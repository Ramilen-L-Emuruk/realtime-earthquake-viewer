/**
 * 自動タブ切替の優先度。**読み上げの優先順位（`docs/spec/audio-tts-spec.md` §6）と同じ並び**に
 * してある。声だけ優先度を持たせても画面を奪われると、EEW を読み上げている最中に別のタブが
 * 出て、肝心の予想震度・予報円が見えない。
 *
 * `manual` を EEW の続報より上、`eewUrgent` を manual より上に置いているのは既存の挙動を保つため。
 * ユーザーが自分で選んだタブを EEW の続報に奪わせないが、**新規発報・レベルアップ・誤報取消は
 * 手動選択より強い**（危険の通知は見せる側が優先する）。
 */
export const TAB_PRIORITY = {
  /** 地震情報・長周期地震動情報。すでに起きた地震の事後情報 */
  quake: 1,
  /** 強震モニタの揺れ検知。「いま揺れている」を示すので地震情報より重い */
  kyoshin: 2,
  /** 津波。避難行動を促すため揺れ検知より重い */
  tsunami: 3,
  /** EEW の続報 */
  eewUpdate: 4,
  /** ユーザーの手動選択 */
  manual: 5,
  /** EEW の新規発報・レベルアップ・誤報取消 */
  eewUrgent: 6,
} as const

export type TabPriority = typeof TAB_PRIORITY[keyof typeof TAB_PRIORITY]

/**
 * 自動タブ切替の保持時間。この間、これより低い優先度の自動切替を拒否する。
 * EEW は続報のたびに張り直されるため、系列が続いている間は自然に守られる。
 */
export const TAB_HOLD_MS = 15000

/** 自動タブ切替の保持状態。「いつまで」「どの優先度で」確保しているか。 */
export interface TabHold {
  until: number
  priority: TabPriority
}

/**
 * 自動タブ切替を受け付けてよいかを判定する。
 *
 * 保持が切れていれば通す。保持中でも**同格以上なら通す**（新しい情報が勝つ。読み上げと同じ規則で、
 * 震度速報の更新が古い震度速報を置き換えるのと同じ考え方）。低い優先度だけを拒否する。
 */
export function shouldAcceptAutoTab(hold: TabHold, priority: TabPriority, now: number): boolean {
  if (hold.until - now <= 0) return true
  return priority >= hold.priority
}
