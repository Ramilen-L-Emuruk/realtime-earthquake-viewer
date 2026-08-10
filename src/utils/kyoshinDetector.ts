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

/**
 * 確信度の 4 段階。
 * - confirmed: コヒーレントな揺れの広がり ＋ 震度1以上（音＋自動タブ＋フィット）
 * - likely   : 広がりあり ＋ 震度1以上（早期反応・候補音＋タブ）
 * - faint    : 同期 onset の広がりはあるが震度1未満（震度0級。無音で控えめに可視化）
 * - weak     : 広がり不足（非表示）
 */
export type Confidence = 'confirmed' | 'likely' | 'faint' | 'weak'

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
  /** 最後に spread（size ≥ MIN_LIKELY_POINTS）を持った dataTime(ms)。LIKELY_HOLD_MS の likely/faint 保持に使う。未達は 0 */
  lastSpreadAtMs: number
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
  /** フレーム配列と同じ並びの一意キー（computeSiteKeys の結果）。座標衝突時の別実体化に使う。 */
  keys: string[]
}

/** 1 フレーム分の入力。 */
export interface Frame {
  dataTimeMs: number
  /** SiteCoords（座標の順序 = values の順序） */
  sites: [number, number][]
  /** indices（計測震度インデックス 0〜20。負値は欠測を示すことがあるが missing で除外して渡すこと） */
  values: number[]
  /** 欠測フラグ（あれば。true の点は状態更新から除外） */
  missing?: boolean[]
  /**
   * 震源要素が確定した（単独点処理=仮定震源要素でない）EEW が発表中か（呼び出し側の責務。
   * cancelled/expired は含めないこと）。severity（Warning/Forecast）は推定震度の大小を示す軸に
   * 過ぎず、予報級でも震度3〜4相当は普通にありうるため使わない。condition='仮定震源要素' は
   * 1 観測点のみのデータで震源を仮決めした速報で、震源・マグニチュード・推定震度の誤差が大きい
   * （eew.ts の eewMaxScale・RealtimeTab・ttsText が同じ条件で推定震度等を信用しない/非表示にする
   * のと同じ判断基準）。
   * true の間は confirmed の確定条件（点数・連続フレーム数）を EEW_CONFIRM_POINTS・EEW_CONFIRM_FRAMES に
   * 差し替えて緩和する（震源座標・距離は見ない＝震源非依存を保ったまま「すでに震源が確定した地震が
   * 起きたと分かっている」局面でだけ確定を早める。§19）。単点ノイズを弾く MIN_CLUSTER・
   * CONFIRM_INTENSE_POINTS・MIN_CONFIRM_INTENSITY は EEW 中でも変えない。
   */
  eewActive?: boolean
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
  /**
   * しきい床への上乗せ(value)。value ≥ floor + これ で「その点の平常を超えた（levelActive）」。
   * 判別の芯を絶対レベルから「同期 onset の空間的広がり（L2 連結成分）」へ移したため 0.0 まで下げる。
   * 強震モニタは 0.5 刻み量子化（震度0=0.0 / 震度1=0.5）なので、静穏点（floor≈0）ではこれを 0 に
   * しないと震度0(value 0.0)を取り込めず faint が発火しない。慢性ノイズ点は floor 自体が高く据え置き
   * （相対的に鈍いまま）。実データ実験（level≥0.0・rise≥0.5）で平常の onset連結成分≤2 を確認済み。
   */
  LEVEL_MARGIN: 0.0,
  /**
   * 「継続して揺れている」メンバー判定の床への上乗せ(value)。value ≥ floor + これ を sustained とみなす。
   * イベントの継続点数・保持(HOLD)はこの sustained（＝床を明確に超えて揺れ続けている点）で数える。
   * LEVEL_MARGIN=0 だと平常の震度0(value 0.0)も levelActive になり保持が切れないため、継続判定は
   * 一段高いこの床で行う。震度1(value 0.5)は floor≈0 で sustained、平常の震度0(0.0)は非 sustained。
   */
  SUSTAIN_MARGIN: 0.4,
  /** オンセット上昇量の下限(value)。RATE_DT_MS 窓での value 上昇がこれ以上で「今立ち上がった」 */
  RATE_MIN: 0.5,
  /** オンセット上昇量の評価窓(ms)。1 フレーム差でなく窓で見て欠測・ジッタを吸収する */
  RATE_DT_MS: 2_500,
  /** 量子化ノイズ除去の絶対下限(value)。これ未満は常に非トリガー（-1.5 = index 3） */
  TRIG_FLOOR: -1.5,
  /** 点別ノイズ床の学習時定数(ms)。慢性ノイズを捉えるため分オーダー（V2 の LTA 45s より遅い） */
  FLOOR_TAU_MS: 900_000,
  /**
   * onset した点のノイズ床学習フリーズ期間(ms)。onset から COINCIDENCE_MS(4s) を過ぎて揺れが収まった
   * と判定された直後も、この期間はノイズ床の学習をスキップする。2026-07-28 熊本群発地震のリプレイ
   * 検証で発見: 対策前は COINCIDENCE_MS が過ぎた瞬間から即座に学習が再開されるため、本震・大きめの
   * 余震の減衰過程で続く残留変動（levelActive を割ったり超えたりしながら緩やかに収まる値）が静穏点の
   * ノイズ床として誤学習され、FLOOR_CAP まで押し上げてしまっていた（実データでは本震後 8 分間、
   * 震度1相当の余震 5 件が完全に無反応だった）。単発の孤立した地震では大きな影響はない
   * （FLOOR_TAU_MS=15分の時定数でゆっくり回復する余地がある）が、数分おきに余震が続く群発地震では
   * 床が回復する前に次の onset が来るため劣化が蓄積し続ける。トリガー対象は onset した観測点のみ
   * （confirmed に無関係のノイズ地域を鈍くする FLOOR_CAP の本来の役目は妨げない）。
   */
  FLOOR_FREEZE_MS: 600_000,
  /** 床＝floorMean + FLOOR_SIGMA_K·floorDev。ばらつきの大きい点を鈍くする係数 */
  FLOOR_SIGMA_K: 3.0,
  /** 点別床の下限(value)。静穏点でもこの床は保つ（微小変動の誤発火防止） */
  FLOOR_MIN: 0.0,
  /** 点別床の上限(value)。慢性ノイズ点でも鈍くしすぎない（実地震を潰さない） */
  FLOOR_CAP: 1.5,
  /** フレーム間隔がこれを超えて飛んだら状態を不連続とみなしリセット */
  MAX_DT_GAP_MS: 10_000,

  // ---- L2 同期 onset の空間的広がり（連結成分） ----
  /**
   * 近傍点数（K 近傍）。各点が R_KM 以内で近い順に保持する隣接点の数。この隣接グラフが L2 の
   * 連結成分（＝面判定）の土台になる。
   * 7→12 の根拠: 密な観測網（九州・関東など）では近傍7点が半径 ~15km 以内で埋まり、40km 以内でも
   * 20〜30km 離れた点は隣接リストから溢れる。本物の揺れの面でも、床を超えて onset した点が 20〜30km
   * 間隔で、その間を埋める点が震度0（床下）で脱落すると、7 近傍では連結経路が断たれ面が育たず非検知に
   * なる（福岡 M2.4 震度1・2026-07-22 05:49 の取りこぼしが実例。K を上げると likely で回復）。12 は
   * これらを橋渡しできるが半径は R_KM=40km のままなので拡散はしない。実地震19件で回帰0・1件改善
   * （紀伊水道 likely→confirmed）、平常35分＋欠測グリッチで可聴誤検知0、漏れ境界（無音 faint）は
   * K=16 で K=12 はその4段手前、を実データで確認済み。onset 点数律速の微小地震（滋賀 M2.5 等）は
   * K を上げても救えない＝これは連結の穴専用の狙い撃ち修正。
   */
  K: 12,
  /** 近傍半径(km) */
  R_KM: 40,
  /**
   * 揺れクラスタに要する同期 onset の連結成分サイズ下限。直近 COINCIDENCE_MS に onset した点を
   * K 近傍グラフで連結し、この数以上の成分を「面として揺れている」＝実地震とみなす。散在ノイズは
   * 成分が育たず脱落する（平常25分・全国で成分≥3 は 0 回を実測）。時間差 onset も成分で束ねる。
   */
  MIN_CLUSTER: 3,
  /** 同期とみなす時間窓(ms)。この窓内に onset した点を連結対象にする */
  COINCIDENCE_MS: 4_000,
  /** トリガー継続窓(ms)。最終トリガーからこの間「継続中（＝アクティブメンバー）」とみなす */
  TRIG_ACTIVE_MS: 8_000,

  // ---- L3 格子・グループ化 ----
  /** 固定格子セルの寸法(度)。安定 ID の錨・セル慢性活性の単位（≒ 20km） */
  CELL_DEG: 0.2,
  /** 既存イベントへの帰属・併合とみなすメンバー重複率の下限 */
  MERGE_MEMBER_FRAC: 0.34,
  /**
   * イベント重心がこの距離(km)以内なら 1 地震として併合する（フレーム末の consolidation）。
   * 沖合・深発の揺れ域は海/山のギャップで近傍グラフが分断され複数成分に割れる（福島県沖 49km・
   * 根室沖 78km で実観測）。同一地震の分裂を 1 本化する。離れた別地震（数百km 級）は併合しない。
   */
  MERGE_EVENT_KM: 100,

  // ---- L4 確信度・発報 ----
  /** likely（可能性）に要する確定揺れ点数 */
  MIN_LIKELY_POINTS: 3,
  /** likely の最大震度下限(value)。0.5 = 震度1 */
  MIN_LIKELY_INTENSITY: 0.5,
  /** confirmed（検知）に要する確定揺れ点数（密な観測網での上限） */
  CONFIRM_POINTS: 5,
  /**
   * 確定点数の密度正規化（改良5・疎地域救済）。局所に実在する観測点が少ない地域（離島・過疎網）では
   * CONFIRM_POINTS を「(局所実在近傍数+1) × この割合」まで下げる（下限 MIN_LIKELY_POINTS）。
   * 例: 奄美（局所実在 ~3）は 3 点で確定可。密な網（局所実在 ≥8）は CONFIRM_POINTS のまま。
   * 近傍一致（L2）自体が空間コヒーレンスを要求するので、平常時ノイズは点数を下げても通らない。
   */
  CONFIRM_DENSITY_FRAC: 0.6,
  /** confirmed の最大震度下限(value)。0.5 = 震度1 */
  MIN_CONFIRM_INTENSITY: 0.5,
  /**
   * confirmed（確定検知）に要する「確定震度レベル以上に達したメンバー数」の下限。
   * size（震度0 を含む onset 連結成分の点数）が揃っても、実際に confirmIntensityReq（通常 震度1）
   * 以上に達した点が1つだけなら confirmed にしない（likely/faint に留める）。
   * 「単点だけ震度1・周囲は震度0 の気配」という分布は実地震の揺れではなく局所ノイズの典型
   * （2026-07-27 13:35 茨城県北部の誤 confirmed が実例＝震度1到達点1・周囲震度0 の5点連結が
   * 69秒 confirmed 居座り）。実地震は震央周辺の複数点が同レベルに達する（同地域・同震度1 の実地震で
   * 震度1到達点12。confirmed 実地震カタログ12件の最小でも 3）。§18・実データ検証で確認。
   * 震源非依存の面判定を保ったままノイズを弾く第3のゲート（likely には課さない＝1点震度1 の
   * 弱い実地震〈福岡 M2.4 等〉を取りこぼさない）。
   */
  CONFIRM_INTENSE_POINTS: 2,
  /**
   * 高震度 fast path の震度下限(value)。2.5 = 震度3。この震度に達したメンバーが
   * HIGH_CONFIRM_POINTS 点以上あれば、確定点数（size）のゲートを免除して confirmed にする（§20）。
   *
   * 2.5 の根拠:
   *  - 点別ノイズ床の学習上限は FLOOR_CAP=1.5（震度2相当）。慢性的に騒がしい点でも学習床はここで
   *    頭打ちになるため、2.5 はノイズ床が到達しうる範囲の外側にある。
   *  - 既存の CELL_FREEZE_INTENSITY と同値。あちらは「これ以上の高震度は明らかに実地震なので
   *    セル慢性活性の学習を凍結する」という判断で、本パラメータはその同じ境界を確定条件でも使う。
   *    片方だけ動かすと「実地震とみなして地域軸の学習は止めるのに、確定は点数が揃うまで待たせる」
   *    という非対称が生まれるため、値を変えるときは両方を揃えて検討すること。
   *  - 実データ（2026-08-09 検証）: 平常時2時間（7200フレーム・全国1725点。2026-08-08 13:00 台の
   *    日中と 2026-08-09 00:00 台の深夜）で value >= 2.5 の出現は **0 点**。2点連結どころか単点すら
   *    現れない。慢性活性セルでの引き上げ（CHRONIC_POINT_BUMP・CHRONIC_CONFIRM_INTENSITY）も
   *    この fast path では併せて免除するが、慢性・非慢性を問わず 2.5 の出現が皆無であるため
   *    地域軸の分岐は設けない（効く場面が観測されていない分岐は足さない）。
   */
  HIGH_CONFIRM_INTENSITY: 2.5,
  /**
   * 高震度 fast path に要する点数。CONFIRM_INTENSE_POINTS と同値にする＝「単点は信じない」という
   * §18 の思想は高震度でも維持したまま、震度のバーだけ 0.5 → 2.5 に上げて点数待ちを外す対称的な拡張。
   *
   * 2 である根拠（3 では機能しない）: 2026-08-07 10:02 の福井の地震（最大震度3）を Yahoo 実データで
   * 追うと、全国で value >= 2.5 に達した観測点はピークでも **2 点**（相互距離 13km）しかなかった。
   * 3 にすると本ケースのような「震度3が数点だけ」の地震を一切救えず、パラメータとして死ぬ。
   *
   * なおこの 2 点は必ず同一イベントのメンバー＝L2 連結成分の由来であることが構造的に保証される
   * （updateEventMetrics は e.memberKeys しか走査しない）。遠く離れた 2 点がたまたま同時に高震度でも
   * 別イベントとして扱われるため fast path は発火せず、空間コヒーレンスの要求は温存される。
   */
  HIGH_CONFIRM_POINTS: 2,
  /** confirmed 連続フレーム数（積分待ちなしで V1 相当の速さ） */
  CONFIRM_FRAMES: 2,
  /** 確定保持(ms)。確定揺れ点が途切れてもこの間はイベントを保持（明滅防止・V1 相当の保持） */
  HOLD_MS: 10_000,
  /**
   * EEW 発表中（frame.eewActive）に CONFIRM_POINTS の代わりに使う確定点数。MIN_LIKELY_POINTS と
   * 同値にして「likely 相当の広がりがあれば、最大震度・確定震度到達点数さえ満たせば即 confirmed」
   * という分かりやすい緩和にする。CHRONIC_POINT_BUMP はこの値の上にも適用する（慢性ノイズ地域の
   * 慎重さは EEW 中でも維持）。§19。
   */
  EEW_CONFIRM_POINTS: 3,
  /** EEW 発表中に CONFIRM_FRAMES の代わりに使う確定連続フレーム数（1 = 積分待ちなしで即確定）。§19 */
  EEW_CONFIRM_FRAMES: 1,
  /**
   * likely/faint のティア保持(ms)。一度 likely/faint に達した（spread を持った）イベントは、揺れの面が
   * 一時的に MIN_LIKELY_POINTS を割ってもこの間はティアを維持する（confirmed の everConfirmed ラッチに
   * 相当するが、こちらは「最後に spread を持ったフレームからの経過」で切る時間上限付き）。confirmed 未達の
   * 弱いイベント（例: 福岡 M2.4 震度1）が面の収縮で数秒後に weak＝非表示へ即転落し「検知が一瞬で消える」
   * のを防ぐ。1 局居残りで無限表示にならないよう survival(HOLD_MS)ではなく spread 基準で上限を切る。
   */
  LIKELY_HOLD_MS: 10_000,

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

/**
 * フレーム配列（座標順）→ 一意キー配列。Yahoo 強震モニタの公開座標は観測点によっては小数第1位までしか
 * 精度が無く、複数の実観測点が同一座標として配信されることがある（2026-08-08 天草・芦北地方の地震の
 * 誤報調査で発覚。全1725点中207グループ・431点が生座標レベルで完全一致）。siteKey(lat,lng) だけを
 * キーにすると後から処理した点が先勝ちの点を黙って上書きし、床学習・オンセット判定が別センサーの
 * データで汚染される（EWMA・onset窓は「同一物理点の連続観測」が前提）。同一座標が複数回現れた場合は
 * 出現順に #2, #3... を付与し、別実体として扱う。Yahoo 公式サイト自身も座標の重複を一切マージせず
 * 観測点ごとに別の描画要素（circle）を出し、震度が大きい方が上に重なるよう描画順をソートしているだけ
 * ——うちの実装でも別実体のまま持てば、既存の最大値集計（updateEventMetrics 等）が同じ結果に自然と
 * 収束する。
 */
export function computeSiteKeys(sites: [number, number][]): string[] {
  const seen = new Map<string, number>()
  return sites.map(([lat, lng]) => {
    const base = siteKey(lat, lng)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
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

/**
 * 表示専用の慢性ノイズ床（value）。震度0ドット表示（KyoshinSubThresholdGL）のフィルタに使う。
 * 検知トリガー用の effectiveFloor と異なり下限 FLOOR_MIN を適用しない。静かな観測点（floorMean が
 * 低い）はそのまま低い床のまま敏感に反応させ、慢性的にノイジーな観測点（floorMean が高い＝大阪・
 * 岡山のような都市部の常時微振動点）だけ床を上げて平常時の反応を鈍く見せる。上限 FLOOR_CAP のみ
 * 検知トリガー用の床と共有する（実地震の反応まで潰さないため）。
 */
export function chronicNoiseFloor(s: SiteState): number {
  return Math.min(s.floorMean + PARAMS.FLOOR_SIGMA_K * s.floorDev, PARAMS.FLOOR_CAP)
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

  // 座標が衝突する点も computeSiteKeys で別実体化した上で、全点をそのまま近傍計算にかける
  // （以前はここで座標重複を畳んで後発の点を丸ごと捨てていたため、それらの点は近傍グラフに
  // 一切載らずどのクラスタにも参加できなかった＝床学習・オンセット判定から常に排除されていた）。
  const keys = computeSiteKeys(sites)
  const uniq: { key: string; lat: number; lng: number }[] = sites.map(([lat, lng], i) => ({
    key: keys[i],
    lat,
    lng,
  }))
  for (const p of uniq) cellOf[p.key] = cellKey(p.lat, p.lng)

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

  return { neighbors, avail, cellOf, keys }
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
  /** 床 + LEVEL_MARGIN を超え「揺れている」か（rate 不問。onset 素地・最大震度に使う。震度0 を含む） */
  levelActive: boolean
  /** 床 + SUSTAIN_MARGIN を超え「継続して明確に揺れている」か（継続点数・保持に使う。平常の震度0 は除外） */
  sustained: boolean
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
  const m = meta ?? buildStationMeta(frame.sites)

  // 不連続（大きな時刻ジャンプ・巻き戻し・コールドスタート初フレーム）は一過性の状態を
  // 作り直す。ただし学習資産（点別床・セル慢性活性）は引き継ぐ（永続化からの復元を保つ・
  // 数十秒の欠測で床/地域活性を捨てない）。
  if (dtMs <= 0 || dtMs > PARAMS.MAX_DT_GAP_MS) {
    const seed = initState(now)
    seed.cellActivity = { ...state.cellActivity }
    const rebuilt = ingest(seed, frame, m, state)
    return { state: rebuilt, detections: [], triggers: [] }
  }

  // ---- L1 点トリガー ----
  const sites: Record<string, SiteState> = {}
  const points: FramePoint[] = []
  const cur = new Map<string, FramePoint>()
  const triggeredAt: Record<string, number | null> = {}

  for (let i = 0; i < frame.values.length; i++) {
    if (frame.missing?.[i]) continue
    const [lat, lng] = frame.sites[i]
    const key = m.keys[i]
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
    const sustained = value >= floor + PARAMS.SUSTAIN_MARGIN && value >= PARAMS.TRIG_FLOOR
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

    const fp: FramePoint = { key, lat, lng, value, levelActive, sustained, onset }
    points.push(fp)
    cur.set(key, fp)
  }

  // ---- L2 同期 onset の空間的広がり（連結成分で確定揺れ点を判定）----
  // 「直近 COINCIDENCE_MS に onset した点」を K 近傍グラフで連結し、成分サイズが MIN_CLUSTER 以上の
  // 成分を「揺れクラスタ」とする。成分＜MIN_CLUSTER は散在ノイズとして破棄する（Scratch のグリッド
  // 上昇割合に相当する面判定。per-point の近傍一致より頑健で、時間差 onset のクラスタも取りこぼさず、
  // 絶対レベルを震度0 まで下げても平常ノイズは成分が育たず脱落する）。
  const recentOnset: string[] = []
  for (const p of points) {
    const trigAt = triggeredAt[p.key]
    if (trigAt != null && now - trigAt <= PARAMS.COINCIDENCE_MS) recentOnset.push(p.key)
  }
  const clusters = connectedComponents(recentOnset, m.neighbors).filter(
    (c) => c.length >= PARAMS.MIN_CLUSTER,
  )
  const confirmedShaking = clusters.flat()
  const shakingSet = new Set(confirmedShaking)
  const triggers: TriggerResult[] = points
    .filter((p) => p.onset || shakingSet.has(p.key))
    .map((p) => ({
      key: p.key,
      lat: p.lat,
      lng: p.lng,
      value: p.value,
      confirmedShaking: shakingSet.has(p.key),
    }))

  // ---- L3 イベント帰属（クラスタ＝広がりのある成分をイベントへ）----
  const { events, nextEventId } = associate(
    state.events,
    state.nextEventId,
    clusters,
    cur,
    triggeredAt,
    state.cellActivity,
    m.cellOf,
    m.avail,
    now,
    frame.eewActive ?? false,
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
  // onset から FLOOR_FREEZE_MS の間は、COINCIDENCE_MS を過ぎて揺れが収まったと判定された直後でも
  // 学習をスキップする（揺れの残響を静穏点のノイズ床として誤学習しないようにする。詳細は FLOOR_FREEZE_MS
  // のコメント参照）。
  const coincidentSet = new Set(confirmedShaking)
  for (const p of points) {
    const s = sites[p.key]
    if (p.levelActive || coincidentSet.has(p.key)) continue // 凍結(揺れ中)
    const trigAt = triggeredAt[p.key]
    if (trigAt != null && now - trigAt <= PARAMS.FLOOR_FREEZE_MS) continue // 凍結(揺れの残響期間)
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
  avail: Record<string, number>,
  now: number,
  eewActive: boolean,
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
      updateEventMetrics(target, cur, triggeredAt, cellActivity, cellOf, avail, now, eewActive)
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
        lastSpreadAtMs: 0,
      }
      updateEventMetrics(ev, cur, triggeredAt, cellActivity, cellOf, avail, now, eewActive)
      events.push(ev)
      updated.add(ev.id)
    }
  }

  // 今フレームで確定揺れ点を伴わなかったイベント: 指標を再評価し、HOLD 経過で解除する。
  const survivors: DetectionEvent[] = []
  for (const e of events) {
    if (!updated.has(e.id)) {
      updateEventMetrics(e, cur, triggeredAt, cellActivity, cellOf, avail, now, eewActive)
    }
    if (now - e.lastOnsetAtMs <= PARAMS.HOLD_MS) survivors.push(e)
  }

  return { events: mergeAdjacentEvents(survivors), nextEventId: idCounter }
}

/**
 * 重心が MERGE_EVENT_KM 以内のイベントを 1 本化する（フレーム末 consolidation）。
 * 沖合・深発の揺れ域が海/山ギャップで複数成分に割れた同一地震を統合する。
 * host は発生時刻が早い方（＝ID を継承）。メンバー・セルは和集合、点数は合算、最大震度は max、
 * 確信度は everConfirmed の論理和で再評価する。離れた別地震（>MERGE_EVENT_KM）は併合しない。
 */
function mergeAdjacentEvents(events: DetectionEvent[]): DetectionEvent[] {
  if (events.length <= 1) return events
  const ordered = [...events].sort((a, b) => a.originTimeMs - b.originTimeMs)
  const hosts: DetectionEvent[] = []
  for (const e of ordered) {
    const host = hosts.find(
      (h) =>
        !!e.epicenter &&
        !!h.epicenter &&
        haversineKm(e.epicenter[0], e.epicenter[1], h.epicenter[0], h.epicenter[1]) <=
          PARAMS.MERGE_EVENT_KM,
    )
    if (!host) {
      hosts.push(e)
      continue
    }
    // 重心は点数の多い側（主パッチ）を採用
    if (e.lastSize > host.lastSize) host.epicenter = e.epicenter
    host.memberKeys = [...new Set([...host.memberKeys, ...e.memberKeys])]
    host.cells = [...new Set([...host.cells, ...e.cells])]
    host.lastSize = host.lastSize + e.lastSize
    host.maxIntensity = Math.max(host.maxIntensity, e.maxIntensity)
    host.lastOnsetAtMs = Math.max(host.lastOnsetAtMs, e.lastOnsetAtMs)
    host.lastSpreadAtMs = Math.max(host.lastSpreadAtMs, e.lastSpreadAtMs)
    host.confirmStreak = Math.max(host.confirmStreak, e.confirmStreak)
    host.everConfirmed = host.everConfirmed || e.everConfirmed
    host.confidence = host.everConfirmed
      ? 'confirmed'
      : host.confidence === 'likely' || e.confidence === 'likely'
        ? 'likely'
        : host.confidence
  }
  return hosts
}

/**
 * イベントの指標（アクティブメンバー数・最大震度・重心）を再計算し、確信度を分類する。
 *
 * - lastSize    : 現在「揺れているメンバー数」＝ sustained（床を明確に超えて継続中）または直近
 *   TRIG_ACTIVE_MS に onset したメンバー。値が頭打ちで onset が止まっても、揺れが続く限り減らない
 *   （旧実装は onset 数のみで数え、揺れ継続中に size が減衰してイベントが早期消滅する不具合があった）。
 * - maxIntensity: levelActive なメンバー現在 value の最大（震度0 を含む＝PLUM 出力・faint 表示）。無ければ前値。
 * - lastOnsetAtMs: 揺れ継続中（size>0）は毎フレーム更新し、揺れが収まってから HOLD_MS 経過で解除する。
 * - confidence  : 点数＋最大震度ゲート＋確定震度到達点数(CONFIRM_INTENSE_POINTS)＋CONFIRM_FRAMES 連続。
 *   特異度は点別床(L1)とセル慢性活性で二軸に、さらに「確定震度に達した点が複数あるか」で第3軸を足す
 *   （単点だけ震度1・周囲は震度0 の局所ノイズを弾く。§18）。慢性活性セルでは確定点数・確定震度のバーを
 *   引き上げる（北関東のコヒーレントノイズ対策・第2軸）。一度 confirmed に達したら HOLD 中は confirmed を
 *   維持する（明滅防止のラッチ）。likely/faint も一度 spread を持てば LIKELY_HOLD_MS の間はティアを維持
 *   する（弱いイベントの「一瞬で消える」防止。震度1到達点数ゲートは confirmed のみで likely には課さない）。
 *   高震度 fast path（§20）: HIGH_CONFIRM_INTENSITY(震度3) 以上に達したメンバーが HIGH_CONFIRM_POINTS 点
 *   以上あれば点数ゲート（慢性活性セルの引き上げ幅を含む）を免除する。CONFIRM_FRAMES の連続要求は残す。
 * - eewActive    : EEW 発表中は確定点数・確定連続フレーム数を EEW_CONFIRM_POINTS・EEW_CONFIRM_FRAMES に
 *   差し替えて確定を早める。CONFIRM_INTENSE_POINTS・MIN_CONFIRM_INTENSITY・慢性活性の引き上げ幅は
 *   変えないため、単点ノイズを弾く仕組み自体は EEW 中でも維持される（§19）。
 */
function updateEventMetrics(
  e: DetectionEvent,
  cur: Map<string, FramePoint>,
  triggeredAt: Record<string, number | null>,
  cellActivity: Record<string, number>,
  cellOf: Record<string, string>,
  avail: Record<string, number>,
  now: number,
  eewActive: boolean,
): void {
  let size = 0
  let maxV = -Infinity
  let availLocal = 0
  const lats: number[] = []
  const lngs: number[] = []
  const activeVals: number[] = [] // levelActive メンバーの現 value（震度1到達点数ゲート用）
  for (const k of e.memberKeys) {
    const p = cur.get(k)
    const t = triggeredAt[k]
    const recentOnset = t != null && now - t <= PARAMS.TRIG_ACTIVE_MS
    // 「揺れているメンバー」= 床を明確に超えて継続中（sustained）or 直近 onset。値頭打ちでも減らない。
    if ((p && p.sustained) || recentOnset) {
      size++
      availLocal = Math.max(availLocal, avail[k] ?? 0) // 局所に実在する近傍数（密度）
    }
    if (p && p.levelActive) {
      if (p.value > maxV) maxV = p.value
      activeVals.push(p.value)
      lats.push(p.lat)
      lngs.push(p.lng)
    }
  }
  e.lastSize = size
  if (maxV > -Infinity) e.maxIntensity = maxV
  if (lats.length > 0) e.epicenter = [mean(lats), mean(lngs)]
  // 揺れが続く限り保持を更新（揺れが収まってから HOLD_MS で解除。onset 途絶では解除しない）
  if (size > 0) e.lastOnsetAtMs = now

  // 地域軸: イベントが占有するセルの慢性活性の最大値
  let chronic = 0
  for (const c of e.cells) chronic = Math.max(chronic, cellActivity[c] ?? 0)
  const isChronic = chronic >= PARAMS.CHRONIC_THRESHOLD

  // 確定点数: 密な網では CONFIRM_POINTS（＋慢性活性セルは引き上げ）。疎地域（局所実在近傍が少ない
  // 離島・過疎網）では「(局所実在数+1)×CONFIRM_DENSITY_FRAC」まで下げる（下限 MIN_LIKELY_POINTS）。
  // EEW 発表中は基礎点数を EEW_CONFIRM_POINTS に差し替えて確定を早める（震源非依存のまま・§19）。
  // 慢性活性セルの引き上げ幅はそのまま適用し、EEW 中でも慢性ノイズ地域の慎重さは維持する。
  const confirmPointsBase = eewActive ? PARAMS.EEW_CONFIRM_POINTS : PARAMS.CONFIRM_POINTS
  const confirmPointsReq = confirmPointsBase + (isChronic ? PARAMS.CHRONIC_POINT_BUMP : 0)
  const densityReq = Math.ceil((availLocal + 1) * PARAMS.CONFIRM_DENSITY_FRAC)
  const effectiveConfirmReq = Math.max(
    PARAMS.MIN_LIKELY_POINTS,
    Math.min(confirmPointsReq, densityReq),
  )
  const confirmIntensityReq = isChronic
    ? PARAMS.CHRONIC_CONFIRM_INTENSITY
    : PARAMS.MIN_CONFIRM_INTENSITY
  // 確定震度レベル以上に達した点数。「単点だけ強く・周囲は震度0」というノイズ分布を弾く第3ゲート。
  const intenseCount = activeVals.filter((v) => v >= confirmIntensityReq).length
  // 高震度 fast path（§20）: HIGH_CONFIRM_INTENSITY(震度3) 以上に達したメンバーが
  // HIGH_CONFIRM_POINTS 点以上あれば、点数（size）ゲートを免除して確定する。震度3級はノイズ床の
  // 学習上限 FLOOR_CAP の外側にあり、かつ同一の連結成分内で複数点が同時に到達しているため、
  // 周辺へ揺れが伝播して CONFIRM_POINTS(5点) が揃うのを待つ必要がない。
  // 免除するのは点数ゲート（size・慢性活性セルの引き上げ幅を含む）だけで、CONFIRM_FRAMES による
  // 連続フレーム要求は残す（単フレームの跳ね値・落雷起因の瞬間ノイズを弾く安全弁）。
  const highIntenseCount = activeVals.filter((v) => v >= PARAMS.HIGH_CONFIRM_INTENSITY).length
  const meetsHighFastPath = highIntenseCount >= PARAMS.HIGH_CONFIRM_POINTS
  const meetsConfirm =
    meetsHighFastPath ||
    (size >= effectiveConfirmReq &&
      e.maxIntensity >= confirmIntensityReq &&
      intenseCount >= PARAMS.CONFIRM_INTENSE_POINTS)
  e.confirmStreak = meetsConfirm ? e.confirmStreak + 1 : 0
  const confirmFramesReq = eewActive ? PARAMS.EEW_CONFIRM_FRAMES : PARAMS.CONFIRM_FRAMES
  if (e.confirmStreak >= confirmFramesReq) e.everConfirmed = true

  // 確信度: 実在性（広がり size）は L2 で担保済み。ここで点数・最大震度から段階化する。
  //  - confirmed/likely は震度1以上（音を鳴らす重み）。confirmed 到達後は HOLD 中ラッチで維持。
  //  - faint は同期 onset の広がりはあるが震度1未満（震度0級）。無音で控えめに可視化する。
  const hasSpread = size >= PARAMS.MIN_LIKELY_POINTS
  if (hasSpread) e.lastSpreadAtMs = now
  // spread を持った likely/faint は、面が一時的に MIN_LIKELY_POINTS を割っても LIKELY_HOLD_MS の間は
  // ティアを維持する（confirmed の everConfirmed ラッチに相当・時間上限付き）。confirmed 未達の弱い
  // イベントが数秒で weak（非表示）へ即転落し「検知が一瞬で消える」のを防ぐ。
  const spreadHeld =
    hasSpread || (e.lastSpreadAtMs > 0 && now - e.lastSpreadAtMs <= PARAMS.LIKELY_HOLD_MS)
  if (e.everConfirmed) {
    e.confidence = 'confirmed'
  } else if (spreadHeld && e.maxIntensity >= PARAMS.MIN_LIKELY_INTENSITY) {
    e.confidence = 'likely'
  } else if (spreadHeld) {
    e.confidence = 'faint'
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
 * キーは呼び出し側が構築済みの `meta.keys`（座標衝突の別実体化を含む）を使う。
 */
function ingest(state: DetectorState, frame: Frame, meta: StationMeta, prev?: DetectorState): DetectorState {
  const sites: Record<string, SiteState> = {}
  for (let i = 0; i < frame.values.length; i++) {
    if (frame.missing?.[i]) continue
    const key = meta.keys[i]
    const value = indexToValue(frame.values[i])
    const prior = prev?.sites[key]
    sites[key] = prior
      ? { hist: [{ t: frame.dataTimeMs, v: value }], floorMean: prior.floorMean, floorDev: prior.floorDev, triggeredAtMs: null }
      : initSiteState(value, frame.dataTimeMs)
  }
  return { ...state, sites, lastDataTimeMs: frame.dataTimeMs }
}
