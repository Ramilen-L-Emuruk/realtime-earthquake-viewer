// 地図がスタイルを失ったかの判定。**MapLibre の型が実装より狭い**ことに乗っているので、
// 前提（`getStyle()` が undefined を返しうる）をテストで明示しておく。型検査では守れない。
import { describe, it, expect } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { isMapStyleGone } from './mapStyleGone'

describe('isMapStyleGone', () => {
  it('スタイルを返す地図は対象にしない', () => {
    // 中身は見ない。空のスタイルでも「地図はまだスタイルを持っている」。
    const map = { getStyle: () => ({}) } as unknown as MapLibreMap
    expect(isMapStyleGone(map)).toBe(false)
  })

  it('スタイルを返さなくなった地図は対象にする', () => {
    // `Map.remove()` は内部で `setStyle(null)` を呼び、以後 `getStyle()` は undefined を返す
    // （実装が `if (this.style) return this.style.serialize()`）。WebGL コンテキストロスト中も
    // 同じ形になる。型宣言は `StyleSpecification` なので、ここを取り違えても型検査では捕まらない。
    const map = { getStyle: () => undefined } as unknown as MapLibreMap
    expect(isMapStyleGone(map)).toBe(true)
  })
})
