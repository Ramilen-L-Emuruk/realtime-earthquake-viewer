// 震央地名を「前部要素 / 後部要素」に割り、読み上げ用のカナ表記へ変換する。
//
// 生成スクリプト（build-epicenter-accents.ts）から使う。HTTP を持たない純粋な変換だけを置く。
// 読みの正規化とカナの組み立ては震度観測点と共通（`stationReading.ts`）。

import { toKanaEntry } from './stationReading'

/**
 * 震央地名の後部要素（漢字とその読みの対）。**長いものを先に並べる** ——
 * `南東沖` を `沖` より先に当てないと、`根室半島南東沖` が `根室半島南東 / 沖` に割れる。
 *
 * 漢字と読みの**両方**が一致したときだけ割る（→ {@link splitEpicenter}）。読みを見ずに漢字だけで
 * 割ると、同じ字で読みが違う名前（`〜島` の しま／じま）で前部要素の読みがずれる。
 */
const SUFFIXES: readonly (readonly [string, string])[] = [
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
  for (const [tail, tailKana] of SUFFIXES) {
    if (!name.endsWith(tail) || !kana.endsWith(tailKana)) continue
    const head = name.slice(0, name.length - tail.length)
    const headKana = kana.slice(0, kana.length - tailKana.length)
    if (head === '' || headKana === '') continue
    return { head, headKana, tail, tailKana }
  }
  return null
}

/**
 * 割った震央地名を AquesTalk 風カナへ変換する（`ミヤコジマ'/キンカイ'`）。
 *
 * `/` が句区切り、`'` がアクセント核。**核は各句の末尾に置く** —— ふりがなはアクセントを持たない
 * ので位置を決められず、末尾なら句がそこで完結する（理由の詳細は `toKanaEntry`）。
 * 長音記号の扱いも `toKanaEntry` に合わせる（AquesTalk 風カナは `ー` を受け付けない）。
 */
export function toAccentEntry(split: EpicenterSplit): string {
  return `${toKanaEntry(split.headKana)}/${toKanaEntry(split.tailKana)}`
}
