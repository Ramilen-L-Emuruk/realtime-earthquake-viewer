import { useEffect, useRef } from 'react'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import {
  makeDayNightLayer,
  DAY_NIGHT_LAYER_ID,
  DAY_NIGHT_LAYER_LABEL,
  type DayNightLayer,
} from './gl/dayNightLayer'
import { subsolarPoint } from '../../utils/solarPosition'
import { serverNow } from '../../utils/clock'
import { clearRenderFailure, reportRenderFailure } from '../../utils/renderHealth'
import { log } from '../../utils/logger'

// 夜の側を地図に重ねる。面の中身（濃さの計算・ディザ）は gl/dayNightLayer.ts が持ち、ここは
// 「いつ太陽の位置を進めるか」だけを決める。
//
// **進める間隔は寄り具合から決まる。** 太陽は 1 分で 0.25° しか動かないが、画面上で何ピクセルに
// あたるかは寄るほど大きくなる。固定の間隔にすると、引いた画では無駄に描き直し、寄った画では
// 境目が飛んで見える（60 秒固定だった頃は zoom 7 で 1 分あたり 46px 飛んでいた）。
//
// 時刻は serverNow() から取るため、テスト時刻設定での再生中は再生時計の昼夜になる（壁時計を使うと、
// 過去の地震を再生しているのに今の昼夜が出る）。

/**
 * 太陽の見かけの動き（度／ミリ秒）。1 日で 360° 回る。
 *
 * 太陽自身の赤緯の変化は 1 日で 0.4° 弱なので、境目の動きはほぼこの自転ぶんで決まる。
 */
const SUN_DEG_PER_MS = 360 / 86400000

/**
 * 1 回の描き直しで境目が動いてよい画面上の距離（物理ピクセル）。
 *
 * 小さくすると滑らかになる代わりに描き直しが増える。1 回の描き直しはフレーム 1 枚ぶんなので、
 * 面を作り直していた頃（実測 22〜131ms）とは費用の桁が違う。
 */
const SUN_MOVE_PX_BUDGET = 2

/** 描き直しの間隔の下限・上限（ミリ秒）。 */
const REDRAW_INTERVAL_MIN_MS = 1000
const REDRAW_INTERVAL_MAX_MS = 60000

/** 間隔の判定を回す周期。下限より細かくする意味はない。 */
const TICK_MS = REDRAW_INTERVAL_MIN_MS

/** 時刻が読めないことを記録する間隔（ミリ秒）。毎周回で出すとコンソールが埋まる。 */
const CLOCK_WARN_INTERVAL_MS = 60000

/**
 * 太陽の位置を進める間隔（ミリ秒）。
 *
 * 境目が画面上で {@link SUN_MOVE_PX_BUDGET} だけ動くのにかかる時間。寄るほど短くなる。
 * 経度 1° あたりの画素数は赤道基準で見る（高緯度では実際よりやや細かい側に倒れる）。
 *
 * @param zoom MapLibre のズーム値（512px タイル基準）。
 * @param dpr デバイスピクセル比。物理ピクセルで見るため掛ける。
 */
export function redrawIntervalMs(zoom: number, dpr: number): number {
  if (!Number.isFinite(zoom) || !Number.isFinite(dpr) || dpr <= 0) return REDRAW_INTERVAL_MAX_MS
  const pxPerDeg = (512 * Math.pow(2, zoom) * dpr) / 360
  if (!(pxPerDeg > 0)) return REDRAW_INTERVAL_MAX_MS
  const ms = SUN_MOVE_PX_BUDGET / (pxPerDeg * SUN_DEG_PER_MS)
  return Math.min(REDRAW_INTERVAL_MAX_MS, Math.max(REDRAW_INTERVAL_MIN_MS, ms))
}

interface Props {
  visible: boolean
  /** 夜が深まりきったところの濃さ。 */
  opacity: number
}

/**
 * 「レイヤーを載せられなかった」を知らせるときの鍵。
 *
 * **描画側（`render()` の中）とは別の鍵にする。** 同じ鍵だと、報告する主体が 2 つに増えるのに
 * 取り下げは互いの内部状態を見て決めるため、片方の報告がもう片方の取り下げで消えたり、
 * 逆に永久に残ったりする。`utils/renderHealth.ts` の取り下げは `<鍵>:` に前方一致するので、
 * レイヤー側の `clearRenderFailure(DAY_NIGHT_LAYER_ID, 'draw')` はこちらも一緒に消す。
 */
export const MOUNT_HEALTH_ID = `${DAY_NIGHT_LAYER_ID}:mount`

export function DayNightGL({ visible, opacity }: Props) {
  const map = useMapGL()
  const layerRef = useRef<DayNightLayer | null>(null)
  const lastDrawnAtRef = useRef<number>(Number.NEGATIVE_INFINITY)
  const lastClockWarnAtRef = useRef<number>(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    if (!map) return
    let created: DayNightLayer
    try {
      created = makeDayNightLayer(subsolarPoint, serverNow(), opacity)
    } catch (e) {
      // **地図全体を巻き込まない。** 夜の側は装飾で、ここを包まないと例外が地図領域の
      // ErrorBoundary まで届き、地震情報・緊急地震速報・強震モニタごと「地図が表示できません」
      // に落ちる。**画面には出す** —— 載せられなければ `render()` が一度も呼ばれず、
      // 描画側の検出に永久に届かない（docs/spec/map-rendering-spec.md §16）。
      log.error('[day-night] レイヤーを作れませんでした', e)
      reportRenderFailure(MOUNT_HEALTH_ID, DAY_NIGHT_LAYER_LABEL, 'draw')
      // **取り下げる主体をここに置く。** レイヤーが無いので `render()` は一度も呼ばれず、
      // 描画側の取り下げには永久に届かない。返さないと、次に作れたときも印だけが残り続ける。
      return () => clearRenderFailure(MOUNT_HEALTH_ID, 'draw')
    }
    created.setVisible(visible)
    layerRef.current = created

    const add = () => {
      try {
        if (!map.getLayer(DAY_NIGHT_LAYER_ID)) addOrderedLayer(map, created.layer)
        // 載せられたのだから、前回の「載せられなかった」は嘘になる。**報告した側が取り下げる。**
        clearRenderFailure(MOUNT_HEALTH_ID, 'draw')
      } catch (e) {
        log.error('[day-night] レイヤーを載せられませんでした', e)
        reportRenderFailure(MOUNT_HEALTH_ID, DAY_NIGHT_LAYER_LABEL, 'draw')
      }
    }
    add()

    // **WebGL の文脈が失われて復旧したとき、MapLibre はカスタムレイヤーを戻さない。**
    // 載せ直さなければ `render()` が二度と呼ばれず、夜の側だけが無音で消える（旧実装は
    // style spec のレイヤーだったので MapLibre 側の復旧に乗っていた）。既存のカスタム
    // レイヤー 4 枚と同じ手当て —— スタイルの読み込みを待ってから載せ直す。
    const onRestored = () => {
      log.warn('[day-night] WebGL の文脈が復旧したのでレイヤーを載せ直します')
      if (map.isStyleLoaded()) add()
      else map.once('style.load', add)
    }
    map.on('webglcontextrestored', onRestored)

    return () => {
      map.off('webglcontextrestored', onRestored)
      layerRef.current = null
      if (map.getLayer(created.layer.id)) map.removeLayer(created.layer.id)
      clearRenderFailure(MOUNT_HEALTH_ID, 'draw')
    }
    // visible と opacity は初期値としてだけ使う。以降の変更は下の useEffect が担う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!map || !layerRef.current) return
    layerRef.current.setVisible(visible)
    map.triggerRepaint()
  }, [map, visible])

  useEffect(() => {
    if (!map || !layerRef.current) return
    layerRef.current.setNightOpacity(opacity)
    map.triggerRepaint()
  }, [map, opacity])

  useEffect(() => {
    // 見えていない間は太陽の位置も進めない。表示に戻したときは下の即時描画が拾う。
    if (!map || !visible) return
    const advance = () => {
      const layer = layerRef.current
      if (!layer) return
      const now = serverNow()
      if (!Number.isFinite(now)) {
        // **記録は間引く。** 毎秒の周回なので、そのまま出すとコンソールが埋まって
        // ほかの異常が見えなくなる。時刻が読めない状態は続くのが普通なので、間隔で絞る。
        const at = Date.now()
        if (at - lastClockWarnAtRef.current >= CLOCK_WARN_INTERVAL_MS) {
          lastClockWarnAtRef.current = at
          log.error('[day-night] 時刻が有限でないため夜の側を更新できません', now)
        }
        return
      }
      if (Math.abs(now - lastDrawnAtRef.current) < redrawIntervalMs(map.getZoom(), window.devicePixelRatio || 1)) {
        return
      }
      // **進められなかったときは時刻も進めない。** 次の周回が「まだ描き直す時期ではない」と
      // 見なして再試行が止まるのを防ぐ。
      if (!layer.setTime(now)) return
      lastDrawnAtRef.current = now
      map.triggerRepaint()
    }
    // 非表示の間に時計が進んでいる（再生の開始・終了を含む）ので、まず今の時刻で描き直す。
    lastDrawnAtRef.current = Number.NEGATIVE_INFINITY
    advance()
    const timer = window.setInterval(advance, TICK_MS)
    return () => window.clearInterval(timer)
  }, [map, visible])

  return null
}
