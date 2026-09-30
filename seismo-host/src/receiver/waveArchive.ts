// 観測点の合成波形を、時刻で頭出しできる形で残す。
//
// **生データ（`rawStore.ts`）では代われない。** あちらが残すのはセンサー単独の RAW カウント値で、
// 画面に出ている合成波形を作り直すには補正 → 区間の組み立て → 合成を通し直す必要がある
// （当時の観測点設定も要る）。しかも日ごとの追記型で、実機の実測で **1 日 1.95 GB** ——
// その日の中で頭出しする手立てが無い。
//
// **1 時間ごとに 1 本へ切る。ファイル名が索引を兼ねる。** 別に索引ファイルを持つと、
// そこが指すバイト位置と実際に書けた量がずれる形（プロセスが落ちた・書き出しが詰まった）を
// 抱え込む。1 本 5 MB 弱なので、読み返しはそのファイルを頭から走査すれば足りる。
//
// **gzip しない。** `rawStore` は古い日を圧縮するが、あれは「読み返さない」前提だから
// できること。圧縮するとランダムアクセスができなくなり、この入れ物の唯一の取り柄が消える。
//
// **消さない。** `rawStore` と同じ約束（ディスクが埋まる前に人が消す）。
//
// **チャンクをそのまま並べる。固定の時間グリッドへ割り付けない。** 刻みは公称 100 Hz に
// 対して実測 0.16% 揺らぐので、グリッドへ丸めると誤差が積み上がり、連続して届いている
// データが偽の欠測に化ける（PWA 側のリングバッファで一度踏んだ罠。
// `docs/spec/data-sources-spec.md` §4.5）。
//
// **落ちない。** 保存が止まっても震度と押し出しは続ける。ただし黙らない —— 失った件数と
// 流し口の異常を、呼び出し側が数えられる形で持つ（`rawStore` と同じ分担）。
//
// **既知の限界: `fsync` は掛けていない。** 書き込みのコールバックが成功で返ってから
// 実際の永続化が失敗する形は検知できない（`rawStore` と同じ）。

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
 * `rawStore` の 8 MB より小さいのは、流れてくる量が桁で違うため —— 合成波形は
 * 1 観測点あたり毎秒 1.4 KB ほどで、生データ（毎秒 23 KB）の 1/16。
 * それでも 2 MB あれば 20 分以上ぶん抱えられる。
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
   * 一度も確かめられない（`rawStore` と同じ理由）。
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
  return `wave-${stationFileToken(stationId)}-${hourKey}.bin`
}

/**
 * まとまり 1 つを並びへ変える。**入口の検証もここで行う。**
 *
 * 形にできなければ `null` —— 呼び出し側は `bad-chunk` として数える。
 */
export function encodeWaveChunk(chunk: FusedWaveChunk): Buffer | null {
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
  buf.writeUInt8(0, 5)
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
  const { dir, stationId, fromMs, toMs } = params
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
      buf = await readFile(join(dir, waveFileName(stationId, hourKey)))
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

  // **並べ直す。** 走査はファイル順（＝時刻順）だが、1 時間前から見る都合で
  // 跨いだまとまりが先に来る。時刻で揃えておけば、受け手が並び順を気にせず繋げる。
  chunks.sort((a, b) => a.firstSampleMs - b.firstSampleMs)
  return { chunks, filesRead, filesMissing, filesFailed, skippedBytes, truncated }
}

interface OpenBook {
  readonly stream: Writable
  readonly hourKey: string
  pending: number
  broken: boolean
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
  /** 観測点ごとの、次に開いてよい時刻。**壊れた直後に開き直し続けないため。** */
  private readonly reopenAt = new Map<string, number>()
  /** 締め終わっていない本。**解決したら外す** —— 積みっぱなしにすると伸び続ける。 */
  private readonly closing = new Set<Promise<void>>()
  private closed = false

  private writeErrorCount = 0
  private lostCount = 0
  private badChunkCount = 0
  private writtenCount = 0
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


    const payload = encodeWaveChunk(chunk)
    if (payload === null) {
      this.badChunkCount += 1
      return { saved: false, reason: 'bad-chunk' }
    }

    const book = this.bookFor(chunk.stationId, hourKey)
    if (book === null) {
      // **開けなかった間に来たまとまりも「失った」に数える。** 流し口が壊れた回数
      // （`writeErrors`）は開き直しの間隔ごとにしか増えないので、あれだけでは
      // **失われた量が桁で分からない**（毎秒 3 件ほど来るのに、数字は 5 秒に 1 つ）。
      //
      // **`rawStore` はここを数えていない。** あちらの `lostRecords` は書き出しの
      // 失敗だけを数える —— 同じ穴だが、直すとあちらの数字の意味が変わるので
      // 別に扱う（#401）。**新しく作るこちらは、失った件数を失った件数として持つ。**
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

    let stream: Writable
    try {
      stream = this.openStream(join(this.dir, waveFileName(stationId, hourKey)))
    } catch (error) {
      this.writeErrorCount += 1
      this.lastWriteErrorText = messageOf(error)
      this.reopenAt.set(stationId, nowMs + this.reopenIntervalMs)
      return null
    }
    const book: OpenBook = { stream, hourKey, pending: 0, broken: false }
    // **壊れたら本ごと捨てる。** `error` の後も書き続けると、渡した分が黙って消える。
    stream.on('error', (error) => {
      this.lastWriteErrorText = messageOf(error)
      this.breakBook(stationId, book)
    })
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

    const budget = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.closeBudgetMs)
      // **プロセスの終了を引き止めない。**
      if (typeof timer.unref === 'function') timer.unref()
    })
    const all = Promise.all([...this.closing]).then(() => 'done' as const)
    if ((await Promise.race([all, budget])) === 'timeout') this.slowCloseFlag = true
  }
}
