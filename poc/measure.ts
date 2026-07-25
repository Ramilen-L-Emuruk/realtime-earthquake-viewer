// 【PoC専用・使い捨て】層B 律速切り分けの計測ランナー（計画書 §6 測定方法）。
//
// 静止/パン/ズームの3局面でフレーム時間(p50/p95/max)・FPS・longtask を測り、負荷3軸
//   - 頂点数軸  : 活断層 full / thin
//   - 塗り面積軸: line-width（＋観測点 circle の on/off）
//   - DPR軸    : pixelRatio
// を振った反応を /__perf-report へ送る（perfReportPlugin が開発機へ保存）。
//
// パン/ズームは rAF ごとにカメラを動かし「操作中の毎フレーム全画面再描画」を強制する
// （Leaflet の CSS transform パンと違い、WebGL 地図は操作中に毎フレーム描き直す。§8）。
//
// 2026-07-25 の飽和・交絡を受け、スイートは (1) 冒頭に全整数ズームのウォームアップ、
// (2) 負荷を上げる方向（DPR2.0・線幅8/12・overload）で vsync 天井の突破を狙う、
// (3) 末尾に baseline-warm 対照、で構成する（詳細は __runLayerBSuite 直前のコメント）。
//
// 実機での使い方（Surface Go 2）:
//   PoC ページで await window.__runLayerBSuite('surface-go2') を1回実行すると、ウォームアップ後に
//   baseline(static/pan/zoom)・各軸(pan/zoom)・baseline-warm の証跡が開発機へ自動保存される。
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

// 計測前のウォームアップ: 全整数ズームを踏んで初回タイル読み込み・ジオメトリ再タイル化を
// 先に済ませる（初訪問ズームの交絡を除く。2026-07-25 の zoom 33.3ms はこれが原因だった）。
// setZoom は瞬間移動で中間ズームを訪れないため、計測時に連続スイープする z4〜7 の全整数を
// 明示的に列挙する。特に GeoJSON ソース(faults/points)は map zoom と 1:1 で、z6 を抜かすと
// baseline zoom の最中に geojson-vt 再タイル化コストが残る（レビュー HIGH1）。末尾の 5 は
// 計測開始位置（初期 zoom）へ戻すため。
async function warmup(map: MaplibreMap): Promise<void> {
  for (const z of [4, 5, 6, 7, 5]) {
    map.setZoom(z)
    await waitIdle(map, 5000)
  }
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

  // 反応表スイート（2026-07-25 の飽和・交絡を踏まえ、負荷を上げる方向＋ウォームアップ対照に改訂）。
  //
  // 1回目/2回目の実機（Surface Go 2・60Hz）では pan・zoom とも全軸が p95 16.9ms（vsync 上限）に
  // 飽和し、塗り面積を 1/4 にしても頂点を 68% 削っても動かず律速を判定できなかった。zoom で
  // baseline だけ 33.3ms を出したのは初訪問ズームレベルのタイル読み込み（ウォームアップ）で、軸の
  // 反応ではなかった（fill-lw4 が逆に改善・longtask が実行順 3→2→1→0→0→0 と減衰・計画書 §6 結果記録）。
  //
  // 対策（計画書 §6 測定方法へ寄せる）:
  //   1) 計測前に z4〜7 を一往復して温め、初回タイル読み込みの交絡を除く。
  //   2) DPR を実効値より「上げる」方向(2.0)・線幅を大きく(8/12)、両者を重ねた overload を先頭に置き、
  //      baseline が vsync 天井(16.7ms)を破るかをまず確認する（天井下では軸比較は無意味）。
  //   3) 末尾で baseline を再計測(baseline-warm)し、warm でも zoom が劣化するかで交絡仮説を検証する。
  //   ※ GPU フレーム時間・CPU スロットル・Leaflet 比較は引き続き実機側/別工数の課題。
  //     performance.memory は snapshot に追加済みだが JS ヒープのみ（WebGL バッファは含まない・§8）。
  w.__runLayerBSuite = async (labelBase = 'layerB', durationMs = 10000) => {
    const dpr = window.devicePixelRatio || 1
    const baseline: Axis = { faults: 'full', lw: 1.2, pr: dpr, points: true }
    const axisPhases: Phase[] = ['pan', 'zoom']
    const runs: { name: string; axis: Axis; phases: Phase[] }[] = [
      { name: 'baseline', axis: baseline, phases: ['static', 'pan', 'zoom'] },
      // 最重設定: DPR 2.0＋線幅12。まず天井(16.7ms)を破れるかを確認する
      // （破れないなら headroom は相当大きい＝現行負荷では律速に届かないと言える）。
      { name: 'overload-dpr2-lw12', axis: { ...baseline, pr: 2.0, lw: 12 }, phases: axisPhases },
      // 塗り面積を上げる方向（フィルレート律速なら悪化するはず）
      { name: 'dpr-2.0', axis: { ...baseline, pr: 2.0 }, phases: axisPhases },
      { name: 'fill-lw12', axis: { ...baseline, lw: 12 }, phases: axisPhases },
      { name: 'fill-lw8', axis: { ...baseline, lw: 8 }, phases: axisPhases },
      // 頂点数軸（CPU/頂点律速なら thin で改善）
      { name: 'verts-thin', axis: { ...baseline, faults: 'thin' }, phases: axisPhases },
      // 下げ方向の対照（天井を破れたときにのみ意味を持つ）
      { name: 'dpr-1.0', axis: { ...baseline, pr: 1.0 }, phases: axisPhases },
      // 観測点 circle の描画寄与（塗り面積の一部）を切り分ける
      { name: 'points-off', axis: { ...baseline, points: false }, phases: axisPhases },
    ]
    // 交絡除去: 計測前に全整数ズームを踏んで温める（初回タイル取得・geojson-vt 再タイル化を先に払う）
    console.log('[layerB] ウォームアップ（z4〜7 全整数・非計測）')
    await deps.applyAxis(baseline)
    await warmup(deps.map)
    console.log(`[layerB] suite 開始（device DPR ${dpr}・各 ${durationMs}ms）`)
    let prevFaults = baseline.faults
    for (const run of runs) {
      await deps.applyAxis(run.axis)
      // ジオメトリ差し替え(faults 切替)は全ズームのタイル化をやり直すため、その run は再度温める。
      // 怠ると verts-thin の zoom 計測に再タイル化コストが乗り、頂点軸だけ不利になる（レビュー HIGH2）。
      const f = run.axis.faults
      if (f && f !== prevFaults) {
        await warmup(deps.map)
        prevFaults = f
      }
      for (const phase of run.phases) {
        await measureOnce(deps, phase, durationMs, `${labelBase}-${run.name}`)
      }
    }
    // ウォーム後の baseline 対照: zoom がここでも 33.3ms なら交絡仮説は棄却（真の負荷）、16.9ms なら交絡確定
    await deps.applyAxis(baseline)
    // baseline は full。直前 run が thin だと差し替えで全ズーム再タイル化になるため、対照計測前に温め直す
    if (prevFaults !== baseline.faults) {
      await warmup(deps.map)
      prevFaults = baseline.faults
    }
    await measureOnce(deps, 'zoom', durationMs, `${labelBase}-baseline-warm`)
    await measureOnce(deps, 'pan', durationMs, `${labelBase}-baseline-warm`)
    console.log('[layerB] suite 完了')
  }
}
