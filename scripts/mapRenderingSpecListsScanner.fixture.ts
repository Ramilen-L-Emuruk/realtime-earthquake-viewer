// `mapRenderingSpecLists.test.ts` の走査に食わせる合成入力。
//
// **中身は実装ではなく標本。** 走査そのものの振る舞いを固定するために置いてある。
// テストの中に直接書かないのは、`type: 'custom'` や `createFakeLayer(` の字面がテスト
// ファイル自身に現れると、**走査の対象から `.test.ts` を外している前提**を読む人が
// 確かめにくくなるため。文字列として export するだけで、ここのコードは一度も実行されない。
//
// 標本が確かめるのは 1 つ —— **コメントの中に書いた使用例を実装として数えないこと**。
// 実リポジトリとの突き合わせ（このファイルを使わない 5 件）は、`src` にその書き方が
// 現れるまで走査の壊れに気づけない。

/** 走査へ渡す 1 ファイル分。 */
export type Sample = { path: string; text: string }

/** id を引数で受け取るカスタムレイヤーのファクトリ（`gl/depthPointLayer.ts` と同じ形）。 */
export const FACTORY: Sample = {
  path: 'src/fake/fakeLayer.ts',
  text: [
    'export function createFakeLayer(id: string) {',
    '  return {',
    '    id,',
    "    type: 'custom',",
    '  }',
    '}',
  ].join('\n'),
}

/** ファクトリを呼ぶ側。**行コメントに書いた使用例**を実装と取り違えないこと。 */
export const CALLER_WITH_LINE_COMMENT: Sample = {
  path: 'src/fake/CallerA.tsx',
  text: [
    "import { createFakeLayer } from './fakeLayer'",
    "// 例: createFakeLayer('example-only-id') のように呼ぶ",
    "const LYR = 'caller-a'",
    'export const layer = createFakeLayer(LYR)',
  ].join('\n'),
}

/**
 * ファクトリを呼ぶ側。**文字列の中の `//`** を行コメントの始まりと取り違えないこと。
 * 取り違えると同じ行にある本物の呼び出しごと消え、**黙って漏れる**。
 */
export const CALLER_WITH_URL: Sample = {
  path: 'src/fake/CallerB.tsx',
  text: [
    "import { createFakeLayer } from './fakeLayer'",
    "const LYR = 'caller-b'",
    "export const base = 'https://example.test'; export const layer = createFakeLayer(LYR)",
  ].join('\n'),
}

/**
 * ファクトリをアロー関数で公開する形。名前は入れ物の変数から取らないと引けない。
 *
 * **関数宣言（`FACTORY`）とは別の分岐を通る。** 片方だけを標本にすると、もう片方が
 * 壊れていても `src` にその書き方が現れるまで気づけない。
 */
export const FACTORY_ARROW: Sample = {
  path: 'src/fake/arrowFactory.ts',
  text: [
    "export const makeArrowLayer = (id: string) => ({ id, type: 'custom' as const })",
  ].join('\n'),
}

/** アロー関数のファクトリを呼ぶ側。 */
export const CALLER_OF_ARROW: Sample = {
  path: 'src/fake/CallerD.tsx',
  text: [
    "import { makeArrowLayer } from './arrowFactory'",
    "const LYR = 'caller-d'",
    'export const layer = makeArrowLayer(LYR)',
  ].join('\n'),
}

/**
 * `id` の省略記法が**引数ではなく外側の変数**を指す形。
 *
 * 囲む関数に `id` という引数が無いので、ファクトリを辿る分岐ではなく
 * 「同じファイルの `const` から引く」分岐へ落ちる。
 */
export const LAYER_WITH_OUTER_CONST_ID: Sample = {
  path: 'src/fake/OuterConstLayer.ts',
  text: [
    "const id = 'outer-const-layer'",
    "export const layer = { id, type: 'custom' as const }",
  ].join('\n'),
}

/**
 * 引数を**包んで**渡す呼び出し側（括弧・`as`）。どちらも値を変えない書き方なので、
 * 剥がさずに弾くと**正しい書き方で落ちる**。
 */
export const CALLER_WITH_WRAPPED_ARGUMENT: Sample = {
  path: 'src/fake/CallerC.tsx',
  text: [
    "import { createFakeLayer } from './fakeLayer'",
    "const LYR = 'caller-c'",
    'export const layer = createFakeLayer((LYR) as string)',
  ].join('\n'),
}

/**
 * `type: 'custom' as const` と書いたレイヤー。
 *
 * **文字列リテラルだけを見る作りだと、このレイヤーが 1 枚まるごと実装から漏れる**
 * （構文木へ移した検証中に実際に作り込んだ）。id は同じファイルの `const` から引く。
 */
export const LAYER_WITH_AS_CONST: Sample = {
  path: 'src/fake/AsConstLayer.ts',
  text: [
    "const LYR = 'as-const-layer'",
    "export const layer = { id: LYR, type: 'custom' as const }",
  ].join('\n'),
}

/**
 * id を公開用の `const` から**別名で受けて**使うレイヤー（`gl/dayNightLayer.ts` と同じ形）。
 *
 * id を外へ出す必要があるファイルは `export const 〜_LAYER_ID = '...'` を置き、ファイル内では
 * 短い名前を作る。文字列リテラルしか見ない作りでは**この正しい書き方で検査が落ちる**ので、
 * 同じファイルの中の別名は辿る（二重管理へ追い込まないため）。
 */
export const LAYER_WITH_ALIASED_ID: Sample = {
  path: 'src/fake/AliasedIdLayer.ts',
  text: [
    "export const ALIASED_LAYER_ID = 'aliased-id-layer'",
    'const LYR = ALIASED_LAYER_ID',
    "export const layer = { id: LYR, type: 'custom' as const }",
  ].join('\n'),
}

/**
 * どの検査にも引っかかってはいけないファイル。
 *
 * **ブロックコメントの継続行に `*` を置かない書き方**（このリポジトリで主流）で、
 * カスタムレイヤーの宣言・`webglcontextrestored` の購読・`projectionProgram` の
 * 取り込みを「かつてこう書いていた」として全部含む。
 */
export const RED_HERRING: Sample = {
  path: 'src/fake/NotALayer.tsx',
  text: [
    '/* 以前はカスタムレイヤーだった。',
    "   id: LEGACY, type: 'custom', onAdd() {} という形で、",
    "   import { applyProjectionUniforms } from './projectionProgram' を使い、",
    "   map.on('webglcontextrestored', onRestored) で載せ直していた。",
    '   いまは通常の DOM マーカー。 */',
    "const LEGACY = 'legacy-id'",
    'export const NOT_A_LAYER = LEGACY',
  ].join('\n'),
}

/** 上のすべてをまとめたもの（走査は「ファイルの集まり」を受け取る）。 */
export const ALL: Sample[] = [
  FACTORY,
  CALLER_WITH_LINE_COMMENT,
  CALLER_WITH_URL,
  CALLER_WITH_WRAPPED_ARGUMENT,
  FACTORY_ARROW,
  CALLER_OF_ARROW,
  LAYER_WITH_AS_CONST,
  LAYER_WITH_OUTER_CONST_ID,
  LAYER_WITH_ALIASED_ID,
  RED_HERRING,
]

/** 実装として数えてほしい id（`ALL` を走査したときの期待値）。 */
export const EXPECTED_IDS = [
  'aliased-id-layer',
  'as-const-layer',
  'caller-a',
  'caller-b',
  'caller-c',
  'caller-d',
  'outer-const-layer',
]
