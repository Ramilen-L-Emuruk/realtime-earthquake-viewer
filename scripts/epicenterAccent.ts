// 震央地名を「前部要素 / 後部要素」に割り、読み上げ用のカナ表記へ変換する。
//
// 生成スクリプト（build-epicenter-accents.ts）から使う。HTTP を持たない純粋な変換だけを置く。
// 読みの正規化とカナの組み立ては震度観測点と共通（`stationReading.ts`）。

import { countMoras, normalizeReading, splitIntoMoras, toKana, toKanaEntry } from './stationReading'

/**
 * 震央地名の後部要素（漢字とその読みの対）。**長いものを先に並べる** ——
 * `南東沖` を `沖` より先に当てないと、`根室半島南東沖` が `根室半島南東 / 沖` に割れる。
 *
 * 漢字と読みの**両方**が一致したときだけ割る（→ {@link splitEpicenter}）。読みを見ずに漢字だけで
 * 割ると、同じ字で読みが違う名前（`〜島` の しま／じま）で前部要素の読みがずれる。
 */
export const SUFFIXES: readonly (readonly [string, string])[] = [
  // 方位を伴う沖
  ['東方はるか沖', 'とうほうはるかおき'],
  ['南東沖', 'なんとうおき'], ['南西沖', 'なんせいおき'],
  ['北東沖', 'ほくとうおき'], ['北西沖', 'ほくせいおき'],
  ['東方沖', 'とうほうおき'], ['西方沖', 'せいほうおき'],
  ['南方沖', 'なんぽうおき'], ['北方沖', 'ほっぽうおき'],
  // 海域・地形
  ['近海', 'きんかい'], ['付近', 'ふきん'], ['沿岸', 'えんがん'],
  ['諸島', 'しょとう'], ['列島', 'れっとう'], ['半島', 'はんとう'],
  ['海峡', 'かいきょう'], ['水道', 'すいどう'],
  ['太平洋', 'たいへいよう'], ['大西洋', 'たいせいよう'],
  // 行政・区分
  ['地方', 'ちほう'],
  ['東北部', 'とうほくぶ'], ['西北部', 'せいほくぶ'],
  ['平野部', 'へいやぶ'], ['山沿い', 'やまぞい'], ['内陸', 'ないりく'],
  ['北部', 'ほくぶ'], ['南部', 'なんぶ'], ['中部', 'ちゅうぶ'],
  ['東部', 'とうぶ'], ['西部', 'せいぶ'],
  // 1 文字のものは最後（上のどれにも当たらなかったときだけ）
  ['沖', 'おき'], ['湾', 'わん'], ['灘', 'なだ'],
]

/**
 * 後部要素の下限モーラ数。**これを下回るなら割らない。**
 *
 * `能登半島沖` の後部要素は `オキ` の 2 モーラしかなく、読み上げ文で直後に付く助詞を取り込むと
 * `オキ＼オ` という短い句になる（→ `docs/spec/audio-tts-spec.md` §3「助詞は辞書の読みへ取り込む」）。
 * 割らずに 1 句のまま渡せばエンジンが「沖」の直前へ核を置き、その形は崩れていない
 * （`ノトハントオ＼オキ`。2026-09-19 に `〜沖` の 33 件すべてで実測し、例外は無かった）。
 *
 * **観測点名の句割りが持つ下限（各句 2 モーラ以上）より 1 つ厳しい。** あちらは辞書の読みが
 * そのまま句になるが、こちらは後部要素へ助詞が付く形が普通にあるため。
 * 実データで落ちるのは `オキ`（2 モーラ）だけで、残る後部要素は 3 モーラ以上ある。
 */
export const MIN_TAIL_MORAS = 3

export type EpicenterSplit = {
  readonly head: string
  readonly headKana: string
  readonly tail: string
  readonly tailKana: string
}

/**
 * 震央地名を「前部要素 / 後部要素」に割る。割れなければ null。
 *
 * **割るのは 1 回だけ。** `房総半島南方沖` は `ぼうそうはんとう / なんぽうおき` の 2 句にする
 * （`ぼうそう / はんとう / なんぽうおき` まで刻むと、地名の輪郭がかえって崩れる）。
 *
 * 後部要素だけの名前（`近海` のような単独）は割らない。前部要素が空になるため。
 */
export function splitEpicenter(name: string, kana: string): EpicenterSplit | null {
  const outcome = splitEpicenterDetailed(name, kana)
  return 'split' in outcome ? outcome.split : null
}

/** 割らなかった理由。 */
export type UnsplitReason =
  /** 後部要素の表（{@link SUFFIXES}）に当たるものが無い */
  | 'no-suffix'
  /** 後部要素だけの名前で、前部要素が空になる（`近海` 等） */
  | 'empty-head'
  /** 後部要素が短すぎる（→ {@link MIN_TAIL_MORAS}） */
  | 'tail-too-short'

export type SplitOutcome =
  | { readonly split: EpicenterSplit }
  | { readonly reason: UnsplitReason }

/**
 * {@link splitEpicenter} と同じ判定を行い、**割らなかったときは理由も返す**。
 *
 * 生成スクリプトが記録へ出すために要る —— 理由を区別せずに「後部要素の表に無い構成」とだけ
 * 書くと、**表に載っているのに短くて落ちた名前**（`能登半島沖`）を表の不備として誤報する。
 * 判定を 2 か所へ書き分けないよう、`splitEpicenter` はこの関数の薄いラッパーにしてある。
 */
export function splitEpicenterDetailed(name: string, kana: string): SplitOutcome {
  let sawEmptyHead = false
  for (const [tail, tailKana] of SUFFIXES) {
    if (!name.endsWith(tail) || !kana.endsWith(tailKana)) continue
    const head = name.slice(0, name.length - tail.length)
    const headKana = kana.slice(0, kana.length - tailKana.length)
    if (head === '' || headKana === '') { sawEmptyHead = true; continue }
    // 短すぎる後部要素では割らない（→ MIN_TAIL_MORAS）。**表は長い順なので、ここまで来たなら
    // 残りの候補はこれより短いか当たらないかのどちらか。** 次を試さず打ち切ってよい
    if (countMoras(toKana(tailKana)) < MIN_TAIL_MORAS) return { reason: 'tail-too-short' }
    return { split: { head, headKana, tail, tailKana } }
  }
  return { reason: sawEmptyHead ? 'empty-head' : 'no-suffix' }
}

/** 各句の核。エンジンから採れなかった句は `null`（→ {@link toAccentEntry} が代わりの位置を決める）。 */
export type ComponentAccents = {
  readonly head: number | null
  readonly tail: number | null
}

/**
 * 前部要素が「〜地方」で終わるか。読みで見る（`ちほう` と `ちほお` の表記ゆれを吸収する）。
 *
 * export しているのは生成スクリプトのため —— この形の前部要素は核を実測より優先して決めるので、
 * エンジンへ訊く対象から外す（訊いても結果が使われず、実測できた割合の数字だけが狂う）。
 */
export function endsWithChihou(kana: string): boolean {
  const normalized = normalizeReading(kana)
  return normalized.endsWith('ちほお') && countMoras(toKana(kana)) > 3
}

/**
 * 1 句ぶんの AquesTalk 風カナを組み立てる。**核の決め方は 3 段**。
 *
 * 1. **「〜地方」は「チ」に核** —— 実測より先に見る。エンジンは語によって「ホ」へ核を置くが
 *    （`十勝地方` は単独で 1 句 `トカチチホ＼オ`）、手書きの句区切り辞書が持つ形は `オシマチ'ホオ`・
 *    `シリベシチ'ホオ` で「チ」。UniDic の `地方` も aType=1（チ＼ホー）。実測を優先すると同じ
 *    「〜地方」が語ごとに違う位置へ割れる
 * 2. **エンジンの実測**（`accent`）—— その語を単独で読ませて 1 句にまとまり、読みがふりがなと
 *    一致したときだけ渡ってくる。末尾核で通していた頃は `ヨーロッパ＼`・`チューゴク＼` のように
 *    明らかに外れる語があった
 * 3. **どちらでもなければ末尾核** —— ふりがなはアクセントを持たないので位置を決められない。
 *    末尾なら句がそこで完結する（理由の詳細は `toKanaEntry`）
 *
 * 長音記号の扱いは `toKanaEntry` に合わせる（AquesTalk 風カナは `ー` を受け付けない）。
 */
function phraseEntry(kana: string, accent: number | null, isHead: boolean): string {
  const moras = splitIntoMoras(toKana(kana))
  // 「〜地方」は実測より先に見る。**エンジンは語によって「チホオ」の「ホ」へ核を置く**
  // （`十勝地方` は単独で 1 句 `トカチチホ＼オ` と読める）が、手書きの句区切り辞書が持つ形は
  // `オシマチ'ホオ`・`シリベシチ'ホオ` で「チ」。実測を優先すると同じ「〜地方」が語ごとに
  // 違う位置へ割れる
  if (isHead && endsWithChihou(kana)) {
    const at = moras.length - 2                     // 「チホオ」の「チ」
    return `${moras.slice(0, at).join('')}'${moras.slice(at).join('')}`
  }
  if (accent != null && accent >= 1 && accent <= moras.length) {
    return `${moras.slice(0, accent).join('')}'${moras.slice(accent).join('')}`
  }
  return toKanaEntry(kana)
}

/**
 * 割った震央地名を AquesTalk 風カナへ変換する（`ミヤコジマ'/キンカイ'`）。
 * `/` が句区切り、`'` がアクセント核。核の決め方は {@link phraseEntry}。
 */
/** 「〜地方」の核を当てられなかった理由。**見送りを黙って落とさない**ために区別する。 */
export type ChihouSkipReason =
  /** 「〜地方」で終わらない（大多数。正常な見送り） */
  | 'not-chihou'
  /** 中黒を含む（割れ目が 3 つになる。手書きの句区切り辞書の担当） */
  | 'nakaguro'
  /** 「県」の読みを切り出せない */
  | 'no-prefecture-reading'
  /** 「県」または「けん」が 2 つ以上あり、どこで割るか決められない */
  | 'ambiguous-prefecture'

export type ChihouOutcome =
  | {
    readonly entry: string
    /**
     * 値の句に対応する漢字。**呼び出し側が割り直さずに済むように返す** —— 同じ計算を
     * 2 箇所に置くと、割り方を変えたときに片方だけ古い分割点で組み立て続ける
     * （句の漢字が実際とずれても、揃えの対象から静かに漏れるだけで誰も気づかない）。
     */
    readonly origin: readonly string[]
  }
  | { readonly reason: ChihouSkipReason }

/**
 * 「〜地方」で終わる名前のエントリ。**句割りの門（モーラ数・句数）を通さずに当てる。**
 *
 * エンジンは「チホオ」の**「ホ」の後**へ核を置く（`キタミチホ＼オ`・`アバシリチホ＼オ`）。
 * 手書きの句区切り辞書と UniDic の `地方`（aType=1）はどちらも「チ」なので、放っておくと
 * 同じ「〜地方」が辞書のあるものと無いもので違う位置に割れる。**短い名前ほど句割りの門
 * （8 モーラ以上の 1 句）に掛からないので、そこで落ちたものが崩れたまま残っていた**
 * （`檜山地方` は 6 モーラで、しかもエンジンは `ヒヤマ / チホオ` と 2 句に割る）。
 *
 * 割り方は 2 通り。
 *
 * - **県名が前に付くなら「県」の後で割る** —— `石川県能登地方` は `イシカワ'ケン/ノトチ'ホオ`。
 *   手書き辞書が持つ形（`ニイガタ'ケン/チュウエツチ'ホオ`）と揃える。県名の核は「県」の直前で、
 *   これはエンジンの実測とも一致する（`イシカワケン` は核4）
 * - **付かないなら割らない** —— `檜山地方` は `ヒヤマチ'ホオ` の 1 句
 *
 * **中黒を含む名前は扱わない**（`熊本県天草・芦北地方`）。割れ目が 3 つになり、中黒の前後を
 * どう分けるかはこの規則からは決まらない。手書きの句区切り辞書の担当。
 *
 * @returns 当てられないときは理由（→ {@link ChihouSkipReason}）。
 */
export function chihouAccentEntry(name: string, kana: string): ChihouOutcome {
  if (!endsWithChihou(kana)) return { reason: 'not-chihou' }
  // **中黒を含む名前は扱わない**（割れ目が 3 つになる）。見送ったことは呼び出し側が記録する
  if (name.includes('・')) return { reason: 'nakaguro' }
  const at = name.indexOf('県')
  if (at < 0) return { entry: phraseEntry(kana, null, true), origin: [name] }
  // **漢字の位置と読みの位置は独立に求めている**ので、どちらも 1 回だけ現れるときに限る。
  // 2 つ以上あるとどれが対応するか決められず、誤った位置で割った値を検証なしに書き出しうる
  // （連結すれば元の読みに戻るので、生成時の往復検証では捕まらない）。
  if (name.indexOf('県', at + 1) >= 0) return { reason: 'ambiguous-prefecture' }
  const head = name.slice(0, at + 1)
  const tail = name.slice(at + 1)
  const normalized = normalizeReading(kana)
  const kanaAt = normalized.indexOf('けん')
  if (!head || !tail || kanaAt < 0) return { reason: 'no-prefecture-reading' }
  if (normalized.indexOf('けん', kanaAt + 2) >= 0) return { reason: 'ambiguous-prefecture' }
  const headKana = kana.slice(0, kanaAt + 2)
  const tailKana = kana.slice(kanaAt + 2)
  if (!headKana || !tailKana) return { reason: 'no-prefecture-reading' }
  return {
    entry: `${prefectureEntry(headKana)}/${phraseEntry(tailKana, null, true)}`,
    origin: [head, tail],
  }
}

/** 「〇〇県」の核は「県」の直前に置く（`イシカワ'ケン`）。エンジンの実測とも一致する。 */
function prefectureEntry(kana: string): string {
  const moras = splitIntoMoras(toKana(kana))
  const at = moras.length - 2                       // 「ケン」の直前
  if (at < 1) return toKanaEntry(kana)
  return `${moras.slice(0, at).join('')}'${moras.slice(at).join('')}`
}

export function toAccentEntry(split: EpicenterSplit, accents?: ComponentAccents): string {
  return `${phraseEntry(split.headKana, accents?.head ?? null, true)}`
    + `/${phraseEntry(split.tailKana, accents?.tail ?? null, false)}`
}
