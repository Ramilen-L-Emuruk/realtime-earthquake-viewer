import type { JMAQuake } from '../types/earthquake'

// 地震情報の優先度（高いほど優先）。live/履歴/P2P の全経路で共有する単一の情報源。
// 注: incoming が VXSE61 のときは優先度比較に載らない（VXSE61 は常に「震源だけ更新・震度は保持」の
// 専用分岐 A を通るため）。ただし existing 側が VXSE61（＝既にマージ済みで震度を保持している完成カード）
// の場合は、分岐 B の据え置き判定でこの 5 が「低優先度の後続電文から完成カードを守るガード」として
// 実際に使われる。P2P 経路の重複排除でも参照するため、この値は削除しないこと。
export const QUAKE_ISSUE_PRIORITY: Record<string, number> = {
  '顕著な地震の震源要素更新のお知らせ': 5,
  '各地の震度情報': 4,
  '震源・震度情報': 3,
  '震源情報': 2,
  '震度速報': 1,
  '遠地地震': 0,
  'その他': 0,
}

const AMENDMENT_TYPE = '顕著な地震の震源要素更新のお知らせ'

// 電文 ID 文字列から eventId（14桁タイムスタンプ）を抽出する。
// VXSE51/52/53/61 はすべて同じ eventId を共有するため、同一地震の同定に使用できる。
// 電文 ID の書式: `dmdata-quake-YYYYMMDDhhmmss-<serial>` または `dmdata-xml-quake-…`（archive リプレイ経路）。
export function extractQuakeEventIdFromId(id: string | undefined | null): string | null {
  return id?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1] ?? null
}

// 地震カード (JMAQuake) の id フィールドから eventId を抽出するラッパ。
export function extractQuakeEventId(q: JMAQuake): string | null {
  return extractQuakeEventIdFromId(q.id)
}

// 2つの地震カードが同一イベントかどうか。
// DMDATA は VXSE51（targetDateTime）→ VXSE52/53（originTime）で earthquake.time が
// 約1分ずれるため、eventId があればそれを優先し、無ければ earthquake.time で比較する。
export function sameQuakeEntry(a: JMAQuake, b: JMAQuake): boolean {
  const ea = extractQuakeEventId(a)
  const eb = extractQuakeEventId(b)
  if (ea && eb) return ea === eb
  return a.earthquake.time === b.earthquake.time
}

// カードが実際の震度データ（最大震度 or 各地の震度）を持つか。
// VXSE61 単独カードや震度欠落の速報段階では false になる。
export function hasIntensity(q: JMAQuake): boolean {
  return q.earthquake.maxScale >= 0 || q.points.length > 0
}

// 表示順（earthquake.time 降順＝新しい地震が先頭）。
export function sortQuakes(arr: JMAQuake[]): JMAQuake[] {
  return [...arr].sort((a, b) =>
    new Date(b.earthquake.time).getTime() - new Date(a.earthquake.time).getTime()
  )
}

// 同一イベントの2電文を統合する唯一の真実。リアルタイム(WS)経路の逐次統合の意味を保存する。
// 取消電文（cancelled=true）は呼び出し側（live の取消専用分岐・履歴の mergeQuakeHistory）で
// 先に捌かれる前提のため、ここでは通常電文として扱わない。
//
// - incoming が VXSE61（顕著地震の震源要素更新）: 既存カードの震度（maxScale/points）を保持したまま、
//   震源・M・種別・発表時刻・（判明していれば）国内津波を更新する。既存が無ければ震度なし単独カードを返す。
// - incoming が通常電文: 既存が「実震度を持つ・未取消・より高優先度」なら据え置き（戻り値 === existing）。
//   そうでなければ incoming で置換する。置換時、
//     * incoming が震度を持たない（震源のみの後続電文）なら既存の震度を補完し、
//     * 既存がより新しい VXSE61 なら、その更新後の震源・種別を保持したまま incoming の震度を採る。
//
// 戻り値が existing と同一参照なら「変化なし」を意味する（呼び出し側は状態を更新しない）。
export function mergeQuakeInto(existing: JMAQuake | undefined, incoming: JMAQuake): JMAQuake {
  // --- A. incoming が VXSE61（顕著地震の震源要素更新） ---
  if (incoming.issue.type === AMENDMENT_TYPE) {
    if (!existing) return incoming
    return {
      ...existing,
      time: incoming.time,
      issue: incoming.issue,
      earthquake: {
        ...existing.earthquake,
        hypocenter: incoming.earthquake.hypocenter,
        domesticTsunami: incoming.earthquake.domesticTsunami !== '不明'
          ? incoming.earthquake.domesticTsunami
          : existing.earthquake.domesticTsunami,
      },
    }
  }

  // --- B. incoming が通常電文 ---
  if (!existing) return incoming

  // 据え置き判定: 既存が実震度を持ち・未取消・より高優先度なら更新しない。
  // hasIntensity を条件に含めることで、VXSE61 単独カードや震度欠落カードは
  // 実震度を持つ電文で必ず上書きできる（'顕著…':5 が震度電文を弾く罠を封じる）。
  if (
    !existing.cancelledAt
    && hasIntensity(existing)
    && (QUAKE_ISSUE_PRIORITY[existing.issue.type] ?? 0) > (QUAKE_ISSUE_PRIORITY[incoming.issue.type] ?? 0)
  ) {
    return existing
  }

  let result = incoming

  // 震度欠落の後続電文（震源のみ等）は既存の震度で補完する。
  if (!hasIntensity(incoming) && hasIntensity(existing)) {
    result = {
      ...result,
      earthquake: { ...result.earthquake, maxScale: existing.earthquake.maxScale },
      points: existing.points,
    }
  }

  // 既存がより新しい VXSE61 の場合、その更新後の震源・種別・発表時刻を保持しつつ
  // incoming（震度電文）の震度を採用する。
  if (existing.issue.type === AMENDMENT_TYPE && existing.time >= incoming.time) {
    result = {
      ...result,
      time: existing.time,
      issue: existing.issue,
      earthquake: { ...result.earthquake, hypocenter: existing.earthquake.hypocenter },
    }
  }

  return result
}

// 電文群を eventId（無ければ earthquake.time）ごとに時刻順で畳み込み、リアルタイムと
// 同一の統合結果を得る。base は統合済みの既存カード群（「もっと見る」でのバッチ跨ぎ用）。
export function mergeQuakeHistory(newQuakes: JMAQuake[], base: JMAQuake[] = []): JMAQuake[] {
  const byKey = new Map<string, JMAQuake>()
  const keyOf = (q: JMAQuake): string => extractQuakeEventId(q) ?? q.earthquake.time

  for (const q of base) {
    byKey.set(keyOf(q), q)
  }

  // 電文の発表時刻昇順で適用する（＝到着順の再現）。
  const ordered = [...newQuakes].sort((a, b) =>
    new Date(a.time).getTime() - new Date(b.time).getTime()
  )
  for (const q of ordered) {
    const key = keyOf(q)
    // 取消電文（infoType=取消）: 履歴では取消された地震のカードを表示しない。
    // ライブ経路（useEarthquakes の取消専用分岐）は取消を10秒表示してから purge するが、
    // 過去情報である履歴ではその最終状態（非表示）に一致させる。
    if (q.cancelled) {
      byKey.delete(key)
      continue
    }
    byKey.set(key, mergeQuakeInto(byKey.get(key), q))
  }

  return sortQuakes(Array.from(byKey.values()))
}
