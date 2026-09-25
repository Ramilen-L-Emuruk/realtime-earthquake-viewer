import { useEffect, useRef, useState } from 'react'
import { recordReplayEvent } from '../utils/replayEventLog'

/**
 * 読み上げているあいだだけ開く折りたたみ。**開閉の状態を呼び出し側が持つ版。**
 *
 * 気象庁が書いた文を読み上げ始めたら開き、読み終わったら閉じる（→ docs/spec/audio-tts-spec.md
 * §6「読み上げに合わせて気象庁の文を開く」）。
 *
 * - **自分が開いた分しか閉じない** —— 利用者が手で開いていたものを読み終わりで閉じると、
 *   見ようとしていた中身を奪うことになる
 * - **利用者が手で閉じたら、その読み上げのあいだは開き直さない** —— 閉じたのに開き直る形に
 *   すると、操作を受け付けないように見える
 *
 * **状態を外に出せる形にしてあるのは、開閉の持ち方が置き場所で違うため。** 特別情報バナーと
 * 津波の面は真偽値 1 つで足りるが、地震カードの「気象庁からの補足」は他の行の開閉と同じ
 * 入れ物（開いている鍵の集合）に乗っている。**判定を書き写すと必ずずれる**ので、規約は
 * この 1 本に閉じ込めて状態の持ち主だけ差し替える。
 *
 * @param speaking この表示に対応する文をいま読み上げているか
 * @param isOpen いま開いているか
 * @param setOpen 開閉を書き換える
 * @param subject 録画ツール向けの記録に載せる主題（→ `docs/spec/recording-interface-spec.md`）。
 *   このフックは 6 箇所（地震カードの補足・南海トラフ臨時情報・後発地震注意情報・関連解説情報・
 *   地震回数・津波のコメント欄）から同じ `overlay: 'telegramText'` で呼ばれるため、これが
 *   無いと記録からどの表示が開いたか区別できない。**必須引数にしてある** —— 既定値を
 *   持たせると、呼び出し元を増やしたときに渡し忘れても型検査を通ってしまう。
 * @returns 利用者の操作から呼ぶ設定関数
 */
export function useAutoOpenWhileSpeakingIn(
  speaking: boolean,
  isOpen: boolean,
  setOpen: (open: boolean) => void,
  subject: string,
): (open: boolean) => void {
  // 最新の値をエフェクトから読むための箱。**依存配列へは入れない** —— 入れると手で閉じた
  // 直後に開き直す（`speaking` の変わり目でだけ判断する）。
  const latest = useRef({ isOpen, setOpen, subject })
  latest.current = { isOpen, setOpen, subject }
  /** この読み上げで自分が開いたか。手で開かれたものと混ぜないための印。 */
  const openedBySpeech = useRef(false)
  /** この読み上げのあいだ、利用者が手で閉じたか。 */
  const dismissed = useRef(false)

  useEffect(() => {
    if (speaking) {
      if (dismissed.current) return
      // 既に開いていた（利用者が手で開いた）なら、こちらの持ち物にしない
      if (latest.current.isOpen) return
      openedBySpeech.current = true
      latest.current.setOpen(true)
      // 録画ツール向けの記録（→ `docs/spec/recording-interface-spec.md`）。**自分が開いた分だけ**
      // —— 手で開いていたものは上で降りているので、ここへは来ない。
      // **`subject` を必ず添える** —— このフックは 6 箇所から同じ `overlay` 種別で呼ばれる。
      recordReplayEvent({
        type: 'overlay', overlay: 'telegramText', open: true, reason: '気象庁の文の読み上げ',
        subject: latest.current.subject,
      })
      return
    }
    // 読み上げが終わった。**自分が開いた分だけ戻す。**
    dismissed.current = false
    if (!openedBySpeech.current) return
    openedBySpeech.current = false
    // **記録は実際に閉じたときだけ。** 開けてから読み終えるまでの間に別の経路が閉じている
    // ことがあり（津波は等級が動いた報が先に閉じる）、覚えだけで記録すると画面が動いて
    // いない回が並ぶ。持ち物から外すのは、閉じられていても行う。
    const wasOpen = latest.current.isOpen
    latest.current.setOpen(false)
    if (wasOpen) {
      recordReplayEvent({
        type: 'overlay', overlay: 'telegramText', open: false, reason: '読み終えた',
        subject: latest.current.subject,
      })
    }
  }, [speaking])

  return (next: boolean) => {
    // 読み上げ中に手で閉じたら、その読み上げのあいだは開き直さない
    if (!next && speaking) dismissed.current = true
    // 手で開いたものは、読み終わりで閉じない（こちらの持ち物から外す）
    if (next) openedBySpeech.current = false
    setOpen(next)
  }
}

/**
 * 読み上げているあいだだけ開く折りたたみ。**状態をこのフックが持つ版**（→ 上の注記）。
 *
 * @param speaking この表示に対応する文をいま読み上げているか
 * @param subject 録画ツール向けの記録に載せる主題（→ `useAutoOpenWhileSpeakingIn`）
 * @returns `[open, setOpen]`。`setOpen` は利用者の操作から呼ぶ
 */
export function useAutoOpenWhileSpeaking(speaking: boolean, subject: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false)
  const setOpenByUser = useAutoOpenWhileSpeakingIn(speaking, open, setOpen, subject)
  return [open, setOpenByUser]
}
