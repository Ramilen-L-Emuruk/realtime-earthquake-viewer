import { describe, it, expect } from 'vitest'
import { validateScenarioIndex, validateScenarioFile } from './testScenarioSchema'

describe('validateScenarioIndex', () => {
  it('正常な index.json を全件通す', () => {
    const raw = [
      { id: 'a', label: 'A', description: 'test', category: 'quake', durationMs: 60000 },
      { id: 'b', label: 'B', description: 'test', category: 'tsunami', durationMs: 90000 },
    ]
    const result = validateScenarioIndex(raw)
    expect(result.valid).toHaveLength(2)
    expect(result.skipped).toBe(0)
    expect(result.malformed).toBe(false)
  })

  it('壊れた要素を skip して残りを通す', () => {
    const raw = [
      { id: 'a', label: 'A', description: 'test', category: 'quake', durationMs: 60000 },
      { id: '', label: 'invalid empty id', description: '', category: 'quake', durationMs: 0 },
      { id: 'c', label: 'C', description: 'test', category: 'unknown-category', durationMs: 60000 },
      { id: 'd', label: 'D', description: 'test', category: 'lpgm', durationMs: -1 },
    ]
    const result = validateScenarioIndex(raw)
    expect(result.valid).toHaveLength(1)
    expect(result.valid[0].id).toBe('a')
    expect(result.skipped).toBe(3)
    expect(result.malformed).toBe(false)
  })

  it('配列でなければ malformed=true で空を返す（HIGH #2 対策）', () => {
    for (const bad of [null, undefined, { foo: 1 }, 'string', 42]) {
      const r = validateScenarioIndex(bad)
      expect(r.valid).toEqual([])
      expect(r.skipped).toBe(0)
      expect(r.malformed).toBe(true)
    }
  })

  it('空配列は valid=[]・skipped=0・malformed=false（正常な空リスト）', () => {
    const result = validateScenarioIndex([])
    expect(result.valid).toEqual([])
    expect(result.skipped).toBe(0)
    expect(result.malformed).toBe(false)
  })
})

describe('validateScenarioFile', () => {
  it('正常なシナリオファイルを返す', () => {
    const raw = {
      id: 'a',
      label: 'A',
      description: 'test',
      category: 'quake',
      durationMs: 60000,
      baseTime: '2026-01-01T00:00:00Z',
      entries: [
        { offsetMs: 0, payload: { kind: 'event', event: { kind: 'quake' } } },
        { offsetMs: 1000, payload: { kind: 'lpgm', data: {} }, silent: true },
        { offsetMs: 2000, payload: { kind: 'nankai', data: {} } },
        { offsetMs: 3000, payload: { kind: 'kohatsu', data: {} } },
      ],
    }
    const result = validateScenarioFile(raw)
    expect(result).not.toBeNull()
    expect(result?.entries).toHaveLength(4)
    expect(result?.entries[1].silent).toBe(true)
  })

  it('payload.kind が既知でも必須サブフィールド欠落なら skip（HIGH #1 対策）', () => {
    const raw = {
      id: 'a', label: 'A', description: 'x', category: 'quake', durationMs: 0,
      baseTime: '2026-01-01T00:00:00Z',
      entries: [
        // event.event が欠落 → remapAppEvent が undefined.kind で TypeError
        { offsetMs: 0, payload: { kind: 'event' } },
        // event.event が非オブジェクト → 同上
        { offsetMs: 100, payload: { kind: 'event', event: 'not-object' } },
        // lpgm/nankai/kohatsu の data 欠落
        { offsetMs: 200, payload: { kind: 'lpgm' } },
        { offsetMs: 300, payload: { kind: 'nankai', data: null } },
        // 正常な 1 件
        { offsetMs: 400, payload: { kind: 'event', event: { kind: 'quake' } } },
      ],
    }
    const result = validateScenarioFile(raw)
    expect(result).not.toBeNull()
    expect(result?.entries).toHaveLength(1)
    expect(result?.entries[0].offsetMs).toBe(400)
  })

  it('未知の payload.kind は skip（HIGH #1 対策・remapPayload の default 節が無いため）', () => {
    const raw = {
      id: 'a', label: 'A', description: 'x', category: 'quake', durationMs: 0,
      baseTime: '2026-01-01T00:00:00Z',
      entries: [
        { offsetMs: 0, payload: { kind: 'unknown', data: {} } },
        { offsetMs: 100, payload: { kind: '', event: {} } },
        { offsetMs: 200, payload: { event: { kind: 'quake' } } }, // kind 自体が無い
      ],
    }
    const result = validateScenarioFile(raw)
    expect(result?.entries).toHaveLength(0)
  })

  it('メタ情報が壊れていれば null', () => {
    const raw = { id: '', label: 'A', description: 'x', category: 'quake', durationMs: 0, baseTime: 'x', entries: [] }
    expect(validateScenarioFile(raw)).toBeNull()
  })

  it('baseTime が空なら null', () => {
    const raw = { id: 'a', label: 'A', description: 'x', category: 'quake', durationMs: 0, baseTime: '', entries: [] }
    expect(validateScenarioFile(raw)).toBeNull()
  })

  it('entries が配列でなければ null', () => {
    const raw = { id: 'a', label: 'A', description: 'x', category: 'quake', durationMs: 0, baseTime: '2026-01-01T00:00:00Z', entries: 'not-array' }
    expect(validateScenarioFile(raw)).toBeNull()
  })

  it('壊れた entry を skip して valid entry だけ通す', () => {
    const raw = {
      id: 'a',
      label: 'A',
      description: 'x',
      category: 'quake',
      durationMs: 0,
      baseTime: '2026-01-01T00:00:00Z',
      entries: [
        { offsetMs: 0, payload: { kind: 'event', event: { kind: 'quake' } } },
        { offsetMs: 'not-number', payload: { kind: 'event', event: {} } },  // 数値でない
        { offsetMs: 100, payload: 'not-object' },                             // payload が object でない
        null,                                                                   // 非オブジェクト
        { offsetMs: NaN, payload: { kind: 'event', event: {} } },              // 非有限数
        { offsetMs: 200, payload: { kind: 'event', event: { kind: 'quake' } } },
      ],
    }
    const result = validateScenarioFile(raw)
    expect(result).not.toBeNull()
    expect(result?.entries).toHaveLength(2)
    expect(result?.entries[0].offsetMs).toBe(0)
    expect(result?.entries[1].offsetMs).toBe(200)
  })

  it('null / 非オブジェクトは null', () => {
    expect(validateScenarioFile(null)).toBeNull()
    expect(validateScenarioFile('string')).toBeNull()
    expect(validateScenarioFile(42)).toBeNull()
    expect(validateScenarioFile([])).toBeNull()
  })

  it('silent が boolean でなければ undefined として保持する', () => {
    const raw = {
      id: 'a', label: 'A', description: 'x', category: 'quake', durationMs: 0,
      baseTime: '2026-01-01T00:00:00Z',
      entries: [{ offsetMs: 0, payload: { kind: 'event', event: { kind: 'quake' } }, silent: 'yes' }],
    }
    const result = validateScenarioFile(raw)
    expect(result?.entries[0].silent).toBeUndefined()
  })
})
