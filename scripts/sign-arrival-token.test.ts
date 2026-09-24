// @vitest-environment node
//
// `.env.local` から到達予想キーの値を読む述語のテスト。
//
// **空の行を値として返すと、発行済みのトークンが全部無効になりうる。** `--init` は
// 「秘密鍵がまだ無いか」をこの述語で判定しているので、空の `TOKEN_SIGNING_PRIVATE_KEY=`
// を読んで真を返せないと鍵を作り直し、そのとき公開鍵も変わるため既に渡した分が失効する。
// 雛形（`.env.example`）をコピーして `.env.local` を作る運用があるので、空の行は現実に生まれうる。
//
// **値のある行が 2 つあるときは、黙って選ばずに落とす。** 署名鍵を取り違えても
// トークンは出力されるので、「発行できたのに検証に通らない」という形でしか表に出ない。
import { describe, it, expect } from 'vitest'
import { readEnvVarFromText, parseDaysArg } from './sign-arrival-token'

const KEY = 'TOKEN_SIGNING_PRIVATE_KEY'

describe('readEnvVarFromText', () => {
  it('値のある行を読む（正）', () => {
    expect(readEnvVarFromText(`${KEY}=abc123`, KEY)).toBe('abc123')
  })

  it('空の行が先にあっても、後ろへ追記された本物に辿り着く（正・この述語の主目的）', () => {
    // 雛形をコピーして作った `.env.local` へ `--init` が末尾へ追記した形。
    // **最初の一致で止まると空文字が返り、`--init` が鍵を作り直す。**
    const text = [
      `${KEY}=`,
      '',
      '# 到達予想トークンの署名鍵（アプリは読まない・配らない）',
      `${KEY}=real-key`,
    ].join('\n')
    expect(readEnvVarFromText(text, KEY)).toBe('real-key')
  })

  it('値のある行が 1 つなら、空の行が前後に何行あっても読める（対照）', () => {
    const text = [`${KEY}=`, `${KEY}=real-key`, `${KEY}=   `].join('\n')
    expect(readEnvVarFromText(text, KEY)).toBe('real-key')
  })

  it('値のある行が 2 つあったら落とす（安全弁）', () => {
    // 手で鍵を追記して古い行を消し忘れた `.env.local` がこの形。**黙ってどちらかを選ぶと、
    // 署名鍵を取り違えてもトークンは出力される**ので、「発行できたのに検証に通らない」という
    // 形でしか表に出ない（例外もログも出ない）。曖昧なまま進まず、ここで止める。
    const text = [`${KEY}=first`, `${KEY}=second`].join('\n')
    expect(() => readEnvVarFromText(text, KEY)).toThrow(/2 行あります/)
  })

  it('落ちるときも値は出さない（安全弁）', () => {
    // 秘密鍵の取り違えを知らせるメッセージが、その秘密鍵を漏らしては意味が無い。
    const text = [`${KEY}=secret-a`, `${KEY}=secret-b`].join('\n')
    let message = ''
    try {
      readEnvVarFromText(text, KEY)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('secret-')
  })

  it('空の行だけなら「無い」と答える（安全弁）', () => {
    // ここで空文字を返すと、`--init` は「もう鍵がある」と誤判定して初回の作成を拒む。
    expect(readEnvVarFromText(`${KEY}=`, KEY)).toBe(null)
    expect(readEnvVarFromText(`${KEY}=   `, KEY)).toBe(null)
  })

  it('その変数が無ければ null（安全弁）', () => {
    expect(readEnvVarFromText('DMDATA_API_KEY=xyz', KEY)).toBe(null)
    expect(readEnvVarFromText('', KEY)).toBe(null)
  })

  it('前後の空白と等号の周りの空白を許す（正）', () => {
    expect(readEnvVarFromText(`  ${KEY} = spaced  `, KEY)).toBe('spaced')
  })

  it('名前が前方一致する別の変数を拾わない（安全弁）', () => {
    // `ARRIVAL_TOKEN` を探して `ARRIVAL_TOKEN_BACKUP` を読むと、別物を鍵として使う。
    expect(readEnvVarFromText('ARRIVAL_TOKEN_BACKUP=other', 'ARRIVAL_TOKEN')).toBe(null)
  })

  it('CRLF の行末でも値に改行が混ざらない（安全弁）', () => {
    // Windows で編集した `.env.local` は CRLF になる。`\r` が値へ残ると base64 の復号で落ちる。
    expect(readEnvVarFromText(`${KEY}=abc\r\nDMDATA_API_KEY=x\r\n`, KEY)).toBe('abc')
  })
})

// `--days` の入口。**上限を置いているのは打ち間違いを弾くため** —— 大きすぎる値を渡すと
// 失効日が日時として扱える範囲（西暦 275760 年あたり）を超えたトークンができる。
// アプリ側もそういう期限は通さないが、配り終えたトークンには効かない。
describe('parseDaysArg', () => {
  it('指定が無ければ既定の 365 日（正）', () => {
    expect(parseDaysArg(undefined)).toBe(365)
  })

  it('読めた値はそのまま使う（正）', () => {
    expect(parseDaysArg('30')).toBe(30)
    expect(parseDaysArg('36500')).toBe(36500)
  })

  it('長すぎる値は落とす（安全弁）', () => {
    // この値を通すと exp が 8.64e15 ミリ秒を超え、画面が期限を整形できなくなる。
    expect(() => parseDaysArg('100000000000')).toThrow(/長すぎます/)
    expect(() => parseDaysArg('36501')).toThrow(/長すぎます/)
  })

  it('読めない値は「長すぎる」と別の理由で落とす（対照）', () => {
    // 直す場所が違う（打ち間違いか、桁の入れ間違いか）。
    for (const bad of ['abc', '0', '-1', 'Infinity', 'NaN']) {
      expect(() => parseDaysArg(bad)).toThrow(/読めません/)
    }
  })

  it('`--days=` と書いて値を空にしたら既定へ倒さない（安全弁）', () => {
    // `Number('')` は 0 を返す。既定へ倒すと、打ち間違いに気づく機会が無い。
    expect(() => parseDaysArg('')).toThrow(/読めません/)
  })
})
