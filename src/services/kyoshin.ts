// Yahoo 強震モニタ（リアルタイム震度）のデータ取得。
// 観測点リストとリアルタイム震度を HTTPS の JSON で取得する。
//
// 参考: https://note.com/looksky758/n/ne9115f77d27a
//   - 観測点: https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList/sitelist.json
//   - 震度  : https://weather-kyoshin.{west|east}.edge.storage-yahoo.jp/RealTimeData/yyyyMMdd/yyyyMMddHHmmss.json
//   - intensity 文字列は各文字の charCode - 100 が観測点ごとの震度インデックス(0〜20)。
//   - 負の値（実測は -1）は欠測（観測点データなし）を示す特殊値であり計測震度ではない。
//     Yahoo公式サイト自身も CSS で `.kyoshin_si--1{display:none}` として非表示にしている
//     （2026-07-29 実データ・公式サイトのCSS調査で確認。全観測点の約3%が該当）。

import type { EEWAlert, IntensityScale } from '../types/earthquake'
import { feedServerSample, serverNow } from '../utils/clock'
import { log } from '../utils/logger'

/** 観測点座標の配列（[緯度, 経度]）。インデックスが intensity 文字列の位置に対応。 */
export type SiteCoords = [number, number][]

/** index がこの値未満なら欠測（観測点データなし）。計測震度としては扱えない。 */
export const MISSING_INDEX_THRESHOLD = 0

const SITELIST_BASE =
  'https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList'
const REALTIME_BASE = (edge: 'west' | 'east') =>
  `https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData`

// siteConfigId ごとにキャッシュ（同一設定版を何度も fetch しない）
const siteListCache = new Map<string, Promise<SiteCoords>>()

/**
 * 観測点リストを取得する。
 * siteConfigId を指定するとその版の sitelist_{id}.json を取得する。
 * 省略時は現在の sitelist.json を取得する。
 * 同一 siteConfigId は Promise をキャッシュして重複 fetch を防ぐ。
 */
export function fetchSiteList(siteConfigId?: string): Promise<SiteCoords> {
  const cacheKey = siteConfigId ?? ''
  const cached = siteListCache.get(cacheKey)
  if (cached) return cached

  const url = siteConfigId
    ? `${SITELIST_BASE}/sitelist_${siteConfigId}.json`
    : `${SITELIST_BASE}/sitelist.json`

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`sitelist fetch failed: ${res.status}`)
      return res.json() as Promise<{ items: SiteCoords }>
    })
    .then((json) => json.items)
    .catch((err) => {
      // 失敗した Promise をキャッシュに残さない。残すと同一 siteConfigId への
      // 再試行が全て過去の失敗 Promise を返してしまい、siteConfigId 切替直後の
      // 一時的な失敗で検知エンジンが恒久停止する（sites が旧 ID のまま更新されず、
      // indices と長さ不整合になった時点で kyoshinDetector.step() が TypeError で
      // 恒久停止しうる）。エラーは呼び出し元へ再スローする。
      siteListCache.delete(cacheKey)
      throw err
    })

  siteListCache.set(cacheKey, promise)
  return promise
}

/** 日時を JST(UTC+9)の {yyyyMMdd, yyyyMMddHHmmss} 文字列に変換する。 */
function jstParts(date: Date): { dateStr: string; ts: string } {
  const format = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
  }
  const p = format(date)
  // LOW-B3: 一部のブラウザ実装（旧 IE 系・古い V8）は 0 時ちょうどを "24" として返す。
  // その場合は日付だけ翌日に繰り上げ、hour は '00' に、minute/second は元の値のまま使う
  // （現行の主要ブラウザ・Node ではこの分岐に到達しないが防御的コード）。
  if (p.hour === '24') {
    const shifted = format(new Date(date.getTime() + 60 * 60 * 1000))
    const dateStrShifted = `${shifted.year}${shifted.month}${shifted.day}`
    return { dateStr: dateStrShifted, ts: `${dateStrShifted}00${p.minute}${p.second}` }
  }
  const dateStr = `${p.year}${p.month}${p.day}`
  return { dateStr, ts: `${dateStr}${p.hour}${p.minute}${p.second}` }
}

/** 緊急地震速報の予報円（P波/S波）。半径は km。震源深度・マグニチュードから自前計算する（標準版・DMDSS版共通）。 */
export interface PsWaveCircle {
  /** どの EEW の円かを識別する（eew.issue?.eventId ?? eew.id）。カメラフィットで単体を特定するために使う。 */
  eventId: string
  lat: number
  lng: number
  pRadius: number
  sRadius: number
  /** 震源深度 [km]。 */
  depth: number
  /** マグニチュード。続報で更新される。 */
  magnitude: number
}

/** Yahoo hypoInfo の EEW 情報（1件）。フィールドはすべて文字列。 */
export interface YahooHypoInfoItem {
  reportId: string
  reportNum: string
  reportTime: string
  originTime: string
  regionCode?: string
  regionName: string
  latitude: string
  longitude: string
  depth: string
  magnitude: string
  calcintensity: string
  isFinal: string
  isCancel: string
  isTraining: string
}

export interface RealtimeIntensity {
  dataTime: string
  /** このデータに対応する観測点リストのバージョン識別子。 */
  siteConfigId: string
  /** 観測点ごとの震度インデックス(0〜20)。sitelist と同順。負の値は欠測（MISSING_INDEX_THRESHOLD 参照）。 */
  indices: number[]
  /** EEW 情報（発報中のみ要素を持つ）。 */
  hypoInfo: YahooHypoInfoItem[]
}

/** "35.5N" / "139.5E" 形式の座標文字列を数値に変換する。 */
function parseCoord(value: string | undefined): number {
  if (!value) return NaN
  return parseFloat(value.replace(/[NESW]/i, ''))
}

/** "60km" などの深さ文字列を km 数値に変換する。不明な場合は -1。 */
function parseDepth(value: string | undefined): number {
  if (!value) return -1
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : -1
}

/**
 * Yahoo の calcintensity コードを IntensityScale に変換する。
 * フォーマット: "01"→10, "02"→20, "03"→30, "04"→40,
 *              "5-"→45, "5+"→50, "6-"→55, "6+"→60, "07"→70
 * 未知コードは -1 を返し、`log.warn` で通知する（KYO-2: silent 格下げ防止）。
 * 呼び出し側の hypoInfoItemToEEW は scale===-1 のとき severity=Forecast に落とす分岐を
 * 持つため、Yahoo が仕様外コードを送ってきた場合に警報が silent に予報へ格下げされる。
 * 空文字・null/undefined（震度未確定の想定内）は抑制対象で無警告。
 */
function calcintensityToScale(s: string): IntensityScale {
  const map: Record<string, IntensityScale> = {
    '01': 10, '02': 20, '03': 30, '04': 40,
    '5-': 45, '5+': 50, '6-': 55, '6+': 60, '07': 70,
  }
  const scale = map[s]
  if (scale === undefined) {
    // 空文字・null/undefined 相当は震度未確定として想定内（発報直後の EEW で頻出）。
    // それ以外の値はマップ外＝仕様変更/不整合の可能性。1Hz ポーリングで頻発しうるため
    // log.warn（error はより重要なイベント用に温存）で残す。
    if (s !== '' && s != null) log.warn(`[kyoshin] 未知の calcintensity コード: "${s}" → -1 フォールバック`)
    return -1
  }
  return scale
}

/** Yahoo hypoInfo の1件を EEWAlert に変換する。 */
export function hypoInfoItemToEEW(item: YahooHypoInfoItem): EEWAlert {
  const scale = calcintensityToScale(item.calcintensity)
  const scaleNum = scale === -1 ? 0 : scale
  return {
    kind: 'eew',
    id: `yahoo-eew-${item.reportId}`,
    time: item.reportTime,
    test: item.isTraining === 'true',
    earthquake: {
      originTime: item.originTime,
      arrivalTime: '',
      condition: '以上',
      hypocenter: {
        name: item.regionName,
        latitude: parseCoord(item.latitude),
        longitude: parseCoord(item.longitude),
        depth: parseDepth(item.depth),
        magnitude: parseFloat(item.magnitude) || 0,
      },
    },
    severity: scaleNum >= 45 ? 'Warning' : 'Forecast',
    forecastMaxScale: scale >= 0 ? scale : undefined,
    cancelled: item.isCancel === 'true',
    isFinal: item.isFinal === 'true',
    issue: {
      eventId: item.reportId,
      serial: item.reportNum,
      time: item.reportTime,
    },
    areas: [],
  }
}

/**
 * 指定時刻のリアルタイム震度を取得する。
 * west エッジが失敗したら east エッジにフォールバックする。
 */
export async function fetchRealtimeIntensity(now: Date): Promise<RealtimeIntensity> {
  const { dateStr, ts } = jstParts(now)
  let lastErr: unknown = null
  // AbortController は付けていない。useKyoshinRealtime の tick は .then/.catch 内でのみ次の
  // setTimeout を仕込む設計で、単一 effect 内では直列。ただし timeOffset 変化で effect が
  // 再起動した瞬間だけ、旧 effect の in-flight fetch と新 effect の初回 tick が短時間並走しうる。
  // 旧 effect の cleanup は active=false を立てて結果を握り潰すため実害はないが、厳密には
  // 「多重リクエストが起き得る」状態。復帰時の即時サンプルを優先し abort は行わない設計。
  for (const edge of ['west', 'east'] as const) {
    try {
      const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json`)
      if (!res.ok) {
        lastErr = new Error(`realtime fetch failed: ${res.status}`)
        continue
      }
      const json = (await res.json()) as {
        realTimeData?: { dataTime?: string; siteConfigId?: string; intensity?: string }
        hypoInfo?: { items?: YahooHypoInfoItem[] }
      }
      // KYO-3: realTimeData / intensity の欠落・空文字はメンテナンス・空応答の兆候。
      // silent に「空震度配列」で返すと検知エンジンが「全点データ無し」と正しく判定できず、
      // 誤って success として集計される。フィールド欠落・型不一致に加え空文字も失敗として扱う。
      const rt = json.realTimeData
      if (!rt || typeof rt.intensity !== 'string' || rt.intensity.length === 0) {
        lastErr = new Error(`realtime response missing/empty realTimeData.intensity (edge=${edge})`)
        continue
      }
      const intensity = rt.intensity
      const indices = Array.from(intensity, (c) => c.charCodeAt(0) - 100)
      const hypoInfo: YahooHypoInfoItem[] = json.hypoInfo?.items ?? []
      const siteConfigId = rt.siteConfigId ?? ''
      return { dataTime: rt.dataTime ?? '', siteConfigId, indices, hypoInfo }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('realtime fetch failed')
}

// ---- クロック同期（サーバー時刻較正）----
// 壁時計(Date.now())に依存せず、Yahoo のフロンティア(403->200 境界)から真のサーバー現在時刻を
// 推定して clock.feedServerSample() へ供給する。挟み込みは performance.now()(単調)で行うため
// 端末時計のドリフト・ジャンプに影響されない。DMDSS の live モードでのみ起動する。
//
// 注意: この較正は未登録秒を意図的に叩いて 403->200 の境界を捉えるため、30秒ごとに数件の
// 403 応答が発生する。ブラウザはこれをネットワーク層のコンソールエラーとして出力するが
// （JS からは抑制不可）、較正機構の正常動作の一部であり良性。実障害ではない。

/** 較正の実行間隔。 */
const CLOCK_SYNC_INTERVAL_MS = 30000
/** flip 検出のポーリング間隔。 */
const SYNC_POLL_MS = 150
/** flip 検出の打ち切り時間。 */
const SYNC_FLIP_TIMEOUT_MS = 1600
/** 秒終了→登録の実測遅延(ms)。west p50 実測値（measure-registration 参照）。 */
const REG_DELAY_MS = 480
/** 較正に使うエッジ（west は east より登録が速い実測結果に基づく）。 */
const SYNC_EDGE: 'west' | 'east' = 'west'

/**
 * 指定エッジ・エポック秒の秒ファイルが登録済み(200)かをキャッシュバスターで判定する。
 * 戻り値:
 *   - `true`: 登録済み（200）
 *   - `false`: 未登録（403 or 404。Yahoo 側でファイル未生成の状態）
 *   - `null`: 判定不能（5xx / 429 / タイムアウト等）。呼び出し元は較正をスキップし、
 *            この回のサンプルを無視すること。5xx→200 のような一時的な CDN 障害を
 *            「未登録→登録」の遷移と誤認して clock.feedServerSample を汚染するのを防ぐ。
 */
export async function isRegistered(edge: 'west' | 'east', epochSec: number): Promise<boolean | null> {
  const { dateStr, ts } = jstParts(new Date(epochSec * 1000))
  const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json?_=${Math.random()}`, {
    cache: 'no-store',
  })
  if (res.status === 200) return true
  if (res.status === 403 || res.status === 404) return false
  return null
}

/** CLK-1: 探索窓の指数拡張パラメータ。連続失敗のたびに広げ、上限で頭打ち。 */
const BASE_SEARCH_ABOVE = 2
const BASE_SEARCH_BELOW = 4
const MAX_SEARCH_HALF_SEC = 60

/** 探索窓を計算する（連続失敗回数を渡す）。 */
function searchRange(consecutiveFail: number): { above: number; below: number } {
  const factor = Math.min(2 ** consecutiveFail, MAX_SEARCH_HALF_SEC / BASE_SEARCH_ABOVE)
  return {
    above: Math.min(BASE_SEARCH_ABOVE * factor, MAX_SEARCH_HALF_SEC),
    below: Math.min(BASE_SEARCH_BELOW * factor, MAX_SEARCH_HALF_SEC),
  }
}

let syncConsecutiveFail = 0

/**
 * フロンティア(403->200 境界)を1回較正し、サーバー現在時刻を clock へ供給する。
 * 失敗時（境界を挟めない等）は何もせず次周期に委ねる。連続失敗のたびに探索窓を指数拡張する。
 */
async function syncClockOnce(): Promise<void> {
  const guessSec = Math.floor(serverNow() / 1000)
  const { above, below } = searchRange(syncConsecutiveFail)
  // フロンティア（最新の登録済み秒）を探す: guess+above から下げて最初に 200 になる秒
  // （null=判定不能は探索対象としてスキップし、次の秒へ進む）
  let frontier: number | null = null
  for (let s = guessSec + above; s >= guessSec - below; s--) {
    if ((await isRegistered(SYNC_EDGE, s)) === true) {
      frontier = s
      break
    }
  }
  if (frontier === null) {
    syncConsecutiveFail += 1
    if (syncConsecutiveFail % 3 === 0) {
      log.warn(`[kyoshin] clock sync frontier not found for ${syncConsecutiveFail} consecutive tries, search window expanded`, { above, below })
    }
    return
  }
  syncConsecutiveFail = 0
  // frontier+1 を短時間ポーリングし、403->200 の flip を performance.now() で挟む
  const target = frontier + 1
  let last403Perf: number | null = null
  const start = performance.now()
  while (performance.now() - start < SYNC_FLIP_TIMEOUT_MS) {
    const p0 = performance.now()
    let registered: boolean | null
    try {
      registered = await isRegistered(SYNC_EDGE, target)
    } catch {
      return
    }
    const pMid = (p0 + performance.now()) / 2
    if (registered === true) {
      // flip を挟めていない（開始時点で既に登録済み）場合は今回は見送る
      if (last403Perf === null) return
      const flipPerf = (last403Perf + pMid) / 2
      // 秒 target の登録時刻 ≈ (target+1)*1000 + REG_DELAY_MS。その瞬間の perf=flipPerf。
      // 現在時刻へ換算して供給する（feedServerSample が performance.now() との差で K を更新）。
      const serverAtFlip = (target + 1) * 1000 + REG_DELAY_MS
      feedServerSample(serverAtFlip + (performance.now() - flipPerf))
      return
    }
    if (registered === false) {
      // 明示的な未登録（403/404）のみ last403Perf に採用する。判定不能（null: 5xx/429/
      // タイムアウト境界のブレ）を採用すると 5xx→200 遷移を「未登録→登録」と誤認して
      // feedServerSample を汚染し、以後 30 秒ごとに真の時刻からずれた基準で target 選定・
      // EEW キャンセル判定・S 波半径計算が行われる（誰にも見えない形で時計がじわじわ狂う）。
      last403Perf = pMid
    }
    // registered === null は較正基準として使わず次ポーリングへ進む
    await new Promise((r) => setTimeout(r, SYNC_POLL_MS))
  }
}

/**
 * クロック同期ループを開始する。返り値の関数で停止する。
 * DMDSS の live モードでのみ呼ぶこと（リプレイ時は clock 側でサンプルが無視される）。
 */
export function startClockSync(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const loop = async () => {
    if (stopped) return
    try {
      await syncClockOnce()
    } catch {
      // 較正失敗は無視し次周期で再試行
    }
    if (!stopped) timer = setTimeout(loop, CLOCK_SYNC_INTERVAL_MS)
  }
  void loop()
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}
