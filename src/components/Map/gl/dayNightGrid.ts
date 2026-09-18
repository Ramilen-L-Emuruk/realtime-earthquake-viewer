// 夜の側を描くための格子。全球を覆う三角形の網で、**時刻に依存しないので一度だけ作る**。
//
// 夜の濃さはフラグメントごとに太陽高度から計算する（gl/dayNightLayer.ts）。この格子が運ぶのは
// 「その頂点の経度緯度」だけで、面の形そのものは太陽の位置と無関係。**日付変更線の跨ぎや極の
// 包含を扱う必要がない**のはこのため —— 濃さの式に入る `cos(経度 - 太陽の経度)` は周期関数で、
// 経度を畳む処理が要らない。
//
// **覆う範囲は極まで伸ばす。** MapLibre は球で描くときも Mercator のタイルを球面へ貼るが、
// 最上端・最下端のタイル行を極まで引き延ばすため、Mercator が表せる範囲（緯度 ±85.051129°）の
// 外側にも地形が描かれている。そこで切ると極の周りだけ夜が掛からず、境目に緯線の直線が出る。

/** Mercator が表せる緯度の限界（度）。これより極側は Mercator 座標が発散する。 */
export const MERCATOR_MAX_LAT = 85.051129

/**
 * 極側の端の緯度（度）。
 *
 * 緯度 90° そのものは Mercator の y が発散するので、そこへ十分近いところで止める
 * （89.99° の y は約 -0.83 で有限）。残る隙間は極点から 1km ほどの円。
 */
export const POLAR_EDGE_LAT = 89.99

/**
 * 極冠（Mercator の限界から極側の端まで）の分割数。
 *
 * **この区間は緯度に対して Mercator の y が急に伸びるので、内側と同じ刻み幅では足りない。**
 * フラグメントへ渡る緯度は y に対して線形に補われるため、誤差は「y の中点における真の緯度との
 * 差」で測れる。内側（2° 弱の刻み）の最大は 0.083°（緯度 85 付近）で、極冠を同じ数だけ刻むと
 * 最外周で 0.52° まで開く。段数で詰めるとこう動く。
 *
 * | 段数 | 極冠の最大誤差 | 内側比 | 頂点数 |
 * |---|---|---|---|
 * | 4 | 0.516° | 6.2 倍 | 17,195 |
 * | 8 | 0.240° | 2.9 倍 | 18,643 |
 * | 16 | 0.108° | 1.3 倍 | 21,539 |
 * | 20 | 0.083° | 1.0 倍 | 22,987 |
 *
 * **20 段で内側と並ぶ。** 増えるのは頂点だけ（上限 65,536 の 35%）で、描画の重さは塗った画素の
 * 数で決まるため実質変わらない。**`y` で等間隔に刻む案は逆に悪くなる**（内側寄りの 1 段が緯度で
 * 3.9° も開き、最大 0.72°）。
 */
const POLAR_STEPS = 20

/**
 * 経度方向の分割数。360° を割るので 180 なら 2° 刻み。
 *
 * 経度は Mercator の x に線形に対応するため、**フラグメントへ渡る経度に補間の誤差が出ない**。
 * 刻みが効くのは球で描くときの三角形の丸みだけ。
 */
const LON_STEPS = 180

/**
 * 緯度方向の分割数。
 *
 * 緯度は Mercator の y に対して非線形なので、三角形の中で緯度を線形に補うと真の値からずれる。
 * ずれは刻みの 2 乗で縮み、2° 弱の刻みでは 0.01° 程度 —— 日の入りから天文薄明までの 17° に
 * 対して無視できる。
 */
const LAT_STEPS = 86

/** 頂点 1 つあたりの float 数（Mercator の x・y と、経度・緯度）。 */
export const FLOATS_PER_VERTEX = 4

export interface DayNightGrid {
  /** `[mercatorX, mercatorY, 経度, 緯度]` を頂点ぶん並べたもの。 */
  vertices: Float32Array
  /** 三角形を作る頂点の並び。 */
  indices: Uint16Array
  vertexCount: number
  indexCount: number
}

/** 緯度（度）を Mercator の y（0〜1・北が 0）へ。 */
function mercatorY(latDeg: number): number {
  const lat = (latDeg * Math.PI) / 180
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)
}

/**
 * 格子の各行の緯度（度）を、北から南へ並べて返す。
 *
 * Mercator が表せる範囲は等間隔に刻み、その外側（極冠）だけ別の刻みで繋ぐ。
 */
function rowLatitudes(): number[] {
  const lats: number[] = []
  const polarSpan = POLAR_EDGE_LAT - MERCATOR_MAX_LAT
  // 北の極冠。限界そのものは次のループが置くので、ここでは手前までにする。
  for (let i = 0; i < POLAR_STEPS; i++) lats.push(POLAR_EDGE_LAT - (polarSpan * i) / POLAR_STEPS)
  // Mercator が表せる範囲（北から南へ）。
  for (let row = 0; row <= LAT_STEPS; row++) {
    lats.push(MERCATOR_MAX_LAT - (2 * MERCATOR_MAX_LAT * row) / LAT_STEPS)
  }
  // 南の極冠。限界は上のループが置いたので 1 つ外から始める。
  for (let i = 1; i <= POLAR_STEPS; i++) lats.push(-MERCATOR_MAX_LAT - (polarSpan * i) / POLAR_STEPS)
  return lats
}

/**
 * 全球を覆う三角形の網を作る。
 *
 * 頂点は経度 ±180・緯度 ±{@link POLAR_EDGE_LAT} の格子。**経度 -180 と 180 の両端に頂点を置く**
 * ので、日付変更線のところで隙間ができない。
 */
export function buildDayNightGrid(): DayNightGrid {
  const cols = LON_STEPS + 1
  const lats = rowLatitudes()
  const rows = lats.length
  const vertexCount = cols * rows
  // Uint16 の index では 65,536 頂点までしか指せない。格子を細かくするときはここで気づけるよう
  // 明示的に確かめる（超えたら Uint32Array と OES_element_index_uint 相当の対応が必要）。
  if (vertexCount > 65536) {
    throw new Error(`[day-night] 格子の頂点数 ${vertexCount} が Uint16 index の上限を超えています`)
  }

  const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX)
  let v = 0
  for (let row = 0; row < rows; row++) {
    // 北（+89.99）から南（-89.99）へ。Mercator の y と同じ向きに並べる。
    const lat = lats[row]
    // **y は 0〜1 へ丸めない。** 極冠の頂点はその範囲の外（北が負・南が 1 超）に出るのが正しく、
    // 丸めると極の帯がぺったり潰れて Mercator の限界と同じ場所へ重なる。
    const y = mercatorY(lat)
    for (let col = 0; col < cols; col++) {
      const lon = -180 + (360 * col) / LON_STEPS
      vertices[v++] = col / LON_STEPS
      vertices[v++] = y
      vertices[v++] = lon
      vertices[v++] = lat
    }
  }

  const indices = new Uint16Array(LON_STEPS * (rows - 1) * 6)
  let i = 0
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < LON_STEPS; col++) {
      const topLeft = row * cols + col
      const topRight = topLeft + 1
      const bottomLeft = topLeft + cols
      const bottomRight = bottomLeft + 1
      indices[i++] = topLeft
      indices[i++] = bottomLeft
      indices[i++] = topRight
      indices[i++] = topRight
      indices[i++] = bottomLeft
      indices[i++] = bottomRight
    }
  }

  return { vertices, indices, vertexCount, indexCount: indices.length }
}
