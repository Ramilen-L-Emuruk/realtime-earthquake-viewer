// Yahoo 強震モニタ（リアルタイム震度）のデータ取得。
// 観測点リストとリアルタイム震度を HTTPS の JSON で取得する。
//
// 参考: https://note.com/looksky758/n/ne9115f77d27a
//   - 観測点: https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList/sitelist.json
//   - 震度  : https://weather-kyoshin.{west|east}.edge.storage-yahoo.jp/RealTimeData/yyyyMMdd/yyyyMMddHHmmss.json
//   - intensity 文字列は各文字の charCode - 100 が観測点ごとの震度インデックス(0〜20)。

import type { EEWAlert, IntensityScale } from '../types/earthquake'
import { feedServerSample, serverNow } from '../utils/clock'

/** 観測点座標の配列（[緯度, 経度]）。インデックスが intensity 文字列の位置に対応。 */
export type SiteCoords = [number, number][]

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

  siteListCache.set(cacheKey, promise)
  return promise
}

/** 日時を JST(UTC+9)の {yyyyMMdd, yyyyMMddHHmmss} 文字列に変換する。 */
function jstParts(date: Date): { dateStr: string; ts: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const hour = get('hour') === '24' ? '00' : get('hour')
  const dateStr = `${get('year')}${get('month')}${get('day')}`
  return { dateStr, ts: `${dateStr}${hour}${get('minute')}${get('second')}` }
}

/** 緊急地震速報の予報円（P波/S波）。半径は km。震源深度・マグニチュードから自前計算する（標準版・DMDSS版共通）。 */
export interface PsWaveCircle {
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
  /** 観測点ごとの震度インデックス(0〜20)。sitelist と同順。 */
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
 *              "5-"→45, "5+"→50, "6-"→55, "6+"→60, "07"→70, その他/不明→-1（フォールバック）
 */
function calcintensityToScale(s: string): IntensityScale {
  const map: Record<string, IntensityScale> = {
    '01': 10, '02': 20, '03': 30, '04': 40,
    '5-': 45, '5+': 50, '6-': 55, '6+': 60, '07': 70,
  }
  return map[s] ?? -1
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
      const intensity = json.realTimeData?.intensity ?? ''
      const indices = Array.from(intensity, (c) => c.charCodeAt(0) - 100)
      const hypoInfo: YahooHypoInfoItem[] = json.hypoInfo?.items ?? []
      const siteConfigId = json.realTimeData?.siteConfigId ?? ''
      return { dataTime: json.realTimeData?.dataTime ?? '', siteConfigId, indices, hypoInfo }
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

/** 指定エッジ・エポック秒の秒ファイルが登録済み(200)かをキャッシュバスターで判定する。 */
async function isRegistered(edge: 'west' | 'east', epochSec: number): Promise<boolean> {
  const { dateStr, ts } = jstParts(new Date(epochSec * 1000))
  const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json?_=${Math.random()}`, {
    cache: 'no-store',
  })
  // 未登録は 403（環境により 404）。200 のみ登録済みとみなす。
  return res.status === 200
}

/**
 * フロンティア(403->200 境界)を1回較正し、サーバー現在時刻を clock へ供給する。
 * 失敗時（境界を挟めない等）は何もせず次周期に委ねる。
 */
async function syncClockOnce(): Promise<void> {
  const guessSec = Math.floor(serverNow() / 1000)
  // フロンティア（最新の登録済み秒）を探す: guess+2 から下げて最初に 200 になる秒
  let frontier: number | null = null
  for (let s = guessSec + 2; s >= guessSec - 4; s--) {
    if (await isRegistered(SYNC_EDGE, s)) {
      frontier = s
      break
    }
  }
  if (frontier === null) return
  // frontier+1 を短時間ポーリングし、403->200 の flip を performance.now() で挟む
  const target = frontier + 1
  let last403Perf: number | null = null
  const start = performance.now()
  while (performance.now() - start < SYNC_FLIP_TIMEOUT_MS) {
    const p0 = performance.now()
    let registered: boolean
    try {
      registered = await isRegistered(SYNC_EDGE, target)
    } catch {
      return
    }
    const pMid = (p0 + performance.now()) / 2
    if (registered) {
      // flip を挟めていない（開始時点で既に登録済み）場合は今回は見送る
      if (last403Perf === null) return
      const flipPerf = (last403Perf + pMid) / 2
      // 秒 target の登録時刻 ≈ (target+1)*1000 + REG_DELAY_MS。その瞬間の perf=flipPerf。
      // 現在時刻へ換算して供給する（feedServerSample が performance.now() との差で K を更新）。
      const serverAtFlip = (target + 1) * 1000 + REG_DELAY_MS
      feedServerSample(serverAtFlip + (performance.now() - flipPerf))
      return
    }
    last403Perf = pMid
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
