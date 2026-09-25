// @vitest-environment jsdom
//
// 到達予想トークンの門が**時間の経過で閉じること**のテスト。
//
// トークン文字列が変わったときにしか検証しない作りだと、このアプリのように開きっぱなしで
// 使う端末では期限を過ぎても自前計算が有効なまま残り、**渡した相手の分を失効させる手段が
// 実質的に消える**（`scripts/sign-arrival-token.ts` は失効を仕組みの中核に据えている）。
//
// あわせて、**設定タブへ出す材料（検証中か・通らなかった理由）が門を緩めないこと**も見る。
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
// **失効では `expMs` も返す**（本物と同じ形。画面が「いつ切れたか」を出せるようにするため）。
const expByToken = new Map<string, number>()
const verify = vi.fn(async (token: string) => {
  const expMs = expByToken.get(token)
  if (expMs === undefined) return { valid: false, expMs: null, problem: 'signature' as const }
  return now > expMs
    ? { valid: false, expMs, problem: 'expired' as const }
    : { valid: true, expMs, problem: null }
})
vi.mock('../utils/arrivalToken', () => ({ verifyArrivalToken: (t: string) => verify(t) }))

const { useArrivalTokenCheck } = await import('./useArrivalToken')

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

describe('useArrivalTokenCheck', () => {
  it('有効なトークンは検証が済んだ時点で通る（正）', async () => {
    expByToken.set('ok', now + 10 * DAY)
    const h = renderHook(() => useArrivalTokenCheck('ok'))
    // **検証が済むまでは閉じている。** 非同期なので、最初のレンダーでは必ず偽。
    expect(h.result.current.valid).toBe(false)
    await settle()
    expect(h.result.current.valid).toBe(true)
  })

  it('失効時刻を過ぎたら、トークンを触らなくても閉じる（安全弁）', async () => {
    expByToken.set('soon', now + 10 * SEC)
    const h = renderHook(() => useArrivalTokenCheck('soon'))
    await settle()
    expect(h.result.current.valid).toBe(true)

    // 期限の手前では開いたまま（境界の手前）。
    await act(async () => { now += 9 * SEC; await vi.advanceTimersByTimeAsync(9 * SEC) })
    expect(h.result.current.valid).toBe(true)

    // 期限を越えたら閉じる。張り直した再検証が発火して落ちる。
    await act(async () => { now += 3 * SEC; await vi.advanceTimersByTimeAsync(3 * SEC) })
    expect(h.result.current.valid).toBe(false)
  })

  it('期限が遠いトークンでも再検証を撃ち続けない（安全弁）', async () => {
    // `setTimeout` は 2^31-1 ms（約 24.8 日）を超える遅延を 0 扱いで即発火する。
    // 素朴に「失効までの残り」を渡すと、既定 365 日の期限では毎回すぐ発火して回り続ける。
    expByToken.set('long', now + 365 * DAY)
    const h = renderHook(() => useArrivalTokenCheck('long'))
    await settle()
    expect(h.result.current.valid).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)

    await act(async () => { now += 60 * SEC; await vi.advanceTimersByTimeAsync(60 * SEC) })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(h.result.current.valid).toBe(true)
  })

  it('未設定（空文字）は検証も走らせず閉じたまま（対照）', async () => {
    const h = renderHook(() => useArrivalTokenCheck(''))
    await settle()
    expect(h.result.current.valid).toBe(false)
    expect(verify).not.toHaveBeenCalled()
  })

  it('空白だけの入力は未設定と同じに扱う（対照）', async () => {
    // 検証の側も前後の空白を落とすので結果は同じになるが、そこへ渡すと
    // **一瞬「確認中」が出る**（触っていない利用者の画面に出したくない表示）。
    const h = renderHook(() => useArrivalTokenCheck('   '))
    expect(h.result.current.checking).toBe(false)
    expect(h.result.current.problem).toBe('empty')
    await settle()
    expect(verify).not.toHaveBeenCalled()
  })

  it('前後の空白を足しただけでは検証を張り直さない（安全弁）', async () => {
    // 張り直すと、その瞬間だけ門が閉じて自前計算が止まる（打鍵のたびに起きる）。
    expByToken.set('ok', now + 10 * DAY)
    const h = renderHook(({ t }) => useArrivalTokenCheck(t), { initialProps: { t: 'ok' } })
    await settle()
    expect(h.result.current.valid).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)

    h.rerender({ t: ' ok ' })
    expect(h.result.current.valid).toBe(true)
    await settle()
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('トークンを差し替えたら、新しい値の検証が済むまで閉じる（安全弁）', async () => {
    expByToken.set('ok', now + 10 * DAY)
    const h = renderHook(({ t }) => useArrivalTokenCheck(t), { initialProps: { t: 'ok' } })
    await settle()
    expect(h.result.current.valid).toBe(true)

    // 差し替えた瞬間は、前の値の結果を流用しない。
    h.rerender({ t: 'ng' })
    expect(h.result.current.valid).toBe(false)
    await settle()
    expect(h.result.current.valid).toBe(false)
  })

  it('検証が済むまでは「確認中」で、理由をまだ出さない（正）', async () => {
    // 画面はこれを見て「確認中」と出す。**失敗と区別できないと、貼った直後に
    // 「使えないキー」と読める表示が一瞬出る。**
    expByToken.set('ok', now + 10 * DAY)
    const h = renderHook(() => useArrivalTokenCheck('ok'))
    expect(h.result.current.checking).toBe(true)
    expect(h.result.current.problem).toBe(null)
    await settle()
    expect(h.result.current.checking).toBe(false)
    expect(h.result.current.problem).toBe(null)
  })

  it('未設定は確認中にせず理由を empty にする（対照）', async () => {
    // 触っていない利用者の画面に「確認中」も「使えません」も出さないための印。
    const h = renderHook(() => useArrivalTokenCheck(''))
    expect(h.result.current.checking).toBe(false)
    expect(h.result.current.problem).toBe('empty')
    await settle()
    expect(h.result.current.problem).toBe('empty')
  })

  it('検証が例外で終わっても「確認中」で固まらない（安全弁）', async () => {
    // **いまの `verifyArrivalToken` は reject しない**（内部の try で囲い `problem: 'error'` を
    // 返す）。この約束は型でもテストでも強制されていないので、将来 try の外に `await` が
    // 1 つ増えれば `.then` へ到達せず、**永久に「確認中」のまま**になる（門は閉じたままだが、
    // 画面から理由が消えて記録も出ない）。それを踏んでも表示が進むことを固定する。
    verify.mockRejectedValueOnce(new Error('boom'))
    const h = renderHook(() => useArrivalTokenCheck('ok'))
    expect(h.result.current.checking).toBe(true)
    await settle()
    expect(h.result.current.checking).toBe(false)
    expect(h.result.current.valid).toBe(false)
    expect(h.result.current.problem).toBe('error')
  })

  it('通らなかった理由と失効時刻を返しても門は開かない（安全弁）', async () => {
    // 理由は画面へ出すためのもの。**`valid` だけが門**で、理由や期限が付いても偽のまま。
    const expMs = now - 1 * DAY
    expByToken.set('gone', expMs)
    const h = renderHook(() => useArrivalTokenCheck('gone'))
    await settle()
    expect(h.result.current.valid).toBe(false)
    expect(h.result.current.problem).toBe('expired')
    // 失効では期限も返る（画面が「いつ切れたか」を出せる）。
    expect(h.result.current.expMs).toBe(expMs)
  })
})
