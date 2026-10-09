import { describe, expect, it } from 'vitest'

import { detailMarkers, detailNote, detailTicks, detailWindow, DETAIL_MAX_MS, readEnvelope, wavesUrl } from './shakeWave'

const T0 = Date.UTC(2026, 9, 6, 4, 26, 4)

describe('detailWindow — 描く範囲', () => {
  it('正: 始まりの 10 秒前から、終わりの 20 秒後まで', () => {
    expect(detailWindow({ startMs: T0, endMs: T0 + 12_000 })).toEqual({ fromMs: T0 - 10_000, toMs: T0 + 32_000 })
  })

  it('安全弁: 長い揺れでも 10 分を超えない（/waves の上限）', () => {
    const w = detailWindow({ startMs: T0, endMs: T0 + 30 * 60_000 })
    expect(w.toMs - w.fromMs).toBe(DETAIL_MAX_MS)
    expect(DETAIL_MAX_MS).toBe(10 * 60_000)
  })

  it('安全弁: 端が整数でなくても、整数のミリ秒にしてから上限で切る（問い合わせで幅が上限を越えない）', () => {
    const w = detailWindow({ startMs: T0 + 0.4, endMs: T0 + 30 * 60_000 + 0.7 })
    expect(Number.isInteger(w.fromMs) && Number.isInteger(w.toMs)).toBe(true)
    expect(w.toMs - w.fromMs).toBeLessThanOrEqual(DETAIL_MAX_MS)
  })
})

describe('wavesUrl', () => {
  it('観測点・範囲・列の数を問い合わせに載せる（観測点の ID はエスケープする）', () => {
    expect(wavesUrl('station 1/a', 1000, 2000, 600)).toBe('/waves?station=station+1%2Fa&from=1000&to=2000&columns=600')
  })

  it('安全弁: 範囲は整数のミリ秒で渡す（小数はホストが bad-range で弾く）', () => {
    expect(wavesUrl('s', 1000.4, 2000.6, 10.2)).toBe('/waves?station=s&from=1000&to=2001&columns=10')
  })
})

function envelopeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stationId: 's',
    stationKnown: true,
    fromMs: T0,
    toMs: T0 + 3000,
    filesRead: 1,
    filesMissing: 0,
    filesFailed: 0,
    skippedBytes: 0,
    truncated: false,
    columnSpanMs: 1000,
    columns: [{ min: [-1, -2, -3], max: [1, 2, 3], minMembers: 3 }, null, { min: [0, 0, 0], max: [0.5, 0.5, 0.5], minMembers: 2 }],
    hasAnyValue: true,
    peakGal: 3,
    ...overrides,
  }
}

describe('readEnvelope — 列ごとにまとめた波形を読む', () => {
  it('正: 列と欠けた列（null）をそのまま読む', () => {
    const e = readEnvelope(envelopeJson())
    expect(e?.columns).toHaveLength(3)
    expect(e?.columns[1]).toBeNull()
    expect(e?.columns[0]).toEqual({ min: [-1, -2, -3], max: [1, 2, 3] })
    expect(e?.partial).toBe(false)
  })

  it('正: 読めなかったファイル・打ち切り・途中で読まなかったバイトがあれば一部欠け', () => {
    expect(readEnvelope(envelopeJson({ filesFailed: 1 }))?.partial).toBe(true)
    expect(readEnvelope(envelopeJson({ skippedBytes: 12 }))?.partial).toBe(true)
    expect(readEnvelope(envelopeJson({ truncated: true }))?.partial).toBe(true)
  })

  it('対照: ファイルが無かっただけ（記録していない時）は一部欠けと言わない', () => {
    expect(readEnvelope(envelopeJson({ filesMissing: 1 }))?.partial).toBe(false)
  })

  it('安全弁: 読めなかった量の欄が無ければ応答ごと読めない（0 と見なして「全部読めた」にしない）', () => {
    const { filesFailed: _a, ...noFailed } = envelopeJson()
    const { truncated: _b, ...noTruncated } = envelopeJson()
    expect(readEnvelope(noFailed)).toBeNull()
    expect(readEnvelope(noTruncated)).toBeNull()
  })

  it('正（2026-10-09）: 列の中で 1 成分だけ欠けていれば（null）、その成分だけ NaN にして読む', () => {
    const e = readEnvelope(envelopeJson({ columns: [{ min: [-1, -2, null], max: [1, 2, null], minMembers: 2 }] }))
    expect(e?.columns[0]?.min[0]).toBe(-1)
    expect(e?.columns[0]?.min[2]).toBeNaN()
  })

  it('安全弁: 列の形が違えば応答ごと読めない（欠けた列と取り違えない）', () => {
    expect(readEnvelope(envelopeJson({ columns: [{ min: [1, 2], max: [1, 2, 3] }] }))).toBeNull()
    expect(readEnvelope(envelopeJson({ columns: 'x' }))).toBeNull()
    expect(readEnvelope(envelopeJson({ columnSpanMs: 0 }))).toBeNull()
  })
})

describe('detailNote', () => {
  it('値を持つ列が 1 つも無ければ「この区間の波形は残っていない」', () => {
    expect(detailNote(readEnvelope(envelopeJson({ hasAnyValue: false, columns: [null, null] }))!)).toBe(
      'この区間の波形は残っていない',
    )
  })

  it('一部だけ読めなかったら「読めなかった部分がある」', () => {
    expect(detailNote(readEnvelope(envelopeJson({ filesFailed: 1 }))!)).toBe('読めなかった部分がある')
  })

  it('対照: 全部読めていれば何も言わない', () => {
    expect(detailNote(readEnvelope(envelopeJson())!)).toBeNull()
  })
})

describe('detailTicks — 横軸の目盛り（始まりからの秒）', () => {
  it('正: 始まりを 0 として秒で刻む（前は −）', () => {
    const ticks = detailTicks(T0 - 10_000, T0 + 32_000, T0, 6)
    expect(ticks.map((t) => t.label)).toEqual(['-10s', '0s', '+10s', '+20s', '+30s'])
    expect(ticks[1].atMs).toBe(T0)
  })

  it('対照: 始まりが秒の途中でも、始まりからの切りのいい秒に置く（時計の秒には揃えない）', () => {
    const start = T0 + 300
    const ticks = detailTicks(start - 10_000, start + 20_000, start, 4)
    expect(ticks.every((t) => (t.atMs - start) % 10_000 === 0)).toBe(true)
  })
})

describe('detailMarkers — 縦に引く線', () => {
  const win = { fromMs: T0 - 10_000, toMs: T0 + 32_000 }

  it('正: 始まり・終わり・S・P を引く', () => {
    const m = detailMarkers({ startMs: T0, endMs: T0 + 12_000, sMs: T0 + 3_000, pMs: T0 + 500 }, win)
    expect(m.map((x) => x.label)).toEqual(['始まり', '終わり', 'S', 'P'])
  })

  it('対照: 拾えなかった S・P は引かない', () => {
    const m = detailMarkers({ startMs: T0, endMs: T0 + 12_000, sMs: null, pMs: null }, win)
    expect(m.map((x) => x.label)).toEqual(['始まり', '終わり'])
  })

  it('安全弁: 範囲の外の線は引かない（10 分で切った長い揺れの終わり）', () => {
    const m = detailMarkers({ startMs: T0, endMs: T0 + 3_600_000, sMs: null, pMs: null }, win)
    expect(m.map((x) => x.label)).toEqual(['始まり'])
  })
})
