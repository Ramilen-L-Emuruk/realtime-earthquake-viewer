import { memo } from 'react'

// 期間を 1 本のスライダーで選ぶ（つまみが 2 つ）。
//
// **HTML に二つまみの入力は無い。** `<input type="range">` を 2 本重ね、溝と選択範囲の帯は
// 別の要素が描く。本物の range のままにしてあるので、キーボード操作（矢印・Home/End）と
// 読み上げは標準の挙動がそのまま残る。つまみだけがクリックを受ける仕掛けは
// `src/index.css` の `.range-thumb-only`。

interface Props {
  min: number
  max: number
  from: number
  to: number
  /** 両端は常に `from <= to` で渡る（押し合いはこの中で解決する）。 */
  onChange: (from: number, to: number) => void
  /** 読み上げ用の名前。「開始」「終了」に付ける前置き。 */
  label: string
  disabled?: boolean
}

/** 値を 0〜100% の位置へ。**幅が 0 の範囲でも落ちないこと**（収録が 1 年だけの場合）。 */
export function percentOf(value: number, min: number, max: number): number {
  const span = max - min
  if (!(span > 0)) return 0
  const t = (value - min) / span
  return (t > 0 ? (t < 1 ? t : 1) : 0) * 100
}

export const YearRangeSlider = memo(function YearRangeSlider({
  min,
  max,
  from,
  to,
  onChange,
  label,
  disabled = false,
}: Props) {
  const left = percentOf(from, min, max)
  const right = percentOf(to, min, max)
  // **つまみが重なったときは開始を上に置く。** 下になった側は掴めない。開始が上なら、
  // 左へ引けば期間が広がり、右へ引けば終了を押して期間ごと動く（どちらも行き止まりにならない）。
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
        aria-label={`${label}の開始`}
        min={min}
        max={max}
        step={1}
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
        aria-label={`${label}の終了`}
        min={min}
        max={max}
        step={1}
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
