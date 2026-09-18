import type { JMAQuake, JMATsunami, Hypocenter, BorrowedFromTsunami, TsunamiSourceEarthquake, DomesticTsunami, TsunamiGrade } from '../types/earthquake'
import { extractQuakeEventId, isHypocenterPending } from './quakeMerge'
import { tsunamiMaxGrade } from './tsunami'

/**
 * 同じ地震の津波電文が伝えている値を、地震カードへ借りる。**震源要素と津波区分の 2 つ**が対象。
 *
 * 気象庁は津波警報を伴う地震で、**地震情報より先に津波電文で震源を伝える**。能登 2024/1/1 の
 * 本震では 16:11〜16:14 に震度速報が 7 通届くあいだ震源がどこにも無く、16:12 の津波警報
 * （「石川県能登地方・Ｍ７．４・ごく浅い」）が最初の震源だった。地震情報として震源が届くのは
 * 16:16。**揺れがいちばん強い数分間、画面から震源が消える**のはこのため。
 *
 * **緊急地震速報からは借りない。** あちらの震源は自動処理の推定値で、同じ時刻の能登では
 * 「能登半島沖・深さ10km」と、津波電文の「石川県能登地方・ごく浅い」とも確定値とも違っていた。
 * 同じ欄へ混ぜると質の違う値が見分けられなくなる。津波電文の震源は気象庁が震源を決めてから
 * 出す速報値で、地震情報と同じ体系のもの。
 *
 * 津波区分（`domesticTsunami`）も同じ穴を持つ —— 詳細は
 * {@link borrowDomesticTsunamiFromTsunami}。**借りたことは値ごとに別の印で持つ**
 * （`hypocenterSource` / `domesticTsunamiSource`）。片方だけ自前の値へ置き換わる報がありうるので、
 * 1 つの印に兼ねさせると、残ったほうの出どころが画面から消える。
 */

/**
 * 画面の震源の行に添える短い語。
 *
 * **等級を名乗らない。** 「津波警報より」と書くと、大津波警報へ引き上げられた地震で一段
 * 軽く見える（→ `docs/spec/quake-spec.md` §3「「警報等」を「津波警報」と書かない」）。
 * 正確な名乗りは `infoName` に持ち、記号に添える説明として出す。
 */
const TSUNAMI_SOURCE_SHORT_LABEL = '津波情報'

/**
 * 借りてよい津波を選ぶ。
 *
 * **`eventId` の一致だけを根拠にする。** 震度速報の `eventId` は気象庁が震源を決める前の
 * 採番で、確定後の電文とは別の値になることがある（実例は `quakeMerge.ts` の
 * `isHypocenterPending`。2026-08-24 04:05 の地震で 20260824040519 → 20260824040526）。
 * 既存の同一性判定（`sameQuakeEntry`）は ID が食い違うとき**区域の重なり**を追加の証拠として
 * 要求するが、津波電文の原因地震は区域を持たないのでその証拠を出せない。
 * **出せない以上、結ばない。** 誤った震源を画面と声に出すほうが、震源が数分間出ないより重い。
 *
 * **取消された津波からは借りない。** 取消は「その報の内容が誤りだった」という意味なので、
 * 取り下げられた震源を別のカードへ持ち込むことになる（既存の震源補完が取消済みカードを
 * 避けているのと同じ向き）。**解除は対象外** —— 津波が引いても、その地震の震源は有効。
 */
function tsunamiToBorrowFrom(eventId: string, tsunamis: readonly JMATsunami[]): JMATsunami | null {
  let best: JMATsunami | null = null
  for (const t of tsunamis) {
    if (!isBorrowableTsunami(t, eventId)) continue
    if (!t.sourceEarthquakes?.[0]?.hypocenterName) continue
    // **新しい報を採る。** 津波電文の震源は続報で更新される（能登では 16:22 に Ｍ７．４→Ｍ７．６。
    // 地震情報が同じ更新を伝えるのは 16:24 で、2 分遅い）。古い報を掴むと、更新された規模が
    // 地震情報の到着まで反映されない。
    if (!best || t.time > best.time) best = t
  }
  return best
}

/**
 * 津波電文の原因地震を、地震カードが持つ震源要素の形へ写す。
 *
 * **読めなかった値はセンチネルで埋める。** 地震情報のパーサーが震源を持たない電文に対して
 * 使うのと同じ値（位置は `-200`、深さは `-1`、規模は `NaN`）で、下流の
 * `hasKnownEpicenter` / `hasMagnitude` がそれを見て「無い」と判定する。**`0` を使わないこと**
 * —— 深さ `0` は「ごく浅い」、規模 `0` は `hasMagnitude` が真を返す有効値。
 */
export function tsunamiSourceHypocenter(src: TsunamiSourceEarthquake): Hypocenter {
  return {
    name: src.hypocenterName,
    latitude: src.latitude ?? -200,
    longitude: src.longitude ?? -200,
    depth: src.depth ?? -1,
    magnitude: src.magnitude ?? NaN,
    ...(src.magnitudeCondition && { magnitudeCondition: src.magnitudeCondition }),
    ...(src.magnitudeType && { magnitudeType: src.magnitudeType }),
    ...(src.code && { code: src.code }),
    ...(src.detailedCode && { detailedCode: src.detailedCode }),
    ...(src.nameFromMark && { nameFromMark: src.nameFromMark }),
    ...(src.markCode && { markCode: src.markCode }),
    ...(src.direction && { direction: src.direction }),
    ...(src.distanceKm !== undefined && { distanceKm: src.distanceKm }),
  }
}

export interface BorrowedHypocenter {
  hypocenter: Hypocenter
  source: BorrowedFromTsunami
}

/**
 * 震源が未確定の地震電文に対し、同じ地震の津波電文から借りられる震源を返す。借りられなければ
 * `null`。
 *
 * **借りる条件はすべてここで見る**（震源が未確定であること・取消でないこと・`eventId` が
 * 一致すること）。条件を呼び出し側へ写すと、カードと読み上げで借りる範囲がずれる。
 */
export function borrowHypocenterFromTsunami(
  quake: JMAQuake,
  tsunamis: readonly JMATsunami[],
): BorrowedHypocenter | null {
  // 対象は「震源が未確定」か「前に借りた震源を持っている」カード。
  //
  // **後者を入れないと、借りた震源が津波の続報に追随しない。** 実電文では 16:22 に
  // Ｍ７．４→Ｍ７．６と上がる（地震情報の同じ更新は 16:24 で 2 分遅い）のに、借りた時点の
  // 値で固まる。借り物かどうかは `hypocenterSource` の有無が単一の目印で、自前の震源が
  // 入った時点で落ちる（→ `quakeMerge.ts` の `mergeQuakeInto`）。
  if (!isHypocenterPending(quake) && !quake.hypocenterSource) return null
  const eventId = extractQuakeEventId(quake)
  if (!eventId) return null
  const tsunami = tsunamiToBorrowFrom(eventId, tsunamis)
  const src = tsunami?.sourceEarthquakes?.[0]
  if (!tsunami || !src) return null
  return {
    hypocenter: tsunamiSourceHypocenter(src),
    source: sourceOf(tsunami),
  }
}

/**
 * その津波から値を借りてよいか（震源・津波区分に共通する条件）。
 *
 * **`cancelled` だけでは足りない。** 取消の状態更新は**表示中の津波（`cancelled: false`）を
 * 土台に `cancelledAt` を足す**形なので（`useEarthquakes` の 'tsunami' ケース）、取消電文の
 * `cancelled: true` は状態に残らない。見ないと、誤報取消を表示している 10 秒のあいだ
 * 取り下げられた値を借りられてしまう。
 *
 * **解除（`lifted`）と失効（`expired`）は借りてよい。** 津波が引いても、その地震に津波警報が
 * 出たことも震源も有効なまま。止めるのは「その報の内容が誤りだった」と気象庁が言った取消だけ。
 *
 * **`eventId` の一致だけを根拠にする。** 理由は {@link tsunamiToBorrowFrom} の注記。
 */
function isBorrowableTsunami(t: JMATsunami, eventId: string): boolean {
  if (t.cancelled || t.cancelReason === 'retracted') return false
  return !!t.eventId && t.eventId === eventId
}

/**
 * 借りた震源を地震電文へ適用した写しを返す。何も変わらなければ**元の参照をそのまま**返す。
 *
 * 同一参照を返すことに意味がある —— 呼び出し側は戻り値を `===` で比べて「変わったかどうか」を
 * 判定でき、変わっていないときに無駄な再レンダーを起こさない。
 *
 * **借りられないときは据え置く（印も震源も落とさない）。** 津波が取り消された・解除で消えた
 * ような場合に落とすと、**前に借りた震源だけが残って出どころの印が消える** ―― 借り物が自前の
 * 震源のように見えてしまう。印を落とすのは自前の震源が入ったときで、それは統合の側の仕事
 * （→ `quakeMerge.ts` の `mergeQuakeInto`）。
 */
export function withBorrowedHypocenter(quake: JMAQuake, tsunamis: readonly JMATsunami[]): JMAQuake {
  const borrowed = borrowHypocenterFromTsunami(quake, tsunamis)
  if (!borrowed) return quake
  // **中身が同じなら元の参照を返す。** 津波の続報は 1 つの津波で 40 通を超える（能登の実電文）。
  // 観測情報や満潮時刻の続報は震源を変えないので、そのたびに新しいカードを作ると
  // `earthquakes` の参照が変わり、**地震一覧全体が無駄に描き直される**
  // （`App.tsx` の `filteredEarthquakes` が新しい配列を作り、`React.memo` が効かなくなる）。
  if (sameBorrowedHypocenter(quake, borrowed)) return quake
  return {
    ...quake,
    earthquake: { ...quake.earthquake, hypocenter: borrowed.hypocenter },
    hypocenterSource: borrowed.source,
  }
}

/**
 * 借りた結果が、いまカードが持っているものと同じか。
 *
 * **比べるのは震源の値だけで、出どころの名乗り・発表時刻は見ない。** 同じ震源を載せた続報が
 * 何通も届くので、時刻まで比べると**値が変わっていないのに「〇時〇分 発表」だけが進み**、
 * 画面の注記が「この時刻に震源が更新された」ように読める。値が変わったときだけ出どころも
 * 更新されるのが正しい —— その震源を最初に伝えた報こそが出どころだから。
 */
function sameBorrowedHypocenter(quake: JMAQuake, borrowed: BorrowedHypocenter): boolean {
  if (!quake.hypocenterSource) return false
  const a = quake.earthquake.hypocenter
  const b = borrowed.hypocenter
  // **規模は `NaN` を取りうる**ので `Object.is` で比べる（`NaN !== NaN`）。
  return a.name === b.name
    && a.latitude === b.latitude
    && a.longitude === b.longitude
    && a.depth === b.depth
    && Object.is(a.magnitude, b.magnitude)
    && a.magnitudeCondition === b.magnitudeCondition
    && a.magnitudeType === b.magnitudeType
    && a.code === b.code
    && a.detailedCode === b.detailedCode
    && a.nameFromMark === b.nameFromMark
    && a.markCode === b.markCode
    && a.direction === b.direction
    && a.distanceKm === b.distanceKm
}

/**
 * 津波を受け取ったときに、既にあるカードへ震源を配る。
 *
 * **契機が両方向に要る。** 地震電文が先に届けば受信側（`useEarthquakes` の 'quake'）が借り、
 * 津波が先に届けばこちらが配る。どちらが先かは決まっていない —— 能登 2024/1/1 は震度速報
 * （16:11）が先で津波警報（16:12）が後だったが、津波が先の順序も起こりうる。
 *
 * **取消表示中のカードは触らない。** 気象庁が取り下げた内容へ新しい震源を書き込むことになる
 * （既存の震源補完が `!existing.cancelledAt` を課しているのと同じ向き）。
 *
 * 1 枚も変わらなければ**元の配列参照をそのまま**返す。
 */
export function borrowFromTsunamiIntoCards(cards: JMAQuake[], tsunamis: readonly JMATsunami[]): JMAQuake[] {
  let changed = false
  const next = cards.map(card => {
    if (card.cancelledAt) return card
    const applied = withBorrowedFromTsunami(card, tsunamis)
    if (applied !== card) changed = true
    return applied
  })
  return changed ? next : cards
}

/**
 * 津波区分（`domesticTsunami`）を、同じ地震の津波電文の等級から借りる。
 *
 * **震源と同じ穴を塞ぐもの。** 震度速報がその地震の初報だと、カードの津波区分は震度速報自身が
 * 持つ定型文（コード 0217「今後の情報に注意してください。」＝`調査中`）のまま残る。これは
 * **その報の判断ではなく種別に付く定型文**で、気象庁が同じ地震に津波警報を出していても動かない
 * （既存カードがあれば `mergeQuakeInto` が上書きを止めるが、初報では止める相手がいない）。
 * 結果、能登 2024/1/1 の本震では大津波警報の発表中に地震カードが「調査中」と出ていた。
 *
 * **写し先は `警報等` だけ。** 気象庁の固定付加文もそう丸めている（コード 0211。大津波警報・
 * 津波警報・津波注意報を 1 つの語にまとめる → `formatDomesticTsunami`）。等級そのものは
 * 津波カードで見る欄なので、ここで細かく分けても地震カードの語彙には無い。
 *
 * **津波予報だけの津波からは借りない。** 予報の定型文はコードが 3 通り（0212〜0216）に分かれ、
 * `若干の海面変動` と `海面変動の可能性` のどちらになるかは**等級からは決まらない**。
 * 決められない値を推測で埋めるより、気象庁が次の報で伝えるのを待つほうが正しい。
 */
export function borrowDomesticTsunamiFromTsunami(
  quake: JMAQuake,
  tsunamis: readonly JMATsunami[],
): BorrowedDomesticTsunami | null {
  // 対象は「まだ判断が無い」か「前に借りた区分を持っている」カード。後者を入れるのは震源と
  // 同じ理由 —— 入れないと、注意報から警報へ引き上げられた続報に追随しない。
  if (!canBorrowDomesticTsunami(quake)) return null
  const eventId = extractQuakeEventId(quake)
  if (!eventId) return null
  const tsunami = tsunamiToBorrowGradeFrom(eventId, tsunamis)
  if (!tsunami) return null
  return {
    domesticTsunami: '警報等',
    source: sourceOf(tsunami),
  }
}

export interface BorrowedDomesticTsunami {
  domesticTsunami: DomesticTsunami
  source: BorrowedFromTsunami
}

/**
 * その地震カードの津波区分を借りてよいか。
 *
 * **`調査中` と `不明` だけが対象。** 気象庁が判断を示した値（`なし`・`若干の海面変動` など）を
 * 上書きしない —— 津波の等級より地震電文の判断のほうが、その地震についての気象庁の答えとして
 * 新しいとは限らないうえ、`なし` を消すと確定した安全表示を取り下げることになる。
 *
 * 借り物（`domesticTsunamiSource` あり）も対象に含める。印の有無が「いま借り物か」の単一の
 * 目印で、自前の値が入った時点で落ちる（→ `quakeMerge.ts` の `mergeQuakeInto`）。
 */
function canBorrowDomesticTsunami(quake: JMAQuake): boolean {
  if (quake.domesticTsunamiSource) return true
  const t = quake.earthquake.domesticTsunami
  return t === '調査中' || t === '不明'
}

/**
 * 津波区分を借りてよい津波を選ぶ。
 *
 * 震源側（{@link tsunamiToBorrowFrom}）と**選び方が違う**。あちらが要るのは原因地震の震源要素で、
 * こちらが要るのは区域の等級 —— 同じ津波でも、載っている報が違う（津波警報等は区域を運び、
 * 観測情報の続報は運ばないことがある）。同じ関数で兼ねると、どちらか一方しか持たない報で
 * 両方が落ちる。
 */
function tsunamiToBorrowGradeFrom(eventId: string, tsunamis: readonly JMATsunami[]): JMATsunami | null {
  let best: JMATsunami | null = null
  for (const t of tsunamis) {
    if (!isBorrowableTsunami(t, eventId)) continue
    if (!BORROWABLE_GRADES.has(tsunamiMaxGrade(t))) continue
    if (!best || t.time > best.time) best = t
  }
  return best
}

/**
 * 地震カードの津波区分 `警報等` へ写してよい等級。
 *
 * 気象庁の固定付加文 0211（「津波警報等」）が束ねているのと同じ 3 つ。`Forecast` を入れない
 * 理由は {@link borrowDomesticTsunamiFromTsunami}、`Unknown` は等級を読めなかった印なので
 * そもそも根拠にならない。
 */
const BORROWABLE_GRADES: ReadonlySet<TsunamiGrade> = new Set<TsunamiGrade>(['MajorWarning', 'Warning', 'Watch'])

/** 借りた値の出どころを組む（震源と津波区分で同じ形）。 */
function sourceOf(tsunami: JMATsunami): BorrowedFromTsunami {
  return {
    shortLabel: TSUNAMI_SOURCE_SHORT_LABEL,
    // 名乗りを読めない電文では短い語をそのまま使う。`infoName` は `Head/Title` で
    // 実電文には必ず入るため、これは読めなかったときの受け皿。
    infoName: tsunami.infoName || TSUNAMI_SOURCE_SHORT_LABEL,
    reportTime: tsunami.time,
  }
}

/**
 * 震源と津波区分を、同じ地震の津波電文から借りた写しを返す。何も変わらなければ**元の参照を
 * そのまま**返す（{@link withBorrowedHypocenter} と同じ約束）。
 *
 * **画面のカード向け。読み上げには使わない。** 読み上げ側が借りるのは震源だけで、津波区分は
 * 借りない —— 同じ津波の読み上げが既に等級と行動指示を語っているので、地震情報の側でも
 * 区分を言うと二重になる（→ `ttsText.ts`）。
 */
export function withBorrowedFromTsunami(quake: JMAQuake, tsunamis: readonly JMATsunami[]): JMAQuake {
  const withHypocenter = withBorrowedHypocenter(quake, tsunamis)
  const borrowed = borrowDomesticTsunamiFromTsunami(withHypocenter, tsunamis)
  if (!borrowed) return withHypocenter
  // 中身が同じなら参照を変えない（理由は `withBorrowedHypocenter` の注記と同じ ―― 観測情報の
  // 続報は等級を変えないので、そのたびに新しいカードを作ると地震一覧が無駄に描き直される）。
  if (withHypocenter.domesticTsunamiSource
    && withHypocenter.earthquake.domesticTsunami === borrowed.domesticTsunami) return withHypocenter
  return {
    ...withHypocenter,
    earthquake: { ...withHypocenter.earthquake, domesticTsunami: borrowed.domesticTsunami },
    domesticTsunamiSource: borrowed.source,
  }
}
