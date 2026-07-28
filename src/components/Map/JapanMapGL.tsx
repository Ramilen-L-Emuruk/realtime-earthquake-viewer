import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapGLContext } from './mapGLContext'
import { BaseMapGL } from './BaseMapGL'
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
import { JAPAN_CENTER, fitJapan } from './gl/camera'
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
  heatPoints,
  showBathymetry = true,
  kyoshinSites = [],
  kyoshinIndices = [],
  detectedPoints = [],
  iconScale = 1,
  showActiveFaults = true,
  showPlateBoundaries = true,
}: JapanMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  // 集約切替（zoom <= MAX_ZOOM で一次細分区域集約）判定のため現在ズームを追跡する。
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  const activeFaults = useActiveFaults()
  const plateBoundaries = usePlateBoundaries()
  // 活断層・プレート境界は地震／リアルタイム震度モードで表示する（Leaflet 版と同条件）。
  const showOverlayLines = mode === 'quake' || mode === 'kyoshin'
  // 地震モードの派生データ（震度点／区域集約／震源）。Leaflet 版と共有の導出フック。
  const {
    intensityMarkers,
    aggregateByRegion,
    regionAggregates,
    hasEpicenter,
    epicenter,
    prefIntensities,
    lpgmActive,
    lpgmMarkers,
    lpgmRegionAggregates,
  } = useQuakeLayerData(mode, quake, zoom, lpgm)
  // 津波の派生データ（海岸線＋観測棒）。発報中は全モードで海岸線を描くため常時計算する。
  const { tsunamiLines, observationBars } = useTsunamiLayerData(tsunamis, observations, obsUpdateStatus)
  // EEW の派生データ（予想震度塗り／予想長周期塗り／震源）。
  const { eewAreaFills, eewLpgmRegionAggregates, eewEpicenters } = useEewLayerData(mode, eews, eewLpgmEventId)

  useEffect(() => {
    if (!containerRef.current) return
    const m = new maplibregl.Map({
      container: containerRef.current,
      center: JAPAN_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
      // F0: 背景色のみの空スタイル。ソース/レイヤーは後続フェーズで追加する。
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } }],
      },
    })
    mapRef.current = m
    // 検証用（Playwright から map を操作・レイヤー確認するため。PoC の __labelMap と同様の dev 補助）。
    ;(window as unknown as Record<string, unknown>).__mapGL = m
    m.on('error', (e) => log.error('[JapanMapGL] map error', e.error))
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
          {/* 活断層・プレート境界（quake/kyoshin モード）。kyoshin ドット群の下に敷く。 */}
          {/* 地震活動ヒートマップ（quake/kyoshin モードで heatPoints があるとき・区域塗りより背面）。 */}
          {(mode === 'quake' || mode === 'kyoshin') && heatPoints && heatPoints.length > 0 && (
            <QuakeHeatmapGL points={heatPoints} />
          )}
          <PlateBoundariesGL plateBoundaries={plateBoundaries} visible={showOverlayLines && showPlateBoundaries} />
          <ActiveFaultsGL activeFaults={activeFaults} visible={showOverlayLines && showActiveFaults} />
          {mode === 'quake' && (
            <>
              {/* 通常の震度表示（LPGM 進行中は非表示＝下の LPGM 表示に置き換わる）。
                  区域集約時は一次細分区域塗り＋震度ラベル、高ズーム時は観測点ごとの震度点。 */}
              <QuakeRegionFillGL
                regionAggregates={regionAggregates}
                iconScale={iconScale}
                visible={aggregateByRegion && !lpgmActive}
              />
              <QuakeIntensityPointsGL
                markers={intensityMarkers}
                iconScale={iconScale}
                visible={!aggregateByRegion && !lpgmActive}
              />
              {/* LPGM（長周期地震動）進行中: 区域集約時は区域塗り＋階級ラベル、高ズーム時は観測点ドット。 */}
              <LpgmRegionFillGL
                regionAggregates={lpgmRegionAggregates}
                iconScale={iconScale}
                visible={aggregateByRegion && lpgmActive}
              />
              <LpgmPointsGL
                markers={lpgmMarkers}
                iconScale={iconScale}
                visible={!aggregateByRegion && lpgmActive}
              />
              {hasEpicenter && epicenter && quake && (
                <EpicenterGL quake={quake} epicenter={epicenter} prefIntensities={prefIntensities} iconScale={iconScale} />
              )}
            </>
          )}
          {mode === 'kyoshin' && (
            <>
              {/* SubThreshold(index1〜6)を先に置き、その上に KyoshinPoints(index7+)を重ねる。
                  さらに検知点・波紋を最前面に重ねる（Leaflet 版の重畳順と一致）。 */}
              <KyoshinSubThresholdGL sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale} />
              <KyoshinPointsGL sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale} />
              <KyoshinDetectedPointsGL points={detectedPoints} iconScale={iconScale} />
              <KyoshinMaxEffectGL sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale} />
            </>
          )}
          {/* EEW 予想震度塗り（kyoshin モード・EEW LPGM 表示中は隠す）と予想長周期塗り。 */}
          <EewRegionFillGL
            areaFills={eewAreaFills}
            visible={eewAreaFills.length > 0 && eewLpgmRegionAggregates.length === 0}
          />
          <EewLpgmRegionFillGL
            regionAggregates={eewLpgmRegionAggregates}
            visible={eewLpgmRegionAggregates.length > 0}
          />
          {/* EEW 予報円（S波塗り／P波外周）。全モードで表示（実 EEW 発報時のみ値が入る）。 */}
          <PsWaveGL psWave={kyoshinPsWave} />
          {/* EEW 震源（×印・点滅）。全モードで表示し、リアルタイム震度モード以外は半透明。 */}
          {eewEpicenters.length > 0 && (
            <EewEpicentersGL epicenters={eewEpicenters} iconScale={iconScale} fullOpacity={mode === 'kyoshin'} />
          )}
          {/* 津波海岸線: 発報中は全モードで最前面付近に描画・点滅する。 */}
          {tsunamiLines.length > 0 && <TsunamiLinesGL lines={tsunamiLines} iconScale={iconScale} />}
          {/* 津波観測棒: 津波モードで波高バーを立てる。 */}
          {mode === 'tsunami' && observationBars.length > 0 && <TsunamiObsBarsGL bars={observationBars} />}
        </MapGLContext.Provider>
      </div>
    </div>
  )
}
