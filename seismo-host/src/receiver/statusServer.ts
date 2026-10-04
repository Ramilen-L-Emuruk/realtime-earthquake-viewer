// 状態の口。
//
// - `GET /status` — いまの様子を JSON で返す（宛先は**運用者**）
// - `GET /stream` — 計測震度を押し出す。波形は `?wave=` で頼んだぶんだけ付く
//   （`station` = 観測点の合成だけ／`1`・`all` = センサー単独も。宛先は **PWA** と**管理コンソール**）
// - `GET /waves` — **過ぎた合成波形**を時刻の範囲で返す（宛先は **PWA**。#357）。
//   保存は `waveArchive.ts`、間引きは `waveEnvelope.ts`。
// - `/api/*` — 設定・履歴・管理操作（宛先は**管理コンソール**）。**認証必須**（`adminAuth.ts`）。
//   応じるのは観測点・基板の設定（`/api/stations`・`/api/boards`）だけ（#313 段 B）。
// - `GET /admin`・`GET /admin/app.js` — 管理コンソール本体（静的アセット）。**認証なし**——
//   見られても書き込みはできない（書き込みには `/api/*` のトークンが要る）（#313 段 C）。
//
// **読み返せるのは観測点の合成波形だけ。** 生データ（センサー単独の RAW 値）は日ごとの
// 追記型のままで、その日の中で頭出しする索引を持たない。
//
// **`/status`・`/stream`・`/waves` は認証を持たない。** 出るのは家の揺れの計測震度と機材の健全性
// だけで、読み取り専用のため公開してよい前提のまま変えていない。書き込みを伴う `/api/*`
// とは守り方が違う——CORS も別に持つ（`applyCors` は `*`、`/api/*` は Origin を列挙する）。
//
// **SSE を選んだ理由**（WebSocket ではなく）。速さはどちらも同じで、差が出るのは別のところ。
// 再接続をブラウザが自分でやること、そしてこちらから送るものが無いので双方向の利点が
// 効かないこと。
//
// **「普通の HTTP なので HTTPS のページからプライベート IP を素の `http://` で叩ける」という
// 前提は、iOS 実機の実測で崩れた**（REQUIREMENTS.md §13）。HTTPS 化の方式は Tailscale Serve に
// 決まっており、SSE と WebSocket のどちらを選ぶかはこの決定に左右されない——どちらも TLS 終端の
// 背後で動く。上記の理由（再接続・双方向不要）だけで SSE を選ぶ判断は変わらない。

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { AdminConsoleAssets } from './adminConsoleAssets'
import { checkAdminAuth } from './adminAuth'
import type { AdminAuthConfig, AdminAuthFailure } from './adminAuth'
import type { SensorRestWindows } from './gravityCheck'
import type { HubMessage, PairWant, ReadingHub, WaveWant } from './readingHub'
import { describeFailure, normalizeBoardKey, parseStationConfig } from './stationConfig'
import type { StationConfig } from './stationConfig'
import type { StatusReport } from './statusReport'
import type { ArchivedWaveChunk, WaveRangeResult } from './waveArchive'
import { buildWaveEnvelope } from './waveEnvelope'
import { EVENT_RANGE_MAX_MS } from '../detection/shakeEventStore'
import type { EventRangeResult } from '../detection/shakeEventStore'

/** 繋ぎ直すまでブラウザに待たせる時間。**SSE の `retry:` で伝える。** */
const RETRY_MS = 3_000

/**
 * `?wave=` に書ける値。
 *
 * **`1` の意味を変えない。** 管理コンソールの波形タブ（`src/admin/waveStream.ts`）が
 * この値で繋いでいて、あちらはセンサー単独の波形を描くのが仕事。
 *
 * **`Record` ではなく `Map` で持つ。** 素の物体は原型の鎖を引くので、
 * `?wave=constructor` のような問い合わせが `Object.prototype.constructor` を拾い、
 * **`?? 'none'` の受けを素通りして関数が `WaveWant` として通る**（型検査は
 * `Record<string, WaveWant>` を信じるので止めない）。`Map` なら入れた鍵しか返らない。
 */
const WAVE_PARAM = new Map<string, WaveWant>([
  ['1', 'all'],
  ['all', 'all'],
  ['station', 'station'],
])

/**
 * `?wave=` の値から、波形をどこまで配るかを決める。
 *
 * **知らない値・未指定は `'none'` へ倒す。** 波形が欲しい相手は必ず名乗るので、
 * 打ち間違いで毎秒 65 KB が流れ出すより、何も出ないほうが安全。
 *
 * **ただし倒したことは黙らない。** 「書いていない」と「書いたが読めなかった」を
 * 分けて返し、後者は呼び出し側が 1 行残す（{@link isUnknownWaveParam}）——
 * 倒したことが `/status` にしか出ないと、`?wave=Station` のような打ち間違いで
 * 波形が一度も届かない状態が「繋がっているのに来ない」としか見えなくなる
 * （購読の上限で断った回を 1 行残しているのと同じ理由）。
 */
export function parseWaveParam(raw: string | null): WaveWant {
  if (raw === null) return 'none'
  return WAVE_PARAM.get(raw) ?? 'none'
}

/**
 * `?wave=` に何か書いてあるのに読めなかったか。**書いていない場合は偽。**
 *
 * 戻りを `raw is string` にしてあるので、真のとき呼び出し側は値を記録へ出せる
 * （`raw !== null` を重ねて書かなくて済む）。
 */
export function isUnknownWaveParam(raw: string | null): raw is string {
  return raw !== null && !WAVE_PARAM.has(raw)
}

/**
 * 差分波形を頼むときに書く欄（#372）。**5 つそろって初めて 1 組を指す。**
 *
 * **区切り文字で連結しない。** `boardKey`・`sensorId` は無認証の UDP パケット由来で
 * 文字種の検証を持たないため、`a|b` のように繋ぐ形は**別の組と同じ鍵になりうる**
 * （`src/admin/waveBuffer.ts` の `keyOf` が長さを前に置いて避けているのと同じ問題）。
 * 欄を分ければ `URLSearchParams` が値ごとに独立に符号化するので、**そもそも
 * 連結が起きない。**
 */
const DIFF_PARAMS = ['diffStation', 'diffBoardA', 'diffSensorA', 'diffBoardB', 'diffSensorB'] as const

/**
 * 1 欄に許す長さ。
 *
 * **この口は認証を持たない**ので、頼んだ組をそのまま `/status` へ出す以上
 * （`SubscriberStats.diff`）、長さの歯止めがここに要る。実物は `mac:aabbccddeeff`
 * 程度・観測点 ID は運用者が付けるので、64 は十分な余裕がある。
 */
const DIFF_VALUE_MAX_LEN = 64

/** `?diff*=` を読んだ結果。 */
export interface DiffRequest {
  /** 読めた 1 組。何も書いていない・読めなかったときは null。 */
  readonly want: PairWant | null
  /**
   * 読めなかった理由。**何も書いていなければ null**（読めた場合も null）。
   *
   * **「書いていない」と「書いたが読めなかった」を分ける。** 後者を黙って
   * 差分なしへ倒すと、症状が「繋がっているのに差分が来ない」だけになる
   * （`isUnknownWaveParam` を分けているのと同じ理由）。
   */
  readonly problem: string | null
  /**
   * 上記の理由の種別。`problem` と同時に立つ。**記録を間引く鍵に使う。**
   *
   * **文面（`problem`）をそのまま鍵にしない。** あちらは欄の名前を含むので
   * 「欄が足りない」だけで 31 通りに分かれ、`logThrottle` の枠（種別ごと 32 個）を
   * 食い尽くす。**種別は 5 つで有界**なので、こちらを鍵にすれば
   * **60 秒の間引きが理由をまたいで潰し合わない** —— 違う理由の 2 件目が
   * 「同じものをほか 1 件」に丸められると、直近の失敗理由を見失う。
   */
  readonly problemKind: DiffProblemKind | null
}

/** 差分の指定を読めなかった理由の種別。**5 つで有界**（上記の `problemKind`）。 */
export type DiffProblemKind =
  | 'missing-fields'
  | 'empty-field'
  | 'too-long'
  | 'bad-board-key'
  | 'same-sensor'

/**
 * `?diff*=` の 5 欄から、差分波形を頼んでいる 1 組を読む。
 *
 * **半端でも接続は断らない。** 差分なしで繋いで 1 行残す —— 波形も震度も見に来て
 * いる相手を、差分の書き方を間違えただけで追い返す理由が無い。
 *
 * **前後の空白は落とす。** 設定側（`stationConfig.ts` の `nonEmptyString`）が
 * 落としてから持つので、ここで落とさないと**空白 1 つで永久に噛み合わない**。
 */
export function parseDiffParams(params: URLSearchParams): DiffRequest {
  const present = DIFF_PARAMS.filter((name) => params.get(name) !== null)
  if (present.length === 0) return { want: null, problem: null, problemKind: null }
  if (present.length < DIFF_PARAMS.length) {
    const missing = DIFF_PARAMS.filter((name) => params.get(name) === null)
    return { want: null, problem: `欄が足りない（${missing.join(' ')}）`, problemKind: 'missing-fields' }
  }

  const values = DIFF_PARAMS.map((name) => (params.get(name) ?? '').trim())
  const emptyAt = values.findIndex((v) => v.length === 0)
  if (emptyAt >= 0) {
    return { want: null, problem: `空の欄がある（${DIFF_PARAMS[emptyAt]}）`, problemKind: 'empty-field' }
  }
  const longAt = values.findIndex((v) => v.length > DIFF_VALUE_MAX_LEN)
  if (longAt >= 0) {
    return {
      want: null,
      problem: `欄が長すぎる（${DIFF_PARAMS[longAt]}・上限 ${DIFF_VALUE_MAX_LEN}）`,
      problemKind: 'too-long',
    }
  }

  const [stationId, rawBoardA, sensorA, rawBoardB, sensorB] = values
  // **設定と同じ関数を通す。** 別に書くと、大文字の MAC を揃え忘れた側だけが
  // 「構文は正しいのに設定の値と永久に一致しない」形になる（`normalizeBoardKey`）。
  const boardA = normalizeBoardKey(rawBoardA)
  const boardB = normalizeBoardKey(rawBoardB)
  if (boardA === null || boardB === null) {
    const which = boardA === null ? 'diffBoardA' : 'diffBoardB'
    return {
      want: null,
      problem: `基板の書き方が違う（${which}・mac: か name: で始める）`,
      problemKind: 'bad-board-key',
    }
  }
  if (boardA === boardB && sensorA === sensorB) {
    // **同じセンサーを 2 つ指している。** 差分は定義上ずっと 0 になるので、
    // 「届いているのに平らなまま」という読み違いを招く。
    return { want: null, problem: '同じセンサーを 2 つ指している', problemKind: 'same-sensor' }
  }
  return {
    want: { stationId, a: { boardKey: boardA, sensorId: sensorA }, b: { boardKey: boardB, sensorId: sensorB } },
    problem: null,
    problemKind: null,
  }
}

/**
 * 読み返し（`GET /waves`）で一度に頼める範囲の上限。
 *
 * **この口は認証を持たない**（`/status`・`/stream` と同じ層）ので、**ここが唯一の
 * 歯止め。** 上限が無いと、1 回の問い合わせでディスクを何時間ぶんも舐めさせられる。
 *
 * 10 分にしたのは、この口を待っている 2 つの用途がどちらもそれで足りるため ——
 * 地震カードへ出す区間の波形（#385）と、押し出しが途絶えた区間の穴埋め。
 */
const WAVE_RANGE_MAX_MS = 10 * 60 * 1000

/**
 * 間引かずに（サンプルのまま）返す場合の上限。**列で返す場合よりずっと狭い。**
 *
 * 2 分ぶんは 3 軸 × 100 Hz で 3.6 万点あり、JSON にすると 500 KB 前後。
 * 10 分を素のまま返すと数 MB になり、**認証の無い口が作る応答としては大きすぎる。**
 */
const WAVE_RAW_RANGE_MAX_MS = 2 * 60 * 1000

/** 落とせる列の数の上限。画面の横幅より多く要る用途は無い。 */
const WAVE_COLUMNS_MAX = 4096

/**
 * 10 進の整数だけを通す。**`Number()` に任せない** —— あれは `0x10` も空文字も受ける
 * （`main.ts` の `DECIMAL_PORT_RE` と同じ判断）。時刻は 13 桁なので 16 桁まで許す。
 */
const DECIMAL_INT_RE = /^-?\d{1,16}$/

function decimalInt(raw: string | null): number | null {
  if (raw === null || !DECIMAL_INT_RE.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

/** 読み返しの問い合わせ。**`columns` が `null` ならサンプルのまま返す。** */
export type WaveQuery =
  | {
      readonly ok: true
      readonly stationId: string
      readonly fromMs: number
      readonly toMs: number
      readonly columns: number | null
    }
  | { readonly ok: false; readonly error: string }

/**
 * `GET /waves` の問い合わせを読む。**範囲外は入口で弾く。**
 *
 * 下流へ流すと、その範囲に触れるファイルの数だけ無駄な読み込みが出る
 * （このリポジトリが「範囲外の指定は入口で弾く」と決めているのと同じ理由）。
 */
export function parseWaveQuery(params: URLSearchParams): WaveQuery {
  const stationId = params.get('station')
  if (stationId === null || stationId.length === 0) return { ok: false, error: 'station-required' }

  const fromMs = decimalInt(params.get('from'))
  const toMs = decimalInt(params.get('to'))
  if (fromMs === null || toMs === null) return { ok: false, error: 'bad-range' }
  // **等しい範囲も弾く。** 幅が無ければ列も作れず、サンプルも 1 点しか入らない。
  if (toMs <= fromMs) return { ok: false, error: 'bad-range' }

  const rawColumns = params.get('columns')
  let columns: number | null = null
  if (rawColumns !== null) {
    const n = decimalInt(rawColumns)
    if (n === null || n < 1 || n > WAVE_COLUMNS_MAX) return { ok: false, error: 'bad-columns' }
    columns = n
  }

  const limit = columns === null ? WAVE_RAW_RANGE_MAX_MS : WAVE_RANGE_MAX_MS
  if (toMs - fromMs > limit) return { ok: false, error: 'range-too-wide' }

  return { ok: true, stationId, fromMs, toMs, columns }
}

export type EventQuery =
  | { readonly ok: true; readonly fromMs: number; readonly toMs: number; readonly stationId: string | null }
  | { readonly ok: false; readonly error: 'bad-range' | 'range-too-wide' }

/**
 * `GET /events` の問い合わせを読む。`from`・`to`（unix ミリ秒）は必須、`station` は任意。
 *
 * **範囲は {@link EVENT_RANGE_MAX_MS} まで。** 記録は月ごとのファイルを頭から読むので、
 * 際限なく広げさせない。
 */
export function parseEventQuery(params: URLSearchParams): EventQuery {
  const fromMs = decimalInt(params.get('from'))
  const toMs = decimalInt(params.get('to'))
  if (fromMs === null || toMs === null || toMs <= fromMs) return { ok: false, error: 'bad-range' }
  if (toMs - fromMs > EVENT_RANGE_MAX_MS) return { ok: false, error: 'range-too-wide' }
  const station = params.get('station')
  return { ok: true, fromMs, toMs, stationId: station === null || station.length === 0 ? null : station }
}

/**
 * 読み返した揺れを応答の形へ。**読めなかった行・ファイルの数を必ず添える** ——
 * 無いと、受け手からは「揺れが無かった」と「記録が壊れていた」が同じ空の配列に見える。
 */
export function buildEventResponse(query: Extract<EventQuery, { ok: true }>, result: EventRangeResult): Record<string, unknown> {
  const events = query.stationId === null ? result.events : result.events.filter((e) => e.stationId === query.stationId)
  return {
    fromMs: query.fromMs,
    toMs: query.toMs,
    stationId: query.stationId,
    events,
    unreadableLines: result.unreadableLines,
    unreadableFiles: result.unreadableFiles,
  }
}

/**
 * 読み返した結果を応答の形へ。
 *
 * **読めなかった量（`skippedBytes`）と、記録の無い時の数（`filesMissing`）を必ず添える。**
 * これが無いと、受け手からは「揺れていなかった」と「残っていない」が同じ空の配列に見える。
 *
 * **サンプルのまま返すときは `null` が欠測を表す。** `JSON.stringify` は `NaN` を
 * `null` にするので、受け手は「数でない要素は届かなかった区間」として読むこと
 * （埋めると、そこだけ時間の縮んだ絵になる）。
 */
export function buildWaveResponse(
  query: Extract<WaveQuery, { ok: true }>,
  result: WaveRangeResult,
  stationKnown: boolean,
): Record<string, unknown> {
  const common = {
    stationId: query.stationId,
    /**
     * その観測点がいまの設定にあるか。
     *
     * **無くても読みにいく。** 設定から外した観測点の記録は残っているので、
     * 「いまの設定に無い」を理由に断ると過去を読み返せなくなる。ただし**黙らない**
     * —— 綴り間違いは「その観測点は静かだった」と寸分違わない応答になるので、
     * ここで見分けが付くようにする。
     */
    stationKnown,
    fromMs: query.fromMs,
    toMs: query.toMs,
    filesRead: result.filesRead,
    filesMissing: result.filesMissing,
    filesFailed: result.filesFailed,
    skippedBytes: result.skippedBytes,
    truncated: result.truncated,
  }
  if (query.columns !== null) {
    const envelope = buildWaveEnvelope({
      chunks: result.chunks,
      fromMs: query.fromMs,
      toMs: query.toMs,
      columnCount: query.columns,
    })
    return {
      ...common,
      columnSpanMs: envelope.columnSpanMs,
      columns: envelope.columns,
      hasAnyValue: envelope.hasAnyValue,
      peakGal: envelope.peakGal,
    }
  }
  return { ...common, chunks: result.chunks.map(toWireChunk) }
}

function toWireChunk(chunk: ArchivedWaveChunk): Record<string, unknown> {
  return {
    firstSampleMs: chunk.firstSampleMs,
    msPerSample: chunk.msPerSample,
    dcGal: chunk.dcGal,
    gal: [Array.from(chunk.gal[0]), Array.from(chunk.gal[1]), Array.from(chunk.gal[2])],
    memberCount: Array.from(chunk.memberCount),
  }
}

/**
 * 外から来た値を記録へ出せる形へ削る。
 *
 * **そのまま書かない。** 問い合わせ文字列は誰でも自由に書けるので、改行を混ぜれば
 * 記録へ偽の 1 行を差し込めるし、長さにも上限が無い。記録に要るのは
 * 「何を渡されたか」が分かる程度で、原文の忠実な再現ではない。
 */
function forLog(raw: string): string {
  const tame = raw.replace(/[\u0000-\u001F\u007F]/g, '?')
  return tame.length > 32 ? `${tame.slice(0, 32)}…` : tame
}

/**
 * 生存確認を送る間隔。
 *
 * **相手が黙って消えたことに気づくための仕組み。** 送るのはコメント行なので
 * `EventSource` の `message` には現れない。これが無いと、電源を抜かれた端末のぶんが
 * 枠を占めたまま残り、**新しく開いたタブが上限で断られる。**
 */
const HEARTBEAT_MS = 15_000

export type LogLevel = 'log' | 'warn' | 'error'

/**
 * 観測点設定の読み書き（#313 段 B）。**この層は保存・反映の中身を知らない** ——
 * `get`・`apply` の実体は `main.ts` が持つ（`StationDirectory`・`IntensityPipeline`・
 * `SensorFusion` の差し替えは、この HTTP の層の関心事ではない）。
 */
export interface StationConfigOps {
  /** いまの設定。**呼ばれた時点のもの**（`status` と同じ理由で、溜め込まない）。 */
  readonly get: () => StationConfig
  /**
   * 新しい設定を保存し、ランタイムへ反映する。
   *
   * **例外を投げうる**（ディスクへの書き込み失敗）。呼び出し元（このファイルの
   * 書き込みハンドラ）が捕まえて 500 へ変える。
   */
  readonly apply: (config: StationConfig) => void
}

export interface StatusServerOptions {
  readonly port: number
  readonly address?: string
  readonly hub: ReadingHub
  /**
   * いまの様子を作って返す。**呼ばれた時点で組み立てる。**
   *
   * 溜め込んだものを返す形にすると、見に来た人が「いつの様子か」を自分で確かめられない。
   */
  readonly status: () => StatusReport
  /**
   * 記録を 1 行出す。**間引きは呼び出し側が持つ**（`main.ts` の `emit`）。
   *
   * ここで数を抑えないのは、抑え方の規約が 1 箇所（`logThrottle.ts`）にある約束を
   * 崩さないため。
   */
  readonly log?: (level: LogLevel, kind: string, detail: string, line: string) => void
  /**
   * 生存確認を送る間隔。**テストのために差し替える。**
   *
   * 既定を運用で変える用途は無い（値の根拠は `HEARTBEAT_MS`）。ここを開けてあるのは、
   * **生存確認がそもそも飛んでいるか**を確かめる手が他に無いため —— 実際に 15 秒
   * 待つテストは書けず、待たずに済ませるとこの間隔タイマーの配線を誰も見ない。
   *
   * **ここで観測できるのは「飛ぶこと」までで、書き込みが失敗した側は覆えない。**
   * 相手が切れば `req` の `'close'` が先に走って間隔タイマーを止めるので、
   * **外から壊せるソケットでは `stopFailed` へ到達しない**（あの経路が要るのは、
   * `'close'` を伴わずに壊れる場合）。`closeFailed` 自体の振る舞いは
   * `readingHub.test.ts` が押さえているが、**ここからの配線は覆われていない。**
   */
  readonly heartbeatMs?: number
  /**
   * `/api/*` を守る認証設定。**`token: null` なら `/api/*` 自体を無効化する**
   * （`adminAuth.ts` の `checkAdminAuth` が `not-configured` を返し、ここで 503 に変える）。
   */
  readonly adminAuth: AdminAuthConfig
  /** `/api/stations`・`/api/boards` の読み書き（#313 段 B）。 */
  readonly stationConfig: StationConfigOps
  /**
   * センサーごとの静止窓（`GET /api/rest-windows`・6 面法と「鉛直を合わせる」の材料）。
   *
   * **`/api/*` の側に置く。** 校正前の生の値は運用者が校正するためのもので、誰でも読める
   * `/status` に並べる理由が無い（9 センサー × 60 窓で `/status` が数十 KB 膨らむ）。
   */
  readonly readRestWindows: () => readonly SensorRestWindows[]
  /**
   * 管理コンソール本体（#313 段 C）。`GET /admin`・`GET /admin/app.js` で配る。
   *
   * **`/api/*` とは別の経路。** ここは静的ファイルを返すだけで認証を持たない
   * ——見られても書き込みはできない（書き込みには別途トークンが要る。
   * README.md「`/api/*` の認証」参照）。
   *
   * **`null` はビルド失敗を表す。** `main.ts` が `buildAdminConsoleAssets()` を
   * `try/catch` した結果——esbuild のビルド失敗（構文エラー・ARM 環境での
   * ネイティブバイナリ解決失敗等）は管理コンソールという補助機能だけの問題で
   * あり、UDP 受信・`/status`・`/stream`・`/api/*` という地震計本体の可用性を
   * 道連れにしてはならない（#313 段 C 敵対的レビューで検出）。`null` のときは
   * `/admin`・`/admin/app.js` だけ 503 を返す。
   */
  readonly adminConsole: AdminConsoleAssets | null
  /**
   * 過ぎた合成波形を時刻の範囲で読み返す（`GET /waves`・#357）。
   *
   * **`null` なら口ごと 503。** 保存を持たない構成（テスト・保存先を開けなかった
   * 起動）で「0 件」を返すと、**揺れていなかったのか記録していないのかが
   * 呼び出し側から見分けられない。**
   *
   * **関数で受け取る。** ディスクを直に触る形にすると、範囲の検証を試すのに
   * ファイルを並べる必要が出る（`stationConfig` を関数で受けているのと同じ分担）。
   */
  readonly readWaves:
    | ((params: {
        readonly stationId: string
        readonly fromMs: number
        readonly toMs: number
      }) => Promise<WaveRangeResult>)
    | null
  /**
   * 検出した揺れの記録を時刻の範囲で読み返す（`GET /events`。REQUIREMENTS.md §9）。
   * **`null` なら記録を持たない構成** —— 503 で答え、「揺れが無かった」と区別させる。
   */
  readonly readEvents: ((params: { readonly fromMs: number; readonly toMs: number }) => Promise<EventRangeResult>) | null
}

export interface StatusServer {
  /** 実際に開いた port。**0 を渡した場合はここで判る。** */
  readonly port: number
  close(): Promise<void>
}

/** SSE の 1 件。 */
function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * 押し出す 1 件を SSE の文面へ直す。
 *
 * **`switch` で全種別を書き、`default` を置かない。** そうしておくと `HubMessage` へ
 * 種別を足したとき「`string` を返さない経路がある」として型検査が止める ——
 * 以前は「最後は `station-reading`」と決め打つ形で、`station-wave` を足した時点で
 * **合成波形が `station-reading` という名前で流れる**ところだった（受け手は名前で
 * 振り分けるので、震度として読もうとして壊れる）。
 */
function encode(message: HubMessage): string {
  switch (message.kind) {
    case 'reading':
      return sseEvent('reading', message.reading)
    case 'wave':
      return sseEvent('wave', message.wave)
    case 'station-reading':
      return sseEvent('station-reading', message.reading)
    case 'station-wave':
      return sseEvent('station-wave', message.wave)
    case 'station-diff':
      return sseEvent('station-diff', message.diff)
    case 'shake-event':
      return sseEvent('shake-event', message.event)
  }
}

/**
 * 横断の許しを付ける。
 *
 * **オリジンを列挙せず `*` で開く。** 読み取り専用で、出るのは家の揺れの計測震度と
 * 機材の健全性だけ。繋ぎ先（GitHub Pages・dev サーバー・preview・別の端末のブラウザ）は
 * 増えるので、列挙する形にすると**増えるたびに受け手を書き換える運用**になる。
 */
function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
}

/**
 * 先回りの問い合わせ（preflight）へ答える。
 *
 * **プライベート網への許しも返す。** ブラウザが `Access-Control-Request-Private-Network` を
 * 付けてくることがあるので、訊かれたら答える形にしてある。**iOS 実機実測の経緯はこのファイル
 * 冒頭のコメント・REQUIREMENTS.md §13 を参照** —— ここは訊かれたら答えるだけの受け身の実装で、
 * 決定した経路（Tailscale Serve）が実際に叩く先とは無関係に残してよい。
 */
function handlePreflight(req: IncomingMessage, res: ServerResponse): void {
  applyCors(res)
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*')
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  res.setHeader('Access-Control-Max-Age', '600')
  res.writeHead(204)
  res.end()
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(code)
  res.end(JSON.stringify(body))
}

/**
 * 管理コンソールの静的アセットを返す。**`no-store` を付ける。** ビルド成果物は
 * ディスクに書かず起動のたびに作り直す（`adminConsoleAssets.ts`）ため、
 * ブラウザ側にキャッシュを持たせると再起動後の変更が反映されない事故になる。
 */
function sendHtml(res: ServerResponse, code: number, body: string): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(code)
  res.end(body)
}

function sendJs(res: ServerResponse, code: number, body: string): void {
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(code)
  res.end(body)
}

/**
 * `/api/*` 向けの横断の許し。**`*` ではなく Origin を列挙して返す。**
 *
 * 書き込みを伴うので、`/status`・`/stream` の `applyCors`（`*`）とは事情が違う——
 * 見せる相手を絞る必要がある。許可リストに無い Origin へは `Access-Control-Allow-Origin`
 * を返さない（ブラウザ側が読み取りを拒む）。`Vary: Origin` を添えるのは、同じ URL でも
 * リクエスト元によって応答ヘッダが変わることを、間に挟まる代理へ伝えるため。
 */
function applyAdminCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: readonly string[]): void {
  const origin = req.headers.origin
  // **`Vary: Origin` は一致・不一致に関わらず常に付ける。** 一致した場合だけ付けると、
  // 間に挟まる代理が「Origin で応答が変わる」こと自体を知らないまま拒否応答（不一致）を
  // キャッシュしうる——別の Origin から来た正当なリクエストへ、他人の拒否応答を返しかねない。
  res.setHeader('Vary', 'Origin')
  if (origin !== undefined && allowedOrigins.some((o) => o.toLowerCase() === origin.toLowerCase())) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
}

/**
 * `/api/*` の先回りの問い合わせ（preflight）へ答える。
 *
 * **認証は見ない。** ブラウザの preflight リクエストは `Authorization` を含まないので
 * （それを訊きに行くのが preflight の役目）、ここで `checkAdminAuth` を通しても
 * 必ず `missing-authorization` になり、本来は認証を持つ正規のリクエストまで
 * preflight の段階で弾かれる。Origin の許可だけを見て応じる。
 */
function handleAdminPreflight(req: IncomingMessage, res: ServerResponse, allowedOrigins: readonly string[]): void {
  applyAdminCors(req, res, allowedOrigins)
  res.setHeader('Access-Control-Max-Age', '600')
  res.writeHead(204)
  res.end()
}

function sendAdminJson(res: ServerResponse, code: number, body: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(code)
  res.end(JSON.stringify(body))
}

/**
 * 認証の失敗理由を HTTP ステータスへ変える。
 *
 * **`default` を置かず全件を switch で網羅する**（`stationConfig.ts` の `describeFailure` と
 * 同じ判断）。理由を足したのにここへ書き足し忘れると、`never` に合わせられず型検査が落ちる——
 * 書き忘れたまま実行時に「理由不明の 500」へ化けることはない。
 */
function adminAuthStatusCode(reason: AdminAuthFailure['reason']): number {
  switch (reason) {
    case 'not-configured':
      return 503
    case 'missing-authorization':
    case 'invalid-token':
      return 401
    case 'host-not-allowed':
    case 'origin-not-allowed':
      return 403
  }
}

/** `/api/*` の経路。**`stationId`・`boardKey` は URL デコード済み。** */
type AdminRoute =
  | { readonly kind: 'stations' }
  | { readonly kind: 'station'; readonly stationId: string }
  | { readonly kind: 'boards' }
  | { readonly kind: 'board'; readonly boardKey: string }
  | { readonly kind: 'rest-windows' }

/**
 * `/api/*` の経路を解く。**マッチしなければ `null`**（呼び出し側が 404 にする）。
 *
 * `boardKey` は `mac:020000000003` のようにコロンを含むが、URL パスのセグメント内では
 * コロンは合法な文字なので `decodeURIComponent` だけで足りる（`encodeURIComponent` された
 * `%3A` 表記でも通す）。
 */
function parseAdminRoute(pathname: string): AdminRoute | null {
  if (pathname === '/api/stations') return { kind: 'stations' }
  if (pathname.startsWith('/api/stations/')) {
    const stationId = decodeURIComponent(pathname.slice('/api/stations/'.length))
    return stationId.length > 0 ? { kind: 'station', stationId } : null
  }
  if (pathname === '/api/boards') return { kind: 'boards' }
  if (pathname.startsWith('/api/boards/')) {
    const boardKey = decodeURIComponent(pathname.slice('/api/boards/'.length))
    return boardKey.length > 0 ? { kind: 'board', boardKey } : null
  }
  if (pathname === '/api/rest-windows') return { kind: 'rest-windows' }
  return null
}

/** 書き込みボディの上限。**観測点設定は小さいデータ**なので十分すぎるほど余裕を持つ。 */
const MAX_ADMIN_BODY_BYTES = 64 * 1024

type AdminBodyResult = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: string }

/**
 * `/api/*` の書き込みボディを読む。**投げない**（`handleAdmin` と同じ契約）。
 *
 * **上限を超えたら溜めるのをやめ、以後は読み捨てる。** 上限までしか溜めないだけだと、
 * 送り手が延々と流し続ける限りこの購読がメモリを食い続ける。
 *
 * **`req.destroy()` は呼ばない。** `req` と `res` は下層のソケットを共有しており、
 * `destroy()` はそのソケットごと閉じる——実測（Node.js v24）で確認したところ、
 * 直後に呼び手が `res.writeHead`/`res.end` を呼んでも例外は投げずに黙って捨てられ、
 * クライアントには 400 の理由ではなく `socket hang up`（接続断）しか届かない。
 * **理由を伝える応答を返すには、ソケットを生かしたまま以後のデータを読み捨てる**
 * （`removeAllListeners('data')` の後 `resume()`）——相手の送信を詰まらせず、
 * `res` 側から通常どおり 400 を返せるようにする。
 */
function readAdminBody(req: IncomingMessage): Promise<AdminBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (result: AdminBodyResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      if (total > MAX_ADMIN_BODY_BYTES) {
        finish({ ok: false, reason: 'body-too-large' })
        req.removeListener('data', onData)
        req.resume()
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) {
        finish({ ok: false, reason: 'empty-body' })
        return
      }
      try {
        finish({ ok: true, body: JSON.parse(text) })
      } catch {
        finish({ ok: false, reason: 'invalid-json' })
      }
    })
    // **`req` 自身が壊れた場合、または相手が送信途中で切った場合。** `'end'` が来ないまま
    // 待ち続けないよう、ここでも決着させる。
    req.on('error', () => finish({ ok: false, reason: 'read-error' }))
    req.on('close', () => finish({ ok: false, reason: 'read-error' }))
  })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * `/api/stations/:stationId` の PUT。**upsert**（無ければ作る・あれば置き換える）。
 *
 * **`stationId` はボディでなく URL パスを正とする。** ボディに別の `stationId` が
 * 入っていても無視する——URL が指す資源を書き換えるという REST の前提に合わせる。
 */
async function handlePutStation(
  req: IncomingMessage,
  res: ServerResponse,
  stationConfig: StationConfigOps,
  stationId: string,
): Promise<void> {
  const bodyResult = await readAdminBody(req)
  if (!bodyResult.ok) {
    sendAdminJson(res, 400, { error: bodyResult.reason })
    return
  }
  if (!isPlainObject(bodyResult.body)) {
    sendAdminJson(res, 400, { error: 'body-not-an-object' })
    return
  }

  const current = stationConfig.get()
  const others = current.stations.filter((s) => s.stationId !== stationId)
  // **`unknown` のまま `parseStationConfig` へ渡す。** `bodyResult.body` はまだ検証前の
  // 入力なので、ここへ `StationConfig` の型注釈を付けると「検証済みのふり」をした値を
  // 作ることになる——実際の検証は次の `parseStationConfig` が担う。
  //
  // **`stationId` は必ずスプレッドの後に置く。** オブジェクトリテラルは後勝ちなので、
  // 先に置くとボディに紛れ込んだ `stationId` で上書きされる——URL パスを正とする
  // という上のコメントの約束が、まさにこの並び順ひとつで壊れる（敵対的レビューで発見）。
  const candidate: unknown = {
    stations: [...others, { ...bodyResult.body, stationId }],
    boards: current.boards,
  }

  const parsed = parseStationConfig(candidate)
  if (!parsed.ok) {
    sendAdminJson(res, 400, { error: 'invalid-config', detail: describeFailure(parsed.failure) })
    return
  }

  try {
    stationConfig.apply(parsed.config)
  } catch (error) {
    sendAdminJson(res, 500, { error: 'save-failed', detail: messageOfError(error) })
    return
  }
  const saved = parsed.config.stations.find((s) => s.stationId === stationId)
  sendAdminJson(res, 200, { station: saved })
}

/**
 * `/api/stations/:stationId` の DELETE。
 *
 * **基板が割り当て済みの観測点は拒む（409）。** 黙って削ると、その基板は
 * `unknown-station-id` を指す壊れた設定になる——`parseStationConfig` が参照整合性を
 * 検査する設計に沿って、こちらも壊れた状態を作らない側に倒す。
 */
function handleDeleteStation(res: ServerResponse, stationConfig: StationConfigOps, stationId: string): void {
  const current = stationConfig.get()
  if (!current.stations.some((s) => s.stationId === stationId)) {
    sendAdminJson(res, 404, { error: 'not-found' })
    return
  }
  const boardsUsingStation = current.boards.filter((b) => b.stationId === stationId).map((b) => b.boardKey)
  if (boardsUsingStation.length > 0) {
    sendAdminJson(res, 409, { error: 'station-in-use', boards: boardsUsingStation })
    return
  }

  // **PUT 系と同じく `parseStationConfig` を通す。** 要素を減らすだけなので通常は
  // 落ちないはずだが、これを通さないと「書き込みハンドラが渡す設定は常にパース済み」
  // という `main.ts` 側の前提（`applyStationConfig` のコメント）が DELETE 系だけ
  // 実態と食い違う——検証の単一情報源を `parseStationConfig` に保つ。
  const parsed = parseStationConfig({
    stations: current.stations.filter((s) => s.stationId !== stationId),
    boards: current.boards,
  })
  if (!parsed.ok) {
    sendAdminJson(res, 400, { error: 'invalid-config', detail: describeFailure(parsed.failure) })
    return
  }
  try {
    stationConfig.apply(parsed.config)
  } catch (error) {
    sendAdminJson(res, 500, { error: 'save-failed', detail: messageOfError(error) })
    return
  }
  sendAdminJson(res, 200, { deleted: stationId })
}

/**
 * `/api/boards/:boardKey` の PUT。**upsert。** `stationId` が `stations[]` に無ければ
 * `parseStationConfig` の `unknown-station-id` で 400 になる——観測点を先に作る必要がある。
 */
async function handlePutBoard(
  req: IncomingMessage,
  res: ServerResponse,
  stationConfig: StationConfigOps,
  boardKey: string,
): Promise<void> {
  const bodyResult = await readAdminBody(req)
  if (!bodyResult.ok) {
    sendAdminJson(res, 400, { error: bodyResult.reason })
    return
  }
  if (!isPlainObject(bodyResult.body)) {
    sendAdminJson(res, 400, { error: 'body-not-an-object' })
    return
  }

  const current = stationConfig.get()
  const others = current.boards.filter((b) => b.boardKey !== boardKey)
  // **`unknown` のまま渡す理由・`boardKey` をスプレッドの後に置く理由は
  // `handlePutStation` と同じ。** `sensors` の既定値（`[]`）はボディより**先**に置く——
  // ボディが `sensors` を持っていればそちらを優先し、無ければ空配列へ倒す。
  const candidate: unknown = {
    stations: current.stations,
    boards: [...others, { sensors: [], ...bodyResult.body, boardKey }],
  }

  const parsed = parseStationConfig(candidate)
  if (!parsed.ok) {
    sendAdminJson(res, 400, { error: 'invalid-config', detail: describeFailure(parsed.failure) })
    return
  }

  try {
    stationConfig.apply(parsed.config)
  } catch (error) {
    sendAdminJson(res, 500, { error: 'save-failed', detail: messageOfError(error) })
    return
  }
  const saved = parsed.config.boards.find((b) => b.boardKey === boardKey)
  sendAdminJson(res, 200, { board: saved })
}

/** `/api/boards/:boardKey` の DELETE。**割当と校正値（`sensors[]`）を丸ごと削除する**（観測点自体は消さない）。 */
function handleDeleteBoard(res: ServerResponse, stationConfig: StationConfigOps, boardKey: string): void {
  const current = stationConfig.get()
  if (!current.boards.some((b) => b.boardKey === boardKey)) {
    sendAdminJson(res, 404, { error: 'not-found' })
    return
  }
  // **理由は `handleDeleteStation` と同じ。**
  const parsed = parseStationConfig({
    stations: current.stations,
    boards: current.boards.filter((b) => b.boardKey !== boardKey),
  })
  if (!parsed.ok) {
    sendAdminJson(res, 400, { error: 'invalid-config', detail: describeFailure(parsed.failure) })
    return
  }
  try {
    stationConfig.apply(parsed.config)
  } catch (error) {
    sendAdminJson(res, 500, { error: 'save-failed', detail: messageOfError(error) })
    return
  }
  sendAdminJson(res, 200, { deleted: boardKey })
}

/** `readingHub.ts` などと同じ形。`Error` でない値が投げられても `.message` で墜落しない。 */
function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `/api/*` の入口。
 *
 * CORS ヘッダは**認証の成否によらず先に付ける**。拒否した応答もブラウザに読ませる必要が
 * あるため（読ませなければ「拒否された」ことがブラウザの `fetch` からは `TypeError` としか
 * 見えず、理由（`error` の値）が失われる）。
 *
 * **拒否した理由は必ず 1 行記録する。** `handleStream` が購読の上限で断ったときと同じ理由——
 * 断りは運用者の記録にしか出ないので、ここで黙ると総当たり・スキャンが記録から一切見えない
 * まま進む（見に来ない運用ではなおさら気づけない）。
 *
 * **投げない。** 書き込みハンドラは非同期だが、内部で全て捕まえる——`createServer` の
 * コールバックは同期関数なので、ここが reject すると `unhandledRejection` として
 * プロセスの外へ漏れる。
 */
async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  adminAuth: AdminAuthConfig,
  log: (level: LogLevel, kind: string, detail: string, line: string) => void,
  stationConfig: StationConfigOps,
  readRestWindows: () => readonly SensorRestWindows[],
): Promise<void> {
  applyAdminCors(req, res, adminAuth.allowedOrigins)

  // **同名ヘッダが複数回届くと配列になる。** `Sec-Fetch-Site` は単一値の想定だが、
  // 型上は他のヘッダと同じ扱いなので、`origin`・`host` と同じ流儀（先頭を採る）に揃える。
  const secFetchSiteHeader = req.headers['sec-fetch-site']
  const secFetchSite = Array.isArray(secFetchSiteHeader) ? secFetchSiteHeader[0] : secFetchSiteHeader

  const failure = checkAdminAuth(
    {
      authorization: req.headers.authorization,
      host: req.headers.host,
      origin: req.headers.origin,
      secFetchSite,
    },
    adminAuth,
  )
  if (failure !== null) {
    log('warn', 'admin', failure.reason, `[admin] /api/* を拒否した（${failure.reason}）`)
    sendAdminJson(res, adminAuthStatusCode(failure.reason), { error: failure.reason })
    return
  }

  const route = parseAdminRoute(url.pathname)
  if (route === null) {
    sendAdminJson(res, 404, { error: 'not-found' })
    return
  }

  if (route.kind === 'stations') {
    if (req.method !== 'GET') {
      sendAdminJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    sendAdminJson(res, 200, { stations: stationConfig.get().stations })
    return
  }
  if (route.kind === 'station') {
    if (req.method === 'PUT') {
      await handlePutStation(req, res, stationConfig, route.stationId)
      return
    }
    if (req.method === 'DELETE') {
      handleDeleteStation(res, stationConfig, route.stationId)
      return
    }
    sendAdminJson(res, 405, { error: 'method-not-allowed' })
    return
  }
  if (route.kind === 'boards') {
    if (req.method !== 'GET') {
      sendAdminJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    sendAdminJson(res, 200, { boards: stationConfig.get().boards })
    return
  }
  if (route.kind === 'rest-windows') {
    if (req.method !== 'GET') {
      sendAdminJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    sendAdminJson(res, 200, { sensors: readRestWindows() })
    return
  }
  // route.kind === 'board'
  if (req.method === 'PUT') {
    await handlePutBoard(req, res, stationConfig, route.boardKey)
    return
  }
  if (req.method === 'DELETE') {
    handleDeleteBoard(res, stationConfig, route.boardKey)
    return
  }
  sendAdminJson(res, 405, { error: 'method-not-allowed' })
}

export async function startStatusServer(options: StatusServerOptions): Promise<StatusServer> {
  const { hub } = options
  const writeLog = options.log ?? ((): void => {})

  /**
   * 記録を 1 行出す。**投げさせない。**
   *
   * `log` は呼び出し側が注入する関数で、この層からは中身を保証できない
   * （標準出力がパイプになっていて読み手が先に閉じれば、`console.*` は同期で投げる）。
   * ここから呼ぶのは**後始末の途中と間隔タイマーの中**なので、抜ければ
   * 後始末が飛ぶか、**この受け手のプロセスごと落ちる** —— 押し出しの購読 1 つのために
   * UDP の受信も生データの保存も道連れになる。
   *
   * **1 箇所ずつ `try` で囲う形にしない。** 呼ぶ場所は 5 つあり、囲い忘れても
   * 型検査もテストも通る（壊れるのは記録の口そのものが壊れたときだけなので、
   * 書き忘れに気づく機会が無い）。ここで一度だけ握れば、以後は素直に呼べる。
   */
  const log = (level: LogLevel, kind: string, detail: string, line: string): void => {
    try {
      writeLog(level, kind, detail, line)
    } catch {
      // **記録する手段そのものが壊れている。** `console` を経由せず、最後の望みとして
      // 直に 1 行だけ書く —— ここまで黙ると、SSE について以後どんな異常が起きても
      // 痕跡がどこにも残らない（切れた件数は数えられるが、**なぜ切れたかが消える**）。
      //
      // **ここも握る。** 握らなければ、記録の口が壊れたことを伝えるために
      // プロセスを落とすことになる。
      try {
        process.stderr.write(`[sse] 記録の口が投げた: ${kind}/${detail}\n`)
      } catch {
        // 伝える手段が 1 つも残っていない。
      }
    }
  }

  const handleStream = (
    req: IncomingMessage,
    res: ServerResponse,
    wantsWave: WaveWant,
    wantsDiff: PairWant | null,
  ): void => {
    applyCors(res)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    // **間に挟まるものに溜め込ませない。** 逆向きの代理が居ると、溜めてから
    // まとめて流す既定のせいで押し出しの意味が消える。
    res.setHeader('X-Accel-Buffering', 'no')

    let heartbeat: NodeJS.Timeout | null = null
    const subscription = hub.subscribe({
      wave: wantsWave,
      diff: wantsDiff,
      deliver: (message) => {
        // **書く前に詰まりを見る。** 書いてから「詰まっている」と申告すると、
        // こちらは捨てたつもりでいるのに向こうの待ち行列だけが伸び続ける
        // （溜めない、という約束がそこで崩れる）。
        if (res.writableEnded || res.writableNeedDrain) return false
        res.write(encode(message))
        return true
      },
      onDetach: (reason) => {
        if (heartbeat !== null) clearInterval(heartbeat)
        // **`log` は投げない**（上の包みが握る）ので、後始末を `finally` へ逃がす
        // 必要は無い。ここで囲い直すと、守りの重なりが「なぜ 2 重なのか」として
        // 読めなくなる。
        log('warn', 'sse', reason, `[sse] 押し出しを切った（${reason}）`)
        res.end()
      },
    })

    if (subscription === null) {
      const limit = hub.snapshot().limit
      // **こちら側にも残す。** 切った理由（詰まり・壊れた・締めくくり）は `onDetach` が
      // 1 行ずつ出しているのに、断った回だけ黙ると非対称になる —— 断りは
      // `/status` の `rejected` にしか出ないので、**見に来ない運用では上限に
      // 張り付いたまま誰も気づけない**（向こうには 503 が返るが、それは向こうの記録）。
      log('warn', 'sse', 'rejected', `[sse] 購読の上限（${limit}）で断った`)
      // **断ったことを相手に伝える。** 黙って閉じると、繋がらない理由が
      // 向こうの画面にも記録にも残らない。
      sendJson(res, 503, { error: 'too-many-subscribers', limit })
      return
    }

    res.writeHead(200)
    // 繋ぎ直しの間隔を先に伝える。コメント行は `message` には現れない。
    res.write(`retry: ${RETRY_MS}\n\n`)

    const stop = (): void => {
      if (heartbeat !== null) clearInterval(heartbeat)
      subscription.close()
    }

    /**
     * 押し出しが壊れたので畳む。**`stop` と分ける。**
     *
     * 相手が閉じただけの正常な終わり方と同じ扱いにすると、**壊れて切れた購読が
     * `/status` の数のどこにも現れない** —— 見えるのは購読者が 1 つ減ったことだけで、
     * ふつうにタブを閉じたのと区別が付かない。詰まり・書き込み失敗を検知するための
     * 口なのに、まさにそれが起きた回だけ黙ることになる。
     */
    const stopFailed = (detail: string): void => {
      if (heartbeat !== null) clearInterval(heartbeat)
      subscription.closeFailed(detail)
      // **後始末はここで済ませる。** `closeFailed` はハブの一覧から外すだけなので、
      // 以後 `closeAll()` はこの購読を見つけられず `onDetach`（＝`res.end()`）も呼ばれない。
      // 壊れたソケットは既に閉じていることが多いが、**そう限らない** ——
      // 残ると、締めくくりで `server.close()` が返らない形になりうる。
      try {
        res.destroy()
      } catch {
        // 既に壊れている。捨てる以上にできることは無い。
      }
    }

    heartbeat = setInterval(() => {
      // **詰まっていたら送らない。** 本体の配達と同じ契約にする —— 小さいとはいえ、
      // 詰まった相手の待ち行列へ 15 秒ごとに積み増す理由が無い。
      if (res.writableEnded || res.writableNeedDrain) return
      // **投げさせない。** 破棄されたソケットへの書き込みは `res` の `'error'` を
      // 経由せず未捕捉例外まで抜けることがある。ここは間隔タイマーの中なので、
      // 抜ければ**この受け手のプロセスごと落ちる** —— 押し出しの購読 1 つのために
      // UDP の受信も生データの保存も道連れになる。
      try {
        res.write(': ping\n\n')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        log('warn', 'sse', 'heartbeat', `[sse] 生存確認を送れず: ${detail}`)
        stopFailed(detail)
      }
    }, options.heartbeatMs ?? HEARTBEAT_MS)
    // **プロセスの終了を妨げない。** 締めくくりで必ず止めるが、止め損ねた経路が
    // あったときに待ち受けだけで終わらなくなるのは避ける。
    heartbeat.unref?.()
    // 相手が閉じた・壊れた。**どちらでも枠を返す。**
    req.on('close', stop)
    res.on('error', (error: Error) => {
      log('warn', 'sse', error.name, `[sse] 押し出しの書き込みで失敗: ${error.message}`)
      stopFailed(error.message)
    })
  }

  const server: Server = createServer((req, res) => {
    // **投げさせない。** ここで投げると Node が既定でプロセスごと落とす ——
    // 状態を見に来ただけの相手の打ち間違いで、受信そのものが止まる。
    try {
      // `req.url` は経路と問い合わせ文字列だけ。**基点は読まれないので何でもよい。**
      const url = new URL(req.url ?? '/', 'http://localhost')

      // **`/api/*` は GET 以外も受けるので、メソッド制限より前で分岐する。**
      // 下の `/status`・`/stream` はどちらも GET 専用のまま変えていない。
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          handleAdminPreflight(req, res, options.adminAuth.allowedOrigins)
          return
        }
        // **`handleAdmin` は内部で全て捕まえる契約だが、ここでも受け止める。**
        // `createServer` のコールバックは同期関数なので、万一 reject すると
        // `unhandledRejection` としてプロセスの外へ漏れる——`/status` の
        // 応答作成失敗と同じ扱いで押さえる。
        handleAdmin(req, res, url, options.adminAuth, log, options.stationConfig, options.readRestWindows).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          log('error', 'admin', 'handler', `[admin] /api/* の処理に失敗: ${detail}`)
          if (!res.headersSent) {
            try {
              sendAdminJson(res, 500, { error: 'internal' })
              return
            } catch (inner) {
              // **二重目の失敗も記録する。** 黙ると、下の非 admin 経路と同じ理由——
              // 応答を送ることすらできずに切ったことが痕跡として残らない。
              const why = inner instanceof Error ? inner.message : String(inner)
              log('error', 'admin', 'fatal', `[admin] 500 も返せず繋ぎを切った: ${why}`)
            }
          }
          res.destroy()
        })
        return
      }

      if (req.method === 'OPTIONS') {
        handlePreflight(req, res)
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      if (url.pathname === '/status') {
        sendJson(res, 200, options.status())
        return
      }
      // **基板がホストの生存を確かめる口**（ファームの `hostReachable`）。**中身は何も組み立てない**
      // —— 答えられたこと自体が「処理が回っている」の証で、`/status` のように重い答えを作ると
      // 基板が待てる時間（1 秒弱）を食う。TCP が繋がるだけでは、処理の止まったホストと
      // 区別できない（OS が代わりに接続を受け付ける）。
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/stream') {
        const waveParam = url.searchParams.get('wave')
        if (isUnknownWaveParam(waveParam)) {
          // **`detail` は固定の合言葉にする。** 渡された値を鍵にすると、
          // でたらめな値を投げ続けるだけで間引きの枠（`logThrottle` の
          // `maxKeysPerKind`）を埋められる。値のほうは 1 行の本文へ入れる。
          log('warn', 'sse', 'bad-wave-param', `[sse] ?wave= を読めないので波形なしで繋ぐ: ${forLog(waveParam)}`)
        }
        const diff = parseDiffParams(url.searchParams)
        if (diff.problem !== null) {
          // **合言葉へ理由の種別を含める。** `logThrottle` は（種別・合言葉）の組で
          // 鍵を分けて 60 秒間引くので、**固定にすると違う理由の 2 件目が記録に残らない**
          // ——実機で 3 通り（欄が足りない・同じセンサー・書式違い）を続けて叩いたとき、
          // 出たのは 1 件目だけだった。しかも次に出る行は「同じものをほか N 件」と
          // 名乗るので、**理由が違うことまで覆い隠す。**
          //
          // **渡された値は入れない。** `problemKind` は 5 つで有界なので、
          // 相手の決める値で鍵の枠（種別ごと 32 個）を食い潰す形にはならない
          // ——文面（`problem`）は欄の名前を含み 31 通りに分かれるので、鍵にはしない。
          log(
            'warn',
            'sse',
            `bad-diff-param/${diff.problemKind}`,
            `[sse] ?diff= を読めないので差分なしで繋ぐ: ${diff.problem}`,
          )
        }
        handleStream(req, res, parseWaveParam(waveParam), diff.want)
        return
      }
      if (url.pathname === '/waves') {
        // **`/api/*` の下に置いていない。** 宛先は PWA で、あちらは管理トークンを
        // 持たない（持たせるべきでもない）。出るのは `/stream` が既に押し出して
        // いるのと同じ合成波形なので、公開の程度は変わらない —— 違うのは「過去を
        // まとめて取れる」ことだけで、そこは範囲の上限（`WAVE_RANGE_MAX_MS`）で縛る。
        if (options.readWaves === null) {
          // **「0 件」で返さない。** 揺れていなかったのか記録していないのかを、
          // 呼び出し側が見分けられなくなる。
          sendJson(res, 503, { error: 'wave-archive-unavailable' })
          return
        }
        const query = parseWaveQuery(url.searchParams)
        if (!query.ok) {
          sendJson(res, 400, { error: query.error })
          return
        }
        // **いまの設定にあるかを添える**（断りはしない。{@link buildWaveResponse} の説明）。
        const stationKnown = options.stationConfig
          .get()
          .stations.some((s) => s.stationId === query.stationId)
        // **投げさせない。** 読み込みは非同期なので、この `try` の外で失敗する。
        void options
          .readWaves({ stationId: query.stationId, fromMs: query.fromMs, toMs: query.toMs })
          .then((result) => {
            sendJson(res, 200, buildWaveResponse(query, result, stationKnown))
          })
          .catch((error: unknown) => {
            // **`options.log` を直に呼ばない。** このファイルは記録の口を `log()` で
            // 包んであり（「記録する手段そのものが壊れている」場合に握るため）、
            // **ここは `.catch()` の中なので、投げても上の同期の `try` には捕まらない**
            // —— `unhandledRejection` としてプロセスごと落ちる。
            log(
              'error',
              'waves',
              forLog(query.stationId),
              `[waves] 読み返しに失敗: ${error instanceof Error ? error.message : String(error)}`,
            )
            // **既に書き始めていたら何もしない**（二重に書くと壊れる）。
            if (!res.headersSent) sendJson(res, 500, { error: 'wave-read-failed' })
          })
        return
      }
      if (url.pathname === '/events') {
        // **`/waves` と同じく `/api/*` の外に置く**（宛先は PWA。出るのは押し出しの
        // `shake-event` と同じ記録で、違うのは過去をまとめて取れることだけ）。
        if (options.readEvents === null) {
          sendJson(res, 503, { error: 'event-store-unavailable' })
          return
        }
        const query = parseEventQuery(url.searchParams)
        if (!query.ok) {
          sendJson(res, 400, { error: query.error })
          return
        }
        // **投げさせない。** 読み込みは非同期なので、上の同期の `try` には捕まらない
        // （`/waves` と同じ理由で `log()` を通す）。
        void options
          .readEvents({ fromMs: query.fromMs, toMs: query.toMs })
          .then((result) => {
            sendJson(res, 200, buildEventResponse(query, result))
          })
          .catch((error: unknown) => {
            log('error', 'events', 'read', `[events] 読み返しに失敗: ${error instanceof Error ? error.message : String(error)}`)
            if (!res.headersSent) sendJson(res, 500, { error: 'event-read-failed' })
          })
        return
      }
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        if (options.adminConsole === null) {
          sendJson(res, 503, { error: 'admin-console-unavailable' })
          return
        }
        sendHtml(res, 200, options.adminConsole.html)
        return
      }
      if (url.pathname === '/admin/app.js') {
        if (options.adminConsole === null) {
          sendJson(res, 503, { error: 'admin-console-unavailable' })
          return
        }
        sendJs(res, 200, options.adminConsole.js)
        return
      }
      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log('error', 'http', 'handler', `[http] 応答を作れず: ${detail}`)
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { error: 'internal' })
          return
        } catch (inner) {
          // **二重目の失敗も記録する。** 黙ると運用者のログには「応答を作れず」の
          // 1 行しか残らず、**応答を送ることすらできずに切ったこと**が痕跡として
          // 残らない（向こうからは「接続がリセットされた」としか見えない）。
          const why = inner instanceof Error ? inner.message : String(inner)
          log('error', 'http', 'fatal', `[http] 500 も返せず繋ぎを切った: ${why}`)
        }
      }
      res.destroy()
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.address, () => {
      const addr = server.address()
      server.removeListener('error', reject)
      resolve(typeof addr === 'object' && addr !== null ? addr.port : options.port)
    })
  })

  return {
    port,
    close: async () => {
      // **押し出しを先に切る。** 開いたままだと `server.close()` は
      // 「まだ応答の途中」とみなして永久に返らない。
      hub.closeAll()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 状態を見たあと黙って繋ぎっぱなしのソケットも手放す。
        server.closeIdleConnections()
      })
    },
  }
}
