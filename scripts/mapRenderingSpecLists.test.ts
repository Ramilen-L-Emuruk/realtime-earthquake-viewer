import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'
import * as fixture from './mapRenderingSpecListsScanner.fixture'

// [`map-rendering-spec.md`](../docs/spec/map-rendering-spec.md) には「実装を列挙した」箇所が
// いくつもある（カスタムレイヤーの id・投影ごとのプログラムが要るファイル・コンテキストロスト
// から自分で載せ直すコンポーネント・`gl/` 配下のファイル構成）。**どれも手で保守されているため、
// 実装より少なくなる方向へ崩れる。**
//
// 実際に 2026-09-18 の作業（推計震度分布図を canvas から WebGL カスタムレイヤーへ移した変更）で、
// ドキュメント客観レビューの 3 巡すべてが「列挙が実装より少ない」を指摘した。毎回別の箇所で、
// 毎回手で揃えた。**次にレイヤーやファイルを足せば同じことが起きる**ので、ここで機械的に止める。
//
// 落とし方は**両方向**を見る。
// - 「実装にあるのに一覧に無い」—— 足したものを書き忘れた（上記のレビューが毎回見つけた形）
// - 「一覧にあるのに実装に無い」—— リネーム・削除の取り残し。こちらは読み手を存在しない
//   ファイルへ案内するので、欠けているより紛らわしい
//
// **実装側は TypeScript の構文木で読む。正規表現で読まない。**
// 最初は正規表現で書いたが、敵対的レビューの 4 巡のうち 3 巡が同じクラスの欠陥を出した
// ——「コメントに書いた使用例を実装として拾う」「同じファイルの 2 件目の呼び出しを見落とす」
// 「ブロックコメントの継続行に `*` が無いと素通しする」。**どれも個別の穴ではなく、
// 構文を文字列パターンで近似したことの帰結**で、直すたびに別の形で戻ってきた。
// 構文木なら、コメント・文字列・呼び出し・引数の区別を言語の側が保証する。
//
// **仕様書側は正規表現のままでよい。** Markdown に構文木は無く、切り出しの当否は
// 下の非空チェックと `section()` の throw で担保する。
//
// **§7「mode 別レイヤー一覧」の mode との対応は検査していない。** あれは `JapanMapGL.tsx` の
// JSX の条件分岐（`mode === 'quake' && ...`）と、無条件にマウントしてコンポーネント内部で
// 出し入れするものが混ざっており、どの mode でどれが出るかは構文木からも決まらない（値の評価が要る）。
// 代わりに「挙げたコンポーネントが実在するか」だけを見る（リネームの取り残しは捕まる）。
// 逆向き（実在するのに §7 に無い）も見ていない —— 載せないと決めたものが実際にあるため
// （`CameraFollowsGL` はレイヤーではない・`JapanMapGL` は配線の中枢）。

const SPEC = 'docs/spec/map-rendering-spec.md'
const MAP_DIR = 'src/components/Map'
const GL_DIR = `${MAP_DIR}/gl`

// ---- 仕様書側の読み取り ----

/**
 * 見出しから、**同じ深さ以下**の次の見出しまでを切り出す（下位の小見出しは中に含める）。
 *
 * 深さを見ずに「次の見出しまで」で切ると、小見出しを持つ節（§7 は直後に `### quake モード` が
 * 来る）が空になる。**その形は「一覧が 0 件」として現れるので、下の非空チェックが無ければ
 * 黙って通る。** 実際にこの検査を書いたときに踏んだ。
 *
 * **見出しが見つからなければ throw する。** 節番号や見出し文が変わったときに、黙って空文字を
 * 走査して「一覧も実装も 0 件」で通る形にしないため。以下の検査はすべてここを通す。
 */
function section(text: string, heading: RegExp): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => /^#{2,6}\s/.test(l) && heading.test(l))
  if (start < 0) throw new Error(`${SPEC} に ${heading} に一致する見出しが無い（節の切り出しが壊れている）`)
  const depth = lines[start].match(/^#+/)![0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const found = lines[i].match(/^(#{1,6})\s/)
    if (found && found[1].length <= depth) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

/** 節の中から「この文字列を含む行」以降を切り出す（節の一部だけを対象にしたいとき）。 */
function fromLineContaining(text: string, marker: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.includes(marker))
  if (start < 0) throw new Error(`${SPEC} の対象節に「${marker}」が無い（目印が変わっている）`)
  return lines.slice(start).join('\n')
}

/** バッククォートで囲まれた語をすべて拾い、`keep` に通ったものだけ返す（重複は畳む）。 */
function backticked(text: string, keep: RegExp): string[] {
  const found = text.match(/`[^`\n]+`/g) ?? []
  return [...new Set(found.map(t => t.slice(1, -1)).filter(t => keep.test(t)))]
}

// ---- 実装側の読み取り（構文木） ----

type SourceFile = { path: string; ast: ts.SourceFile }

function parseSource(path: string, text: string): SourceFile {
  return {
    path,
    // `setParentNodes` を true にするのは、`id` の省略記法から**それを囲む関数**へ遡るため。
    ast: ts.createSourceFile(
      path, text, ts.ScriptTarget.Latest, true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  node.forEachChild(child => walk(child, visit))
}

function listSourcePaths(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourcePaths(path))
    // テストは実装ではない（`type: 'custom'` を書いた作り物のレイヤーが混ざる）。
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

async function loadSources(): Promise<SourceFile[]> {
  const paths = listSourcePaths('src')
  return Promise.all(
    paths.map(async path => {
      const normalized = path.replace(/\\/g, '/')
      return parseSource(normalized, await readFile(path, 'utf8'))
    }),
  )
}

/** そのノードが何行目にあるか（1 始まり）。エラーに出す位置のため。 */
function lineOf(file: SourceFile, node: ts.Node): number {
  return file.ast.getLineAndCharacterOfPosition(node.getStart(file.ast)).line + 1
}

/** オブジェクトのプロパティ名（計算プロパティなど名前が定まらないものは null）。 */
function propertyName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text
  return null
}

/**
 * `const <name> = '<値>'` の値を返す（ファイル内のどこにあってもよい）。
 *
 * **別の `const` を経由していても辿る。** id を外へ公開する必要があるファイルは
 * `export const DAY_NIGHT_LAYER_ID = 'day-night'` を置いたうえで `const LYR = DAY_NIGHT_LAYER_ID`
 * と短い名前を作る（`gl/dayNightLayer.ts`）。リテラルしか見ない作りでは、この**正しい書き方で
 * 検査が落ちる**——しかも症状は「レイヤーの id を引けない」で、一覧の当否とは無関係に見える。
 * 二重管理（同じ文字列を 2 箇所に書く）へ追い込まないこと。
 */
function constString(file: SourceFile, name: string, seen: Set<string> = new Set()): string | null {
  // `const a = b; const b = a` のような循環で止まらなくなるのを防ぐ。
  if (seen.has(name)) return null
  seen.add(name)
  let found: string | null = null
  let alias: string | null = null
  walk(file.ast, n => {
    if (found !== null || alias !== null) return
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== name) return
    if (!n.initializer) return
    const e = unwrapExpression(n.initializer)
    if (ts.isStringLiteral(e)) found = e.text
    else if (ts.isIdentifier(e)) alias = e.text
  })
  if (found !== null) return found
  return alias === null ? null : constString(file, alias, seen)
}

/** `import ... from '<パス>/<moduleBase>'` で読み込んでいるか。 */
function importsModule(file: SourceFile, moduleBase: string): boolean {
  let found = false
  walk(file.ast, n => {
    if (found) return
    if (!ts.isImportDeclaration(n) && !ts.isExportDeclaration(n)) return
    const spec = n.moduleSpecifier
    if (spec && ts.isStringLiteral(spec) && spec.text.endsWith(`/${moduleBase}`)) found = true
  })
  return found
}

/** `<何か>.on('webglcontextrestored', ...)` を呼んでいるか。 */
function subscribesContextRestored(file: SourceFile): boolean {
  let found = false
  walk(file.ast, n => {
    if (found) return
    if (!ts.isCallExpression(n)) return
    if (!ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'on') return
    const [first] = n.arguments
    if (first && ts.isStringLiteral(first) && first.text === 'webglcontextrestored') found = true
  })
  return found
}

/**
 * `type: 'custom'` を宣言しているオブジェクトリテラルを、文書順で返す。
 *
 * **値は包みを剥がしてから見る。** `type: 'custom' as const` と書かれたレイヤーを
 * 見落とした（検証中に実際に作り込んだ）。文字列リテラルだけを見る作りは、
 * 「レイヤーが 1 枚まるごと実装として数えられない」という**黙って漏れる**形になる。
 */
function customLayerObjects(file: SourceFile): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = []
  walk(file.ast, n => {
    if (!ts.isObjectLiteralExpression(n)) return
    const isCustom = n.properties.some(p => {
      if (!ts.isPropertyAssignment(p) || propertyName(p) !== 'type') return false
      const value = unwrapExpression(p.initializer)
      return ts.isStringLiteral(value) && value.text === 'custom'
    })
    if (isCustom) out.push(n)
  })
  return out
}

/**
 * そのノードを囲む関数のうち、**`id` という引数を取るいちばん内側のもの**の名前。
 *
 * 遡るのは関数だけ。途中にある変数宣言を名前として採ってはいけない
 * ——`gl/depthPointLayer.ts` はレイヤーを `const layer = { id, type: 'custom', ... }` に
 * 入れているので、変数も見る作りにするとファクトリではなく `layer` を掴む。
 *
 * 引数名まで確かめるのは、`id` の省略記法が**引数ではなく外側の変数**を指している
 * 可能性があるため（そのときは null を返し、呼び出し側が変数として引き直す）。
 */
function enclosingFactoryTakingId(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isFunctionDeclaration(n) && !ts.isFunctionExpression(n) && !ts.isArrowFunction(n)) continue
    if (!n.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === 'id')) continue
    if (ts.isFunctionDeclaration(n)) return n.name?.text ?? null
    // `export const makeX = (id: string) => ...` の形。名前は入れ物の変数から取る。
    const holder = n.parent
    return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : null
  }
  return null
}

/** `factory(...)` の第 1 引数を、そのファイルにある呼び出しすべてについて返す。 */
function firstArgumentsOfCallsTo(file: SourceFile, factory: string): ts.Expression[] {
  const out: ts.Expression[] = []
  walk(file.ast, n => {
    if (!ts.isCallExpression(n)) return
    if (!ts.isIdentifier(n.expression) || n.expression.text !== factory) return
    if (n.arguments.length > 0) out.push(n.arguments[0])
  })
  return out
}

/**
 * `getStyle().layers` に現れないカスタムレイヤーの id を実装から集める。
 *
 * id の在りかは 2 通りある。
 * - **同じファイルが持つ**（`id: LYR,` ＋ `const LYR = '...'`）
 * - **引数で受け取る**（`id,` の省略記法）—— `gl/depthPointLayer.ts` のように 1 つの実装を
 *   複数のレイヤーで使い回す作り。id はそのモジュールを import している側にあるので、
 *   囲んでいる関数の名前を取り、その関数を呼んでいるファイルの第 1 引数を辿って引く
 *
 * **引けなかったら必ず throw する。** 黙って少なく返すと、検査が緩む方向へ静かに壊れる
 * ——「実装にあるのに一覧に無い」を見逃す側は、このテストが防ぎたいものそのもの。
 */
function customLayerIdsFromImplementation(files: SourceFile[]): string[] {
  const owners = files.filter(f => customLayerObjects(f).length > 0)
  if (owners.length === 0) throw new Error("`type: 'custom'` を宣言したファイルが 1 件も見つからない（走査の当て先が違う）")

  const ids = new Set<string>()
  for (const owner of owners) {
    // **1 ファイルに 1 枚とは限らない前提で全件見る。** 最初の 1 枚だけを見る作りにすると、
    // 既存のファイルへ 2 枚目を足したときに黙って集合から漏れる。
    for (const object of customLayerObjects(owner)) {
      const at = `${owner.path}:${lineOf(owner, object)}`
      const id = object.properties.find(p => propertyName(p) === 'id')
      if (!id) throw new Error(`${at}: \`type: 'custom'\` のオブジェクトに \`id\` が無い`)

      if (ts.isShorthandPropertyAssignment(id)) {
        const factory = enclosingFactoryTakingId(id)
        if (factory !== null) {
          for (const value of idsFromCallersOf(files, owner, factory, at)) ids.add(value)
          continue
        }
        // 引数ではなく外側の変数を指している形。同じファイルの `const` から引く。
        const value = constString(owner, 'id')
        if (value === null) throw new Error(`${at}: \`id\` の省略記法の出どころが引けない（引数でも文字列の \`const\` でもない）`)
        ids.add(value)
        continue
      }
      if (!ts.isPropertyAssignment(id)) throw new Error(`${at}: \`id\` の書き方が想定外（${ts.SyntaxKind[id.kind]}）`)
      ids.add(stringValueOf(owner, id.initializer, `${at} の \`id\``))
    }
  }
  return [...ids]
}

/**
 * ファクトリを呼んでいるファイルから id を集める。
 *
 * **引けない呼び出しは 1 件ごとに throw する。** 「1 件でも引けたか」で済ませると、
 * 3 つの呼び出しのうち 1 つだけが想定外の渡し方に変わっても気づけず、その id だけが
 * 静かに欠ける（症状は「仕様書が実装より進んでいる」に見えて、原因と食い違う）。
 */
function idsFromCallersOf(files: SourceFile[], owner: SourceFile, factory: string, at: string): string[] {
  const moduleBase = owner.path.replace(/^.*\//, '').replace(/\.tsx?$/, '')
  const ids: string[] = []
  for (const caller of files.filter(f => importsModule(f, moduleBase))) {
    // 型だけを import したファイルは呼び出しを持たない（何も足さないのが正しい）。
    for (const argument of firstArgumentsOfCallsTo(caller, factory)) {
      ids.push(stringValueOf(caller, argument, `${caller.path}:${lineOf(caller, argument)} の \`${factory}\` の第 1 引数`))
    }
  }
  if (ids.length === 0) throw new Error(`${at}: \`${factory}\` を呼んでいるファイルが 1 つも見つからない`)
  return ids
}

/**
 * 値を変えない包みを剥がす（括弧・`as`・`satisfies`・`!`）。
 *
 * どれも「その式そのもの」を指す書き方なので、剥がさずに弾くと**正しい書き方で落ちる**。
 * 構文木で読む利点はここで出る —— 文字列パターンでは括弧の対応を数えるしかなかった。
 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let e = expression
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression
  }
  return e
}

/** 式から文字列の値を得る（リテラルか、同じファイルの `const` に入った文字列）。 */
function stringValueOf(file: SourceFile, expression: ts.Expression, label: string): string {
  const e = unwrapExpression(expression)
  if (ts.isStringLiteral(e)) return e.text
  if (ts.isIdentifier(e)) {
    const value = constString(file, e.text)
    if (value !== null) return value
    throw new Error(`${label}: \`${e.text}\` の値を引けない（文字列の \`const\` ではない）`)
  }
  throw new Error(`${label}: 値を引けない形（${ts.SyntaxKind[e.kind]}）`)
}

// ---- 実装側の事実（モジュール読み込み時に一度だけ求める） ----

/**
 * 実装から読み取った 3 つの集合。
 *
 * **求めるのはテスト本体ではなくモジュールの読み込み時**（下のトップレベル `await`）。
 * `src` 配下 240 ファイルの読み込みと構文解析で、テスト本体に置くと単体 0.7 秒・
 * **並列実行では既定の 5 秒に迫る**（同じ罠を `akamaiClock` と `noRawControlChars` が踏んだ）。
 * 読み込み時の待ちは `testTimeout` の対象外なので、そちらへ移す。
 *
 * **失敗は投げずに抱える。** トップレベルで投げるとモジュールごと読めなくなり、
 * 「どの検査が何で落ちたか」が消える。抱えて `unwrap` で該当の検査だけ落とす。
 */
type ImplementationFacts = {
  customLayerIds: string[] | Error
  projectionProgramImporters: string[]
  contextRestoredSubscribers: string[]
}

async function readImplementation(): Promise<ImplementationFacts> {
  const files = await loadSources()
  let customLayerIds: string[] | Error
  try {
    customLayerIds = customLayerIdsFromImplementation(files)
  } catch (e) {
    customLayerIds = e instanceof Error ? e : new Error(String(e))
  }
  return {
    customLayerIds,
    // 一覧は `src/components/Map/` からの相対で書いてあるので、そこへ揃えて比べる。
    projectionProgramImporters: files
      .filter(f => importsModule(f, 'projectionProgram'))
      .map(f => f.path.replace(`${MAP_DIR}/`, '')),
    contextRestoredSubscribers: files
      .filter(subscribesContextRestored)
      .map(f => f.path.replace(/^.*\//, '')),
  }
}

const implementation = await readImplementation()

function unwrap<T>(value: T | Error): T {
  if (value instanceof Error) throw value
  return value
}

// ---- 検査 ----

/** 「一覧に無い実装」「実装に無い一覧」を両方向で突き合わせる。 */
function expectSameSet(listed: string[], actual: string[], what: string): void {
  const missing = actual.filter(a => !listed.includes(a)).sort()
  const stale = listed.filter(l => !actual.includes(l)).sort()
  expect(
    { 一覧に無い実装: missing, 実装に無い一覧: stale },
    `${what}（足したものは一覧へ／消えたものは一覧から外す）`,
  ).toEqual({ 一覧に無い実装: [], 実装に無い一覧: [] })
}

describe('map-rendering-spec.md の実装列挙', () => {
  it('§3 カスタムレイヤーの id が実装と一致する', async () => {
    const spec = await readFile(SPEC, 'utf8')
    const block = fromLineContaining(section(spec, /^##\s*3\./), '**カスタムレイヤーの注意**')
    // id はケバブケース（`MAP_LAYER_ORDER` の全 id がそう書かれている）。`.` や `/` を含む語
    // （`map.style._order`・`gl/depthPointLayer.ts`）と空白を含む語（`type: 'custom'`）は
    // ここで落ちる。**この規約から外れた id を作ると一覧側から漏れる**が、そのときは
    // 「一覧に無い実装」として落ちるので黙って通ることはない。
    const listed = backticked(block, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    expect(listed.length, '§3 が id を 1 件も挙げていない（書き方が変わっている）').toBeGreaterThan(0)

    expectSameSet(
      listed,
      unwrap(implementation.customLayerIds),
      '§3「カスタムレイヤーの注意」の id 一覧が実装とずれている',
    )
  })

  it('§6 投影ごとのプログラムが要るファイルが実装と一致する', async () => {
    const spec = await readFile(SPEC, 'utf8')
    const sentence = fromLineContaining(section(spec, /^##\s*6\./), 'カスタムレイヤー（')
    const closing = sentence.indexOf('）')
    if (closing < 0) throw new Error(`${SPEC} §6 のカスタムレイヤーの列挙に閉じ括弧が無い`)
    const listed = backticked(sentence.slice(0, closing), /\.tsx?$/)
    expect(listed.length, '§6 がファイルを 1 件も挙げていない（目印が変わっている）').toBeGreaterThan(0)

    // 根拠は `gl/projectionProgram.ts` を import しているかどうか（本文中の言及では数えない）。
    expectSameSet(listed, implementation.projectionProgramImporters, '§6「地図の投影」のファイル一覧が実装とずれている')
  })

  it('§12 コンテキストロストから載せ直すコンポーネントが実装と一致する', async () => {
    const spec = await readFile(SPEC, 'utf8')
    const block = section(spec, /^###\s*コンテキストロスト/)
    // 挙げているのはコンポーネント（`.tsx`）。共有している `gl/depthPointLayer.ts` は含まない。
    const listed = backticked(block, /\.tsx$/)
    expect(listed.length, '§12 がコンポーネントを 1 件も挙げていない').toBeGreaterThan(0)

    // 根拠は `map.on('webglcontextrestored', ...)` の購読。`gl/guardRender.ts` は本文で
    // 触れるだけなので、呼び出しとして拾う限り混ざらない。
    expectSameSet(listed, implementation.contextRestoredSubscribers, '§12「コンテキストロスト」のコンポーネント一覧が実装とずれている')
  })

  it('§13 の gl/ ファイル構成が実装と一致する', async () => {
    const spec = await readFile(SPEC, 'utf8')
    const lines = fromLineContaining(section(spec, /^##\s*13\./), `- \`${GL_DIR}/\``).split('\n')
    // 親の直後に続く字下げした箇条だけが gl/ 配下。字下げの無い箇条に当たったら終わり
    // （§13 には `mapTypes.ts` のような gl/ 外のファイルも並ぶので、節ごと走査すると混ざる）。
    const nested: string[] = []
    for (const line of lines.slice(1)) {
      if (/^\s+-\s/.test(line)) nested.push(line)
      else if (/^-\s/.test(line)) break
    }
    const listed = backticked(nested.join('\n'), /^[\w.]+\.ts$/)
    expect(listed.length, '§13 が gl/ のファイルを 1 件も挙げていない（字下げの形が変わっている）').toBeGreaterThan(10)

    const actual = readdirSync(GL_DIR).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))
    expectSameSet(listed, actual, '§13「関連実装ファイル」の gl/ 一覧が実装とずれている')
  })

  it('§7 に挙げたコンポーネントは実在する（mode との対応は見ていない）', async () => {
    const spec = await readFile(SPEC, 'utf8')
    const listed = backticked(section(spec, /^##\s*7\./), /^[A-Z][A-Za-z0-9]*GL$/)
    expect(listed.length, '§7 がコンポーネントを 1 件も挙げていない').toBeGreaterThan(0)

    const absent = listed.filter(name => !existsSync(join(MAP_DIR, `${name}.tsx`))).sort()
    expect(absent, '§7 が実在しないコンポーネントを挙げている（リネームの取り残し）').toEqual([])
  })
})

// 上の 5 件は実リポジトリを突き合わせるだけなので、**走査そのものが壊れても
// `src` に該当する書き方が現れるまで気づけない。** 標本で振る舞いを固定する
// （標本は `mapRenderingSpecListsScanner.fixture.ts`。走査の対象から外れる `scripts/` 配下）。
//
// 固定するのは「コメントに書いた使用例を実装として数えないこと」。正規表現で走査していた頃は
// ここが 4 巡のうち 3 巡の指摘の出どころで、書き方を変えるたびに別の形で戻ってきた。
describe('実装側の走査（構文木）', () => {
  const files = fixture.ALL.map(s => parseSource(s.path, s.text))

  it('ファクトリ経由の id を、呼び出し側から全件集める', () => {
    expect(customLayerIdsFromImplementation(files).sort()).toEqual(fixture.EXPECTED_IDS)
  })

  it('コメントに書いた使用例の id を実装として数えない', () => {
    // 行コメントの `createFakeLayer('example-only-id')` とブロックコメントの
    // `id: LEGACY, type: 'custom'`（継続行に `*` が無い書き方）のどちらも拾わない。
    const ids = customLayerIdsFromImplementation(files)
    expect(ids).not.toContain('example-only-id')
    expect(ids).not.toContain('legacy-id')
  })

  it('文字列の中の `//` を行コメントの始まりと取り違えない', () => {
    // 取り違えると、同じ行にある本物の呼び出しごと消えて**黙って漏れる**。
    expect(customLayerIdsFromImplementation(files)).toContain('caller-b')
  })

  it('`id` の省略記法の出どころを、3 通りの形すべてで引く', () => {
    // 関数宣言のファクトリ（caller-a・caller-b・caller-c）／アロー関数のファクトリ（caller-d）／
    // 引数ではなく外側の `const` を指す形（outer-const-layer）。
    // **1 つの形だけを標本にすると、残りが壊れても `src` にその書き方が現れるまで気づけない。**
    const ids = customLayerIdsFromImplementation(files)
    expect(ids).toContain('caller-a')
    expect(ids).toContain('caller-d')
    expect(ids).toContain('outer-const-layer')
  })

  it('id を別の `const` から受け取っていても辿る', () => {
    // id を外へ公開するファイルは `export const 〜_LAYER_ID` を置いて別名で使う（`gl/dayNightLayer.ts`）。
    // リテラルしか見ない作りだと**正しい書き方で落ちる**——実際にそれで検査が落ちた。
    expect(customLayerIdsFromImplementation(files)).toContain('aliased-id-layer')
  })

  it('値を変えない包み（括弧・`as`）を剥がして読む', () => {
    // `type: 'custom' as const` は剥がさないとレイヤーごと見落とす（黙って漏れる）。
    // 引数側の `(LYR) as string` は剥がさないと正しい書き方で落ちる。
    const ids = customLayerIdsFromImplementation(files)
    expect(ids).toContain('as-const-layer')
    expect(ids).toContain('caller-c')
  })

  it('コメントに書いた import・購読を数えない', () => {
    const redHerring = files.find(f => f.path === fixture.RED_HERRING.path)!
    expect(importsModule(redHerring, 'projectionProgram')).toBe(false)
    expect(subscribesContextRestored(redHerring)).toBe(false)
  })

  it('id を引けない呼び出しがあれば throw する（黙って少なく返さない）', () => {
    const broken = fixture.ALL.map(s =>
      s.path === fixture.CALLER_WITH_URL.path
        ? parseSource(s.path, s.text.replace('createFakeLayer(LYR)', 'createFakeLayer(makeId())'))
        : parseSource(s.path, s.text))
    expect(() => customLayerIdsFromImplementation(broken)).toThrow(/値を引けない形/)
  })
})
