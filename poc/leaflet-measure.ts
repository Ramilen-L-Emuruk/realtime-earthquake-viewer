// 【PoC専用・使い捨て】検証項目2: Leaflet 側の律速切り分け（poc/measure.ts の Leaflet 版）。
//
// 層B（検証項目1・poc/main.ts）は「MapLibre は現行負荷で天井(vsync)を破らない」ことを実機3回計測で
// 確定させたが、これは「Leaflet より軽いか」には答えていない。Leaflet の pan は CSS transform の
// コンポジタ合成のみで再ペイントがほぼ走らないのに対し、MapLibre は毎フレーム全ビューポートを
// 塗り直すため、両者とも「60fps」に張り付いてもメインスレッドの仕事量は桁違いの可能性がある
// （計画書 §2.4・層B 2回目の訂正）。この差はフレーム時間だけでは区別できない可能性が高いが、
// まずはフレーム時間（poc/measure.ts と同じ p50/p95/max/longtask）で測り、それで差が見えるかを
// 確認する（見えなければ Performance トレースでのメインスレッド内訳計測を別途検討する）。
//
// poc/main.ts（MapLibre 版）と条件を揃えるため、負荷3軸のうち Leaflet に対応物がある2軸だけ再現する:
//   - 頂点数軸  : 活断層 full(31,646頂点) / thin(9,874頂点) の切替（同じ public/data/*.json を使う）
//   - 塗り面積軸: line weight・観測点 circleMarker の on/off
// DPR 軸（MapLibre の setPixelRatio）は Leaflet に対応する公開APIが無いため対象外（申し送り。
// Leaflet の Canvas/SVG レンダラーは devicePixelRatio 依存の内部スケーリングを持つのみで、
// インスタンス単位で解像度倍率を独立に変える手段は無い）。
//
// パン/ズームの駆動方法は MapLibre 版と意図的に非対称にする（それこそが測りたい違いのため）:
//   - pan       : 毎フレーム map._rawPanBy(offset) + map.fire('move') のみ発火し、moveend は
//                 フェーズ終了時（ドラッグ終了相当）に1回だけ発火する。
//                 【レビュー CRITICAL】当初 map.panBy(offset, {animate:false}) を毎フレーム呼んでいたが、
//                 このAPIは内部で this.fire('move').fire('moveend') を同一呼び出しで発火する
//                 （node_modules/leaflet/dist/leaflet-src.js L3460-3463）。Renderer.getEvents() は
//                 moveend を購読して _updatePaths()（全SVGパスの再クリップ・再簡略化・再描画）を
//                 起動するため、毎フレーム moveend を発火すると実ドラッグでは起きないフル再描画を
//                 人為的に注入してしまい、「Leaflet の pan は CSS transform 合成のみで軽い」という
//                 本項目が検証したい仮説そのものを壊す。実ドラッグ（Handler.Drag._onDrag、L13817-13831）
//                 は毎フレーム 'move' のみを発火し、'moveend' は指を離した時（_onDragEnd）に1回だけ
//                 発火する。この経路を直接再現する
//   - zoom-native: 本番相当。setZoom(target, {animate:true}) を一定間隔（既定アニメ時間 250ms より
//                 長い 400ms 間隔）で往復させ、Leaflet 自身のズームアニメーション（CSS transform で
//                 拡縮→着地時に1回だけ再描画）に任せる。「本番はどれだけ軽いか」を測る
//   - zoom-forced: setZoom(nz, {animate:false}) を毎フレーム呼び、MapLibre 同様に毎フレーム強制再描画
//                 させる。「アニメーションの近道が無ければ Leaflet の素の描画コストはどうか」を測る
//                 （MapLibre と直接比較できる数値はこちら）
import type { Map as LeafletMap, TileLayer } from 'leaflet'

export type Axis = { faults?: 'full' | 'thin'; lw?: number; points?: boolean }
export type Phase = 'static' | 'pan' | 'zoom-native' | 'zoom-forced'

export interface MeasureDeps {
  map: LeafletMap
  tileLayer: TileLayer
  applyAxis: (a: Axis) => Promise<void>
  snapshot: () => Record<string, unknown>
}

const REPORT_URL = '/__perf-report'
// poc/measure.ts の START_ZOOM と同値（可視ジオメトリ量を揃える）
const START_ZOOM = 5
const ZOOM_MIN = 4
const ZOOM_MAX = 7
// zoom-native の往復間隔。Leaflet既定のズームアニメーション時間(250ms)より長く取り、
// 前のアニメーションが着地してから次を発火する（自己干渉を避ける）
const ZOOM_NATIVE_INTERVAL_MS = 400

// --- 検証項目3: カメラ操作（flyTo/flyToBounds）の Leaflet 版 ---
// poc/measure.ts（MapLibre 版 measureOneFly / __runCameraSuite）と apples-to-apples にするための対応物。
// 目的: 実機で MapLibre 側がカメラ操作中に vsync 天井を破った（fps 28.2〜52.7）のに対し、Leaflet 側の
// 同条件計測が無く優劣を判定できない、を解消する（検証項目3・実機報告
// webgl-poc-surface-go2-2026-07-27.md）。既存の Leaflet PoC（poc/main.ts の MapLibre 版と同一の
// GEBCO＋活断層＋観測点構成）にカメラ計測を足すことで、本番アプリ側の交絡（レイヤー内容差）を挟まず
// PoC 対 PoC の同条件比較にする。
//
// MapLibre 版との対応と相違:
//   - 座標順: Leaflet は [lat, lng]（MapLibre は [lng, lat]）
//   - duration: Leaflet の flyTo/flyToBounds は**秒**（MapLibre はミリ秒）。durationSec をそのまま渡す
//   - 本番 flyTo パターン（JapanMap.tsx 調査・MapLibre 版と同一）: 単一点は zoom=CAMERA_MAX_ZOOM(8) 固定、
//     複数点フィットは padding 60(EEW検知)/48(津波・観測点)/20(JAPAN_BOUNDS 全体復帰)、duration 0.8/1.0秒
export type FlyKind = 'point' | 'bounds'
const CAMERA_MAX_ZOOM = 8
// JapanMap.tsx の JAPAN_BOUNDS そのまま（Leaflet は [lat, lng] 順）。MapLibre 版はこれを [lng,lat] に
// 入れ替えた値を使っている（poc/measure.ts）。
const JAPAN_BOUNDS_LATLNG: [[number, number], [number, number]] = [
  [30.99, 129.43],
  [45.52, 145.82],
]
const LOCAL_CLUSTER_SPREAD_DEG = 0.15
// 直近の static 計測で得た vsync 推定値。カメラ計測（measureOneFlyLeaflet）は常時カメラが動くため
// static 相当の推定が取れず、スイート先頭の static 計測でキャッシュした値を証跡に添える
// （MapLibre 版 measure.ts の lastEstimatedVsyncMs と同じ仕組み・レビュー HIGH4/HIGH2 の系譜。
// どの天井で測ったかを証跡に残し、環境違いの取り違えを防ぐ）。
let lastEstimatedVsyncMs: number | null = null

function randomPointInJapan(): [number, number] {
  const [[lat0, lng0], [lat1, lng1]] = JAPAN_BOUNDS_LATLNG
  return [lat0 + Math.random() * (lat1 - lat0), lng0 + Math.random() * (lng1 - lng0)]
}

// 局所クラスタの bounds（MapLibre 版 randomLocalClusterBounds と対応・[lat,lng] 順）。
// padding 60/48 の本番用途（EEW検知点・観測点/海岸線フィット）は日本全体ではなく、ごく一部に散らばる
// 少数点への「タイトなズームイン」（maxZoom 付き）なので、都度この局所 bounds を生成する。
function randomLocalClusterBounds(pointCount = 3): [[number, number], [number, number]] {
  const [lat0, lng0] = randomPointInJapan()
  let minLat = lat0
  let maxLat = lat0
  let minLng = lng0
  let maxLng = lng0
  for (let i = 1; i < pointCount; i++) {
    const lat = lat0 + (Math.random() - 0.5) * LOCAL_CLUSTER_SPREAD_DEG * 2
    const lng = lng0 + (Math.random() - 0.5) * LOCAL_CLUSTER_SPREAD_DEG * 2
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
  }
  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ]
}

// padding から本番と同じ意味の bounds/maxZoom を決める（MapLibre 版 boundsTargetForPadding と対応）。
// 20 = JAPAN_BOUNDS 全体復帰（maxZoom 無し）、60/48 = 局所クラスタへのタイトなズームイン（maxZoom:8）。
function boundsTargetForPadding(padding: number): {
  bounds: [[number, number], [number, number]]
  maxZoom?: number
} {
  if (padding === 20) return { bounds: JAPAN_BOUNDS_LATLNG }
  return { bounds: randomLocalClusterBounds(), maxZoom: CAMERA_MAX_ZOOM }
}

function waitTilesLoaded(layer: TileLayer, timeoutMs = 5000): Promise<void> {
  return new Promise((res) => {
    if (!layer.isLoading()) {
      res()
      return
    }
    const t = setTimeout(res, timeoutMs)
    layer.once('load', () => {
      clearTimeout(t)
      res()
    })
  })
}

// phase に応じてカメラを動かし続ける。停止関数を返す。
// 停止関数は、フェーズ終了時に同期的に発生したコスト（pan の moveend 一括再描画）があれば
// その所要時間(ms)を返す。無ければ undefined（レビュー b4524cd 系譜・82d4d39 HIGH1 対応）。
function startDrive(map: LeafletMap, phase: Phase): () => number | undefined {
  if (phase === 'static') return () => undefined
  if (phase === 'pan') {
    // 実ドラッグ（Handler.Drag._onDrag）と同じ経路: 毎フレームは _rawPanBy + 'move' のみ発火する
    // （SVGレンダラーは 'moveend' しか購読しないため、ここでは全パス再描画は起きない）。
    const rawMap = map as unknown as { _rawPanBy: (offset: { x: number; y: number }) => void }
    let dir = 1
    let moved = 0
    let id = requestAnimationFrame(function step() {
      rawMap._rawPanBy({ x: 6 * dir, y: 0 })
      map.fire('move')
      moved += 6
      if (moved >= 600) {
        moved = 0
        dir *= -1
      }
      id = requestAnimationFrame(step)
    })
    // フェーズ終了 = 実ドラッグでの指を離すタイミング相当。ここで初めて 'moveend' を1回発火し、
    // SVGレンダラーの全パス再描画（本来ドラッグ終了時に1回だけ起きるコスト）を起こす。
    // 【レビュー HIGH1】この同期コストは cancelAnimationFrame 後に起きるためフレーム統計
    // （p50/p95/max）には一切現れない。Leaflet の pan は「動作中は軽いが離した瞬間に一括で払う」
    // 性質なので、この「払う分」を測らないと Leaflet 有利に偏る。moveendMs として名指しで返す
    // （MapLibre 側には対応するコストが存在しない——この非対称自体が項目2 の答えの一部）。
    return () => {
      cancelAnimationFrame(id)
      const t0 = performance.now()
      map.fire('moveend')
      return performance.now() - t0
    }
  }
  if (phase === 'zoom-forced') {
    let dir = 1
    let id = requestAnimationFrame(function step() {
      const z = map.getZoom()
      let nz = z + 0.02 * dir
      if (nz >= ZOOM_MAX) {
        nz = ZOOM_MAX
        dir = -1
      } else if (nz <= ZOOM_MIN) {
        nz = ZOOM_MIN
        dir = 1
      }
      map.setZoom(nz, { animate: false })
      id = requestAnimationFrame(step)
    })
    return () => {
      cancelAnimationFrame(id)
      return undefined
    }
  }
  // zoom-native: 着地コストは400ms間隔の往復の中で(次のsetZoom呼び出し前に)発火済みのため、
  // フェーズ終了時に追加で払うコストは無い（レビュー 82d4d39 HIGH1 の補足）。
  let toggled = false
  const id = setInterval(() => {
    map.setZoom(toggled ? START_ZOOM : ZOOM_MAX, { animate: true })
    toggled = !toggled
  }, ZOOM_NATIVE_INTERVAL_MS)
  return () => {
    clearInterval(id)
    return undefined
  }
}

async function warmup(map: LeafletMap, tileLayer: TileLayer): Promise<void> {
  for (const z of [4, 5, 6, 7, START_ZOOM]) {
    map.setZoom(z, { animate: false })
    await waitTilesLoaded(tileLayer, 5000)
  }
}

async function measureOnce(
  deps: MeasureDeps,
  phase: Phase,
  durationMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  const { map, tileLayer } = deps
  map.setZoom(START_ZOOM, { animate: false })
  await waitTilesLoaded(tileLayer)

  const frameDeltas: number[] = []
  const frameCollectStart = performance.now()
  let last = frameCollectStart
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
  const moveendMs = stopDrive()
  // fpsはdurationMs(名目値)ではなく実測経過時間で割る（項目7 HIGH1と同じ理由。moveendの同期コスト
  // 分だけ実際の経過時間はdurationMsよりわずかに長くなりうる。レビュー b4524cd 系譜・MEDIUM2 対応）。
  const elapsedMs = performance.now() - frameCollectStart
  cancelAnimationFrame(rafId)
  if (po) po.disconnect()

  frameDeltas.shift()
  const sorted = [...frameDeltas].sort((a, b) => a - b)
  const pick = (q: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)

  // static は何も動かさないため frame.p50 が実質そのままvsync間隔になる（項目5×6 情報5・
  // 項目7 baseline と同じ手）。MapLibre側(poc/measure.ts)にはこれが無く、実際に「開発機」と
  // 記録された2つの測定が天井の違う環境（60Hz対170Hz）で取られ数値が食い違う事故があった
  // （レビュー HIGH4）。どの天井で測ったかを証跡に残す。
  const estimatedVsyncMs = phase === 'static' ? round(pick(0.5)) : null
  // カメラ計測（measureOneFlyLeaflet）が証跡に添えられるよう、static 計測時にモジュールへキャッシュ
  // する（MapLibre 版 measure.ts の lastEstimatedVsyncMs と同じ仕組み）。
  if (phase === 'static' && estimatedVsyncMs != null) lastEstimatedVsyncMs = estimatedVsyncMs

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
      estimatedVsyncMs,
      ...deps.snapshot(),
    },
    frame: {
      frames: sorted.length,
      fps: round(sorted.length / (elapsedMs / 1000)),
      p50: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(sorted[sorted.length - 1] ?? null),
    },
    // ドラッグ終了時（pan のみ）の一括再描画コスト。動作中のフレーム時間とは別物として名指しで
    // 記録する（項目7 の areaEvents と同じ考え方）。MapLibre 側には対応するコストが存在しない。
    // 注意: この同期コストは elapsedMs（＝fps の分母）にも含まれるため、pan の fps がわずかに
    // 下がる形でも同じコストの影響が出る。二重に不利と見なさず、fps低下とmoveendMsは同じ1つの
    // コストを2つの角度（動作中平均への影響／単発の実額）から見ているだけと読むこと。
    moveendMs: moveendMs != null ? round(moveendMs) : null,
    longTask: {
      count: po ? longTasks.length : -1,
      totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
    },
  }

  try {
    const res = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(result) })
    console.log(
      `[leafletB] ${label} ${phase}: ${res.ok ? await res.text() : 'HTTP ' + res.status}`,
      result.frame,
    )
  } catch (e) {
    console.warn('[leafletB] report 送信失敗（結果はログから回収可）:', e, result)
  }
  return result
}

// flyTo/flyToBounds 1回分（呼び出し〜'moveend' 発火まで）を1計測単位とする（MapLibre 版 measureOneFly
// と対応）。measureOnce（固定 duration でフレーム集計）と違い、飛行時間そのものが計測対象になる。
async function measureOneFlyLeaflet(
  deps: MeasureDeps,
  fly: () => void,
  label: string,
  extraMeta: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { map } = deps
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
  // 'moveend' が発火しない事故に備えタイムアウトを対にする（MapLibre 版と同じ。map.once だと
  // タイムアウト経路でリスナーを外せず連続実行で蓄積するため、on/off を自前で対にして確実に外す）。
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

  frameDeltas.shift()
  const sorted = [...frameDeltas].sort((a, b) => a - b)
  const pick = (q: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)

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
      // スイート先頭の static 計測でキャッシュした vsync 推定値（無ければ null）。MapLibre 版と同様。
      estimatedVsyncMs: lastEstimatedVsyncMs,
      ...extraMeta,
      ...deps.snapshot(),
    },
    frame: {
      frames: sorted.length,
      fps: round(sorted.length / (elapsedMs / 1000)),
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
      `[leaflet-camera] ${label}: ${res.ok ? await res.text() : 'HTTP ' + res.status}`,
      result.frame,
    )
  } catch (e) {
    console.warn('[leaflet-camera] report 送信失敗（結果はログから回収可）:', e, result)
  }
  return result
}

export function installLeafletMeasure(deps: MeasureDeps): void {
  const w = window as unknown as Record<string, unknown>

  // 単発計測: await __measureLeafletB({ phase:'zoom-forced', durationMs:10000, label:'adhoc' })
  w.__measureLeafletB = (opts: { phase?: Phase; durationMs?: number; label?: string } = {}) =>
    measureOnce(deps, opts.phase ?? 'pan', opts.durationMs ?? 10000, opts.label ?? 'adhoc')

  // 反応表スイート。poc/main.ts の __runLayerBSuite と対応する軸（faults/lw/points）を振る。
  // DPR軸は対象外（Leafletに対応APIが無い）。zoom は native/forced 両方を毎 run で測る。
  w.__runLeafletBSuite = async (labelBase = 'leafletB', durationMs = 10000) => {
    const baseline: Axis = { faults: 'full', lw: 1.2, points: true }
    const runs: { name: string; axis: Axis }[] = [
      { name: 'baseline', axis: baseline },
      { name: 'fill-lw12', axis: { ...baseline, lw: 12 } },
      { name: 'fill-lw8', axis: { ...baseline, lw: 8 } },
      { name: 'verts-thin', axis: { ...baseline, faults: 'thin' } },
      { name: 'points-off', axis: { ...baseline, points: false } },
    ]
    console.log('[leafletB] ウォームアップ（z4〜7 全整数・非計測）')
    await deps.applyAxis(baseline)
    await warmup(deps.map, deps.tileLayer)
    console.log(`[leafletB] suite 開始（devicePixelRatio ${window.devicePixelRatio}・各 ${durationMs}ms）`)
    let prevFaults = baseline.faults
    for (const run of runs) {
      await deps.applyAxis(run.axis)
      const f = run.axis.faults
      if (f && f !== prevFaults) {
        await warmup(deps.map, deps.tileLayer)
        prevFaults = f
      }
      await measureOnce(deps, 'static', durationMs, `${labelBase}-${run.name}`)
      await measureOnce(deps, 'pan', durationMs, `${labelBase}-${run.name}`)
      await measureOnce(deps, 'zoom-native', durationMs, `${labelBase}-${run.name}`)
      await measureOnce(deps, 'zoom-forced', durationMs, `${labelBase}-${run.name}`)
    }
    await deps.applyAxis(baseline)
    if (prevFaults !== baseline.faults) {
      await warmup(deps.map, deps.tileLayer)
    }
    await measureOnce(deps, 'zoom-forced', durationMs, `${labelBase}-baseline-warm`)
    await measureOnce(deps, 'pan', durationMs, `${labelBase}-baseline-warm`)
    console.log('[leafletB] suite 完了')
  }

  // --- 検証項目3: カメラ操作（MapLibre 版 __measureCameraFly / __runCameraSuite と apples-to-apples）---

  // 単発計測: await __measureLeafletCameraFly({ kind:'bounds', padding:60, durationSec:0.8 })
  w.__measureLeafletCameraFly = (
    opts: { kind?: FlyKind; durationSec?: number; padding?: number } = {},
  ) => {
    const durationSec = opts.durationSec ?? 1.0
    if ((opts.kind ?? 'point') === 'bounds') {
      const padding = opts.padding ?? 60
      const { bounds, maxZoom } = boundsTargetForPadding(padding)
      return measureOneFlyLeaflet(
        deps,
        () =>
          deps.map.flyToBounds(bounds, {
            padding: [padding, padding],
            ...(maxZoom != null ? { maxZoom } : {}),
            duration: durationSec,
          }),
        'adhoc-bounds',
        { kind: 'bounds', padding, durationSec, bounds, maxZoom },
      )
    }
    const target = randomPointInJapan()
    return measureOneFlyLeaflet(
      deps,
      () => deps.map.flyTo(target, CAMERA_MAX_ZOOM, { duration: durationSec }),
      'adhoc-point',
      { kind: 'point', target, zoom: CAMERA_MAX_ZOOM, durationSec },
    )
  }

  // カメラ操作スイート。MapLibre 版 __runCameraSuite と同じ構造: 先頭で static を1回踏み vsync を
  // 証跡に残す → 単一点 flyTo（zoom8）⇔ flyToBounds（padding 60/48/20）を rounds 回、duration
  // 0.8/1.0秒を交互に踏む。ラベルは MapLibre 版と同形式（point-d{sec} / bounds-p{pad}-d{sec}）にして
  // 突き合わせやすくする。実機での呼び出し: await window.__runLeafletCameraSuite('surface-go2-leaflet-camera')
  w.__runLeafletCameraSuite = async (labelBase = 'leaflet-camera', rounds = 8) => {
    const { map, tileLayer } = deps
    map.setZoom(START_ZOOM, { animate: false })
    await waitTilesLoaded(tileLayer)
    // vsync 天井の実測を証跡に残す（この static 計測が lastEstimatedVsyncMs を更新し、以降の
    // 各 measureOneFlyLeaflet に添えられる）。
    await measureOnce(deps, 'static', 2000, `${labelBase}-vsync-check`)
    console.log(`[leaflet-camera] suite 開始（${rounds} 往復）`)
    const paddings = [60, 48, 20] as const
    for (let i = 0; i < rounds; i++) {
      const durationSec = i % 2 === 0 ? 0.8 : 1.0
      const target = randomPointInJapan()
      await measureOneFlyLeaflet(
        deps,
        () => map.flyTo(target, CAMERA_MAX_ZOOM, { duration: durationSec }),
        `${labelBase}-point-d${durationSec}`,
        { kind: 'point', target, zoom: CAMERA_MAX_ZOOM, durationSec },
      )
      const padding = paddings[i % paddings.length]
      const { bounds, maxZoom } = boundsTargetForPadding(padding)
      await measureOneFlyLeaflet(
        deps,
        () =>
          map.flyToBounds(bounds, {
            padding: [padding, padding],
            ...(maxZoom != null ? { maxZoom } : {}),
            duration: durationSec,
          }),
        `${labelBase}-bounds-p${padding}-d${durationSec}`,
        { kind: 'bounds', padding, durationSec, bounds, maxZoom },
      )
    }
    console.log('[leaflet-camera] suite 完了')
  }
}
