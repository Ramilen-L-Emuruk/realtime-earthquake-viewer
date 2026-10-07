// 観測点の合成波形を、時刻で頭出しできる形で残す。
//
// **生データ（`mseedStore.ts`）では代われない。** あちらが残すのはセンサー単独の RAW カウント値で、
// 画面に出ている合成波形を作り直すには補正 → 区間の組み立て → 合成を通し直す必要がある
// （当時の観測点設定も要る）。
//
// **1 時間ごとに 1 本へ切る。ファイル名が索引を兼ねる。** 別に索引ファイルを持つと、
// そこが指すバイト位置と実際に書けた量がずれる形（プロセスが落ちた・書き出しが詰まった）を
// 抱え込む。1 本 5 MB 弱なので、読み返しはそのファイルを頭から走査すれば足りる。
//
// **gzip しない。** 圧縮するとランダムアクセスができなくなり、この入れ物の唯一の取り柄が消える。
//
// **消さない。** 生データ（`mseedStore.ts`）と同じ約束（ディスクが埋まる前に人が消す）。
//
// **チャンクをそのまま並べる。固定の時間グリッドへ割り付けない。** 刻みは公称 100 Hz に
// 対して実測 0.16% 揺らぐので、グリッドへ丸めると誤差が積み上がり、連続して届いている
// データが偽の欠測に化ける（PWA 側のリングバッファで一度踏んだ罠。
// `docs/spec/data-sources-spec.md` §4.5）。
//
// **落ちない。** 保存が止まっても震度と押し出しは続ける。ただし黙らない —— 失った件数と
// 流し口の異常を、呼び出し側が数えられる形で持つ。
//
// **既知の限界: `fsync` は掛けていない。** 書き込みのコールバックが成功で返ってから
// 実際の永続化が失敗する形は検知できない。

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Writable } from 'node:stream'

import { jstHour, jstHourStartMs } from './jstTime'
import type { FusedWaveChunk } from './sensorFusion'

/** 1 チャンクの頭。**すべて little endian。** */
const HEADER_BYTES = 32
/** 頭の目印。再同期には使わないが、別の形式のファイルを読んだときに気づくため。 */
const MAGIC = 0x5357
/** 書き出す形式の版。読む側が知らない版を見たらそこで打ち切る。 */
const FORMAT_VERSION = 1
/**
 * 頭の 5 バイト目（旗）のうち「作り直した分」の印。**版は上げない** —— 旧い読み手はこのバイトを
 * 読まないので、印の付いた分もただのまとまりとして読める（二重に見えるだけで、壊れはしない）。
 */
const FLAG_REVISED = 0b1
/** 1 サンプルぶんの本体（3 軸 × f32 ＋ 効いたセンサーの本数 u8）。 */
const BYTES_PER_SAMPLE = 3 * 4 + 1

/** 1 チャンクに収められるサンプル数。**頭の `u16` が決める。** */
const MAX_SAMPLES_PER_CHUNK = 65535

/**
 * 1 まとまりが覆ってよい長さ。
 *
 * **読み返しの「1 時間前から見る」が成り立つ条件。** まとまりは自分の先頭が属する時の
 * ファイルへ丸ごと入るので、これを超える長さのまとまりがあると、後の時から問い合わせた
 * ときに 1 時間遡っただけでは届かない。実際のまとまりは 0.3 秒ほどなので、
 * ここへ掛かるのは上流（合成）が壊れたときだけ。
 */
const MAX_CHUNK_SPAN_MS = 10 * 60 * 1000

/**
 * 抱えたまま書き出せていない量の上限。**超えたら捨てる。**
 *
 * 合成波形は 1 観測点あたり毎秒 1.4 KB ほどなので、2 MB あれば 20 分以上ぶん抱えられる。
 */
const MAX_PENDING_BYTES_DEFAULT = 2 * 1024 * 1024

/** 流し口が壊れてから開き直すまで。**毎回開き直すと、詰まったディスクを叩き続ける。** */
const REOPEN_INTERVAL_MS_DEFAULT = 5_000

/** `close()` 全体に掛ける上限。 */
const CLOSE_BUDGET_MS_DEFAULT = 10_000

/**
 * 1 回の読み返しで開くファイルの上限（＝時間数）。
 *
 * **範囲の広さは呼び出し側が縛る**（`GET /waves` は 10 分）が、ここにも歯止めを置く ——
 * 縛りを持たない呼び出しが後から足されたとき、際限なくディスクを舐める形になるのを防ぐ。
 * 26 にしてあるのは 1 日ぶん（24）＋ 前後のまたぎ。
 */
const MAX_FILES_PER_READ = 26

const HOUR_MS = 60 * 60 * 1000

/** 保存できなかった理由。**数えるために分ける** —— 手当てが違う。 */
export type WaveUnsavedReason =
  /** 流し口を開けていない（開き直しの間隔を待っている最中を含む）。 */
  | 'no-stream'
  /** 書き出しが追いつかず、抱えた量が上限を超えた。 */
  | 'backpressure'
  /** 書き込みそのものが失敗した。 */
  | 'write-failed'
  /** 既に締めたあとに渡された。 */
  | 'closed'
  /**
   * そのまとまりを形にできなかった（時刻が時刻として表せない・刻みが正でない・
   * 3 軸の長さが揃っていない・1 チャンクに収まらない）。
   *
   * **捨てたことを「書けなかった」と混ぜない。** こちらはディスクと無関係で、
   * 手当ては上流（合成）を見ること。
   */
  | 'bad-chunk'

export type WaveWriteResult =
  | {
      readonly saved: true
      /**
       * 書くものが無かった（サンプル 0 件）。**失っていない。**
       *
       * 真偽の欄で持つのは、`saved: true` の 2 形を判別できる型にならないため
       * （`{ saved: true }` は `{ saved: true; empty: true }` にも代入できてしまう）。
       */
      readonly empty: boolean
    }
  | { readonly saved: false; readonly reason: WaveUnsavedReason }

/** 作り直した分を足した結果（{@link WaveArchive.writeRevised}）。 */
export interface RevisedWriteResult {
  /** 書き終えたまとまりの数。 */
  readonly written: number
  /** 書けなかったまとまりの数（流し口を開けない・書き込みの失敗・締めたあと）。 */
  readonly lost: number
  /** 形にできずに捨てたまとまりの数（`bad-chunk` と同じ理由）。 */
  readonly bad: number
}

export interface WaveArchiveOptions {
  /** 書き出す先。無ければ作る。**作れなければ投げる。** */
  readonly dir: string
  /** いまの時刻（unix ミリ秒）。差し替えられるのはテストのため。 */
  readonly now?: () => number
  readonly maxPendingBytes?: number
  readonly reopenIntervalMs?: number
  readonly closeBudgetMs?: number
  /**
   * 流し口を開く。**差し替えられるのはテストのため。**
   *
   * 「書き込みが失敗する」「閉じるのに時間が掛かる」相手は、本物のファイルでは
   * 決め打ちで作れない。ここを差し替えられないと、失敗の手当てが効いているかを
   * 一度も確かめられない。
   */
  readonly openStream?: (path: string) => Writable
}

/**
 * 観測点の識別子を、ファイル名に使える形へ。
 *
 * **そのまま使わない。** `stationId` は設定ファイル・管理コンソールから来る任意の文字列で、
 * 空でないことしか保証がない（`stationConfig.ts` の `parseStations`）—— 区切り文字や
 * 予約名が混じれば、置き場所の外へ書きにいく形になる。
 *
 * **可逆である必要は無い**（読み返しは識別子を指定して来るので、同じ関数を通せば一致する）。
 * 要るのは**衝突しないこと**だけなので、読める形へ均した名前に指紋を足す ——
 * 均しただけだと `a/b` と `a_b` が同じ名前になる。
 */
export function stationFileToken(stationId: string): string {
  const safe = stationId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  const fingerprint = createHash('sha256').update(stationId).digest('hex').slice(0, 12)
  return `${safe}-${fingerprint}`
}

/** その観測点・その時のファイル名。 */
export function waveFileName(stationId: string, hourKey: string): string {
  return waveFileNameOfToken(stationFileToken(stationId), hourKey)
}

/** 札（{@link stationFileToken}）からの、その時のファイル名。 */
export function waveFileNameOfToken(stationKey: string, hourKey: string): string {
  return `wave-${stationKey}-${hourKey}.bin`
}

/**
 * まとまり 1 つを並びへ変える。**入口の検証もここで行う。**
 *
 * 形にできなければ `null` —— 呼び出し側は `bad-chunk` として数える。
 */
export function encodeWaveChunk(chunk: FusedWaveChunk, revised: boolean): Buffer | null {
  // **3 成分あることを実行時にも確かめる。** 型は組（タプル）で縛っているが、
  // ここで崩れると `axis.length` が投げ、**投げた先はこのまとまりを運んできた
  // データグラムの処理全体**（`main.ts` の受け手は例外を囲わない方針）——
  // 同じパケットの震度も自己診断もまとめて落ちるうえ、どの数え上げにも現れない。
  if (chunk.gal.length !== 3 || chunk.dcGal.length !== 3) return null
  const [ns, ew, ud] = chunk.gal
  const count = ns.length
  if (count === 0) return null
  if (ew.length !== count || ud.length !== count) return null
  if (chunk.memberCount.length !== count) return null
  if (count > MAX_SAMPLES_PER_CHUNK) return null
  if (!Number.isFinite(chunk.firstSampleMs)) return null
  if (!Number.isFinite(chunk.msPerSample) || chunk.msPerSample <= 0) return null
  // **1 まとまりが覆う長さにも上限を置く。** 読み返しは「まとまりは高々 1 時間ぶん」
  // という前提で範囲の 1 時間前から見る（{@link readWaveRange}）ので、それを超える
  // まとまりは**後の時から問い合わせたときに読み落とす**。実際は 0.3 秒ほどなので、
  // ここへ掛かるのは上流が壊れたときだけ。
  if ((count - 1) * chunk.msPerSample > MAX_CHUNK_SPAN_MS) return null

  const buf = Buffer.allocUnsafe(HEADER_BYTES + count * BYTES_PER_SAMPLE)
  buf.writeUInt16LE(MAGIC, 0)
  buf.writeUInt16LE(count, 2)
  buf.writeUInt8(FORMAT_VERSION, 4)
  buf.writeUInt8(revised ? FLAG_REVISED : 0, 5)
  buf.writeUInt16LE(0, 6)
  buf.writeDoubleLE(chunk.firstSampleMs, 8)
  buf.writeFloatLE(chunk.msPerSample, 16)
  // **直流はまとまりごとに 1 組だけ持つ。** `FusedWaveChunk` はサンプルごとに持っている
  // （落とした値を捨てない、という約束）が、直流は 100 Hz で動くものではない ——
  // まとまりは 0.3 秒ほどなので、その粒度で残せば「重力の向きと大きさ」は復元できる。
  // 毎サンプル持つと入れ物が倍近くになり、得るものは 0.3 秒より細かい直流の動きだけ。
  for (let a = 0; a < 3; a += 1) {
    const axis = chunk.dcGal[a]
    // **先頭ではなく平均。** まとまりの境目でだけ拾うと、跨いだところの値が実際より
    // 片寄る（直流は緩やかに動くので、代表としては平均のほうが素直）。
    let sum = 0
    let n = 0
    for (let i = 0; i < axis.length; i += 1) {
      const v = axis[i]
      if (Number.isFinite(v)) {
        sum += v
        n += 1
      }
    }
    buf.writeFloatLE(n > 0 ? sum / n : Number.NaN, 20 + a * 4)
  }

  let pos = HEADER_BYTES
  for (let a = 0; a < 3; a += 1) {
    const axis = chunk.gal[a]
    for (let i = 0; i < count; i += 1) {
      buf.writeFloatLE(axis[i], pos)
      pos += 4
    }
  }
  for (let i = 0; i < count; i += 1) {
    const m = chunk.memberCount[i]
    // **合わない値を書かずに落とさない。** 本数が読めない（`NaN`）まとまりでも波形そのものは
    // 使えるので、0（＝裏付け無し）へ倒して残す —— 捨てると波形ごと消える。
    buf.writeUInt8(Number.isFinite(m) ? Math.min(255, Math.max(0, Math.round(m))) : 0, pos)
    pos += 1
  }
  return buf
}

/** 読み返した 1 まとまり。 */
export interface ArchivedWaveChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** gal（直流を引いた変動分）。`gal[axis][i]` が i 番目のサンプル。 */
  readonly gal: readonly [Float32Array, Float32Array, Float32Array]
  /** そのまとまりの直流（重力）の平均。`gal` へ足せば校正済みの値に戻る。 */
  readonly dcGal: readonly [number, number, number]
  /** 各サンプルへ実際に効いたセンサーの数。 */
  readonly memberCount: Uint8Array
  /**
   * 欠けを取り戻したあとで生データから作り直した分か（`stationRewave.ts`）。読み返しは、
   * 重なるライブの分より印の付いた分を採る（{@link resolveRevisions}）。
   */
  readonly revised: boolean
}

export interface WaveRangeResult {
  readonly chunks: readonly ArchivedWaveChunk[]
  /** 開いて読めたファイルの数。 */
  readonly filesRead: number
  /** 無かったファイルの数。**その時のぶんは記録されていない**（異常ではない）。 */
  readonly filesMissing: number
  /** 開けたが読めなかったファイルの数。 */
  readonly filesFailed: number
  /**
   * 途中で打ち切って読まなかったバイト数の合計。**0 なら全部を最後まで読めた。**
   *
   * **「0 件だった」と「読めなかった」を分けるために持つ。** 打ち切るのは、頭の目印が
   * 合わない・知らない版・残りが 1 まとまりに満たない（＝書いている最中か、途中で落ちた）とき。
   */
  readonly skippedBytes: number
  /** 範囲が広すぎて、開くファイルの数の上限で切ったか。 */
  readonly truncated: boolean
}

/** 1 ファイルぶんを読み解く。**壊れた先は読まない**（`skippedBytes` に出る）。 */
export function decodeWaveFile(
  buf: Buffer,
  fromMs: number,
  toMs: number,
): { readonly chunks: ArchivedWaveChunk[]; readonly skippedBytes: number } {
  const chunks: ArchivedWaveChunk[] = []
  let pos = 0
  while (pos + HEADER_BYTES <= buf.length) {
    if (buf.readUInt16LE(pos) !== MAGIC) break
    if (buf.readUInt8(pos + 4) !== FORMAT_VERSION) break
    const count = buf.readUInt16LE(pos + 2)
    const total = HEADER_BYTES + count * BYTES_PER_SAMPLE
    // **残りが足りなければ読まない。** 書いている最中の末尾か、途中で落ちた跡。
    if (count === 0 || pos + total > buf.length) break

    const firstSampleMs = buf.readDoubleLE(pos + 8)
    const msPerSample = buf.readFloatLE(pos + 16)
    const lastMs = firstSampleMs + (count - 1) * msPerSample
    // **重なっていれば採る。** 端を跨ぐまとまりを落とすと、範囲の両端が欠ける。
    if (lastMs >= fromMs && firstSampleMs <= toMs) {
      const gal: [Float32Array, Float32Array, Float32Array] = [
        new Float32Array(count),
        new Float32Array(count),
        new Float32Array(count),
      ]
      let p = pos + HEADER_BYTES
      for (let a = 0; a < 3; a += 1) {
        const axis = gal[a]
        for (let i = 0; i < count; i += 1) {
          // **`Float32Array` の view を作らない。** 読み込んだ `Buffer` の先頭位置が
          // 4 の倍数である保証が無く（Node は小さい確保をプールから切り出す）、
          // 境界が合わなければ `new Float32Array(buffer, offset, n)` は投げる。
          axis[i] = buf.readFloatLE(p)
          p += 4
        }
      }
      const memberCount = new Uint8Array(count)
      for (let i = 0; i < count; i += 1) memberCount[i] = buf.readUInt8(p + i)
      chunks.push({
        firstSampleMs,
        msPerSample,
        gal,
        dcGal: [buf.readFloatLE(pos + 20), buf.readFloatLE(pos + 24), buf.readFloatLE(pos + 28)],
        memberCount,
        revised: (buf.readUInt8(pos + 5) & FLAG_REVISED) !== 0,
      })
    }
    pos += total
  }
  return { chunks, skippedBytes: buf.length - pos }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

/**
 * 時刻の範囲に重なる合成波形を読み返す。
 *
 * **範囲の 1 時間前のファイルから見る。** まとまりは自分の先頭が属する時のファイルへ
 * 丸ごと入るので、時の境目を跨いだまとまりは 1 つ前のファイルの末尾にいる。
 */
export async function readWaveRange(params: {
  readonly dir: string
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
}): Promise<WaveRangeResult> {
  const { stationId, ...rest } = params
  return readWaveRangeByToken({ ...rest, stationKey: stationFileToken(stationId) })
}

/**
 * {@link readWaveRange} を、観測点の識別子ではなくファイル名の札（{@link stationFileToken}）で引く形。
 * **札から識別子へは戻せない**ので、ファイルの名前から観測点を知る読み手（管理コンソールの
 * 「波形の記録」）はこちらを使う —— 設定から外した観測点の記録も読める。
 */
export async function readWaveRangeByToken(params: {
  readonly dir: string
  readonly stationKey: string
  readonly fromMs: number
  readonly toMs: number
}): Promise<WaveRangeResult> {
  const { dir, stationKey, fromMs, toMs } = params
  const chunks: ArchivedWaveChunk[] = []
  let filesRead = 0
  let filesMissing = 0
  let filesFailed = 0
  let skippedBytes = 0
  let truncated = false

  const startHour = jstHourStartMs(fromMs)
  if (startHour === null || !Number.isFinite(toMs) || toMs < fromMs) {
    return { chunks, filesRead, filesMissing, filesFailed, skippedBytes, truncated }
  }

  for (let i = 0; i < MAX_FILES_PER_READ; i += 1) {
    const at = startHour - HOUR_MS + i * HOUR_MS
    if (at > toMs) break
    if (i === MAX_FILES_PER_READ - 1 && at + HOUR_MS <= toMs) truncated = true
    const hourKey = jstHour(at)
    if (hourKey === null) continue
    let buf: Buffer
    try {
      buf = await readFile(join(dir, waveFileNameOfToken(stationKey, hourKey)))
    } catch (error) {
      if (isMissing(error)) filesMissing += 1
      else filesFailed += 1
      continue
    }
    filesRead += 1
    const decoded = decodeWaveFile(buf, fromMs, toMs)
    for (const c of decoded.chunks) chunks.push(c)
    skippedBytes += decoded.skippedBytes
  }

  // **重なりを解いてから並べ直す。** `chunks` はいま書いた順（ファイル順・ファイルの中の順）で、
  // 作り直し同士は後から書いたほうを採るのにその順を使う。走査はファイル順（＝時刻順）だが、
  // 1 時間前から見る都合で跨いだまとまりが先に来る。時刻で揃えておけば、受け手が並び順を気にせず繋げる。
  const resolved = resolveRevisions(chunks)
  resolved.sort((a, b) => a.firstSampleMs - b.firstSampleMs)
  return { chunks: resolved, filesRead, filesMissing, filesFailed, skippedBytes, truncated }
}

/** まとまりの `[from, to)` 番目のサンプルだけを切り出す。 */
function sliceChunk(c: ArchivedWaveChunk, from: number, to: number): ArchivedWaveChunk {
  return {
    firstSampleMs: c.firstSampleMs + from * c.msPerSample,
    msPerSample: c.msPerSample,
    gal: [c.gal[0].subarray(from, to), c.gal[1].subarray(from, to), c.gal[2].subarray(from, to)],
    dcGal: c.dcGal,
    memberCount: c.memberCount.subarray(from, to),
    revised: c.revised,
  }
}

/**
 * 作り直した分とライブの分の重なりを解く。`chunks` は**書いた順**で渡すこと。
 *
 * - **作り直した分はライブの分より優先する。** 重なったライブのサンプルは返さない
 * - **作り直し同士は、後から書いたほうを優先する**（もう一度作り直したら、新しいほうが正）
 * - **削るのはサンプル単位。** まとまりごと捨てると、境目でライブのまとまりの残り半分が穴になる
 *   （作り直しの区切りとライブの区切りは揃わない）
 *
 * あるサンプルが覆われているかは、優先する側のまとまりの「最初のサンプルの半刻み手前から最後の
 * サンプルの半刻み先まで」に入るかで見る。**作り直した分が 1 つも無ければ、そのまま返す。**
 */
export function resolveRevisions(chunks: readonly ArchivedWaveChunk[]): ArchivedWaveChunk[] {
  if (!chunks.some((c) => c.revised)) return [...chunks]
  const covered: Array<[number, number]> = []
  const isCovered = (t: number): boolean => covered.some(([a, b]) => t >= a && t < b)
  const out: ArchivedWaveChunk[] = []
  const take = (c: ArchivedWaveChunk): void => {
    const n = c.memberCount.length
    let runStart = -1
    for (let i = 0; i <= n; i += 1) {
      const free = i < n && !isCovered(c.firstSampleMs + i * c.msPerSample)
      if (free && runStart < 0) runStart = i
      if (!free && runStart >= 0) {
        out.push(runStart === 0 && i === n ? c : sliceChunk(c, runStart, i))
        runStart = -1
      }
    }
  }
  // 作り直した分を新しい順に。採った範囲を覆いへ足していく。
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const c = chunks[i]!
    if (!c.revised) continue
    take(c)
    const half = c.msPerSample / 2
    const span: [number, number] = [c.firstSampleMs - half, c.firstSampleMs + (c.memberCount.length - 1) * c.msPerSample + half]
    // **直前に足した覆いと接していれば繋ぐ。** 1 回の作り直しは数百まとまりを時刻順に書くので、
    // 新しい順に回すと隣り合ったまとまりが続けて来る。繋がないと、覆いの判定がサンプルごとに
    // その数だけ回る（10 分の読み返しで 1 億回近く）。
    const last = covered[covered.length - 1]
    if (last !== undefined && span[1] >= last[0] && span[0] <= last[1]) {
      last[0] = Math.min(last[0], span[0])
      last[1] = Math.max(last[1], span[1])
    } else {
      covered.push(span)
    }
  }
  for (const c of chunks) if (!c.revised) take(c)
  return out
}

interface OpenBook {
  readonly stream: Writable
  readonly hourKey: string
  pending: number
  broken: boolean
  /**
   * ライブの本として持っている観測点。**作り直しが開いた脇の本（{@link WaveArchive.writeRevised}）は
   * `null`** で、ライブがその時へ切り替わったら引き継いで観測点を入れる。
   */
  owner: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WaveArchive {
  private readonly dir: string
  private readonly now: () => number
  private readonly maxPendingBytes: number
  private readonly reopenIntervalMs: number
  private readonly closeBudgetMs: number
  private readonly openStream: (path: string) => Writable

  /** 観測点ごとに 1 冊。**時が変われば閉じて開き直す。** */
  private readonly books = new Map<string, OpenBook>()
  /**
   * 作り直しがライブの外の時へ書くために開いた本（ファイルの場所ごと）。**ライブが同じ時へ
   * 切り替わったら、新しく開かずにこれを引き継ぐ** —— 1 つのファイルへ 2 本の書き口を開かない。
   */
  private readonly sideBooks = new Map<string, OpenBook>()
  /**
   * 脇の本を次に開いてよい時刻（ファイルの場所ごと）。**ライブの {@link reopenAt} とは分ける** ——
   * 過去の時のファイルが開けないだけで、ライブが次の時を開くのまで待たせない。
   */
  private readonly sideReopenAt = new Map<string, number>()
  /** 観測点ごとの、次に開いてよい時刻。**壊れた直後に開き直し続けないため。** */
  private readonly reopenAt = new Map<string, number>()
  /** 締め終わっていない本。**解決したら外す** —— 積みっぱなしにすると伸び続ける。 */
  private readonly closing = new Set<Promise<void>>()
  private closed = false

  private writeErrorCount = 0
  private lostCount = 0
  private badChunkCount = 0
  private writtenCount = 0
  private revisedWrittenCount = 0
  private revisedLostCount = 0
  private rotatedCount = 0
  private slowCloseFlag = false
  private lastWriteErrorText: string | null = null

  constructor(options: WaveArchiveOptions) {
    this.dir = options.dir
    this.now = options.now ?? Date.now
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES_DEFAULT
    this.reopenIntervalMs = options.reopenIntervalMs ?? REOPEN_INTERVAL_MS_DEFAULT
    this.closeBudgetMs = options.closeBudgetMs ?? CLOSE_BUDGET_MS_DEFAULT
    this.openStream = options.openStream ?? ((path) => createWriteStream(path, { flags: 'a' }))
    // **作れなければここで投げる。** 黙って保存せずに走るのがいちばん悪い。
    mkdirSync(this.dir, { recursive: true })
  }

  /** 流し口が壊れた回数。**本ごとなので、失ったまとまりの件数とは別**（次の欄）。 */
  get writeErrors(): number {
    return this.writeErrorCount
  }

  /**
   * 書き出せずに失ったまとまりの件数。
   *
   * **流し口を開けていない間に来たぶんも含む**（`no-stream`）。流し口が壊れた回数
   * （{@link writeErrors}）は開き直しの間隔ごとにしか増えないので、あれだけでは
   * 失われた量が桁で分からない。
   */
  get lostRecords(): number {
    return this.lostCount
  }

  /** 形にできずに捨てたまとまりの件数。**ディスクとは無関係**（手当ては上流を見ること）。 */
  get badChunks(): number {
    return this.badChunkCount
  }

  /** 流し口へ渡せたまとまりの件数。**「保存が動いている」ことを外から確かめる唯一の欄。** */
  get written(): number {
    return this.writtenCount
  }

  /** 作り直して足したまとまりの件数（{@link writeRevised}）。 */
  get revisedWritten(): number {
    return this.revisedWrittenCount
  }

  /** 作り直したのに書けなかったまとまりの件数。 */
  get revisedLost(): number {
    return this.revisedLostCount
  }

  /** 時が変わって本を切り替えた回数。 */
  get rotated(): number {
    return this.rotatedCount
  }

  /** 書き出しは済んだのに、閉じ終わるのを待ちきれなかったか。**1 件も失っていない。** */
  get slowClose(): boolean {
    return this.slowCloseFlag
  }

  /** いま開いている本の数。 */
  get openBooks(): number {
    return this.books.size
  }

  /** 直近の書き込みの失敗の文面。 */
  get lastWriteError(): string | null {
    return this.lastWriteErrorText
  }

  write(chunk: FusedWaveChunk): WaveWriteResult {
    if (this.closed) return { saved: false, reason: 'closed' }

    const hourKey = jstHour(chunk.firstSampleMs)
    if (hourKey === null) {
      this.badChunkCount += 1
      return { saved: false, reason: 'bad-chunk' }
    }
    // **`chunk.gal[0]` へ直に触らない。** 3 成分あることは型（組）が縛っているが、
    // 崩れたときにここで `undefined.length` を読むと、**その壊れ方を `bad-chunk` として
    // 受け止めるはずの `encodeWaveChunk` の検証へ辿り着く前に投げる** ——
    // 同じパケットが運んできた震度も自己診断もまとめて落ち、どの数え上げにも現れない。
    if (chunk.gal.length === 3 && chunk.gal[0].length === 0) return { saved: true, empty: true }


    const payload = encodeWaveChunk(chunk, false)
    if (payload === null) {
      this.badChunkCount += 1
      return { saved: false, reason: 'bad-chunk' }
    }

    const book = this.bookFor(chunk.stationId, hourKey)
    if (book === null) {
      // **開けなかった間に来たまとまりも「失った」に数える。** 流し口が壊れた回数
      // （`writeErrors`）は開き直しの間隔ごとにしか増えないので、あれだけでは
      // **失われた量が桁で分からない**（毎秒 3 件ほど来るのに、数字は 5 秒に 1 つ）。
      // 生データの保存（`mseedStore`）も同じ数え方をする。
      this.lostCount += 1
      return { saved: false, reason: 'no-stream' }
    }
    if (book.pending + payload.length > this.maxPendingBytes) {
      this.lostCount += 1
      return { saved: false, reason: 'backpressure' }
    }

    book.pending += payload.length
    // **抱えている量を負へ落とさない。** 壊れた本は抱え分をまとめて 0 にするので、
    // その後に届いたコールバックが素直に引くと負になり、上限の判定が二度と効かなくなる。
    const release = (): void => {
      book.pending = Math.max(0, book.pending - payload.length)
    }
    try {
      book.stream.write(payload, (error) => {
        release()
        if (error) {
          this.lostCount += 1
          this.lastWriteErrorText = messageOf(error)
        }
      })
    } catch (error) {
      release()
      this.lostCount += 1
      this.lastWriteErrorText = messageOf(error)
      this.breakBook(chunk.stationId, book)
      return { saved: false, reason: 'write-failed' }
    }
    this.writtenCount += 1
    return { saved: true, empty: false }
  }

  /**
   * 生データから作り直したまとまり（`stationRewave.ts`）を、「作り直し」の印を付けて足す。
   * **書き終えるまで待つ**（書けた数を返す）。投げない。
   *
   * **ライブの {@link write} を通さない。** あちらは時が変わると本を閉じて開き直すので、過去の時の
   * まとまりを渡すと、いま書いている本を閉じて過去の本を開き、次のライブのまとまりでまた開き直す。
   * - その時の本をライブで開いていれば、その流し口へ続けて書く（**1 つのファイルへ 2 か所から書かない**）
   * - 開いていなければ、その時のファイルを追記で開き（脇の本・{@link sideBooks}）、書き終えたら閉じる。
   *   **書いている最中にライブがその時へ切り替わったら、ライブはそれを引き継ぐ**（閉じるのはライブの側）
   * - 閉じかけのライブの本（時が変わって締めくくりへ回した本）とは、書き口が一時 2 本になりうる。
   *   閉じかけの本はもう新しく書かず、溜めた分を吐き出すだけで、追記は 1 回の書き込みごとに末尾へ足される
   *   ので、まとまりが途中で混ざることはない
   *
   * 印の付いた分は読み返しでライブより優先される（{@link resolveRevisions}）ので、ファイルを
   * 書き換えずに済む。
   */
  async writeRevised(stationId: string, chunks: readonly FusedWaveChunk[]): Promise<RevisedWriteResult> {
    let written = 0
    let lost = 0
    let bad = 0
    const byHour = new Map<string, Buffer[]>()
    for (const chunk of chunks) {
      const hourKey = jstHour(chunk.firstSampleMs)
      const payload = hourKey === null ? null : encodeWaveChunk(chunk, true)
      if (hourKey === null || payload === null) {
        bad += 1
        continue
      }
      const list = byHour.get(hourKey) ?? []
      list.push(payload)
      byHour.set(hourKey, list)
    }
    for (const [hourKey, payloads] of byHour) {
      if (this.closed) {
        lost += payloads.length
        continue
      }
      const live = this.books.get(stationId)
      let ok: number
      if (live !== undefined && !live.broken && live.hourKey === hourKey) {
        ok = await this.appendPayloads(live, payloads)
      } else {
        const path = join(this.dir, waveFileName(stationId, hourKey))
        const side = this.sideBookFor(path, hourKey)
        ok = side === null ? 0 : await this.appendPayloads(side, payloads)
        // **ライブが引き継いでいなければ閉じる**（引き継いだなら、閉じるのはライブの側）。
        if (side !== null && this.sideBooks.get(path) === side) {
          this.sideBooks.delete(path)
          this.retire(side)
        }
      }
      written += ok
      lost += payloads.length - ok
    }
    this.revisedWrittenCount += written
    this.revisedLostCount += lost
    this.badChunkCount += bad
    return { written, lost, bad }
  }

  /**
   * 本へまとめて書き、書けた数を返す。投げない。**抱える量の上限はライブの {@link write} と同じに
   * 数える** —— 作り直しは数百まとまりを一度に渡すので、数えないとディスクが詰まった間に
   * 上限を越えて抱え込み、そのことがどの数え上げにも出ない。上限を越える分は書かない。
   */
  private appendPayloads(book: OpenBook, payloads: readonly Buffer[]): Promise<number> {
    return Promise.all(
      payloads.map(
        (p) =>
          new Promise<boolean>((resolve) => {
            if (book.broken || book.pending + p.length > this.maxPendingBytes) {
              resolve(false)
              return
            }
            book.pending += p.length
            try {
              book.stream.write(p, (error) => {
                book.pending = Math.max(0, book.pending - p.length)
                if (error) this.lastWriteErrorText = messageOf(error)
                resolve(!error)
              })
            } catch (error) {
              book.pending = Math.max(0, book.pending - p.length)
              this.lastWriteErrorText = messageOf(error)
              resolve(false)
            }
          }),
      ),
    ).then((results) => results.filter(Boolean).length)
  }

  /** 作り直しが書く脇の本。**開いていればそれ、無ければ開く。** 開けなければ `null`。投げない。 */
  private sideBookFor(path: string, hourKey: string): OpenBook | null {
    const open = this.sideBooks.get(path)
    if (open !== undefined && !open.broken) return open
    // **開けなかった・壊れた直後は開き直さない**（ライブの本と同じく、詰まったディスクを叩き続けない）。
    const nowMs = this.now()
    // **期限の切れた覚えはここで捨てる。** 鍵はファイル（観測点 × 時）なので、同じ時へ二度と書かなければ
    // 残り続ける —— ディスクが長く詰まると、詰まっていた間に作り直した時の数だけ積み上がる。
    for (const [p, until] of this.sideReopenAt) if (until <= nowMs) this.sideReopenAt.delete(p)
    if (nowMs < (this.sideReopenAt.get(path) ?? 0)) return null
    let stream: Writable
    try {
      stream = this.openStream(path)
    } catch (error) {
      this.writeErrorCount += 1
      this.lastWriteErrorText = messageOf(error)
      this.sideReopenAt.set(path, nowMs + this.reopenIntervalMs)
      return null
    }
    this.sideReopenAt.delete(path)
    const book: OpenBook = { stream, hourKey, pending: 0, broken: false, owner: null }
    this.watchErrors(book)
    this.sideBooks.set(path, book)
    return book
  }

  /**
   * 本の流し口の `error` を受ける。**壊れたら本ごと捨てる** —— `error` の後も書き続けると、
   * 渡した分が黙って消える。ライブの本なら開き直しの間隔を置く（{@link breakBook}）。
   */
  private watchErrors(book: OpenBook): void {
    book.stream.on('error', (error) => {
      this.lastWriteErrorText = messageOf(error)
      if (book.owner !== null) {
        this.breakBook(book.owner, book)
        return
      }
      // 脇の本。**ライブの本と同じく「流し口が壊れた」に数え**、しばらく開き直さない。
      if (book.broken) return
      book.broken = true
      book.pending = 0
      this.writeErrorCount += 1
      for (const [path, side] of this.sideBooks) {
        if (side !== book) continue
        this.sideBooks.delete(path)
        this.sideReopenAt.set(path, this.now() + this.reopenIntervalMs)
      }
    })
  }

  /**
   * その観測点・その時の本。**無ければ開く。**
   *
   * 開けなければ `null`（次に開いてよい時刻まで待つ）。
   */
  private bookFor(stationId: string, hourKey: string): OpenBook | null {
    const current = this.books.get(stationId)
    if (current !== undefined && !current.broken) {
      if (current.hourKey === hourKey) return current
      // 時が変わった。**古い本は締めくくりへ回す**（待たない —— 待つと、
      // 日が変わる瞬間に届いたまとまりを取りこぼす）。
      this.books.delete(stationId)
      this.rotatedCount += 1
      this.retire(current)
    }

    const waitUntil = this.reopenAt.get(stationId) ?? 0
    const nowMs = this.now()
    if (nowMs < waitUntil) return null

    const path = join(this.dir, waveFileName(stationId, hourKey))
    // **作り直しがその時のファイルを開いていれば引き継ぐ**（{@link sideBooks}）。
    const side = this.sideBooks.get(path)
    if (side !== undefined && !side.broken) {
      this.sideBooks.delete(path)
      side.owner = stationId
      this.books.set(stationId, side)
      return side
    }
    let stream: Writable
    try {
      stream = this.openStream(path)
    } catch (error) {
      this.writeErrorCount += 1
      this.lastWriteErrorText = messageOf(error)
      this.reopenAt.set(stationId, nowMs + this.reopenIntervalMs)
      return null
    }
    const book: OpenBook = { stream, hourKey, pending: 0, broken: false, owner: stationId }
    this.watchErrors(book)
    this.books.set(stationId, book)
    return book
  }

  /** 壊れた本を外し、開き直しの間隔を置く。**同じ本で二度数えない。** */
  private breakBook(stationId: string, book: OpenBook): void {
    if (book.broken) return
    book.broken = true
    this.writeErrorCount += 1
    // 抱えていた分はまとめて失われる。
    if (book.pending > 0) book.pending = 0
    if (this.books.get(stationId) === book) this.books.delete(stationId)
    this.reopenAt.set(stationId, this.now() + this.reopenIntervalMs)
    this.retire(book)
  }

  /** 本を閉じる。**投げない** —— 閉じ損ねても受信は続ける。 */
  private retire(book: OpenBook): void {
    const done = new Promise<void>((resolve) => {
      try {
        book.stream.end(() => resolve())
      } catch {
        resolve()
      }
    })
    this.closing.add(done)
    void done.finally(() => this.closing.delete(done))
  }

  /**
   * 締めくくる。**以後の `write` は `closed` で断る。**
   *
   * 上限を過ぎても閉じ終わらなければ諦める（`slowClose` が立つ）。
   * **ここで諦めても、渡し終えた分が消えるわけではない** —— OS が引き取っている。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [, book] of this.books) this.retire(book)
    this.books.clear()
    for (const [, book] of this.sideBooks) this.retire(book)
    this.sideBooks.clear()

    const budget = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.closeBudgetMs)
      // **プロセスの終了を引き止めない。**
      if (typeof timer.unref === 'function') timer.unref()
    })
    const all = Promise.all([...this.closing]).then(() => 'done' as const)
    if ((await Promise.race([all, budget])) === 'timeout') this.slowCloseFlag = true
  }
}
