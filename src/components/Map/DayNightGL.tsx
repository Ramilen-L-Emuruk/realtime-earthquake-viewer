import { useEffect, useRef } from 'react'
import type { DataDrivenPropertyValueSpecification, GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import { shadowBands, SHADOW_STEPS } from '../../utils/solarTerminator'
import { serverNow } from '../../utils/clock'
import { log } from '../../utils/logger'

// 夜の側を地図に重ねる。日の入りから天文薄明の下限までを刻み、段ごとに「その段の濃さ」を持つ
// 帯として描く。帯どうしは重ならないので、同じ画素を塗るのは 1 回だけで済む。
//
// **濃淡を重ね塗りの累積で作らない。** 半透明を重ねるたびに結果が 8bit へ丸められ、色の成分ごとに
// 潰れ方が違う。32 回も重ねると誤差が積み上がって色相そのものが動く（陸地の上で濃さ 70% のとき、
// 赤だけが 22 から 14 まで落ちて緑と青は 1 も動かず、青紫から青緑へ 34 度ずれた）。帯にすれば
// 合成は 1 回きりなので、誤差は 1/255 に収まって累積しない。同じ画素を塗る回数が段数ぶんから
// 1 回に減るぶん、描画コストも段数に比例しなくなる。
//
// 帯は 1 枚のレイヤーへまとめて入れる。段ごとにレイヤーを分けると、段数を変えるたびに
// gl/layerOrder.ts の登録も動かすことになる。
//
// 面の形は utils/solarTerminator.ts が作る。時刻は serverNow() から取るため、テスト時刻設定での
// 再生中は再生時計の昼夜になる（壁時計を使うと、過去の地震を再生しているのに今の昼夜が出る）。

const SRC = 'day-night'
const LYR = 'day-night'

/**
 * 帯の濃さを深さ（`depth`）から決める式。最も内側の帯が設定どおりの `nightOpacity` になる。
 *
 * 段を重ねて濃くしていた頃と同じ濃さの付き方にするため、深さに対して指数で効かせる。段数を
 * 変えても夜の濃さは変わらず、変わるのは境目の滑らかさだけ（上限は useSettings.ts の
 * `DAY_NIGHT_OPACITY_MAX`）。
 *
 * **濃さは feature へ焼き込まず式で持たせる。** 焼き込むと、設定のスライダーを動かすたびに面を
 * 作り直すことになる。深さは形が変わらないかぎり不変なので、動くのはこの式の係数だけで済む。
 *
 * **`depth` を持たない feature をこのソースへ混ぜないこと。** MapLibre は式の評価に失敗しても
 * 例外を投げず、警告を 1 度出してそのプロパティの既定値へ落ちる。`fill-opacity` の既定は 1 な
 * ので、素のまま `get` すると夜の面が**真っ黒な不透明の板**になる。`coalesce` で 0 へ倒して
 * おけば、異常時は濃くなる側ではなく消える側へ寄る。式の中からはアプリの `log` を呼べないため、
 * 転落しても記録は残らない。`depth` を必ず入れる `buildFeatureCollection` 側だけが拠り所になる。
 *
 * `totalSteps` には**帯を作るときと同じ段数**を渡すこと。ずれても式は成立してしまい、最も内側の
 * 帯が設定値へ届かないまま夜が薄くなるだけで終わる。
 */
export function opacityExpression(
  nightOpacity: number,
  totalSteps: number,
): DataDrivenPropertyValueSpecification<number> {
  return ['-', 1, ['^', 1 - nightOpacity, ['/', ['coalesce', ['get', 'depth'], 0], totalSteps]]]
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
    features: shadowBands(epochMs, SHADOW_STEPS).flatMap(band =>
      band.polygons.map(rings => ({
        type: 'Feature' as const,
        properties: { depth: band.depth },
        geometry: { type: 'Polygon' as const, coordinates: rings },
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
        'fill-opacity': opacityExpression(opacity, SHADOW_STEPS),
        // 経度 ±180 で切った縦辺どうしと、隣り合う帯の境目が接する。縁を滑らかにするとそこが
        // 線として見えるため、アンチエイリアスを外して継ぎ目を消す。
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
    if (map.getLayer(LYR)) map.setPaintProperty(LYR, 'fill-opacity', opacityExpression(opacity, SHADOW_STEPS))
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
      let data: FeatureCollection<Polygon>
      try {
        data = buildFeatureCollection(now)
      } catch (error) {
        // 面を作れなかったのに時刻だけ進めると、次の周回が「まだ描き直す時期ではない」と判断して
        // REDRAW_THRESHOLD_MS のあいだ再試行が止まる。1 度の失敗が最大 1 分の固着に化けるので、
        // 記録を残したうえで時刻は据え置き、次の周回で作り直す。
        log.error('[day-night] 夜の面を作れませんでした', error)
        return
      }
      lastDrawnAtRef.current = now
      source.setData(data)
    }
    // 非表示の間に時計が進んでいる（再生の開始・終了を含む）ので、まず今の時刻で描き直す。
    lastDrawnAtRef.current = Number.NEGATIVE_INFINITY
    redraw()
    const timer = window.setInterval(redraw, TICK_MS)
    return () => window.clearInterval(timer)
  }, [map, visible])

  return null
}
