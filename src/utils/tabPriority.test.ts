// 自動タブ切替の優先度判定のテスト。
//
// 直したかった症状: EEW が realtime タブを確保した直後に地震情報が届くと、無条件にタブを
// 奪われていた。読み上げ側は EEW を守るようにしたのに、画面だけ取られて肝心の予想震度・
// 予報円が見えない状態だった。
import { describe, it, expect } from 'vitest'
import {
  TAB_PRIORITY, TAB_HOLD_MS, TAB_FOLLOW_MIN_DWELL_MS,
  shouldAcceptAutoTab, shouldFollowNow, idleRevertPriority,
  type TabHold,
} from './tabPriority'

const NOW = 1_000_000
const held = (priority: TabHold['priority'], source: TabHold['source'] = 'hold'): TabHold =>
  ({ until: NOW + TAB_HOLD_MS, priority, source })

describe('shouldAcceptAutoTab', () => {
  it('保持が切れていれば、どの優先度でも通す', () => {
    const expired: TabHold = { until: NOW - 1, priority: TAB_PRIORITY.eewUrgent, source: 'hold' }
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
    const hold: TabHold = { until: NOW, priority: TAB_PRIORITY.eewUrgent, source: 'hold' }
    expect(shouldAcceptAutoTab(hold, TAB_PRIORITY.quake, NOW)).toBe(true)
  })
})

// 読み上げに同調した追従（source: 'speech'）の規則。
//
// 直したかった症状: 読み終えた EEW の保持の残りに、次に読む大津波警報や震度速報が
// 弾かれ、声だけが喋って画面が動かない状態になっていた。
describe('shouldAcceptAutoTab（読み上げ追従）', () => {
  it('追従どうしなら、優先度が低くても保持を見ずに通す', () => {
    // 読み上げの行列がすでに順序を決めているため、ここで二重に守ると
    // 読み終えた電文の保持が次を弾く。
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUrgent, 'speech'), TAB_PRIORITY.quake, NOW, 'speech')).toBe(true)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami, 'speech'), TAB_PRIORITY.lpgm, NOW, 'speech')).toBe(true)
  })

  it('追従は、揺れ検知の保持には妨げられない', () => {
    // 揺れ検知は読み上げを持たないため、順序を決める仕組みに参加していない。
    // 声が地震情報を読んでいるのに画面が揺れ検知のまま留まると、この修正の目的自体が損なわれる。
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.kyoshin), TAB_PRIORITY.quake, NOW, 'speech')).toBe(true)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.kyoshin), TAB_PRIORITY.lpgm, NOW, 'speech')).toBe(true)
  })

  it('追従でも、揺れ検知以外の保持機構の保持は優先度で判定する', () => {
    // ここを「手動選択以外は全部突破」まで広げると、津波の受信時フォールバックを長周期が奪い、
    // アイドル復帰が EEW 中に張った保持も地震情報だけで外れる。
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami), TAB_PRIORITY.lpgm, NOW, 'speech')).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami), TAB_PRIORITY.quake, NOW, 'speech')).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUpdate), TAB_PRIORITY.quake, NOW, 'speech')).toBe(false)
    // 同格以上なら通る（従来の規則どおり）
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami), TAB_PRIORITY.tsunami, NOW, 'speech')).toBe(true)
  })

  it('保持機構どうしでは従来の優先度比較が生きている', () => {
    // 読み上げ無効の端末はこちらだけを通る。挙動を変えていないことの確認。
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.kyoshin), TAB_PRIORITY.quake, NOW, 'hold')).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.kyoshin), TAB_PRIORITY.tsunami, NOW, 'hold')).toBe(true)
  })

  it('手動選択の保持中は、追従でも奪わない（EEW の緊急側だけが突破する）', () => {
    // ユーザーが自分で選んだタブだけは、読み上げ追従より強いままにしてある。
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.manual), TAB_PRIORITY.tsunami, NOW, 'speech')).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.manual), TAB_PRIORITY.quake, NOW, 'speech')).toBe(false)
    // 新規発報・レベルアップ・誤報取消（eewUrgent）は追従でも突破する。
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.manual), TAB_PRIORITY.eewUrgent, NOW, 'speech')).toBe(true)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.manual), TAB_PRIORITY.eewUrgent, NOW, 'hold')).toBe(true)
  })

  it('EEW の続報は、他の情報が確保している画面を奪わない', () => {
    // 従来からある片方向の抑制。これが無いと、津波や地震情報を読み上げて画面を移した直後に
    // EEW の続報が来て realtime へ引き戻し、数秒ごとに画面が往復する。
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami, 'speech'), TAB_PRIORITY.eewUpdate, NOW, 'speech')).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.quake, 'speech'), TAB_PRIORITY.eewUpdate, NOW, 'speech')).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.kyoshin), TAB_PRIORITY.eewUpdate, NOW, 'hold')).toBe(false)
    // 同じ系列で realtime を確保している間は素通りさせる（続報のたびに保持を延ばす）
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUrgent, 'speech'), TAB_PRIORITY.eewUpdate, NOW, 'speech')).toBe(true)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUpdate, 'speech'), TAB_PRIORITY.eewUpdate, NOW, 'speech')).toBe(true)
    // 新規発報・レベルアップ・誤報取消は eewUrgent なので抑制に掛からない
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.tsunami, 'speech'), TAB_PRIORITY.eewUrgent, NOW, 'speech')).toBe(true)
  })

  it('長周期地震動は地震情報より軽い（専用の段を持つ）', () => {
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.quake), TAB_PRIORITY.lpgm, NOW)).toBe(false)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.lpgm), TAB_PRIORITY.quake, NOW)).toBe(true)
  })
})

describe('shouldFollowNow', () => {
  it('直前の追従がなければ通す', () => {
    expect(shouldFollowNow(null, TAB_PRIORITY.quake, NOW)).toBe(true)
  })

  it('床の内側は間引くが、境界ちょうどは通す', () => {
    const last = { at: NOW, priority: TAB_PRIORITY.quake }
    expect(shouldFollowNow(last, TAB_PRIORITY.quake, NOW + TAB_FOLLOW_MIN_DWELL_MS - 1)).toBe(false)
    expect(shouldFollowNow(last, TAB_PRIORITY.quake, NOW + TAB_FOLLOW_MIN_DWELL_MS)).toBe(true)
  })

  it('直前より重い情報は床を待たずに通す', () => {
    // 津波の読み上げに EEW が割り込んだ場合。声が切り替わっているのに画面が遅れては困る。
    const last = { at: NOW, priority: TAB_PRIORITY.tsunami }
    expect(shouldFollowNow(last, TAB_PRIORITY.eewUpdate, NOW + 1)).toBe(true)
    expect(shouldFollowNow(last, TAB_PRIORITY.tsunami, NOW + 1)).toBe(false)
  })
})

describe('idleRevertPriority', () => {
  it('EEW 発報中は EEW 続報相当、揺れ検知だけなら揺れ検知の重みで張る', () => {
    expect(idleRevertPriority(true)).toBe(TAB_PRIORITY.eewUpdate)
    expect(idleRevertPriority(false)).toBe(TAB_PRIORITY.kyoshin)
  })

  it('揺れ検知だけの復帰なら、津波はその保持を突破できる', () => {
    // 従来は eewUpdate を張っていたため、津波警報が 15 秒間画面を取れなかった。
    const hold = held(idleRevertPriority(false))
    expect(shouldAcceptAutoTab(hold, TAB_PRIORITY.tsunami, NOW)).toBe(true)
    expect(shouldAcceptAutoTab(held(TAB_PRIORITY.eewUpdate), TAB_PRIORITY.tsunami, NOW)).toBe(false)
  })
})
