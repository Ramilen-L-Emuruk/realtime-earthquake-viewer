/**
 * 地震カードの震度一覧・長周期地震動の一覧の 1 行を、地名から引く（テスト用）。
 *
 * **行の DOM の形を前提にしている。** 行は直下に span を 2 つだけ持ち、1 つ目が
 * 「震度（階級）と、その値についての印」、2 つ目が「地名・`＊`・開閉の記号」。地名は
 * 2 つ目の先頭の子要素で、そこを完全一致で見る（→ `EarthquakeCard` の `IntensityRow` /
 * `LpgmRow`。並べ方の規約は docs/spec/quake-spec.md §8「地名は右端で揃える」）。
 *
 * **`getByText('〇〇＊')` では引けない。** 地名と `＊` は右端を揃えるために別の要素へ
 * 分けてあり、Testing Library の既定の照合は直下のテキストノードしか繋がない。
 *
 * **2 つのテストファイルで共有する。** 同じ述語を書き写すと、行の形を変えたときに
 * 片方だけ直して静かに引けなくなる（実際に 2 ファイルへ分かれていたところを集約した）。
 */
export function findIntensityRow(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll('div')].find(el =>
    el.children.length === 2
    && el.children[0].tagName === 'SPAN'
    && el.children[1].tagName === 'SPAN'
    && el.children[1].children[0]?.textContent === name) as HTMLElement | undefined
}

/** その地名の行に出ている文字列（印・`＊`・開閉の記号まで含む）。行が無ければ空文字。 */
export function intensityRowText(name: string): string {
  return findIntensityRow(name)?.textContent?.trim() ?? ''
}
