/**
 * 地震カードに紐づく追加表示（長周期地震動階級／震度分布モード）の状態と遷移。
 *
 * **同時に 1 つだけ。** どちらも「この地震について今これを見たい」という一時的な表示切替で、
 * 地図は両方を出せない（`JapanMapGL` の `showDistribution` が長周期を勝たせる）。独立した
 * 状態に分けると、カードのボタンは両方とも押された見た目になるのに地図には長周期しか出ない、
 * という食い違いが起きる。**排他は型で表し、遷移はここへ集約する。**
 *
 * **選択中の地震のものとは限らない。** 地震カードのボタンから開いたものは選択と一致するが
 * （ボタンの側で `selectQuake` を呼ぶ）、EEW カードから開いた長周期と、引き当てる地震カードが
 * 無いまま届いた長周期は選択と結び付かない。どちらも選択中の地震とは無関係に地図へ出る
 * （`useQuakeLayerData` の `lpgmActive`）。
 */

/**
 * - `lpgm` — 長周期地震動階級。`eventId` は電文の識別子で、`source` は開いた場所
 *   （地震カード／EEW カード）。後者は EEW が消えたときの自動解除に使う
 * - `distribution` — 震度分布モード。`eventKey` は地震カードの鍵
 *
 * **鍵の体系が違うので 1 つには畳めない。** 長周期は電文の `eventId`、分布は地震カードの
 * `eventKey`（DMDATA は `eventId` 由来だが P2PQuake は地震の時刻＋震源名）で地震を指す。
 */
export type QuakeOverlay =
  | { kind: 'lpgm'; eventId: string; source: 'earthquake' | 'eew' }
  | { kind: 'distribution'; eventKey: string }

/**
 * 長周期の表示をトグルした結果を返す。
 *
 * 同じ `eventId` が表示中なら閉じ、それ以外なら開く（震度分布モードを開いていれば、それは閉じる）。
 *
 * **判定に `source` を混ぜない。** 同じ地震について地震カードと EEW カードの両方から開けるが、
 * どちらから押しても「表示中のものを押したら閉じる」のがトグルの振る舞い。
 */
export function toggleLpgmOverlay(
  prev: QuakeOverlay | null,
  eventId: string,
  source: 'earthquake' | 'eew',
): QuakeOverlay | null {
  if (prev?.kind === 'lpgm' && prev.eventId === eventId) return null
  return { kind: 'lpgm', eventId, source }
}

/**
 * 震度分布モードをトグルした結果を返す。
 *
 * 同じ地震の分布を開いていれば閉じ、それ以外なら開く（長周期を開いていれば、それは閉じる）。
 */
export function toggleDistributionOverlay(
  prev: QuakeOverlay | null,
  eventKey: string,
): QuakeOverlay | null {
  if (prev?.kind === 'distribution' && prev.eventKey === eventKey) return null
  return { kind: 'distribution', eventKey }
}

/**
 * 長周期の表示だけを閉じた結果を返す（EEW カードの閉じる操作）。
 *
 * **震度分布は触らない。** 排他なので同時には開いていないが、この操作の意味は
 * 「長周期を閉じる」であって追加表示すべてではない。
 */
export function closeLpgmOverlay(prev: QuakeOverlay | null): QuakeOverlay | null {
  return prev?.kind === 'lpgm' ? null : prev
}

/**
 * EEW カードから開いた長周期だけを閉じた結果を返す（EEW が消えた・階級が無くなったとき）。
 *
 * **地震カードから開いた長周期は残す。** 閉じる理由が EEW の消滅なので、地震情報側の表示には
 * 当たらない。
 */
export function closeEewLpgmOverlay(prev: QuakeOverlay | null): QuakeOverlay | null {
  return prev?.kind === 'lpgm' && prev.source === 'eew' ? null : prev
}

/**
 * 選択が別の地震へ移ったか（＝追加表示を閉じるか）を返す。
 *
 * **同じ地震の続報では閉じない。** 続報は長く続くので、電文を受けるたびに閉じると開いた表示が
 * 数分後に消える（実電文での裏付けは `docs/spec/quake-spec.md` §9「震度分布モード」）。
 *
 * **選択が外れたとき（`null`）も閉じる。** 取消しで選択が解かれた地震の表示を残す理由はない。
 */
export function shouldCloseOverlayOnSelection(
  prevSelectedKey: string | null,
  nextSelectedKey: string | null,
): boolean {
  return prevSelectedKey !== nextSelectedKey
}
