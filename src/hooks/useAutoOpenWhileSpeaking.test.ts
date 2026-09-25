// @vitest-environment jsdom
//
// 読み上げているあいだだけ開く折りたたみ（→ docs/spec/audio-tts-spec.md §6
// 「読み上げに合わせて気象庁の文を開く」）。
//
// 固定するのは 3 種。
//   正  : 読み始めたら開き、読み終わったら閉じる
//   対照: 利用者が手で開いていたものは、読み終わりで閉じない
//   安全弁: 読み上げ中に手で閉じたら、その読み上げのあいだは開き直さない
//           （閉じたそばから開き直ると、操作を受け付けないように見える）
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAutoOpenWhileSpeaking, useAutoOpenWhileSpeakingIn } from './useAutoOpenWhileSpeaking'
import { drainReplayEvents, __resetReplayEventLogForTest, type ReplayOverlayEvent } from '../utils/replayEventLog'

describe('読み上げているあいだだけ開く', () => {
  // 正: 読み始めたら開き、読み終わったら閉じる
  it('読み始めで開き、読み終わりで閉じる', () => {
    const { result, rerender } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking, 'test'),
      { initialProps: { speaking: false } },
    )
    expect(result.current[0]).toBe(false)

    rerender({ speaking: true })
    expect(result.current[0]).toBe(true)

    rerender({ speaking: false })
    expect(result.current[0]).toBe(false)
  })

  // 対照: **手で開いたものは閉じない。** 見ようとしていた中身を読み終わりで奪わない
  it('利用者が手で開いていたものは、読み終わりで閉じない', () => {
    const { result, rerender } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking, 'test'),
      { initialProps: { speaking: false } },
    )
    act(() => { result.current[1](true) })
    expect(result.current[0]).toBe(true)

    rerender({ speaking: true })
    expect(result.current[0]).toBe(true)
    rerender({ speaking: false })
    expect(result.current[0]).toBe(true)
  })

  // 対照: 読み上げ中に手で開いた場合も、こちらの持ち物にしない
  it('読み上げ中に手で開き直したら、読み終わりで閉じない', () => {
    const { result, rerender } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking, 'test'),
      { initialProps: { speaking: true } },
    )
    expect(result.current[0]).toBe(true)
    act(() => { result.current[1](false) })   // 手で閉じる
    act(() => { result.current[1](true) })    // 手で開き直す
    rerender({ speaking: false })
    expect(result.current[0]).toBe(true)
  })

  // 安全弁: 読み上げ中に手で閉じたら、その読み上げのあいだは開き直さない
  it('読み上げ中に手で閉じたら、そのまま閉じたままにする', () => {
    const { result, rerender } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking, 'test'),
      { initialProps: { speaking: false } },
    )
    rerender({ speaking: true })
    expect(result.current[0]).toBe(true)

    act(() => { result.current[1](false) })
    expect(result.current[0]).toBe(false)
    // 同じ読み上げが続いても開き直さない
    rerender({ speaking: true })
    expect(result.current[0]).toBe(false)

    // 次の読み上げでは開く
    rerender({ speaking: false })
    rerender({ speaking: true })
    expect(result.current[0]).toBe(true)
  })
})

// 録画ツール向けの記録（→ docs/spec/recording-interface-spec.md）。
// このフックは 6 箇所（地震カードの補足・南海トラフ臨時情報・後発地震注意情報・関連解説情報・
// 地震回数・津波のコメント欄）から同じ `overlay: 'telegramText'` で呼ばれるため、`subject` が
// 無いとどの表示が開いたか区別できない。
describe('録画ツール向けの記録: subject で主題を区別する', () => {
  beforeEach(() => { __resetReplayEventLogForTest() })

  const overlays = () => drainReplayEvents().events
    .filter((e): e is ReplayOverlayEvent => e.type === 'overlay' && e.overlay === 'telegramText')

  it('正: 開いたときの記録に呼び出し元の subject が乗る', () => {
    const { rerender } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking, 'nankai'),
      { initialProps: { speaking: false } },
    )
    rerender({ speaking: true })

    const opens = overlays().filter(e => e.open)
    expect(opens).toHaveLength(1)
    expect(opens[0].subject).toBe('nankai')
  })

  it('正: 閉じたときの記録にも同じ subject が乗る', () => {
    const { rerender } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking, 'kohatsu'),
      { initialProps: { speaking: false } },
    )
    rerender({ speaking: true })
    rerender({ speaking: false })

    const closes = overlays().filter(e => !e.open)
    expect(closes).toHaveLength(1)
    expect(closes[0].subject).toBe('kohatsu')
  })

  // 対照: 呼び出し元ごとに主題が違えば、記録される値も違う——同じ overlay 種別に
  // まとめて潰していないことの確認
  it('対照: 主題が違う呼び出し元は違う subject で記録される', () => {
    const { rerender: rerenderA } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeakingIn(speaking, false, () => {}, 'lpgm:evt-1'),
      { initialProps: { speaking: false } },
    )
    rerenderA({ speaking: true })
    const { rerender: rerenderB } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeakingIn(speaking, false, () => {}, 'tsunamiComment'),
      { initialProps: { speaking: false } },
    )
    rerenderB({ speaking: true })

    const subjects = overlays().filter(e => e.open).map(e => e.subject)
    expect(subjects).toEqual(['lpgm:evt-1', 'tsunamiComment'])
  })
})
