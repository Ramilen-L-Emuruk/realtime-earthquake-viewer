// @vitest-environment jsdom
//
// 地震回数に関する情報の区間（`Item/StartTime`・`Item/EndTime`）が、日時として読めないときに
// 何を出すか。
//
// **この経路は電文の読み取りと対で見ないと意味が分からない。** 読み取り側
// （`dmdataParser.ts` の `readTelegramDateTime`）は読めない値を捨てて空文字にし、記録だけ残す。
// そのため画面へ届くのは「空文字」で、以前ここにあった「電文の生の文字列をそのまま出す」
// フォールバックはもう発火しない —— 残したままだと区切りの「〜」だけが並び、値を読み落とした
// ように見える。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EarthquakeCountDetail } from './EarthquakeCountDetail'
import { withTz } from '../../test-utils/withTz'
import type { JMAEarthquakeCount, JMAEarthquakeCountItem } from '../../types/earthquake'

afterEach(cleanup)

const item = (over: Partial<JMAEarthquakeCountItem> = {}): JMAEarthquakeCountItem => ({
  type: '累積地震回数',
  startTime: '2026-01-01T09:00:00+09:00',
  endTime: '2026-01-02T12:00:00+09:00',
  number: 123,
  feltNumber: 45,
  ...over,
})

const count = (items: JMAEarthquakeCountItem[]): JMAEarthquakeCount => ({
  id: 'c1',
  time: '2026-01-02T12:00:00+09:00',
  eventId: 'ev1',
  headline: '地震回数に関する情報をお知らせします。',
  items,
  cancelled: false,
  reportDateTime: '2026-01-02T12:00:00+09:00',
  expireAt: '2026-01-09T12:00:00+09:00',
})

describe('地震回数の区間が読めないとき', () => {
  // 対照: 読める値では従来どおり期間を出す（日をまたぐので終わりにも日付が付く）。
  it('読める値では期間を出す', () => {
    // **時間帯を固定する。** 壁時計で組み立てるので、UTC で走る CI では日付ごとずれる。
    withTz('Asia/Tokyo', () => {
      const { container } = render(<EarthquakeCountDetail count={count([item()])} />)
      expect(container.textContent).toContain('1/1 09:00〜1/2 12:00')
      expect(container.textContent).not.toContain('期間不明')
    })
  })

  // 正: 読み取り側が捨てた結果（空文字）では「期間不明」を出す。
  //
  // **「〜」だけを残さない。** 区切りしか出ないと、値が無いのか描画に失敗したのかが
  // 利用者にも次に触る人にも判らない。
  it('空文字では「期間不明」を出し、区切りだけを残さない', () => {
    const { container } = render(
      <EarthquakeCountDetail count={count([item({ startTime: '', endTime: '' })])} />,
    )
    expect(screen.getByText('期間不明')).toBeTruthy()
    expect(container.textContent).not.toMatch(/(^|[^0-9])〜([^0-9]|$)/)
    expect(container.textContent).not.toContain('Invalid Date')
  })

  // 正: 片方だけ読めても期間としては出さない。端が 1 つでは何日ぶんの数字か決まらず、
  // 読める側だけを出すと区間が確定しているように見える。
  it('片方だけ読めても「期間不明」へ倒す', () => {
    withTz('Asia/Tokyo', () => {
      const { container } = render(<EarthquakeCountDetail count={count([item({ endTime: '' })])} />)
      expect(screen.getByText('期間不明')).toBeTruthy()
      expect(container.textContent).not.toContain('1/1 09:00')
    })
  })

  // 安全弁: 期間が出せなくても回数は残る。時刻が読めないことで、この情報の主題
  // （何回起きたか）まで道連れにしない。
  it('期間が出せなくても回数は残る', () => {
    const { container } = render(
      <EarthquakeCountDetail count={count([item({ startTime: '', endTime: '' })])} />,
    )
    expect(container.textContent).toContain('123')
    expect(container.textContent).toContain('45')
  })
})
