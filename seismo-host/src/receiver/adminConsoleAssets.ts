// 管理コンソール（`src/admin/`）の静的アセットを組み立てる。
//
// **メモリ上のみでビルドする。ディスクへ書き出さない**（`write: false`）——
// ビルド成果物を git 管理するか `.gitignore` するかという判断を丸ごと避けられ、
// `statusServer.ts` は常にソースの最新を配れる。起動のたびに 1 回だけ呼べば足りる
// （esbuild は高速で、実行のたびに数十ミリ秒程度）。
//
// **`src/admin/` は独立した TypeScript プロジェクト**（`tsconfig.seismo-host-admin.json`）。
// ブラウザ向け（DOM 型が要る）で、ホスト本体（Node 専用）とは前提が逆になるため、
// 型チェックの構成を分けている——詳細はそちらのコメント。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

export interface AdminConsoleAssets {
  readonly html: string
  readonly js: string
}

export function buildAdminConsoleAssets(): AdminConsoleAssets {
  const htmlPath = fileURLToPath(new URL('../admin/index.html', import.meta.url))
  const entryPath = fileURLToPath(new URL('../admin/app.ts', import.meta.url))

  const html = readFileSync(htmlPath, 'utf8')

  const result = esbuild.buildSync({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  })

  // **`logLevel: 'silent'` はコンソール出力を止めるだけで、エラーは戻り値に残る。**
  // ここで確かめないと、壊れた TypeScript を黙って空の JS として配ることになる。
  if (result.errors.length > 0) {
    throw new Error(
      `管理コンソールのビルドに失敗: ${result.errors.map((e) => e.text).join('; ')}`,
    )
  }

  const output = result.outputFiles[0]
  if (output === undefined) {
    throw new Error('管理コンソールのビルド結果が空だった')
  }

  return { html, js: output.text }
}
