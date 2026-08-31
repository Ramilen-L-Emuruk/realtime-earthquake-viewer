// 行動チェックリストを出すかどうかの判定。
//
// 【3 つの経路】揺れを知る手段が 3 つあり、どれで気づくかは状況で変わる。
//   - EEW … 揺れる前。予想震度は一次細分区域単位でしか出ないので、区域名で照合する
//   - 強震モニタ … 揺れている最中。検知エンジンが確定した観測点のリアルタイム震度を見る
//     （EEW が間に合わない直下型ではこれが最初の手がかりになる。ただし確定を待つぶん、生の
//     観測値が閾値を超えた瞬間よりは遅れる）
//   - 地震情報 … 揺れが収まった後。気象庁が確定させた観測点別の震度
//
// 【返すのは震度】3 つとも「閾値に達していればその範囲での最大震度、達していなければ `null`」を
// 返す。真偽だけを返すと、呼び出し側が表示に使う震度を別途組み立てることになり、**判定した範囲と
// 表示する震度がずれる**（自宅の区域で判定したのに全国の最大震度をバッジに出す、など）。
//
// 【位置を持つ意味】ホーム地点があれば「自分のいる場所が揺れたか」で判定できる。無ければ地域で
// 絞れないので全国のどこかが閾値に達したかで判定する（＝出る回数は増えるが、出ないよりよい）。
//
// 【半径内に有効な点が無いとき】離島など観測点が届かない場所では、位置があっても判定できない。
// その場合は**位置なしと同じ扱いに倒す**。「近くに点が無いから出さない」は、まさに情報が要る人に
// 出さない結果になる。
//
// **「近くに観測点が無い」と「近くの観測点が揺れていない」は別物。** 後者を前者として扱うと、
// 遠方の地震で毎回出ることになり、地点を登録した意味が消える。地震情報では電文の点を 1 件でも
// 引けるかで見分け（`recognizesTelegram`）、強震モニタでは半径内の観測点が検知エンジンの
// 確定メンバーに入っているかで見分ける。
//
// 【壊れた震度は見なかったことにする】電文の震度階級は実地震テストシナリオの手書き JSON など
// 型検査を通らない経路からも来る（`eew.ts` の `eewMaxScaleInfo` も同じ理由で実行時に弾いている）。
// 階級表に無い値は判定にも表示にも使わない。結果として半径内の点が 1 つも残らなければ、
// 上の規則どおり全国基準へ倒れる。

import type { EEWAlert, JMAQuake } from '../types/earthquake'
import { eewAreas, eewMaxScale } from './eew'
import { isValidIntensityScale } from './intensity'
import type { DetectedPoint } from './kyoshinDetectionView'
import { kyoshinIndexToJma } from './kyoshinIntensity'

/** 判定に使う「自宅の周り」。半径内に何も無ければ空になり、その場合は全国基準へ倒す。 */
export interface NearbyScope {
  /** 強震モニタの観測点キー（`computeSiteKeys` 由来。検知エンジンのメンバーと突き合わせる）。 */
  kyoshinKeys: ReadonlySet<string>
  /**
   * 気象庁の観測点名（県名を含めない）。
   *
   * DMDATA の電文は `pref` を空で積むため、"県|観測点名" の形では突き合わせられない
   * （`nearbyStationNames` の説明を参照）。
   */
  stationNames: ReadonlySet<string>
  /** 半径内の観測点が属する一次細分区域名。 */
  regionNames: ReadonlySet<string>
  /**
   * こちらの索引が知っている**すべての**観測点名・区域名（半径で絞らない）。
   *
   * 「半径内の点が電文に載っていない」の意味を決めるために持つ。**これが無いと
   * 「近所は揺れていない」と「電文の粒度が索引と噛み合っていない」を見分けられない**
   * （詳しくは `quakeScaleForScope`）。地域を絞れないときは使われないので空でよい。
   */
  knownStationNames: ReadonlySet<string>
  knownRegionNames: ReadonlySet<string>
}

/** 位置を持たない（または半径内に観測点が無い）ことを表す。全国基準で判定する。 */
export const NO_SCOPE: NearbyScope = {
  kyoshinKeys: new Set(),
  stationNames: new Set(),
  regionNames: new Set(),
  knownStationNames: new Set(),
  knownRegionNames: new Set(),
}

/** その `scope` で地域を絞れるか。3 つとも空なら絞れない＝全国基準へ倒す。 */
export function hasNearby(scope: NearbyScope): boolean {
  return scope.kyoshinKeys.size > 0 || scope.stationNames.size > 0 || scope.regionNames.size > 0
}

/** 閾値そのものが妥当か。「出さない」（負値）と階級表に無い値を弾く。 */
function isUsableThreshold(minScale: number): boolean {
  return isValidIntensityScale(minScale) && minScale >= 0
}

/**
 * 地震情報が閾値に達しているか。達していればその範囲での最大震度を返す。
 *
 * 地域を絞れるときは半径内の観測点、絞れないときは電文の最大震度を見る。
 *
 * **観測点の点と区域の点の両方を見る。** 震度速報（VXSE51）は区域別震度しか持たず
 * （[quake-spec.md](../../docs/spec/quake-spec.md) §4）、多くの地震で最初に届く報がこれ。
 * 観測点だけを見ると、地点を登録している人ほど**震度速報だけで終わる地震で何も出ない**という
 * 逆転が起きる。区域の点は半径内の観測点が属する区域（`regionNames`）と突き合わせる。
 *
 * それでも 1 件も引き当てられなかったときは**全国基準へ倒す**。「絞れているのに該当する点が
 * 見つからない」のは電文の粒度がこちらの持つ索引と噛み合っていないだけで、揺れが無い証明では
 * ないため。この機能は出さないことの方が重い。
 */
export function quakeScaleForScope(
  quake: JMAQuake,
  scope: NearbyScope,
  minScale: number,
): number | null {
  if (!isUsableThreshold(minScale)) return null
  const nationwide = () => {
    const max = quake.earthquake.maxScale
    return isValidIntensityScale(max) && max >= minScale ? max : null
  }
  if (!hasNearby(scope)) return nationwide()

  let matched = false
  let max: number | null = null
  for (const p of quake.points ?? []) {
    // `pref` は見ない。DMDATA は常に空、P2PQuake は非空という非対称があるため、
    // 名前だけで引き当てる（`nearbyStationNames` / `nearbyRegionNames` も名前で持つ）。
    const inScope = p.isArea
      ? scope.regionNames.has(p.addr)
      : scope.stationNames.has(p.addr)
    if (!inScope) continue
    // 壊れた震度は「その点を観測できなかった」ものとして扱う。matched に数えると、
    // 有効な点が 1 つも無い電文で全国基準へ倒れなくなる（黙って出なくなる）。
    if (!isValidIntensityScale(p.scale)) continue
    matched = true
    if (p.scale >= minScale && (max == null || p.scale > max)) max = p.scale
  }
  // 半径内に該当する点が 1 つも無かったときの読み方は 2 通りある。
  //
  //   (a) 近所は電文に載るほど揺れていない  … 出さないのが正しい
  //   (b) 電文の粒度がこちらの索引と噛み合っていない … 判定できないので全国基準へ倒す
  //
  // 見分けは「その電文の点を 1 件でも引けるか」で付く（`recognizesTelegram`）。
  // **(a) を (b) として扱うと遠方の地震で毎回出る。** `points` には震度1以上を観測した観測点
  // （震度速報は震度3以上の区域）しか載らないので、自宅の周りが無感なら 0 件になるのが普通。
  // そこで全国基準へ倒すと「地点を登録していればその周辺で判定する」が成り立たない
  // （実測: 2018 年大阪府北部地震を東京の地点で受けると、最初に届く震度速報 3 本がいずれも
  // 0 件になり、全国基準で震度6弱として出る）。
  if (!matched) {
    if (!recognizesTelegram(quake, scope)) return nationwide()
    // 「載っていない」から言えることは電文の粒度で決まる。**言えない場合は倒す。**
    //
    // 観測点の点を持つ電文なら「載っていない＝震度1未満」なので、閾値がいくつでも出さなくてよい。
    // 区域しか持たない電文（震度速報）で言えるのは「震度3未満」までなので、閾値がそれより低いと
    // 判定できない。**そこで判定を保留すると、その地震は二度と評価されないことがある** ——
    // 見るのは常に最新の 1 件（`earthquakes[0]`・発生時刻の新しい順）なので、観測点を載せた続報が
    // 届く前に別の地震が起きると、古い方は先頭へ戻れない。
    const hasStationPoint = (quake.points ?? []).some(p => !p.isArea && isValidIntensityScale(p.scale))
    if (!hasStationPoint && minScale < AREA_REPORT_FLOOR) return nationwide()
    return null
  }
  return max
}

/**
 * 区域しか持たない電文（震度速報）が載せる下限の震度。
 *
 * 震度速報は震度3以上の区域だけを載せる（[quake-spec.md](../../docs/spec/quake-spec.md) §4）。
 * 収録済みの実電文（2016 熊本・2018 大阪府北部・2018 胆振東部・2024 能登・2024 日向灘）でも、
 * 震度速報に現れた最小の階級は震度3、観測点を持つ詳細報は震度1 だった。
 */
const AREA_REPORT_FLOOR = 30

/**
 * その電文に載っている点を、こちらの索引が 1 件でも引けるか。
 *
 * 引けるなら索引は生きているので、自宅の周りが載っていないのは「載るほど揺れていない」から。
 *
 * ここで判るのは索引が生きていることだけ。**「載っていない」から何が言えるかは電文の粒度で
 * 決まる**ので、その判断は呼び出し側で行う（`AREA_REPORT_FLOOR`）。
 */
function recognizesTelegram(quake: JMAQuake, scope: NearbyScope): boolean {
  return (quake.points ?? []).some(p => (
    // 壊れた震度の点は上の走査で「観測できなかった」ものとして飛ばしている。ここでも同じ扱いに
    // しないと、値の使えない点だけで「粒度は噛み合っている」と結論して黙って出なくなる。
    isValidIntensityScale(p.scale)
    && (p.isArea ? scope.knownRegionNames.has(p.addr) : scope.knownStationNames.has(p.addr))
  ))
}

/**
 * 強震モニタが閾値に達しているか。達していればその範囲での最大震度を返す。
 *
 * **見るのは検知エンジンが確定（confirmed）と判断した観測点だけ。** 音・自動タブ切替・地図の
 * 検知点はすべてエンジンの結果で動いており、ここだけが生の観測値を走査していた。機器の異常など
 * 地震ではない跳ね上がりは近傍の点が揃わないので、エンジンを通せばメンバーに入らない。
 *
 * **ただし発表震度とのずれはこれで消えない。** リアルタイム震度は 1〜2 秒の窓で出す速報値で、
 * 揺れの継続時間まで見る計測震度より高く振れる。実データ 793 窓の再生では、既定の閾値で帯が出る
 * 22 窓のうち 16 窓が気象庁の発表より高い震度になり、その値はエンジンを通しても変わらなかった
 * （跳ね上がっていたのは震源直上の観測点で、ノイズではなく本物の観測値だったため。発表が震度1 の
 * 地震の震源から 8km で 5弱相当、発表6強 の地震で震度7相当）。この数字を発表震度として読ませない
 * のは表示側の仕事で、`ActionChecklist` がこの経路だけ指標名を明示する。
 *
 * 渡す点は `deriveKyoshinView` が解決したもの（音・地図の検知点と同じ集合）。値は欠測の瞬断を
 * 直前値で埋めた保持値で、これはこのアプリの規約（kyoshin-detection-spec.md §8）。
 */
export function kyoshinScaleForScope(
  points: readonly DetectedPoint[],
  scope: NearbyScope,
  minScale: number,
): number | null {
  if (!isUsableThreshold(minScale)) return null
  // 確定した揺れが無ければ、値の高い点があっても出さない。
  if (points.length === 0) return null
  const scanAll = () => scanPoints(points, minScale, null).max
  // 半径内に強震モニタの観測点が 1 つも無ければ絞れないので、確定メンバー全体で見る（地点が
  // 未登録の場合と、登録されていても近くに観測点が無い離島などの両方がここに入る）。
  if (scope.kyoshinKeys.size === 0) return scanAll()
  const near = scanPoints(points, minScale, scope.kyoshinKeys)
  // 半径内に確定メンバーが 1 つも無い＝「近所は揺れていない」。ここで全国基準へ倒すと、遠方の
  // 地震で毎回出ることになり、地点を登録した意味が消える。
  if (near.count === 0) return null
  // **メンバーはあるのに 1 点も値を読めなかったときは全国基準へ倒す。** 大きな地震では近くの
  // 観測点がまとめて途絶しうるが、それは「揺れていない」ことの証明ではない。ここで諦めると、
  // 最も情報が要る場面で最も早い経路だけが黙って止まる。
  //
  // 確定メンバーが欠測を持ちうるのは、`deriveKyoshinView` が値の有無に関わらず点を作るため
  // （`buildSiteIndex`）。渡ってくる値は瞬断を直前値で埋めた保持値だが、途絶が保持期間を過ぎれば
  // 欠測のセンチネルへ戻る。
  return near.observed ? near.max : scanAll()
}

/**
 * 点を走査して、最大震度・対象になった点数・「1 点でも値を読めたか」を返す。
 *
 * `observed` は**欠測と震度0 を区別する**ためにある。震度0 は「観測できて揺れていない」なので
 * 全国基準へ倒す理由にならないが、全点が欠測なら「近所が揺れていない」とは言えない。
 */
function scanPoints(
  points: readonly DetectedPoint[],
  minScale: number,
  keys: ReadonlySet<string> | null,
): { max: number | null; count: number; observed: boolean } {
  let max: number | null = null
  let count = 0
  let observed = false
  for (const p of points) {
    if (keys && !keys.has(p.key)) continue
    count++
    const jma = kyoshinIndexToJma(p.index)
    if (jma == null) continue
    observed = true
    // **震度0 は閾値がいくつであっても対象にしない。** 強震モニタでは震度0 と震度1 の階級値が
    // 同じ（どちらも 10）で、設定の「出す最低震度」は震度1 まで下げられる。階級値だけで比べると
    // 平常時のノイズ（ほぼ全点が震度0 の帯にいる）が閾値を通り、帯が鳴りっぱなしになる。
    if (jma.rank < 1) continue
    if (jma.scale < minScale) continue
    if (max == null || jma.scale > max) max = jma.scale
  }
  return { max, count, observed }
}

/**
 * EEW の予想震度が閾値に達しているか。達していればその範囲での最大予想震度を返す。
 *
 * 予想震度は区域単位でしか出ないため、地域を絞るときは**半径内の観測点が属する区域**と
 * `EEWRegion.name` を突き合わせる。上限が定まらない報（`scaleTo` が「〜以上」の下限）でも
 * 下限側で比べれば足りる —— 下限が閾値に達していれば実際の揺れはそれ以上になる。
 *
 * **区域を持たない EEW がある。** standard 版は Yahoo hypoInfo（1Hz ポーリング）で先に検知し、
 * 後着の P2PQuake が区域を補う（[eew-spec.md](../../docs/spec/eew-spec.md) §3 の `enrichEEW`）。
 * hypoInfo 由来の報は `areas` を持たず予想震度が `forecastMaxScale` にしか入らないため、
 * **補われる前の窓では区域で判定できない**（Yahoo の続報が上書きして区域が消えることもある）。
 * 区域が無ければ `eewMaxScale`（`areas` が空のときに `forecastMaxScale` へ落ちる正規の取り出し）で
 * 全国基準として判定する。`eewAreas` を使うのは旧形式（`regions` だけを持つ電文）も拾うため。
 */
export function eewScaleForScope(
  eew: EEWAlert,
  scope: NearbyScope,
  minScale: number,
): number | null {
  if (!isUsableThreshold(minScale)) return null
  const regions = eewAreas(eew)
  // 区域が無い、または自宅の区域を引けない場合は全国基準。`eewMaxScale` は区域が空なら
  // `forecastMaxScale` を返すので、区域が補われる前の報もここで拾える。
  if (regions.length === 0 || !hasNearby(scope) || scope.regionNames.size === 0) {
    const max = eewMaxScale(eew)
    return isValidIntensityScale(max) && max >= minScale ? max : null
  }
  // ここで `eewMaxScaleInfo` を使わないのは、あれが「電文全体の最大」を返す関数だから。
  // 欲しいのは自宅の区域だけの最大なので、区域を絞ってから同じ検証（階級表にある値か）を当てる。
  let max: number | null = null
  for (const r of regions) {
    if (!scope.regionNames.has(r.name)) continue
    for (const s of [r.scaleTo, r.scaleFrom]) {
      if (!isValidIntensityScale(s) || s < minScale) continue
      if (max == null || s > max) max = s
    }
  }
  // 区域はあるが自宅の区域が対象外だった場合は「自宅は閾値未満」と読める。ここは倒さない。
  return max
}
