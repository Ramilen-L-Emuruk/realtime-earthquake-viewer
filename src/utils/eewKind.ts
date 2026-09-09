/**
 * 緊急地震速報の種別コード（`Category/Kind/Code`。気象庁コード表 12「緊急地震速報」）。
 *
 * | コード | 種別 | 主要動 |
 * |---|---|---|
 * | 00 / 10 | 予報 / 警報 | 未到達と予想 |
 * | 01 / 11 | 予報 / 警報 | 既に到達と推定 |
 * | 09 / 19 | 予報 / 警報 | 到達予測なし（PLUM 法による予測） |
 *
 * **名前（`Kind/Name`）ではなくコードで見る。** どちらも同じ事実を表すが、名前は表記が
 * 変われば一致しなくなる。
 *
 * **同じ判定を書き分けない。** 「その区域は警報の対象か」という 1 つの事実を、電文の解釈は
 * 名前で、地図の塗り分けと画面の県名の振り分けはコードの列挙で、それぞれ別に判定していた。
 * 表現が違うぶん、片方だけ直せば静かにずれる。
 *
 * 依存を持たないのは、電文パーサーからも画面からも呼ぶため。
 */
const EEW_WARNING_KIND_CODES = new Set(['10', '11', '19'])
const EEW_FORECAST_KIND_CODES = new Set(['00', '01', '09'])

/** その区域が警報（強震動警戒域）の対象か。 */
export function isEewWarningKindCode(code: string): boolean {
  return EEW_WARNING_KIND_CODES.has(code)
}

/**
 * その区域が予報の対象か。
 *
 * **コード表に無い値はどちらでもない。** 「警報でない＝予報」と書くと、コード表が増えた
 * ときに未知の値が黙って予報として通る。呼び出し側で控えの判定へ落とせるよう、
 * 予報かどうかも明示的に問える形にしておく。
 */
export function isEewForecastKindCode(code: string): boolean {
  return EEW_FORECAST_KIND_CODES.has(code)
}
