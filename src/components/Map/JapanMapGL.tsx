import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
// maplibre-gl.css は main.tsx が index.css より前に読む（カスケード順を固定するため。詳細は main.tsx）。
// ?worker&url でワーカーとその依存（maplibre-gl-shared.mjs）を1ファイルにバンドルし URL を得る。
// 単なる ?url だとワーカー単体しかコピーされず、ワーカー内の `import './maplibre-gl-shared.mjs'` が
// 本番で 404 になり geojson タイル化が動かない（境界・区域が描画されない）。
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { MapGLContext } from './mapGLContext'
import { BaseMapGL } from './BaseMapGL'
import { LabelsGL } from './LabelsGL'
import { KyoshinSubThresholdGL } from './KyoshinSubThresholdGL'
import { KyoshinPointsGL } from './KyoshinPointsGL'
import { KyoshinDetectedPointsGL } from './KyoshinDetectedPointsGL'
import { KyoshinMaxEffectGL } from './KyoshinMaxEffectGL'
import { ActiveFaultsGL } from './ActiveFaultsGL'
import { PlateBoundariesGL } from './PlateBoundariesGL'
import { DayNightGL } from './DayNightGL'
import { QuakeIntensityPointsGL } from './QuakeIntensityPointsGL'
import { QuakeIntensitySurfaceGL } from './QuakeIntensitySurfaceGL'
import { QuakeRegionFillGL } from './QuakeRegionFillGL'
import { QuakeHeatmapGL } from './QuakeHeatmapGL'
import { HypocenterDepthGL } from './HypocenterDepthGL'
import { HypocenterCatalogGL } from './HypocenterCatalogGL'
import { LpgmPointsGL } from './LpgmPointsGL'
import { LpgmRegionFillGL } from './LpgmRegionFillGL'
import { TsunamiLinesGL } from './TsunamiLinesGL'
import { TsunamiObsBarsGL } from './TsunamiObsBarsGL'
import { TsunamiArrivalMarkersGL } from './TsunamiArrivalMarkersGL'
import { EewRegionFillGL } from './EewRegionFillGL'
import { EewLpgmRegionFillGL } from './EewLpgmRegionFillGL'
import { EewEpicentersGL } from './EewEpicentersGL'
import { PsWaveGL } from './PsWaveGL'
import {
  QuakeFitGL,
  FitJapanOnEnterGL,
  FitToDetectionGL,
  FitToCandidateGL,
  FitToEEWGL,
  TsunamiFitGL,
  FocusObsGL,
} from './CameraFollowsGL'
import { JAPAN_CENTER, fitJapan, fitMaxZoom, REFERENCE_FIT_MAX_ZOOM } from './gl/camera'
import { useActiveFaults } from '../../hooks/useActiveFaults'
import { usePlateBoundaries } from '../../hooks/usePlateBoundaries'
import { useQuakeLayerData } from '../../hooks/useQuakeLayerData'
import { useTsunamiLayerData } from '../../hooks/useTsunamiLayerData'
import { useEewLayerData } from '../../hooks/useEewLayerData'
import type { JapanMapProps, MapHandle } from './mapTypes'
import { drawTsunamiObsBars } from './gl/tsunamiObsBar'
import { drawTsunamiArrivalMarkers } from './gl/tsunamiArrivalMarker'
import { kyoshinIndexToJma } from '../../utils/kyoshinIntensity'
import { log } from '../../utils/logger'
import { beginSpan, noteEvent } from '../../utils/frameProfiler'
import { serverNow } from '../../utils/clock'
import { syncEewFirstSeen } from './gl/eewFirstSeen'
import { applyFrontSortKeys, bearingChangedEnough } from './gl/screenDepth'
import { installNoopCameraUpdateSkip } from './gl/skipNoopCameraUpdate'

// MapLibre GL JS 版の地図コンポーネント（Leaflet 版 JapanMap と同一 Props）。
// MapLibre 移行計画 docs/webgl-migration-implementation-plan.md のフェーズ順に、
// このコンポーネントへレイヤーを積み増していく。F0 は空地図の骨格のみ
// （背景色＋日本中心・map インスタンスを Context 提供）。以降のレイヤーは
// 子コンポーネントが useMapGL() で map を購読して描画する。
//
// maplibre-gl 6 は default export を持たないため `import * as maplibregl`。
//
// バンドラ（Vite/rollup）利用時は MapLibre GL JS v6 のワーカー URL を明示設定する必要がある
// （v5→v6 移行ガイド: バンドラのモジュールグラフは worker ファイルパスを確実に解決できないため
// setWorkerUrl() の一度きりの呼び出しが必須）。これを怠ると本番ビルドで GeoJSON ワーカーが解決できず、
// 全 geojson ソースがタイル化されない＝ラスタ背景だけ描画され境界・区域・震度点等のベクタが一切出ない。
// dev では未バンドルで自動解決されるため顕在化せず、本番のみで壊れる。モジュール読込時に一度だけ実行する。
maplibregl.setWorkerUrl(maplibreWorkerUrl)

// 初期ズーム（load 後に fitJapan で日本全体フレーミングへ合わせるため暫定値）。
const INITIAL_ZOOM = 5

export function JapanMapGL({
  mode,
  quake,
  lpgm,
  tsunamis = [],
  observations = [],
  obsUpdateStatus,
  eews = [],
  eewLpgmEventId = null,
  kyoshinPsWave = [],
  focusObsName = null,
  heatPoints,
  showBathymetry = true,
  kyoshinSites = [],
  kyoshinIndices = [],
  kyoshinStale,
  kyoshinSubIndices,
  detectedPoints = [],
  detectedMarkerPoints = [],
  candidatePoints = [],
  unconfirmedPoints = [],
  candidateId = null,
  shakeFocus = null,
  iconScale = 1,
  hypocenterDepthScale = 1,
  catalogCloud = null,
  showActiveFaults = true,
  activeFaultOpacity = 0.4,
  showPlateBoundaries = true,
  showDayNight = true,
  dayNightOpacity = 0.5,
  quakeSelectionTick = 0,
  onMapReady,
}: JapanMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  // 地図の生成 effect は依存配列が空（地図は 1 度だけ作る）。コールバックを直接読むと、
  // 親が別の関数を渡してきたときに古い参照を掴んだままになるため ref 越しに呼ぶ。
  const onMapReadyRef = useRef(onMapReady)
  useEffect(() => {
    onMapReadyRef.current = onMapReady
  }, [onMapReady])
  // 集約切替（zoom <= 寄り上限 で一次細分区域集約）判定のため現在ズームを追跡する。
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  // 集約切替の閾値。カメラの寄り上限と同値にすることで「自動フィット着地後は必ず区域集約＝震度塗り」
  // が成り立つ（useQuakeLayerData の aggregateMaxZoom の注記）。寄り上限は地図ペインの短辺で決まるため
  // 定数にできず、ペインが変わるたび取り直す必要がある（パネル境界のつまみ・画面回転・リサイズ）。
  // 地図の生成前は基準ペインの値を置く。
  const [aggregateMaxZoom, setAggregateMaxZoom] = useState(REFERENCE_FIT_MAX_ZOOM)
  // QuakeFitGL が「最後に処理した quakeSelectionTick の値」を保持する ref。
  // ここ（JapanMapGL は常時マウント）で保有し、QuakeFitGL に props で渡すことで
  // タブ切替による QuakeFitGL のリマウントをまたいでも「明示選択で tick が進んだ最初の
  // フィットだけ explicit=true」という判定を保つ（QuakeFitGL 内で useRef すると
  // リマウントのたびに初期値へリセットされ、タブ復帰のたびに強制フィットが走る不具合が
  // 出る。CameraFollowsGL.tsx の QuakeFitGL コメント参照）。
  const lastConsumedQuakeTickRef = useRef<number>(0)
  // FitToEEWGL が「新規発報」と「発報中の EEW のところへ入室した」を見分けるための 2 つの ref。
  // FitToEEWGL は kyoshin モード限定マウントなので、内部で持つとタブ復帰のたびに初期化され、
  // 入室しただけで新規発報として震源へ寄ってしまう（上の lastConsumedQuakeTickRef と同じ構図）。
  // eewFirstSeenAtRef: eventId → その EEW を初めて見た時刻（serverNow）。全モードで記録するため、
  //   他タブに居る間に届いた EEW でも初出時刻が残る。
  // focusedEewIdRef: 第一報のフォーカスを与え終えた EEW の eventId。
  const eewFirstSeenAtRef = useRef<Map<string, number>>(new Map())
  const focusedEewIdRef = useRef<string | null>(null)
  // FitToDetectionGL が最後に消費した ShakeFocus の連番。**ここで保有するのが要点**——
  // FitToDetectionGL は kyoshin モード限定マウントなので、内部に持つとタブを離れるたびに
  // 初期値へリセットされ、直前に見せたばかりの要求を「まだ消費していない」と読んで同じ点へ
  // 寄り直してしまう（鮮度の窓 5 秒に入っていれば通る）。上の 2 つと同じ構図。
  const lastConsumedShakeFocusTickRef = useRef<number>(0)
  // 記録・掃除の中身は純関数（gl/eewFirstSeen.ts）。消滅と再出現の境界がバグを生みやすいので、
  // そこだけ切り出してテストで固定している。
  useEffect(() => {
    syncEewFirstSeen(eewFirstSeenAtRef.current, focusedEewIdRef, eews, serverNow())
  }, [eews])
  const activeFaults = useActiveFaults()
  const plateBoundaries = usePlateBoundaries()
  // 活断層・プレート境界は地震／リアルタイム震度／震源カタログモードで表示する。
  // **カタログを足したのは、深さを持つ点群を読むのに沈み込み帯の位置が要るため**
  //（点群だけ見ても、その並びがプレートの沈み込みだと判らない）。
  const showOverlayLines = mode === 'quake' || mode === 'kyoshin' || mode === 'catalog'
  // 地震モードの派生データ（震度点／区域集約／震源）。Leaflet 版と共有の導出フック。
  const {
    stationMarkers,
    aggregateByRegion,
    regionAggregates,
    hasEpicenter,
    epicenter,
    prefIntensities,
    lpgmActive,
    lpgmMarkers,
    lpgmRegionAggregates,
    quakeFitPositions,
    quakeSignature,
  } = useQuakeLayerData(mode, quake, { zoom, aggregateMaxZoom }, lpgm)
  // 津波の派生データ（海岸線＋観測棒＋到達確認マーカー）。発報中は全モードで海岸線を描くため常時計算する。
  const { tsunamiLines, observationBars, arrivalMarkers, tsunamiFitPositions, tsunamiSignature } = useTsunamiLayerData(
    tsunamis,
    observations,
    obsUpdateStatus,
  )
  // 観測行クリックで寄せられる点。**カードに出ている観測点をすべて含める**こと——
  // 実測（観測棒）だけにすると、到達確認の行をクリックしても地図が動かない。
  const focusablePoints = useMemo(
    () => [
      ...observationBars.map((b) => ({ name: b.name, lat: b.lat, lng: b.lng })),
      ...arrivalMarkers.map((m) => ({ name: m.name, lat: m.lat, lng: m.lng })),
    ],
    [observationBars, arrivalMarkers],
  )
  // 撮影した画像へ描き足すもの。いまは津波の観測棒と到達確認マーカーで、どちらも DOM マーカーの
  // ため WebGL のキャンバスに写らない（gl/tsunamiObsBar.ts・gl/tsunamiArrivalMarker.ts）。
  // 表示条件は下の TsunamiObsBarsGL / TsunamiArrivalMarkersGL のマウント条件と揃える。
  const extrasRef = useRef<{
    bars: typeof observationBars
    arrivals: typeof arrivalMarkers
    iconScale: number
    showBars: boolean
  }>({
    bars: [],
    arrivals: [],
    iconScale: 1,
    showBars: false,
  })
  useEffect(() => {
    extrasRef.current = { bars: observationBars, arrivals: arrivalMarkers, iconScale, showBars: mode === 'tsunami' }
  }, [observationBars, arrivalMarkers, iconScale, mode])
  // カメラが追う検知点。**実際に地図へ描かれているものだけ**に揃える。
  // detectedPoints（confirmed イベントのメンバーの和集合）は現在の震度で絞られていない
  // （`kyoshinDetector` の memberKeys。値が下がりきった点は `MEMBER_DROP_MS` の猶予を過ぎれば
  // 外れるが、それまでは残る）。一方マーカー側は現在の震度で二段に絞られる
  // （震度0未満・欠測を描かない `gl/kyoshinDetectedFeatures.ts` ＋ 孤立した震度0を落とす
  // `dropIsolatedZeroPoints`）。この差をカメラが引き継ぐと、大地震のあと画が全国に張り付いたまま
  // 戻らない（2024-01-01 能登の再生で実測: 描かれている 70 点に対しフィット目標が 887 点）。
  // 「検知が続いているか」の判定にはこのフィルタを通さない生の detectedPoints を使う
  // （表示を整えるフィルタで検知の有無を書き換えないため。FitToDetectionGL の hasDetection 参照）。
  const detectedFitPoints = useMemo(
    () => detectedMarkerPoints.filter((p) => kyoshinIndexToJma(p.index) !== null),
    [detectedMarkerPoints],
  )
  // EEW の派生データ（予想震度塗り／予想長周期塗り／震源／カメラ追従に含める区域の範囲）。
  const { eewAreaFills, eewLpgmRegionAggregates, eewEpicenters, eewFitPositions } = useEewLayerData(
    eews,
    eewLpgmEventId,
  )

  // 地名ラベル（LabelsGL）の重なり判定の再評価トリガー。震度バッジ・観測点・検知点等
  // 「マーカー」側の**位置情報**が変わったときだけ値が変わるようにする（区域塗りは判定対象外・
  // labelOverlap.ts 参照。EEW 予想震度塗りはバッジを持たないため含めない）。kyoshinIndices
  // （観測点の指数・毎秒更新）はここに含めない——観測点の位置は不変なので、値が変わっても
  // ラベルとの重なりの有無自体は変化しないため（含めると毎秒再評価が走ってしまう）。
  const overlapSignature = useMemo(() => {
    const parts = [
      aggregateByRegion ? regionAggregates.map((r) => r.name).join(',') : '',
      aggregateByRegion && lpgmActive ? lpgmRegionAggregates.map((r) => r.name).join(',') : '',
      !aggregateByRegion ? stationMarkers.map((m) => `${m.position[0]},${m.position[1]}`).join(';') : '',
      !aggregateByRegion && lpgmActive ? lpgmMarkers.map((m) => `${m.position[0]},${m.position[1]}`).join(';') : '',
      mode === 'kyoshin' ? kyoshinSites.length : 0,
      mode === 'kyoshin' ? detectedMarkerPoints.map((p) => `${p.lat},${p.lng}`).join(';') : '',
      // 検知点マーカーとして実際に描かれるのは detectedMarkerPoints と unconfirmedPoints の 2 本。
      // detectedPoints（間引き前）と candidatePoints はカメラフィット専用のため含めない。
      mode === 'kyoshin' ? unconfirmedPoints.map((p) => `${p.lat},${p.lng}`).join(';') : '',
    ]
    return parts.join('|')
  }, [
    aggregateByRegion,
    regionAggregates,
    lpgmActive,
    lpgmRegionAggregates,
    stationMarkers,
    lpgmMarkers,
    mode,
    kyoshinSites,
    detectedMarkerPoints,
    unconfirmedPoints,
  ])

  useEffect(() => {
    if (!containerRef.current) return
    const m = new maplibregl.Map({
      container: containerRef.current,
      center: JAPAN_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
      // 地図の傾き（pitch）と回転（bearing）はユーザー操作から使える。地下の震源分布を立体で
      // 見せるため。標準ジェスチャがそのまま担うので、操作系のオプションは何も塞がない。
      //
      // **maxPitch の 60 は MapLibre の既定値。その先は霧（sky / fog）を前提とした領域で、
      // このアプリは霧を設定していない。** 上げる前に必ず docs/spec/map-rendering-spec.md §6
      // 「地図の傾きと回転」を読むこと——水平線の位置は fov の引き算では求まらず、MapLibre 内部の
      // getMercatorHorizon が決める。根拠となる式・霧の設計・実測値は仕様書側に集約してある
      // （2 箇所に書くと、MapLibre のバージョンが上がったとき片方が取り残される）。
      maxPitch: 60,
      // CJK ラベルはビルド時に事前生成した SDF グリフ PBF（public/fonts/<stack>/<range>.pbf）を
      // 使う。localIdeographFontFamily:false で漢字を実行時 TinySDF 生成に回さず、必ずサーバー
      // グリフを取りに行かせる（区域名初出＝自動ズームと重なる最悪局面の生成スパイクを恒久的に消す。
      // 移行計画 §8・scripts/build-glyphs.mjs）。
      localIdeographFontFamily: false,
      // symbol レイヤーの出入りに付く配置フェードを切る。効果は**地図上の symbol レイヤーすべて**に
      // 及び、レイヤー単位に絞れない。これは paint プロパティのトランジション（各レイヤーで
      // `-transition: {duration:0}` として個別に切っているもの）とは**別系統**で、地図全体にしか
      // 設定できない（詳細と対象レイヤーの内訳は docs/spec/map-rendering-spec.md §8「symbol の
      // 配置フェード」。対象をここに列挙はしない——2 箇所に並べると片方だけ古くなる）。
      //
      // 0 にする理由は 2 つある。
      // 1. この地図では不透明度が既に意味を持っている。欠測ホールド中の点を 0.35 倍で描いて
      //    「そこに点はあるが今は値が無い」と伝えているため（utils/kyoshinMissingHold.ts）、
      //    出現アニメーションで 0→1 を通すと、その途中が「欠測中の点」と見分けられなくなる。
      // 2. 既定の 300ms を残すと、同じ「新しい検知点が出る」出来事が 2 通りの見え方に割れる。
      //    MapLibre は直前の配置に対応付けられたシンボルの不透明度を引き継ぎ、対応付かない
      //    シンボルだけ 0 から立ち上げる。さらにタイル再読み込み直後の配置ではフェードを免除する
      //    （内部の skipFade）。能登本震のリプレイで実測すると免除は配置 1,583 件中 131 件（8%）
      //    しか起きず、残りは 0 から立ち上がっていた。どちらに転ぶかは秒単位のタイミング次第。
      //
      // 上の pitch/rotation と同じく、欠けても型チェックも単体テストも通ってしまう（この
      // コードベースに Map を実際に構築するテストは無い）。消したことに気づけるのは手動の
      // ブラウザ確認だけになる。
      fadeDuration: 0,
      style: {
        version: 8,
        // 地球を球として描く。傾けて見るのが常態になった以上、平面のままだと引いたときに
        // 端が伸びて見える。**寄ると MapLibre が自動で Mercator へ切り替える**ので、
        // 日本を細かく見る場面では従来と同じ描画になる（切り替えの実測と、カスタムレイヤーが
        // 両方の投影に追随する仕組みは docs/spec/map-rendering-spec.md §6「地図の投影」）。
        projection: { type: 'globe' },
        glyphs: `${import.meta.env.BASE_URL}fonts/{fontstack}/{range}.pbf`,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } }],
      },
    })
    mapRef.current = m
    // カメラが動くたびに走る「地形めり込み補正」を、地形を使っていないこの地図では省く
    // （gl/skipNoopCameraUpdate.ts。省略してよいかは実際に本物と突き合わせて確かめる）。
    const cameraUpdateSkip = installNoopCameraUpdateSkip(m)
    // 効き具合を読む口。**省略が効いているかは画面にも警告にも現れない**ので、これが無いと
    // 「入れたのに軽くならない」ときに原因を切り分けられない。露出の考え方は下の __mapGL と同じ。
    ;(window as unknown as Record<string, unknown>).__cameraUpdateSkip = cameraUpdateSkip.status
    // 検証用: 本番ビルドでも意図的に window.__mapGL を公開する。CLAUDE.md の検証手順
    // （実データの map.getSource(...).getData() 集計・Playwright からの map 操作）と
    // docs/spec/settings-pwa-spec.md の「開発者向け機能」節が明示的にこれを利用する。
    // 露出範囲は Same-Origin Policy による: 異なるオリジンの親ページから contentWindow.__mapGL
    // を読み取ることはできない（同一オリジンに限定）。frame-ancestors CSP は現状未実装（index.html
    // の SEC-2 注記参照）だが、SOP により実質的な露出範囲は限定的。
    ;(window as unknown as Record<string, unknown>).__mapGL = m
    // ソース単位のエラーは MapLibre が sourceId をイベントへ載せてくる（型定義には現れないが実測で確認）。
    // 海底地形のように同一 URL のソースを複数持つ場合（BaseMapGL の 2 層構成）、メッセージ中の URL だけでは
    // どちらの層が落ちたか判別できないため sourceId も残す。
    m.on('error', (e) => {
      const sourceId = (e as { sourceId?: string }).sourceId
      log.error('[JapanMapGL] map error', { sourceId, error: e.error })
    })
    m.once('load', () => {
      // 本アプリの既定フレーミング（日本全体・padding 20）へ即時に合わせる。
      fitJapan(m, 0)
      setZoom(m.getZoom())
      setAggregateMaxZoom(fitMaxZoom(m))
      setMap(m)
      const handle: MapHandle = {
        map: m,
        drawExtras: (ctx, target, scale) => {
          const { bars, arrivals, iconScale: s, showBars } = extrasRef.current
          if (!showBars) return
          drawTsunamiObsBars(ctx, target, scale, bars, s)
          drawTsunamiArrivalMarkers(ctx, target, scale, arrivals, s)
        },
      }
      onMapReadyRef.current?.(handle)
    })
    // ズーム確定ごとに zoom state を更新（集約切替の再評価用）。
    const onZoomEnd = () => setZoom(m.getZoom())
    m.on('zoomend', onZoomEnd)
    // ペインの寸法が変わると寄り上限＝集約閾値も変わる。MapLibre はコンテナを ResizeObserver で
    // 監視するため、window のリサイズだけでなくパネル境界のつまみの操作でもここへ届く。
    const onResize = () => setAggregateMaxZoom(fitMaxZoom(m))
    m.on('resize', onResize)
    // 同じ階級のバッジを画面の手前から並べる（gl/screenDepth.ts）。手前らしさは方位だけで決まる
    // ので、購読するのは回転だけでよい（中心・ズーム・傾きでは並びが変わらない）。
    // **購読はここに 1 本だけ置く。** 対象のレイヤーはモードごとに出入りするので、各レイヤーの
    // コンポーネントに置くと購読が増えたり減ったりして、どれが効いているか追えなくなる。
    let appliedBearing = 0
    const onRotate = () => {
      const b = m.getBearing()
      // 回している間ずっと作り直すとシンボルの配置計算が繰り返し走る。刻みで間引く。
      if (!bearingChangedEnough(appliedBearing, b)) return
      appliedBearing = b
      applyFrontSortKeys(m, b)
    }
    m.on('rotate', onRotate)
    // 間引きで取りこぼした端数を、回し終わりで必ず合わせる。
    const onRotateEnd = () => {
      appliedBearing = m.getBearing()
      applyFrontSortKeys(m, appliedBearing)
    }
    m.on('rotateend', onRotateEnd)
    // レイヤーはモードの切替で後から足される。**足された時点の方位で式を入れ直す**
    // （追加時の初期値は方位 0 で焼いてあるため、回した状態で入室すると並びがずれる）。
    // **ここは刻みで間引かない。** 間引くと「レイヤーが足されたのに方位が古いまま」が起きる。
    // 書き込み自体は `applyFrontSortKeys` が中身の比較で止めるので、値が変わらない限り
    // 式を組み立てて比べるだけで終わる。
    const onStyleData = () => applyFrontSortKeys(m, m.getBearing())
    m.on('styledata', onStyleData)

    // コマ落ちの診断（utils/frameProfiler.ts）へ、地図側の文脈を 2 つ渡す。
    //
    // **カメラの移動は区間として記録する。** 区間そのものの長さには意味がない（飛行時間なので
    // 必ず長い）。目的は、記録された長いフレームを後から「移動中に起きたもの」と結び付けられる
    // ようにすることだけ。
    let endMoveSpan: ((detail?: string) => void) | null = null
    const onMoveStart = () => {
      // 前の区間が閉じていなければここで閉じる。`movestart` が続けて来ても開いたままにしない
      // （閉じ忘れた区間は記録に残らず、その移動中のフレームが「移動外」に見える）。
      endMoveSpan?.()
      endMoveSpan = beginSpan('camera:move')
    }
    const onMoveEnd = () => {
      endMoveSpan?.()
      endMoveSpan = null
    }
    m.on('movestart', onMoveStart)
    m.on('moveend', onMoveEnd)
    // **タイルの到着は点として記録する。** これが長いフレームの前後に集まっていれば読み込み側、
    // 集まっていなければメインスレッド側——この切り分けが診断の主眼。ソース ID まで名前に含める
    // のは、海底地形ラスタと geojson の再タイル化を混ぜないため。
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.tile) noteEvent(`map:tile:${e.sourceId}`)
    }
    m.on('sourcedata', onSourceData)

    return () => {
      // 飛行中に破棄されたら、そこまでを部分区間として残す（閉じないと記録が丸ごと消える）。
      endMoveSpan?.()
      endMoveSpan = null
      m.off('zoomend', onZoomEnd)
      m.off('resize', onResize)
      m.off('rotate', onRotate)
      m.off('rotateend', onRotateEnd)
      m.off('styledata', onStyleData)
      m.off('movestart', onMoveStart)
      m.off('moveend', onMoveEnd)
      m.off('sourcedata', onSourceData)
      cameraUpdateSkip.restore()
      delete (window as unknown as Record<string, unknown>).__cameraUpdateSkip
      mapRef.current = null
      setMap(null)
      onMapReadyRef.current?.(null)
      m.remove()
    }
  }, [])

  // MapLibre は container に position:relative を強制するため、地図領域を埋める absolute inset-0 は
  // 外側ラッパーに掛け、MapLibre コンテナ自身は h-full/w-full でラッパーいっぱいに広げる
  // （container 直下に absolute inset-0 を掛けると position を上書きされ高さ0に潰れる）。
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full">
        <MapGLContext.Provider value={map}>
          {/* 後続フェーズのレイヤーコンポーネントはここに置く（map を Context で購読） */}
          <BaseMapGL showBathymetry={showBathymetry} />
          {/* 地名ラベル（地方/県/区域名・最前面）。 */}
          <LabelsGL overlapSignature={overlapSignature} iconScale={iconScale} />
          {/* 活断層・プレート境界（quake/kyoshin モード）。kyoshin ドット群の下に敷く。 */}
          {/* 地震活動ヒートマップ（quake/kyoshin モードで heatPoints があるとき・区域塗りより背面）。
              GeoJSON source を持つレイヤーは mode に関わらず常時マウントし visible だけで切り替える
              （条件付きレンダリングで addSource/removeSource を繰り返すと、非同期タイル化待ちの間
              タブ切替直後の数フレームが空白になるフリッカーの原因になるため）。 */}
          <QuakeHeatmapGL
            points={heatPoints ?? []}
            iconScale={iconScale}
            visible={(mode === 'quake' || mode === 'kyoshin') && !!heatPoints && heatPoints.length > 0}
          />
          {/* 夜の側の重ね塗り。地図の照明条件にあたるので、モードを問わず出す
              （夜間の津波は避難の条件が変わるため、津波モードでも意味を持つ）。 */}
          <DayNightGL visible={showDayNight} opacity={dayNightOpacity} />
          <PlateBoundariesGL plateBoundaries={plateBoundaries} visible={showOverlayLines && showPlateBoundaries} />
          <ActiveFaultsGL activeFaults={activeFaults} visible={showOverlayLines && showActiveFaults} opacity={activeFaultOpacity} />
          {/* 通常の震度表示（LPGM 進行中は非表示＝下の LPGM 表示に置き換わる）。
              区域集約時は一次細分区域塗り＋震度ラベル、高ズーム時は観測点ごとの震度点。
              上と同じ理由で quake モード限定でも常時マウントし visible だけ切り替える。 */}
          <QuakeRegionFillGL
            regionAggregates={regionAggregates}
            iconScale={iconScale}
            visible={mode === 'quake' && aggregateByRegion && !lpgmActive}
          />
          {/* 観測点表示のときだけ、その背景に震度の面を敷く（区域塗りとは排他）。 */}
          <QuakeIntensitySurfaceGL
            markers={stationMarkers}
            visible={mode === 'quake' && !aggregateByRegion && !lpgmActive}
          />
          <QuakeIntensityPointsGL
            markers={stationMarkers}
            iconScale={iconScale}
            visible={mode === 'quake' && !aggregateByRegion && !lpgmActive}
            epicenter={epicenter}
          />
          {/* LPGM（長周期地震動）進行中: 区域集約時は区域塗り＋階級ラベル、高ズーム時は観測点ドット。 */}
          <LpgmRegionFillGL
            regionAggregates={lpgmRegionAggregates}
            iconScale={iconScale}
            visible={mode === 'quake' && aggregateByRegion && lpgmActive}
          />
          <LpgmPointsGL
            markers={lpgmMarkers}
            iconScale={iconScale}
            visible={mode === 'quake' && !aggregateByRegion && lpgmActive}
          />
          {/* SubThreshold(index1〜6)を先に置き、その上に KyoshinPoints(index7+)を重ねる。
              さらに検知点・波紋を最前面に重ねる（Leaflet 版の重畳順と一致）。同じ理由で常時マウント。
              SubThreshold は custom レイヤーで style spec の visibility が効かないため、
              内部で毎秒の triggerRepaint 自体を止める自前ガードを持つ（KyoshinSubThresholdGL 側）。 */}
          <KyoshinSubThresholdGL
            sites={kyoshinSites}
            indices={kyoshinSubIndices ?? kyoshinIndices}
            iconScale={iconScale}
            visible={mode === 'kyoshin'}
          />
          <KyoshinPointsGL sites={kyoshinSites} indices={kyoshinIndices} stale={kyoshinStale} iconScale={iconScale} visible={mode === 'kyoshin'} />
          <KyoshinDetectedPointsGL
            confirmedPoints={detectedMarkerPoints}
            unconfirmedPoints={unconfirmedPoints}
            iconScale={iconScale}
            visible={mode === 'kyoshin'}
          />
          <KyoshinMaxEffectGL sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale} visible={mode === 'kyoshin'} />
          {/* 長期震源カタログの点群。**常時マウントして visible だけ切り替える**——
              カスタムレイヤーの付け外しはシェーダーの作り直しを伴い、タブを往復するたびに
              数十万点を詰め直すことになる。 */}
          {catalogCloud && (
            <HypocenterCatalogGL
              cloud={catalogCloud}
              exaggeration={hypocenterDepthScale}
              visible={mode === 'catalog'}
            />
          )}
          {mode === 'quake' && (
            <>
              {hasEpicenter && epicenter && quake && (
                <HypocenterDepthGL
                  quake={quake}
                  epicenter={epicenter}
                  prefIntensities={prefIntensities}
                  iconScale={iconScale}
                  exaggeration={hypocenterDepthScale}
                />
              )}
              {/* 地震モードのカメラフィット（signature 変化時に観測点＋震源へ）。 */}
              <QuakeFitGL
                signature={quakeSignature}
                positions={quakeFitPositions}
                selectionTick={quakeSelectionTick}
                lastConsumedTickRef={lastConsumedQuakeTickRef}
              />
            </>
          )}
          {mode === 'kyoshin' && (
            <>
              {/* リアルタイム震度モードのカメラ追従（検知点/候補クラスタ/タブ入室）。EEW 追従は Camera-2。
                  カメラ移動という副作用そのものがモード入室時にのみ起きてほしいため、レイヤーとは
                  異なり条件付きマウントのままにする（常時マウントすると非表示タブでも発火しうる）。

                  **この 4 つの記述順には意味がある。FitToEEWGL を必ず最後に置くこと。**
                  effect はコンポーネントツリー順に走るため、同一コミット内で最後に flyTo を呼ぶのは
                  最後にマウントされたものになる。EEW 解除と確定検知の消失が同時に起きた場合、
                  FitToEEWGL の帰還先の判断（検知点 → 候補クラスタ → 日本全体）が他の判断を上書きして
                  勝つ設計にしている。順序を入れ替えると、EEW 発報中に FitToCandidateGL /
                  FitToDetectionGL が委譲した先（FitToEEWGL）の帰還が他方の fitJapan に潰され、
                  「EEW 中に立った候補クラスタが一度も画面に入らない」という境界ケースだけが静かに壊れる。 */}
              <FitJapanOnEnterGL hasEew={eews.length > 0} hasDetection={detectedPoints.length > 0 || candidatePoints.length > 0} />
              <FitToCandidateGL
                points={candidatePoints}
                candidateId={candidateId}
                hasEew={eews.length > 0}
                hasDetection={detectedPoints.length > 0}
              />
              <FitToDetectionGL
                points={detectedFitPoints}
                hasDetection={detectedPoints.length > 0}
                hasEew={eews.length > 0}
                hasCandidate={candidateId !== null && candidatePoints.length > 0}
                shakeFocus={shakeFocus}
                lastConsumedFocusTickRef={lastConsumedShakeFocusTickRef}
              />
              {/* EEW 追従（idle 抑制つき）。
                  MAP-5 の常時マウント化は QuakeFitGL/TsunamiFitGL との flyTo 争い・EEW 解除後の
                  帰還未実装等の副作用が広範で、正しい対応には大規模リファクタが必要と判明したため
                  revert。kyoshin モード限定のままとし、他モード滞在中の EEW 追従中断は既知の限界
                  として仕様書に明記する。 */}
              <FitToEEWGL
                eews={eews}
                psWave={kyoshinPsWave}
                detectedPoints={detectedFitPoints}
                hasDetection={detectedPoints.length > 0}
                candidatePoints={candidatePoints}
                forecastAreaPositions={eewFitPositions}
                firstSeenAtRef={eewFirstSeenAtRef}
                focusedEewIdRef={focusedEewIdRef}
                shakeFocus={shakeFocus}
                lastConsumedFocusTickRef={lastConsumedShakeFocusTickRef}
              />
            </>
          )}
          {/* EEW 予想震度塗り（kyoshin モード・EEW LPGM 表示中は隠す）と予想長周期塗り。
              データ自体は mode に関わらず常時計算（useEewLayerData）しておき、visible だけで
              表示を絞る。kyoshin タブへ切り替えた瞬間に GeoJSON source が空→実データへ非同期
              タイル化される隙を作らないため。 */}
          <EewRegionFillGL
            areaFills={eewAreaFills}
            visible={mode === 'kyoshin' && eewAreaFills.length > 0 && eewLpgmRegionAggregates.length === 0}
          />
          <EewLpgmRegionFillGL
            regionAggregates={eewLpgmRegionAggregates}
            visible={mode === 'kyoshin' && eewLpgmRegionAggregates.length > 0}
          />
          {/* EEW 予報円（S波塗り／P波外周）。全モードで表示し、リアルタイム震度モード以外は半透明（震源×印と同じ扱い）。 */}
          <PsWaveGL psWave={kyoshinPsWave} fullOpacity={mode === 'kyoshin'} />
          {/* EEW 震源（×印・点滅）。全モードで表示し、リアルタイム震度モード以外は半透明。 */}
          {eewEpicenters.length > 0 && (
            <EewEpicentersGL epicenters={eewEpicenters} iconScale={iconScale} fullOpacity={mode === 'kyoshin'} />
          )}
          {/* 津波海岸線: 発報中は全モードで最前面付近に描画・点滅する。GeoJSON source を持つため
              常時マウントし visible だけ切り替える（発表/全解除で 0↔非0 になるたびの
              addSource/removeSource churn を避ける）。 */}
          <TsunamiLinesGL lines={tsunamiLines} iconScale={iconScale} visible={tsunamiLines.length > 0} />
          {/* 津波観測棒: 津波モードで波高バーを立てる。HTML Marker ベースで GeoJSON source の
              非同期タイル化を伴わないため、タブ切替時のマウント/アンマウント自体は実害が薄い
              （観測点名キーの差分更新で、更新のたびの全マーカー作り直しは別途解消済み）。 */}
          {mode === 'tsunami' && observationBars.length > 0 && (
            <TsunamiObsBarsGL bars={observationBars} iconScale={iconScale} />
          )}
          {/* 津波の到達確認マーカー: 波高がまだ出ていない観測点に印を置く。観測棒と対で、
              値が付いた観測点はこちらから消えて棒へ移る。 */}
          {mode === 'tsunami' && arrivalMarkers.length > 0 && (
            <TsunamiArrivalMarkersGL markers={arrivalMarkers} iconScale={iconScale} />
          )}
          {/* 津波カメラ追従・観測フォーカス（モード切替をまたいで ref 保持するため常時マウント）。 */}
          <TsunamiFitGL
            mode={mode}
            tsunamiSignature={tsunamiSignature}
            tsunamiFitPositions={tsunamiFitPositions}
            observationBars={observationBars}
            arrivalMarkers={arrivalMarkers}
            focusObsName={focusObsName}
          />
          <FocusObsGL focusObsName={focusObsName} observationBars={focusablePoints} />
        </MapGLContext.Provider>
      </div>
    </div>
  )
}
