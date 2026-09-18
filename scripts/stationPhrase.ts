// 観測点名を「市町村 / 地点」の 2 アクセント句に割り、読み上げ用のカナ表記へ変換する。
//
// 生成スクリプト（build-station-readings.ts）から使う。HTTP を持たない純粋な変換だけを置き、
// エンジンへの問い合わせ（市町村のアクセント核の実測）は呼び出し側に任せる。
// 読みの正規化とカナの組み立ては震度観測点・震央地名と共通（`stationReading.ts`）。
//
// 【なぜ割るのか】`toKanaEntry` はふりがなをカタカナ化して末尾に核を 1 つ置くだけなので、
// どれだけ長い名前でも 1 アクセント句になる（`札幌豊平区月寒東` → `サッポロトヨヒラクツキサムヒガシ'`
// ＝ 15 モーラひと息）。一方**エンジンが正しく読める観測点名では、エンジン自身が市町村の境界で
// 句を割っている** —— 8 モーラ以上で市町村が前方一致する 1690 件から 400 件を読ませたところ、
// 380 件（95.0%）で最初のアクセント句が市町村名とちょうど一致した（1 句にまとまったのが 7 件、
// 別の位置で割れたのが 13 件で、`〜村役場` が `ムラヤクバ` でまとまる類）。
// つまり辞書へ入れる形だけが、エンジンの自然な句構成から外れていた。

import { countMoras, splitIntoMoras, toKana } from './stationReading'

/**
 * 句を割る対象にするモーラ数の下限（名前全体）。
 *
 * 震央地名の句割り（`build-epicenter-accents.ts`）と同じ値だが、**別々に決めた値**で、
 * あちらの根拠（震央地名の分布）はこちらには当てはまらない。片方を動かすときはもう片方も
 * 見直すこと —— 「1 句が長いと切れ目が語の途中に来る」という同じ症状を扱っている。
 *
 * この値で割れる観測点名の分布（2026-09 時点・辞書 2669 キー中、1 句のものが 2573 件）:
 * 8 モーラ 292 件／9 モーラ 413 件／10 モーラ 470 件／11 モーラ 347 件／12 モーラ 274 件／
 * 13 モーラ 206 件／14 モーラ 151 件／15 モーラ 102 件／16 モーラ 74 件／17 モーラ 34 件／
 * 18 モーラ 34 件／19 モーラ 8 件／20 モーラ 4 件／21 モーラ 2 件。
 * 8 モーラ未満は 162 件（最長でも 7 モーラ）で、そこは 1 句でも語の輪郭が保たれると見て外した。
 */
export const MIN_MORAS_TO_SPLIT = 8

/**
 * 割った後の各句に要求するモーラ数の下限。
 *
 * **1 モーラの句は自ら核を持って浮く。** 辞書該当語の直後の助詞を読みへ取り込んでいるのは
 * まさにこの症状を避けるためで（→ `docs/spec/audio-tts-spec.md` §3「助詞は辞書の読みへ取り込む」）、
 * 句割りで同じものを作っては意味が無い。実データで引っ掛かるのは `新温泉町湯`
 * （`シンオンセンチョウ` / `ユ`）の 1 件だけ。
 */
export const MIN_MORAS_PER_PHRASE = 2

/** 市町村の名前と読み（カタカナ・核なし）。長い名前から当てるため配列で持つ。 */
export type CityIndex = readonly { readonly name: string; readonly kana: string }[]

/**
 * 市町村の読みの表を作る。**名前の長い順に並べる。**
 *
 * 一方が他方の前方一致になっている組が実データに 3 組ある
 * （`佐世保市` ⊂ `佐世保市宇久島`・`薩摩川内市` ⊂ `薩摩川内市甑島`・`東村` ⊂ `東村山市`）。
 * **ただし今の実データでは、並べ替えが結果を変える組は 1 つも無い** —— 短い側を先に当てても
 * {@link splitStationName} の読みの照合が弾く（`東村山市本町` は漢字が `東村` で始まるが、
 * 読み `ヒガシムラヤマシホンチョウ` は `東村` の読み `ヒガシソン` で始まらない）。
 * 並べ替えは、読みまで前方一致してしまう組が将来現れたときの備え。
 *
 * @param rows 市町村の名前とふりがな（ひらがな）の対。気象庁 個別コード表のシート 24 から取る。
 */
export function buildCityIndex(rows: Iterable<readonly [string, string]>): CityIndex {
  const kanaOf = new Map<string, string>()
  for (const [name, furigana] of rows) {
    if (name === '' || furigana === '') continue
    kanaOf.set(name, toKana(furigana))
  }
  return [...kanaOf].map(([name, kana]) => ({ name, kana }))
    .sort((a, b) => b.name.length - a.name.length)
}

export type StationSplit = {
  readonly city: string
  /** 市町村の読み（カタカナ・核なし）。 */
  readonly cityKana: string
  /** 市町村より後ろの読み（カタカナ・核なし）。 */
  readonly localityKana: string
}

/**
 * 句割りを見送った理由。**生成側の報告にそのまま出す語**なので、読んで意味が通る形にしてある。
 *
 * **1 つの `null` に畳まないのはこのため** —— 見送りが急に増えたとき、「割れる名前が
 * もともと少なかった」のか「どの門が効きすぎているのか」をログから特定できる必要がある。
 *
 * 前 3 つは {@link splitStationName} が決める。`沖合で対象外` だけは生成側が付ける
 * （沖合の潮位観測点は値がエンジン自身のカナ表記で、既に句を含むため判定に掛けない）。
 */
export type SplitSkipReason =
  | 'モーラ数が足りない'
  | '市町村が当たらない'
  | '句が短すぎる'
  | '沖合で対象外'

/** 句割りの判定結果。割れたか、割らなかったか（＋その理由）。 */
export type SplitOutcome =
  | { readonly kind: 'split'; readonly split: StationSplit }
  | { readonly kind: 'skipped'; readonly reason: SplitSkipReason }

/**
 * 観測点名を「市町村 / 地点」に割る。割らなかった場合は理由を返す。
 *
 * **漢字と読みの両方が前方一致したときだけ割る。** 読みを見ないと、上流の命名の揺れを
 * そのまま飲み込んで**別の語の途中で割る**。実データにある揺れは 3 通り:
 *
 * - 観測点名の側にだけ都道府県の冠が付く（観測点 `静岡菊川市赤土` に対し市町村は `菊川市`）
 * - 市町村の側にだけ冠が付く（市町村 `長崎対馬市` に対し潮位観測点は `対馬市厳原`）
 * - ふりがなの促音が小書きになっていない（観測点 `日光市御幸町` のふりがなが `につこうし〜` で、
 *   市町村 `日光市` の `にっこうし` と食い違う）
 *
 * いずれも**割らずに 1 句のまま残す**のが正しい扱いで、当たらなかった件数は呼び出し側が記録する。
 * 8 モーラ以上の 1 句エントリ 2411 件のうち、割れるのは 2381 件（見送り 30 件）。
 *
 * **割るのは 1 回だけ。** 後半が長く残る場合（8 モーラ以上が 409 件）でも、そこは割らない。
 * 後半の割れ目を決めるには旧町名の読み（`丸岡町` の ちょう／まち）が要るが、気象庁のコード表は
 * 市町村までしか読みを持たない。エンジンから採る手も使えない —— **409 件のうちエンジンが後半を
 * 正しく読めるのは 1 件だけ**で、残りは後半が誤読（`岩見沢市栗沢町東本町` →
 * `クリサワマチヒガシホンマチ`。正しくは `クリサワチョウヒガシホンチョウ`）。
 * 後半が誤読であることこそが、その名前が辞書に入っている理由。
 *
 * @param furigana 気象庁のふりがな（ひらがな）。
 */
export function splitStationName(
  name: string,
  furigana: string,
  cities: CityIndex,
): SplitOutcome {
  const kana = toKana(furigana)
  if (countMoras(kana) < MIN_MORAS_TO_SPLIT) return { kind: 'skipped', reason: 'モーラ数が足りない' }
  for (const { name: city, kana: cityKana } of cities) {
    if (!name.startsWith(city) || name.length === city.length) continue
    if (!kana.startsWith(cityKana) || kana.length === cityKana.length) continue
    const localityKana = kana.slice(cityKana.length)
    // **最長一致がこの名前の境界。** モーラ数が足りないからといって短い市町村へ落とさない
    // （落とすと市町村名の途中で割れる）。ここで諦めて 1 句のまま残す。
    if (countMoras(cityKana) < MIN_MORAS_PER_PHRASE) return { kind: 'skipped', reason: '句が短すぎる' }
    if (countMoras(localityKana) < MIN_MORAS_PER_PHRASE) return { kind: 'skipped', reason: '句が短すぎる' }
    return { kind: 'split', split: { city, cityKana, localityKana } }
  }
  return { kind: 'skipped', reason: '市町村が当たらない' }
}

/**
 * 割った観測点名を AquesTalk 風カナへ変換する（`イシカ'リシ/ハナカワ'`）。
 *
 * `/` が句区切り、`'` がアクセント核。長音記号は使えないので母音の重ねへ開いてある
 * （{@link toKana} の担当）。
 *
 * **市町村の核はエンジンの実測を使う。** ふりがなはアクセントを持たないので、ふりがなから
 * 組めるのは末尾核だけだが、エンジンが市町村名に置く核は末尾ではない ——
 * `イシカリシ` は 5 モーラで核 4・`エベツシ` は 4 モーラで核 3 で、どちらも「市」の直前。
 * 末尾核で通すと、市町村名の抑揚がエンジンの判断から外れる。
 *
 * 核の位置の分布は**上流の全市町村 1894 件**を読ませて測った（探索時の値。生成はこの全件を
 * 訊かない。下記）。読みが一致して核を採れたのは 1257 件で、うち末尾は 141 件・
 * **末尾の 1 つ前が 868 件**・その他 248 件。
 *
 * 市町村名を**単独で**読ませた核を使ってよいことも実測で確かめてある ——
 * 観測点名の文脈の中で出てくる核と比べて、両方で採れた 263 件が 263 件とも一致した。
 *
 * @param cityAccent 市町村の核の位置（1 始まり）。エンジンから採れなかった場合は null を渡す。
 *   その場合は末尾核へ倒す（ふりがなだけから組める唯一の形）。採れない理由はエンジンが市町村名を
 *   誤読することで、その大半は「町」の ちょう／まち。
 *   **生成が訊くのは「誤読する観測点に現れる市町村」だけ**なので、採れる割合は上の全件の値
 *   （1257 / 1894 ＝ 66.4%）より低い ——
 *   2026-09 時点の生成では 592 / 1192 件（49.7%）。母集団がエンジンの誤読しやすい名前へ
 *   偏るため。**`npm run build-station-readings` のログに出るのは後者。**
 *   **値域を外れた場合も末尾核へ倒す** —— AquesTalk 風カナは 1 句にちょうど 1 つの核を要求し、
 *   0 個なら `ACCENT_NOTFOUND` で拒否される。実測では 0 も範囲外も現れなかったが、
 *   現れたときに黙って壊れた記法を書かないため。
 */
export function toStationAccentEntry(split: StationSplit, cityAccent: number | null): string {
  const moras = splitIntoMoras(split.cityKana)
  const at = cityAccent != null && cityAccent >= 1 && cityAccent <= moras.length
    ? cityAccent
    : moras.length
  const head = `${moras.slice(0, at).join('')}'${moras.slice(at).join('')}`
  return `${head}/${split.localityKana}'`
}
