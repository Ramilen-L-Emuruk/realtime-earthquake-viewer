// 行動チェックリストを出すかどうかの判定。
//
// 【3 つの経路】揺れを知る手段が 3 つあり、どれで気づくかは状況で変わる。
//   - EEW … 揺れる前。予想震度は一次細分区域単位でしか出ないので、区域名で照合する
//   - 強震モニタ … 揺れている最中。観測点ごとのリアルタイム震度を直接見る（最も早い）
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
// 【壊れた震度は見なかったことにする】電文の震度階級は実地震テストシナリオの手書き JSON など
// 型検査を通らない経路からも来る（`eew.ts` の `eewMaxScaleInfo` も同じ理由で実行時に弾いている）。
// 階級表に無い値は判定にも表示にも使わない。結果として半径内の点が 1 つも残らなければ、
// 上の規則どおり全国基準へ倒れる。

import type { EEWAlert, JMAQuake } from '../types/earthquake'
import { eewAreas, eewMaxScale } from './eew'
import { isValidIntensityScale } from './intensity'
import { kyoshinIndexToJma } from './kyoshinIntensity'

/** 判定に使う「自宅の周り」。半径内に何も無ければ空になり、その場合は全国基準へ倒す。 */
export interface NearbyScope {
  /** 強震モニタの観測点の添字（フレームの `indices` と同順）。 */
  kyoshinIndices: readonly number[]
  /**
   * 気象庁の観測点名（県名を含めない）。
   *
   * DMDATA の電文は `pref` を空で積むため、"県|観測点名" の形では突き合わせられない
   * （`nearbyStationNames` の説明を参照）。
   */
  stationNames: ReadonlySet<string>
  /** 半径内の観測点が属する一次細分区域名。 */
  regionNames: ReadonlySet<string>
}

/** 位置を持たない（または半径内に観測点が無い）ことを表す。全国基準で判定する。 */
export const NO_SCOPE: NearbyScope = {
  kyoshinIndices: [],
  stationNames: new Set(),
  regionNames: new Set(),
}

/** その `scope` で地域を絞れるか。3 つとも空なら絞れない＝全国基準へ倒す。 */
export function hasNearby(scope: NearbyScope): boolean {
  return scope.kyoshinIndices.length > 0 || scope.stationNames.size > 0 || scope.regionNames.size > 0
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
  // 半径内に該当する点が 1 つも無い電文（区域索引と噛み合わない・観測点が載っていない等）は
  // 地域で絞れなかったものとして扱う。
  if (!matched) return nationwide()
  return max
}

/**
 * 半径内（または全点）を走査して、最大震度と「1 点でも観測できたか」を返す。
 *
 * `observed` は**欠測と震度0 を区別する**ためにある。震度0 は「観測できて揺れていない」なので
 * 全国基準へ倒す理由にならないが、全点が欠測なら「自宅の周りが揺れていない」とは言えない。
 */
function scanKyoshin(
  indices: readonly number[],
  minScale: number,
  pick: (n: number) => number,
  count: number,
): { max: number | null; observed: boolean } {
  let max: number | null = null
  let observed = false
  for (let n = 0; n < count; n++) {
    const jma = kyoshinIndexToJma(indices[pick(n)])
    if (jma == null) continue
    observed = true
    // **震度0 は閾値がいくつであっても対象にしない。** 強震モニタでは震度0 と震度1 の階級値が
    // 同じ（どちらも 10）で、設定の「出す最低震度」は震度1 まで下げられる。階級値だけで比べると
    // 平常時のノイズ（ほぼ全点が震度0 の帯にいる）が閾値を通り、帯が鳴りっぱなしになる。
    if (jma.rank < 1) continue
    if (jma.scale < minScale) continue
    if (max == null || jma.scale > max) max = jma.scale
  }
  return { max, observed }
}

/**
 * 強震モニタのフレームが閾値に達しているか。達していればその範囲での最大震度を返す。
 *
 * `indices` は Yahoo の震度インデックス（0〜20 前後）で気象庁の階級とは別物なので、
 * `kyoshinIndexToJma` で階級へ直してから比べる。欠測（負のセンチネル）は `null` が返る。
 *
 * **半径内の点が 1 つも観測できていないときは全国基準へ倒す。** 大きな地震では近くの観測点が
 * まとめて途絶しうるが、それは「揺れていない」ことの証明ではない。ここで諦めると、最も情報が
 * 要る場面で最も早い経路だけが黙って止まる。
 */
export function kyoshinScaleForScope(
  indices: readonly number[],
  scope: NearbyScope,
  minScale: number,
): number | null {
  if (!isUsableThreshold(minScale)) return null
  // 全点を見るときも添字の配列を作らない —— この判定はレンダーのたびに走りうるため、
  // 毎回 1725 要素を確保すると重い。
  const scanAll = () => scanKyoshin(indices, minScale, n => n, indices.length).max
  if (!hasNearby(scope) || scope.kyoshinIndices.length === 0) return scanAll()
  const near = scanKyoshin(indices, minScale, n => scope.kyoshinIndices[n], scope.kyoshinIndices.length)
  return near.observed ? near.max : scanAll()
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
