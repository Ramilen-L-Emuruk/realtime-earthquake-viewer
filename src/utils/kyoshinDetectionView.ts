// V2 検知エンジン（kyoshinDetector）の出力（DetectionEvent[]）を、UI・音・地図フィットが
// 消費する「表示状態」へ変換する純粋ユーティリティ。
// エンジンは震源・確信度・メンバー観測点キーを持つが、地図フィット/検知点マーカーは
// 座標＋現在インデックスの点列（DetectedPoint）を要求するため、ここで memberKeys を解決する。

import { computeSiteKeys, type DetectionEvent } from './kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'

/** 地図フィット・検知点マーカー・ヒストグラムが扱う観測点（座標＋現在インデックス）。 */
export interface DetectedPoint {
  lat: number
  lng: number
  index: number
}

/** 検知の表示状態（音・自動タブ切替・自動フィットの駆動元）。 */
export interface KyoshinView {
  /** confirmed イベントが1件以上あるか（＝V1 の detected 相当） */
  confirmed: boolean
  /** likely イベントが1件以上あるか（＝V1 の候補クラスタ相当・早期反応の駆動元） */
  candidate: boolean
  /** confirmed 全イベントのメンバー観測点（自動フィット・検知点マーカー用） */
  detectedPoints: DetectedPoint[]
  /** 主 likely イベント（score 最大）のメンバー観測点（候補フィット用） */
  candidatePoints: DetectedPoint[]
  /**
   * confirmed 以外（likely / faint）の全イベントのメンバー観測点（検知点マーカー用）。
   * リアルタイムタブの検知カードが集計する集合（weak 以外の全イベント）と一致させるため、
   * detectedPoints とこの 2 本で全体を覆う。**カメラフィットには使わない**
   * （候補フィットは主 likely 1 件の candidatePoints を使う。理由は deriveKyoshinView 参照）。
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
  confirmedShocks: { lat: number; lng: number; index: number }[]
}

/**
 * 座標キー → 観測点（座標＋現在インデックス）の索引を作る。memberKeys 解決に使う。
 * キーは kyoshinDetector 側と同じ computeSiteKeys で構築する（座標衝突時の別実体化を検知エンジンと
 * 一致させる。同じ sites 配列を同じ順序で渡す前提のため、ずれると memberKeys の解決が食い違う）。
 */
export function buildSiteIndex(sites: SiteCoords, indices: number[]): Map<string, DetectedPoint> {
  const byKey = new Map<string, DetectedPoint>()
  const keys = computeSiteKeys(sites as [number, number][])
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    if (!s) continue
    const idx = indices[i]
    if (idx === undefined) continue
    byKey.set(keys[i], { lat: s[0], lng: s[1], index: idx })
  }
  return byKey
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
 * - candidatePoints: 主 likely イベント（最大震度が最大）1件のメンバー観測点（主候補フィットに対応）。
 *   複数 likely の和集合にすると境界が飛び跳ねるため、常に1件へ絞る。
 * - unconfirmedPoints: likely / faint 全イベントのメンバー観測点の和集合（検知点マーカー用）。
 *   カードの集計対象と揃えるため絞り込まない。フィットに使うと境界が飛び跳ねるため用途を分ける。
 * - 震央には**フィットしない**（メンバー観測点にフィットする）。不確実な震央へ
 *   地図が飛ぶ事故を構造的に避けるため。
 */
export function deriveKyoshinView(
  detections: DetectionEvent[],
  sites: SiteCoords,
  indices: number[],
): KyoshinView {
  const byKey = buildSiteIndex(sites, indices)

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

  // confirmed 各イベント（地域）の代表点＋メンバー最大インデックス（地域単位発報の入力）
  const confirmedShocks = confirmedEvents.flatMap((e) => {
    if (!e.epicenter) return []
    let maxIdx = 0
    for (const k of e.memberKeys) {
      const p = byKey.get(k)
      if (p && p.index > maxIdx) maxIdx = p.index
    }
    return [{ lat: e.epicenter[0], lng: e.epicenter[1], index: maxIdx }]
  })

  return {
    confirmed: confirmedEvents.length > 0,
    candidate: likelyEvents.length > 0,
    detectedPoints: resolveMembers([...detectedKeys], byKey),
    candidatePoints: primaryLikely ? resolveMembers(primaryLikely.memberKeys, byKey) : [],
    unconfirmedPoints: resolveMembers([...unconfirmedKeys], byKey),
    candidateId: primaryLikely ? eventIdNum(primaryLikely.id) : null,
    candidateMaxIndex,
    confirmedShocks,
  }
}
