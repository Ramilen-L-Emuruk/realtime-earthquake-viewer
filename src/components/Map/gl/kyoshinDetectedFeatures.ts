import type { FeatureCollection, Point } from 'geojson'
import type { DetectedPoint } from '../../../utils/kyoshinDetectionView'
import { kyoshinIndexToJma, type KyoshinJma } from '../../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../../utils/intensity'
import { kyoshinDetectedIconId, KYOSHIN_DETECTED_ICON_BASE_RADIUS } from './kyoshinDetectedIcons'

// 揺れ検知点マーカー（KyoshinDetectedPointsGL）の GeoJSON を組み立てる純粋関数。
// 描画そのものはコンポーネント側、「どの点をどのバッジで描くか」の判断はこちらに置く。

// 確信度別の半径ボーナス（通常震度点の半径 getScaleRadius(scale) に加算）。
// confirmed は unconfirmed（likely/faint）よりさらに大きく＋太めの白フチ
// （kyoshinDetectedIcons.ts）で、一目で「確定」と分かるようにする。
const CONFIRMED_RADIUS_BONUS = 6
const UNCONFIRMED_RADIUS_BONUS = 2

// 検知点1点の描画半径（Leaflet 版と同一ロジックを confidence 別ボーナスへ一般化）。
// 震度0は固定小半径、震度1以上は計測震度連動。
// 固定式 (bonus + 3) / 2 は bonus=2（likelyの旧confirmed相当）で旧固定値 2.5 と一致する。
function detectedRadius(jma: KyoshinJma, iconScale: number, bonus: number): number {
  return jma.label !== '0' ? (getScaleRadius(jma.scale) + bonus) * iconScale : ((bonus + 3) / 2) * iconScale
}

/**
 * 点列 → バッジ feature 列。**震度0未満・欠測（`kyoshinIndexToJma` が null）の点は描かない。**
 *
 * イベントのメンバー観測点は一度入るとイベント解除まで残る（kyoshinDetector の memberKeys は
 * 和集合で単調増加し、揺れが収まっても縮まない。現在揺れている数は lastSize が別に持つ）。
 * これらを震度0のバッジで描くと、揺れが収まるほど「もう揺れていない点」で地図が埋まり、
 * 震度0以上だけを数えるリアルタイムタブの検知カードの震度別点数と桁違いにずれる
 * （2026-08-18 の実測: カードが震度0を24点と出している時点で地図には361個のバッジがあり、
 * うち337個が震度0未満・欠測だった）。
 */
function buildFeatures(points: DetectedPoint[], iconScale: number, confirmed: boolean) {
  // アイコン ID 側は confirmed 以外を歴史的に `candidate` と呼ぶ（likely だけを想定していた頃の語。
  // kyoshinDetectedIcons.ts）。ここでの unconfirmed（likely ＋ faint）と同じものを指す。
  const bonus = confirmed ? CONFIRMED_RADIUS_BONUS : UNCONFIRMED_RADIUS_BONUS
  return points.flatMap((p) => {
    const jma = kyoshinIndexToJma(p.index)
    if (!jma) return []
    const radius = detectedRadius(jma, iconScale, bonus)
    return [{
      type: 'Feature' as const,
      properties: {
        index: p.index,
        iconId: kyoshinDetectedIconId(jma.rank, confirmed),
        iconSizeRatio: radius / KYOSHIN_DETECTED_ICON_BASE_RADIUS,
        // 欠測ホールドで直前値を描いている点。レイヤー側が icon-opacity を落として
        // 「そこに点はあるが今は値が無い」と示す（utils/kyoshinMissingHold.ts）。
        stale: p.stale === true,
      },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    }]
  })
}

/**
 * 検知点マーカーの GeoJSON を作る。
 *
 * 2 つの点列は**重複しない前提**（`deriveKyoshinView` が観測点キーの差集合として渡す）。
 * ここで座標を見て重複を弾くことはしない——同一座標に複数の実体がある観測点が実在するため
 * （`buildSiteIndex` 参照）、座標で弾くと別の観測点を取り違えて落としてしまう。
 *
 * @param confirmedPoints confirmed のメンバーのうち実際に描く分（`deriveKyoshinView` の
 *   `detectedMarkerPoints`。孤立した震度0点は事前に除かれている）
 * @param unconfirmedPoints likely / faint 全イベントのメンバー観測点（confirmed に属する点は除かれている）
 * @param iconScale 地図アイコン倍率
 */
export function buildDetectedFC(
  confirmedPoints: DetectedPoint[],
  unconfirmedPoints: DetectedPoint[],
  iconScale: number,
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: [
      ...buildFeatures(confirmedPoints, iconScale, true),
      ...buildFeatures(unconfirmedPoints, iconScale, false),
    ],
  }
}
