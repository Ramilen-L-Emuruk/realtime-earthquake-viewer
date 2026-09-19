// 電文の取得で取りこぼした量の数え方と、ライブ側（地震タブ）へ出す文面。
//
// リプレイ側の `ReplayLoss` はこの型を拡張して先読みの失敗を足す。数え方を 2 本持つと
// 片方だけ「同じ取得元を二重に数えない」を落とすため、ここが単一の情報源。
//
// **「積むか置き換えるか」で悩んだら持ち方のほうを疑う。** 中身がただの件数だと、積めば重複し、
// 置き換えれば前に確定した分が消える —— どちらを選んでも正しくならない。取得元は識別子の集合・
// 電文は日ごとに持たせることで、その判断そのものが要らなくなっている。
import { describe, it, expect } from 'vitest'
import {
  createEmptyTelegramLoss, addTelegramLoss, telegramLossFrom, isTelegramLossEmpty,
  describeTelegramLossParts, formatHistoryLossNotice, formatRateLimitedNotice,
  FETCH_THROTTLED_NOTICE, totalSkipped, mergeHistoryLoss, createSkipCounter, UNKNOWN_SKIP_DAY,
} from './telegramLoss'

/**
 * テスト用: 取りこぼしを日ごとの Map にする。
 *
 * 実装が件数ひとつから日ごとへ変わったのは、同じ日を二度読んでも二重に数えず、別の日の分も
 * 失わないため（→ `utils/telegramLoss.ts` の `skippedByDay`）。日を書き分けたいテストは
 * 第 2 引数を渡す。
 */
function skips(count: number, day = '2026-08-10'): Map<string, number> {
  return count > 0 ? new Map([[day, count]]) : new Map()
}


describe('addTelegramLoss', () => {
  it('別の日の取りこぼしは積み上げる', () => {
    let loss = createEmptyTelegramLoss()
    loss = addTelegramLoss(loss, skips(3, '2026-09-10'), [])
    loss = addTelegramLoss(loss, skips(2, '2026-09-03'), [])

    // 一度失われた電文は後続の取得が成功しても戻らないので、消さずに積む
    expect(totalSkipped(loss)).toBe(5)
  })

  // **同じ日でも足す。** ここで集めるのは別々の取得（リプレイの本編・初期状態・履歴・先読み）
  // で、同じ日に別々の電文が壊れていれば足すべき 2 件になる。日付範囲が重なる取得どうしで
  // 同じ破損を二度数えることはあるが、**少なく見せて「静かな時間帯だった」と誤読されるより、
  // 多めに申告する側へ倒す**（旧実装からの方針）。
  //
  // 「同じ範囲を読み直す」側（カーソル方式の「もっと見る」）は `mergeHistoryLoss` が担当する。
  it('同じ日の取りこぼしも足す（別々の取得を集めるため）', () => {
    let loss = createEmptyTelegramLoss()
    loss = addTelegramLoss(loss, skips(3, '2026-09-10'), [])
    loss = addTelegramLoss(loss, skips(2, '2026-09-10'), [])

    expect(totalSkipped(loss)).toBe(5)
  })

  // 起動時の履歴と「もっと見る」は日付範囲が重なるため同じアーカイブを両方が読む。
  // 件数で合算すると 1 件の障害が「2 件」と表示される。
  it('同じ取得元を二重に数えない', () => {
    let loss = createEmptyTelegramLoss()
    loss = addTelegramLoss(loss, skips(0), ['https://x/a', 'live:2026-09-15'])
    loss = addTelegramLoss(loss, skips(0), ['https://x/a'])

    expect(loss.failedSources.size).toBe(2)
  })

  // **鍵まで見る**（理由は `mergeHistoryLoss` 側の同名のテスト）。
  it('日ごとの中身まで足し合わせる', () => {
    let loss = createEmptyTelegramLoss()
    loss = addTelegramLoss(loss, new Map([['2026-09-10', 3], ['2026-09-03', 1]]), [])
    loss = addTelegramLoss(loss, new Map([['2026-09-10', 2]]), [])

    expect(loss.skippedByDay).toEqual(new Map([['2026-09-10', 5], ['2026-09-03', 1]]))
  })

  it('元の損失を書き換えない（不変）', () => {
    const original = createEmptyTelegramLoss()
    const next = addTelegramLoss(original, skips(1), ['https://x/a'])

    expect(totalSkipped(original)).toBe(0)
    expect(original.failedSources.size).toBe(0)
    expect(totalSkipped(next)).toBe(1)
  })

  // `ReplayLoss` のように項目を足した型でもそのまま積めること（型を保って返す）。
  it('足した項目は保つ', () => {
    const loss = { ...createEmptyTelegramLoss(), failedPrefetches: 2 }
    const next = addTelegramLoss(loss, skips(1), ['https://x/a'])

    expect(next.failedPrefetches).toBe(2)
    expect(totalSkipped(next)).toBe(1)
  })
})

// ライブの履歴取得は毎回「その時点の全範囲」を走査して数え直すので、積むと
// ①同じ損失を呼び出しの回数だけ数え ②取得が回復しても消えない、の 2 つが起きる。
describe('telegramLossFrom', () => {
  it('正: 渡した結果そのものになる（積まない）', () => {
    const loss = telegramLossFrom(skips(2), ['https://x/a'])

    expect(totalSkipped(loss)).toBe(2)
    expect(loss.failedSources.size).toBe(1)
  })

  it('正: 回復した結果で置き換えれば空になる', () => {
    const before = telegramLossFrom(skips(2), ['https://x/a'])
    const after = telegramLossFrom(skips(0), [])

    expect(isTelegramLossEmpty(before)).toBe(false)
    expect(isTelegramLossEmpty(after)).toBe(true)
  })

  // 渡した配列を握り込むと、呼び出し側が後で書き換えたときに損失が変わる
  it('安全弁: 渡した配列を握らない', () => {
    const ids = ['https://x/a']
    const loss = telegramLossFrom(skips(0), ids)
    ids.push('https://x/b')

    expect(loss.failedSources.size).toBe(1)
  })
})

describe('isTelegramLossEmpty', () => {
  it('何も欠けていなければ真', () => {
    expect(isTelegramLossEmpty(createEmptyTelegramLoss())).toBe(true)
  })

  it('電文だけ欠けても偽', () => {
    expect(isTelegramLossEmpty(addTelegramLoss(createEmptyTelegramLoss(), skips(1), []))).toBe(false)
  })

  it('取得元だけ欠けても偽', () => {
    expect(isTelegramLossEmpty(addTelegramLoss(createEmptyTelegramLoss(), skips(0), ['https://x/a']))).toBe(false)
  })
})

describe('describeTelegramLossParts', () => {
  // 取得元単位の失敗は「その日の電文が何通あったか」すら分からないため、電文数に合算できない。
  it('取得元と電文を別に数える', () => {
    const parts = describeTelegramLossParts(addTelegramLoss(createEmptyTelegramLoss(), skips(5), ['https://x/a']))

    expect(parts).toEqual(['取得元1件', '電文5件'])
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
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(0), ['https://x/a']))

    expect(msg).toMatch(/取得元1件/)
  })

  it('正: 電文 1 件でも出す', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(1), []))

    expect(msg).toMatch(/電文1件/)
  })

  it('両方欠けたときは両方を並べる', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(5), ['https://x/a']))

    expect(msg).toMatch(/取得元1件/)
    expect(msg).toMatch(/電文5件/)
  })

  // **429 の見送り（`formatRateLimitedNotice`）と同じ `notices` に並びうる。** 通知の形を
  // 揃えたぶん、「取りに行って失敗した」と「上限で取りに行かなかった」の差は語だけが担う。
  it('安全弁: 見送りの「未取得」と語を分ける', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(1), []))

    expect(msg).toMatch(/取り込めず/)
    expect(msg).not.toMatch(/未取得/)
  })

  // 自動では取り直さないので、添えないと打てる手が分からない。
  it('安全弁: 取得し直す手立てを添える', () => {
    const msg = formatHistoryLossNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(1), []))

    expect(msg).toMatch(/再読み込み/)
  })
})

// 429 の窓で**取りに行かなかった**分。**取得の失敗とは別の枠で数える**——
// あちらは恒久的な喪失、こちらは待てば取れる（→ `types/replay.ts` の `rateLimitedSources`）。
describe('429 の見送りは取得の失敗と別に数える', () => {
  // 正: 見送りを積める
  it('正: 取得元と電文をそれぞれ積む', () => {
    const loss = addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], {
      sources: ['https://x/a'], telegrams: 3,
    })

    expect(loss.rateLimitedSources.size).toBe(1)
    expect(loss.rateLimitedTelegrams).toBe(3)
  })

  // 対照: 取得の失敗の枠へは混ざらない（混ぜると「再読み込みで取得し直します」が嘘になる）
  it('対照: 取得の失敗の枠へは入れない', () => {
    const loss = addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], {
      sources: ['https://x/a'], telegrams: 3,
    })

    expect(loss.failedSources.size).toBe(0)
    expect(totalSkipped(loss)).toBe(0)
  })

  // 安全弁: 同じ取得元を二重に数えない（取得の失敗と同じ規律）
  it('安全弁: 同じ取得元を二重に数えない', () => {
    let loss = addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], { sources: ['https://x/a'] })
    loss = addTelegramLoss(loss, skips(0), [], { sources: ['https://x/a', 'https://x/b'] })

    expect(loss.rateLimitedSources.size).toBe(2)
  })

  // 見送りがあるだけでも「何も欠けていない」とは言わない
  it('見送りだけでも空とみなさない', () => {
    const loss = telegramLossFrom(skips(0), [], { telegrams: 1 })

    expect(isTelegramLossEmpty(loss)).toBe(false)
  })

  it('見送りが無ければ空', () => {
    expect(isTelegramLossEmpty(telegramLossFrom(skips(0), []))).toBe(true)
  })
})

describe('formatRateLimitedNotice', () => {
  // 対照: 見送りが無ければ出さない
  it('対照: 見送りが無ければ null', () => {
    expect(formatRateLimitedNotice(createEmptyTelegramLoss())).toBeNull()
    expect(formatRateLimitedNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(5), ['https://x/a']))).toBeNull()
  })

  // 正: 両方あれば両方の単位で出す
  it('正: 取得元と電文を単位ごとに出す', () => {
    const msg = formatRateLimitedNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], {
      sources: ['https://x/a', 'https://x/b'], telegrams: 5,
    }))

    expect(msg).toBe('リクエスト過多のため、取得制限中（取得元2件・電文5件が未取得）')
  })

  // 安全弁: **単位を混ぜない。** 取得元単位で見送った日は「その日に何通あったか」すら
  // 分からないので、電文数へ合算できない。
  it('安全弁: 取得元だけのとき、電文の件数を書かない', () => {
    const msg = formatRateLimitedNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], {
      sources: ['https://x/a'],
    }))

    expect(msg).toBe('リクエスト過多のため、取得制限中（取得元1件が未取得）')
  })

  it('安全弁: 電文だけのとき、取得元の件数を書かない', () => {
    const msg = formatRateLimitedNotice(addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], {
      telegrams: 2,
    }))

    expect(msg).toBe('リクエスト過多のため、取得制限中（電文2件が未取得）')
  })

  // **待っているだけの告知と主節をそろえる。** 利用者にとっては同じ「アプリが自分で絞っている」
  // 事実で、違うのは結果だけ（待てば取れる／その回は取らなかった）。
  it('待ちの告知と主節がそろっている', () => {
    const msg = formatRateLimitedNotice(telegramLossFrom(skips(0), [], { telegrams: 1 }))
    const head = 'リクエスト過多のため、取得制限中'

    expect(FETCH_THROTTLED_NOTICE.startsWith(head)).toBe(true)
    expect(msg?.startsWith(head)).toBe(true)
    // 括弧の中だけが違う
    expect(FETCH_THROTTLED_NOTICE).not.toBe(msg)
  })
})

// 取得側が取りこぼしを数える入れ物。**合流の規則がここで決まる**ので、単体で固定する。
describe('createSkipCounter', () => {
  // 正: 日ごとに数える
  it('正: 日ごとに数える', () => {
    const c = createSkipCounter()
    c.add('2026-09-10')
    c.add('2026-09-10')
    c.add('2026-09-03')

    expect(c.toMap()).toEqual(new Map([['2026-09-10', 2], ['2026-09-03', 1]]))
  })

  // **対照: `addAll` は足す。上書きではない。**
  //
  // ここで合流するのは「同じ範囲を読み直した結果」ではなく**別々のものを読んだ結果**
  // （アーカイブ経路と当日経路・当日経路の複数日）。上書きにすると、同じ日に別々の電文が
  // 壊れていたとき片方が黙って消える。
  it('対照: addAll は同じ日でも足す', () => {
    const c = createSkipCounter()
    c.add('2026-09-10')

    c.addAll(new Map([['2026-09-10', 2], ['2026-09-03', 1]]))

    expect(c.toMap()).toEqual(new Map([['2026-09-10', 3], ['2026-09-03', 1]]))
  })

  // **安全弁: 日が辿れない分も消えない。**
  //
  // `UNKNOWN_SKIP_DAY` は窓を持たない固定の鍵なので、「同じ窓の読み直しだから上書きしてよい」
  // という理屈がどこでも成り立たない。複数の取得が報告したら足されなければならない。
  it('安全弁: 日が辿れない取りこぼしも、複数の取得から来たら足す', () => {
    const c = createSkipCounter()
    c.add(UNKNOWN_SKIP_DAY)

    c.addAll(new Map([[UNKNOWN_SKIP_DAY, 2]]))

    expect(c.toMap().get(UNKNOWN_SKIP_DAY)).toBe(3)
  })

  // 安全弁: 取り出した Map を書き換えても、中の状態は動かない
  it('安全弁: toMap() の結果は複製', () => {
    const c = createSkipCounter()
    c.add('2026-09-10')

    c.toMap().set('2026-09-10', 999)

    expect(c.toMap().get('2026-09-10')).toBe(1)
  })
})

// 「もっと見る」で続きを読んだときの合流。**中身によって残し方が違う**ので、その判断を
// 呼び出し側に書かせずここへ集めている。
describe('mergeHistoryLoss', () => {
  const result = (
    skippedByDay: ReadonlyMap<string, number>,
    failedArchiveUrls: string[] = [],
    rateLimited: { sources?: string[]; telegrams?: number } = {},
  ) => ({
    skippedByDay,
    failedArchiveUrls,
    rateLimitedSources: rateLimited.sources ?? [],
    rateLimitedTelegrams: rateLimited.telegrams ?? 0,
  })

  // 正: 別の日の取りこぼしは足される（窓が重ならないので、前の窓の分は残す）
  it('正: 別の日の壊れた電文は足す', () => {
    const prev = telegramLossFrom(skips(2, '2026-09-10'), [])

    const next = mergeHistoryLoss(prev, result(skips(3, '2026-09-03')))

    expect(totalSkipped(next)).toBe(5)
  })

  // **対照: 同じ日を読み直しても増えない。** ここが件数ひとつで持っていた頃に壊れていた
  // ところ —— カーソルが停滞して同じ窓を読み直すと、押すたび無制限に積み上がっていた。
  it('対照: 同じ日を読み直しても増えない', () => {
    const prev = telegramLossFrom(skips(2, '2026-09-10'), [])

    let next = mergeHistoryLoss(prev, result(skips(2, '2026-09-10')))
    next = mergeHistoryLoss(next, result(skips(2, '2026-09-10')))

    expect(totalSkipped(next)).toBe(2)
  })

  // 安全弁: 取得元の失敗は残さない（失敗した日でカーソルが止まるので、次に押せば読み直す）
  it('安全弁: 取得元の失敗はその取得の結果で置き換える', () => {
    const prev = telegramLossFrom(new Map(), ['https://x/a'])

    const next = mergeHistoryLoss(prev, result(new Map()))

    expect(next.failedSources.size).toBe(0)
  })

  // **鍵まで見る。** 合計だけを見ると、日を取り違えても通ってしまう —— 読み直しで置き換わる
  // 日と、前の窓のまま残る日が入れ替わっても合計は同じになりうる。
  it('日ごとの中身まで、読み直した日だけが置き換わる', () => {
    const prev = telegramLossFrom(new Map([['2026-09-10', 2], ['2026-09-03', 1]]), [])

    const next = mergeHistoryLoss(prev, result(new Map([['2026-09-10', 5]])))

    expect(next.skippedByDay).toEqual(new Map([['2026-09-10', 5], ['2026-09-03', 1]]))
  })

  // 安全弁: 壊れた電文は「回復」しない。取得元が回復しても残る
  it('安全弁: 取得元が回復しても、壊れた電文の分は残る', () => {
    const prev = telegramLossFrom(skips(1, '2026-09-10'), ['https://x/a'])

    const next = mergeHistoryLoss(prev, result(new Map()))

    expect(next.failedSources.size).toBe(0)
    expect(totalSkipped(next)).toBe(1)
  })
})
