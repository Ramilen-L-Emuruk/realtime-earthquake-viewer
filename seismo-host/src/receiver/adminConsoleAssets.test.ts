import { describe, expect, it } from 'vitest'

import { buildAdminConsoleAssets } from './adminConsoleAssets'

describe('buildAdminConsoleAssets（#313 段 C: 管理コンソール本体）', () => {
  it('正: html・js の両方を空でなく返す', () => {
    const assets = buildAdminConsoleAssets()
    expect(assets.html).toContain('<html')
    expect(assets.html).toContain('app.js')
    expect(assets.js.length).toBeGreaterThan(0)
  })

  it('正: js に app.ts の中身がバンドルされている', () => {
    const assets = buildAdminConsoleAssets()
    expect(assets.js).toContain('/api/stations')
    expect(assets.js).toContain('/api/boards')
  })

  it('対照: js は素の TypeScript のままではない（型注釈が除去されている）', () => {
    const assets = buildAdminConsoleAssets()
    // TypeScript 由来の型注釈構文はバンドル後の JS には残らない。
    expect(assets.js).not.toContain(': StationInfo')
  })

  it('安全弁: 複数回呼んでも同じ内容を返す（べき等）', () => {
    const first = buildAdminConsoleAssets()
    const second = buildAdminConsoleAssets()
    expect(first.html).toBe(second.html)
    expect(first.js).toBe(second.js)
  })
})
