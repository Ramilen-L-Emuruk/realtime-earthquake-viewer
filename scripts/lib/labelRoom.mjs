// 地名ラベルを代表点から上下へ退避させられる「余地」を、境界ポリゴンから計算する。
//
// build-subregions.mjs（一次細分区域）と build-prefectures.mjs（都道府県）の両方が使う。
// この 2 つだけを共有するのは、**どちらも 2026-08-23 のラベル退避の変更で同時に追加した同一実装**
// だから。
//
// 両スクリプトには toLatLng / dedupe / perpDist / simplify / normalizeRings も重複している。うち
// **相違があるのは simplify だけ**（再帰の組み立て方が違う。評価順は同じで結果は等価）で、他の 4 つは
// コメントを除いて完全一致している。それでも一括で見送ったのは、normalizeRings が内部で simplify を
// 呼ぶため単独では切り出せず、simplify の差異解消とセットになるから。**手を付けるなら simplify から**。
//
// 退避の使われ方は src/components/Map/gl/labelOverlap.ts、仕様は docs/spec/map-rendering-spec.md §5
// 「バッジとの重なりを避ける」を参照。

/**
 * 点がリング群の内側にあるか（偶奇規則）。
 *
 * `src/utils/geo.ts` の同名関数と同じ判定式で、引数の渡し方だけが違う。共有していないのは、
 * ビルドスクリプト（Node 単体実行・型チェックの対象外）からブラウザ側の TypeScript を読めないため。
 * grep で 2 つ出てきたときに「どちらが正か」を悩まなくて済むよう書き残しておく。
 */
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
 * 代表点そのものが領域の外に落ちる場合（大きく凹んだ形・離島の集まり）は、レイの最初の交点が
 * 「領域の入口」になり余地として使えないため `[0, 0]` を返す（退避させず、重なったら薄くする側へ倒す）。
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
  const round = (v) => (v === Infinity ? 0 : Math.round(v * 1000) / 1000)
  return [round(north), round(south)]
}
