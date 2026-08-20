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
  /**
   * 長周期地震動情報。地震のあとに出る事後情報で、地震情報よりさらに軽い。
   * 読み上げ側は当初から分けていた（`SPEECH_PRIORITY.low`）が、タブ側は地震情報と同格で
   * 優劣が付かなかった。
   */
  lpgm: 1,
  /** 地震情報。すでに起きた地震の事後情報 */
  quake: 2,
  /** 強震モニタの揺れ検知。「いま揺れている」を示すので地震情報より重い */
  kyoshin: 3,
  /** 津波。避難行動を促すため揺れ検知より重い */
  tsunami: 4,
  /** EEW の続報 */
  eewUpdate: 5,
  /** ユーザーの手動選択 */
  manual: 6,
  /** EEW の新規発報・レベルアップ・誤報取消 */
  eewUrgent: 7,
} as const

export type TabPriority = typeof TAB_PRIORITY[keyof typeof TAB_PRIORITY]

/**
 * 自動タブ切替の保持時間。この間、これより低い優先度の自動切替を拒否する。
 * EEW は続報のたびに張り直されるため、系列が続いている間は自然に守られる。
 */
export const TAB_HOLD_MS = 15000

/**
 * 自動タブ切替の駆動源。
 *
 * - `speech`: 読み上げの発話に同調した追従。順序は読み上げ側（`waitForSpeechSlot` /
 *   `chainEEWSpeech`）が既に決めているため、タブ側で重ねて順序を守る必要がない
 * - `hold`: 電文の受信そのもの・ユーザー操作・アイドル復帰・揺れ検知など、読み上げを持たない経路
 */
export type TabHoldSource = 'speech' | 'hold'

/** 自動タブ切替の保持状態。「いつまで」「どの優先度で」「どちらの駆動で」確保しているか。 */
export interface TabHold {
  until: number
  priority: TabPriority
  source: TabHoldSource
}

/**
 * 自動タブ切替を受け付けてよいかを判定する。
 *
 * 保持が切れていれば通す。保持中でも**同格以上なら通す**（新しい情報が勝つ。読み上げと同じ規則で、
 * 震度速報の更新が古い震度速報を置き換えるのと同じ考え方）。低い優先度だけを拒否する。
 *
 * ただし**読み上げ追従どうしは保持を見ない**。順序は読み上げ側が既に決めているため、ここで
 * 二重に守ると「読み終わった電文の保持の残り」が次に読む電文を弾く。実測では、読み終えた EEW の
 * 保持（優先度 6・残り 12.8 秒）に大津波警報（3）と震度速報（1）が弾かれ、声だけが喋って
 * 画面が動かない状態になっていた（2026-08-20）。
 *
 * 逆に、読み上げを持たない経路（揺れ検知・手動選択・アイドル復帰・読み上げ無効時の受信）が
 * 絡む組み合わせでは従来の優先度比較を残す。これらは順序を決める仕組みを他に持たないため。
 */
export function shouldAcceptAutoTab(
  hold: TabHold,
  priority: TabPriority,
  now: number,
  source: TabHoldSource = 'hold',
): boolean {
  if (hold.until - now <= 0) return true
  if (source === 'speech' && hold.source === 'speech') return true
  return priority >= hold.priority
}

/**
 * 読み上げ追従が続けて発火するときの最小滞留時間。
 *
 * VOICEVOX が起動していない端末では、合成が 1 チャンクも通らないまま発話がほぼ即座に終わる。
 * すると読み上げの行列が一瞬で捌け、**声は一切出ないのにタブだけが激しく入れ替わる**。
 * 床を置いて間引く。
 */
export const TAB_FOLLOW_MIN_DWELL_MS = 1500

/** 直前の読み上げ追従の記録（いつ・どの優先度で動いたか）。 */
export interface TabFollowMark {
  at: number
  priority: TabPriority
}

/**
 * 読み上げ追従を今すぐ発火してよいかを判定する。
 *
 * 直前の追従より**重い情報は待たせない**（EEW が津波の読み上げに割り込んだ場合など、
 * 声が切り替わっているのに画面が遅れるのを防ぐ）。同格以下の連続だけを床で間引く。
 */
export function shouldFollowNow(
  last: TabFollowMark | null,
  priority: TabPriority,
  now: number,
): boolean {
  if (last === null) return true
  if (priority > last.priority) return true
  return now - last.at >= TAB_FOLLOW_MIN_DWELL_MS
}

/**
 * アイドル復帰で realtime に留めるときの優先度を決める。
 *
 * EEW 発報中は続報が続く系列の途中なので `eewUpdate` で確保してよいが、**揺れ検知だけのときに
 * 同じ重みを使ってはいけない**。優先度表（揺れ検知 2 ＜ 津波 3）が逆転し、津波警報や
 * 「別地点で揺れ検知」が画面を取れなくなる。実測では揺れ検知が続く間、30 秒周期で 15 秒の
 * ブロック窓が開き続けていた（2026-08-20・2024/1/1 能登前震のリプレイで確認）。
 */
export function idleRevertPriority(hasActiveEew: boolean): TabPriority {
  return hasActiveEew ? TAB_PRIORITY.eewUpdate : TAB_PRIORITY.kyoshin
}
