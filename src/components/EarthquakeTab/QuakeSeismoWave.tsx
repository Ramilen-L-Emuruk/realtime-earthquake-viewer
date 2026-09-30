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
import { trimTrailingGap, type TimedColumns } from '../../utils/seismoWaveColumns'
import { useWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { P_WAVE_COLOR, S_WAVE_COLOR } from '../Map/gl/psWaveStyle'
import { foldHistoryColumns } from '../SeismoWaveChart/historyColumns'
import { paintWaveColumns, type WaveMark } from '../SeismoWaveChart/paintWave'
import { WaveAxisToggles } from '../SeismoWaveChart/WaveAxisToggles'

/**
 * 縦の振れ幅の下限（gal）。**地図の下端の絵と同じ値**（`SeismoWaveChart` の
 * `MIN_SCALE_GAL`）。**揃えないと、同じ揺れが場所によって違う大きさに見える。**
 */
const MIN_SCALE_GAL = 10

/**
 * 到達の線の見た目。**地図の予報円と同じ配色・同じ線種を使う**（`gl/psWaveStyle.ts`）——
 * 同じ画面で同じものを指すのに色が違うと、別の量に見える。**P が破線・S が実線**なのも
 * あちらに揃えたもの。
 */
const P_MARK = { color: P_WAVE_COLOR, dashed: true } as const
const S_MARK = { color: S_WAVE_COLOR, dashed: false } as const

/**
 * 到達時刻を、絵の横位置（左端 0・右端 1）へ落とす。
 *
 * **落とす相手は末尾を切った後の列。** 切る前の窓で割ると、まだ来ていない時刻ぶんだけ
 * 分母が長くなり、線が左へ寄る。
 */
export function buildArrivalMarks(
  trimmed: TimedColumns,
  arrival: { pMs: number; sMs: number } | null,
): WaveMark[] {
  if (arrival === null) return []
  const spanMs = trimmed.columns.length * trimmed.columnSpanMs
  if (!(spanMs > 0)) return []
  const ratioOf = (atMs: number): number => (atMs - trimmed.fromMs) / spanMs
  return [
    { ratio: ratioOf(arrival.pMs), label: 'P', ...P_MARK },
    { ratio: ratioOf(arrival.sMs), label: 'S', ...S_MARK },
  ]
}

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
  // **こちらは購読する。** 地図の下端の絵と違って毎秒描き直していないので、
  // 押した向きを反映する契機がこれしかない。
  const visibleAxes = useWaveAxes()

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
              visibleAxes,
            }),
          // **途切れたら濃さを落とす。** 列は時間で薄れないので、渡さないと
          // 止まった絵が「いま静かに揺れている」ように見え続ける
          // （→ `useSeismoQuakeWaves` の `interrupted`）。**`waveStale` を素通しで
          // 代わりにはできない** —— あちらはライブ接続の生死なので、過去に完結した
          // 7 日ぶんのカードまで薄くなる。
          wave.interrupted,
          { marks: buildArrivalMarks(trimmed, wave.arrival), visibleAxes },
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
    // **到達も向きも依存に入れる** —— 続報で震源が動くと線の位置が変わり、
    // 向きを押すと描く本数と振れ幅の分母が変わる。
    //
    // **途切れも入れる。** 途切れているときは列が 1 つも変わらないので、
    // これが無いと濃さを落とす契機がどこにも無い。
  }, [wave.columns, wave.arrival, wave.interrupted, visibleAxes])

  return (
    <div className="rounded bg-black/30 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-[8rem] roomy:max-w-[14rem]">
          {wave.displayName}
        </span>
        <WaveAxisToggles />
        <span className="ml-auto font-mono tabular-nums text-secondary">{scaleText ?? '—'}</span>
      </div>
      <canvas ref={canvasRef} className="block w-full h-[48px] roomy:h-[64px]" />
    </div>
  )
}
