import { useState } from 'react'

// 日付を 1 つ選ぶ入力欄。震源カタログの期間で使う。
//
// **打鍵の途中の値を握っておくためにローカルの下書きを持つ。** `<input type="date">` は
// 年・月・日をセグメントごとに打つ間、日付として不完全な瞬間があり、そのとき `value` は
// **空文字**になる。読めないからと親の状態を更新せずにいると、React は制御された `value`
// （＝変わっていない元の日付）を DOM へ書き戻し、**打ちかけのセグメントが元へ戻る**。
// 以降の打鍵は別のセグメントへ流れ、利用者からは「キーボードで入力できない」ように見える。

interface Props {
  /** 読み上げ用の名前。 */
  label: string
  /** 親が持っている値（`YYYY-MM-DD`）。 */
  value: string
  /**
   * 選べる範囲（`YYYY-MM-DD`）。
   *
   * **`min` / `max` 属性はカレンダーの操作しか縛らない。** 打鍵では範囲外の日も確定するので、
   * 収めるのは受け取った側の仕事。
   */
  min: string
  max: string
  disabled?: boolean
  /**
   * 値が決まったときに呼ぶ。**範囲に収まる完全な日付になった瞬間だけ**。
   *
   * 打鍵のたびに呼ばないのは、年を打っている間に `0002-…` `0020-…` `0202-…` と通り過ぎる
   * だけの値が来るため——そのつど渡すと、その期間ぶんの重い作り直し（点群の組み立てと
   * 年ファイルの取得）が走る。
   */
  onCommit: (value: string) => void
  className?: string
}

export function DateField({ label, value, min, max, disabled = false, onCommit, className }: Props) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <input
      type="date"
      aria-label={label}
      // **下書きがある間はそちらを出す。** ここを親の値だけにすると打鍵が巻き戻る（冒頭）。
      value={draft ?? value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value
        setDraft(next)
        if (next !== '' && next >= min && next <= max) onCommit(next)
      }}
      // **打ちかけのまま離れたら、確定させずに捨てる。**「打ち切った範囲外の日」と
      // 「打ちかけの途中」は見分けが付かないので、確定させると年を 3 桁まで打って離れただけで
      // 期間が収録の端へ飛ぶ。入らなかったことは値が元へ戻ることで伝わる。
      onBlur={() => setDraft(null)}
      className={className}
    />
  )
}
