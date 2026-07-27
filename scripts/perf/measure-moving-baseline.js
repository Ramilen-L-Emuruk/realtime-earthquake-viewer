/**
 * 本番アプリ（現行 Leaflet 版）の「移動中」ベースライン計測スクリプト
 * （docs/webgl-production-baseline-request.md の依頼に対応）。
 *
 * 目的: これまでの計測は静止時か PoC 対 PoC のみで、本番アプリの「移動中」（手動パン/ズーム・
 * 地震検知時の自動ズーム）は一度も測られていない。ユーザーは現行 v3.23.1 でも移動中にコマ落ちが
 * 見えると報告しており、その「移行前ベースライン（before）」を今のうちに取る。本番コードは改変しない
 * （注入型。JapanMap.tsx は map を window に露出していないが、人が操作すればよい）。
 *
 * 使い方（実機・Surface Go 2 / DMDSS 版）:
 *   1. 開発機で `npm run dev:dmdss -- --host` を起動し、実機のブラウザで
 *      http://<開発機のIP>:5173/realtime-earthquake-viewer/dmdss/ を開く
 *      （リアルタイム＝地図モード kyoshin・観測点ロード完了を確認しておく）
 *   2. DevTools コンソールで次の 1 行を実行してスクリプトを読み込む（関数を定義するだけ・自動実行しない）:
 *        document.head.appendChild(Object.assign(document.createElement('script'),
 *          { src: '/__perf-script?file=moving-baseline' }))
 *   3. 区間ごとに次を実行し、**②の合図が出たら実際に地図を動かす**（人の操作が計測対象）:
 *        await window.__measureMovingBaseline({ label:'surface-go2-move-pan',      segment:'pan',      durationMs:15000 })
 *        await window.__measureMovingBaseline({ label:'surface-go2-move-zoom',     segment:'zoom',     durationMs:15000 })
 *        await window.__measureMovingBaseline({ label:'surface-go2-move-autozoom', segment:'autozoom', durationMs:20000 })
 *      - pan:      合図後、地図をドラッグでパンし続ける
 *      - zoom:     合図後、ホイール/ズームボタンでズームを繰り返す
 *      - autozoom: 合図後、設定タブの「地震テスト」ボタンを押す（自動ズーム flyTo/fitBounds を発火）
 *   4. 各区間は先頭で estimatedVsyncMs（静止2秒の rAF p50）を取ってから移動窓に入る。**静止計測中は
 *      動かさないこと**。結果は開発機の scripts/perf/results/ へ自動送信される。
 *   5. **同じ区間を複数回**行い、1 回の値で断定しない（人の操作依存で再現性が落ちるため）。
 *
 * 指標（PoC 側 poc/measure.ts・poc/label.ts と揃える。揃えないと比較できない）:
 *   - frame:            rAF フレーム間隔 p50/p95/max・fps（fps は実測 durationMs 割り） … 主指標
 *   - longTask:         >50ms のロングタスク件数・合計・最大 … 主指標
 *   - estimatedVsyncMs: 静止2秒の rAF p50。**必須**（無いと「何フレーム落ち」を後から読めない）
 *   - blockMaxMs/Top3:  MessageChannel ブロック検出器によるメインスレッド最長連続ブロック
 *                       （Leaflet は再描画を遅延させるため frame 統計だけでは取りこぼす。poc/label.ts と同技法）
 *   - domWrites:        DOM 変更回数/秒。**移動中に全点書き換えへ戻るか**（段階0 の差分更新が移動中は
 *                       効かない疑い）を直接確認する主仮説の指標
 *   - meta:             viewport / devicePixelRatio / 観測点パス数・circle 数 / kyoshinActive / segment / mode
 */
window.__measureMovingBaseline = async function measureMovingBaseline(opts = {}) {
  const durationMs = Number(opts.durationMs) || 15000
  const vsyncMs = Number(opts.vsyncMs) || 2000
  const segment = String(opts.segment ?? 'move')
  const label = String(opts.label ?? '')
  const reportUrl = opts.reportUrl || '/__perf-report'

  const mapPane = document.querySelector('.leaflet-map-pane')
  if (!mapPane) throw new Error('leaflet-map-pane が見つからない（地図未表示？）')
  // kyoshin モード以外（quake/tsunami）では kyoshin-points ペインが無いこともあるため null 許容。
  const kyoshinPane = document.querySelector('.leaflet-kyoshin-points-pane')
  const pathCount = kyoshinPane ? kyoshinPane.querySelectorAll('path').length : 0
  const circleCount = kyoshinPane ? kyoshinPane.querySelectorAll('circle').length : 0

  const round = (v) => (v == null ? null : Math.round(v * 100) / 100)

  // --- ① 静止 vsync 計測（必須・operator は動かさない）------------------------------------------
  // どの天井（60Hz=16.7ms 等）で測ったかを証跡に残す。項目2・3 で 2 度同じ穴（vsync 実測の欠落）を
  // 踏んでいるため、移動窓に入る前に必ず取る。
  console.log(`[movingBaseline] ① 静止 vsync 計測 ${vsyncMs}ms … 動かさずにお待ちください`)
  const vsyncDeltas = []
  {
    let lastT = performance.now()
    let id = requestAnimationFrame(function loop(t) {
      vsyncDeltas.push(t - lastT)
      lastT = t
      id = requestAnimationFrame(loop)
    })
    await new Promise((r) => setTimeout(r, vsyncMs))
    cancelAnimationFrame(id)
  }
  vsyncDeltas.shift()
  const vsSorted = [...vsyncDeltas].sort((a, b) => a - b)
  const estimatedVsyncMs = round(vsSorted.length ? vsSorted[Math.floor(vsSorted.length * 0.5)] : null)
  console.log(`[movingBaseline] estimatedVsyncMs = ${estimatedVsyncMs}ms`)

  // --- ② 移動中計測 -----------------------------------------------------------------------------
  // DOM 変更カウント（mapPane 全体と、うち kyoshin-points ペイン配下を分計）。移動中に kyoshinAttrPerSec が
  // 跳ね上がれば「差分更新は移動時に全点書き換えへ戻る（＝地図が動くと全点の座標が変わる）」の裏付け。
  const counts = { map: { attr: 0, nodes: 0 }, kyoshin: { attr: 0, nodes: 0 } }
  const tally = (bucket) => (records) => {
    for (const r of records) {
      if (r.type === 'attributes') bucket.attr++
      else if (r.type === 'childList') bucket.nodes += r.addedNodes.length + r.removedNodes.length
    }
  }
  const moOptions = { attributes: true, childList: true, subtree: true }
  const moMap = new MutationObserver(tally(counts.map))
  moMap.observe(mapPane, moOptions)
  let moKyoshin = null
  if (kyoshinPane) {
    moKyoshin = new MutationObserver(tally(counts.kyoshin))
    moKyoshin.observe(kyoshinPane, moOptions)
  }

  // frame（rAF フレーム間隔）
  const frameDeltas = []
  let lastT = performance.now()
  let rafId = requestAnimationFrame(function loop(t) {
    frameDeltas.push(t - lastT)
    lastT = t
    rafId = requestAnimationFrame(loop)
  })

  // longTask（>50ms。未対応環境では count:-1）
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

  // blockMaxMs（MessageChannel ブロック検出器・vsync 非依存）。Leaflet は移動中サボり着地で一括再描画
  // する性質のため、frame 統計に出ない同期ブロックを名指しで捕捉する（poc/label.ts と同技法）。
  const blockGaps = []
  const mc = new MessageChannel()
  let blockRunning = true
  let lastPing = performance.now()
  mc.port1.onmessage = () => {
    const now = performance.now()
    const gap = now - lastPing
    lastPing = now
    if (gap > 3) blockGaps.push(gap)
    if (blockRunning) mc.port2.postMessage(0)
  }

  const hint =
    segment === 'autozoom'
      ? '設定タブの「地震テスト」ボタンを押してください（自動ズーム flyTo/fitBounds を発火）'
      : segment === 'zoom'
        ? 'ホイール/ズームボタンでズームを繰り返してください'
        : '地図をドラッグしてパンを繰り返してください'
  console.log(`[movingBaseline] ② 移動中計測 ${durationMs}ms … ▶ 今すぐ操作: ${hint}`)
  lastPing = performance.now()
  mc.port2.postMessage(0) // 移動窓の開始と同時にブロック検出を開始
  await new Promise((r) => setTimeout(r, durationMs))

  cancelAnimationFrame(rafId)
  blockRunning = false
  if (po) po.disconnect()
  moMap.disconnect()
  if (moKyoshin) moKyoshin.disconnect()

  // 最初のフレーム間隔は計測開始タイミング依存のノイズなので捨てる
  frameDeltas.shift()
  const sorted = [...frameDeltas].sort((a, b) => a - b)
  const pick = (q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null
  const perSec = (n) => Math.round((n / (durationMs / 1000)) * 10) / 10
  const sortedBlocks = [...blockGaps].sort((a, b) => b - a)

  const result = {
    meta: {
      when: new Date().toISOString(),
      label,
      segment,
      mode: String(opts.mode ?? (pathCount > 1000 ? 'kyoshin' : 'unknown')),
      url: location.href,
      ua: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      pathCount,
      circleCount,
      kyoshinActive: pathCount > 1000,
      durationMs,
      vsyncMs,
      // 何フレーム落ちかを後から読むための天井。移動窓ではなく先頭の静止2秒で取る（必須）。
      estimatedVsyncMs,
    },
    frame: {
      frames: sorted.length,
      fps: round(sorted.length / (durationMs / 1000)),
      p50: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(sorted[sorted.length - 1] ?? null),
    },
    longTask: {
      count: po ? longTasks.length : -1,
      totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
    },
    // メインスレッド最長連続ブロック（vsync 非依存）。frame.p95/max と併読すること。
    blockMaxMs: round(sortedBlocks[0] ?? 0),
    blockTop3Ms: sortedBlocks.slice(0, 3).map((v) => round(v)),
    domWrites: {
      mapPaneAttrPerSec: perSec(counts.map.attr),
      mapPaneNodesPerSec: perSec(counts.map.nodes),
      kyoshinAttrPerSec: perSec(counts.kyoshin.attr),
      kyoshinNodesPerSec: perSec(counts.kyoshin.nodes),
      raw: counts,
    },
  }
  console.log('[movingBaseline] ' + JSON.stringify(result))

  if (opts.report !== false) {
    try {
      const res = await fetch(reportUrl, { method: 'POST', body: JSON.stringify(result) })
      console.log(`[movingBaseline] 証跡送信: ${res.ok ? await res.text() : `HTTP ${res.status}`}`)
    } catch (e) {
      console.warn('[movingBaseline] 証跡送信に失敗（結果は上のログから手動回収可能）:', e)
    }
  }
  return result
}

// /__perf-script?file=moving-baseline として script タグでロードされた場合の準備モード。
// 移動計測は人の操作が要るため自動実行はしない。関数を定義し、証跡の送信先（スクリプト取得元オリジン）を
// 既定に仕込んで使い方を表示するだけにする（別ポートの比較サーバーから読んでも証跡が一箇所に集まる）。
;(() => {
  const script = document.currentScript
  if (!script || !script.src) return
  const src = new URL(script.src, location.href)
  const defaultReportUrl = `${src.origin}/__perf-report`
  const raw = window.__measureMovingBaseline
  // reportUrl の既定をスクリプト取得元オリジンにするラッパへ差し替える（opts で明示された場合は尊重）。
  window.__measureMovingBaseline = (opts = {}) =>
    raw({ reportUrl: defaultReportUrl, ...opts })
  console.log(
    '[movingBaseline] 準備完了。区間ごとに実行してください（②の合図が出たら地図を操作）:\n' +
      "  await window.__measureMovingBaseline({ label:'surface-go2-move-pan',      segment:'pan',      durationMs:15000 })\n" +
      "  await window.__measureMovingBaseline({ label:'surface-go2-move-zoom',     segment:'zoom',     durationMs:15000 })\n" +
      "  await window.__measureMovingBaseline({ label:'surface-go2-move-autozoom', segment:'autozoom', durationMs:20000 })",
  )
})()
