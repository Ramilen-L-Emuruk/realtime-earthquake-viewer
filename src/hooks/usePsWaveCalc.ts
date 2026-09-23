import { useEffect, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'
import { serverNow } from '../utils/clock'
import { hasKnownEpicenter } from '../utils/geo'
import { reachRadiusKm } from '../utils/travelTime'

const UPDATE_INTERVAL_MS = 100

/**
 * 単一 EEW の震源・発生時刻（now 時点）から P波・S波の地表到達円を計算する。円が作れない場合
 * （取消済み・座標無効・震源未確定・仮定震源要素・未発生）は null。
 *
 * **走時は JMA2001 走時表から引く**（`utils/travelTime.ts`）。震央距離と深さの組で表を引くので、
 * 地表の曲がりも地殻・マントルの構造も表が持っている —— こちら側で速度モデルを組まない。
 *
 * usePsWaveCalc の 100ms ポーリングとは独立に、新規 EEW 受信直後などその場で1件だけ即時計算したい
 * 場面（CameraFollowsGL の新規 EEW フィット）でも使う。psWave state は別 Effect の非同期更新を待つため、
 * 新規 EEW 受信直後の1レンダーではまだ反映されていないことがあり、そこでは使えない。
 */
export function computeEewCircle(eew: EEWAlert, now: number): PsWaveCircle | null {
  if (eew.cancelled || eew.cancelledAt) return null
  const { hypocenter } = eew.earthquake
  // **位置の判定は `hasKnownEpicenter` に通す。** 有限性だけでは足りない —— 位置不明は
  // センチネル `-200` で表され、`Number.isFinite(-200)` は真なのですり抜ける。すり抜けた値は
  // `PsWaveGL` の `map.project([lng, lat])` へ渡り、MapLibre が緯度の範囲外として例外を投げる
  // （実測: 「Invalid LngLat latitude value: must be between -90 and 90」）。**投げるのは MapLibre の
  // 描画ループ（rAF）の中なので ErrorBoundary は届かない。** `gl/guardRender.ts` が予報円 1 枚に
  // 被害を閉じ込めるが、円が出ないこと自体は防げない。
  if (!hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude)) return null
  // 仮定震源要素では円を描かない。震源・M・深さが固定の仮定値であることに加え、**気象庁は
  // PLUM 法による予測の報で主要動の到達予測時刻を出さない**（PLUM は震源を使わないため猶予時間を
  // 算出できず、受信端末向けのガイドラインも「まもなく到達」等の表現を推奨している）。予報円は
  // 猶予時間の図示なので、描けば根拠のない秒数を見せることになる。震源名が空の報も同じ扱い。
  if (!hypocenter.name || eew.earthquake.condition === '仮定震源要素') return null

  const originMs = new Date(eew.earthquake.originTime).getTime()
  const t = (now - originMs) / 1000
  if (t < 0) return null

  const depth = Math.max(0, hypocenter.depth ?? 0)

  return {
    eventId: eew.issue?.eventId ?? eew.id,
    lat: hypocenter.latitude,
    lng: hypocenter.longitude,
    pRadius: reachRadiusKm('P', t, depth),
    sRadius: reachRadiusKm('S', t, depth),
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
