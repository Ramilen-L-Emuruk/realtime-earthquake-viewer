// `xlsx.mjs` の型宣言。**実装は JS 側が正**で、ここはそれを TypeScript から呼ぶための宣言だけ。
//
// 実装を .ts へ移していないのは、`build-tsunami-obs-coords.mjs` が素の node で動かす規定
// （`node scripts/build-tsunami-obs-coords.mjs`）で、そちらから import できる形を保つため。

/**
 * zip の中から、条件に合う xlsx を 1 つ選んでシートを読む。見つからなければ null。
 *
 * **`@returns` が null を含むことに注意。** 実装の JSDoc は Map だけを書いているが、
 * どのブックも条件に合わなければ null を返す（`xlsx.mjs` の末尾）。
 */
export function findWorkbookInZip(
  zipBytes: Uint8Array,
  matches: (sheets: Map<string, unknown[][]>) => boolean,
): Map<string, unknown[][]> | null
