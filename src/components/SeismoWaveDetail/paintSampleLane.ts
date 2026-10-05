// 詳細の窓の 1 段（成分 1 つ、または 3 軸合成）を、生のサンプルから Canvas へ描く。
//
// **カードの絵（`paintWave.ts`）と見た目を揃える。** 目盛りの帯・縦線（P/S・最大）・中心線・
// 濃さは同じ関数・同じ値を使う。違うのは線の作り方だけ —— 寄せて 1 ピクセルに入る点が少なければ
// **点を時間順に結ぶ**（波の形が出る）。多ければ 1 ピクセルごとの上下の端を縦に塗る（包絡）。

import { AXIS_BAND_PX, paintMarks, paintTicks, type WaveMark } from '../SeismoWaveChart/paintWave'
import type { TimeTick } from '../SeismoWaveChart/timeTicks'
import type { LaneGeometry } from './sampleSeries'

/** 1 段を描く。**2D コンテキストが取れなければ `false`**（記録は呼び出し側）。 */
export function paintSampleLane(
  canvas: HTMLCanvasElement,
  params: {
    /** 線の色。 */
    readonly color: string
    /**
     * 0 の位置。成分は**段の中ほど**（正負に振れる）、3 軸合成は**段の下端**（大きさなので負が無い）。
     */
    readonly baseline: 'center' | 'bottom'
    /** 描き方。**幅（デバイスピクセル）を受け取って作る**（幅を知っているのはここだけ）。 */
    readonly geometry: (widthPx: number) => LaneGeometry
    readonly scaleGal: number
    readonly stale: boolean
    readonly marks: readonly WaveMark[]
    readonly ticks?: (widthCssPx: number) => readonly TimeTick[]
  },
): boolean {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return false
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx.clearRect(0, 0, w, h)
  const ticks = params.ticks?.(canvas.clientWidth) ?? []
  const axisH = params.ticks !== undefined ? Math.round(AXIS_BAND_PX * dpr) : 0
  const plotH = Math.max(1, h - axisH)
  paintTicks(ctx, ticks, w, plotH, h, dpr)
  // 0 の線。下端に置くときは線の太さぶん内側へ（切れないように）。
  const zeroY = params.baseline === 'center' ? plotH / 2 : plotH - dpr
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, Math.round(zeroY) + 0.5)
  ctx.lineTo(w, Math.round(zeroY) + 0.5)
  ctx.stroke()

  const scale = params.scaleGal
  if (scale > 0) {
    // 縦の物差し: 0 から上端（中ほどなら上下の端）まで。上端は線の太さぶん空ける。
    const reach = Math.max(1, params.baseline === 'center' ? plotH / 2 - dpr : plotH - dpr * 2)
    const yOf = (v: number): number => zeroY - (v / scale) * reach
    const geom = params.geometry(w)
    // 途切れていれば薄く（カードと同じ 0.25）。段に 1 本しか無いので、カードのように下の線を
    // 透かす必要は無い。
    ctx.globalAlpha = params.stale ? 0.25 : 0.85
    ctx.lineWidth = dpr
    ctx.strokeStyle = params.color
    ctx.beginPath()
    let started = false
    if (geom.kind === 'envelope') {
      for (let c = 0; c < geom.min.length; c += 1) {
        const lo = geom.min[c]
        const hi = geom.max[c]
        // 値の無い列で線を切る（`lineTo` に NaN を渡しても何もしないので、自分で切る）。
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          started = false
          continue
        }
        const x = c + 0.5
        if (started) ctx.lineTo(x, yOf(hi))
        else {
          ctx.moveTo(x, yOf(hi))
          started = true
        }
        ctx.lineTo(x, yOf(lo))
      }
    } else {
      for (let k = 0; k < geom.x.length; k += 1) {
        const v = geom.y[k]
        if (!Number.isFinite(v)) {
          started = false
          continue
        }
        if (started) ctx.lineTo(geom.x[k], yOf(v))
        else {
          ctx.moveTo(geom.x[k], yOf(v))
          started = true
        }
      }
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  paintMarks(ctx, params.marks, w, plotH, dpr)
  return true
}
