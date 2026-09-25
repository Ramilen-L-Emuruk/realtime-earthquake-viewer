// 自作センサーの受け手。UDP で待ち受け、届いたパケットを段 1〜3 へ通して
// 計測震度相当を出す常駐プロセス。
//
// **いまの出口は標準出力と生データのファイル。** 状態の口（JSON と SSE）は 4-4 が受け持つ。
// **配る中身は 2 つある** —— 数え上げ（`src/receiver/packetTally.ts` の `snapshotTotal()`）と、
// **保存の健全性**（`RawStore` の `writeErrors` / `lostRecords` / `compressed` /
// `compressFailures` / `leftovers` / `openFiles`）。後者は表の外にあるので、
// 前者だけを配ると「生データが残っていない」ことが状態の口から丸ごと落ちる。
//
// **画面を持たない常駐プロセスなので、黙ったら誰も気づかない。** 受け取った結果
// （`PacketOutcome`）のどの欄も読み捨てないこと —— 読み捨てた欄は、そこで起きた異常が
// どこにも現れないことを意味する。
//
// **1 件ずつの行は見本、正確な数は表のほう。** 速度の上限を入れた以上、落ちたパケット
// 1 つにつき 1 行出す作りのままだと上限いっぱいで撃たれたとき毎秒 100 行が流れる。
// 行は間引き（`src/receiver/logThrottle.ts`）を通し、数は要約で出す。
//
// 起動:
//   npm run seismo-host
//   SEISMO_UDP_PORT=50505 SEISMO_UDP_ADDRESS=0.0.0.0 npm run seismo-host
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MAX_TIME_MS, parseSensorPacket } from './src/protocol/parsePacket'
import { IntensityPipeline } from './src/receiver/intensityPipeline'
import type { CloseFailure, IntensityReading } from './src/receiver/intensityPipeline'
import { LogThrottle, suppressedSuffix } from './src/receiver/logThrottle'
import { PacketTally, formatTally } from './src/receiver/packetTally'
import type { TallySnapshot } from './src/receiver/packetTally'
import { RawStore } from './src/receiver/rawStore'
import { SourceRateLimit } from './src/receiver/sourceRateLimit'
import { startUdpReceiver } from './src/receiver/udpReceiver'
import type { DatagramSource } from './src/receiver/udpReceiver'
import { streamKeyOf } from './src/timebase/segmenter'

/** 記録係の原型（`capture.mjs`）と同じ口。基板の送り先もこの値。 */
const DEFAULT_PORT = 50505

/** 読めなかった中身を記録へ出す長さ。**全部は出さない** —— 1 行が読めなくなる。 */
const DETAIL_CHARS = 120

/** 要約を出す間隔。 */
const SUMMARY_INTERVAL_MS = 60_000

/**
 * 生データの既定の置き場所。
 *
 * **このファイルからの相対で解決する。** 実行時の作業ディレクトリを基準にすると、
 * どこから `npm run seismo-host` を叩いたかで書き出し先が変わる。
 * `.gitignore` 済み —— **このリポジトリは公開されていて、3 台 1 日で 600 MB 前後増える。**
 * （封筒を付けたあとの嵩。内訳は `seismo-host/README.md`「日の境目と圧縮」）
 */
function defaultRawDir(): string {
  return fileURLToPath(new URL('./data/raw/', import.meta.url))
}

/**
 * 10 進の整数だけを通す。**`Number()` に任せない** —— あれは `0x1F91` を 8081 として受け、
 * 打ち間違えたつもりの無い値が「読めた」ことになる（読み取り側の `DECIMAL_INTEGER_RE` と同じ判断）。
 */
const DECIMAL_PORT_RE = /^\d{1,5}$/

export function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  // **黙って既定へ倒さない。** 打ち間違えたまま「別のポートで動いている」状態は、
  // 基板からの送信が届かない理由として画面にも記録にも現れない。
  if (!DECIMAL_PORT_RE.test(raw)) {
    throw new Error(`SEISMO_UDP_PORT が port 番号として読めない: ${raw}`)
  }
  const port = Number(raw)
  if (port > 65535) throw new Error(`SEISMO_UDP_PORT が port 番号の範囲を超えている: ${raw}`)
  return port
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatSource(from: DatagramSource): string {
  return `${from.address}:${from.port}`
}

function shorten(detail: string): string {
  return detail.length <= DETAIL_CHARS ? detail : `${detail.slice(0, DETAIL_CHARS)}…`
}

/**
 * 時刻を文字列にする。**出せない値でも投げない。**
 *
 * `new Date(v).toISOString()` は `Date` が表せる範囲の外で例外を投げる。読み取りの側
 * （`src/protocol/parsePacket.ts`）で弾いてあるが、`atMs` は名乗られた時刻そのものでは
 * なく区間の当てはめから引いた値なので、ここでも投げない形にしておく
 * （このリポジトリが「日時は 2 つの層で確かめる」と決めているのと同じ考え方）。
 *
 * **1 件の整形の失敗で他を巻き添えにしない。** 出す側は 1 パケットぶんの震度をまとめて
 * 回しており、しかも**その中には他の基板の締めくくりが混ざる**。途中で投げると、
 * 残りは数えも出しもされないまま消える。行そのものは印を付けて必ず出す ——
 * 震度の値は生きているし、時刻が壊れていることは読めば分かる。
 */
export function formatAt(atMs: number): string {
  if (!Number.isFinite(atMs) || Math.abs(atMs) > MAX_TIME_MS) return `時刻不正(${atMs})`
  return new Date(atMs).toISOString()
}

function printReading(r: IntensityReading): void {
  const at = formatAt(r.atMs)
  const value = r.intensity === null ? '-' : r.intensity.toFixed(2)
  // **時刻の根拠が崩れていたら、その行に書く。** 倒れている間の `atMs` は正常時と
  // 同じ形をしているので、行の外で報せると正常な値と見分けが付かない。
  const timebase = r.timebaseNominalReason === null ? '' : ` 時刻=公称(${r.timebaseNominalReason})`
  console.log(`${at} ${r.boardKey} ${r.sensorId} seg=${r.segmentId} I=${value}${timebase}`)
}

/**
 * 表に出ない数え上げを 1 行にするための組。
 *
 * **0 のときは出さない規則をここ 1 箇所に置く。** 呼び出し側で書き分けると、
 * 数え上げを足すたびに「0 でも出てしまう」形が混ざる。
 */
export interface WindowCounter {
  readonly label: string
  readonly value: number
}

export interface WindowSummaryInput {
  /** 窓の長さ（秒）。 */
  readonly windowSec: number
  /** その窓で起きたこと。 */
  readonly window: TallySnapshot
  /** 表に出ない数え上げ（送信元の枠・生データの保存など）。 */
  readonly counters: readonly WindowCounter[]
  /** 直前の窓について「届いていない」と既に伝えたか。 */
  readonly quietReported: boolean
}

export interface WindowSummary {
  readonly lines: readonly string[]
  /** 次の窓へ持ち越す印。 */
  readonly quietReported: boolean
}

/** 1 行ぶんの警告。**間引きを通す前**の形。 */
export interface RawWarning {
  readonly level: 'warn'
  /** 間引きの区分。 */
  readonly kind: string
  /**
   * 間引きの鍵の後半。
   *
   * **値が変わったら出し直してほしいものは、ここへその値を入れる。** 定数にすると、
   * 状況が悪化しても最初の 1 行しか出ない（間引きは鍵ごとに間隔を持つ）。
   */
  readonly detail: string
  readonly line: string
}

export interface RawWarningInput {
  /** この窓で書き損ねた件数。 */
  readonly lost: number
  /** この窓で流し口が壊れた回数。 */
  readonly sinkBroken: number
  /** この窓で圧縮できなかった本の数。 */
  readonly compressFailed: number
  /** この窓で元を消せなかった本の数。 */
  readonly leftover: number
  readonly lastWriteError: string | null
  readonly lastSweepError: string | null
  /** 開いたまま閉じていない本の数。**正常は 1 本。** */
  readonly openFiles: number
  /**
   * 締めくくりに入ってから長く閉じ終わらない本の数。
   *
   * **これが閉じ忘れの印で、開いたままの本の数ではない。** 日が変わる瞬間は新旧 2 冊が
   * 数秒だけ共存するのが正常なので、冊数で鳴らすと毎日その瞬間に誤報が出る。
   */
  readonly stuckBooks: number
  /** 置き場所そのものを読めなかった回数（この窓ぶん）。 */
  readonly listFailures: number
  /** 同じ日の `.gz` と中身が食い違い、別名へ逃がした本の数（この窓ぶん）。 */
  readonly escaped: number
}

/**
 * 生データの保存について、1 分ごとの要約のあとに出す警告を組み立てる。
 *
 * **1 件ずつ出る経路が無いものをここで拾う。** 件数は要約の行が持つので、ここで出すのは
 * 理由と、件数では表せない状態（開いたままの本）だけ。掃き取りは日に 1 度の裏の仕事、
 * 書き損ねはコールバックで後から判るので、どちらも受信の経路では 1 行も出ない。
 */
export function buildRawWarnings(input: RawWarningInput): readonly RawWarning[] {
  const out: RawWarning[] = []
  // **理由そのものは鍵へ入れない。** 開いたままの本の数（下を見よ）と違って、文面は
  // 無限に変わりうる —— 入れると間引きの枠（種類ごとに 64）を使い切り、そのぶん
  // 別の種類の記録を押し出す。間隔が明ければ新しい理由は出るので、失うのは速さだけ。
  if ((input.lost > 0 || input.sinkBroken > 0) && input.lastWriteError !== null) {
    out.push({
      level: 'warn',
      kind: 'raw-write',
      detail: 'sink',
      line: `[raw] 書き出せなかった理由: ${shorten(input.lastWriteError)}`,
    })
  }
  if (input.listFailures > 0) {
    out.push({
      level: 'warn',
      kind: 'raw-list',
      detail: 'dir',
      line: '[raw] 生データの置き場所を読めず、古い記録を掃き取れていない（何本残っているかも判らない）',
    })
  }
  if (input.escaped > 0) {
    out.push({
      level: 'warn',
      kind: 'raw-escaped',
      // 開いたままの本と同じ理由で件数を鍵へ入れる —— 増えていることが間引かれない。
      detail: `clock:${input.escaped}`,
      line: `[raw] 同じ日の記録が別の中身で ${input.escaped} 本できた（時計が戻った疑い。別名へ逃がしてある）`,
    })
  }
  if ((input.compressFailed > 0 || input.leftover > 0 || input.listFailures > 0) && input.lastSweepError !== null) {
    out.push({
      level: 'warn',
      kind: 'raw-sweep',
      detail: 'sweep',
      line: `[raw] 掃き取れなかった理由: ${shorten(input.lastSweepError)}`,
    })
  }
  // **閉じ終わらない本があれば報せる。** 閉じ忘れは中身の欠けとしては現れず、
  // 1 年動かしてファイルの上限に触れて初めて表に出る（そのときには原因を辿れない）。
  //
  // **鍵へ件数を入れる。** 定数にすると 1 本 → 3 本 → 10 本と悪化しても最初の 1 行しか
  // 出ない —— いちばん知りたい「増えていること」が間引かれる側へ入る。
  if (input.stuckBooks > 0) {
    out.push({
      level: 'warn',
      kind: 'raw-open',
      detail: `stuck:${input.stuckBooks}`,
      line:
        `[raw] 生データの本が ${input.stuckBooks} 本、締めくくりから戻ってこない` +
        `（開いたままは全部で ${input.openFiles} 本）`,
    })
  }
  return out
}

/** 締めくくりで出す 1 行。 */
export interface ClosingLine {
  readonly level: 'log' | 'error'
  readonly line: string
}

export interface ClosingLinesInput {
  /** 送信元の枠を捨てた回数。 */
  readonly evictions: number
  readonly writeErrors: number
  readonly lostRecords: number
  readonly slowCloses: number
  readonly compressed: number
  readonly compressFailures: number
  readonly leftovers: number
  /** 締め終えたあとも開いたままの本の数。**上限で切り上げれば 0 とは限らない。** */
  readonly openFiles: number
  /** 締めくくりを待ち時間の上限で切り上げたか。 */
  readonly cutShort: boolean
  /**
   * 締めくくりから戻ってこない本の数。
   *
   * **開いたままの本の数とは別に出す。** 終了の合図と日の境目が重なれば、正常な
   * 2 冊の共存がそのまま最後の記録に残る —— それと「ずっと居座っていた本」を
   * 数字だけで見分けられない。
   */
  readonly stuckBooks: number
  /**
   * 締めくくりの最中の本が抱えたままの件数。
   *
   * **打ち切ったときの被害の大きさ。** 失った件数（`lostRecords`）は締め終わって初めて
   * 確定するので、上限で切り上げるとその加算が間に合わない —— この値だけが、
   * 何件を書き切れなかったかを示す。
   */
  readonly recordsAtRisk: number
  readonly listFailures: number
  readonly escaped: number
  readonly lastWriteError: string | null
  readonly lastSweepError: string | null
}

/**
 * 起動してからの累計のうち、表（`formatTally`）に載らない分の行を組み立てる。
 *
 * **この環境では実機で確かめられない。** 締めくくりは終了の合図でしか走らず、Windows の
 * `process.kill` は SIGINT でもハンドラを呼ばずにプロセスを落とす —— だから中身は
 * ここへ出してテストで固定する。呼び出し側は出すだけ。
 */
export function buildClosingLines(input: ClosingLinesInput): readonly ClosingLine[] {
  const out: ClosingLine[] = []
  for (const c of [
    { label: '送信元の枠を捨てた', value: input.evictions },
    { label: '生データを残せず流し口が壊れた', value: input.writeErrors },
    { label: '生データを書き損ねた', value: input.lostRecords },
    { label: '生データの締めくくりが遅い', value: input.slowCloses },
    { label: '古い記録を圧縮した', value: input.compressed },
    { label: '古い記録を圧縮できず', value: input.compressFailures },
    { label: '置き場所を読めず掃き取れず', value: input.listFailures },
    { label: '同じ日の記録が別の中身で残った', value: input.escaped },
    { label: '圧縮したが元を消せず', value: input.leftovers },
    // **閉じ切れなかった本も出す。** `close()` には待ち時間の上限があるので、ここへ来ても
    // 0 とは限らない。0 なら行ごと出ないので、平時の締めくくりは何も変わらない。
    { label: '閉じ切れなかった生データの本', value: input.openFiles },
    { label: 'うち締めくくりから戻ってこない本', value: input.stuckBooks },
  ]) {
    // **0 は出さない。** 起きなかったことを毎回並べると、起きたことが埋もれる。
    if (c.value > 0) out.push({ level: 'log', line: `  ${c.label}=${c.value}` })
  }

  // **打ち切ったなら言う。** 黙って打ち切ると「全部片付けて終わった」のと見分けが付かない。
  // 上の行は開いたままの本の数を出すが、打ち切った直後に閉じ終われば 0 に戻るので、
  // **打ち切った事実はそれとは別に残す**。
  if (input.cutShort) {
    out.push({
      level: 'error',
      line:
        '  生データの締めくくりを待ち時間の上限で打ち切りました' +
        `（書き切れていない ${input.recordsAtRisk} 件）`,
    })
  }

  // **理由も出す。** 締めくくりでは毎分の要約が止まっているので、最後の窓で起きた失敗は
  // **件数だけが累計に載り、理由はどこにも出ないまま失われる**。運用者が最後に読むのは
  // ここで、しかも原因がいちばん要るのは障害の直後。
  if (input.lastWriteError !== null) {
    out.push({ level: 'error', line: `  生データを書き出せなかった理由: ${shorten(input.lastWriteError)}` })
  }
  if (input.lastSweepError !== null) {
    out.push({ level: 'error', line: `  古い記録を掃き取れなかった理由: ${shorten(input.lastSweepError)}` })
  }
  return out
}

/**
 * 窓の長さ（秒）。
 *
 * **`setInterval` の間隔は約束であって実績ではない。** 詰まれば伸びるので、名目の 60 秒を
 * 書き続けると実際には 90 秒ぶんの件数を「直近 60 秒」と名乗ることになる。数える側は
 * 正しいので、嘘をつくのは文面だけ —— だから文面のほうを実測へ合わせる。
 *
 * 測れなかったとき（時計が戻った・非有限）は名目へ倒す。**「直近 0 秒」「直近 NaN 秒」と
 * 書くよりは名目のほうがまし**で、どちらにせよ件数は正しい。
 */
export function windowSeconds(elapsedMs: number, nominalSec: number): number {
  if (!Number.isFinite(elapsedMs)) return nominalSec
  return Math.max(1, Math.round(elapsedMs / 1000))
}

/**
 * 窓ぶんの要約を組む。
 *
 * **何も届かなかった窓は、続く間 1 度だけ伝える。** 毎分同じ空の表を出すと記録が埋まるし、
 * かといって黙ると**基板が全部黙ったことに気づけない**（画面を持たない常駐プロセスで、
 * 「何も起きていない」と「受信口が死んでいる」は外から見分けが付かない）。
 */
export function buildWindowSummary(input: WindowSummaryInput): WindowSummary {
  const rows = formatTally(input.window)
  // **表に出ない数え上げは、行が空でも落とさない。** いまの呼び出し順では届いた件数が 0 なら
  // 枠も捨てようが無いが、その前提を要約の側が握っていると、順序を変えたときに黙って消える。
  const extra = input.counters
    .filter((c) => c.value > 0)
    .map((c) => `  ${c.label}=${c.value}`)

  if (rows.length === 0 && extra.length === 0) {
    if (input.quietReported) return { lines: [], quietReported: true }
    return {
      lines: [`[集計] 直近 ${input.windowSec} 秒は 1 件も届いていない`],
      quietReported: true,
    }
  }
  return {
    lines: [`[集計] 直近 ${input.windowSec} 秒`, ...rows.map((r) => `  ${r}`), ...extra],
    quietReported: false,
  }
}

async function main(): Promise<void> {
  const port = readPort(process.env.SEISMO_UDP_PORT)
  const address = process.env.SEISMO_UDP_ADDRESS
  const pipeline = new IntensityPipeline()
  const tally = new PacketTally()
  const rateLimit = new SourceRateLimit()
  const throttle = new LogThrottle()
  // **作れなければここで落ちる。** 黙って保存せずに走るのがいちばん悪い ——
  // 基板は送っていて震度も出ていて、生だけが残っていない状態に外から気づけない。
  const rawStore = new RawStore({ dir: process.env.SEISMO_RAW_DIR ?? defaultRawDir() })

  /**
   * 間引きを通して 1 行出す。
   *
   * **黙らせはしない** —— 初回は必ず出て、以後も間隔ごとに出る。抑えた件数は行へ添わるので、
   * 読んだ人が件数を取り違えない。**正確な数は表（`tally`）のほう。**
   */
  const emit = (
    level: 'log' | 'warn' | 'error',
    kind: string,
    detail: string,
    line: string,
  ): void => {
    const decision = throttle.shouldLog(kind, detail)
    if (decision === null) return
    const text = `${line}${suppressedSuffix(decision)}`
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  }

  const reportCloseFailures = (failures: readonly CloseFailure[]): void => {
    for (const f of failures) {
      // 締めくくりを出せなかった＝その区間の最後の窓ぶんが失われている。
      tally.record({ kind: 'close-failed', board: f.boardKey })
      emit(
        'error',
        'close',
        f.boardKey,
        `[close] ${f.boardKey} ${f.sensorId} seg=${f.segmentId} の締めくくりに失敗: ${shorten(f.detail)}`,
      )
    }
  }

  const receiver = await startUdpReceiver({
    port,
    address,
    // **ここも間引きを通す。** データグラムの受け手が投げた例外はこの口へ流れてくるので、
    // 壊れた送り手が撃ち続けているあいだ、速度の上限に掛かる手前の 1 件ごとに 1 行出る。
    // 間引きを入れた意味がそこで消えるうえ、他の警告が埋もれる。
    //
    // **囲いはしない**（この口自身が投げたら落ちる側に倒す。段 4-1 で決めたとおり）。
    // 間引きは黙らせる仕組みではないので、その判断とは両立する。
    // 細目に例外の種類を使うのは、種類ごとに初回を必ず出すため —— 文面を鍵にすると
    // 中身（アドレス等）が混ざって枠が際限なく増える。
    onError: (error) => emit('error', 'udp', error.name, `[udp] ${error.message}`),
    onDatagram: (payload, from) => {
      // **届いた件数は上限を掛ける前に数える。** あとだと分母が上限そのものになり、
      // 「どれだけ撃たれているか」が表から読めなくなる。
      tally.record({ kind: 'received', source: from.address })

      // **上限は読み取りより前。** あとに置くと、落とすと決めたパケットの JSON を
      // 先に読むことになり、いちばん抑えたい場面で仕事が減らない。
      if (!rateLimit.allow(from.address)) {
        tally.record({ kind: 'rate-limited', source: from.address })
        emit('warn', 'limit', from.address, `[limit] ${formatSource(from)} 速度の上限で落とした`)
        return
      }

      // **保存は上限の後・読み取りの前。** 前に置くと壊れた送り手 1 台にディスクを
      // 埋められる（削除しない約束なので、埋まったら人が来るまで戻らない）。
      // 後ろに置くと**いちばん残したい読めなかったパケット**が消える。
      const stored = rawStore.write(formatSource(from), payload)
      if (!stored.saved) {
        tally.record({ kind: 'raw-unsaved', source: from.address, reason: stored.reason })
        // **理由の文面は、その理由が書き込み系のときだけ添える。** 抱えきれずに捨てた
        // （`backpressure`）のはディスクと無関係なので、直前の書き込み障害の文面を
        // 付けると原因を取り違えさせる。
        const why =
          (stored.reason === 'no-stream' || stored.reason === 'write-failed') &&
          rawStore.lastWriteError !== null
            ? `: ${shorten(rawStore.lastWriteError)}`
            : ''
        emit(
          'warn',
          'raw',
          `${from.address}|${stored.reason}`,
          `[raw] ${formatSource(from)} 生データを残せず（${stored.reason}）${why}`,
        )
      }

      const read = parseSensorPacket(payload)
      if (!read.ok) {
        // **ここは基板で数えられない。** ヘッダが読めていないので誰が送ったか判らず、
        // 判るのは送信元アドレスだけ（`packetTally.ts` が表を 2 つに分けている理由）。
        tally.record({ kind: 'parse-failed', source: from.address, reason: read.reason })
        emit(
          'warn',
          'read',
          `${from.address}|${read.reason}`,
          `[read] ${formatSource(from)} ${read.reason}: ${shorten(read.detail)}`,
        )
        return
      }

      const board = read.packet.boardKey
      tally.record({ kind: 'accepted', board })
      const outcome = pipeline.handlePacket(read.packet)

      if (outcome.dropped !== null) {
        tally.record({ kind: 'dropped', board, reason: outcome.dropped })
        const detail = outcome.detail === null ? '' : `: ${shorten(outcome.detail)}`
        emit(
          'warn',
          'drop',
          `${board}|${outcome.dropped}`,
          `[drop] ${formatSource(from)} ${outcome.dropped}${detail}`,
        )
      }
      if (outcome.startedBecause !== null) {
        tally.record({ kind: 'segment-started', board, reason: outcome.startedBecause })
        if (outcome.intensitySkipped !== null) {
          tally.record({ kind: 'intensity-skipped', board, reason: outcome.intensitySkipped })
        }
        const skip =
          outcome.intensitySkipped === null
            ? ''
            : `（震度なし: ${outcome.intensitySkipped}${
              outcome.detail === null ? '' : ` — ${shorten(outcome.detail)}`
            }）`
        emit(
          'log',
          'segment',
          `${board}|${outcome.startedBecause}`,
          `[segment] ${board} ${outcome.startedBecause}${skip}`,
        )
      }

      // **このパケットと無関係な流れが閉じられたら報せる。** 覚えていられる流れの数には
      // 上限があり、達すると**いちばん長く音沙汰の無い流れ**が閉じられる。版 2 のファームは
      // 再起動のたびに別の流れとして現れるので、枠は黙って埋まっていく。報せないと
      // 「あの基板の震度が急に出なくなった」理由がどこにも残らない。
      const current = streamKeyOf(read.packet)
      for (const c of outcome.closed) {
        if (c.meta.streamKey === current) continue
        tally.record({ kind: 'evicted', board: c.meta.boardKey })
        emit(
          'warn',
          'evict',
          c.meta.boardKey,
          `[evict] ${c.meta.boardKey} ${c.meta.sensorId} を枠の上限で閉じた`,
        )
      }
      reportCloseFailures(outcome.closeFailures)
      for (const r of outcome.readings) {
        tally.record({ kind: 'reading', board: r.boardKey })
        printReading(r)
      }
    },
  })

  console.log(`[udp] ${address ?? '0.0.0.0'}:${receiver.port} で待ち受け中`)

  // **起動時にも掃き取る。** 回転は日が変わったときにしか走らないので、
  // これが無いと止まっていた間に古くなった分が素のまま残り続ける。
  // 待たない —— 圧縮に数十秒かかることがあり、その間パケットを取りこぼす。
  void rawStore.sweep()

  let quietReported = false
  let lastSummaryMs = Date.now()
  /**
   * 累計しか持たない数え上げから、この窓ぶんの増分を取る。
   *
   * **前回値を数え上げごとに手で持たない** —— 1 つ足すたびに変数が増え、
   * 引き算と代入のどちらかを書き忘れると、その数だけが静かにずれる。
   */
  const reported = new Map<string, number>()
  /**
   * **鍵と見せる文言を分ける。** 表示文言を集計の鍵に兼ねると、文言を揃えるつもりで
   * 同じ文字列を 2 つの数え上げへ書いたとき、片方の累計がもう片方を上書きして
   * 増分が静かにずれる（型検査もテストも通る）。
   */
  const delta = (key: string, label: string, total: number): WindowCounter => {
    const before = reported.get(key) ?? 0
    reported.set(key, total)
    return { label, value: total - before }
  }
  const summarize = (): void => {
    // **名前ではなく鍵で引く。** 文面と照合していると、表記を片方だけ直したとき
    // 理由の行が静かに出なくなる（型検査もテストも通ったまま）。
    const counters = {
      evicted: delta('evicted', '送信元の枠を捨てた', rateLimit.evictions),
      sinkBroken: delta('sinkBroken', '生データを残せず流し口が壊れた', rawStore.writeErrors),
      lost: delta('lost', '生データを書き損ねた', rawStore.lostRecords),
      slowClose: delta('slowClose', '生データの締めくくりが遅い', rawStore.slowCloses),
      compressed: delta('compressed', '古い記録を圧縮した', rawStore.compressed),
      compressFailed: delta('compressFailed', '古い記録を圧縮できず', rawStore.compressFailures),
      leftover: delta('leftover', '圧縮したが元を消せず', rawStore.leftovers),
      listFailed: delta('listFailed', '置き場所を読めず掃き取れず', rawStore.listFailures),
      escaped: delta('escaped', '同じ日の記録が別の中身で残った', rawStore.escaped),
    }
    const now = Date.now()
    const elapsedSec = windowSeconds(now - lastSummaryMs, SUMMARY_INTERVAL_MS / 1000)
    lastSummaryMs = now
    const summary = buildWindowSummary({
      windowSec: elapsedSec,
      window: tally.takeWindow(),
      counters: Object.values(counters),
      quietReported,
    })
    quietReported = summary.quietReported
    for (const line of summary.lines) console.log(line)
    // **組み立ては純関数へ置く。** ここは `main()` の中にあって、エントリポイントの門の
    // 内側なのでテストが届かない —— 出す条件と間引きの鍵を直に書くと、誰も見ていない
    // ことになる。
    const warnings = buildRawWarnings({
      lost: counters.lost.value,
      sinkBroken: counters.sinkBroken.value,
      compressFailed: counters.compressFailed.value,
      leftover: counters.leftover.value,
      listFailures: counters.listFailed.value,
      escaped: counters.escaped.value,
      lastWriteError: rawStore.lastWriteError,
      lastSweepError: rawStore.lastSweepError,
      openFiles: rawStore.openFiles,
      stuckBooks: rawStore.stuckBooks,
    })
    for (const w of warnings) emit(w.level, w.kind, w.detail, w.line)
  }
  const timer = setInterval(summarize, SUMMARY_INTERVAL_MS)

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    // **合図は繰り返し来る。** 2 度目で締めくくりをもう 1 度走らせない。
    if (closing) return
    closing = true
    clearInterval(timer)
    console.log(`[udp] ${signal} を受けたので締めます`)

    // **受信口を先に閉じる。** 締めくくりを先にすると、空にしたそばから届いた分が
    // 新しい区間を開き、二度と締められないまま終わる（その基板の最後の窓ぶんが、
    // 警告も記録も無いまま消える）。
    await receiver.close()

    // **受信口を閉じたらすぐ流し切る。** 圧縮の途中で抜けると `.gz.tmp` が残り、
    // 次の起動が書きかけのファイルを見る。**ここで投げさせない** —— 震度の
    // 締めくくりへ進めなくなる。
    try {
      await rawStore.close()
    } catch (error) {
      console.error(`[raw] 生データの締めに失敗: ${messageOf(error)}`)
    }

    // **締めくくりを出してから終える。** 出さずに終えると、最後の窓ぶんの答えが消える。
    // **ここで投げさせない** —— 終了に到達しなくなる。
    try {
      const rest = pipeline.closeAll()
      reportCloseFailures(rest.failures)
      for (const r of rest.readings) {
        tally.record({ kind: 'reading', board: r.boardKey })
        printReading(r)
      }
    } catch (error) {
      console.error(`[close] 締めくくりに失敗: ${messageOf(error)}`)
    }

    // **累計は最後に必ず出す。** ここを囲いの中へ入れると、締めくくりが投げたときに
    // 起動してからの数え上げが丸ごと消える。
    console.log('[集計] 起動してからの累計')
    for (const line of formatTally(tally.snapshotTotal())) console.log(`  ${line}`)
    // **中身は純関数が持つ。** ここは終了の合図でしか走らないので、条件を直に書くと
    // 誰も見ていないことになる（この環境では実機でも確かめられない）。
    for (const c of buildClosingLines({
      evictions: rateLimit.evictions,
      writeErrors: rawStore.writeErrors,
      lostRecords: rawStore.lostRecords,
      slowCloses: rawStore.slowCloses,
      compressed: rawStore.compressed,
      compressFailures: rawStore.compressFailures,
      leftovers: rawStore.leftovers,
      listFailures: rawStore.listFailures,
      escaped: rawStore.escaped,
      openFiles: rawStore.openFiles,
      cutShort: rawStore.cutShort,
      stuckBooks: rawStore.stuckBooks,
      recordsAtRisk: rawStore.recordsAtRisk,
      lastWriteError: rawStore.lastWriteError,
      lastSweepError: rawStore.lastSweepError,
    })) {
      if (c.level === 'error') console.error(c.line)
      else console.log(c.line)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// **直接実行のときだけ走らせる。** 門が無いと、この先 `readPort` のような部品を
// 取り出してテストしようと読み込んだだけで、UDP の待ち受けが副作用として開く
// （同じ穴が `scripts/` 配下で起きたので、`scriptEntrypoints.test.ts` が検査している）。
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    // **起動に失敗したら落とす。** 待ち受けを開けなかったプロセスが走り続けると、
    // 基板は送っているのにどこにも届かない状態が黙って続く。
    console.error(messageOf(error))
    process.exit(1)
  })
}
