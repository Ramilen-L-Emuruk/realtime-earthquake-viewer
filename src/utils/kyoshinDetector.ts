/**
 * 強震モニタ地震検知エンジン（純粋コア）。
 *
 * 設計書: docs/kyoshin-detection-design.md
 * React から切り離した純粋関数として実装する（副作用・現在時刻の直接参照を持たない。
 * 時刻はすべて frame.dataTimeMs から供給する）。決定的で単体テスト可能。
 *
 * このファイルは Phase 1（純粋コア骨格 ＋ ① 自己正規化トリガー）を実装する。
 * ② 時空間アソシエーション・③ 確信度スコア積分は後続フェーズで実装するため、
 * 現時点では step() の該当箇所をスタブにしてある。
 *
 * 【単位に関する設計判断（設計書 §5① の refinement）】
 * 強震モニタの値は計測震度（≒ 地動振幅の対数）で、-3.0〜7.0 の連続値。
 * 対数スケールのため、STA/LTA の「比」ではなく「差 (STA − LTA)」を用いる。
 * 差はそのまま線形振幅の対数比に相当し、オフセットを持つ index の比より物理的に正しい。
 * 本コアは全体を value（計測震度）単位で扱い、境界で index → value 変換する。
 */

// ============================================================
// 型定義（設計書 §7.1）
// ============================================================

/** トリガーの発火経路。 */
export type TriggerPath =
  | 'fast' // 急オンセット（STA−LTA・立ち上がり）
  | 'slow' // 絶対レベル（ゆっくり成長する強い揺れ）
  | 'sync' // 空間同期（Phase 2 の ② で判定。ここでは未使用）
  | null

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

/** 検知イベント（多重地震・余震を同時に保持できる）。Phase 2 以降で本格利用。 */
export interface DetectionEvent {
  id: string
  /** 波面フィット由来の震源。少数点・遠地では null */
  epicenter: [number, number] | null
  originTimeMs: number
  /** リーキー積分値 S_k */
  score: number
  confidence: 'confirmed' | 'likely' | 'weak'
  lastOnsetAtMs: number
  /** 参加観測点の座標キー */
  memberKeys: string[]
}

/** 検知エンジンの全状態。localStorage に永続化する対象。 */
export interface DetectorState {
  /** 座標キー → 逐次状態 */
  sites: Record<string, SiteState>
  /** アクティブイベント集合 */
  events: DetectionEvent[]
  /** 連続性チェック用（前フレームの dataTime） */
  lastDataTimeMs: number
  /** ウォームアップ完了時刻(ms)。これ以前は確信度を抑制する */
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

/** ① トリガー評価の結果（1 観測点分。Phase 1 の観測対象）。 */
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

// ============================================================
// パラメータ（設計書 §9。すべて value=計測震度 単位。実データ調整前提）
// ============================================================

export const PARAMS = {
  /** 短時間平均の時定数(ms) */
  STA_TAU_MS: 2_000,
  /** 長時間平均の時定数(ms) */
  LTA_TAU_MS: 45_000,
  /** 速い経路: STA − LTA がこの値以上で発火（value 単位 ≒ 対数振幅比） */
  DELTA_TRIG: 1.0,
  /** 速い経路: value ≥ LTA + K_SIGMA·σ で発火 */
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
  /** フレーム間隔がこの倍率を超えて飛んだら状態を不連続とみなしリセット検討 */
  MAX_DT_GAP_MS: 10_000,
  /** ウォームアップ期間(ms)。起動後この間は確信度を抑制 */
  WARMUP_MS: 60_000,
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
    const fastByDelta = sta - lta >= PARAMS.DELTA_TRIG
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
// step（設計書 §7.1）
// ============================================================

/** 空の検知状態を生成する（コールドスタート用）。 */
export function initState(dataTimeMs = 0): DetectorState {
  return {
    sites: {},
    events: [],
    lastDataTimeMs: dataTimeMs,
    warmupUntilMs: dataTimeMs + PARAMS.WARMUP_MS,
  }
}

/**
 * 1 フレーム分の状態遷移（純粋）。1 秒ごとに呼ぶ。
 *
 * Phase 1 では ① トリガーまでを実装し、トリガー結果を triggers として返す。
 * ② アソシエーション・③ 確信度積分は後続フェーズで実装するため detections は空配列。
 *
 * @param state 前状態
 * @param frame 現フレーム
 * @param _meta 静的観測点メタ（Phase 2 の ② で使用。現状未使用）
 */
export function step(
  state: DetectorState,
  frame: Frame,
  _meta?: Record<string, StationMeta>,
): { state: DetectorState; detections: DetectionEvent[]; triggers: TriggerResult[] } {
  const dtMs = frame.dataTimeMs - state.lastDataTimeMs

  // 不連続（大きな時刻ジャンプ・巻き戻し）は状態をリセットして作り直す（設計書 §3.3-2,3）。
  if (dtMs <= 0 || dtMs > PARAMS.MAX_DT_GAP_MS) {
    const fresh = initState(frame.dataTimeMs)
    const rebuilt = ingestWithoutTrigger(fresh, frame)
    return { state: rebuilt, detections: [], triggers: [] }
  }

  const sites: Record<string, SiteState> = {}
  const triggers: TriggerResult[] = []

  for (let i = 0; i < frame.values.length; i++) {
    if (frame.missing?.[i]) continue
    const [lat, lng] = frame.sites[i]
    const key = siteKey(lat, lng)
    const value = indexToValue(frame.values[i])
    const prev = state.sites[key] ?? null

    const { state: next, path, triggered, rising } = updateSiteState(
      prev,
      value,
      dtMs,
      frame.dataTimeMs,
    )
    sites[key] = next

    if (triggered) {
      triggers.push({ key, lat, lng, triggered, path, value, rising })
    }
  }

  const nextState: DetectorState = {
    sites,
    events: state.events, // Phase 2 の ②③ で更新する
    lastDataTimeMs: frame.dataTimeMs,
    warmupUntilMs: state.warmupUntilMs,
  }

  // TODO(Phase 2): triggers を ② 時空間アソシエーションに渡してイベント帰属・確信度を算出する。
  return { state: nextState, detections: [], triggers }
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
