// @vitest-environment jsdom
//
// 自作地震計の押し出しが切れたことを知らせる行の**出る条件**を固定する。
//
// 見ているのは 3 つ ——「切れたままなら出る」「瞬断では出ない」「機能を切って
// いるときは出ない」。文面そのものより、**出る／出ないの境目**がこの部品の中身。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { SeismoLinkStatus } from './SeismoLinkStatus'

const TEXT = '地震計 未接続'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 偽の時計を進める。**`act` で包まないと state の書き換えが画面へ出ない。** */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('自作地震計に繋がらないことを知らせる行', () => {
  it('正: 繋がらない状態が 5 秒続けば出る', () => {
    render(<SeismoLinkStatus stream={{ kind: 'reconnecting', detail: '応答なし', nextAttemptInMs: 1000 }} />)

    expect(screen.queryByText(TEXT)).toBeNull()
    advance(5000)

    expect(screen.getByText(TEXT)).toBeTruthy()
  })

  it('対照: 5 秒に満たないうちに繋がれば出ない（瞬断でちらつかない）', () => {
    const { rerender } = render(<SeismoLinkStatus stream={{ kind: 'connecting' }} />)
    advance(4000)
    rerender(<SeismoLinkStatus stream={{ kind: 'open' }} />)
    advance(10_000)

    expect(screen.queryByText(TEXT)).toBeNull()
  })

  it('正: 出たあとでも、繋がれば消える', () => {
    const { rerender } = render(<SeismoLinkStatus stream={{ kind: 'connecting' }} />)
    advance(5000)
    expect(screen.getByText(TEXT)).toBeTruthy()

    rerender(<SeismoLinkStatus stream={{ kind: 'open' }} />)

    expect(screen.queryByText(TEXT)).toBeNull()
  })

  // **待ちが張り直されると永久に出ない。** `reconnecting` は繋ぎ直しのたびに
  // 待ち時間（`nextAttemptInMs`）の違う別の値で届くので、オブジェクトを依存に
  // すると 5 秒に届く前に毎回作り直される。
  it('安全弁: 繋ぎ直しを繰り返しても、通算 5 秒で出る', () => {
    const { rerender } = render(<SeismoLinkStatus stream={{ kind: 'connecting' }} />)
    advance(2000)
    rerender(<SeismoLinkStatus stream={{ kind: 'reconnecting', detail: '応答なし', nextAttemptInMs: 1000 }} />)
    advance(2000)
    rerender(<SeismoLinkStatus stream={{ kind: 'reconnecting', detail: '応答なし', nextAttemptInMs: 2000 }} />)
    advance(1000)

    expect(screen.getByText(TEXT)).toBeTruthy()
  })

  // 機能を切っている・URL の形が違うときは `null` が来る。**繋がらないのは当然**
  // なので、知らせる相手がいない（設定タブの 1 行が受け持つ）。
  it('安全弁: 繋ぎに行っていないとき（null）は何も描かない', () => {
    const { container } = render(<SeismoLinkStatus stream={null} />)
    advance(60_000)

    expect(container.firstChild).toBeNull()
  })

  it('対照: 繋がっているときは何も描かない', () => {
    const { container } = render(<SeismoLinkStatus stream={{ kind: 'open' }} />)
    advance(60_000)

    expect(container.firstChild).toBeNull()
  })
})
