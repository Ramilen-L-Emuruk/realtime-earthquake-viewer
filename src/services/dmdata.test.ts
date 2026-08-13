// DMDATA WebSocket クライアントの単体テスト。
// WebSocket そのものは jsdom でもモックしないため、ここではモジュール公開の
// ユーティリティ（close code 判定）のみを対象にする。
import { describe, it, expect } from 'vitest'
import { isNonRecoverableCloseCode } from './dmdata'

describe('isNonRecoverableCloseCode', () => {
  it('1008 (Policy Violation) のみ非回復扱い', () => {
    expect(isNonRecoverableCloseCode(1008)).toBe(true)
  })

  it('1008 以外はすべて false（現状 1008 のみ判定対象）', () => {
    // 1000: Normal Closure, 1001: Going Away, 1005: No Status, 1006: Abnormal,
    // 1011: Internal Server Error, 4xxx: application-defined, 5xxx: 範囲外
    for (const code of [1000, 1001, 1005, 1006, 1011, 4000, 4001, 4409, 4999, 5000, 9999]) {
      expect(isNonRecoverableCloseCode(code)).toBe(false)
    }
  })
})
