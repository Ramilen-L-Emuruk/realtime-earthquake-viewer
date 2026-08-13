import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { SiteCoords } from '../../services/kyoshin'
import { addOrderedLayer } from './gl/layerOrder'
import { makeSubThresholdLayer, MAX_SUB_IDX, type SubThresholdLayer } from './gl/subThresholdLayer'
import { log } from '../../utils/logger'

// 強震モニタの震度0以下（index 1〜6）を描画する MapLibre 版（Leaflet の KyoshinSubThreshold 相当）。
// index 0（データ無し）と index 7+（震度1以上・KyoshinPoints が描画）は対象外。
//
// Leaflet 版は「同レベルのドット同士が重なっても濃くならない」非加算合成（SVG の <g opacity> 単位合成）を
// 行う。これを WebGL で厳密に再現するため、レベルごとにオフスクリーン FBO へ不透明描画してから opacity で
// 本描画先へ over 合成するカスタムレイヤーを使う（GL 実装は gl/subThresholdLayer.ts・PoC で実証済み）。
// 毎秒更新は index バッファのカウンティングソート＋triggerRepaint で反映する（feature-state はカスタム
// レイヤーの paint 式に効かないため使わない）。

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
  /**
   * 表示/非表示（モード切替用）。false のときは毎秒の triggerRepaint を止め、
   * バックグラウンドタブでもフルキャンバス再描画が走り続けるのを防ぐ
   * （レベル配列自体は裏で更新し続け、表示に戻った瞬間に1回だけ repaint する）。
   */
  visible: boolean
}

export function KyoshinSubThresholdGL({ sites, indices, iconScale, visible }: Props) {
  const map = useMapGL()
  const layerRef = useRef<SubThresholdLayer | null>(null)
  // restore 直後に「マウント時点の値」ではなく現在の props を復元するため ref で保持する。
  const iconScaleRef = useRef(iconScale)
  const visibleRef = useRef(visible)
  const levelsRef = useRef<Uint8Array | null>(null)
  iconScaleRef.current = iconScale
  visibleRef.current = visible

  // 観測点座標が確定したらカスタムレイヤーを生成して追加する（座標は静的）。
  useEffect(() => {
    if (!map || sites.length === 0) return
    // sites（[lat,lng]）を Mercator 座標の Float32Array に事前変換して 1 本のバッファに詰める。
    const positions = new Float32Array(sites.length * 2)
    sites.forEach(([lat, lng], i) => {
      const m = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat })
      positions[i * 2] = m.x
      positions[i * 2 + 1] = m.y
    })
    // 各 restore で GL リソース参照を再構築するため、レイヤーオブジェクトごと作り直す。
    // 成功後に layerRef を差し替えるため、部分的成功（addOrderedLayer 失敗時に layerRef だけ
    // 新オブジェクトを指す）は起きない。
    const makeAndAdd = (): SubThresholdLayer | null => {
      // 既存レイヤーが残っていれば無駄な再生成を避ける（PsWaveGL の再追加パターンと対称）。
      if (map.getLayer('kyoshin-subthreshold')) return layerRef.current
      const sub = makeSubThresholdLayer(positions, sites.length, iconScaleRef.current)
      try {
        addOrderedLayer(map, sub.layer)
      } catch (err) {
        log.error('[KyoshinSubThresholdGL] custom layer re-add failed', err)
        return null
      }
      // restore 時にマウント時点の値ではなく現在の props/直近 levels を反映する。
      sub.setVisible(visibleRef.current)
      sub.setIconScale(iconScaleRef.current)
      if (levelsRef.current) sub.setLevels(levelsRef.current)
      layerRef.current = sub
      return sub
    }
    let sub = makeAndAdd()
    // MAP-1: WebGL context lost/restored 時に MapLibre は custom layer を復元しない
    // （公式コードが console.warn で明示）ため、restore イベントで手動再追加する。
    //
    // 重要（v6 タイミング設計）: `_contextRestored` は setStyle 直後の同期実行内で
    // `webglcontextrestored` を発火し、この時点で新 Style は _loaded=false のため addLayer は
    // Error("Style is not done loading.") を投げる。style.load を待ってから再追加する。
    // さらに Evented.fire はリスナー単位で try/catch しないため各コンポーネントで try/catch する。
    const doReadd = () => { sub = makeAndAdd() ?? sub }
    const onRestored = () => {
      log.warn('[KyoshinSubThresholdGL] WebGL context restored, re-adding custom layer')
      if (map.isStyleLoaded()) doReadd()
      else map.once('style.load', doReadd)
    }
    map.on('webglcontextrestored', onRestored)
    return () => {
      map.off('webglcontextrestored', onRestored)
      // 登録されていない fn への off は no-op のため、常に呼んで cleanup を対称にする。
      map.off('style.load', doReadd)
      if (sub && map.getLayer(sub.layer.id)) map.removeLayer(sub.layer.id)
      layerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, sites])

  // 毎秒の震度更新（レベル配列を作り setLevels → triggerRepaint で反映）。
  // レベル配列自体は非表示中も更新し続けるが、triggerRepaint（フルキャンバス再描画）は
  // visible のときだけ呼ぶ。他タブを見ている間もバックグラウンドで毎秒フル repaint が
  // 走り続けるコストを避けるため（gl/subThresholdLayer.ts の render() 側は setVisible で
  // 早期リターンする二重ガードにしてあるが、そもそも repaint 自体を起こさない方が安い）。
  useEffect(() => {
    const sub = layerRef.current
    if (!map || !sub) return
    const levels = new Uint8Array(sites.length)
    for (let i = 0; i < sites.length; i++) {
      const idx = indices[i] ?? 0
      levels[i] = idx >= 1 && idx <= MAX_SUB_IDX ? idx : 0
    }
    // restore 直後の再適用用に直近の levels を保持する（MAP-1 対応）。
    levelsRef.current = levels
    sub.setLevels(levels)
    if (visible) map.triggerRepaint()
  }, [map, indices, sites, visible])

  // 表示切替。非表示→表示になった瞬間、裏で更新済みのレベルを1回だけ描画に反映する。
  useEffect(() => {
    const sub = layerRef.current
    if (!map || !sub) return
    sub.setVisible(visible)
    if (visible) map.triggerRepaint()
  }, [map, visible])

  // UI 倍率の変化で半径を更新。
  useEffect(() => {
    const sub = layerRef.current
    if (!map || !sub) return
    sub.setIconScale(iconScale)
    if (visible) map.triggerRepaint()
  }, [map, iconScale, visible])

  return null
}
