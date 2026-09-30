// 自作地震計の波形グラフを、いま画面に出すかどうか。
//
// **「受け取るか」と「絵を出すか」は別の判断。** 購読の切り替え（`wave`）は SSE を
// 繋ぎ直すので、揺れを検知してから上げたのでは間に合わない —— 繋ぎ直しに数百 ms〜
// 数秒かかり、しかも**その時点から 0 秒ぶん**しか波形が無い。いちばん見たい初動が
// 絵に入らないことになる。60 秒のリングバッファ（`seismoWaveBuffer.ts`）を持つ意味も
// 揺れる前から溜めておいてこそなので、**`'auto'` でも購読は張りっぱなしにして、
// 絵の出し入れだけをここで決める**（購読の判断は `App.tsx` 側）。

import { useEffect, useRef, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { NearbyScope } from '../utils/actionChecklistTrigger'
import type { DetectedPoint } from '../utils/kyoshinDetectionView'
import {
  seismoWaveTriggered,
  type SeismoIntensityLike,
  type SeismoWaveMode,
} from '../utils/seismoWaveTrigger'

/**
 * 揺れの条件が消えてから絵を引っ込めるまで（ms）。
 *
 * **即座に消さない。** 揺れが収まった瞬間に絵まで消えると、いちばん見たい波形
 * （立ち上がりから収束まで）を見られないまま終わる。抱えている長さ（60 秒。
 * `useSeismoStation` の `WAVE_RETAIN_SEC`）に合わせてあるので、余韻の間は
 * 揺れの全体が絵に入っている。
 */
const LINGER_MS = 60_000

/**
 * いま波形グラフを画面に出すか。
 *
 * **再生（テスト時刻設定）中は呼び出し側が `'off'` へ倒す。** 自作地震計は再生中に
 * 繋がない（`App.tsx`）ので、判定の材料になる震度がそもそも届かない。
 */
export function useSeismoWaveVisibility(params: {
  mode: SeismoWaveMode
  scope: NearbyScope
  eews: readonly EEWAlert[]
  detectedPoints: readonly DetectedPoint[]
  stations: readonly SeismoIntensityLike[]
}): boolean {
  const { mode, scope, eews, detectedPoints, stations } = params

  // 判定そのものは純関数なので毎レンダー呼んでよい（走査するのは検知メンバーと
  // 発報中の EEW だけ）。
  const triggered =
    mode === 'auto' && seismoWaveTriggered({ scope, eews, detectedPoints, stations })

  const [visible, setVisible] = useState(false)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // **数えるのは「条件が外れた瞬間から」。** この効果が走るのは `triggered` が
  // 切り替わったときだけなので、`false` の枝へ来た時点が「揺れが収まった時点」に
  // なる。成立していた時刻を ref に控えて残りを引く形にすると、**揺れが 60 秒を
  // 超えて続いたときに起点が更新されない** —— `triggered` が `true` のまま変わら
  // なければ効果が走り直さないため、収まった瞬間には既に残りが尽きていて絵が
  // 即座に消える（「揺れ始めてから 60 秒」に化ける）。
  useEffect(() => {
    // **`'auto'` を離れたら即座に落とす。** 残したままだと、`'always'` から
    // 戻したときに揺れていない絵が余韻ぶん居座る。
    if (mode !== 'auto') {
      setVisible(false)
      return
    }
    if (triggered) {
      setVisible(true)
      return
    }
    // **出ていないなら何もしない。** ここで無条件にタイマーを張ると、揺れが
    // 一度も起きていない端末で空振りの待ちが生まれる。
    if (!visibleRef.current) return
    const timer = setTimeout(() => setVisible(false), LINGER_MS)
    return () => clearTimeout(timer)
  }, [mode, triggered])

  if (mode === 'off') return false
  if (mode === 'always') return true
  return visible
}
