import { describe, expect, it, vi } from 'vitest'
import type { TelegramLogEntry } from '../../types/earthquake'
import { NON_EEW_HANDLED_TYPES, EEW_HEAD_TYPES } from '../../services/dmdataTelegramPayload'
import { DISPATCHED_WITHOUT_PARSER } from '../../services/dmdata'
import { isSupportedCode } from '../../services/p2pquake'
import {
  HEAD_TYPE_LABEL, KIND_LABEL, KIND_OPTIONS, headTypeLabel, matchesTelegramFilter, readKindFilter,
  telegramLogKindOf,
} from './labels'

describe('HEAD_TYPE_LABEL', () => {
  // 鍵がコードの文字列なので、型検査では書き漏らしを捕まえられない。アプリが扱う種別の集合と
  // 突き合わせる。集合はそれぞれの単一情報源から読むので、種別を足せばここが落ちる。
  it('DMDATA で扱う全コードに種別名がある', () => {
    const handled = [...NON_EEW_HANDLED_TYPES, ...EEW_HEAD_TYPES, ...DISPATCHED_WITHOUT_PARSER]
    expect(handled.length).toBeGreaterThan(0)
    expect(handled.filter(code => !(code in HEAD_TYPE_LABEL))).toEqual([])
  })

  it('P2PQuake で扱う全コードに種別名がある', () => {
    // P2PQuake のコードは 3 桁（551 地震情報・552 津波・556 EEW など）。扱うかは isSupportedCode が決める
    const handled = Array.from({ length: 1000 }, (_, i) => i).filter(isSupportedCode)
    expect(handled.length).toBeGreaterThan(0)
    expect(handled.filter(code => !(String(code) in HEAD_TYPE_LABEL))).toEqual([])
  })

  it('VYSE51・VYSE52 は括弧書きで見分けられる', () => {
    expect(HEAD_TYPE_LABEL.VYSE51).toBe('南海トラフ地震関連解説情報（臨時解説）')
    expect(HEAD_TYPE_LABEL.VYSE52).toBe('南海トラフ地震関連解説情報（定例解説）')
  })
})

describe('headTypeLabel', () => {
  it('載っているコードは種別名、扱わないコードはコードそのものを返す', () => {
    expect(headTypeLabel('VYSE50')).toBe('南海トラフ地震臨時情報')
    // P2PQuake は扱わないコード（561 など）も filtered で記録する。名前は付けない
    expect(headTypeLabel('561')).toBe('561')
  })

  it('継承したキーは引かない', () => {
    expect(headTypeLabel('constructor')).toBe('constructor')
    expect(headTypeLabel('toString')).toBe('toString')
  })
})

describe('telegramLogKindOf', () => {
  it('扱う全コードが種別を持つ（種別を持たない行でも絞り込みに当たる）', () => {
    const handled = [
      ...NON_EEW_HANDLED_TYPES, ...EEW_HEAD_TYPES, ...DISPATCHED_WITHOUT_PARSER,
      ...Array.from({ length: 1000 }, (_, i) => i).filter(isSupportedCode).map(String),
    ]
    expect(handled.filter(headType => telegramLogKindOf({ headType, kind: undefined }) === undefined)).toEqual([])
  })

  it('コードから引いた種別は、読めた行の種別と食い違わない', () => {
    expect(telegramLogKindOf({ headType: 'IXAC41', kind: undefined })).toBe('estimatedIntensity')
    expect(telegramLogKindOf({ headType: 'VYSE52', kind: undefined })).toBe('nankaiCommentary')
    expect(telegramLogKindOf({ headType: 'VXSE42', kind: undefined })).toBe('eew')
    expect(telegramLogKindOf({ headType: '552', kind: undefined })).toBe('tsunami')
  })

  it('読めた行は読んだ結果の種別を使い、扱わないコードは種別を持たない', () => {
    expect(telegramLogKindOf({ headType: 'VXSE53', kind: 'quake' })).toBe('quake')
    expect(telegramLogKindOf({ headType: '561', kind: undefined })).toBeUndefined()
  })
})

describe('KIND_OPTIONS', () => {
  it('種別の短い名前を書いた順にすべて並べる', () => {
    expect(KIND_OPTIONS).toEqual([
      'eew', 'quake', 'tsunami', 'lpgm', 'nankai', 'nankaiCommentary', 'kohatsu',
      'quakeNotice', 'earthquakeCount', 'estimatedIntensity',
    ])
    expect(KIND_OPTIONS.every(kind => KIND_LABEL[kind].length > 0)).toBe(true)
  })
})

// ログの時刻の前置き（`timestampPrefix`）が時計の未較正を別に警告することがあるので、
// この部品の記録だけを数える
const ownWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((args: unknown[]) => args.some((a: unknown) => typeof a === 'string' && a.includes('[TelegramTab]')))

describe('readKindFilter', () => {
  it('種別と読み取りの結果をそのまま読む', () => {
    expect(readKindFilter('nankaiCommentary')).toBe('nankaiCommentary')
    expect(readKindFilter('estimatedIntensity')).toBe('estimatedIntensity')
    expect(readKindFilter('filtered')).toBe('filtered')
    expect(readKindFilter('error')).toBe('error')
    expect(readKindFilter('all')).toBe('all')
  })

  it('知らない値は全種別へ倒し、記録を残す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readKindFilter('VYSE50')).toBe('all')
      expect(readKindFilter('')).toBe('all')
      expect(ownWarnings(warn)).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  // 上の「記録を残す」と対で見る。こちら単独では、記録の仕組みが壊れても通ってしまう
  it('知っている値では記録を残さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      readKindFilter('all')
      readKindFilter('kohatsu')
      expect(ownWarnings(warn)).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('matchesTelegramFilter', () => {
  const entry = (patch: Partial<TelegramLogEntry>): Pick<TelegramLogEntry, 'source' | 'status' | 'kind' | 'headType'> => ({
    source: 'dmdss', status: 'parsed', kind: undefined, headType: '561', ...patch,
  })

  it('いままで絞れなかった 6 種別でも絞れる', () => {
    for (const kind of ['nankai', 'nankaiCommentary', 'kohatsu', 'quakeNotice', 'earthquakeCount', 'estimatedIntensity'] as const) {
      expect(matchesTelegramFilter(entry({ kind }), 'all', kind)).toBe(true)
      expect(matchesTelegramFilter(entry({ kind: 'quake' }), 'all', kind)).toBe(false)
    }
  })

  it('結合待ちの断片・読み取りに失敗した行も、電文種別コードから種別で当たる', () => {
    const fragment = entry({ status: 'filtered', headType: 'IXAC41' })
    expect(matchesTelegramFilter(fragment, 'all', 'estimatedIntensity')).toBe(true)
    expect(matchesTelegramFilter(fragment, 'all', 'filtered')).toBe(true)
    const failed = entry({ status: 'error', headType: 'VYSE50' })
    expect(matchesTelegramFilter(failed, 'all', 'nankai')).toBe(true)
    expect(matchesTelegramFilter(failed, 'all', 'error')).toBe(true)
    expect(matchesTelegramFilter(failed, 'all', 'kohatsu')).toBe(false)
  })

  it('扱わないコードの行（種別を持たない）は種別では当たらず、スキップでは当たる', () => {
    const skipped = entry({ status: 'filtered' })
    expect(matchesTelegramFilter(skipped, 'all', 'quake')).toBe(false)
    expect(matchesTelegramFilter(skipped, 'all', 'filtered')).toBe(true)
    expect(matchesTelegramFilter(skipped, 'all', 'error')).toBe(false)
    expect(matchesTelegramFilter(skipped, 'all', 'all')).toBe(true)
  })

  it('取得元の絞り込みは種別より先に効く', () => {
    const p2p = entry({ source: 'p2pquake', kind: 'eew' })
    expect(matchesTelegramFilter(p2p, 'dmdss', 'eew')).toBe(false)
    expect(matchesTelegramFilter(p2p, 'p2pquake', 'eew')).toBe(true)
    expect(matchesTelegramFilter(p2p, 'all', 'eew')).toBe(true)
  })
})
