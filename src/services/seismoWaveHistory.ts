// 過ぎた合成波形を、地震の区間ぶんだけホストから読み返す（`GET /waves`）。
//
// **押し出し（`seismoStream.ts`）とは役割が違う。** あちらは「いま」を流し続ける口で、
// 抱えるのは直近 60 秒だけ。震度速報が届くのは地震発生の 1 分半ほど後なので、
// **カードが立った時点で初動はもう流れ去っている。** こちらは時刻の範囲を指定して
// 取りに行くので、過ぎた区間を後から引ける。
//
// **落とすのはホストの仕事。** 5 分ぶんの生の値は 3 軸で 9 万個あるが、描く側が使うのは
// 列ごとの上下だけ。`columns` を渡すと列で返る（実機の実測で 3.5 分・600 列が 138 ms）。
//
// **受け取る形はここに書く。** ホスト側の型を `import type` で借りない（理由は
// `seismoStream.ts` の冒頭と同じ —— 境界を越えてくる値を型どおりと信じない）。

import { log } from '../utils/logger'
import { arr, obj, str } from './parseHelpers'
import { isValidSeismoHostUrl } from './seismoStream'
import { QUAKE_MINUTE_LEAD_MS } from '../utils/quakeOriginSeconds'
import { NOISE_SPAN_MS } from '../utils/seismoQuakeWindow'

/**
 * 地震カードの時刻（分の頭）より手前を何 ms 取るか。**60 秒。**
 *
 * 初動より前の静かなところを入れる —— 揺れ始めがどこかを目で取るには、揺れていない区間との
 * 対比が要り、描く範囲の判定も時間軸の 0 の手前 {@link NOISE_SPAN_MS}（30 秒）で平常時のノイズを測る。
 * **時間軸の 0 は分の頭より前へ出うる**（秒まで取れた発生時刻は分の頭の {@link QUAKE_MINUTE_LEAD_MS}
 * 前まで。カードの時刻が地震発現の分のため）。その両方を覆う幅にしてある —— 30 秒だけだと、
 * 発生が分の頭より 20 秒以上前の地震でノイズを測る秒が足りず、描く範囲を切れない。
 */
export const WAVE_HISTORY_LEAD_MS = NOISE_SPAN_MS + QUAKE_MINUTE_LEAD_MS

/**
 * 地震の発生時刻より後を何 ms 取るか。**4 分。**
 *
 * 遠い地震ほど S 波の到達が遅く、大きい地震ほど揺れが長引く。**到達時刻を自前で
 * 計算して詰めない** —— 固定の窓で足りる。自前で解く形へ変えるなら、
 * `docs/forecast-computation-audit.md` の棚卸しへの追記が要る。
 */
export const WAVE_HISTORY_TAIL_MS = 240_000

/**
 * ホストが列で返せる範囲の上限（ms）。**`seismo-host` 側の `WAVE_RANGE_MAX_MS` と同じ値。**
 *
 * **こちらでも持つのは、超える範囲を投げないため**（CLAUDE.md「範囲外の指定は入口で弾く」）。
 * 投げても 400 が返るだけだが、**それは通信を 1 往復した後**で、しかも画面からは
 * 「記録が無い」と見分けが付かない。
 *
 * **値が食い違ったらホスト側が正。** ここを緩めてもホストが弾く（安全側に外れる）。
 */
const HOST_RANGE_MAX_MS = 10 * 60 * 1000

/** 取るときの打ち切り（ms）。LAN 内の相手だが、`/status` より広い範囲を読むので長めに取る。 */
const FETCH_TIMEOUT_MS = 15_000

/** 列 1 つぶん。**ホストは値を持たない列を `null` で返す**ので、この形は「値がある列」だけ。 */
export interface WaveHistoryColumn {
  /** 3 成分それぞれの下端（gal）。 */
  readonly min: readonly [number, number, number]
  /** 3 成分それぞれの上端（gal）。 */
  readonly max: readonly [number, number, number]
  /** その列に効いたセンサーの最小本数。1 以下なら合成の裏付けが無い。 */
  readonly minMembers: number
  /**
   * 合成（3 成分のベクトルの大きさ）の下端と上端（gal）。**ホストがサンプルごとに出して列の端を取ったもの。**
   * 成分ごとの端からは作れない（別々の瞬間の最大を組み合わせると実際より大きく出る）。
   *
   * **古いホストは返さないので `NaN`。** 描く側は合成を描かず、3 成分を重ねた絵へ戻す。
   */
  readonly magMin: number
  readonly magMax: number
  /**
   * 合成の和（gal）と、足したサンプルの数。**合成を前後 1 秒で均した線を引く材料**（隣り合う列の和と数を
   * まとめて割る）。ホストがサンプルを持っているのでそちらで足す。
   *
   * **古いホストは返さないので `magSum` は `NaN`・`magCount` は 0。** 描く側は均した線を引かない。
   */
  readonly magSum: number
  readonly magCount: number
}

/** 読み返した区間。 */
export interface WaveHistory {
  readonly stationId: string
  /**
   * ホストがその観測点を知っているか。
   *
   * **`false` は観測点 ID の取り違えを示す唯一の手掛かり。** これを読み捨てると
   * 「その観測点は静かだった」と寸分違わない応答になる（ホストは断らない ——
   * 設定から外した観測点の記録も読めるようにするため）。
   */
  readonly stationKnown: boolean
  /** 実際に返ってきた範囲の始まり（要求した値をホストが丸めることがある）。 */
  readonly fromMs: number
  /** 1 列が覆う長さ（ms）。 */
  readonly columnSpanMs: number
  /** 値を持たない列は `null`。**描く側はそこで線を切る。** */
  readonly columns: readonly (WaveHistoryColumn | null)[]
  /** 値を持つ列が 1 つでもあるか。 */
  readonly hasAnyValue: boolean
  /** 窓の中の最大の絶対値（gal）。 */
  readonly peakGal: number
  /** 触れるはずのファイルのうち、無かったもの。**0 でなければ記録が欠けている。** */
  readonly filesMissing: number
  /** 読めなかったファイル。 */
  readonly filesFailed: number
  /** 末尾が切れていて読み飛ばしたバイト数。 */
  readonly skippedBytes: number
  /** 範囲が広すぎてホストが打ち切ったか。 */
  readonly truncated: boolean
}

/**
 * 読み返した結果。
 *
 * **失敗の理由を分けて持つ。** 画面へ出すかは呼び出し側が決めるが（2026-09-29 の判断で
 * 記録が無いときは黙る）、**記録には理由が要る** —— 分けないと「繋がらない」と
 * 「記録が無い」と「観測点 ID が違う」が同じ沈黙になる。
 */
export type WaveHistoryResult =
  | { readonly kind: 'ok'; readonly history: WaveHistory }
  /** 範囲・引数が不正で、通信する前に弾いた。 */
  | { readonly kind: 'bad-request'; readonly detail: string }
  /** 応答が返らなかった（落ちている・経路が無い・混在コンテンツで止められた）。 */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** 応答は返ったが HTTP が成功ではない。 */
  | { readonly kind: 'http-error'; readonly status: number }
  /** 応答は返ったが、こちらが期待する形ではない。 */
  | { readonly kind: 'unreadable'; readonly detail: string }
  /**
   * 呼び出し側が取り消した。**失敗ではないので記録へ残さない。**
   *
   * 相手が悪いわけでもこちらの組み立てが悪いわけでもない —— 対象が入れ替わった
   * （新しい有感地震が来た）・カードが画面から消えた、というだけ。`unreachable` と
   * 同じ枠に入れると、**群発のときほど「繋がらなかった」の行が埋まり、本物の
   * ホスト障害と見分けが付かなくなる。**
   */
  | { readonly kind: 'aborted' }

/** 読み返す範囲。 */
export interface WaveHistoryRange {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 地震の発生時刻から、読み返す範囲を組み立てる。
 *
 * **現在時刻を見ない。** 端末の時計は当てにならない（2026-09-29 の実測で作業 PC は
 * 1.16 秒 遅れていた）。電文が名乗る発生時刻だけで決まる形にしておけば、端末の時計が
 * どれだけ狂っていても窓はずれない。
 *
 * **未来を切り落とさない。** まだ来ていない区間を要求してもホストは「記録が無い」を
 * 返すだけで、害は無い。切り落とす形にすると現在時刻が要る（上記のとおり当てにならない）。
 */
export function buildWaveHistoryRange(originMs: number): WaveHistoryRange | null {
  if (!Number.isFinite(originMs)) return null
  const fromMs = Math.floor(originMs - WAVE_HISTORY_LEAD_MS)
  const toMs = Math.floor(originMs + WAVE_HISTORY_TAIL_MS)
  // **定数を動かしたときの歯止め。** いまの値（5 分）では起きないが、伸ばした人が
  // 上限を超えたことに気づく手立てがここしか無い。
  if (toMs - fromMs > HOST_RANGE_MAX_MS) return null
  return { fromMs, toMs }
}

/**
 * 3 成分の端として読む。**成分の数が 3 でない・数として読めないものは通さない。**
 *
 * **`null` の成分は「その列にその成分の値が無い」として `NaN` にする。** 観測点の合成は、測る向きが
 * 3 方向へ散っていない間、解けない成分だけを欠けにする（`seismo-host/src/receiver/sensorFusion.ts`・
 * 2026-10-09 ユーザー承認）。1 成分の欠けで応答ごと捨てると、上が解けないだけで地震カードの波形が消える。
 */
function readTriple(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const out: [number, number, number] = [0, 0, 0]
  for (let a = 0; a < 3; a += 1) {
    const n: unknown = value[a]
    if (n === null) {
      out[a] = Number.NaN
      continue
    }
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
    out[a] = n
  }
  return out
}

/** 数として読めるものだけ通す。読めなければ `fallback`。 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 応答を読む。**読めない列があれば、その応答ごと捨てる。**
 *
 * **読めない列だけを飛ばして詰めない。** 波形の途中を抜いて前後を繋ぐと、そこだけ
 * 時間が縮んだ絵になる —— 絵としては普通に見えるので、見ている人には確かめる手立てが
 * 無い（`seismoStream.ts` の `readFiniteArray` と同じ判断）。**ただし `null` の列は
 * 「値が無い」という正しい応答**なので、そのまま残す。
 */
export function readWaveHistory(parsed: unknown): { value: WaveHistory } | { detail: string } {
  const root = obj(parsed)
  const stationId = str(root.stationId)
  if (stationId === '') return { detail: 'stationId が無い' }
  if (!Array.isArray(root.columns)) return { detail: 'columns が配列ではない' }

  const columns: (WaveHistoryColumn | null)[] = []
  for (const raw of arr(root.columns)) {
    if (raw === null) {
      columns.push(null)
      continue
    }
    const col = obj(raw)
    const min = readTriple(col.min)
    const max = readTriple(col.max)
    if (min === null || max === null) return { detail: '列の min / max を読めない' }
    // **合成の上下はそろって読む。** 片方だけ読めた列は合成を持たないものとして扱う（古いホストは両方とも返さない）。
    const magMin = finiteOr(col.magMin, Number.NaN)
    const magMax = finiteOr(col.magMax, Number.NaN)
    const hasMag = Number.isFinite(magMin) && Number.isFinite(magMax)
    // **和と数もそろって読む。** 数が正の整数でなければ、和があっても持たないものとして扱う（0 で割らない）。
    const magSum = finiteOr(col.magSum, Number.NaN)
    const magCount = finiteOr(col.magCount, 0)
    const hasMean = Number.isFinite(magSum) && Number.isInteger(magCount) && magCount > 0
    columns.push({
      min,
      max,
      minMembers: finiteOr(col.minMembers, 0),
      magMin: hasMag ? magMin : Number.NaN,
      magMax: hasMag ? magMax : Number.NaN,
      magSum: hasMean ? magSum : Number.NaN,
      magCount: hasMean ? magCount : 0,
    })
  }

  return {
    value: {
      stationId,
      // **既定を `true` にしない。** 欄が欠けている応答（版が古い・別のものが応えている）を
      // 「知っている観測点」として通すと、取り違えを示す唯一の手掛かりが消える。
      stationKnown: root.stationKnown === true,
      fromMs: finiteOr(root.fromMs, NaN),
      columnSpanMs: finiteOr(root.columnSpanMs, NaN),
      columns,
      hasAnyValue: root.hasAnyValue === true,
      peakGal: finiteOr(root.peakGal, 0),
      filesMissing: finiteOr(root.filesMissing, 0),
      filesFailed: finiteOr(root.filesFailed, 0),
      skippedBytes: finiteOr(root.skippedBytes, 0),
      truncated: root.truncated === true,
    },
  }
}

/** 経路を繋ぐための基点（末尾のスラッシュを落とす。理由は `seismoStream.ts` の `apiBase`）。 */
function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * 過ぎた合成波形を、列の形で取る。
 *
 * **失敗しても投げない。** 呼ぶのは画面の描画の都合で、取れなかったことは表示の
 * 選択肢（描かない）であって異常ではない。**そのぶん記録へ 1 行残す** ——
 * 画面に出さないと決めた以上（2026-09-29 の判断）、記録が唯一の手掛かりになる。
 */
export async function fetchSeismoWaveHistory(params: {
  baseUrl: string
  stationId: string
  range: WaveHistoryRange
  /** 返してほしい列の数。**画面の幅（デバイスピクセル）を渡す。** */
  columns: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<WaveHistoryResult> {
  const { baseUrl, stationId, range, columns, signal } = params
  const fetchImpl = params.fetchImpl ?? globalThis.fetch

  const fail = <T extends WaveHistoryResult>(result: T, why: string): T => {
    log.warn(`[seismo] 過ぎた波形を読めず（${result.kind}）: ${why}`)
    return result
  }

  if (!isValidSeismoHostUrl(baseUrl)) {
    return fail({ kind: 'bad-request' as const, detail: 'URL の形が正しくない' }, 'URL の形が正しくない')
  }
  if (stationId === '') {
    return fail({ kind: 'bad-request' as const, detail: '観測点が空' }, '観測点が空')
  }
  if (!Number.isFinite(range.fromMs) || !Number.isFinite(range.toMs) || range.toMs <= range.fromMs) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が不正' }, '範囲が不正')
  }
  if (range.toMs - range.fromMs > HOST_RANGE_MAX_MS) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が上限を超える' }, '範囲が上限を超える')
  }
  if (!Number.isInteger(columns) || columns <= 0) {
    return fail({ kind: 'bad-request' as const, detail: '列数が不正' }, '列数が不正')
  }

  const query = new URLSearchParams({
    station: stationId,
    from: String(Math.floor(range.fromMs)),
    to: String(Math.floor(range.toMs)),
    columns: String(columns),
  })

  let res: Response
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    // **呼び出し側の取り消しも効かせる。** カードが画面から消えたのに取りに行き続けると、
    // 履歴を遡るたびに宙に浮いた要求が積み上がる。
    const onAbort = (): void => ctrl.abort()
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted === true) ctrl.abort()
    try {
      res = await fetchImpl(`${apiBase(baseUrl)}/waves?${query.toString()}`, {
        signal: ctrl.signal,
        cache: 'no-store',
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    // **呼び出し側の取り消しは失敗として記録しない**（`kind` の説明を見ること）。
    //
    // **時間切れ（`FETCH_TIMEOUT_MS`）とは区別する。** どちらも `AbortError` になるが、
    // あちらは本物の失敗なので記録が要る。**見分けるのは投げた `error` ではなく、
    // 呼び出し側の `signal` が上がっているかどうか** —— 例外の側からは、どちらの
    // `AbortController` が中断したのか分からない。
    if (signal?.aborted === true) return { kind: 'aborted' as const }
    const detail = describeError(error)
    return fail({ kind: 'unreachable' as const, detail }, detail)
  }
  if (!res.ok) return fail({ kind: 'http-error' as const, status: res.status }, `HTTP ${res.status}`)

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (error) {
    const detail = describeError(error)
    return fail({ kind: 'unreadable' as const, detail }, detail)
  }

  const read = readWaveHistory(parsed)
  if ('detail' in read) return fail({ kind: 'unreadable' as const, detail: read.detail }, read.detail)
  return { kind: 'ok', history: read.value }
}
