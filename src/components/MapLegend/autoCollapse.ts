// 凡例を畳んだ状態から始めるかどうかを、地図領域の実寸から決める。
//
// **描画から切り出してあるのはテストで押さえるため。** 測るのは `App` に置いた ResizeObserver で、
// 判定だけをここへ置く（同じ判定を「描画の前に 1 回測る」経路と「以後の変化を追う」経路の
// 2 つが呼ぶので、書き写すと片方だけ古くなる）。

/**
 * これより地図が低ければ、畳んだ状態から始める（利用者が開閉すればその選択が優先される）。
 *
 * **画面の分け方に引いた線。** 上下分割のモバイル縦（地図 387px）を畳み、タブレット縦や
 * 左右分割（どちらもこれより高い）は開く。
 *
 * 根拠は占有率の実測。狭い画面では文字・余白・色見本をひと段詰めてあるが（`MapLegend` の
 * `compact`）、それでも開いた凡例は津波の 3 ブロックで 75px ＝ **地図 387px の 19%** を占め、
 * 震度や地震活動の密度が重なればさらに伸びる。畳めば 19px（5%）。
 *
 * **凡例の高さそのものを境目にしない。** 畳んだ状態の高さは中身によらずほぼ一定なので、
 * 中身ごとに境目を動かすと同じ画面で開いたり畳んだりを繰り返す。
 */
export const LEGEND_AUTO_COLLAPSE_MAP_HEIGHT_PX = 424

/**
 * 測った高さから「地図が低い」を決める。
 *
 * **`undefined` は「決めない」。** 0 は上下分割の折りたたみの途中などで来るので、そこで判定すると
 * 畳んだ状態へ引っ張られる。前の判定を据え置くために、偽ではなく `undefined` を返す。
 */
export function isMapAreaShort(height: number | undefined): boolean | undefined {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined
  return height < LEGEND_AUTO_COLLAPSE_MAP_HEIGHT_PX
}
