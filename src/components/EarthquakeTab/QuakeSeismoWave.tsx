// 地震カードへ、その区間の自作地震計の合成波形を描く。
//
// **描くだけ。** 読み返しも継ぎ足しも `hooks/useSeismoQuakeWaves` の担当 ——
// 描画側に置くと**カードを開いている間・タブが見えている間しか繋がらない**
// （2026-09-30 のユーザー指摘で作り直した）。
//
// **地図の下端の絵（`SeismoWaveChart`）と描き方を共有する。** 見えているものは同じ
// なので、描画は `paintWave.ts` の 1 つだけ。
//
// **記録が無いときは呼ばれない。** 「揺れを捉えていない」「記録が無い」を画面へ
// 出さないと決めてあるので（2026-09-29 のユーザー判断）、載せるものが無ければ
// 親が丸ごと描かない。

import { useEffect, useRef, useState } from 'react'

import type { SeismoQuakeWave } from '../../hooks/useSeismoQuakeWaves'
import { trimTrailingGap } from '../../utils/seismoWaveColumns'
import { foldHistoryColumns } from '../SeismoWaveChart/historyColumns'
import { AXIS_COLORS, AXIS_LABELS, paintWaveColumns } from '../SeismoWaveChart/paintWave'

/**
 * 縦の振れ幅の下限（gal）。**地図の下端の絵と同じ値**（`SeismoWaveChart` の
 * `MIN_SCALE_GAL`）。**揃えないと、同じ揺れが場所によって違う大きさに見える。**
 */
const MIN_SCALE_GAL = 10

interface Props {
  waves: readonly SeismoQuakeWave[]
}

export function QuakeSeismoWave({ waves }: Props) {
  if (waves.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-1">
      {waves.map((wave) => (
        <HistoryWave key={wave.stationId} wave={wave} />
      ))}
    </div>
  )
}

function HistoryWave({ wave }: { wave: SeismoQuakeWave }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [scaleText, setScaleText] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const paint = (): void => {
      // **末尾の空を切ってから描く。** 要求した窓の右端はまだ来ていない時刻を含むので、
      // そのままだと絵の大半が空になる（2026-09-30 のユーザー指摘）。
      const trimmed = trimTrailingGap(wave.columns)
      setScaleText(
        paintWaveColumns(
          canvas,
          (columnCount) =>
            foldHistoryColumns({
              source: trimmed.columns,
              columnCount,
              minScaleGal: MIN_SCALE_GAL,
            }),
          false,
        ),
      )
    }
    paint()
    // **幅が変わったら描き直す。** カードは畳んだり開いたりするので、最初に描いた
    // ときの幅のまま残ると引き伸ばされてぼける。
    const observer = new ResizeObserver(() => paint())
    observer.observe(canvas)
    return () => observer.disconnect()
    // 列が伸びたら描き直す（繋ぎ足しは `useSeismoQuakeWaves` が新しい参照で渡す）。
  }, [wave.columns])

  return (
    <div className="rounded bg-black/30 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-[8rem] roomy:max-w-[14rem]">
          {wave.displayName}
        </span>
        {AXIS_LABELS.map((label, i) => (
          <span key={label} style={{ color: AXIS_COLORS[i] }}>{label}</span>
        ))}
        <span className="ml-auto font-mono tabular-nums text-secondary">{scaleText ?? '—'}</span>
      </div>
      <canvas ref={canvasRef} className="block w-full h-[48px] roomy:h-[64px]" />
    </div>
  )
}
