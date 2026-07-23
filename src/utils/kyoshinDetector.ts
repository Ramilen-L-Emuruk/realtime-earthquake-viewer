/**
 * 強震モニタ地震検知エンジン（純粋コア）。
 *
 * 設計書: docs/kyoshin-detection-design.md
 * React から切り離した純粋関数として実装する（副作用・現在時刻の直接参照を持たない。
 * 時刻はすべて frame.dataTimeMs から供給する）。決定的で単体テスト可能。
 *
 * 実装済み: Phase 1（① 自己正規化トリガー）＋ Phase 2（② 時空間アソシエーション・③ 確信度積分）。
 *
 * 【簡略化（設計書からの意図的な差分。後続フェーズで拡張予定）】
 * - 波面フィットは軽量版: 震源＝最早オンセット点、オンセット×距離の最小二乗で見かけ速度・残差を出す
 *   （グリッド探索による震源推定は Phase 3 後段）。
 * - クラスタは時空間ゲート付きシード成長（Phase 3 で single-linkage の巨大ブロブ融合を是正済み）。
 *   密度正規化・地理ブロックは未実装。
 * - 地域類型（疎地域の単点判定・海域片側 type-B 震央・遠地平面波）は未実装（Phase 3 後段）。
 *
 * 【単位に関する設計判断（設計書 §5① の refinement）】
 * 強震モニタの値は計測震度（≒ 地動振幅の対数）で、-3.0〜7.0 の連続値。
 * 対数スケールのため、STA/LTA の「比」ではなく「差 (STA − LTA)」を用いる。
 * 差はそのまま線形振幅の対数比に相当し、オフセットを持つ index の比より物理的に正しい。
 * 本コアは全体を value（計測震度）単位で扱い、境界で index → value 変換する。
 */

import { haversineKm, bearingDeg } from './geo'

/** 緯度1度あたりのおおよその距離(km)。局所平面(ENU)近似での座標変換に使う。 */
const KM_PER_DEG = 111.194

// ============================================================
// 型定義（設計書 §7.1）
// ============================================================

/** トリガーの発火経路。 */
export type TriggerPath =
  | 'fast' // 急オンセット（STA−LTA・立ち上がり）
  | 'slow' // 絶対レベル（ゆっくり成長する強い揺れ）
  | 'sync' // 空間同期（Phase 3 で判定。ここでは未使用）
  | null

/** 確信度の 3 段階（設計書 §2）。 */
export type Confidence = 'confirmed' | 'likely' | 'weak'

/** 1 観測点の逐次状態。キーは座標（siteKey）で管理する。 */
export interface SiteState {
  /** 短時間平均（value 単位） */
  sta: number
  /** 長時間平均（value 単位。トリガー中は凍結） */
  lta: number
  /** ばらつき（|value − lta| の EWMA） */
  sigma: number
  /** LTA/σ を凍結中か（トリガー発火中は基準を汚さない） */
  frozen: boolean
  /** 前フレームの value（立ち上がり検出用） */
  lastValue: number
  /** 最後にトリガーした dataTime(ms)。未トリガーは null */
  triggeredAt: number | null
  /** トリガー稼働率(duty cycle)の EWMA。鳴りっぱなしの故障観測点の識別に使う */
  triggerRate: number
  /** 故障観測点ガードの減衰重み（0=除外〜1=通常）。triggerRate から算出。補助（散在ノイズの主判別は空間連続性ゲート CONTIG_*） */
  noiseWeight: number
}

/** 継続中のトリガー点（② のクラスタリング対象。フレーム跨ぎで追跡）。 */
export interface ActiveTrigger {
  key: string
  lat: number
  lng: number
  /** 現エピソードの最初のトリガー時刻(ms)。波面フィットのオンセット時刻に使う */
  onsetMs: number
  /** 直近トリガー時刻(ms)。ACTIVE_WINDOW_MS 内なら「継続中」 */
  lastTrigMs: number
  /** エピソード中の最大 value */
  peakValue: number
  /** 直近の noiseWeight（鳴りっぱなしの故障観測点はクラスタリング入力から除外する） */
  noiseWeight: number
}

/** 検知イベント（多重地震・余震を同時に保持できる）。 */
export interface DetectionEvent {
  id: string
  /** 波面フィット由来の震源（最早オンセット点近傍）。フィット不能時は null */
  epicenter: [number, number] | null
  /**
   * 震源の方位（真北=0°・時計回り）。片側配置(type-B)で震源が沖のどちらにあるかを示す。
   * 2D 方位が定まらない（共線配置など）場合は null。
   */
  bearingDeg: number | null
  /** 片側配置か（海溝型 type-B）。true のとき epicenter は「最短距離の点」で沖合距離は不確実。 */
  oneSided: boolean
  originTimeMs: number
  /** リーキー積分値 S_k */
  score: number
  confidence: Confidence
  lastOnsetAtMs: number
  /** 参加観測点の座標キー */
  memberKeys: string[]
  /** 直近フレームのクラスタ規模（減衰フレームでの再分類に使う） */
  lastSize: number
  /** 直近フレームで波面フィットが成立したか（radial または平面波） */
  lastFitOk: boolean
  /** 直近フレームで radial フィット（震源を囲む配置）が成立したか。confirmed 判定に使う */
  lastRadialFitOk: boolean
  /** 直近フレームのクラスタ最大計測震度（value）。likely ゲート（振幅下限）に使う */
  lastPeak: number
  /** 直近フレームで空間連続性ゲートを通過したか（疎地域は免除で true） */
  lastSpatialOk: boolean
  /** 直近フレームの空間連続性（各メンバー近傍の反応割合の中央値）。診断用 */
  lastContiguity: number
}

/** 検知エンジンの全状態。localStorage に永続化する対象。 */
export interface DetectorState {
  /** 座標キー → 逐次状態 */
  sites: Record<string, SiteState>
  /** 継続中トリガー点（座標キー → ActiveTrigger） */
  activeTriggers: Record<string, ActiveTrigger>
  /** アクティブイベント集合 */
  events: DetectionEvent[]
  /** イベント ID 採番用の連番（決定性のため乱数・時刻を使わない） */
  nextEventId: number
  /** 連続性チェック用（前フレームの dataTime） */
  lastDataTimeMs: number
  /** ウォームアップ完了時刻(ms)。これ以前は確信度を confirmed に上げない */
  warmupUntilMs: number
}

/** 事前計算する静的な観測点メタ（座標キー → メタ）。検知中は不変で永続化不要。 */
export interface StationMeta {
  /** 地理ブロック（島・地域。海で分断） */
  blockId: string
  /** 観測網の内側か（方位カバレッジ十分か） */
  isNetworkInterior: boolean
  noiseEnv: 'urban' | 'volcanic' | 'quiet' | 'coastal'
}

/** 1 フレーム分の入力。 */
export interface Frame {
  dataTimeMs: number
  /** SiteCoords（座標の順序 = values の順序） */
  sites: [number, number][]
  /** indices（計測震度インデックス 0〜20） */
  values: number[]
  /** 欠測フラグ（あれば。true の点は状態更新から除外） */
  missing?: boolean[]
}

/** ① トリガー評価の結果（1 観測点分）。 */
export interface TriggerResult {
  key: string
  lat: number
  lng: number
  triggered: boolean
  path: TriggerPath
  /** 現フレームの value（計測震度） */
  value: number
  /** 立ち上がり中か（second onset 検出の素） */
  rising: boolean
  /** 観測点の noiseWeight（故障観測点ガードの減衰重み） */
  noiseWeight: number
}

/** 波面フィットの結果。 */
export interface WaveFit {
  epicenter: [number, number] | null
  /** 見かけ速度(km/s)。フィット不能時は NaN */
  velocityKmS: number
  /** 走時回帰の残差 RMS(秒)。フィット不能時は Infinity */
  residualRms: number
  /** 十分な点数・距離レンジ・物理的な速度でフィットできたか（radial または平面波のいずれか） */
  fitOk: boolean
  /**
   * radial フィット（震源＝最早点を囲む配置）が成立したか。confirmed 判定で「震源が良く拘束
   * されている」証拠として使う。片側配置（平面波のみ）で fitOk なときは false になる。
   */
  radialFitOk: boolean
  /**
   * 震源の方位（真北=0°・時計回り, [0,360)）。平面波スローネスフィット由来。
   * 片側配置(type-B)で「震源がどちらにあるか」を示す。2D 方位が定まらない場合は null。
   */
  bearingDeg: number | null
  /**
   * 片側配置か（海溝型 type-B）。アンカーから見たクラスタの方位ギャップが大きい状態。
   * true のとき沖合方向の距離は不確実で、震央点は「最短距離（陸側最寄り）」の近似となる。
   */
  oneSided: boolean
  /** アンカーから見たクラスタ点の最大方位ギャップ(度)。片側配置の指標。 */
  azimuthalGapDeg: number
}

// ============================================================
// パラメータ（設計書 §9。すべて value=計測震度 単位。実データ調整前提）
// ============================================================

export const PARAMS = {
  // ---- ① トリガー ----
  /** 短時間平均の時定数(ms) */
  STA_TAU_MS: 2_000,
  /** 長時間平均の時定数(ms) */
  LTA_TAU_MS: 45_000,
  /** 速い経路(delta): STA − LTA がこの値以上で発火（静穏点の床値。value 単位 ≒ 対数振幅比） */
  DELTA_TRIG: 1.0,
  /** 速い経路(delta)のノイズ正規化係数: 恒常ノイズ点は STA−LTA ≥ K_SIGMA_DELTA·σ を要求 */
  K_SIGMA_DELTA: 3.0,
  /** 速い経路(sigma): value ≥ LTA + K_SIGMA·σ で発火 */
  K_SIGMA: 4.0,
  /**
   * σ ベース発火の最小マージン(value)。σ→0（完全静穏）の点が微小変動で誤発火するのを防ぐ。
   * 実際の判定は value ≥ LTA + max(K_SIGMA·σ, SIGMA_FLOOR_MARGIN)。
   */
  SIGMA_FLOOR_MARGIN: 0.75,
  /** 遅い経路: 立ち上がりの急峻さを問わず value がこの絶対値以上で発火（0.5=震度1） */
  ABS_LEVEL: 0.5,
  /** 量子化ノイズ除去の絶対下限（-1.5 = index 3）。これ未満は常に非トリガー */
  TRIG_FLOOR: -1.5,
  /** 立ち上がり判定: 前フレームからの value 増分がこの値以上で rising=true */
  RISE_DELTA: 0.5,
  /** フレーム間隔がこの値を超えて飛んだら状態を不連続とみなしリセット */
  MAX_DT_GAP_MS: 10_000,
  /** ウォームアップ期間(ms)。起動後この間は確信度を confirmed に上げない */
  WARMUP_MS: 60_000,

  // ---- ② アソシエーション ----
  /** トリガー点が「継続中」とみなされる猶予(ms)。最後のトリガーからこの時間で失効 */
  ACTIVE_WINDOW_MS: 8_000,
  /** 空間クラスタの近傍リンク距離(km) */
  PROXIMITY_KM: 60,
  /** クラスタのシードからの直径上限(km)。巨大ブロブ融合を防ぐ */
  MAX_CLUSTER_RADIUS_KM: 300,
  /** シード成長の時空間ゲート許容(秒)。量子化・近接同時性を吸収しつつ非伝播な併合を弾く */
  CLUSTER_T_TOL_S: 3,
  /** イベント化に要する最小クラスタ点数（2点は隣接センサー誤作動と区別不可のため 3 以上）。疎地域の少数点判定は Phase 3 */
  MIN_EVENT_SIZE: 3,
  /**
   * confirmed に要する最小クラスタ点数（radial 裏取りあり＝震源を囲む配置）。3点は自由度1で偶然
   * 直線に乗る（スプリアスフィット）ため誤 confirmed の温床（並走検証で確認）。4点以上を要求する。
   */
  MIN_CONFIRM_SIZE: 4,
  /**
   * 片側配置（平面波フィットのみで radial 裏取りが無い type-B）で confirmed に上げるための最小点数。
   * 片側配置は震源位置が縮退し 4 点程度ではノイズ塊の偶然フィットと区別できない（並走検証で size4 の
   * 誤 confirmed を観測）。本物の海溝型 M4+ は陸側で多数点が並ぶため、多めの裏取りを要求する。
   */
  MIN_CONFIRM_SIZE_ONESIDED: 8,
  /**
   * likely 以上に上げるための最小クラスタ点数。少数点（size 3）は平常時ノイズが多く
   * （並走検証: 平常時の偽 likely はほぼ size3）、揺れの可能性として提示するには不足。
   * これ未満は weak 止まり（＝表示対象外）。
   */
  MIN_LIKELY_SIZE: 4,
  /**
   * likely 以上に上げるためのクラスタ最大計測震度の下限（0.0 = 震度0）。振幅が震度0 未満の
   * クラスタは都市ノイズ（並走検証: 夜間 size8 でも peak -1.0 の例）で、地震ではない。
   * 実地震は最低でも震度0 以上の点を含む（福岡 震度1 で peak 0.5）。
   */
  MIN_LIKELY_PEAK: 0.0,
  /** 波面フィットに要する最小点数 */
  MIN_FIT_POINTS: 3,
  /** 波面フィットに要する距離レンジ下限(km。縮退回避) */
  FIT_RANGE_MIN_KM: 15,
  /** 見かけ速度の許容下限・上限(km/s) */
  V_MIN_KMS: 2.0,
  V_MAX_KMS: 8.0,
  /** 既存イベントとの同一判定距離(km) */
  PENDING_MATCH_KM: 120,
  /**
   * 既存イベントへの帰属・イベント併合で「同一地震」とみなすメンバー観測点の重複率の下限。
   * 重複率 = |共通メンバー| / min(|クラスタ|, |イベント|)。震央が null（フィット失敗）やジッタで
   * 動いても、同じ観測点群が反応していれば同一イベントに再帰属・併合し、1 地震が複数 ID へ分裂
   * するのを防ぐ（設計書 §5-E）。
   */
  MERGE_MEMBER_FRAC: 0.34,
  /**
   * 片側配置(type-B)と判定する方位ギャップの下限(度)。アンカーから見たクラスタ点の最大方位
   * ギャップがこれ以上なら「震源を囲んでいない＝沖合距離が縮退」とみなす。
   * 内陸で囲まれた震源は通常 ≤120°、海溝型は陸側のみで ≥180° になる。
   */
  ONE_SIDED_GAP_DEG: 160,

  // ---- 故障観測点ガード（noiseWeight。設計書 §5-D）----
  // 単一観測点が鳴り続ける故障（stuck/暴走センサ）を、クラスタリング前に落とす補助的な仕組み。
  // 散在する地域性ノイズの主判別は空間連続性ゲート（下記 CONTIG_*）が担う。連続性ゲートは
  // クラスタ後に tier を決めるだけで、本物のクラスタに紛れ込んだ故障点の幾何汚染（震央・onset・
  // 波面フィットのずれ）は除けない。その一点をこの前処理が埋める。既定閾値では duty ~42.5%以上
  // （＝ほぼ鳴りっぱなし）の点のみが除外対象になる。
  /** トリガー稼働率(duty cycle)の EWMA 時定数(ms)。故障（鳴り続け）と一過性地震を分ける時間軸 */
  NOISE_TAU_MS: 600_000,
  /** 稼働率がこの値以下なら noiseWeight=1（通常）。一過性地震(60-120s)の稼働率上昇を許容 */
  NOISE_DUTY_LO: 0.25,
  /** 稼働率がこの値以上なら noiseWeight=0（故障観測点）。LO〜HI は線形補間 */
  NOISE_DUTY_HI: 0.6,
  /** noiseWeight がこの値未満の観測点はクラスタリング入力から除外する（故障観測点の排除） */
  NOISE_WEIGHT_MIN: 0.5,

  // ---- 空間連続性ゲート（面的な埋まり具合。ノイズ＝スカスカ / 実地震＝連続を判別）----
  /** 局所連続性を測る近傍半径(km)。各メンバーのこの範囲で「一緒に反応した割合」を見る */
  CONTIG_RADIUS_KM: 25,
  /**
   * likely 以上に要する局所連続性（メンバーごとの近傍反応割合の中央値）の下限。
   * 実データ検証: 実地震(福岡0.50/長野0.545) と 広域ノイズ(北関東≤0.30) が 0.30〜0.50 で分離。
   */
  CONTIG_MIN: 0.4,
  /** 疎地域ガードの局所密度を測る半径(km) */
  CONTIG_DENSITY_RADIUS_KM: 50,
  /**
   * 疎地域ガード: 震央周辺(CONTIG_DENSITY_RADIUS_KM)の観測点数がこの値未満なら連続性ゲートを
   * 適用しない（離島・沖合など元々スカスカな地域で実地震を潰さないため。設計書 §5-A）。
   */
  CONTIG_SPARSE_MIN: 15,

  // ---- ③ スコア・確信度 ----
  /** 波面残差 RMS の「良好」目安(秒) */
  RESID_GOOD_S: 3.0,
  /** リーキー積分の減衰率(1フレームあたり) */
  DECAY: 0.8,
  /** confirmed 発報のスコア上限しきい値 */
  S_ON: 1.5,
  /** likely のスコアしきい値 */
  S_LIKELY: 0.8,
  /** イベント維持の下限しきい値（下回ると終了判定へ） */
  S_OFF: 0.5,
  /** 無オンセットでの終了猶予(ms) */
  END_TIMEOUT_MS: 10_000,
  /** イベント強制終了の上限継続時間(ms) */
  MAX_EVENT_DURATION_MS: 300_000,
} as const

// ============================================================
// 内部ヘルパー
// ============================================================

/** 計測震度インデックス(0〜20) → 計測震度 value(-3.0〜7.0)。設計書 §3.2 */
export function indexToValue(index: number): number {
  return -3.0 + index * 0.5
}

/**
 * 座標 → 状態管理キー。小数第 3 位（約 100m）で丸めて安定化する。
 * sitelist 更新時の丸め誤差レベルの座標揺れで別キー扱いになるのを防ぐ。
 */
export function siteKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`
}

/**
 * Δt を考慮した EWMA 係数を返す。α = 1 − exp(−Δt/τ)。
 * フレーム欠損で Δt が伸びても時定数を保つ（設計書 §3.3-2）。
 */
export function ewmaAlpha(dtMs: number, tauMs: number): number {
  if (dtMs <= 0) return 0
  return 1 - Math.exp(-dtMs / tauMs)
}

/** 新規観測点の初期状態。初期 LTA は現在値に置く（ウォームアップで収束）。 */
function initSiteState(value: number): SiteState {
  return {
    sta: value,
    lta: value,
    sigma: 0,
    frozen: false,
    lastValue: value,
    triggeredAt: null,
    triggerRate: 0,
    noiseWeight: 1,
  }
}

/**
 * 1 観測点の逐次状態を更新し、トリガー判定を行う（純粋）。
 * @param prev 前状態（無ければ null で新規初期化）
 * @param value 現フレームの計測震度
 * @param dtMs 前フレームからの経過時間
 * @param dataTimeMs 現フレームのデータ時刻
 * @returns 更新後状態とトリガー結果（path/triggered/rising）
 */
export function updateSiteState(
  prev: SiteState | null,
  value: number,
  dtMs: number,
  dataTimeMs: number,
): { state: SiteState; path: TriggerPath; triggered: boolean; rising: boolean } {
  if (prev == null) {
    const state = initSiteState(value)
    return { state, path: null, triggered: false, rising: false }
  }

  const aSta = ewmaAlpha(dtMs, PARAMS.STA_TAU_MS)
  const aLta = ewmaAlpha(dtMs, PARAMS.LTA_TAU_MS)

  // STA は常に追随。LTA/σ は凍結中は更新しない（基準汚染＝余震マスキング防止）。
  const sta = prev.sta + aSta * (value - prev.sta)
  const lta = prev.frozen ? prev.lta : prev.lta + aLta * (value - prev.lta)
  const sigma = prev.frozen
    ? prev.sigma
    : prev.sigma + aLta * (Math.abs(value - lta) - prev.sigma)

  // ---- トリガー評価 ----
  const rising = value - prev.lastValue >= PARAMS.RISE_DELTA
  let path: TriggerPath = null
  let triggered = false

  if (value >= PARAMS.TRIG_FLOOR) {
    // delta 経路も per-point ノイズで正規化する（静穏点は DELTA_TRIG 床、恒常ノイズ点は k·σ を要求）。
    // 実データの過検知対策（並走検証で判明。σ を見ない素の delta は都市微動で誤発火する）。
    const fastByDelta = sta - lta >= Math.max(PARAMS.DELTA_TRIG, PARAMS.K_SIGMA_DELTA * sigma)
    const sigmaMargin = Math.max(PARAMS.K_SIGMA * sigma, PARAMS.SIGMA_FLOOR_MARGIN)
    const fastBySigma = value >= lta + sigmaMargin
    if (fastByDelta || fastBySigma) {
      path = 'fast'
      triggered = true
    } else if (value >= PARAMS.ABS_LEVEL) {
      path = 'slow'
      triggered = true
    }
  }

  // 故障観測点ガード: トリガー稼働率(duty cycle)を長時定数 EWMA で追跡し、
  // 鳴りっぱなしの故障点の noiseWeight を下げる。一過性の地震は稼働率がほとんど上がらない。
  // （散在する地域性ノイズの主判別は空間連続性ゲート。ここは単一故障点を落とす補助的役割。）
  const aNoise = ewmaAlpha(dtMs, PARAMS.NOISE_TAU_MS)
  const triggerRate = prev.triggerRate + aNoise * ((triggered ? 1 : 0) - prev.triggerRate)
  const noiseWeight = clamp(
    1 - (triggerRate - PARAMS.NOISE_DUTY_LO) / (PARAMS.NOISE_DUTY_HI - PARAMS.NOISE_DUTY_LO),
    0,
    1,
  )

  const state: SiteState = {
    sta,
    lta,
    sigma,
    // トリガー中は次フレームで LTA/σ を凍結する
    frozen: triggered,
    lastValue: value,
    triggeredAt: triggered ? dataTimeMs : prev.triggeredAt,
    triggerRate,
    noiseWeight,
  }
  return { state, path, triggered, rising }
}

// ============================================================
// ② 時空間アソシエーション
// ============================================================

/**
 * 継続中トリガー点をクラスタに分割する（時空間ゲート付きシード成長）。
 *
 * 単純な単一連結（union-find）は、広域で揺れると近接点が数珠つなぎになり felt エリア全体を
 * 巨大ブロブに融合する（並走検証で判明）。これを避けるため、最早オンセット点をシードに、
 * 幅優先で近傍リンク（PROXIMITY_KM）を辿りつつ、採否は**シード基準の時空間妥当性**で決める:
 *  - シードからの距離が MAX_CLUSTER_RADIUS_KM 以内
 *  - オンセット遅延 dt が波面として妥当: dt ∈ [r/V_MAX, r/V_MIN] ± CLUSTER_T_TOL_S
 * これにより、非伝播な同時多発・ノイズは弾かれ、本物の伝播波面（遠いほど遅い）は 1 クラスタに保たれる。
 *
 * @returns クラスタ（ActiveTrigger の配列）の配列
 */
export function clusterActive(triggers: ActiveTrigger[]): ActiveTrigger[][] {
  const sorted = [...triggers].sort((a, b) => a.onsetMs - b.onsetMs)
  const assigned = new Set<string>()
  const clusters: ActiveTrigger[][] = []

  for (const seed of sorted) {
    if (assigned.has(seed.key)) continue
    const cluster = [seed]
    assigned.add(seed.key)
    const queue: ActiveTrigger[] = [seed]

    while (queue.length > 0) {
      const p = queue.shift() as ActiveTrigger
      for (const q of sorted) {
        if (assigned.has(q.key)) continue
        // 空間リンク: 既存メンバー p の近傍にあること（連結性）
        if (haversineKm(p.lat, p.lng, q.lat, q.lng) > PARAMS.PROXIMITY_KM) continue
        // 直径上限: シードから離れすぎない
        const rFromSeed = haversineKm(seed.lat, seed.lng, q.lat, q.lng)
        if (rFromSeed > PARAMS.MAX_CLUSTER_RADIUS_KM) continue
        // 時空間ゲート: シード基準のオンセット遅延が波面として妥当か
        const dt = (q.onsetMs - seed.onsetMs) / 1000
        const minDt = rFromSeed / PARAMS.V_MAX_KMS - PARAMS.CLUSTER_T_TOL_S
        const maxDt = rFromSeed / PARAMS.V_MIN_KMS + PARAMS.CLUSTER_T_TOL_S
        if (dt < minDt || dt > maxDt) continue

        cluster.push(q)
        assigned.add(q.key)
        queue.push(q)
      }
    }
    clusters.push(cluster)
  }
  return clusters
}

const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length

/**
 * アンカー点から見たクラスタ各点の最大方位ギャップ(度)を返す。
 * 震源を囲む配置ならギャップは小さく、陸側のみ（海溝型 type-B）なら 180° 以上になる。
 * 方位を評価できる点が 2 未満のときはカバレッジ無しとみなし 360 を返す。
 */
function azimuthalGap(anchor: ActiveTrigger, cluster: ActiveTrigger[]): number {
  const azimuths: number[] = []
  for (const p of cluster) {
    if (p === anchor) continue
    if (haversineKm(anchor.lat, anchor.lng, p.lat, p.lng) < 1e-6) continue
    azimuths.push(bearingDeg(anchor.lat, anchor.lng, p.lat, p.lng))
  }
  if (azimuths.length < 2) return 360
  azimuths.sort((a, b) => a - b)
  let maxGap = 0
  for (let i = 1; i < azimuths.length; i++) {
    maxGap = Math.max(maxGap, azimuths[i] - azimuths[i - 1])
  }
  // 端点の回り込み（最大方位→最小方位を 360 経由で結ぶ）
  maxGap = Math.max(maxGap, 360 - azimuths[azimuths.length - 1] + azimuths[0])
  return maxGap
}

/**
 * 平面波スローネスフィット。局所平面(ENU, km)で t ≈ t0 + px·E + py·N を最小二乗する。
 * スローネスベクトル (px, py)[s/km] は波の伝播方向（走時が増える向き）を指すため、
 * その逆方向が震源方位、大きさの逆数が見かけ速度になる。
 *
 * 片側配置（海溝型）では震源を「点」で当てられなくても**方位は堅牢に決まる**。
 * 一方、沖合距離は波面の曲率（1 秒量子化に埋もれる二次効果）からしか出ず復元不能なため、
 * ここでは距離を推定せず方位のみを返す（設計書 §5-B）。
 * 共線配置は 2D スローネスが退化する（det≤0）ため ok=false（方位不定）。
 */
function planeWaveFit(cluster: ActiveTrigger[]): {
  ok: boolean
  bearingDeg: number
  velocityKmS: number
  residualRms: number
} {
  const FAIL = { ok: false, bearingDeg: NaN, velocityKmS: NaN, residualRms: Infinity }
  const n = cluster.length
  const lat0 = mean(cluster.map((p) => p.lat))
  const lng0 = mean(cluster.map((p) => p.lng))
  const cosLat = Math.cos((lat0 * Math.PI) / 180)
  const E = cluster.map((p) => (p.lng - lng0) * KM_PER_DEG * cosLat)
  const N = cluster.map((p) => (p.lat - lat0) * KM_PER_DEG)
  const T = cluster.map((p) => p.onsetMs / 1000)
  const mE = mean(E)
  const mN = mean(N)
  const mT = mean(T)
  let SEE = 0
  let SNN = 0
  let SEN = 0
  let SEt = 0
  let SNt = 0
  for (let i = 0; i < n; i++) {
    const de = E[i] - mE
    const dn = N[i] - mN
    const dt = T[i] - mT
    SEE += de * de
    SNN += dn * dn
    SEN += de * dn
    SEt += de * dt
    SNt += dn * dt
  }
  // 開口（配置の 2D 広がり）が狭いと走時差が量子化に埋もれ、見かけ速度が偶然物理域に入る
  // スプリアスフィットを生む。radial の距離レンジ下限と同じ FIT_RANGE_MIN_KM を課す。
  const apertureKm = Math.hypot(
    Math.max(...E) - Math.min(...E),
    Math.max(...N) - Math.min(...N),
  )
  if (apertureKm < PARAMS.FIT_RANGE_MIN_KM) return FAIL
  const det = SEE * SNN - SEN * SEN
  if (det <= 0) return FAIL
  const px = (SNN * SEt - SEN * SNt) / det
  const py = (SEE * SNt - SEN * SEt) / det
  const slow = Math.hypot(px, py)
  if (slow <= 0) return FAIL
  const velocityKmS = 1 / slow
  const a = mT - px * mE - py * mN
  let sqErr = 0
  for (let i = 0; i < n; i++) {
    const pred = a + px * E[i] + py * N[i]
    sqErr += (T[i] - pred) ** 2
  }
  const residualRms = Math.sqrt(sqErr / n)
  // 震源方位 = 伝播方向 (px,py) の逆向き。ENU なので atan2(East, North)=コンパス方位。
  const back = ((Math.atan2(-px, -py) * 180) / Math.PI + 360) % 360
  const ok = velocityKmS >= PARAMS.V_MIN_KMS && velocityKmS <= PARAMS.V_MAX_KMS
  return { ok, bearingDeg: back, velocityKmS, residualRms }
}

/**
 * クラスタの波面フィット。震央アンカーは最早オンセット点（最短距離の点）に置く。
 *
 * 2 系統を併用する:
 *  - **radial フィット**: アンカーからの距離と走時の 1D 回帰。観測点が震源を囲む内陸浅発で有効
 *    （最早点 ≈ 震央）。
 *  - **平面波フィット**: 局所平面での 2D スローネス。片側配置（海溝型 type-B）で radial が壊れても
 *    震源**方位**を堅牢に出す。
 * どちらかが物理的に成立すれば fitOk とする。方位ギャップが大きければ oneSided（沖合距離は不確実）。
 * グリッド探索による震央の点推定は採らない（片側配置では 1 秒量子化で radial 方向が不安定なため）。
 */
export function estimateWaveFit(cluster: ActiveTrigger[]): WaveFit {
  // 最早オンセット点を震源アンカー（最短距離の点）にする
  let earliest = cluster[0]
  for (const p of cluster) if (p.onsetMs < earliest.onsetMs) earliest = p
  const epicenter: [number, number] = [earliest.lat, earliest.lng]

  if (cluster.length < PARAMS.MIN_FIT_POINTS) {
    return {
      epicenter,
      velocityKmS: NaN,
      residualRms: Infinity,
      fitOk: false,
      radialFitOk: false,
      bearingDeg: null,
      oneSided: false,
      azimuthalGapDeg: 0,
    }
  }

  // ---- radial フィット: t = a + b·r（b = 1/見かけ速度[s/km]） ----
  const t0 = earliest.onsetMs
  const rs = cluster.map((p) => haversineKm(epicenter[0], epicenter[1], p.lat, p.lng))
  const ts = cluster.map((p) => (p.onsetMs - t0) / 1000)
  const range = Math.max(...rs) - Math.min(...rs)
  const n = rs.length
  const meanR = mean(rs)
  const meanT = mean(ts)
  let sRR = 0
  let sRT = 0
  for (let i = 0; i < n; i++) {
    sRR += (rs[i] - meanR) ** 2
    sRT += (rs[i] - meanR) * (ts[i] - meanT)
  }
  const b = sRR > 0 ? sRT / sRR : 0
  const a = meanT - b * meanR
  let sqErr = 0
  for (let i = 0; i < n; i++) {
    const pred = a + b * rs[i]
    sqErr += (ts[i] - pred) ** 2
  }
  const residualRadial = Math.sqrt(sqErr / n)
  const vRadial = b > 0 ? 1 / b : NaN
  const radialFitOk =
    range >= PARAMS.FIT_RANGE_MIN_KM &&
    b > 0 &&
    vRadial >= PARAMS.V_MIN_KMS &&
    vRadial <= PARAMS.V_MAX_KMS

  // ---- 平面波フィット（方位）＋方位カバレッジ ----
  const plane = planeWaveFit(cluster)
  const gap = azimuthalGap(earliest, cluster)
  const oneSided = gap >= PARAMS.ONE_SIDED_GAP_DEG

  // radial が成立すればその速度・残差を、そうでなければ平面波フィットのものを採用する。
  const fitOk = radialFitOk || plane.ok
  const velocityKmS = radialFitOk ? vRadial : plane.ok ? plane.velocityKmS : NaN
  const residualRms = radialFitOk ? residualRadial : plane.ok ? plane.residualRms : Infinity
  const bearingDeg = plane.ok ? plane.bearingDeg : null

  return {
    epicenter,
    velocityKmS,
    residualRms,
    fitOk,
    radialFitOk,
    bearingDeg,
    oneSided,
    azimuthalGapDeg: gap,
  }
}

/**
 * クラスタ規模・振幅・波面フィット品質・空間連続性から、1 フレームの「地震らしさ」寄与 s を算出する。
 *
 * 設計（並走検証で改訂）: 旧実装は size を 8 で頭打ちにし振幅を無視していたため、大規模・高震度の
 * 実地震（例: 大隅 M5.2 size108 震度3）が片側配置の高残差で waveFactor が下限に落ちて潰れ、likely
 * 止まりだった。実地震とノイズを分ける材料（規模・振幅・連続性）をすべて score に反映する:
 *  - sizeTerm  : size の平方根で逓減しつつ頭打ちを外す（大規模を正当に評価）。
 *  - ampTerm   : クラスタ最大計測震度。実地震は震度が高く、ノイズは震度0近傍（＝confirmed 排除の要）。
 *  - waveFactor: フィット残差の良さ。片側配置の高残差でも下限を上げ、強いクラスタを潰さない。
 *  - contigFactor: 面の埋まり具合。連続性ゲート(CONTIG_MIN)近傍のノイズを穏やかに減点する。
 * DECAY のとき定常 S ≈ s/(1−DECAY)。s≈0.3 で S_ON、s≈0.16 で S_LIKELY に到達する目安。
 *
 * @param size クラスタの観測点数
 * @param peak クラスタ最大計測震度（value。震度0≈0, 震度1≈0.5, 震度2≈1.5, 震度3≈2.5）
 * @param fit 波面フィット結果
 * @param contiguity 空間連続性（spatialFill。0〜1）
 */
export function frameScore(size: number, peak: number, fit: WaveFit, contiguity: number): number {
  const sizeTerm = 0.25 + 0.06 * Math.sqrt(Math.max(size, 0))
  const ampTerm = clamp(0.7 + 0.3 * peak, 0.7, 1.6)
  const waveFactor = fit.fitOk
    ? clamp(1.2 - fit.residualRms / PARAMS.RESID_GOOD_S, 0.45, 1.0)
    : 0.35
  const contigFactor = clamp(0.6 + 0.7 * contiguity, 0.6, 1.2)
  return sizeTerm * ampTerm * waveFactor * contigFactor
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/**
 * スコア・規模・フィット・ウォームアップから確信度を分類する。
 *
 * likely 以上には**波面フィットの成立（伝播整合）を必須**とする。空間規模だけで likely に
 * 上げると、大きなノイズクラスタが誤って likely になる（並走検証で判明）。fitOk でなければ weak 止まり。
 *
 * confirmed には**震源拘束の強さ**で非対称なゲートを課す:
 *  - radial 裏取りあり（震源を囲む配置）: MIN_CONFIRM_SIZE で確定可（震源が良く決まる）。
 *  - 片側配置（平面波のみ・radialFitOk=false）: MIN_CONFIRM_SIZE_ONESIDED まで点数を要求する。
 *    片側配置は震源が縮退し、少数点ではノイズ塊の偶然フィットと区別できない（並走検証で size4 の
 *    誤 confirmed を観測）ため。本物の海溝型は陸側で多数点が並ぶので確定できる（設計書 §5-B）。
 */
/**
 * クラスタの空間的な「埋まり具合」を測る（設計書 §5-D）。
 * 実地震は felt エリア内の観測点が連続的にほぼ全て反応する（高い連続性）が、
 * 広域ノイズは間に非反応点が挟まりスカスカになる（低い連続性）。地域に依らない per-cluster 量。
 *
 * @param cluster クラスタ（反応中の観測点）
 * @param allSites 現フレームの全観測点座標（非反応点を知るために必要）
 * @returns contiguity（各メンバー近傍の反応割合の中央値）と densityNear（震央周辺の観測点数）
 */
export function spatialFill(
  cluster: ActiveTrigger[],
  allSites: [number, number][],
): { contiguity: number; densityNear: number } {
  const memberSet = new Set(cluster.map((c) => c.key))
  const cLat = mean(cluster.map((c) => c.lat))
  const cLng = mean(cluster.map((c) => c.lng))

  let densityNear = 0
  for (const s of allSites) {
    if (haversineKm(cLat, cLng, s[0], s[1]) <= PARAMS.CONTIG_DENSITY_RADIUS_KM) densityNear++
  }

  const contigs: number[] = []
  for (const m of cluster) {
    let near = 0
    let nearMembers = 0
    for (const s of allSites) {
      if (haversineKm(m.lat, m.lng, s[0], s[1]) <= PARAMS.CONTIG_RADIUS_KM) {
        near++
        if (memberSet.has(siteKey(s[0], s[1]))) nearMembers++
      }
    }
    if (near > 0) contigs.push(nearMembers / near)
  }
  contigs.sort((a, b) => a - b)
  const contiguity = contigs.length > 0 ? contigs[Math.floor(contigs.length / 2)] : 0
  return { contiguity, densityNear }
}

export function classify(
  score: number,
  size: number,
  peak: number,
  fitOk: boolean,
  radialFitOk: boolean,
  spatialOk: boolean,
  warmup: boolean,
): Confidence {
  // likely 以上の下限ゲート（平常時ノイズ抑制。並走検証で決定）:
  //  - 波面フィット成立（伝播整合）
  //  - 空間連続性（面が埋まっている＝実地震。スカスカ＝広域ノイズを除外。疎地域は spatialOk=true で免除）
  //  - クラスタ点数が少数点ノイズを超える（MIN_LIKELY_SIZE）
  //  - クラスタ最大振幅が震度0 以上（MIN_LIKELY_PEAK。低振幅の都市ノイズを除外）
  if (!fitOk || !spatialOk || size < PARAMS.MIN_LIKELY_SIZE || peak < PARAMS.MIN_LIKELY_PEAK)
    return 'weak'

  const confirmSize = radialFitOk ? PARAMS.MIN_CONFIRM_SIZE : PARAMS.MIN_CONFIRM_SIZE_ONESIDED
  let c: Confidence = 'weak'
  if (score >= PARAMS.S_ON && size >= confirmSize) c = 'confirmed'
  else if (score >= PARAMS.S_LIKELY) c = 'likely'
  // ウォームアップ中は confirmed に上げない（設計書 §7.4）
  if (warmup && c === 'confirmed') c = 'likely'
  return c
}

// ============================================================
// step（設計書 §7.1）
// ============================================================

/** 空の検知状態を生成する（コールドスタート用）。 */
export function initState(dataTimeMs = 0): DetectorState {
  return {
    sites: {},
    activeTriggers: {},
    events: [],
    nextEventId: 1,
    lastDataTimeMs: dataTimeMs,
    warmupUntilMs: dataTimeMs + PARAMS.WARMUP_MS,
  }
}

/**
 * 1 フレーム分の状態遷移（純粋）。1 秒ごとに呼ぶ。
 *
 * ① 各観測点のトリガー判定 → ② 継続トリガーのクラスタリング・波面フィット・イベント帰属
 * → ③ リーキー積分・確信度分類・終了判定、の順で処理する。
 *
 * @param state 前状態
 * @param frame 現フレーム
 * @param _meta 静的観測点メタ（Phase 3 の地域類型で使用。現状未使用）
 */
export function step(
  state: DetectorState,
  frame: Frame,
  _meta?: Record<string, StationMeta>,
): { state: DetectorState; detections: DetectionEvent[]; triggers: TriggerResult[] } {
  const now = frame.dataTimeMs
  const dtMs = now - state.lastDataTimeMs

  // 不連続（大きな時刻ジャンプ・巻き戻し）は状態をリセットして作り直す（設計書 §3.3-2,3）。
  if (dtMs <= 0 || dtMs > PARAMS.MAX_DT_GAP_MS) {
    const rebuilt = ingestWithoutTrigger(initState(now), frame)
    return { state: rebuilt, detections: [], triggers: [] }
  }

  // ---- ① トリガー ----
  const sites: Record<string, SiteState> = {}
  const triggers: TriggerResult[] = []
  for (let i = 0; i < frame.values.length; i++) {
    if (frame.missing?.[i]) continue
    const [lat, lng] = frame.sites[i]
    const key = siteKey(lat, lng)
    const value = indexToValue(frame.values[i])
    const prev = state.sites[key] ?? null

    const { state: next, path, triggered, rising } = updateSiteState(prev, value, dtMs, now)
    sites[key] = next
    if (triggered)
      triggers.push({ key, lat, lng, triggered, path, value, rising, noiseWeight: next.noiseWeight })
  }

  // ---- ② 継続トリガーの更新（フレーム跨ぎ）----
  const activeTriggers = updateActiveTriggers(state.activeTriggers, triggers, now)

  // ---- ② クラスタリング＋波面フィット → ③ イベント帰属・積分 ----
  // 鳴りっぱなしの故障観測点（noiseWeight 低）をクラスタリング入力から除外する補助ガード（§5-D）。
  // 散在する地域性ノイズの主判別はクラスタ後の空間連続性ゲート（spatialFill）が担う。
  const clusterInput = Object.values(activeTriggers).filter(
    (at) => at.noiseWeight >= PARAMS.NOISE_WEIGHT_MIN,
  )
  const clusters = clusterActive(clusterInput).filter((c) => c.length >= PARAMS.MIN_EVENT_SIZE)
  const warmup = now < state.warmupUntilMs
  const { events, nextEventId } = associateAndScore(
    state.events,
    state.nextEventId,
    clusters,
    frame.sites,
    now,
    warmup,
  )

  const nextState: DetectorState = {
    sites,
    activeTriggers,
    events,
    nextEventId,
    lastDataTimeMs: now,
    warmupUntilMs: state.warmupUntilMs,
  }
  // detections はアクティブな全イベント（確信度は各々の tier で表現）。スコア降順。
  const detections = [...events].sort((x, y) => y.score - x.score)
  return { state: nextState, detections, triggers }
}

/** 継続トリガー点を更新する。今フレームのトリガーで onset を追跡し、失効分を落とす。 */
function updateActiveTriggers(
  prev: Record<string, ActiveTrigger>,
  triggers: TriggerResult[],
  now: number,
): Record<string, ActiveTrigger> {
  const next: Record<string, ActiveTrigger> = {}
  // 既存の継続点を引き継ぐ（失効していないもの）
  for (const at of Object.values(prev)) {
    if (now - at.lastTrigMs <= PARAMS.ACTIVE_WINDOW_MS) next[at.key] = { ...at }
  }
  // 今フレームのトリガーを反映
  for (const t of triggers) {
    const existing = next[t.key]
    if (existing) {
      existing.lastTrigMs = now
      existing.peakValue = Math.max(existing.peakValue, t.value)
      existing.noiseWeight = t.noiseWeight
    } else {
      next[t.key] = {
        key: t.key,
        lat: t.lat,
        lng: t.lng,
        onsetMs: now,
        lastTrigMs: now,
        peakValue: t.value,
        noiseWeight: t.noiseWeight,
      }
    }
  }
  return next
}

/**
 * クラスタを既存イベントに帰属（震源近接）or 新規生成し、③ リーキー積分・確信度分類・終了判定を行う。
 */
function associateAndScore(
  prevEvents: DetectionEvent[],
  nextEventId: number,
  clusters: ActiveTrigger[][],
  allSites: [number, number][],
  now: number,
  warmup: boolean,
): { events: DetectionEvent[]; nextEventId: number } {
  const events = prevEvents.map((e) => ({ ...e, memberKeys: [...e.memberKeys] }))
  const updated = new Set<string>()
  let idCounter = nextEventId

  for (const cluster of clusters) {
    const fit = estimateWaveFit(cluster)
    const epi = fit.epicenter
    const clusterPeak = Math.max(...cluster.map((c) => c.peakValue))
    const memberKeys = cluster.map((c) => c.key)
    // 空間連続性ゲート: 面が埋まっているか（実地震）／スカスカか（広域ノイズ）。
    // 疎地域（震央周辺の観測点数が少ない）は連続性が本質的に低いのでゲート免除。
    const { contiguity, densityNear } = spatialFill(cluster, allSites)
    const spatialOk = densityNear < PARAMS.CONTIG_SPARSE_MIN || contiguity >= PARAMS.CONTIG_MIN
    // score には規模・振幅・フィット品質・連続性を反映する（frameScore 参照）
    const s = frameScore(cluster.length, clusterPeak, fit, contiguity)

    // 既存イベントとの帰属判定: 震源近接（両方に震央がある場合）またはメンバー観測点の重複。
    // メンバー重複を併用することで、フィット失敗(epicenter=null)や震央ジッタでも同じ観測点群を
    // 同一イベントへ再帰属でき、1 地震が複数 ID に分裂するのを防ぐ（設計書 §5-E）。
    const memberSet = new Set(memberKeys)
    let target: DetectionEvent | undefined
    for (const e of events) {
      if (updated.has(e.id)) continue
      const epiClose =
        !!epi && !!e.epicenter &&
        haversineKm(epi[0], epi[1], e.epicenter[0], e.epicenter[1]) <= PARAMS.PENDING_MATCH_KM
      if (epiClose || memberOverlapFrac(memberSet, e.memberKeys) >= PARAMS.MERGE_MEMBER_FRAC) {
        target = e
        break
      }
    }

    if (target) {
      target.score = PARAMS.DECAY * target.score + s
      target.epicenter = epi
      target.bearingDeg = fit.bearingDeg
      target.oneSided = fit.oneSided
      target.lastOnsetAtMs = now
      target.lastSize = cluster.length
      target.lastFitOk = fit.fitOk
      target.lastRadialFitOk = fit.radialFitOk
      target.lastPeak = clusterPeak
      target.lastSpatialOk = spatialOk
      target.lastContiguity = contiguity
      target.memberKeys = [...new Set([...target.memberKeys, ...memberKeys])]
      target.confidence = classify(
        target.score,
        cluster.length,
        clusterPeak,
        fit.fitOk,
        fit.radialFitOk,
        spatialOk,
        warmup,
      )
      updated.add(target.id)
    } else {
      const score = s // 初回は DECAY·0 + s
      const ev: DetectionEvent = {
        id: `evt-${idCounter++}`,
        epicenter: epi,
        bearingDeg: fit.bearingDeg,
        oneSided: fit.oneSided,
        originTimeMs: now,
        score,
        confidence: classify(
          score,
          cluster.length,
          clusterPeak,
          fit.fitOk,
          fit.radialFitOk,
          spatialOk,
          warmup,
        ),
        lastOnsetAtMs: now,
        memberKeys,
        lastSize: cluster.length,
        lastFitOk: fit.fitOk,
        lastRadialFitOk: fit.radialFitOk,
        lastPeak: clusterPeak,
        lastSpatialOk: spatialOk,
        lastContiguity: contiguity,
      }
      events.push(ev)
      updated.add(ev.id)
    }
  }

  // 今フレームで更新されなかったイベントは減衰させ、終了判定する
  const survivors: DetectionEvent[] = []
  for (const e of events) {
    if (!updated.has(e.id)) {
      e.score = PARAMS.DECAY * e.score
      e.confidence = classify(
        e.score,
        e.lastSize,
        e.lastPeak,
        e.lastFitOk,
        e.lastRadialFitOk,
        e.lastSpatialOk,
        warmup,
      )
    }
    const idle = now - e.lastOnsetAtMs
    const duration = now - e.originTimeMs
    const terminated =
      (e.score < PARAMS.S_OFF && idle >= PARAMS.END_TIMEOUT_MS) ||
      duration >= PARAMS.MAX_EVENT_DURATION_MS
    if (!terminated) survivors.push(e)
  }

  // フレーム末に「同一地震」の分裂イベントを 1 本化する（設計書 §5-E）。
  return { events: mergeEvents(survivors, warmup), nextEventId: idCounter }
}

/** クラスタ(a)とイベント(bKeys)のメンバー観測点の重複率 = |a∩b| / min(|a|,|b|)。 */
export function memberOverlapFrac(a: Set<string>, bKeys: string[]): number {
  if (a.size === 0 || bKeys.length === 0) return 0
  let common = 0
  for (const k of bKeys) if (a.has(k)) common++
  return common / Math.min(a.size, bKeys.length)
}

/** フィット根拠の強さ（radial 裏取り > 平面波フィット成立 > フィット無し）。併合時の採用元選択に使う。 */
function fitRank(e: DetectionEvent): number {
  return e.lastRadialFitOk ? 2 : e.lastFitOk ? 1 : 0
}

/**
 * 併合時に震央・波面フィット系フィールドの採用元にするイベントを選ぶ。
 * 優先順: フィット根拠の強さ → 最大振幅 → 規模。
 */
function pickFitSource(a: DetectionEvent, b: DetectionEvent): DetectionEvent {
  const ra = fitRank(a)
  const rb = fitRank(b)
  if (ra !== rb) return ra > rb ? a : b
  if (a.lastPeak !== b.lastPeak) return a.lastPeak > b.lastPeak ? a : b
  return a.lastSize >= b.lastSize ? a : b
}

/**
 * 同一地震とみなせるイベント同士を 1 本化する（設計書 §5-E）。
 *
 * 帰属判定(associateAndScore)は updated 集合により 1 イベント=1 クラスタ/フレームに制限されるため、
 * 1 フレームで複数クラスタに割れた同一地震が別 ID として残り得る。フレーム末にこのパスで畳み込む。
 *
 * 併合条件: メンバー観測点の重複率 ≥ MERGE_MEMBER_FRAC、または両者の震央が PENDING_MATCH_KM 以内。
 * 基準イベント(host)は発生時刻が早い方。スコアは max（同一エネルギーの二重計上を避ける保守側）、
 * メンバーは和集合、震央・波面フィット系はフィット根拠が強い方から採用し、確信度を再評価する。
 */
export function mergeEvents(events: DetectionEvent[], warmup: boolean): DetectionEvent[] {
  if (events.length <= 1) return events
  const ordered = [...events].sort((a, b) => a.originTimeMs - b.originTimeMs)
  const hosts: DetectionEvent[] = []
  for (const e of ordered) {
    const eSet = new Set(e.memberKeys)
    const host = hosts.find(
      (h) =>
        memberOverlapFrac(eSet, h.memberKeys) >= PARAMS.MERGE_MEMBER_FRAC ||
        (!!e.epicenter && !!h.epicenter &&
          haversineKm(e.epicenter[0], e.epicenter[1], h.epicenter[0], h.epicenter[1]) <=
            PARAMS.PENDING_MATCH_KM),
    )
    if (!host) {
      hosts.push(e)
      continue
    }
    const fitSrc = pickFitSource(host, e)
    host.score = Math.max(host.score, e.score)
    host.memberKeys = [...new Set([...host.memberKeys, ...e.memberKeys])]
    host.originTimeMs = Math.min(host.originTimeMs, e.originTimeMs)
    host.lastOnsetAtMs = Math.max(host.lastOnsetAtMs, e.lastOnsetAtMs)
    host.epicenter = fitSrc.epicenter
    host.bearingDeg = fitSrc.bearingDeg
    host.oneSided = fitSrc.oneSided
    host.lastFitOk = fitSrc.lastFitOk
    host.lastRadialFitOk = fitSrc.lastRadialFitOk
    host.lastSpatialOk = fitSrc.lastSpatialOk
    host.lastContiguity = fitSrc.lastContiguity
    host.lastPeak = Math.max(host.lastPeak, e.lastPeak)
    host.lastSize = Math.max(host.lastSize, e.lastSize)
    host.confidence = classify(
      host.score,
      host.lastSize,
      host.lastPeak,
      host.lastFitOk,
      host.lastRadialFitOk,
      host.lastSpatialOk,
      warmup,
    )
  }
  return hosts
}

/**
 * トリガー判定を伴わずに全観測点の状態を初期化して取り込む。
 * 不連続リセット直後の 1 フレーム目に使う（この 1 フレームはトリガー対象にしない）。
 */
function ingestWithoutTrigger(state: DetectorState, frame: Frame): DetectorState {
  const sites: Record<string, SiteState> = {}
  for (let i = 0; i < frame.values.length; i++) {
    if (frame.missing?.[i]) continue
    const [lat, lng] = frame.sites[i]
    sites[siteKey(lat, lng)] = initSiteState(indexToValue(frame.values[i]))
  }
  return { ...state, sites, lastDataTimeMs: frame.dataTimeMs }
}
