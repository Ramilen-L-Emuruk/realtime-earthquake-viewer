// 自作センサーの受け手。UDP で待ち受け、届いたパケットを段 1〜3 へ通して
// 計測震度相当を出す常駐プロセス。
//
// **出口は 4 つ。** 標準出力・生データのファイル・状態の口（`GET /status`）・
// 押し出しの口（`GET /stream`）。後ろ 2 つは HTTP で、宛先が違う ——
// 状態は**運用者**、押し出しは **PWA**（観測結果はビューアー、機材の管理はビューアーの外）。
//
// **状態の口へ配る中身は 5 系統ある** —— 数え上げ（`src/receiver/packetTally.ts`）・
// **保存の健全性**（`RawStore` の読み取り専用の値）・**センサーごとの生存**
// （`src/receiver/sensorHealth.ts`）・**換算の自己診断**（`src/receiver/gravityCheck.ts`）・
// **観測点ぶんの合成の生存**（`src/receiver/stationHealth.ts`。複数センサーの波形合成
// ・REQUIREMENTS.md §7）。数え上げだけを配ると「生データが残っていない」ことも
// 「9 個のうち 1 個が黙った」ことも「届いている値の桁が狂っている」ことも、
// この口から丸ごと落ちる。
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

import { GAL_PER_G } from './src/intensity/units'
import { MAX_TIME_MS, parseSensorPacket } from './src/protocol/parsePacket'
import { GravityCheckBook } from './src/receiver/gravityCheck'
import type { GravityCount, GravityCounts, GravityVerdict } from './src/receiver/gravityCheck'
import { IntensityPipeline } from './src/receiver/intensityPipeline'
import type { CloseFailure, IntensityReading } from './src/receiver/intensityPipeline'
import { LogThrottle, suppressedSuffix } from './src/receiver/logThrottle'
import { PacketTally, formatTally } from './src/receiver/packetTally'
import type { TallySnapshot } from './src/receiver/packetTally'
import { RawStore } from './src/receiver/rawStore'
import { ReadingHub } from './src/receiver/readingHub'
import { SensorFusion } from './src/receiver/sensorFusion'
import type { FusionOutcome, StationCloseFailure, StationIntensityReading } from './src/receiver/sensorFusion'
import { SensorHealthBook } from './src/receiver/sensorHealth'
import {
  StationDirectory,
  loadStationConfig,
  saveStationConfig,
  stationsWithMultipleBoards,
} from './src/receiver/stationConfig'
import type { StationConfig } from './src/receiver/stationConfig'
import { StationHealthBook } from './src/receiver/stationHealth'
import { buildStatusReport } from './src/receiver/statusReport'
import { startStatusServer } from './src/receiver/statusServer'
import { SourceRateLimit } from './src/receiver/sourceRateLimit'
import { startUdpReceiver } from './src/receiver/udpReceiver'
import type { DatagramSource } from './src/receiver/udpReceiver'
import { streamKeyOf } from './src/timebase/segmenter'

/** 記録係の原型（`capture.mjs`）と同じ口。基板の送り先もこの値。 */
const DEFAULT_PORT = 50505

/** 状態と押し出しの口。**受信口の隣。** */
const DEFAULT_HTTP_PORT = 50506

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
 * 観測点の設定ファイルの既定の置き場所。
 *
 * **このファイルからの相対で解決する**（`defaultRawDir` と同じ理由）。`.gitignore` 済み
 * —— 設置場所（＝自宅の間取り）を書くので、生データと同じく公開リポジトリへは入れない。
 */
function defaultStationConfigPath(): string {
  return fileURLToPath(new URL('./config/stations.json', import.meta.url))
}

/**
 * 10 進の整数だけを通す。**`Number()` に任せない** —— あれは `0x1F91` を 8081 として受け、
 * 打ち間違えたつもりの無い値が「読めた」ことになる（読み取り側の `DECIMAL_INTEGER_RE` と同じ判断）。
 */
const DECIMAL_PORT_RE = /^\d{1,5}$/

export function readPort(
  raw: string | undefined,
  fallback: number = DEFAULT_PORT,
  name = 'SEISMO_UDP_PORT',
): number {
  if (raw === undefined || raw === '') return fallback
  // **黙って既定へ倒さない。** 打ち間違えたまま「別のポートで動いている」状態は、
  // 基板からの送信が届かない理由として画面にも記録にも現れない。
  if (!DECIMAL_PORT_RE.test(raw)) {
    throw new Error(`${name} が port 番号として読めない: ${raw}`)
  }
  const port = Number(raw)
  if (port > 65535) throw new Error(`${name} が port 番号の範囲を超えている: ${raw}`)
  return port
}

/**
 * `/api/*` の共有トークン。**空文字列は「無い」と同じに扱う**——`SEISMO_ADMIN_TOKEN=`
 * のように値を書き忘れた環境変数を、そのまま比較対象のトークンとして使ってしまうと、
 * 空文字列どうしの一致で誰でも通ってしまいうる（実際には `Bearer ` の後ろが空なら
 * `adminAuth.ts` の `missing-authorization` で弾かれるが、意図を明確にするため
 * ここでも弾く）。
 */
export function readAdminToken(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** カンマ区切りの一覧を読む。空要素は無視する。 */
export function readAllowList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * `SEISMO_ADMIN_ALLOWED_HOSTS` の既定値。**Tailscale Serve がバックエンドへ
 * プロキシする際の `Host` ヘッダを想定した推測**（REQUIREMENTS.md §13 の decision の
 * 実測はまだ無い）。環境変数で上書きできるのはこのため。
 */
function defaultAdminAllowedHosts(httpPort: number): readonly string[] {
  return [`127.0.0.1:${httpPort}`, `localhost:${httpPort}`]
}

/**
 * `raw` が空文字列・空白だけの場合も既定値へ倒す。**`readAllowList` をそのまま使うと
 * 空文字列が「明示的な空配列」（＝誰も通さない）になり、`readAdminToken` の「空文字列は
 * 未設定と同じ」という判断と食い違う**——`.env` の空値コピペのような打ち間違いで
 * `/api/*` が理由の分からないまま `host-not-allowed` に固定される事故につながる
 * （敵対的レビューで指摘された）。
 */
export function readAdminAllowedHosts(raw: string | undefined, httpPort: number): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) return defaultAdminAllowedHosts(httpPort)
  return readAllowList(raw)
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

/**
 * 観測点設定が読めなかった理由を、定期要約でも再掲する。
 *
 * **起動時の `console.warn`（`main()` 冒頭）は 1 回しか出ない。** ログだけをテールで
 * 監視している運用者には、起動直後を見逃すと二度と伝わらない —— `GET /status` の
 * `stationConfigWarning` には恒久的に載るが、能動的にポーリングしない限り気づけない。
 * `buildRawWarnings` と同じ「間引きつつ再掲する」扱いに寄せる。
 */
export function buildStationConfigWarning(warning: string | null): readonly RawWarning[] {
  if (warning === null) return []
  return [
    {
      level: 'warn',
      kind: 'station-config',
      detail: warning,
      line: `[station] 観測点の設定を読めなかった: ${warning}`,
    },
  ]
}

/**
 * 判定基準の食い違いを突き合わせる。
 *
 * **`stationsWithMultipleBoards` は基板の割り当てだけを見るが、`groupedStationIds` は
 * 各基板の `sensors[]` に `sensorId` が明示列挙されている観測点しか含まない**——
 * `sensors[]` を空のまま基板だけ割り当てると、単一センサー側の震度算出は既定値で
 * 動き続ける一方、合成だけが沈黙して起動しない。
 */
export function findUngroupedMultiBoardStations(
  config: StationConfig,
  groupedStationIds: readonly string[],
): readonly string[] {
  return stationsWithMultipleBoards(config).filter((id) => !groupedStationIds.includes(id))
}

/**
 * 「複数の基板を割り当てたのに合成グループが組めていない」観測点を、定期要約でも再掲する。
 *
 * **`sensors[]` を空のまま基板だけ割り当てると、単一センサー側の震度算出は既定値で
 * 動き続けるが、複数センサー合成（§7）だけが沈黙して起動しない**（README.md「複数
 * センサーの波形合成（§7）」参照）——校正値の各項目は省略できても、`sensors[]` への
 * `sensorId` の列挙自体は省略できない。運用者が校正未実測を理由に `sensors[]` を
 * 書かなかった場合に典型的に踏む。
 */
export function buildStationGroupingWarning(ungroupedStationIds: readonly string[]): readonly RawWarning[] {
  if (ungroupedStationIds.length === 0) return []
  return [
    {
      level: 'warn',
      kind: 'station-grouping',
      // 観測点の集合が変わったら出し直す —— 定数だと最初の 1 回で以後は間引かれる。
      // **`JSON.stringify` を使う。** カンマ区切りだと `["a,b"]`（1 件）と `["a","b"]`
      // （2 件）が同じ鍵へ潰れ、集合が変わっても出し直されない窓ができる
      // （`stationId` は非空以外の文字種制限が無い）。
      detail: JSON.stringify([...ungroupedStationIds].sort()),
      line:
        `[station] 観測点 ${ungroupedStationIds.join('・')} は複数の基板を割り当てているが、` +
        '合成グループを組めていない（各基板の sensors[] に sensorId を最低 1 件書くこと）',
    },
  ]
}

/**
 * 観測点ぶんの合成の状態が変わったログのレベル。
 *
 * **震度が出せない間（`reason !== null`）は `'warn'`。** 正常な区間切り替え
 * （`reason === null`）と同じ `'log'` のままだと、`push()` 失敗後に自己回復しない
 * 恒久障害（`sensorFusion.ts` のコメント参照）が通常運用と見分けの付かない重要度で
 * 出続け、`journalctl -p warning` 等のレベルでフィルタする運用では拾えない。
 */
export function stationSegmentLogLevel(reason: string | null): 'log' | 'warn' {
  return reason === null ? 'log' : 'warn'
}

/**
 * gal を読みやすい桁へ。**有効数字をそろえる。**
 *
 * **小数点以下の桁数を固定しない。** この行がいちばん効くのは倍率が 1000 分の 1 に
 * 狂った場面で、そこでの値は 0.98 gal —— 小数第 1 位で丸めると `1.0` になり、
 * **桁を診るための行が桁を潰す**。
 */
function gal(v: number | null): string {
  if (v === null) return '?'
  const abs = Math.abs(v)
  if (abs >= 100) return v.toFixed(0)
  if (abs >= 10) return v.toFixed(1)
  if (abs >= 1) return v.toFixed(2)
  // 1 gal 未満。**`toPrecision` は指数が -7 に届くまで固定小数で返す**ので、
  // ここへ来る値（1000 分の 1 で 0.98、100 万分の 1 でも 0.00098）は指数表記にならない。
  return v.toPrecision(3)
}

/**
 * 換算の自己診断から出す行を組み立てる。**正常なら 1 行も出さない。**
 *
 * **判定できなかった窓（揺れていた・サンプルが足りない）では黙る。** 地震のたびに
 * 記録が流れることになるうえ、それ自体は異常ではない —— 件数は要約が持つ。
 *
 * **倍率と平均引きは別の行にする。** 同じ窓で両方立ちうるが、疑う先が違う
 * （前者はヘッダの名乗り、後者は震度を出す側の配線）ので、1 行へ混ぜると
 * どちらを見に行けばよいか読み取れない。
 *
 * **間引きの区分（`kind`）も 3 つに分ける。** 枠は区分ごとに 64 個で、ここは
 * **1 つのセンサーが最大 3 つの鍵を使う**（他の区分は基板 1 つにつき 1 つ）。
 * 1 つの区分を共有すると、センサーが 22 台を超えたあたりで枠を使い切り、
 * **そのあとに現れた別のセンサーの初回の異常が 1 行も出ないまま抑えられる**
 * （`src/receiver/logThrottle.ts` 自身がこの形を戒めている）。上の
 * `buildRawWarnings` も種類ごとに区分を分けている。
 */
export function buildGravityWarnings(v: GravityVerdict): readonly RawWarning[] {
  const out: RawWarning[] = []
  const who = `${v.boardKey} ${v.sensorId}`
  if (v.scale === 'too-small' || v.scale === 'too-large') {
    const direction = v.scale === 'too-small' ? '小さすぎる' : '大きすぎる'
    out.push({
      level: 'warn',
      kind: 'gravity-scale',
      // **判定を鍵へ入れる。** 小さすぎるが大きすぎるへ転じたら出し直してほしい。
      detail: `${who}|${v.scale}`,
      line:
        `[gravity] ${who} の換算が${direction}: 静止時の 3 軸合成が ${gal(v.meanGal)} gal`
        + `（1 g = ${gal(GAL_PER_G)} gal のはず）。`
        + `名乗る分解能${v.scale === 'too-large' ? 'とフルスケールの組' : ''}の桁を疑う`,
    })
  }
  if (v.scale === 'unreadable') {
    out.push({
      level: 'warn',
      kind: 'gravity-unreadable',
      detail: who,
      line: `[gravity] ${who} の波形に数値として読めない値が混ざっている（${v.sampleCount} 件の窓）`,
    })
  }
  if (v.restless) {
    out.push({
      level: 'warn',
      kind: 'gravity-restless',
      detail: who,
      line:
        `[gravity] ${who} は静止している（ばらつき ${gal(v.sdGal)} gal）のに`
        + ` 計測震度 ${v.maxIntensity ?? '?'} が出ている。窓ごとの平均引きを疑う`,
    })
  }
  return out
}

/**
 * 震度 1 つを配る先。**呼ぶ順番に意味があるので、束ねて 1 つの型にする。**
 *
 * `main()` の中に並べただけだと、**この順番を守るものが何も無い**（あそこは
 * 「直接実行のときだけ走らせる」門の内側でテストが届かない）。実際この並びは
 * レビューで 2 巡続けて指摘された論点そのもので、直しても**戻されたことに
 * 気づく手立てが無かった**。
 */
export interface ReadingSinks {
  /** 数える。 */
  readonly count: (r: IntensityReading) => void
  /** センサーの生存として覚える。 */
  readonly remember: (r: IntensityReading) => void
  /** 押し出しの口へ流す。 */
  readonly publish: (r: IntensityReading) => void
  /** 標準出力へ出す。 */
  readonly print: (r: IntensityReading) => void
  /** 換算の自己診断へ渡す。 */
  readonly diagnose: (r: IntensityReading) => void
}

/**
 * 震度を 1 つ配る。**数える・覚える・押し出す・出す・診る をこの順で。**
 *
 * **診断はいちばん最後。** あれは補助の仕組みで、本筋（押し出しと標準出力）より
 * 手前に置くと、そこで投げたときに**この読み自身が画面にも購読者にも出ない**。
 * 受け手（`udpReceiver.ts`）はデータグラムの処理を丸ごと囲うだけなので、途中で
 * 投げれば以降は実行されない。
 *
 * **同じ配列の後続の読みまでは守れていない** —— この関数を繰り返し呼ぶのは
 * 呼び出し側で、そこで投げれば残りは止まる。守れているのは「この読み自身は
 * 必ず出る」まで。
 *
 * **いまこの穴が開くことはない** —— `gravityCheck.ts` の `noteIntensity` は
 * `Map` の参照と数の比較だけで投げる経路を持たない。この並びは**あとから検証や
 * 読み取りを足したときに備えたもの**で、現に起きている不具合の手当てではない。
 */
export function deliverReading(to: ReadingSinks, r: IntensityReading): void {
  to.count(r)
  to.remember(r)
  to.publish(r)
  to.print(r)
  to.diagnose(r)
}

/**
 * 観測点ぶんの合成結果（`FusionOutcome`）の配り先。**順序はここが決める。**
 */
export interface StationFusionSinks {
  readonly noteReading: (r: StationIntensityReading) => void
  readonly publish: (r: StationIntensityReading) => void
  readonly reportCloseFailure: (f: StationCloseFailure) => void
  readonly noteSkip: (stationId: string, reason: string | null) => void
  /**
   * 合成の流し込みの状態が変わりうる処理が走った回にだけ呼ぶ。**1 件ずつの行**
   * （単一センサーの `[segment] ...` と対称）。数え上げ・状態の口は `noteSkip` が持つので、
   * ここは「画面を持たない常駐プロセスで黙って気づけない」ことへの手当て専用。
   */
  readonly logSegment: (stationId: string, reason: string | null) => void
}

/**
 * `SensorFusion.ingest()` が返す 1 回ぶんの結果を配る。
 *
 * **読みを先に配り、いまの合成状態（`noteSkip`）は最後に確定させる。**
 * `fusion.readings` には区間の作り直しで前区間の残り（`carried`。
 * `../src/receiver/sensorFusion.ts` の `ingest()` を見ること）が混ざりうる——
 * それは「たった今出た、新しい区間より古い震度」なので、`noteReading` が無条件に
 * クリアする `lastSkipReason` を、直前にセットしたばかりの「いまの異常」の上へ
 * 被せてしまう（`sensorHealth.ts` が同じ形の競合を `skipStreamKey`/`skipSegmentId`
 * で明示的にガードしているのと同じ症状——壊れた合成が一瞬だけ健全に見える）。
 * 順序を「過去の読み → いまの状態」にすれば、いまの状態が必ず最後に残る。
 *
 * **`closeFailure`・`intensitySkipReason` は駆動役の到着でだけ意味を持つ**
 * （`fusedWave` が非 null の回に限る。`sensorFusion.ts` の `FusionOutcome` を見ること）。
 */
export function deliverStationFusion(to: StationFusionSinks, fusion: FusionOutcome): void {
  if (fusion.fusedWave !== null && fusion.closeFailure !== null) {
    to.reportCloseFailure(fusion.closeFailure)
  }
  for (const r of fusion.readings) {
    to.noteReading(r)
    to.publish(r)
  }
  if (fusion.fusedWave !== null) {
    to.noteSkip(fusion.fusedWave.stationId, fusion.intensitySkipReason)
    // **異常が続いている間は毎回呼ぶ。正常なら状態が変わった回にだけ呼ぶ。**
    //
    // `intensitySkipReason` が非 null（＝合成の震度が出せない）の間は、`ingest()`
    // が `intensityStateChanged` を再び立てない場合がある——`push()` の失敗は
    // 区間の作り直しを伴わず、`SensorFusion` 側に自己回復の仕組みが無いため
    // （`sensorFusion.ts` の `ingest()` を見ること）、壊れた状態が同じ区間の間
    // ずっと続きうる。`intensityStateChanged` だけで絞ると、**最初の 1 回しか
    // ログが出ず、以後「合成が壊れたままだ」という事実そのものが沈黙する**。
    // 間引き（`logThrottle.shouldLog`）が「初回は必ず出し、以後も間隔ごとに
    // 出し直す」設計を持つので、毎回呼んでも実際の出力頻度はあちらに任せられる。
    //
    // 正常（`null`）に戻った回は、区間が変わった・push が成功した等の
    // `intensityStateChanged` が立つ回にだけ知らせれば十分——正常が続く間、
    // 毎パケット「合成の状態が変わった」と言い続ける理由は無い。
    if (fusion.intensitySkipReason !== null || fusion.intensityStateChanged) {
      to.logSegment(fusion.fusedWave.stationId, fusion.intensitySkipReason)
    }
  }
}

/**
 * `applyStationConfigCore` が触る先。**`main()` の中に並べただけだと、この順番を
 * 守るものが何も無い**（あそこは「直接実行のときだけ走らせる」門の内側でテストが
 * 届かない）——`deliverReading`/`deliverStationFusion` と同じ理由で抽出する。
 */
export interface ApplyStationConfigDeps {
  /** ディスクへ保存する。**投げうる**——投げたら以降は一切呼ばない。 */
  readonly save: (config: StationConfig) => void
  /** `/api/stations`・`/api/boards` の GET が返す値を差し替える。 */
  readonly setCurrentConfig: (config: StationConfig) => void
  /** `StationDirectory` を作り直し、`IntensityPipeline` へ差し替える。 */
  readonly rebuildStations: (config: StationConfig) => void
  /** 古い `SensorFusion` を締める。**投げうる**（呼び出し側が捕まえる）。 */
  readonly closeSensorFusion: () => { failures: readonly StationCloseFailure[]; readings: readonly StationIntensityReading[] }
  readonly reportCloseFailures: (failures: readonly StationCloseFailure[]) => void
  readonly emitReading: (r: StationIntensityReading) => void
  /** 古い `closeSensorFusion` が投げたときに呼ぶ。設定の差し替え自体は止めない。 */
  readonly onCloseFailure: (error: unknown) => void
  /** 新しい `SensorFusion` を作り、合成グループが組めた観測点の一覧を返す。 */
  readonly rebuildSensorFusion: (config: StationConfig) => readonly string[]
  readonly setUngroupedMultiBoardStations: (ids: readonly string[]) => void
  readonly setWarning: (warning: string | null) => void
}

/**
 * `/api/*` の書き込みが観測点設定を確定したときに呼ぶ（#313 段 B）。
 *
 * **保存を先に、反映は後で。** `save` が投げたら、以降のどの `deps` も呼ばない——
 * 保存に失敗したのに実行中の設定だけ変わる、という食い違いを避ける。
 *
 * 反映は 2 つ:
 * 1. `rebuildStations` は差し替えるだけ。進行中の区間組み立ては打ち切らない——
 *    校正値を都度引くだけで、区間の連続性には関わらない
 *    （`intensityPipeline.ts` の `updateStations` コメント参照）
 * 2. `sensorFusion` は作り直す。合成グループの組み方自体（基板→観測点の割当）が
 *    変わりうるので、差し替えでは済まない——`closeSensorFusion` で進行中の合成を
 *    締めてから `rebuildSensorFusion` で新しいインスタンスへ切り替える（進行中の
 *    合成区間はここで打ち切られる。設定変更自体が頻繁でないので許容する）
 *
 * **`setCurrentConfig`・`rebuildStations`・`rebuildSensorFusion` の間にロールバックは
 * 無い。** 現状は安全——`StationDirectory`・`SensorFusion` のコンストラクタは
 * 例外を投げない設計（壊れた入力は `console.warn` して無視する側に倒す）。もし将来
 * どちらかが検証強化等で投げるようになったら、`currentStationConfig`（GET が返す値）
 * だけが新設定に進み、実際にパケット処理へ使う校正値は古いままという食い違いが
 * 起きる——そのときは `setCurrentConfig` を最後（全て構築し終えてから）へ動かすこと。
 */
export function applyStationConfigCore(deps: ApplyStationConfigDeps, newConfig: StationConfig): void {
  deps.save(newConfig)

  deps.setCurrentConfig(newConfig)
  deps.rebuildStations(newConfig)

  // **締めの失敗で反映を止めない。** `shutdown` の同じ処理と同じ理由——
  // 締めくくりが投げても、設定の差し替え自体は進める。
  try {
    const stationRest = deps.closeSensorFusion()
    deps.reportCloseFailures(stationRest.failures)
    for (const r of stationRest.readings) deps.emitReading(r)
  } catch (error) {
    deps.onCloseFailure(error)
  }

  const groupedStationIds = deps.rebuildSensorFusion(newConfig)
  deps.setUngroupedMultiBoardStations(findUngroupedMultiBoardStations(newConfig, groupedStationIds))
  // **保存できた時点で `parseStationConfig` を通過済み。** 書き込みハンドラが渡す
  // `newConfig` は常にパース済みの正しい形なので、読み直して警告の有無を
  // 確かめ直す必要は無い。
  deps.setWarning(null)
}

/**
 * 自己診断の数え上げに付ける見出し。**毎分の要約も終了時の締めくくりもここから引く。**
 *
 * **`Record<GravityCount, string>` にしてあるので、数え上げを足して**
 * **ここへ書かなければ型検査が止める。** この機能は「数を足したのに出す先の 1 つへ
 * 書き忘れる」を 4 巡続けた —— 同じ名前を要約と締めくくりで別々に書き写していたのが根で、
 * 表を 1 つにすれば書き写す場所そのものが無くなる。
 *
 * **並び順もここが決める。** 異常（0 が正常なもの）を先に、平常でも増えるものを後ろへ。
 */
const GRAVITY_LABELS: Record<GravityCount, string> = {
  mismatches: '換算の倍率が合わない窓',
  restlessWindows: '静止しているのに震度が高い窓',
  unjudged: '静止しておらず倍率を診られなかった窓',
  restarts: '基板の起動が変わり、診断の窓を捨てた',
  evictions: '自己診断の枠を捨てた',
}

/** 自己診断の数え上げ 1 つぶん。 */
export interface GravityCountEntry {
  readonly key: GravityCount
  readonly label: string
  readonly value: number
}

/**
 * 自己診断の数え上げを、見出しを添えて並べる。
 *
 * **要約と締めくくりが同じものを通る。** 片方だけに欄を足す形をやめるための口で、
 * 並びも件数も `GRAVITY_LABELS` が決める。
 */
export function gravityCountEntries(counts: GravityCounts): readonly GravityCountEntry[] {
  return (Object.keys(GRAVITY_LABELS) as GravityCount[]).map((key) => ({
    key,
    label: GRAVITY_LABELS[key],
    value: counts[key],
  }))
}

/** 締めくくりで出す 1 行。 */
export interface ClosingLine {
  readonly level: 'log' | 'error'
  readonly line: string
}

export interface ClosingLinesInput {
  /** 送信元の枠を捨てた回数。 */
  readonly evictions: number
  /**
   * 数として出せず落とした計測震度の数。
   *
   * **0 のままなのが正常。** 上流が非有限を先に弾いているので、ここが増えるのは
   * その境界が緩んだ合図（`src/receiver/intensityPipeline.ts` の `normalizeIntensity`）。
   * **状態の口にも出るが、そちらは見に来た人にしか届かない** —— HTTP の口を開いて
   * いない運用では、締めくくりのこの 1 行だけが気づく機会になる。
   */
  readonly unusableIntensities: number
  /**
   * センサーの生存の記録を、枠の上限で押し出した数。
   *
   * **送信元の枠（`evictions`）とは別に出す。** あちらは「速すぎる送り手を捨てた」で、
   * こちらは「見ているセンサーが多すぎて古いものを忘れた」—— 忘れた先が
   * **黙ったセンサーを見つけるための仕組みそのもの**なので、混ぜると
   * 監視の劣化が監視対象の異常と同じ数に紛れる。
   */
  readonly sensorEvictions: number
  /** 観測点ぶんの合成の覚え（`StationHealthBook`）を上限で押し出した数。 */
  readonly stationEvictions: number
  /**
   * 換算の自己診断の数え上げ。**帳面が返すものをそのまま受け取る。**
   *
   * 欄を 1 つずつ並べる形にすると、あちらへ数を足したときにここで渡し忘れる
   * （`src/receiver/gravityCheck.ts` の `GravityCount`）。見出しと並びは
   * `GRAVITY_LABELS` が持つ。
   */
  readonly gravity: GravityCounts
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
    { label: '数として出せなかった計測震度', value: input.unusableIntensities },
    { label: 'センサーの生存の枠を捨てた', value: input.sensorEvictions },
    { label: '観測点ぶんの合成の生存の枠を捨てた', value: input.stationEvictions },
    ...gravityCountEntries(input.gravity),
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
  const startedAtMs = Date.now()
  const port = readPort(process.env.SEISMO_UDP_PORT)
  const address = process.env.SEISMO_UDP_ADDRESS
  const httpPort = readPort(process.env.SEISMO_HTTP_PORT, DEFAULT_HTTP_PORT, 'SEISMO_HTTP_PORT')
  const httpAddress = process.env.SEISMO_HTTP_ADDRESS

  // **`/api/*`（設定の読み書き・管理操作）の認証。** トークンが無ければその口自体を
  // 無効化する（`statusServer.ts` の `checkAdminAuth` が `not-configured` を返す）。
  // 未設定は運用者にまだ管理コンソールを使う気が無いだけかもしれないので、ここで
  // 起動を止めはしない——止めると、その口を使わない構成（現状の全端末がそう）まで
  // 起動できなくなる。
  const adminToken = readAdminToken(process.env.SEISMO_ADMIN_TOKEN)
  if (adminToken === null) {
    console.warn('[admin] SEISMO_ADMIN_TOKEN が未設定のため /api/* は無効です')
  }
  const adminAllowedOrigins = readAllowList(process.env.SEISMO_ADMIN_ALLOWED_ORIGINS)
  // **トークンは設定したのに Origin を 1 つも許可していない構成を、黙って見過ごさない。**
  // `allowedOrigins` の既定は意図的に空（README「運用者が明示するまで誰も通さない」）だが、
  // トークンまで設定した運用者がこれを見落とすと、「なぜ 403（origin-not-allowed）が
  // 続くのか」を突き止める手掛かりが起動時のログに無いまま管理コンソールを使い始める。
  if (adminToken !== null && adminAllowedOrigins.length === 0) {
    console.warn('[admin] SEISMO_ADMIN_ALLOWED_ORIGINS が未設定のため /api/* はどの Origin からも拒否されます')
  }
  const adminAuth = {
    token: adminToken,
    allowedHosts: readAdminAllowedHosts(process.env.SEISMO_ADMIN_ALLOWED_HOSTS, httpPort),
    allowedOrigins: adminAllowedOrigins,
  }

  // **割り当ては任意。** ファイルが無い・壊れているときも起動は止めない——
  // 観測点を知らないだけで、震度を出す仕事とは無関係（`stationConfig.ts` の設計原則）。
  // ただし黙って空にはしない。
  //
  // **`pipeline` より先に作る。** 校正（REQUIREMENTS.md §16）の適用にはセンサーの
  // 割り当てが要るので、`IntensityPipeline` のコンストラクタへ渡す。
  const stationConfigPath = process.env.SEISMO_STATION_CONFIG ?? defaultStationConfigPath()
  const stationConfigLoad = loadStationConfig(stationConfigPath)
  // **文面はここで直書きしない。** `buildStationConfigWarning`（定期要約でも使う）と
  // 別の文字列を持つと、起動直後のログと 60 秒後以降の再掲ログの表現がずれる。
  for (const w of buildStationConfigWarning(stationConfigLoad.warning)) console.warn(w.line)
  // **以下 5 つは `/api/*`（#313 段 B）が書き換える。** 設定を保存・反映するたびに
  // `applyStationConfig`（このスコープの下のほうで定義）がまとめて差し替える——
  // 個別に更新すると、一部だけ新しい設定を見て残りが古いままになる（例えば
  // `stations` だけ差し替えて `ungroupedMultiBoardStations` を更新し忘れると、
  // 解消したはずの警告が再掲され続ける）。
  let currentStationConfig = stationConfigLoad.config
  let stationConfigWarning = stationConfigLoad.warning
  let stations = new StationDirectory(stationConfigLoad.config)
  const pipeline = new IntensityPipeline({ stations })
  // **複数センサーの波形合成（REQUIREMENTS.md §7）。** 割り当てが 2 台に満たない
  // 観測点はグループを組まない（`sensorFusion.ts` の `buildGroups`）ので、単一センサーの
  // 構成では常に何もしない——観測点を割り当てていない構成と同じく安全に無視できる。
  let sensorFusion = new SensorFusion(stationConfigLoad.config)
  let ungroupedMultiBoardStations = findUngroupedMultiBoardStations(
    stationConfigLoad.config,
    sensorFusion.groupedStationIds,
  )
  // 文面はここでも直書きしない（理由は上のコメントと同じ）。
  for (const w of buildStationGroupingWarning(ungroupedMultiBoardStations)) console.warn(w.line)
  const tally = new PacketTally()
  const rateLimit = new SourceRateLimit()
  const throttle = new LogThrottle()
  const hub = new ReadingHub()
  const health = new SensorHealthBook()
  const stationHealth = new StationHealthBook()
  const gravity = new GravityCheckBook()
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

  /**
   * 震度 1 つの配り先。**ここは繋ぎ先を並べるだけで、順番は `deliverReading` が持つ。**
   *
   * 呼ぶのは 2 箇所（受信の最中と、終了の締めくくり）。**別々に書くと片方だけ抜ける** ——
   * 抜けたほうは「最後の窓ぶんが押し出されない」という、記録にも残らない形で出る。
   */
  const sinks: ReadingSinks = {
    count: (r) => tally.record({ kind: 'reading', board: r.boardKey }),
    remember: (r) =>
      health.noteReading({
        boardKey: r.boardKey,
        sensorId: r.sensorId,
        streamKey: r.streamKey,
        segmentId: r.segmentId,
        atMs: r.atMs,
        intensity: r.intensity,
        timebaseNominalReason: r.timebaseNominalReason,
      }),
    publish: (r) => hub.publish({ kind: 'reading', reading: r }),
    print: printReading,
    // 揺れていないのに高い震度が出続けるなら、疑うのは換算ではなく震度を出す側の
    // 配線（窓ごとの平均引き）。
    diagnose: (r) =>
      gravity.noteIntensity({
        boardKey: r.boardKey,
        sensorId: r.sensorId,
        streamKey: r.streamKey,
        intensity: r.intensity,
      }),
  }

  const emitReading = (r: IntensityReading): void => deliverReading(sinks, r)

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

  /**
   * 観測点ぶんの計測震度（複数センサーの合成）の配り先。**呼ぶのは 2 箇所**
   * （受信の最中と、終了の締めくくり）で、上の `emitReading` と同じ理由。
   *
   * **`packetTally.ts` の `boards` 表へは乗せない。** あちらの鍵は基板（`BoardKey`）を
   * 前提にしており、観測点の識別子（`stationId`）を混ぜると「基板」の意味が崩れる
   * （別の表を新設するかは #315 の範囲）。
   */
  const emitStationReading = (r: StationIntensityReading): void => {
    stationHealth.noteReading(r)
    hub.publish({ kind: 'station-reading', reading: r })
  }

  const reportStationCloseFailures = (failures: readonly StationCloseFailure[]): void => {
    for (const f of failures) {
      stationHealth.noteCloseFailure(f.stationId, f.detail)
      emit(
        'error',
        'station-close',
        f.stationId,
        `[station] ${f.stationId} の合成の締めくくりに失敗: ${shorten(f.detail)}`,
      )
    }
  }

  /** `deliverStationFusion` へ渡す配り先。順序はあちらが決める。 */
  const stationFusionSinks: StationFusionSinks = {
    noteReading: (r) => stationHealth.noteReading(r),
    publish: (r) => hub.publish({ kind: 'station-reading', reading: r }),
    reportCloseFailure: (f) => reportStationCloseFailures([f]),
    noteSkip: (stationId, reason) => stationHealth.noteSkip(stationId, reason),
    logSegment: (stationId, reason) => {
      const skip = reason === null ? '' : `（震度なし: ${reason}）`
      emit(
        stationSegmentLogLevel(reason),
        'station-segment',
        `${stationId}|${reason ?? 'ok'}`,
        `[station] ${stationId} 合成の状態が変わった${skip}`,
      )
    },
  }

  /**
   * `/api/*` の書き込みが観測点設定を確定したときに呼ぶ（#313 段 B）。
   *
   * **順序に意味のあるロジックは `applyStationConfigCore` へ抽出済み。** ここは
   * `main()` のローカル変数を `deps` へ束ねる配線だけを持つ。
   */
  const applyStationConfig = (newConfig: StationConfig): void => {
    applyStationConfigCore(
      {
        save: (config) => saveStationConfig(stationConfigPath, config),
        setCurrentConfig: (config) => {
          currentStationConfig = config
        },
        rebuildStations: (config) => {
          stations = new StationDirectory(config)
          pipeline.updateStations(stations)
        },
        closeSensorFusion: () => sensorFusion.closeAll(),
        reportCloseFailures: reportStationCloseFailures,
        emitReading: emitStationReading,
        onCloseFailure: (error) =>
          console.error(`[station-close] 設定変更に伴う観測点合成の締めくくりに失敗: ${messageOf(error)}`),
        rebuildSensorFusion: (config) => {
          sensorFusion = new SensorFusion(config)
          return sensorFusion.groupedStationIds
        },
        setUngroupedMultiBoardStations: (ids) => {
          ungroupedMultiBoardStations = ids
        },
        setWarning: (warning) => {
          stationConfigWarning = warning
        },
      },
      newConfig,
    )
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
      // **誰の声かが判るのはここから。** 読み取りに失敗した回は基板が判らないので覚えない。
      const current = streamKeyOf(read.packet)
      health.notePacket({ boardKey: board, sensorId: read.packet.sensorId, streamKey: current })
      const outcome = pipeline.handlePacket(read.packet)

      // **波形は震度より先に押し出す。** 計測震度は窓の都合で 2 秒遅れて出るので、
      // 順を入れ替えると受け手の画面で波形だけが遅れて見える。
      if (outcome.wave !== null) hub.publish({ kind: 'wave', wave: outcome.wave })

      // **観測点の合成（REQUIREMENTS.md §7）は、`ingest()` をここで呼ぶ。**
      // 波形の押し出し直後——属さない・相方が居ないセンサーは `SensorFusion.ingest()`
      // が素通りするので、単一センサー構成では何もしない。`ingest()` 自体は投げない
      // 契約（`sensorFusion.ts` を見ること）だが、**結果を配る（`deliverStationFusion`）
      // のはここでは行わない** —— 下で単一センサー側の報告を出し切ってから。
      const fusion = outcome.wave !== null ? sensorFusion.ingest(outcome.wave) : null

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
          const skipped = outcome.intensitySkipped
          tally.record({ kind: 'intensity-skipped', board, reason: skipped.reason })
          // **理由をセンサーごとに覚える。** この値が返るのは区間が始まった回だけで、
          // 記録の行を見逃すと「パケットは届くのに震度が出ない」理由が二度と分からない。
          //
          // **どの区間で立った理由かも渡す。** 下の `outcome.readings` には
          // 畳み直した旧区間の締めくくりが入ることがあり、渡さないとそちらが
          // 「震度が出た」として理由を消してしまう（`sensorHealth.ts` の `noteReading`）。
          health.noteSkip({
            boardKey: board,
            sensorId: read.packet.sensorId,
            reason: skipped.reason,
            streamKey: skipped.streamKey,
            segmentId: skipped.segmentId,
          })
        }
        const skip =
          outcome.intensitySkipped === null
            ? ''
            : `（震度なし: ${outcome.intensitySkipped.reason}${
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
      for (const r of outcome.readings) emitReading(r)

      // **観測点の合成の結果を配るのは、単一センサー側の報告をすべて出し切ってから。**
      // `deliverStationFusion` は外から注入された関数（`stationHealth.noteReading` 等）を
      // 呼ぶので、投げない契約が将来崩れる余地がある——手前に置いて投げると、この
      // データグラムが運んできた単一センサー側の報告（上の dropped・startedBecause・
      // closed・closeFailures・readings）がまとめて消える（下の自己診断と同じ理由）。
      if (fusion !== null) deliverStationFusion(stationFusionSinks, fusion)

      // **自己診断は本筋を出し切ってから。** このデータグラムの受け手は例外を囲わない
      // 方針（段 4-1）なので、ここで投げると**そのパケットが運んできた計測震度ごと**
      // 落ちる —— しかも残るのは `[udp] …` という汎用の 1 行だけで、震度が消えたことも
      // 診断が原因だということもどこにも出ない。**補助の仕組みを本筋の手前に置かない。**
      //
      // 渡すのは押し出すのと同じ配列。生のカウントからここで換算し直すと経路が 2 本になり、
      // **診断したい当の換算を迂回する**ことになる。
      if (outcome.wave !== null) {
        const verdict = gravity.noteWave({
          boardKey: outcome.wave.boardKey,
          sensorId: outcome.wave.sensorId,
          streamKey: outcome.wave.streamKey,
          gal: outcome.wave.gal,
        })
        if (verdict !== null) {
          for (const w of buildGravityWarnings(verdict)) emit(w.level, w.kind, w.detail, w.line)
        }
      }
    },
  })

  console.log(`[udp] ${address ?? '0.0.0.0'}:${receiver.port} で待ち受け中`)

  // **開けなければ落ちる。** 受信だけ生きていて状態も押し出しも届かない状態は、
  // 外から見ると「基板が黙っている」のと見分けが付かない。
  const statusServer = await startStatusServer({
    port: httpPort,
    address: httpAddress,
    hub,
    adminAuth,
    stationConfig: {
      get: () => currentStationConfig,
      apply: applyStationConfig,
    },
    // **呼ばれた時点で組み立てる。** 溜め込んだものを返すと、見に来た人が
    // 「いつの様子か」を自分で確かめられない。
    status: () =>
      buildStatusReport({
        nowMs: Date.now(),
        startedAtMs,
        udp: { address: address ?? '0.0.0.0', port: receiver.port },
        http: { address: httpAddress ?? '0.0.0.0', port: statusServer.port },
        tally: tally.snapshotTotal(),
        sensors: health.snapshot(),
        sensorEvictions: health.evictions,
        stationEvictions: stationHealth.evictions,
        stationIntensities: stationHealth.snapshot(),
        gravity: gravity.snapshot(),
        segments: pipeline.openSegments(),
        unusableIntensities: pipeline.unusableIntensities,
        // **`RawStore` の欄をここで書き写す。** 表の外にある値なので、
        // 足したときにここへ反映し忘れると状態の口からだけ静かに落ちる。
        raw: {
          writeErrors: rawStore.writeErrors,
          lostRecords: rawStore.lostRecords,
          slowCloses: rawStore.slowCloses,
          compressed: rawStore.compressed,
          compressFailures: rawStore.compressFailures,
          leftovers: rawStore.leftovers,
          listFailures: rawStore.listFailures,
          escaped: rawStore.escaped,
          openFiles: rawStore.openFiles,
          stuckBooks: rawStore.stuckBooks,
          recordsAtRisk: rawStore.recordsAtRisk,
          cutShort: rawStore.cutShort,
          currentDay: rawStore.currentDay,
          lastWriteError: rawStore.lastWriteError,
          lastSweepError: rawStore.lastSweepError,
        },
        hub: hub.snapshot(),
        stations,
        stationConfigWarning,
        ungroupedMultiBoardStations,
      }),
    log: emit,
  })
  console.log(
    `[http] ${httpAddress ?? '0.0.0.0'}:${statusServer.port} で待ち受け中`
    + '（/status は状態・/stream は震度の押し出し。?wave=1 で波形も）',
  )

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
    // **診断の結果も要約へ出す。** 1 件ずつの行は間引きを通るので、撃たれている間に
    // 抑えられうる。**欄は手で並べない** —— 見出しも並びも `GRAVITY_LABELS` が持ち、
    // 数を足せば黙って付いてくる（この機能は書き写す形で 4 巡続けて書き忘れた）。
    const diag = gravity.snapshot()
    const gravityCounters = gravityCountEntries(diag).map((e) =>
      delta(`gravity:${e.key}`, e.label, e.value),
    )
    const counters = {
      evicted: delta('evicted', '送信元の枠を捨てた', rateLimit.evictions),
      // **状態の口へ出すだけでは足りない。** ここは画面を持たない常駐プロセスで、
      // `/status` は見に来た人にしか届かない。この 3 つは**それ以外に声を持たない** ——
      // 押し出しの切断（詰まり・壊れた）は `onDetach` が 1 行ずつ出し、生データ系は
      // 下の行が拾っているが、こちらは要約から漏れると再起動まで誰も気づけない。
      unusableIntensity: delta(
        'unusableIntensity',
        '数として出せなかった計測震度',
        pipeline.unusableIntensities,
      ),
      sensorEvicted: delta('sensorEvicted', 'センサーの生存の枠を捨てた', health.evictions),
      stationEvicted: delta(
        'stationEvicted',
        '観測点ぶんの合成の生存の枠を捨てた',
        stationHealth.evictions,
      ),
      sseNotifyFailed: delta(
        'sseNotifyFailed',
        '押し出しを切ったことを報せられず',
        hub.snapshot().notifyFailed,
      ),
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
      counters: [...Object.values(counters), ...gravityCounters],
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
    // **設定ファイルの破損・合成グループの乖離も、間引きつつ再掲する。** 起動時の
    // `console.warn` は 1 回きりで、ログだけを監視している運用者には見逃すと二度と
    // 伝わらない（`buildStationConfigWarning`・`buildStationGroupingWarning` のコメント参照）。
    for (const w of buildStationConfigWarning(stationConfigWarning)) emit(w.level, w.kind, w.detail, w.line)
    for (const w of buildStationGroupingWarning(ungroupedMultiBoardStations)) {
      emit(w.level, w.kind, w.detail, w.line)
    }
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
      for (const r of rest.readings) emitReading(r)
    } catch (error) {
      console.error(`[close] 締めくくりに失敗: ${messageOf(error)}`)
    }

    // **観測点の合成（§7）も同じ理由で締める。** `sensorFusion.closeAll()` 自体は
    // 投げない契約（`sensorFusion.ts` の `endGroupStream` を見ること）だが、
    // 呼び出し元に個別の try/catch を要求する契約でもないので、他の締めくくりと
    // 同じ形で囲っておく。
    try {
      const stationRest = sensorFusion.closeAll()
      reportStationCloseFailures(stationRest.failures)
      for (const r of stationRest.readings) emitStationReading(r)
    } catch (error) {
      console.error(`[station-close] 観測点の合成の締めくくりに失敗: ${messageOf(error)}`)
    }

    // **状態の口は震度を出し切ってから閉じる。** 先に閉じると、最後の窓ぶんの答えが
    // 購読者へ届かない（押し出しを先に切らないと `server.close()` が返らないので、
    // 閉じる中で順序は守られる）。**ここで投げさせない** —— 終了に到達しなくなる。
    try {
      await statusServer.close()
    } catch (error) {
      console.error(`[http] 状態の口の締めに失敗: ${messageOf(error)}`)
    }

    // **累計は最後に必ず出す。** ここを囲いの中へ入れると、締めくくりが投げたときに
    // 起動してからの数え上げが丸ごと消える。
    console.log('[集計] 起動してからの累計')
    for (const line of formatTally(tally.snapshotTotal())) console.log(`  ${line}`)
    // **中身は純関数が持つ。** ここは終了の合図でしか走らないので、条件を直に書くと
    // 誰も見ていないことになる（この環境では実機でも確かめられない）。
    const lastDiag = gravity.snapshot()
    for (const c of buildClosingLines({
      evictions: rateLimit.evictions,
      unusableIntensities: pipeline.unusableIntensities,
      sensorEvictions: health.evictions,
      stationEvictions: stationHealth.evictions,
      gravity: lastDiag,
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
