import type { JMAEstimatedIntensity } from '../../../types/earthquake'
import { buildSiToScale } from '../../../utils/estimatedIntensity'
import { getIntensityColor } from '../../../utils/intensity'
import { mercatorY } from '../../../utils/isoseismal'

// 推計震度分布図（IXAC41）を GPU へ渡す形へ落とす。描画側は gl/estimatedIntensityLayer.ts。
//
// **ここで作るのは「色」ではなく「値」。** 計測震度をそのままテクスチャへ入れ、階級への写しと
// 色付けはフラグメントシェーダーが引く（凡例も同じテクスチャの組で渡す）。理由は 2 つ。
//
// 1. **階級の境目が画面の画素で立つ。** 色を焼いてから引き伸ばすと、線形補間が階級の境界を
//    混ぜてしまう（震度5弱と5強のあいだに両者の中間色の帯ができる）。値を補間してから階級へ
//    写せば、境界は等値線として画素単位で出る
// 2. **メッシュの矩形は立たない。** 値の側は線形に補間されるので、セル境界に段は出ない。
//    気象庁が「メッシュの境界線を強調してもあまり意味がありません」と書いている求めに沿う
//    （出典は docs/spec/map-rendering-spec.md §19）
//
// **テクスチャは緯度経度で等間隔。** 貼り付け先（Mercator 空間）の非線形さは頂点の位置が
// 吸収する（`buildEstimatedIntensityMesh` が格子を細かく割るのはこのため）。canvas source へ
// 焼いていた頃は「4 隅を Mercator 空間へ線形に貼る」制約があったため格子を Mercator 等間隔に
// 取っていたが、その制約はもう無い。セルと画素を 1 対 1 に揃えられるのでテクスチャが最小になる。

/** 計測震度（0.1 単位の整数）の幅。電文の場が 7 ビットなので 0〜127。凡例テクスチャの幅もこれ。 */
export const SI_RANGE = 128

/**
 * 面を貼る格子の分割数（縦横それぞれ）。頂点は (N+1)² 個。
 *
 * **緯度と Mercator 座標の関係は非線形**なので、頂点のあいだは線形近似になる。分割を粗くすると
 * 面が南北にずれる。緯度幅 10 度（実電文で観測された最大の分布より広い）を 48 分割したときの
 * 近似誤差は、北緯 35 度でセル 1 つの 1/30 ほど（250m に対して 8m）。**高緯度ほど大きくなり**、
 * 北緯 45 度では 1/22（11m）。球で表示しているときの曲率による歪みも、頂点間が 23km 程度なら
 * 画素以下。
 *
 * 頂点数は 2401 で、索引は Uint16 に収まる（`buildEstimatedIntensityMesh` がそれを前提にする）。
 */
export const MESH_DIVISIONS = 48

/** テクスチャの上限として受け付ける最小値。極端に小さい値を渡されても焼けるようにする。 */
const MIN_TEXTURE_SIZE = 16

/**
 * 分布の外周へ足す余白（画素）。
 *
 * `spreadValues` が値を広げる先と、線形補間で縁を切る場所になる。**画素で数える**——
 * 度やセルの数で取ると、上限に収めるため縮めた画で 1 画素に満たなくなる。
 */
const PAD_PX = 1

export interface EstimatedIntensityRaster {
  width: number
  height: number
  /**
   * RG8 の画素。R が計測震度（0.1 単位の整数）、G が 255 なら「セルがある」。
   *
   * **G は縁を切るために要る。** R だけだと、値の無いところ（0）が線形補間で混ざり、
   * 分布の縁で階級が 1 段落ちる。G を線形補間して 0.5 未満を捨てれば、縁はセル境界で切れる。
   */
  pixels: Uint8Array
  /** 貼る範囲（度）。セルの外接矩形を余白 1 セル分だけ広げたもの。 */
  west: number
  east: number
  south: number
  north: number
  /** 上限に収めるために縮めたか（セルと画素が 1 対 1 でなくなる）。 */
  scaled: boolean
  /** セルがある画素の数。0 なら描くものが無い。 */
  painted: number
  /** そのうち凡例で色が付く画素の数。`painted` が正なのにこれが 0 なら凡例と噛み合っていない。 */
  colored: number
  /** 計測震度 → 階級の色（RGBA・幅 `SI_RANGE`・高さ 1）。凡例に無い値は透明。 */
  legend: Uint8Array
}

function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/**
 * 値の無い画素へ、隣り合う画素の最も大きい計測震度を 1 画素だけ広げる。
 *
 * **有効フラグ（G）は広げない。** 広げるのは R だけで、描くかどうかは G が決める。これで
 * 縁の外側にも「補間の材料になる値」が置かれ、分布の縁で階級が落ちなくなる。
 *
 * **元の状態を控える必要はない。** 書き込むのは G が 0 の画素だけで、判定に使うのは
 * 「隣の G が 0 でないこと」。書き込んだ画素は G が 0 のままなので、次の画素の判定では
 * 参照されない——広げた値が連鎖して外へ伸びていくことはない。
 */
function spreadValues(pixels: Uint8Array, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 2
      if (pixels[k + 1] !== 0) continue
      let best = 0
      // 斜めも見る。線形補間は 2x2 の画素を混ぜるので、斜めにしか隣接しない画素も材料になる。
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const nk = (ny * width + nx) * 2
          if (pixels[nk + 1] === 0) continue
          if (pixels[nk] > best) best = pixels[nk]
        }
      }
      if (best > 0) pixels[k] = best
    }
  }
}

/**
 * 電文のセルをテクスチャへ焼く。**セル 1 つが画素 1 つ**になる解像度を取り、上限を超える場合だけ縮める。
 *
 * 縮めた画では 1 画素へ複数のセルが重なる。そのときは**最も大きい計測震度を残す**——後勝ちに
 * すると「強く揺れた狭い範囲」が隣のセルに上書きされて消える。
 *
 * @param maxTextureSize テクスチャの 1 辺の上限（GPU の `MAX_TEXTURE_SIZE` と自前の上限の小さいほう）
 * @returns 焼けなければ null（セルが無い・範囲が退化している）
 */
export function rasterizeEstimatedIntensity(
  data: JMAEstimatedIntensity,
  maxTextureSize: number,
): EstimatedIntensityRaster | null {
  if (data.count <= 0) return null
  const b = data.bounds
  // 比較は NaN に対しても偽になるので、値が壊れている場合もここで捕まる。
  if (!(b.east > b.west) || !(b.north > b.south)) return null

  // セル 1 つが画素 1 つになる寸法（余白を含まない）。
  // **寸法は電文が持っているものを使う** —— モジュール定数から引くと、IXAC40（1km メッシュ）で
  // 4 倍細かい格子を取り、上限への縮小が無用に掛かる。
  let innerWidth = Math.max(1, Math.round((b.east - b.west) / data.cellLonDeg))
  let innerHeight = Math.max(1, Math.round((b.north - b.south) / data.cellLatDeg))
  let scaled = false
  const cap = Math.max(MIN_TEXTURE_SIZE, Math.floor(maxTextureSize))
  // **余白のぶんを引いた上限に収める。** 縮めた後で余白を足すので、上限を越えない。
  const innerCap = Math.max(1, cap - 2 * PAD_PX)
  const longest = Math.max(innerWidth, innerHeight)
  if (longest > innerCap) {
    const k = innerCap / longest
    innerWidth = Math.max(1, Math.floor(innerWidth * k))
    innerHeight = Math.max(1, Math.floor(innerHeight * k))
    scaled = true
  }
  const width = innerWidth + 2 * PAD_PX
  const height = innerHeight + 2 * PAD_PX

  // 縁の外へ余白を取る。`spreadValues` が値を広げる余地と、線形補間で縁を半画素外側まで
  // 滑らかに切るための場所になる。
  //
  // **測るのは「縮めた後の画素 1 つ分」で、セル 1 つ分ではない。** 等倍なら両者は一致するが、
  // 上限に収めるため縮めた画では画素がセルより粗くなる。セルの幅で取ると余白が 1 画素に
  // 満たなくなり、いちばん広い分布（＝縮める分布）でだけ縁の手当てが効かなくなる。
  const pxLon = (b.east - b.west) / innerWidth
  const pxLat = (b.north - b.south) / innerHeight
  const west = b.west - PAD_PX * pxLon
  const east = b.east + PAD_PX * pxLon
  const south = b.south - PAD_PX * pxLat
  const north = b.north + PAD_PX * pxLat

  const pixels = new Uint8Array(width * height * 2)
  const sx = width / (east - west)
  const sy = height / (north - south)
  let painted = 0

  // **セル中心が入る画素を 1 つだけ塗る。** 画素はセルと同じか粗いので（`width` はセル数以下）、
  // 1 セルが複数画素へまたがることは原理的に無い。縁を境界で計算すると、電文の座標が
  // `Float32Array` で持たれているぶんの丸め（1 セルの 1/1000 ほど）で 1 画素はみ出し、
  // 分布が半セル分だけ広がる。中心なら許容誤差が半画素あるので、その丸めでは動かない。
  //
  // 縮めた画で 1 セルが 1 画素に満たなくても、中心の画素は必ず塗られる（潰れて消えない）。
  const halfLon = data.cellLonDeg / 2
  const halfLat = data.cellLatDeg / 2
  for (let i = 0; i < data.count; i++) {
    const v = data.si[i]
    // 計測震度 0 は「セルが無い」と区別できない。震度4未満はそもそも配信されないので、
    // 塗る対象が無いものとして落とす。
    if (v === 0) continue
    const x = Math.floor((data.lon[i] + halfLon - west) * sx)
    // 画像の y は北が 0。
    const y = Math.floor((north - (data.lat[i] + halfLat)) * sy)
    if (x < 0 || x >= width || y < 0 || y >= height) continue
    const k = (y * width + x) * 2
    if (pixels[k + 1] === 0) painted++
    if (v > pixels[k]) pixels[k] = v
    pixels[k + 1] = 255
  }

  // **凡例は電文が持っているものを使う。** 自前の階級表を当てると、気象庁が境界を見直したときに
  // 画面だけが古い区切りで塗られる（`utils/estimatedIntensity.ts` の `buildSiToScale`）。
  const siToScale = buildSiToScale(data.grades)
  let colored = 0
  for (let i = 0; i < width * height; i++) {
    if (pixels[i * 2 + 1] === 0) continue
    const si = pixels[i * 2]
    // 場は 7 ビットなので 128 以上は現れないが、復号が壊れた場合に索引の外を引かないようにする。
    if (si >= SI_RANGE) continue
    if (siToScale[si] !== 0) colored++
  }

  const legend = new Uint8Array(SI_RANGE * 4)
  for (let si = 0; si < SI_RANGE; si++) {
    const scale = siToScale[si]
    if (scale === 0) continue
    const [r, g, bl] = hexToRgb(getIntensityColor(scale))
    const o = si * 4
    legend[o] = r
    legend[o + 1] = g
    legend[o + 2] = bl
    legend[o + 3] = 255
  }

  spreadValues(pixels, width, height)

  return { width, height, pixels, west, east, south, north, scaled, painted, colored, legend }
}

export interface EstimatedIntensityMesh {
  /** 頂点の Mercator 座標（x, y）。`projectTile` へそのまま渡せる。 */
  positions: Float32Array
  /** 頂点のテクスチャ座標（u, v）。等間隔。 */
  uvs: Float32Array
  indices: Uint16Array
  vertexCount: number
}

/**
 * 面を貼る格子を作る。**頂点は緯度経度で等分**し、そこから Mercator 座標へ写す。
 *
 * テクスチャ座標を等間隔にできるのは、テクスチャ側も緯度経度で等間隔だから
 * （`rasterizeEstimatedIntensity`）。緯度と Mercator 座標の非線形さは、頂点をこの密度で
 * 置くことで吸収する（`MESH_DIVISIONS` を参照）。
 */
export function buildEstimatedIntensityMesh(range: {
  west: number
  east: number
  south: number
  north: number
}): EstimatedIntensityMesh {
  const n = MESH_DIVISIONS
  const side = n + 1
  const vertexCount = side * side
  const positions = new Float32Array(vertexCount * 2)
  const uvs = new Float32Array(vertexCount * 2)
  for (let j = 0; j < side; j++) {
    const v = j / n
    const lat = range.north + (range.south - range.north) * v
    const y = mercatorY(lat)
    for (let i = 0; i < side; i++) {
      const u = i / n
      const lon = range.west + (range.east - range.west) * u
      const k = (j * side + i) * 2
      // Mercator の x は経度に線形（MapLibre の MercatorCoordinate.fromLngLat と同じ式）。
      positions[k] = (lon + 180) / 360
      positions[k + 1] = y
      uvs[k] = u
      uvs[k + 1] = v
    }
  }
  const indices = new Uint16Array(n * n * 6)
  let p = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i
      const bb = a + 1
      const c = a + side
      const d = c + 1
      indices[p++] = a
      indices[p++] = c
      indices[p++] = bb
      indices[p++] = bb
      indices[p++] = c
      indices[p++] = d
    }
  }
  return { positions, uvs, indices, vertexCount }
}
