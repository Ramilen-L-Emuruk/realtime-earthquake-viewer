import { describe, it, expect } from 'vitest'
import {
  createMissingHoldState,
  stepMissingHold,
  MISSING_HOLD_MS,
} from './kyoshinMissingHold'

// 欠測（-1）の瞬断を表示側で吸収する保持ロジックの回帰テスト。
//
// Yahoo の秒データは、強く揺れている観測点でも単発で欠測を返す。保持しないと震度6強級のバッジが
// 1 秒だけ消えて次の秒で戻る明滅になる。一方で、数十秒に及ぶ本物の観測点停止は従来どおり消えなければ
// ならない。実測とこの境目の決め方は docs/spec/kyoshin-detection-v3-design.md §25。

const T0 = Date.parse('2024-01-01T07:10:00Z')
const CFG = '20220301000000'
const MISSING = -1

describe('stepMissingHold: 欠測の瞬断を直前値で埋める', () => {
  it('有効値はそのまま通り、保持中フラグは立たない', () => {
    const st = createMissingHoldState()
    const r = stepMissingHold(st, [18, 6, 0], T0, CFG)
    expect(r.indices).toEqual([18, 6, 0])
    expect(r.stale).toEqual([false, false, false])
  })

  it('1 秒の欠測は直前値で埋め、保持中と印を付ける', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18], T0, CFG)
    const r = stepMissingHold(st, [MISSING], T0 + 1000, CFG)
    expect(r.indices).toEqual([18])
    expect(r.stale).toEqual([true])
  })

  it('値が戻ったら保持中フラグが下がる', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18], T0, CFG)
    stepMissingHold(st, [MISSING], T0 + 1000, CFG)
    const r = stepMissingHold(st, [17], T0 + 2000, CFG)
    expect(r.indices).toEqual([17])
    expect(r.stale).toEqual([false])
  })

  it('保持の上限（MISSING_HOLD_MS）を過ぎたら欠測のまま返す（本物の観測点停止は消える）', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18], T0, CFG)
    const atLimit = stepMissingHold(st, [MISSING], T0 + MISSING_HOLD_MS, CFG)
    expect(atLimit.indices).toEqual([18])
    expect(atLimit.stale).toEqual([true])
    const past = stepMissingHold(st, [MISSING], T0 + MISSING_HOLD_MS + 1000, CFG)
    expect(past.indices).toEqual([MISSING])
    expect(past.stale).toEqual([false])
  })

  it('保持の起点は最後に有効値を観測した時刻（欠測が続いても延びない）', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18], T0, CFG)
    // 1 秒・2 秒は保持、3 秒目（上限 2000ms 超）で切れる
    expect(stepMissingHold(st, [MISSING], T0 + 1000, CFG).stale).toEqual([true])
    expect(stepMissingHold(st, [MISSING], T0 + 2000, CFG).stale).toEqual([true])
    expect(stepMissingHold(st, [MISSING], T0 + 3000, CFG).indices).toEqual([MISSING])
  })

  it('一度も有効値が来ていない点は保持しない', () => {
    const st = createMissingHoldState()
    const r = stepMissingHold(st, [MISSING], T0, CFG)
    expect(r.indices).toEqual([MISSING])
    expect(r.stale).toEqual([false])
  })
})

describe('stepMissingHold: 保持値を捨てる条件', () => {
  it('観測点集合（siteConfigId）が変わったら保持値を捨てる', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18, 18], T0, CFG)
    const r = stepMissingHold(st, [MISSING, MISSING], T0 + 1000, 'other-config')
    expect(r.indices).toEqual([MISSING, MISSING])
    expect(r.stale).toEqual([false, false])
  })

  it('観測点数が変わったら保持値を捨てる（位置対応が崩れるため）', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18, 18], T0, CFG)
    const r = stepMissingHold(st, [MISSING], T0 + 1000, CFG)
    expect(r.indices).toEqual([MISSING])
  })

  it('データ時刻が巻き戻ったら保持値を捨てる（ライブ⇄リプレイ切替）', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18], T0, CFG)
    const r = stepMissingHold(st, [MISSING], T0 - 60_000, CFG)
    expect(r.indices).toEqual([MISSING])
    expect(r.stale).toEqual([false])
  })

  it('データ時刻が読めないフレームは素通しする（保持も更新もしない）', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18], T0, CFG)
    const nan = stepMissingHold(st, [MISSING], Number.NaN, CFG)
    expect(nan.indices).toEqual([MISSING])
    expect(nan.stale).toEqual([false])
    // 素通ししたフレームは保持状態に影響しない（次の欠測では引き続き直前値で埋まる）
    const after = stepMissingHold(st, [MISSING], T0 + 1000, CFG)
    expect(after.indices).toEqual([18])
    expect(after.stale).toEqual([true])
  })
})

describe('stepMissingHold: 同じフレームの再処理', () => {
  it('同一データ時刻で二度呼んでも結果が変わらない（React の再レンダー・StrictMode 対策）', () => {
    const st = createMissingHoldState()
    stepMissingHold(st, [18], T0, CFG)
    const first = stepMissingHold(st, [MISSING], T0 + 1000, CFG)
    const second = stepMissingHold(st, [MISSING], T0 + 1000, CFG)
    expect(second.indices).toEqual(first.indices)
    expect(second.stale).toEqual(first.stale)
  })
})
