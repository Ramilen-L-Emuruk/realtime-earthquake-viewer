// 震度観測点名の読みを、気象庁のふりがなと音声合成エンジンの読みで突き合わせる処理。
//
// 生成スクリプト（build-station-readings.ts）から使う。HTTP を持たない純粋な変換だけを置き、
// エンジンへの問い合わせは呼び出し側に任せる（この形なら単体テストで固定できる）。

/** ひらがな → カタカナの符号位置の差。 */
const KANA_OFFSET = 0x60

/**
 * 母音ごとのかな。長音記号（`ー`）を母音へ開くときと、長音表記の揺れを吸収するときに使う。
 *
 * 小書きのかな（`ぁぃぅぇぉゃゅょ`）も含める。「ティ」「センター」のような表記が実データに
 * あり（`山鹿市老人福祉センター` → `せんた-`）、開けないと比較が崩れる。
 * `ん` と `っ` は母音を持たないので、どの行にも入れない。
 */
const VOWEL_ROWS: readonly (readonly [string, string])[] = [
  ['あ', 'あかがさざただなはばぱまやらわゃぁ'],
  ['い', 'いきぎしじちぢにひびぴみりぃ'],
  ['う', 'うくぐすずつづぬふぶぷむゆるゅぅ'],
  ['え', 'えけげせぜてでねへべぺめれぇ'],
  ['お', 'おこごそぞとどのほぼぽもよろをょぉ'],
]

const VOWEL_OF = new Map<string, string>()
for (const [vowel, chars] of VOWEL_ROWS) {
  for (const ch of chars) VOWEL_OF.set(ch, vowel)
}

/** 比較の前に落とす文字。AquesTalk 風カナのアクセント記号・句区切り・無声化記号と、句読点。 */
const IGNORED_IN_READING = /['/_、。？\s]/g

/**
 * 長音記号として扱う文字。実データに半角ハイフンで書かれた点が 1 つある（`せんた-`）ので、
 * ハイフン類も含める。符号位置で書くのは、文字のまま並べると文字クラス内の `-` が範囲指定と
 * 解釈されて壊れるため。
 * 順に: 長音記号 / ハイフンマイナス / ハイフン〜水平線 / 全角ハイフンマイナス / マイナス / 半角長音。
 */
const PROLONGED_MARKS = /[\u30FC\u002D\u2010-\u2015\uFF0D\u2212\uFF70]/

export function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + KANA_OFFSET))
}

export function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - KANA_OFFSET))
}

/**
 * 長音記号を直前のかなの母音へ開く（`せんたー` → `せんたあ`）。開く先が無ければ落とす。
 *
 * 比較の正規化にも、読み上げへ渡すカナの組み立てにも要る。**後者は避けて通れない** ——
 * `/accent_phrases?is_kana=true` は長音記号を受け付けず、`センター'` は
 * `400 UNKNOWN_TEXT（判別できない読み仮名があります: ー）` で落ちる。母音の重ねなら通る。
 */
function expandProlongedMarks(hiragana: string): string {
  let out = ''
  for (const ch of hiragana) {
    if (PROLONGED_MARKS.test(ch)) {
      const vowel = VOWEL_OF.get(out.at(-1) ?? '')
      if (vowel) out += vowel
      continue
    }
    out += ch
  }
  return out
}

/**
 * 読みを比較できる形へ揃える。ひらがなに寄せ、記号を落とし、**長音の書き方の違いを吸収する**。
 *
 * 同じ読みでも表記は 3 通りに割れる —— 気象庁のふりがなは `とうべつ`、エンジンが返すモーラ列は
 * `トオベツ`、カナ表記では `トーベツ` になる。素朴に比べると全件が不一致になるので、
 *
 * - `ー` は直前のかなの母音へ開く（`センター` → `せんたあ`）
 * - お段 + `う` は お段 + `お` へ（`とうべつ` → `とおべつ`）
 * - え段 + `い` は え段 + `え` へ（`ていね` → `てえね`）
 * - `づ` `ぢ` は `ず` `じ` へ（`あいづ` と `アイズ` は同じ音）
 *
 * まで揃えてから比べる。**「町」を `ちょう` と読むか `まち` と読むかの違いは吸収しない** ——
 * 音の書き方の違いではなく、別の地名として聞こえる誤読だから（→ {@link isMisreading}）。
 */
export function normalizeReading(text: string): string {
  const hira = expandProlongedMarks(toHiragana(text).replace(IGNORED_IN_READING, ''))
  let out = ''
  for (const ch of hira) {
    const prevVowel = VOWEL_OF.get(out.at(-1) ?? '')
    if (ch === 'う' && prevVowel === 'お') { out += 'お'; continue }
    if (ch === 'い' && prevVowel === 'え') { out += 'え'; continue }
    out += ch
  }
  return out.replace(/づ/g, 'ず').replace(/ぢ/g, 'じ')
}

/**
 * エンジンの読みが気象庁のふりがなと食い違うか（＝誤読か）を返す。
 *
 * 判定は {@link normalizeReading} で揃えた列の一致だけ。**アクセントの当たりは見ない** ——
 * ふりがなはアクセントを持たないので、ここで比べられるのはモーラの並びだけ。
 */
export function isMisreading(engineReading: string, furigana: string): boolean {
  return normalizeReading(engineReading) !== normalizeReading(furigana)
}

/**
 * 文脈付きで読ませたモーラ列から、末尾に付けた助詞ぶんを外す。外せなければ null。
 *
 * **判定は名前を単体で読ませて済ませてはいけない。** 誤読は後ろに続く文字で反転する
 * （→ `docs/spec/audio-tts-spec.md` §3「何を収録するか」）。そこで読み上げ文が実際に作る形
 * （`名前、` と `名前では、`）で読ませ、返った列から助詞ぶんを差し引いて名前の読みを取り出す。
 *
 * 助詞の読みが想定と違ったとき（`では` が「デワ」で終わらない等）に黙って通さないよう、
 * 外せない場合は null を返す。呼び出し側はそこで止めること —— 差し引きを誤ると、名前の末尾の
 * モーラを削った列で比較して**誤読を捏造する**（あるいは見逃す）。
 */
export function stripReadingTail(reading: string, tail: string): string | null {
  const normalized = normalizeReading(reading)
  if (tail === '') return normalized
  const normalizedTail = normalizeReading(tail)
  if (!normalized.endsWith(normalizedTail)) return null
  return normalized.slice(0, normalized.length - normalizedTail.length)
}

/**
 * ふりがなを、読み上げに渡す AquesTalk 風カナへ変換する。
 *
 * **末尾にアクセント核（`'`）を置く。** `/accent_phrases?is_kana=true` は核を持たないアクセント句を
 * 受け付けない（`400 ACCENT_NOTFOUND`）ため、核なしでは渡せない。気象庁のふりがなはアクセントを
 * 持たないので位置は決められないが、末尾に置けば**全体が 1 アクセント句**になる。
 * カナをそのまま普通のテキストとして渡す形（核が要らない）と比べたときの違いはここで、
 * あちらはエンジンが句を勝手に割る（`イシカリシハナカワ` → `イシ'カリ/シ'ハナ/カワ'`）。
 *
 * アクセントの当たりが悪いものは、実際に聞いてから `tts-phrase-break-dict.json` へ手で足す
 * （そちらのキーが優先される）。
 */
export function toKanaEntry(furigana: string): string {
  return `${toKatakana(expandProlongedMarks(toHiragana(furigana)))}'`
}

/**
 * ふりがなとして扱えない文字を含むかを返す。含む点は読みを作れないので、生成側で記録する。
 *
 * 長音記号は通す（{@link toKanaEntry} が `ー` へ直す）。
 */
export function hasUnreadableFurigana(furigana: string): boolean {
  if (furigana === '') return true
  for (const ch of furigana) {
    if (PROLONGED_MARKS.test(ch)) continue
    if (!/[ぁ-ゖ]/.test(ch)) return true
  }
  return false
}
