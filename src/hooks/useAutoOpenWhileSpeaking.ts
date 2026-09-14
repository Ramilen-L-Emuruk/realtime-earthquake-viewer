import { useEffect, useRef, useState } from 'react'

/**
 * 読み上げているあいだだけ開く折りたたみの状態。
 *
 * 気象庁が書いた文を読み上げ始めたら開き、読み終わったら閉じる（→ docs/spec/audio-tts-spec.md
 * §6「読み上げに合わせて気象庁の文を開く」）。**自分が開いた分しか閉じない** —— 利用者が手で
 * 開いていたものを読み終わりで閉じると、見ようとしていた中身を奪うことになる。
 *
 * **利用者が手で閉じたら、その読み上げのあいだは開き直さない。** 閉じたのに毎フレーム開き直る
 * 形にすると、操作を受け付けないように見える。
 *
 * @param speaking この表示に対応する文をいま読み上げているか
 * @returns `[open, setOpen]`。`setOpen` は利用者の操作から呼ぶ
 */
export function useAutoOpenWhileSpeaking(speaking: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false)
  /** この読み上げで自分が開いたか。手で開かれたものと混ぜないための印。 */
  const openedBySpeech = useRef(false)
  /** この読み上げのあいだ、利用者が手で閉じたか。 */
  const dismissed = useRef(false)

  useEffect(() => {
    if (speaking) {
      if (dismissed.current) return
      setOpen(prev => {
        // 既に開いていた（利用者が手で開いた）なら、こちらの持ち物にしない
        if (prev) return prev
        openedBySpeech.current = true
        return true
      })
      return
    }
    // 読み上げが終わった。**自分が開いた分だけ戻す。**
    dismissed.current = false
    if (!openedBySpeech.current) return
    openedBySpeech.current = false
    setOpen(false)
  }, [speaking])

  const setOpenByUser = (next: boolean) => {
    // 読み上げ中に手で閉じたら、その読み上げのあいだは開き直さない
    if (!next && speaking) dismissed.current = true
    // 手で開いたものは、読み終わりで閉じない（こちらの持ち物から外す）
    if (next) openedBySpeech.current = false
    setOpen(next)
  }

  return [open, setOpenByUser]
}
