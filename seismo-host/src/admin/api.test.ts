// `apiFetch` 自体は `fetch`・`localStorage` に依存するため対象外（DOM 依存部分は
// ブラウザで確認する）。ここでは DOM に依存しない純関数だけをテストする。

import { describe, expect, it } from 'vitest'
import { ApiError, describeAdminAuthFailure } from './api'

describe('describeAdminAuthFailure', () => {
  it('invalid-token を「トークンが違う」の文言へ変える', () => {
    expect(describeAdminAuthFailure('invalid-token')).toBe('トークンが違う')
  })

  it('host-not-allowed を SEISMO_ADMIN_ALLOWED_HOSTS への言及付きの文言へ変える', () => {
    const message = describeAdminAuthFailure('host-not-allowed')
    expect(message).toContain('SEISMO_ADMIN_ALLOWED_HOSTS')
  })

  it('origin-not-allowed を SEISMO_ADMIN_ALLOWED_ORIGINS への言及付きの文言へ変える', () => {
    const message = describeAdminAuthFailure('origin-not-allowed')
    expect(message).toContain('SEISMO_ADMIN_ALLOWED_ORIGINS')
  })

  it('missing-authorization・not-configured も日本語文言を返す', () => {
    expect(describeAdminAuthFailure('missing-authorization')).not.toBeNull()
    expect(describeAdminAuthFailure('not-configured')).not.toBeNull()
  })

  it('認証と無関係な理由コードは null を返す（呼び出し側が別の文言にフォールバックできる）', () => {
    expect(describeAdminAuthFailure('station-in-use')).toBeNull()
  })
})

describe('ApiError', () => {
  it('body.error があればそれを message にする', () => {
    const error = new ApiError(400, { error: 'bad-request' })
    expect(error.message).toBe('bad-request')
  })

  it('body が null なら HTTP ステータスを message にする', () => {
    const error = new ApiError(500, null)
    expect(error.message).toBe('HTTP 500')
  })
})
