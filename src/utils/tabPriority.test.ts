// 自動タブ切替の優先度判定のテスト。
//
// 直したかった症状: EEW が realtime タブを確保した直後に地震情報が届くと、無条件にタブを
// 奪われていた。読み上げ側は EEW を守るようにしたのに、画面だけ取られて肝心の予想震度・
// 予報円が見えない状態だった。
import { describe, it, expect } from 'vitest'
import { TAB_PRIORITY, TAB_HOLD_MS, shouldAcceptAutoTab, type TabHold } from './tabPriority'

const NOW = 1_000_000
const held = (priority: TabHold['priority']): TabHold => ({ until: NOW + TAB_HOLD_MS, priority })

describe('shouldAcceptAutoTab', () => {
  it('保持が切れていれば、どの優先度でも通す', () => {
    const expired: TabHold = { until: NOW - 1, priority: TAB_PRIORITY.eewUrgent }
    expect(shouldAcceptAutoTab(expired, TAB_PRIORITY.quake, NOW)).toBe(true)
  })

  // これが本題。EEW が確保している間は地震情報・長周期にタブを渡さない。
  it('EEW が確保している間、地震情報はタブを奪えない', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUrgent), TAB_PRIORITY.quake, NOW)).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUpdate), TAB_PRIORITY.quake, NOW)).toBe(false)
  })

  it('EEW が確保している間、津波もタブを奪えない（読み上げと同じ順）', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUrgent), TAB_PRIORITY.tsunami, NOW)).toBe(false)
  })

  // 揺れ検知は「いま揺れている」を示すので地震情報より重く、避難行動を促す津波より軽い。
  it('揺れ検知は地震情報に奪われず、津波には譲る', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.kyoshin), TAB_PRIORITY.quake, NOW)).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.kyoshin), TAB_PRIORITY.tsunami, NOW)).toBe(true)
  })

  it('津波が確保している間、地震情報はタブを奪えない', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami), TAB_PRIORITY.quake, NOW)).toBe(false)
  })

  // 同格は通す。新しい情報が古い情報を置き換えるのは読み上げと同じ規則。
  it('同格どうしは通す', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.quake), TAB_PRIORITY.quake, NOW)).toBe(true)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami), TAB_PRIORITY.tsunami, NOW)).toBe(true)
  })

  // 既存の挙動。ユーザーが自分で選んだタブを EEW の続報に奪わせない。
  it('手動選択の保持中、EEW の続報はタブを奪えない', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.manual), TAB_PRIORITY.eewUpdate, NOW)).toBe(false)
  })

  // これも既存の挙動。危険の通知は手動選択より強い。
  it('手動選択の保持中でも、EEW の新規発報・レベルアップ・誤報取消は通す', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.manual), TAB_PRIORITY.eewUrgent, NOW)).toBe(true)
  })

  it('保持の期限ちょうどは通す（境界）', () => {
    const hold: TabHold = { until: NOW, priority: TAB_PRIORITY.eewUrgent }
    expect(shouldAcceptAutoTab(hold, TAB_PRIORITY.quake, NOW)).toBe(true)
  })
})
