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
   * 地震情報と長周期地震動情報。すでに起きた地震の事後情報。
   *
   * **長周期を地震情報と同格にしている**のは読み上げ側と揃えるため（`SPEECH_PRIORITY.normal`）。
   * 長周期は地震情報より新しい情報なので、待たせるのではなく割り込ませる。どちらも移動先は
   * 地震情報タブなので、同格にしてもタブの奪い合いは起きない。
   */
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
 * 逆に、読み上げを持たない経路（手動選択・アイドル復帰・読み上げ無効時の受信）が絡む
 * 組み合わせでは従来の優先度比較を残す。これらは順序を決める仕組みを他に持たないため。
 * 例外は揺れ検知の保持で、こちらは読み上げの有無に関わらず他の移動を妨げない（下記）。
 */
export function shouldAcceptAutoTab(
  hold: TabHold,
  priority: TabPriority,
  now: number,
  source: TabHoldSource = 'hold',
): boolean {
  if (hold.until - now <= 0) return true
  // **揺れ検知の保持は、他の情報の移動を妨げない。** 揺れ検知は「いま揺れている」を realtime で
  // 見せるための移動だが、そこに地震情報が届いたなら地震情報を見せてよい（実際に起きた順序どおり
  // なので、画面が留まる方が不自然）。読み上げの有無に関わらず同じ扱いにする。
  // 揺れ検知の続き（レベルアップ・別地点）は自分で要求を出し直すため、必要なら realtime へ戻る。
  if (hold.priority === TAB_PRIORITY.kyoshin) return true
  // **EEW の続報は、他の情報が確保している画面を奪わない。** 従来からある片方向の抑制で、
  // 「非 realtime タブへ移ったあとは EEW の続報で realtime へ引き戻さない」もの。
  // 抑制が無いと、津波や地震情報を読み上げて画面を移した直後に続報が来て realtime に戻り、
  // 数秒ごとに画面が往復する（読み上げは続いているのに画面だけが行き来する）。
  // 同じ系列で realtime を確保している間（保持が EEW 由来）は素通りさせる。
  // 新規発報・レベルアップ・誤報取消は `eewUrgent` で要求されるため、この抑制に掛からない。
  if (priority === TAB_PRIORITY.eewUpdate
    && hold.priority !== TAB_PRIORITY.eewUpdate
    && hold.priority !== TAB_PRIORITY.eewUrgent) {
    return false
  }
  // 追従どうしは順序が保証されているので保持を見ない。
  //
  // **ここを「手動選択以外は全部突破する」まで広げてはいけない。** 広げると、区域を持たない
  // 津波電文で受信時要求に落としたフォールバック（`tsunami`）を地震情報・長周期（`quake`）が即座に奪い、
  // アイドル復帰が EEW 中に張った保持（`eewUpdate`）も地震情報だけで外れる。
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
 *
 * **床を読む要求と、床（`TabFollowMark`）を進める要求は同じ集合に保つこと。** 進める側だけを
 * 広く取ると、床を読まない要求（通知音と同時の先出し・EEW の受信時要求）が床を押し上げ、
 * 後から実際に声が出る側の追従を弾く。呼び出し側の条件は `App.tsx` の `requestAutoTab` にある。
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
