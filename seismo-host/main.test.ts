import { describe, expect, it } from 'vitest'

// **読み込むだけで待ち受けが開かないことも、この import が確かめている。**
// `main()` は「直接実行のときだけ走らせる」門の中にあるので、ここでは走らない
// （門が無ければ、このテストを走らせるたびに UDP の口が開く）。
import { readPort } from './main'

describe('readPort', () => {
  it('省略したら既定の口を使う', () => {
    expect(readPort(undefined)).toBe(50505)
    expect(readPort('')).toBe(50505)
  })

  it('10 進の値をそのまま使う', () => {
    expect(readPort('50505')).toBe(50505)
    expect(readPort('0')).toBe(0)
    expect(readPort('65535')).toBe(65535)
  })

  it('10 進でない表記は弾く', () => {
    // **`Number()` に任せると通ってしまう形。** `0x1F91` は 8081 として読めるので、
    // 打ち間違えに気づかないまま別の口で待ち受けることになる。
    expect(() => readPort('0x1F91')).toThrow(/読めない/)
    expect(() => readPort('1e3')).toThrow(/読めない/)
    expect(() => readPort('50505.0')).toThrow(/読めない/)
    expect(() => readPort(' 50505')).toThrow(/読めない/)
    expect(() => readPort('-1')).toThrow(/読めない/)
    expect(() => readPort('ポート')).toThrow(/読めない/)
  })

  it('範囲の外は別の文言で弾く', () => {
    // 書式は正しいので、打ち間違えの種類が違う。
    expect(() => readPort('70000')).toThrow(/範囲を超えている/)
  })
})
