import { describe, it, expect, vi } from 'vitest'
import { dmdataConnectionLabel } from './connectionLabel'
import { log } from '../../utils/logger'

vi.mock('../../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// 接続状態の文言。**利用者がすべきことが違うなら文言も分ける**という規約を固定する。
//
// 画面の分岐をここへ切り出したのは、三項演算子の連鎖だと `ConnectionStatus` へ値を足した
// ときの書き忘れが型検査に掛からず、「画面にだけ出ない」形で漏れるため。
describe('dmdataConnectionLabel', () => {
  const KEY_OK = { apiKeySet: true, apiKeyInvalid: false }

  // 正: 同時接続の上限は専用の文言にする。**利用者がすべきことを書く** ——
  // 実際にできるのは別のタブを閉じることだけで、枠が空けば自動で繋がる
  it('同時接続の上限は「切断」と別の文言で、閉じれば繋がることを伝える', () => {
    const label = dmdataConnectionLabel('crowded', KEY_OK)

    expect(label.text).toContain('同時接続')
    expect(label.text).toContain('自動で繋がります')
    expect(label.text).not.toContain('切断')
    // 「異常」の赤ではなく注意の色。こちら側の不具合ではないため
    expect(label.className).toContain('amber')
  })

  // 対照: 本当の切断は従来どおり「切断」。crowded の文言に寄せると、
  // キーや回線の問題を「タブを閉じれば直る」と誤って案内する
  it('切断は「切断」のまま', () => {
    expect(dmdataConnectionLabel('disconnected', KEY_OK).text).toBe('切断')
  })

  // 対照: キーが未設定・不正なときは接続を試みていないので、通信の失敗と区別する
  it('キーの問題は通信の失敗と区別する', () => {
    expect(dmdataConnectionLabel('disconnected', { apiKeySet: false, apiKeyInvalid: false }).text).toBe('APIキー未設定')
    expect(dmdataConnectionLabel('disconnected', { apiKeySet: true, apiKeyInvalid: true }).text).toBe('APIキーが不正')
    expect(dmdataConnectionLabel(undefined, { apiKeySet: false, apiKeyInvalid: false }).text).toBe('APIキー未設定')
  })

  // 対照: 既存の 3 状態を巻き込んでいないこと
  it('接続中・接続試行中・再生中は従来の文言', () => {
    expect(dmdataConnectionLabel('connected', KEY_OK).text).toBe('接続中')
    expect(dmdataConnectionLabel('connecting', KEY_OK).text).toBe('接続試行中...')
    expect(dmdataConnectionLabel('replay', KEY_OK).text).toContain('再生中')
  })

  // 安全弁: **どの状態でも空文字を返さない**。空を返すと接続状態の行が消え、
  // 「状態が分からない」ことに画面からも気づけない
  it('どの状態でも文言が空にならない', () => {
    for (const s of ['connected', 'connecting', 'disconnected', 'replay', 'crowded', undefined] as const) {
      const label = dmdataConnectionLabel(s, KEY_OK)
      expect(label.text.length).toBeGreaterThan(0)
      expect(label.className.length).toBeGreaterThan(0)
    }
  })

  // 安全弁: キーの状態は `disconnected` / 未設定のときだけ見る。
  // 繋がっているのに「APIキーが不正」と出たら、利用者は正しいキーを疑って消しにかかる
  it('接続できている状態ではキーの不正を文言に出さない', () => {
    const invalid = { apiKeySet: true, apiKeyInvalid: true }
    expect(dmdataConnectionLabel('connected', invalid).text).toBe('接続中')
    expect(dmdataConnectionLabel('crowded', invalid).text).toContain('同時接続')
  })

  // 安全弁: 型検査を通らない経路で未知の値が来たとき、**画面に出すだけでなく記録も残す**。
  // 画面の文言だけでは、どこから来た値なのか追えない
  it('未知の状態は記録を残し、既存の文言へ混ぜない', () => {
    vi.mocked(log.warn).mockClear()

    // 型の上では到達しない分岐。型を無視して渡す経路（型と呼び出し側の同期が崩れた場合）を再現する
    const label = dmdataConnectionLabel('throttled' as never, KEY_OK)

    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('未知の接続状態')
    // **「切断」へ落とさない** —— 落とすと新しい状態が既存の文言に混ざり、画面からも気づけない
    expect(label.text).not.toBe('切断')
  })
})
