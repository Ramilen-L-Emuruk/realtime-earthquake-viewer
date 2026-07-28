/**
 * MapLibre 実アプリの描画負荷計測スクリプト（高精細化後の頂点数増加の実機裏取り用）。
 * docs/webgl-rendering-migration-plan.md §2.3 / レビュー webgl-migration-review-89188bd.md の
 * 「頂点数がPoC基準(40,917)の約8.75倍(~358k)になったので実機で軽く確認」への回答ツール。
 *
 * PoC(poc/measure.ts)の実証済みプリミティブを実アプリ向けに移植:
 *   - blockMaxMs: MessageChannel ping-pong による vsync 非依存のメインスレッド停止検出。
 *     開発機は 60/144/170Hz の vsync 天井に張り付いて frame では差が見えないが、非力機
 *     (Surface Go 2)の「カクッと引っかかる」実コストはこれで捉えられる（PoC の主指標）。
 *   - fps は名目 duration ではなく実 elapsed 割り（PoC で3度踏んだ罠）。
 *   - detect: 各シナリオで queryRenderedFeatures 等を記録し「狙った負荷を実際に踏んだか」を
 *     結果自身に持たせる（PoC の「差の出ない条件で差が出ないのを良い結果と誤読する」対策）。
 *
 * 計測シナリオ:
 *   - static-quake       : 地震情報モード静止（境界+活断層+プレート+ラベルの高精細ジオメトリ・vsync 床）
 *   - pan-maxzoom-quake  : 高ズームで連続パン（全レイヤー・頂点シェーダ+ライン結合の実負荷）
 *   - zoom-quake         : ズームイン/アウト往復（再タイル化・LOD 切替コスト）
 *   - static-kyoshin     : リアルタイムモニタ静止（観測点1700+毎秒更新が加わる）
 *   - pan-maxzoom-kyoshin: リアルタイムで高ズーム連続パン
 *   - maxload-eew        : 【防災アプリ最悪ケース】リアルタイム稼働中に EEW 特別警報テストを発火し、
 *                          予想震度塗り+震源+カメラ flyTo+毎秒更新を高精細ベースマップごと同時に走らせる
 *
 * 使い方 A（手動・開発機/実機）: 本ファイルを DevTools コンソールへ貼り付け →
 *   `await window.__measureAppRender({ label: 'surface-go2' })` の返り値 JSON を記録。
 * 使い方 B（実機・自動送信。vite-plugin-perf-report.ts とセット）: 開発機で
 *   `npm run dev:dmdss -- --host` を起動 → 実機ブラウザでアプリを開き、DevTools で1行:
 *   document.head.appendChild(Object.assign(document.createElement('script'),
 *     { src: '/__perf-script?file=measure-app-render.js&auto=1&label=surface-go2-hires' }))
 *   → 全シナリオを自動計測し scripts/perf/results/ へ証跡が保存される。
 */
;(() => {
  const round = (v) => (v == null ? null : Math.round(v * 100) / 100)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function stats(xs) {
    if (!xs.length) return { n: 0, p50: null, p95: null, max: null, mean: null }
    const s = [...xs].sort((a, b) => a - b)
    const pick = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
    return {
      n: s.length,
      p50: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(s[s.length - 1]),
      mean: round(xs.reduce((a, b) => a + b, 0) / xs.length),
    }
  }

  function summarizeFrames(deltas, elapsedMs) {
    const st = stats(deltas)
    return { frames: st.n, fps: round(st.n / (elapsedMs / 1000)), p50: st.p50, p95: st.p95, max: st.max }
  }

  const map = () => window.__mapGL

  // 現ビューポートで指定レイヤー群が実際に何 feature 描画されているか（負荷を踏んだ証跡）。
  function detect() {
    const m = map()
    const ids = [
      'land-fill', 'sub-borders', 'pref-borders', 'active-faults', 'plate-boundaries',
      'kyoshin-points', 'kyoshin-subthreshold', 'quake-region-fill', 'eew-region-fill', 'pswave',
    ]
    const out = { zoom: round(m.getZoom()) }
    for (const id of ids) {
      if (!m.getLayer(id)) continue
      try {
        out[id] = m.queryRenderedFeatures({ layers: [id] }).length
      } catch {
        /* custom レイヤー等は query 不可 */
      }
    }
    return out
  }

  // duration の間 frame delta / blockMaxMs / longtask を収集する。drive(仕掛け) は並行して走らせる。
  async function measureWindow(durationMs, drive) {
    const frameDeltas = []
    let last = performance.now()
    let rafId = requestAnimationFrame(function loop(t) {
      frameDeltas.push(t - last)
      last = t
      rafId = requestAnimationFrame(loop)
    })

    // vsync 非依存のブロック検出（ping-pong の往復間隔＝メインスレッドが止まった時間）。
    const blockGaps = []
    const mc = new MessageChannel()
    let running = true
    let lastPing = performance.now()
    mc.port1.onmessage = () => {
      const now = performance.now()
      const gap = now - lastPing
      lastPing = now
      if (gap > 3) blockGaps.push(gap)
      if (running) mc.port2.postMessage(0)
    }

    const longTasks = []
    let po = null
    try {
      po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) longTasks.push(e.duration)
      })
      po.observe({ type: 'longtask' })
    } catch {
      po = null
    }

    const t0 = performance.now()
    lastPing = performance.now()
    mc.port2.postMessage(0)
    if (drive) await drive(durationMs)
    else await sleep(durationMs)
    const elapsedMs = performance.now() - t0

    running = false
    cancelAnimationFrame(rafId)
    if (po) po.disconnect()
    frameDeltas.shift() // 先頭は計測開始前の待ち時間を含むため捨てる

    const sortedBlocks = blockGaps.slice().sort((a, b) => b - a)
    return {
      elapsedMs: round(elapsedMs),
      frame: summarizeFrames(frameDeltas, elapsedMs),
      blockMaxMs: round(sortedBlocks[0] ?? 0),
      blockTop3Ms: sortedBlocks.slice(0, 3).map(round),
      longtask: {
        count: po ? longTasks.length : -1,
        maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
        totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      },
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      detect: detect(),
    }
  }

  // --- カメラ駆動（計測窓の間、連続レンダーを起こす） ---
  const JAPAN = [138, 37]
  // 高ズームで一定方向へ連続パン（線形 easeTo・duration 全域）。
  function drivePan(fromCenter, zoom, dLng, dLat) {
    return (durationMs) =>
      new Promise((res) => {
        const m = map()
        m.jumpTo({ center: fromCenter, zoom })
        m.once('moveend', res)
        m.easeTo({
          center: [fromCenter[0] + dLng, fromCenter[1] + dLat],
          duration: durationMs,
          easing: (t) => t,
        })
        // easeTo が moveend を出さない事故に備えた保険
        setTimeout(res, durationMs + 800)
      })
  }
  // ズームイン→アウトを往復（再タイル化コスト）。
  function driveZoom(center, zLo, zHi) {
    return async (durationMs) => {
      const m = map()
      const half = Math.max(400, durationMs / 2)
      m.jumpTo({ center, zoom: zLo })
      await new Promise((res) => {
        m.once('moveend', res)
        m.easeTo({ zoom: zHi, duration: half, easing: (t) => t })
        setTimeout(res, half + 600)
      })
      await new Promise((res) => {
        m.once('moveend', res)
        m.easeTo({ zoom: zLo, duration: half, easing: (t) => t })
        setTimeout(res, half + 600)
      })
    }
  }

  // --- タブ/モード制御 ---
  function clickNav(keyword) {
    for (const b of document.querySelectorAll('nav button, [role="navigation"] button, button')) {
      const name = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.textContent || ''}`
      if (name.includes(keyword)) {
        b.click()
        return true
      }
    }
    return false
  }
  function clickTestButton(label) {
    for (const b of document.querySelectorAll('button')) {
      if ((b.textContent || '').replace(/\s/g, '').includes(label.replace(/\s/g, ''))) {
        b.click()
        return true
      }
    }
    return false
  }
  // リアルタイム(kyoshin)モードで観測点が揃うのを待つ。
  async function waitKyoshinReady(maxSec = 40) {
    clickNav('リアルタイム')
    for (let i = 0; i < maxSec; i++) {
      const m = map()
      if (m && m.getLayer('kyoshin-points')) {
        try {
          if (m.queryRenderedFeatures({ layers: ['kyoshin-points'] }).length > 100) return true
        } catch {
          /* まだ */
        }
      }
      await sleep(1000)
    }
    return false
  }

  // --- 本体 ---
  async function run(opts = {}) {
    const label = opts.label || 'app-render'
    const DUR = opts.durationMs || 6000
    const m = map()
    if (!m) throw new Error('window.__mapGL が無い（MapLibre 版で実行しているか確認）')

    const scenarios = {}

    // 1) 地震情報モード（既定タブ）で高精細ベースマップの静止 → vsync 床＋静的描画コスト
    clickNav('地震情報') || clickNav('情報')
    await sleep(1200)
    scenarios['static-quake'] = await measureWindow(DUR, (d) => {
      m.jumpTo({ center: JAPAN, zoom: 6 })
      return sleep(d)
    })
    const vsync = scenarios['static-quake'].frame.p50

    // 2) 高ズーム連続パン（全レイヤーの実頂点負荷）
    scenarios['pan-maxzoom-quake'] = await measureWindow(DUR, drivePan([136.0, 35.3], 12, 0.4, 0.15))
    // 3) ズーム往復
    scenarios['zoom-quake'] = await measureWindow(DUR, driveZoom([138.7, 35.38], 8, 13.5))

    // 4-5) リアルタイム(kyoshin)モード：観測点1700+毎秒更新が加わる
    const kyoshinOk = await waitKyoshinReady()
    scenarios['static-kyoshin'] = await measureWindow(DUR, (d) => {
      m.jumpTo({ center: JAPAN, zoom: 6 })
      return sleep(d)
    })
    scenarios['pan-maxzoom-kyoshin'] = await measureWindow(DUR, drivePan([139.6, 35.6], 11, 0.3, 0.1))

    // 6) 【防災アプリ最悪ケース】リアルタイム稼働中に EEW 特別警報テスト発火（震度7・特別警報）。
    //    予想震度塗り+震源+カメラ flyTo+毎秒更新+高精細ベースマップを同時に走らせて blockMaxMs を見る。
    m.jumpTo({ center: [141.0, 38.3], zoom: 7 })
    await sleep(300)
    const eewFired = clickTestButton('EEW特別警報テスト') || clickTestButton('特別警報テスト')
    scenarios['maxload-eew'] = await measureWindow(opts.maxloadMs || 12000, (d) => sleep(d))
    scenarios['maxload-eew'].detect.eewFired = eewFired
    scenarios['maxload-eew'].detect.kyoshinReady = kyoshinOk

    const result = {
      meta: {
        when: new Date().toISOString(),
        label,
        url: location.href,
        ua: navigator.userAgent,
        viewport: `${innerWidth}x${innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
        canvas: (() => {
          const c = m.getCanvas()
          return `${c.width}x${c.height}`
        })(),
        estimatedVsyncMs: vsync,
        jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      },
      scenarios,
    }

    // 読みやすいサマリをログ（実機の DevTools で一目で分かるように）
    console.log('[measureAppRender] 完了。blockMaxMs（小さいほど良い・非力機の実カクつき指標）:')
    for (const [k, v] of Object.entries(scenarios)) {
      console.log(
        `  ${k.padEnd(22)} fps ${String(v.frame.fps).padStart(5)}  blockMax ${String(v.blockMaxMs).padStart(6)}ms  longtaskMax ${v.longtask.maxMs}ms`,
      )
    }

    if (opts.report) {
      try {
        const res = await fetch(opts.reportUrl || '/__perf-report', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify(result),
        })
        console.log('[measureAppRender] report:', res.ok ? await res.text() : 'HTTP ' + res.status)
      } catch (e) {
        console.warn('[measureAppRender] report 送信失敗（結果はログ/返り値から回収可）:', e)
      }
    }
    return result
  }

  window.__measureAppRender = run

  // 自動実行モード（/__perf-script?file=measure-app-render.js&auto=1&label=xxx）
  const script = document.currentScript
  if (script && script.src) {
    const src = new URL(script.src, location.href)
    if (src.searchParams.get('auto') === '1') {
      const label = src.searchParams.get('label') || ''
      ;(async () => {
        // アプリ初期化（地図生成・データ遅延読込）を少し待ってから開始
        for (let i = 0; i < 30; i++) {
          if (window.__mapGL) break
          await sleep(1000)
        }
        await run({ label, report: true, reportUrl: `${src.origin}/__perf-report` })
      })()
    }
  }
})()
