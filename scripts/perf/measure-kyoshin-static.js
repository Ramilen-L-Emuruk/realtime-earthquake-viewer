/**
 * 強震モニタ静止時の描画負荷計測スクリプト（docs/webgl-rendering-migration-plan.md §6 段階0）
 *
 * 使い方 A（開発機・手動）:
 *   1. `npm run dev:dmdss` を起動し、ブラウザで
 *      http://localhost:5173/realtime-earthquake-viewer/dmdss/ を開く
 *      （リアルタイムモニタ表示＝地図モード kyoshin・観測点ロード完了を確認しておく）
 *   2. このファイルの内容を DevTools コンソール（または Playwright の evaluate）へ貼り付けて実行する
 *   3. `await window.__measureKyoshinStatic(15000)` の返り値 JSON を記録する
 *      （計測中はタブをフォアグラウンドに保ち、マウス操作をしない＝静止時計測）
 *
 * 使い方 B（実機・自動計測＋証跡の自動送信。vite-plugin-perf-report.ts とセット）:
 *   1. 開発機で `npm run dev:dmdss -- --host` を起動し、実機のブラウザで
 *      http://<開発機のIP>:5173/realtime-earthquake-viewer/dmdss/ を開く
 *   2. DevTools コンソールで次の 1 行を実行する（label は結果ファイル名に入る識別子）:
 *      document.head.appendChild(Object.assign(document.createElement('script'),
 *        { src: '/__perf-script?auto=1&duration=15000&label=surface-go2-after' }))
 *   3. 観測点ロード待ち → 計測 → 開発機の scripts/perf/results/ へ自動保存される
 *      （進行状況はコンソールの [measureKyoshinStatic] ログで確認できる）。
 *   - 改修前コードの比較サーバー（別ポート）のページで実行する場合は、src を
 *     'http://<開発機のIP>:5173/__perf-script?auto=1&...' の絶対 URL にする。
 *     結果はスクリプト取得元（5173 側）の scripts/perf/results/ に保存される。
 *
 * 指標:
 *   - frame:    rAF フレーム間隔の分布（p50/p95/max）と FPS … 主指標
 *   - longTask: >50ms のロングタスク件数・合計・最大 … 主指標
 *   - domWrites: DOM 変更回数/秒 … 中間指標（before/after の構造差を見る）
 *       mapPane*    = .leaflet-map-pane 配下すべて（kyoshin ペイン含む）
 *       kyoshin*    = kyoshin-points ペイン配下のみ
 *       attr        = 属性書き換え（setAttribute 等）回数
 *       nodes       = ノード追加+削除数（KyoshinSubThreshold のグループ付け替えはこちらに出る）
 */
window.__measureKyoshinStatic = async function measureKyoshinStatic(durationMs = 15000, opts = {}) {
  const mapPane = document.querySelector('.leaflet-map-pane')
  const kyoshinPane = document.querySelector('.leaflet-kyoshin-points-pane')
  if (!mapPane) throw new Error('leaflet-map-pane が見つからない（地図未表示？）')
  if (!kyoshinPane) throw new Error('kyoshin-points ペインが見つからない（リアルタイムモニタ表示で実行すること）')

  // KyoshinPoints(L.circleMarker×SVGレンダラ)は <path>、KyoshinSubThreshold は生 <circle> で描画される
  const pathCount = kyoshinPane.querySelectorAll('path').length
  const circleCount = kyoshinPane.querySelectorAll('circle').length

  // --- DOM 変更カウント（mapPane 全体と、うち kyoshin-points ペイン配下を分計）
  const counts = {
    map: { attr: 0, nodes: 0 },
    kyoshin: { attr: 0, nodes: 0 },
  }
  const tally = (bucket) => (records) => {
    for (const r of records) {
      if (r.type === 'attributes') bucket.attr++
      else if (r.type === 'childList') bucket.nodes += r.addedNodes.length + r.removedNodes.length
    }
  }
  const moMap = new MutationObserver(tally(counts.map))
  const moKyoshin = new MutationObserver(tally(counts.kyoshin))
  const moOptions = { attributes: true, childList: true, subtree: true }
  moMap.observe(mapPane, moOptions)
  moKyoshin.observe(kyoshinPane, moOptions)

  // --- フレーム時間
  const frameDeltas = []
  let lastT = performance.now()
  let rafId = 0
  const loop = (t) => {
    frameDeltas.push(t - lastT)
    lastT = t
    rafId = requestAnimationFrame(loop)
  }
  rafId = requestAnimationFrame(loop)

  // --- ロングタスク（未対応環境では count: -1）
  const longTasks = []
  let po = null
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration)
    })
    po.observe({ type: 'longtask' })
  } catch {
    po = null
  }

  console.log(`[measureKyoshinStatic] 計測開始（${durationMs}ms・静止したまま待機）`)
  await new Promise((resolve) => setTimeout(resolve, durationMs))

  cancelAnimationFrame(rafId)
  moMap.disconnect()
  moKyoshin.disconnect()
  if (po) po.disconnect()

  // 最初のフレーム間隔は計測開始タイミング依存のノイズなので捨てる
  frameDeltas.shift()
  const sorted = [...frameDeltas].sort((a, b) => a - b)
  const pick = (q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null
  const round = (v) => (v == null ? null : Math.round(v * 100) / 100)
  const perSec = (n) => Math.round((n / (durationMs / 1000)) * 10) / 10

  const result = {
    meta: {
      when: new Date().toISOString(),
      label: String(opts.label ?? ''),
      url: location.href,
      ua: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      pathCount,
      circleCount,
      durationMs,
    },
    frame: {
      frames: sorted.length,
      fps: round(sorted.length / (durationMs / 1000)),
      p50: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(sorted[sorted.length - 1]),
    },
    longTask: {
      count: po ? longTasks.length : -1,
      totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
    },
    domWrites: {
      mapPaneAttrPerSec: perSec(counts.map.attr),
      mapPaneNodesPerSec: perSec(counts.map.nodes),
      kyoshinAttrPerSec: perSec(counts.kyoshin.attr),
      kyoshinNodesPerSec: perSec(counts.kyoshin.nodes),
      raw: counts,
    },
  }
  console.log('[measureKyoshinStatic] ' + JSON.stringify(result))

  // 証跡の自動送信（vite-plugin-perf-report.ts の /__perf-report へ保存）。
  // ヘッダー無し fetch = text/plain の simple request とし、比較サーバー（別オリジン）の
  // ページから reportUrl 指定で送る場合も CORS preflight を発生させない。
  if (opts.report) {
    const reportUrl = opts.reportUrl || '/__perf-report'
    try {
      const res = await fetch(reportUrl, { method: 'POST', body: JSON.stringify(result) })
      console.log(
        `[measureKyoshinStatic] 証跡送信: ${res.ok ? await res.text() : `HTTP ${res.status}`}`,
      )
    } catch (e) {
      console.warn('[measureKyoshinStatic] 証跡送信に失敗（結果は上のログから手動回収可能）:', e)
    }
  }
  return result
}

// /__perf-script?auto=1&duration=15000&label=xxx として script タグでロードされた場合の
// 自動実行モード。観測点の生成を待ってから計測し、結果をスクリプト取得元オリジンへ送信する
// （別ポートの比較サーバーのページから実行しても証跡が一箇所に集まる）。
;(() => {
  const script = document.currentScript
  if (!script || !script.src) return
  const src = new URL(script.src, location.href)
  if (src.searchParams.get('auto') !== '1') return
  const duration = Number(src.searchParams.get('duration')) || 15000
  const label = src.searchParams.get('label') || ''
  ;(async () => {
    console.log('[measureKyoshinStatic] 自動実行モード: リアルタイムタブへ切替→観測点ロードを待機')
    // 素の localStorage（デフォルトタブ=地震情報）でも計測できるよう、ナビからリアルタイムタブへ
    // 切り替える。IconNav のボタンはアイコン（SVG）のみでラベルは aria-label / title 属性に入るため、
    // textContent ではなく属性で判定する。
    const clickRealtimeTab = () => {
      for (const b of document.querySelectorAll('nav button')) {
        const name = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.textContent || ''}`
        if (name.includes('リアルタイム')) {
          b.click()
          return true
        }
      }
      return false
    }
    if (!clickRealtimeTab()) {
      console.warn('[measureKyoshinStatic] リアルタイムタブのボタンが見つからない（手動で切り替えてから再実行してください）')
    }
    for (let i = 0; i < 60; i++) {
      const pane = document.querySelector('.leaflet-kyoshin-points-pane')
      if (pane && pane.querySelectorAll('path').length > 1000) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    // 観測点が揃わないまま計測すると無意味な証跡が残るため中止する
    const pane = document.querySelector('.leaflet-kyoshin-points-pane')
    if (!pane || pane.querySelectorAll('path').length < 1000) {
      console.warn('[measureKyoshinStatic] 観測点が揃わないため中止。リアルタイムタブ表示を確認して再実行してください')
      return
    }
    // アイドル自動復帰（既定30秒）で計測中にタブが戻らないよう、計測直前にもう一度
    // 切り替えて（=操作扱いでアイドルタイマーをリセットして）から開始する
    clickRealtimeTab()
    await new Promise((r) => setTimeout(r, 500))
    await window.__measureKyoshinStatic(duration, {
      label,
      report: true,
      reportUrl: `${src.origin}/__perf-report`,
    })
  })()
})()
