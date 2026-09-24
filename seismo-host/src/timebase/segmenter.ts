// 届いたパケットを、センサーごとの「途切れていない一続き」へ組み直す。
//
// **繋いではいけない切れ目が 2 つある。** 通し番号が飛んだとき（パケットが落ちた）と、
// FIFO があふれたとき（基板の中でサンプルが失われた）。どちらも**失われた時間を
// 詰めて繋ぐと、そこに段差ができる**。計測震度のフィルタは段差を強い揺れとして読むので、
// 繋いだ結果は「静止しているのに揺れた」という形で出る。offline の解析（`nightly.py`）も
// 同じ 2 つで切っており、ここはその規則をそのまま持ってくる。
//
// **ファイルを読むのとは違う事象が 3 つ増える。** offline の解析はパケットが順番どおり
// 1 度ずつ並んだファイルを読むが、こちらは UDP で受ける。
//
//   - 並び替え・重複 —— 同じ通し番号が二度来る、後ろの番号が先に来る
//   - 再起動 —— 通し番号が 0 へ戻る（版 1 は起動ごとの識別子を持たないので、
//     鍵だけでは見分けられない）
//   - 設定変更 —— 軸の数・サンプリング周波数・換算係数が途中で変わる
//
// **戻ってきた番号を繋ぎ直さない。** 遅れて届いたパケットを区間へ挿し込む形にすると、
// 下流は「一度渡したより古いサンプル」を受け取ることになる。落ちた時点で区間は
// 閉じているので、遅れて来たものは数えて捨てる。
import type { BoardKey, SensorPacket } from '../protocol/types'
import { IncrementalLineFit } from './lineFit'

/**
 * 名乗る時刻が、その通し番号にふさわしい位置からどれだけ離れてよいか（ミリ秒）。
 *
 * **並び替えと再起動は、番号の戻り幅では見分けられない。** 起動から間もない基板が
 * 落ちると、通し番号はまだ大きく戻れないので、戻り幅で測ると再起動を並び替えと読む。
 *
 * **見分けるのは時刻の辻褄。** 遅れて届いただけのパケットは、その番号にふさわしい
 * 過去の時刻を名乗る。再起動後のパケットは辻褄が合わない —— 時計が合っていれば
 * 未来へ飛び、合う前なら大きく過去へ飛ぶ。**どちらの向きも同じ判定で捕まる。**
 *
 * **比べる足場は「最後に受理したパケット」で、間隔は公称値を使う**（区間の当てはめ
 * ではない）。当てはめを使うと、区間が始まったばかりでアンカーが 2 つしか無い時期の
 * 傾きの揺れが、離れた番号ほど拡大されて効く —— 区間の開始より前から遅れて届いた
 * 正規のパケットを、偽の再起動として切ってしまう。
 *
 * 公称値で足りる根拠は実測。8 時間・3 台の記録で、区間ごとに当てはめた実際の間隔は
 * 10.000〜10.010 ms（公称 10 ms からのずれは最大 0.06%）だった。並び替えが起きうる
 * 幅（数パケット＝数秒）では、このずれは数ミリ秒にしかならない。
 *
 * 100 ms は、名乗る時刻そのもののばらつき（当てはめ残差で 2.5〜4.7 ms）の 20 倍以上。
 * 正常なばらつきでは届かず、再起動はこれより確実に長くかかる。
 *
 * **この幅より短い中断は見分けられない。** 版 2 の起動 ID が焼かれれば鍵そのものが
 * 変わるので、その弱点は版 1 に限られる。
 */
const TIMEBASE_CONSISTENCY_MS = 100

/**
 * 当てはめた間隔が公称値から離れてよい割合。
 *
 * 水晶の誤差は 100 ppm の桁なので、1 割も離れていれば当てはめのほうが壊れている
 * （アンカーが 2 つしか無い時期は抜き出しの揺れだけで数 % 動くため、そこは許す）。
 * 離れたら公称値へ倒し、**倒したことを隠さない**。
 */
const MAX_SLOPE_DEVIATION = 0.1

/** 区間が始まった理由。**続きではないことを下流へ伝えるのが目的。** */
export type SegmentBreakReason =
  /** その鍵で初めて受け取った。 */
  | 'stream-start'
  /** 通し番号が飛んだ。パケットが届かなかった。 */
  | 'seq-gap'
  /** 通し番号が大きく戻った。基板が再起動したとみなす。 */
  | 'seq-reset'
  /** FIFO があふれた。基板の中でサンプルが失われた。 */
  | 'overflow'
  /** 軸・周波数・換算のいずれかが変わった。前の区間とは別物。 */
  | 'config-changed'

/** その区間のあいだ変わらない事実。 */
export interface SegmentMeta {
  /** プロセスの中で一意。**変わったら下流はフィルタの状態を捨てる。** */
  readonly segmentId: number
  /** どのセンサーの流れか。`boardKey` と `sensorId` と `bootId` の組。 */
  readonly streamKey: string
  readonly boardKey: BoardKey
  readonly sensorId: string
  readonly bootId: string
  readonly sensorType: string
  readonly channels: readonly string[]
  readonly sampleRateHz: number
  readonly ugPerLsb: number
  readonly fullScaleG: number
  /** 区間の先頭サンプルの通し番号。 */
  readonly firstSeq: number
  readonly startedBecause: SegmentBreakReason
}

/** 公称値へ倒した理由。倒していなければ null。 */
export type NominalReason = 'too-few-anchors' | 'slope-out-of-range'

/** 区間の中の位置から時刻を出すための当てはめ結果。 */
export interface Timebase {
  /** 1 サンプルあたりのミリ秒。 */
  readonly msPerSample: number
  /** 区間の先頭サンプルの時刻（unix ミリ秒）。 */
  readonly firstSampleMs: number
  /** 当てはめに使ったパケットの数。 */
  readonly anchorCount: number
  /** 名乗られた時刻のばらつき。当てはめていなければ null。 */
  readonly residualRmsMs: number | null
  /** 公称値へ倒した理由。当てはめた値を使っていれば null。 */
  readonly nominalReason: NominalReason | null
}

/** 区間のいまの状態。 */
export interface SegmentState {
  readonly meta: SegmentMeta
  /** 先頭から数えたサンプルの総数。 */
  readonly sampleCount: number
  readonly timebase: Timebase
}

export type SegmentAcceptResult =
  | {
      readonly ok: true
      /**
       * このパケットによって閉じた区間。**普通は 0 件で、切れ目があれば 1 件**
       * （流れの数が上限に達して別の流れを閉じた場合も入る）。
       */
      readonly closed: readonly SegmentState[]
      /** このパケットを収めた区間。 */
      readonly segment: SegmentState
      /** 新しい区間が始まったなら理由。続きなら null。 */
      readonly startedBecause: SegmentBreakReason | null
      /** 区間の先頭から数えた、このパケットの最初のサンプルの位置。 */
      readonly firstSampleIndex: number
    }
  | {
      readonly ok: false
      /** 既に渡した範囲。並び替えか重複。 */
      readonly reason: 'duplicate'
      readonly streamKey: string
    }

export interface SegmenterOptions {
  /**
   * 同時に覚えておく流れの数の上限。
   *
   * **受信口は LAN へ開くので、送り手の数はこちらで決められない。** 壊れた送り手や
   * 別のプログラムが毎回違う名前で投げてきたときに、覚えが際限なく増えないようにする。
   * 上限に達したら**いちばん長く音沙汰の無い流れを閉じる**（新しいほうを拒むと、
   * 基板を入れ替えたときに新しい基板が永久に映らない）。
   */
  readonly maxStreams?: number
}

interface StreamState {
  meta: SegmentMeta
  fit: IncrementalLineFit
  sampleCount: number
  /** 次に来るはずの通し番号。 */
  expectedSeq: number
  lastOverflow: number
  /** 最初のアンカーの時刻。当てはめが効かないあいだの足場になる。 */
  firstAnchorMs: number
  /** 最後に受理したパケットの先頭サンプル。並び替えと再起動の見分けの足場。 */
  lastAcceptedSeq: number
  lastAcceptedSampleMs: number
  /** 受け取った順の通し番号。実時計を使わずに「古さ」を測るため。 */
  touchedAt: number
}

/** 区間の中の位置から時刻を出す。 */
export function sampleTimeMs(timebase: Timebase, index: number): number {
  return timebase.firstSampleMs + timebase.msPerSample * index
}

function sameConfig(meta: SegmentMeta, p: SensorPacket): boolean {
  if (meta.sampleRateHz !== p.sampleRateHz) return false
  if (meta.ugPerLsb !== p.ugPerLsb) return false
  if (meta.fullScaleG !== p.fullScaleG) return false
  if (meta.sensorType !== p.sensorType) return false
  if (meta.channels.length !== p.channels.length) return false
  for (let i = 0; i < meta.channels.length; i++) {
    if (meta.channels[i] !== p.channels[i]) return false
  }
  return true
}

export function streamKeyOf(p: SensorPacket): string {
  // **区切り文字で繋がないこと。** 受信口は LAN へ開くので、名乗る値の文字種を
  // こちらで決められない。`|` で繋ぐ形だと、値の中に `|` を含む送り手が来たときに
  // **別々のセンサーが同じ鍵になりうる**（`mac="X|Y", sid="Z"` と
  // `mac="X", sid="Y|Z"` が同じ文字列になる）。鍵が衝突すれば、まったく別の場所の
  // 波形が 1 つの区間へ混ざる。長さを含んで書き出す形なら、どんな文字でも一意に戻せる。
  return JSON.stringify([p.boardKey, p.sensorId, p.bootId])
}

/**
 * 同時に覚えていられる流れの数。
 *
 * **受信層の上限もここから読む。** 数える表（`../receiver/packetTally.ts`）・送信元ごとの
 * 速度の上限（`../receiver/sourceRateLimit.ts`）・記録の間引き（`../receiver/logThrottle.ts`）は
 * どれも「1 台につき 1 つの枠」を前提に大きさを決めており、**流れの上限と揃っていることが
 * その前提の根拠**。それぞれが手書きの数字を持つと、ここを動かしたとき残りが古い値のまま
 * 取り残され、揃えたつもりの関係が黙って外れる。
 */
export const MAX_STREAMS_DEFAULT = 64

export class Segmenter {
  private readonly streams = new Map<string, StreamState>()
  private readonly maxStreams: number
  private nextSegmentId = 1
  private clock = 0

  constructor(options: SegmenterOptions = {}) {
    this.maxStreams = options.maxStreams ?? MAX_STREAMS_DEFAULT
  }

  accept(packet: SensorPacket): SegmentAcceptResult {
    const key = streamKeyOf(packet)
    const existing = this.streams.get(key)
    const closed: SegmentState[] = []

    if (existing !== undefined) {
      const reason = this.breakReason(existing, packet)
      if (reason === 'duplicate') {
        // **区間は触らない。** 既に渡した範囲なので、通し番号もあふれの記録も進めない。
        existing.touchedAt = ++this.clock
        return { ok: false, reason: 'duplicate', streamKey: key }
      }
      if (reason === null) {
        return this.append(existing, packet, closed, null)
      }
      closed.push(snapshot(existing))
      const started = this.start(key, packet, reason)
      return this.append(started, packet, closed, reason)
    }

    if (this.streams.size >= this.maxStreams) {
      const evicted = this.evictOldest()
      if (evicted !== null) closed.push(evicted)
    }
    const started = this.start(key, packet, 'stream-start')
    return this.append(started, packet, closed, 'stream-start')
  }

  /** いま開いている区間。読み取りだけ。 */
  openSegments(): SegmentState[] {
    return [...this.streams.values()].map(snapshot)
  }

  /** 名指しで閉じる。無ければ null。 */
  closeStream(streamKey: string): SegmentState | null {
    const s = this.streams.get(streamKey)
    if (s === undefined) return null
    this.streams.delete(streamKey)
    return snapshot(s)
  }

  /** すべて閉じる。 */
  closeAll(): SegmentState[] {
    const out = this.openSegments()
    this.streams.clear()
    return out
  }

  private breakReason(s: StreamState, p: SensorPacket): SegmentBreakReason | 'duplicate' | null {
    // **番号が戻っているかを、何よりも先に見る。** 遅れて届いたパケットは、あふれの数も
    // 設定も「その当時の値」を持っている。先に設定やあふれと比べると、**古い値と
    // いまの値が食い違うので偽の切れ目が立ち**、しかもその区間は古い番号から始まるため
    // 次の正規のパケットでもう 1 度切れる。古いものは何も見ずに落とす。
    if (p.firstSeq < s.expectedSeq) {
      // **その番号にふさわしい時刻を名乗っているかで見分ける。** 遅れて届いただけなら
      // 辻褄は合う。再起動なら合わない。版 1 は起動ごとの識別子を持たず鍵が変わらない
      // ので、ここで見分けないと再起動をまたいだサンプルが同じ区間へ繋がり、
      // 止まっていた時間が詰められて段差になる。
      const nominalMsPerSample = 1000 / s.meta.sampleRateHz
      const predicted =
        s.lastAcceptedSampleMs + (p.firstSeq - s.lastAcceptedSeq) * nominalMsPerSample
      const off = Math.abs(p.firstSampleMs - predicted)
      return off > TIMEBASE_CONSISTENCY_MS ? 'seq-reset' : 'duplicate'
    }
    // **設定とあふれの順序は、どちらが先でも区間は正しく切れる。** 同じパケットで
    // 両方が成立したときに名乗る理由が設定側になるだけで、繋ぐか切るかは変わらない。
    if (!sameConfig(s.meta, p)) return 'config-changed'
    if (p.overflowCount !== s.lastOverflow) return 'overflow'
    return p.firstSeq > s.expectedSeq ? 'seq-gap' : null
  }

  private start(key: string, p: SensorPacket, reason: SegmentBreakReason): StreamState {
    const meta: SegmentMeta = {
      segmentId: this.nextSegmentId++,
      streamKey: key,
      boardKey: p.boardKey,
      sensorId: p.sensorId,
      bootId: p.bootId,
      sensorType: p.sensorType,
      channels: p.channels,
      sampleRateHz: p.sampleRateHz,
      ugPerLsb: p.ugPerLsb,
      fullScaleG: p.fullScaleG,
      firstSeq: p.firstSeq,
      startedBecause: reason,
    }
    const state: StreamState = {
      meta,
      fit: new IncrementalLineFit(),
      sampleCount: 0,
      expectedSeq: p.firstSeq,
      lastOverflow: p.overflowCount,
      firstAnchorMs: p.firstSampleMs,
      lastAcceptedSeq: p.firstSeq,
      lastAcceptedSampleMs: p.firstSampleMs,
      touchedAt: ++this.clock,
    }
    this.streams.set(key, state)
    return state
  }

  private append(
    s: StreamState,
    p: SensorPacket,
    closed: SegmentState[],
    startedBecause: SegmentBreakReason | null,
  ): SegmentAcceptResult {
    const firstSampleIndex = p.firstSeq - s.meta.firstSeq
    s.fit.add(firstSampleIndex, p.firstSampleMs)
    s.sampleCount = firstSampleIndex + p.samples.length
    s.expectedSeq = p.firstSeq + p.samples.length
    s.lastOverflow = p.overflowCount
    s.lastAcceptedSeq = p.firstSeq
    s.lastAcceptedSampleMs = p.firstSampleMs
    s.touchedAt = ++this.clock
    return { ok: true, closed, segment: snapshot(s), startedBecause, firstSampleIndex }
  }

  private evictOldest(): SegmentState | null {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of this.streams) {
      if (v.touchedAt < oldestAt) {
        oldestAt = v.touchedAt
        oldestKey = k
      }
    }
    return oldestKey === null ? null : this.closeStream(oldestKey)
  }
}

function snapshot(s: StreamState): SegmentState {
  return { meta: s.meta, sampleCount: s.sampleCount, timebase: timebaseOf(s) }
}

function timebaseOf(s: StreamState): Timebase {
  const nominalMsPerSample = 1000 / s.meta.sampleRateHz
  const fit = s.fit.result()
  const fallback = (reason: NominalReason): Timebase => ({
    msPerSample: nominalMsPerSample,
    // **区間の最初のアンカーは、定義上いつも先頭サンプルを指す**（区間はその
    // パケットから始まる）ので、そのまま足場に使える。
    firstSampleMs: s.firstAnchorMs,
    anchorCount: fit.count,
    residualRmsMs: null,
    nominalReason: reason,
  })
  if (!fit.usable) return fallback('too-few-anchors')
  const deviation = Math.abs(fit.slope - nominalMsPerSample) / nominalMsPerSample
  if (!(deviation <= MAX_SLOPE_DEVIATION)) return fallback('slope-out-of-range')
  return {
    msPerSample: fit.slope,
    firstSampleMs: fit.intercept,
    anchorCount: fit.count,
    residualRmsMs: fit.residualRms,
    nominalReason: null,
  }
}
