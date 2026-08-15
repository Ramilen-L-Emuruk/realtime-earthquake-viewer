import type { ExpressionSpecification, MapGeoJSONFeature, Map as MapLibreMap } from 'maplibre-gl'

// 地名ラベル（地方/県/区域名）が、震度塗り・観測点ドット・検知点等の「マーカー」と画面上で実際に
// 重なっているときだけ text-opacity を下げるための判定ユーティリティ。
//
// MapLibre の symbol レイヤーは、他レイヤーの feature（塗りポリゴンの下・観測点ドット等）を避けて
// 自動配置してはくれない（震度系アイコンは icon-allow-overlap/ignore-placement で衝突判定自体に
// 参加しない設計・layerOrder.ts 参照）。かつ text-size はズームに関わらず固定の画面ピクセル数なので、
// ラベルの地理座標が「どの feature の中にあるか」を地図データだけで静的に判定しても、ズームによる
// テキスト⇔ポリゴンの相対サイズの変化を反映できない。そのため実際の画面上のレンダリング結果を
// map.queryRenderedFeatures() で問い合わせ、ラベルが占めるであろう矩形と重なるかどうかを動的に見る。

/** 重なっているときの text-opacity。0 にはせず、地理感覚が完全には失われないよう薄く残す。 */
export const DIMMED_TEXT_OPACITY = 0.35

/** text-opacity の paint 式（各ラベルレイヤー共通）。feature-state の dimmed を見る。 */
export const LABEL_TEXT_OPACITY_EXPR: ExpressionSpecification = [
  'case',
  ['boolean', ['feature-state', 'dimmed'], false],
  DIMMED_TEXT_OPACITY,
  1,
]

// 重なり判定の対象レイヤー。区域塗り（fill）は対象外——面が大きく、テキストが多少乗っても
// 情報として一体的に見えるため対象にしない（ユーザー判断）。震度バッジ・観測点ドット・検知点・
// 波紋等の「マーカー」のみを対象にする。custom layer（kyoshin-subthreshold）と HTML Marker
// （震源×印・津波観測棒）は map.queryRenderedFeatures() の対象にできないため対象外（既知の制約）。
const OVERLAP_CHECK_LAYER_IDS = [
  'quake-region-label',
  'quake-lpgm-region-label',
  'quake-points',
  'quake-lpgm-points',
  'kyoshin-points',
  'kyoshin-detected',
  'kyoshin-ripple',
]

// 日本語ラベル（事前生成グリフのフォント＝ gl/fontStack.ts の JP_FONT_STACK）の推定文字幅・行高比率。
// 全角文字はおよそ 1 文字 = フォントサイズ幅（現行フォントでも全角の advance が font-size と一致する）。
const CHAR_WIDTH_RATIO = 1.0
const LINE_HEIGHT_RATIO = 1.3

export interface LabelOverlapTarget {
  /** GeoJSON source id（setFeatureState の対象）。 */
  source: string
  /** feature の id（GeoJSON Feature.id・数値）。 */
  id: number
  /** ラベルの地理座標 [lng, lat]。 */
  lngLat: [number, number]
  /** ラベル文字列（矩形サイズの推定に使う）。 */
  text: string
  /** text-size（px・iconScale 適用前の基準値）。実描画サイズは updateLabelOverlap 側で iconScale を掛ける。 */
  textSize: number
  /** text-offset の大きさ（em）。up/down 双方向オフセットを使うラベルのみ指定。 */
  offsetEm?: number
  /** text-offset の方向。 */
  dir?: 'up' | 'down'
  /**
   * 自分自身の feature を重なり判定から除外する名前（properties.name と比較）。
   * 区域名ラベルは自分の区域の震度バッジ（text-offset で退避済み）と数px 単位で
   * 隣接することがあるため、自区域のバッジは無視する。
   */
  excludeName?: string
}

/** ラベルの推定表示矩形（画面ピクセル半幅・半高）。 */
function estimateHalfExtent(text: string, textSize: number): { halfW: number; halfH: number } {
  return {
    halfW: (text.length * textSize * CHAR_WIDTH_RATIO) / 2,
    halfH: (textSize * LINE_HEIGHT_RATIO) / 2,
  }
}

/**
 * queryRenderedFeatures は見た目上透明な feature もヒットさせる。kyoshin-points は全国約1725点
 * （観測点全数）を常時 source に保持し、震度0以下（未検出）は feature-state の opacity=0 で
 * 視覚的に透明にしているだけ（毎秒の色替えを setData ではなく feature-state 差分で行う設計・
 * KyoshinPointsGL.tsx 参照）。実際に色が付いている（opacity>0）点だけを「見た目上の重なり」とみなす。
 */
function isVisibleHit(f: MapGeoJSONFeature): boolean {
  if (f.layer.id === 'kyoshin-points') {
    return !!(f.state as { opacity?: number } | undefined)?.opacity
  }
  return true
}

/**
 * 各ラベルについて、対象レイヤーと画面上で重なっているかを判定し、setFeatureState で
 * dimmed フラグを反映する。対象レイヤーが1つも存在しない（quake/kyoshin どちらのモードでもない等）
 * 場合は全ラベルの dimmed を false にする。
 *
 * iconScale は地図アイコンの倍率（設定値）。ラベルの text-size も同倍率で描画されるため
 * （LabelsGL）、判定に使う矩形・オフセットにも同じ倍率を掛けないと、倍率変更時に
 * 「実際は重なっているのに薄くならない」ズレが出る。
 */
export function updateLabelOverlap(map: MapLibreMap, targets: LabelOverlapTarget[], iconScale: number): void {
  const layers = OVERLAP_CHECK_LAYER_IDS.filter((id) => map.getLayer(id))
  for (const t of targets) {
    let dimmed = false
    if (layers.length > 0) {
      const point = map.project(t.lngLat)
      const textSize = t.textSize * iconScale
      const offsetPx = t.offsetEm ? t.offsetEm * textSize : 0
      const cy = t.dir === 'up' ? point.y - offsetPx : t.dir === 'down' ? point.y + offsetPx : point.y
      const { halfW, halfH } = estimateHalfExtent(t.text, textSize)
      const hits = map
        .queryRenderedFeatures(
          [
            [point.x - halfW, cy - halfH],
            [point.x + halfW, cy + halfH],
          ],
          { layers },
        )
        .filter(isVisibleHit)
      dimmed = t.excludeName ? hits.some((f) => f.properties?.name !== t.excludeName) : hits.length > 0
    }
    map.setFeatureState({ source: t.source, id: t.id }, { dimmed })
  }
}
