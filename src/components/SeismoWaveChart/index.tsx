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
import { measureWindowQuietLevel, QuietLevelMemory, quietScaledGal } from '../../utils/seismoQuietScale'
import { buildWaveColumns } from './waveColumns'
import { formatWaveTally } from './waveLabels'
import { readWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { paintWaveColumns } from './paintWave'
import { buildTimeTicks } from './timeTicks'
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
 * 静かさを測り直す間隔（データの時刻で ms）。**1 秒。**
 *
 * 描き直しは 0.3 秒ごとだが、測るのは 30 秒ぶんの中央値なので、0.3 秒ごとに測っても値はほとんど
 * 動かない。3 成分 × 3000 サンプルを並べ替えるので、描くたびに測る理由が無い。
 */
const QUIET_MEASURE_INTERVAL_MS = 1000

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
    // **静かさは観測点ごとに覚える**（`QuietLevelMemory`）。観測点が替わったら覚え直す。
    let quietStationId: string | null = null
    let quiet = new QuietLevelMemory()
    let lastMeasuredMs = -Infinity
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < MIN_REDRAW_MS) return
      lastAt = now
      const canvas = canvasRef.current
      if (canvas === null) return
      const stationId = stationIdRef.current
      const win = readWaveRef.current(stationId)
      if (stationId !== quietStationId) {
        quietStationId = stationId
        quiet = new QuietLevelMemory()
        lastMeasuredMs = -Infinity
      }
      if (win !== null && win.gal[0].length > 0) {
        const endMs = win.firstSampleMs + win.gal[0].length * win.msPerSample
        // 時刻が戻った（再接続で窓が作り直された等）ときも測り直す。
        if (endMs - lastMeasuredMs >= QUIET_MEASURE_INTERVAL_MS || endMs < lastMeasuredMs) {
          lastMeasuredMs = endMs
          quiet.observe(endMs, measureWindowQuietLevel(win))
        }
      }
      const next = drawWave(canvas, win, staleRef.current, quietScaledGal('card', quiet.current()))
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
      {/* 高さは目盛りの帯（`AXIS_BAND_PX` = 15px）を足したもの。 */}
      <canvas ref={canvasRef} className="block w-full h-[55px] roomy:h-[71px]" />
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
  minScaleGal: number,
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
            minScaleGal,
            visibleAxes,
          }),
    stale,
    { visibleAxes, ticks: liveTicks },
  )
}

/**
 * 目盛り（−60s 〜 0s）。**0 は右端の「最後に届いたサンプル」**（`buildWaveColumns` が右端を
 * そこへ固定している）。時刻の幅は変わらないので、刻みは絵の幅だけで決まる。
 */
function liveTicks(widthCssPx: number) {
  return buildTimeTicks({ fromMs: -SPAN_MS, toMs: 0, zeroMs: 0, zeroLabel: '0s', widthPx: widthCssPx })
}
