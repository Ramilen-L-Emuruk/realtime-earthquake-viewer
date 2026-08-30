// 検知エンジン（kyoshinDetector）が確信度を決めたときの判定材料を、画面に出す言葉へ変える
// 純粋ユーティリティ。エンジンの `DetectionGates` / `ConfirmSnapshot` を読むだけで、判定には
// 一切関与しない。
//
// **数字を作らない。** 「確信度 82%」のような値はここでも作らないこと。エンジンは確率モデル
// ではなく決定的なゲートの通過判定で段（confirmed / likely / faint / weak）を決めており、
// 中間の連続量を持っていない。出せるのは「どの条件をいくつ満たしたか」「あと何が足りないか」
// だけで、それを割合へ均すと実装が持っていない精度を装うことになる。

import type { DetectionEvent } from './kyoshinDetector'
import { kyoshinIndexToLabel, kyoshinValueToIndex } from './kyoshinIntensity'

/** 計測震度 → 震度階級ラベル。階級を持たない値（震度0未満）は `—`。 */
function scaleLabel(value: number): string {
  return kyoshinIndexToLabel(kyoshinValueToIndex(value)) ?? '—'
}

/** 根拠の表の 1 行。 */
export interface GateRow {
  /** 行の見出し */
  label: string
  /** いまの値 */
  value: string
  /** 満たすべき値。要求を持たない行は null */
  req: string | null
  /** 満たしているか。要求を持たない行は null */
  met: boolean | null
}

/**
 * 確信度の一行説明。カードのヘッダー直下に出す。
 *
 * - 確定したもの: **確定した瞬間の**内訳で「なぜ確定したか」を言う（`confirmedBy`）。
 *   現フレームの内訳で言ってはいけない——確定後は震度が減衰して点数も減り、
 *   `everConfirmed` のラッチだけが確信度を支える局面が普通に来る
 * - まだのもの: 確定まで何が足りないかを言う
 *
 * 言うことが無ければ null（呼び出し側は行ごと出さない）。
 */
export function gateShortfall(e: DetectionEvent): string | null {
  const g = e.gates

  if (e.confidence === 'confirmed') {
    const c = e.confirmedBy
    if (!c) return null
    return c.gates.fastPath
      ? `震度${scaleLabel(c.gates.highIntensityReq)}以上が${c.gates.highIntenseCount}点で確定`
      : `${c.size}点・震度${scaleLabel(c.intensity)}で確定`
  }

  // 単点のまま居座って降ろされたもの（設計書§33）。確信度は weak になり、検知カードは weak を
  // 除いた配列を渡してくるので、**いまのアプリにこの分岐へ届く経路は無い**。
  // weak を含む配列を渡す消費者（診断ログの閲覧画面など）を作ったときに黙って空欄にならないよう
  // 置いてある
  if (g.soloStale) return '広がりが続かなかったため取り下げ'

  // 連続フレーム数が進んでいる＝確定の条件を今まさに満たしている。残りフレーム数だけを言う。
  //
  // **確信度より先に見ること。** 確定の条件（`meetsConfirm`）は周囲の裏付け（`everNeighborRise`）を
  // 見ないが、`likely` へ上げる条件は見る。そのため「確定へ向けて秒読みに入っているのに確信度は
  // faint」という状態が普通に起こる（震源最近傍の単点が先行する高震度 fast path の典型）。
  // faint の分岐を先に置くと、この状態で「周囲の裏付け待ち」——`likely` への条件であって
  // 確定への条件ではないもの——を残り条件として示してしまう。
  if (e.confirmStreak > 0) {
    const rest = g.streakReq - e.confirmStreak
    // 「フレーム」は検知エンジンの内部単位（1 秒ごとに 1 回）。利用者にはそのまま出さない。
    // 「約」を付けているのは、観測値が届かなかった秒は判定が進まないため
    return rest > 0 ? `確定まで あと約${rest}秒` : '確定条件を満たしています'
  }

  if (e.confidence === 'faint') {
    // faint には 2 種類ある。震度が届いていないものと、震度は出ているが周囲の裏付けが
    // 取れていないもの（設計書§32）。足りないものが違うので言い分ける
    if (e.maxIntensity < g.likelyIntensityReq) {
      return `震度${scaleLabel(g.likelyIntensityReq)}に届いていません`
    }
    if (!e.everNeighborRise) return '周囲の観測点の裏付け待ち'
  }

  const missing: string[] = []
  // 高震度 fast path が成立している間は点数条件が免除されるので、不足として挙げない
  if (!g.fastPath && e.lastSize < g.sizeReq) missing.push(`あと${g.sizeReq - e.lastSize}点`)
  if (g.intenseCount < g.intenseReq) {
    missing.push(`震度${scaleLabel(g.intensityReq)}以上が あと${g.intenseReq - g.intenseCount}点`)
  }
  return missing.length > 0 ? `確定まで ${missing.join('・')}` : null
}

/**
 * 根拠の表。折りたたみを開いたときに出す。
 *
 * 並びは判定の順序（点数 → 震度 → 第3ゲート → 連続フレーム → 高震度の抜け道 → likely の条件）。
 *
 * **見出しに検知エンジンの内部用語を出さない。** 「フレーム」「spread」「近傍一致」といった語は
 * 仕様書にしか定義が無く、この表を初めて開く利用者には手がかりが無い。
 * 値はすべて**現フレーム**のもので、`gateShortfall` が確定済みイベントに対して使う
 * `confirmedBy`（確定した瞬間の凍結）とは別物。
 */
export function gateRows(e: DetectionEvent): GateRow[] {
  const g = e.gates
  const intensityName = scaleLabel(g.intensityReq)
  const highName = scaleLabel(g.highIntensityReq)
  return [
    {
      // カードの「N観測点で反応」とは数える対象が違う。あちらは現在震度0以上の点、こちらは
      // 「床を明確に超えて継続中 or 直近に立ち上がった」点（エンジンの lastSize）
      label: '揺れ継続中の点',
      value: `${e.lastSize}`,
      req: `${g.sizeReq}`,
      met: e.lastSize >= g.sizeReq,
    },
    {
      label: '最大震度',
      value: `震度${scaleLabel(e.maxIntensity)}`,
      req: `震度${intensityName}`,
      met: e.maxIntensity >= g.intensityReq,
    },
    {
      label: `震度${intensityName}以上の点`,
      value: `${g.intenseCount}`,
      req: `${g.intenseReq}`,
      met: g.intenseCount >= g.intenseReq,
    },
    {
      label: '連続して満たした回数',
      value: `${e.confirmStreak}`,
      req: `${g.streakReq}`,
      met: e.confirmStreak >= g.streakReq,
    },
    {
      label: `震度${highName}以上の点`,
      value: `${g.highIntenseCount}`,
      req: `${g.highIntenseReq}`,
      met: g.highIntenseCount >= g.highIntenseReq,
    },
    { label: '揺れの範囲が続いている', value: g.spreadHeld ? 'はい' : 'いいえ', req: null, met: null },
    { label: '周囲の観測点も反応', value: e.everNeighborRise ? 'はい' : 'いいえ', req: null, met: null },
  ]
}

/**
 * 要求値が既定から動いている理由と、判定に効いた抜け道。表の下に並べる。
 *
 * 空配列なら「既定の条件で判定した」という意味になるので、呼び出し側は何も出さなくてよい。
 */
export function gateNotes(e: DetectionEvent): string[] {
  const g = e.gates
  const notes: string[] = []
  if (g.eewActive) notes.push('緊急地震速報の発表中のため、確定の条件を緩めています')
  if (g.chronic) notes.push('平常時から反応の多い地域のため、確定の条件を引き上げています')
  if (g.sparse) notes.push('観測点が疎な地域のため、確定に要る点数を引き下げています')
  if (g.fastPath) {
    notes.push(`震度${scaleLabel(g.highIntensityReq)}以上の点が揃ったため、点数の条件を免除しています`)
  }
  if (g.soloStale) notes.push('周囲へ広がらないまま続いたため、確定を取り下げました')
  return notes
}
