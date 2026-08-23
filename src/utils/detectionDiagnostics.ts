/**
 * 揺れ検知の診断ログ（純粋コア）。
 *
 * 検知が走ったとき、**アプリが実際に何を見ていたか**を後から再生できる形で書き出す。記録するのは
 * 前後 30 秒ぶんの生の観測値・イベントの内訳・アプリのバージョン・その時点の学習資産。
 *
 * 【なぜ要るか】2026-08-23 の誤検知調査で、利用者が記録した 30 件のうち 12 件が Yahoo のアーカイブから
 * まったく再現できなかった。通常再生・コマ落ち再現・助走 45 分・当時のバージョンのどれでも弱いクラスタ
 * すら立たず、原因を特定できないまま保留になった。**その場のアプリが見た値が残っていれば即座に決着した。**
 *
 * 【なぜブラウザが自動で書き出さないか】ファイルシステムへ許可なく書き込む口がブラウザには無い。
 * ここでは記録を溜めるだけで、書き出しは設定タブのボタン（利用者の操作）から行う。
 *
 * このファイルは副作用を持たない（保存は `detectionDiagnosticsDb.ts`、配線は
 * `hooks/useDetectionDiagnostics.ts`）。時刻はすべて呼び出し側が渡すデータ時刻を使う。
 */
import type { DetectionEvent, LearnedState } from './kyoshinDetector'
import { indexToValue } from './kyoshinDetector'

/** 検知の前に遡って残すフレーム数(秒)。 */
export const LEAD_FRAMES = 30
/** 検知の後に残すフレーム数(秒)。この長さが経ってから記録を確定する。 */
export const TAIL_FRAMES = 30
/** 保持する記録の上限。古いものから捨てる。 */
export const MAX_RECORDS = 50
/**
 * フレームのデータ時刻がこれを超えて飛んだ（または後退した）ら、溜めた分を捨てて始め直す。
 *
 * **ライブとリプレイを行き来すると時刻が数か月ぶん後退する。** 捨てないと 2 つの害がある。
 * ひとつは記録の中身が壊れること——環状バッファに切替前のフレームが残っており、そのまま記録すると
 * ライブと過去の値が混ざる。もうひとつは記録が二度と開かれなくなること——`OPEN_COOLDOWN_MS` の判定が
 * 引き算なので、後退した時刻では常に負値になり、どんなに時間が経っても下限を満たさない。
 *
 * 検知エンジン自身も同じ理由で不連続を検出して一過性の状態を作り直す（`PARAMS.MAX_DT_GAP_MS`）。
 */
export const MAX_GAP_MS = 10_000
/**
 * 記録を開く間隔の下限(ms)。前に開いてからこの間は新しい記録を開かない。
 *
 * **1 つの地震が何本もの記録を生む。** 揺れが広がる過程で成分が分かれ、別イベントとして次々に
 * 立ち上がるため（茨城県南部 M5.9 のリプレイでは 13 本になった）。前後 30 秒ずつの窓は互いに
 * 重なっており、中身はほとんど同じ。上限（`MAX_RECORDS`）を 1 回の地震で食い潰すと、本来残したい
 * 「地震が無いのに鳴った」記録が押し出される。
 */
export const OPEN_COOLDOWN_MS = 60_000

/** 記録 1 件の観測フレーム。`intensity` は 1 文字 1 観測点（Yahoo の生の形と同じ）。 */
export interface DiagnosticFrame {
  ms: number
  intensity: string
}

/** 検知したイベントの内訳（記録用に平らにしたもの）。 */
export interface DiagnosticEvent {
  id: string
  confidence: string
  lastSize: number
  maxIntensity: number
  epicenter: [number, number] | null
  /** メンバー観測点の座標と、検知フレームでの値 */
  members: { lat: number; lng: number; value: number }[]
}

/** 書き出す 1 件。 */
export interface DiagnosticRecord {
  /** データ時刻とイベント ID から作る一意キー */
  id: string
  /** アプリのバージョン（`__APP_VERSION__`） */
  version: string
  /** ビルドバリアント（standard / dmdss） */
  variant: string
  /** 検知したデータ時刻(ms) */
  dataTimeMs: number
  /** 観測点リストの版（`siteConfigId`） */
  siteConfigId: string
  /**
   * 観測点の座標（`frames[].intensity` の文字と同じ並び）。
   *
   * **版だけを記録して後から引く形にしない。** この機能は「Yahoo のアーカイブから当時の値を再現
   * できなかった」ことへの対策なのに、解読を別の Yahoo 提供リソース（旧版の観測点リスト）が
   * 配信され続けることに賭けるのでは、同じ穴をもう一度掘ることになる。
   */
  sites: [number, number][]
  event: DiagnosticEvent
  /**
   * このイベントが**最終的に到達した**確信度。`event.confidence` は記録を開いた瞬間の値なので、
   * 後から育ったものは開いた時点の姿しか残らない。
   *
   * これが無いと、記録の目的である「周囲の裏付けが取れずに抑えた分」と「画面に出た検知」の
   * 区別が付かない。抑えた分は `faint` のまま終わり、育ったものは `likely`／`confirmed` になる。
   */
  reachedConfidence: string
  /** 前後の生の観測値（データ時刻の昇順） */
  frames: DiagnosticFrame[]
  /**
   * その時点の学習資産（点別床・セル慢性活性）。同じ値から再生を始めれば、
   * アプリが置かれていた状態を再現できる。取得できなければ null
   */
  learned: LearnedState | null
}

/** 検知フレームの情報（記録を開くときに呼び出し側から受け取る）。 */
export interface CaptureSeed {
  dataTimeMs: number
  siteConfigId: string
  sites: [number, number][]
  event: DiagnosticEvent
  learned: LearnedState | null
}

/** 震度インデックス列 → Yahoo の生の形（1 文字 1 観測点）。`services/kyoshin.ts` の逆変換。 */
export function encodeIntensity(indices: readonly number[]): string {
  let out = ''
  for (const v of indices) out += String.fromCharCode(v + 100)
  return out
}

/** イベントのメンバーを座標と値の並びへ平らにする。 */
export function describeEvent(
  e: DetectionEvent,
  keyToIndex: ReadonlyMap<string, number>,
  sites: readonly [number, number][],
  indices: readonly number[],
): DiagnosticEvent {
  const members: { lat: number; lng: number; value: number }[] = []
  for (const k of e.memberKeys) {
    const i = keyToIndex.get(k)
    if (i == null || !sites[i]) continue
    members.push({ lat: sites[i][0], lng: sites[i][1], value: indexToValue(indices[i] ?? 0) })
  }
  return {
    id: e.id,
    confidence: e.confidence,
    lastSize: e.lastSize,
    maxIntensity: e.maxIntensity,
    epicenter: e.epicenter,
    members,
  }
}

/**
 * 検知の前後を切り出す蓄積器。
 *
 * フレームを流し込み（`pushFrame`）、検知が起きたら記録を開く（`open`）。開いた記録は後ろ側の
 * フレームが `TAIL_FRAMES` 分たまった時点で確定し、`takeFinished` から取り出せる。
 *
 * **同じイベントで二度開かない。** 確信度が上がったとき（faint→likely→confirmed）に毎回開くと、
 * ほぼ同じ内容の記録が並んで上限をすぐ食い潰す。イベント ID ごとに一度だけ開く。
 */
export class DiagnosticCapture {
  private readonly ring: DiagnosticFrame[] = []
  /** 開いている記録。`tail` は**開いた後に足したフレーム数**（前側を混ぜて数えないため別に持つ）。 */
  private readonly pending: { seed: CaptureSeed; frames: DiagnosticFrame[]; tail: number }[] = []
  private readonly finished: DiagnosticRecord[] = []
  private readonly opened = new Set<string>()
  /** 最後に記録を開いたデータ時刻(ms)。未記録は null */
  private lastOpenedMs: number | null = null
  /** 最後に流し込んだフレームのデータ時刻(ms)。不連続の検出に使う */
  private lastFrameMs: number | null = null

  /**
   * 1 フレーム流し込む。データ時刻の昇順で呼ぶこと。
   *
   * 時刻が後退した・大きく飛んだ場合は溜めた分を捨てて始め直す（`MAX_GAP_MS`）。
   */
  pushFrame(ms: number, intensity: string): void {
    if (this.lastFrameMs != null && (ms <= this.lastFrameMs || ms - this.lastFrameMs > MAX_GAP_MS)) {
      this.reset()
    }
    this.lastFrameMs = ms
    const frame = { ms, intensity }
    this.ring.push(frame)
    while (this.ring.length > LEAD_FRAMES + 1) this.ring.shift()
    for (const p of this.pending) {
      p.frames.push(frame)
      p.tail++
    }
    // 後ろ側がたまった記録を確定する（配列の後ろから消すので逆順に走査）
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]
      if (p.tail < TAIL_FRAMES) continue
      this.finished.push(this.build(p.seed, p.frames))
      this.pending.splice(i, 1)
    }
  }

  /**
   * 検知が起きた。記録を開く。
   *
   * 同じイベント ID では一度だけ。加えて、前に開いてから `OPEN_COOLDOWN_MS` の間は開かない
   * （1 つの地震が生む複数イベントで上限を食い潰さないため）。
   */
  open(seed: CaptureSeed, version: string, variant: string): void {
    if (this.opened.has(seed.event.id)) {
      // 既に開いている記録でも、到達した確信度だけは追い続ける（後から育つため）
      this.noteReached(seed.event.id, seed.event.confidence)
      return
    }
    if (this.lastOpenedMs != null && seed.dataTimeMs - this.lastOpenedMs < OPEN_COOLDOWN_MS) return
    this.lastOpenedMs = seed.dataTimeMs
    this.opened.add(seed.event.id)
    this.versionOf.set(seed.event.id, { version, variant })
    this.noteReached(seed.event.id, seed.event.confidence)
    // 開いた時点の直近フレーム（検知フレームを含む）を前側として取り込む
    this.pending.push({ seed, frames: [...this.ring], tail: 0 })
  }

  /** 確定した記録を取り出す（取り出した分は内部から消える）。 */
  takeFinished(): DiagnosticRecord[] {
    return this.finished.splice(0, this.finished.length)
  }

  /**
   * 途中で打ち切って、開いている記録を後ろ側が足りないまま確定する。
   * 画面を閉じる・リプレイへ切り替える等、フレームがもう来ない場面で使う。
   */
  flush(): DiagnosticRecord[] {
    for (const p of this.pending) this.finished.push(this.build(p.seed, p.frames))
    this.pending.length = 0
    return this.takeFinished()
  }

  /** 一過性の状態を捨てる（リプレイ切替・観測点集合の入れ替え時）。 */
  reset(): void {
    this.ring.length = 0
    this.pending.length = 0
    this.opened.clear()
    this.reached.clear()
    this.lastOpenedMs = null
    this.lastFrameMs = null
  }

  private readonly versionOf = new Map<string, { version: string; variant: string }>()
  /** イベント ID → 到達した最高の確信度 */
  private readonly reached = new Map<string, string>()

  /** 到達した確信度を更新する（上がる方向にだけ動かす）。 */
  private noteReached(id: string, confidence: string): void {
    const rank = (c: string): number => ({ weak: 0, faint: 1, likely: 2, confirmed: 3 })[c] ?? 0
    const cur = this.reached.get(id)
    if (cur == null || rank(confidence) > rank(cur)) this.reached.set(id, confidence)
  }

  private build(seed: CaptureSeed, frames: DiagnosticFrame[]): DiagnosticRecord {
    const v = this.versionOf.get(seed.event.id)
    return {
      id: `${seed.dataTimeMs}-${seed.event.id}`,
      version: v?.version ?? '',
      variant: v?.variant ?? '',
      dataTimeMs: seed.dataTimeMs,
      siteConfigId: seed.siteConfigId,
      sites: seed.sites,
      event: seed.event,
      reachedConfidence: this.reached.get(seed.event.id) ?? seed.event.confidence,
      frames,
      learned: seed.learned,
    }
  }
}
