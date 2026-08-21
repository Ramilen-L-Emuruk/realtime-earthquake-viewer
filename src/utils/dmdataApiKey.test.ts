// APIキーの文字種判定と Basic 認証ヘッダの単体テスト。
//
// 固定したいのは 2 つ。
//  1. 正規のキーを弾かないこと（実在のキーはピリオドを含む。英数だけに絞る「改善」を止める杭）
//  2. 通信に載せられない値が `btoa` へ到達しないこと（DOMException を外へ漏らさない）
import { describe, it, expect } from 'vitest'
import { isValidDmdataApiKey, authHeader, DmdataApiKeyError, DMDATA_API_KEY_INVALID_MESSAGE } from './dmdataApiKey'

describe('isValidDmdataApiKey', () => {
  it('英数のみのキーを受け付ける', () => {
    expect(isValidDmdataApiKey('abcdef0123456789ABCDEF')).toBe(true)
  })

  // 実在の DMDATA API キーにはピリオドが含まれる。ここを英数だけに絞ると
  // 正規のキーを弾いて「合っているのに繋がらない」状態を作る。
  it('ピリオドを含むキーを受け付ける（実在のキー形式）', () => {
    expect(isValidDmdataApiKey('a1b2c3.d4e5f6.g7h8i9')).toBe(true)
  })

  // 判定したいのは「btoa と HTTP ヘッダを壊さないか」だけなので、記号は一律で通す。
  // DMDATA がキーの書式を変えても、ここが原因で弾くことがないようにしておく。
  it('印字可能 ASCII の記号を受け付ける', () => {
    expect(isValidDmdataApiKey('-_~+/=')).toBe(true)
  })

  it('印字可能 ASCII の両端（0x21 と 0x7E）を受け付ける', () => {
    expect(isValidDmdataApiKey('!')).toBe(true)
    expect(isValidDmdataApiKey('~')).toBe(true)
  })

  it('空文字は受け付けない（未設定と同じく通信させない）', () => {
    expect(isValidDmdataApiKey('')).toBe(false)
  })

  it('日本語・全角文字を受け付けない', () => {
    expect(isValidDmdataApiKey('あいうえお')).toBe(false)
    expect(isValidDmdataApiKey('ａｂｃ')).toBe(false)
    // 日本語入力の変換途中で混ざる形（英数の後ろに未確定の文字が付く）。
    expect(isValidDmdataApiKey('abc123あ')).toBe(false)
  })

  it('空白・制御文字を受け付けない', () => {
    expect(isValidDmdataApiKey('abc def')).toBe(false)
    expect(isValidDmdataApiKey('abc\tdef')).toBe(false)
    expect(isValidDmdataApiKey('abc\ndef')).toBe(false)
    expect(isValidDmdataApiKey(' abc')).toBe(false)
    expect(isValidDmdataApiKey('abc ')).toBe(false)
  })

  // Latin-1 の範囲内なので btoa は通してしまうが、HTTP ヘッダ値には載せられない。
  // 判定の下限を「btoa が通るか」に緩めると、ここが素通りして fetch 側で落ちる。
  it('Latin-1 の範囲内でも非 ASCII は受け付けない', () => {
    expect(isValidDmdataApiKey('café')).toBe(false)
    expect(() => btoa('café:')).not.toThrow()
  })
})

describe('authHeader', () => {
  it('Basic 認証ヘッダを組む', () => {
    expect(authHeader('abc')).toBe('Basic ' + btoa('abc:'))
  })

  it('ピリオドを含むキーでもヘッダを組める', () => {
    const key = 'a1b2c3.d4e5f6'
    expect(authHeader(key)).toBe('Basic ' + btoa(key + ':'))
  })

  // btoa をそのまま呼んでいた頃は InvalidCharacterError（DOMException）が外へ出ていた。
  // 呼び出し元は理由を判別できず、WebSocket は認証エラーと区別できないまま再接続を繰り返した。
  it('不正な文字を含むキーは DmdataApiKeyError にする（DOMException を漏らさない）', () => {
    let caught: unknown
    try { authHeader('あ') } catch (err) { caught = err }

    expect(caught).toBeInstanceOf(DmdataApiKeyError)
    expect((caught as Error).name).toBe('DmdataApiKeyError')
    expect((caught as Error).message).toBe(DMDATA_API_KEY_INVALID_MESSAGE)
  })

  it('空文字も DmdataApiKeyError にする', () => {
    expect(() => authHeader('')).toThrow(DmdataApiKeyError)
  })

  // 安全弁: btoa 自体は通る値（非 ASCII だが Latin-1 内）でも、ヘッダに載せる前に止める。
  it('btoa が通る非 ASCII でも DmdataApiKeyError にする', () => {
    expect(() => authHeader('café')).toThrow(DmdataApiKeyError)
  })
})
