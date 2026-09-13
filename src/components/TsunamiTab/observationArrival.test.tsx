// @vitest-environment jsdom
//
// 区域の中の観測点の行で、実測の到達時刻が出せていないときに予報側の到達予想を添えること
// （→ docs/spec/tsunami-spec.md §9「実測の到達時刻が無い行に添える到達予想」）。
//
// **描いてみないと確かめられない。** 到達予想は `TsunamiArea.stations`、観測の状態は
// `TsunamiObservation` と別々の場所にあり、この行は 2 つを名前で突き合わせて 1 行に畳む。
// 畳み方は型検査も `utils/tsunami.ts` のユニットテストも通らないところにある —— 実際、
// 同じ station の満潮時刻だけを拾って到達予想を落としていたことに長く気づけなかった。
//
// 時刻は `formatTime` がローカル時刻で組むため、**オフセットを書かない表記**を使う
// （CI は TZ=UTC で回る）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TsunamiTab } from './index'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'

afterEach(cleanup)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

const HIGH_TIDE = '2026-04-20T07:30:00'

function makeTsunami(stations: TsunamiArea['stations'], observations: TsunamiObservation[]): JMATsunami {
  const areas: TsunamiArea[] = [
    {
      code: '250', name: '福島県', grade: 'MajorWarning', immediate: true,
      maxHeight: { description: '6m', value: 6.0 },
      stations,
    },
  ]
  return {
    kind: 'tsunami',
    id: 'test-tsunami-arrival',
    eventId: '20260420050000',
    time: '2026-04-20T05:30:00',
    cancelled: false,
    issue: { source: 'テスト', time: '2026-04-20T05:30:00', type: 'Focus' },
    areas,
    observations,
  }
}

/** 観測点の行の時刻欄（名前の span と同じ枠にいる）。欄そのものが無ければ null。 */
function timeLineOf(name: string): string | null {
  const nameEl = screen.getByText(name)
  const line = nameEl.parentElement?.parentElement?.querySelector('.mt-1')
  return line ? line.textContent : null
}

// 第1波も最大波も欠測。到達したかどうかも判っていない地点。
const missing: TsunamiObservation = {
  name: 'いわき市小名浜', districtCode: '250', districtName: '福島県',
  condition: { firstHeightMissing: true, maxHeightMissing: true },
}

describe('観測点の行の到達予想', () => {
  // 正: 実測の到達時刻が無い行に、予報側の到達予想が語つきで出る。
  it('欠測の地点に予報の到達予想を出す', () => {
    render(<TsunamiTab tsunamis={[makeTsunami(
      [{ name: 'いわき市小名浜', code: '25002', arrivalTime: '2026-04-20T05:12:00', highTideDateTime: HIGH_TIDE }],
      [missing],
    )]} isVisible />)
    expect(timeLineOf('いわき市小名浜')).toBe('到達予想 05:12　満潮 07:30')
  })

  // 対照: 実測の到達時刻がある行には出さない。予報の値で観測の事実を上書きしないこと。
  it('実測の到達時刻がある地点には出さない', () => {
    render(<TsunamiTab tsunamis={[makeTsunami(
      [{ name: '相馬', code: '25001', arrivalTime: '2026-04-20T05:08:00', highTideDateTime: HIGH_TIDE }],
      [{
        name: '相馬', districtCode: '250', districtName: '福島県',
        arrivalTime: '2026-04-20T05:09:00', initial: '押し', condition: { maxHeightMissing: true },
      }],
    )]} isVisible />)
    const line = timeLineOf('相馬')
    expect(line).not.toContain('到達予想')
    expect(line).toBe('05:09 押し波　満潮 07:30')
  })

  // 安全弁: 予報側が到達予想を持たない欠測の地点では、満潮時刻だけが出る。
  //
  // **先頭に区切りが残らないこと**まで見る。区切りを前置きする書き方だと、到達時刻の欄が
  // 空のときに満潮時刻だけが字下げされた行になる（到達予想を足す前の実際の見た目）。
  it('予報に到達予想が無ければ何も足さず、先頭に区切りも残さない', () => {
    render(<TsunamiTab tsunamis={[makeTsunami(
      [{ name: 'いわき市小名浜', code: '25002', highTideDateTime: HIGH_TIDE }],
      [missing],
    )]} isVisible />)
    expect(timeLineOf('いわき市小名浜')).toBe('満潮 07:30')
  })

  // 安全弁: 予報側に同名の観測点が無ければ、時刻の欄そのものを出さない。
  it('同名の予報観測点が無ければ時刻の欄を出さない', () => {
    render(<TsunamiTab tsunamis={[makeTsunami([], [missing])]} isVisible />)
    expect(timeLineOf('いわき市小名浜')).toBeNull()
  })

  // 安全弁: 実測を持たない観測点だけの行（「予測」バッジ）も同じ語を使う。同じ
  // `TsunamiStation.arrivalTime` を、実測のエントリが有るか無いかで呼び分けないこと。
  it('予報だけの行も同じ語で出す', () => {
    render(<TsunamiTab tsunamis={[makeTsunami(
      [{ name: '相馬', code: '25001', arrivalTime: '2026-04-20T05:08:00', highTideDateTime: HIGH_TIDE }],
      [],
    )]} isVisible />)
    expect(timeLineOf('相馬')).toBe('到達予想 05:08　満潮 07:30')
  })

  // 安全弁: 予報だけの行も、時刻を 1 つも持たなければ欄ごと出さない（実測の行と同じ扱い）。
  // 名前だけの観測点は電文の構造上ありうる —— `FirstHeight` も `HighTideDateTime` も
  // `Station` の必須要素ではない。
  it('予報だけの行が時刻を持たなければ欄を出さない', () => {
    render(<TsunamiTab tsunamis={[makeTsunami([{ name: '相馬', code: '25001' }], [])]} isVisible />)
    expect(timeLineOf('相馬')).toBeNull()
  })
})
