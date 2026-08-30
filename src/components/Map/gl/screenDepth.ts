import type { ExpressionSpecification, Map as MapLibreMap } from 'maplibre-gl'

// 同じ階級のバッジを「画面の手前から」並べるための仕組み。
//
// 地図を傾けると奥行きが生まれ、同じ震度のバッジが重なったときに**どちらが手前か**が意味を持つ。
// MapLibre の並べ替えは 2 通りあるが、**どちらか一方しか使えない**。
//
// - `symbol-sort-key` … 値の大きいものが手前（実測で確認）。階級の優先はこれで作っている
// - `symbol-z-order: 'viewport-y'` … 画面の下にあるものが手前。タダで「手前優先」になる
//
// MapLibre は `symbol-sort-key` を指定すると `viewport-y` を使わない（排他）。したがって
// 「階級が第一・手前らしさが第二」の二段の並びは、**両方を 1 つの値へ畳んだ合成キー**でしか作れない。
//
// 手前らしさは**方位と座標だけ**から出る。中心・ズーム・傾きには依存しないので、
// **作り直しが要るのは方位が変わったときだけ**（毎フレームの `setData` にはならない）。
// 座標は不変なので、点の側には Mercator 座標を持たせておき、方位が変わったら
// `setLayoutProperty` で式だけ差し替える。

/** 点が持つ Mercator 座標のプロパティ名。式から `['get', ...]` で読む。 */
export const MERCATOR_X_PROP = 'mercX'
export const MERCATOR_Y_PROP = 'mercY'

/**
 * 合成キーで手前らしさに割り当てる幅。
 *
 * **1 未満であること。** 階級の値は整数で刻まれる（震度は 10 刻み・長周期は 1 刻み）ので、
 * 1 未満に収めておけば手前らしさが隣の階級を追い越さない。
 */
export const FRONT_WEIGHT = 0.9

/**
 * 点に持たせる Mercator 座標。**方位に依存しないので、点を作るときに 1 度だけ計算すればよい。**
 *
 * y は南ほど大きい（Web Mercator の定義どおり）。
 */
export function mercatorProps(lng: number, lat: number): { [MERCATOR_X_PROP]: number; [MERCATOR_Y_PROP]: number } {
  return {
    [MERCATOR_X_PROP]: (180 + lng) / 360,
    [MERCATOR_Y_PROP]: (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360,
  }
}

/**
 * 画面の手前らしさ（0〜1。大きいほど手前＝画面の下）。
 *
 * 方位 θ に対して `−x·sinθ + y·cosθ`。Mercator 座標が 0〜1 のとき、この値は
 * **±(|sinθ| + |cosθ|)、つまり最大で ±√2 まで振れる**（θ が 45 度のとき）。±1 で収まると誤ると、
 * 斜めの方位で 0〜1 をはみ出して**隣の階級を追い越す**。√2 で割ってから 0〜1 へ写す。
 *
 * **実測で裏を取った式。** 中心 138E36N・zoom 5 で 289 点を撒き、画面 y との順序の食い違い
 * （転倒率）を数えたところ、方位 0/90 度と傾き 0 では 0%、斜めの方位でも 0.2〜1.2% だった
 * （Mercator の縮尺が緯度で変わるぶんの誤差で、バッジの前後を決めるには十分）。
 */
export function frontness01(mercX: number, mercY: number, bearingDeg: number): number {
  const th = (bearingDeg * Math.PI) / 180
  return (-mercX * Math.sin(th) + mercY * Math.cos(th) + Math.SQRT2) / (2 * Math.SQRT2)
}

/**
 * 「階級が第一・手前らしさが第二」の合成キーの式。
 *
 * @param levelProp 階級を持つプロパティ名（震度なら `scale`、長周期なら `lgInt`）
 * @param bearingDeg 地図の方位。**値を式へ焼き込む**（式から方位を読む手段が無いため）
 */
export function frontSortKeyExpression(levelProp: string, bearingDeg: number): ExpressionSpecification {
  const th = (bearingDeg * Math.PI) / 180
  const sin = Math.sin(th)
  const cos = Math.cos(th)
  // frontness01 と同じ式。こちらは MapLibre の式で組む。
  const front: ExpressionSpecification = [
    '/',
    [
      '+',
      ['-', ['*', ['get', MERCATOR_Y_PROP], cos], ['*', ['get', MERCATOR_X_PROP], sin]],
      Math.SQRT2,
    ],
    2 * Math.SQRT2,
  ]
  return ['+', ['get', levelProp], ['*', front, FRONT_WEIGHT]]
}

/** 手前らしさで並べ替えるレイヤーと、その階級のプロパティ名。 */
export interface FrontSortedLayer {
  id: string
  levelProp: string
}

/**
 * 対象のレイヤー。**バッジが重なりうるもの**だけを挙げる。
 *
 * ここに足したレイヤーの点には `mercatorProps` を必ず持たせること。持たせ忘れると
 * `['get', ...]` が null を返し、**そのレイヤーの並びが階級ごと壊れる**（合成キーが null になる）。
 */
export const FRONT_SORTED_LAYERS: readonly FrontSortedLayer[] = [
  { id: 'quake-points', levelProp: 'scale' },
  { id: 'quake-region-label', levelProp: 'scale' },
  { id: 'quake-lpgm-points', levelProp: 'lgInt' },
  { id: 'quake-lpgm-region-label', levelProp: 'lgInt' },
  { id: 'kyoshin-detected', levelProp: 'index' },
]

/**
 * 方位の変化を並びへ反映する。**まだ地図に無いレイヤーは黙って飛ばす**
 * （モードごとに出入りするため、無いことは異常ではない）。
 *
 * **中身が変わらないなら書かない。** `setLayoutProperty` は `styledata` を発火させるので、
 * そのイベントを購読してこの関数を呼ぶ経路（レイヤーが後から足されたときの再適用）と組み合わせると
 * **書く→通知→書く の無限ループになる**。いま入っている式と突き合わせて、違うときだけ書く。
 */
export function applyFrontSortKeys(map: MapLibreMap, bearingDeg: number): void {
  for (const { id, levelProp } of FRONT_SORTED_LAYERS) {
    if (!map.getLayer(id)) continue
    const next = frontSortKeyExpression(levelProp, bearingDeg)
    const current = map.getLayoutProperty(id, 'symbol-sort-key')
    if (JSON.stringify(current) === JSON.stringify(next)) continue
    map.setLayoutProperty(id, 'symbol-sort-key', next)
  }
}

/**
 * 並びを作り直す方位の刻み（度）。
 *
 * 作り直すとシンボルの配置計算が走るので、回している間ずっと呼ぶのは重い。バッジの前後が
 * 入れ替わるのは方位が大きく動いたときだけなので、この刻みで足りる。
 */
export const BEARING_STEP_DEG = 5

/**
 * 前回反映した方位から、作り直すべきほど変わったか。
 *
 * **360 度の折り返しを跨いでも正しく測ること。** 359 度から 1 度への変化は 2 度であって
 * 358 度ではない。素朴な引き算だと、少し回しただけで毎回作り直す。
 */
export function bearingChangedEnough(prevDeg: number, nextDeg: number): boolean {
  const diff = Math.abs(((nextDeg - prevDeg + 540) % 360) - 180)
  return diff >= BEARING_STEP_DEG
}
