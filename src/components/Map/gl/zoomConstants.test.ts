import { describe, it, expect } from 'vitest'
import { fitMaxZoomForPane, REFERENCE_FIT_MAX_ZOOM, EEW_ZOOM_SNAP, snapZoomDown } from './camera'
import {
  desiredTileZoom,
  GEBCO_HIRES_MIN_ZOOM,
  GEBCO_OVERVIEW_MAX_ZOOM,
  GEBCO_SOURCE_MAX_ZOOM,
  GEBCO_TILE_SIZE,
  MAX_TILE_ZOOM,
} from '../../../utils/gebcoPrefetch'
import { detailMinZoomForPane, labelMinZoomForPane } from './zoomLevels'
import { ABSOLUTE_MAX_ZOOM, clampMinZoom } from './viewSpan'
import { REGION_MAX_ZOOM } from '../LabelsGL'
import { JAPAN_BOUNDS } from './bounds'

// 複数モジュールに散らばるズーム閾値の「相互関係」を固定する回帰テスト。
//
// 閾値の一部は視野の実距離（km）で持ち、地図ペインの寸法から実行時にズームへ換算する
// （gl/viewSpan.ts）。そのため定数どうしの比較では関係を固定できない。代表的なペイン寸法を
// 並べ、そのすべてで関係が成り立つことを確認する。
//
// 代表ペインには縦長・横長の両方を入れる。閾値の換算は短辺で行う一方、日本全体フィットの
// 着地ズームは縦横それぞれの収まりで決まるため、短辺だけを変えても横向きの端末を代表できない。
//
// テスト対象がモジュール横断のため、個々のモジュールの単体テスト（camera.test.ts 等）ではなく
// 専用ファイルに置く。

interface Pane {
  name: string
  width: number
  height: number
}

// 代表的な地図ペインの寸法（CSS px）。厳密な実測値ではなく「この幅の端末がある」ことを示す代表値。
// 最後の 1 つは想定使用範囲の外側（4K を 50% 表示にした程度で到達する）。閾値が可変になった以上、
// 上限側の破綻は大きなペインでしか現れないため、代表値に含めておく。
const PANES: Pane[] = [
  { name: 'スマホ縦（上下分割）', width: 375, height: 420 },
  { name: 'スマホ横', width: 640, height: 360 },
  { name: 'デスクトップ（左右分割）', width: 900, height: 800 },
  { name: '2K フルスクリーン', width: 1400, height: 1200 },
  { name: '超大画面（4K を 50% 表示）', width: 5760, height: 4320 },
]

const shortSideOf = (pane: Pane) => Math.min(pane.width, pane.height)

// fitJapan（`camera.ts`）の padding。日本全体フィットの着地ズームの算出に必要。
const FIT_JAPAN_PADDING_PX = 20

/**
 * `fitJapan` の着地ズーム。JAPAN_BOUNDS が padding を除いたペインへ収まる最大ズーム。
 *
 * 緯度方向は Web Mercator で引き伸ばされるため、km へ直して比べると北の端で誤差が出る。
 * ここは「日本全体表示で細線とラベルが必ず出る」ことを確かめるための基準値なので、
 * MapLibre と同じ正規化 Mercator 座標で厳密に解く。
 */
function fitJapanZoom(pane: Pane): number {
  const [[west, south], [east, north]] = JAPAN_BOUNDS
  const mercY = (lat: number) => {
    const rad = (lat * Math.PI) / 180
    return 0.5 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / (2 * Math.PI)
  }
  // ズーム 0 での世界の大きさ（px）は MapLibre のタイル基準と同じ 512。
  const worldPx = 512
  const spanX = ((east - west) / 360) * worldPx
  const spanY = (mercY(south) - mercY(north)) * worldPx
  const usableW = pane.width - FIT_JAPAN_PADDING_PX * 2
  const usableH = pane.height - FIT_JAPAN_PADDING_PX * 2
  return Math.min(Math.log2(usableW / spanX), Math.log2(usableH / spanY))
}

describe('ズーム閾値の相互関係', () => {
  // 区域集約の閾値（`useQuakeLayerData` の aggregateMaxZoom）は、カメラの寄り上限と同値であることが
  // 「自動フィット着地後は必ず区域集約＝震度塗りになる」前提を支えている。両者は同じ関数
  // （`fitMaxZoom`）を共有することで揃えており、値としては存在しないためここでは比較できない。
  // 渡し先は JapanMapGL（`aggregateMaxZoom` state）。独自の定数へ戻すと大きな画面で静かに崩れる。

  it.each(PANES)('$name: 寄り上限が 0.5 刻みに乗る（着地が 1 段損しない）', (pane) => {
    // 上限が刻みから外れていると、上限にクランプされた着地を snapZoomDown がさらに 1 段引き下げる
    // （6.95 → 6.5 ＝ 意図より 36% 広い画）。刻みに乗っていれば切り下げは恒等になる。
    const cap = fitMaxZoomForPane(shortSideOf(pane))
    expect(snapZoomDown(cap, EEW_ZOOM_SNAP)).toBeCloseTo(cap, 6)
  })

  it.each(PANES)('$name: 寄り上限が絶対上限を超えない', (pane) => {
    expect(fitMaxZoomForPane(shortSideOf(pane))).toBeLessThanOrEqual(ABSOLUTE_MAX_ZOOM)
  })

  it('大画面では絶対上限のクランプが効く（際限なく寄らない）', () => {
    // 4K の上下分割相当（短辺 2000px）。視野基準の値だけなら 8.5 まで寄ってしまう。
    expect(fitMaxZoomForPane(2000)).toBe(ABSOLUTE_MAX_ZOOM)
  })

  it.each(PANES)('$name: 細線の下限が寄り上限より浅い（寄った画で県境・活断層が消えない）', (pane) => {
    // 下限が寄り上限を超えると、自動フィットの着地点でも県境・一次細分区域境界・活断層が
    // 一切出なくなる（地震カード選択後の地図が陸地塗りだけになる）。
    expect(detailMinZoomForPane(shortSideOf(pane))).toBeLessThan(fitMaxZoomForPane(shortSideOf(pane)))
  })

  it.each(PANES)('$name: 日本全体表示で細線が出る', (pane) => {
    expect(detailMinZoomForPane(shortSideOf(pane))).toBeLessThan(fitJapanZoom(pane))
  })

  it.each(PANES)('$name: 日本全体表示で地方名ラベルが出る', (pane) => {
    // ズーム値で下限を持っていた間、狭いペインではここが破れていた（着地 3.8 に対し閾値 4.5 で
    // 地名が一切出ない）。視野の実距離で持つことでどの寸法でも成り立つ。
    expect(labelMinZoomForPane(shortSideOf(pane))).toBeLessThan(fitJapanZoom(pane))
  })

  it.each(PANES)('$name: 地方名ラベルの下限が細線の下限より深い（線の無い画に地名だけ出ない）', (pane) => {
    expect(labelMinZoomForPane(shortSideOf(pane))).toBeGreaterThan(detailMinZoomForPane(shortSideOf(pane)))
  })

  it.each(PANES)('$name: 地方名ラベルの帯が潰れない', (pane) => {
    // 地方名の帯は「可変の下限 〜 固定の上限（REGION_MAX_ZOOM）」で、ペインが大きいほど下限が深く
    // なる。追い越すと MapLibre は minzoom > maxzoom をそのまま受け取り、どのズームでも描かれない
    // レイヤーになる（例外もログも出ない）。実際にレイヤーへ渡す値でこれを固定する。
    expect(clampMinZoom(labelMinZoomForPane(shortSideOf(pane)), REGION_MAX_ZOOM)).toBeLessThan(REGION_MAX_ZOOM)
  })

  it('大きなペインではラベル下限のクランプが実際に効いている（ガードが飾りでないことの確認）', () => {
    // クランプを外すと帯が潰れる領域が現に存在することを示す。ここが成り立たなくなったら
    // （LABEL_MAX_SPAN_KM や REGION_MAX_ZOOM を動かした結果）上のテストは通っても意味を失う。
    const shortSide = 4320
    expect(labelMinZoomForPane(shortSide)).toBeGreaterThan(REGION_MAX_ZOOM)
    expect(clampMinZoom(labelMinZoomForPane(shortSide), REGION_MAX_ZOOM)).toBeLessThan(REGION_MAX_ZOOM)
  })

  it('GEBCO 先読みの最大タイル z がマップズーム上限より深い（タイル座標系との混同検出）', () => {
    // 512px より小さいタイルのソースは、マップズーム z のときタイル z+1 を要求する。
    // マップズーム基準の値をそのままタイル z として使うと、自動フィット上限で実際に使うタイルが
    // 先読みから漏れる。先読みが基準にするのは基準ペインでの寄り上限（大画面の分は追わない。
    // 理由は gebcoPrefetch.ts の MAX_TILE_ZOOM の注記）。
    expect(GEBCO_TILE_SIZE).toBeLessThan(512)
    expect(MAX_TILE_ZOOM).toBeGreaterThan(REFERENCE_FIT_MAX_ZOOM)
  })

  it('GEBCO 先読みの最大タイル z がタイルセットの実在最大 z を超えない', () => {
    // 超えると存在しないタイルを叩くが、先読みは失敗を握りつぶすため無症状で空回りする。
    expect(MAX_TILE_ZOOM).toBeLessThanOrEqual(GEBCO_SOURCE_MAX_ZOOM)
  })

  it('海底地形の高解像度層の下限ズームが、下地層と同一タイルを要求する帯のちょうど外側にある', () => {
    // 下限ズームでは、上層が下地層（maxzoom でクランプされる）より深いタイルを要求する。ここが崩れると
    // 2 層が同じタイルを個別に取得するだけの帯が残る（実測でその帯の存在を確認済み）。
    expect(desiredTileZoom(GEBCO_HIRES_MIN_ZOOM)).toBeGreaterThan(GEBCO_OVERVIEW_MAX_ZOOM)
    // わずかに下のズームでは重複帯の内側にいる（＝そこで上層を描かない判断が正しい）。下限を必要以上に
    // 高くすると、二重取得は起きないままここが破れる。境界を両側から締めることで「寄っても高解像度が
    // 出ない」劣化を検出する。
    expect(desiredTileZoom(GEBCO_HIRES_MIN_ZOOM - 0.01)).toBeLessThanOrEqual(GEBCO_OVERVIEW_MAX_ZOOM)
  })

  it.each(PANES)('$name: 自動フィットの寄り上限では必ず高解像度の海底地形が出る', (pane) => {
    expect(GEBCO_HIRES_MIN_ZOOM).toBeLessThan(fitMaxZoomForPane(shortSideOf(pane)))
  })
})
