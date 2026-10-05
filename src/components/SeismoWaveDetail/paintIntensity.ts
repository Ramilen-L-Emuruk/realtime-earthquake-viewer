// 詳細の窓の「震度の推移」を Canvas へ描く。
//
// **値はホストが出したリアルタイム震度の列をそのまま描く**（`GET /quake-intensity` の
// `realtimeSeries`）。ブラウザで計算し直さない —— 窓の長さも直流の引き方もホストと別になり、
// カードの「最大リアルタイム震度」と線の頂点が食い違いうる。
//
// **階級の境目に横線を引き、線は値の階級の色で塗る。** 小数の数字だけでは「震度いくつか」が
// 一目で読めない。色は気象庁の震度配色（`intensityGradeColor`）——地図や一覧と同じ色にする。

import { createLogThrottle, log } from '../../utils/logger'
import { intensityGradeColor, measuredIntensityToGrade } from '../../utils/measuredIntensity'
import type { WaveMark } from '../SeismoWaveChart/paintWave'
import type { ViewRange } from './detailView'

/** 階級の境目（計測震度）と、その上の階級の名前。 */
const GRADE_EDGES: readonly { value: number; label: string }[] = [
  { value: 0.5, label: '1' },
  { value: 1.5, label: '2' },
  { value: 2.5, label: '3' },
  { value: 3.5, label: '4' },
  { value: 4.5, label: '5弱' },
  { value: 5.0, label: '5強' },
  { value: 5.5, label: '6弱' },
  { value: 6.0, label: '6強' },
  { value: 6.5, label: '7' },
]

const LABEL_FONT_PX = 9

/** 2D コンテキストを取れなかった記録の間引き（ブラウザ側の事情なので 1 つの枠）。 */
const throttledNoContext = createLogThrottle(300_000)

/**
 * 縦の範囲。**下は 0 か値の最小、上は「震度2 の境目（1.5）」か値の最大＋余白。**
 *
 * 上に下限を置くのは、静穏時の小さな振れ（0 前後）が枠いっぱいに広がって「揺れている」ように
 * 見えないため（波形の縦の下限と同じ理由）。
 */
export function intensityYRange(values: readonly number[]): { min: number; max: number } {
  let lo = 0
  let hi = 1.5
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v + 0.3 > hi) hi = v + 0.3
  }
  return { min: Math.floor(lo * 2) / 2, max: Math.ceil(hi * 2) / 2 }
}

/**
 * 震度の推移を描く。
 *
 * @param range 横の物差し。**波形の段と同じ範囲を渡すこと**（ずれると線と波形の位置が合わない）
 * @param segments 線を切った後の点の並び（→ `seriesSegments`）
 * @param marks 到達の線・最大の線（比は `range` に対するもの）
 */
export function paintIntensitySeries(
  canvas: HTMLCanvasElement,
  range: ViewRange,
  segments: readonly (readonly { atMs: number; value: number }[])[],
  marks: readonly WaveMark[],
): void {
  const ctx = canvas.getContext('2d')
  // **取れなかったことは記録へ残す**（`paintWave.ts` と同じ。黙って戻ると「推移が無い」のと
  // 区別が付かない）。描き直しのたびに通るので間引く。
  if (ctx === null) {
    throttledNoContext(() => log.error('[seismo] 震度の推移を描く 2D コンテキストを取れなかった'))
    return
  }
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx.clearRect(0, 0, w, h)
  const span = range.toMs - range.fromMs
  if (!(span > 0)) return

  const values = segments.flatMap((s) => s.map((p) => p.value))
  const { min, max } = intensityYRange(values)
  const pad = 2 * dpr
  const yOf = (v: number): number => h - pad - ((v - min) / (max - min)) * (h - 2 * pad)
  const xOf = (ms: number): number => ((ms - range.fromMs) / span) * w

  // 階級の境目
  ctx.font = `${Math.round(LABEL_FONT_PX * dpr)}px ui-monospace, monospace`
  ctx.textBaseline = 'bottom'
  ctx.lineWidth = dpr
  for (const edge of GRADE_EDGES) {
    if (edge.value <= min || edge.value >= max) continue
    const y = Math.round(yOf(edge.value)) + 0.5
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.setLineDash([2 * dpr, 3 * dpr])
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.fillText(`震度${edge.label}`, 2 * dpr, y - dpr)
  }

  // 線。**区間ごとに、終点の値の階級の色で塗る。**
  ctx.lineWidth = 1.5 * dpr
  for (const seg of segments) {
    if (seg.length === 1) {
      const p = seg[0]
      const grade = measuredIntensityToGrade(p.value)
      ctx.fillStyle = grade === null ? '#fff' : intensityGradeColor(grade)
      ctx.fillRect(xOf(p.atMs) - dpr, yOf(p.value) - dpr, 2 * dpr, 2 * dpr)
      continue
    }
    for (let i = 1; i < seg.length; i += 1) {
      const a = seg[i - 1]
      const b = seg[i]
      const grade = measuredIntensityToGrade(b.value)
      ctx.strokeStyle = grade === null ? '#fff' : intensityGradeColor(grade)
      ctx.beginPath()
      ctx.moveTo(xOf(a.atMs), yOf(a.value))
      ctx.lineTo(xOf(b.atMs), yOf(b.value))
      ctx.stroke()
    }
  }

  // 縦の線（到達・最大）。ラベルは波形の段に出すのでここでは引くだけ。
  ctx.lineWidth = dpr
  for (const mark of marks) {
    if (!(mark.ratio >= 0 && mark.ratio <= 1)) continue
    const x = Math.round(mark.ratio * w) + 0.5
    ctx.strokeStyle = mark.color
    ctx.setLineDash(mark.dashed ? [3 * dpr, 3 * dpr] : [])
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  ctx.setLineDash([])
}
