// @vitest-environment jsdom
//
// 緊急地震速報の取消しの理由（電文の `Body/Text`）が**画面に出る**ことを固定する。
//
// この項目はパーサー・状態更新・読み上げのテストをすべて通しながら、**画面にだけ出ない**
// という形で落ちうる（オプショナルなフィールドなので型検査も素通りする）。実際、地震情報と
// 津波情報だけを直して EEW の表示を足し忘れていた。画面へ届くことを確かめるには、
// 描いてみる以外に方法が無い（→ quake-spec.md §8「取消しの理由は電文にしかない」）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert } from '../../types/earthquake'

afterEach(cleanup)

function makeCancelledEEW(overrides: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
    },
    severity: 'Warning',
    cancelled: true,
    cancelledAt: new Date('2026-01-01T12:00:30Z'),
    ...overrides,
  }
}

const renderTab = (eews: EEWAlert[]) =>
  render(
    <RealtimeTab
      eews={eews}
      swaveArrival={null}
      kyoshinV2Detections={[]}
      kyoshinDetectedPoints={[]}
      visible
    />,
  )

describe('緊急地震速報の取消オーバーレイ', () => {
  // 正: 電文が理由を持っていれば、そのまま画面に出す。
  it('取消しの理由を画面に出す', () => {
    renderTab([makeCancelledEEW({ cancelText: 'システムの障害により誤った緊急地震速報を配信しました。' })])
    expect(screen.getByText('この緊急地震速報は取り消されました')).toBeTruthy()
    expect(screen.getByText('システムの障害により誤った緊急地震速報を配信しました。')).toBeTruthy()
  })

  // 対照: 理由が無ければ定型文だけ。空の枠を出さない。
  it('理由が無ければ定型文だけを出す', () => {
    renderTab([makeCancelledEEW()])
    expect(screen.getByText('この緊急地震速報は取り消されました')).toBeTruthy()
    expect(screen.queryByText('システムの障害により誤った緊急地震速報を配信しました。')).toBeNull()
  })

  // 安全弁: 取り消されていない EEW にオーバーレイを出さない（`cancelText` が
  // 続報で残っていても、取消しの印が無ければ表示は変えない）。
  it('取消しの印が無ければオーバーレイを出さない', () => {
    renderTab([makeCancelledEEW({ cancelled: false, cancelledAt: undefined, cancelText: '理由' })])
    expect(screen.queryByText('この緊急地震速報は取り消されました')).toBeNull()
    expect(screen.queryByText('理由')).toBeNull()
  })
})
