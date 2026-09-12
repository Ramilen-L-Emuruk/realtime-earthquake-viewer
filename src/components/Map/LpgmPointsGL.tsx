import { useEffect, useRef } from 'react'
import { frontSortKeyExpression, mercatorProps } from './gl/screenDepth'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel, getLpgmClassRadius, lpgmPeriodLabel } from '../../utils/lpgm'
import { getIntensityLabel } from '../../utils/intensity'
import type { LpgmMarker } from '../../hooks/useQuakeLayerData'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'
import { NON_JMA_MARK_TITLE, withNonJmaMark } from '../../utils/formatters'
import { ensureLpgmIcons, lpgmIconId, LPGM_ICON_BASE_RADIUS } from './gl/lpgmIcons'

// 長周期地震動観測点を階級ラベル付き四角バッジで描画する MapLibre 版。
// バッジは Canvas2D で事前ラスタライズした画像を icon-image として貼る（gl/lpgmIcons.ts、
// 震度観測点 QuakeIntensityPointsGL と同じ理由）。
// LPGM の points は常に観測点そのもの（区域代表点は points ではなく regions という別枠の
// 電文データから来る）ため、isArea の出し分けは不要。
//
// 更新は電文切替時のみ（頻度が低い）なので setData で丸ごと差し替える。
// ホバーで観測点名＋階級、クリックで都道府県まで出す。

const SRC = 'quake-lpgm-points'
const LYR = 'quake-lpgm-points'
// 観測点バッジは階級連動（getLpgmClassRadius: 8〜14 ＝ 一辺 16〜28px）。
// 区域バッジ（LpgmRegionFillGL）はここに下駄を履かせて一回り大きくする。
const HIT_TOL_PX = 8

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  markers: LpgmMarker[]
  iconScale: number
  visible: boolean
}

function buildFC(markers: LpgmMarker[], iconScale: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: {
      iconId: lpgmIconId(m.lgInt),
      iconSizeRatio: (getLpgmClassRadius(m.lgInt) * iconScale) / LPGM_ICON_BASE_RADIUS,
      lgInt: m.lgInt,
      name: m.name,
      pref: m.pref,
      nonJma: m.nonJma ?? false,
      // **周期帯の内訳は文字列にして渡す。** GeoJSON の properties は MapLibre を
      // 通ると配列やオブジェクトが素の形では戻らないため、読み出す側で復元する。
      int: m.int ?? -1,
      sva: m.sva ?? -1,
      periodsJson: m.periods && m.periods.length > 0 ? JSON.stringify(m.periods) : '',
      // 同じ階級のバッジを画面の手前から並べるために持たせる（gl/screenDepth.ts）。
      ...mercatorProps(m.position[1], m.position[0]),
    },
    geometry: { type: 'Point', coordinates: [m.position[1], m.position[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

/**
 * ポップアップの見出し（表示名）。
 *
 * **気象庁以外が運用する観測点には `＊` を付ける**（→ `withNonJmaMark`）。ホバーと
 * クリックの両方がこれを通るので、同じ観測点が場所によって違う名前で出ることはない。
 */
export function lpgmPointPopupTitle(f: MapGeoJSONFeature): string {
  return withNonJmaMark(String(f.properties?.name ?? ''), Boolean(f.properties?.nonJma))
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const lgInt = Number(f.properties?.lgInt ?? 0)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(String(lgInt), getLpgmClassColor(lgInt))}` +
    `<span style="font-weight:600">${escapeHtml(lpgmPointPopupTitle(f))}</span></div>`
  )
}

/**
 * 周期帯ごとの内訳。**長周期地震動は「どの周期帯が強く出たか」が本体**で、
 * 全体の階級だけでは低層寄りか高層寄りかが出せない。
 *
 * 階級 0 の帯も出す —— 0 は「その周期帯では該当なし」で、落とすと
 * 「短い周期だけ強く出た」形が「短い周期しか観測していない」ように見える。
 */
export function lpgmPeriodsHtml(json: string): string {
  if (!json) return ''
  let bands: { band: number; lgInt?: number; sva?: number }[]
  try {
    bands = JSON.parse(json)
  } catch {
    return ''
  }
  if (!Array.isArray(bands) || bands.length === 0) return ''
  const rows = bands.map(b => {
    const cls = typeof b.lgInt === 'number' ? b.lgInt : -1
    const chip = cls >= 1
      ? badgeHtml(String(cls), getLpgmClassColor(cls))
      : `<span style="display:inline-block;width:16px;text-align:center;color:#64748b">−</span>`
    const sva = typeof b.sva === 'number' ? b.sva.toFixed(1) : ''
    return (
      `<div style="display:flex;align-items:center;gap:6px;line-height:1.6">` +
      `<span style="width:32px;color:#94a3b8;text-align:right">${escapeHtml(lpgmPeriodLabel(b.band))}</span>` +
      `${chip}` +
      `<span style="color:#cbd5e1;font-variant-numeric:tabular-nums">${escapeHtml(sva)}</span></div>`
    )
  }).join('')
  // **専門用語をそのまま出さない。** このアプリは分類番号を平易な一文へ直す作法を取っている
  // （→ `lpgmCategoryNote`）。周期帯・応答の大きさも、値だけ出しても何を意味するか伝わらない。
  // 数字は残したうえで、読み方を一行添える。
  return (
    `<div style="margin-top:8px;border-top:1px solid #334155;padding-top:6px">` +
    `<div style="font-size:10px;color:#94a3b8;margin-bottom:2px">揺れの周期ごと（階級・揺れの大きさ）</div>` +
    `<div style="font-size:11px">${rows}</div>` +
    `<div style="font-size:10px;color:#94a3b8;margin-top:4px">周期が長いほど、高い建物が大きく揺れます</div></div>`
  )
}

function clickHtml(f: MapGeoJSONFeature): string {
  const lgInt = Number(f.properties?.lgInt ?? 0)
  const pref = String(f.properties?.pref ?? '')
  const int = Number(f.properties?.int ?? -1)
  const sva = Number(f.properties?.sva ?? -1)
  // 気象庁以外が運用する観測点。震度側の吹き出しと同じ扱い（→ `withNonJmaMark`）。
  const nonJma = Boolean(f.properties?.nonJma)
  return (
    `<div style="min-width:170px">` +
    `<div style="font-weight:700;font-size:13px"` +
      (nonJma ? ` title="${escapeHtml(NON_JMA_MARK_TITLE)}"` : '') +
      `>${escapeHtml(lpgmPointPopupTitle(f))}</div>` +
    (pref ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">${escapeHtml(pref)}</div>` : '') +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(String(lgInt), getLpgmClassColor(lgInt))}` +
    `<span style="color:#cbd5e1">長周期地震動${escapeHtml(getLpgmClassLabel(lgInt))}</span></div>` +
    // **震度も併せて出す。** 震度は小さいのに階級が高い観測点があることが長周期地震動の
    // 要点で、片方だけ出すとその差が見えない。
    (int >= 0
      ? `<div style="margin-top:4px;font-size:12px;color:#cbd5e1">震度 ${escapeHtml(getIntensityLabel(int))}</div>`
      : '') +
    // 絶対速度応答スペクトルの最大値。語をそのまま出しても伝わらないので、
    // 「揺れの大きさ」と書いて単位を添える（値は電文のまま）。
    (sva >= 0
      ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">揺れの大きさ 最大 ${escapeHtml(sva.toFixed(1))} cm/s</div>`
      : '') +
    lpgmPeriodsHtml(String(f.properties?.periodsJson ?? '')) +
    `</div>`
  )
}

export function LpgmPointsGL({ markers, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    ensureLpgmIcons(map)
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'symbol',
      source: SRC,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': ['get', 'iconSizeRatio'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // 階級が第一・画面の手前らしさが第二の合成キー（gl/screenDepth.ts）。方位が変われば
        // JapanMapGL が式を差し替える。ここで置くのは方位 0 の初期値。
        'symbol-sort-key': frontSortKeyExpression('lgInt', 0),
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'point',
      tolPx: HIT_TOL_PX,
      rankKey: 'lgInt',
      buildHoverHtml: hoverHtml,
      buildClickHtml: clickHtml,
    })
    addedRef.current = true
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(markers, iconScale))
  }, [map, markers, iconScale])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
