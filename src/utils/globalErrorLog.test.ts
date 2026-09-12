// @vitest-environment jsdom
//
// React の外で投げられた例外を記録へ拾えていることを固定する。
// **画面には何も出さない**のが前提なので、ここで見るのは記録だけ。
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { installGlobalErrorLog, resetGlobalErrorLogForTest } from './globalErrorLog'

let errorSpy: { mock: { calls: unknown[][] } }

/** この仕組みが出した記録だけを数える。 */
function globalLogCount(): number {
  return errorSpy.mock.calls.filter((args) =>
    args.some((a) => typeof a === 'string' && a.includes('[global]')),
  ).length
}

/** 未処理の Promise 拒否を模す。jsdom は `PromiseRejectionEvent` を持たないので手で組む。 */
function dispatchRejection(reason: unknown): void {
  const e = new Event('unhandledrejection') as Event & { reason: unknown }
  e.reason = reason
  window.dispatchEvent(e)
}

// **リスナーの登録は 1 度だけ。** 各テストで呼ぶと二重に登録され、記録の件数が倍で数えられる。
beforeAll(() => {
  installGlobalErrorLog()
})

beforeEach(() => {
  resetGlobalErrorLogForTest()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('installGlobalErrorLog', () => {
  // 正: ブラウザの既定の出力にしか残らない例外を、アプリ時計の記録へ載せること。
  it('受け止められなかった例外を記録する', () => {
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', filename: 'a.ts', lineno: 12, error: new Error('boom') }),
    )
    expect(globalLogCount()).toBe(1)
  })

  it('処理されなかった Promise の失敗を記録する', () => {
    dispatchRejection(new Error('なにか'))
    expect(globalLogCount()).toBe(1)
  })

  // 安全弁: 毎フレーム投げ続ける経路があるので間引くこと。素通しにすると他の記録が読めなくなる。
  it('同じ内容が続いたら間引く', () => {
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'a.ts', lineno: 12 }))
    }
    expect(globalLogCount()).toBe(1)
  })

  // 対照: 間引きの単位は内容ごと。ひとまとめに黙らせると、別の原因が見えなくなる。
  it('内容が違えば間引かない', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'a.ts', lineno: 12 }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'b.ts', lineno: 34 }))
    dispatchRejection(new Error('別件'))
    expect(globalLogCount()).toBe(3)
  })

  // 安全弁: 間隔が空いたら数え直すこと。一度きりに絞ると、続いている障害が
  // 「一度失敗して直った」ように見える。
  it('間隔が空いたら同じ内容でも記録し直す', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let t = 1_000_000
    nowSpy.mockImplementation(() => t)
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'a.ts', lineno: 12 }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'a.ts', lineno: 12 }))
    expect(globalLogCount()).toBe(1)
    t += 10_001
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'a.ts', lineno: 12 }))
    expect(globalLogCount()).toBe(2)
  })

  // 安全弁: 毎回違う文面で投げ続ける経路があっても、覚える量に上限があること。
  it('覚える内容が上限を超えても記録は続く', () => {
    for (let i = 0; i < 200; i++) {
      window.dispatchEvent(new ErrorEvent('error', { message: `boom ${i}`, filename: 'a.ts', lineno: i }))
    }
    expect(globalLogCount()).toBe(200)
  })
})
