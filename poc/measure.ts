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
import type { Map as MaplibreMap, FitBoundsOptions } from 'maplibre-gl'

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
// 全計測の開始 zoom。zoom 駆動の終了位置は駆動時間依存で不定になり、次 run の pan 計測の開始
// zoom（＝可視ジオメトリ量。頂点数・点数は zoom で2倍以上変わる）を汚すため固定する（レビュー HIGH4）。
// warmup の末尾もここへ戻すので、全計測が同じ描画量から始まる。
const START_ZOOM = 5

// 直近の static 計測（measureOnce）で得た vsync 推定値。measureOneFly（カメラ計測）は常時
// カメラが動いていて static 計測ができないため、この値をキャッシュして使い回す（レビュー HIGH2）。
let lastEstimatedVsyncMs: number | null = null

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
// baseline zoom の最中に geojson-vt 再タイル化コストが残る（レビュー HIGH1）。末尾は START_ZOOM に
// 戻し、後続の各計測（measureOnce 冒頭でも START_ZOOM へ）と開始 zoom＝描画量を揃える。
async function warmup(map: MaplibreMap): Promise<void> {
  for (const z of [4, 5, 6, 7, START_ZOOM]) {
    map.setZoom(z)
    await waitIdle(map, 5000)
  }
}

const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)

// frameDeltas から frame 統計を作る（項目3のflyTo計測・§8ラベル計測とも共有）。
// 最初のフレーム間隔は計測開始タイミング依存のノイズなので捨てる。
export function summarizeFrames(frameDeltas: number[], elapsedMs: number) {
  const deltas = frameDeltas.slice(1)
  const sorted = [...deltas].sort((a, b) => a - b)
  const pick = (q: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null
  return {
    frames: sorted.length,
    fps: round(sorted.length / (elapsedMs / 1000)),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(sorted[sorted.length - 1] ?? null),
  }
}

function summarizeLongTasks(longTasks: number[], observed: boolean) {
  return {
    count: observed ? longTasks.length : -1,
    totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
    maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
  }
}

async function sendReport(
  result: Record<string, unknown>,
  logLabel: string,
  frame: unknown,
): Promise<void> {
  try {
    const res = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(result) })
    console.log(`${logLabel}: ${res.ok ? await res.text() : 'HTTP ' + res.status}`, frame)
  } catch (e) {
    console.warn(`${logLabel} report 送信失敗（結果はログから回収可）:`, e, result)
  }
}

async function measureOnce(
  deps: MeasureDeps,
  phase: Phase,
  durationMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  const { map } = deps
  // 全計測を同じ開始 zoom（＝同じ可視ジオメトリ量）に揃える（レビュー HIGH4）。
  // zoom 駆動の終了位置は駆動時間依存で不定になり、次 run の pan の開始 zoom を汚すため。
  map.setZoom(START_ZOOM)
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

  const frame = summarizeFrames(frameDeltas, durationMs)
  // static は何も動かさないため frame.p50 が実質そのままvsync間隔になる（項目5×6 情報5と同じ手）。
  // 検証項目2（poc/leaflet-measure.ts）と天井の異なる環境で測っていないかを突き合わせるための
  // 証跡（レビュー b4524cd 系譜 HIGH4: Leaflet側にこれが無く、同じ「開発機」でも天井が違う
  // （60Hz対170Hz）測定を並べて食い違う事故があった）。カメラ計測（measureOneFly）は常時
  // カメラが動いていて static を取れないため、直近の static 計測値をキャッシュして使い回す
  // （レビュー HIGH2: __runCameraSuite が static を一度も踏まず、新設パスで再発していた）。
  if (phase === 'static') lastEstimatedVsyncMs = frame.p50
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
      estimatedVsyncMs: phase === 'static' ? frame.p50 : null,
      ...deps.snapshot(),
    },
    frame,
    longTask: summarizeLongTasks(longTasks, po != null),
  }

  await sendReport(result, `[layerB] ${label} ${phase}`, result.frame)
  return result
}

// --- 検証項目3: カメラ操作（flyTo/fitBounds）の滑らかさ ---
//
// 本番の flyTo パターン（JapanMap.tsx 調査済み・flyToLite.ts 経由の全呼び出しを集計）:
//   - 単一点への flyTo: 目標 zoom は MAX_ZOOM(8) 固定
//   - 複数点への flyToBounds: padding は [60,60]（EEW検知系）・[48,48]（津波/観測点フィット）・
//     [20,20]（JAPAN_BOUNDS 全体復帰）の3パターン
//   - duration は 0.8秒（EEW系）・1.0秒（それ以外）の二値
// MapLibre の flyTo/fitBounds の duration は**ミリ秒**単位（Leaflet は秒単位）のため、
// 本 PoC では durationSec を受け取り ×1000 して渡す（取り違え防止のため変数名で明示）。
export type FlyKind = 'point' | 'bounds'
const CAMERA_MAX_ZOOM = 8
// JapanMap.tsx の JAPAN_BOUNDS（[lat,lng]）を MapLibre の [lng,lat] 順へ変換した値
const JAPAN_BOUNDS_LNGLAT: [[number, number], [number, number]] = [
  [129.43, 30.99],
  [145.82, 45.52],
]

function randomPointInJapan(): [number, number] {
  const [[lng0, lat0], [lng1, lat1]] = JAPAN_BOUNDS_LNGLAT
  return [lng0 + Math.random() * (lng1 - lng0), lat0 + Math.random() * (lat1 - lat0)]
}

// padding 60/48 の本番用途（EEW検知点・観測点/海岸線フィット）は、JAPAN_BOUNDS のような広域では
// なく、日本全体の中のごく一部に散らばる少数点への「タイトなズームイン」（maxZoom:MAX_ZOOM 付き）。
// 同じ JAPAN_BOUNDS を使い回すと padding の差しか測れず最も負荷が高い局面（大きなズーム変化）が
// 抜けるため（レビュー HIGH2）、局所クラスタの bounds を都度生成する。
const LOCAL_CLUSTER_SPREAD_DEG = 0.15
function randomLocalClusterBounds(pointCount = 3): [[number, number], [number, number]] {
  const [lng0, lat0] = randomPointInJapan()
  let minLng = lng0
  let maxLng = lng0
  let minLat = lat0
  let maxLat = lat0
  for (let i = 1; i < pointCount; i++) {
    const lng = lng0 + (Math.random() - 0.5) * LOCAL_CLUSTER_SPREAD_DEG * 2
    const lat = lat0 + (Math.random() - 0.5) * LOCAL_CLUSTER_SPREAD_DEG * 2
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ]
}

// padding から本番と同じ意味の bounds/maxZoom を決める。
// [20,20] は JAPAN_BOUNDS への全体復帰（JapanMap.tsx:288 等）、[60,60]/[48,48] は
// EEW検知点・観測点/海岸線への局所フィット（同 :344-346 等、いずれも maxZoom:MAX_ZOOM 付き）。
function boundsTargetForPadding(padding: number): {
  bounds: [[number, number], [number, number]]
  maxZoom?: number
} {
  if (padding === 20) return { bounds: JAPAN_BOUNDS_LNGLAT }
  return { bounds: randomLocalClusterBounds(), maxZoom: CAMERA_MAX_ZOOM }
}

// fitBounds の options を組み立てる。maxZoom が無いケース（padding=20）で `maxZoom: undefined` を
// キーごと渡すと、MapLibre 内部のデフォルト値マージが効かず fitBounds が NaN 座標を計算して
// 例外を投げる（実機検証中に踏んだ・maplibre-gl の既知の挙動）。undefined ならキー自体を含めない。
function fitBoundsOptions(
  padding: number,
  maxZoom: number | undefined,
  durationSec: number,
): FitBoundsOptions {
  const opts: FitBoundsOptions = { padding, duration: durationSec * 1000, essential: true }
  if (maxZoom != null) opts.maxZoom = maxZoom
  return opts
}

// flyTo/fitBounds 1回分（呼び出し〜'moveend' 発火まで）を1計測単位とする。
// measureOnce（固定durationで回してframeDeltaを集計）と違い、実際の飛行時間そのものが計測対象になる。
async function measureOneFly(
  map: MaplibreMap,
  fly: () => void,
  label: string,
  extraMeta: Record<string, unknown>,
  snapshot: () => Record<string, unknown>,
): Promise<Record<string, unknown>> {
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

  const t0 = performance.now()
  // 何らかの理由で 'moveend' が発火しない事故に備え、フレーム収集ループが無限に残らないようにする。
  // map.once だとタイムアウト経路でリスナー参照を解除する手段が無く連続実行のたびに蓄積するため
  // （レビュー MEDIUM）、on/off を自前で対にして確実に外す。
  const moveEndPromise = new Promise<void>((res) => {
    let settled = false
    const handler = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      map.off('moveend', handler)
      res()
    }
    const timeout = setTimeout(handler, 15000)
    map.on('moveend', handler)
  })
  fly()
  await moveEndPromise
  const elapsedMs = performance.now() - t0
  cancelAnimationFrame(rafId)
  if (po) po.disconnect()

  const frame = summarizeFrames(frameDeltas, elapsedMs)
  const result = {
    meta: {
      when: new Date().toISOString(),
      label,
      phase: 'flyto',
      elapsedMs: round(elapsedMs),
      url: location.href,
      ua: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      // レビュー HIGH2: __runCameraSuite 側で static 計測を一度踏み lastEstimatedVsyncMs を
      // 確定させてから使う。単発の __measureCameraFly のみ呼んだ場合は null のままになりうる。
      // 注意（セルフレビュー指摘）: __runCameraSuite 実行後に static を挟まず単発計測だけを
      // 繰り返すと、直近スイート時点の古い値が使われ続ける（値自体は間違っていないが、
      // ディスプレイのリフレッシュレートや電源プロファイルが変わった後は再度スイートを
      // 走らせて更新すること）。
      estimatedVsyncMs: lastEstimatedVsyncMs,
      ...extraMeta,
      ...snapshot(),
    },
    frame,
    longTask: summarizeLongTasks(longTasks, po != null),
  }

  await sendReport(result, `[camera] ${label}`, result.frame)
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

  // 単発計測: await __measureCameraFly({ kind:'bounds', padding:60, durationSec:0.8 })
  w.__measureCameraFly = (
    opts: { kind?: FlyKind; durationSec?: number; padding?: number } = {},
  ) => {
    const durationSec = opts.durationSec ?? 1.0
    if ((opts.kind ?? 'point') === 'bounds') {
      const padding = opts.padding ?? 60
      const { bounds, maxZoom } = boundsTargetForPadding(padding)
      return measureOneFly(
        deps.map,
        () => deps.map.fitBounds(bounds, fitBoundsOptions(padding, maxZoom, durationSec)),
        'adhoc-bounds',
        { kind: 'bounds', padding, durationSec, bounds, maxZoom },
        deps.snapshot,
      )
    }
    const target = randomPointInJapan()
    return measureOneFly(
      deps.map,
      () =>
        deps.map.flyTo({
          center: target,
          zoom: CAMERA_MAX_ZOOM,
          duration: durationSec * 1000,
          essential: true,
        }),
      'adhoc-point',
      { kind: 'point', target, zoom: CAMERA_MAX_ZOOM, durationSec },
      deps.snapshot,
    )
  }

  // カメラ操作スイート: 本番の flyTo（単一点・zoom8）⇔ flyToBounds（padding 60/48 は局所クラスタへの
  // ズームイン、20 は JAPAN_BOUNDS 全体復帰。boundsTargetForPadding 参照）を rounds 回往復し、
  // duration 0.8秒/1.0秒を交互に踏んで実機の滑らかさを測る。
  w.__runCameraSuite = async (labelBase = 'camera', rounds = 8) => {
    const { map } = deps
    map.setZoom(START_ZOOM)
    await waitIdle(map)
    // レビュー HIGH2: vsync天井の実測を証跡に残すため、カメラ計測本体の前に一度 static を
    // 踏む（measureOnce 内で lastEstimatedVsyncMs が更新され、以降の measureOneFly 全てに使う）。
    await measureOnce(deps, 'static', 2000, `${labelBase}-vsync-check`)
    console.log(`[camera] suite 開始（${rounds} 往復）`)
    const paddings = [60, 48, 20] as const
    for (let i = 0; i < rounds; i++) {
      const durationSec = i % 2 === 0 ? 0.8 : 1.0
      const target = randomPointInJapan()
      await measureOneFly(
        map,
        () =>
          map.flyTo({
            center: target,
            zoom: CAMERA_MAX_ZOOM,
            duration: durationSec * 1000,
            essential: true,
          }),
        `${labelBase}-point-d${durationSec}`,
        { kind: 'point', target, zoom: CAMERA_MAX_ZOOM, durationSec },
        deps.snapshot,
      )
      const padding = paddings[i % paddings.length]
      const { bounds, maxZoom } = boundsTargetForPadding(padding)
      await measureOneFly(
        map,
        () => map.fitBounds(bounds, fitBoundsOptions(padding, maxZoom, durationSec)),
        `${labelBase}-bounds-p${padding}-d${durationSec}`,
        { kind: 'bounds', padding, durationSec, bounds, maxZoom },
        deps.snapshot,
      )
    }
    console.log('[camera] suite 完了')
  }

  // --- 検証項目: §8「実行時メモリ」= 長時間稼働の安定性観測 ---
  //
  // 【計測方針（2026-07-27 ユーザー判断）】VRAM（GPU テクスチャ）はブラウザ/OS から観測できず
  // `performance.memory` は JS ヒープのみのため、バイトの厳密計測は原理的に不可能。そこで
  // §8 の問い（＝移行で 4GB 機が不安定化するか）に直答するため、**実機で長時間稼働させて
  // タブ kill / context lost / OOM という「結果」が起きるかを観測**する（webgl-poc-surface-go2-2026-07-27.md
  // ③・計画書 §8）。バイト計測でなく結果を見る。
  //
  // 実利用（防災アプリ＝常時表示・時々 EEW で flyTo）を模し、sampleEverySec ごとに1回だけ軽く
  // カメラを動かして（ランダム地点へ flyTo → 日本全体へ戻す＝タイル/テクスチャの確保・解放を促す）、
  // その都度 jsHeap・webglMemory 推定・contextLost 回数・longtask をスナップショットして /__perf-report へ送る。
  // 末尾に first/last/min/max とデルタの要約を送る。**判定は人が読む**: contextLost>0 は不安定、
  // webglTotalMB / jsHeapMB の deltaFirstToLast が持続的に増え続けるならリーク疑い（単発の増減は無視）。
  //
  // 実機での呼び出し: await window.__runStabilitySuite('surface-go2-stability', 30)  // 30分
  // 途中停止: window.__stopStabilitySuite()
  // 【注意】タブ kill 自体はページ消滅のため自己申告できない。最後に届いたサンプルの elapsedSec/when が
  // 「いつまで生きていたか」を示す（＝実機側でサンプルが途切れたら kill/reload と判断する）。
  w.__runStabilitySuite = async (labelBase = 'stability', minutes = 30, sampleEverySec = 30) => {
    const { map } = deps
    const canvas = map.getCanvas()
    let contextLost = 0
    let contextRestored = 0
    const onLost = () => {
      contextLost++
      console.warn(`[stability] webglcontextlost #${contextLost}`)
    }
    const onRestored = () => {
      contextRestored++
      console.warn(`[stability] webglcontextrestored #${contextRestored}`)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    let stopped = false
    w.__stopStabilitySuite = () => {
      stopped = true
    }

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

    const samples: Record<string, number | null>[] = []
    const takeSample = () => {
      const snap = deps.snapshot() as { jsHeapMB?: number | null; webglMemory?: { totalBytes?: number } }
      const webglTotalMB =
        snap.webglMemory?.totalBytes != null ? round(snap.webglMemory.totalBytes / 1048576) : null
      // 消費済み longtask は切り捨てる（配列を溜め続けると、まさに測りたい jsHeap トレンドに
      // ハーネス自身のメモリ増加が混入するため）。
      const newLt = longTasks.splice(0, longTasks.length)
      const s: Record<string, number | null> = {
        elapsedSec: Math.round((performance.now() - t0) / 1000),
        jsHeapMB: snap.jsHeapMB ?? null,
        webglTotalMB,
        contextLost,
        contextRestored,
        ltCount: newLt.length,
        ltMaxMs: round(newLt.length ? Math.max(...newLt) : 0),
      }
      samples.push(s)
      return s
    }
    const sampleMeta = () => ({
      when: new Date().toISOString(),
      label: `${labelBase}-sample`,
      kind: 'stability-sample',
      url: location.href,
      ua: navigator.userAgent,
      ...deps.snapshot(),
    })
    // moveend が来なくても進めるようタイムアウトと対にする。map.once ではタイムアウト経路で
    // リスナーが残り連続実行で蓄積するため（measureOneFly と同じ教訓）、on/off を自前で対にして外す。
    const flyAndWait = (fly: () => void) =>
      new Promise<void>((res) => {
        let settled = false
        const handler = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          map.off('moveend', handler)
          res()
        }
        const timeout = setTimeout(handler, 3000)
        map.on('moveend', handler)
        fly()
      })

    const t0 = performance.now()
    const totalMs = minutes * 60_000
    map.setZoom(START_ZOOM)
    await waitIdle(map)
    console.log(
      `[stability] 開始: ${minutes}分・${sampleEverySec}秒ごとにサンプル。途中停止は __stopStabilitySuite()`,
    )
    await sendReport({ meta: sampleMeta(), sample: takeSample() }, '[stability] sample(初期)', null)

    while (!stopped && performance.now() - t0 < totalMs) {
      // 実利用を模した軽い活動: ランダム地点へ flyTo → 日本全体へ戻す（タイル/テクスチャの確保・解放を促す）
      await flyAndWait(() =>
        map.flyTo({ center: randomPointInJapan(), zoom: CAMERA_MAX_ZOOM, duration: 1000, essential: true }),
      )
      await flyAndWait(() =>
        map.fitBounds(JAPAN_BOUNDS_LNGLAT, { padding: 20, duration: 1000, essential: true }),
      )
      // サンプル間隔は近似（2回の flyAndWait が計 ~2000ms で終わる前提で残りを待つ）。フレーム落ちで
      // 飛行が延びると間隔は延びうるが、各サンプルの elapsedSec は実測値なので記録自体は正確。
      await new Promise((r) => setTimeout(r, Math.max(0, sampleEverySec * 1000 - 2000)))
      const s = takeSample()
      await sendReport({ meta: sampleMeta(), sample: s }, `[stability] +${s.elapsedSec}s`, s)
    }

    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
    if (po) po.disconnect()

    const trend = (key: 'jsHeapMB' | 'webglTotalMB') => {
      const arr = samples.map((s) => s[key]).filter((v): v is number => v != null)
      if (!arr.length) return null
      return {
        first: arr[0],
        last: arr[arr.length - 1],
        min: Math.min(...arr),
        max: Math.max(...arr),
        deltaFirstToLast: round(arr[arr.length - 1] - arr[0]),
      }
    }
    const summary = {
      meta: {
        when: new Date().toISOString(),
        label: `${labelBase}-summary`,
        kind: 'stability-summary',
        url: location.href,
        ua: navigator.userAgent,
        durationSec: Math.round((performance.now() - t0) / 1000),
        samples: samples.length,
        ...deps.snapshot(),
      },
      contextLost,
      contextRestored,
      jsHeapMB: trend('jsHeapMB'),
      webglTotalMB: trend('webglTotalMB'),
      // 自動判定ではなく人が読むための目安。contextLost>0 は不安定。デルタが持続的増加ならリーク疑い。
      stableHint: contextLost === 0,
    }
    await sendReport(summary, '[stability] summary', summary)
    console.log('[stability] 完了', summary)
    return summary
  }
}
