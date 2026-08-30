import { useEffect, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'
import { serverNow } from '../utils/clock'
import { EARTH_RADIUS_KM, hypocentralDistanceKm, surfaceDistanceKm } from '../utils/geo'

// 地殻速度モデル（日本の平均的な1D速度構造に基づく）
const VP1 = 6.0   // 地殻 P波 [km/s]
const VP2 = 7.8   // マントル P波 / Pn波 [km/s]
const VS1 = 3.5   // 地殻 S波 [km/s]
const VS2 = 4.5   // マントル S波 / Sn波 [km/s]
const MOHO_KM = 33 // モホ面深度 [km]（日本平均値）

/**
 * モホ面に沿って進んだ距離を地表の距離へ直す倍率。
 *
 * 屈折波（Pn/Sn）はモホ面（半径 R−33km の球面）を伝わる。同じ角度でも地表のほうが外側なので
 * 弧は長い。**同じ球で解くなら、ここも換算しないと屈折波だけ平面のまま残る**（差は 0.52%）。
 */
const MOHO_TO_SURFACE = EARTH_RADIUS_KM / (EARTH_RADIUS_KM - MOHO_KM)

// Pn/Sn の臨界角の余弦
const COS_IC_P = Math.sqrt(1 - (VP1 / VP2) ** 2)
const COS_IC_S = Math.sqrt(1 - (VS1 / VS2) ** 2)

const UPDATE_INTERVAL_MS = 100

/**
 * 2層速度モデルで地表距離 R に S波が到達するまでの走時を返す。
 * computeRadius の逆関数（解析的逆算）。
 *
 * **距離はすべて球で解く**（utils/geo.ts）。`sqrt(R² + depth²)` のような平らな直角三角形は使わない。
 *
 * depth <= MOHO_KM の場合:
 *   直達波: t_direct = hypocentralDistanceKm(R, depth) / VS1
 *   屈折波: t_head   = R / MOHO_TO_SURFACE / VS2 + interceptTime
 *            （屈折波はモホ面沿いに進むので、地表の距離を内側の弧へ縮めてから割る）
 *   → 先に到達する方（min）が実際の到達時刻
 *
 * depth > MOHO_KM の場合:
 *   マントル速度のみ: t = hypocentralDistanceKm(R, depth) / VS2
 */
export function computeSWaveTravelTimeSec(surfaceDistKm: number, depth: number): number {
  if (depth > MOHO_KM) {
    return hypocentralDistanceKm(surfaceDistKm, depth) / VS2
  }
  const tDirect = hypocentralDistanceKm(surfaceDistKm, depth) / VS1
  const interceptTime = (2 * MOHO_KM - depth) * COS_IC_S / VS1
  const tHead = surfaceDistKm / MOHO_TO_SURFACE / VS2 + interceptTime
  return Math.min(tDirect, tHead)
}

/**
 * S波の走時モデルで、経過時間 t における地表到達半径を返す。
 * computeSWaveTravelTimeSec の逆関数。PsWaveLayer で「durationSec秒前の
 * 波面半径」（揺れ継続時間の後端）を求めるために使用する。
 */
export function computeSWaveRadiusAtTime(t: number, depth: number): number {
  if (t <= 0) return 0
  return computeRadius(t, depth, VS1, VS2, COS_IC_S)
}

/**
 * 2層速度モデル（地殻＋マントル）で地表到達半径を計算する。
 * computeSWaveTravelTimeSec の逆関数（P 波側も同じ関数を速度だけ替えて通す）。
 *
 * **距離はすべて球で解く**（utils/geo.ts）。`√(hypo² − depth²)` のような平らな直角三角形は使わない。
 *
 * 震源が地殻内（depth <= MOHO_KM）の場合:
 *   - 直達波（P/S）: surfaceDistanceKm(V1·t, depth)
 *   - 屈折波（Pn/Sn）: (t − t_intercept) · V2 · MOHO_TO_SURFACE  ← モホ面沿いの高速伝播
 *     （モホ面上を進んだ距離を地表の弧へ広げる。外側のぶんだけ長い）
 *   - 両者の大きい方が実際の波面位置
 *
 * 震源がマントル内（depth > MOHO_KM）の場合:
 *   - マントル速度（V2）で直達波計算
 *
 * これにより震源から 150km 超の P波円・160km 超の S波円の精度が向上する。
 */
function computeRadius(t: number, depth: number, v1: number, v2: number, cosIc: number): number {
  if (depth <= MOHO_KM) {
    // 直達波の地表半径
    const directRadius = surfaceDistanceKm(v1 * t, depth)

    // Pn/Sn 屈折波の地表半径
    // インターセプト時刻: 波がモホ面に達して戻ってくるまでの余分な時間
    const interceptTime = (2 * MOHO_KM - depth) * cosIc / v1
    // モホ面沿いに進んだ距離を地表の弧へ直す（外側のぶんだけ伸びる）。
    const headRadius = t > interceptTime ? (t - interceptTime) * v2 * MOHO_TO_SURFACE : 0

    return Math.max(directRadius, headRadius)
  } else {
    // 震源がマントル内: マントル速度で直達波（簡略）。
    // 既知の限界（EEW-5・DOC 化されている）: 地殻区間を考慮しないため到達時刻を過小評価する。
    // 33km 前後で不連続ジャンプもある。Snell 則ベースの本来の屈折波再設計は今後の課題。
    return surfaceDistanceKm(v2 * t, depth)
  }
}

/**
 * 単一 EEW の震源・発生時刻（now 時点）から P波・S波の地表到達円を計算する。円が作れない場合
 * （取消済み・座標無効・震源未確定・仮定震源要素・未発生）は null。
 *
 * usePsWaveCalc の 100ms ポーリングとは独立に、新規 EEW 受信直後などその場で1件だけ即時計算したい
 * 場面（CameraFollowsGL の新規 EEW フィット）でも使う。psWave state は別 Effect の非同期更新を待つため、
 * 新規 EEW 受信直後の1レンダーではまだ反映されていないことがあり、そこでは使えない。
 */
export function computeEewCircle(eew: EEWAlert, now: number): PsWaveCircle | null {
  if (eew.cancelled || eew.cancelledAt) return null
  const { hypocenter } = eew.earthquake
  if (!Number.isFinite(hypocenter.latitude) || !Number.isFinite(hypocenter.longitude)) return null
  // マグニチュード・深さが仮の値（震源未確定・単独点処理）の場合はカードと同様に円を生成しない
  if (!hypocenter.name || eew.earthquake.condition === '仮定震源要素') return null

  const originMs = new Date(eew.earthquake.originTime).getTime()
  const t = (now - originMs) / 1000
  if (t < 0) return null

  const depth = Math.max(0, hypocenter.depth ?? 0)

  return {
    eventId: eew.issue?.eventId ?? eew.id,
    lat: hypocenter.latitude,
    lng: hypocenter.longitude,
    pRadius: computeRadius(t, depth, VP1, VP2, COS_IC_P),
    sRadius: computeRadius(t, depth, VS1, VS2, COS_IC_S),
    depth,
    magnitude: hypocenter.magnitude,
  }
}

/**
 * アクティブな EEW の震源・発生時刻から P波・S波の地表到達半径を計算する（標準版・DMDSS版共通）。
 * 100ms ごとに更新することでスムーズな拡張アニメーションを実現する。
 */
export function usePsWaveCalc(
  activeEEWs: EEWAlert[],
  replayTimeOffset: number | null = null,
): PsWaveCircle[] {
  const [waves, setWaves] = useState<PsWaveCircle[]>([])

  useEffect(() => {
    if (activeEEWs.length === 0) {
      setWaves([])
      return
    }

    const compute = () => {
      // serverNow() はサーバー同期時刻（リプレイ時は clock.setReplayOffset 経由でオフセット反映済み）
      const now = serverNow()
      const circles: PsWaveCircle[] = []
      for (const eew of activeEEWs) {
        const circle = computeEewCircle(eew, now)
        if (circle) circles.push(circle)
      }
      setWaves(circles)
    }

    compute()
    const id = setInterval(compute, UPDATE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [activeEEWs, replayTimeOffset])

  return waves
}
