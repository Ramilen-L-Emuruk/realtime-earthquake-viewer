/**
 * 強震モニタ揺れ検知エンジン V3（純粋コア・近傍一致／PLUM 型）。
 *
 * 設計書: docs/spec/kyoshin-detection-v3-design.md
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
  /**
   * 最後に levelActive（床 + LEVEL_MARGIN を超えていた）だった dataTime(ms)。一度も無ければ null。
   * イベントのメンバーを「値が下がりきったら外す」判定（`pruneFadedMembers`）に使う。
   */
  lastLevelActiveAtMs: number | null
}

/**
 * 確信度の判定に使った値の内訳（根拠開示・**表示専用**）。
 *
 * `updateEventMetrics` が確信度を決めた**そのフレームの**要求値と中間集計を、判定を終えた後に
 * そのまま持ち帰るだけのもの。「なぜこの確信度なのか」「確定まであと何が足りないか」を
 * 画面と診断ログへ出すために置いている。
 *
 * 守ること 3 つ。
 *
 * 1. **判定はここを読まない。** 分岐の入力にすると、表示のための構造体が判定の一部になり、
 *    片方を変えたときにもう片方が黙って変わる。書くのは判定を終えた後の 1 箇所だけにする
 * 2. **イベント自身が既に持っている値を写さない。** 点数は `lastSize`、震度は `maxIntensity`、
 *    連続フレーム数は `confirmStreak`、周囲の裏付けは `everNeighborRise` が持っている。
 *    ここへ複製すると `mergeAdjacentEvents` が本体だけを書き換えたときに二重管理が食い違う。
 *    **ここに置くのは「要求値」と「イベントに残らない中間集計」だけ**
 * 3. **要求値は毎フレーム動く。** 慢性活性セル・疎地域・EEW 発表中で確定点数の要求が変わるため、
 *    定数として読まないこと（診断ログの記録が版をまたいで比較できるのもこれが理由）
 */
export interface DetectionGates {
  /** 確定に要る点数（`lastSize` と比べる）。慢性活性・疎地域・EEW で動く */
  sizeReq: number
  /**
   * 確定に要る最大震度（`maxIntensity` と比べる）。慢性活性セルでは引き上がる。
   * `updateEventMetrics` の `confirmIntensityReq` がそのまま入る。
   */
  intensityReq: number
  /** 確定震度に達したメンバー数（第3ゲート・§18）。イベントには残らない */
  intenseCount: number
  /** 第3ゲートに要る点数 */
  intenseReq: number
  /** 確定に要る連続フレーム数（`confirmStreak` と比べる）。EEW 中は短くなる */
  streakReq: number
  /** 高震度 fast path の対象メンバー数（§20・§29）。イベントには残らない */
  highIntenseCount: number
  /** 高震度 fast path に要る点数 */
  highIntenseReq: number
  /** 高震度 fast path の対象になる震度（計測震度）。この値以上のメンバーを数える */
  highIntensityReq: number
  /** 高震度 fast path が成立し、点数ゲートを免除したか */
  fastPath: boolean
  /** likely の広がり条件を、`LIKELY_HOLD_MS` の保持を含めて満たしているか */
  spreadHeld: boolean
  /** likely に要る震度（`everNeighborRise` と併せて likely の条件になる） */
  likelyIntensityReq: number
  /** 慢性活性セル（確定の要求を引き上げている） */
  chronic: boolean
  /** 疎地域（局所の実在近傍数から確定点数の要求を引き下げている） */
  sparse: boolean
  /** EEW 発表中（確定の点数・連続フレーム数の要求を引き下げている） */
  eewActive: boolean
  /** 単点のまま居座って確定を降ろされたか（§33）。降格した場合は確信度が weak になる */
  soloStale: boolean
}

/**
 * 確定した瞬間の判定材料（根拠開示・表示専用）。
 *
 * `DetectionGates` が**現フレームの姿**しか持たないのに対し、こちらは `everConfirmed` が立った
 * 瞬間で凍結する。確定後は震度が減衰して点数も減り、`everConfirmed` のラッチだけが確信度を
 * 支える局面が普通に来るため、現フレームの内訳から「なぜ確定したか」は復元できない。
 */
export interface ConfirmSnapshot {
  /**
   * 確定した dataTime(ms)。凍結した当時の `firstConfirmedAtMs` と同値。
   *
   * **どちらの内訳を採るかの比較に使う。** 併合（`mergeAdjacentEvents`）は同じイベント ID へ
   * 別イベントの内訳を持ち込むため、「先に来たほう」ではなく「先に確定したほう」で選ばないと、
   * 画面が出している根拠と診断ログの根拠が食い違う。
   */
  atMs: number
  /** 確定した瞬間の「揺れ継続中の点数」 */
  size: number
  /** 確定した瞬間の最大震度（計測震度） */
  intensity: number
  /** 確定した瞬間に課されていた要求値と中間集計 */
  gates: DetectionGates
}

/** 検知イベント（多重地震・余震を同時に保持できる）。 */
export interface DetectionEvent {
  id: string
  confidence: Confidence
  /**
   * 参加した確定揺れ点の座標キー。増える側は和集合だが、値が下がりきった点は `pruneFadedMembers` で
   * 外れる（UI の震度分布・自動フィットに使う）。**イベントが生存している間に空にはならない**
   * （`MEMBER_DROP_MS` の下限がそれを保証する）。
   */
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
  /** 初めて confirmed に達した dataTime(ms)。単点のまま居座る確定を降ろす判定に使う。未達は 0 */
  firstConfirmedAtMs: number
  /**
   * 一度でも単点でなくなった（`lastSize >= SOLO_DECAY_SIZE`）か。
   *
   * **これが立たないまま `SOLO_CONFIRM_GRACE_MS` を過ぎた確定は降ろす**（§33）。実データ 793 窓では、
   * 気象庁発表の地震に紐づく確定検知 823 件すべてがいずれ単点でなくなり、遅れた 6 件も最長 9 秒だった。
   * 一方、上限に張り付いた観測点は永久に単点のまま居座る。
   */
  everMultiPoint: boolean
  /** 最後に spread（size ≥ MIN_LIKELY_POINTS）を持った dataTime(ms)。LIKELY_HOLD_MS の likely/faint 保持に使う。未達は 0 */
  lastSpreadAtMs: number
  /**
   * 一度でも周囲の同時上昇（`NEIGHBOR_RISE_FRAC`）を満たしたか。likely へ上げる条件のラッチ（§32）。
   *
   * **ラッチが要るのは「上がっている」が一瞬の性質だから。** 周囲が持ち上がるのは波が通り過ぎる
   * 1〜2 秒だけで、その後は横ばいになる（`rising` は上昇量で判定するので横ばいは偽）。毎フレーム
   * 評価にすると、揺れが続いている最中に条件を割って faint へ落ちる。問いたいのは「いま周囲が
   * 上がっているか」ではなく「**周囲が一度でも裏付けたか**」で、一斉に動いた事実は後から消えない。
   *
   * 副次的に、確信度が likely と faint を往復しなくなる。往復すると `useKyoshinAlerts` が候補音の
   * 立ち上がりを何度も検出して鳴らし直す（`everConfirmed` を確信度のラッチにしているのと同じ事情）。
   */
  everNeighborRise: boolean
  /**
   * 確信度の判定に使った値の内訳（表示専用）。毎フレーム `updateEventMetrics` が書き換える。
   * 判定の入力にしないこと（理由は `DetectionGates`）。
   */
  gates: DetectionGates
  /**
   * 確定した瞬間の判定材料（表示専用）。未確定は null。
   *
   * **一度入っても不変ではない。** `updateEventMetrics` は初めて確定したフレームで 1 度だけ
   * 書くが、`mergeAdjacentEvents` は別イベントを 1 本化するときに**より早く確定したほう**の
   * 内訳へ差し替える（`firstConfirmedAtMs` を早いほうへ揃えるのと対になる操作）。
   * この構造体を消費する側は「イベント ID ごとに不変」を前提にしないこと。
   */
  confirmedBy: ConfirmSnapshot | null
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
  keys: readonly string[]
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
   * 震源要素が確定した（＝仮定震源要素でない）EEW が発表中か（呼び出し側の責務。
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
  /**
   * 高震度（HIGH_CONFIRM_INTENSITY 以上）に達した点を含む成分に要する点数。MIN_CLUSTER より緩い
   * この段を挟むのは、震源最近傍の点が先に立ち上がる実地震の初動を MIN_CLUSTER(3) が取りこぼす
   * ためで、2 に留めるのは「震度3の単点は信じない」（§18）を維持するため。§29。
   */
  HIGH_CLUSTER_POINTS: 2,
  /**
   * 単独の点でも成分として認める震度下限(value)。3.5 = 震度4。
   *
   * 震源最近傍の1点だけが先に高震度へ達し、隣の点（20〜30km 先）にはまだ波が届いていない、という
   * 状態は実地震の初動として正常に起こる（能登半島地震 本震・2023 の両方で、震源近傍の単点が
   * 高震度に達してから周囲が反応するまで4〜5秒あることを Yahoo 実データで確認した）。この間は
   * 「単点だけ高震度・周囲は静穏」という分布が機器故障と区別できないため、点数ではなく**震度の
   * 高さ**で信頼するしかない。§29。
   *
   * 3.5 の根拠: 点別ノイズ床の学習上限 FLOOR_CAP=1.5（震度2相当）から 2 段階離れており、
   * HIGH_CONFIRM_INTENSITY(2.5) よりさらに外側にある。実データでは平常時に value >= 2.5 の出現が
   * 0 点であり、3.5 はその更に上。震度3（2.5〜3.4）は HIGH_CLUSTER_POINTS(2) 点を要求して単点を
   * 弾き、震度4以上でのみ単点を認めるという二段構えにしている。
   */
  SOLO_CLUSTER_INTENSITY: 3.5,
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
   *
   * **この値は発報側も借りている。** `useKyoshinAlerts` の `isSameShakeAsBefore` が、検知が途絶して
   * 復帰したときに「同じ揺れの続きか」を重心どうしの距離で照合する（誤ると無関係な地震の警報を
   * 無音で握り潰す）。動かすときはそちらの意味も見直すこと。
   */
  MERGE_EVENT_KM: 100,
  /**
   * 単点のまま確定が続くのを許す時間(ms)。これを過ぎても `lastSize` が `SOLO_DECAY_SIZE` に達して
   * いなければ、`everConfirmed` のラッチを降ろす（§33）。
   *
   * **鳴らす条件は変えない。** 震源最近傍の 1 点が先に立ち上がり、遅れて周囲へ伝播するのは実地震の
   * 正常な姿（能登本震）なので、発報はこれまでどおり即座に行う。問題は「周囲が続かなかったときに
   * 降りられない」ことのほうで、ここはその出口。
   *
   * 値の根拠: 実データ 793 窓で、気象庁発表の地震に紐づく確定検知 823 件のうち 817 件は確定した時点で
   * 既に単点ではなく、遅れた 6 件も 2/2/4/5/9 秒だった（最長 9 秒）。20 秒はその 2 倍以上の余裕。
   * 残る 1 件（55 秒）は設計書§30「残る課題」の富山の単独再検知そのもので、降ろしたい側にあたる。
   */
  SOLO_CONFIRM_GRACE_MS: 20_000,
  /**
   * 「単点ではなくなった」とみなす点数。**2 で十分**で、`MIN_CLUSTER`(3) にすると本物を巻き込む
   * （実データでは size 2 止まりの本物が 4 件あり、いずれも能登・福島の大地震の成分）。
   */
  SOLO_DECAY_SIZE: 2,
  /**
   * 単点でなくなったと認めるのに、対の相手へ値を要求し始める震度。
   *
   * **低い震度では要求しない。** 震源最近傍の 1 点が先に立ち上がり、隣が追いつくのに時間が
   * かかるのは実地震の正常な姿で、そこへ一律に値を課すと本物の初動まで降ろしてしまう。
   */
  SOLO_PAIR_HIGH_INTENSITY: 4.5,
  /**
   * 上の震度を超えたイベントで、対の相手に要求する値。
   *
   * **これが無いと、上限に張り付いた 1 点の隣で微動しているだけの点が「2 点目」に数えられる。**
   * 実際にリアルタイム震度7 の誤検知が 5 時間居座った（隣は 0.5 のまま 31 秒不変）。
   */
  SOLO_PAIR_MIN_INTENSITY: 2.0,

  /**
   * メンバーを外すまでの猶予(ms)。イベントのメンバーが「levelActive を最後に満たしてから」これを
   * 超えたら、そのイベントのメンバーから外す（`pruneFadedMembers`）。
   *
   * 【なぜ必要か】`memberKeys` は和集合で単調増加し、揺れが収まっても縮まなかった。表示・カメラ
   * フィットはこのメンバーを見るため、大地震のあと「値が下がりきった点」が全国に居残り、画が
   * 日本全域に張り付いたまま戻らない。2024-01-01 能登本震の実データでは、本震から 12 分後の本震
   * イベントのメンバー 870 点のうち 658 点（76%）が震度0未満（＝地図に描かれない帯）だった。
   *
   * 【なぜ判定を壊さないか】確定ゲートが数える対象は、この猶予より短い窓で絞られている。
   * `lastSize` は sustained（levelActive より一段高い床）か直近 TRIG_ACTIVE_MS の onset、
   * `maxIntensity`・`epicenter`・確定震度到達点数は levelActive のメンバーのみ。外れる点はどの
   * 指標にも寄与していない。
   *
   * 【なぜ TRIG_ACTIVE_MS + HOLD_MS 以上でなければならないか】メンバーが空になるより先に
   * **イベント自体が必ず消えている**ことを保証するため。ある点が onset した直後に値が沈むと、
   * その点は onset から TRIG_ACTIVE_MS(8s) の間 `lastSize` に寄与し続ける（`recentOnset` は
   * 現在の値を見ない）一方、`lastLevelActiveAtMs` は onset の瞬間で止まる。イベントは
   * 「size が 0 になってから HOLD_MS(10s)」で解除されるので、猶予がこの和(18s)を下回ると
   * **イベントが confirmed のまま生存しているのにメンバーだけ空になる窓**ができる。その窓では
   * `deriveKyoshinView` の `detectedPoints` が空になり、地図側の `hasDetection` が false へ落ちて
   * カメラが全国表示へ戻る（`CameraFollowsGL` の `FitToDetectionGL`）。この機構が直そうとしている
   * 「画が全国に張り付く」の裏返し（検知中に画が戻る）を作ってしまう。不変条件はテストで固定して
   * あり、窓が実際に作れないことも別のテストで確かめている。
   *
   * 【なぜ 20 秒か】下限 18 秒（TRIG_ACTIVE_MS + HOLD_MS）に余裕を 2 秒足した。刈り取りを遅らせる
   * ぶん「下がりきった点」が長く残るが、狙いは分オーダーで居残る点を消すことなので影響しない。
   */
  MEMBER_DROP_MS: 20_000,

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
   * 高震度 fast path に要する点数。1＝「震度3に達した点が1つでもあれば確定する」。
   *
   * 当初は CONFIRM_INTENSE_POINTS と同値の 2 だった（§18 の「単点は信じない」思想を高震度でも
   * 維持する意図）。2026-08-21 に能登半島地震 本震（2024-01-01 16:10）の実データで測り直したところ、
   * **2 では実質的に無効**だと分かった。震度3が2点に達する時点では L2 連結成分（MIN_CLUSTER=3）も
   * ほぼ同時に成立するため、点数ゲートの免除が確定を早める余地が残らない（実測: 2→1 の単独変更では
   * 初回 confirmed が 1 秒も動かない）。§29。
   *
   * 1 にする安全性の根拠:
   *  - 平常時（深夜・日中の各窓・全国1725点）で value >= 2.5 の出現は 0 点。ノイズ床の学習上限
   *    FLOOR_CAP=1.5 の外側にあり、単点でも震度3はノイズとして現れない。
   *  - CONFIRM_FRAMES(2) の連続要求は免除しないため、単フレームの跳ね値では確定しない。
   *  - fast path が数えるのは e.memberKeys＝同一イベントのメンバーだけなので、遠く離れた点が
   *    偶然同時に高震度でも別イベントとして扱われる（空間コヒーレンスの要求は温存）。
   */
  HIGH_CONFIRM_POINTS: 1,
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
  /**
   * 周囲の同時上昇を見る半径(km)。イベント重心からこの距離内にいる観測点を分母にする。
   *
   * 50km は L2 の近傍半径（`R_KM` 40km）より一回り広い。狙いは「揺れの面そのもの」ではなく
   * 「その面のまわりが一緒に持ち上がっているか」なので、成分に加わらなかった点まで含める必要がある。
   */
  NEIGHBOR_RADIUS_KM: 50,
  /**
   * likely に要する「圏内で同時に立ち上がっている点」の割合。
   *
   * **数えるのは床（震度0）を超えたかではなく、`RATE_MIN` 以上の上昇があったか。** 実地震は震度0 に
   * 届かない点まで一斉に持ち上げるが、局所ノイズは周囲を動かさない。L1 の `levelActive` は絶対レベルで
   * 切るため、床下で一斉に動いている証拠を丸ごと捨てていた。それを likely の裏付けとして拾い直す（§32）。
   *
   * 0.15 の根拠（実データ・設計書§32 付録の実測）:
   *  - 気象庁が発表した地震で likely 止まりだったもの（＝福岡型。音を鳴らしたい弱い実地震）は 22〜26%
   *  - 都市部の常習点による誤検知は 2〜12%
   *  - 実地震 735 件で確定検知（confirmed）の到達時刻は 1 件も動かない。likely を失うのは熊本 M2.1 の 1 件
   */
  NEIGHBOR_RISE_FRAC: 0.15,

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
// 観測点リストごとのキー配列。**同じ配列に対しては作り直さない。**
//
// 表示側（`kyoshinDetectionView` の `buildSiteIndex`）は強震モニタが 1 秒ごとに値を配るたびに
// これを呼ぶが、渡ってくる観測点リストは同じ配列（`fetchSiteList` がキャッシュしたもの）で、
// 座標が変わらない以上キーも変わらない。それでも全 1725 点ぶんの文字列を毎秒組み直しており、
// 非力な端末では自動移動 1 回のあいだに 30〜50ms をここで使っていた。
//
// **配列そのものを鍵にする**（中身の比較はしない）。観測点リストが差し替わるときは必ず別の配列に
// なるため、これで十分に見分けられる。WeakMap なので、リストが捨てられればキャッシュも一緒に消える。
//
// **返す配列は `readonly`。** キャッシュを入れる前は呼び出しごとに別の配列を返していたので、
// 誰かが並べ替えても他へは波及しなかった。いまは同じ配列を全員（近傍グラフ・表示用の索引・
// 診断ログ）が共有するため、1 箇所の書き換えが全部を同時に狂わせる。例外は出ず、座標とキーの
// 対応だけが静かにずれるので、型で止める。
const siteKeysCache = new WeakMap<readonly [number, number][], readonly string[]>()

export function computeSiteKeys(sites: [number, number][]): readonly string[] {
  const cached = siteKeysCache.get(sites)
  if (cached) return cached
  const seen = new Map<string, number>()
  const keys = sites.map(([lat, lng]) => {
    const base = siteKey(lat, lng)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
  siteKeysCache.set(sites, keys)
  return keys
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
    lastLevelActiveAtMs: null,
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
 *
 * PERF-2: 逆方向探索（cur を近傍に持つ点）を毎回 O(n·K) で全走査する実装から、
 * keys 内の点だけを対象にした `reverseAdj`（cur -> [cur を近傍に持つ keys 内の点]）
 * を事前構築して O(n·K) 全体に落とす。keys が大規模な同時 onset（大地震・多点ノイズ）
 * のときの探索コストがボトルネックだったのを解消する。
 */
/**
 * 連結成分をイベント候補として認める最小点数。成分内の最大震度が高いほど緩める（§29）。
 *
 * 通常は MIN_CLUSTER(3) の面を要求する。震度3以上を含むなら HIGH_CLUSTER_POINTS(2)、震度4以上を
 * 含むなら 1 点で認める。震源最近傍の単点が先行する実地震の初動を取りこぼさないための段階付けで、
 * 高い震度ほどノイズ床（FLOOR_CAP=1.5）から離れていることが根拠。判定は成分ごとに閉じているため、
 * 他所のノイズの有無で本物の判定が変わることはない。
 *
 * @param maxValue 成分内メンバーの現在 value の最大
 */
function requiredClusterSize(maxValue: number): number {
  if (maxValue >= PARAMS.SOLO_CLUSTER_INTENSITY) return 1
  if (maxValue >= PARAMS.HIGH_CONFIRM_INTENSITY) return PARAMS.HIGH_CLUSTER_POINTS
  return PARAMS.MIN_CLUSTER
}

function connectedComponents(keys: string[], neighbors: Record<string, string[]>): string[][] {
  const inSet = new Set(keys)
  const visited = new Set<string>()
  const components: string[][] = []

  // 逆方向隣接: cur を近傍に含む keys 内の点を高速に引く。K が定数なので構築 O(n·K)。
  const reverseAdj = new Map<string, string[]>()
  for (const key of keys) {
    for (const nb of neighbors[key] ?? []) {
      if (!inSet.has(nb)) continue
      const list = reverseAdj.get(nb)
      if (list) list.push(key)
      else reverseAdj.set(nb, [key])
    }
  }

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
      // 近傍 → cur（cur を近傍に持つ確定揺れ点。非対称性の補完・reverseAdj で O(1) ルックアップ）
      for (const other of reverseAdj.get(cur) ?? []) {
        if (visited.has(other)) continue
        visited.add(other)
        queue.push(other)
      }
    }
    components.push(comp)
  }
  return components
}

/**
 * クラスタ(a)とイベント(bKeys)のメンバー重複率 = |a∩b| / |a|（＝「この成分の何割が既存メンバーか」）。
 *
 * 分母を成分側に固定するのが要点。かつては `min(|a|,|b|)` だったが、これはメンバーの少ないイベントに
 * 大きな成分が吸い込まれる向きに甘い（メンバー2点のイベントに 30 点の成分が 1 点だけ共通していると
 * 1/2 = 0.5 で帰属が成立してしまう）。`pruneFadedMembers` でメンバーが縮むようになったため、痩せた
 * 古いイベントが新しい地震を飲み込み、`everConfirmed` のラッチで初検知の発報が鳴らなくなる経路が
 * 現実的になった。成分側を分母にすれば「小さな成分が大きなイベントへ帰属する」向き（分子=分母で
 * 1.0）は保たれたまま、この向きだけが締まる。
 */
export function memberOverlapFrac(a: Set<string>, bKeys: string[]): number {
  if (a.size === 0 || bKeys.length === 0) return 0
  let common = 0
  for (const k of bKeys) if (a.has(k)) common++
  return common / a.size
}

// ============================================================
// step
// ============================================================

/** 空の検知状態を生成する（コールドスタート用）。warmup は無い。 */
/**
 * `DetectionGates` の初期値。イベント生成の直後に `updateEventMetrics` が必ず上書きするため、
 * 実行時にここの値が画面へ出ることはない（型を満たすための置き石）。
 *
 * 公開しているのは、`DetectionEvent` を組み立てるテストが「内訳には関心が無い」ことを
 * 明示できるようにするため。
 */
export function initGates(): DetectionGates {
  return {
    sizeReq: PARAMS.CONFIRM_POINTS,
    intensityReq: PARAMS.MIN_CONFIRM_INTENSITY,
    intenseCount: 0,
    intenseReq: PARAMS.CONFIRM_INTENSE_POINTS,
    streakReq: PARAMS.CONFIRM_FRAMES,
    highIntenseCount: 0,
    highIntenseReq: PARAMS.HIGH_CONFIRM_POINTS,
    highIntensityReq: PARAMS.HIGH_CONFIRM_INTENSITY,
    fastPath: false,
    spreadHeld: false,
    likelyIntensityReq: PARAMS.MIN_LIKELY_INTENSITY,
    chronic: false,
    sparse: false,
    eewActive: false,
    soloStale: false,
  }
}

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
    sites[k] = { hist: [], floorMean: fd[0], floorDev: fd[1], triggeredAtMs: null, lastLevelActiveAtMs: null }
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
  /**
   * 床の上下を問わず、RATE_DT_MS 窓で RATE_MIN 以上の上昇があったか（周囲の同時上昇の判定用）。
   * `onset` と違い `levelActive` を要求しない＝**震度0 に届かない点の立ち上がりも数える**。
   */
  rising: boolean
}

/**
 * 1 フレーム分の状態遷移（純粋）。1 秒ごとに呼ぶ。
 *
 * L1 点トリガー → L2 近傍同時性 → L3 連結成分グループ化・イベント帰属 → L4 確信度分類・保持判定。
 *
 * @param state 前状態
 * @param frame 現フレーム
 * @param meta 静的観測点メタ（未指定ならフレーム座標から都度構築。テスト・小規模用）
 * @returns `recentOnsetKeys` は直近 TRIG_ACTIVE_MS に立ち上がった観測点キー。表示側が
 *   「今まさに揺れ始めた点」と「揺れが去った後の残り」を区別するために使う
 *   （kyoshinDetectionView.dropIsolatedZeroPoints）。
 */
export function step(
  state: DetectorState,
  frame: Frame,
  meta?: StationMeta,
): {
  state: DetectorState
  detections: DetectionEvent[]
  triggers: TriggerResult[]
  recentOnsetKeys: string[]
  /**
   * 今フレームでイベントのメンバーから外した延べ点数（`pruneFadedMembers`）。刈り取りは点を静かに
   * 消す処理で失敗しても例外が出ないため、実運用で効き具合を追えるように件数だけ返す
   * （`dropIsolatedZeroPoints` を `recentOnsetKeys` の件数で追っているのと同じ趣旨）。
   */
  prunedMembers: number
} {
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
    return { state: rebuilt, detections: [], triggers: [], recentOnsetKeys: [], prunedMembers: 0 }
  }

  // ---- L1 点トリガー ----
  const sites: Record<string, SiteState> = {}
  const points: FramePoint[] = []
  const cur = new Map<string, FramePoint>()
  const triggeredAt: Record<string, number | null> = {}

  for (let i = 0; i < frame.values.length; i++) {
    const key = m.keys[i]
    if (frame.missing?.[i]) {
      // KYO-1: 欠測フレームでも学習資産（floorMean/floorDev）は据え置く。
      // 完全消失 → 次フレームで initSiteState から再学習になると、慢性ノイズ点の
      // floorDev=0 リセットが揺れ検知の閾値を崩し自己マスキングを起こしうる。
      // hist は空配列にリセットする（据え置くと復帰時に「N秒前のサンプル」を
      // windowRate が「RATE_DT_MS 窓の直近」として拾い、経過時間の乖離を検証しないため、
      // 気温/風/センサー再較正等による緩やかなドリフトを偽オンセットと誤判定しうる）。
      // triggeredAtMs は COINCIDENCE_MS の時刻ベース判定で自然に減衰するため保持可。
      const prev = state.sites[key]
      if (prev) sites[key] = { ...prev, hist: [] }
      continue
    }
    const [lat, lng] = frame.sites[i]
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
      lastLevelActiveAtMs: levelActive ? now : prev.lastLevelActiveAtMs,
    }
    sites[key] = s
    triggeredAt[key] = s.triggeredAtMs

    const fp: FramePoint = {
      key,
      lat,
      lng,
      value,
      levelActive,
      sustained,
      onset,
      rising: rate != null && rate >= PARAMS.RATE_MIN,
    }
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
  // 成分をイベント候補として認める点数は、成分内の最大震度で緩める（§29）。
  // 成分メンバーは必ず `cur` に登録済み（`connectedComponents` に渡す `recentOnset` は `points` 由来で、
  // `points` は欠測点と初出の点を除いた「今フレームで `cur` に入った点」だけを含む）。最大値の取り方は
  // updateEventMetrics と同じ手動比較に揃える（`Math.max` は引数に NaN が混ざると結果が NaN に固定され、
  // 同じ成分にいる他メンバーの震度を握り潰して fast path を静かに無効化する）。
  const clusters = connectedComponents(recentOnset, m.neighbors).filter((c) => {
    let maxV = -Infinity
    for (const k of c) {
      const v = cur.get(k)?.value
      if (v != null && v > maxV) maxV = v
    }
    return c.length >= requiredClusterSize(maxV)
  })
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
  const { events, nextEventId, prunedMembers } = associate(
    state.events,
    state.nextEventId,
    clusters,
    points,
    cur,
    triggeredAt,
    sites,
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
  // 直近 TRIG_ACTIVE_MS に立ち上がった点。イベントのメンバー判定（updateEventMetrics の
  // recentOnset）と同じ窓を使い、表示側でも「今揺れ始めた点」の基準を揃える。
  const recentOnsetKeys: string[] = []
  for (const p of points) {
    const t = triggeredAt[p.key]
    if (t != null && now - t <= PARAMS.TRIG_ACTIVE_MS) recentOnsetKeys.push(p.key)
  }
  return { state: nextState, detections, triggers, recentOnsetKeys, prunedMembers }
}

/**
 * 値が下がりきったメンバーをイベントから外す。
 *
 * 対象は「今フレームに値が届いている点」だけ。欠測・初出の点は判定材料が無いので残す（1 秒の瞬断で
 * メンバーが落ちると、地図の点とカードの点数が明滅する。欠測の穴埋めは表示側の保持機構の担当）。
 *
 * @param memberKeys イベントの現メンバー
 * @param cur 今フレームの点（欠測・初出は含まない）
 * @param sites 更新後の観測点状態（`lastLevelActiveAtMs` を見る）
 * @param now 現フレームの dataTime(ms)
 * @returns 残すメンバー
 */
export function pruneFadedMembers(
  memberKeys: string[],
  cur: Map<string, FramePoint>,
  sites: Record<string, SiteState>,
  now: number,
): string[] {
  return memberKeys.filter((k) => {
    if (!cur.has(k)) return true
    const s = sites[k]
    // 状態が無いのは想定外（`cur` に居る点は同じループで `sites` にも入る）。判定材料が無いので
    // 保持側に倒す。ここで外すと、リファクタで両者の構築が分かれた瞬間に「揺れている点を静かに
    // 落とす」側へ倒れる。
    if (!s) return true
    // 一度も levelActive になっていない点はメンバーになりえない（メンバーは onset 由来で、
    // onset は levelActive を含む）。状態リセット後の残骸なので外す。
    if (s.lastLevelActiveAtMs == null) return false
    return now - s.lastLevelActiveAtMs <= PARAMS.MEMBER_DROP_MS
  })
}

/**
 * 連結成分を既存イベントに帰属（メンバー重複 or セル共有）or 新規生成し、L4 の確信度分類・保持判定を行う。
 */
function associate(
  prevEvents: DetectionEvent[],
  nextEventId: number,
  components: string[][],
  framePoints: FramePoint[],
  cur: Map<string, FramePoint>,
  triggeredAt: Record<string, number | null>,
  sites: Record<string, SiteState>,
  cellActivity: Record<string, number>,
  cellOf: Record<string, string>,
  avail: Record<string, number>,
  now: number,
  eewActive: boolean,
): { events: DetectionEvent[]; nextEventId: number; prunedMembers: number } {
  // 値が下がりきったメンバーを外す。成分の帰属より先に行うことで、痩せたメンバーに対する重複率で
  // 帰属を判断させる（成分ごとに刈り取ると、同じフレーム内で順番によって結果が変わる）。
  // `cells` は刈らない——同じ場所の再 onset を同一イベントへ戻す錨で、これを失うと新規イベントが
  // 乱立する。
  let prunedMembers = 0
  const events = prevEvents.map((e) => {
    const memberKeys = pruneFadedMembers(e.memberKeys, cur, sites, now)
    prunedMembers += e.memberKeys.length - memberKeys.length
    return { ...e, memberKeys, cells: [...e.cells] }
  })
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
      updateEventMetrics(
        target,
        framePoints,
        cur,
        triggeredAt,
        cellActivity,
        cellOf,
        avail,
        now,
        eewActive,
        comp.length,
      )
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
        firstConfirmedAtMs: 0,
        everMultiPoint: false,
        lastSpreadAtMs: 0,
        everNeighborRise: false,
        gates: initGates(),
        confirmedBy: null,
      }
      updateEventMetrics(
        ev,
        framePoints,
        cur,
        triggeredAt,
        cellActivity,
        cellOf,
        avail,
        now,
        eewActive,
        comp.length,
      )
      events.push(ev)
      updated.add(ev.id)
    }
  }

  // 今フレームで確定揺れ点を伴わなかったイベント: 指標を再評価し、HOLD 経過で解除する。
  // 成分が帰属していないので compSize は 0 を渡す（高震度 fast path の点数免除を効かせない）。
  const survivors: DetectionEvent[] = []
  for (const e of events) {
    if (!updated.has(e.id)) {
      updateEventMetrics(e, framePoints, cur, triggeredAt, cellActivity, cellOf, avail, now, eewActive, 0)
    }
    if (now - e.lastOnsetAtMs <= PARAMS.HOLD_MS) survivors.push(e)
  }

  return { events: mergeAdjacentEvents(survivors, now), nextEventId: idCounter, prunedMembers }
}

/**
 * 重心が MERGE_EVENT_KM 以内のイベントを 1 本化する（フレーム末 consolidation）。
 * 沖合・深発の揺れ域が海/山ギャップで複数成分に割れた同一地震を統合する。
 * host は発生時刻が早い方（＝ID を継承）。メンバー・セルは和集合、点数は合算、最大震度は max、
 * 確信度は everConfirmed の論理和で再評価する。離れた別地震（>MERGE_EVENT_KM）は併合しない。
 */
function mergeAdjacentEvents(events: DetectionEvent[], now: number): DetectionEvent[] {
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
    // 確定の内訳は「先に確定したほう」から採る。`firstConfirmedAtMs` を早いほうへ揃えるのと
    // 対になる操作なので、**揃える前の値**で選ぶ
    const eConfirmedEarlier =
      e.firstConfirmedAtMs > 0 &&
      (host.firstConfirmedAtMs === 0 || e.firstConfirmedAtMs < host.firstConfirmedAtMs)
    if (host.confirmedBy == null || eConfirmedEarlier) {
      host.confirmedBy = e.confirmedBy ?? host.confirmedBy
    }
    // 確定の計時は早いほうに揃える（遅いほうに合わせると猶予が伸びる）。0 は未確定なので除く
    const confirmedAts = [host.firstConfirmedAtMs, e.firstConfirmedAtMs].filter((v) => v > 0)
    host.firstConfirmedAtMs = confirmedAts.length > 0 ? Math.min(...confirmedAts) : 0
    // **`everMultiPoint` は併合で引き継がない。**
    //
    // 和集合になるのだから引き継いでよさそうに見えるが、この印は一度立つと降りない。引き継ぐと
    // **併合相手が消えて根拠が無くなった後も残り、単点のまま居座る確定を降ろす契機が永久に消える**
    // （`MERGE_EVENT_KM` は 100km なので、固着した点の周りで無関係な小さい地震が 1 度起きる
    // だけで成立する。実測では 84km 先の震度1 が 6 秒あれば足りた）。
    //
    // 引き継がなくても困らない——併合後の姿は次のフレームの `updateEventMetrics` が host の
    // メンバー（和集合）で評価し直すので、**対が実在すればそこで立つ**。実データ 793 窓でも差分は出ない。
    // 併合したどちらかが周囲の裏付けを持っていれば、1 本化した後も持つ（メンバーは和集合になるため）
    host.everNeighborRise = host.everNeighborRise || e.everNeighborRise
    // 併合した結果に対して単点判定をやり直す（everMultiPoint は論理和・firstConfirmedAtMs は
    // 早いほうへ揃えた後なので、ここで評価すれば 1 本化した姿での判定になる）
    const hostStale = isSoloConfirmStale(host, now)
    host.confidence = host.everConfirmed && !hostStale
      ? 'confirmed'
      : hostStale
        ? 'weak' // 降ろした確定は下位ティアにも上げない（updateEventMetrics と同じ扱い）
        : host.confidence === 'likely' || e.confidence === 'likely'
          ? 'likely'
          : host.confidence
    // 内訳も 1 本化した姿に揃える。**併合が本体の値を書き換えた分だけ**追従させる
    // ——揃えないと「点数は 8 なのに内訳は 3 点で確定まであと 2 点」と表示が矛盾する。
    // 数え上げ（intenseCount・highIntenseCount）は `lastSize` と同じく合算する（メンバーは
    // 和集合で、併合対象の 2 イベントは別々の成分に由来するため重複しない）。
    // **要求値（sizeReq 等）は host のものを残す。** 併合後の密度・慢性活性で引き直すには
    // updateEventMetrics が持っている材料（avail・cellActivity）が要るが、ここには渡って
    // いない。ずれるのは併合が起きたフレームの 1 秒だけで、次フレームには引き直される。
    // `intenseCount` は**イベントごとに違うバーで数えた値**なので、単純に足せない
    // （`confirmIntensityReq` は慢性活性セルかどうかで変わり、併合の相手は最大 100km 離れている）。
    // バーが揃っているときだけ合算し、食い違うときは厳しいほうのバーを表示に残して、
    // **そのバーで実際に数えた側の値だけ**を採る。足りない側は数え直せないので載せない
    // ——欠けた数を出すほうが、違うバーで数えた点を混ぜた数を出すよりまし。
    // `highIntenseCount` は `HIGH_CONFIRM_INTENSITY` という全イベント共通の定数で数えるため、
    // この問題を持たない（そのまま合算してよい）。
    const intensityReq = Math.max(host.gates.intensityReq, e.gates.intensityReq)
    const sameBar = host.gates.intensityReq === e.gates.intensityReq
    host.gates = {
      ...host.gates,
      intensityReq,
      intenseCount: sameBar
        ? host.gates.intenseCount + e.gates.intenseCount
        : host.gates.intensityReq === intensityReq
          ? host.gates.intenseCount
          : e.gates.intenseCount,
      highIntenseCount: host.gates.highIntenseCount + e.gates.highIntenseCount,
      fastPath: host.gates.fastPath || e.gates.fastPath,
      // lastSpreadAtMs を max で揃えているので、保持の成立も論理和になる
      spreadHeld: host.gates.spreadHeld || e.gates.spreadHeld,
      // cells は和集合になるため、どちらかが慢性活性セルなら 1 本化した後もそう扱う
      chronic: host.gates.chronic || e.gates.chronic,
      soloStale: hostStale,
    }
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
 *   likely にはもう 1 つ条件があり、**周囲が一緒に立ち上がっていること**（`hasNeighborRise`・§32）を要する。
 *   単点だけが震度1 へ跳ね、周囲が微動だにしない分布は都市部の局所ノイズの典型で、瞬間の値の並びでは
 *   弱い実地震と区別が付かない。confirmed には課さない（`everConfirmed` のラッチが先に立つ）。
 * - eewActive    : EEW 発表中は確定点数・確定連続フレーム数を EEW_CONFIRM_POINTS・EEW_CONFIRM_FRAMES に
 *   差し替えて確定を早める。CONFIRM_INTENSE_POINTS・MIN_CONFIRM_INTENSITY・慢性活性の引き上げ幅は
 *   変えないため、単点ノイズを弾く仕組み自体は EEW 中でも維持される（§19）。
 */
function updateEventMetrics(
  e: DetectionEvent,
  framePoints: FramePoint[],
  cur: Map<string, FramePoint>,
  triggeredAt: Record<string, number | null>,
  cellActivity: Record<string, number>,
  cellOf: Record<string, string>,
  avail: Record<string, number>,
  now: number,
  eewActive: boolean,
  compSize: number,
): void {
  let size = 0
  let maxV = -Infinity
  let availLocal = 0
  const lats: number[] = []
  const lngs: number[] = []
  const activeVals: number[] = [] // levelActive メンバーの現 value（震度1到達点数ゲート用）
  // size に数えたメンバーの座標。単点判定の隣接チェックに使う（下記 hasAdjacentPair）
  const sizeLats: number[] = []
  const sizeLngs: number[] = []
  // 対の相手に値を要求するとき（下記 SOLO_PAIR_MIN_INTENSITY）に使う。座標と同じ並び
  const sizeVals: number[] = []
  for (const k of e.memberKeys) {
    const p = cur.get(k)
    const t = triggeredAt[k]
    const recentOnset = t != null && now - t <= PARAMS.TRIG_ACTIVE_MS
    // 「揺れているメンバー」= 床を明確に超えて継続中（sustained）or 直近 onset。値頭打ちでも減らない。
    if ((p && p.sustained) || recentOnset) {
      size++
      availLocal = Math.max(availLocal, avail[k] ?? 0) // 局所に実在する近傍数（密度）
      // 今フレームに値が届いていない点（欠測）は座標が引けない。隣接判定からは自然に落ちる
      if (p) {
        sizeLats.push(p.lat)
        sizeLngs.push(p.lng)
        sizeVals.push(p.value)
      }
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
  // 高震度 fast path（§20・§29）: HIGH_CONFIRM_INTENSITY(震度3) 以上に達したメンバーが
  // HIGH_CONFIRM_POINTS 点以上あれば、点数（size）ゲートを免除して確定する。震度3級はノイズ床の
  // 学習上限 FLOOR_CAP の外側にあるため、周辺へ揺れが伝播して CONFIRM_POINTS(5点) が揃うのを
  // 待つ必要がない。
  //
  // 免除するのは点数ゲート（size・慢性活性セルの引き上げ幅を含む）だけで、次の2つは免除しない。
  //  - CONFIRM_FRAMES の連続フレーム要求（単フレームの跳ね値・落雷起因の瞬間ノイズを弾く安全弁）
  //  - CONFIRM_INTENSE_POINTS の第3ゲート（§18）。「1点だけ強く・周囲は震度0」という局所ノイズの
  //    分布を、震度3のバーで再び通さないため。ただし成分点数の緩和（§29）で認められた小さな成分
  //    （compSize < MIN_CLUSTER）が今フレームに帰属したときは、そもそも点数が足りず課せないので
  //    震度の高さで代替する（震源最近傍の1点が先行する初動は、周囲がまだ静穏でも実地震の正常な姿）。
  //
  // この判定に lastSize（＝揺れているメンバー数）を使ってはいけない。lastSize は時間で減衰し、
  // TRIG_ACTIVE_MS(8s) の onset 途絶で 0 まで落ちる一方、イベントは HOLD_MS(10s) まで生存するため、
  // **確定に至らず消えていくイベントは必ず「size < MIN_CLUSTER だが生存中」を通過する**。そこで
  // 免除すると、その窓でメンバーの1点が震度3へ跳ねただけで confirmed になる（§18 が塞いだ分布と
  // 同型。実測で再現済み）。compSize は「今フレームに帰属した L2 成分の点数」で、成分が帰属して
  // いなければ 0 が渡る＝免除は効かない。
  // 免除は「今フレームに帰属した成分」だけで決める。時間保持を持たせてはいけない——イベント全体に
  // 保持フラグを持たせる実装を試したところ、「免除の根拠になった小さな成分の構成点」と「免除が適用
  // される高震度メンバー」が別人でも通る穴ができた（4 秒以内に別々のメンバーが 2 回スパイクすれば
  // 成立する。§29）。単点・2点の成分は毎フレーム requiredClusterSize を満たし直す必要があるため、
  // 値が閾値付近で 1 フレーム沈むと確定が遅れるが、それは受容している（変更前は単点では永久に
  // 確定しなかったので劣化ではない。実データ 34 窓では保持の有無で結果が一切変わらなかった）。
  const smallCluster = compSize > 0 && compSize < PARAMS.MIN_CLUSTER
  const highIntenseCount = activeVals.filter((v) => v >= PARAMS.HIGH_CONFIRM_INTENSITY).length
  const meetsHighFastPath =
    highIntenseCount >= PARAMS.HIGH_CONFIRM_POINTS &&
    (smallCluster || intenseCount >= PARAMS.CONFIRM_INTENSE_POINTS)
  const meetsConfirm =
    meetsHighFastPath ||
    (size >= effectiveConfirmReq &&
      e.maxIntensity >= confirmIntensityReq &&
      intenseCount >= PARAMS.CONFIRM_INTENSE_POINTS)
  e.confirmStreak = meetsConfirm ? e.confirmStreak + 1 : 0
  const confirmFramesReq = eewActive ? PARAMS.EEW_CONFIRM_FRAMES : PARAMS.CONFIRM_FRAMES
  if (e.confirmStreak >= confirmFramesReq && !e.everConfirmed) {
    e.everConfirmed = true
    e.firstConfirmedAtMs = now
  }

  // 単点のまま居座る確定を降ろす（§33）。
  //
  // **鳴らすのは今までどおり。** 震源最近傍の 1 点が先に立ち上がり、遅れて周囲へ伝播するのは実地震の
  // 正常な姿なので、発報を遅らせない。ここが直すのは「周囲が続かなかったときに降りられない」ほう。
  //
  // **「点数」だけで見てはいけない。** `memberKeys` は併合（`mergeAdjacentEvents`）で和集合になり、
  // 併合は重心が `MERGE_EVENT_KM`(100km) 以内なら成立する。離れた場所で別々に張り付いた 2 点が
  // 併合されると点数だけは 2 になり、この判定が丸ごと素通しになる。数えるのは「隣り合う対があるか」
  // ——L2 が成分を作るときと同じ `R_KM` を使う。
  // `size` の条件は `hasAdjacentPair` の呼び出しを省くための早期リターン（対が 1 つも無ければ
  // あちらも偽を返す）。`SOLO_DECAY_SIZE` を 3 以上へ動かしたときに意味を持つ
  // **高震度のイベントでは、対の相手にも値を要求する。**
  // 上限に張り付いた 1 点の隣で微動しているだけの点でも成分にはなるため、座標の隣接だけで
  // 見ると「2 点目が来た」と誤認し、単点居座りを降ろす契機が永久に消える。低い震度で要求
  // しないのは、隣が追いつくのに時間がかかる本物の初動を巻き込むため
  // （`SOLO_PAIR_HIGH_INTENSITY`）。
  let pairLats = sizeLats
  let pairLngs = sizeLngs
  if (maxV >= PARAMS.SOLO_PAIR_HIGH_INTENSITY) {
    pairLats = []
    pairLngs = []
    for (let i = 0; i < sizeLats.length; i++) {
      if (sizeVals[i] >= PARAMS.SOLO_PAIR_MIN_INTENSITY) {
        pairLats.push(sizeLats[i])
        pairLngs.push(sizeLngs[i])
      }
    }
  }
  if (!e.everMultiPoint && size >= PARAMS.SOLO_DECAY_SIZE && hasAdjacentPair(pairLats, pairLngs)) {
    e.everMultiPoint = true
  }
  // 降ろすのは確信度だけで、状態は書き換えない（理由は `isSoloConfirmStale` のコメント）。
  // 一度降りたら `everMultiPoint` が立つまで戻らない（遅れて隣接する点が続けば自力で復帰する）。
  const soloTooLong = isSoloConfirmStale(e, now)

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
  // 周囲の裏付けはラッチする（「上がっている」は波の通過中だけの一瞬の性質。毎フレーム評価だと
  // 揺れの最中に条件を割って faint へ落ちる。詳細は everNeighborRise のコメント）
  if (!e.everNeighborRise && hasNeighborRise(e, framePoints)) e.everNeighborRise = true
  if (e.everConfirmed && !soloTooLong) {
    e.confidence = 'confirmed'
  } else if (soloTooLong) {
    // **降ろした確定を下位ティアへ回り込ませない。** 3 点以上が鎖状に併合されると（併合は重心間
    // 100km で greedy に連なるため、互いに 40km 超でも成立する）`size` が MIN_LIKELY_POINTS に届き、
    // `spreadHeld` が立って `faint`、条件次第では `likely` にまで上がる。likely は候補音を鳴らす。
    // 「本物ではない」と判断して降ろしたものが下から出てくるのでは降ろした意味が無い
    e.confidence = 'weak'
  } else if (spreadHeld && e.maxIntensity >= PARAMS.MIN_LIKELY_INTENSITY && e.everNeighborRise) {
    e.confidence = 'likely'
  } else if (spreadHeld) {
    e.confidence = 'faint'
  } else {
    e.confidence = 'weak'
  }

  // 判定に使った値を持ち帰る（根拠開示・表示専用）。**確信度を決め終えた後に 1 箇所だけで書く**
  // ——判定の途中で書くと、以降の分岐がここを読める形になり、表示用の構造体が判定の入力になる。
  // 点数・震度・連続フレーム数・周囲の裏付けはイベント自身が持っているので複製しない（`DetectionGates`）。
  e.gates = {
    sizeReq: effectiveConfirmReq,
    intensityReq: confirmIntensityReq,
    intenseCount,
    intenseReq: PARAMS.CONFIRM_INTENSE_POINTS,
    streakReq: confirmFramesReq,
    highIntenseCount,
    highIntenseReq: PARAMS.HIGH_CONFIRM_POINTS,
    highIntensityReq: PARAMS.HIGH_CONFIRM_INTENSITY,
    fastPath: meetsHighFastPath,
    spreadHeld,
    likelyIntensityReq: PARAMS.MIN_LIKELY_INTENSITY,
    chronic: isChronic,
    // 疎地域の引き下げが「実際に効いたか」を見る。`densityReq < confirmPointsReq` で判定すると、
    // 下限（MIN_LIKELY_POINTS）に頭を押さえられて結局下がらなかった場合まで真になる
    sparse: effectiveConfirmReq < confirmPointsReq,
    eewActive,
    soloStale: soloTooLong,
  }

  // 確定したフレームの内訳を凍結する。判定した値を `e.gates` に組み上げた**後**に行う
  // ——`everConfirmed` が立つのは上の分岐の途中で、その時点の `e.gates` はまだ前フレームの姿。
  // 見分けは `firstConfirmedAtMs === now`（確定した当のフレームでだけ真になる）。
  if (e.confirmedBy == null && e.everConfirmed && e.firstConfirmedAtMs === now) {
    e.confirmedBy = { atMs: now, size, intensity: e.maxIntensity, gates: { ...e.gates } }
  }

  void cellOf
}

/**
 * 単点のまま確定が居座っているか（§33）。**確信度を決める箇所すべてでこれを使う。**
 *
 * `updateEventMetrics` と `mergeAdjacentEvents` の 2 箇所が確信度を書く。片方だけに置くと、
 * 併合が走ったフレームだけ `everConfirmed` から `confirmed` が付け直されて 1 フレーム復活する
 * （実測: 能登の富山イベントが復帰の瞬間に 1 フレームだけ confirmed へ跳ねた）。**1 フレームでも
 * 立ち上がれば `useKyoshinAlerts` が検知音を鳴らす**ので、判定はここに集約する。
 *
 * 状態は書き換えない。書き換えると確定条件を満たし直した瞬間に再確定し、猶予の周期で明滅する。
 */
function isSoloConfirmStale(e: DetectionEvent, now: number): boolean {
  return (
    e.everConfirmed &&
    !e.everMultiPoint &&
    e.firstConfirmedAtMs > 0 &&
    now - e.firstConfirmedAtMs > PARAMS.SOLO_CONFIRM_GRACE_MS
  )
}

/**
 * 与えられた点の中に、`R_KM` 以内で隣り合う対が 1 つでもあるか。
 *
 * 「単点ではなくなった」の判定に使う（§33）。**点数を数えるだけでは足りない**——イベントのメンバーは
 * 併合で和集合になるため、100km 離れた 2 つの故障点でも点数は 2 になる。実地震の面は L2 が `R_KM` の
 * 近傍グラフで連結して作るので、同じ尺度で「隣り合っているか」を見る。
 *
 * 走査は O(n^2) だが、呼ぶのはラッチが立つまでの間だけで、実地震なら最初の対で即座に成立する。
 */
function hasAdjacentPair(lats: readonly number[], lngs: readonly number[]): boolean {
  const latMargin = PARAMS.R_KM / KM_PER_DEG
  for (let i = 0; i < lats.length; i++) {
    for (let j = i + 1; j < lats.length; j++) {
      if (Math.abs(lats[i] - lats[j]) > latMargin) continue
      if (haversineKm(lats[i], lngs[i], lats[j], lngs[j]) <= PARAMS.R_KM) return true
    }
  }
  return false
}

/**
 * イベントの周囲が一緒に立ち上がっているか（§32）。
 *
 * 重心から `NEIGHBOR_RADIUS_KM` 内にいる観測点のうち、同じ窓で `RATE_MIN` 以上上がっている点の割合が
 * `NEIGHBOR_RISE_FRAC` 以上なら真。**床（震度0）に届かない点も数える**のが要点で、実地震は震度0 未満の
 * 点まで一斉に持ち上げるのに対し、局所ノイズは周囲を動かさない。
 *
 * **圏内に点が 1 つも無ければ偽**（判定できないものを通さない）。疎地域の救済は入れていない——
 * 実データ 793 窓で「圏内が数点しか無い」状況は起きず、代わりに大量欠測の瞬間だけ分母が縮んで
 * 判定を素通しし、ラッチで likely が開きっぱなしになる穴になる。守りたい相手（欠測グリッチ）に
 * 対して逆を向く緩和は置かない。
 *
 * @param framePoints 今フレームで値が届いた点（欠測・初出は含まない＝分母から自然に落ちる）
 */
function hasNeighborRise(e: DetectionEvent, framePoints: FramePoint[]): boolean {
  const ep = e.epicenter
  if (!ep) return false
  // 緯度バウンディングボックスで haversine の呼び出しを間引く（buildStationMeta と同じ前段）
  const latMargin = PARAMS.NEIGHBOR_RADIUS_KM / KM_PER_DEG
  let total = 0
  let rising = 0
  for (const p of framePoints) {
    if (Math.abs(p.lat - ep[0]) > latMargin) continue
    if (haversineKm(ep[0], ep[1], p.lat, p.lng) > PARAMS.NEIGHBOR_RADIUS_KM) continue
    total++
    if (p.rising) rising++
  }
  if (total === 0) return false
  return rising / total >= PARAMS.NEIGHBOR_RISE_FRAC
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
      ? { hist: [{ t: frame.dataTimeMs, v: value }], floorMean: prior.floorMean, floorDev: prior.floorDev, triggeredAtMs: null, lastLevelActiveAtMs: null }
      : initSiteState(value, frame.dataTimeMs)
  }
  return { ...state, sites, lastDataTimeMs: frame.dataTimeMs }
}
