/**
 * 地震カードに紐づく追加表示（長周期地震動階級／震度分布モード／未入電）の状態と遷移。
 *
 * **同時に 1 つだけ。** どれも「この地震について今これを見たい」という一時的な表示切替で、
 * 地図は全部を出せない（`JapanMapGL` の `showDistribution` が長周期を勝たせる）。独立した
 * 状態に分けると、カードのボタンは両方とも押された見た目になるのに地図には長周期しか出ない、
 * という食い違いが起きる。**排他は型で表し、遷移はここへ集約する。**
 *
 * **選択中の地震のものとは限らない。** 地震カードのボタンから開いたものは選択と一致するが
 * （ボタンの側で `selectQuake` を呼ぶ）、EEW カードから開いた長周期と、引き当てる地震カードが
 * 無いまま届いた長周期は選択と結び付かない。どちらも選択中の地震とは無関係に地図へ出る
 * （`useQuakeLayerData` の `lpgmActive`）。
 */

import type { TabId } from '../components/IconNav'

/**
 * - `lpgm` — 長周期地震動階級。`eventId` は電文の識別子で、`source` は開いた場所
 *   （地震カード／EEW カード）。後者は EEW が消えたときの自動解除に使う
 * - `distribution` — 震度分布モード。`eventKey` は地震カードの鍵
 * - `unreceived` — 震度が届いていない地点。`eventKey` は地震カードの鍵
 *
 * **鍵の体系が違うので 1 つには畳めない。** 長周期は電文の `eventId`、分布は地震カードの
 * `eventKey`（DMDATA は `eventId` 由来だが P2PQuake は地震の時刻＋震源名）で地震を指す。
 */
export type QuakeOverlay =
  | { kind: 'lpgm'; eventId: string; source: 'earthquake' | 'eew' }
  | { kind: 'distribution'; eventKey: string }
  | { kind: 'unreceived'; eventKey: string }

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
 * 震度分布モードを**開いた**結果を返す（推計震度分布図の受信で自動的に開くとき）。
 *
 * {@link toggleDistributionOverlay} と分けてあるのは、こちらが「開く」だけで閉じないため。
 * トグルを流用すると、同じ分布を二度開こうとしたときに閉じてしまう —— 自動で開く経路は
 * **受信の瞬間と、読み上げの順番が来た瞬間の 2 回**呼ぶので（理由は
 * [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「推計震度分布図は地震情報の音を借りる」）、
 * 閉じる側へ倒れると声に出す瞬間に分布が消える。
 *
 * **既に同じ分布を開いていれば前の値をそのまま返す。** 新しいオブジェクトを返すと、内容が
 * 同じでも React は状態が変わったとみなして描き直す。
 */
export function openDistributionOverlay(
  prev: QuakeOverlay | null,
  eventKey: string,
): QuakeOverlay | null {
  if (prev?.kind === 'distribution' && prev.eventKey === eventKey) return prev
  return { kind: 'distribution', eventKey }
}

/**
 * 長周期の表示を開いた結果を返す（トグルではない）。
 *
 * **電文が届くたびに呼ばれる**ので、`toggleLpgmOverlay` は使えない（続報のたびに開閉が
 * 裏返る）。
 *
 * **既に同じものを開いていれば前の値をそのまま返す。** 新しいオブジェクトを返すと、内容が
 * 同じでも React は状態が変わったとみなして描き直す（`applyQuakeOverlay` が `setState` を
 * 呼び直す）。長周期は続報が続くので、ここを踏み外すと報の数だけ無駄な描き直しが並ぶ。
 *
 * **録画ツール向けの記録は別の安全弁で守られている**（→ `quakeOverlayChangeLog`。あちらは
 * 参照ではなく「画面に出ているもの」の見た目で比較するので、このメモ化を忘れて毎回新しい
 * オブジェクトを返しても偽の開閉は記録されない）。ここでの参照維持は再描画を減らすための
 * 最適化であって、記録の正しさが依存しているわけではない。
 */
export function openLpgmOverlay(
  prev: QuakeOverlay | null,
  eventId: string,
  source: 'earthquake' | 'eew',
): QuakeOverlay | null {
  if (prev?.kind === 'lpgm' && prev.eventId === eventId && prev.source === source) return prev
  return { kind: 'lpgm', eventId, source }
}

/**
 * 未入電の表示をトグルした結果を返す。
 *
 * 同じ地震の未入電を開いていれば閉じ、それ以外なら開く（他の追加表示を開いていれば、それは閉じる）。
 *
 * **開いている間、地図は未入電の印だけを出す**（判定は `JapanMapGL`）。震度の表現を残すと、
 * 件数が多いとき（実電文で最大 60 点）印が塗りの上に散って「どこが届いていないのか」が読めない。
 */
export function toggleUnreceivedOverlay(
  prev: QuakeOverlay | null,
  eventKey: string,
): QuakeOverlay | null {
  if (prev?.kind === 'unreceived' && prev.eventKey === eventKey) return null
  return { kind: 'unreceived', eventKey }
}

/**
 * 未入電の表示だけを閉じた結果を返す（その地震の未入電が 1 件も無くなったとき）。
 *
 * **開いたまま閉じられなくなる形があるため要る。** カードのボタンは件数で出しているので、
 * 続報で観測点が入電して 0 件になると消える。一方この状態は選択が別の地震へ移るまで残り、
 * 地図は未入電モードの間だけ震度の表現を引っ込めるので、**震源の印だけの画面で固定される**。
 *
 * **長周期・震度分布は触らない。** 閉じる理由が「未入電が無くなった」ことなので、他には当たらない。
 */
export function closeUnreceivedOverlay(prev: QuakeOverlay | null): QuakeOverlay | null {
  return prev?.kind === 'unreceived' ? null : prev
}

/**
 * **その地震の**未入電の表示だけを閉じた結果を返す（読み上げの自動開閉が自分の分を戻すとき）。
 *
 * {@link closeUnreceivedOverlay} と分けてあるのは、閉じる主体が違うため。あちらは
 * 「未入電が 1 件も無くなった」という事実に対する後始末なので、開いている未入電は必ず対象。
 * こちらは**自分が開いた分を戻す**操作で、開けてから閉じるまでの間に別の地震へ移っていれば、
 * そこにあるのは他人の表示になる（選択が移ると追加表示は一度閉じられ、利用者が手で開き直す
 * 余地がある）。鍵が違えば触らない。
 */
export function closeUnreceivedOverlayFor(
  prev: QuakeOverlay | null,
  eventKey: string,
): QuakeOverlay | null {
  return prev?.kind === 'unreceived' && prev.eventKey === eventKey ? null : prev
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
 * その地震の電文を受けたとき、震度分布モードだけを閉じた結果を返す。
 *
 * **分布モードは発表値を引っ込めるモード**なので（区域塗りも観測点ドットも出さない。
 * → `docs/spec/quake-spec.md` §9「震度分布モード」）、開いたままだと続報で震度がどこまで
 * 変わったのかが地図に一切現れない。分布は地震発生から概ね 15 分後に届き、震源・震度情報の
 * 続報はその後も続くため、放置すると**いちばん新しい発表値が、いちばん見えない**状態になる。
 *
 * **手で開いたものも閉じる。** 開いた主体（自動／利用者）で分けていない —— 新しい発表値が
 * 届いたことは、どちらで開いていても知りたい事実だから。閉じたあとカードのボタンを押せば
 * すぐ分布へ戻せる。
 *
 * **長周期・未入電は触らない。** 閉じる理由が「発表値が更新されたのに分布モードが隠している」
 * ことなので、他の追加表示には当たらない（長周期は自分の区域塗りを出しており、発表値を
 * 隠していない）。
 *
 * **鍵を照合する。** この関数が受け持つのは「**同じ地震の**続報でも閉じる」ぶんだけ。鍵が
 * 食い違うときは、直前に呼ばれる {@link shouldCloseOverlayOnSelection} が「別の地震へ移った」
 * と見て既に閉じている（呼ぶ順は `selectQuake` → こちらで、分布モードの鍵は開く経路がどちらでも
 * 選択と揃えてある）。照合を外せば順序に依存しなくなるが、代わりに別の地震の分布まで巻き込む。
 */
export function closeDistributionOverlayOnQuakeReport(
  prev: QuakeOverlay | null,
  eventKey: string,
): QuakeOverlay | null {
  return prev?.kind === 'distribution' && prev.eventKey === eventKey ? null : prev
}

/**
 * 選択が別の地震へ移ったか（＝追加表示を閉じるか）を返す。
 *
 * **同じ地震の続報では閉じない。** 続報は長く続くので、電文を受けるたびに閉じると開いた表示が
 * 数分後に消える（実電文での裏付けは `docs/spec/quake-spec.md` §9「震度分布モード」）。
 * **震度分布モードだけは例外**で、その地震の電文を受けた時点で
 * {@link closeDistributionOverlayOnQuakeReport} が別途閉じる（理由はそちら）。
 *
 * **選択が外れたとき（`null`）も閉じる。** 取消しで選択が解かれた地震の表示を残す理由はない。
 */
export function shouldCloseOverlayOnSelection(
  prevSelectedKey: string | null,
  nextSelectedKey: string | null,
): boolean {
  return prevSelectedKey !== nextSelectedKey
}

/**
 * 開こうとした結果。**「開かないことを選んだ」と「開くべきなのに開けない」を分ける。**
 * 分けないと、正常な見送り（別のタブを見ている等）まで診断に載って記録が役に立たなくなる。
 */
export type UnreceivedOpenResult =
  /** 開いた。 */
  | 'opened'
  /** 開かないことを選んだ（別のタブを見ている・他の追加表示が開いている）。正常。 */
  | 'declined'
  /**
   * 開くべきなのに開けない（読んでいる地震が画面に無い・その地震に未入電の地点が無い）。
   * 読み上げと画面が食い違っている印なので記録する。
   */
  | 'mismatch'

/**
 * 読み上げに合わせて未入電モードを開いてよいかを決める
 * （→ [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせた未入電モードの自動開閉」）。
 *
 * **対象は読み上げの主題（`subject`）で決め、「いま選ばれている地震」で代用しない。** 読み上げは
 * 優先度の待ち行列を通るので、順番が回ってくるまでに別の地震の電文が届いて選択がそちらへ移って
 * いることがある（選択は受信した瞬間に同期で動く）。代用すると **A の未入電を読みながら B の
 * 一覧を開く**。
 *
 * 判定を純関数にしてあるのは、この 4 つの分岐が画面からは見分けにくいため（開かなかったことは
 * 「画面が動かない」としか現れない）。
 */
export function decideUnreceivedSpeechOpen(args: {
  /** いま見ているタブ。 */
  activeTab: TabId
  /** いま開いている追加表示（排他）。 */
  overlay: QuakeOverlay | null
  /** 読み上げの主題（どの地震について語っているか）。 */
  subject: string | undefined
  /** 画面が出している地震の鍵。 */
  selectedKey: string | null
  /** その地震に、地図へ出せる未入電の地点があるか。 */
  hasUnreceivedPoints: boolean
}): UnreceivedOpenResult {
  // 津波やリアルタイムを見ている最中に、地図だけ未入電の画へ変わるのを防ぐ
  // （タブ移動は読み上げ追従の側が別に判断していて、こちらはその結果に従う）。
  if (args.activeTab !== 'earthquake') return 'declined'
  // **手で開かれている別の追加表示は奪わない。** 3 つは排他なので、ここで開くと震度分布・
  // 長周期が閉じる。しかも閉じる番（`closeUnreceivedOverlayFor`）は元の表示へ戻さないので、
  // 利用者からは操作していないのに消えたようにしか見えない。
  if (args.overlay !== null) return 'declined'
  // 読んでいる地震が画面に出ていない。主題を持たない読み上げもここへ来る
  // （この経路は地震の読み上げしか通らないはずなので、来たら記録に値する）。
  if (!args.subject || args.selectedKey !== args.subject) return 'mismatch'
  // 未入電を読み上げているのに地点が無い＝読み上げ文と画面のカードが食い違っている。
  if (!args.hasUnreceivedPoints) return 'mismatch'
  return 'opened'
}

/**
 * 画面に出ている追加表示を指す鍵。**見た目が同じかを比べるためのもの。**
 *
 * **`source` は含めない。** 長周期をどちらのカードから開いたかは自動で閉じる条件に効くだけで、
 * 出ている一覧は変わらない。含めると、同じ一覧が出たままなのに「閉じた・開いた」が並ぶ。
 */
function visibleOverlayKey(o: QuakeOverlay | null): string | null {
  if (!o) return null
  return o.kind === 'lpgm' ? `lpgm:${o.eventId}` : `${o.kind}:${o.eventKey}`
}

/**
 * 追加表示が指す地震の主題（→ `docs/spec/recording-interface-spec.md` の `subject`）。
 *
 * `lpgm` は電文の `eventId`、`distribution`／`unreceived` は地震カードの `eventKey`。
 * `visibleOverlayKey` と鍵の形は同じだが、あちらは種別を含めた「見た目の一致判定」用で
 * こちらは「どの地震か」だけを表す——同じ材料でも用途が違うので使い分ける。
 */
function overlaySubject(o: QuakeOverlay): string {
  return o.kind === 'lpgm' ? o.eventId : o.eventKey
}

/**
 * 追加表示の変化を、録画ツール向けの記録 1 件ずつへ開く。
 *
 * **記録の判断をここ 1 つへ集めるために切り出してある。** 追加表示は `distribution` /
 * `unreceived` / `lpgm` の排他な 1 つの状態機械なのに、書き手は 13 ある。呼び出し側ごとに
 * 「変わったか」を判定して記録する形にすると、**書き手を足すたびに抜ける** —— 実際に
 * 自動で開く経路だけが記録され、カードのボタンを押した回と長周期の開閉が丸ごと落ちていた。
 *
 * **差し替え（別の追加表示へ移る）は 2 件になる。** 閉じた分と開いた分は別の出来事で、
 * 1 件に畳むと編集する側は何が引っ込んだのか読めない。並びは「閉じる → 開く」。
 *
 * **`subject` を持たせる。** 群発地震で複数の地震について続けて lpgm/distribution/unreceived
 * が開閉したとき、`overlay` 種別だけでは「同じ地震の開閉」か「別の地震への切り替え」かを
 * 録画ログから区別できない。
 *
 * @param before 書き換える前（同じ参照なら変化なしとみなす）
 * @param after 書き換えた後
 */
export function quakeOverlayChangeLog(
  before: QuakeOverlay | null,
  after: QuakeOverlay | null,
): { overlay: QuakeOverlay['kind'], open: boolean, subject: string }[] {
  // 変化が無ければ何も出さない。**参照ではなく「画面に出ているもの」で比べる** ——
  // ヘルパーは「変わらなければ同じ参照を返す」規約だが、参照だけに頼ると**呼び出し側が
  // ヘルパーを通さずオブジェクトを作った瞬間に偽の開閉が湧く**（長周期の自動表示で実際に
  // 起きた）。見た目で比べておけば、その踏み外しがここまで漏れてこない。
  if (visibleOverlayKey(before) === visibleOverlayKey(after)) return []
  const entries: { overlay: QuakeOverlay['kind'], open: boolean, subject: string }[] = []
  if (before) entries.push({ overlay: before.kind, open: false, subject: overlaySubject(before) })
  if (after) entries.push({ overlay: after.kind, open: true, subject: overlaySubject(after) })
  return entries
}
