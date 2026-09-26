import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EMPTY_STATION_CONFIG,
  StationDirectory,
  loadStationConfig,
  parseStationConfig,
} from './stationConfig'

describe('parseStationConfig', () => {
  it('正: boardKey・stationId・displayName が揃った設定を読める', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'mac:3c8a1f5d54d8', stationId: 'study', displayName: '書斎' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.stations).toEqual([
      { boardKey: 'mac:3c8a1f5d54d8', stationId: 'study', displayName: '書斎' },
    ])
  })

  it('安全弁: 同じ stationId へ複数の boardKey を割り当てられる（複数台の統合を妨げない）', () => {
    const result = parseStationConfig({
      stations: [
        { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'study', displayName: '書斎' },
        { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'study', displayName: '書斎' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.stations).toHaveLength(2)
  })

  it('版 1 の名前ベースの boardKey（name:）も受ける', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'name:seismo-3', stationId: 'living', displayName: '1F 居間' }],
    })
    expect(result.ok).toBe(true)
  })

  it('対照: stations が無いと弾く', () => {
    const result = parseStationConfig({})
    expect(result).toEqual({ ok: false, failure: { reason: 'stations-not-array' } })
  })

  it('対照: stations が配列でないと弾く', () => {
    const result = parseStationConfig({ stations: 'not-an-array' })
    expect(result).toEqual({ ok: false, failure: { reason: 'stations-not-array' } })
  })

  it('対照: 中身がオブジェクトでないと弾く', () => {
    const result = parseStationConfig('not-an-object')
    expect(result).toEqual({ ok: false, failure: { reason: 'not-an-object' } })
  })

  it('対照: エントリがオブジェクトでないと弾く', () => {
    const result = parseStationConfig({ stations: ['not-an-object'] })
    expect(result).toEqual({ ok: false, failure: { reason: 'entry-not-an-object', index: 0 } })
  })

  it('対照: boardKey が mac:/name: で始まらないと弾く', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'study', stationId: 'study', displayName: '書斎' }],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'entry-field-invalid', index: 0, field: 'boardKey', value: 'study' },
    })
  })

  it('対照: mac: の中身が 12 桁の 16 進数でなければ弾く（実機と一致しない値を通さない）', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'mac:aa', stationId: 'study', displayName: '書斎' }],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'entry-field-invalid', index: 0, field: 'boardKey', value: 'mac:aa' },
    })
  })

  it('安全弁: 実機 12 桁ぴったりの mac: は通り、13 桁は弾く（境界値）', () => {
    const ok = parseStationConfig({
      stations: [{ boardKey: 'mac:3c8a1f5d54d8', stationId: 'study', displayName: '書斎' }],
    })
    expect(ok.ok).toBe(true)

    const tooLong = parseStationConfig({
      stations: [{ boardKey: 'mac:3c8a1f5d54d80', stationId: 'study', displayName: '書斎' }],
    })
    expect(tooLong.ok).toBe(false)
  })

  it('対照: name: の中身が空（trim 後）だと弾く（境界値: name: は 5 文字で isBoardKeyLike の旧閾値 4 を通ってしまっていた）', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'name:', stationId: 'study', displayName: '書斎' }],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'entry-field-invalid', index: 0, field: 'boardKey', value: 'name:' },
    })
  })

  it('正: mac: は大文字が混じっていても小文字へ正規化して格納する', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'mac:3C8A1F5D54D8', stationId: 'study', displayName: '書斎' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.stations[0].boardKey).toBe('mac:3c8a1f5d54d8')
  })

  it('正: boardKey の前後の空白は落として格納する（実機の値と一致させるため）', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: ' mac:3c8a1f5d54d8 ', stationId: 'study', displayName: '書斎' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.stations[0].boardKey).toBe('mac:3c8a1f5d54d8')
  })

  it('対照: stationId が空文字だと弾く', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'mac:aabbccddeeff', stationId: '  ', displayName: '書斎' }],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'entry-field-invalid', index: 0, field: 'stationId', value: '  ' },
    })
  })

  it('対照: displayName が欠けていると弾く', () => {
    const result = parseStationConfig({
      stations: [{ boardKey: 'mac:aabbccddeeff', stationId: 'study' }],
    })
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'entry-field-invalid',
        index: 0,
        field: 'displayName',
        value: undefined,
      },
    })
  })

  it('対照: 同じ boardKey が 2 度現れると弾く（黙ってどちらかを採らない）', () => {
    const result = parseStationConfig({
      stations: [
        { boardKey: 'mac:aabbccddeeff', stationId: 'study', displayName: '書斎（旧）' },
        { boardKey: 'mac:aabbccddeeff', stationId: 'study', displayName: '書斎（新）' },
      ],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'duplicate-board-key', boardKey: 'mac:aabbccddeeff' },
    })
  })

  it('対照: 正規化後に一致する boardKey も重複として弾く（大文字違いで素通りさせない）', () => {
    const result = parseStationConfig({
      stations: [
        { boardKey: 'mac:aabbccddeeff', stationId: 'study', displayName: '書斎（旧）' },
        { boardKey: 'mac:AABBCCDDEEFF', stationId: 'study', displayName: '書斎（新）' },
      ],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'duplicate-board-key', boardKey: 'mac:aabbccddeeff' },
    })
  })
})

describe('StationDirectory', () => {
  it('正: 設定にある boardKey を解決すると観測点が返る', () => {
    const dir = new StationDirectory({
      stations: [{ boardKey: 'mac:aa', stationId: 'study', displayName: '書斎' }],
    })
    expect(dir.resolve('mac:aa')).toEqual({ stationId: 'study', displayName: '書斎' })
  })

  it('対照: 設定に無い boardKey は未割当（null）', () => {
    const dir = new StationDirectory({
      stations: [{ boardKey: 'mac:aa', stationId: 'study', displayName: '書斎' }],
    })
    expect(dir.resolve('mac:bb')).toBeNull()
  })

  it('空の帳面はどの boardKey も未割当を返す', () => {
    const dir = StationDirectory.empty()
    expect(dir.resolve('mac:aa')).toBeNull()
  })
})

describe('loadStationConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seismo-station-config-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('対照: ファイルが無ければ空の設定・警告なし（割り当ては任意）', () => {
    const result = loadStationConfig(join(dir, 'stations.json'))
    expect(result).toEqual({ config: EMPTY_STATION_CONFIG, warning: null })
  })

  it('正: 書いたとおりに読める', () => {
    const path = join(dir, 'stations.json')
    writeFileSync(
      path,
      JSON.stringify({
        stations: [{ boardKey: 'mac:aabbccddeeff', stationId: 'study', displayName: '書斎' }],
      }),
    )
    const result = loadStationConfig(path)
    expect(result.warning).toBeNull()
    expect(result.config.stations).toEqual([
      { boardKey: 'mac:aabbccddeeff', stationId: 'study', displayName: '書斎' },
    ])
  })

  it('対照: JSON として読めなければ空の設定へ倒し、理由を warning へ出す（黙って空にはしない）', () => {
    const path = join(dir, 'stations.json')
    writeFileSync(path, '{not valid json')
    const result = loadStationConfig(path)
    expect(result.config).toEqual(EMPTY_STATION_CONFIG)
    expect(result.warning).not.toBeNull()
  })

  it('対照: 書式が崩れていれば空の設定へ倒し、理由を warning へ出す（実際に書いた不正な値も添える）', () => {
    const path = join(dir, 'stations.json')
    writeFileSync(path, JSON.stringify({ stations: [{ boardKey: 'study' }] }))
    const result = loadStationConfig(path)
    expect(result.config).toEqual(EMPTY_STATION_CONFIG)
    expect(result.warning).toContain('boardKey')
    expect(result.warning).toContain('study')
  })
})
