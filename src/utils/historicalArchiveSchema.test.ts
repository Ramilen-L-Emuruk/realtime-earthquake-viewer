import { describe, it, expect } from 'vitest'
import { validateHistoricalArchiveIndex, validateHistoricalArchiveFile } from './historicalArchiveSchema'

describe('validateHistoricalArchiveIndex', () => {
  it('正常な index.json を全件通す', () => {
    const raw = [
      { id: 'a', label: 'A', description: 'test', from: '2011-03-11T05:45:00Z', to: '2011-03-11T06:00:00Z' },
    ]
    const result = validateHistoricalArchiveIndex(raw)
    expect(result.valid).toHaveLength(1)
    expect(result.skipped).toBe(0)
    expect(result.malformed).toBe(false)
  })

  it('壊れた要素を skip して残りを通す', () => {
    const raw = [
      { id: 'a', label: 'A', description: 'test', from: '2011-03-11T05:45:00Z', to: '2011-03-11T06:00:00Z' },
      { id: '', label: 'empty id', description: '', from: '2011-01-01T00:00:00Z', to: '2011-01-02T00:00:00Z' },
      { id: 'c', label: 'C', description: 'test', from: 'not-a-date', to: '2011-01-02T00:00:00Z' },
      // from >= to（範囲が逆転・ゼロ幅）
      { id: 'd', label: 'D', description: 'test', from: '2011-01-02T00:00:00Z', to: '2011-01-01T00:00:00Z' },
    ]
    const result = validateHistoricalArchiveIndex(raw)
    expect(result.valid).toHaveLength(1)
    expect(result.valid[0].id).toBe('a')
    expect(result.skipped).toBe(3)
    expect(result.malformed).toBe(false)
  })

  it('配列でなければ malformed=true で空を返す', () => {
    for (const bad of [null, undefined, { foo: 1 }, 'string', 42]) {
      const r = validateHistoricalArchiveIndex(bad)
      expect(r.valid).toEqual([])
      expect(r.skipped).toBe(0)
      expect(r.malformed).toBe(true)
    }
  })

  it('空配列は valid=[]・malformed=false（正常な空リスト）', () => {
    const result = validateHistoricalArchiveIndex([])
    expect(result.valid).toEqual([])
    expect(result.malformed).toBe(false)
  })
})

describe('validateHistoricalArchiveFile', () => {
  const meta = { id: 'a', label: 'A', description: 'test', from: '2011-03-11T05:45:00Z', to: '2011-03-11T06:00:00Z' }
  const validEew = { kind: 'eew', areas: [{ pref: '宮城県', name: '宮城県北部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null }] }
  const validQuake = { kind: 'quake', earthquake: { maxScale: 70 }, points: [{ pref: '宮城県', addr: '宮城県北部', isArea: true, scale: 70 }] }
  const validTsunami = { kind: 'tsunami', areas: [{ grade: 'MajorWarning', immediate: true, name: '宮城県' }] }

  it('正常なアーカイブファイルを返す', () => {
    const raw = {
      ...meta,
      entries: [
        { time: '2011-03-11T05:46:27Z', payload: { kind: 'event', event: validEew } },
        { time: '2011-03-11T05:49:00Z', payload: { kind: 'event', event: validTsunami }, silent: true },
        { time: '2011-03-11T05:50:00Z', payload: { kind: 'nankaiCommentary', data: {} } },
      ],
    }
    const result = validateHistoricalArchiveFile(raw)
    expect(result).not.toBeNull()
    expect(result?.file.entries).toHaveLength(3)
    expect(result?.file.entries[1].silent).toBe(true)
    expect(result?.skipped).toBe(0)
  })

  it('メタ情報が壊れていれば null', () => {
    expect(validateHistoricalArchiveFile({ ...meta, id: '', entries: [] })).toBeNull()
    expect(validateHistoricalArchiveFile({ ...meta, from: 'not-a-date', entries: [] })).toBeNull()
    expect(validateHistoricalArchiveFile({ ...meta, from: meta.to, to: meta.from, entries: [] })).toBeNull()
  })

  it('entries が配列でなければ null', () => {
    expect(validateHistoricalArchiveFile({ ...meta, entries: 'not-array' })).toBeNull()
  })

  it('time が不正な entry・payload の判別子/サブフィールドが欠落した entry は skip し、件数を返す', () => {
    const raw = {
      ...meta,
      entries: [
        { time: 'not-a-date', payload: { kind: 'event', event: validEew } },
        { time: '2011-03-11T05:46:27Z', payload: { kind: 'event' } }, // event 欠落
        { time: '2011-03-11T05:46:27Z', payload: { kind: 'unknown', event: validEew } }, // 未知の kind
        { time: '2011-03-11T05:46:27Z', payload: 'not-object' },
        null,
        { time: '2011-03-11T05:47:00Z', payload: { kind: 'event', event: validEew } }, // 正常
      ],
    }
    const result = validateHistoricalArchiveFile(raw)
    expect(result).not.toBeNull()
    expect(result?.file.entries).toHaveLength(1)
    expect(result?.file.entries[0].time).toBe('2011-03-11T05:47:00Z')
    expect(result?.skipped).toBe(5)
  })

  it('null / 非オブジェクトは null', () => {
    expect(validateHistoricalArchiveFile(null)).toBeNull()
    expect(validateHistoricalArchiveFile('string')).toBeNull()
    expect(validateHistoricalArchiveFile(42)).toBeNull()
    expect(validateHistoricalArchiveFile([])).toBeNull()
  })

  it('silent が boolean でなければ undefined として保持する', () => {
    const raw = {
      ...meta,
      entries: [{ time: '2011-03-11T05:46:27Z', payload: { kind: 'event', event: validEew }, silent: 'yes' }],
    }
    const result = validateHistoricalArchiveFile(raw)
    expect(result?.file.entries[0].silent).toBeUndefined()
  })

  // CRITICAL対策: event/data の中身（震度値・警報区分）の値域も検証する。
  // このアプリに ErrorBoundary が無いため、中間値・未知の区分がそのまま state に乗ると
  // カード・バッジの表示が壊れる（このファイルは capture-test-scenario.ts のような機械生成
  // ではなく手作業で書き起こすため、typo が混入しやすい）。
  describe('AppEvent の値域検証', () => {
    it('quake: maxScale が IntensityScale に無い値（中間値）なら skip', () => {
      const raw = {
        ...meta,
        entries: [{ time: '2011-03-11T05:46:27Z', payload: { kind: 'event', event: { ...validQuake, earthquake: { maxScale: 35 } } } }],
      }
      expect(validateHistoricalArchiveFile(raw)?.file.entries).toHaveLength(0)
    })

    it('quake: points[].scale が不正なら skip', () => {
      const raw = {
        ...meta,
        entries: [{
          time: '2011-03-11T05:46:27Z',
          payload: { kind: 'event', event: { ...validQuake, points: [{ pref: '宮城県', addr: '宮城県北部', isArea: true, scale: 25 }] } },
        }],
      }
      expect(validateHistoricalArchiveFile(raw)?.file.entries).toHaveLength(0)
    })

    it('eew: areas[].scaleFrom/scaleTo が不正なら skip', () => {
      const raw = {
        ...meta,
        entries: [{
          time: '2011-03-11T05:46:27Z',
          payload: { kind: 'event', event: { kind: 'eew', areas: [{ pref: '宮城県', name: '宮城県北部', scaleFrom: 40, scaleTo: 99, kindCode: '10', arrivalTime: null }] } },
        }],
      }
      expect(validateHistoricalArchiveFile(raw)?.file.entries).toHaveLength(0)
    })

    it('tsunami: areas が欠落・非配列なら skip', () => {
      const raw = {
        ...meta,
        entries: [
          { time: '2011-03-11T05:46:27Z', payload: { kind: 'event', event: { kind: 'tsunami' } } },
          { time: '2011-03-11T05:47:00Z', payload: { kind: 'event', event: { kind: 'tsunami', areas: 'not-array' } } },
        ],
      }
      expect(validateHistoricalArchiveFile(raw)?.file.entries).toHaveLength(0)
    })

    it('tsunami: areas[].grade が未知の区分なら skip', () => {
      const raw = {
        ...meta,
        entries: [{
          time: '2011-03-11T05:46:27Z',
          payload: { kind: 'event', event: { kind: 'tsunami', areas: [{ grade: 'Unknown区分', immediate: true, name: '宮城県' }] } },
        }],
      }
      expect(validateHistoricalArchiveFile(raw)?.file.entries).toHaveLength(0)
    })

    it('event.kind が quake/eew/tsunami のいずれでもなければ skip', () => {
      const raw = {
        ...meta,
        entries: [{ time: '2011-03-11T05:46:27Z', payload: { kind: 'event', event: { kind: 'unknown-kind' } } }],
      }
      expect(validateHistoricalArchiveFile(raw)?.file.entries).toHaveLength(0)
    })

    it('妥当な quake/eew/tsunami は通す', () => {
      const raw = {
        ...meta,
        entries: [
          { time: '2011-03-11T05:46:00Z', payload: { kind: 'event', event: validQuake } },
          { time: '2011-03-11T05:46:27Z', payload: { kind: 'event', event: validEew } },
          { time: '2011-03-11T05:49:00Z', payload: { kind: 'event', event: validTsunami } },
        ],
      }
      expect(validateHistoricalArchiveFile(raw)?.file.entries).toHaveLength(3)
    })
  })
})
