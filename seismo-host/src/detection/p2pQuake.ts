// P2PQuake の地震情報（code 551）を、照合用の地震（`ReferenceQuake`）へ読み替える。
//
// **読むのは震源と発生時刻だけ。** 照合（`quakeMatch.ts`）に要るのはそれだけで、震度の
// 一覧などは地震ビューアー本体（PWA）が持つ。ここで型を広げると、PWA の読み取り
// （`src/services/p2pquake.ts`）と二重に持つことになる。
//
// **値の形は公式の OpenAPI に合わせる**（`epsp-specifications/json-api-v2.yaml`）。
// 発生時刻は `YYYY/MM/DD HH:mm:ss`（日本時間）で、地震情報では秒が `00` の分単位で届く。
// 震源が決まっていない報（震度速報）は緯度・経度に `-200`、深さ・規模が分からなければ `-1` が入る。

import type { ReferenceQuake } from './quakeMatch'

const JST_OFFSET_MS = 9 * 3_600_000

/** 照合用の地震に、照らし合わせた結果を記録へ残すための値を足したもの。 */
export interface P2pReferenceQuake extends ReferenceQuake {
  /** 最大震度（P2PQuake の 10・20・…・70 の形）。分からなければ null。 */
  readonly maxScale: number | null
  /** 同じ地震の報をまとめる鍵（発生時刻と震央地名）。 */
  readonly key: string
}

/** `YYYY/MM/DD HH:mm:ss`（日本時間）→ unix ミリ秒。読めなければ null。 */
export function parseP2pTime(text: string): number | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (m === null) return null
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - JST_OFFSET_MS
  return Number.isFinite(ms) ? ms : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 地震情報 1 件を読む。照らしようのない報（震源未確定・時刻が読めない・地震情報でない）は null。
 */
export function parseP2pQuakeItem(raw: unknown): P2pReferenceQuake | null {
  if (!isRecord(raw)) return null
  if (raw.code !== undefined && raw.code !== 551) return null
  const q = raw.earthquake
  if (!isRecord(q) || typeof q.time !== 'string') return null
  const h = q.hypocenter
  if (!isRecord(h)) return null
  const originMs = parseP2pTime(q.time)
  const lat = num(h.latitude)
  const lon = num(h.longitude)
  if (originMs === null || lat === null || lon === null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const depth = num(h.depth)
  const magnitude = num(h.magnitude)
  const maxScale = num(q.maxScale)
  const name = typeof h.name === 'string' ? h.name : ''
  return {
    originMs,
    // 秒が 00 なら分単位で丸めた値とみなす（地震情報はこの形で届く）。
    originPrecisionMs: q.time.endsWith(':00') ? 60_000 : 1_000,
    lat,
    lon,
    depthKm: depth === null || depth < 0 ? null : depth,
    magnitude: magnitude === null || magnitude < 0 ? null : magnitude,
    name,
    maxScale: maxScale === null || maxScale < 0 ? null : maxScale,
    key: `${q.time}|${name}`,
  }
}

/**
 * 読めなかった地震情報が「震源未確定の報（震度速報）」か。照らしようがないだけで、
 * 壊れているわけではないので、読めなかった数には入れない。**履歴とライブの両方がこれで分ける**
 * （片方だけで分けると、同じ壊れ方の報が経路によって数えられたり数えられなかったりする）。
 */
export function isUnsettledP2pQuake(raw: unknown): boolean {
  const h = isRecord(raw) && isRecord(raw.earthquake) ? raw.earthquake.hypocenter : undefined
  return isRecord(h) && typeof h.latitude === 'number' && h.latitude < -90
}

/**
 * 地震情報の配列（`/v2/history`・`/v2/jma/quake` の応答）を読む。同じ地震の報（震源に関する
 * 情報・各地の震度に関する情報など）は 1 件にまとめ、後に読んだもので上書きする。
 *
 * 地震情報でない要素（code が 551 以外）は数えずに外す。地震情報なのに読めなかったものは
 * `unreadable` に数える —— 黙って捨てると、照合できなかった理由が「地震が無かった」と区別できない。
 */
export function parseP2pQuakeList(raw: unknown): { quakes: P2pReferenceQuake[]; unreadable: number } {
  if (!Array.isArray(raw)) return { quakes: [], unreadable: 0 }
  const byKey = new Map<string, P2pReferenceQuake>()
  let unreadable = 0
  for (const item of raw) {
    if (isRecord(item) && item.code !== undefined && item.code !== 551) continue
    const q = parseP2pQuakeItem(item)
    if (q === null) {
      if (!isUnsettledP2pQuake(item)) unreadable++
      continue
    }
    byKey.set(q.key, q)
  }
  return { quakes: [...byKey.values()].sort((a, b) => a.originMs - b.originMs), unreadable }
}
