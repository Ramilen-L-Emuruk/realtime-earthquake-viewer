// 地図の下端の波形の段を描く（`index.tsx` の描画の輪から 0.3 秒ごとに呼ぶ）。
//
// **描くのは `paintWave.ts`。** ここが担うのは「抱えている窓を段ごとの列へ落とし、どの描き方で描くかを決める」
// ところだけ。描き分けの判定を部品の外に置くのは、テストで固定するため（`liveLanes.test.ts`）。

import type { WaveArrival } from '../../utils/seismoWaveArrival'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { quietScaledGal } from '../../utils/seismoQuietScale'
import { readWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { WAVE_RETAIN_SEC } from '../../hooks/useSeismoStation'
import { buildArrivalMarksForRange } from './arrivalMarks'
import { buildWaveColumns, buildWaveMeanLines, type WaveMeanLines } from './waveColumns'
import {
  AXIS_AVERAGE_COLORS,
  COMPOSITE_SMOOTH_COLOR,
  paintCompositeColumns,
  paintWaveColumns,
  type WaveMark,
} from './paintWave'
import { buildTimeTicks } from './timeTicks'

/** 横軸の幅（ms）。**抱えている長さと揃える** —— ずれると絵の左端の意味が狂う。 */
const SPAN_MS = WAVE_RETAIN_SEC * 1000

/** 描く段。**畳んでいれば 1 枚**（`composite` か `overlay`）、展開していれば合成＋見えている向き。 */
export type Lane = { readonly kind: 'composite' } | { readonly kind: 'overlay' } | { readonly kind: 'axis'; readonly axis: number }

export function laneKey(lane: Lane): string {
  return lane.kind === 'axis' ? `axis-${lane.axis}` : lane.kind
}

/**
 * 段をすべて描き、段ごとの縦の表示を返す（描けなかった段は `null`）。
 *
 * **描くのは `paintWave.ts`。** ここが担うのは「抱えている窓を列へ落とす」ところだけ
 * ——同じ絵を過去の区間からも描くので（地震カードの波形。→ `EarthquakeTab/QuakeSeismoWave`）、
 * 描画そのものを 2 つ持たない。
 */
export function drawLanes(params: {
  canvases: ReadonlyMap<string, HTMLCanvasElement>
  lanes: readonly Lane[]
  /** 展開しているか。**段の数から推し量らない**（向きを減らしても展開は展開）。 */
  expanded: boolean
  win: SeismoWaveWindow | null
  stale: boolean
  quietLevel: number | null
  arrival: WaveArrival | null
}): { texts: Record<string, string | null>; compositeFellBack: boolean } {
  const { canvases, lanes, expanded, win, stale, quietLevel, arrival } = params
  // **描くたびに読み直す。** 押した向きは次のフレームで効く（この関数は毎秒 3 回
  // 呼ばれるので、購読して描き直しを促す必要が無い）。
  const visibleAxes = readWaveAxes()
  // **縦の下限は畳むと ×3・展開した段は ×1.5**（2026-10-13 ユーザー承認。展開した段は詳細の窓と揃える）。
  const minScaleGal = quietScaledGal(expanded ? 'detail' : 'card', quietLevel)
  const marks = liveArrivalMarks(win, arrival)
  // 平均の線は**線が 1 本だけの段**に重ねる（2026-10-13 ユーザー承認）——展開した段・畳んだ合成・向きを 1 つだけ
  // 残した「3 成分を重ねる」。3 本を重ねた絵では作らない（6000 点 × 3 成分の移動平均なので、使わないときは回さない）。
  // **列数ごとに 1 回だけ作る**（段の幅は同じなので、段ごとに作り直さない）。
  // **成分の平均は、成分の線を求められて初めて作る**（畳んだ合成だけなら要らない）。どの段が使うかを先に
  // 数え上げる形にすると、使う段を足したときに数え漏れても線が黙って消えるだけになる。
  let meanCache: { count: number; withAxes: boolean; lines: WaveMeanLines } | null = null
  const meansFor = (columnCount: number, withAxes: boolean): WaveMeanLines | null => {
    if (win === null) return null
    if (meanCache === null || meanCache.count !== columnCount || (withAxes && !meanCache.withAxes)) {
      meanCache = {
        count: columnCount,
        withAxes,
        lines: buildWaveMeanLines({ window: win, columnCount, spanMs: SPAN_MS, visibleAxes, includeAxes: withAxes }),
      }
    }
    return meanCache.lines
  }
  // **列も列数ごとに 1 回だけ組む**（展開すると 4 段が同じ引数で呼ぶ）。
  let columnsCache: { count: number; columns: ReturnType<typeof buildWaveColumns> | null } | null = null
  const build = (columnCount: number) => {
    if (columnsCache === null || columnsCache.count !== columnCount) {
      columnsCache = {
        count: columnCount,
        columns: win === null ? null : buildWaveColumns({ window: win, columnCount, spanMs: SPAN_MS, minScaleGal, visibleAxes }),
      }
    }
    return columnsCache.columns
  }

  /** その成分の正側・負側の平均の線（段の線と同じ縦の物差しで重ねる）。 */
  const axisMeanOverlays = (a: number) => (count: number) => {
    const m = meansFor(count, true)
    if (m === null) return []
    const color = AXIS_AVERAGE_COLORS[a]
    return [
      { values: m.axes[a].pos, color },
      { values: m.axes[a].neg, color },
    ]
  }
  // 3 成分を重ねる絵で、向きが 1 つだけ残っているならその成分（それ以外は重ねない）。
  const onlyAxis = singleVisibleAxis(visibleAxes)
  const overlayLaneOverlays = onlyAxis === null ? undefined : axisMeanOverlays(onlyAxis)

  const out: Record<string, string | null> = {}
  let compositeFellBack = false
  lanes.forEach((lane, i) => {
    const key = laneKey(lane)
    const canvas = canvases.get(key)
    if (canvas === undefined) return
    const isLast = i === lanes.length - 1
    // **P/S のラベルは一番上の段だけ**（詳細の窓と同じ。段ごとに同じ字が並ぶと読みにくい）。
    const laneMarks = i === 0 ? marks : marks.map((m) => ({ ...m, label: '' }))
    const ticks = isLast ? liveTicks : undefined
    if (lane.kind === 'composite') {
      const text = paintCompositeColumns(canvas, build, stale, {
        minScaleGal,
        marks: laneMarks,
        ticks,
        // 合成の段は畳んでも展開しても 1 本なので、いつも均した線を重ねる。
        overlays: (count) => {
          const m = meansFor(count, false)
          return m === null ? [] : [{ values: m.compositeSmooth, color: COMPOSITE_SMOOTH_COLOR }]
        },
      })
      // **畳んだ合成が描けなければ 3 成分を重ねる**（展開していれば成分の段が下にあるので空のまま）。
      // 押し出しの窓は合成を必ず作れるので、ふだんは来ない。**重ねた絵が描けたときだけ「戻した」と数える**
      // ——どちらも描けないのは値が 1 つも無いとき（途絶・繋いだ直後）で、それは段の「—」が示している。
      if (text === null && !expanded) {
        const overlay = paintWaveColumns(canvas, build, stale, {
          visibleAxes,
          ticks,
          marks: laneMarks,
          overlays: overlayLaneOverlays,
        })
        if (overlay !== null) compositeFellBack = true
        out[key] = overlay
        return
      }
      out[key] = text
      return
    }
    if (lane.kind === 'overlay') {
      out[key] = paintWaveColumns(canvas, build, stale, {
        visibleAxes,
        ticks,
        marks: laneMarks,
        overlays: overlayLaneOverlays,
      })
      return
    }
    const a = lane.axis
    out[key] = paintWaveColumns(canvas, build, stale, {
      // **振れ幅の分母は見えている向き全体で取り、線はその段の成分だけ引く** ——3 段の縦を揃える（詳細の窓と同じ）。
      visibleAxes: [0, 1, 2].map((x) => x === a),
      ticks,
      marks: laneMarks,
      overlays: axisMeanOverlays(a),
    })
  })
  return { texts: out, compositeFellBack }
}

/**
 * 見えている向きが 1 つだけならその番号、そうでなければ `null`。**3 成分を重ねる絵で平均の線を重ねるかの判定。**
 * 2 本以上を重ねた絵に平均の線を足すと、線の数が倍になって読めない。
 */
export function singleVisibleAxis(visibleAxes: readonly boolean[]): number | null {
  let only: number | null = null
  for (let a = 0; a < 3; a += 1) {
    if (visibleAxes[a] === false) continue
    if (only !== null) return null
    only = a
  }
  return only
}

/**
 * P/S の到達線を、いまの 60 秒の窓の横位置へ落とす。**右端は最後に届いたサンプル**
 * （`buildWaveColumns` が右端をそこへ固定している）。まだ来ていない時刻は右端の外に落ちて描かれない。
 */
function liveArrivalMarks(win: SeismoWaveWindow | null, arrival: WaveArrival | null): WaveMark[] {
  if (win === null || arrival === null) return []
  const n = win.gal[0].length
  if (n === 0) return []
  const lastMs = win.firstSampleMs + (n - 1) * win.msPerSample
  return buildArrivalMarksForRange({ fromMs: lastMs - SPAN_MS, toMs: lastMs }, arrival)
}

/**
 * 目盛り（−60s 〜 0s）。**0 は右端の「最後に届いたサンプル」**（`buildWaveColumns` が右端を
 * そこへ固定している）。時刻の幅は変わらないので、刻みは絵の幅だけで決まる。
 */
function liveTicks(widthCssPx: number) {
  return buildTimeTicks({ fromMs: -SPAN_MS, toMs: 0, zeroMs: 0, zeroLabel: '0s', widthPx: widthCssPx })
}
