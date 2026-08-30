import { describe, it, expect } from 'vitest'
import { ringBounds } from './psWaveRing'
import { fitMaxZoomForPane, REFERENCE_FIT_MAX_ZOOM, EEW_ZOOM_SNAP, snapZoomDown, snapZoomNearest } from './camera'
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
import { CITY_LABEL_MIN_ZOOM, REGION_MAX_ZOOM } from '../LabelsGL'
import { JAPAN_BOUNDS, EEW_FOLLOW_MAX_RADIUS_KM } from './bounds'

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
// タブレット縦は「自動フィットの着地が 6.5 になる帯」（短辺 494〜698px）の代表。この帯が代表値から
// 漏れていたため、表示境界を着地段に乗せた不具合（2026-08-30）が検証をすり抜けていた。
const PANES: Pane[] = [
  { name: 'スマホ縦（上下分割）', width: 375, height: 420 },
  { name: 'スマホ横', width: 640, height: 360 },
  { name: 'タブレット縦（上下分割）', width: 768, height: 600 },
  { name: 'デスクトップ（左右分割）', width: 900, height: 800 },
  { name: '2K フルスクリーン', width: 1400, height: 1200 },
  { name: '超大画面（4K を 50% 表示）', width: 5760, height: 4320 },
]

const shortSideOf = (pane: Pane) => Math.min(pane.width, pane.height)

// レイヤーの表示境界を、カメラの着地段（`snapZoomDown` / `snapZoomNearest` の 0.5 刻み）から
// どれだけ離すか。
//
// flyTo は放物線を描いて飛ぶため、**開始と目標が同じズームでも移動中は必ず下回る**。落ち込み幅を
// 決めるのは視野に対する移動量で、距離そのものではない（zoom 8 での実測は 34km で 0.011・224km で
// 0.38。zoom 6.5 では同じ距離が 0.0014・0.060）。ここは「数十 km の移動で境界を割らない」ことだけを
// 求める下限で、余裕の選び方そのものは LabelsGL の CITY_LABEL_MIN_ZOOM と REGION_MAX_ZOOM にある。
const MIN_CLEARANCE_FROM_LANDING_STEP = 0.05

/**
 * そのズーム値が、カメラの着地しうる段（0.5 刻み）から十分離れているか。
 *
 * レイヤーの表示境界が着地段と同値だと、その段へ着地するたび flyTo のアンダーシュートで境界を割り、
 * **移動中だけレイヤーがまるごと消える**。着地すると戻るうえ、ズーム表示は丸めで変化して見えないため、
 * 症状から原因へ辿り着きにくい。
 */
function clearsCameraLandingSteps(zoom: number): boolean {
  // 丸め方は camera.ts と共有する。ここで式を書き写すと、着地の丸め方を変えたときテストだけが
  // 古い基準のまま緑になり、ガードが実装からずれたことに気づけない。
  return Math.abs(zoom - snapZoomNearest(zoom, EEW_ZOOM_SNAP)) > MIN_CLEARANCE_FROM_LANDING_STEP
}

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
  return landingZoom(pane, JAPAN_BOUNDS, FIT_JAPAN_PADDING_PX)
}

/** 矩形 `[[west,south],[east,north]]` が padding を除いたペインへ収まる最大ズーム（切り下げ前）。 */
function landingZoom(
  pane: Pane,
  [[west, south], [east, north]]: [[number, number], [number, number]],
  paddingPx: number,
): number {
  const mercY = (lat: number) => {
    const rad = (lat * Math.PI) / 180
    return 0.5 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / (2 * Math.PI)
  }
  // ズーム 0 での世界の大きさ（px）は MapLibre のタイル基準と同じ 512。
  const worldPx = 512
  const spanX = ((east - west) / 360) * worldPx
  const spanY = (mercY(south) - mercY(north)) * worldPx
  const usableW = pane.width - paddingPx * 2
  const usableH = pane.height - paddingPx * 2
  return Math.min(Math.log2(usableW / spanX), Math.log2(usableH / spanY))
}

// EEW 追従（`flyToBoundsSnapped` の呼び出し・`CameraFollowsGL.tsx`）で使う padding。
const EEW_FOLLOW_PADDING_PX = 60

/**
 * 震源中心・半径 radiusKm の箱へ EEW 追従が着地するズーム。
 *
 * 実装が通る経路（`flyToBoundsSnapped` → `cameraForBounds(bounds, { padding, maxZoom })` →
 * `snapZoomDown`）と同じ順序で解く。**寄り上限（`fitMaxZoom`）のクランプも入れる**——引き上限に
 * 達する規模の箱では上限側の制約は効かないが、それはいまの値でそうなっているだけ。省くと
 * `EEW_FOLLOW_MAX_RADIUS_KM` を小さくしたときにテストが「クランプ前の理論値」を検証し続ける。
 */
function eewFollowLandingZoom(pane: Pane, radiusKm: number, centerLat: number, centerLng: number): number {
  // **矩形の作り方は実装と共有する**（gl/psWaveRing.ts の ringBounds）。ここで独自に
  // 「緯度 1 度 = 111.32km」と書くと、実装が測地の解き方へ移ったのに気づかないまま
  // 別の近似を検証し続けることになる。
  const [west, south, east, north] = ringBounds(centerLng, centerLat, radiusKm)
  return eewFollowLandingZoomForBox(pane, [
    [west, south],
    [east, north],
  ])
}

/** 任意の箱に対する EEW 追従の着地ズーム（旧キャップとの比較にも使う）。 */
function eewFollowLandingZoomForBox(pane: Pane, box: [[number, number], [number, number]]): number {
  const raw = Math.min(
    landingZoom(pane, box, EEW_FOLLOW_PADDING_PX),
    fitMaxZoomForPane(shortSideOf(pane)),
  )
  return snapZoomDown(raw, EEW_ZOOM_SNAP)
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

  it('区域名ラベルの下限が、カメラの着地しうるズーム段から離れている', () => {
    // 8 ちょうどに置いていた間、寄り上限が 8 に達するペインでは地震カードを選ぶたびに区域名が
    // レイヤーごと約 1 秒消えていた（着地点と表示境界が同値・2026-08-30 実測）。
    expect(clearsCameraLandingSteps(CITY_LABEL_MIN_ZOOM)).toBe(true)
  })

  it('地方名と県名の境目も、カメラの着地しうるズーム段から離れている', () => {
    // 6.5 に置いていた間、着地が 6.5 になるペイン（短辺 494〜698px）では移動中だけ県名が
    // 地方名へ落ちていた。区域名の下限と同じ穴。
    expect(clearsCameraLandingSteps(REGION_MAX_ZOOM)).toBe(true)
  })

  it('段に乗った値を判定が捕まえる（ガードが飾りでないことの確認）', () => {
    // 上のテストが「たまたま通っている」のではなく、現に落とし穴のある値を弾いていることを示す。
    expect(clearsCameraLandingSteps(8)).toBe(false)
    expect(clearsCameraLandingSteps(7.5)).toBe(false)
  })

  it('県名ラベルの帯が潰れない（地方名の上限 < 区域名の下限）', () => {
    // 区域名の下限を下げすぎると県名の帯が消える。段から逃がすために動かせる範囲の下側を止める。
    expect(REGION_MAX_ZOOM).toBeLessThan(CITY_LABEL_MIN_ZOOM)
  })

  // 以下 3 件は EEW 追従の引き上限（`EEW_FOLLOW_MAX_RADIUS_KM`）と地方名ラベルの閾値の関係。
  // 上限は「旧キャップ（日本の枠で矩形の辺を切り詰める方式）と同じ見え方」を基準に選んだ値なので、
  // その前提が崩れたことを検知できるようにしておく。崩れても型チェックには一切現れない。
  it.each(PANES)('$name: 引き上限に達した EEW 追従が、旧キャップと同じ段へ着地する', (pane) => {
    // 旧実装は円の外接矩形を日本の枠へ切り詰めていた（枠いっぱいが最大ケース）。
    // 新実装は震源中心 ±上限 の箱。同じ段へ着地するなら、見え方は変わっていない。
    const old = eewFollowLandingZoomForBox(pane, JAPAN_BOUNDS)
    const capped = eewFollowLandingZoom(pane, EEW_FOLLOW_MAX_RADIUS_KM, 37.5, 137.2)
    expect(capped).toBe(old)
  })

  it('基準ペインでは引き上限に達した画でも地方名ラベルが出る', () => {
    // 上限を選ぶときの制約。視野は padding のぶん半径の 2 倍より広くなるため、上げすぎると
    // 大地震の引きの画で地名が落ちる。
    const pane: Pane = { name: '基準', width: 900, height: 800 }
    const landed = eewFollowLandingZoom(pane, EEW_FOLLOW_MAX_RADIUS_KM, 37.5, 137.2)
    expect(landed).toBeGreaterThan(labelMinZoomForPane(shortSideOf(pane)))
  })

  it('基準ペインでも半径 1000km まで上げると地方名ラベルが落ちる（上限に余裕が無いことの確認）', () => {
    // 上のテストが「たまたま通っている」のではなく、境目が近いことを示す。
    // 境目は 930km あたり。ここが動いたら `EEW_FOLLOW_MAX_RADIUS_KM` の docstring も見直す。
    const pane: Pane = { name: '基準', width: 900, height: 800 }
    expect(eewFollowLandingZoom(pane, 1000, 37.5, 137.2)).toBeLessThan(labelMinZoomForPane(shortSideOf(pane)))
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
