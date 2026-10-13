/**
 * ほかのアプリの日本語の文言を、手元の言語ファイルから探す（docs/ui-wording-procedure.md「3. 語の出どころを探す」）。
 * 読み方は `scripts/lib/localeStrings.ts`。
 *
 *   npx tsx scripts/find-locale-strings.ts <言語ファイル> <語…>
 *
 * 言語ファイルの場所（Windows）:
 *   Chrome   "C:\Program Files\Google\Chrome\Application\<版>\Locales\ja.pak"
 *   VS Code  "%USERPROFILE%\.vscode\extensions\ms-ceintl.vscode-language-pack-ja-<版>\translations\main.i18n.json"
 *            （拡張機能ごとの訳は同じ場所の extensions\*.i18n.json。Git なら vscode.git.i18n.json）
 *
 * 突き合わせは全角・半角を揃えて（NFKC）行う。読んだ件数と日本語を含む件数を標準エラーへ出す。
 *
 * 終了コード: 0 = 当たった、1 = 日本語の言語ファイルを読めたが 1 件も当たらなかった、
 * 2 = 読めなかった・日本語を含む文字列が半分に満たない（別の言語のファイルか、読み方が合っていない）。
 * 「その言い方をしていない」と「読めなかった」を取り違えないため、2 つを分ける。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findLocaleStrings, looksJapanese } from './lib/localeStrings'

function main(): number {
  const [file, ...words] = process.argv.slice(2)
  if (file === undefined || words.length === 0) {
    console.error('使い方: npx tsx scripts/find-locale-strings.ts <言語ファイル> <語…>')
    return 2
  }
  const result = findLocaleStrings(file, readFileSync(file), words)
  for (const line of result.lines) console.log(line)
  console.error(`${result.lines.length} 件（読んだ文字列 ${result.total} 件・うち日本語を含む ${result.japanese} 件）`)
  if (!looksJapanese(result)) {
    console.error(`日本語を含む文字列が半分に満たない。別の言語のファイルか、読み方が合っていない`)
    return 2
  }
  return result.lines.length === 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`読めなかった: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
  }
}
