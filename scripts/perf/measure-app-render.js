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
 *   - move / blockTimeline: ブロック検出の各発生時刻と movestart/moveend の時系列を記録し、
 *     重いブロックがカメラ移動(flyTo)区間に集中するかを機種非依存で判定する（move.blockDuringMoveMs
 *     ≫ blockWhileStillMs なら diagnosis-3 の「flyTo×同時データ更新の重なり」仮説が数値で裏付く）。
 *     静止シナリオ(ハーネスがカメラを駆動しない窓)での想定外の move は、実データ由来の検知フィットが
 *     計測に混入したシグナルにもなる（caveat-real-quake の担保）。
 *
 * 計測シナリオ:
 *   - static-quake       : 地震情報モード静止（境界+活断層+プレート+ラベルの高精細ジオメトリ・vsync 床）
 *   - pan-maxzoom-quake  : 高ズームで連続パン（全レイヤー・頂点シェーダ+ライン結合の実負荷）
 *   - zoom-quake         : ズームイン/アウト往復（再タイル化・LOD 切替コスト）
 *   - flyto-widezoom-quake: 【分離】広ズーム(EEW 画角)でカメラ移動のみ・低密度ルート＝高精細ベース×カメラの単独コスト
 *   - flyto-sanriku-quake : 【ピンポイント】三陸沖(EEW 震源=最密リアス海岸)へカメラ移動・quake のみ＝最密域飛行の単独コスト
 *   - static-kyoshin     : リアルタイムモニタ静止（観測点1700+毎秒更新が加わる）
 *   - pan-maxzoom-kyoshin: リアルタイムで高ズーム連続パン
 *   - maxload-eew        : 【防災アプリ最悪ケース】リアルタイム稼働中に EEW 特別警報テストを発火し、
 *                          予想震度塗り+震源+カメラ flyTo+毎秒更新を高精細ベースマップごと同時に走らせる
 *                          （新規発報条件＝前回 n=3 基準と同一。EEW セクションの先頭で発火する）
 *   - eew-static         : 【分離】EEW 複合をカメラ静止で＝毎秒更新+波+EEW塗り × 高精細ベースの持続コスト単独
 *                          （直前 maxload の EEW が残るため続報になるが狙いは損なわれない）
 *   - eew-nofills        : 【内訳切り分け】eew-static と同一状態で EEW 区域塗りレイヤーだけ非表示。
 *                          eew-static − eew-nofills ＝ 区域塗りの per-render コスト（予報円/震源は WebGL 外）
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

  // movestart/moveend の時系列(絶対時刻)から「カメラが動いていた区間」を t0 相対[開始,終了]で復元する。
  // 入れ子(easeTo 中の再フィット等)は深さカウンタで畳み、取りこぼし(窓外で開始/未クローズ)には保守的に
  // 窓端で丸める。復元後に重なり/隣接区間をマージし、ブロック時間の移動中/静止中按分に使う。
  function buildMoveWindows(events, t0, elapsedMs) {
    const wins = []
    let depth = 0
    let start = null
    for (const e of events) {
      const t = round(e.at - t0)
      if (e.type === 'start') {
        if (depth === 0) start = Math.max(0, t)
        depth++
      } else if (depth === 0) {
        // 窓開始前から動いていた移動の moveend → 窓頭から当該時刻までを区間とする。
        wins.push([0, Math.min(round(elapsedMs), t)])
      } else if (--depth === 0) {
        wins.push([start ?? 0, t])
        start = null
      }
    }
    if (depth > 0) wins.push([start ?? 0, round(elapsedMs)]) // 窓末で未クローズの移動
    wins.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const w of wins) {
      const last = merged[merged.length - 1]
      if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1])
      else merged.push([w[0], w[1]])
    }
    return merged
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
    // 各ブロックの発生時刻(絶対)も記録し、後で t0 相対へ直してカメラ移動区間との重なりを判定する。
    const blockEvents = [] // { at, gap }（at は performance.now() 絶対値）
    const mc = new MessageChannel()
    let running = true
    let lastPing = performance.now()
    mc.port1.onmessage = () => {
      const now = performance.now()
      const gap = now - lastPing
      lastPing = now
      if (gap > 3) blockEvents.push({ at: now, gap })
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

    // 窓の途中(60%地点)でも detect を採る。maxload 等は終端でカメラが海上へ flyTo して陸が
    // 画面外になり end の detect が全0になるため、負荷が乗っている最中のスナップショットを別に持つ。
    let detectMid = null
    const midTimer = setTimeout(() => {
      try {
        detectMid = detect()
      } catch {
        /* 途中で query 不可な状態でも計測は続ける */
      }
    }, Math.round(durationMs * 0.6))

    // カメラ移動イベントの時系列。movestart→moveend の対から「カメラが動いていた区間」を復元し、
    // 重いブロックがその区間に集中するか(diagnosis-3 の flyTo×同時データ更新の重なり 仮説)を直接判定する。
    // 併せて、静止シナリオ(ハーネスがカメラを駆動しない窓)での想定外の movestart は、実データ由来の
    // 検知フィット等の混入シグナルになる(caveat-real-quake)。moveendCount は従来どおりカメラ確定回数
    // （データ駆動で GPU 速度非依存＝機種非依存）を保持する。
    const moveEvents = [] // { at, type: 'start'|'end' }
    let moveendCount = 0
    const onMoveStart = () => moveEvents.push({ at: performance.now(), type: 'start' })
    const onMoveEnd = () => {
      moveEvents.push({ at: performance.now(), type: 'end' })
      moveendCount++
    }
    const mm = map()
    mm.on('movestart', onMoveStart)
    mm.on('moveend', onMoveEnd)

    // map の 'render'(全体再描画)発火回数。非力機では1回の再描画が高コスト(358k頂点)なので、
    // 「連続再描画させている駆動源」を機種非依存で捉える鍵。maxload と eew-static で比べ、maxload だけ
    // render が突出していれば「何かが計測窓中ずっと triggerRepaint/再描画させている」ことの証拠になる。
    let renderCount = 0
    const onRender = () => {
      renderCount++
    }
    mm.on('render', onRender)

    const t0 = performance.now()
    lastPing = performance.now()
    mc.port2.postMessage(0)
    if (drive) await drive(durationMs)
    else await sleep(durationMs)
    const elapsedMs = performance.now() - t0

    clearTimeout(midTimer)
    running = false
    cancelAnimationFrame(rafId)
    if (po) po.disconnect()
    mm.off('movestart', onMoveStart)
    mm.off('moveend', onMoveEnd)
    mm.off('render', onRender)
    frameDeltas.shift() // 先頭は計測開始前の待ち時間を含むため捨てる

    // t0 相対の時系列へ変換し、カメラ移動区間を復元してブロック時間を移動中/静止中に按分する。
    const blockTimeline = blockEvents.map((b) => ({ t: round(b.at - t0), ms: round(b.gap) }))
    const moveTimeline = moveEvents.map((e) => ({ t: round(e.at - t0), type: e.type }))
    const moveWindows = buildMoveWindows(moveEvents, t0, elapsedMs)
    const inMoveWindow = (t) => moveWindows.some((w) => t >= w[0] && t <= w[1])
    let blockDuringMoveMs = 0
    let blockWhileStillMs = 0
    let blockMaxDuringMove = 0
    let blockMaxWhileStill = 0
    for (const b of blockTimeline) {
      if (inMoveWindow(b.t)) {
        blockDuringMoveMs += b.ms
        if (b.ms > blockMaxDuringMove) blockMaxDuringMove = b.ms
      } else {
        blockWhileStillMs += b.ms
        if (b.ms > blockMaxWhileStill) blockMaxWhileStill = b.ms
      }
    }

    const sortedBlocks = blockTimeline.map((b) => b.ms).sort((a, b) => b - a)
    return {
      elapsedMs: round(elapsedMs),
      moveendCount,
      renderCount,
      renderPerSec: round(renderCount / (elapsedMs / 1000)),
      frame: summarizeFrames(frameDeltas, elapsedMs),
      blockMaxMs: round(sortedBlocks[0] ?? 0),
      blockTop3Ms: sortedBlocks.slice(0, 3).map(round),
      // 【diagnosis-3 実証フック】カメラ移動区間との時系列相関。move.blockDuringMoveMs ≫ blockWhileStillMs なら
      // 「重いブロックは flyTo 進行中に集中する（flyTo×同時データ更新の重なり）」が数値で裏付けられる。
      move: {
        windows: moveWindows, // [[開始,終了],...]（ms・t0 相対。カメラが動いていた区間）
        count: moveWindows.length,
        totalMoveMs: round(moveWindows.reduce((a, w) => a + (w[1] - w[0]), 0)),
        blockDuringMoveMs: round(blockDuringMoveMs),
        blockWhileStillMs: round(blockWhileStillMs),
        blockMaxDuringMove: round(blockMaxDuringMove),
        blockMaxWhileStill: round(blockMaxWhileStill),
      },
      blockTimeline: blockTimeline.slice(0, 300), // 生の時系列（先頭300件で頭打ち・payload 制限対策）
      moveTimeline,
      longtask: {
        count: po ? longTasks.length : -1,
        maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
        totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      },
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      detect: detect(),
      detectMid,
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
    // 3.5) 【分離】広ズーム(EEW 発報の画角)で連続パン＝高精細ベースマップ×カメラ移動のみ。
    //      EEW も kyoshin も無い純粋な地震情報モードで、広ズーム時のベース再描画コストを単独で捉える。
    //      経路は茨城〜栃木付近（相対的に密度の低い区間）。三陸ルート(下)との対照になる。
    scenarios['flyto-widezoom-quake'] = await measureWindow(DUR, drivePan([139.5, 37.5], 7.5, 0.6, 0.25))
    // 3.6) 【ピンポイント検証】EEW 震源=三陸沖(38.1,142.9・最密リアス海岸の直近)へ向けてカメラ移動(quake のみ・
    //      EEW/kyoshin なし)。内陸[140.5,39.0]から震源[142.9,38.1]へ＝三陸リアス海岸を横断する経路。
    //      flyto-widezoom(低密度ルート)と比較し、三陸ルートだけ突出して重ければ「最密ジオメトリ域への
    //      カメラ移動」が maxload の支配要因と確定する（診断 docs/webgl-migration-hires-perf-diagnosis-2026-07-28.md）。
    scenarios['flyto-sanriku-quake'] = await measureWindow(DUR, drivePan([140.5, 39.0], 8, 2.4, -0.9))

    // 4-5) リアルタイム(kyoshin)モード：観測点1700+毎秒更新が加わる
    const kyoshinOk = await waitKyoshinReady()
    scenarios['static-kyoshin'] = await measureWindow(DUR, (d) => {
      m.jumpTo({ center: JAPAN, zoom: 6 })
      return sleep(d)
    })
    scenarios['pan-maxzoom-kyoshin'] = await measureWindow(DUR, drivePan([139.6, 35.6], 11, 0.3, 0.1))

    // 6) 【防災アプリ最悪ケース】リアルタイム稼働中に EEW 特別警報テスト発火（震度7・特別警報）。
    //    予想震度塗り+震源+カメラ flyTo+毎秒更新+高精細ベースマップを同時に走らせて blockMaxMs を見る。
    //    ※EEW セクションの先頭に置く＝計測窓内で最初の発火＝「新規発報」条件。前回 n=3 の基準
    //      （maxload-eew が唯一・最初の発火）と同一条件で比較できるようにする（レビュー review-b9f5b95 の MEDIUM）。
    m.jumpTo({ center: [141.0, 38.3], zoom: 7 })
    await sleep(300)
    const eewFired = clickTestButton('EEW特別警報テスト') || clickTestButton('特別警報テスト')
    scenarios['maxload-eew'] = await measureWindow(opts.maxloadMs || 12000, (d) => sleep(d))
    scenarios['maxload-eew'].detect.eewFired = eewFired
    scenarios['maxload-eew'].detect.kyoshinReady = kyoshinOk

    // 7) 【分離】EEW 複合を「カメラ静止」で測る＝毎秒更新+波(100ms)+EEW塗り × 高精細ベース(広ズーム・陸)。
    //    直前 maxload の EEW がまだ有効（自動解除 ~30秒 > 経過 ~12秒）なため、ここの発火は「続報」になるが、
    //    本シナリオの狙いは「カメラ静止での複合再描画の持続コスト」で、続報でも塗り/毎秒更新/波は同様に走り、
    //    続報の再フィット flyTo は下の定点 jumpTo で上書きするため目的は損なわれない。maxload が遅く
    //    eew-static も遅ければ主因は「複合再描画×広ズームのベース」、eew-static が健全なら flyTo 側
    //    （flyto-widezoom と突き合わせる）。
    // 定点は EEW 予想震度塗りが実際に写る視点（maxload の detectMid で eew-region-fill>0 を確認済みの
    // 震源近傍・三陸沿岸）にする。北にずらすと塗りが画角外になり eew-static/eew-nofills の対照が無意味になる。
    const EEW_LAND_VIEW = [141.0, 38.3]
    const EEW_LAND_ZOOM = 7
    m.jumpTo({ center: EEW_LAND_VIEW, zoom: EEW_LAND_ZOOM })
    await sleep(300)
    const eewFired1 = clickTestButton('EEW特別警報テスト') || clickTestButton('特別警報テスト')
    await sleep(4000) // 発火（続報）時の自動 flyTo の収束を待つ
    m.jumpTo({ center: EEW_LAND_VIEW, zoom: EEW_LAND_ZOOM }) // 定点へ戻して静止（塗りが写る震源近傍）
    await sleep(500)
    scenarios['eew-static'] = await measureWindow(8000, (d) => sleep(d))
    scenarios['eew-static'].detect.eewFired = eewFired1

    // 7b) 【内訳切り分け】直前の eew-static と同一状態（EEW 有効・カメラ EEW_LAND_VIEW 固定）で、EEW 区域塗り
    //     レイヤーだけを非表示にして再計測する。予報円は自前 canvas・震源は HTML マーカーで WebGL 描画の外なので、
    //     EEW が WebGL 描画に足しているのは実質この塗りだけ。eew-static − eew-nofills の差＝塗りの per-render コスト。
    //     この差が支配的なら「区域塗りの高精細ジオメトリ」を見た目を保ったまま軽量化(LOD等)する対処が的。
    const EEW_FILL_LAYERS = ['eew-region-fill', 'eew-region-fill-line', 'eew-lpgm-region-fill', 'eew-lpgm-region-fill-line']
    const hidden = []
    for (const id of EEW_FILL_LAYERS) {
      if (m.getLayer(id)) {
        m.setLayoutProperty(id, 'visibility', 'none')
        hidden.push(id)
      }
    }
    await sleep(500)
    scenarios['eew-nofills'] = await measureWindow(8000, (d) => sleep(d))
    scenarios['eew-nofills'].detect.hiddenFillLayers = hidden
    for (const id of hidden) m.setLayoutProperty(id, 'visibility', 'visible') // 状態を戻す

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

    // 読みやすいサマリをログ（実機の DevTools で一目で分かるように）。
    // blockMove/blockStill＝重いブロックの合計を「カメラ移動中／静止中」に按分した値。
    // maxload-eew で blockMove ≫ blockStill なら flyTo×同時更新の重なりが主因と読める（diagnosis-3）。
    console.log('[measureAppRender] 完了。blockMaxMs（小さいほど良い・非力機の実カクつき指標）:')
    for (const [k, v] of Object.entries(scenarios)) {
      console.log(
        `  ${k.padEnd(22)} fps ${String(v.frame.fps).padStart(5)}  blockMax ${String(v.blockMaxMs).padStart(6)}ms` +
          `  blockMove ${String(v.move.blockDuringMoveMs).padStart(6)}ms  blockStill ${String(v.move.blockWhileStillMs).padStart(6)}ms` +
          `  moveWin ${v.move.count}  longtaskMax ${v.longtask.maxMs}ms`,
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
