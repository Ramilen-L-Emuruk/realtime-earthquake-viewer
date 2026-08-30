import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import { shadowPolygon, shadowAltitudes, SHADOW_STEPS } from '../../utils/solarTerminator'
import { serverNow } from '../../utils/clock'
import { log } from '../../utils/logger'

// 夜の側を地図に重ねる。日の入りから天文薄明の下限までを刻んだ面を、同じ濃さで重ね塗りする。
// 内側ほど枚数が増えるので、濃淡は重なりの累積そのものが作る（帯を穴あきポリゴンで切り出すより
// 単純で、リングの巻き方向の取り違えが起きない）。
//
// **重なりは 1 枚のレイヤーの中でも累積する**ため、段ごとにレイヤーを分ける必要はない。分けると
// 段数を変えるたびに gl/layerOrder.ts の登録も動かすことになる。
//
// 面の形は utils/solarTerminator.ts が作る。時刻は serverNow() から取るため、テスト時刻設定での
// 再生中は再生時計の昼夜になる（壁時計を使うと、過去の地震を再生しているのに今の昼夜が出る）。

const SRC = 'day-night'
const LYR = 'day-night'

/**
 * 1 枚あたりの不透明度。重ねた結果が `nightOpacity`（設定）になるよう段数から逆算する。
 *
 * 段数を変えても夜の濃さは変わらず、変わるのは境目の滑らかさだけ。**逆に、夜を濃くすると
 * 1 段あたりの濃さもそのまま上がり、段差が縞として見え始める**ので、濃さの上限と段数は
 * 対で決める（上限は useSettings.ts の `DAY_NIGHT_OPACITY_MAX`）。
 */
function stepOpacity(nightOpacity: number): number {
  return 1 - Math.pow(1 - nightOpacity, 1 / SHADOW_STEPS)
}

/** 夜の色。純黒だと地図が沈むので、わずかに青へ寄せる。 */
const NIGHT_COLOR = '#0a1024'

/** 太陽位置を計算し直す間隔（実時間・ms）。再生時計のジャンプにもこの周期で追従する。 */
const TICK_MS = 10000

/**
 * 描き直しの閾値（時計上の経過・ms）。太陽は 1 分で 0.25° しか動かないため、この頻度で
 * 十分に滑らかに見える。無駄な再タイル化を避ける目的で置いている。
 */
const REDRAW_THRESHOLD_MS = 60000

function buildFeatureCollection(epochMs: number): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: shadowAltitudes().flatMap(altitude =>
      shadowPolygon(epochMs, altitude).map(ring => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
      })),
    ),
  }
}

interface Props {
  visible: boolean
  /** 全段が重なりきったところの不透明度。 */
  opacity: number
}

export function DayNightGL({ visible, opacity }: Props) {
  const map = useMapGL()
  const lastDrawnAtRef = useRef<number>(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    if (!map) return
    lastDrawnAtRef.current = serverNow()
    map.addSource(SRC, { type: 'geojson', data: buildFeatureCollection(lastDrawnAtRef.current) })

    addOrderedLayer(map, {
      id: LYR,
      type: 'fill',
      source: SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'fill-color': NIGHT_COLOR,
        'fill-opacity': stepOpacity(opacity),
        // 経度 ±180 で切った縦辺どうしが隣り合うため、縁を滑らかにすると継ぎ目が線として
        // 見える。面は縁を強調する必要がないので、アンチエイリアスを外して継ぎ目を消す。
        'fill-antialias': false,
        // 既定の 300ms トランジションを外す。形の差し替えでは効かないが、将来 opacity を
        // 触ったときに黙って遅延が入るのを防ぐ。
        'fill-opacity-transition': { duration: 0 },
      },
    })
    return () => {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
    // visible と opacity は初期値としてだけ使う。以降の変更は下の useEffect が担う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!map) return
    if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  useEffect(() => {
    if (!map) return
    // スライダーを動かしている間も遅れずに追う（paint の既定 300ms トランジションは外してある）。
    if (map.getLayer(LYR)) map.setPaintProperty(LYR, 'fill-opacity', stepOpacity(opacity))
  }, [map, opacity])

  useEffect(() => {
    // 見えていない間は計算も差し替えもしない。表示に戻したときは下の即時描画が拾う。
    if (!map || !visible) return
    const redraw = () => {
      const now = serverNow()
      // 時計が有限でない値を返したら描き直さない。そのまま渡すと全頂点が NaN になり、面は
      // クリップで残らず捨てられる。**画面上は設定でオフにしたのと見分けが付かない**ので、
      // 黙って消えないよう記録を残して直前の絵を保つ（clock.ts の feedServerSample と同じ構え）。
      if (!Number.isFinite(now)) {
        log.error('[day-night] 時刻が有限でないため夜の面を更新できません', now)
        return
      }
      if (Math.abs(now - lastDrawnAtRef.current) < REDRAW_THRESHOLD_MS) return
      const source = map.getSource(SRC) as GeoJSONSource | undefined
      if (!source) return
      lastDrawnAtRef.current = now
      source.setData(buildFeatureCollection(now))
    }
    // 非表示の間に時計が進んでいる（再生の開始・終了を含む）ので、まず今の時刻で描き直す。
    lastDrawnAtRef.current = Number.NEGATIVE_INFINITY
    redraw()
    const timer = window.setInterval(redraw, TICK_MS)
    return () => window.clearInterval(timer)
  }, [map, visible])

  return null
}
