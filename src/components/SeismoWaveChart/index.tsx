// 自作地震計の合成波形を、地図の下端へ横長で描く。
//
// **出すのは観測点の合成 1 本。** センサーごとの 9 本ではない —— 左上に出している
// 震度が合成の値なので、波形を単独センサーにすると「グラフと震度が別のものを
// 表している」形になる。
//
// **Canvas で描く**（管理コンソールの波形タブと同じ方針）。60 秒 × 100 Hz の
// 6000 点を DOM で持つ形は取らない。
//
// **読む頻度はここが決める。** `readWave()` は state に載らない代わり、呼ぶたびに
// 96 KB を確保する（`useSeismoStation` の `SeismoStations.readWave`）。毎フレーム
// 呼ぶと毎秒 5.7 MB の割り当てになるので、`requestAnimationFrame` の中で最小間隔を
// 置いて間引く。**`setInterval` ではなく rAF を使うのは、タブが隠れている間は
// 止まってほしいから。**

import { useEffect, useRef, useState } from 'react'
import { WAVE_RETAIN_SEC, type SeismoStationState, type SeismoStations } from '../../hooks/useSeismoStation'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { buildWaveColumns } from './waveColumns'
import { formatWaveTally } from './waveLabels'
import { readWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { paintWaveColumns } from './paintWave'
import { WaveAxisToggles } from './WaveAxisToggles'

/**
 * 波形が届かなくなっているときに出す語。
 *
 * **「接続断」とは書かない。** 接続は生きていて（震度は届き続けている）、
 * 波形だけが来ていない状態 —— そう書くと事実とずれる。
 *
 * **復旧すれば自動で消える**（次の巡回で `waveStale` が下りる）。止まっていた事実は
 * 絵の欠測と数え上げに残るので、この語が消えても無かったことにはならない。
 */
const STALE_LABEL = '波形 途絶'

/**
 * 縦の振れ幅の下限（gal）。
 *
 * **実機の静穏時から決めた値**（2026-09-29・12 秒 1203 サンプルの実測）——
 *
 * | 成分 | 最大 | p99 | RMS |
 * |---|---|---|---|
 * | 南北 | 1.50 | 0.84 | 0.32 gal |
 * | 東西 | 1.22 | 0.84 | 0.34 gal |
 * | 上下 | **1.61** | **1.24** | **0.49 gal** |
 *
 * **素の自動にすると平常時のノイズが画面いっぱいに広がり、揺れているようにしか
 * 見えなくなる**（下限 2 gal で試したときは最大が画面の 8 割まで振れた）。この値なら
 * 静穏時の最大が中心から 16%（画面全体の 3 割）に収まり、静かなことが一目で分かる。
 *
 * **これ以上下げない。** 上下動のノイズが上がってきたら、下げるのではなく
 * 設置か校正（#367）を疑うところ。
 *
 * **震度1 の揺れは、この絵では静穏時と見分けられない** —— 震度1 の加速度は
 * 静穏時のノイズと同じ桁にいる。波形で見分けたいのは震度2 以上（2 gal 以上）で、
 * それなら中心から 2 割以上に振れる。震度1 かどうかは左上の計測震度が受け持つ。
 */
const MIN_SCALE_GAL = 10

/** 横軸の幅（ms）。**抱えている長さと揃える** —— ずれると絵の左端の意味が狂う。 */
const SPAN_MS = WAVE_RETAIN_SEC * 1000

/**
 * 描き直しの最小間隔（ms）。
 *
 * **押し出しの周期に合わせる。** まとまりは 0.3 秒ごとに届く（実機の実測で 12 秒に
 * 40 件）ので、それより細かく描いても**同じ絵を描き直すだけ** —— 読むたびに 96 KB を
 * 確保するので、3 倍の頻度で回すと毎秒 1 MB 近い割り当てが無駄に増える。
 */
const MIN_REDRAW_MS = 300

interface Props {
  stations: readonly SeismoStationState[]
  readWave: SeismoStations['readWave']
}

export function SeismoWaveChart({ stations, readWave }: Props) {
  if (stations.length === 0) return null
  // 観測点が増えたら縦に積む（親が `flex flex-col`）。いまは 1 つ。
  return (
    <>
      {stations.map((station) => (
        <StationWave key={station.stationId} station={station} readWave={readWave} />
      ))}
    </>
  )
}

function StationWave({ station, readWave }: { station: SeismoStationState; readWave: Props['readWave'] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [scaleText, setScaleText] = useState<string | null>(null)

  // **描画の輪は張り直さない。** 観測点が変わるたびに rAF を組み直すと、
  // 毎秒の再描画でそのつど輪が切れる。最新の値は ref から読む。
  const readWaveRef = useRef(readWave)
  readWaveRef.current = readWave
  const stationIdRef = useRef(station.stationId)
  stationIdRef.current = station.stationId
  const scaleTextRef = useRef<string | null>(null)
  // **途絶を描画へも渡す。** 文言だけだと、絵そのものは「いま揺れている」ように
  // 見えたまま —— 線を薄くして、生きていない絵だと分かるようにする。
  const staleRef = useRef(station.waveStale)
  staleRef.current = station.waveStale

  useEffect(() => {
    let raf = 0
    let lastAt = -Infinity
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < MIN_REDRAW_MS) return
      lastAt = now
      const canvas = canvasRef.current
      if (canvas === null) return
      const next = drawWave(canvas, readWaveRef.current(stationIdRef.current), staleRef.current)
      // **同じ文字列なら state を差し替えない。** 揺れている間は毎回変わりうるが、
      // 丸めた表示が動かない限り再描画する意味が無い。
      if (next !== scaleTextRef.current) {
        scaleTextRef.current = next
        setScaleText(next)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const tallyText = formatWaveTally(station.waveTally)

  return (
    <div className="w-full bg-black/70 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-[8rem] roomy:max-w-[14rem]">{station.displayName}</span>
        <WaveAxisToggles />
        {/* **途絶はいちばん右へ寄せず、数え上げと同じ列に並べる。** 起きていることの
            種類が違うだけで、どちらも「この絵をそのまま信じてよいか」の手掛かり。 */}
        {station.waveStale && <span className="ml-auto text-secondary">{STALE_LABEL}</span>}
        {tallyText !== null && (
          <span className={`text-secondary truncate${station.waveStale ? '' : ' ml-auto'}`}>{tallyText}</span>
        )}
        <span
          className={`font-mono tabular-nums text-secondary${
            tallyText === null && !station.waveStale ? ' ml-auto' : ''
          }`}
        >
          {scaleText ?? '—'}
        </span>
      </div>
      <canvas ref={canvasRef} className="block w-full h-[40px] roomy:h-[56px]" />
    </div>
  )
}

/**
 * 1 枚ぶんを描き、縦の振れ幅の表示を返す。**描けなければ `null`。**
 *
 * **描くのは `paintWave.ts`。** ここが担うのは「抱えている窓を列へ落とす」ところだけ
 * ——同じ絵を過去の区間からも描くので（地震カードの波形。→ `EarthquakeTab/QuakeSeismoWave`）、
 * 描画そのものを 2 つ持たない。
 */
function drawWave(
  canvas: HTMLCanvasElement,
  win: SeismoWaveWindow | null,
  stale: boolean,
): string | null {
  // **描くたびに読み直す。** 押した向きは次のフレームで効く（この関数は毎秒 10 回
  // 呼ばれるので、購読して描き直しを促す必要が無い）。
  const visibleAxes = readWaveAxes()
  return paintWaveColumns(
    canvas,
    (columnCount) =>
      win === null
        ? null
        : buildWaveColumns({
            window: win,
            columnCount,
            spanMs: SPAN_MS,
            minScaleGal: MIN_SCALE_GAL,
            visibleAxes,
          }),
    stale,
    { visibleAxes },
  )
}
