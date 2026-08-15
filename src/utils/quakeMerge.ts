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

// 地震カードの安定キー。統合・選択・通知の同一性判定はすべてこの値で行う。
// 統合済みカードは mergeQuakeInto が付けた eventKey を持ち、続報で id が変わっても不変。
// 統合前の生電文にはまだ無いため、その場で新規キーを導出する。
export function quakeEventKey(q: JMAQuake): string {
  return q.eventKey ?? initialQuakeKey(q)
}

// 生電文からイベントキーを新規に作る。DMDATA は全報が共有する eventId をそのまま使う。
// P2PQuake は eventId を配信せず、レコード id も報ごとに変わるため、
// 「発生時刻＋その報の id」で一意化する。このキーが作られるのはイベントの初報だけで、
// 以降の続報は mergeQuakeInto が初報のキーを引き継ぐ（＝キーは事後的に安定する）。
function initialQuakeKey(q: JMAQuake): string {
  return extractQuakeEventId(q) ?? `p2p:${q.earthquake.time}#${q.id}`
}

// 同一イベントのまま震源名が変わりうる電文か。
// - 訂正報（infoType=訂正／P2PQuake の `correct`）: 震源そのものを訂正する
// - 顕著な地震の震源要素更新（VXSE61 / P2PQuake の DestinationAmended）: 震源要素を差し替える
//   電文で、`issue.correct` は「なし」のまま来る。mergeQuakeInto の分岐 A が hypocenter を
//   丸ごと置き換える設計と対になる条件なので、ここから外すと震源名が変わった更新報が
//   別カードに分裂する（P2PQuake 経路は eventId が無く震源名で判定するため）。
function allowsHypocenterChange(q: JMAQuake): boolean {
  return q.issue.correct !== 'なし' || q.issue.type === AMENDMENT_TYPE
}

// 震源名が「両方とも判明していて食い違う」なら別イベントとみなせる。
// 震度速報は震源が未確定で名前が空のため判定に使わない（震源を伴う続報と合流させる）。
//
// 副作用: 条件が対称なので、片方が震源名の変更を許す電文（訂正報・震源要素更新）であれば
// 常に「食い違いなし」になる。震源要素更新のカードが残っている間は、同じ分に起きた別の
// 地震の報まで吸収しうる（`docs/spec/quake-spec.md` §6.1 の限界の 3 つ目）。
function hasConflictingHypocenter(a: JMAQuake, b: JMAQuake): boolean {
  const na = a.earthquake.hypocenter.name
  const nb = b.earthquake.hypocenter.name
  if (!na || !nb || na === nb) return false
  return !allowsHypocenterChange(a) && !allowsHypocenterChange(b)
}

// 2つの地震カードが同一イベントかどうか。
// 判定の優先順は「安定キー → eventId → 発生時刻＋震源名」。
// DMDATA は VXSE51（targetDateTime）→ VXSE52/53（originTime）で earthquake.time が
// 約1分ずれるため eventId を優先する。P2PQuake は eventId が無いため発生時刻で比較するが、
// 同時刻は分単位でしか一致しない（P2PQuake の発生時刻は秒が常に 00）ので、
// 震源名まで見て「同じ分に起きた別の地震」を分離する。
//
// 第1分岐（双方が eventKey を持つ）は、実運用では incoming 側が統合前の生電文なので通らない。
// 統合済みカードどうしを比較する将来の呼び出し・テストのための分岐。
//
// 限界（`docs/spec/quake-spec.md` §6.1）: P2PQuake 経路では、同じ分に起きた別々の地震を
// 常には分離できない。震源名が同じ場合と、震源が未確定の震度速報が絡む場合がこれにあたる。
export function sameQuakeEntry(a: JMAQuake, b: JMAQuake): boolean {
  if (a.eventKey && b.eventKey) return a.eventKey === b.eventKey
  const ea = extractQuakeEventId(a)
  const eb = extractQuakeEventId(b)
  if (ea && eb) return ea === eb
  if (a.earthquake.time !== b.earthquake.time) return false
  return !hasConflictingHypocenter(a, b)
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
//
// 統合結果には必ず eventKey を持たせる。既存カードがあればそのキーを引き継ぐため、
// P2PQuake のように続報で id が変わる経路でも、カードのキーは初報のまま不変になる。
export function mergeQuakeInto(existing: JMAQuake | undefined, incoming: JMAQuake): JMAQuake {
  const eventKey = existing?.eventKey ?? quakeEventKey(incoming)

  // --- A. incoming が VXSE61（顕著地震の震源要素更新） ---
  if (incoming.issue.type === AMENDMENT_TYPE) {
    if (!existing) return { ...incoming, eventKey }
    return {
      ...existing,
      eventKey,
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
  if (!existing) return { ...incoming, eventKey }

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

  let result: JMAQuake = { ...incoming, eventKey }

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

// 電文群をイベントごとに時刻順で畳み込み、リアルタイムと同一の統合結果を得る。
// base は統合済みの既存カード群（「もっと見る」でのバッチ跨ぎ用）。
//
// 同一イベントの判定は sameQuakeEntry に一本化している（Map のキー方式では、震源名を見る
// 判定や「震度速報は震源名が空」の扱いを表現できないため）。件数は履歴数十〜数百件なので
// 線形探索で足りる。
export function mergeQuakeHistory(newQuakes: JMAQuake[], base: JMAQuake[] = []): JMAQuake[] {
  const merged: JMAQuake[] = [...base]

  // 電文の発表時刻昇順で適用する（＝到着順の再現）。
  const ordered = [...newQuakes].sort((a, b) =>
    new Date(a.time).getTime() - new Date(b.time).getTime()
  )
  for (const q of ordered) {
    const index = merged.findIndex(e => sameQuakeEntry(e, q))
    // 取消電文（infoType=取消）: 履歴では取消された地震のカードを表示しない。
    // ライブ経路（useEarthquakes の取消専用分岐）は取消を10秒表示してから purge するが、
    // 過去情報である履歴ではその最終状態（非表示）に一致させる。
    if (q.cancelled) {
      if (index >= 0) merged.splice(index, 1)
      continue
    }
    if (index >= 0) merged[index] = mergeQuakeInto(merged[index], q)
    else merged.push(mergeQuakeInto(undefined, q))
  }

  return sortQuakes(merged)
}
