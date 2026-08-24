// APIキーの文字種判定と Basic 認証ヘッダの単体テスト。
//
// 固定したいのは 2 つ。
//  1. 正規のキーを弾かないこと（実在のキーはピリオドを含む。英数だけに絞る「改善」を止める杭）
//  2. 通信に載せられない値が `btoa` へ到達しないこと（DOMException を外へ漏らさない）
import { describe, it, expect } from 'vitest'
import {
  isValidDmdataApiKey, authHeader, DmdataApiKeyError,
  dmdataApiKeyProblem, dmdataApiKeyMessage,
  DMDATA_API_KEY_INVALID_MESSAGE, DMDATA_API_KEY_MISSING_MESSAGE,
} from './dmdataApiKey'

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

  // 未設定と不正は別の文言で投げる。この関数を直に叩く経路（リプレイの取得）は手前で未設定を
  // 弾いていないため、ここの文言がそのままログへ出る。同じ文にすると、一度も入力していない人に
  // 「使用できない文字が含まれています」と告げることになる（2026-08-24 に実際に起きた）。
  it('空文字は「未設定」として DmdataApiKeyError にする', () => {
    let caught: unknown
    try { authHeader('') } catch (err) { caught = err }

    expect(caught).toBeInstanceOf(DmdataApiKeyError)
    expect((caught as DmdataApiKeyError).problem).toBe('missing')
    expect((caught as Error).message).toBe(DMDATA_API_KEY_MISSING_MESSAGE)
  })

  // 安全弁: btoa 自体は通る値（非 ASCII だが Latin-1 内）でも、ヘッダに載せる前に止める。
  it('btoa が通る非 ASCII でも DmdataApiKeyError にする', () => {
    expect(() => authHeader('café')).toThrow(DmdataApiKeyError)
  })
})

// 未設定と不正の言い分け。文言を選ぶ場所を 1 箇所（dmdataApiKeyMessage）に集約しているので、
// 「どちらの理由か」を返す判定と、その理由に対応する文言の両方を固定する。
describe('dmdataApiKeyProblem', () => {
  it('[正] 空文字は missing', () => {
    expect(dmdataApiKeyProblem('')).toBe('missing')
  })

  it('[正] 印字可能 ASCII 以外を含むキーは invalid', () => {
    expect(dmdataApiKeyProblem('abc123あ')).toBe('invalid')
    expect(dmdataApiKeyProblem('café')).toBe('invalid')
  })

  // 空白だけのキーは「未設定」ではなく「不正」。利用者は何かを入力しており（貼り付けの失敗など）、
  // 入れた値が通信に載せられないことを伝える方が手掛かりになる。
  it('[対照] 空白だけのキーは invalid（何かを入れた状態なので未設定ではない）', () => {
    expect(dmdataApiKeyProblem(' ')).toBe('invalid')
    expect(dmdataApiKeyProblem('   ')).toBe('invalid')
  })

  it('[正] 使えるキーは null', () => {
    expect(dmdataApiKeyProblem('a1b2c3.d4e5f6')).toBeNull()
  })

  // 安全弁: 理由を問わない既存の呼び出し側（7 箇所）の意味を変えていないこと。
  //
  // **`dmdataApiKeyProblem` の戻り値と比べてはならない。** 実装がそれへの委譲なので、委譲している
  // 限り何を変えても真になる（＝何も守らない）。判定の中身をここへ独立して置き、受け付ける集合が
  // 言い分けの導入前と変わっていないことを確かめる。
  it('[安全弁] 受け付ける集合は言い分けの導入前と同じ（判定式を独立に置いて突き合わせる）', () => {
    // `!`〜`~` は 0x21〜0x7E と同じ範囲（実装の正規表現とは別の書き方にして、写し取りを避ける）。
    const acceptedBefore = (key: string) => /^[!-~]+$/.test(key)
    const keys = ['', ' ', '   ', 'あ', 'ａｂｃ', 'café', 'a1b2c3.d4e5f6', '!', '~', 'abc123あ', 'abc def', 'abc	def']
    for (const key of keys) {
      expect(isValidDmdataApiKey(key)).toBe(acceptedBefore(key))
    }
  })
})

describe('dmdataApiKeyMessage', () => {
  it('理由ごとに別の文言を返す', () => {
    expect(dmdataApiKeyMessage('missing')).toBe(DMDATA_API_KEY_MISSING_MESSAGE)
    expect(dmdataApiKeyMessage('invalid')).toBe(DMDATA_API_KEY_INVALID_MESSAGE)
  })

  // 文言が同じだと言い分けた意味が消える。取り違えを機械的に止める杭。
  it('2 つの文言は別物', () => {
    expect(DMDATA_API_KEY_MISSING_MESSAGE).not.toBe(DMDATA_API_KEY_INVALID_MESSAGE)
  })
})
