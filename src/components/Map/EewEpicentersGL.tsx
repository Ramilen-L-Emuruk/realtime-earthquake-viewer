import { useEffect, useRef } from 'react'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { EewEpicenter } from '../../hooks/useEewLayerData'
import { getIntensityColor, getIntensityLabelWithOrAbove } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { addOrderedLayer } from './gl/layerOrder'
import { createDepthPointLayer, type DepthPoint, type DepthPointLayer } from './gl/depthPointLayer'
import { badgeHtml, escapeHtml } from './gl/popupHtml'
import { log } from '../../utils/logger'

// EEW（緊急地震速報）の震源（×印・点滅）。全モードで表示し、リアルタイム震度モード以外は
// 半透明にする。複数 EEW 時は全震源を表示する。
//
// **地震情報の震源と同じ仕組みで、実際の深さへ置く**（gl/depthPointLayer.ts）。地表に×印だけを
// 置いていた頃は、地震情報の震源だけが深さを持ち EEW は地表という非対称があった。
//
// 仮定震源要素（単独観測点処理）の震源は控えめに描いて確定震源と区別する
// （予報円を出さない・カードで M/深さを隠すのと同じ扱いを地図にも与える）。
// **深さも採らない**——数値が確定していないため、地表に置く（docs/spec/eew-spec.md §5）。
// 区別は「不透明度を下げる」だけでなく「点滅の振幅を浅くする」ことでも付ける。
// 不透明度と点滅は**乗算される**ため、下げるだけでは点滅の谷で消えてしまい
// 「たまに薄く見える」状態になる（下記の 2 組の定数）。
//
// クリックで震源名・第何報・M・深さ・予想最大震度・警報種別を出す（地震情報の震源と対）。

const LYR = 'eew-epicenters'

/** ×印の色・大きさ。地震情報の震源（HypocenterDepthGL）と揃える。 */
const CROSS_COLOR: readonly [number, number, number] = [255 / 255, 34 / 255, 34 / 255]
const CROSS_SIZE_PX = 32
/** 震央（地表）の印。震源より控えめにして、主役が震源であることを保つ。 */
const EPICENTER_COLOR: readonly [number, number, number] = [0.62, 0.16, 0.16]
const EPICENTER_SIZE_PX = 12

/**
 * ×印の点滅（明側・暗側の不透明度）。周期は `BLINK_PERIOD_MS`。
 *
 * 仮定震源要素は振幅を浅くする。不透明度と**乗算される**ため、確定と同じ谷（0.1）を使うと
 * 倍率と掛かって事実上消えてしまう。「常に見えるが穏やかに明滅する」質感で確定と区別する。
 */
export const EEW_BLINK = {
  confirmed: { high: 1, low: 0.1 },
  assumed: { high: 0.9, low: 0.45 },
} as const

/**
 * 仮定震源要素の×印の不透明度倍率。確定震源より控えめにするが、点滅
 * （`EEW_BLINK.assumed`・谷 0.45）と乗算されるため下げすぎない。
 * kyoshin モードではこちらが採られる（1 × 0.7）。
 */
const ASSUMED_OPACITY_RATIO = 0.7
/**
 * 同・下限。**地震/津波モードでは実質こちらが採用される**（元が 0.4 なので倍率だけだと
 * 0.28 まで落ち、点滅の谷と掛かって 0.13 になる）。このモードでは確定震源との差を
 * 不透明度ではなく点滅の振幅で付ける。
 */
const ASSUMED_OPACITY_MIN = 0.35
/** kyoshin モード以外の×印の不透明度。 */
const DIMMED_OPACITY = 0.4

/**
 * ×印に渡す不透明度。`fullOpacity` は kyoshin モードかどうか（それ以外は半透明）。
 * 点滅（`EEW_BLINK`）と**乗算される**ので、実際の見え方はこの値そのものではない。
 * 積の関係は `EewEpicentersGL.test.ts` が固定している。
 *
 * 仮定震源が確定震源より薄いのは**濃い側だけ**。確定は谷が深いため（1 → 0.1／0.4 → 0.04）、
 * **点滅の谷ではどのモードでも仮定の方が濃くなる**（kyoshin 0.315 対 0.1／他 0.158 対 0.04）。
 * 逆転を消すには、**この 2 軸（不透明度・点滅の振幅）の中では**仮定を「谷で消える」ところまで
 * 戻すしかない。意図した引き換えとして扱っている。線の色や太さで差を付ければ逆転を避けつつ
 * 視認性も保てるが、現状は採っていない（区別は不透明度と点滅だけで付ける方針）。
 */
export function crossOpacity(isAssumed: boolean, fullOpacity: boolean): number {
  const base = fullOpacity ? 1 : DIMMED_OPACITY
  return isAssumed ? Math.max(base * ASSUMED_OPACITY_RATIO, ASSUMED_OPACITY_MIN) : base
}

/**
 * 震源をレイヤーへ渡す点の並びと、点の添字から震源を引く表を作る。
 *
 * 1 つの震源につき「震央（地表の丸・補助）」と「震源（地下の×）」の 2 点を出す。深さが 0 のとき
 * （ごく浅い・仮定震源要素）は柄の長さが 0 になり、震央の印はレイヤー側の判定で自動的に消える。
 *
 * **クリックの引き当てに使うので、点の並びと表の並びは必ず一致させること。**
 */
export function buildEpicenterPoints(
  epicenters: readonly EewEpicenter[],
  iconScale: number,
  fullOpacity: boolean,
): { points: DepthPoint[]; owners: EewEpicenter[] } {
  const points: DepthPoint[] = []
  const owners: EewEpicenter[] = []
  for (const ep of epicenters) {
    const alpha = crossOpacity(ep.isAssumed, fullOpacity)
    const blink = ep.isAssumed ? EEW_BLINK.assumed : EEW_BLINK.confirmed
    // 仮定震源要素は深さを採らない（M・深さを画面から隠すのと同じ扱い）。
    const depthKm = ep.isAssumed ? 0 : (ep.depth ?? 0)
    const [lat, lng] = ep.position
    points.push({
      lng,
      lat,
      depthKm: 0,
      shape: 'circle',
      auxiliary: true,
      color: EPICENTER_COLOR,
      sizePx: EPICENTER_SIZE_PX * iconScale,
      alpha,
      blink,
    })
    owners.push(ep)
    points.push({
      lng,
      lat,
      depthKm,
      shape: 'cross',
      stem: true,
      color: CROSS_COLOR,
      sizePx: CROSS_SIZE_PX * iconScale,
      alpha,
      blink,
    })
    owners.push(ep)
  }
  return { points, owners }
}

interface Props {
  epicenters: EewEpicenter[]
  iconScale: number
  /** リアルタイム震度モードのとき不透明、それ以外は半透明（0.4）。 */
  fullOpacity: boolean
}

function buildPopupHtml(ep: EewEpicenter): string {
  const isWarning = ep.severity === 'Warning'
  const kindColor = isWarning ? '#f87171' : '#fbbf24'
  // 予報級の電文は VXSE45「緊急地震速報（地震動予報）」。表示も実態に合わせる
  const kind = isWarning ? '警報' : '地震動予報'
  // 報番号は電文由来。最終報なら第N報より「最終報」の方が状態が伝わる。
  const serialText = ep.isFinal ? '最終報' : ep.serial ? `第${escapeHtml(ep.serial)}報` : ''
  // 単独観測点処理の初期報は震源が確定していない。数値を鵜呑みにしないよう明示する
  // （×印を薄く描く判定と同じ isAssumed を使い、判定を二重に持たない）。
  const provisional = ep.isAssumed
  const scaleLabel = getIntensityLabelWithOrAbove(ep.maxScale, ep.maxScaleOrAbove)
  return (
    `<div style="min-width:170px">` +
    `<div style="display:flex;align-items:baseline;gap:8px">` +
    `<span style="font-weight:700;font-size:13px">${escapeHtml(ep.name)}</span>` +
    (serialText ? `<span style="font-size:11px;color:#94a3b8">${serialText}</span>` : '') +
    `</div>` +
    // EEW-6: 仮定震源要素（単独観測点処理）は M・深さが未確定なので数値を隠す。
    // カード表示（RealtimeTab の EEWCard）と同じ扱いにする。
    `<div style="margin-top:2px;font-size:11px;color:#94a3b8">` +
    (provisional
      ? '震源調査中'
      : `${escapeHtml(formatMagnitude(ep.magnitude))} / 深さ ${escapeHtml(formatDepth(ep.depth))}`) +
    `</div>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    // 上限が定まらない報は「4以上」と出す。値だけにすると下限を断定した表示になる
    // （語を出す箇所の一覧は docs/spec/eew-spec.md §4）。
    `${badgeHtml(scaleLabel, getIntensityColor(ep.maxScale))}` +
    `<span style="color:#cbd5e1;white-space:nowrap">予想最大震度 ${escapeHtml(scaleLabel)}</span>` +
    `<span style="color:${kindColor};font-weight:700;white-space:nowrap">${kind}</span></div>` +
    (provisional
      ? `<div style="margin-top:4px;font-size:11px;color:#fbbf24">仮定震源要素（単独観測点処理・震源未確定）</div>`
      : '') +
    `</div>`
  )
}

export function EewEpicentersGL({ epicenters, iconScale, fullOpacity }: Props) {
  const map = useMapGL()
  const layerRef = useRef<DepthPointLayer | null>(null)
  // 点の添字から震源 id を引く表。レイヤー登録は map の寿命で 1 回だけなので、クロージャに
  // 古い値を閉じ込めないよう ref を経由する。
  const ownerIdsRef = useRef<string[]>([])
  // id からいまの震源を引く表。**吹き出しの中身は id 経由で引く。**
  // 「最後に引き当てたもの」を覚えて使うと、`refreshMs` のような後から呼び直す経路が入ったとき、
  // 別の震源の内容を出す穴になる（いまは呼び直しが無いので到達しないだけ）。
  const byIdRef = useRef<Map<string, EewEpicenter>>(new Map())

  useEffect(() => {
    if (!map) return
    const layer = createDepthPointLayer(LYR, map)
    layerRef.current = layer

    const add = () => {
      try {
        if (!map.getLayer(LYR)) addOrderedLayer(map, layer)
      } catch (err) {
        log.error('[EewEpicentersGL] custom layer add failed', err)
      }
    }
    add()

    // MAP-1: WebGL context lost/restored 時に MapLibre は custom layer を復元しない。
    // HypocenterDepthGL / PsWaveGL と同じ手当て。
    const onRestored = () => {
      log.warn('[EewEpicentersGL] WebGL context restored, re-adding custom layer')
      if (map.isStyleLoaded()) add()
      else map.once('style.load', add)
    }
    map.on('webglcontextrestored', onRestored)

    // カスタムレイヤーは queryRenderedFeatures にヒットしないので、判定を自前で渡す。
    let popup: PopupHandle | null = null
    try {
      popup = registerPopupSource(map, {
        layerId: LYR,
        priority: 'point',
        // pick を渡すとき tolPx は使われない（許容範囲はレイヤー側の HIT_PAD_PX）。
        tolPx: 0,
        pick: (point, forClick) => {
          const hit = layerRef.current?.pick(point.x, point.y, forClick)
          if (hit === 'pending') return 'pending'
          if (hit == null) return null
          const id = ownerIdsRef.current[hit]
          const ep = id ? byIdRef.current.get(id) : undefined
          if (!ep) return null
          // 吹き出しの位置は地表（震央）に置く。Popup は LngLat しか受け付けないため、
          // 地下の × 印とは深さのぶんだけ離れて出る。
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [ep.position[1], ep.position[0]] },
            properties: { id },
          } as unknown as MapGeoJSONFeature
        },
        buildClickHtml: (feature) => {
          const ep = byIdRef.current.get(String(feature.properties?.id))
          // 引けないのは、吹き出しを開いたまま EEW が失効したときだけ。空を返すと閉じるボタン
          // だけの箱が残るので、消えたことを言う。
          return ep ? buildPopupHtml(ep) : '<div style="font-size:12px;color:#94a3b8">この緊急地震速報は終了しました</div>'
        },
      })
    } catch (err) {
      log.error('[EewEpicentersGL] popup source registration failed', err)
    }

    return () => {
      popup?.remove()
      map.off('webglcontextrestored', onRestored)
      map.off('style.load', add)
      layerRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
    }
  }, [map])

  useEffect(() => {
    const { points, owners } = buildEpicenterPoints(epicenters, iconScale, fullOpacity)
    ownerIdsRef.current = owners.map((ep) => ep.id)
    byIdRef.current = new Map(epicenters.map((ep) => [ep.id, ep]))
    // **`fullOpacity` だけの変化でも作り直す。** 旧実装（DOM マーカー）はこれを避けていたが、
    // 理由は「作り直すと×印が一瞬消え、CSS の点滅が頭から始まる」ことだった。どちらもこの実装には
    // 当てはまらない——点は数個で作り直しは頂点バッファ 100 バイト程度の差し替えに過ぎず、
    // 点滅の位相は全点共通の時計から決まるので作り直しの影響を受けない。
    layerRef.current?.setPoints(points)
    // **`map` を依存に含めること。** レイヤーを作るのは別の effect（`[map]`）で、地図の生成は
    // 非同期（`load` を待つ）。ページを開いた時点で既に EEW が出ていると、この効果が先に
    // 走って `layerRef.current` が null のまま素通りし、**後からレイヤーができても点が入らない**。
    // 続報が来れば自己回復するが、最終報しか無ければ震源が永久に描かれない。
  }, [map, epicenters, iconScale, fullOpacity])

  return null
}
