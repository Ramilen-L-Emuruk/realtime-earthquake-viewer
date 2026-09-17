// @vitest-environment jsdom
//
// 履歴の一部が取れなかったことを地震タブへ出す。
//
// 履歴取得は例外を投げずに一部の失敗を吸収するため `error` は立たない。**画面には取れた分の
// カードだけが出て、失敗は何も出ない**状態だった（実測 2026-09-15: 起動時の電文本体 85 件のうち
// 81 件が 429 で失敗し、4 件しか出ていなかった）。取得元が「日」単位なので、1 日落ちれば
// 失う電文は多い。
//
// **いちばん効くのはカードが 0 件のとき。** 出さないと「7 日のうち 6 日が落ちて 0 件」が
// 「まったく静かな期間だった」と同じ画になる。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss, addTelegramLoss, type TelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: `dmdata-quake-${EVENT_ID}-1`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:24:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T16:10:00+09:00',
    hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
    maxScale: 45,
    domesticTsunami: '警報等',
  },
  points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 45 }],
}

function renderTab(opts: {
  earthquakes?: JMAQuake[]
  historyLoss?: TelegramLoss
  loadMoreFailed?: boolean
  error?: string | null
}) {
  const earthquakes = opts.earthquakes ?? [QUAKE]
  return render(
    <EarthquakeTab
      earthquakes={earthquakes}
      selectedId={earthquakes[0] ? quakeEventKey(earthquakes[0]) : null}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={false}
      onLoadMore={() => {}}
      error={opts.error ?? null}
      historyLoss={opts.historyLoss ?? createEmptyTelegramLoss()}
      loadMoreFailed={opts.loadMoreFailed ?? false}
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
  )
}

describe('履歴の一部が取れなかったときの帯', () => {
  it('正: 取得元が 1 件でも読めなければ帯を出す', () => {
    renderTab({ historyLoss: addTelegramLoss(createEmptyTelegramLoss(), 0, ['https://x/a']) })

    expect(screen.getByText(/1 件の取得元.*取り込めませんでした/)).toBeTruthy()
  })

  // **カードは覆わない。** 全画面のエラー表示と違って、取れた分は見られなければならない。
  it('正: 帯を出してもカードは残る', () => {
    renderTab({ historyLoss: addTelegramLoss(createEmptyTelegramLoss(), 2, []) })

    expect(screen.getByText(/2 件の電文/)).toBeTruthy()
    expect(screen.getByText('石川県能登地方')).toBeTruthy()
  })

  // ここが「静かな期間だった」との見分け。
  it('正: カードが 0 件でも帯を出す（「地震情報はありません」だけにしない）', () => {
    renderTab({
      earthquakes: [],
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), 0, ['https://x/a', 'https://x/b']),
    })

    expect(screen.getByText('地震情報はありません')).toBeTruthy()
    expect(screen.getByText(/2 件の取得元/)).toBeTruthy()
  })

  it('対照: 何も欠けていなければ帯は出ない', () => {
    renderTab({})

    expect(screen.queryByText(/取り込めませんでした/)).toBeNull()
  })

  it('対照: カードが 0 件でも、欠けていなければ帯は出ない', () => {
    renderTab({ earthquakes: [] })

    expect(screen.getByText('地震情報はありません')).toBeTruthy()
    expect(screen.queryByText(/取り込めませんでした/)).toBeNull()
  })

  // 確定した損失と、押し直せば回復しうる失敗は別の文面で出す。混ぜると、戻せない損失と
  // 戻せる失敗が同じ重さに見える。
  it('正: 「もっと見る」の失敗は別の文面で出す', () => {
    renderTab({ loadMoreFailed: true })

    expect(screen.getByText(/続きの読み込みに失敗しました/)).toBeTruthy()
  })

  it('正: 両方あれば両方出す', () => {
    renderTab({
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), 1, []),
      loadMoreFailed: true,
    })

    expect(screen.getByText(/1 件の電文/)).toBeTruthy()
    expect(screen.getByText(/続きの読み込みに失敗しました/)).toBeTruthy()
  })

  // 安全弁: 1 件も取れなかったとき（`error`）は全画面の失敗表示が出る。そこへ帯を重ねない
  // ——「一部が欠けた」と「まるごと失敗した」が同じ画面に並ぶと、どちらの話か読めない。
  it('安全弁: 全滅の表示中は帯を出さない', () => {
    renderTab({
      error: '取得失敗',
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), 1, ['https://x/a']),
    })

    expect(screen.getByText('データの取得に失敗しました')).toBeTruthy()
    expect(screen.queryByText(/取り込めませんでした（再読み込み/)).toBeNull()
  })
})
