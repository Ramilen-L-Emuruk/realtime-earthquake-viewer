import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import { addOrderedLayer } from './gl/layerOrder'
import { ensureKyoshinDetectedIcons } from './gl/kyoshinDetectedIcons'
import { buildDetectedFC } from './gl/kyoshinDetectedFeatures'
import { MISSING_HOLD_OPACITY } from '../../utils/kyoshinMissingHold'

// 揺れ検知点（confirmed＝確定／likely・faint＝未確定）を描画する MapLibre 版（Leaflet の KyoshinDetectedPoints 相当）。
// 丸背景・色・フチ・震度ラベルを Canvas2D で事前ラスタライズした1枚の画像（gl/kyoshinDetectedIcons.ts）を
// icon-image として表示する（地震情報タブの観測点 QuakeIntensityPointsGL と同方式）。
//
// 丸背景を circle レイヤーで、震度ラベルを別の symbol レイヤーで重ねる方式（旧実装）も試したが、
// circle は MapLibre の衝突判定に一切参加しない仕様のため丸同士の重なりを防げず、さらに文字レイヤーは
// 丸レイヤーとは独立に描画されるため「下に完全に隠れた丸の文字まで重ねて表示してしまう」問題があった
// （2026-08-10 の実機検証）。丸ごと icon-image 化することで、重なった場合も「丸＋文字セット」で
// 前面に来た1点だけが完全に読める状態になる（QuakeIntensityPointsGL と同じ考え方）。
// icon-allow-overlap は true のまま（重なりは許容し、位置情報を落とさない）。symbol-sort-key で
// 震度の高い点を前面に描くことで、密集地帯でも「一番強い震度」は必ず正しく読める。
//
// points は検知中で震度0以上の点に限られる（大地震の最盛期でも数百点程度）ので、KyoshinPoints
// のような feature-state 差分は行わず、更新のたびに GeoJSON を作り直して setData で丸ごと差し替える
// （Leaflet 版と同じくフル再描画）。

const SRC = 'kyoshin-detected'
const LYR = 'kyoshin-detected'

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  confirmedPoints: DetectedPoint[]
  /**
   * confirmed 以外（likely / faint）の全イベントのメンバー観測点。リアルタイムタブの検知カードが
   * 集計する集合（weak 以外の全イベント）と一致させるため、confirmed とこの 2 本で全体を覆う。
   */
  unconfirmedPoints: DetectedPoint[]
  iconScale: number
  visible: boolean
}

export function KyoshinDetectedPointsGL({ confirmedPoints, unconfirmedPoints, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  // 直近に setData した内容の署名。points は kyoshinView が indices tick（毎秒）で作り直されるため
  // 検知フットプリントが不変でも参照だけ変わる。同一内容の再 setData（＝geojson-vt 再タイル化）を避ける。
  const lastSigRef = useRef<string | null>(null)

  // source + layer を一度だけ作る。
  useEffect(() => {
    if (!map) return
    ensureKyoshinDetectedIcons(map)
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    // 初回 effect で必ず setData が走るよう null 起点にする（マウント直後の props.iconScale は
    // 1 固定ではないため事前 sig を書いても一致しないケースが出る。空 FC への 1 回の setData は
    // 実質ノーコストなので、null 起点にして初回一致を狙わない方が単純）。
    addOrderedLayer(map, {
      id: LYR,
      type: 'symbol',
      source: SRC,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': ['get', 'iconSizeRatio'],
        // 地震情報タブの観測点（QuakeIntensityPointsGL）と同方式: 重なりは許容し、
        // symbol-sort-key（震度が高いほど大きい値）で震度の強い点を前面に描く。
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'index'],
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        // 欠測ホールド中（直前値を描いている）点は薄く描き、値が生きている点と区別する。
        'icon-opacity': ['case', ['get', 'stale'], MISSING_HOLD_OPACITY, 1],
        // 既定（約300ms）のトランジションを切る。残すと復帰の瞬間に不透明度が補間され、
        // 抑えようとしている明滅が「薄くなりかけて戻る」形で残る。
        'icon-opacity-transition': { duration: 0, delay: 0 },
      },
    })
    addedRef.current = true
    return () => {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
      lastSigRef.current = null
    }
  }, [map])

  // データ／倍率変化のたびに丸ごと差し替える。内容が前回と同一ならスキップして再タイル化を避ける。
  // MAP-2: 非表示中は setData を止める（visible=false 中は lastSigRef を維持し、表示に戻った瞬間
  // に visible を含む依存変化で差分反映される）。
  //
  // 毎秒の点数チェックを早期化: kyoshinView は indices tick（≈1Hz）で points 参照を作り直すため
  // 検知フットプリント不変でも参照が変わる。JSON.stringify(fc) は毎秒 O(N) 級のコストで走るため、
  // まず軽量 signature（点数 + iconScale + 各点の lat/lng/index の join）で比較して同一なら
  // buildFC / JSON.stringify を丸ごとスキップする。フットプリントが変わったときのみ重い比較を行う。
  useEffect(() => {
    if (!map || !addedRef.current || !visible) return
    // 軽量 signature: 点数と iconScale と各点の識別情報。JSON より 10x 以上高速。
    // 欠測ホールドの保持フラグ（stale）も署名に含める。保持中は index が直前値のまま変わらないため、
    // stale を外すと「値が生きている → 保持中」の遷移で署名が一致し、半透明が反映されないまま残る。
    const lightSig = `${confirmedPoints.length}|${unconfirmedPoints.length}|${iconScale}|`
      + confirmedPoints.map((p) => `${p.lat},${p.lng},${p.index},${p.stale ? 1 : 0}`).join(';')
      + '#'
      + unconfirmedPoints.map((p) => `${p.lat},${p.lng},${p.index},${p.stale ? 1 : 0}`).join(';')
    if (lightSig === lastSigRef.current) return
    lastSigRef.current = lightSig
    const fc = buildDetectedFC(confirmedPoints, unconfirmedPoints, iconScale)
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(fc)
  }, [map, confirmedPoints, unconfirmedPoints, iconScale, visible])

  // 表示切替（モード切替用）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
