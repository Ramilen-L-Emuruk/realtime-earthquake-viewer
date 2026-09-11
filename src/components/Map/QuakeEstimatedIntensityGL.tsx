import { useEffect, useRef } from 'react'
import type { CanvasSource } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { getIntensityColor } from '../../utils/intensity'
import { addOrderedLayer } from './gl/layerOrder'
import { mercatorY } from '../../utils/isoseismal'
import { buildSiToScale } from '../../utils/estimatedIntensity'
import { CELL_LAT_DEG, CELL_LON_DEG } from '../../utils/bufrEstimatedIntensity'
import type { JMAEstimatedIntensity } from '../../types/earthquake'
import { log, createLogThrottle } from '../../utils/logger'

// 気象庁の推計震度分布図（IXAC41）を面として敷く。
//
// **自前の面（QuakeIntensitySurfaceGL）の公式版。** あちらは観測点の値を逆距離加重で
// 補間しただけだが、こちらは地盤増幅度と緊急地震速報の震度予測技術まで織り込んだ気象庁の推計。
// **同時には出さない**（どちらを見ているのか混ざる）。切り替えは JapanMapGL 側の `visible`。
//
// 自前の面との作りの違いは 2 つ。
//
// - **補間しない。** 値は 250m メッシュのセルが自分で持っている。セルを画素へ塗るだけ
// - **陸クリップを掛けない。** 気象庁が陸域だけを配信しており、実電文の分布もそうなっている
//   （復号したセルを描くと海岸線がそのまま出る）。県境で切り直す必要が無い
//
// **メッシュの境界を強調しない。** 気象庁が「個々のメッシュの震度は矩形内が同一震度である
// ことを示すものではなく、メッシュの境界線が震度の境界でもありません」「分布図を必要以上に
// 拡大してメッシュの境界線を強調してもあまり意味がありません」と明記している。視野に合わせた
// ラスタへ落とし、線形補間で貼るのはこの求めに沿う形（格子をポリゴンで出すと境界線が立つ）。
//
// **仕様書は docs/spec/map-rendering-spec.md §19（描き方）と quake-spec.md §9（出す条件）。**

const SRC = 'quake-estimated-intensity'
const LYR = 'quake-estimated-intensity'

/** 面の濃さ。観測点バッジと地形が透けて見える程度（自前の面と揃える）。 */
const SURFACE_OPACITY = 0.62

/** canvas の短辺の目標。自前の面と同じ考え方（視野のアスペクト比で長辺を決める）。 */
const TARGET_SHORT_PX = 512
const MAX_LONG_PX = 1536

/** 視野の外へ少しはみ出させる割合。移動のたびに縁が見えるのを防ぐ。 */
const VIEW_PADDING = 0.08

const ANOMALY_LOG_INTERVAL_MS = 30_000

type AnomalyKind = 'missing-objects' | 'degenerate-view' | 'no-context' | 'no-cell-drawn' | 'exception'

/** 種別ごとに独立したスロットル（理由を共有すると最初の 1 つが残りを隠す。自前の面と同じ）。 */
function createAnomalyLog(): (kind: AnomalyKind, emit: () => void) => void {
  const throttles = new Map<AnomalyKind, (emit: () => void) => void>()
  return (kind, emit) => {
    let t = throttles.get(kind)
    if (!t) { t = createLogThrottle(ANOMALY_LOG_INTERVAL_MS); throttles.set(kind, t) }
    t(emit)
  }
}

const INITIAL_COORDINATES: [[number, number], [number, number], [number, number], [number, number]] = [
  [122, 46], [154, 46], [154, 24], [122, 24],
]

function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
const BAND_RGB = new Map<number, [number, number, number]>()
function bandRgb(scale: number): [number, number, number] {
  const hit = BAND_RGB.get(scale)
  if (hit) return hit
  const rgb = hexToRgb(getIntensityColor(scale))
  BAND_RGB.set(scale, rgb)
  return rgb
}

interface Props {
  data: JMAEstimatedIntensity | null
  visible: boolean
}

export function QuakeEstimatedIntensityGL({ data, visible }: Props) {
  const map = useMapGL()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const addedRef = useRef(false)
  const anomalyLogRef = useRef(createAnomalyLog())

  useEffect(() => {
    if (!map) return
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    canvasRef.current = canvas
    map.addSource(SRC, { type: 'canvas', canvas, coordinates: INITIAL_COORDINATES, animate: false })
    addOrderedLayer(map, {
      id: LYR,
      type: 'raster',
      source: SRC,
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': SURFACE_OPACITY,
        'raster-opacity-transition': { duration: 0, delay: 0 },
        'raster-fade-duration': 0,
        // メッシュの境界を立てない。**気象庁が「境界線を強調しても意味がない」と書いている。**
        'raster-resampling': 'linear',
      },
    })
    addedRef.current = true
    return () => {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
      canvasRef.current = null
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return

    const hide = () => {
      if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', 'none')
    }
    const giveUp = (kind: AnomalyKind, reason: string) => {
      hide()
      anomalyLogRef.current(kind, () => log.warn(`[map] 推計震度分布図を描けなかった: ${reason}`))
    }

    const draw = () => {
      const canvas = canvasRef.current
      const src = map.getSource(SRC) as CanvasSource | undefined
      if (!canvas || !src || !map.getLayer(LYR)) {
        giveUp('missing-objects', 'canvas / source / layer が揃っていない')
        return
      }
      // 出さない条件のうち、これらは正常な状態（モードが off・電文が無い）。
      if (!visible || !data || data.count === 0) { hide(); return }

      const view = map.getBounds()
      const rawWest = view.getWest()
      const rawEast = view.getEast()
      const rawNorth = Math.min(85, view.getNorth())
      const rawSouth = Math.max(-85, view.getSouth())
      const padLng = (rawEast - rawWest) * VIEW_PADDING
      const padLat = (rawNorth - rawSouth) * VIEW_PADDING
      const west = rawWest - padLng
      const east = rawEast + padLng
      const north = Math.min(85, rawNorth + padLat)
      const south = Math.max(-85, rawSouth - padLat)
      // 比較は NaN に対しても偽になるので、値が壊れている場合もここで捕まる。
      if (!(east > west) || !(north > south)) {
        giveUp('degenerate-view', `視野が退化している (${rawWest},${rawSouth})-(${rawEast},${rawNorth})`)
        return
      }

      const yTop = mercatorY(north)
      const yBottom = mercatorY(south)
      const mercHeight = yBottom - yTop
      const mercWidth = (east - west) / 360
      if (!(mercHeight > 0) || !(mercWidth > 0)) {
        giveUp('degenerate-view', `視野の寸法が求まらない (merc ${mercWidth} x ${mercHeight})`)
        return
      }

      // canvas のアスペクトは Mercator 空間で取る（貼り付け先がその空間のため）。
      const aspect = mercWidth / mercHeight
      let width = aspect >= 1 ? Math.round(TARGET_SHORT_PX * aspect) : TARGET_SHORT_PX
      let height = aspect >= 1 ? TARGET_SHORT_PX : Math.round(TARGET_SHORT_PX / aspect)
      const longPx = Math.max(width, height)
      if (longPx > MAX_LONG_PX) {
        const k = MAX_LONG_PX / longPx
        width = Math.max(16, Math.round(width * k))
        height = Math.max(16, Math.round(height * k))
      }

      const startedAt = performance.now()
      // 画素ごとに**最も大きい計測震度**を残す。引いた画では 1 画素に十数セルが重なるので、
      // 後勝ちにすると「強く揺れた狭い範囲」が隣のセルに上書きされて消える。
      const best = new Uint8Array(width * height)
      const sx = width / (east - west)
      const sy = height / mercHeight
      const { lat: lats, lon: lons, si: sis, count } = data
      let drawn = 0
      for (let i = 0; i < count; i++) {
        const la = lats[i]
        const lo = lons[i]
        const v = sis[i]
        let xa = Math.floor((lo - west) * sx)
        let xb = Math.ceil((lo + CELL_LON_DEG - west) * sx)
        // Mercator では緯度が上がるほど y が小さくなるので、北端が上（yb）・南端が下（ya）。
        let yb = Math.floor((mercatorY(la + CELL_LAT_DEG) - yTop) * sy)
        let ya = Math.ceil((mercatorY(la) - yTop) * sy)
        if (xb <= 0 || xa >= width || ya <= 0 || yb >= height) continue
        if (xa < 0) xa = 0
        if (xb > width) xb = width
        if (yb < 0) yb = 0
        if (ya > height) ya = height
        // 寄っていない画では 1 セルが 1 画素に満たない。潰れて消えないよう最低 1 画素は塗る。
        if (xb <= xa) xb = xa + 1
        if (ya <= yb) ya = yb + 1
        for (let y = yb; y < ya; y++) {
          const row = y * width
          for (let x = xa; x < xb; x++) {
            if (v > best[row + x]) best[row + x] = v
          }
        }
        drawn++
      }
      if (drawn === 0) {
        // 視野の中にセルが 1 つも無い。**異常ではない**（分布から離れた場所を見ているだけ）。
        hide()
        return
      }

      const siToScale = buildSiToScale(data.grades)
      const rgba = new Uint8ClampedArray(width * height * 4)
      let painted = 0
      for (let k = 0; k < best.length; k++) {
        const v = best[k]
        if (v === 0) continue
        const scale = siToScale[v]
        if (scale === 0) continue
        const [r, g, b] = bandRgb(scale)
        const o = k * 4
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = b
        rgba[o + 3] = 255
        painted++
      }
      if (painted === 0) {
        // セルは視野に入っているのに 1 画素も色が付かない＝凡例とセルの値が噛み合っていない。
        // 全面が透明になるので、黙って「表示中」を名乗らせない。
        giveUp('no-cell-drawn', `視野内に ${drawn} セルあるが、凡例（${data.grades.length} 段）に当たる値が無い`)
        return
      }

      const sizeChanged = canvas.width !== width || canvas.height !== height
      if (sizeChanged) {
        canvas.width = width
        canvas.height = height
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        giveUp('no-context', '2D コンテキストを取得できない')
        return
      }
      ctx.clearRect(0, 0, width, height)
      ctx.putImageData(new ImageData(rgba, width, height), 0, 0)

      src.setCoordinates([[west, north], [east, north], [east, south], [west, south]])
      // animate:false のままでは中身の変化が GPU へ転送されない（サイズが変わったときだけ
      // MapLibre 側が拾う）。play()→pause() で 1 フレームぶんだけ取り込ませる。
      if (!sizeChanged) {
        src.play()
        src.pause()
      }
      map.setLayoutProperty(LYR, 'visibility', 'visible')

      // 実測（2026-04-20 の M7.5・364,993 セル）で 683x512 が 37ms・1366x1024 が 43ms。
      // 移動が終わるたびに走るので、これを大きく超えるようなら原因を見ること。
      const elapsed = performance.now() - startedAt
      if (elapsed > 150) {
        log.debug(`[map] 推計震度分布図: ${width}x${height} / セル ${count} / ${elapsed.toFixed(0)}ms`)
      }
    }

    const redraw = () => {
      try {
        draw()
      } catch (e) {
        hide()
        anomalyLogRef.current('exception', () => log.error('[map] 推計震度分布図の描画に失敗', e))
      }
    }

    redraw()
    map.on('moveend', redraw)
    return () => {
      map.off('moveend', redraw)
    }
  }, [map, data, visible])

  return null
}
