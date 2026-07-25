// 【PoC専用・使い捨て】層B 律速切り分けの計測ランナー（計画書 §6 測定方法）。
//
// 静止/パン/ズームの3局面でフレーム時間(p50/p95/max)・FPS・longtask を測り、負荷3軸
//   - 頂点数軸  : 活断層 full / thin
//   - 塗り面積軸: line-width
//   - DPR軸    : pixelRatio
// を baseline から1軸ずつ振った反応を /__perf-report へ送る（perfReportPlugin が開発機へ保存）。
//
// パン/ズームは rAF ごとにカメラを動かし「操作中の毎フレーム全画面再描画」を強制する
// （Leaflet の CSS transform パンと違い、WebGL 地図は操作中に毎フレーム描き直す。§8）。
//
// 実機での使い方（Surface Go 2）:
//   PoC ページを開き、DevTools コンソールで  await window.__runLayerBSuite('surface-go2')
//   を1回実行すると、baseline(static/pan/zoom) と各軸(pan/zoom) の証跡が開発機へ自動保存される。
import type { Map as MaplibreMap } from 'maplibre-gl'

export type Axis = { faults?: 'full' | 'thin'; lw?: number; pr?: number; points?: boolean }
export type Phase = 'static' | 'pan' | 'zoom'

export interface MeasureDeps {
  map: MaplibreMap
  /** 3軸のうち指定されたものだけ適用し、描画が落ち着くまで待つ。 */
  applyAxis: (a: Axis) => Promise<void>
  /** 計測時点の軸パラメータ・頂点数・キャンバス解像度のスナップショット。 */
  snapshot: () => Record<string, unknown>
}

const REPORT_URL = '/__perf-report'

function waitIdle(map: MaplibreMap, timeoutMs = 8000): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, timeoutMs)
    map.once('idle', () => {
      clearTimeout(t)
      res()
    })
  })
}

// phase に応じてカメラを毎フレーム動かし、全ビューポート再描画を強制する。停止関数を返す。
function startDrive(map: MaplibreMap, phase: Phase): () => void {
  if (phase === 'static') return () => {}
  let id = 0
  let dir = 1
  let moved = 0
  const step = () => {
    if (phase === 'pan') {
      map.panBy([6 * dir, 0], { animate: false })
      moved += 6
      if (moved >= 600) {
        moved = 0
        dir *= -1
      }
    } else {
      const z = map.getZoom()
      let nz = z + 0.02 * dir
      if (nz >= 7) {
        nz = 7
        dir = -1
      } else if (nz <= 4) {
        nz = 4
        dir = 1
      }
      map.setZoom(nz)
    }
    id = requestAnimationFrame(step)
  }
  id = requestAnimationFrame(step)
  return () => cancelAnimationFrame(id)
}

async function measureOnce(
  deps: MeasureDeps,
  phase: Phase,
  durationMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  const { map } = deps
  await waitIdle(map)

  const frameDeltas: number[] = []
  let last = performance.now()
  let rafId = requestAnimationFrame(function loop(t) {
    frameDeltas.push(t - last)
    last = t
    rafId = requestAnimationFrame(loop)
  })

  const longTasks: number[] = []
  let po: PerformanceObserver | null = null
  try {
    po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push(e.duration)
    })
    po.observe({ type: 'longtask' })
  } catch {
    po = null
  }

  const stopDrive = startDrive(map, phase)
  await new Promise((r) => setTimeout(r, durationMs))
  stopDrive()
  cancelAnimationFrame(rafId)
  if (po) po.disconnect()

  // 最初のフレーム間隔は計測開始タイミング依存のノイズなので捨てる
  frameDeltas.shift()
  const sorted = [...frameDeltas].sort((a, b) => a - b)
  const pick = (q: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)

  const result = {
    meta: {
      when: new Date().toISOString(),
      label,
      phase,
      durationMs,
      url: location.href,
      ua: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      ...deps.snapshot(),
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
  }

  try {
    const res = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(result) })
    console.log(
      `[layerB] ${label} ${phase}: ${res.ok ? await res.text() : 'HTTP ' + res.status}`,
      result.frame,
    )
  } catch (e) {
    console.warn('[layerB] report 送信失敗（結果はログから回収可）:', e, result)
  }
  return result
}

export function installMeasure(deps: MeasureDeps): void {
  const w = window as unknown as Record<string, unknown>

  // 単発計測: await __measureLayerB({ phase:'pan', durationMs:10000, label:'adhoc' })
  w.__measureLayerB = (opts: { phase?: Phase; durationMs?: number; label?: string } = {}) =>
    measureOnce(deps, opts.phase ?? 'pan', opts.durationMs ?? 10000, opts.label ?? 'adhoc')

  // 反応表スイート: baseline から1軸ずつ振り、律速(CPU/頂点 か GPUフィルレート)を切り分ける。
  //
  // 2026-07-25 の実機（Surface Go 2）計測で、pan は全軸そろって p95 16.9ms（60Hz の vsync 上限）に
  // 張り付き、塗り面積を 1/4 にしても頂点を 68% 削っても数値が動かなかった。天井より上の余裕は
  // 原理的に測れないため、pan では律速を判定できない（計画書 §6 結果記録）。
  //
  // zoom へ軸を広げた2回目で、zoom も同じく飽和していると判明した。1回目に baseline zoom だけが
  // 33.3ms を出したのは軸の反応ではなく、スイート中で最初に z4〜7 を訪れたことによる
  // 初回タイル読み込み（ウォームアップ）。線幅を 4 に増やした run が逆に 16.9ms へ改善し、
  // longtask が実行順に 3→2→1→0→0→0 と減衰したのが証拠。
  //
  // 【未修正の課題】この suite はまだ計画書 §6「測定方法」の指定を満たしていない:
  //   - DPR は 2.0 へ「上げる」指定なのに 0.75 まで下げる方向にしか振っていない（天井下では無意味）
  //   - CPU スロットル軸・GPU フレーム時間・performance.memory・Leaflet 比較がいずれも未実装
  //   - ウォームアップパス（計測前に z4〜7 を一往復）と末尾の対照 baseline-warm が未実装
  // 所要は約2.3分（13計測 × 10秒）。
  w.__runLayerBSuite = async (labelBase = 'layerB', durationMs = 10000) => {
    const dpr = window.devicePixelRatio || 1
    const baseline: Axis = { faults: 'full', lw: 1.2, pr: dpr, points: true }
    const axisPhases: Phase[] = ['pan', 'zoom']
    const runs: { name: string; axis: Axis; phases: Phase[] }[] = [
      { name: 'baseline', axis: baseline, phases: ['static', 'pan', 'zoom'] },
      // DPR軸: 下げて改善するなら GPU フィルレート律速
      { name: 'dpr-1.0', axis: { ...baseline, pr: 1.0 }, phases: axisPhases },
      { name: 'dpr-0.75', axis: { ...baseline, pr: 0.75 }, phases: axisPhases },
      // 頂点数軸: thin で改善するなら CPU/頂点処理律速
      { name: 'verts-thin', axis: { ...baseline, faults: 'thin' }, phases: axisPhases },
      // 塗り面積軸: 線を太くして悪化するなら GPU フィルレート律速
      { name: 'fill-lw4', axis: { ...baseline, lw: 4 }, phases: axisPhases },
      // 点の寄与
      { name: 'points-off', axis: { ...baseline, points: false }, phases: axisPhases },
    ]
    console.log(`[layerB] suite 開始（device DPR ${dpr}・各 ${durationMs}ms）`)
    for (const run of runs) {
      await deps.applyAxis(run.axis)
      for (const phase of run.phases) {
        await measureOnce(deps, phase, durationMs, `${labelBase}-${run.name}`)
      }
    }
    await deps.applyAxis(baseline)
    console.log('[layerB] suite 完了')
  }
}
