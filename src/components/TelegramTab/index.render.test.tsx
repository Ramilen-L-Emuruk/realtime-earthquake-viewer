// @vitest-environment jsdom
//
// 電文ログの行と絞り込みを、画面に出る形で固定する。行はライブ受信でしか積まれないので、
// 南海トラフの情報のような滅多に来ない種別は、ここでしか見た目を確かめられない。
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { TelegramLogEntry } from '../../types/earthquake'
import { TelegramTab } from './index'

const entry = (id: string, patch: Partial<TelegramLogEntry>): TelegramLogEntry => ({
  id,
  receivedAt: new Date('2026-10-15T00:00:00Z'),
  source: 'dmdss',
  headType: 'VXSE53',
  isTest: false,
  status: 'parsed',
  rawBody: '<Report/>',
  ...patch,
})

const log: TelegramLogEntry[] = [
  entry('a', { headType: 'VYSE51', kind: 'nankaiCommentary' }),
  entry('b', { headType: 'IXAC41', kind: 'estimatedIntensity' }),
  entry('c', { headType: 'VXSE53', kind: 'quake' }),
  // 結合待ちの断片。種別を持たずに記録される
  entry('d', { headType: 'IXAC41', status: 'filtered' }),
  // 扱わないコード（P2PQuake は filtered で記録する）
  entry('e', { headType: '561', status: 'filtered', source: 'p2pquake', rawBody: {} }),
]

const rowTexts = () => screen.getAllByRole('listitem').map(li => li.textContent ?? '')

describe('TelegramTab', () => {
  it('いままで種別名の出なかった電文も、短い名前と種別名を並べて出す', () => {
    render(<TelegramTab telegramLog={log} onClear={() => {}} />)
    const rows = rowTexts()
    expect(rows[0]).toContain('南海トラフ解説情報 · 南海トラフ地震関連解説情報（臨時解説）')
    expect(rows[1]).toContain('推計震度分布図 · 推計震度分布図作図用データ')
    expect(rows[2]).toContain('地震 · 震源・震度')
    expect(rows[3]).toContain('推計震度分布図 · 推計震度分布図作図用データ')
    // 扱わないコードは名前を付けず、コードだけを出す
    expect(rows[4]).toContain('561')
    expect(rows[4]).not.toContain('·')
  })

  it('いままで絞れなかった種別で絞れる', () => {
    render(<TelegramTab telegramLog={log} onClear={() => {}} />)
    const select = screen.getAllByRole('combobox').find(s =>
      within(s).queryByRole('option', { name: 'エラー' }) !== null) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'estimatedIntensity' } })
    // 読めた行と結合待ちの断片の 2 行
    const rows = rowTexts()
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.includes('IXAC41'))).toBe(true)
  })
})
