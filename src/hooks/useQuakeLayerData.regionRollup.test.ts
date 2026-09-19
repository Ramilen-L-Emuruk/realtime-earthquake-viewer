// @vitest-environment jsdom
//
// 区域集約（regionMaxByName → regionAggregates）が「区域の点」をどう数えるかのテスト。
//
// パス2 は `p.isArea` だけで絞っており、quakeMerge の areaNames と ttsText が使う
// `p.isArea && p.addr !== p.pref`（都道府県ロールアップ点の除外）を持ち込んでいない。
// 見た目は不揃いだが、揃えると標準版（P2PQuake）で奈良県が地図から落ちる。
// **その回帰を止めるのは 1 件目だけ。** 2 件目・3 件目は集約そのものの性質
// （実在しない区域名は引かれない・同じキーは畳まれる）を固定するもので、除外を足しても通る。
// 奈良県は 47 都道府県で唯一、県内の一次細分区域が 1 つだけで、その名前が県名と同じ
// （station-coords.json の areas が `奈良県|奈良県` の 1 件のみ。この前提自体は
// stationCoords.test.ts「多区域の県に、県名と同じ表記の区域は無い」が固定している）。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { JMAQuake, EarthquakePoint } from '../types/earthquake'
import type { SubRegion } from '../utils/subregions'
import { CELL_LAT_DEG, CELL_LON_DEG } from '../utils/bufrEstimatedIntensity'

function sub(name: string, lat: number, lng: number): SubRegion {
  return {
    name,
    label: [lat, lng],
    room: [0.2, 0.2],
    rings: [[[lat + 0.2, lng - 0.2], [lat + 0.2, lng + 0.2], [lat - 0.2, lng + 0.2], [lat - 0.2, lng - 0.2]]],
  }
}

const NARA = sub('奈良県', 34.4, 135.8)
const OSAKA_SOUTH = sub('大阪府南部', 34.4, 135.5)
const TOKYO_23 = sub('東京都23区', 35.7, 139.7)

vi.mock('./useSubRegions', () => ({
  useSubRegions: () => ({ data: [NARA, OSAKA_SOUTH, TOKYO_23], failed: false }),
}))

// 座標テーブルはこのテストの対象外。区域塗りは電文が持つ区域名で直接引くため未読み込みでも成立する
// （→ docs/spec/quake-spec.md §7.3）。パス1（観測点からの逆引き）はこの経路では働かない。
vi.mock('./useStationCoords', () => ({ useStationCoords: () => null }))

const { useQuakeLayerData } = await import('./useQuakeLayerData')

// 区域集約が働くズーム（zoom <= aggregateMaxZoom）。
const VIEW = { zoom: 5, aggregateMaxZoom: 8 }

function makeQuake(points: EarthquakePoint[]): JMAQuake {
  const time = '2026-09-04T03:00:00Z'
  return {
    kind: 'quake',
    id: `quake-${time}`,
    time,
    issue: { source: 'p2pquake', time, type: '震度速報', correct: 'なし' },
    earthquake: {
      time,
      hypocenter: { name: '奈良県', latitude: 34.4, longitude: 135.8, depth: 10, magnitude: 5.0 },
      maxScale: 40,
      domesticTsunami: 'なし',
    },
    points,
  }
}

function aggregates(points: EarthquakePoint[]) {
  const { result } = renderHook(() => useQuakeLayerData('quake', makeQuake(points), VIEW))
  return result.current.regionAggregates.map((a) => [a.name, a.scale] as const)
}

describe('区域集約が数える「区域の点」', () => {
  // 正: 標準版（P2PQuake）の震度速報は区域点にも pref を積むため、奈良県は addr === pref になる。
  // ここに `addr !== pref` を持ち込むとこの区域が落ちる（観測点が無いのでパス1 でも拾えない）。
  it('区域名が県名と同じ奈良県も、pref 付きの区域点として集約に残る（標準版の震度速報）', () => {
    expect(
      aggregates([
        { pref: '奈良県', addr: '奈良県', isArea: true, scale: 40 },
        { pref: '大阪府', addr: '大阪府南部', isArea: true, scale: 30 },
      ]),
    ).toEqual([
      ['大阪府南部', 30],
      ['奈良県', 40],
    ])
  })

  // 除外しなくても区域塗りに漏れない仕組みを固定する。集約の鍵は subregionIndex（実在する
  // 区域名）なので、区域名として実在しない県名のエントリはどこからも引かれない。
  // 集約を regionMaxByName のキー側から回す実装へ変えると、これが崩れて県名が塗られる。
  it('都道府県ロールアップ点は、同名の区域が無い県では集約に現れない', () => {
    expect(
      aggregates([
        { pref: '', addr: '東京都23区', isArea: true, scale: 30 },
        { pref: '東京都', addr: '東京都', isArea: true, scale: 30 },
      ]),
    ).toEqual([['東京都23区', 30]])
  })

  // 奈良県では区域点とロールアップ点が同じキーへ積まれる。Map への bump なので行が二重に
  // 出ることも、震度が電文の値から動くことも無い——という重複の畳み方を固定する。
  it('奈良県で区域点とロールアップ点が重なっても、集約は 1 件・震度は電文どおり', () => {
    expect(
      aggregates([
        { pref: '', addr: '奈良県', isArea: true, scale: 40 },
        { pref: '奈良県', addr: '奈良県', isArea: true, scale: 40 },
      ]),
    ).toEqual([['奈良県', 40]])
  })
})

// 震度分布モードのカメラの寄り直し。
//
// **寄り先は「塗りがある範囲」の 2 点**（外接矩形の南西・北東）。カメラは `quakeSignature` が
// 変わったときだけ寄り直すが、シグネチャは寄り先の**本数しか見ない**。同じ地震のまま
// モードを切り替えると、たまたま点の数が同じ（区域 1 つ＝2 点）になったとき値が変わらず、
// **カメラが分布の位置へ寄らないまま据え置かれる**——エラーもログも出ない。
describe('震度分布モードのシグネチャ', () => {
  const EI = {
    id: 'ix1', time: '2026-07-28T16:32:00+09:00', arrivalTime: '2026-07-28T07:27:00.000Z',
    hypocenter: { lat: 32.6, lon: 130.7, depthKm: 10 },
    magnitude: 4.2, areaCode: 741, telegramKind: 0,
    grades: [{ scale: 4, modifier: 'none' as const, lower: 35, upper: 44 }],
    count: 1, lat: new Float32Array([32.6]), lon: new Float32Array([130.7]), si: new Uint8Array([42]),
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
    bounds: { south: 32.6, north: 32.7, west: 130.7, east: 130.8 },
  }
  const POINTS: EarthquakePoint[] = [{ addr: '奈良県', pref: '奈良県', isArea: true, scale: 40 }]

  function render(distributionMode: boolean) {
    const { result } = renderHook(() =>
      useQuakeLayerData('quake', makeQuake(POINTS), VIEW, null, distributionMode, EI))
    return result.current
  }

  // 正: 分布モードでは塗りがある範囲（外接矩形の 2 点）へ寄せる。
  it('分布モードでは塗りがある範囲へ寄せる', () => {
    expect(render(true).quakeFitPositions).toEqual([[32.6, 130.7], [32.7, 130.8]])
  })

  // 対照: モードを切ればいつもの寄り先（観測点・区域・震源）へ戻る。
  it('モードを切れば塗りの範囲へは寄せない', () => {
    expect(render(false).quakeFitPositions).not.toEqual([[32.6, 130.7], [32.7, 130.8]])
  })

  // 安全弁: **シグネチャがモードそのものを持つこと。**
  // 寄り先の本数だけで組むと、本数がたまたま一致した地震（分布モードは常に 2 点）で
  // 値が変わらず、上の 2 つが両方通っていてもカメラは動かない。本数を揃えた地震を
  // 作り分けても網羅にならないので、**モードの別が値に入っていること**を直接見る。
  it('シグネチャにモードの別が入っている', () => {
    const off = render(false), on = render(true)
    expect(on.quakeSignature).not.toBe(off.quakeSignature)
    // 本数の項を取り除いても差が残る＝差の出どころが本数ではない
    const dropCount = (sig: string) => sig.slice(0, sig.lastIndexOf(':'))
    expect(dropCount(on.quakeSignature)).not.toBe(dropCount(off.quakeSignature))
  })
})

// 寄り上限の選び方（`quakeFitZoomPolicy`）。
//
// 分布の寄り先は「塗りがある範囲」そのものなので、自動フィットの寄り上限（視野の短辺 400km）を
// 当てると、分布が数十 km に収まる地震では画の中心に来るだけで面が小さいまま残る。上限の値は
// `gl/zoomConstants.test.ts` が固定しており、ここで見るのは**どの寄り先にどちらを当てるか**。
describe('震度分布モードの寄り上限の選び方', () => {
  const EI = {
    id: 'ix1', time: '2026-07-28T16:32:00+09:00', arrivalTime: '2026-07-28T07:27:00.000Z',
    hypocenter: { lat: 32.6, lon: 130.7, depthKm: 10 },
    magnitude: 4.2, areaCode: 741, telegramKind: 0,
    grades: [{ scale: 4, modifier: 'none' as const, lower: 35, upper: 44 }],
    count: 1, lat: new Float32Array([32.6]), lon: new Float32Array([130.7]), si: new Uint8Array([42]),
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
    bounds: { south: 32.6, north: 32.7, west: 130.7, east: 130.8 },
  }
  const POINTS: EarthquakePoint[] = [{ addr: '奈良県', pref: '奈良県', isArea: true, scale: 40 }]

  function render(distributionMode: boolean, estimated: typeof EI | null) {
    const { result } = renderHook(() =>
      useQuakeLayerData('quake', makeQuake(POINTS), VIEW, null, distributionMode, estimated ?? undefined))
    return result.current
  }

  // 正: 分布を出しているときは分布向けの上限を選ぶ。
  it('分布を出しているときは分布向けの上限を選ぶ', () => {
    expect(render(true, EI).quakeFitZoomPolicy).toBe('distribution')
  })

  // 対照: モードを切れば自動フィットの上限に戻る。
  it('モードを切れば自動フィットの上限に戻る', () => {
    expect(render(false, EI).quakeFitZoomPolicy).toBe('auto')
  })

  // 安全弁: **モードだけを見て選ばない。** 気象庁の推計が届いていない間の寄り先は通常の区域範囲
  // （自前の面を出している状態）なので、分布向けの上限を当てると県ひとつの区域塗りへ
  // 数 km まで寄る画になる。寄り先と上限は同じ条件から出すこと。
  it('安全弁: モードに入っていても推計が届いていなければ自動フィットの上限', () => {
    expect(render(true, null).quakeFitZoomPolicy).toBe('auto')
  })

  // 安全弁: 推計が後から届いたときに寄り直せること。**モードの別だけではこの変化を表せない**
  // （どちらも分布モードのまま）。本数の項を取り除いても差が残ることで、差の出どころが
  // 寄り上限の別であることを確かめる——区域が 1 つの地震では本数も一致しうる。
  it('安全弁: シグネチャに寄り上限の別が入っている', () => {
    const before = render(true, null), after = render(true, EI)
    const dropCount = (sig: string) => sig.slice(0, sig.lastIndexOf(':'))
    expect(dropCount(after.quakeSignature)).not.toBe(dropCount(before.quakeSignature))
  })
})
