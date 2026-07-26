// 【PoC専用・使い捨て】検証項目6（毎秒更新）の律速切り分け。
//
// 強震モニタは毎秒、全観測点（約1,725）の震度 index を更新する。現行 Leaflet+SVG は
// 「前回レベルから変化した点だけ setStyle」の差分更新で、平常時はほぼ書き込み 0＋SVG は
// 変更要素だけ再ペイント（KyoshinPoints.tsx 段階0）。MapLibre(WebGL) に移すと 1 点でも
// 変われば全ビューポート再描画になる（ダブルバッファの swap で前フレームを保持しないため、
// SVG のような「変わった要素だけ再ラスタライズ」ができない）。
//
// 「全画面」には観測点だけでなく本番のベースマップ（陸地塗り＋細分区域境界＋県境の約4万頂点。県境リングは
// fill と line の両方で描画されるため実描画頂点は 40,917）も含まれ、毎秒まとめて塗り直される。そこで
// 本番相当のベースマップを敷いた上で、更新方式ごとに
// 「毎秒の全画面再描画」＋「更新の CPU コスト」を切り分けて測る:
//   - baseline     : 更新なし（静止の床）
//   - feature-state: 既に GPU に乗った頂点の状態(色)だけ更新。再タイル化なし＝更新 CPU 最小・
//                    再描画は毎秒全画面。WebGL の最良ケース。
//   - setData      : 観測点 GeoJSON を丸ごと差し替え。geojson-vt が worker で再タイル化＋全画面
//                    再描画。素朴実装の悪ケース。
//
// 判定: feature-state が baseline に近ければ「WebGL でも毎秒更新は軽く回せる」＝一本化 GO 材料。
//       setData が longtask/フレーム遅延を生めば「素朴な setData は不可・feature-state 必須」という
//       移植制約が判明する。どちらも天井を破らなければ検証項目7（EEW 複合）へ積む。
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Point, Polygon, LineString } from 'geojson'

// 本体 JapanMap.tsx / kyoshinIntensity.ts と揃える描画パラメータ
const JAPAN_CENTER: [number, number] = [137.7, 38.25] // MapLibre は [lng, lat]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
const BASE_RADIUS = 2.5
// 現行の強震モニタ観測点数（約1,725）に合わせて station-coords を均等サンプリングする（main.ts と同じ）
const TARGET_POINTS = 1725
const LEVELS = 10 // lvl 0..9
// 強震モニタ風の簡易段階配色（負荷測定用・厳密な気象庁配色ではない。lvl 0 は震度0以下のグレー）
const COLORS = [
  '#9ca3af',
  '#2b8cbe',
  '#41b6c4',
  '#7fcdbb',
  '#c7e9b4',
  '#ffffb2',
  '#fecc5c',
  '#fd8d3c',
  '#f03b20',
  '#bd0026',
]
// 本番 kyoshin モードのベースマップ配色（BaseMap.tsx と一致・毎秒の全画面再描画で塗り直される対象）
const LAND_FILL = '#161b24' // 陸地塗り（都道府県ポリゴン）
const SUBREGION_BORDER = '#39414f' // 一次細分区域の境界線
const PREF_BORDER = '#56607a' // 県境
// 全計測の開始 zoom（可視ジオメトリ量＝描画量を揃える。measure.ts と同思想）
const START_ZOOM = 5
const REPORT_URL = '/__perf-report'
// settle（apply→idle 収束時間）のタイムアウト上限（レビュー CRITICAL）。setData の再タイル化が周期
// (1000ms)を超えて収束しないと idle が発火せず settle が沈黙するため、この時間で打ち切って下限値を計上し、
// 収束しなかった事実を settleTimeouts で明示する。周期の数倍を取る。
const SETTLE_TIMEOUT_MS = 5000

type LevelProps = { lvl: number }
// 計測モード: baseline=更新なしの床 / repaint-only=更新なしで全画面再描画のみ（再描画コスト単独・提案4）/
// feature-state=GPU 上の状態(色)だけ更新 / setData=GeoJSON 丸ごと差し替え。
type Mode = 'baseline' | 'repaint-only' | 'feature-state' | 'setData'

const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN_CENTER,
  zoom: START_ZOOM,
  attributionControl: false,
  // 素の描画負荷を測るため、ラベル等の余計なレイヤーは持たせない
  style: {
    version: 8,
    sources: {
      // maxzoom: タイルセットの実カバレッジ上限（z7）。未指定だと手動で z8+ にズームした際に存在しない
      // タイルを要求して 404 がコンソールを埋め、ERROR: の目視確認と紛らわしい（レビュー情報5）。
      gebco: { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256, maxzoom: 7 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
      { id: 'gebco', type: 'raster', source: 'gebco' },
    ],
  },
})

// setData で properties.lvl を差し替えて再利用するため、生成後の FeatureCollection を保持する
let fc: FeatureCollection<Point, LevelProps> = { type: 'FeatureCollection', features: [] }
let pointCount = 0
let basemapVertices = 0

// station-coords（約4,372点）を TARGET_POINTS へ均等サンプリングし、feature に id と lvl:0 を付与する。
// feature-state は feature.id が無いと機能しないため、top-level id（0..n-1）を必ず振る。
async function loadPoints(): Promise<FeatureCollection<Point, LevelProps>> {
  const d: { stations: Record<string, [number, number]> } = await fetch(
    '/data/station-coords.json',
  ).then((r) => r.json())
  const coords = Object.values(d.stations)
  // floor で間引き間隔を決める（round だと 4,372/1,725≈2.53 が 3 に切り上がり 1,458 点＝目標の 85% しか
  // 残らない。floor なら step=2 で 2,186 点候補→slice で 1,725 ちょうど）。レビュー LOW2。
  const step = Math.max(1, Math.floor(coords.length / TARGET_POINTS))
  const sampled = coords.filter((_, i) => i % step === 0).slice(0, TARGET_POINTS)
  return {
    type: 'FeatureCollection',
    features: sampled.map(([lat, lon], i) => ({
      type: 'Feature',
      id: i,
      properties: { lvl: 0 },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    })),
  }
}

// 本番 kyoshin モード相当のベースマップ（陸地塗り＋細分区域境界＋県境）を MapLibre feature へ変換する。
// rings は [lat,lng] 順・GeoJSON は [lng,lat] 順のため入れ替える（main.ts と同じ）。BaseMap.tsx は各リングを
// 独立に塗る（穴処理なし）ため、ここでも各リングを 1 ポリゴン feature とする。
type Ringed = { rings: [number, number][][] }
async function loadBasemap(): Promise<{
  fill: FeatureCollection<Polygon>
  prefLines: FeatureCollection<LineString>
  subLines: FeatureCollection<LineString>
  vertexCount: number
}> {
  const [prefs, subs] = await Promise.all([
    fetch('/data/prefectures.json').then((r) => r.json() as Promise<Record<string, Ringed>>),
    fetch('/data/subregions.json').then((r) => r.json() as Promise<Ringed[]>),
  ])
  const fill: FeatureCollection<Polygon>['features'] = []
  const prefLines: FeatureCollection<LineString>['features'] = []
  const subLines: FeatureCollection<LineString>['features'] = []
  let v = 0
  for (const shape of Object.values(prefs)) {
    for (const ring of shape.rings) {
      const coords = ring.map(([lat, lng]) => [lng, lat] as [number, number])
      // 県境リングは fill と prefLines の両方で描画されるため、頂点は 2 回計上する（レビュー LOW3）。
      v += coords.length * 2
      fill.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [coords] },
      })
      prefLines.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      })
    }
  }
  for (const sr of subs) {
    for (const ring of sr.rings) {
      const coords = ring.map(([lat, lng]) => [lng, lat] as [number, number])
      v += coords.length
      subLines.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      })
    }
  }
  return {
    fill: { type: 'FeatureCollection', features: fill },
    prefLines: { type: 'FeatureCollection', features: prefLines },
    subLines: { type: 'FeatureCollection', features: subLines },
    vertexCount: v,
  }
}

// 毎秒の更新レベルを生成: 全点にランダムな lvl(0..9)＝「毎秒全点変化」の最悪ケース（上界）。
// WebGL は変化数に依らず全画面再描画になるため、最悪でも天井内なら現実（部分変化）は当然収まる。
function genLevels(n: number): Uint8Array {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i++) a[i] = (Math.random() * LEVELS) | 0
  return a
}

// feature-state 方式: 既に GPU に乗った頂点の状態(色)だけ更新。再タイル化は起きない。
function applyFeatureState(levels: Uint8Array): void {
  for (let i = 0; i < levels.length; i++) {
    map.setFeatureState({ source: 'points', id: i }, { lvl: levels[i] })
  }
}

// setData 方式: 保持している fc の properties.lvl を全点書き換えて丸ごと差し替える。
// geojson-vt が worker で再タイル化する（＝メインスレッド同期部分だけでは測れない実コストがある）。
function applySetData(levels: Uint8Array): void {
  const feats = fc.features
  for (let i = 0; i < levels.length; i++) feats[i].properties.lvl = levels[i]
  ;(map.getSource('points') as maplibregl.GeoJSONSource | undefined)?.setData(fc)
}

// baseline / feature-state phase の前に、直前 phase の状態を素の lvl:0 に戻す
function resetToBaseline(): void {
  map.removeFeatureState({ source: 'points' })
  const feats = fc.features
  for (let i = 0; i < feats.length; i++) feats[i].properties.lvl = 0
  ;(map.getSource('points') as maplibregl.GeoJSONSource | undefined)?.setData(fc)
}

// circle-color 式: feature-state.lvl 優先、無ければ properties.lvl、既定 0。
// これで baseline / feature-state / setData を同一レイヤーで測れる。
function buildColorExpr(): maplibregl.ExpressionSpecification {
  const matchArgs: (number | string)[] = []
  for (let i = 0; i < LEVELS - 1; i++) matchArgs.push(i, COLORS[i])
  return [
    'match',
    ['coalesce', ['feature-state', 'lvl'], ['get', 'lvl'], 0],
    ...matchArgs,
    COLORS[LEVELS - 1],
  ] as unknown as maplibregl.ExpressionSpecification
}

function updateStat(mode: string, extra = ''): void {
  const el = document.getElementById('stat')
  if (!el) return
  el.textContent = [
    `mode   : ${mode}`,
    `points : ${pointCount.toLocaleString()}`,
    `base   : ${basemapVertices.toLocaleString()} 頂点`,
    `zoom   : ${map.getZoom().toFixed(2)}`,
    `pixelR : ${map.getPixelRatio?.() ?? window.devicePixelRatio}  (device ${window.devicePixelRatio})`,
    extra,
  ]
    .filter(Boolean)
    .join('\n')
}

map.on('load', async () => {
  const [pts, base] = await Promise.all([loadPoints(), loadBasemap()])
  fc = pts
  pointCount = fc.features.length
  basemapVertices = base.vertexCount

  // 本番 kyoshin モード相当のベースマップ（観測点の背面）。毎秒の全画面再描画では、観測点だけでなく
  // この3層も丸ごと塗り直される＝現行の全画面再描画コストを再現する。
  map.addSource('land', { type: 'geojson', data: base.fill })
  map.addLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': LAND_FILL } })
  map.addSource('sub-lines', { type: 'geojson', data: base.subLines })
  map.addLayer({
    id: 'sub-borders',
    type: 'line',
    source: 'sub-lines',
    paint: { 'line-color': SUBREGION_BORDER, 'line-width': 0.5 },
  })
  map.addSource('pref-lines', { type: 'geojson', data: base.prefLines })
  map.addLayer({
    id: 'pref-borders',
    type: 'line',
    source: 'pref-lines',
    paint: { 'line-color': PREF_BORDER, 'line-width': 1 },
  })

  // 観測点（最前面）
  map.addSource('points', { type: 'geojson', data: fc })
  map.addLayer({
    id: 'points',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': BASE_RADIUS,
      'circle-color': buildColorExpr(),
      'circle-opacity': 0.85,
    },
  })

  ;(window as unknown as { __rtReady: boolean }).__rtReady = true
  updateStat('baseline')
})

map.on('zoomend', () => updateStat(currentMode))
map.on('error', (e) => {
  const el = document.getElementById('stat')
  if (el) el.textContent = 'ERROR: ' + (e.error?.message ?? String(e))
  console.error('[rt] map error', e.error)
})

// --- 手動確認用の毎秒更新トグル（本計測は __runRealtimeSuite が自動駆動する） ---
let currentMode: Mode = 'baseline'
let manualTimer: number | undefined

function startManual(mode: 'feature-state' | 'setData'): void {
  stopManual()
  currentMode = mode
  const apply = mode === 'feature-state' ? applyFeatureState : applySetData
  manualTimer = window.setInterval(() => {
    const lv = genLevels(pointCount)
    const t0 = performance.now()
    apply(lv)
    updateStat(mode, `applyMs: ${(performance.now() - t0).toFixed(1)}`)
  }, 1000)
  updateStat(mode)
}

function stopManual(): void {
  if (manualTimer != null) {
    clearInterval(manualTimer)
    manualTimer = undefined
  }
  currentMode = 'baseline'
  resetToBaseline()
  updateStat('baseline')
}

document.getElementById('fsBtn')?.addEventListener('click', () => startManual('feature-state'))
document.getElementById('sdBtn')?.addEventListener('click', () => startManual('setData'))
document.getElementById('stopBtn')?.addEventListener('click', () => stopManual())

// --- 計測ランナー（measure.ts の p95/longtask/report/warmup 手法を踏襲。駆動は毎秒更新） ---
function waitIdle(timeoutMs = 8000): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, timeoutMs)
    map.once('idle', () => {
      clearTimeout(t)
      res()
    })
  })
}

// 計測前のウォームアップ: 全整数ズームを踏んで初回タイル読み込み・geojson-vt 再タイル化を先に払う
// （初訪問ズームの交絡を除く。measure.ts と同じ・レビュー HIGH1 の教訓）。末尾は START_ZOOM に戻す。
async function warmup(): Promise<void> {
  for (const z of [4, 5, 6, 7, START_ZOOM]) {
    map.setZoom(z)
    await waitIdle(5000)
  }
}

const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)
function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, p50: null, p95: null, max: null, mean: null }
  const s = [...xs].sort((a, b) => a - b)
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
  return {
    n: s.length,
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(s[s.length - 1]),
    mean: round(xs.reduce((a, b) => a + b, 0) / xs.length),
  }
}

async function measureRealtime(mode: Mode, durationMs: number, label: string) {
  currentMode = mode
  map.setZoom(START_ZOOM)
  await waitIdle()
  // 前 phase の状態を素に戻してから測る（feature-state 残り・setData の色残りを排除）
  resetToBaseline()
  await waitIdle()

  // 更新起因フレームを名指しで測る（レビュー MEDIUM1 / HIGH6）。毎秒 1 回の更新は全フレームの
  // ~1.7%(実機60Hz) しか占めず p95(上位5%を切る)の外に埋もれるため、更新フレームを名指しで測る。
  // 計測用 rAF は再描画(render)より先に発火し、しかも render が乗るフレームは機種依存（feature-state は
  // 直後・setData は数フレーム後）なので、固定窓ではなく render イベント発火を起点にする（HIGH6/HIGH 統合）。
  // render 発火後の最初の rAF フレーム（＝再描画を含むフレーム）の dt を 1 サンプルとする。
  const frameDeltas: number[] = []
  const updateFrameMs: number[] = []
  let updateArmed = false // apply 直後、次の再描画フレームを待っている
  let updateRendered = false // その待機中に render が発火した
  // settle: apply→次の idle までの収束時間（HIGH7）。setData の再タイル化バーストを丸ごと含む。ただし
  // 収束が周期を超えると idle が発火せず沈黙するため（レビュー CRITICAL）、apply ごとに SETTLE_TIMEOUT_MS の
  // タイムアウトを競わせる。複数 apply が 1 回の idle に相乗りした場合は pendingApplies に溜まっている全 apply
  // をまとめて計上する（直近だけでなく全件・後続 apply による記録消失を防ぐ）。計測終了時点で未解決の apply は
  // 経過時間を下限値として打ち切り計上してから measuring=false にする（以降の遅延発火は measuring で無視）。
  const settleMs: number[] = []
  let settleTimeouts = 0
  const pendingApplies: number[] = [] // 未解決 apply の時刻を FIFO で保持し、全 apply を個別に解決する
  let measuring = true
  let last = performance.now()
  let rafId = requestAnimationFrame(function loop(t) {
    const dt = t - last
    frameDeltas.push(dt)
    if (updateArmed && updateRendered) {
      updateFrameMs.push(dt)
      updateArmed = false
      updateRendered = false
    }
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

  // 毎秒 1 回、更新を回す（baseline は駆動なし）。repaint-only は属性更新せず全画面再描画だけ要求し、
  // 再描画コスト単独を測る（feature-state − repaint-only ≒ 更新 CPU 分）。レビュー提案4。
  const applyMs: number[] = []
  let timer: number | undefined
  let onRender: (() => void) | undefined
  let onIdle: (() => void) | undefined
  if (mode !== 'baseline') {
    const apply =
      mode === 'feature-state' ? applyFeatureState : mode === 'setData' ? applySetData : null
    // render 発火を updateFrame の窓の起点にする（rAF ループが直後の再描画フレームを 1 つ記録する）
    onRender = () => {
      if (updateArmed) updateRendered = true
    }
    // idle は「その時点で未解決の apply が全部収束した」ことを意味するので、溜まっている全 apply を計上する。
    // 単一変数だと後続 apply に上書きされ、収束しない最悪ケースで記録が丸ごと消える（レビュー CRITICAL 再発）。
    onIdle = () => {
      if (!measuring || pendingApplies.length === 0) return
      const now = performance.now()
      for (const t of pendingApplies) settleMs.push(now - t)
      pendingApplies.length = 0
    }
    map.on('render', onRender)
    map.on('idle', onIdle)
    timer = window.setInterval(() => {
      let t0: number
      if (apply) {
        const lv = genLevels(pointCount) // 更新値生成は計測外（apply の同期コストだけを applyMs に入れる）
        t0 = performance.now()
        apply(lv)
      } else {
        t0 = performance.now()
        map.triggerRepaint() // repaint-only: 属性更新なしで全画面再描画だけ要求する
      }
      applyMs.push(performance.now() - t0)
      // 次の render 発火後の最初のフレームを再描画フレームとして 1 つ記録する（HIGH6/HIGH）
      updateArmed = true
      updateRendered = false
      // apply→idle の収束時間。全 apply を pendingApplies に積み idle でまとめて解決する。idle が来ないまま
      // SETTLE_TIMEOUT_MS 経った apply は個別に下限値で打ち切り settleTimeouts に数える＝収束しない最悪
      // ケースでも沈黙しない（レビュー CRITICAL）。単一変数だと後続 apply に上書きされ数え漏れるため配列で持つ。
      const tApply = performance.now()
      pendingApplies.push(tApply)
      window.setTimeout(() => {
        if (!measuring) return
        const idx = pendingApplies.indexOf(tApply)
        if (idx === -1) return // 既に idle 側で解決済み
        pendingApplies.splice(idx, 1)
        settleMs.push(SETTLE_TIMEOUT_MS)
        settleTimeouts++
      }, SETTLE_TIMEOUT_MS)
    }, 1000)
  }

  await new Promise((r) => setTimeout(r, durationMs))

  if (timer != null) clearInterval(timer)
  // 計測終了時点で未収束の apply は「収束せず打ち切り」として経過時間（下限）を計上し、全 apply を必ず
  // settle に残す（レビュー CRITICAL: 最悪ケースで settle が空・settleTimeouts=0 に化けるのを防ぐ）。
  const tEnd = performance.now()
  for (const t of pendingApplies) settleMs.push(tEnd - t)
  pendingApplies.length = 0
  measuring = false // 以降に遅延発火する idle/timeout は settleMs に入れない
  if (onRender) map.off('render', onRender)
  if (onIdle) map.off('idle', onIdle)
  cancelAnimationFrame(rafId)
  if (po) po.disconnect()

  frameDeltas.shift() // 開始タイミング依存のノイズを捨てる
  const frame = stats(frameDeltas)
  // 全 apply が idle / timeout / 打ち切りのいずれかで settle に記録されているはず（記録漏れの自己検知）
  console.assert(
    settleMs.length === applyMs.length,
    `settle 記録漏れ: settleMs=${settleMs.length} applyMs=${applyMs.length}`,
  )

  const result = {
    meta: {
      when: new Date().toISOString(),
      label,
      mode,
      durationMs,
      url: location.href,
      ua: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      points: pointCount,
      basemapVertices,
      canvasW: map.getCanvas().width,
      canvasH: map.getCanvas().height,
      jsHeapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ? Math.round(
            (performance as unknown as { memory: { usedJSHeapSize: number } }).memory
              .usedJSHeapSize / 1048576,
          )
        : null,
    },
    frame: {
      frames: frame.n,
      fps: round(frame.n / (durationMs / 1000)),
      p50: frame.p50,
      p95: frame.p95,
      max: frame.max,
    },
    // 【feature-state はこれで読む】更新起因フレームの所要時間分布（MEDIUM1 / HIGH6）。毎秒スパイクは
    // frame.p95 に埋もれるため、render 発火後の最初のフレーム（＝再描画を含むフレーム）を名指しで測る。
    // ※setData は再描画が worker 再タイル化で数百 ms のバーストになり 1 フレームに収まらないため settle で読む。
    updateFrame: mode === 'baseline' ? null : stats(updateFrameMs),
    // 【setData はこれで読む】apply→次の idle までの収束時間（HIGH7）。feature-state は render 1 回で
    // 収束し settle≈updateFrame、setData は再タイル化バーストを丸ごと含む。p95/max が周期(1000ms)を超えたら
    // 毎秒更新が収束しきらず地図が常時再描画状態＝素朴な setData は不可、と判定できる。settleTimeouts>0 は
    // SETTLE_TIMEOUT_MS 内に一度も収束しなかった回数＝さらに深刻（その回の settle 値は下限）。
    settle: mode === 'baseline' ? null : stats(settleMs),
    settleTimeouts: mode === 'baseline' ? null : settleTimeouts,
    // 更新処理そのものの所要時間（メインスレッド同期部分）。feature-state はこれが更新 CPU の実体。
    // setData は再タイル化が worker で非同期のため、この値は同期部分のみ＝実コストの下界（過小評価）。
    // repaint-only は triggerRepaint 要求コストのみ（ほぼ 0）。総合影響は updateFrame / settle / max / longTask で読む。
    apply: mode === 'baseline' ? null : stats(applyMs),
    longTask: {
      count: po ? longTasks.length : -1,
      totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
    },
  }

  resetToBaseline()
  currentMode = 'baseline'
  updateStat('baseline')

  try {
    const res = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(result) })
    console.log(
      `[rt] ${label} ${mode}: ${res.ok ? await res.text() : 'HTTP ' + res.status}`,
      result.frame,
      result.apply,
    )
  } catch (e) {
    console.warn('[rt] report 送信失敗（結果はログから回収可）:', e, result)
  }
  return result
}

const w = window as unknown as Record<string, unknown>

// 単発計測: await __measureRealtime({ mode:'setData', durationMs:12000, label:'adhoc' })
w.__measureRealtime = (opts: { mode?: Mode; durationMs?: number; label?: string } = {}) =>
  measureRealtime(opts.mode ?? 'feature-state', opts.durationMs ?? 12000, opts.label ?? 'adhoc')

// 反応表スイート: ウォームアップ → baseline / repaint-only / feature-state / setData を順に毎秒更新で測る。
// durationMs=12000 なら各 12 サンプルの updateFrame / applyMs が取れる。
w.__runRealtimeSuite = async (labelBase = 'realtime', durationMs = 12000) => {
  console.log('[rt] ウォームアップ（z4〜7 全整数・非計測）')
  await warmup()
  console.log(`[rt] suite 開始（device DPR ${window.devicePixelRatio}・各 ${durationMs}ms）`)
  await measureRealtime('baseline', durationMs, `${labelBase}-baseline`)
  await measureRealtime('repaint-only', durationMs, `${labelBase}-repaint`)
  await measureRealtime('feature-state', durationMs, `${labelBase}-fs`)
  await measureRealtime('setData', durationMs, `${labelBase}-setdata`)
  console.log('[rt] suite 完了')
}

// 更新処理単体ベンチ: 描画を挟まず apply を連続実行し、メインスレッド同期コストだけを測る。
// feature-state の 1,725 setFeatureState の純コスト確認用。setData は worker 再タイル化を含まない
// 下界である点に注意（真の総合影響は __runRealtimeSuite の frame/longTask で読む）。
w.__benchApply = (mode: 'feature-state' | 'setData' = 'feature-state', iters = 50) => {
  const apply = mode === 'feature-state' ? applyFeatureState : applySetData
  const ms: number[] = []
  for (let k = 0; k < iters; k++) {
    const lv = genLevels(pointCount)
    const t0 = performance.now()
    apply(lv)
    ms.push(performance.now() - t0)
  }
  resetToBaseline()
  const s = stats(ms)
  console.log(`[rt] benchApply ${mode} ×${iters}（同期・描画なし）:`, s)
  return s
}

// 計測スクリプトから触れるよう map と現在状態を露出する
Object.assign(w, {
  __rtMap: map,
  __rtGetMode: () => currentMode,
})
