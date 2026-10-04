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
import { formatTime } from '../../utils/formatters'
import { log } from '../../utils/logger'
import { selectQuakeWindow, type WaveAxisZero } from '../../utils/seismoQuakeWindow'
import type { TimedColumns } from '../../utils/seismoWaveColumns'
import { useWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { P_WAVE_COLOR, S_WAVE_COLOR } from '../Map/gl/psWaveStyle'
import { foldHistoryColumns } from '../SeismoWaveChart/historyColumns'
import { paintWaveColumns, type WaveMark } from '../SeismoWaveChart/paintWave'
import { WaveAxisToggles } from '../SeismoWaveChart/WaveAxisToggles'
import { buildTimeTicks } from '../SeismoWaveChart/timeTicks'

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

/**
 * 時間軸の 0 に書く名前。
 *
 * - 秒まで取れた: 「発生」
 * - 分までしか無い: 地震情報の時刻（`13:26:00`）。**発生を名乗らない** —— 発生はこの分の
 *   0〜59 秒のどこかで、0 に「発生」と書くと最大 59 秒ずれた目盛りになる
 */
export function axisZeroLabel(zero: WaveAxisZero): string {
  if (zero.kind === 'origin') return '発生'
  return formatTime(new Date(zero.ms).toISOString()) ?? ''
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
  // 「範囲を切れなかった」を記録へ残した組。**同じ理由は 1 回だけ** —— 描き直しは列が伸びるたび
  // （0.3 秒ごと）に走るので、間引かないと同じ行で埋まる。
  const loggedUntrimmedRef = useRef<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const paint = (): void => {
      // **揺れに合わせて範囲を切り出してから描く**（→ `utils/seismoQuakeWindow.ts`）。
      // 取った範囲は発生の 30 秒前から 4 分ぶんあり、そのまま描くと揺れが平らな線に埋もれる。
      // 末尾の空（まだ来ていない時刻）もここで落ちる。
      const picked = selectQuakeWindow({ base: wave.columns, zero: wave.axisZero, reach: wave.reach })
      const trimmed = picked.columns
      // **切れなかったことは記録へ残す。** 絵は取った範囲のまま出るので、画面からは「切る必要が
      // 無かった」と見分けが付かない（ノイズの測り方や走時の側が壊れても、黙って広い絵に戻るだけ）。
      if (picked.untrimmedReason !== null) {
        const key = `${wave.stationId}@${wave.axisZero.ms}@${picked.untrimmedReason}`
        if (loggedUntrimmedRef.current !== key) {
          loggedUntrimmedRef.current = key
          log.debug(
            `[seismo] 地震カードの波形を揺れに合わせて切れなかった（${wave.stationId}）: ${picked.untrimmedReason}`,
          )
        }
      }
      const spanMs = trimmed.columns.length * trimmed.columnSpanMs
      const zeroLabel = axisZeroLabel(wave.axisZero)
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
          {
            marks: buildArrivalMarks(trimmed, wave.arrival),
            visibleAxes,
            ticks: (widthPx) =>
              buildTimeTicks({
                fromMs: trimmed.fromMs,
                toMs: trimmed.fromMs + spanMs,
                zeroMs: wave.axisZero.ms,
                zeroLabel,
                widthPx,
              }),
          },
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
    //
    // **時間軸の 0 と時間帯も入れる。** 秒が後から取れると列は変わらないまま 0 だけが動く。
  }, [wave.columns, wave.arrival, wave.axisZero, wave.reach, wave.interrupted, visibleAxes])

  return (
    <div className="rounded bg-black/30 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-[8rem] roomy:max-w-[14rem]">
          {wave.displayName}
        </span>
        <WaveAxisToggles />
        <span className="ml-auto font-mono tabular-nums text-secondary">{scaleText ?? '—'}</span>
      </div>
      {/* 高さは目盛りの帯（`AXIS_BAND_PX` = 10px）を足したもの。 */}
      <canvas ref={canvasRef} className="block w-full h-[58px] roomy:h-[74px]" />
    </div>
  )
}
