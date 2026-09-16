// 電文の取得で取りこぼした量の数え方と、ライブ側（地震タブ）へ出す文面。
//
// リプレイ側の `ReplayLoss` はこの型を拡張して先読みの失敗を足す。数え方を 2 本持つと
// 片方だけ「同じ取得元を二重に数えない」を落とすため、ここが単一の情報源。
//
// **積む（`addTelegramLoss`）か置き換える（`telegramLossFrom`）かは、その入れ物が何を持つかで
// 決まる。** ライブの `historyLoss` は履歴の取得 1 本だけを持つので置き換え、リプレイの
// `ReplayLoss` は他の取得も同じ入れ物へ集めるので積む。取り違えると「取れているのに失敗中と
// 出続ける」形になる。
import { describe, it, expect } from 'vitest'
import {
  createEmptyTelegramLoss, addTelegramLoss, telegramLossFrom, isTelegramLossEmpty,
  describeTelegramLossParts, formatHistoryLossNotice,
} from './telegramLoss'

describe('addTelegramLoss', () => {
  it('電文の取りこぼしを積み上げる', () => {
    let loss = createEmptyTelegramLoss()
    loss = addTelegramLoss(loss, 3, [])
    loss = addTelegramLoss(loss, 2, [])

    // 一度失われた電文は後続の取得が成功しても戻らないので、消さずに積む
    expect(loss.skippedTelegrams).toBe(5)
  })

  // 起動時の履歴と「もっと見る」は日付範囲が重なるため同じアーカイブを両方が読む。
  // 件数で合算すると 1 件の障害が「2 件」と表示される。
  it('同じ取得元を二重に数えない', () => {
    let loss = createEmptyTelegramLoss()
    loss = addTelegramLoss(loss, 0, ['https://x/a', 'live:2026-09-15'])
    loss = addTelegramLoss(loss, 0, ['https://x/a'])

    expect(loss.failedSources.size).toBe(2)
  })

  it('元の損失を書き換えない（不変）', () => {
    const original = createEmptyTelegramLoss()
    const next = addTelegramLoss(original, 1, ['https://x/a'])

    expect(original.skippedTelegrams).toBe(0)
    expect(original.failedSources.size).toBe(0)
    expect(next.skippedTelegrams).toBe(1)
  })

  // `ReplayLoss` のように項目を足した型でもそのまま積めること（型を保って返す）。
  it('足した項目は保つ', () => {
    const loss = { ...createEmptyTelegramLoss(), failedPrefetches: 2 }
    const next = addTelegramLoss(loss, 1, ['https://x/a'])

    expect(next.failedPrefetches).toBe(2)
    expect(next.skippedTelegrams).toBe(1)
  })
})

// ライブの履歴取得は毎回「その時点の全範囲」を走査して数え直すので、積むと
// ①同じ損失を呼び出しの回数だけ数え ②取得が回復しても消えない、の 2 つが起きる。
describe('telegramLossFrom', () => {
  it('正: 渡した結果そのものになる（積まない）', () => {
    const loss = telegramLossFrom(2, ['https://x/a'])

    expect(loss.skippedTelegrams).toBe(2)
    expect(loss.failedSources.size).toBe(1)
  })

  it('正: 回復した結果で置き換えれば空になる', () => {
    const before = telegramLossFrom(2, ['https://x/a'])
    const after = telegramLossFrom(0, [])

    expect(isTelegramLossEmpty(before)).toBe(false)
    expect(isTelegramLossEmpty(after)).toBe(true)
  })

  // 渡した配列を握り込むと、呼び出し側が後で書き換えたときに損失が変わる
  it('安全弁: 渡した配列を握らない', () => {
    const ids = ['https://x/a']
    const loss = telegramLossFrom(0, ids)
    ids.push('https://x/b')

    expect(loss.failedSources.size).toBe(1)
  })
})

describe('isTelegramLossEmpty', () => {
  it('何も欠けていなければ真', () => {
    expect(isTelegramLossEmpty(createEmptyTelegramLoss())).toBe(true)
  })

  it('電文だけ欠けても偽', () => {
    expect(isTelegramLossEmpty(addTelegramLoss(createEmptyTelegramLoss(), 1, []))).toBe(false)
  })

  it('取得元だけ欠けても偽', () => {
    expect(isTelegramLossEmpty(addTelegramLoss(createEmptyTelegramLoss(), 0, ['https://x/a']))).toBe(false)
  })
})

describe('describeTelegramLossParts', () => {
  // 取得元単位の失敗は「その日の電文が何通あったか」すら分からないため、電文数に合算できない。
  it('取得元と電文を別に数える', () => {
    const parts = describeTelegramLossParts(addTelegramLoss(createEmptyTelegramLoss(), 5, ['https://x/a']))

    expect(parts).toEqual(['1 件の取得元', '5 件の電文'])
  })

  it('何も欠けていなければ空', () => {
    expect(describeTelegramLossParts(createEmptyTelegramLoss())).toEqual([])
  })
})

describe('formatHistoryLossNotice', () => {
  it('何も欠けていなければ出さない', () => {
    expect(formatHistoryLossNotice(createEmptyTelegramLoss())).toBeNull()
  })

  // 取得元が「日」単位になったぶん、1 日落ちれば失う電文は多い。リプレイ側も 1 件から
  // 出しており、ライブだけ黙ると同じ障害が片方でしか見えない。
  it('正: 取得元 1 件でも出す', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), 0, ['https://x/a']))

    expect(msg).toMatch(/1 件の取得元/)
  })

  it('正: 電文 1 件でも出す', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), 1, []))

    expect(msg).toMatch(/1 件の電文/)
  })

  it('両方欠けたときは両方を並べる', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), 5, ['https://x/a']))

    expect(msg).toMatch(/1 件の取得元/)
    expect(msg).toMatch(/5 件の電文/)
  })

  // 自動では取り直さないので、添えないと打てる手が分からない。
  it('安全弁: 取得し直す手立てを添える', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), 1, []))

    expect(msg).toMatch(/再読み込み/)
  })
})
