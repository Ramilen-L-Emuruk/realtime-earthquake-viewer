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
import { QuakeIntensityPointsGL } from './QuakeIntensityPointsGL'
import { QuakeRegionFillGL } from './QuakeRegionFillGL'
import { QuakeHeatmapGL } from './QuakeHeatmapGL'
import { EpicenterGL } from './EpicenterGL'
import { LpgmPointsGL } from './LpgmPointsGL'
import { LpgmRegionFillGL } from './LpgmRegionFillGL'
import { TsunamiLinesGL } from './TsunamiLinesGL'
import { TsunamiObsBarsGL } from './TsunamiObsBarsGL'
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
import { JAPAN_CENTER, fitJapan, DEFAULT_IDLE_REVERT_SEC } from './gl/camera'
import { useActiveFaults } from '../../hooks/useActiveFaults'
import { usePlateBoundaries } from '../../hooks/usePlateBoundaries'
import { useQuakeLayerData } from '../../hooks/useQuakeLayerData'
import { useTsunamiLayerData } from '../../hooks/useTsunamiLayerData'
import { useEewLayerData } from '../../hooks/useEewLayerData'
import type { JapanMapProps } from './mapTypes'
import { log } from '../../utils/logger'

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
  idleRevertSec = DEFAULT_IDLE_REVERT_SEC,
  focusObsName = null,
  heatPoints,
  showBathymetry = true,
  kyoshinSites = [],
  kyoshinIndices = [],
  kyoshinSubIndices,
  detectedPoints = [],
  candidatePoints = [],
  candidateId = null,
  iconScale = 1,
  showActiveFaults = true,
  activeFaultOpacity = 0.4,
  showPlateBoundaries = true,
  quakeSelectionTick = 0,
}: JapanMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  // 集約切替（zoom <= MAX_ZOOM で一次細分区域集約）判定のため現在ズームを追跡する。
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  // QuakeFitGL が「最後に処理した quakeSelectionTick の値」を保持する ref。
  // ここ（JapanMapGL は常時マウント）で保有し、QuakeFitGL に props で渡すことで
  // タブ切替による QuakeFitGL のリマウントをまたいでも「明示選択で tick が進んだ最初の
  // フィットだけ explicit=true」という判定を保つ（QuakeFitGL 内で useRef すると
  // リマウントのたびに初期値へリセットされ、タブ復帰のたびに強制フィットが走る不具合が
  // 出る。CameraFollowsGL.tsx の QuakeFitGL コメント参照）。
  const lastConsumedQuakeTickRef = useRef<number>(0)
  const activeFaults = useActiveFaults()
  const plateBoundaries = usePlateBoundaries()
  // 活断層・プレート境界は地震／リアルタイム震度モードで表示する（Leaflet 版と同条件）。
  const showOverlayLines = mode === 'quake' || mode === 'kyoshin'
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
  } = useQuakeLayerData(mode, quake, zoom, lpgm)
  // 津波の派生データ（海岸線＋観測棒）。発報中は全モードで海岸線を描くため常時計算する。
  const { tsunamiLines, observationBars, tsunamiFitPositions, tsunamiSignature } = useTsunamiLayerData(
    tsunamis,
    observations,
    obsUpdateStatus,
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
      mode === 'kyoshin' ? detectedPoints.map((p) => `${p.lat},${p.lng}`).join(';') : '',
      mode === 'kyoshin' ? candidatePoints.map((p) => `${p.lat},${p.lng}`).join(';') : '',
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
    detectedPoints,
    candidatePoints,
  ])

  useEffect(() => {
    if (!containerRef.current) return
    const m = new maplibregl.Map({
      container: containerRef.current,
      center: JAPAN_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
      // CJK ラベルはビルド時に事前生成した SDF グリフ PBF（public/fonts/<stack>/<range>.pbf）を
      // 使う。localIdeographFontFamily:false で漢字を実行時 TinySDF 生成に回さず、必ずサーバー
      // グリフを取りに行かせる（区域名初出＝自動ズームと重なる最悪局面の生成スパイクを恒久的に消す。
      // 移行計画 §8・scripts/build-glyphs.mjs）。
      localIdeographFontFamily: false,
      style: {
        version: 8,
        glyphs: `${import.meta.env.BASE_URL}fonts/{fontstack}/{range}.pbf`,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } }],
      },
    })
    mapRef.current = m
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
      setMap(m)
    })
    // ズーム確定ごとに zoom state を更新（集約切替の再評価用）。
    const onZoomEnd = () => setZoom(m.getZoom())
    m.on('zoomend', onZoomEnd)
    return () => {
      m.off('zoomend', onZoomEnd)
      mapRef.current = null
      setMap(null)
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
          <KyoshinPointsGL sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale} visible={mode === 'kyoshin'} />
          <KyoshinDetectedPointsGL
            confirmedPoints={detectedPoints}
            candidatePoints={candidatePoints}
            iconScale={iconScale}
            visible={mode === 'kyoshin'}
          />
          <KyoshinMaxEffectGL sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale} visible={mode === 'kyoshin'} />
          {mode === 'quake' && (
            <>
              {hasEpicenter && epicenter && quake && (
                <EpicenterGL quake={quake} epicenter={epicenter} prefIntensities={prefIntensities} iconScale={iconScale} />
              )}
              {/* 地震モードのカメラフィット（signature 変化時に観測点＋震源へ）。 */}
              <QuakeFitGL
                signature={quakeSignature}
                positions={quakeFitPositions}
                selectionTick={quakeSelectionTick}
                lastConsumedTickRef={lastConsumedQuakeTickRef}
                idleRevertSec={idleRevertSec}
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
                idleRevertSec={idleRevertSec}
              />
              <FitToDetectionGL
                points={detectedPoints}
                hasEew={eews.length > 0}
                hasCandidate={candidateId !== null && candidatePoints.length > 0}
                idleRevertSec={idleRevertSec}
              />
              {/* EEW 追従（idle 抑制つき）。
                  MAP-5 の常時マウント化は QuakeFitGL/TsunamiFitGL との flyTo 争い・EEW 解除後の
                  帰還未実装等の副作用が広範で、正しい対応には大規模リファクタが必要と判明したため
                  revert。kyoshin モード限定のままとし、他モード滞在中の EEW 追従中断は既知の限界
                  として仕様書に明記する。 */}
              <FitToEEWGL
                eews={eews}
                psWave={kyoshinPsWave}
                idleRevertSec={idleRevertSec}
                detectedPoints={detectedPoints}
                candidatePoints={candidatePoints}
                forecastAreaPositions={eewFitPositions}
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
          {/* 津波カメラ追従・観測フォーカス（モード切替をまたいで ref 保持するため常時マウント）。 */}
          <TsunamiFitGL
            mode={mode}
            tsunamiSignature={tsunamiSignature}
            tsunamiFitPositions={tsunamiFitPositions}
            observationBars={observationBars}
            focusObsName={focusObsName}
            idleRevertSec={idleRevertSec}
          />
          <FocusObsGL focusObsName={focusObsName} observationBars={observationBars} />
        </MapGLContext.Provider>
      </div>
    </div>
  )
}
