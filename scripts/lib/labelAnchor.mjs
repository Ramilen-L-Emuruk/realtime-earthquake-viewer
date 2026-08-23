// 地名ラベルをどこに置くか（代表点）と、そこから上下へどれだけ逃がせるか（余地）を、
// 境界ポリゴンから計算する。
//
// build-subregions.mjs（一次細分区域）と build-prefectures.mjs（都道府県）の両方が使う。
// 両スクリプトには toLatLng / dedupe / perpDist / simplify / normalizeRings も重複している。うち
// **相違があるのは simplify だけ**（再帰の組み立て方が違う。評価順は同じで結果は等価）で、他の 4 つは
// コメントを除いて完全一致している。それでも一括で見送っているのは、normalizeRings が内部で simplify を
// 呼ぶため単独では切り出せず、simplify の差異解消とセットになるから。**手を付けるなら simplify から**。
//
// 退避の使われ方は src/components/Map/gl/labelOverlap.ts、仕様は docs/spec/map-rendering-spec.md §5
// 「バッジとの重なりを避ける」を参照。

/** リングの符号付き面積の 2 倍（シューレース公式）。重心の計算と面積比較で共有する。 */
function doubleSignedArea(ring) {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [y0, x0] = ring[i]
    const [y1, x1] = ring[j]
    sum += x0 * y1 - x1 * y0
  }
  return sum
}

/**
 * 面積が最大のリングを返す。
 *
 * **点数ではなく面積で選ぶ。** 海岸線が細かく刻まれた小島は、本島より頂点数が多くなることがある
 * （小笠原・北海道利尻礼文で実際に起きていた）。ラベルを置きたいのは広い方なので面積で採る。
 *
 * 面積は緯度補正をしない平面近似。同じ領域の中に緯度の離れた島があるほど誤差が出る（東京都は本土と
 * 沖ノ鳥島で約 12%、北海道で約 7%、鹿児島県で約 5%、小笠原の父島と硫黄島で約 2%）。それでも補正を
 * 入れていないのは、**全 192 区域・47 県で選択が変わるのが小笠原の 1 件だけ**で、しかもその 1 件は
 * 補正を入れると悪くなるから——父島（27.07°N・平面積 0.00212）と硫黄島（24.78°N・同 0.00211）は
 * 0.5% 差で、補正すると人口のない硫黄島が選ばれる。0.5% 差の島を面積だけで裁くこと自体に無理があり、
 * 補正の有無で正しくなる問題ではない。
 *
 * ただし**上流データの簡素化が変われば選択は反転しうる**。小笠原のラベルが父島から動いたらここを
 * 疑うこと。緯度スパンの大きい東京都・北海道・鹿児島県も、島どうしの面積が近づけば同じ危うさを持つ。
 */
function largestRing(rings) {
  let largest = rings[0]
  let largestArea = Math.abs(doubleSignedArea(rings[0]))
  for (const ring of rings) {
    const area = Math.abs(doubleSignedArea(ring))
    if (area > largestArea) {
      largest = ring
      largestArea = area
    }
  }
  return largest
}

const round3 = (v) => Math.round(v * 1000) / 1000

/** リングの頂点平均。面積が求まらない退化した形（全点が一直線上など）のときだけ使う。 */
function vertexMean(ring) {
  const sum = ring.reduce((a, [lat, lon]) => [a[0] + lat, a[1] + lon], [0, 0])
  return [round3(sum[0] / ring.length), round3(sum[1] / ring.length)]
}

/**
 * ラベルを置く代表点 `[lat, lon]`。**面積最大のリングの面積重心**。
 *
 * 頂点の平均ではなく面積の重心を採る。頂点平均は「海岸線が細かく刻まれた側」へ引っ張られるため、
 * 同じ形でも測量データの粗密で位置が動いてしまう。
 *
 * **領域の内側に入ることは保証しない。** 湾を抱えた形（鹿児島県の錦江湾・石川県能登の七尾湾など）
 * では重心が水面に落ちるが、それでよい——県や区域として見れば湾の上こそ中心で、無理に陸地へ寄せると
 * かえって「その地域を指している」ように見えなくなる。内側を保証する方式（polylabel＝境界から最も
 * 遠い点）も試したが、細長い形や二股の形で端へ寄る欠点の方が大きかった（石川県が能登半島を捨てて
 * 加賀へ、宮崎県が北へ 30km、鹿児島県が薩摩半島の付け根へ動いた）。
 *
 * リングに穴（ドーナツ状の内側の輪）があっても除外しない。`normalizeRings` が外周と穴を区別せず
 * 平らな配列にしてしまうため、この関数からは判別できない。上流データで穴を持つのは山口県中部と
 * 沖縄県石垣島（およびそれを含む県）で、いずれも 500m 四方ほどと小さく、**現時点で代表点が穴の中に
 * 落ちている領域は無い**（全 192 区域・47 県で確認済み）。穴が大きくなれば重心が穴に入りうるが、
 * その場合も上の「内側は保証しない」と同じ扱いになる。
 */
export function labelAnchor(rings) {
  const ring = largestRing(rings)
  const a2 = doubleSignedArea(ring)
  if (a2 === 0) return vertexMean(ring)
  let cx = 0
  let cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [y0, x0] = ring[i]
    const [y1, x1] = ring[j]
    const f = x0 * y1 - x1 * y0
    cx += (x0 + x1) * f
    cy += (y0 + y1) * f
  }
  // 重心 = Σ(頂点の和 × 外積) / (3 × 符号付き面積の 2 倍)。a2 は既に「2 倍」なので分母は 3 * a2。
  return [round3(cy / (3 * a2)), round3(cx / (3 * a2))]
}

/** 点がリング群の内側にあるか（偶奇規則）。 */
function pointInRings(rings, [lat, lon]) {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i]
      const [yj, xj] = ring[j]
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/**
 * 代表点から真北・真南へ進んだとき、領域（区域・県）の外へ出るまでの距離（緯度差の度数）を
 * `[北, 南]` で返す。
 *
 * 描画側はラベルが震度バッジと重なったとき上下へ退避させるが、その退避で領域の外まで文字が飛ぶと
 * 「隣の区域に別の区域名が乗っている」状態になる。ここで焼いた余地を上限として、収まる方向へだけ
 * 退避させる。
 *
 * **代表点が領域の外にある場合は `[0, 0]`**（退避させず、重なったら薄くする側へ倒す）。湾を抱えた
 * 形では代表点が水面に落ちる（`labelAnchor` 参照）ため、この分岐は実際に使われる。レイの最初の交点が
 * 「領域の入口」になってしまい、余地として意味を成さないため。
 */
export function shiftRoom(rings, label) {
  const [lat0, lon0] = label
  if (!pointInRings(rings, label)) return [0, 0]
  let north = Infinity
  let south = Infinity
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [y1, x1] = ring[i]
      const [y2, x2] = ring[j]
      // 経度 lon0 の子午線を跨ぐ辺だけが交点を持つ。
      if (x1 > lon0 === x2 > lon0) continue
      const lat = y1 + ((lon0 - x1) / (x2 - x1)) * (y2 - y1)
      if (lat > lat0) north = Math.min(north, lat - lat0)
      else south = Math.min(south, lat0 - lat)
    }
  }
  const round = (v) => (v === Infinity ? 0 : round3(v))
  return [round(north), round(south)]
}
