import type { Plugin, Connect } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

// 実機計測の証跡収集用プラグイン（dev サーバー＋preview サーバー。build/transform 系フックを持たず
// configureServer/configurePreviewServer でミドルウェアを足すだけなので本番バンドルには一切含まれない）。
//
//   GET  /__perf-script : 計測スクリプトを配信する。既定は scripts/perf/measure-kyoshin-static.js。
//                         ?file=moving-baseline で measure-moving-baseline.js（本番移動中計測）を配信する。
//                         自動実行/区間クエリはスクリプト自身が document.currentScript.src から読む
//                         （本プラグインは素通し）。file はallowlistで解決しパストラバーサルを防ぐ。
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

// 配信可能な計測スクリプトの allowlist（?file= で選択。パストラバーサル防止のため任意パスは受け付けない）。
const PERF_SCRIPTS: Record<string, string> = {
  'kyoshin-static': 'scripts/perf/measure-kyoshin-static.js',
  'moving-baseline': 'scripts/perf/measure-moving-baseline.js',
}

// dev サーバー・preview サーバー共通のミドルウェア登録。両サーバーとも .middlewares（connect）と
// .config.logger を持つため同じ実装を使い回せる。【残作業D 対応】本番ビルドの計測は `vite preview` で
// 行うため、従来の configureServer（dev 専用）に加えて configurePreviewServer でも同じ受け口を提供する。
function registerPerfMiddlewares(middlewares: Connect.Server, logInfo: (msg: string) => void): void {
  middlewares.use('/__perf-script', (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/javascript; charset=utf-8')
    // ?file= を allowlist で解決（既定は従来の kyoshin-static・後方互換）。未知の値は 400。
    const fileKey = new URL(req.url ?? '', 'http://x').searchParams.get('file') ?? 'kyoshin-static'
    const rel = PERF_SCRIPTS[fileKey]
    if (!rel) {
      res.statusCode = 400
      res.end(`unknown perf script: ${fileKey}`)
      return
    }
    res.end(fs.readFileSync(path.resolve(rel), 'utf8'))
  })

  middlewares.use('/__perf-report', (req, res) => {
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
        logInfo(`[perf-report] saved: scripts/perf/results/${name}`)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ saved: name }))
      } catch (e) {
        res.statusCode = 400
        res.end(`invalid JSON: ${String(e)}`)
      }
    })
  })
}

export function perfReportPlugin(): Plugin {
  // apply:'serve' は付けない。build/transform フックが無いので build 時は何もせず、生成物に影響しない
  // （残作業D: preview でも計測できるようにするため。configurePreviewServer は build フックに触れず安全）。
  return {
    name: 'perf-report',
    configureServer(server) {
      registerPerfMiddlewares(server.middlewares, (m) => server.config.logger.info(m))
    },
    configurePreviewServer(server) {
      registerPerfMiddlewares(server.middlewares, (m) => server.config.logger.info(m))
    },
  }
}
