// @vitest-environment jsdom
//
// ErrorBoundary が「どこまで受け止め、いつ諦めるか」を固定する。
//
// **ここで押さえられるのは React の呼び出しスタックの中だけ。** rAF・イベントハンドラ・Promise の
// 中の例外はこの境界に届かないので、そちらは別の仕組みの担当（ErrorBoundary.tsx の冒頭を見ること）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

/** 押すたびに throw するかどうかを外から決められる子。 */
function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('boom')
  return <div>中身</div>
}

/** console.error のスパイ。`vi.spyOn` の戻り値をそのまま型に使うと、引数の型が付かない。 */
type ErrorSpy = { mock: { calls: unknown[][] } }

/** この境界が出した記録だけを数える（React 自身も console.error を使うため区別が要る）。 */
function boundaryLogCount(spy: ErrorSpy): number {
  return spy.mock.calls.filter((args) =>
    args.some((a) => typeof a === 'string' && a.includes('[error-boundary]')),
  ).length
}

let errorSpy: ErrorSpy

beforeEach(() => {
  // React は境界が受け止めた例外も開発時に console へ出す。テストの出力を埋めるので黙らせる。
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  // 対照: 何も起きなければ素通しであること。境界が常時何かを挟んでいたら、この段で気づける。
  it('子が投げなければ中身をそのまま出す', () => {
    render(
      <ErrorBoundary variant="region" label="地図">
        <Bomb explode={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('中身')).toBeTruthy()
    expect(boundaryLogCount(errorSpy)).toBe(0)
  })

  // 正: レンダー中の例外を受け止め、その範囲だけ差し替わること。
  it('子のレンダー例外を受け止めて領域の表示へ差し替える', () => {
    render(
      <ErrorBoundary variant="region" label="地図">
        <Bomb explode />
      </ErrorBoundary>,
    )
    expect(screen.getByText('地図を表示できません')).toBeTruthy()
    expect(screen.queryByText('中身')).toBeNull()
    expect(screen.getByRole('button', { name: '再表示' })).toBeTruthy()
  })

  it('受け止めた例外を記録する', () => {
    render(
      <ErrorBoundary variant="region" label="地図">
        <Bomb explode />
      </ErrorBoundary>,
    )
    expect(boundaryLogCount(errorSpy)).toBeGreaterThan(0)
    // componentStack を落とすと、同じ関数が複数の場所から呼ばれるこのコードベースで経路を絞れない。
    const call = errorSpy.mock.calls.find((args) =>
      args.some((a) => typeof a === 'string' && a.includes('[error-boundary]')),
    )
    expect(call?.some((a) => typeof a === 'string' && a.includes('Bomb'))).toBe(true)
  })

  it('再表示を押すと子をマウントし直す', () => {
    // **「N 回目のレンダーで直る」という書き方をしないこと。** React は境界が受け止めた例外を
    // 開発時にもう一度レンダーして再現しに行くため、レンダー回数を数える子は最初の 1 回で
    // 直ったことになってしまい、再表示を押す前に成功してしまう（実際に踏んだ）。
    // 外から倒せるフラグにすれば、何度レンダーされても結果は変わらない。
    let explode = true
    function Flaky() {
      if (explode) throw new Error('boom')
      return <div>直った</div>
    }

    render(
      <ErrorBoundary variant="region" label="地図">
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByText('地図を表示できません')).toBeTruthy()
    explode = false
    fireEvent.click(screen.getByRole('button', { name: '再表示' }))
    expect(screen.getByText('直った')).toBeTruthy()
  })

  // 安全弁: 押しても直らないと分かったら、押せる見た目をやめること。
  // これが無いと「押す→即落ちる」を延々繰り返させる。
  it('窓の中で落ち直し続けたら再表示を引っ込める', () => {
    render(
      <ErrorBoundary variant="region" label="地図">
        <Bomb explode />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: '再表示' }))
    // まだ 1 回目。諦めるのは早い。
    expect(screen.getByRole('button', { name: '再表示' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '再表示' }))
    expect(screen.queryByRole('button', { name: '再表示' })).toBeNull()
    expect(screen.getByText('再読み込みで直ることがあります')).toBeTruthy()
  })

  // 安全弁の対照: **押して直った後、しばらく持ちこたえてから落ちた分は数えないこと。**
  // ここを数えると、一日に一度ずつ落ちる端末で再表示が永久に出なくなる。
  it('押して持ちこたえた後に落ちた分は数えない', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let t = 1_000_000
    nowSpy.mockImplementation(() => t)

    let explode = true
    function Flaky() {
      if (explode) throw new Error('boom')
      return <div>直った</div>
    }
    // **要素は毎回作り直す。** 同じ要素参照を渡すと React が「変わっていない」と見て
    // 子のレンダーを飛ばすため、落とし直せない。
    const makeTree = () => (
      <ErrorBoundary variant="region" label="地図">
        <Flaky />
      </ErrorBoundary>
    )
    const { rerender } = render(makeTree())
    expect(screen.getByText('地図を表示できません')).toBeTruthy()

    // 押したら直った。
    explode = false
    fireEvent.click(screen.getByRole('button', { name: '再表示' }))
    expect(screen.getByText('直った')).toBeTruthy()

    // 30 秒もってから、あらためて落ちる。「押しても直らなかった」には当たらない。
    t += 30_001
    explode = true
    rerender(makeTree())
    expect(screen.getByRole('button', { name: '再表示' })).toBeTruthy()
  })

  // 根は state ごと失われるので、再表示に意味が無い。押せるのは再読み込みだけ。
  it('根では再表示を出さず、受信が止まったことを伝える', () => {
    render(
      <ErrorBoundary variant="root">
        <Bomb explode />
      </ErrorBoundary>,
    )
    expect(screen.getByText('画面を表示できなくなりました')).toBeTruthy()
    expect(screen.getByText('情報の受信も止まっています')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '再表示' })).toBeNull()
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeTruthy()
  })
})
