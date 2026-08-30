import { memo } from 'react'

// 範囲を 1 本のスライダーで選ぶ（つまみが 2 つ）。震源カタログの期間・マグニチュード・深さで使う。
//
// **HTML に二つまみの入力は無い。** `<input type="range">` を 2 本重ね、溝と選択範囲の帯は
// 別の要素が描く。本物の range のままにしてあるので、キーボード操作（矢印・Home/End）と
// 読み上げは標準の挙動がそのまま残る。つまみだけがクリックを受ける仕掛けは
// `src/index.css` の `.range-thumb-only`。

interface Props {
  min: number
  max: number
  /** つまみの刻み。 */
  step: number
  from: number
  to: number
  /** 両端は常に `from <= to` で渡る（押し合いはこの中で解決する）。 */
  onChange: (from: number, to: number) => void
  /** 読み上げ用の名前。下の `ends` と組にして各つまみの名前にする。 */
  label: string
  /**
   * 読み上げでつまみを言い分ける対語（既定は「下端」「上端」）。
   *
   * **期間には「開始」「終了」を渡すこと。**「期間の下端」は日本語として不自然で、
   * 聞いたときに何を指すか掴みにくい。値の範囲（マグニチュード・深さ・緯度・経度）は
   * 既定のままでよい。
   */
  ends?: readonly [string, string]
  disabled?: boolean
}

/** 値を 0〜100% の位置へ。**幅が 0 の範囲でも落ちないこと**（収録が 1 年だけの場合）。 */
export function percentOf(value: number, min: number, max: number): number {
  const span = max - min
  if (!(span > 0)) return 0
  const t = (value - min) / span
  return (t > 0 ? (t < 1 ? t : 1) : 0) * 100
}

export const RangeSlider = memo(function RangeSlider({
  min,
  max,
  step,
  from,
  to,
  onChange,
  label,
  ends = ['下端', '上端'],
  disabled = false,
}: Props) {
  const left = percentOf(from, min, max)
  const right = percentOf(to, min, max)
  // **つまみが重なったときは下端を上に置く。** 下になった側は掴めない。下端が上なら、
  // 左へ引けば範囲が広がり、右へ引けば上端を押して範囲ごと動く（どちらも行き止まりにならない）。
  // 離れているときはつまみ同士が重ならないため、上下は関係しない。
  const fromOnTop = from >= to

  return (
    <div className="relative h-6 w-full select-none">
      {/* 溝 */}
      <div className="absolute top-1/2 left-0 right-0 h-1 -translate-y-1/2 rounded bg-border" />
      {/* 選んでいる範囲 */}
      <div
        className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-blue-500"
        style={{ left: `${left}%`, right: `${100 - right}%` }}
      />
      <input
        type="range"
        aria-label={`${label}の${ends[0]}`}
        min={min}
        max={max}
        step={step}
        value={from}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          onChange(v, Math.max(v, to))
        }}
        className="range-thumb-only absolute inset-0 w-full h-6"
        style={{ zIndex: fromOnTop ? 4 : 3 }}
      />
      <input
        type="range"
        aria-label={`${label}の${ends[1]}`}
        min={min}
        max={max}
        step={step}
        value={to}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          onChange(Math.min(v, from), v)
        }}
        className="range-thumb-only absolute inset-0 w-full h-6"
        style={{ zIndex: fromOnTop ? 3 : 4 }}
      />
    </div>
  )
})
