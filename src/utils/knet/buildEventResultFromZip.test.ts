import { describe, expect, test } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { buildEventResultFromZip } from './buildEventResultFromZip'

/**
 * K-NET ASCII形式のヘッダー・データを合成したテスト用ZIPを作る。
 * 実際にダウンロードした強震データは再配布禁止のため、このリポジトリには一切含めない
 * （knetAscii.test.ts と同じ方針。公式ドキュメントで確認済みの書式に沿って自作した値のみを使う）。
 */
function sineWave(freqHz: number, amplitude: number, sampleRateHz: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRateHz)))
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function buildStationFileText(opts: {
  stationCode: string
  originTime?: string
  recordTime?: string
  samplingHz?: number
  data: number[]
}): string {
  const samplingHz = opts.samplingHz ?? 100
  const lines = [
    `Origin Time\t${opts.originTime ?? '2018/09/06 03:07:59'}`,
    'Lat.\t42.686',
    'Long.\t142.001',
    'Depth. (km)\t37',
    'Mag.\t6.7',
    `Station Code\t${opts.stationCode}`,
    'Station Lat.\t42.9241',
    'Station Long.\t141.9503',
    'Station Height(m)\t145',
    `Record Time\t${opts.recordTime ?? '2018/09/06 03:08:04'}`,
    `Sampling Freq(Hz)\t${samplingHz}Hz`,
    'Duration Time(s)\t300',
    'Dir.\tN-S',
    'Scale Factor\t1(gal)/1',
    'Max. Acc. (gal)\t1029.67',
    'Last Correction\t2019/03/07 16:11:24',
    'Memo.\t',
    ...chunk(opts.data, 8).map((row) => row.join(' ')),
  ]
  return lines.join('\n')
}

/** 3成分揃った1観測点ぶんのZIPエントリを作る（震度が算出できるだけの長さの正弦波データ）。 */
function buildStationEntries(stationCode: string, opts: { originTime?: string; amplitude?: number } = {}): Record<string, Uint8Array> {
  const sampleRateHz = 100
  const n = 2048
  const amplitude = opts.amplitude ?? 300
  const data = sineWave(2, amplitude, sampleRateHz, n)
  const entries: Record<string, Uint8Array> = {}
  for (const comp of ['NS', 'EW', 'UD'] as const) {
    entries[`${stationCode}.${comp}`] = strToU8(
      buildStationFileText({ stationCode, originTime: opts.originTime, samplingHz: sampleRateHz, data }),
    )
  }
  return entries
}

describe('buildEventResultFromZip', () => {
  test('安全弁: stepSecが非整数だとエラーになる（epochSecの丸め衝突を防ぐ）', () => {
    const zip = zipSync(buildStationEntries('AAA001'))
    expect(() => buildEventResultFromZip(zip, 20, 0.5)).toThrow(/stepSec は正の整数/)
  })

  test('安全弁: stepSecが0以下だとエラーになる', () => {
    const zip = zipSync(buildStationEntries('AAA001'))
    expect(() => buildEventResultFromZip(zip, 20, 0)).toThrow(/stepSec は正の整数/)
  })

  test('安全弁: windowSecが0以下だとエラーになる', () => {
    const zip = zipSync(buildStationEntries('AAA001'))
    expect(() => buildEventResultFromZip(zip, 0, 5)).toThrow(/windowSec は正の数/)
  })

  test('正: ZIPを解析して観測点ごとの震度時系列とピーク震度を算出する', () => {
    const zip = zipSync({
      ...buildStationEntries('AAA001'),
      ...buildStationEntries('BBB002'),
    })
    const result = buildEventResultFromZip(zip, 20, 5)
    expect(result.originTimeJst).toBe('20180906030759')
    expect(result.stationSeries).toHaveLength(2)
    expect(result.stationSeries.map((s) => s.stationCode).sort()).toEqual(['AAA001', 'BBB002'])
    expect(result.peakIntensity).toBeGreaterThan(0)
  })

  test('対照: 観測点1件でも欠損なく算出できる', () => {
    const zip = zipSync(buildStationEntries('AAA001'))
    const result = buildEventResultFromZip(zip, 20, 5)
    expect(result.stationSeries).toHaveLength(1)
  })

  test('安全弁: ZIP内にNS/EW/UDファイルが1件も無いとエラーになる', () => {
    const zip = zipSync({ 'readme.txt': strToU8('not a waveform file') })
    expect(() => buildEventResultFromZip(zip, 20, 5)).toThrow(/波形ファイルが1件も見つかりません/)
  })

  test('安全弁: 3成分が揃わない観測点が過半数を占めるとエラーになる', () => {
    // AAA001は3成分揃うが、BBB002・CCC003・DDD004はNSしか無い（不完全な観測点が4件中3件=75%）。
    const complete = buildStationEntries('AAA001')
    const incomplete: Record<string, Uint8Array> = {}
    for (const code of ['BBB002', 'CCC003', 'DDD004']) {
      incomplete[`${code}.NS`] = strToU8(
        buildStationFileText({ stationCode: code, samplingHz: 100, data: sineWave(2, 300, 100, 2048) }),
      )
    }
    const zip = zipSync({ ...complete, ...incomplete })
    expect(() => buildEventResultFromZip(zip, 20, 5)).toThrow(/3成分が揃わない観測点が/)
  })

  test('安全弁: ZIP内に異なる地震のOrigin Timeが混在しているとエラーになる', () => {
    const zip = zipSync({
      ...buildStationEntries('AAA001', { originTime: '2018/09/06 03:07:59' }),
      ...buildStationEntries('BBB002', { originTime: '2018/10/05 08:58:53' }),
    })
    expect(() => buildEventResultFromZip(zip, 20, 5)).toThrow(/異なる地震のOrigin Timeが混在/)
  })

  test('安全弁: 有効な計測震度を1件も算出できない場合はエラーになる（データ長不足）', () => {
    // データが極端に短い（stepSamples > データ長）と、computeIntensityTimeSeriesのループが
    // 一度も回らずウィンドウが0件になる（nullウィンドウが並ぶのではない）。結果としてpeakIntensityが
    // 更新されず-Infinityのままになり、安全弁が発火する。
    const sampleRateHz = 100
    const shortData = sineWave(2, 300, sampleRateHz, 5) // 0.05秒ぶん
    const zip = zipSync({
      'AAA001.NS': strToU8(buildStationFileText({ stationCode: 'AAA001', samplingHz: sampleRateHz, data: shortData })),
      'AAA001.EW': strToU8(buildStationFileText({ stationCode: 'AAA001', samplingHz: sampleRateHz, data: shortData })),
      'AAA001.UD': strToU8(buildStationFileText({ stationCode: 'AAA001', samplingHz: sampleRateHz, data: shortData })),
    })
    expect(() => buildEventResultFromZip(zip, 20, 5)).toThrow(/有効な計測震度を1件も算出できませんでした/)
  })
})
