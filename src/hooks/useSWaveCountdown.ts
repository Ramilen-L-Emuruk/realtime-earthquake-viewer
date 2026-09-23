import { useEffect, useRef, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'
import { travelTimeSec } from '../utils/travelTime'
import { calcArrivalSafetyMarginSec, calcEEWAutoCancelSec, S_WAVE_FALLBACK_KM_PER_SEC } from '../utils/eew'
import { haversineKm } from '../utils/geo'
import { serverNow } from '../utils/clock'
import { log } from '../utils/logger'
import { useHomeAreaArrival } from './useHomeAreaArrival'

/**
 * 登録地点への主要動到達の見込み。
 *
 * **出どころが 2 つあり、既定は気象庁の発表値。** 自前の走時計算で「その地点へ何秒後」を出すのは
 * 気象業務法第 17 条の許可を要する地震動の予報業務に当たりうるため（→ `useHomeAreaArrival`）、
 * 公開版は気象庁が区域ごとに出した到達予測時刻をそのまま伝える。自前計算は発行済みトークンを
 * 持つ端末でだけ有効になる（→ `docs/spec/eew-spec.md` §6）。
 *
 * **`source` を画面へ必ず反映すること。** 区域の値と地点の値は精度も意味も違うので、
 * どちらを出しているか判らない表示にすると、区域の値が地点の値として読まれる。
 */
export interface SWaveArrival {
  /** `'telegram'` = 気象庁の区域ごとの発表値／`'own'` = 自前の走時計算（地点） */
  source: 'telegram' | 'own'
  /** 気象庁が値を出した区域の名前。`source === 'own'` では null。 */
  areaName: string | null
  /** 震源から登録地点までの距離 [km]。震源が判らなければ null（距離は観測事実で予想ではない）。 */
  distanceKm: number | null
  /** 到達までの秒数。到達済みは 0、推定不能は null。 */
  etaSec: number | null
  arrived: boolean
}

const SPEED_SMOOTH_FRAMES = 3   // 移動平均フレーム数
const MIN_VALID_SPEED = 0.5     // この速度(km/s)未満はフォールバック使用
/**
 * 発表値の残り秒数を進める間隔。
 *
 * **予報円の更新に相乗りしない。** いまは `usePsWaveCalc` が 100ms ごとに新しい配列を返すので
 * 秒数はそれでも動くが、それは**あちらが同一参照を返さないという偶然**に頼っている。
 * 空のときは同じ参照を返す、といった最適化が入った瞬間に秒数が黙って止まるので、
 * 発表値を出す経路は自分で計時する。
 */
const TELEGRAM_TICK_MS = 1000

export function useSWaveCountdown(
  psWave: PsWaveCircle[],
  eews: EEWAlert[],
  home: { lat: number; lng: number } | null,
  hasActiveEEW: boolean,
  /**
   * 自前の走時計算を使ってよいか（発行済みトークンの検証結果）。
   *
   * **既定値を持たせない。** 渡し忘れたときに黙って自前計算へ倒れると、公開版が
   * 許可の要る形で動いてしまう。呼び出し側に必ず決めさせる。
   */
  allowOwnCalculation: boolean,
): SWaveArrival | null {
  const [arrival, setArrival] = useState<SWaveArrival | null>(null)
  const prevSRadiusRef = useRef<number | null>(null)
  const speedHistoryRef = useRef<number[]>([])
  const lastLoggedEEWRef = useRef<string | null>(null)
  const homeAreaArrival = useHomeAreaArrival(eews, home)

  // 発表値を使う経路の計時。予報円の更新に相乗りできない理由は TELEGRAM_TICK_MS のコメント。
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!hasActiveEEW || home === null || allowOwnCalculation) return
    const id = setInterval(() => setTick((t) => t + 1), TELEGRAM_TICK_MS)
    return () => clearInterval(id)
  }, [hasActiveEEW, home, allowOwnCalculation])

  useEffect(() => {
    if (home === null || !hasActiveEEW) {
      prevSRadiusRef.current = null
      speedHistoryRef.current = []
      setArrival(null)
      return
    }

    // 最も波面が外側にある円。距離の表示にだけ使う経路もあるので先に取る。
    const circle = psWave.length > 0
      ? psWave.reduce((best, c) => (c.sRadius > best.sRadius ? c : best), psWave[0])
      : null
    const distanceKm = circle ? haversineKm(circle.lat, circle.lng, home.lat, home.lng) : null

    if (!allowOwnCalculation) {
      // **気象庁の発表値を伝えるだけ。** 区域の値なので区域名を添える。
      if (!homeAreaArrival) {
        prevSRadiusRef.current = circle?.sRadius ?? null
        setArrival(null)
        return
      }
      const etaSec = homeAreaArrival.arrivalMs === null
        ? null
        : Math.max(0, Math.round((homeAreaArrival.arrivalMs - serverNow()) / 1000))
      setArrival({
        source: 'telegram',
        areaName: homeAreaArrival.areaName,
        distanceKm,
        etaSec,
        arrived: homeAreaArrival.arrived || etaSec === 0,
      })
      return
    }

    // ここから下は自前計算（トークンを持つ端末だけ）。
    if (circle === null || distanceKm === null) {
      setArrival(null)
      return
    }
    const sRadiusKm = circle.sRadius
    let arrived = sRadiusKm >= distanceKm

    let etaSec: number | null
    if (circle.depth !== undefined && sRadiusKm > 0) {
      // JMA2001 走時表から理論上のS波到達走時を引き、安全マージンを加算する
      // （震源近傍は直達波がそのまま立ち上がるが、遠方ほど表面波の分離・コーダ波の重畳で
      //  揺れの立ち上がりがなだらかになり、S波理論到達より体感開始が遅れる傾向があるため）
      const marginSec = calcArrivalSafetyMarginSec(distanceKm)
      const tNow = travelTimeSec('S', sRadiusKm, circle.depth)
      const tArrivalWithMargin = travelTimeSec('S', distanceKm, circle.depth) + marginSec
      arrived = tNow >= tArrivalWithMargin
      etaSec = arrived ? 0 : Math.max(0, Math.round(tArrivalWithMargin - tNow))

      // EEW解除前にS波が自宅に到達しない場合は非表示
      // （安全マージン込みの到達時刻で判定する。マージン無しの理論到達時刻だけで解除前と
      //   判定すると、実際の体感到達は解除後にずれ込むケースをカードで見せてしまうため）
      if (!arrived && circle.magnitude !== undefined) {
        const autoCancelSec = calcEEWAutoCancelSec(circle.magnitude, circle.depth)
        const willArriveBeforeCancel = tArrivalWithMargin < autoCancelSec
        const eewKey = `${circle.magnitude}-${circle.depth}`
        if (lastLoggedEEWRef.current !== eewKey) {
          lastLoggedEEWRef.current = eewKey
          log.debug('[eew] S波到達判定（EEW更新）', {
            sRadiusKm: Number(sRadiusKm.toFixed(1)),
            distanceToHomeKm: Number(distanceKm.toFixed(1)),
            etaSec,
            marginSec: Number(marginSec.toFixed(1)),
            autoCancelSec: Number(autoCancelSec.toFixed(1)),
            tArrivalWithMargin: Number(tArrivalWithMargin.toFixed(1)),
            willArriveBeforeCancel,
          })
        }
        if (!willArriveBeforeCancel) {
          prevSRadiusRef.current = sRadiusKm
          setArrival(null)
          return
        }
      }
    } else if (arrived) {
      etaSec = 0
    } else {
      // S波がまだ地表に出ていない場合: フレーム差分で速度を推定
      // ※更新間隔は約100ms〜1秒なので delta ≈ km/s として扱える
      let speed = S_WAVE_FALLBACK_KM_PER_SEC
      if (prevSRadiusRef.current !== null) {
        const delta = sRadiusKm - prevSRadiusRef.current
        if (delta > 0) {
          speedHistoryRef.current.push(delta)
          if (speedHistoryRef.current.length > SPEED_SMOOTH_FRAMES) {
            speedHistoryRef.current.shift()
          }
          const avg = speedHistoryRef.current.reduce((s, v) => s + v, 0) / speedHistoryRef.current.length
          if (avg >= MIN_VALID_SPEED) speed = avg
        }
      }
      etaSec = sRadiusKm === 0 ? null : Math.max(0, Math.round((distanceKm - sRadiusKm) / speed))
    }

    prevSRadiusRef.current = sRadiusKm
    setArrival({ source: 'own', areaName: null, distanceKm, etaSec, arrived })
  }, [psWave, home, hasActiveEEW, allowOwnCalculation, homeAreaArrival, tick])

  return arrival
}
