// @vitest-environment jsdom
//
// EEW カードの固定付加文（電文の `Comments/WarningComment/Text`。実電文では
// 「強い揺れに警戒してください。」の 1 種類だけ）。
//
// **置き場所そのものが要件。** 電文が言う唯一の行動指示なので、カードの末尾に置くと
// 区域一覧や到達予測の下に埋もれる（→ docs/spec/eew-spec.md §3「固定付加文」）。
// 予想値のバナー群の直後に出ていることを DOM の並びで固定する。
//
// **取消の判定は `cancelledAt`。** `cancelled` は受け取った電文が取消報かを表すフラグで、
// 画面が持つ EEW には伝わらない（状態更新は `{ ...表示中の EEW, cancelledAt }` の形で当てる）。
// `!eew.cancelled` と書いていた版があり、常に真で素通りしていた。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert } from '../../types/earthquake'

afterEach(cleanup)

const COMMENT = '強い揺れに警戒してください。'

function makeEEW(over: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxScale: 50,
    warningComment: COMMENT,
    ...over,
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )

/** a が b より前に出ているか。 */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

describe('EEW カードの固定付加文', () => {
  // 正: 警報級の報で付加文が出る。
  it('付加文を持つ報では原文をそのまま出す', () => {
    renderTab(makeEEW())
    expect(screen.getByText(COMMENT)).toBeTruthy()
  })

  // 安全弁: 位置が予想値のバナー群の直後であること（末尾へ戻していないこと）。
  it('予想最大震度より後・発生時刻より前に置く', () => {
    renderTab(makeEEW())
    const comment = screen.getByText(COMMENT)
    const maxScaleLabel = screen.getByText('予想最大震度')
    const originTime = screen.getByText(/ごろ$/)
    expect(precedes(maxScaleLabel, comment)).toBe(true)
    expect(precedes(comment, originTime)).toBe(true)
  })

  // 対照: 付加文を持たない報（実電文では予報級）では何も足さない。
  it('付加文が無ければ出さない', () => {
    renderTab(makeEEW({ warningComment: undefined }))
    expect(screen.queryByText(COMMENT)).toBeNull()
  })

  // 安全弁: 取消の印は `cancelledAt`。判定を `cancelled` へ戻すとこのテストが落ちる ——
  // 画面が持つ EEW の `cancelled` は取消後も false のままなので、付加文が出てしまう。
  it('取消（cancelledAt）では出さない', () => {
    renderTab(makeEEW({ cancelledAt: new Date('2026-01-01T12:01:00Z') }))
    expect(screen.queryByText(COMMENT)).toBeNull()
  })
})
