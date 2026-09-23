// @vitest-environment jsdom
//
// 到達予想トークンの門が**時間の経過で閉じること**のテスト。
//
// トークン文字列が変わったときにしか検証しない作りだと、このアプリのように開きっぱなしで
// 使う端末では期限を過ぎても自前計算が有効なまま残り、**渡した相手の分を失効させる手段が
// 実質的に消える**（`scripts/sign-arrival-token.ts` は失効を仕組みの中核に据えている）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

/** 進められるサーバー同期時刻。偽のタイマーと一緒に進める。 */
let now = Date.parse('2026-09-22T00:00:00+09:00')
vi.mock('../utils/clock', () => ({
  serverNow: () => now,
  serverDate: () => new Date(now),
}))

// 本物の検証は `arrivalToken.test.ts` が見る。ここで見たいのは**呼び直しの張り方**なので、
// 「その時刻で有効か」だけを答える最小の代役へ差し替える。
const expByToken = new Map<string, number>()
const verify = vi.fn(async (token: string) => {
  const expMs = expByToken.get(token)
  if (expMs === undefined) return { valid: false, expMs: null }
  return now > expMs ? { valid: false, expMs: null } : { valid: true, expMs }
})
vi.mock('../utils/arrivalToken', () => ({ verifyArrivalToken: (t: string) => verify(t) }))

const { useArrivalTokenValid } = await import('./useArrivalToken')

const SEC = 1000
const DAY = 86_400 * SEC

beforeEach(() => {
  vi.useFakeTimers()
  verify.mockClear()
  expByToken.clear()
})
afterEach(() => { vi.useRealTimers() })

/** 検証（非同期）が落ち着くまで進める。 */
async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('useArrivalTokenValid', () => {
  it('有効なトークンは検証が済んだ時点で通る（正）', async () => {
    expByToken.set('ok', now + 10 * DAY)
    const h = renderHook(() => useArrivalTokenValid('ok'))
    // **検証が済むまでは閉じている。** 非同期なので、最初のレンダーでは必ず false。
    expect(h.result.current).toBe(false)
    await settle()
    expect(h.result.current).toBe(true)
  })

  it('失効時刻を過ぎたら、トークンを触らなくても閉じる（安全弁）', async () => {
    expByToken.set('soon', now + 10 * SEC)
    const h = renderHook(() => useArrivalTokenValid('soon'))
    await settle()
    expect(h.result.current).toBe(true)

    // 期限の手前では開いたまま（境界の手前）。
    await act(async () => { now += 9 * SEC; await vi.advanceTimersByTimeAsync(9 * SEC) })
    expect(h.result.current).toBe(true)

    // 期限を越えたら閉じる。張り直した再検証が発火して落ちる。
    await act(async () => { now += 3 * SEC; await vi.advanceTimersByTimeAsync(3 * SEC) })
    expect(h.result.current).toBe(false)
  })

  it('期限が遠いトークンでも再検証を撃ち続けない（安全弁）', async () => {
    // `setTimeout` は 2^31-1 ms（約 24.8 日）を超える遅延を 0 扱いで即発火する。
    // 素朴に「失効までの残り」を渡すと、既定 365 日の期限では毎回すぐ発火して回り続ける。
    expByToken.set('long', now + 365 * DAY)
    const h = renderHook(() => useArrivalTokenValid('long'))
    await settle()
    expect(h.result.current).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)

    await act(async () => { now += 60 * SEC; await vi.advanceTimersByTimeAsync(60 * SEC) })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(h.result.current).toBe(true)
  })

  it('未設定（空文字）は検証も走らせず閉じたまま（対照）', async () => {
    const h = renderHook(() => useArrivalTokenValid(''))
    await settle()
    expect(h.result.current).toBe(false)
    expect(verify).not.toHaveBeenCalled()
  })

  it('トークンを差し替えたら、新しい値の検証が済むまで閉じる（安全弁）', async () => {
    expByToken.set('ok', now + 10 * DAY)
    const h = renderHook(({ t }) => useArrivalTokenValid(t), { initialProps: { t: 'ok' } })
    await settle()
    expect(h.result.current).toBe(true)

    // 差し替えた瞬間は、前の値の結果を流用しない。
    h.rerender({ t: 'ng' })
    expect(h.result.current).toBe(false)
    await settle()
    expect(h.result.current).toBe(false)
  })
})
