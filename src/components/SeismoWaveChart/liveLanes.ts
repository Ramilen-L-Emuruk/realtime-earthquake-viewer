// 地図の下端の波形の段を描く（`index.tsx` の描画の輪から 0.3 秒ごとに呼ぶ）。
//
// **描くのは `paintWave.ts`。** ここが担うのは「抱えている窓を段ごとの列へ落とし、どの描き方で描くかを決める」
// ところだけ。描き分けの判定を部品の外に置くのは、テストで固定するため（`liveLanes.test.ts`）。
//
// **右端は時計の「いま」**（`docs/public-waveform-design.md` §5.4）。ここが描くのは画面に置かない裏の絵で、
// 横は「いま − 時間幅（設定の 60 / 120 / 180 秒）」から「いま ＋ 先の余白」まで。画面へは `index.tsx` が毎フレーム、時計の進んだ分だけ
// ずらして写す（組み直すのは 0.3 秒ごと）。先の余白は、次に組み直すまでの間に右端から見えてくる分で、
// そこには何も描かない（まだ届いていない）。

import type { WaveArrival } from '../../utils/seismoWaveArrival'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { readWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { buildArrivalMarksForRange } from './arrivalMarks'
import { buildWaveColumns, buildWaveMeanLines, type WaveMeanLines } from './waveColumns'
import {
  AXIS_AVERAGE_COLORS,
  COMPOSITE_SMOOTH_COLOR,
  paintCompositeColumnsAt,
  paintWaveColumnsAt,
  type CssSize,
  type WaveMark,
} from './paintWave'
import { buildTimeTicks } from './timeTicks'
import type { WaveUnit } from './waveUnit'

/** 裏の絵を描く先。**画面に置かない canvas** なので、大きさは画面の段から測って渡す。 */
export interface LaneTarget {
  readonly canvas: HTMLCanvasElement
  readonly size: CssSize
}

/**
 * 裏の絵の時間の取り方。`nowMs` が組み直した時点の「いま」、`spanMs` が画面に見える横の幅、`leadMs` がその先に
 * 取る余白。裏の絵は `nowMs − spanMs` から `nowMs + leadMs` まで（幅は {@link liveSpanMs}）。
 */
export interface LiveTimeline {
  readonly nowMs: number
  /** 画面に見える横の幅（ms。設定の時間幅。抱えている長さ以下）。 */
  readonly spanMs: number
  readonly leadMs: number
  /**
   * `nowMs` が較正した時計の値か。**較正していない間は P/S の線を引かない**（2026-10-15 ユーザー承認）——
   * そのときの「いま」は端末の時計で、進んでいれば到達時刻より先に線が出る。
   */
  readonly clockCalibrated: boolean
}

/** 裏の絵の横の幅（ms）。 */
export function liveSpanMs(timeline: LiveTimeline): number {
  return timeline.spanMs + timeline.leadMs
}

/**
 * 裏の絵を組んでから、画面へ写す時点までに時計が進んだ分（ms）。**0 から `leadMs` の間に収める** ——
 * 時計が戻ったら組んだときの位置のまま写し、組み直しが遅れても余白の外の空白は写さない。
 * 時計の値が壊れていれば（非有限）0 を返す。
 */
export function presentShiftMs(timeline: LiveTimeline, nowMs: number): number {
  const elapsed = nowMs - timeline.nowMs
  if (!Number.isFinite(elapsed)) return 0
  return Math.min(Math.max(0, elapsed), timeline.leadMs)
}

/** 裏の絵のどこから写すか（裏の絵の画素）。ずらす時間を、見える幅（`spanMs` ぶん）の画素へ直す。 */
export function presentSourceX(shiftMs: number, spanMs: number, cssWidth: number, dpr: number): number {
  return (shiftMs / spanMs) * cssWidth * dpr
}

/** 目盛りの帯だけを取り、目盛りは描かない（目盛りは画面へ写すときに動かさずに描く）。 */
const RESERVE_TICK_BAND = (): readonly never[] => []

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
  targets: ReadonlyMap<string, LaneTarget>
  lanes: readonly Lane[]
  /** 展開しているか。**段の数から推し量らない**（向きを減らしても展開は展開）。 */
  expanded: boolean
  win: SeismoWaveWindow | null
  stale: boolean
  quietLevel: number | null
  arrival: WaveArrival | null
  timeline: LiveTimeline
  /** 縦の単位と下限の物差し（自作地震計は gal、公開観測点は μm/s。`waveUnit.ts`）。 */
  unit: WaveUnit
}): { texts: Record<string, string | null>; compositeFellBack: boolean } {
  const { targets, lanes, expanded, win, stale, quietLevel, arrival, timeline, unit } = params
  const spanMs = liveSpanMs(timeline)
  const rightEdge = timeline.nowMs + timeline.leadMs
  // **描くたびに読み直す。** 押した向きは次のフレームで効く（この関数は毎秒 3 回
  // 呼ばれるので、購読して描き直しを促す必要が無い）。
  const visibleAxes = readWaveAxes()
  // **縦の下限は畳むと ×3・展開した段は ×1.5**（2026-10-13 ユーザー承認。展開した段は詳細の窓と揃える）。
  // 値の単位は観測点の種類で違う（`unit`）。列の組み立て（`buildWaveColumns`）は単位を見ないので、名前の gal は読み替える。
  const minScale = unit.minScale(expanded ? 'detail' : 'card', quietLevel)
  const marks = liveArrivalMarks(timeline, arrival)
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
        lines: buildWaveMeanLines({ window: win, columnCount, spanMs, rightEdge, visibleAxes, includeAxes: withAxes }),
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
        columns: win === null ? null : buildWaveColumns({ window: win, columnCount, spanMs, rightEdge, minScaleGal: minScale, visibleAxes }),
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
    const target = targets.get(key)
    if (target === undefined) return
    const { canvas, size } = target
    const isLast = i === lanes.length - 1
    // **P/S のラベルは一番上の段だけ**（詳細の窓と同じ。段ごとに同じ字が並ぶと読みにくい）。
    const laneMarks = i === 0 ? marks : marks.map((m) => ({ ...m, label: '' }))
    // **一番下の段は目盛りの帯だけ取る。** 目盛りの字は時間と一緒に流れてはいけない（−30s は −30s の位置に
    // 留まる）ので、画面へ写すときに描く。
    const ticks = isLast ? RESERVE_TICK_BAND : undefined
    if (lane.kind === 'composite') {
      const text = paintCompositeColumnsAt(canvas, size, build, stale, {
        minScale,
        unit: unit.label,
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
        const overlay = paintWaveColumnsAt(canvas, size, build, stale, {
          visibleAxes,
          ticks,
          marks: laneMarks,
          overlays: overlayLaneOverlays,
          unit: unit.label,
        })
        if (overlay !== null) compositeFellBack = true
        out[key] = overlay
        return
      }
      out[key] = text
      return
    }
    if (lane.kind === 'overlay') {
      out[key] = paintWaveColumnsAt(canvas, size, build, stale, {
        visibleAxes,
        ticks,
        marks: laneMarks,
        overlays: overlayLaneOverlays,
        unit: unit.label,
      })
      return
    }
    const a = lane.axis
    out[key] = paintWaveColumnsAt(canvas, size, build, stale, {
      // **振れ幅の分母は見えている向き全体で取り、線はその段の成分だけ引く** ——3 段の縦を揃える（詳細の窓と同じ）。
      visibleAxes: [0, 1, 2].map((x) => x === a),
      ticks,
      marks: laneMarks,
      overlays: axisMeanOverlays(a),
      unit: unit.label,
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
 * P/S の到達線を、裏の絵の横位置へ落とす。**「いま」（組み直した時点）より先の線は入れない。**
 * 裏の絵は「いま」の先に余白を持つが、そこへ線を入れると、画面へ写す間に右端から先に現れてしまう。
 * 線が届くのは、その時刻を過ぎてから最初に組み直したとき（遅れは組み直す間隔ぶん）。
 *
 * **この関数の振る舞いが、到達予想キーの門を掛けない根拠になっている**（`docs/forecast-computation-audit.md` の 11。
 * 右端＝いま、それより先の時刻は描かない）。これから来る時刻を示す形（「いま」より先の線を描く・範囲外の線を
 * 端へ張り付ける）へ変えるなら、その整理をやり直す。
 */
export function liveArrivalMarks(timeline: LiveTimeline, arrival: WaveArrival | null): WaveMark[] {
  if (arrival === null || !timeline.clockCalibrated) return []
  const fromMs = timeline.nowMs - timeline.spanMs
  const toMs = timeline.nowMs + timeline.leadMs
  const nowRatio = (timeline.nowMs - fromMs) / (toMs - fromMs)
  return buildArrivalMarksForRange({ fromMs, toMs }, arrival).filter((m) => m.ratio <= nowRatio)
}

/**
 * 目盛り（−時間幅 〜 0s）。**0 は右端の「いま」。** 画面へ写すたびに描き、波形と一緒に流さない。
 * 刻みは時間幅と絵の幅で決まる。
 */
export function liveTicks(widthCssPx: number, spanMs: number) {
  return buildTimeTicks({ fromMs: -spanMs, toMs: 0, zeroMs: 0, zeroLabel: '0s', widthPx: widthCssPx })
}
