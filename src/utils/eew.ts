import type { EEWAlert, EEWRegion } from '../types/earthquake'
import { computeSWaveTravelTimeSec } from '../hooks/useDmdssWaves'

// 司・翠川(1999)の距離減衰式を使ってEEW最終報後の自動解除秒数を計算する。
// 有感半径（震度1以上が届く距離）を逆算し、1.5倍のバッファを乗せてS波到達時刻を求める。

const FELT_RADIUS_BUFFER = 1.5   // 地盤増幅を無視した分の補正係数
const MAX_FELT_RADIUS_KM = 2500  // 上限（M9クラスでも日本全域をカバー）
const MIN_CANCEL_SEC = 60        // 最終報受信から最低この秒数は解除しない
const FIXED_BUFFER_SEC = 30      // S波到達後の余裕

/** Mjma → Mw 変換（宇津 1982） */
function mjmaToMw(mjma: number): number {
  return mjma - 0.171
}

/**
 * 司・翠川(1999)距離減衰式で工学的基盤上の最大速度(PGV600, cm/s)を計算する。
 * X: 断層最短距離(km), mw: モーメントマグニチュード, depth: 震源深度(km)
 */
function calcPGV600(X: number, mw: number, depth: number): number {
  const logPGV = 0.58 * mw + 0.0038 * depth - 1.29
    - Math.log10(X + 0.0028 * 10 ** (0.5 * mw))
    - 0.002 * X
  return 10 ** logPGV
}

/**
 * 司・翠川式の逆算で震度 targetIntensity 以上となる震央距離(km)を返す。
 * 断層長（宇津 1977）を考慮した断層最短距離に変換してから計算する。
 * バッファ係数・上限キャップを適用済み。
 */
function calcFeltRadiusKm(mjma: number, depth: number, targetIntensity = 1.0): number {
  const mw = mjmaToMw(Math.max(mjma, 3.0))
  const faultHalfLen = 10 ** (0.5 * mw - 1.85)  // 断層半長(km)（宇津 1977: log L = 0.5Mw - 1.85）
  // 震度 targetIntensity に対応するPGVしきい値（翠川他 1999: I = 2.68 + 1.72·log(PGV)）
  const pgvThreshold = 10 ** ((targetIntensity - 2.68) / 1.72)

  // 二分探索で有感半径を逆算（PGVは距離単調減少）
  let lo = 0, hi = MAX_FELT_RADIUS_KM / FELT_RADIUS_BUFFER
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    const hypoDist = Math.sqrt(mid ** 2 + depth ** 2)
    const X = Math.max(hypoDist - faultHalfLen, 3)
    if (calcPGV600(X, mw, depth) > pgvThreshold) lo = mid
    else hi = mid
  }

  const rawRadius = (lo + hi) / 2
  return Math.min(rawRadius * FELT_RADIUS_BUFFER, MAX_FELT_RADIUS_KM)
}

/**
 * EEW最終報の発震時刻から何秒後に自動解除するかを返す。
 * 司・翠川(1999)の有感半径(×1.5バッファ)にS波が到達するまでの時間 + 30秒。
 */
export function calcEEWAutoCancelSec(mjma: number, depth: number): number {
  const feltRadius = calcFeltRadiusKm(mjma, depth)
  const sWaveSec = computeSWaveTravelTimeSec(feltRadius, Math.max(depth, 1))
  return Math.round(sWaveSec) + FIXED_BUFFER_SEC
}

/** EEWの発震時刻を起点にした自動解除時刻を返す。最終報受信から MIN_CANCEL_SEC 秒の下限保証付き。 */
export function calcEEWCancelTime(eew: EEWAlert, reportTime: Date): Date {
  const mjma = eew.earthquake.hypocenter.magnitude ?? 6.0
  const depth = eew.earthquake.hypocenter.depth ?? 30
  const originTime = new Date(eew.earthquake.originTime)
  const autoCancelSec = calcEEWAutoCancelSec(mjma, depth)
  const fromOrigin = new Date(originTime.getTime() + autoCancelSec * 1000)
  const minTime = new Date(reportTime.getTime() + MIN_CANCEL_SEC * 1000)
  return fromOrigin > minTime ? fromOrigin : minTime
}

// EEW の areas が未設定の場合 regions にフォールバックする（旧形式互換）。

export function eewAreas(eew: EEWAlert): EEWRegion[] {
  return eew.areas ?? eew.regions ?? []
}

/** 対象地域の最大予想震度（scale 値）。
 * condition=仮定震源要素（単独点処理）かつ areas が空の場合は forecastMaxScale を使わず 0 を返す。
 * 単独点PLUM検知では forecastMaxInt が設定されても地域別予想は発表されないため。
 */
export function eewMaxScale(eew: EEWAlert): number {
  const areasMax = eewAreas(eew).reduce((max, r) => Math.max(max, r.scaleTo), 0)
  if (areasMax > 0) return areasMax
  if (eew.earthquake.condition === '仮定震源要素') return 0
  return eew.forecastMaxScale ?? 0
}

/** 情報番号（第N報）。取得できなければ null。 */
export function eewSerial(eew: EEWAlert): number | null {
  const n = Number(eew.issue?.serial)
  return Number.isInteger(n) && n > 0 ? n : null
}
