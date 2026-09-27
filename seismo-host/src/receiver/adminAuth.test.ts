import { describe, expect, it } from 'vitest'

import { checkAdminAuth } from './adminAuth'
import type { AdminAuthConfig, AdminAuthHeaders } from './adminAuth'

const TOKEN = 'super-secret-token'
const HOST = '127.0.0.1:50506'
const ORIGIN = 'https://console.example.ts.net'

function config(overrides: Partial<AdminAuthConfig> = {}): AdminAuthConfig {
  return {
    token: TOKEN,
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
    ...overrides,
  }
}

function headers(overrides: Partial<AdminAuthHeaders> = {}): AdminAuthHeaders {
  return {
    authorization: `Bearer ${TOKEN}`,
    host: HOST,
    origin: ORIGIN,
    ...overrides,
  }
}

describe('checkAdminAuth', () => {
  it('トークン・Host・Origin が全て一致すれば通す', () => {
    expect(checkAdminAuth(headers(), config())).toBeNull()
  })

  it('トークンが未設定なら not-configured を返す（Host・Origin が正しくても）', () => {
    expect(checkAdminAuth(headers(), config({ token: null }))).toEqual({ reason: 'not-configured' })
  })

  it('Authorization ヘッダが無ければ missing-authorization', () => {
    expect(checkAdminAuth(headers({ authorization: undefined }), config())).toEqual({
      reason: 'missing-authorization',
    })
  })

  it('Bearer 前置きが無ければ missing-authorization', () => {
    expect(checkAdminAuth(headers({ authorization: TOKEN }), config())).toEqual({
      reason: 'missing-authorization',
    })
  })

  it('Bearer の後ろが空白だけなら missing-authorization', () => {
    expect(checkAdminAuth(headers({ authorization: 'Bearer    ' }), config())).toEqual({
      reason: 'missing-authorization',
    })
  })

  it('トークンが違えば invalid-token', () => {
    expect(checkAdminAuth(headers({ authorization: 'Bearer wrong-token' }), config())).toEqual({
      reason: 'invalid-token',
    })
  })

  // **対照**: 長さが違うトークンでも `timingSafeEqual` の例外で落ちず、判定として返ること。
  it('トークンの長さが違っても例外を投げず invalid-token を返す', () => {
    expect(checkAdminAuth(headers({ authorization: 'Bearer x' }), config())).toEqual({
      reason: 'invalid-token',
    })
  })

  it('Origin が許可リストに無ければ origin-not-allowed', () => {
    expect(checkAdminAuth(headers({ origin: 'https://evil.example.com' }), config())).toEqual({
      reason: 'origin-not-allowed',
    })
  })

  it('Origin ヘッダが無ければ origin-not-allowed', () => {
    expect(checkAdminAuth(headers({ origin: undefined }), config())).toEqual({
      reason: 'origin-not-allowed',
    })
  })

  it('Host が許可リストに無ければ host-not-allowed', () => {
    expect(checkAdminAuth(headers({ host: 'evil.example.com' }), config())).toEqual({
      reason: 'host-not-allowed',
    })
  })

  it('Host ヘッダが無ければ host-not-allowed', () => {
    expect(checkAdminAuth(headers({ host: undefined }), config())).toEqual({
      reason: 'host-not-allowed',
    })
  })

  it('Host の大小文字は区別しない', () => {
    expect(checkAdminAuth(headers({ host: HOST.toUpperCase() }), config())).toBeNull()
  })

  it('Origin の大小文字は区別しない', () => {
    expect(checkAdminAuth(headers({ origin: ORIGIN.toUpperCase() }), config())).toBeNull()
  })

  // **安全弁**: 許可リストが空のままでは、正しいトークンを持っていても誰も通さない
  // （「運用者が明示するまで /api/* は誰にも開かない」という #313 の決定）。
  it('allowedOrigins が空なら、正しいトークン・Host でも通さない', () => {
    expect(checkAdminAuth(headers(), config({ allowedOrigins: [] }))).toEqual({
      reason: 'origin-not-allowed',
    })
  })

  it('allowedHosts が空なら、正しいトークン・Origin でも通さない', () => {
    expect(checkAdminAuth(headers(), config({ allowedHosts: [] }))).toEqual({
      reason: 'host-not-allowed',
    })
  })

  // **正・対照**: Origin・Host を先に見て、トークンは最後に見る（判定順序の固定）。
  // トークンが違っていても、Origin が先に間違っていれば origin-not-allowed のまま——
  // 「トークンの正誤だけを他の条件と切り離して確認できる」経路が無いことを確認する。
  it('Origin もトークンも違う場合、origin-not-allowed が先に返る（トークンの正誤には触れない）', () => {
    expect(
      checkAdminAuth(
        headers({ origin: 'https://evil.example.com', authorization: 'Bearer wrong-token' }),
        config(),
      ),
    ).toEqual({ reason: 'origin-not-allowed' })
  })

  it('Host もトークンも違う場合、host-not-allowed が先に返る', () => {
    expect(
      checkAdminAuth(headers({ host: 'evil.example.com', authorization: 'Bearer wrong-token' }), config()),
    ).toEqual({ reason: 'host-not-allowed' })
  })
})
