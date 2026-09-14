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
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAutoOpenWhileSpeaking } from './useAutoOpenWhileSpeaking'

describe('読み上げているあいだだけ開く', () => {
  // 正: 読み始めたら開き、読み終わったら閉じる
  it('読み始めで開き、読み終わりで閉じる', () => {
    const { result, rerender } = renderHook(
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking),
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
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking),
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
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking),
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
      ({ speaking }) => useAutoOpenWhileSpeaking(speaking),
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
