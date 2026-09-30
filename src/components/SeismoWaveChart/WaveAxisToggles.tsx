// 波形の向き（南北・東西・上下）の凡例。**押すとその向きを消せる。**
//
// **地図の下端の絵と地震カードの波形で同じものを使う。** 見た目も押したときの効きも
// 揃えるため ——別々に書くと、片方だけ押せる形が生まれる。
//
// **状態はここが持たない**（→ `hooks/useSeismoWaveAxes`）。2 つの絵は親子関係を
// 持たないので、props で配ると App から 2 経路のバケツリレーになる。
//
// **`<button>` ではなく `<span role="button">` で作る。** 地震カードは全体が
// `<button>`（選択のトグル）で、ボタンの入れ子は HTML が許さない ——カード内の
// 他の押せるもの（未入電・長周期のトグル）と同じ作法に揃えてある。
// **`stopPropagation` も同じ理由** ——押した拍子にカードが選択されてしまう。

import { toggleWaveAxis, useWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { AXIS_COLORS, AXIS_LABELS } from './paintWave'

export function WaveAxisToggles() {
  const axes = useWaveAxes()
  return (
    <>
      {AXIS_LABELS.map((label, i) => {
        const visible = axes[i] !== false
        return (
          <span
            key={label}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              toggleWaveAxis(i)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.stopPropagation()
              e.preventDefault()
              toggleWaveAxis(i)
            }}
            aria-pressed={visible}
            // **消えている向きも残す。** 畳んで消すと、消したこと自体を忘れて
            // 「上下動が出ない」と悩むことになる。薄く残せば押して戻せる。
            className={`cursor-pointer leading-none select-none transition-opacity${
              visible ? '' : ' opacity-30 line-through'
            }`}
            style={{ color: AXIS_COLORS[i] }}
          >
            {label}
          </span>
        )
      })}
    </>
  )
}
