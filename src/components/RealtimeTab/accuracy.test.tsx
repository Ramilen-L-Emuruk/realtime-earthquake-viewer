// @vitest-environment jsdom
//
// EEW カードの「震源の決め方」（電文の `Hypocenter/Accuracy`）。
//
// **震央と深さをまとめるかどうかは、生のランク値で比べる。** 表示文字列で比べると、
// 深さのランクが 0（不明）や対応表に無い値のとき文字列が空になり「同じ」と判定され、
// 震央の精度が「震源」（震央＋深さ）としてまとめて出てしまう —— 深さの精度が不明である
// ことが画面から消える。この分岐は描いてみないと確かめられない。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAccuracy, EEWAlert } from '../../types/earthquake'

afterEach(cleanup)

function makeEEW(accuracy?: EEWAccuracy): EEWAlert {
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
    ...(accuracy && { accuracy }),
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )

/**
 * 「震源の決め方」のブロックだけを取り出す。
 *
 * **カード全体を対象に文字を探さないこと。** 「深さ」はマグニチュードと並ぶ震源の深さの欄にも
 * あり、素で探すとそちらを拾って常に真になる（この取り違えで最初のテストが落ちた）。
 */
function accuracyBlock(): HTMLElement | null {
  const label = screen.queryByText('震源の決め方')
  return label ? label.closest('div.flex.flex-col') as HTMLElement : null
}

describe('EEW カードの「震源の決め方」', () => {
  // 正: 震央と深さが同じランクなら 1 行にまとめ、見出しは「震源」。
  it('震央と深さが同じなら 1 行にまとめる', () => {
    renderTab(makeEEW({ epicenterRank: 4, depthRank: 4, magnitudeRank: 4, magnitudePoints: 5 }))
    const block = within(accuracyBlock()!)
    expect(block.getByText('震源')).toBeTruthy()
    expect(block.queryByText('深さ')).toBeNull()
    expect(block.getByText('IPF法（5点以上）')).toBeTruthy()
    expect(block.getByText('P相／全相混在・5点以上')).toBeTruthy()
  })

  // 対照: 値が違えば 2 行に分け、見出しを「震央」と「深さ」にする。
  it('震央と深さが違えば分けて出す', () => {
    renderTab(makeEEW({ epicenterRank: 4, depthRank: 2 }))
    const block = within(accuracyBlock()!)
    expect(block.getByText('震央')).toBeTruthy()
    expect(block.getByText('深さ')).toBeTruthy()
    expect(block.getByText('IPF法（5点以上）')).toBeTruthy()
    expect(block.getByText('IPF法（2点）')).toBeTruthy()
  })

  // **安全弁: 深さのランクが 0（不明）でも「同じ」に倒さない。**
  // ここが表示文字列の比較だと、震央の精度が「震源」としてまとめて出てしまう。
  it('深さが不明（0）なら震央としてだけ出す', () => {
    renderTab(makeEEW({ epicenterRank: 4, depthRank: 0 }))
    const block = within(accuracyBlock()!)
    expect(block.getByText('震央')).toBeTruthy()
    expect(block.queryByText('震源')).toBeNull()
    // 深さの行は語が無いので出ない（「不明」とは書かない）
    expect(block.queryByText('深さ')).toBeNull()
  })

  // 対照: 精度をまったく持たない電文では欄ごと出ない。
  it('精度が無ければ欄ごと出ない', () => {
    renderTab(makeEEW())
    expect(screen.queryByText('震源の決め方')).toBeNull()
    expect(accuracyBlock()).toBeNull()
  })

  // 正: rank2 の 9 のときだけ「これ以降変わりません」を出す。**「最終報」とは書かない**
  // （資料は同じ注で「PLUM 法により予測震度が今後変化する可能性はある」と断っている）。
  it('震源とＭが確定したことを出す', () => {
    renderTab(makeEEW({ epicenterRank: 6, epicenterRank2: 9 }))
    expect(screen.getByText('震源とＭはこれ以降変わりません')).toBeTruthy()
  })

  it('rank2 が 9 でなければ出さない', () => {
    renderTab(makeEEW({ epicenterRank: 6, epicenterRank2: 4 }))
    expect(screen.queryByText('震源とＭはこれ以降変わりません')).toBeNull()
  })
})
