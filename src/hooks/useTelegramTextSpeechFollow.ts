import { useEffect } from 'react'
import type { SpeechFollowSession } from '../utils/ttsFollow'

/**
 * 気象庁が書いた文を読み上げているあいだ、画面のその表示を開いておく。
 *
 * **セッションの有無だけを見る。** 津波カードの追従や未入電モードの自動開閉は「いまどの箇所を
 * 読んでいるか」まで追うが、こちらは開く対象が本文まるごと 1 つなので、始まりと終わりで足りる
 * （→ docs/spec/audio-tts-spec.md §6「読み上げに合わせて気象庁の文を開く」）。
 *
 * そのため rAF も要らない。**タイマーを張らないこと**は他の追従と同じで、
 * 非表示のタブで滞留したタイマーが後から発火して開いたまま残る事故を避けられる。
 *
 * 返すものは無い。開閉は呼び出し側（`App`）が持ち、ここは「いまどの電文の文を読んでいるか」を
 * 伝えるだけ。
 */
export interface TelegramTextSpeechFollowOptions {
  /** 読み上げの進行（`createSpeechFollowController` が publish するセッション）。 */
  session: SpeechFollowSession | null
  /**
   * いま読んでいる電文の主題（`telegramText:<kind>`）を伝える。読み終わったら `null`。
   *
   * **開いた側が「自分が開いた分」を覚えること。** ここは主題を流すだけで、利用者が手で開いた
   * ものと見分ける責任は持たない。
   */
  onSubjectChange: (subject: string | null) => void
}

export function useTelegramTextSpeechFollow({
  session, onSubjectChange,
}: TelegramTextSpeechFollowOptions): void {
  // **`session` そのものではなく主題で依存を張る。** セッションは予約のたびに作り直されるので、
  // 参照で張ると同じ電文を読んでいる最中に通知が繰り返される。
  const subject = session?.subject ?? null
  useEffect(() => {
    onSubjectChange(subject)
    // 読み上げが終わった・割り込まれた・リセットされたときは、この後始末が閉じる側を起こす。
    return () => { onSubjectChange(null) }
    // `onSubjectChange` は呼び出し側で `useCallback` に包む前提（包まないと毎レンダー走る）。
  }, [subject, onSubjectChange])
}
