import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isRegistered } from './kyoshin'

describe('isRegistered', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('200 は true（登録済み）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200 } as Response)
    expect(await isRegistered('west', 1704067200)).toBe(true)
  })

  it('403 は false（未登録）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 403 } as Response)
    expect(await isRegistered('west', 1704067200)).toBe(false)
  })

  it('404 は false（未登録）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 404 } as Response)
    expect(await isRegistered('west', 1704067200)).toBe(false)
  })

  it('500 は null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('502 は null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 502 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('429 は null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 429 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('その他 4xx（例: 418）も null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 418 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('west と east 両エッジで判定できる', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValue({ status: 200 } as Response)
    expect(await isRegistered('east', 1704067200)).toBe(true)
    // URL の一部にエッジが反映されているか確認
    expect(mockFetch).toHaveBeenCalled()
    const call = mockFetch.mock.calls[0][0] as string
    expect(call).toContain('east')
  })
})
