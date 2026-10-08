// 波形の向き（東西・南北・上下）の凡例。**押すとその向きを消せる。**
//
// **置くのは地図の下端の絵だけ。** 地震カードには置かない（見出しの行が二段に折れる。向きを
// 消して見るのは詳細の窓でする。2026-10-05 のユーザー判断）。詳細の窓は `ToggleChip` だけを借りる。
//
// **状態はここが持たない**（→ `hooks/useSeismoWaveAxes`）。
//
// **`<button>` ではなく `<span role="button">` で作る。** 地震カードは全体が
// `<button>`（選択のトグル）で、ボタンの入れ子は HTML が許さない ——カード内の
// 他の押せるもの（未入電・長周期のトグル）と同じ作法に揃えてある。
// **`stopPropagation` も同じ理由** ——押した拍子にカードが選択されてしまう。

import type { ReactNode } from 'react'

import { toggleWaveAxis, useWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { AXIS_COLORS, AXIS_LABELS } from './paintWave'

export function WaveAxisToggles() {
  const axes = useWaveAxes()
  return (
    <>
      {AXIS_LABELS.map((label, i) => (
        <ToggleChip key={label} on={axes[i] !== false} color={AXIS_COLORS[i]} onToggle={() => toggleWaveAxis(i)}>
          {label}
        </ToggleChip>
      ))}
    </>
  )
}

export function ToggleChip({
  on,
  color,
  onToggle,
  children,
}: {
  on: boolean
  color: string
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.stopPropagation()
        e.preventDefault()
        onToggle()
      }}
      aria-pressed={on}
      // **切っているものも残す。** 畳んで消すと、消したこと自体を忘れて
      // 「上下動が出ない」と悩むことになる。薄く残せば押して戻せる。
      className={`cursor-pointer leading-none select-none transition-opacity${on ? '' : ' opacity-30 line-through'}`}
      style={{ color }}
    >
      {children}
    </span>
  )
}
