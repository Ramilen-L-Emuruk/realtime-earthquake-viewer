import { describe, expect, test } from 'vitest'
import { countsToGal, groupIntoStations, parseKnetAsciiFile, resolveComponentFromFileName, type KnetAsciiFile } from './knetAscii'

/**
 * K-NET ASCII形式のヘッダー・データを合成したテスト用フィクスチャ。
 * 実際にダウンロードした強震データは再配布禁止のため、このリポジトリには一切含めない
 * （公式ドキュメントで確認済みの書式に沿って自作した値のみを使う）。
 */
function buildKnetAsciiFixture(opts: {
  stationCodeLine?: string
  latLine?: string
  lonLine?: string
  samplingLine?: string
  scaleFactorLine?: string
  recordTimeLine?: string
  memoLine?: string
  data?: number[]
} = {}): string {
  const data = opts.data ?? [-30, -25, -34, -28, -32, -25, -33, -30, -35, -25]
  const lines = [
    'Origin Time\t2018/09/06 03:07:59',
    'Lat.\t42.686',
    'Long.\t142.001',
    'Depth. (km)\t37',
    'Mag.\t6.7',
    opts.stationCodeLine ?? 'Station Code\tHKD127',
    opts.latLine ?? 'Station Lat.\t42.9241',
    opts.lonLine ?? 'Station Long.\t141.9503',
    'Station Height(m)\t145',
    opts.recordTimeLine ?? 'Record Time\t2018/09/06 03:08:04',
    opts.samplingLine ?? 'Sampling Freq(Hz)\t100Hz',
    'Duration Time(s)\t300',
    'Dir.\tN-S',
    opts.scaleFactorLine ?? 'Scale Factor\t2000(gal)/8388608',
    'Max. Acc. (gal)\t1029.67',
    'Last Correction\t2019/03/07 16:11:24',
    opts.memoLine ?? 'Memo.\t',
    ...chunk(data, 8).map((row) => row.join(' ')),
  ]
  return lines.join('\n')
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

describe('parseKnetAsciiFile', () => {
  test('正: 標準的なヘッダー・データを解析できる', () => {
    const file = parseKnetAsciiFile(buildKnetAsciiFixture(), 'HKD1270809060308.NS')
    expect(file.stationCode).toBe('HKD127')
    expect(file.latitude).toBeCloseTo(42.9241)
    expect(file.longitude).toBeCloseTo(141.9503)
    expect(file.samplingHz).toBe(100)
    expect(file.scaleFactor).toEqual({ numerator: 2000, denominator: 8388608 })
    // 2018/09/06 03:08:04 JST = 2018/09/05 18:08:04 UTC
    expect(file.recordStartTime.toISOString()).toBe('2018-09-05T18:08:04.000Z')
    expect(file.component).toBe('NS')
    expect(file.depthKind).toBe('surface')
    expect(file.rawCounts).toEqual([-30, -25, -34, -28, -32, -25, -33, -30, -35, -25])
  })

  test('回帰: 長いキーで値との間が空白1個しか無くても読み取れる（固定幅列のため）', () => {
    // 実ファイル（2018年北海道胆振東部地震、観測点FKS007）で確認済み: キーが列幅に近い/超える
    // 場合、値との間の空白は1個だけになる（例: "Sampling Freq(Hz) 100Hz"）。
    // 「2文字以上の連続空白を区切りとみなす」という判定ではこの行を読み取れず、
    // ヘッダー全体のパースが本番データで即座に失敗していた（実機確認で発覚）。
    const file = parseKnetAsciiFile(
      buildKnetAsciiFixture({ samplingLine: 'Sampling Freq(Hz) 100Hz' }),
      'HKD1270809060308.NS',
    )
    expect(file.samplingHz).toBe(100)
  })

  test('対照: "Lon." 表記（"Long."ではない）でも Station 経度を読み取れる', () => {
    const file = parseKnetAsciiFile(
      buildKnetAsciiFixture({ lonLine: 'Station Lon.\t141.9503' }),
      'HKD1270809060308.NS',
    )
    expect(file.longitude).toBeCloseTo(141.9503)
  })

  test('回帰: "Memo."行に値が続かない（区切り無し）場合もヘッダー終端として扱う', () => {
    // 実ファイル（2018年北海道胆振東部地震、観測点FKS007）で確認済み: キーと値の区切りは
    // 固定幅の列位置であり、"Memo."の後に値が無い行もそのまま17行目に来る。
    const file = parseKnetAsciiFile(buildKnetAsciiFixture({ memoLine: 'Memo.' }), 'HKD1270809060308.NS')
    expect(file.rawCounts).toEqual([-30, -25, -34, -28, -32, -25, -33, -30, -35, -25])
  })

  test('安全弁: Station Code が無いとエラーになる（無警告で欠損値を採用しない）', () => {
    // 行を削除すると17行目の位置がずれてしまう（別の異常系になる）ため、行数は保ったまま
    // キーだけ別物に差し替える。
    const broken = buildKnetAsciiFixture({ stationCodeLine: 'Unknown Field\tHKD127' })
    expect(() => parseKnetAsciiFile(broken, 'HKD1270809060308.NS')).toThrow(/Station Code/)
  })

  test('データ行に数値でないトークンがあるとエラーになる', () => {
    const broken = buildKnetAsciiFixture().replace('-30 -25 -34 -28 -32 -25 -33 -30', 'BAD -25 -34 -28 -32 -25 -33 -30')
    expect(() => parseKnetAsciiFile(broken, 'HKD1270809060308.NS')).toThrow(/数値でないトークン/)
  })
})

describe('resolveComponentFromFileName', () => {
  test('K-NET形式（.NS/.EW/.UD）はsurfaceと判定する', () => {
    expect(resolveComponentFromFileName('HKD1270809060308.NS')).toEqual({ component: 'NS', depthKind: 'surface' })
    expect(resolveComponentFromFileName('HKD1270809060308.EW')).toEqual({ component: 'EW', depthKind: 'surface' })
    expect(resolveComponentFromFileName('HKD1270809060308.UD')).toEqual({ component: 'UD', depthKind: 'surface' })
  })

  test('KiK-net形式: 末尾1=borehole、末尾2=surface', () => {
    expect(resolveComponentFromFileName('IBUH010809060308.NS1')).toEqual({ component: 'NS', depthKind: 'borehole' })
    expect(resolveComponentFromFileName('IBUH010809060308.NS2')).toEqual({ component: 'NS', depthKind: 'surface' })
  })

  test('未知の拡張子はエラーになる', () => {
    expect(() => resolveComponentFromFileName('readme.txt')).toThrow(/成分/)
  })
})

describe('countsToGal', () => {
  test('スケールファクタ通りにgalへ換算する', () => {
    const file: KnetAsciiFile = {
      stationCode: 'HKD127',
      latitude: 42.9241,
      longitude: 141.9503,
      samplingHz: 100,
      scaleFactor: { numerator: 2000, denominator: 8388608 },
      recordStartTime: new Date('2018-09-05T18:08:04.000Z'),
      component: 'NS',
      depthKind: 'surface',
      rawCounts: [8388608, -8388608, 0],
    }
    const gal = countsToGal(file)
    expect(gal[0]).toBeCloseTo(2000)
    expect(gal[1]).toBeCloseTo(-2000)
    expect(gal[2]).toBe(0)
  })
})

describe('groupIntoStations', () => {
  const makeFile = (component: 'NS' | 'EW' | 'UD', depthKind: 'surface' | 'borehole', stationCode = 'HKD127'): KnetAsciiFile => ({
    stationCode,
    latitude: 42.9241,
    longitude: 141.9503,
    samplingHz: 100,
    scaleFactor: { numerator: 1, denominator: 1 },
    recordStartTime: new Date('2018-09-05T18:08:04.000Z'),
    component,
    depthKind,
    rawCounts: [1, 2, 3],
  })

  test('正: NS/EW/UDが揃った観測点は1件のKnetStationになる', () => {
    const { stations, skippedIncomplete } = groupIntoStations([
      makeFile('NS', 'surface'),
      makeFile('EW', 'surface'),
      makeFile('UD', 'surface'),
    ])
    expect(stations).toHaveLength(1)
    expect(stations[0].stationCode).toBe('HKD127')
    expect(skippedIncomplete).toBe(0)
  })

  test('対照: 3成分が揃わない観測点は除外され、件数が加算される', () => {
    const { stations, skippedIncomplete } = groupIntoStations([
      makeFile('NS', 'surface'),
      makeFile('EW', 'surface'),
    ])
    expect(stations).toHaveLength(0)
    expect(skippedIncomplete).toBe(1)
  })

  test('安全弁: KiK-netの地中(borehole)成分は地表が別に無い限り採用されない', () => {
    const { stations, skippedIncomplete } = groupIntoStations([
      makeFile('NS', 'borehole'),
      makeFile('EW', 'borehole'),
      makeFile('UD', 'borehole'),
    ])
    expect(stations).toHaveLength(0)
    // borehole は grouping 対象から事前に除外されるため「不完全」としても数えない
    expect(skippedIncomplete).toBe(0)
  })
})
