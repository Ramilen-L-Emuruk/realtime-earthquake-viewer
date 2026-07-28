import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

// 実機計測の証跡収集用 dev サーバー専用プラグイン（apply: 'serve'。本番ビルドには一切含まれない）。
//
//   GET  /__perf-script : 計測スクリプトを配信する。?file= で選択（ホワイトリスト）。
//                         既定 measure-kyoshin-static.js（段階0・後方互換）。
//                         MapLibre 実アプリの描画負荷計測は ?file=measure-app-render.js。
//                         自動実行クエリ（auto/duration/label）はスクリプト自身が
//                         document.currentScript.src から読む（本プラグインは素通し）。
//   POST /__perf-report : 計測結果 JSON を scripts/perf/results/perf-<日時>-<label>.json へ保存する。
//
// 想定フロー（実機計測・使い方はスクリプト冒頭コメントも参照）:
//   1. 開発機で `npm run dev:dmdss -- --host` を起動し LAN へ公開する
//   2. 実機のブラウザでアプリを開き、DevTools から /__perf-script を script タグでロードする
//   3. 計測完了時にスクリプトが本エンドポイントへ POST → 開発機側にファイルとして証跡が残る
//
// 比較用の別サーバー（改修前コード・別ポート）のページから実行しても結果を受け取れるよう、
// クロスオリジンは CORS ヘッダー ＋ text/plain の simple request（preflight 回避）で通す。
// LAN 内限定の開発用途のため認証は持たない。ファイル名はサーバー側で生成し、label は
// 英数とハイフン・アンダースコアへサニタイズする（パス操作の防止）。

const MAX_BODY_BYTES = 1024 * 1024

// ?file= で配信できる計測スクリプト（ホワイトリスト。任意ファイル読み出しを防ぐ）。
const PERF_SCRIPTS = new Set(['measure-kyoshin-static.js', 'measure-app-render.js'])

export function perfReportPlugin(): Plugin {
  return {
    name: 'perf-report',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__perf-script', (req, res) => {
        res.setHeader('access-control-allow-origin', '*')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        const file = new URL(req.url ?? '', 'http://x').searchParams.get('file') ?? 'measure-kyoshin-static.js'
        const safe = PERF_SCRIPTS.has(file) ? file : 'measure-kyoshin-static.js'
        res.end(fs.readFileSync(path.resolve('scripts/perf', safe), 'utf8'))
      })

      server.middlewares.use('/__perf-report', (req, res) => {
        res.setHeader('access-control-allow-origin', '*')
        if (req.method === 'OPTIONS') {
          res.setHeader('access-control-allow-methods', 'POST')
          res.setHeader('access-control-allow-headers', '*')
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        let body = ''
        let aborted = false
        req.on('data', (chunk: Buffer) => {
          body += chunk
          if (body.length > MAX_BODY_BYTES) {
            aborted = true
            res.statusCode = 413
            res.end('payload too large')
            req.destroy()
          }
        })
        req.on('end', () => {
          if (aborted) return
          try {
            const result = JSON.parse(body) as { meta?: { label?: unknown } }
            const label = String(result?.meta?.label ?? '')
              .replace(/[^a-zA-Z0-9_-]/g, '')
              .slice(0, 40)
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const dir = path.resolve('scripts/perf/results')
            fs.mkdirSync(dir, { recursive: true })
            const name = `perf-${stamp}${label ? `-${label}` : ''}.json`
            fs.writeFileSync(path.join(dir, name), JSON.stringify(result, null, 2) + '\n')
            server.config.logger.info(`[perf-report] saved: scripts/perf/results/${name}`)
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ saved: name }))
          } catch (e) {
            res.statusCode = 400
            res.end(`invalid JSON: ${String(e)}`)
          }
        })
      })
    },
  }
}
