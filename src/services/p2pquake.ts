import type {
  AppEvent, JMAQuake, JMATsunami, EEWAlert, EEWRegion,
  EarthquakePoint, Hypocenter, IntensityScale,
  IssueType, CorrectType, DomesticTsunami, TsunamiArea, TsunamiGrade, TelegramLogEntry,
} from '../types/earthquake'
import { serverNow, serverDate } from '../utils/clock'
import { quakeIdentityKey } from '../utils/quakeHeatmap'
import { isValidIntensityScale } from '../utils/intensity'
import { log } from '../utils/logger'
// 数値は parseHelpers の parseNum ではなくローカルの readNumber を使う（理由は readNumber の注記）
import { arr, obj, str } from './parseHelpers'

const API_BASE = 'https://api.p2pquake.net/v2'
const WS_URL = 'wss://api.p2pquake.net/v2/ws'

// P2PQuake API はイベント種別を数値 code で返すため、内部の kind 識別子に変換する
type RawP2PEvent = { code: number; [key: string]: unknown }

function codeToLogKind(code: number): TelegramLogEntry['kind'] {
  if (code === 551) return 'quake'
  if (code === 552) return 'tsunami'
  if (code === 556) return 'eew'
  return undefined
}

const CORRECT_TYPE_MAP: Record<string, CorrectType> = {
  None: 'なし', Unknown: '訂正', ScaleOnly: '震度のみ訂正',
  DestinationOnly: '震源を訂正', ScaleAndDestination: '震度・震源を訂正',
}

const DOMESTIC_TSUNAMI_MAP: Record<string, DomesticTsunami> = {
  None: 'なし', Unknown: '不明', Checking: '調査中',
  // SeaFloor は DomesticTsunami 型に含まれる正規値だが、P2PQuake API v2 の実運用で
  // この enum が返る実例は確認できていない（実データ検証で 0 件）。型網羅性維持と、
  // 将来の API 変更時に未変換のまま流さないためエントリは残す。
  SeaFloor: '海面変動の可能性', NonEffective: '若干の海面変動',
  Watch: '注意報', Warning: '警報等',
  // QUAKE-5: 大津波警報。欠落していると DOMESTIC_TSUNAMI_MAP[raw]=undefined → '不明' 灰色格下げに
  MajorWarning: '警報等',
}

const ISSUE_TYPE_MAP: Record<string, IssueType> = {
  ScalePrompt: '震度速報',
  Destination: '震源情報',
  ScaleAndDestination: '震源・震度情報',
  DetailScale: '各地の震度情報',
  DestinationAmended: '顕著な地震の震源要素更新のお知らせ',
  Foreign: '遠地地震',
  Other: 'その他',
}

const TSUNAMI_GRADES: readonly TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch', 'Forecast', 'Unknown']

// 震源が未確定のときのセンチネル。いずれも P2PQuake API 自身が「不明」に使う値なので、
// 正常データをそのまま通すだけで内部表現と一致する。
// 座標・深さは DMDATA 経路（dmdataParser.ts）とも同じ値。規模だけは一致しない
// （DMDATA 経路は parseNum 由来の NaN）。どちらも hasMagnitude() が「不明」として弾くため
// 表示・読み上げの結果は揃う。地図・カードは lat/lng > -200 で「位置あり」を判定する。
const COORD_UNKNOWN = -200
const DEPTH_UNKNOWN = -1
const MAGNITUDE_UNKNOWN = -1

// P2PQuake API v2 が正規値として返すが、内部の IntensityScale には無い震度値。
// いずれも仕様どおりの値なので警告は出さず、意味の最も近い値へ寄せる。
//   46: 「震度5弱以上と推定されるが震度情報を入手していない」→ 下限の 5 弱として扱う。
//       -1（不明・灰色）に落とすと「5弱以上」という最も重要な情報が画面から消える。
//   0 : 「震度0」→ IntensityScale に無いので「不明」(-1) に寄せる。eewMaxScale() は -1 を
//       有効値として Math.max に通すが、初期値 0 を下回るため最大値には反映されない。
//       つまり 0 のままでも -1 でも判定結果は変わらない。
const P2P_SCALE_ALIASES: Record<number, IntensityScale> = { 46: 45, 0: -1 }

// scaleTo の「〜程度以上」コード。scaleFrom とセットで初めて意味を成す（例: scaleFrom=70 なら「震度7程度以上」）。
const P2P_SCALE_TO_OR_ABOVE = 99

// 1 電文の中で同じ理由の警告が要素数だけ出るとコンソールが埋まり、本当に見るべき警告が沈む
// （551「各地の震度情報」の points は数百件になりうる）。同じフィールドについては先頭数件だけ
// 内容を出し、残りは電文の最後に件数だけまとめる。解析は同期処理なので、電文ごとにリセットする
// モジュールスコープの集計で足りる。
const WARN_DETAIL_LIMIT = 3
let warnCounts: Map<string, number> | null = null

/** 警告を 1 件記録する。同じ field の 4 件目以降は内容を出さず件数だけ数える。 */
function countWarn(field: string): boolean {
  if (!warnCounts) return true
  const n = (warnCounts.get(field) ?? 0) + 1
  warnCounts.set(field, n)
  return n <= WARN_DETAIL_LIMIT
}

function warnField(context: string, field: string, value: unknown): void {
  if (countWarn(field)) {
    log.warn(`[p2pquake] ${context}: ${field} が想定外の値のため既定値に落としました`, { value })
  }
}

/** API 仕様上は必須なのに欠落しているフィールド。既定値で通すが、黙って通さない。 */
function warnMissing(context: string, field: string): void {
  if (countWarn(field)) {
    log.warn(`[p2pquake] ${context}: 必須フィールド ${field} が欠落しています`)
  }
}

/** 抑制した警告の件数をまとめて出す。電文 1 通の解析が終わるたびに呼ぶ。 */
function flushWarnCounts(context: string): void {
  if (!warnCounts) return
  for (const [field, n] of warnCounts) {
    if (n > WARN_DETAIL_LIMIT) {
      log.warn(`[p2pquake] ${context}: ${field} の警告は計 ${n} 件（内容は先頭 ${WARN_DETAIL_LIMIT} 件のみ出力）`)
    }
  }
  warnCounts = null
}

/**
 * 数値フィールドを読む。`parseNum()`（＝`Number()`）は空文字・真偽値・空配列を 0 に変換してしまい、
 * 壊れた値が「有効な 0」として無警告で通る（緯度 `''` → 0 = ギニア湾沖）。
 * 数値そのものか、数値として読める非空文字列だけを受け付ける。
 */
function readNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return NaN
}

/**
 * 時刻フィールドを読む。空・欠落なら `null`（＝呼び出し側で電文ごと破棄）、
 * 値はあるが `Date` として解釈できない場合は警告だけ出してその文字列を返す。
 *
 * 空を破棄するのは、空文字が下流で `new Date('')` = Invalid Date になり、
 * `useEarthquakes` の `?? serverNow()`（`??` は null/undefined しか救わない）をすり抜けるため。
 * キューのディスパッチャは先頭ブロッキング（`q[0].eventTime <= now`）で、NaN 比較は常に偽に
 * なるため、Invalid Date が 1 件混ざると以降のライブイベントが二度と発火しない。
 *
 * 一方「値はあるが読めない」を破棄しないのは、P2PQuake の時刻が `2026/01/02 15:04:05.999` という
 * スラッシュ区切りの非 ISO 形式で、`Date` のパース可否がブラウザ実装に依存するため。
 * 厳格な実装に当たったときに全電文を捨てるより、時刻表示が崩れても地震を出す方が実害が小さい。
 * キュー停止そのものは `enqueueEvent` 側の `Number.isFinite` ガードで別途塞いである。
 */
function readTime(v: unknown, context: string, field: string): string | null {
  const time = str(v)
  if (!time) {
    warnMissing(context, field)
    return null
  }
  if (!Number.isFinite(new Date(time).getTime())) warnField(context, field, v)
  return time
}

/**
 * P2PQuake の数値震度を IntensityScale へ正規化する。
 * フィールド自体が無いのは正常（震源情報に最大震度は無い等）なので警告しない。
 * 値が入っているのに階級として解釈できない場合だけ警告して「不明」(-1) に落とす。
 */
function toIntensityScale(v: unknown, context: string, field: string, required = false): IntensityScale {
  if (v === undefined || v === null) {
    if (required) warnMissing(context, field)
    return -1
  }
  // 仕様上「システムの都合で小数点が付きますが整数部のみ有効」なので切り捨てて比較する
  const n = Math.trunc(readNumber(v))
  const alias = P2P_SCALE_ALIASES[n]
  if (alias !== undefined) return alias
  if (isValidIntensityScale(n)) return n
  warnField(context, field, v)
  return -1
}

/** 数値フィールドを読む。欠落は正常（センチネルへ）、値があるのに数値でない場合だけ警告する。 */
function toNumberOrSentinel(v: unknown, sentinel: number, context: string, field: string): number {
  if (v === undefined || v === null) return sentinel
  const n = readNumber(v)
  if (Number.isFinite(n)) return n
  warnField(context, field, v)
  return sentinel
}

/** API 仕様上は必須の文字列フィールド。欠落しても既定値（空文字）で通すが、警告は残す。 */
function requiredStr(v: unknown, context: string, field: string): string {
  const s = str(v)
  if (!s) warnMissing(context, field)
  return s
}

/** API 仕様上は必須の真偽値フィールド。欠落は false に倒す（警報を勝手に消さない安全側）。 */
function requiredBool(v: unknown, context: string, field: string): boolean {
  if (typeof v !== 'boolean') warnMissing(context, field)
  return v === true
}

/** 震源要素。震度速報のように震源が未確定の電文では hypocenter ごと欠落するのが正常。 */
function parseHypocenter(v: unknown, context: string): Hypocenter {
  const h = obj(v)
  return {
    name: str(h.name),
    latitude: toNumberOrSentinel(h.latitude, COORD_UNKNOWN, context, 'hypocenter.latitude'),
    longitude: toNumberOrSentinel(h.longitude, COORD_UNKNOWN, context, 'hypocenter.longitude'),
    depth: toNumberOrSentinel(h.depth, DEPTH_UNKNOWN, context, 'hypocenter.depth'),
    magnitude: toNumberOrSentinel(h.magnitude, MAGNITUDE_UNKNOWN, context, 'hypocenter.magnitude'),
  }
}

/** 各地の震度。1 観測点が壊れていても地震全体は捨てず、その要素だけ落とす。 */
function parseQuakePoints(v: unknown, context: string): EarthquakePoint[] {
  const points: EarthquakePoint[] = []
  for (const raw of arr(v)) {
    const p = obj(raw)
    const addr = str(p.addr)
    // addr は観測点・地域そのものの識別子。空だと一覧にも地図にも出せない。
    // pref は空が正常なケースがある（識別規則は docs/spec/quake-spec.md §4）ため必須にしない。
    if (!addr) {
      warnField(context, 'points[].addr', raw)
      continue
    }
    points.push({
      pref: str(p.pref),
      addr,
      isArea: p.isArea === true,
      // scale は points[] の必須フィールド（maxScale と違い「無いのが正常」ではない）
      scale: toIntensityScale(p.scale, context, 'points[].scale', true),
    })
  }
  return points
}

function parseQuake(raw: Record<string, unknown>): JMAQuake | null {
  const id = str(raw.id)
  // id と発生時刻は同一性キー（quakeIdentityKey）の材料。どちらかが欠けると別々の地震が
  // 同じキーに潰れ、統合・選択・通知がまとめて狂う。ここだけは電文ごと捨てる。
  // API 仕様上いずれも必須フィールドなので、欠けていれば本当に壊れた電文。
  if (!id) {
    log.warn('[p2pquake] 551: id が無いため電文を破棄', { time: raw.time })
    return null
  }
  const context = `551 id=${id}`
  const earthquake = obj(raw.earthquake)
  const time = readTime(raw.time, context, 'time')
  // earthquake.time は同一性キーに加えてカードの表示時刻・一覧のソートキーにもなる
  const originTime = readTime(earthquake.time, context, 'earthquake.time')
  if (time === null || originTime === null) return null

  const issue = obj(raw.issue)
  const rawIssueType = str(issue.type)
  const issueType = ISSUE_TYPE_MAP[rawIssueType]
  if (rawIssueType && !issueType) warnField(context, 'issue.type', rawIssueType)
  const rawCorrect = str(issue.correct)
  const correct = CORRECT_TYPE_MAP[rawCorrect]
  if (rawCorrect && !correct) warnField(context, 'issue.correct', rawCorrect)

  const rawTsunami = str(earthquake.domesticTsunami)
  const domesticTsunami = DOMESTIC_TSUNAMI_MAP[rawTsunami]
  if (rawTsunami && !domesticTsunami) warnField(context, 'earthquake.domesticTsunami', rawTsunami)

  return {
    kind: 'quake',
    id,
    time,
    issue: {
      source: str(issue.source),
      time: requiredStr(issue.time, context, 'issue.time'),
      // 未知の種別は 'その他' へ格下げする。落とすと種別を持たない電文になり、
      // 統合時の優先度判定（quakeMerge）が働かなくなる。
      type: issueType ?? 'その他',
      correct: correct ?? 'なし',
    },
    earthquake: {
      time: originTime,
      hypocenter: parseHypocenter(earthquake.hypocenter, context),
      maxScale: toIntensityScale(earthquake.maxScale, context, 'earthquake.maxScale'),
      domesticTsunami: domesticTsunami ?? '不明',
    },
    points: parseQuakePoints(raw.points, context),
  }
}

function parseTsunamiAreas(v: unknown, context: string): TsunamiArea[] {
  const areas: TsunamiArea[] = []
  for (const raw of arr(v)) {
    const a = obj(raw)
    const name = str(a.name)
    // 予報区名は海岸線データ（tsunami-zones.json）との突き合わせキー。無い区域は描画も一覧もできない。
    if (!name) {
      warnField(context, 'areas[].name', raw)
      continue
    }
    const rawGrade = str(a.grade)
    const isKnownGrade = (TSUNAMI_GRADES as readonly string[]).includes(rawGrade)
    if (rawGrade && !isKnownGrade) warnField(context, 'areas[].grade', rawGrade)

    const firstHeight = obj(a.firstHeight)
    const arrivalTime = str(firstHeight.arrivalTime)
    const condition = str(firstHeight.condition)
    const maxHeight = obj(a.maxHeight)
    const description = str(maxHeight.description)
    // 「巨大」「高い」には数値表現が付かない（API 仕様どおり）。description だけで区域行を描けるよう、
    // 数値が無くても maxHeight を落とさない。
    const heightValue = readNumber(maxHeight.value)

    areas.push({
      grade: isKnownGrade ? rawGrade as TsunamiGrade : 'Unknown',
      immediate: a.immediate === true,
      name,
      firstHeight: (arrivalTime || condition) ? { arrivalTime: arrivalTime || undefined, condition } : undefined,
      maxHeight: description
        ? { description, value: Number.isFinite(heightValue) ? heightValue : undefined }
        : undefined,
    })
  }
  return areas
}

function parseTsunami(raw: Record<string, unknown>): JMATsunami | null {
  const id = str(raw.id)
  if (!id) {
    log.warn('[p2pquake] 552: id が無いため電文を破棄', { time: raw.time })
    return null
  }
  const context = `552 id=${id}`
  const time = readTime(raw.time, context, 'time')
  if (time === null) return null

  const issue = obj(raw.issue)
  // 内部型は 'Focus' 固定。API 仕様も現状 Focus のみだが、増えたときに黙って嘘を書かないよう警告する。
  const issueType = requiredStr(issue.type, context, 'issue.type')
  if (issueType && issueType !== 'Focus') warnField(context, 'issue.type', issueType)

  return {
    kind: 'tsunami',
    id,
    time,
    // 解除電文は cancelled=true・areas は空配列で届く。
    // 解除理由（cancelReason）は DMDSS 経路でしか判別できないため standard 版では付けない。
    cancelled: requiredBool(raw.cancelled, context, 'cancelled'),
    issue: {
      source: requiredStr(issue.source, context, 'issue.source'),
      time: requiredStr(issue.time, context, 'issue.time'),
      type: 'Focus',
    },
    areas: parseTsunamiAreas(raw.areas, context),
  }
}

function parseEEWRegions(v: unknown, context: string): EEWRegion[] {
  const regions: EEWRegion[] = []
  for (const raw of arr(v)) {
    const r = obj(raw)
    const name = str(r.name)
    // 地域名は station-coords との突き合わせキー。無いと地図にも一覧にも出せない。
    if (!name) {
      warnField(context, 'areas[].name', raw)
      continue
    }
    const scaleFrom = toIntensityScale(r.scaleFrom, context, 'areas[].scaleFrom')
    // scaleTo=99 は「scaleFrom 程度以上」を表す。そのまま通すと IntensityScale に無い値になり、
    // eewMaxScale() の実行時ガードがこの地域を丸ごと無視する。最強クラス（scaleFrom=70 の
    // 「震度7程度以上」）が特別警報に上がらなくなるため、下限の scaleFrom を上限として採用する。
    const isOrAbove = Math.trunc(readNumber(r.scaleTo)) === P2P_SCALE_TO_OR_ABOVE
    regions.push({
      pref: str(r.pref),
      name,
      scaleFrom,
      scaleTo: isOrAbove ? scaleFrom : toIntensityScale(r.scaleTo, context, 'areas[].scaleTo'),
      kindCode: str(r.kindCode),
      // 内部型は「到達予想なし」を null で表す（undefined ではない）
      arrivalTime: str(r.arrivalTime) || null,
      // 長周期地震動階級は P2PQuake が配信しないため常に undefined（DMDATA 経路のみ取得できる）
    })
  }
  return regions
}

function parseEEW(raw: Record<string, unknown>): EEWAlert | null {
  const id = str(raw.id)
  if (!id) {
    log.warn('[p2pquake] 556: id が無いため電文を破棄', { time: raw.time })
    return null
  }
  const context = `556 id=${id}`
  const time = readTime(raw.time, context, 'time')
  if (time === null) return null

  const issue = obj(raw.issue)
  const areas = parseEEWRegions(raw.areas, context)
  // 取消電文は earthquake ごと欠落しうる（API 仕様上 earthquake 自体は optional）。
  // 一方 earthquake がある場合の originTime / arrivalTime / hypocenter は必須。
  const hasEarthquake = raw.earthquake !== undefined && raw.earthquake !== null
  const earthquake = obj(raw.earthquake)
  if (hasEarthquake && earthquake.hypocenter == null) warnMissing(context, 'earthquake.hypocenter')

  return {
    kind: 'eew',
    id,
    time,
    test: raw.test === true,
    earthquake: {
      // originTime は予報円（usePsWaveCalc の computeEewCircle）の起点。読めないと円が
      // 半径 0 のまま描画され続けるため、欠落は必ず警告する。
      originTime: hasEarthquake ? requiredStr(earthquake.originTime, context, 'earthquake.originTime') : '',
      arrivalTime: hasEarthquake ? requiredStr(earthquake.arrivalTime, context, 'earthquake.arrivalTime') : '',
      // '仮定震源要素'（単独観測点処理）の判別に使う。eewMaxScale/eewMaxLpgmClass が参照する。
      condition: str(earthquake.condition),
      hypocenter: parseHypocenter(earthquake.hypocenter, context),
    },
    // P2PQuake API v2 の code=556 は気象庁 EEW 警報（VXSE43/45 相当）の二次配信のみで、
    // ペイロードに severity 相当フィールドが含まれない。JMA の仕様上ここで配信される
    // ものは全て警報級であり、Warning を明示付与しないと後段の computeSingleEEWLevel が
    // 常に Forecast 扱い（レベル0）に格下げして警報音・特別警報表示が発火しなくなる。
    severity: 'Warning',
    cancelled: requiredBool(raw.cancelled, context, 'cancelled'),
    // eventId は EEW の同一性キー（`issue?.eventId ?? id` の形で続報統合・解除追跡に使う）。
    // 欠落すると報ごとに変わる id へフォールバックし、続報が別イベント扱いになって黙って壊れる。
    issue: {
      eventId: requiredStr(issue.eventId, context, 'issue.eventId') || undefined,
      serial: requiredStr(issue.serial, context, 'issue.serial') || undefined,
      time: requiredStr(issue.time, context, 'issue.time') || undefined,
    },
    // 地域が 1 件も無いとき（取消電文など）は undefined にする。空配列を入れると
    // useEarthquakes の enrichEEW（`source.areas ?? existing.areas`）が既存の地域別予想を
    // 空で上書きしてしまい、地図の区域塗りが消える。
    areas: areas.length > 0 ? areas : undefined,
  }
}

export function convertEvent(raw: RawP2PEvent): AppEvent | null {
  // 引数は `as RawP2PEvent` で通ってくる（WebSocket の JSON.parse・REST のレスポンス）ため
  // 型注釈を信用しない。配列や null が来ても落ちないように obj() で受け直す。
  const data = obj(raw)
  const code = readNumber(data.code)
  if (!isSupportedCode(code)) return null
  warnCounts = new Map()
  try {
    if (code === 551) return parseQuake(data)
    if (code === 552) return parseTsunami(data)
    return parseEEW(data)
  } finally {
    flushWarnCounts(`${code} id=${str(data.id)}`)
  }
}

/** 内部型へ変換できる電文種別か。未対応 code は障害ではなく設計どおりの読み飛ばし。 */
export function isSupportedCode(code: unknown): boolean {
  return code === 551 || code === 552 || code === 556
}

export async function fetchHistory(
  codes: number[] = [551, 552, 556],
  limit = 20,
  offset = 0,
): Promise<AppEvent[]> {
  const params = new URLSearchParams()
  codes.forEach(c => params.append('codes', String(c)))
  params.set('limit', String(limit))
  if (offset > 0) params.set('offset', String(offset))
  const res = await fetch(`${API_BASE}/history?${params.toString()}`)
  if (!res.ok) throw new Error(`P2PQuake API error: ${res.status}`)
  const raws = await res.json() as RawP2PEvent[]
  return raws.flatMap(r => { const e = convertEvent(r); return e ? [e] : [] })
}

// /v2/history より大幅に深い履歴（2015年〜）を持つ地震情報専用エンドポイント
export async function fetchJmaQuake(limit = 50, offset = 0): Promise<JMAQuake[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (offset > 0) params.set('offset', String(offset))
  const res = await fetch(`${API_BASE}/jma/quake?${params.toString()}`)
  if (!res.ok) throw new Error(`P2PQuake jma/quake error: ${res.status}`)
  const raws = await res.json() as RawP2PEvent[]
  return raws.flatMap(r => { const e = convertEvent(r); return e && e.kind === 'quake' ? [e] : [] })
}

// jma/quake のレート制限は 10リクエスト/分（IPごと）。ヒートマップ用の遡り取得では
// リクエスト間隔を空けて上限に触れないようにする。
const JMA_QUAKE_HISTORY_REQUEST_INTERVAL_MS = 6500
const JMA_QUAKE_HISTORY_MAX_PAGES = 20

// ヒートマップ用: 直近 `days` 日分の地震履歴を offset ページングでまとめて取得する。
export async function fetchJmaQuakeHistory(days: number): Promise<JMAQuake[]> {
  const cutoffMs = serverNow() - days * 24 * 60 * 60 * 1000
  const collected: JMAQuake[] = []
  let offset = 0
  for (let page = 0; page < JMA_QUAKE_HISTORY_MAX_PAGES; page++) {
    const batch = await fetchJmaQuake(100, offset)
    if (batch.length === 0) break
    collected.push(...batch)
    const oldestTime = new Date(batch[batch.length - 1].earthquake.time).getTime()
    if (oldestTime < cutoffMs || batch.length < 100) break
    offset += batch.length
    await new Promise(resolve => setTimeout(resolve, JMA_QUAKE_HISTORY_REQUEST_INTERVAL_MS))
  }
  // 同一地震でも「震度速報→震源情報→震源・震度情報→各地の震度情報」と複数の issue が
  // 別レコードとして history に載るため重複排除する（id は issue ごとに異なりキーにならない）。
  // ヒートマップ側と同じ quakeIdentityKey を使う。発生時刻だけをキーにすると、
  // 同じ分に起きた別の地震が 1 件に潰れる。
  const seenKeys = new Set<string>()
  const deduped = collected.filter(q => {
    const key = quakeIdentityKey(q)
    if (seenKeys.has(key)) return false
    seenKeys.add(key)
    return true
  })
  return deduped.filter(q => new Date(q.earthquake.time).getTime() >= cutoffMs)
}

export class P2PQuakeWebSocket {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 3000
  private shouldReconnect = false

  onEvent: ((event: AppEvent) => void) | null = null
  onStatusChange: ((status: 'connecting' | 'connected' | 'disconnected') => void) | null = null
  onRawMessage: ((entry: TelegramLogEntry) => void) | null = null

  connect() {
    this.shouldReconnect = true
    this.createConnection()
  }

  private createConnection() {
    this.onStatusChange?.('connecting')
    this.ws = new WebSocket(WS_URL)

    this.ws.onopen = () => {
      this.reconnectDelay = 3000
      this.onStatusChange?.('connected')
    }

    this.ws.onmessage = (event) => {
      let raw: RawP2PEvent
      try {
        raw = JSON.parse(event.data as string) as RawP2PEvent
      } catch {
        // JSON として読めないメッセージは記録する術も無いので捨てる（電文ログにも残せない）
        return
      }
      // 変換とアプリ側の状態更新は JSON.parse と分けて捕捉する。まとめて握り潰すと
      // バリデーションや後段の state 更新で投げた例外が無言で消える。
      try {
        const appEvent = convertEvent(raw)
        // 未対応 code の読み飛ばし（設計どおり）と、必須フィールド欠落による破棄（障害）を
        // 電文ログ上で区別する。DMDSS 経路（dmdata.ts の makeLogEntry）と同じ粒度に揃える。
        const isBroken = !appEvent && isSupportedCode(raw?.code)
        this.onRawMessage?.({
          id: `${Date.now()}-${Math.random()}`,
          receivedAt: serverDate(),
          source: 'p2pquake',
          headType: String(raw?.code),
          isTest: false,
          status: appEvent ? 'parsed' : isBroken ? 'error' : 'filtered',
          errorMessage: isBroken ? '必須フィールドの欠落・不正値によりバリデーションで破棄' : undefined,
          kind: codeToLogKind(raw?.code),
          rawBody: raw,
        })
        if (appEvent) this.onEvent?.(appEvent)
      } catch (e) {
        log.error('[p2pquake] 受信メッセージの処理に失敗', e)
      }
    }

    this.ws.onclose = () => {
      this.onStatusChange?.('disconnected')
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000)
          this.createConnection()
        }, this.reconnectDelay)
      }
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect() {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      // close() 前に全ハンドラを外す。onclose に再接続ロジックがあるため、
      // 参照を残したまま close() すると shouldReconnect=false でも onStatusChange('disconnected')
      // が呼ばれ、後続の GC タイミングでゾンビイベントが発火する可能性がある。
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
  }
}
