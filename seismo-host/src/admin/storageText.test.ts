import { describe, expect, it } from 'vitest'

import {
  daysLeftText,
  formatBytes,
  purgeConfirmBody,
  purgeProblemText,
  setPendingProblemText,
  storageWarnings,
  type StorageBriefView,
} from './storageText'
import { migrationHtml } from './viewStorage'

const GB = 1024 ** 3

describe('formatBytes', () => {
  it('GB は小数 1 桁・MB 以下は整数', () => {
    expect(formatBytes(87.6 * GB)).toBe('87.6 GB')
    expect(formatBytes(8 * 1024 ** 2)).toBe('8 MB')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('daysLeftText', () => {
  it('出せない間は「—」', () => {
    expect(daysLeftText(null)).toBe('—')
    expect(daysLeftText(174.6)).toBe('約 175 日')
  })
})

describe('setPendingProblemText（2026-10-13 ユーザー承認の文面）', () => {
  it('理由ごとの文面', () => {
    expect(setPendingProblemText('not-absolute', null)).toBe('絶対パスで入力してください')
    expect(setPendingProblemText('same', null)).toBe('いまの保存先と同じ')
    expect(setPendingProblemText('nested', null)).toBe('いまの保存先と入れ子になっている')
    expect(setPendingProblemText('not-writable', 'EACCES')).toBe('書き込めない: EACCES')
    expect(setPendingProblemText('not-enough-space', `${19.6 * GB}/${12 * GB}`)).toBe(
      '空き容量が不足している: 必要 19.6 GB、空き 12.0 GB',
    )
    expect(setPendingProblemText('locked', null)).toBe('環境変数で固定されているので変えられない')
    expect(setPendingProblemText('migrating', null)).toBe('前の保存先からの複製が終わるまで変えられない')
  })
})

describe('storageWarnings', () => {
  const base: StorageBriefView = { drives: [], lastError: null, migration: null, startupProblem: null, journalProblem: null }

  it('警告が無ければ何も出さない', () => {
    expect(storageWarnings(base)).toEqual([])
  })

  it('空きの割合・日数・複製の停止・移せなかった理由・測れない理由', () => {
    const w = storageWarnings({
      drives: [
        { kinds: ['raw'], freeBytes: 12 * GB, totalBytes: 471.6 * GB, growthBytesPerDay: null, daysLeft: null, warning: 'low-free' },
        { kinds: ['wave'], freeBytes: 50 * GB, totalBytes: 100 * GB, growthBytesPerDay: 9 * GB, daysLeft: 5.6, warning: 'low-days' },
      ],
      lastError: '<EIO>',
      migration: { state: 'copying', blockedBySpace: true, lastError: 'raw/a を複製できず: <EIO>' },
      startupProblem: 'x',
      journalProblem: 'y',
    })
    expect(w).toEqual([
      '保存先の空き容量が 5% を切った（空き 12.0 GB / 471.6 GB）',
      '保存先の空き容量があと約 6 日でなくなる',
      '前の保存先からの複製が止まっている: 空き容量が不足している',
      '前の保存先からの複製に失敗した: raw/a を複製できず: &lt;EIO&gt;',
      '複製の記録を読めない: y',
      '保存先を移せなかった: x',
      // 理由は OS の例外の文面なのでエスケープする
      '容量を測れない: &lt;EIO&gt;',
    ])
  })

  it('複製の失敗は複製している間だけ出す（削除のときの残したものは複製の欄の件数で伝える）', () => {
    expect(storageWarnings({ ...base, migration: { state: 'done', blockedBySpace: false, lastError: 'z' } })).toEqual([])
  })
})

describe('purgeProblemText（2026-10-13 ユーザー承認の文面）', () => {
  it('理由ごとの文面', () => {
    expect(purgeProblemText('failed', 'EBUSY')).toBe('前の保存先から削除できなかった: EBUSY')
    expect(purgeProblemText('busy', null)).toBe('前の保存先から削除している最中')
    expect(purgeProblemText('not-copied', null)).toBe('複製が終わっていないので削除できない')
  })
})

describe('確認の窓と複製の欄', () => {
  it('確認の窓の本文', () => {
    expect(purgeConfirmBody('D:\\seismo\\data', 5540, 18.6 * GB)).toBe(
      'D:\\seismo\\data から、複製と照合が済んだ 5,540 件（18.6 GB）を削除します。この操作は元に戻せません。',
    )
  })

  const m = {
    from: 'D:\\old<x>',
    to: 'E:\\new',
    totalFiles: 10,
    totalBytes: 10 * GB,
    doneFiles: 4,
    doneBytes: 4 * GB,
    skippedExists: 0,
    skippedUnreadable: 0,
    blockedBySpace: null,
    lastError: null,
    purgeable: null,
    purged: null,
  }

  it('複製中は進み具合を出し、削除のボタンは出さない', () => {
    const html = migrationHtml({ ...m, state: 'copying' })
    expect(html).toContain('4 / 10 件・4.0 GB / 10.0 GB')
    expect(html).not.toContain('purge-old')
    // パスはエスケープする
    expect(html).toContain('D:\\old&lt;x&gt;')
  })

  it('複製が済んで消せるものがあれば、削除のボタンを出す', () => {
    const html = migrationHtml({ ...m, state: 'copied', doneFiles: 10, purgeable: { files: 9, bytes: 9 * GB }, skippedExists: 1 })
    expect(html).toContain('purge-old')
    expect(html).toContain('前の保存先に残すもの')
    expect(html).toContain('1 件')
  })

  it('消している最中は「削除中」と出し、ボタンは出さない。途中で止まった削除は承認し直せる', () => {
    const busy = migrationHtml({ ...m, state: 'purging', purgeable: null })
    expect(busy).toContain('削除中')
    expect(busy).not.toContain('purge-old')
    const stuck = migrationHtml({ ...m, state: 'purging', purgeable: { files: 9, bytes: 9 * GB } })
    expect(stuck).toContain('purge-old')
  })

  it('消した後は件数を出す', () => {
    const html = migrationHtml({ ...m, state: 'done', purged: { files: 9, bytes: 9 * GB, kept: 0 } })
    expect(html).toContain('前の保存先から 9 件を削除した')
    expect(html).not.toContain('purge-old')
  })
})
