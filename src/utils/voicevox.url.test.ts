// VOICEVOX の接続確認先として通信してよい URL かの判定（`isValidVoicevoxUrl`）。
//
// この判定は「入力途中の値を弾く」ためのものではない。入力途中で飛ぶリクエストを止めるのは
// 呼び出し側のデバウンス（`VOICEVOX_URL_DEBOUNCE_MS`。設定タブの接続確認と、App の切り出し語の
// 作り置きの両方が使う）の役目で、ここが担うのは
// スキームの書き忘れのような直らない誤りを「起動していません」と誤診しないこと。
// その境界を取り違えるとどちらの防御も中途半端になるため、対で固定する。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkVoicevoxAvailable, fetchVoicevoxSpeakers, isValidVoicevoxUrl } from './voicevox'

describe('isValidVoicevoxUrl', () => {
  it('http/https のホスト付き URL を通す', () => {
    expect(isValidVoicevoxUrl('http://localhost:50021')).toBe(true)
    expect(isValidVoicevoxUrl('http://192.168.0.64:50021')).toBe(true)
    expect(isValidVoicevoxUrl('https://voicevox.example.jp')).toBe(true)
    expect(isValidVoicevoxUrl('http://[::1]:50021')).toBe(true)
  })

  // いずれも `new URL` が例外を投げる側で落ちる（protocol の判定までは進まない）。
  // `http://` はホストを伴わないため、`192.168.0.64:50021` は数字がスキームの先頭に
  // 置けないため。ホスト名の有無を別途判定していないのはこれが理由。
  it('URL として解析できない値を弾く', () => {
    expect(isValidVoicevoxUrl('')).toBe(false)
    expect(isValidVoicevoxUrl('   ')).toBe(false)
    expect(isValidVoicevoxUrl('http://')).toBe(false)   // ホストが無い
    expect(isValidVoicevoxUrl('192.168.0.64:50021')).toBe(false)   // スキーム忘れ
  })

  it('http/https 以外のスキームを弾く', () => {
    expect(isValidVoicevoxUrl('ws://localhost:50021')).toBe(false)
    expect(isValidVoicevoxUrl('file:///tmp/voicevox')).toBe(false)
  })

  // 実地で観測した入力途中の値。URL としては解析でき、ブラウザは実際に接続を試みる
  // （裸の整数が IPv4 として解釈され `http://0.0.0.1:50021` 等になる）。
  // ここで弾けないことを明示しておかないと、「検証を入れたのだから中間状態は飛ばない」と
  // 誤解したままデバウンスを外されうる。
  it('入力途中の裸の整数ホストは弾けない（止めるのはデバウンスの役目）', () => {
    expect(isValidVoicevoxUrl('http://1:50021')).toBe(true)
    expect(isValidVoicevoxUrl('http://192.:50021')).toBe(true)
  })
})

// 末尾スラッシュ付きの URL は `isValidVoicevoxUrl` を通る（URL としては正しいため）。
// 連結側で吸収しないと `//version` を叩いて 404 になり、VOICEVOX は起動しているのに
// 接続状態だけが「起動していません」になる。検証では捕まえられない誤診なので、
// 組み立てた URL そのものを固定する。
describe('末尾スラッシュの正規化', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const stubFetch = () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('checkVoicevoxAvailable が二重スラッシュを作らない', async () => {
    const fetchMock = stubFetch()
    await checkVoicevoxAvailable('http://localhost:50021/')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:50021/version')
  })

  it('fetchVoicevoxSpeakers が二重スラッシュを作らない', async () => {
    const fetchMock = stubFetch()
    await fetchVoicevoxSpeakers('http://localhost:50021///')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:50021/speakers')
  })

  it('末尾スラッシュが無い URL はそのまま使う', async () => {
    const fetchMock = stubFetch()
    await checkVoicevoxAvailable('http://192.168.0.64:50021')
    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.0.64:50021/version')
  })
})
