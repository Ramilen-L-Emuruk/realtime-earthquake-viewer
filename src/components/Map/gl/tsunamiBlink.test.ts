import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTsunamiBlink,
  msUntilNextTsunamiBlinkEdge,
  tsunamiBlinkOpacity,
  TSUNAMI_BLINK_ON_RATIO,
  TSUNAMI_BLINK_PERIOD_MS,
  TSUNAMI_LINE_OPACITY_ON,
} from './tsunamiBlink'

const P = TSUNAMI_BLINK_PERIOD_MS
const ON = P * TSUNAMI_BLINK_ON_RATIO

describe('tsunamiBlinkOpacity', () => {
  it('周期の前 8 割は点灯、残り 2 割は消灯（旧 Leaflet の step-end と同じ見た目）', () => {
    expect(tsunamiBlinkOpacity(0)).toBe(TSUNAMI_LINE_OPACITY_ON)
    expect(tsunamiBlinkOpacity(ON - 1)).toBe(TSUNAMI_LINE_OPACITY_ON)
    expect(tsunamiBlinkOpacity(ON)).toBe(0)
    expect(tsunamiBlinkOpacity(P - 1)).toBe(0)
    expect(tsunamiBlinkOpacity(P)).toBe(TSUNAMI_LINE_OPACITY_ON)
  })
})

describe('msUntilNextTsunamiBlinkEdge', () => {
  it('点灯中は消える瞬間まで、消灯中は次に点く瞬間まで', () => {
    expect(msUntilNextTsunamiBlinkEdge(0)).toBe(ON)
    expect(msUntilNextTsunamiBlinkEdge(ON - 100)).toBe(100)
    expect(msUntilNextTsunamiBlinkEdge(ON)).toBe(P - ON)
    expect(msUntilNextTsunamiBlinkEdge(P - 100)).toBe(100)
  })
})

describe('createTsunamiBlink', () => {
  // 時計はフェイクタイマーの `Date.now()` に合わせる。`advanceTimersByTime` で一緒に進む。
  beforeEach(() => vi.useFakeTimers({ now: 0 }))
  afterEach(() => vi.useRealTimers())
  const clock = () => Date.now()

  // 正: 有効にした時点の値を当て、以後は切り替わりの瞬間にだけ当てる。
  it('有効にした時点の値を当て、点く・消える瞬間にだけ当て直す', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    expect(apply.mock.calls).toEqual([[TSUNAMI_LINE_OPACITY_ON]])

    vi.advanceTimersByTime(ON)
    expect(apply.mock.calls).toEqual([[TSUNAMI_LINE_OPACITY_ON], [0]])

    vi.advanceTimersByTime(P - ON)
    expect(apply.mock.calls).toEqual([[TSUNAMI_LINE_OPACITY_ON], [0], [TSUNAMI_LINE_OPACITY_ON]])
    b.dispose()
  })

  // 対照: 切り替わりの間は 1 回も当てない。旧実装は毎フレーム当てていた（＝毎フレーム描き直し）。
  it('10 周期のあいだに当てる回数は切り替わりの回数だけ（毎フレーム当てない）', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    vi.advanceTimersByTime(P * 10)
    // 有効にした時点の 1 回 ＋ 1 周期に 2 回 × 10 周期。
    expect(apply).toHaveBeenCalledTimes(1 + 2 * 10)
    b.dispose()
  })

  // 安全弁: 見えていない間は当てない（旧実装も非表示中は止めていた。それを落とさない）。
  it('無効にすると当てなくなり、有効に戻すとそのときの値から再開する', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    b.setActive(false)
    apply.mockClear()
    vi.advanceTimersByTime(P * 3)
    expect(apply).not.toHaveBeenCalled()

    // 消灯の区間で有効に戻す。最後に当てた値（点灯）と違うので、その場で 0 を当てる。
    vi.advanceTimersByTime(ON + 10)
    b.setActive(true)
    expect(apply.mock.calls).toEqual([[0]])
    b.dispose()
  })

  // 安全弁: 表示の切り替えを何度受けても予約は 1 本。積み上がると同じ瞬間に何度も描き直す。
  it('有効を続けて渡しても予約は増えない', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    b.setActive(true)
    b.setActive(true)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(P)
    expect(apply).toHaveBeenCalledTimes(3)
    b.dispose()
  })

  // 安全弁: レイヤーを外した後に地図へ触らない。
  it('dispose の後は当てない', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    b.dispose()
    apply.mockClear()
    vi.advanceTimersByTime(P * 3)
    expect(apply).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  // 安全弁: 当てる処理が投げても点滅は止まらない。止まると当て損ねた値（消灯かもしれない）で固まる。
  it('当てる処理が例外を投げても予約は続き、次の切り替わりで当て直す', () => {
    let fail = false
    const apply = vi.fn(() => {
      if (fail) throw new Error('Style is not done loading')
      return true
    })
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    fail = true
    vi.advanceTimersByTime(ON) // 消える瞬間で失敗
    expect(vi.getTimerCount()).toBe(1)
    fail = false
    apply.mockClear()
    vi.advanceTimersByTime(P - ON) // 点く瞬間
    // 失敗した分は当てた記憶に残っていないので、点灯をきちんと当てる。
    expect(apply.mock.calls).toEqual([[TSUNAMI_LINE_OPACITY_ON]])
    b.dispose()
  })

  // 安全弁: レイヤーが引けずに当てられなかった（false）ときも、当てた記憶を進めない。
  it('当てられなかった（false）ときは、同じ値でも次の機会に当て直す', () => {
    let ok = false
    const apply = vi.fn(() => ok)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true) // 点灯を当てようとして失敗
    ok = true
    apply.mockClear()
    // 位相は点灯のまま。記憶が進んでいれば何も当てないが、進んでいないので当て直す。
    vi.setSystemTime(100)
    b.resync()
    expect(apply.mock.calls).toEqual([[TSUNAMI_LINE_OPACITY_ON]])
    b.dispose()
  })

  // 安全弁: タイマーの中で当てられなかった（false）ときも、次の切り替わりで当て直す。
  it('切り替わりで当てられなかったら、次の切り替わりで当て直す', () => {
    let ok = true
    const apply = vi.fn(() => ok)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    ok = false
    vi.advanceTimersByTime(ON) // 消灯を当てようとして失敗
    ok = true
    apply.mockClear()
    vi.advanceTimersByTime(P - ON) // 点灯の瞬間。記憶は進んでいないので当てる
    expect(apply.mock.calls).toEqual([[TSUNAMI_LINE_OPACITY_ON]])
    b.dispose()
  })

  // 正: 隠れていたタブが戻ったとき、間引かれて先に残った予約を待たずに位相を合わせる。
  it('resync はいまの位相を当て、予約を張り直す', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.setActive(true)
    apply.mockClear()
    // 予約を発火させずに時計だけ消灯の区間へ進めた状態（隠れたタブの間引き）を作る。
    vi.setSystemTime(ON + 100)
    b.resync()
    expect(apply.mock.calls).toEqual([[0]])
    expect(vi.getTimerCount()).toBe(1)
    b.dispose()
  })

  // 対照: 点滅していないときの resync は何もしない（津波が無いのに地図を描き直さない）。
  it('無効のときの resync は当てず、予約も張らない', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.resync()
    expect(apply).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  // 安全弁: 破棄した部品が、遅れて届いた表示切替で動き出さない。
  it('dispose の後に setActive(true) を受けても動き出さない', () => {
    const apply = vi.fn(() => true)
    const b = createTsunamiBlink(apply, clock)
    b.dispose()
    b.setActive(true)
    b.resync()
    expect(apply).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  // タイマーが境界の手前で発火しても、値が変わらなければ当てない（変わらない値で描き直さない）。
  it('早く発火しても値が変わっていなければ当てず、境界で当てる', () => {
    const apply = vi.fn(() => true)
    let skew = 0
    const b = createTsunamiBlink(apply, () => Date.now() - skew)
    b.setActive(true)
    apply.mockClear()
    // 時計が 5ms 遅れている＝タイマーが 5ms 早く発火したのと同じ。
    skew = 5
    vi.advanceTimersByTime(ON)
    expect(apply).not.toHaveBeenCalled()
    skew = 0
    vi.advanceTimersByTime(5)
    expect(apply.mock.calls).toEqual([[0]])
    b.dispose()
  })
})
