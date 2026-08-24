// V2 検知エンジン（kyoshinDetector）の出力（DetectionEvent[]）を、UI・音・地図フィットが
// 消費する「表示状態」へ変換する純粋ユーティリティ。
// エンジンは震源・確信度・メンバー観測点キーを持つが、地図フィット/検知点マーカーは
// 座標＋現在インデックスの点列（DetectedPoint）を要求するため、ここで memberKeys を解決する。

import { computeSiteKeys, type DetectionEvent } from './kyoshinDetector'
import { kyoshinIndexToJma } from './kyoshinIntensity'
import { haversineKm } from './geo'
import type { SiteCoords } from '../services/kyoshin'

/** 地図フィット・検知点マーカー・ヒストグラムが扱う観測点（座標＋現在インデックス）。 */
export interface DetectedPoint {
  /**
   * 観測点キー（`computeSiteKeys` 由来）。同一座標に複数の実体がある観測点が実在するため
   * （`buildSiteIndex` 参照）、点の同一性は座標ではなくこのキーで判断する。
   */
  key: string
  lat: number
  lng: number
  index: number
  /**
   * `index` が「現フレームは欠測で、直前の有効値を保持している」値かどうか
   * （`utils/kyoshinMissingHold.ts`）。描画側は保持中の点を半透明で描く。
   * 保持を通していない経路（テスト・保持前の生値）では undefined。
   */
  stale?: boolean
}

/**
 * 「孤立した震度0の検知点」を判定する近傍半径(km)。この距離内に震度1以上の検知点が無ければ孤立とみなす。
 *
 * 30km の根拠（2024-08-08 日向灘 M7.1 の実データ80分で計測。詳細は設計書 §22）: 20km に下げると
 * 間引き量は増える（延べ描画の 7.8%→16.3%）が、揺れが広がっていく最初の数分で「これから震度1以上へ
 * 育つ点」＝到達先端を誤って消す数が 54→244 点に膨らむ。40km 以上では収束期の残りがほとんど落ちない。
 * 検知エンジンの近傍半径 PARAMS.R_KM(40km) とは別概念のため独立に持つ（あちらは「onset を連結して
 * 面と認めるか」、こちらは「描いた点が揺れの面の一部か」）。
 */
export const ISOLATED_ZERO_RADIUS_KM = 30

/** 検知の表示状態（音・自動タブ切替・自動フィットの駆動元）。 */
export interface KyoshinView {
  /** confirmed イベントが1件以上あるか（＝V1 の detected 相当） */
  confirmed: boolean
  /** likely イベントが1件以上あるか（＝V1 の候補クラスタ相当・早期反応の駆動元） */
  candidate: boolean
  /**
   * confirmed 全イベントのメンバー観測点（**自動フィット・検知の継続判定用**）。
   * 孤立した震度0点の間引き（`dropIsolatedZeroPoints`）は**通していない**。
   * カメラ追従（`CameraFollowsGL`）と `JapanMapGL` はこの配列が空になったことを「検知が終わった」
   * 合図として扱い、日本全体へ戻す。表示を整えるフィルタでここを空にすると、検知が続いている最中に
   * カメラが勝手に引く（実測: 2024-08-08 日向灘のリプレイで 20 秒間・往復2回）。
   * 地図に描くのは下の `detectedMarkerPoints` の方。
   */
  detectedPoints: DetectedPoint[]
  /** confirmed 全イベントのメンバー観測点のうち**実際に描く**もの（`dropIsolatedZeroPoints` 適用後） */
  detectedMarkerPoints: DetectedPoint[]
  /**
   * 主 likely イベント（score 最大）のメンバー観測点（候補フィット用）。
   * `detectedPoints` と同じ理由で間引きを通していない（候補カメラフィットの対象）。
   */
  candidatePoints: DetectedPoint[]
  /**
   * confirmed 以外（likely / faint）の全イベントのメンバー観測点（検知点マーカー用）。
   * リアルタイムタブの検知カードが集計する集合（weak 以外の全イベント）と一致させるため、
   * detectedMarkerPoints とこの 2 本で全体を覆う。**カメラフィットには使わない**
   * （候補フィットは主 likely 1 件の candidatePoints を使う。理由は deriveKyoshinView 参照）。
   * 間引きの対象は confirmed のメンバーだけなので、こちらは素通し（理由は
   * `dropIsolatedZeroPoints` の「なぜ対象を confirmed に限るか」）。
   */
  unconfirmedPoints: DetectedPoint[]
  /** 主 likely イベントの安定 ID（FitToCandidate の再フィット判定用）。無ければ null。 */
  candidateId: number | null
  /** 主 likely イベントのメンバー観測点の最大インデックス（likely 中の音レベル追跡に使う）。無ければ0。 */
  candidateMaxIndex: number
  /**
   * confirmed 各イベント（＝地域）の代表点と最大インデックス。地域単位の発報（新地域の検知・
   * 既存地域の再上昇で鳴らす）に使う。震源ではなくメンバー重心＋メンバー最大震度。
   */
  confirmedShocks: ConfirmedShock[]
}

/** `KyoshinView.confirmedShocks` の 1 件。 */
export interface ConfirmedShock {
  /** メンバー重心（地域単位の発報の照合に使う位置）。 */
  lat: number
  lng: number
  /** メンバー観測点の最大計測震度インデックス。 */
  index: number
  /**
   * `index` を記録した観測点そのものの座標。**カメラを寄せる先はこちら**（揺れフォーカス。
   * `map-rendering-spec.md` §6）。
   *
   * 重心と分けているのが要点。広域に広がったイベントでは重心が最も強く揺れている点から
   * 大きく離れる（2024-01-01 16:08 能登の再生で実測: 石川〜千葉に広がったイベントの重心は
   * 新潟県境付近で、震度4を記録した能登の観測点から約 140km 離れていた）。照合には重心が要る
   * （距離の閾値がそれを前提に調整されている）ため、寄り先だけを別に持つ。
   *
   * メンバーの座標が 1 つも引けないとき（観測点リストの入れ替え中に `sites` が空へゲートされる）は
   * 重心と同じ値を入れる。**イベント自体は落とさない**（理由は `deriveKyoshinView` の該当箇所）。
   */
  peak: { lat: number; lng: number }
}

/**
 * 座標キー → 観測点（座標＋現在インデックス）の索引を作る。memberKeys 解決に使う。
 * キーは kyoshinDetector 側と同じ computeSiteKeys で構築する（座標衝突時の別実体化を検知エンジンと
 * 一致させる。同じ sites 配列を同じ順序で渡す前提のため、ずれると memberKeys の解決が食い違う）。
 *
 * @param stale 欠測ホールドで直前値を保持している点のフラグ（`indices` と同順・省略可）。
 */
export function buildSiteIndex(
  sites: SiteCoords,
  indices: number[],
  stale?: readonly boolean[],
): Map<string, DetectedPoint> {
  const byKey = new Map<string, DetectedPoint>()
  const keys = computeSiteKeys(sites as [number, number][])
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    if (!s) continue
    const idx = indices[i]
    if (idx === undefined) continue
    byKey.set(keys[i], { key: keys[i], lat: s[0], lng: s[1], index: idx, stale: stale?.[i] === true })
  }
  return byKey
}

/**
 * 揺れが去った後に confirmed イベントへ残る「孤立した震度0の検知点」を落とす
 * （検知点マーカー・検知カードが共有する表示の前段フィルタ）。
 *
 * `targetKeys` に含まれる点のうち、次の 3 条件をすべて満たすものだけを落とす:
 *  1. 現在の震度が 0（震度1以上・震度0未満/欠測は対象外）
 *  2. ISOLATED_ZERO_RADIUS_KM 以内に震度1以上の検知点が無い
 *  3. 直近に立ち上がっていない（`recentOnsetKeys` に含まれない）
 *
 * 【なぜ必要か】イベントのメンバー（`memberKeys`）は、値が下がりきってから `MEMBER_DROP_MS` を
 * 過ぎるまで残る（`kyoshinDetector` の `pruneFadedMembers`）。表面波が抜けた後も値が震度0付近を
 * うろつく点は下がりきらないためメンバーに残り続け、大地震のあと各地に震度0のバッジが点々と居座る。
 *
 * 【なぜ条件3が要るか】空間条件だけで落とすと、揺れが広がっていく最初の数分で「まだ震度0だが直後に
 * 震度1以上へ育つ点」＝到達先端まで消える。直近の立ち上がりを除外すればそれを避けられる。
 *
 * 【なぜ対象を confirmed に限るか】残骸を溜めるのは長寿命の confirmed イベントで、実測では孤立した
 * 震度0点の 96.6% がそれ。likely / faint は `HOLD_MS` / `LIKELY_HOLD_MS` の範囲で短命なうえ、faint は
 * 定義上メンバー全員が震度0であるため、対象に含めるとイベントが生きている間に点だけが消えて
 * 「微弱な揺れの兆候」カードと地図が食い違う。計測の詳細は設計書 §22。
 *
 * @param points 判定に使う全点（confirmed ＋ unconfirmed をまとめて渡すこと。条件2の「近くに震度1以上が
 *   あるか」は対象外の点も材料にする——confirmed の震度0点の隣にある likely の震度1点を見落とさないため）
 * @param targetKeys 間引きの対象にする観測点キー（confirmed イベントのメンバー）
 * @param recentOnsetKeys 直近に立ち上がった観測点キー（`step()` の `recentOnsetKeys`）
 */
export function dropIsolatedZeroPoints(
  points: DetectedPoint[],
  targetKeys: ReadonlySet<string>,
  recentOnsetKeys: ReadonlySet<string>,
): DetectedPoint[] {
  const isZero = (p: DetectedPoint): boolean => kyoshinIndexToJma(p.index)?.label === '0'
  const strong = points.filter((p) => {
    const jma = kyoshinIndexToJma(p.index)
    return jma != null && jma.label !== '0'
  })
  // 緯度差での足切りを先に行い、haversine の呼び出しを間引く（震度0点×震度1以上点の総当たりは
  // 大地震で数万回/秒に達する）。経度差は緯度に依存するため、ここでは緯度だけで粗く落とす。
  const degLat = ISOLATED_ZERO_RADIUS_KM / 111.194
  return points.filter((p) => {
    if (!targetKeys.has(p.key)) return true
    if (!isZero(p)) return true
    if (recentOnsetKeys.has(p.key)) return true
    return strong.some(
      (s) =>
        Math.abs(s.lat - p.lat) <= degLat &&
        haversineKm(p.lat, p.lng, s.lat, s.lng) <= ISOLATED_ZERO_RADIUS_KM,
    )
  })
}

/** メンバー観測点キー列を DetectedPoint 列へ解決する（索引に無いキーは捨てる）。 */
export function resolveMembers(keys: string[], byKey: Map<string, DetectedPoint>): DetectedPoint[] {
  const pts: DetectedPoint[] = []
  for (const k of keys) {
    const p = byKey.get(k)
    if (p) pts.push(p)
  }
  return pts
}

/** `evt-N` 形式の ID から連番 N を取り出す（FitToCandidate の安定キー）。 */
function eventIdNum(id: string): number | null {
  const m = /(\d+)/.exec(id)
  return m ? Number(m[1]) : null
}

/**
 * 検知イベント列から表示状態を導出する。
 *
 * - detectedPoints: confirmed 全イベントのメンバー観測点の和集合（フットプリント全体にフィット）。
 * - detectedMarkerPoints: 上記から孤立した震度0点を落としたもの（検知点マーカーに描く分）。
 * - candidatePoints: 主 likely イベント（最大震度が最大）1件のメンバー観測点（主候補フィットに対応）。
 *   複数 likely の和集合にすると境界が飛び跳ねるため、常に1件へ絞る。
 * - unconfirmedPoints: likely / faint 全イベントのメンバー観測点の和集合（検知点マーカー用）。
 *   カードの集計対象と揃えるため絞り込まない。フィットに使うと境界が飛び跳ねるため用途を分ける。
 * - 震央には**フィットしない**（メンバー観測点にフィットする）。不確実な震央へ
 *   地図が飛ぶ事故を構造的に避けるため。
 *
 * **孤立した震度0点の間引き（`dropIsolatedZeroPoints`）を通すのは `detectedMarkerPoints` だけ。**
 * `stale`（欠測ホールドで直前値を保持している点のフラグ）を渡すと、各 `DetectedPoint` に引き継がれる。
 * 描画側はそれを見て半透明で描く（`utils/kyoshinMissingHold.ts`）。
 *
 * カメラフィットに使う `detectedPoints` / `candidatePoints`、および確信度・音の駆動に使う値
 * （confirmed / candidate / candidateMaxIndex / confirmedShocks）はフィルタの影響を受けない——表示を
 * 整えるためのフィルタが「検知したかどうか」を書き換えると、地図から点が消えるのに合わせてカメラが
 * 引いたり音が鳴らなくなったりする結合が生まれるため。
 */
export function deriveKyoshinView(
  detections: DetectionEvent[],
  sites: SiteCoords,
  indices: number[],
  recentOnsetKeys: ReadonlySet<string>,
  stale?: readonly boolean[],
): KyoshinView {
  const byKey = buildSiteIndex(sites, indices, stale)

  const confirmedEvents = detections.filter((d) => d.confidence === 'confirmed')
  const likelyEvents = detections.filter((d) => d.confidence === 'likely')

  const detectedKeys = new Set<string>()
  for (const e of confirmedEvents) for (const k of e.memberKeys) detectedKeys.add(k)

  // confirmed 以外（likely / faint）の全イベント。weak は検知カードでも除外されるため含めない。
  // confirmed にも属する観測点はここから除き、detectedPoints との差集合にする（同じ観測点が
  // confirmed と likely の両方のメンバーになりうる）。除去を観測点キーで行うのが要点で、
  // 描画側で座標を見て弾くと、同一座標に複数の実体がある観測点（buildSiteIndex 参照）を
  // 取り違えて落としてしまう。
  const unconfirmedKeys = new Set<string>()
  for (const e of detections) {
    if (e.confidence === 'confirmed' || e.confidence === 'weak') continue
    for (const k of e.memberKeys) if (!detectedKeys.has(k)) unconfirmedKeys.add(k)
  }

  const primaryLikely = likelyEvents.reduce<DetectionEvent | null>(
    (best, e) => (!best || e.maxIntensity > best.maxIntensity ? e : best),
    null,
  )

  // 主 likely イベントのメンバー最大インデックス（likely 中の音レベル追跡の基準値作りに使う）
  let candidateMaxIndex = 0
  if (primaryLikely) {
    for (const k of primaryLikely.memberKeys) {
      const p = byKey.get(k)
      if (p && p.index > candidateMaxIndex) candidateMaxIndex = p.index
    }
  }

  // confirmed 各イベント（地域）の代表点＋メンバー最大インデックス（地域単位発報の入力）と、
  // その最大を記録した観測点の座標（揺れフォーカスの寄り先）。
  const confirmedShocks = confirmedEvents.flatMap<ConfirmedShock>((e) => {
    if (!e.epicenter) return []
    // 同じ最大値が並んだときは先に現れた観測点を採る（`memberKeys` の並び順＝検知エンジンが
    // メンバーを束ねた順。どちらも「最も強く揺れている点」なので優劣を付ける根拠が無い）。
    let peak: DetectedPoint | null = null
    for (const k of e.memberKeys) {
      const p = byKey.get(k)
      if (!p) continue
      if (peak === null || p.index > peak.index) peak = p
    }
    // メンバーが 1 つも索引に無いときは重心へ落とす（観測点リストの入れ替え中に `sites` が空へ
    // ゲートされると起きる）。**イベントごと落としてはならない**——地域単位の発報
    // （`stepAlertRegions`）は `confirmedShocks` が空になったことを「確定が消えた」と読み、
    // 発報済み・EEW 吸収済みの記録を捨てる。捨てると入れ替えの直後に同じ地域が鳴り直す。
    // 欠測（負のインデックス）は 0 に丸める（従来の `maxIdx` の初期値 0 と同じ扱い）。
    const [centroidLat, centroidLng] = e.epicenter
    return [{
      lat: centroidLat,
      lng: centroidLng,
      index: Math.max(0, peak?.index ?? 0),
      peak: peak ? { lat: peak.lat, lng: peak.lng } : { lat: centroidLat, lng: centroidLng },
    }]
  })

  // 間引きの対象は confirmed のメンバーだが、「近くに震度1以上があるか」の判定材料には unconfirmed も
  // 含めて渡す（confirmed の震度0点の隣にある likely の震度1点を見落とさないため）。
  const visibleKeys = new Set(
    dropIsolatedZeroPoints(
      resolveMembers([...detectedKeys, ...unconfirmedKeys], byKey),
      detectedKeys,
      recentOnsetKeys,
    ).map((p) => p.key),
  )

  return {
    confirmed: confirmedEvents.length > 0,
    candidate: likelyEvents.length > 0,
    detectedPoints: resolveMembers([...detectedKeys], byKey),
    detectedMarkerPoints: resolveMembers(
      [...detectedKeys].filter((k) => visibleKeys.has(k)),
      byKey,
    ),
    candidatePoints: primaryLikely ? resolveMembers(primaryLikely.memberKeys, byKey) : [],
    unconfirmedPoints: resolveMembers([...unconfirmedKeys], byKey),
    candidateId: primaryLikely ? eventIdNum(primaryLikely.id) : null,
    candidateMaxIndex,
    confirmedShocks,
  }
}
