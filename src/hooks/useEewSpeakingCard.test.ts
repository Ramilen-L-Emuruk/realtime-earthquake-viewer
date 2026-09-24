// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useEewSpeakingCard,
  EEW_SPEAKING_CARD_PENDING_POLL_MS,
  EEW_SPEAKING_CARD_AFTERGLOW_MS,
  EEW_SPEAKING_CARD_MAX_HOLD_MS,
} from './useEewSpeakingCard'

/** 語ることが尽きている（この発話で終わり）。 */
const nothingPending = () => false

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

  // 正: 語ることが尽きていれば、残像が明けて落ちる。
  it('語ることが尽きていれば、残像が明けて落ちる', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token, nothingPending) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 対照: 残像のあいだはまだ残る。**ここが残像を置いた狙い** —— 予想値の発話は短く、
  // 鳴り終わりで落とすと声で気づいて目を移した人に何も残らない。
  it('語り終わった直後はまだ残る', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token, nothingPending) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS - 1) })
    expect(result.current.speakingKey).toBe('A')
  })

  // 正: **まだ語ることが残っているあいだは保つ。** これが一律の猶予をやめた理由 ——
  // 名乗りと予想値のあいだには安定待ち（最大 5 秒）が挟まるので、時間で切ると
  // 読み上げの途中で印が消える。残像の何十倍の時間が過ぎても残ることを確かめる。
  it('まだ語ることが残っているあいだは、いくら経っても保つ', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token, () => true) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS * 50) })
    expect(result.current.speakingKey).toBe('A')
  })

  // 正: 残っていた予定が尽きたら落ちる（安定待ちが明けて、結局何も読まなかった形）。
  // **見直しを続けていることの確認** —— 1 回だけ見て保つ実装だと、ここで永久に残る。
  it('保っている途中で語ることが尽きたら、そこから残像を置いて落ちる', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let pending = true
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token, () => pending) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_PENDING_POLL_MS * 4) })
    expect(result.current.speakingKey).toBe('A')
    // 誤報取消やリセットで予約が捨てられた（あるいは安定待ちが確定して何も読まなかった）。
    pending = false
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_PENDING_POLL_MS) })
    expect(result.current.speakingKey).toBe('A')   // まだ残像のあいだ
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: **判定が投げたら印を落とす。** 判らないまま保ち続けると、その印は二度と消えない
  // （見直しのタイマーも張り直されないため）。
  it('語る予定を判定できなければ印を落とす', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => {
      result.current.follow.end(token, () => { throw new Error('判定できない') })
    })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: 残像のあいだに別の地震が語り始めたら、そちらへ移り、**前の後始末に奪われない**。
  // これが同時多発でいちばん効く場面（発話は eventId をまたいで交錯する）。
  it('残像中に別の地震が語り始めたら、その印は前の後始末で落ちない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let a = 0, b = 0
    act(() => { a = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(a, nothingPending) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS - 1) })
    act(() => { b = result.current.follow.begin('B') })
    expect(result.current.speakingKey).toBe('B')
    // **A が張ったタイマーの時刻を跨いでも B は残る。** begin はタイマーを取り消すだけで
    // 張り直さないので、B が落ちるのは B 自身の end が来たときだけ。
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS * 2) })
    expect(result.current.speakingKey).toBe('B')
    act(() => { result.current.follow.end(b, nothingPending) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: **世代が進んだ後始末は何もしない。** 呼び出し側は印を立てた回だけ end を呼ぶが、
  // **リセットをまたいで遅れて届く分**（下の「旧世代の後始末」）に備えて受け口の側でも照合する。
  // 照合を外すと、古い後始末が届いた瞬間にタイマーが張り替わり、いま印が付いている地震を
  // 落とす契機が 1 つも残らない。
  it('世代が過ぎた後始末では、いまの印の後始末を奪わない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let a = 0
    act(() => { a = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(a, nothingPending) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS / 2) })
    // 既に過ぎた世代で後始末が来る（リセットや別の発話で世代が進んだ後に届く形）。
    act(() => { result.current.follow.end(a - 1, () => true) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: **リセットをまたいで同じ eventId が復帰しても、取り残された後始末が新しい印を
  // 落とさない。** resetTracking はチェーンの参照を差し替えるだけで、合成の応答を待っている
  // 発話は止まらない —— eventId で照合していた頃は、リプレイを停止してすぐ同じ日時を再生し直すと
  // 旧タイムラインの end が新しい発話の印を落としに来て、**まだ語っている最中に消していた**。
  it('リセットをまたいで同じ eventId が復帰しても、旧世代の後始末で消えない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let stale = 0
    act(() => { stale = result.current.follow.begin('X') })   // 旧タイムラインの発話
    act(() => { result.current.follow.reset() })              // リプレイの停止・開始
    act(() => { result.current.follow.begin('X') })           // 新タイムラインで同じ地震が復帰
    expect(result.current.speakingKey).toBe('X')
    act(() => { result.current.follow.end(stale, nothingPending) })   // 取り残された後始末が届く
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS * 2) })
    expect(result.current.speakingKey).toBe('X')
  })

  // 安全弁: 時間軸が変わったら即座に落とす（リプレイの開始・停止）。
  it('リセットで即座に落ちる', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    act(() => { result.current.follow.begin('A') })
    act(() => { result.current.follow.reset() })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: リセットは見直しのタイマーも取り消す。残すと、リセット後に語り始めた別の地震の
  // 印を、前の時間軸の後始末が落としに来る。
  it('リセット後に語り始めた印は、前の後始末で落ちない', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let a = 0
    act(() => { a = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(a, nothingPending) })
    act(() => { result.current.follow.reset() })
    act(() => { result.current.follow.begin('A') })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS) })
    expect(result.current.speakingKey).toBe('A')
  })

  // 正: **残像のあいだに語ることが増えたら、消さずに保ち直す。** 実配信の続報は 0.3〜2 秒
  // 間隔で届き、残像（0.8 秒）より短い。ここで確かめずに落とすと印が一瞬消えて次の発話で
  // 点き直し、**窓が縮んだだけで点滅が残る**（一律 5 秒の猶予をやめた意味が半分消える）。
  it('残像のあいだに語ることが増えたら、印を保ち直す', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let pending = false
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token, () => pending) })
    // 残像の途中で次の電文が届き、新しい安定待ちが積まれた。
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_AFTERGLOW_MS - 100) })
    pending = true
    // 残像が明けても落ちない。
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current.speakingKey).toBe('A')
    // 見直しへ戻っているので、いくら経っても保つ。
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_PENDING_POLL_MS * 10) })
    expect(result.current.speakingKey).toBe('A')
  })

  // 安全弁: **語ることが尽きないまま上限に達したら落とす。** 見直しを入れたことで
  // 「捨てられた予約」は覆えたが、「消えない予約」は覆えない —— 旧実装（一律の猶予）が
  // 副次的に持っていた「最悪でも消える」性質をここで残す。
  it('語る予定が尽きないまま上限に達したら落ちる', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let token = 0
    act(() => { token = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(token, () => true) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_MAX_HOLD_MS - EEW_SPEAKING_CARD_PENDING_POLL_MS) })
    expect(result.current.speakingKey).toBe('A')
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_PENDING_POLL_MS * 2) })
    expect(result.current.speakingKey).toBeNull()
  })

  // 安全弁: **保っている最中にリセットされたら、見直しごと止まる。** 止まらないと、
  // リセット後に語り始めた別の地震を古い判定が見張り続け、そちらの印を落としに来る。
  it('保っている最中にリセットされたら、見直しが止まる', () => {
    const { result } = renderHook(() => useEewSpeakingCard())
    let a = 0
    act(() => { a = result.current.follow.begin('A') })
    act(() => { result.current.follow.end(a, () => true) })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_PENDING_POLL_MS * 2) })
    act(() => { result.current.follow.reset() })
    act(() => { result.current.follow.begin('B') })
    act(() => { vi.advanceTimersByTime(EEW_SPEAKING_CARD_PENDING_POLL_MS * 10) })
    expect(result.current.speakingKey).toBe('B')
  })
})
