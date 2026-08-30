import type { JMAQuake, JMATsunami, TsunamiObservation, EEWAlert, JMALpgm } from '../../types/earthquake'
import type { SiteCoords, PsWaveCircle } from '../../services/kyoshin'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { HeatPoint } from '../../utils/quakeHeatmap'
import type { CatalogPointCloud } from '../../utils/hypocenterCatalogView'

// 地図コンポーネントの契約（Props とモード）の単一情報源。
// Leaflet 版 JapanMap と MapLibre 版 JapanMapGL、両者を出し分ける MapView が
// この同一の型を共有することで、移行中に両実装のシグネチャがずれないようにする。
// （MapLibre 移行計画 docs/webgl-migration-implementation-plan.md F0）

// 地図のモード: quake=地震情報 / tsunami=津波海岸線 / kyoshin=リアルタイム震度・予報円 /
// catalog=長期震源カタログの点群。
export type MapMode = 'quake' | 'tsunami' | 'kyoshin' | 'catalog'

/**
 * 揺れ検知で「今この 1 点を見せたい」という要求。`useKyoshinAlerts` が通知音とまったく同じ判定で
 * 発行し（揺れの強まり＝レベルアップ／再エスカレーションと、別地点発報）、`FitToDetectionGL` が
 * 消費して短く寄る。
 *
 * `tick` は単調増加の連番。座標の等値では「同じ場所でさらに強まった」を表せないため、寄り直しの
 * 合図はこの連番で持つ。`atMs` は要求した時刻（`Date.now()`）で、地図側が古い要求を捨てるために使う
 * ——タブの保持（優先度）で realtime へ移れなかった場合、要求だけが残って後から入室したときに
 * 蒸し返される。
 */
export interface ShakeFocus {
  lat: number
  lng: number
  tick: number
  atMs: number
}

export interface JapanMapProps {
  mode: MapMode
  quake: JMAQuake | null
  tsunamis: JMATsunami[]
  observations?: TsunamiObservation[]
  lpgm?: JMALpgm
  iconScale?: number
  /** 震源の深さをどれだけ強調するか（1 = 実際の深さ）。水平方向は常に実スケール。 */
  hypocenterDepthScale?: number
  /**
   * 長期震源カタログの点群（`catalog` モードで描く）。
   *
   * **絞り込みと色付けは呼び出し側の担当。** 地図は受け取った列をそのまま描くだけで、
   * カタログの読み込みにも条件にも関わらない（点数が多く、条件が変わるたびに詰め直すため）。
   */
  catalogCloud?: CatalogPointCloud | null
  showBathymetry?: boolean
  showActiveFaults?: boolean
  activeFaultOpacity?: number
  heatPoints?: HeatPoint[] | null
  showPlateBoundaries?: boolean
  kyoshinSites?: SiteCoords
  kyoshinIndices?: number[]
  /**
   * `kyoshinIndices` のうち、欠測ホールドで直前値を保持している点のフラグ（同順）。
   * 該当点は薄く描く（`utils/kyoshinMissingHold.ts`）。
   */
  kyoshinStale?: boolean[]
  /** 震度0ドット（KyoshinSubThresholdGL）専用の慢性ノイズ床フィルタ適用済みインデックス。未指定時は kyoshinIndices をそのまま使う。 */
  kyoshinSubIndices?: number[]
  kyoshinPsWave?: PsWaveCircle[]
  eews?: EEWAlert[]
  /**
   * confirmed 全イベントのメンバー観測点。**「検知が続いているか」の判定専用**
   * （空になったことを検知終了の合図として扱う。イベントが生存している間ここが空にならないことは
   * `MEMBER_DROP_MS` の下限が保証している）。この集合は現在の震度で絞られていないため、
   * **カメラフィットの目標には使わない**
   * （`JapanMapGL` が detectedMarkerPoints から寄り先を作る。理由は同ファイルの detectedFitPoints）。
   * 地図に描く分は detectedMarkerPoints を使う。
   */
  detectedPoints?: DetectedPoint[]
  /**
   * confirmed のメンバーのうち実際に描くもの（孤立した震度0点を除いた集合）。
   * **検知点マーカーと、そこから作るカメラの寄り先**に使う。
   */
  detectedMarkerPoints?: DetectedPoint[]
  /** 主 likely イベント 1 件のメンバー観測点。**候補カメラフィット専用**（検知点マーカーは unconfirmedPoints を使う）。 */
  candidatePoints?: DetectedPoint[]
  /** likely / faint 全イベントのメンバー観測点。**検知点マーカー専用**（フィットには使わない）。 */
  unconfirmedPoints?: DetectedPoint[]
  candidateId?: number | null
  /**
   * 揺れの強まり・別地点発報で立った「1 点へ寄せる」要求（`ShakeFocus`）。null は要求なし。
   * 消費済みの連番は `JapanMapGL` が保有する ref で覚える（理由は同ファイルの
   * `lastConsumedShakeFocusTickRef`）。
   */
  shakeFocus?: ShakeFocus | null
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
