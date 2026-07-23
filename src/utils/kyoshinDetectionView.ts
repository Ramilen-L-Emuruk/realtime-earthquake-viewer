// V2 検知エンジン（kyoshinDetector）の出力（DetectionEvent[]）を、UI・音・地図フィットが
// 消費する「表示状態」へ変換する純粋ユーティリティ。
// エンジンは震源・確信度・メンバー観測点キーを持つが、地図フィット/検知点マーカーは
// 座標＋現在インデックスの点列（DetectedPoint）を要求するため、ここで memberKeys を解決する。

import { siteKey, type DetectionEvent } from './kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'

/** 地図フィット・検知点マーカー・ヒストグラムが扱う観測点（座標＋現在インデックス）。 */
export interface DetectedPoint {
  lat: number
  lng: number
  index: number
}

/**
 * 全観測点表示・サマリ用の最低インデックス（震度-1相当: 計測震度 -0.5 以上 = index 5）。
 * ヒストグラム集計と実効最大インデックスの下限に使う。
 */
export const MIN_DETECTION_INDEX = 5

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
  /** 主 likely イベントの安定 ID（FitToCandidate の再フィット判定用）。無ければ null。 */
  candidateId: number | null
}

/** 座標キー → 観測点（座標＋現在インデックス）の索引を作る。memberKeys 解決に使う。 */
export function buildSiteIndex(sites: SiteCoords, indices: number[]): Map<string, DetectedPoint> {
  const byKey = new Map<string, DetectedPoint>()
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    if (!s) continue
    const idx = indices[i]
    if (idx === undefined) continue
    byKey.set(siteKey(s[0], s[1]), { lat: s[0], lng: s[1], index: idx })
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
 * V2 検知イベント列から表示状態を導出する。
 *
 * - detectedPoints: confirmed 全イベントのメンバー観測点の和集合（フットプリント全体にフィット）。
 * - candidatePoints: 主 likely イベント（score 最大）1件のメンバー観測点（V1 の主候補フィットに対応）。
 *   複数 likely の和集合にすると境界が飛び跳ねるため、常に1件へ絞る。
 * - 震央には**フィットしない**（メンバー観測点にフィットする）。片側配置・深発の不確実な震央へ
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

  const primaryLikely = likelyEvents.reduce<DetectionEvent | null>(
    (best, e) => (!best || e.score > best.score ? e : best),
    null,
  )

  return {
    confirmed: confirmedEvents.length > 0,
    candidate: likelyEvents.length > 0,
    detectedPoints: resolveMembers([...detectedKeys], byKey),
    candidatePoints: primaryLikely ? resolveMembers(primaryLikely.memberKeys, byKey) : [],
    candidateId: primaryLikely ? eventIdNum(primaryLikely.id) : null,
  }
}
