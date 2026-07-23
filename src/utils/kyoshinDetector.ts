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

import { haversineKm } from './geo'

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
  /** 恒常ノイズ源の減衰重み（0=無効化〜1=通常） */
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
}

/** 検知イベント（多重地震・余震を同時に保持できる）。 */
export interface DetectionEvent {
  id: string
  /** 波面フィット由来の震源（最早オンセット点近傍）。フィット不能時は null */
  epicenter: [number, number] | null
  originTimeMs: number
  /** リーキー積分値 S_k */
  score: number
  confidence: Confidence
  lastOnsetAtMs: number
  /** 参加観測点の座標キー */
  memberKeys: string[]
  /** 直近フレームのクラスタ規模（減衰フレームでの再分類に使う） */
  lastSize: number
  /** 直近フレームで波面フィットが成立したか */
  lastFitOk: boolean
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
}

/** 波面フィットの結果。 */
export interface WaveFit {
  epicenter: [number, number] | null
  /** 見かけ速度(km/s)。フィット不能時は NaN */
  velocityKmS: number
  /** オンセット×距離 線形回帰の残差 RMS(秒)。フィット不能時は Infinity */
  residualRms: number
  /** 十分な点数・距離レンジ・物理的な速度でフィットできたか */
  fitOk: boolean
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
   * confirmed に要する最小クラスタ点数。3点は自由度1で偶然直線に乗る（スプリアスフィット）ため
   * 誤 confirmed の温床（並走検証で確認）。4点以上の裏取りを要求する。
   */
  MIN_CONFIRM_SIZE: 4,
  /** 波面フィットに要する最小点数 */
  MIN_FIT_POINTS: 3,
  /** 波面フィットに要する距離レンジ下限(km。縮退回避) */
  FIT_RANGE_MIN_KM: 15,
  /** 見かけ速度の許容下限・上限(km/s) */
  V_MIN_KMS: 2.0,
  V_MAX_KMS: 8.0,
  /** 既存イベントとの同一判定距離(km) */
  PENDING_MATCH_KM: 120,

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

  const state: SiteState = {
    sta,
    lta,
    sigma,
    // トリガー中は次フレームで LTA/σ を凍結する
    frozen: triggered,
    lastValue: value,
    triggeredAt: triggered ? dataTimeMs : prev.triggeredAt,
    noiseWeight: prev.noiseWeight,
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

/**
 * クラスタの波面フィット（軽量版）。
 * 震源を最早オンセット点に置き、オンセット時刻 t と震源距離 r の線形回帰で見かけ速度・残差を得る。
 * 地震なら「遠い点ほど遅い」ため残差が小さく傾きが正になる。ノイズは乗らない。
 * グリッド探索による震源推定は Phase 3。
 */
export function estimateWaveFit(cluster: ActiveTrigger[]): WaveFit {
  // 最早オンセット点を震源候補にする
  let earliest = cluster[0]
  for (const p of cluster) if (p.onsetMs < earliest.onsetMs) earliest = p
  const epicenter: [number, number] = [earliest.lat, earliest.lng]

  if (cluster.length < PARAMS.MIN_FIT_POINTS) {
    return { epicenter, velocityKmS: NaN, residualRms: Infinity, fitOk: false }
  }

  const t0 = earliest.onsetMs
  const rs: number[] = []
  const ts: number[] = []
  for (const p of cluster) {
    rs.push(haversineKm(epicenter[0], epicenter[1], p.lat, p.lng))
    ts.push((p.onsetMs - t0) / 1000) // 秒
  }
  const range = Math.max(...rs) - Math.min(...rs)
  if (range < PARAMS.FIT_RANGE_MIN_KM) {
    return { epicenter, velocityKmS: NaN, residualRms: Infinity, fitOk: false }
  }

  // 線形回帰 t = a + b·r（b = 1/見かけ速度[s/km]）
  const n = rs.length
  const meanR = rs.reduce((s, v) => s + v, 0) / n
  const meanT = ts.reduce((s, v) => s + v, 0) / n
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
  const residualRms = Math.sqrt(sqErr / n)
  const velocityKmS = b > 0 ? 1 / b : NaN
  const fitOk =
    b > 0 && velocityKmS >= PARAMS.V_MIN_KMS && velocityKmS <= PARAMS.V_MAX_KMS

  return { epicenter, velocityKmS, residualRms, fitOk }
}

/**
 * クラスタ規模と波面フィット品質から、1 フレームの「地震らしさ」スコア寄与 s を算出する。
 * DECAY=0.8 のとき定常で S ≈ s/(1−DECAY)=5s に収束するため、s≈0.3 で S_ON に到達する目安。
 */
export function frameScore(size: number, fit: WaveFit): number {
  const sizeTerm = 0.25 + 0.05 * Math.min(size, 8)
  const waveFactor = fit.fitOk
    ? clamp(1.2 - fit.residualRms / PARAMS.RESID_GOOD_S, 0.3, 1.0)
    : 0.3
  return sizeTerm * waveFactor
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/**
 * スコア・規模・フィット・ウォームアップから確信度を分類する。
 * likely 以上には**波面フィットの成立（伝播整合）を必須**とする。空間規模だけで likely に
 * 上げると、大きなノイズクラスタが誤って likely になる（並走検証で判明）。fitOk でなければ weak 止まり。
 */
function classify(score: number, size: number, fitOk: boolean, warmup: boolean): Confidence {
  let c: Confidence = 'weak'
  if (fitOk && score >= PARAMS.S_ON && size >= PARAMS.MIN_CONFIRM_SIZE) c = 'confirmed'
  else if (fitOk && score >= PARAMS.S_LIKELY) c = 'likely'
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
    if (triggered) triggers.push({ key, lat, lng, triggered, path, value, rising })
  }

  // ---- ② 継続トリガーの更新（フレーム跨ぎ）----
  const activeTriggers = updateActiveTriggers(state.activeTriggers, triggers, now)

  // ---- ② クラスタリング＋波面フィット → ③ イベント帰属・積分 ----
  const clusters = clusterActive(Object.values(activeTriggers)).filter(
    (c) => c.length >= PARAMS.MIN_EVENT_SIZE,
  )
  const warmup = now < state.warmupUntilMs
  const { events, nextEventId } = associateAndScore(
    state.events,
    state.nextEventId,
    clusters,
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
    } else {
      next[t.key] = {
        key: t.key,
        lat: t.lat,
        lng: t.lng,
        onsetMs: now,
        lastTrigMs: now,
        peakValue: t.value,
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
  now: number,
  warmup: boolean,
): { events: DetectionEvent[]; nextEventId: number } {
  const events = prevEvents.map((e) => ({ ...e, memberKeys: [...e.memberKeys] }))
  const updated = new Set<string>()
  let idCounter = nextEventId

  for (const cluster of clusters) {
    const fit = estimateWaveFit(cluster)
    const epi = fit.epicenter
    const s = frameScore(cluster.length, fit)
    const memberKeys = cluster.map((c) => c.key)

    // 既存イベントとの帰属判定（震源が PENDING_MATCH_KM 以内）
    let target: DetectionEvent | undefined
    if (epi) {
      for (const e of events) {
        if (updated.has(e.id) || !e.epicenter) continue
        const d = haversineKm(epi[0], epi[1], e.epicenter[0], e.epicenter[1])
        if (d <= PARAMS.PENDING_MATCH_KM) {
          target = e
          break
        }
      }
    }

    if (target) {
      target.score = PARAMS.DECAY * target.score + s
      target.epicenter = epi
      target.lastOnsetAtMs = now
      target.lastSize = cluster.length
      target.lastFitOk = fit.fitOk
      target.memberKeys = [...new Set([...target.memberKeys, ...memberKeys])]
      target.confidence = classify(target.score, cluster.length, fit.fitOk, warmup)
      updated.add(target.id)
    } else {
      const score = s // 初回は DECAY·0 + s
      const ev: DetectionEvent = {
        id: `evt-${idCounter++}`,
        epicenter: epi,
        originTimeMs: now,
        score,
        confidence: classify(score, cluster.length, fit.fitOk, warmup),
        lastOnsetAtMs: now,
        memberKeys,
        lastSize: cluster.length,
        lastFitOk: fit.fitOk,
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
      e.confidence = classify(e.score, e.lastSize, e.lastFitOk, warmup)
    }
    const idle = now - e.lastOnsetAtMs
    const duration = now - e.originTimeMs
    const terminated =
      (e.score < PARAMS.S_OFF && idle >= PARAMS.END_TIMEOUT_MS) ||
      duration >= PARAMS.MAX_EVENT_DURATION_MS
    if (!terminated) survivors.push(e)
  }

  return { events: survivors, nextEventId: idCounter }
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
