import { useEffect, useRef } from 'react'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import { makeEstimatedIntensityLayer, type EstimatedIntensityLayer } from './gl/estimatedIntensityLayer'
import { clearRenderFailure, clearRenderFailuresFor, reportRenderFailure } from '../../utils/renderHealth'
import { log } from '../../utils/logger'
import type { JMAEstimatedIntensity } from '../../types/earthquake'

// 気象庁の推計震度分布図（IXAC41）を面として敷く。
//
// **自前の面（QuakeIntensitySurfaceGL）の公式版。** あちらは観測点の値を逆距離加重で
// 補間しただけだが、こちらは地盤増幅度と緊急地震速報の震度予測技術まで織り込んだ気象庁の推計。
// **同時には出さない**（どちらを見ているのか混ざる）。切り替えは JapanMapGL 側の `visible`。
//
// ここは MapLibre への出し入れだけを持つ。**描き方は 2 つのファイルに分かれている。**
//
// - `gl/estimatedIntensityRaster.ts` — 電文を GPU へ渡す形（値のテクスチャと凡例）へ落とす
// - `gl/estimatedIntensityLayer.ts` — カスタムレイヤー本体（シェーダーと GL の状態）
//
// **仕様書は docs/spec/map-rendering-spec.md §19（描き方）と quake-spec.md §9（出す条件）。**

const LYR = 'quake-estimated-intensity'
const LABEL = '推計震度分布図'

interface Props {
  data: JMAEstimatedIntensity | null
  visible: boolean
}

export function QuakeEstimatedIntensityGL({ data, visible }: Props) {
  const map = useMapGL()
  const layerRef = useRef<EstimatedIntensityLayer | null>(null)
  // 文脈の復元直後に「マウント時点の値」ではなく現在の props を戻すため ref で持つ。
  const dataRef = useRef(data)
  const visibleRef = useRef(visible)
  dataRef.current = data
  visibleRef.current = visible

  useEffect(() => {
    if (!map) return

    // 文脈を作り直すと GL リソースの参照が無効になるため、レイヤーオブジェクトごと作り直す。
    const makeAndAdd = (): EstimatedIntensityLayer | null => {
      // 既存レイヤーが残っていれば無駄な再生成を避ける。
      if (map.getLayer(LYR)) return layerRef.current
      const created = makeEstimatedIntensityLayer()
      try {
        addOrderedLayer(map, created.layer)
      } catch (err) {
        // **載せられなければ `render()` は一度も呼ばれない。** レイヤー側の検出には永久に
        // 到達しないので、ここで画面へ出す（docs/spec/map-rendering-spec.md §16）。
        log.error('[QuakeEstimatedIntensityGL] custom layer add failed', err)
        reportRenderFailure(LYR, LABEL, 'draw')
        return null
      }
      // **載せられたら前回の失敗を引きずらない。** 文脈の復元で載せ直せた場合、
      // レイヤーは作り直されて「報告済み」の覚えも初期化されるため、上で立てた記録を
      // 取り下げる機会がここ以外に無い（描けているのにバナーが居座る）。
      // **まとめて消す版は使わない**——`gl/guardRender.ts` の未解決の記録を巻き込む。
      clearRenderFailure(LYR, 'draw')
      // 復元時はマウント時点ではなく現在の props を反映する。
      created.setData(dataRef.current)
      created.setVisible(visibleRef.current)
      layerRef.current = created
      return created
    }

    makeAndAdd()

    // MapLibre は WebGL の文脈が復元されても custom レイヤーを戻さないため、自分で再追加する。
    // `webglcontextrestored` の時点では新しい Style がまだ読み込み中で `addLayer` が投げるので、
    // `style.load` を待つ（`KyoshinSubThresholdGL` と同じ手当て）。
    const doReadd = () => {
      makeAndAdd()
      map.triggerRepaint()
    }
    const onRestored = () => {
      log.warn('[QuakeEstimatedIntensityGL] WebGL context restored, re-adding custom layer')
      if (map.isStyleLoaded()) doReadd()
      else map.once('style.load', doReadd)
    }
    map.on('webglcontextrestored', onRestored)

    return () => {
      map.off('webglcontextrestored', onRestored)
      // 登録されていない関数への off は何もしないので、対称にするため常に呼ぶ。
      map.off('style.load', doReadd)
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      // **追加に失敗したまま外れる経路がある。** そのとき `onRemove` は呼ばれないので、
      // 上で立てた報告を消すのはここしかない（レイヤーが載っていれば `onRemove` が
      // 先に消しており、この呼び出しは何もしない）。放っておくと、二度と出てこない
      // 描画物の名前がバナーに居座る（`utils/renderHealth.ts`）。
      clearRenderFailuresFor(LYR)
      layerRef.current = null
    }
  }, [map])

  // 分布の差し替え。焼き直しは次の描画で走るので、`triggerRepaint` で 1 フレーム要求する。
  useEffect(() => {
    const l = layerRef.current
    if (!map || !l) return
    l.setData(data)
    if (visible) map.triggerRepaint()
  }, [map, data, visible])

  useEffect(() => {
    const l = layerRef.current
    if (!map || !l) return
    l.setVisible(visible)
    map.triggerRepaint()
  }, [map, visible])

  return null
}
