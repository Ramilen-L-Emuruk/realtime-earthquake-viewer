// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEewSpeakingCard, EEW_SPEAKING_CARD_LINGER_MS } from './useEewSpeakingCard'

describe('いま声が語っている緊急地震速報（useEewSpeakingCard）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 語り始めたらその eventId が入る。
  it('語り始めた eventId が入る', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    expect(result.current.speakingKey).toBeNull()
    act(() => { result.current.follow.begin('A') })
    expect(result.current.speakingKey).toBe('A')
  })

  // 正: 語り終わって猶予が明けたら落ちる。
  it('語り終わって猶予が明けたら落ちる', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 対照: 語り終わった直後（猶予中）はまだ残る。**ここが猶予を置いた狙い** ——
  // 予想値の発話は短く、鳴り終わりで落とすと声で気づいて目を移した人に何も残らない。
  it('語り終わった直後はまだ残る', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS - 1) })
    expect(result.current.speakingKey).toBe('A')
  })

  // 安全弁: 猶予のあいだに別の地震が語り始めたら、そちらへ移り、**前の猶予に奪われない**。
  // これが同時多発でいちばん効く場面（発話は eventId をまたいで交錯する）。
  it('猶予中に別の地震が語り始めたら、その印は前の猶予で落ちない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let a = 0, b = 0
    act(() => { a = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(a) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS - 1) })
    act(() => { b = result.current.follow.begin('B') })
    expect(result.current.speakingKey).toBe('B')
    // **A が張った猶予の時刻を跨いでも B は残る。** `begin` は猶予のタイマーを取り消すだけで
    // 張り直さないので、B が落ちるのは B 自身の `end` が来たときだけ。
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS * 2) })
    expect(result.current.speakingKey).toBe('B')
    act(() => { result.current.follow.end(b) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: **世代が進んだ後始末は何もしない。** 呼び出し側は印を立てた回だけ `end` を呼ぶが、
  // **リセットをまたいで遅れて届く分**（下の「旧世代の後始末」）に備えて受け口の側でも照合する。
  // 照合を外すと、古い後始末が届いた瞬間に猶予が張り替わり、いま印が付いている地震を
  // 落とす契機が 1 つも残らない。
  it('世代が過ぎた後始末では、いまの印の猶予を奪わない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let a = 0
    act(() => { a = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(a) })
    act(() => { vi.advanceTimersByTime(1000) })
    // 既に過ぎた世代で後始末が来る（リセットや別の発話で世代が進んだ後に届く形）。
    act(() => { result.current.follow.end(a - 1) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: **リセットをまたいで同じ eventId が復帰しても、取り残された後始末が新しい印を
  // 落とさない。** `resetTracking` はチェーンの参照を差し替えるだけで、合成の応答を待っている
  // 発話は止まらない —— eventId で照合していた頃は、リプレイを停止してすぐ同じ日時を再生し直すと
  // 旧タイムラインの `end` が新しい発話の印に猶予を張り、**まだ語っている最中に消していた**。
  it('リセットをまたいで同じ eventId が復帰しても、旧世代の後始末で消えない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let stale = 0
    act(() => { stale = result.current.follow.begin('X') })   // 旧タイムラインの発話
    act(() => { result.current.follow.reset() })              // リプレイの停止・開始
    act(() => { result.current.follow.begin('X') })           // 新タイムラインで同じ地震が復帰
    expect(result.current.speakingKey).toBe('X')
    act(() => { result.current.follow.end(stale) })           // 取り残された後始末が届く
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS * 2) })
    expect(result.current.speakingKey).toBe('X')
  })

  // 安全弁: 時間軸が変わったら即座に落とす（リプレイの開始・停止）。
  it('リセットで即座に落ちる', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    act(() => { result.current.follow.begin('A') })
    act(() => { result.current.follow.reset() })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: リセットは猶予のタイマーも取り消す。残すと、リセット後に語り始めた別の地震の
  // 印を、前の時間軸の猶予が落としに来る。
  it('リセット後に語り始めた印は、前の猶予で落ちない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let a = 0
    act(() => { a = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(a) })
    act(() => { result.current.follow.reset() })
    act(() => { result.current.follow.begin('A') })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_LINGER_MS) })
    expect(result.current.speakingKey).toBe('A')
  })
})
