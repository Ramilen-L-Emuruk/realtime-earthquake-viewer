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
