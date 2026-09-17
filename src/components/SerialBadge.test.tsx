// @vitest-environment jsdom
//
// 種別ヘッダーに添える報番号の見た目（→ `components/SerialBadge.tsx`）。
//
// **緊急地震速報と地震情報カードで揃っていることを守る。** 揃える理由は部品側に書いてある。
//
// 見た目は描いてみないと確かめられないので、クラス名の一致ではなく**両方をレンダーして
// 突き合わせる**。文字列で書き写すと、写した側だけが古くなる。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { RealtimeTab } from './RealtimeTab'
import { EarthquakeTab } from './EarthquakeTab'
import { quakeEventKey } from '../utils/quakeMerge'
import type { EEWAlert, JMAQuake, QuakeReportRecord } from '../types/earthquake'
import { createEmptyTelegramLoss } from '../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

function makeEEW(serial: string): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '茨城県沖', latitude: 36.2, longitude: 141.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { serial },
  }
}

function makeQuake(reports: QuakeReportRecord[]): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20240101160610-1',
    eventId: '20240101160610',
    time: '2024-01-01T07:10:00Z',
    issue: { source: 'テスト', time: '2024-01-01T07:10:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:06:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.3, depth: 16, magnitude: 7.6 },
      maxScale: 70,
      domesticTsunami: '警報等',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 70 }],
    reports,
  }
}

const renderEEW = (eew: EEWAlert) =>
  render(
    <RealtimeTab eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  ).container

const renderQuake = (quake: JMAQuake, selected = true) =>
  render(
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={selected ? quakeEventKey(quake) : 'other'}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={false}
      onLoadMore={() => {}}
      error={null}
      historyLoss={createEmptyTelegramLoss()}
      loadMoreFailed={false}
      lpgmByEventId={new Map()}
      activeLpgmEventId={null}
      onToggleLpgm={() => {}}
      estimatedIntensity={null}
      distributionQuakeKey={null}
      onToggleDistribution={() => {}}
      unreceivedQuakeKey={null}
      onToggleUnreceived={() => {}}
      onFocusMap={() => {}}
      speakingTelegramTextSubject={null}
    />,
  ).container

/** 種別ヘッダー（`緊急地震速報（警報）#1` / `震度速報 #2 / 震源情報` を出す帯）。 */
const header = (container: HTMLElement) => container.querySelector('.tracking-widest') as HTMLElement

/**
 * ヘッダーの中の報番号だけを取り出す。
 *
 * **地の文から切り出さない。** 番号が種別名と別の要素になっていること自体が守りたい形なので、
 * 要素として引けるかどうかで判定する。
 */
const serialEl = (host: HTMLElement) =>
  [...host.querySelectorAll('span')].find(el => el.textContent?.trim().startsWith('#')) ?? null

/** 2 通受け取った震度速報と、1 通だけの震源情報。 */
const TWO_AND_ONE: QuakeReportRecord[] = [
  { type: '震度速報', keys: ['2024-01-01T07:07:40Z', '2024-01-01T07:12:00Z'] },
  { type: '震源情報', keys: ['2024-01-01T07:10:30Z'] },
]

describe('報番号の見た目', () => {
  // 正: 緊急地震速報の報番号が、種別名とは別の要素として出る。
  it('緊急地震速報では報番号が別の要素で出る', () => {
    const head = header(renderEEW(makeEEW('1')))
    expect(head.textContent).toContain('緊急地震速報（警報）')
    const badge = serialEl(head)
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('#1')
  })

  // 正: 地震情報カードでも同じ形で出る。**種別名へ直付けしない。**
  it('地震情報カードでも報番号が別の要素で出る', () => {
    const head = header(renderQuake(makeQuake(TWO_AND_ONE)))
    expect(head.textContent).toContain('震度速報')
    expect(head.textContent).toContain('震源情報')
    const badge = serialEl(head)
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('#2')
    // 種別名は器の外。`震度速報#2` のように 1 つの要素へ畳まれていたら落ちる。
    expect(badge!.textContent).not.toContain('震度速報')
  })

  // **安全弁: 2 つの器が同じ見た目であること。** 片方だけ書き換えたらここで止まる。
  it('緊急地震速報と地震情報カードで器のクラスが一致する', () => {
    const eewHead = header(renderEEW(makeEEW('1')))
    const eewBadge = serialEl(eewHead)!
    const eewClasses = { head: eewHead.className, badge: eewBadge.className }
    cleanup()
    const quakeHead = header(renderQuake(makeQuake(TWO_AND_ONE)))
    expect(serialEl(quakeHead)!.className).toBe(eewClasses.badge)
    // 種別ヘッダーそのものも同じ器。番号の細さ・薄さはこの中での相対的な弱さなので、
    // 器が違えば同じクラスでも見え方が変わる。
    expect(quakeHead.className).toBe(eewClasses.head)
  })

  // 対照: 1 通しか受け取っていない種別には番号を付けない。
  it('1 通だけの種別には報番号を出さない', () => {
    const head = header(renderQuake(makeQuake([{ type: '震源情報', keys: ['2024-01-01T07:10:30Z'] }])))
    expect(head.textContent).toContain('震源情報')
    expect(serialEl(head)).toBeNull()
  })

  // 正: 畳んだカードの種別バッジでも同じ形で出す（開いた表示と語を揃える）。
  it('畳んだカードでも報番号が別の要素で出る', () => {
    const container = renderQuake(makeQuake(TWO_AND_ONE), false)
    const badge = serialEl(container)
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('#2')
  })
})
