import type { ExpressionSpecification, MapGeoJSONFeature, Map as MapLibreMap } from 'maplibre-gl'

// 地名ラベル（地方/県/区域名）が、震度バッジ・観測点ドット等の「マーカー」と画面上で重なるのを
// 避けるための判定ユーティリティ。避けきれないときは薄くする。
//
// MapLibre の symbol レイヤーは、他レイヤーの feature（塗りポリゴンの下・観測点ドット等）を避けて
// 自動配置してはくれない（震度系アイコンは icon-allow-overlap/ignore-placement で衝突判定自体に
// 参加しない設計・layerOrder.ts 参照）。かつ text-size はズームに関わらず固定の画面ピクセル数なので、
// ラベルの地理座標が「どの feature の中にあるか」を地図データだけで静的に判定しても、ズームによる
// テキスト⇔ポリゴンの相対サイズの変化を反映できない。そのため実際の画面上のレンダリング結果を
// map.queryRenderedFeatures() で問い合わせ、ラベルが占めるであろう矩形と重なるかどうかを動的に見る。
//
// 判定は「そのまま置けるか → ずらせば避けられるか → どちらも駄目なら薄くする」の 3 段。
// **退避は重なったときだけ**行い、平常時は代表点の真上に置く。以前は退避方向を生成データに焼いて
// 常時ずらしていたが、区域の南北幅に対して退避量（区域名で 2.2em）が大きく、区域の端まで文字が
// 寄っていた（埼玉県秩父で区域高さの 1/5・ズーム 8 では 192 区域中 29 件が自区域の外へ出ていた）。
// 退避が必要なのは震度バッジ等が出ている間だけなので、動的に判定する側へ寄せた。
//
// 結果は feature の properties（shift / dimmed）として GeoJSON へ書き戻す（LabelsGL が setData する）。
// feature-state を使わないのは、**layout プロパティである text-offset が feature-state 式を受け付けない**
// ため（MapLibre のスタイル検証が "feature-state data expressions are not supported with layout
// properties" で弾く）。paint 側の text-opacity だけ feature-state にすると駆動元が 2 つに割れるので、
// 両方を properties に寄せている。

/** ラベルの退避方向。`none` は代表点の真上（退避なし）。 */
export type LabelShift = 'none' | 'up' | 'down'

/** 1 ラベルの配置結果。 */
export interface LabelPlacement {
  shift: LabelShift
  /** 退避しても避けられず、薄く落とすことにしたか。 */
  dimmed: boolean
}

/**
 * 避けきれなかったときの text-opacity。0 にはせず、地理感覚が完全には失われないよう薄く残す
 * （退避を先に試すので、ここへ来るのは「どこへ逃がしても当たる」場合だけ）。
 */
export const DIMMED_TEXT_OPACITY = 0.35

/** text-opacity の paint 式（各ラベルレイヤー共通）。 */
export const LABEL_TEXT_OPACITY_EXPR: ExpressionSpecification = [
  'case',
  ['boolean', ['get', 'dimmed'], false],
  DIMMED_TEXT_OPACITY,
  1,
]

/**
 * text-offset の layout 式。`shiftEm` は退避量（em・文字サイズに対する比）。
 * 文字とバッジの双方に同じ iconScale が掛かるため、em で持つ限り倍率を変えても間隔の比率は崩れない。
 */
export function labelTextOffsetExpr(shiftEm: number): ExpressionSpecification {
  return [
    'case',
    ['==', ['get', 'shift'], 'up'],
    ['literal', [0, -shiftEm]],
    ['==', ['get', 'shift'], 'down'],
    ['literal', [0, shiftEm]],
    ['literal', [0, 0]],
  ]
}

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
  /** GeoJSON source id。 */
  source: string
  /** feature の id（GeoJSON Feature.id・数値）。 */
  id: number
  /** ラベルの地理座標 [lng, lat]。 */
  lngLat: [number, number]
  /** ラベル文字列（矩形サイズの推定に使う。properties.name にもこの値が入る）。 */
  text: string
  /** text-size（px・iconScale 適用前の基準値）。実描画サイズは判定側で iconScale を掛ける。 */
  textSize: number
  /** 重なったときにずらす量（em）。**省略すると退避せず、重なった時点で薄くする**（地方名）。 */
  shiftEm?: number
  /**
   * 代表点から北・南へずらせる余地 `[北, 南]`（緯度差の度数）。生成データが持つ値で、
   * 「その方向へ進んで区域（県）の外に出るまでの距離」。退避で文字が領域外へ飛ぶのを防ぐ上限。
   * `shiftEm` を持つラベルのみ指定する。
   */
  room?: readonly [number, number]
  /**
   * **退避したあとの位置**で、重なりに数えない feature の名前（properties.name と比較）。
   *
   * 区域名ラベルに自区域名を渡している。退避量とバッジの半径は近い値なので、逃がした先でも
   * 自区域バッジの縁と数 px かすめることがある。そこで薄くしてしまうと「バッジを避けたのに
   * 読めない」になるため、退避を済ませた後の接触は許容する。
   *
   * **代表点での判定には効かせない。** そこで除外すると、避けたい当の相手（自区域バッジは区域名
   * ラベルと同じ代表点に置かれる）が判定から消え、退避そのものが発火しなくなる。
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
 * 2 要素とも有限の数値か。ラベルの座標（`lngLat`）と退避の余地（`room`）はどちらも生成データ
 * （`public/data/*.json`）由来で、fetch 後に形を検証していないため、算術へ入れる前にここで確かめる。
 *
 * **壊れた値を素通しすると `map.project()` が NaN 座標で例外を投げる。** 判定は `targets.map()` の
 * 中で回るので、ラベル 1 件の破損が全ラベルの判定を巻き添えにし、しかも次の再評価でも同じデータを
 * 読むため、以後セッション終了までラベルの重なり回避が止まる。値を通す側で塞いでおく。
 */
export function isFinitePair(v: readonly [number, number] | undefined): v is readonly [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n))
}

/**
 * 退避の余地として使える値か。有限であることに加えて**非負**を要求する。
 *
 * 余地は「代表点から領域の外に出るまでの距離」なので負にはなり得ないが、負値が紛れ込むと
 * `shiftCandidates` の `Math.abs()` が符号を吸収し、**余地が無いはずの方向を「余地がある」と
 * 読んでしまう**（そちらへ退避して文字が領域の外へ出る＝この実装が無くそうとした症状の再発）。
 * 型としては正しいので `isFinitePair` では捕まらない。座標（`lngLat`）は負を取りうるので、
 * 非負の要求はこちらだけに置く。
 */
export function isUsableRoom(room: readonly [number, number] | undefined): room is readonly [number, number] {
  return isFinitePair(room) && room[0] >= 0 && room[1] >= 0
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

/** 指定の画面位置にラベルを置いたとき、対象レイヤーと重なるか。 */
function overlapsAt(
  map: MapLibreMap,
  layers: string[],
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  excludeName: string | undefined,
): boolean {
  const hits = map
    .queryRenderedFeatures(
      [
        [cx - halfW, cy - halfH],
        [cx + halfW, cy + halfH],
      ],
      { layers },
    )
    .filter(isVisibleHit)
  return excludeName ? hits.some((f) => f.properties?.name !== excludeName) : hits.length > 0
}

/**
 * 退避を試せる方向を、余地が広い順に返す。余地が足りない方向は候補に入れない。
 *
 * 必要な余地は「退避量 ＋ 文字の半分の高さ」。退避後に文字の**縁**まで領域内へ収める必要があるため、
 * 中心の移動量だけでは足りない。
 */
function shiftCandidates(
  map: MapLibreMap,
  t: LabelOverlapTarget,
  textSize: number,
  halfH: number,
  centerY: number,
): LabelShift[] {
  if (!t.shiftEm || !isUsableRoom(t.room)) return []
  const need = t.shiftEm * textSize + halfH
  const [lng, lat] = t.lngLat
  // 度 → px の換算は緯度で変わる（メルカトル）。実際に投影して測る。
  const northPx = Math.abs(centerY - map.project([lng, lat + t.room[0]]).y)
  const southPx = Math.abs(map.project([lng, lat - t.room[1]]).y - centerY)
  const usable: { dir: LabelShift; room: number }[] = []
  if (northPx >= need) usable.push({ dir: 'up', room: northPx })
  if (southPx >= need) usable.push({ dir: 'down', room: southPx })
  usable.sort((a, b) => b.room - a.room)
  return usable.map((u) => u.dir)
}

/**
 * 各ラベルの配置（退避方向・薄くするか）を判定する。戻り値は `targets` と同じ順・同じ長さ。
 *
 * 対象レイヤーが 1 つも存在しない（quake/kyoshin どちらのモードでもない等）場合は、全ラベルを
 * 退避なし・不透明のままにする。
 *
 * iconScale は地図アイコンの倍率（設定値）。ラベルの text-size も同倍率で描画されるため
 * （LabelsGL）、判定に使う矩形・退避量にも同じ倍率を掛けないと、倍率変更時に
 * 「実際は重なっているのに避けない」ズレが出る。
 */
export function computeLabelPlacements(
  map: MapLibreMap,
  targets: LabelOverlapTarget[],
  iconScale: number,
): LabelPlacement[] {
  const layers = OVERLAP_CHECK_LAYER_IDS.filter((id) => map.getLayer(id))
  if (layers.length === 0) return targets.map(() => ({ shift: 'none', dimmed: false }))

  return targets.map((t) => {
    // 座標も生成データ由来なので、`room` と同じく投影の前に確かめる（isFinitePair の説明を参照）。
    // 壊れている場合そのラベルは MapLibre 側でも描画されないため、判定結果は既定値でよい。
    if (!isFinitePair(t.lngLat)) return { shift: 'none', dimmed: false }
    const point = map.project(t.lngLat)
    const textSize = t.textSize * iconScale
    const { halfW, halfH } = estimateHalfExtent(t.text, textSize)
    // 代表点の判定では excludeName を効かせない（避けたい相手を除外してしまうため。上の定義を参照）。
    if (!overlapsAt(map, layers, point.x, point.y, halfW, halfH, undefined))
      return { shift: 'none', dimmed: false }

    const shiftPx = (t.shiftEm ?? 0) * textSize
    for (const dir of shiftCandidates(map, t, textSize, halfH, point.y)) {
      const cy = dir === 'up' ? point.y - shiftPx : point.y + shiftPx
      if (!overlapsAt(map, layers, point.x, cy, halfW, halfH, t.excludeName))
        return { shift: dir, dimmed: false }
    }
    return { shift: 'none', dimmed: true }
  })
}
