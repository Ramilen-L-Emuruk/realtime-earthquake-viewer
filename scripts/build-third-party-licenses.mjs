// 配布物に同梱する第三者ライブラリのライセンス全文（public/third-party-licenses.txt）を生成する。
//
//   npm run build-third-party-licenses
//
// 【なぜ要るか】MIT・ISC・BSD はいずれも「著作権表示とライセンス文を配布物に含める」ことを条件と
// している。バンドラが残すライセンスコメントだけでは足りない —— 実測（2026-09-25・v5.26.1 の
// `dist/assets/index-*.js`）では次のように分かれていた。
//
//   react / react-dom / scheduler / react-jsx-runtime … 著作権表示と「MIT license found in the
//                                                        LICENSE file」の言及はあるが、全文は無い
//   maplibre-gl                                      … 著作権表示と全文への URL はあるが、全文は無い
//   fflate / fft-js                                  … 著作権表示すら 1 文字も残らない
//
// 【直接の依存だけを見ない】`package.json` の `dependencies` は 5 件だが、**そこから辿れる
// 推移的な依存を含めると 35 件**（2026-09-25 実測）。`react-dom` が引く `scheduler`、
// `maplibre-gl` が引く `@mapbox/*` や `gl-matrix` も同じようにバンドルへ入る。
// **直接の依存だけを集めた版は、自分のコメントで `scheduler` に言及しながらそれを
// 収録していなかった** —— 集合の取り方が実態と違うと、こういう形で静かにずれる。
//
// 【手で保守しない】依存を足したときに書き足す形にすると必ず忘れる。依存グラフから機械的に集め、
// `scripts/thirdPartyLicenses.test.ts` が「全件が載っていること」「版が一致すること」を
// `npm test` で検査する。
//
// 【devDependencies は入れない】ビルド時にしか動かず配布物へ入らない。ただし
// **バンドルへ実際に入るかは import されているかで決まる**ので、devDependencies にある
// ものを `src/` から import するようになったら、その依存は dependencies へ移すこと。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_PATH = join(ROOT, 'public', 'third-party-licenses.txt')

/** 見出しと本文を区切る線。**テスト側と同じ長さにすること**（あちらはこの線で本文を切り出す）。 */
export const RULE = '='.repeat(78)

/** ライセンス全文が入っていそうなファイル名（大文字小文字は問わない）。 */
const LICENSE_FILE_RE = /^licen[cs]e(\.(txt|md))?$/i

/**
 * ライセンス文として成立する最小の長さ。
 *
 * **上流の LICENSE ファイルを信じるが、空や数行の断片は弾く。** いちばん短い ISC でも 700 字を
 * 超えるので、この値を下回るものは「ファイルはあるが中身が壊れている」と見なす。
 */
const MIN_LICENSE_LENGTH = 400

/**
 * 許諾条項の始まり。**これより後ろの `Copyright` は著作権表示ではない。**
 *
 * MIT・BSD の免責条項には `... THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE ...` という
 * 一文があり、上流の改行位置によっては `COPYRIGHT HOLDERS BE LIABLE...` が行頭へ来る。
 * 行頭一致だけで著作権表示を探すと**これを著作権者として拾い、検査が素通りする**
 * （`minimist` で実際に起きた）。
 */
const GRANT_CLAUSE_RE = /^(permission is hereby granted|permission to use|redistribution and use)/i

/**
 * 上流の LICENSE ファイルが著作権者を宣言していない依存。
 *
 * **こちらが欠落させたのではなく、上流のファイルにそもそも書かれていない。** 全文を
 * そのまま転記している以上ライセンスの条件は満たしているが、下記の検査を素通りさせない
 * よう明示的に挙げる。
 *
 * - `minimist` —— LICENSE が「This software is released under the MIT license:」で始まり、
 *   許諾条項の前に著作権表示の行が無い（実測 2026-09-25）。
 *
 * **`scripts/thirdPartyLicenses.test.ts` が両方向で検査する** —— ここに挙げたのに上流が
 * 書くようになったら落ちる（列挙から外す合図）。挙げていないのに書いていなければ落ちる。
 */
export const NO_COPYRIGHT_HOLDER = new Set(['minimist'])

/**
 * ライセンス文から著作権者の宣言を取り出す。読み取れなければ null。
 *
 * 見るのは**許諾条項より前にある、行頭が `Copyright` の行**だけ（理由は `GRANT_CLAUSE_RE`）。
 */
export function copyrightHolder(text) {
  const lines = text.split('\n').map((l) => l.trim())
  const grantAt = lines.findIndex((l) => GRANT_CLAUSE_RE.test(l))
  const head = grantAt < 0 ? lines : lines.slice(0, grantAt)
  const line = head.find((l) => /^copyright\b/i.test(l))
  if (!line) return null
  const holder = line
    .replace(/^copyright\b/i, '')
    .replace(/^\s*(\(c\)|©)/i, '')
    .replace(/^\s*\d{4}(\s*[-–,]\s*\d{4})*/, '') // 年（範囲・列挙も）を落とす
    .trim()
  return holder === '' ? null : holder
}

/** MIT の標準の文面（上流が LICENSE ファイルを配っていない依存のため）。 */
const MIT_TEMPLATE = (holders) =>
  [
    `MIT License`,
    ``,
    `Copyright (c) ${holders}`,
    ``,
    `Permission is hereby granted, free of charge, to any person obtaining a copy`,
    `of this software and associated documentation files (the "Software"), to deal`,
    `in the Software without restriction, including without limitation the rights`,
    `to use, copy, modify, merge, publish, distribute, sublicense, and/or sell`,
    `copies of the Software, and to permit persons to whom the Software is`,
    `furnished to do so, subject to the following conditions:`,
    ``,
    `The above copyright notice and this permission notice shall be included in all`,
    `copies or substantial portions of the Software.`,
    ``,
    `THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR`,
    `IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,`,
    `FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE`,
    `AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER`,
    `LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,`,
    `OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE`,
    `SOFTWARE.`,
    ``,
    `（注: 上流の配布物に LICENSE ファイルが含まれていないため、package.json が宣言する`,
    `ライセンスの標準の文面を、同じく package.json が宣言する著作権者名とともに記載した）`,
  ].join('\n')

/** `package.json` の著作権者フィールドを 1 つの文字列へ。**空なら例外。** */
function resolveHolders(meta) {
  // author / contributors / maintainers のどれに入っているかは上流ごとに違う。
  // **`author` だけを見た版は `fft-js` の著作権者を空欄のまま書き出していた**
  // （あのパッケージは `contributors` にしか持っていない）。
  const raw = meta.author ?? meta.contributors ?? meta.maintainers
  const holders = (Array.isArray(raw) ? raw : [raw])
    .filter(Boolean)
    .map((a) => (typeof a === 'string' ? a : a?.name))
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .join(', ')
  if (holders === '') {
    throw new Error(
      `${meta.name}: 著作権者を package.json から解決できません` +
        `（author / contributors / maintainers のいずれも空）。` +
        `上流の配布物を確認し、必要なら手で調べた値をここへ渡す形へ変えてください`,
    )
  }
  return holders
}

/** LICENSE ファイルが無い依存のための代替。**作れないライセンスなら例外。** */
function fallbackText(meta) {
  // **ここへ分岐を足すのは「上流が LICENSE ファイルを配っていない」ときだけ。**
  // 配っているものを手書きで写すと、上流が文面を変えたときに気づけない。
  if (meta.license !== 'MIT') {
    throw new Error(
      `${meta.name}: LICENSE ファイルが無く、${meta.license ?? '不明なライセンス'} の` +
        `標準の文面も用意していません。上流の配布物を確認してください`,
    )
  }
  return MIT_TEMPLATE(resolveHolders(meta))
}

/**
 * 依存グラフでは辿れないが、配布物へ入るもの。
 *
 * **`dependencies` の推移的閉包だけでは足りない。** ビルドの過程で、別のパッケージの
 * コードが成果物へ注入されることがある。いまの該当は 1 つ。
 *
 * - **Workbox** —— `vite-plugin-pwa` が `dist/sw.js` と `dist/workbox-*.js` を生成し、
 *   そこへ Workbox のランタイムが入る（実測 2026-09-25・v5.26.1 で 22KB。
 *   **著作権表示は 1 文字も残らない**）。`vite-plugin-pwa` は devDependencies なので
 *   依存グラフからは辿れない。`node_modules` の `workbox-*` 16 パッケージは
 *   ライセンス文がすべて同一（MIT・Google LLC・実測で 1 種類）なので、代表して 1 件を載せる。
 *
 * **ここへ足すのは「ビルド成果物を見て実際に入ると確かめたもの」だけ。**
 * 憶測で足すと、使っていないものを配布物の一覧に並べることになる。
 */
const EXTRA_BUNDLED = [
  {
    name: 'workbox-core',
    note: 'vite-plugin-pwa が Service Worker へ注入。workbox-* 16 パッケージは同一の文面',
  },
]

/** 配布物へ入る全件（本番依存の推移的閉包 ＋ 上記の追加分）。 */
export function bundledPackages(root = ROOT) {
  const deps = resolveProdDependencies(root)
  const extra = EXTRA_BUNDLED.map((e) => e.name).filter((n) => !deps.includes(n))
  return [...deps, ...extra].sort()
}

/** 1 依存ぶんの情報を集める。全文を得られなければ例外。 */
export function collect(name, root = ROOT) {
  const dir = join(root, 'node_modules', name)
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  const file = readdirSync(dir).find((f) => LICENSE_FILE_RE.test(f))
  const extraNote = EXTRA_BUNDLED.find((e) => e.name === name)?.note
  const entry = file
    ? {
        text: readFileSync(join(dir, file), 'utf8').trim(),
        source: extraNote ? `${file}（${extraNote}）` : file,
      }
    : { text: fallbackText(meta), source: '（上流に LICENSE ファイル無し）' }

  // **生成の時点で完全性を見る。** テスト側にも同じ検査があるが、
  // `npm run build-...` を単独で走らせた人が「正常終了」を信じられる必要がある
  // （書き出してからテストを回すまでのあいだ、不完全な生成物が `public/` に残る）。
  if (entry.text.length < MIN_LICENSE_LENGTH) {
    throw new Error(`${name}: ライセンス文が短すぎます（${entry.text.length} 字）。中身を確認してください`)
  }
  if (copyrightHolder(entry.text) === null && !NO_COPYRIGHT_HOLDER.has(name)) {
    throw new Error(
      `${name}: ライセンス文から著作権者を読み取れません。上流のファイルを確認し、` +
        `本当に書かれていないなら NO_COPYRIGHT_HOLDER へ理由とともに足してください`,
    )
  }

  return { name, version: meta.version, license: meta.license ?? '(宣言なし)', ...entry }
}

/**
 * `package.json` の `dependencies` から辿れる依存をすべて集める（推移的閉包）。
 *
 * **node_modules がフラットに置かれる前提**（npm 7 以降の既定）。入れ子で解決されている
 * パッケージは見つからず例外になるので、そのときはここを直すこと。
 */
export function resolveProdDependencies(root = ROOT) {
  const seen = new Set()
  const walk = (name) => {
    if (seen.has(name)) return
    const metaPath = join(root, 'node_modules', name, 'package.json')
    let meta
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch {
      throw new Error(
        `${name}: node_modules に見当たりません（${metaPath}）。` +
          `npm install を実行したか、入れ子で解決されていないかを確認してください`,
      )
    }
    seen.add(name)
    for (const dep of Object.keys(meta.dependencies ?? {})) walk(dep)
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const direct = Object.keys(pkg.dependencies ?? {})
  if (direct.length === 0) throw new Error('package.json の dependencies が 1 件も見つかりません')
  for (const name of direct) walk(name)
  return [...seen].sort()
}

function main() {
  const names = bundledPackages()
  const entries = names.map((n) => collect(n))

  const body = [
    'このファイルは、リアルタイム地震ビューアーが同梱している第三者ソフトウェアの',
    'ライセンス全文です。scripts/build-third-party-licenses.mjs が package.json の',
    'dependencies とその依存先から自動生成しています（手で編集しないでください）。',
    '',
    // **生成日時は入れない。** 中身が変わっていないのに走らせるたび差分が出ると、
    // 「依存が変わったから再生成した」のか「ただ走らせただけ」なのかが git 履歴から読めなくなる。
    `対象: ${entries.length} 件`,
    '',
    ...entries.map(
      (e) =>
        [
          RULE,
          `${e.name} ${e.version}`,
          `SPDX: ${e.license}`,
          `出どころ: node_modules/${e.name}/${e.source}`,
          RULE,
          '',
          e.text,
          '',
        ].join('\n'),
    ),
  ].join('\n')

  writeFileSync(OUT_PATH, body, 'utf8')
  console.log(`third-party-licenses.txt を書き出しました（${entries.length} 件・${(body.length / 1024).toFixed(1)}KB）`)
  const fallbacks = entries.filter((e) => e.source.startsWith('（'))
  if (fallbacks.length > 0) {
    console.log(`  うち ${fallbacks.length} 件は上流に LICENSE ファイルが無く、標準の文面で補った:`)
    for (const e of fallbacks) console.log(`    ${e.name} ${e.version}（${e.license}）`)
  }
}

// 直接実行のときだけ走らせる門。テストから関数を import したときに生成処理まで
// 走らせないため（→ CLAUDE.md「検証」・scripts/scriptEntrypoints.test.ts が検査する）。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (e) {
    console.error(`失敗: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
