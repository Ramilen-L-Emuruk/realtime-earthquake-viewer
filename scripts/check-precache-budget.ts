/**
 * ビルド後の出力を走査し、precache に載る 1 ファイルの大きさを予算と突き合わせる。
 *
 * `npm run build` / `npm run build:dmdss` の後段で走る。予算を超えたら exit 1 で止める。
 * 上限そのものは vite-plugin-pwa が見ていて超えればビルドが落ちるが、それでは
 * 「上限すれすれで走っていること」が見えない（→ `scripts/precacheBudget.ts` の冒頭）。
 *
 * **sw.js を読まずに、出力ディレクトリを自分で走査する。** Service Worker の中身の書式は
 * workbox のバージョンで変わるため、そこを正規表現で読む形にすると、書式が変わった日に
 * 「0 件で通る」へ静かに倒れる。
 *
 * ## この検査が見ないもの（既知の限界）
 *
 * - **`includeAssets` で足したファイル**（`vite.config.ts` の `icons/*.svg`）。あれは
 *   workbox の `additionalManifestEntries` へ積まれ、**サイズ上限の変換が済んだ後**に
 *   足される（`workbox-build` の `transform-manifest.js`）。つまり **vite-plugin-pwa の
 *   2 MiB 上限そのものからも外れている。** 現在の中身は `public/` から出力へコピーされる
 *   小さな svg 1 枚で、拡張子が下の一覧に入っているのでこの検査には掛かる。**対象外の
 *   拡張子（`.json` 等）を `includeAssets` へ足すと、どちらの網にも入らなくなる。**
 * - **シンボリックリンク。** `readdirSync` の `Dirent` はリンク自体の種別を返すため辿らない。
 *   workbox は `globFollow` が既定 true で辿るので、そこだけ非対称（Vite の出力に
 *   シンボリックリンクは現れないため、いまは実害が無い）。
 * - 「対象 N 件」は **sw.js の precache エントリ数とは一致しない。** `manifest.webmanifest`
 *   は下の拡張子に無く、アイコンは manifest 経由でも登録されて二重に数えられる。
 *   ここで見たいのは 1 ファイルの大きさなので、件数は走査の目安として出している。
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { outDirForVariant } from './buildOutDir'
import {
  PRECACHE_EXTENSIONS,
  evaluatePrecacheBudget,
  formatPrecacheBudget,
  isServiceWorkerAsset,
  type PrecacheFile,
} from './precacheBudget'

const EXTENSIONS = new Set<string>(PRECACHE_EXTENSIONS)

/** 出力ディレクトリを再帰で走査し、precache の対象になる拡張子のファイルを集める。 */
function collect(root: string, dir: string, acc: PrecacheFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(root, full, acc)
      continue
    }
    const ext = entry.name.includes('.') ? entry.name.split('.').pop()! : ''
    if (!EXTENSIONS.has(ext.toLowerCase())) continue
    const path = relative(root, full).split(sep).join('/')
    if (isServiceWorkerAsset(path)) continue
    acc.push({ path, size: statSync(full).size })
  }
}

function main(): void {
  const variant = process.env.VITE_VARIANT
  const outDir = outDirForVariant(variant)

  if (!existsSync(outDir)) {
    console.error(`precache budget: 出力ディレクトリ ${outDir} がありません（先にビルドすること）`)
    process.exit(1)
  }

  const files: PrecacheFile[] = []
  collect(outDir, outDir, files)

  // 0 件は「小さくて済んだ」ではなく「走査が外れた」。出力先や拡張子の指定がずれたときに
  // 黙って通らないよう、ここで止める。
  if (files.length === 0) {
    console.error(`precache budget: ${outDir} に対象ファイルが 1 件もありません（走査の指定を確認すること）`)
    process.exit(1)
  }

  const result = evaluatePrecacheBudget(files)
  const report = formatPrecacheBudget(result)
  if (!result.ok) {
    console.error(report)
    process.exit(1)
  }
  console.log(report)
}

// 直接実行のときだけ走らせる（定数を読むための import で検査が始まらないように）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
