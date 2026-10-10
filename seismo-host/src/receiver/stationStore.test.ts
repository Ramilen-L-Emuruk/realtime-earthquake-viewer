import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StationConfig } from './stationConfigTypes'
import { loadStationHistory, STATION_CONFIG_FILE, StationStore } from './stationStore'
import { configAt } from './stationXml'

const CONFIG_A: StationConfig = {
  stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
  boards: [
    {
      boardKey: 'mac:020000000003',
      stationId: 'study',
      // 鉛直を合わせた回転（純粋な回転を小数 6 桁に丸めたもの）。
      orientation: [
        [0.999844, -0.000312, 0.017659],
        [-0.000312, 0.999688, 0.024984],
        [-0.017659, -0.024984, 0.999532],
      ],
      sensors: [
        {
          sensorId: 'i2c0-68',
          enabled: true,
          axes: [
            { vector: [0.99364, 0.0021, -0.0005], offset: 18.55 },
            { vector: [-0.0012, 1.0013, 0.0008], offset: 2.25 },
            { vector: [0.0003, -0.0009, 1.00641], offset: 235.5 },
          ],
          noiseDensity: null,
        },
      ],
    },
  ],
}
const CONFIG_B: StationConfig = { stations: [], boards: [] }

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'station-store-'))
  path = join(dir, 'config', STATION_CONFIG_FILE)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('StationStore', () => {
  it('ファイルが無ければ空の設定で開き、記録を書くとファイルができる（一時ファイルは残さない）', () => {
    const store = new StationStore({ path, now: () => 1_000 })
    expect(store.open()).toEqual({ config: CONFIG_B, warning: null })
    store.record(CONFIG_A, 'startup')
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(store.recorded).toBe(1)
  })

  it('保存した設定が、次の起動でそのまま（値も並びも）いまの設定になる', () => {
    const first = new StationStore({ path, now: () => 1_000 })
    first.open()
    first.record(CONFIG_A, 'changed')
    const second = new StationStore({ path, now: () => 2_000 })
    expect(second.open()).toEqual({ config: CONFIG_A, warning: null })
  })

  it('起動の記録を足しても期間は続き、設定を変えたら期間を足す（履歴は消えない）', () => {
    let now = 1_000
    const store = new StationStore({ path, now: () => now })
    store.open()
    store.record(CONFIG_A, 'startup')
    now = 2_000
    store.record(CONFIG_A, 'startup')
    now = 3_000
    store.record(CONFIG_B, 'changed')

    const doc = loadStationHistory(path)
    expect(doc.boards).toHaveLength(1)
    expect(doc.boards[0]).toMatchObject({ startMs: 1_000, endMs: 3_000 })
    expect(doc.revisions.map((r) => [r.atMs, r.reason])).toEqual([
      [1_000, 'startup'],
      [2_000, 'startup'],
      [3_000, 'changed'],
    ])
    expect(configAt(doc, 2_500)).toEqual(CONFIG_A)
    expect(configAt(doc, 3_000)).toEqual(CONFIG_B)
  })

  describe('configThrough（作り直しが使う「区間の間ずっと効いていた設定」）', () => {
    function storeWith(records: Array<[number, StationConfig, 'startup' | 'changed']>): StationStore {
      let now = 0
      const store = new StationStore({ path, now: () => now })
      store.open()
      for (const [at, config, reason] of records) {
        now = at
        store.record(config, reason)
      }
      return store
    }

    it('正: 区間の中に起動の記録しか無ければ、その設定を返す（再起動をまたいでも作り直せる）', () => {
      const store = storeWith([[1_000, CONFIG_A, 'startup'], [2_000, CONFIG_A, 'startup']])
      expect(store.configThrough(1_500, 2_500)).toEqual(CONFIG_A)
    })

    it('対照: 区間の中で設定が変わっていれば changed（区間の外で変わったなら、その時点の設定）', () => {
      const store = storeWith([[1_000, CONFIG_A, 'startup'], [3_000, CONFIG_B, 'changed']])
      expect(store.configThrough(2_000, 3_500)).toBe('changed')
      expect(store.configThrough(1_500, 2_500)).toEqual(CONFIG_A)
      expect(store.configThrough(3_000, 4_000)).toEqual(CONFIG_B)
    })

    it('安全弁: 区間の中で変えて元へ戻しても changed（両端だけ比べない）', () => {
      const store = storeWith([[1_000, CONFIG_A, 'startup'], [2_000, CONFIG_B, 'changed'], [3_000, CONFIG_A, 'changed']])
      expect(store.configThrough(1_500, 3_500)).toBe('changed')
    })

    it('安全弁: ファイルを読めていなければ null（いまの設定で代わりに作らない）', () => {
      mkdirSync(join(dir, 'config'), { recursive: true })
      writeFileSync(path, 'not xml')
      const store = new StationStore({ path })
      store.open()
      expect(store.configThrough(0, 1_000)).toBeNull()
    })
  })

  it('読めないファイルは空の設定と理由で開き、以後は書かず（投げる）、ファイルをそのまま残す', () => {
    const store0 = new StationStore({ path, now: () => 1 })
    store0.open()
    store0.record(CONFIG_A, 'startup')
    const broken = `${readFileSync(path, 'utf8').slice(0, 200)}`
    writeFileSync(path, broken)

    const store = new StationStore({ path, now: () => 2 })
    const opened = store.open()
    expect(opened.config).toEqual(CONFIG_B)
    expect(opened.warning).toMatch(/^読めない: /)
    expect(() => store.record(CONFIG_A, 'changed')).toThrow(/読めなかった/)
    expect(store.writeFailures).toBe(1)
    expect(store.lastError).toMatch(/読めなかった/)
    expect(readFileSync(path, 'utf8')).toBe(broken)
  })

  it('StationXML としては読めても、設定の検証を通らなければ読めないとして扱う', () => {
    const store0 = new StationStore({ path, now: () => 1 })
    store0.open()
    store0.record(CONFIG_A, 'startup')
    // 緯度 200 は StationXML の読み手は通す（期間と記録で揃っている）が、設定の検証は受け付けない。
    const outOfRange = readFileSync(path, 'utf8').replaceAll('35.6', '200')
    writeFileSync(path, outOfRange)
    const opened = new StationStore({ path, now: () => 2 }).open()
    expect(opened.config).toEqual(CONFIG_B)
    expect(opened.warning).toMatch(/lat が不正: 200/)
  })

  it('いまの設定が通っても、過去の記録の設定が通らなければ読めないとする（評価台は過去の設定を使う）', () => {
    let now = 1
    const store0 = new StationStore({ path, now: () => now })
    store0.open()
    store0.record(CONFIG_A, 'startup')
    now = 2
    store0.record(CONFIG_B, 'changed')
    // 緯度は過去の記録（と閉じた期間）にしか無い。いまの設定（CONFIG_B）は空で、検証を通る。
    const outOfRange = readFileSync(path, 'utf8').replaceAll('35.6', '200')
    writeFileSync(path, outOfRange)
    expect(() => loadStationHistory(path)).toThrow(/記録の設定が通らない: .*lat が不正: 200/)
    const opened = new StationStore({ path, now: () => 3 }).open()
    expect(opened.config).toEqual(CONFIG_B)
    expect(opened.warning).toMatch(/lat が不正: 200/)
  })

  it('書けなければ投げて数える（保存の失敗を呼び出し側へ返す）', () => {
    // 置き場所にファイルを置いて、ディレクトリを作れなくする。
    const blocked = join(dir, 'blocker')
    writeFileSync(blocked, '')
    const store = new StationStore({ path: join(blocked, STATION_CONFIG_FILE), now: () => 1 })
    store.open()
    expect(() => store.record(CONFIG_A, 'startup')).toThrow()
    expect(store.writeFailures).toBe(1)
    expect(store.recorded).toBe(0)
  })
})
