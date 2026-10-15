/**
 * 公開観測点の表（`public/data/public-stations.json`）と、それを作る `buildPublicStations` の検査。
 * 上流の応答（`.claude/public-stations-cache/`）はリポジトリに無いので、組み立ては小さな見本で確かめる。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPublicStations, endIso, NAMES_JA, type PublicStationsFile } from './build-public-stations'

const FILE: PublicStationsFile = JSON.parse(
  readFileSync(resolve(__dirname, '../public/data/public-stations.json'), 'utf8'),
)

/** 2026-10-14 にリング（SeedLink）で流れていた `JP` 網の観測点 */
const RING_CODES = [
  'JCJ', 'JEM', 'JEW', 'JGF', 'JHJ2', 'JHS', 'JKA', 'JMM', 'JMN', 'JMZ',
  'JNU', 'JOW', 'JSD', 'JSG', 'JSU', 'JTM', 'JTU', 'JWT', 'JYT', 'YOJ',
]

describe('公開観測点の表', () => {
  it('リングに流れている 20 点がすべて運用中のエポックを持つ', () => {
    const current = FILE.stations.filter((s) => s.end === null).map((s) => s.code).sort()
    expect(current).toEqual([...RING_CODES].sort())
  })

  it('名前は気象庁の観測点一覧の表記のまま（一覧と照らした数点を固定する）', () => {
    // 一覧（地震・火山月報（カタログ編）の付録「地震観測点」）の「観測点名」。字を取り違えやすいものを選んだ
    expect(NAMES_JA.JSU).toBe('鹿児島錫山')
    expect(NAMES_JA.JTU).toBe('対馬上県')
    expect(NAMES_JA.JTM).toBe('青森天間林')
    expect(NAMES_JA.JMZ).toBe('南大東島池之沢')
    expect(NAMES_JA.JKA).toBe(NAMES_JA.ASAJ)
    expect(NAMES_JA.JCJ).toBe(NAMES_JA.CBIJ)
  })

  it('どのエポックも日本語の名前と 3 成分を持つ', () => {
    for (const s of FILE.stations) {
      expect(s.nameJa, s.code).toBe(NAMES_JA[s.code])
      expect(s.channels.map((c) => c.code), s.code).toEqual(['BHE', 'BHN', 'BHZ'])
    }
  })

  it('同じコードのエポックは期間が重ならない', () => {
    const byCode = new Map<string, typeof FILE.stations>()
    for (const s of FILE.stations) byCode.set(s.code, [...(byCode.get(s.code) ?? []), s])
    for (const [code, list] of byCode) {
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].end, code).not.toBeNull()
        expect(list[i - 1].end! <= list[i].start, code).toBe(true)
      }
    }
  })
})


const STATION_HEADER = '#Network | Station | Latitude | Longitude | Elevation | SiteName | StartTime | EndTime'
const CHANNEL_HEADER =
  '#Network | Station | Location | Channel | Latitude | Longitude | Elevation | Depth | Azimuth | Dip | SensorDescription | Scale | ScaleFreq | ScaleUnits | SampleRate | StartTime | EndTime'

const ORIENT: Record<string, [number, number]> = { BHE: [90, 0], BHN: [0, 0], BHZ: [0, -90] }

interface Epoch {
  code: string
  lat: string
  lon: string
  start: string
  end?: string
  /** 成分を持たせない（JMJ・JMJ2 の形） */
  noChannels?: boolean
  /** BHN の採取率だけ変える */
  bhnRate?: string
}

function stationLine(e: Epoch): string {
  return `JP|${e.code}|${e.lat}|${e.lon}|10.0|Site ${e.code}|${e.start}|${e.end ?? ''}`
}

function channelLines(e: Epoch): string[] {
  if (e.noChannels) return []
  return ['BHE', 'BHN', 'BHZ'].map(
    (ch) =>
      `JP|${e.code}||${ch}|${e.lat}|${e.lon}|10.0|0.0|${ORIENT[ch][0]}.0|${ORIENT[ch][1]}.0|Streckeisen STS-2|1.0E9|8.0|M/S|${ch === 'BHN' && e.bhnRate ? e.bhnRate : '20.0'}|${e.start}|${e.end ?? ''}`,
  )
}

/** 錨 3 点・成分を持たない既知の 2 エポック・ほかの名前のある観測点を揃えた見本 */
function baseEpochs(): Epoch[] {
  const list: Epoch[] = [
    { code: 'ASAJ', lat: '44.118801', lon: '142.593002', start: '1996-09-24T00:00:00.0000', end: '2013-01-28T23:59:59.9999' },
    { code: 'JKA', lat: '44.118801', lon: '142.593002', start: '2013-01-29T00:00:00.0000' },
    { code: 'JMN', lat: '33.731499', lon: '133.876328', start: '1996-09-26T00:00:00.0000' },
    { code: 'YOJ', lat: '24.467199', lon: '123.011299', start: '1996-10-14T00:00:00.0000', bhnRate: '30.113' },
    { code: 'JMJ', lat: '24.8', lon: '125.3', start: '1996-09-24T00:00:00.0000', end: '2013-03-25T23:59:59.9999', noChannels: true },
    { code: 'JMJ2', lat: '24.7', lon: '125.3', start: '2013-03-28T00:00:00.0000', noChannels: true },
  ]
  const present = new Set(list.map((e) => e.code))
  for (const code of Object.keys(NAMES_JA)) {
    if (!present.has(code)) list.push({ code, lat: '35.0', lon: '135.0', start: '2000-01-01T00:00:00.0000' })
  }
  return list
}

function texts(epochs: Epoch[], extraChannels: string[] = []): [string, string] {
  return [
    [STATION_HEADER, ...epochs.map(stationLine)].join('\n'),
    [CHANNEL_HEADER, ...epochs.flatMap(channelLines), ...extraChannels].join('\n'),
  ]
}

function build(epochs: Epoch[], extraChannels: string[] = []) {
  const [st, ch] = texts(epochs, extraChannels)
  return buildPublicStations(st, ch, '2026-10-14')
}

function edit(epochs: Epoch[], code: string, patch: Partial<Epoch>): Epoch[] {
  return epochs.map((e) => (e.code === code ? { ...e, ...patch } : e))
}

describe('buildPublicStations', () => {
  it('見本はそのまま通り、既知の 2 エポックだけを外す', () => {
    const out = build(baseEpochs())
    expect(out.excluded.map((e) => e.code)).toEqual(['JMJ', 'JMJ2'])
    expect(out.stations.some((s) => s.code === 'JMJ')).toBe(false)
  })

  it('既知でないエポックが成分を持たなかったら止める（応答の欠けを「外した」に化けさせない）', () => {
    expect(() => build(edit(baseEpochs(), 'JMN', { noChannels: true }))).toThrow(/JMN@1996-09-26T00:00:00Z: 波形の成分が 1 本も無い/)
  })

  it('既知の成分なしのエポックが成分を持ったら止める（表の取り残し）', () => {
    expect(() => build(edit(baseEpochs(), 'JMJ2', { noChannels: false }))).toThrow(/KNOWN_NO_CHANNELS の JMJ2@/)
  })

  it('終わりは秒へ切り上げた半開区間で、次のエポックの始めと揃う', () => {
    const out = build(baseEpochs())
    const asaj = out.stations.find((s) => s.code === 'ASAJ')!
    const jka = out.stations.find((s) => s.code === 'JKA')!
    expect(asaj.end).toBe('2013-01-29T00:00:00Z')
    expect(asaj.end).toBe(jka.start)
  })

  it('同じ場所で分かれたエポックへ、成分をそれぞれ 1 本ずつ割り当てる', () => {
    const out = build(baseEpochs())
    for (const code of ['ASAJ', 'JKA']) {
      expect(out.stations.find((s) => s.code === code)!.channels.map((c) => c.code)).toEqual(['BHE', 'BHN', 'BHZ'])
    }
  })

  // 重なると 2010 年の成分が両方のエポックへ入るので「BHE が 2 件」も同時に出る（重なりの形そのものの性質）。
  // 正規表現が重なりの文言を要求するので、重なりの検査を外せば落ちる
  it('同じコードのエポックが重なったら止める', () => {
    const list = baseEpochs()
    // 1996〜2013 と 2010〜 の 2 エポックを JMN に持たせる
    list.push({ code: 'JMN', lat: '33.731499', lon: '133.876328', start: '2010-01-01T00:00:00.0000' })
    const withEnd = list.map((e) => (e.code === 'JMN' && e.start.startsWith('1996') ? { ...e, end: '2013-01-01T00:00:00.0000' } : e))
    expect(() => build(withEnd)).toThrow(/JMN: エポック .* が重なる/)
  })

  it('どのエポックにも入らない成分の行があれば止める', () => {
    const orphan = 'JP|JMN||BHZ|33.731499|133.876328|10.0|0.0|0.0|-90.0|Streckeisen STS-2|1.0E9|8.0|M/S|20.0|1990-01-01T00:00:00.0000|1995-01-01T00:00:00.0000'
    expect(() => build(baseEpochs(), [orphan])).toThrow(/JMN\.BHZ（1990-01-01T00:00:00.0000〜）: 対応する観測点のエポックが無い/)
  })

  it('既知の採取率の食い違い（YOJ.BHN）はそのエポックでだけ通す', () => {
    const yoj = build(baseEpochs()).stations.find((s) => s.code === 'YOJ')!
    expect(yoj.channels.find((c) => c.code === 'BHN')!.sampleRate).toBe(30.113)
    expect(() => build(edit(baseEpochs(), 'JMN', { bhnRate: '30.113' }))).toThrow(/JMN\.BHN: 採取率 30\.113/)
  })

  it('既知でない採取率は止める', () => {
    expect(() => build(edit(baseEpochs(), 'JMN', { bhnRate: '40.0' }))).toThrow(/JMN\.BHN: 採取率 40/)
  })

  it('成分の向きが名前と食い違ったら止める（東西と南北の取り違え）', () => {
    const [st, ch] = texts(baseEpochs())
    const swapped = ch.replace('|JMN||BHE|33.731499|133.876328|10.0|0.0|90.0|0.0|', '|JMN||BHE|33.731499|133.876328|10.0|0.0|0.0|0.0|')
    expect(swapped).not.toBe(ch)
    expect(() => buildPublicStations(st, swapped, '2026-10-14')).toThrow(/JMN\.BHE: 向き 方位 0/)
  })

  it('感度が 1.0×10⁹ から外れたら止める', () => {
    const [st, ch] = texts(baseEpochs())
    const broken = ch.replace('|JMN||BHZ|33.731499|133.876328|10.0|0.0|0.0|-90.0|Streckeisen STS-2|1.0E9', '|JMN||BHZ|33.731499|133.876328|10.0|0.0|0.0|-90.0|Streckeisen STS-2|6.0E8')
    expect(broken).not.toBe(ch)
    expect(() => buildPublicStations(st, broken, '2026-10-14')).toThrow(/JMN\.BHZ: 感度/)
  })

  it('日本語の名前が無い観測点が現れたら止める', () => {
    const list = [...baseEpochs(), { code: 'JZZ', lat: '35.0', lon: '135.0', start: '2020-01-01T00:00:00.0000' }]
    expect(() => build(list)).toThrow(/JZZ（Site JZZ）: 日本語の名前/)
  })

  it('錨の座標が動いたら止める（成分も同じ場所へ動かし、錨の判定だけを見る）', () => {
    let err: unknown
    try {
      build(edit(baseEpochs(), 'JMN', { lon: '133.9' }))
    } catch (e) {
      err = e
    }
    const message = String(err)
    expect(message).toMatch(/錨 JMN: 座標/)
    expect(message).not.toMatch(/成分の座標/)
  })
})

describe('endIso（終わりを半開区間へ切り上げる）', () => {
  it('正: 小数秒つきの終わりは次の秒へ繰り上げる（年をまたぐ）', () => {
    expect(endIso('2012-12-31T23:59:59.9999', 'x')).toBe('2013-01-01T00:00:00Z')
  })
  it('対照: 小数部が 0 か無いなら繰り上げない', () => {
    expect(endIso('2013-01-28T23:59:59.0000', 'x')).toBe('2013-01-28T23:59:59Z')
    expect(endIso('2013-01-28T23:59:59', 'x')).toBe('2013-01-28T23:59:59Z')
  })
  it('安全弁: 閏日へ正しく繰り上がる', () => {
    expect(endIso('2016-02-28T23:59:59.9999', 'x')).toBe('2016-02-29T00:00:00Z')
    expect(endIso('2015-02-28T23:59:59.9999', 'x')).toBe('2015-03-01T00:00:00Z')
  })
  it('空なら null（運用が続いている）', () => {
    expect(endIso('', 'x')).toBeNull()
  })
})
