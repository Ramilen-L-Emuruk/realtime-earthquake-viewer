/**
 * 強震モニタ静止時の描画負荷計測スクリプト（docs/webgl-rendering-migration-plan.md §6 段階0）
 *
 * 使い方:
 *   1. `npm run dev:dmdss` を起動し、ブラウザで
 *      http://localhost:5173/realtime-earthquake-viewer/dmdss/ を開く
 *      （リアルタイムモニタ表示＝地図モード kyoshin・観測点ロード完了を確認しておく）
 *   2. このファイルの内容を DevTools コンソール（または Playwright の evaluate）へ貼り付けて実行する
 *   3. `await window.__measureKyoshinStatic(15000)` の返り値 JSON を記録する
 *      （計測中はタブをフォアグラウンドに保ち、マウス操作をしない＝静止時計測）
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
window.__measureKyoshinStatic = async function measureKyoshinStatic(durationMs = 15000) {
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
      url: location.href,
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
  return result
}
