/**
 * 強震モニタ揺れ検知エンジン V3（純粋コア・近傍一致／PLUM 型）。
 *
 * 設計書: docs/kyoshin-detection-v3-design.md
 * React から切り離した純粋関数として実装する（副作用・現在時刻の直接参照を持たない。
 * 時刻はすべて frame.dataTimeMs から供給する）。決定的で単体テスト可能。
 *
 * 【V2 からの転換】
 * V2 は「波面フィットで震源を決め、その品質を時間積分して確信度を出す」設計だった。これが
 * Kanto の壁（弱い震度1の実地震と北関東の間欠ノイズが per-cluster 特徴で分離不能）・確定
 * レイテンシ（積分が登るのに 5〜6 秒）・明滅（フィット破綻で confirmed→weak 転落）・分裂
 * （震央ジッタで別 ID）・warmup（LTA が 60 秒落ち着かない）を生んだ。
 *
 * V3 は JMA EEW（PLUM 法・着未着法）と Scratch 前身の調査から収束した「震源非依存の面判定」に作り替える:
 *  L1 点トリガー   : 点別のノイズ床（長時定数・オンライン学習）を超え、かつ今まさに立ち上がったか。
 *  L2 近傍同時性   : その点の K 近傍のうち一定数が短時間窓で一緒に立ち上がったか（PLUM／着未着）。
 *  L3 グループ化   : 確定揺れ点を K 近傍グラフの連結成分で束ね、固定格子セルで安定 ID を与える。
 *  L4 確信度       : 点数＋最大震度ゲート＋連続フレーム。特異度は「点別床」と「セル別慢性活性」の二軸で守る。
 * 波面フィット・震源推定・時間積分・warmup は廃止。可動部を減らし V1 相当（数秒）で確定する。
 *
 * 【単位】強震モニタの値は計測震度（≒ 地動振幅の対数）で -3.0〜7.0 の連続値。震度0≈0.0。
 * 本コアは全体を value（計測震度）単位で扱い、境界で index → value 変換する。
 */

import { haversineKm } from './geo'

/** 緯度1度あたりのおおよその距離(km)。近傍探索のバウンディングボックス前段に使う。 */
const KM_PER_DEG = 111.194

// ============================================================
// 型定義
// ============================================================

/** 確信度の 3 段階。 */
export type Confidence = 'confirmed' | 'likely' | 'weak'

/** 1 観測点の逐次状態。キーは座標（siteKey）で管理する。 */
export interface SiteState {
  /** 直近の (dataTime, value) 履歴。オンセット上昇量(rate)の窓評価に使う（欠測・ジッタ吸収）。 */
  hist: { t: number; v: number }[]
  /** 点別ノイズ床の平均（value・長時定数 EWMA。慢性的に騒がしい点ほど高い） */
  floorMean: number
  /** 点別ノイズ床のばらつき（|value − floorMean| の長時定数 EWMA） */
  floorDev: number
  /** 最後にオンセット・トリガーした dataTime(ms)。未トリガーは null */
  triggeredAtMs: number | null
}

/** 検知イベント（多重地震・余震を同時に保持できる）。 */
export interface DetectionEvent {
  id: string
  confidence: Confidence
  /** 参加した確定揺れ点の座標キー（累積和集合。UI の震度分布・自動フィットに使う） */
  memberKeys: string[]
  /** 占有する固定格子セル（安定 ID の錨・セル慢性活性の更新対象） */
  cells: string[]
  originTimeMs: number
  /** 直近に確定揺れ点を伴った dataTime(ms)。HOLD_MS 経過で解除 */
  lastOnsetAtMs: number
  /** 推定最大震度（メンバー現在 value の最大＝PLUM 出力）。カード・音レベルに使う */
  maxIntensity: number
  /** 直近フレームのアクティブメンバー数（トリガー継続窓内）。確定点数ゲートに使う */
  lastSize: number
  /** メンバー点の重心（表示専用・任意）。震源推定ではない。 */
  epicenter: [number, number] | null
  /** confirmed 条件を連続で満たしたフレーム数（CONFIRM_FRAMES 連続で confirmed） */
  confirmStreak: number
  /** 一度でも confirmed に達したか（明滅防止のラッチ。HOLD 中は confirmed を維持） */
  everConfirmed: boolean
}

/** 検知エンジンの全状態。localStorage への永続化を想定（floor・cellActivity が学習資産）。 */
export interface DetectorState {
  /** 座標キー → 逐次状態 */
  sites: Record<string, SiteState>
  /** アクティブイベント集合 */
  events: DetectionEvent[]
  /** セル別の慢性活性（0〜1・長時定数）。平常時に確定揺れ点を出す地域ほど高い＝特異度の第2軸 */
  cellActivity: Record<string, number>
  /** イベント ID 採番用の連番（決定性のため乱数・時刻を使わない） */
  nextEventId: number
  /** 連続性チェック用（前フレームの dataTime） */
  lastDataTimeMs: number
}

/** 事前計算（実行時に一度）する静的な観測点メタ。座標キーで引く。 */
export interface StationMeta {
  /** 各点の K 近傍（R_KM 以内）の座標キー配列 */
  neighbors: Record<string, string[]>
  /** 各点の R_KM 以内に実在する近傍数（疎地域救済の割合条件の分母） */
  avail: Record<string, number>
  /** 各点が属する固定格子セルのキー */
  cellOf: Record<string, string>
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

/** トリガー結果（1 観測点分・診断用）。 */
export interface TriggerResult {
  key: string
  lat: number
  lng: number
  /** 現フレームの value（計測震度） */
  value: number
  /** 近傍同時性を満たした確定揺れ点か */
  confirmedShaking: boolean
}

// ============================================================
// パラメータ（設計書 §6。すべて value=計測震度 単位。ハーネスで較正）
// ============================================================

export const PARAMS = {
  // ---- L1 点トリガー ----
  /** しきい床への上乗せ(value)。床 + これ を超えたら「その点の平常を超えた」 */
  LEVEL_MARGIN: 0.5,
  /** オンセット上昇量の下限(value)。RATE_DT_MS 窓での value 上昇がこれ以上で「今立ち上がった」 */
  RATE_MIN: 0.5,
  /** オンセット上昇量の評価窓(ms)。1 フレーム差でなく窓で見て欠測・ジッタを吸収する */
  RATE_DT_MS: 2_500,
  /** 量子化ノイズ除去の絶対下限(value)。これ未満は常に非トリガー（-1.5 = index 3） */
  TRIG_FLOOR: -1.5,
  /** 点別ノイズ床の学習時定数(ms)。慢性ノイズを捉えるため分オーダー（V2 の LTA 45s より遅い） */
  FLOOR_TAU_MS: 900_000,
  /** 床＝floorMean + FLOOR_SIGMA_K·floorDev。ばらつきの大きい点を鈍くする係数 */
  FLOOR_SIGMA_K: 3.0,
  /** 点別床の下限(value)。静穏点でもこの床は保つ（微小変動の誤発火防止） */
  FLOOR_MIN: 0.0,
  /** 点別床の上限(value)。慢性ノイズ点でも鈍くしすぎない（実地震を潰さない） */
  FLOOR_CAP: 1.5,
  /** フレーム間隔がこれを超えて飛んだら状態を不連続とみなしリセット */
  MAX_DT_GAP_MS: 10_000,

  // ---- L2 近傍同時性 ----
  /** 近傍点数（K 近傍） */
  K: 7,
  /** 近傍半径(km) */
  R_KM: 40,
  /** 近傍一致に要する数 */
  MIN_NEIGHBORS: 3,
  /** 近傍一致の割合条件（疎地域救済）。agree/avail がこれ以上でも確定揺れ点 */
  MIN_NEIGHBOR_FRAC: 0.5,
  /** 近傍一致とみなす時間窓(ms)。この窓内で一緒に立ち上がったか */
  COINCIDENCE_MS: 4_000,
  /** トリガー継続窓(ms)。最終トリガーからこの間「継続中（＝アクティブメンバー）」とみなす */
  TRIG_ACTIVE_MS: 8_000,

  // ---- L3 格子・グループ化 ----
  /** 固定格子セルの寸法(度)。安定 ID の錨・セル慢性活性の単位（≒ 20km） */
  CELL_DEG: 0.2,
  /** 既存イベントへの帰属・併合とみなすメンバー重複率の下限 */
  MERGE_MEMBER_FRAC: 0.34,

  // ---- L4 確信度・発報 ----
  /** likely（可能性）に要する確定揺れ点数 */
  MIN_LIKELY_POINTS: 3,
  /** likely の最大震度下限(value)。0.5 = 震度1 */
  MIN_LIKELY_INTENSITY: 0.5,
  /** confirmed（検知）に要する確定揺れ点数 */
  CONFIRM_POINTS: 5,
  /** confirmed の最大震度下限(value)。0.5 = 震度1 */
  MIN_CONFIRM_INTENSITY: 0.5,
  /** confirmed 連続フレーム数（積分待ちなしで V1 相当の速さ） */
  CONFIRM_FRAMES: 2,
  /** 確定保持(ms)。確定揺れ点が途切れてもこの間はイベントを保持（明滅防止・V1 相当の保持） */
  HOLD_MS: 10_000,

  // ---- 特異度・第2軸（セル別慢性活性） ----
  /** セル慢性活性の学習時定数(ms)。長時定数で「その地域が平常時どれだけ点を出すか」を学ぶ */
  CELL_ACTIVITY_TAU_MS: 1_800_000,
  /** 慢性活性セルとみなす閾値。これ超で確定バーを引き上げる */
  CHRONIC_THRESHOLD: 0.25,
  /** 慢性活性セルでの確定点数の引き上げ幅 */
  CHRONIC_POINT_BUMP: 4,
  /** 慢性活性セルでの確定最大震度下限(value)。1.5 = 震度2（北関東のコヒーレント震度1 を弾く） */
  CHRONIC_CONFIRM_INTENSITY: 1.5,
  /**
   * セル慢性活性の学習を凍結する最大震度(value)。これ以上の高震度イベント（明らかに実地震）が
   * 属するセルは慢性活性を更新しない（実地震で地域軸を汚さない）。2.5 = 震度3。
   * 低震度（震度1〜2）のコヒーレント同時多発は凍結せず学習させ、地域ノイズとして受け止める。
   */
  CELL_FREEZE_INTENSITY: 2.5,
} as const

// ============================================================
// ヘルパー
// ============================================================

/** 計測震度インデックス(0〜20) → 計測震度 value(-3.0〜7.0)。 */
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

/** 座標 → 固定格子セルキー（CELL_DEG 等間隔ビン）。 */
export function cellKey(lat: number, lng: number): string {
  const cell = PARAMS.CELL_DEG
  return `${Math.floor(lat / cell)},${Math.floor(lng / cell)}`
}

/**
 * Δt を考慮した EWMA 係数を返す。α = 1 − exp(−Δt/τ)。
 * フレーム欠損で Δt が伸びても時定数を保つ。
 */
export function ewmaAlpha(dtMs: number, tauMs: number): number {
  if (dtMs <= 0) return 0
  return 1 - Math.exp(-dtMs / tauMs)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)

/** 点別ノイズ床の実効値（value）。floorMean + K·floorDev を [FLOOR_MIN, FLOOR_CAP] にクランプ。 */
function effectiveFloor(s: SiteState): number {
  return clamp(s.floorMean + PARAMS.FLOOR_SIGMA_K * s.floorDev, PARAMS.FLOOR_MIN, PARAMS.FLOOR_CAP)
}

// ============================================================
// L0 静的メタ（実行時に一度計算・キャッシュ）
// ============================================================

/**
 * 観測点座標から K 近傍グラフと格子割当を計算する（純粋）。
 *
 * 近傍は「メモリ上にある実行時座標」からの純粋な幾何計算で、追加リクエストは発生しない。
 * 事前計算 JSON を出荷せず実行時に組むことで、siteConfigId 版差での siteKey ドリフトを構造的に防ぐ。
 * O(点数²) だが観測点集合ごとに一度だけ（フレーム毎ではない）計算しキャッシュする前提。
 * バウンディングボックス前段で haversine 呼び出しを大幅に間引く。
 */
export function buildStationMeta(sites: [number, number][]): StationMeta {
  const neighbors: Record<string, string[]> = {}
  const avail: Record<string, number> = {}
  const cellOf: Record<string, string> = {}

  // 重複座標を畳んだ一意点列（siteKey・座標）
  const uniq: { key: string; lat: number; lng: number }[] = []
  const seen = new Set<string>()
  for (const [lat, lng] of sites) {
    const key = siteKey(lat, lng)
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push({ key, lat, lng })
    cellOf[key] = cellKey(lat, lng)
  }

  const latMargin = PARAMS.R_KM / KM_PER_DEG
  for (const p of uniq) {
    // 近い順に距離を集め、R_KM 以内を avail、その先頭 K を neighbors とする
    const cand: { key: string; d: number }[] = []
    for (const q of uniq) {
      if (q.key === p.key) continue
      if (Math.abs(q.lat - p.lat) > latMargin) continue // 緯度バウンディングボックス前段
      const d = haversineKm(p.lat, p.lng, q.lat, q.lng)
      if (d <= PARAMS.R_KM) cand.push({ key: q.key, d })
    }
    cand.sort((a, b) => a.d - b.d)
    avail[p.key] = cand.length
    neighbors[p.key] = cand.slice(0, PARAMS.K).map((c) => c.key)
  }

  return { neighbors, avail, cellOf }
}

// ============================================================
// L1 点トリガー
// ============================================================

/** 新規観測点の初期状態。床は既定値で開始（warmup 不要・初手から検知可能）。 */
function initSiteState(value: number, t: number): SiteState {
  return {
    hist: [{ t, v: value }],
    floorMean: value,
    floorDev: 0,
    triggeredAtMs: null,
  }
}

/** 履歴に (t,v) を積み、RATE_DT_MS の 2 倍より古いサンプルを捨てる。 */
function pushHist(hist: { t: number; v: number }[], t: number, v: number): void {
  hist.push({ t, v })
  const cutoff = t - PARAMS.RATE_DT_MS * 2
  while (hist.length > 2 && hist[0].t < cutoff) hist.shift()
}

/**
 * RATE_DT_MS 窓での value 上昇量を返す。窓の起点（now − RATE_DT_MS 以前で最新のサンプル）が
 * 無ければ null（コールドスタート直後・オンセット評価不能）。欠測でフレームが飛んでも時刻基準なので頑健。
 */
function windowRate(hist: { t: number; v: number }[], now: number): number | null {
  const target = now - PARAMS.RATE_DT_MS
  let baseline: { t: number; v: number } | null = null
  for (const s of hist) {
    if (s.t <= target + 500) baseline = s // 起点許容 0.5s
  }
  if (!baseline) return null
  const cur = hist[hist.length - 1]
  return cur.v - baseline.v
}

// ============================================================
// L3 グループ化（K 近傍グラフの連結成分）
// ============================================================

/**
 * 確定揺れ点を K 近傍グラフの連結成分に束ねる（境界の無い方式・セル境界での分裂を避ける）。
 * a〜b は「b が a の近傍」または「a が b の近傍」で連結（K 近傍の非対称性を吸収）。
 */
function connectedComponents(keys: string[], neighbors: Record<string, string[]>): string[][] {
  const inSet = new Set(keys)
  const visited = new Set<string>()
  const components: string[][] = []

  for (const start of keys) {
    if (visited.has(start)) continue
    const comp: string[] = []
    const queue = [start]
    visited.add(start)
    while (queue.length > 0) {
      const cur = queue.shift() as string
      comp.push(cur)
      // cur → 近傍（cur の近傍のうち確定揺れ点）
      for (const nb of neighbors[cur] ?? []) {
        if (inSet.has(nb) && !visited.has(nb)) {
          visited.add(nb)
          queue.push(nb)
        }
      }
      // 近傍 → cur（cur を近傍に持つ確定揺れ点。非対称性の補完）
      for (const other of keys) {
        if (visited.has(other)) continue
        if ((neighbors[other] ?? []).includes(cur)) {
          visited.add(other)
          queue.push(other)
        }
      }
    }
    components.push(comp)
  }
  return components
}

/** クラスタ(a)とイベント(bKeys)のメンバー重複率 = |a∩b| / min(|a|,|b|)。 */
export function memberOverlapFrac(a: Set<string>, bKeys: string[]): number {
  if (a.size === 0 || bKeys.length === 0) return 0
  let common = 0
  for (const k of bKeys) if (a.has(k)) common++
  return common / Math.min(a.size, bKeys.length)
}

// ============================================================
// step
// ============================================================

/** 空の検知状態を生成する（コールドスタート用）。warmup は無い。 */
export function initState(dataTimeMs = 0): DetectorState {
  return {
    sites: {},
    events: [],
    cellActivity: {},
    nextEventId: 1,
    lastDataTimeMs: dataTimeMs,
  }
}

/** 永続化する学習資産（点別床・セル慢性活性）。一過性の hist・triggeredAtMs・events は含めない。 */
export interface LearnedState {
  /** 座標キー → [floorMean, floorDev]。既定床から動いた点のみ（静穏点は省略＝復元時に既定初期化）。 */
  floors: Record<string, [number, number]>
  /** セルキー → 慢性活性(0〜1) */
  cellActivity: Record<string, number>
}

/**
 * 学習資産だけを抽出する（localStorage 保存用）。
 * 既定床のままの静穏点（floorMean/floorDev がともに微小）は省いて保存量を抑える。
 */
export function extractLearned(state: DetectorState): LearnedState {
  const floors: Record<string, [number, number]> = {}
  for (const [k, s] of Object.entries(state.sites)) {
    if (s.floorMean > 0.05 || s.floorDev > 0.05) floors[k] = [s.floorMean, s.floorDev]
  }
  return { floors, cellActivity: { ...state.cellActivity } }
}

/**
 * 学習資産を状態へ流し込む（コールドスタート直後の再読込用）。
 * 点別床は「床のみ持つ SiteState」として先置きし、初フレームでその床から検知を開始できるようにする
 * （hist は空・triggeredAtMs は null＝一過性は復元しない）。warmup は無いので初手から検知可能。
 */
export function hydrateLearned(state: DetectorState, learned: LearnedState): DetectorState {
  const sites: Record<string, SiteState> = { ...state.sites }
  for (const [k, fd] of Object.entries(learned.floors)) {
    sites[k] = { hist: [], floorMean: fd[0], floorDev: fd[1], triggeredAtMs: null }
  }
  return { ...state, sites, cellActivity: { ...learned.cellActivity } }
}

/** 現フレームの 1 観測点の観測結果（L1〜L2 の途中集計）。 */
interface FramePoint {
  key: string
  lat: number
  lng: number
  value: number
  /** 床 + マージンを超え「揺れている」か（rate 不問。メンバー・最大震度に使う） */
  levelActive: boolean
  /** 今フレームでオンセット・トリガーしたか（levelActive かつ立ち上がり） */
  onset: boolean
}

/**
 * 1 フレーム分の状態遷移（純粋）。1 秒ごとに呼ぶ。
 *
 * L1 点トリガー → L2 近傍同時性 → L3 連結成分グループ化・イベント帰属 → L4 確信度分類・保持判定。
 *
 * @param state 前状態
 * @param frame 現フレーム
 * @param meta 静的観測点メタ（未指定ならフレーム座標から都度構築。テスト・小規模用）
 */
export function step(
  state: DetectorState,
  frame: Frame,
  meta?: StationMeta,
): { state: DetectorState; detections: DetectionEvent[]; triggers: TriggerResult[] } {
  const now = frame.dataTimeMs
  const dtMs = now - state.lastDataTimeMs

  // 不連続（大きな時刻ジャンプ・巻き戻し・コールドスタート初フレーム）は一過性の状態を
  // 作り直す。ただし学習資産（点別床・セル慢性活性）は引き継ぐ（永続化からの復元を保つ・
  // 数十秒の欠測で床/地域活性を捨てない）。
  if (dtMs <= 0 || dtMs > PARAMS.MAX_DT_GAP_MS) {
    const seed = initState(now)
    seed.cellActivity = { ...state.cellActivity }
    const rebuilt = ingest(seed, frame, state)
    return { state: rebuilt, detections: [], triggers: [] }
  }

  const m = meta ?? buildStationMeta(frame.sites)

  // ---- L1 点トリガー ----
  const sites: Record<string, SiteState> = {}
  const points: FramePoint[] = []
  const cur = new Map<string, FramePoint>()
  const triggeredAt: Record<string, number | null> = {}

  for (let i = 0; i < frame.values.length; i++) {
    if (frame.missing?.[i]) continue
    const [lat, lng] = frame.sites[i]
    const key = siteKey(lat, lng)
    const value = indexToValue(frame.values[i])
    const prev = state.sites[key]

    if (!prev) {
      const s = initSiteState(value, now)
      sites[key] = s
      triggeredAt[key] = null
      continue
    }

    const hist = [...prev.hist]
    pushHist(hist, now, value)
    const floor = effectiveFloor(prev)
    const levelActive = value >= floor + PARAMS.LEVEL_MARGIN && value >= PARAMS.TRIG_FLOOR
    const rate = windowRate(hist, now)
    const onset = levelActive && rate != null && rate >= PARAMS.RATE_MIN

    const s: SiteState = {
      hist,
      floorMean: prev.floorMean,
      floorDev: prev.floorDev,
      triggeredAtMs: onset ? now : prev.triggeredAtMs,
    }
    sites[key] = s
    triggeredAt[key] = s.triggeredAtMs

    const fp: FramePoint = { key, lat, lng, value, levelActive, onset }
    points.push(fp)
    cur.set(key, fp)
  }

  // ---- L2 近傍同時性（確定揺れ点の判定）----
  // 「最近オンセットした点」で、K 近傍のうち一定数（数 or 割合）が COINCIDENCE_MS 窓で
  // 一緒に立ち上がった点を確定揺れ点とする。孤立・散在ノイズは近傍が揃わず脱落する。
  const confirmedShaking: string[] = []
  const triggers: TriggerResult[] = []
  for (const p of points) {
    const trigAt = triggeredAt[p.key]
    const recentOnset = trigAt != null && now - trigAt <= PARAMS.COINCIDENCE_MS
    let ok = false
    if (recentOnset) {
      const nb = m.neighbors[p.key] ?? []
      let agree = 0
      for (const n of nb) {
        const nt = triggeredAt[n]
        if (nt != null && now - nt <= PARAMS.COINCIDENCE_MS) agree++
      }
      const availN = m.avail[p.key] ?? nb.length
      ok = agree >= PARAMS.MIN_NEIGHBORS || agree / Math.max(availN, 1) >= PARAMS.MIN_NEIGHBOR_FRAC
      if (ok) confirmedShaking.push(p.key)
    }
    if (p.onset || ok)
      triggers.push({ key: p.key, lat: p.lat, lng: p.lng, value: p.value, confirmedShaking: ok })
  }

  // ---- L3 グループ化・イベント帰属 ----
  const components = connectedComponents(confirmedShaking, m.neighbors)
  const { events, nextEventId } = associate(
    state.events,
    state.nextEventId,
    components,
    cur,
    triggeredAt,
    state.cellActivity,
    m.cellOf,
    now,
  )

  // ---- セル慢性活性の学習（特異度の第2軸）----
  const cellActivity = updateCellActivity(
    state.cellActivity,
    confirmedShaking,
    events,
    m.cellOf,
    dtMs,
  )

  // ---- 点別ノイズ床の学習 ----
  // 揺れていない・近傍同時でない「静穏な点」だけで床を更新する（実イベント・群発で床が汚れ鈍化しない）。
  const coincidentSet = new Set(confirmedShaking)
  for (const p of points) {
    const s = sites[p.key]
    if (p.levelActive || coincidentSet.has(p.key)) continue // 凍結
    const a = ewmaAlpha(dtMs, PARAMS.FLOOR_TAU_MS)
    s.floorMean = s.floorMean + a * (p.value - s.floorMean)
    s.floorDev = s.floorDev + a * (Math.abs(p.value - s.floorMean) - s.floorDev)
  }

  const nextState: DetectorState = {
    sites,
    events,
    cellActivity,
    nextEventId,
    lastDataTimeMs: now,
  }
  // detections はアクティブな全イベント。最大震度降順（強い順）。
  const detections = [...events].sort((x, y) => y.maxIntensity - x.maxIntensity)
  return { state: nextState, detections, triggers }
}

/**
 * 連結成分を既存イベントに帰属（メンバー重複 or セル共有）or 新規生成し、L4 の確信度分類・保持判定を行う。
 */
function associate(
  prevEvents: DetectionEvent[],
  nextEventId: number,
  components: string[][],
  cur: Map<string, FramePoint>,
  triggeredAt: Record<string, number | null>,
  cellActivity: Record<string, number>,
  cellOf: Record<string, string>,
  now: number,
): { events: DetectionEvent[]; nextEventId: number } {
  const events = prevEvents.map((e) => ({
    ...e,
    memberKeys: [...e.memberKeys],
    cells: [...e.cells],
  }))
  const updated = new Set<string>()
  let idCounter = nextEventId

  for (const comp of components) {
    const compSet = new Set(comp)
    const compCells = new Set(comp.map((k) => cellOf[k]).filter(Boolean))

    // 既存イベントへの帰属: メンバー重複率 or セル共有（震央ジッタでも同一 ID を保つ）。
    let target: DetectionEvent | undefined
    for (const e of events) {
      if (updated.has(e.id)) continue
      const overlap = memberOverlapFrac(compSet, e.memberKeys) >= PARAMS.MERGE_MEMBER_FRAC
      const cellShare = e.cells.some((c) => compCells.has(c))
      if (overlap || cellShare) {
        target = e
        break
      }
    }

    if (target) {
      target.memberKeys = [...new Set([...target.memberKeys, ...comp])]
      target.cells = [...new Set([...target.cells, ...compCells])]
      target.lastOnsetAtMs = now
      updateEventMetrics(target, cur, triggeredAt, cellActivity, cellOf, now)
      updated.add(target.id)
    } else {
      const ev: DetectionEvent = {
        id: `evt-${idCounter++}`,
        confidence: 'weak',
        memberKeys: [...comp],
        cells: [...compCells],
        originTimeMs: now,
        lastOnsetAtMs: now,
        maxIntensity: 0,
        lastSize: 0,
        epicenter: null,
        confirmStreak: 0,
        everConfirmed: false,
      }
      updateEventMetrics(ev, cur, triggeredAt, cellActivity, cellOf, now)
      events.push(ev)
      updated.add(ev.id)
    }
  }

  // 今フレームで確定揺れ点を伴わなかったイベント: 指標を再評価し、HOLD 経過で解除する。
  const survivors: DetectionEvent[] = []
  for (const e of events) {
    if (!updated.has(e.id)) {
      updateEventMetrics(e, cur, triggeredAt, cellActivity, cellOf, now)
    }
    if (now - e.lastOnsetAtMs <= PARAMS.HOLD_MS) survivors.push(e)
  }

  return { events: survivors, nextEventId: idCounter }
}

/**
 * イベントの指標（アクティブメンバー数・最大震度・重心）を再計算し、確信度を分類する。
 *
 * - lastSize    : トリガー継続窓(TRIG_ACTIVE_MS)内にあるメンバー数。波が広がるほど増え、8s 保持される。
 * - maxIntensity: メンバー現在 value の最大（＝PLUM 出力）。levelActive なメンバーが無ければ前値を保つ。
 * - confidence  : 点数＋最大震度ゲート＋CONFIRM_FRAMES 連続。特異度は点別床(L1)とセル慢性活性で二軸。
 *   慢性活性セルでは確定点数・確定震度のバーを引き上げる（北関東のコヒーレントノイズ対策・第2軸）。
 *   一度 confirmed に達したら HOLD 中は confirmed を維持する（明滅防止のラッチ）。
 */
function updateEventMetrics(
  e: DetectionEvent,
  cur: Map<string, FramePoint>,
  triggeredAt: Record<string, number | null>,
  cellActivity: Record<string, number>,
  cellOf: Record<string, string>,
  now: number,
): void {
  let size = 0
  let maxV = -Infinity
  const lats: number[] = []
  const lngs: number[] = []
  for (const k of e.memberKeys) {
    const t = triggeredAt[k]
    if (t != null && now - t <= PARAMS.TRIG_ACTIVE_MS) size++
    const p = cur.get(k)
    if (p && p.levelActive) {
      if (p.value > maxV) maxV = p.value
      lats.push(p.lat)
      lngs.push(p.lng)
    }
  }
  e.lastSize = size
  if (maxV > -Infinity) e.maxIntensity = maxV
  if (lats.length > 0) e.epicenter = [mean(lats), mean(lngs)]

  // 地域軸: イベントが占有するセルの慢性活性の最大値
  let chronic = 0
  for (const c of e.cells) chronic = Math.max(chronic, cellActivity[c] ?? 0)
  const isChronic = chronic >= PARAMS.CHRONIC_THRESHOLD

  const confirmPointsReq = PARAMS.CONFIRM_POINTS + (isChronic ? PARAMS.CHRONIC_POINT_BUMP : 0)
  const confirmIntensityReq = isChronic
    ? PARAMS.CHRONIC_CONFIRM_INTENSITY
    : PARAMS.MIN_CONFIRM_INTENSITY
  const meetsConfirm = size >= confirmPointsReq && e.maxIntensity >= confirmIntensityReq
  e.confirmStreak = meetsConfirm ? e.confirmStreak + 1 : 0
  if (e.confirmStreak >= PARAMS.CONFIRM_FRAMES) e.everConfirmed = true

  // 確信度: ラッチ（confirmed 到達後は HOLD 中維持）→ confirmed → likely → weak
  if (e.everConfirmed) {
    e.confidence = 'confirmed'
  } else if (size >= PARAMS.MIN_LIKELY_POINTS && e.maxIntensity >= PARAMS.MIN_LIKELY_INTENSITY) {
    e.confidence = 'likely'
  } else {
    e.confidence = 'weak'
  }

  void cellOf
}

/**
 * セル別慢性活性を更新する（特異度の第2軸）。
 *
 * 平常時に確定揺れ点を出すセルほど活性が上がる＝北関東等のコヒーレントノイズ地域を「名指しせず」学習する。
 * ただし高震度イベント（明らかに実地震・CELL_FREEZE_INTENSITY 以上）が属するセルは凍結し、実地震で
 * 地域軸を汚さない。低震度（震度1〜2）のコヒーレント同時多発は凍結せず学習させ、地域ノイズとして受け止める。
 */
function updateCellActivity(
  prev: Record<string, number>,
  confirmedShaking: string[],
  events: DetectionEvent[],
  cellOf: Record<string, string>,
  dtMs: number,
): Record<string, number> {
  const next: Record<string, number> = { ...prev }
  const a = ewmaAlpha(dtMs, PARAMS.CELL_ACTIVITY_TAU_MS)

  // 今フレームで確定揺れ点を出したセル
  const firedCells = new Set<string>()
  for (const k of confirmedShaking) {
    const c = cellOf[k]
    if (c) firedCells.add(c)
  }
  // 高震度イベントが占有するセル（学習凍結対象）
  const frozenCells = new Set<string>()
  for (const e of events) {
    if (e.maxIntensity >= PARAMS.CELL_FREEZE_INTENSITY) for (const c of e.cells) frozenCells.add(c)
  }

  // 発火セルは 1 へ、非発火の既知セルは 0 へ、長時定数で寄せる（凍結セルは据え置き）。
  const keys = new Set<string>([...Object.keys(next), ...firedCells])
  for (const c of keys) {
    if (frozenCells.has(c)) continue
    const target = firedCells.has(c) ? 1 : 0
    const v0 = next[c] ?? 0
    next[c] = v0 + a * (target - v0)
  }
  return next
}

/**
 * トリガー判定を伴わずに全観測点の状態を取り込む。不連続リセット直後の 1 フレーム目に使う
 * （この 1 フレームはトリガー対象にしない）。
 *
 * `prev` を渡すと、既知点の**点別床（学習資産）は引き継ぎ**、hist・triggeredAtMs（一過性）だけ
 * リセットする。これで永続化からの復元・数十秒の欠測をまたいでも床を失わない。
 */
function ingest(state: DetectorState, frame: Frame, prev?: DetectorState): DetectorState {
  const sites: Record<string, SiteState> = {}
  for (let i = 0; i < frame.values.length; i++) {
    if (frame.missing?.[i]) continue
    const [lat, lng] = frame.sites[i]
    const key = siteKey(lat, lng)
    const value = indexToValue(frame.values[i])
    const prior = prev?.sites[key]
    sites[key] = prior
      ? { hist: [{ t: frame.dataTimeMs, v: value }], floorMean: prior.floorMean, floorDev: prior.floorDev, triggeredAtMs: null }
      : initSiteState(value, frame.dataTimeMs)
  }
  return { ...state, sites, lastDataTimeMs: frame.dataTimeMs }
}
