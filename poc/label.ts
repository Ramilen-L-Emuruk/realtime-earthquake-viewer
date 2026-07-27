// 【PoC専用・使い捨て】§8「テキスト描画（ラベル・ツールチップ）」の検証。
//
// 計画書は「MapLibre で GPU 描画するには symbol レイヤー＋日本語グリフ（フォント PBF）の
// 自前生成・ホストが要る」と見積もっていたが、MapLibre 公式リポジトリの test/examples
// （Context7 で裏取り）には、style に `glyphs` を一切設定せず `text-font` に OS 標準の
// 日本語フォント名を並べるだけで日本語ラベルを描く実例がある
// （https://github.com/maplibre/maplibre-gl-js/blob/main/test/examples/style-labels-with-local-fonts.html
//   実際に「安曇野市」「松本市」という日本の地名で検証されている）。
// これが本当に効くか、本番のラベルデータ（地方9件・県47件・区域192件）と
// 震度ラベル（src/utils/intensity.ts の実表示文字列、"5弱"/"5強"等の漢字混じりを含む）で
// 実際に確認する。
//
// 本番（BaseMap.tsx）の排他表示条件を再現する:
//   zoom <  5.5              : ラベル非表示
//   5.5 <= zoom <  7.5        : 地方ラベル（9件）
//   7.5 <= zoom <  9          : 県名ラベル（47件）
//   zoom >= 9                 : 区域名ラベル（192件）
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Point } from 'geojson'
import { summarizeFrames } from './measure'

const JAPAN_CENTER: [number, number] = [137.7, 38.25]
// JapanMap.tsx の JAPAN_BOUNDS（[lat,lng]）を [lng,lat] へ変換した値。計測時に日本全体を
// 視野に収めたまま固定するために使う（レビュー HIGH: ズームで視野を切り替える方式は
// 対象点が画面外に出て狙った文字種が一度も描画されない事故を起こした）。
const JAPAN_BOUNDS_LNGLAT: [[number, number], [number, number]] = [
  [129.43, 30.99],
  [145.82, 45.52],
]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'

// BaseMap.tsx の LABEL_MIN_ZOOM/REGION_MAX_ZOOM/CITY_LABEL_MIN_ZOOM をそのまま踏襲
const LABEL_MIN_ZOOM = 5.5
const REGION_MAX_ZOOM = 7.5
const CITY_LABEL_MIN_ZOOM = 9

// glyphs は意図的に設定しない（本 PoC の検証対象そのもの）。text-font に日本語フォントを
// 並べ、ローカル表意文字レンダリングだけで描けるかを見る。Windows(実機 Surface Go 2)を
// 主対象に、代表的な和文フォント名を優先度順で並べる。
const JP_TEXT_FONT = ['Yu Gothic UI', 'Meiryo', 'MS Gothic', 'Noto Sans CJK JP']

const REGIONS: { name: string; lat: number; lng: number }[] = [
  { name: '北海道', lat: 43.4, lng: 142.8 },
  { name: '東北', lat: 39.6, lng: 140.6 },
  { name: '関東', lat: 36.1, lng: 139.7 },
  { name: '中部', lat: 36.2, lng: 137.6 },
  { name: '近畿', lat: 34.5, lng: 135.8 },
  { name: '中国', lat: 34.9, lng: 132.6 },
  { name: '四国', lat: 33.6, lng: 133.5 },
  { name: '九州', lat: 32.3, lng: 130.9 },
  { name: '沖縄', lat: 26.5, lng: 128.0 },
]

type PrefShape = { label: [number, number]; dir: string; rings: [number, number][][] }
type SubRegion = { name: string; label: [number, number]; rings: [number, number][][] }

function pointFC(features: { name: string; lat: number; lng: number }[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      properties: { name: f.name },
      geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
    })),
  }
}

async function loadPrefectures(): Promise<FeatureCollection<Point>> {
  const prefs: Record<string, PrefShape> = await fetch('/data/prefectures.json').then((r) => r.json())
  return pointFC(
    Object.entries(prefs).map(([name, shape]) => ({ name, lat: shape.label[0], lng: shape.label[1] })),
  )
}

async function loadSubregions(): Promise<FeatureCollection<Point>> {
  const subs: SubRegion[] = await fetch('/data/subregions.json').then((r) => r.json())
  return pointFC(subs.map((s) => ({ name: s.name, lat: s.label[0], lng: s.label[1] })))
}

// 震度ラベルの描画確認用。区域ラベルの一部座標を間引いて流用し、実際に画面へ表示される
// 震度ラベル文字列（src/utils/intensity.ts の INTENSITY_LABELS）をそのまま巡回して割り当てる。
// "5弱"/"5強"/"6弱"/"6強" のような漢字混じり2文字を含む点が重要（本番 JapanMap.tsx:95 の
// `label.length > 1 ? size*0.42 : size*0.6` という、2文字ラベルだけ縮小する分岐が実在し、
// 「小さいフォントサイズでの漢字グリフ描画」が本 PoC で確認すべき具体的な組み合わせのため。
// レビュー指摘: 当初 ASCII 記号 "5-"/"5+" 等で代替していたが、本番はこの表記を画面に一切
// 出さない（電文パース時の内部コードに過ぎない）ため、実表示文字列に差し替えた。
const INTENSITY_LABELS = ['1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7']
// 区域ラベルと同一座標に重ねると、どちらの文字が描画されたか判別しづらくなるため
// （レビュー指摘）、緯度方向にわずかにオフセットする。
const INTENSITY_LABEL_OFFSET_LAT = 0.08
function intensityFC(subregionPoints: FeatureCollection<Point>): FeatureCollection<Point> {
  const step = Math.max(1, Math.floor(subregionPoints.features.length / 40))
  const sampled = subregionPoints.features.filter((_, i) => i % step === 0)
  return {
    type: 'FeatureCollection',
    features: sampled.map((f, i) => ({
      type: 'Feature',
      properties: { label: INTENSITY_LABELS[i % INTENSITY_LABELS.length] },
      geometry: {
        type: 'Point',
        coordinates: [f.geometry.coordinates[0], f.geometry.coordinates[1] + INTENSITY_LABEL_OFFSET_LAT],
      },
    })),
  }
}

function updateStat(text: string): void {
  const el = document.getElementById('stat')
  if (el) el.textContent = text
}

const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN_CENTER,
  zoom: 6,
  attributionControl: false,
  // glyphs キー自体を持たせない構成（Context7 で確認した公式サンプルと同じ）。
  style: {
    version: 8,
    sources: {
      gebco: { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256, maxzoom: 10 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
      { id: 'gebco', type: 'raster', source: 'gebco' },
    ],
  },
})

map.on('load', async () => {
  const [prefFC, subFC] = await Promise.all([loadPrefectures(), loadSubregions()])
  const regionFC = pointFC(REGIONS)
  const intensityFCData = intensityFC(subFC)

  map.addSource('regions', { type: 'geojson', data: regionFC })
  map.addSource('prefectures', { type: 'geojson', data: prefFC })
  map.addSource('subregions', { type: 'geojson', data: subFC })
  map.addSource('intensity', { type: 'geojson', data: intensityFCData })

  // 地方ラベル: LABEL_MIN_ZOOM <= zoom < REGION_MAX_ZOOM
  map.addLayer({
    id: 'regions-label',
    type: 'symbol',
    source: 'regions',
    minzoom: LABEL_MIN_ZOOM,
    maxzoom: REGION_MAX_ZOOM,
    layout: { 'text-field': ['get', 'name'], 'text-font': JP_TEXT_FONT, 'text-size': 18 },
    // 本番(index.css)は text-shadow を3枚重ねたソフトなグローで縁取る。MapLibre の
    // text-halo-width はハードエッジのため、幅を絞り halo-blur でぼかして近づける
    // （幅を太いままにするとハローだけが目立ち文字が読みにくくなる。ユーザー指摘で調整）。
    paint: {
      'text-color': '#e5e7eb',
      'text-halo-color': '#0a0c10',
      'text-halo-width': 0.8,
      'text-halo-blur': 0.5,
    },
  })

  // 県名ラベル: REGION_MAX_ZOOM <= zoom < CITY_LABEL_MIN_ZOOM
  map.addLayer({
    id: 'prefectures-label',
    type: 'symbol',
    source: 'prefectures',
    minzoom: REGION_MAX_ZOOM,
    maxzoom: CITY_LABEL_MIN_ZOOM,
    layout: { 'text-field': ['get', 'name'], 'text-font': JP_TEXT_FONT, 'text-size': 14 },
    paint: {
      'text-color': '#e5e7eb',
      'text-halo-color': '#0a0c10',
      'text-halo-width': 0.7,
      'text-halo-blur': 0.5,
    },
  })

  // 区域名ラベル: zoom >= CITY_LABEL_MIN_ZOOM
  map.addLayer({
    id: 'subregions-label',
    type: 'symbol',
    source: 'subregions',
    minzoom: CITY_LABEL_MIN_ZOOM,
    layout: { 'text-field': ['get', 'name'], 'text-font': JP_TEXT_FONT, 'text-size': 12 },
    paint: {
      'text-color': '#e5e7eb',
      'text-halo-color': '#0a0c10',
      'text-halo-width': 0.6,
      'text-halo-blur': 0.4,
    },
  })

  // 震度ラベル: 文字描画そのものの確認用（本番はズーム非依存で地震発生時のみ表示されるが、
  // PoC では表示条件を分離して確認しやすくする）。
  // 本番(JapanMap.tsx:95) は `label.length > 1 ? size*0.42 : size*0.6` と2文字ラベル
  // （"5弱"等）だけ縮小するため、同じ分岐を text-size の data-driven expression で再現する。
  // 初期状態は非表示（レビュー HIGH: 以前は常時表示にしていたため、__runLabelZoomSuite
  // 実行前の load 時点で既にグリフが生成されてしまい、intensity 計測値が「suite開始前に
  // 済んでいた」というアーティファクトになっていた）。目視確認は下の「震度ラベル表示」
  // ボタンで手動トグルする。
  map.addLayer({
    id: 'intensity-label',
    type: 'symbol',
    source: 'intensity',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': JP_TEXT_FONT,
      'text-size': ['case', ['>', ['length', ['get', 'label']], 1], 9, 13],
      'text-allow-overlap': true,
      visibility: 'none',
    },
    paint: {
      'text-color': '#fbbf24',
      'text-halo-color': '#000000',
      'text-halo-width': 0.6,
      'text-halo-blur': 0.3,
    },
  })

  Object.assign(window as unknown as Record<string, unknown>, { __pocReady: true })
  updateStat(`zoom: ${map.getZoom().toFixed(2)}\n地方${regionFC.features.length}/県${prefFC.features.length}/区域${subFC.features.length}件\n震度ラベル${intensityFCData.features.length}件（初期非表示・ボタンで表示切替）`)
})

map.on('zoomend', () => {
  updateStat(
    document.getElementById('stat')!.textContent!.replace(/zoom: [\d.]+/, `zoom: ${map.getZoom().toFixed(2)}`),
  )
})

map.on('error', (e) => {
  updateStat('ERROR: ' + (e.error?.message ?? String(e)))
  console.error('[label] map error', e.error)
})

const zoomButtons: Record<string, number> = { z5: 5, z6: 6, z8: 8, z11: 11 }
for (const [id, z] of Object.entries(zoomButtons)) {
  document.getElementById(id)?.addEventListener('click', () => map.setZoom(z))
}

// 震度ラベルは初期非表示のため（上記コメント参照）、目視確認用の手動トグルを用意する。
document.getElementById('toggleIntensity')?.addEventListener('click', () => {
  const current = map.getLayoutProperty('intensity-label', 'visibility') ?? 'visible'
  map.setLayoutProperty('intensity-label', 'visibility', current === 'none' ? 'visible' : 'none')
})

// レビュー MEDIUM3→HIGH（再指摘）: glyphs 無しは「サーバー生成PBFが無いぶん、ASCII数字も
// 含め全文字をクライアント側で TinySDF ラスタライズする」ことを意味する（追認1: !this.url
// 分岐）。「描ける」ことは確認済みだが「安い」かは未確認だったため、当初はズーム帯を
// またいで新しい文字種が初出現する際の longtask を計測する方式にした。
// **しかしこれは失敗だった**（レビューが独立検証で発見）: ズームインすると視野が狭まり
// 対象点が画面外に出るため、県47件・区域192件のラベルは一度も描画されず、
// `map.style.glyphManager.entries` を直接観測しても全ズーム帯でグリフ生成数が
// 40種のまま不変（＝地方9件と震度ラベルの初期表示ぶんだけ）だった。「longtask 0」は
// 「安い」ではなく「ほとんど何も生成していない」ことの誤読だった。
// 対処: 日本全体が映るビューを固定したまま、各レイヤーの minzoom/maxzoom 制約を
// setLayerZoomRange で計測時だけ外し、visibility の出し入れだけでレイヤーを順に出す。
// 結果には renderedSymbols（実描画数）・glyphsGenerated（累積グリフ生成数）を含め、
// 「longtaskが0＝安い」なのか「何も生成していない」なのかを後から判別できるようにする
// （LOWで tracked フラグに入れたのと同じ処方箋）。
const LABEL_LAYER_IDS = ['regions-label', 'prefectures-label', 'subregions-label', 'intensity-label'] as const

// map.style.glyphManager は公開型（maplibre-gl.d.ts の Style クラス定義）にそのまま乗るため
// キャスト不要（セルフレビュー指摘: 当初 `as unknown as {...}` していたが、将来 MapLibre が
// この内部構造を変えた際に「コンパイルエラーで気づける」利点を自ら手放し「黙って0を返す」
// 方向に倒すのは、本PoCが問題視した「longtask 0＝生成していないことの誤読」と同じ失敗の
// 再生産になるため、素の型のまま使う）。
function totalGlyphsGenerated(): number {
  const entries = map.style.glyphManager.entries
  let total = 0
  for (const stack of Object.keys(entries)) {
    total += Object.keys(entries[stack].glyphs).length
  }
  return total
}

interface LabelRenderResult {
  label: string
  // 実描画数（queryRenderedFeatures 実測）。ソース内フィーチャ数より少なく出ることがある
  // （text-allow-overlap 既定 false の3レイヤーは、日本全体を視野に収めた低ズームで多数の
  // 点が密集し衝突判定で間引かれるため。正常な挙動であり生成失敗ではない）。
  // 「狙った文字種を実際に生成したか」は glyphsGenerated で、「その生成が何ms掛かるか」は
  // blockMaxMs（下記）で読む。
  renderedSymbols: number
  glyphsGenerated: number
  // 【主指標】グリフ生成に伴うメインスレッドの最長連続ブロック時間（ms）。MessageChannel の
  // ping-pong で計測し、vsync に量子化されないためリフレッシュレート非依存で生成コストを
  // 捉える。実測（Intel Iris Xe・60Hz 開発機・headed）: 区域192件＝196グリフの初回生成で
  // 3回とも blockMaxMs≈20ms（2番手≈16ms）、cached 再表示・生成0の対照では≈6ms。
  // σ~0.5ms で再現性が高い（＝「開発機では検出できない」は誤りだった。計測器の問題）。
  blockMaxMs: number
  // 上位3ブロック。生成は MapLibre が複数チャンクに分割するため（最長≈20ms＋次点≈16ms 等）、
  // 単一の最大値だけでなく分割の様子も残す。
  blockTop3Ms: number[]
  // idle までの所要時間。レビュー指摘（新規HIGH）: グリフ生成コストの指標として無情報
  // だった（生成量が region+2→subregion+125と60倍以上変わっても elapsedMs の差は0.7ms・
  // 約612msで一定）。参考値として残す。
  elapsedMs: number
  // rAF フレーム間隔の要約（p50/p95/max）。【注意・副指標】vsync に量子化されるため計測器
  // としては鈍い。60Hz（budget 16.7ms）では最長≈20ms の生成ブロックが budget を僅かに
  // 超えるだけで、vsync 位相との整列次第で 17ms に吸収されたり 33/50ms に跳ねたりする
  // （＝frame.max は 60Hz では生成コストの有無を安定判定できない）。生成コストは blockMaxMs
  // を見ること。高リフレッシュ機（例: 6.1ms/164Hz のレビュー機）では 20ms ブロックが明確に
  // 浮くため frame.max でも検出できる（レビュー実測 subregions 35.3ms・再現性 0.2ms）。
  frame: ReturnType<typeof summarizeFrames>
  longTaskCount: number
  longTaskTotalMs: number
  longTaskMaxMs: number
}

// 対象レイヤーだけ visibility:visible にし、他は none にして描画・グリフ生成コストを計測する。
//
// 計測は2系統を並行して回す:
//   ① MessageChannel ブロック検出器（主指標 blockMaxMs/blockTop3Ms）— visibility 切替の
//      直前に開始し、生成に伴うメインスレッドの連続ブロックを vsync 非依存で捉える。
//   ② rAF フレーム間隔（副指標 frame）— vsync に量子化されるため 60Hz 開発機では鈍い
//      （LabelRenderResult.frame のコメント参照）。参考・高リフレッシュ機向けに残す。
//
// 【過去の誤り・訂正済み】以前ここに「rAFループ開始→visibility切替 の順だと生成コストが
// frame.max に現れず、順序を逆にすると 49.9ms のスパイクを複数回再現できる」と書いていたが、
// これは誤りだった。①のブロック検出器で測ると、順序に関わらず生成ブロックは常に blockMaxMs
// ≈20ms で再現性高く存在する（3回試行 σ~0.5ms）。順序を変えて rAF で「49.9ms が出たり
// 出なかったり」したのは、20ms 級のブロックが 16.7ms の frame budget を僅かに超えるだけで
// vsync 位相との整列に依存する量子化アーティファクトであり、順序が検出可否を決めていた
// わけではなかった。visibility を先に設定するのは「計測窓の中で生成を起こす」ための自然な
// 順序として残すが、検出の決め手ではない。
function measureLabelLayer(layerId: string, label: string): Promise<LabelRenderResult> {
  const frameDeltas: number[] = []
  const longTasks: number[] = []
  const blockGaps: number[] = []
  let po: PerformanceObserver | null = null
  try {
    po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push(e.duration)
    })
    po.observe({ type: 'longtask' })
  } catch {
    po = null
  }
  // 主指標: メインスレッド連続ブロック検出。MessageChannel の ping-pong はアイドル時
  // サブマイクロ秒で往復するため、往復間隔がそのまま「連続ブロックされた時間」になる。
  // アイドル時の膨大なサブms往復は捨て、3ms 超のブロックだけ記録する（描画5〜6ms・
  // 生成20ms級を漏らさず、配列を小さく保つ）。
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
  const t0 = performance.now()
  return new Promise((res) => {
    lastPing = performance.now()
    mc.port2.postMessage(0) // visibility 切替の直前にブロック検出を開始（生成を取りこぼさない）
    for (const id of LABEL_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', id === layerId ? 'visible' : 'none')
    }
    let last = performance.now()
    let rafId = requestAnimationFrame(function loop(t) {
      frameDeltas.push(t - last)
      last = t
      rafId = requestAnimationFrame(loop)
    })
    const timeout = setTimeout(finish, 8000)
    function finish() {
      clearTimeout(timeout)
      map.off('idle', finish)
      cancelAnimationFrame(rafId)
      blockRunning = false
      if (po) po.disconnect()
      const elapsedMs = performance.now() - t0
      const round = (v: number) => Math.round(v * 10) / 10
      const sortedBlocks = blockGaps.slice().sort((a, b) => b - a)
      const result: LabelRenderResult = {
        label,
        renderedSymbols: map.queryRenderedFeatures({ layers: [layerId] }).length,
        glyphsGenerated: totalGlyphsGenerated(),
        blockMaxMs: round(sortedBlocks[0] ?? 0),
        blockTop3Ms: sortedBlocks.slice(0, 3).map(round),
        elapsedMs: round(elapsedMs),
        frame: summarizeFrames(frameDeltas, elapsedMs),
        longTaskCount: po ? longTasks.length : -1,
        longTaskTotalMs: round(longTasks.reduce((a, b) => a + b, 0)),
        longTaskMaxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
      }
      console.log(`[label] ${label}`, result)
      res(result)
    }
    map.once('idle', finish)
  })
}

function waitIdle(timeoutMs: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, timeoutMs)
    map.once('idle', () => {
      clearTimeout(t)
      res()
    })
  })
}

// await __runLabelZoomSuite() で 日本全体を視野に固定したまま regions→prefectures→
// subregions→intensity の順にレイヤーを1つずつ表示させ、各段の実描画数・グリフ生成コストを
// 計測する。計測後は本番相当のズーム連動表示に戻す。
//
// 【重要】ページをリロードしてから1回だけ実行すること。glyphManager のグリフキャッシュは
// ページを閉じるまで消えないため、2回目以降の実行では glyphsGenerated が全段で最終値の
// まま変化しない（=既に生成済みのグリフを再描画するだけになり、生成コストの計測が無効化
// される。動作確認中に実際に踏んだ）。
//
// 【計測器の選択】グリフ生成コストは blockMaxMs（MessageChannel ブロック検出器）で読む。
// frame.max（rAFフレーム時間）は vsync に量子化されるため計測環境のリフレッシュレートに
// 左右される: この開発機は headed だが物理モニタが 60Hz（vsync 16.7ms・実測）で、最長20ms
// 級の生成ブロックが frame budget を僅かに超えるだけのため frame.max では安定検出できない
// （＝過去に「開発機では検出できない・実機を待つしかない」と書いたのは誤り。計測器を
// blockMaxMs に替えれば 60Hz 開発機でも σ~0.5ms で検出できる）。レビュー機は同じく headed
// だが高リフレッシュ（6.1ms/≒164Hz）のため 20ms ブロックが frame.max でも明確に浮いた
// （subregions 35.3ms）。両者の観測差は headed/headless でも Playwright/実Chrome でもなく、
// 物理モニタのリフレッシュレート差にすぎない。実機（Surface Go 2）計測の価値は「開発機で
// 測れないから」ではなく「非力機での生成コスト絶対値を知るため」（blockMaxMs が 2〜3倍に
// 伸びれば longtask 閾値 50ms に達しうる）。
async function runLabelZoomSuite(): Promise<LabelRenderResult[]> {
  map.fitBounds(JAPAN_BOUNDS_LNGLAT, { padding: 20, duration: 0 })
  for (const id of LABEL_LAYER_IDS) {
    if (id !== 'intensity-label') map.setLayerZoomRange(id, 0, 24)
    map.setLayoutProperty(id, 'visibility', 'none')
  }
  await waitIdle(3000)

  const results: LabelRenderResult[] = []
  results.push(await measureLabelLayer('regions-label', 'regions(地方9件)'))
  results.push(await measureLabelLayer('prefectures-label', 'prefectures(県47件)'))
  results.push(await measureLabelLayer('subregions-label', 'subregions(区域192件・最多ユニーク漢字)'))
  results.push(await measureLabelLayer('intensity-label', 'intensity(震度ラベル)'))

  // 本番相当のズーム連動表示に戻す。center も明示的に復元する（fitBounds が動かした ままだと
  // 偶然 JAPAN_CENTER に近い値になるだけで、意図した復元ではなかったためレビュー指摘で修正）。
  map.setLayerZoomRange('regions-label', LABEL_MIN_ZOOM, REGION_MAX_ZOOM)
  map.setLayerZoomRange('prefectures-label', REGION_MAX_ZOOM, CITY_LABEL_MIN_ZOOM)
  map.setLayerZoomRange('subregions-label', CITY_LABEL_MIN_ZOOM, 24)
  for (const id of LABEL_LAYER_IDS) map.setLayoutProperty(id, 'visibility', 'visible')
  map.jumpTo({ center: JAPAN_CENTER, zoom: 6 })

  return results
}

// Playwright からの確認用: レイヤーの可視状態・キャンバスのピクセル抽出は
// map.queryRenderedFeatures や map.getCanvas() を直接使えるため、追加の露出は最小限にする。
Object.assign(window as unknown as Record<string, unknown>, {
  __labelMap: map,
  __runLabelZoomSuite: runLabelZoomSuite,
})
