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
// 上の表の 2 行目・3 行目。**下 1 桁が主要動の状況**で、予報／警報とは独立した軸。
const EEW_ARRIVED_KIND_CODES = new Set(['01', '11'])
const EEW_PLUM_KIND_CODES = new Set(['09', '19'])

/** その区域が警報（強震動警戒域）の対象か。 */
export function isEewWarningKindCode(code: string): boolean {
  return EEW_WARNING_KIND_CODES.has(code)
}

/**
 * その区域で主要動が既に到達したと推定されているか（**種別コードから見た場合**）。
 *
 * **同じ事実を電文が 2 通りで伝えてくる。** このコードと、区域の `Condition`（「既に主要動
 * 到達と推測」。電文解説資料 Ⅱ.21 2-1-5-3-7）。DMDATA の電文では両方が同時に出る。
 *
 * **画面はこの関数を直接呼ばず、`isEewAreaArrived`（`utils/eew.ts`）を通すこと。**
 * 2 通りのどちらが来るかは経路で違う —— `Condition` を配信するのは DMDATA だけで、P2PQuake は
 * このコードでしか伝えてこない。**どちらか一方だけを見ると、その経路で到達済みの区域を取りこぼす。**
 */
export function isEewArrivedKindCode(code: string): boolean {
  return EEW_ARRIVED_KIND_CODES.has(code)
}

/**
 * その区域が PLUM 法で予測されているか。
 *
 * **この区域の `ArrivalTime` は到達予測時刻ではない。** 資料 Ⅱ.21 2-1-5-3-6 は
 * 「PLUM 法でその震度（階級震度）を初めて予測した時刻」と定めており、**過去の時刻**が入る。
 * 到達予想として並べると、既に過ぎた時刻を「これから来る」と読ませることになる。
 */
export function isEewPlumKindCode(code: string): boolean {
  return EEW_PLUM_KIND_CODES.has(code)
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
