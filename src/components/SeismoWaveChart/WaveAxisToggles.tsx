// 波形の向き（南北・東西・上下）の凡例。**押すとその向きを消せる。**
// 地震カードでは、その隣に強調（ノイズを潰す）の切り替えも置く。
//
// **地図の下端の絵と地震カードの波形で同じものを使う。** 見た目も押したときの効きも
// 揃えるため ——別々に書くと、片方だけ押せる形が生まれる。
//
// **状態はここが持たない**（→ `hooks/useSeismoWaveAxes`・`hooks/useSeismoWaveEmphasis`）。
// 2 つの絵は親子関係を持たないので、props で配ると App から 2 経路のバケツリレーになる。
//
// **`<button>` ではなく `<span role="button">` で作る。** 地震カードは全体が
// `<button>`（選択のトグル）で、ボタンの入れ子は HTML が許さない ——カード内の
// 他の押せるもの（未入電・長周期のトグル）と同じ作法に揃えてある。
// **`stopPropagation` も同じ理由** ——押した拍子にカードが選択されてしまう。

import type { ReactNode } from 'react'

import { toggleWaveAxis, useWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { toggleWaveEmphasis, useWaveEmphasis } from '../../hooks/useSeismoWaveEmphasis'
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

/**
 * 強調（平常時のノイズを潰して描く）の切り替え。**地震カードと詳細の窓だけに置く** ——
 * 地図の下端の絵には潰す物差し（発生前の区間）が無い。
 */
export function WaveEmphasisToggle() {
  const emphasized = useWaveEmphasis()
  return (
    <ToggleChip on={emphasized} color="rgba(255,255,255,0.85)" onToggle={toggleWaveEmphasis}>
      強調
    </ToggleChip>
  )
}

function ToggleChip({
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
