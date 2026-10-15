import { useEffect, useRef } from 'react'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { EewEpicenter } from '../../hooks/useEewLayerData'
import { getIntensityColor, getIntensityLabelWithApproxAbove } from '../../utils/intensity'
import { formatMagnitude, formatDepth, hasDepth } from '../../utils/formatters'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { addOrderedLayer } from './gl/layerOrder'
import { createDepthPointLayer, type DepthPoint, type DepthPointLayer, type DepthPointShape } from './gl/depthPointLayer'
import { badgeHtml, escapeHtml } from './gl/popupHtml'
import { log } from '../../utils/logger'
import { reportRenderFailure, clearRenderFailure, clearRenderFailuresFor } from '../../utils/renderHealth'

// EEW（緊急地震速報）の震源（×印・点滅）。全モードで表示し、リアルタイム震度モード以外は
// 半透明にする。複数 EEW 時は全震源を表示する。
//
// **地震情報の震源と同じ仕組みで、実際の深さへ置く**（gl/depthPointLayer.ts）。地表に×印だけを
// 置いていた頃は、地震情報の震源だけが深さを持ち EEW は地表という非対称があった。
//
// 仮定震源要素（震源未確定）と「非常に強い揺れを検知」の報の震源は、**形で**確定震源と区別する
// （× ＋外周の輪。予報円を出さない・カードで M/深さを隠すのと同じ扱いを地図にも与える）。
// **深さも採らない**——数値が確定していないため、地表に置く（docs/spec/eew-spec.md §5）。
// 深さだけが判らない報は**途切れた ×**にする（地表に置くので、形を変えないと「ごく浅い」と
// 見分けが付かない）。形と、点滅を確定と揃えることは 2026-10-15 ユーザー承認
// （→ docs/spec/map-rendering-spec.md §16）。
//
// クリックで震源名・第何報・M・深さ・予想最大震度・警報種別を出す（地震情報の震源と対）。

const LYR = 'eew-epicenters'
/** 不調を知らせるときに画面へ出す名前（`utils/renderHealth.ts`）。 */
const LABEL = '緊急地震速報の震源'

/** ×印の色・大きさ。地震情報の震源（HypocenterDepthGL）と揃える。 */
const CROSS_COLOR: readonly [number, number, number] = [255 / 255, 34 / 255, 34 / 255]
const CROSS_SIZE_PX = 32
/** 震央（地表）の印。震源より控えめにして、主役が震源であることを保つ。 */
const EPICENTER_COLOR: readonly [number, number, number] = [0.62, 0.16, 0.16]
const EPICENTER_SIZE_PX = 12

/**
 * ×印の点滅（明側・暗側の不透明度）。周期は `BLINK_PERIOD_MS`。**全震源で共通。**
 *
 * かつて仮定震源要素は振幅を浅く・不透明度を低くして区別していたが、点滅の谷では仮定の方が
 * 濃く見える逆転があった。区別を形（`crossShape`）へ移したので、濃さは揃えてある
 * （2026-10-15 ユーザー承認）。
 */
export const EEW_BLINK = { high: 1, low: 0.1 } as const

/** kyoshin モード以外の×印の不透明度。 */
const DIMMED_OPACITY = 0.4

/**
 * ×印に渡す不透明度。`fullOpacity` は kyoshin モードかどうか（それ以外は半透明）。
 * 点滅（`EEW_BLINK`）と**乗算される**ので、実際の見え方はこの値そのものではない。
 */
export function crossOpacity(fullOpacity: boolean): number {
  return fullOpacity ? 1 : DIMMED_OPACITY
}

/**
 * ×印の形。**位置そのものが仮か**を先に見る —— 仮定震源要素は深さも採らないので、深さ不明の
 * 印を重ねると「位置は確か」と読めてしまう。
 *
 * - 仮定震源要素・「非常に強い揺れを検知」の報（`isAssumed`）→ × ＋外周の輪
 * - 深さだけが判らない報（センチネル `-1`。`hasDepth` で判定）→ 途切れた ×。
 *   緯度経度は確かなので、仮のように見せない
 * - それ以外 → 普通の ×（`0` は「ごく浅い」という有効値なのでこちら）
 */
export function crossShape(ep: Pick<EewEpicenter, 'isAssumed' | 'depth'>): DepthPointShape {
  if (ep.isAssumed) return 'crossRing'
  if (!hasDepth(ep.depth)) return 'crossBroken'
  return 'cross'
}

/**
 * ×印を地下ではなく**地表**へ置くか。**理由は 2 つあり、どちらも柄が消え**、震央の印も
 * レイヤー側の判定で消える。2 つの見分けと「ごく浅い」との見分けは形で付ける（`crossShape`）。
 *
 * - **仮定震源要素**（震源未確定）—— 震源・M・深さが固定の仮定値。確定していない数値を
 *   立体で断定して見せない（→ `docs/spec/eew-spec.md` §5）
 * - **深さが判らない報** —— センチネル `-1` をそのまま渡すと `elevationMetersFromDepthKm` が
 *   標高 +1000m を返し、**×印が地表より 1km 上へ浮く**（`gl/depthPointLayer.ts`）。
 *   `??` は `-1` に効かないので `hasDepth` で判定する。**仮定震源要素と同じ形にはしない** ——
 *   あちらは震源の位置そのものが仮だが、こちらは緯度経度が確かで判らないのは深さだけ
 */
function shouldPlaceAtSurface(ep: EewEpicenter): boolean {
  return ep.isAssumed || !hasDepth(ep.depth)
}

/**
 * 震源をレイヤーへ渡す点の並びと、点の添字から震源を引く表を作る。
 *
 * 1 つの震源につき「震央（地表の丸・補助）」と「震源（地下の×）」の 2 点を出す。深さが 0 のとき
 * （ごく浅い・仮定震源要素・**深さ不明**）は柄の長さが 0 になり、震央の印はレイヤー側の判定で
 * 自動的に消える。
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
    const alpha = crossOpacity(fullOpacity)
    const blink = EEW_BLINK
    // 地表へ置く条件は `shouldPlaceAtSurface`（仮定震源要素・深さ不明）。どちらも柄が消えるので、
    // 「ごく浅い」との見分けは形（`crossShape`）で付ける。
    const depthKm = shouldPlaceAtSurface(ep) ? 0 : ep.depth
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
      shape: crossShape(ep),
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

export function buildPopupHtml(ep: EewEpicenter): string {
  const isWarning = ep.severity === 'Warning'
  const kindColor = isWarning ? '#f87171' : '#fbbf24'
  // 予報級の電文は VXSE45「緊急地震速報（地震動予報）」。表示も実態に合わせる
  const kind = isWarning ? '警報' : '地震動予報'
  // 報番号は電文由来。最終報なら第N報より「最終報」の方が状態が伝わる。
  const serialText = ep.isFinal ? '最終報' : ep.serial ? `第${escapeHtml(ep.serial)}報` : ''
  // 仮定震源要素の報は震源が確定していない。数値を鵜呑みにしないよう明示する
  // （×印の形を輪つきにする判定と同じ isAssumed を使い、判定を二重に持たない）。
  const provisional = ep.isAssumed
  const scaleLabel = getIntensityLabelWithApproxAbove(ep.maxScale, ep.maxScaleOrAbove)
  return (
    `<div style="min-width:170px">` +
    `<div style="display:flex;align-items:baseline;gap:8px">` +
    `<span style="font-weight:700;font-size:13px">${escapeHtml(ep.name)}</span>` +
    (serialText ? `<span style="font-size:11px;color:#94a3b8">${serialText}</span>` : '') +
    `</div>` +
    // EEW-6: 仮定震源要素（震源未確定）は M・深さが未確定なので数値を隠す。
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
    // 地名まで含めて仮の値であることを言い切る。カードの「（震源未確定）」だけでは
    // 「この地名がおおよその震源」と読めてしまうが、実際は最初に揺れを検知した観測点の所在地で
    // 震源とは無関係（→ docs/spec/eew-spec.md §5）。ポップアップは行数に余裕があるので書ききる。
    // 「非常に強い揺れを検知」の報は `Condition` が仮定震源要素ではないので、語を分ける
    // （2026-10-15 ユーザー承認）。どちらも地名が観測点の所在地である点は同じ。
    (provisional
      ? ep.strongShakingOnly
        ? `<div style="margin-top:4px;font-size:11px;color:#fbbf24">非常に強い揺れを検知（震源未確定）<br>` +
          `<span style="color:#94a3b8">地名は揺れを検知した観測点の位置です</span></div>`
        : `<div style="margin-top:4px;font-size:11px;color:#fbbf24">仮定震源要素（震源未確定）<br>` +
          `<span style="color:#94a3b8">地名は最初に揺れを検知した観測点の位置です</span></div>`
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
    const layer = createDepthPointLayer(LYR, map, LABEL)
    layerRef.current = layer

    const add = () => {
      try {
        if (!map.getLayer(LYR)) addOrderedLayer(map, layer)
        // 載せられたら不調の記録を消す（前回の失敗を引きずらない）。
        clearRenderFailure(LYR, 'draw')
      } catch (err) {
        log.error('[EewEpicentersGL] custom layer add failed', err)
        // **ここも画面へ出す。** 載せられなければ `render()` が一度も呼ばれず、
        // 描画側の検出（シェーダーの可否）には永久に到達しない。
        reportRenderFailure(LYR, LABEL, 'draw')
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
        label: LABEL,
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
      // **画面にも出す。** 描画は出るのにクリックしても何も返らない状態は、
      // 見た目からは仕様と区別がつかない。
      reportRenderFailure(LYR, LABEL, 'interact')
    }

    return () => {
      popup?.remove()
      // **画面から外れたら不調の記録も消す**（残すと、もう出てこないものの名前が居座る）。
      // `draw` 側と `gl/guardRender.ts` が受け止めた例外の記録も、この 1 行でまとめて消える。
      clearRenderFailuresFor(LYR)
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
