import type { JMAQuake, JMATsunami, TsunamiObservation, EEWAlert, JMALpgm } from '../../types/earthquake'
import type { SiteCoords, PsWaveCircle } from '../../services/kyoshin'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { HeatPoint } from '../../utils/quakeHeatmap'

// 地図コンポーネントの契約（Props とモード）の単一情報源。
// Leaflet 版 JapanMap と MapLibre 版 JapanMapGL、両者を出し分ける MapView が
// この同一の型を共有することで、移行中に両実装のシグネチャがずれないようにする。
// （MapLibre 移行計画 docs/webgl-migration-implementation-plan.md F0）

// 地図のモード: quake=地震情報 / tsunami=津波海岸線 / kyoshin=リアルタイム震度・予報円。
export type MapMode = 'quake' | 'tsunami' | 'kyoshin'

export interface JapanMapProps {
  mode: MapMode
  quake: JMAQuake | null
  tsunamis: JMATsunami[]
  observations?: TsunamiObservation[]
  lpgm?: JMALpgm
  iconScale?: number
  showBathymetry?: boolean
  showActiveFaults?: boolean
  activeFaultOpacity?: number
  heatPoints?: HeatPoint[] | null
  showPlateBoundaries?: boolean
  kyoshinSites?: SiteCoords
  kyoshinIndices?: number[]
  /** 震度0ドット（KyoshinSubThresholdGL）専用の慢性ノイズ床フィルタ適用済みインデックス。未指定時は kyoshinIndices をそのまま使う。 */
  kyoshinSubIndices?: number[]
  kyoshinPsWave?: PsWaveCircle[]
  eews?: EEWAlert[]
  /**
   * confirmed 全イベントのメンバー観測点。**カメラフィットと「検知が続いているか」の判定専用**
   * （空になったことを検知終了の合図として扱う）。地図に描く分は detectedMarkerPoints を使う。
   */
  detectedPoints?: DetectedPoint[]
  /** confirmed のメンバーのうち実際に描くもの（孤立した震度0点を除いた集合）。**検知点マーカー専用**。 */
  detectedMarkerPoints?: DetectedPoint[]
  /** 主 likely イベント 1 件のメンバー観測点。**候補カメラフィット専用**（検知点マーカーは unconfirmedPoints を使う）。 */
  candidatePoints?: DetectedPoint[]
  /** likely / faint 全イベントのメンバー観測点。**検知点マーカー専用**（フィットには使わない）。 */
  unconfirmedPoints?: DetectedPoint[]
  candidateId?: number | null
  eewLpgmEventId?: string | null
  focusObsName?: { name: string; ts: number } | null
  obsUpdateStatus?: Map<string, 'new' | 'updated'>
  /**
   * 地震カードをユーザーが明示的に選んだ回数（単調増加）。QuakeFitGL が「明示選択」と
   * 「電文更新起点の自動追従」を区別するために使う。ズーム/パン中でもカードクリックには
   * 追従してほしいため、tick が進んだフィットは isUserInteracting を無視して発火する。
   */
  quakeSelectionTick?: number
}
