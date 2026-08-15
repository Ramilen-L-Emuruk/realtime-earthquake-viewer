// リプレイ制御のうち、React に依存しない部分の単体テスト。
//
// アーカイブ取得は中断できないのに、ユーザーはいつでも停止・再開できる。そのため
// 「古い取得が後から完了したとき、その結果を受け取ってよいか」を判定する仕組みが要る。
// その判定（世代照合）と、取りこぼしの通知文言をここで検証する。
//
// Hook 本体の結線（どの state 更新が照合の後ろにあるか）は、このプロジェクトに
// React のテスト環境が無いため実機のブラウザ操作で確認している。
import { describe, it, expect } from 'vitest'
import { createSessionGuard, createEmptyLoss, addLoss, formatLossNotice } from './useReplayController'

describe('createSessionGuard', () => {
  it('開始した直後のセッションは現役', () => {
    const guard = createSessionGuard()
    const s = guard.begin()
    expect(guard.isCurrent(s)).toBe(true)
  })

  it('新しく開始すると、前のセッションは現役でなくなる', () => {
    const guard = createSessionGuard()
    const first = guard.begin()
    const second = guard.begin()

    // 「停止 → 別の日で再開」した直後に古い取得が完了しても結果を捨てられる
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })

  it('無効化するとどのセッションも現役でなくなる', () => {
    const guard = createSessionGuard()
    const s = guard.begin()
    guard.invalidate()

    // 停止したあとに取得が完了しても、電文を積まず表示も触らない
    expect(guard.isCurrent(s)).toBe(false)
  })

  it('無効化後に開始したセッションは現役になる', () => {
    const guard = createSessionGuard()
    guard.begin()
    guard.invalidate()
    const restarted = guard.begin()

    expect(guard.isCurrent(restarted)).toBe(true)
  })

  it('current() は世代を進めない（先読みは既存セッションに属する）', () => {
    const guard = createSessionGuard()
    const s = guard.begin()

    const forPrefetch = guard.current()

    expect(forPrefetch).toBe(s)
    expect(guard.isCurrent(s)).toBe(true)
  })

  it('先読み中に停止されたら、その先読みは現役でなくなる', () => {
    const guard = createSessionGuard()
    guard.begin()
    const prefetch = guard.current()

    guard.invalidate()

    expect(guard.isCurrent(prefetch)).toBe(false)
  })

  it('世代番号は単調増加し、過去の番号と衝突しない', () => {
    const guard = createSessionGuard()
    const seen = new Set<number>()
    for (let i = 0; i < 50; i++) {
      seen.add(guard.begin())
      guard.invalidate()
    }
    expect(seen.size).toBe(50)
  })

  it('独立したガード同士は干渉しない', () => {
    const a = createSessionGuard()
    const b = createSessionGuard()
    const sa = a.begin()
    b.begin()
    b.invalidate()

    expect(a.isCurrent(sa)).toBe(true)
  })
})

describe('addLoss', () => {
  it('電文の取りこぼしを積み上げる', () => {
    let loss = createEmptyLoss()
    loss = addLoss(loss, 3, [])
    loss = addLoss(loss, 2, [])

    // 一度失われた電文は後続の取得が成功しても戻らないので、消さずに積む
    expect(loss.skippedTelegrams).toBe(5)
  })

  // 本編と初期状態は日付範囲が重なるため同じアーカイブを両方が読む。件数で合算すると
  // 1 件の障害が「2 件」と表示される。URL の集合で持つことでこれを防ぐ。
  it('同じアーカイブを二重に数えない', () => {
    let loss = createEmptyLoss()
    loss = addLoss(loss, 0, ['https://x/a', 'https://x/b'])
    loss = addLoss(loss, 0, ['https://x/a'])

    expect(loss.failedArchives.size).toBe(2)
  })

  it('元の損失を書き換えない（不変）', () => {
    const original = createEmptyLoss()
    const next = addLoss(original, 1, ['https://x/a'])

    expect(original.skippedTelegrams).toBe(0)
    expect(original.failedArchives.size).toBe(0)
    expect(next.skippedTelegrams).toBe(1)
  })
})

describe('formatLossNotice', () => {
  it('何も欠けていなければ出さない', () => {
    expect(formatLossNotice(createEmptyLoss())).toBeNull()
  })

  it('電文の取りこぼしを件数付きで知らせる', () => {
    const msg = formatLossNotice(addLoss(createEmptyLoss(), 3, []))
    expect(msg).toMatch(/3 件の電文/)
    // 失敗と誤読されないよう、再生が続いていることを必ず添える
    expect(msg).toMatch(/継続中/)
  })

  // アーカイブ丸ごとの失敗は「その日に何通あったか」が分からないため電文数に合算できない。
  // 黙らせると「1 日分まるごと欠けた再生」を成功と見分けられなくなる。
  it('アーカイブ単位の失敗も知らせる', () => {
    const msg = formatLossNotice(addLoss(createEmptyLoss(), 0, ['https://x/a', 'https://x/b']))
    expect(msg).toMatch(/2 件のアーカイブ/)
    expect(msg).toMatch(/継続中/)
  })

  it('両方欠けたときは両方を並べる', () => {
    const msg = formatLossNotice(addLoss(createEmptyLoss(), 5, ['https://x/a']))
    expect(msg).toMatch(/1 件のアーカイブ/)
    expect(msg).toMatch(/5 件の電文/)
  })
})
