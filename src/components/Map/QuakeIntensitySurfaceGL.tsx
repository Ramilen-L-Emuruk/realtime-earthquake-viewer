import { useEffect, useRef, useState } from 'react'
import type { CanvasSource } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { getIntensityColor } from '../../utils/intensity'
import type { IntensityMarker } from '../../hooks/useQuakeLayerData'
import { addOrderedLayer } from './gl/layerOrder'
import { isFinitePair } from './gl/labelOverlap'
import { loadPrefectures, type Prefectures } from '../../utils/prefectures'
import {
  buildIsoseismalGrid,
  bandScaleOf,
  mercatorY,
  type IsoseismalBounds,
  type IsoseismalPoint,
} from '../../utils/isoseismal'
import { log, createLogThrottle } from '../../utils/logger'

// 観測点ごとの震度を面として敷く（地震モードで観測点表示になっているズーム帯）。
// 点の集合では読み取りにくい「揺れの広がりの形」を背景として見せ、観測点のバッジは
// その上に残す（QuakeIntensityPointsGL がこのレイヤーより前面）。
//
// 区域塗り（QuakeRegionFillGL）とは排他。あちらは気象庁が発表した区域ごとの最大震度そのもので、
// こちらは観測点からの推定。**同時に出すと、どちらが発表値でどちらが推定かが混ざる**ため、
// 表示条件を「区域集約でないとき」に揃えて重ならないようにしている（JapanMapGL 側の visible）。
//
// 描き方の要点:
// - **陸だけに切る。** 観測点は陸にしかないので、海に色を置けば全部が作り話になる。
//   県境ポリゴン（prefectures.json）でクリップする。切った結果、震源が海にあることも読める
// - **canvas を貼る**（MapLibre の canvas source）。格子を GeoJSON のポリゴンで出すと
//   数万フィーチャになり、まとめようとすると「高震度の中にある低震度の島」（周りと食い違う
//   単独の観測点でできる）を潰すことになる。canvas ならその島がそのまま残る
// - **canvas の行は Mercator 空間で等間隔。** canvas source は 4 隅を結んで Mercator 空間へ
//   線形に貼るため、緯度で等分すると南北にずれる（isoseismal.ts の冒頭 4）
//
// 更新は地図の移動が終わったときと電文が変わったとき。移動中は貼ったままにする（拡大縮小は
// テクスチャの引き伸ばしで追随するので、指を離すまで作り直さなくても破綻しない）。
//
// **仕様書は docs/spec/map-rendering-spec.md §17（描き方）と quake-spec.md §9（出す条件）。**
// ここの方針を変えるときは両方を追従させること。
//
// **描けない理由が生じたら必ず面を消すこと。** 途中で抜けると前回の視野の絵が貼りついたまま残り、
// 「いまの視野とは違う場所の分布」を事実のように見せてしまう。出せないなら消すのが、外挿しない
// という方針と揃う（isoseismal.ts の冒頭 3）。

const SRC = 'quake-intensity-surface'
const LYR = 'quake-intensity-surface'

/** 面の濃さ。観測点バッジと地形が透けて見える程度に留める。 */
const SURFACE_OPACITY = 0.62

/** canvas の短辺の目標。これを基準に視野のアスペクト比で長辺を決める。 */
const TARGET_SHORT_PX = 512

/** canvas の長辺の上限（極端に細長い視野で青天井にしないため）。 */
const MAX_LONG_PX = 1536

/**
 * 格子 1 セルが表す最小の距離（km）。寄るほど canvas を細かくしても、元の観測点は
 * 10〜20km 間隔のままで情報は増えない。計算量だけが増える（影響円のセル数はセル辺の 2 乗で
 * 効く）ので下限で止める。
 *
 * 副作用として、深く寄ると陸クリップの縁も canvas の解像度に縛られる（視野 13km で canvas は
 * 43px まで落ちる）。海岸線がわずかに滲むが、その帯では面はほぼ単色で読み取れる情報が無く、
 * 縁の精度を上げても得るものが無いため下限を優先している。
 */
const MIN_CELL_KM = 0.3

/** 視野の外へ少しはみ出させる割合。移動のたびに縁が見えるのを防ぐ。 */
const VIEW_PADDING = 0.08

const KM_PER_DEG = 111.19

/**
 * 異常の記録を間引く間隔。この層の異常はどれも `moveend` のたびに再発しうるので、
 * 素通しにするとログが埋まる（logger.ts の `createLogThrottle` の考え方に従う）。
 */
const ANOMALY_LOG_INTERVAL_MS = 30_000

/** 異常の種別。**間引きは種別ごとに独立させる**（下の `createAnomalyLog` を参照）。 */
type AnomalyKind =
  | 'missing-objects'
  | 'degenerate-view'
  | 'no-context'
  | 'no-usable-points'
  | 'broken-points'
  | 'exception'

/**
 * 種別ごとに独立したスロットルを持つ記録係を作る。
 *
 * **1 個を共有してはいけない。** `createLogThrottle` はメッセージを区別せず経過時間だけを見るため、
 * 共有すると最初に鳴った理由が残りを間引き間隔いっぱい隠す。ここは理由が 6 種あり、しかもどれも
 * 同じ `moveend` の周期で再発しうるので、共有すると「観測点の座標が壊れている」が鳴っている間
 * 「2D コンテキストが取れない」が一度も出ない、という取りこぼしが起きる（`services/kyoshin.ts` の
 * `throttledMissLog` が同じ理由で理由ごとに分けている）。
 */
function createAnomalyLog(): (kind: AnomalyKind, emit: () => void) => void {
  const throttles = new Map<AnomalyKind, (emit: () => void) => void>()
  return (kind, emit) => {
    let throttle = throttles.get(kind)
    if (!throttle) {
      throttle = createLogThrottle(ANOMALY_LOG_INTERVAL_MS)
      throttles.set(kind, throttle)
    }
    throttle(emit)
  }
}

interface Props {
  /** 観測点の震度点（区域の代表点を含まないもの＝useQuakeLayerData の stationMarkers）。 */
  markers: IntensityMarker[]
  visible: boolean
}

/** 面を貼る初期座標。データが無い間は使われないが、source の生成には座標が要る。 */
const INITIAL_COORDINATES: [[number, number], [number, number], [number, number], [number, number]] = [
  [122, 46],
  [154, 46],
  [154, 24],
  [122, 24],
]

/** 色の 16 進表記を RGB へ。`getIntensityColor` は `#rrggbb` を返す。 */
function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** 階級値 → RGB。呼び出しごとに解析しないよう作り置きする。 */
const BAND_RGB = new Map<number, [number, number, number]>()
function bandRgb(scale: number): [number, number, number] {
  const hit = BAND_RGB.get(scale)
  if (hit) return hit
  const rgb = hexToRgb(getIntensityColor(scale))
  BAND_RGB.set(scale, rgb)
  return rgb
}

/** リングの外接矩形。県境データは不変なので一度だけ計算して持ち回す。 */
interface RingBox {
  ring: [number, number][] // [lat, lng]
  north: number
  south: number
  west: number
  east: number
}

/**
 * 県境ポリゴンを外接矩形付きに畳む。**壊れた座標はここで落とす。**
 *
 * Canvas2D の `moveTo`/`lineTo` は非有限値を渡しても例外を投げず黙って無視するため、
 * 素通しにすると「クリップの形だけが静かに歪む」（海へ色が漏れる／陸が切り取られる）という
 * 最も気づきにくい壊れ方をする。同じ生成データを使う地名ラベル側が `isFinitePair` で
 * 同じ穴を塞いでいるので、判定もそちらと共有する（gl/labelOverlap.ts）。
 */
function buildRingBoxes(prefectures: Prefectures): { boxes: RingBox[]; dropped: number } {
  const boxes: RingBox[] = []
  let dropped = 0
  for (const shape of Object.values(prefectures)) {
    for (const ring of shape.rings) {
      if (!Array.isArray(ring) || ring.length < 3) {
        dropped++
        continue
      }
      let north = -90
      let south = 90
      let west = 180
      let east = -180
      let broken = false
      for (const p of ring) {
        if (!isFinitePair(p as readonly [number, number])) {
          broken = true
          break
        }
        const [lat, lng] = p
        if (lat > north) north = lat
        if (lat < south) south = lat
        if (lng < west) west = lng
        if (lng > east) east = lng
      }
      if (broken) {
        dropped++
        continue
      }
      boxes.push({ ring: ring as [number, number][], north, south, west, east })
    }
  }
  return { boxes, dropped }
}

export function QuakeIntensitySurfaceGL({ markers, visible }: Props) {
  const map = useMapGL()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 補間結果を一旦置く canvas。陸クリップは ImageData に効かないため、ここへ置いてから
  // クリップ付きで転写する。moveend のたびに作り直さず使い回す。
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const addedRef = useRef(false)
  const [prefectures, setPrefectures] = useState<Prefectures | null>(null)
  const ringBoxesRef = useRef<RingBox[] | null>(null)
  const anomalyLogRef = useRef(createAnomalyLog())

  // 県境は陸クリップに使う。BaseMapGL が既に読んでいればキャッシュが返る（二重取得にならない）。
  // 取得の失敗は fetchJsonWithTimeout が地図の「データの一部を取得できませんでした」へ計上する。
  useEffect(() => {
    let alive = true
    loadPrefectures()
      .then((p) => {
        if (alive) setPrefectures(p)
      })
      .catch((e) => {
        // 取れなければ面は出さない。海へ広がった面を出すより、出さないほうが誤解を生まない。
        log.warn('[map] prefectures 取得失敗（震度の面を表示しない）', e)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!prefectures) return
    const { boxes, dropped } = buildRingBoxes(prefectures)
    ringBoxesRef.current = boxes
    if (dropped > 0) {
      log.warn(`[map] 震度の面: 県境ポリゴンのうち ${dropped} リングを座標の破損で除外した`)
    }
  }, [prefectures])

  // source / layer の作成。canvas は DOM へ挿さず、要素の参照だけ MapLibre へ渡す。
  useEffect(() => {
    if (!map) return
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    canvasRef.current = canvas
    offscreenRef.current = document.createElement('canvas')

    map.addSource(SRC, {
      type: 'canvas',
      canvas,
      coordinates: INITIAL_COORDINATES,
      // 中身が変わるのは移動と電文の受信のときだけ。毎フレーム GPU へ転送させない
      // （更新時は play()→pause() で 1 回だけ取り込ませる）。
      animate: false,
    })
    addOrderedLayer(map, {
      id: LYR,
      type: 'raster',
      source: SRC,
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': SURFACE_OPACITY,
        // MapLibre は paint プロパティに既定 300ms のトランジションを掛ける。移動のたびに
        // 面が薄れて戻るのを防ぐため 0 にする。
        'raster-opacity-transition': { duration: 0, delay: 0 },
        'raster-fade-duration': 0,
        // 格子は粗い（1 セル数百 m〜1km）。線形補間で引き伸ばしたほうが、階段が出るより素直に見える。
        'raster-resampling': 'linear',
      },
    })
    addedRef.current = true
    return () => {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
      canvasRef.current = null
      offscreenRef.current = null
    }
  }, [map])

  // 面の描き直し。視野・観測点・県境のいずれかが変わったら走る。
  useEffect(() => {
    if (!map || !addedRef.current) return

    /** 面を消す。描けない理由が生じたときは必ずここを通す（古い絵を残さない）。 */
    const hide = () => {
      if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', 'none')
    }

    /** 想定外の状態で描画を諦めたことを記録する。無音で消えると原因を追う手掛かりが残らない。 */
    const giveUp = (kind: AnomalyKind, reason: string) => {
      hide()
      anomalyLogRef.current(kind, () => log.warn(`[map] 震度の面を描けなかった: ${reason}`))
    }

    const draw = () => {
      const canvas = canvasRef.current
      const offscreen = offscreenRef.current
      const src = map.getSource(SRC) as CanvasSource | undefined
      if (!canvas || !offscreen || !src || !map.getLayer(LYR)) {
        // addedRef が true の間は揃っているはずなので、ここへ来ること自体が異常。
        giveUp('missing-objects', 'canvas / source / layer が揃っていない')
        return
      }

      // 出さない条件のうち、これらは正常な状態（区域集約中・電文が無い・県境の読み込み待ち）。
      const boxes = ringBoxesRef.current
      if (!visible || markers.length === 0 || !boxes || boxes.length === 0) {
        hide()
        return
      }

      // 座標が壊れた点は補間へ入れない（`buildIsoseismalGrid` の二分探索は NaN を渡されると
      // 走査範囲が空に潰れ、その点だけが黙って抜ける。抜けたことに気づけるよう入口で落とす）。
      const points: IsoseismalPoint[] = []
      let brokenPoints = 0
      for (const m of markers) {
        if (!isFinitePair(m.position)) {
          brokenPoints++
          continue
        }
        points.push({ lat: m.position[0], lng: m.position[1], scale: m.scale })
      }
      if (brokenPoints > 0) {
        anomalyLogRef.current('broken-points', () =>
          log.warn(`[map] 震度の面: 観測点 ${brokenPoints} 件を座標の破損で除外した`),
        )
      }
      if (points.length === 0) {
        hide()
        return
      }

      const view = map.getBounds()
      const rawWest = view.getWest()
      const rawEast = view.getEast()
      const rawNorth = Math.min(85, view.getNorth())
      const rawSouth = Math.max(-85, view.getSouth())
      const padLng = (rawEast - rawWest) * VIEW_PADDING
      const padLat = (rawNorth - rawSouth) * VIEW_PADDING
      const bounds: IsoseismalBounds = {
        west: rawWest - padLng,
        east: rawEast + padLng,
        north: Math.min(85, rawNorth + padLat),
        south: Math.max(-85, rawSouth - padLat),
      }
      // 比較は NaN に対しても偽になるので、値が壊れている場合もここで捕まる。
      if (!(bounds.east > bounds.west) || !(bounds.north > bounds.south)) {
        giveUp('degenerate-view', `視野が退化している (${rawWest},${rawSouth})-(${rawEast},${rawNorth})`)
        return
      }

      const midLat = (bounds.north + bounds.south) / 2
      const widthKm = (bounds.east - bounds.west) * KM_PER_DEG * Math.cos((midLat * Math.PI) / 180)
      const heightKm = (bounds.north - bounds.south) * KM_PER_DEG
      const yTop = mercatorY(bounds.north)
      const yBottom = mercatorY(bounds.south)
      const mercWidth = (bounds.east - bounds.west) / 360
      const mercHeight = yBottom - yTop
      if (!(widthKm > 0) || !(heightKm > 0) || !(mercHeight > 0)) {
        giveUp(
          'degenerate-view',
          `視野の寸法が求まらない (${widthKm}km x ${heightKm}km / merc ${mercHeight})`,
        )
        return
      }

      // canvas のアスペクトは Mercator 空間で取る（貼り付け先がその空間のため）。
      const aspect = mercWidth / mercHeight
      let shortPx = TARGET_SHORT_PX
      const shortKm = Math.min(widthKm, heightKm)
      if (shortKm / shortPx < MIN_CELL_KM) shortPx = Math.max(16, Math.round(shortKm / MIN_CELL_KM))
      let width = aspect >= 1 ? Math.round(shortPx * aspect) : shortPx
      let height = aspect >= 1 ? shortPx : Math.round(shortPx / aspect)
      const longPx = Math.max(width, height)
      if (longPx > MAX_LONG_PX) {
        const k = MAX_LONG_PX / longPx
        width = Math.max(16, Math.round(width * k))
        height = Math.max(16, Math.round(height * k))
      }

      const startedAt = performance.now()
      const grid = buildIsoseismalGrid(points, bounds, width, height)
      if (grid.usedPoints === 0) {
        // 点はあるのに 1 つも使えなかった＝階級表から漏れている。全面が透明になるので、
        // 黙って「表示中」を名乗らせない（震度0 しか無い電文でもここへ来る）。
        giveUp('no-usable-points', `観測点 ${points.length} 件がいずれも震度階級表に無い値だった`)
        return
      }

      // 帯の色を ImageData へ。値を持たないセルは透明のまま残す。
      const rgba = new Uint8ClampedArray(width * height * 4)
      for (let k = 0; k < grid.values.length; k++) {
        const v = grid.values[k]
        if (Number.isNaN(v)) continue
        const scale = bandScaleOf(v)
        if (scale === null) continue
        const [r, g, b] = bandRgb(scale)
        const o = k * 4
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = b
        rgba[o + 3] = 255
      }

      // 2D コンテキストは**表側を消す前に**両方確保する。片方だけ取ってから失敗すると、
      // 直前まで出ていた面を自分で消したまま何も描かずに終わる。
      const sizeChanged = canvas.width !== width || canvas.height !== height
      if (sizeChanged) {
        canvas.width = width
        canvas.height = height
      }
      if (offscreen.width !== width || offscreen.height !== height) {
        offscreen.width = width
        offscreen.height = height
      }
      const ctx = canvas.getContext('2d')
      const octx = offscreen.getContext('2d')
      if (!ctx || !octx) {
        giveUp('no-context', '2D コンテキストを取得できない')
        return
      }

      ctx.clearRect(0, 0, width, height)
      octx.clearRect(0, 0, width, height)
      octx.putImageData(new ImageData(rgba, width, height), 0, 0)

      const xOf = (lng: number) => ((lng - bounds.west) / (bounds.east - bounds.west)) * width
      const yOf = (lat: number) => ((mercatorY(lat) - yTop) / mercHeight) * height

      const landPath = new Path2D()
      let drawnRings = 0
      for (const box of boxes) {
        if (box.south > bounds.north || box.north < bounds.south) continue
        if (box.west > bounds.east || box.east < bounds.west) continue
        const ring = box.ring
        landPath.moveTo(xOf(ring[0][1]), yOf(ring[0][0]))
        for (let i = 1; i < ring.length; i++) landPath.lineTo(xOf(ring[i][1]), yOf(ring[i][0]))
        landPath.closePath()
        drawnRings++
      }
      if (drawnRings === 0) {
        // 視野が完全に海の上。面は出さない（外挿しないという方針の当然の帰結で、異常ではない）。
        hide()
        return
      }

      // **塗り分けの規則は even-odd。** 県境データは外周と内包リング（湖沼・飛び地の内側）を
      // 区別せず 1 つの配列へ並べており、巻き順が正しい保証がない。既定の nonzero だと巻き順が
      // 揃った瞬間に穴を抜けなくなる。同じデータを判定する `pointInRings`（utils/geo.ts）も
      // 巻き順に依存しない実装を選んでいるので、そちらへ合わせる。
      ctx.save()
      ctx.clip(landPath, 'evenodd')
      ctx.drawImage(offscreen, 0, 0)
      ctx.restore()

      src.setCoordinates([
        [bounds.west, bounds.north],
        [bounds.east, bounds.north],
        [bounds.east, bounds.south],
        [bounds.west, bounds.south],
      ])
      // canvas の中身は animate:false のままでは GPU へ再転送されない（サイズが変わったときだけ
      // MapLibre 側が拾う）。play()→pause() で 1 フレームぶんだけ取り込ませる。
      if (!sizeChanged) {
        src.play()
        src.pause()
      }
      map.setLayoutProperty(LYR, 'visibility', 'visible')

      // 実測（能登本震・観測点 2782 件・1027x1000 のペイン）で最も重かったのは寄り上限のすぐ内側で
      // 530x512・89ms。そこから寄るほど canvas が小さくなり 2ms まで下がる。移動が終わるたびに
      // 走るので、これを大きく超えるようなら原因を見ること。
      const elapsed = performance.now() - startedAt
      if (elapsed > 150) {
        log.debug(`[map] 震度の面: ${width}x${height} / 観測点 ${points.length} / ${elapsed.toFixed(0)}ms`)
      }
    }

    // 例外はここで受ける。`moveend` のハンドラから投げると MapLibre の `error` イベントには
    // 乗らず（あれは source のエラー専用）、このアプリのログ基盤を素通りして消える。
    const redraw = () => {
      try {
        draw()
      } catch (e) {
        hide()
        anomalyLogRef.current('exception', () => log.error('[map] 震度の面の描画に失敗', e))
      }
    }

    redraw()
    map.on('moveend', redraw)
    return () => {
      map.off('moveend', redraw)
    }
  }, [map, markers, visible, prefectures])

  return null
}
