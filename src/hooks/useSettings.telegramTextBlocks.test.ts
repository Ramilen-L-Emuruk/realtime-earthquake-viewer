// 気象庁が書いた文のブロック指定（`ttsTelegramTextBlocks`）の保存と復元。
//
// この設定だけオブジェクトで持っているので、**壊れた値の入り口が他の設定より広い**
// （キーの欠け・余り・真偽でない値）。`sanitize` がキーの一覧から作り直すことを固定する。
//
//   正  : 保存された指定が復元される
//   対照: 未設定なら全部読む（既定＝設定を入れる前の挙動）
//   安全弁: 欠けたキーは既定で埋め、知らないキーは捨て、真偽でない値は既定へ落とす
import { describe, it, expect } from 'vitest'
import { sanitize, DEFAULTS, TELEGRAM_TEXT_BLOCK_KEYS } from './useSettings'
import type { AppSettings } from './useSettings'

describe('気象庁が書いた文のブロック指定', () => {
  // 対照: **既定は全部読む。** マスタートグルを入れた利用者は「気象庁の文を読む」ことを
  // 選んだのだから、内訳の既定は読む側へ倒す
  it('未設定なら全ブロックを読む', () => {
    const s = sanitize({})
    expect(TELEGRAM_TEXT_BLOCK_KEYS.every(key => s.ttsTelegramTextBlocks[key])).toBe(true)
    expect(Object.keys(s.ttsTelegramTextBlocks)).toHaveLength(TELEGRAM_TEXT_BLOCK_KEYS.length)
  })

  // 正: 保存された指定が戻る
  it('保存された指定を復元する', () => {
    const saved = { ...DEFAULTS.ttsTelegramTextBlocks, nankaiSummary: false, quakeVarComment: false }
    const s = sanitize({ ttsTelegramTextBlocks: saved })
    expect(s.ttsTelegramTextBlocks.nankaiSummary).toBe(false)
    expect(s.ttsTelegramTextBlocks.quakeVarComment).toBe(false)
    expect(s.ttsTelegramTextBlocks.nankaiBody).toBe(true)
  })

  // 安全弁: 欠けたキーは既定で埋める。**後から足したキーが欠けたまま残ると、
  // その項目だけ `undefined` になって読むかどうかが不定になる**
  it('欠けたキーを既定で埋める', () => {
    const s = sanitize({
      ttsTelegramTextBlocks: { nankaiSummary: false } as AppSettings['ttsTelegramTextBlocks'],
    })
    expect(s.ttsTelegramTextBlocks.nankaiSummary).toBe(false)
    for (const key of TELEGRAM_TEXT_BLOCK_KEYS) {
      expect(typeof s.ttsTelegramTextBlocks[key], `${key} が真偽値であること`).toBe('boolean')
    }
    expect(s.ttsTelegramTextBlocks.nankaiBody).toBe(true)
  })

  // 安全弁: 知らないキーは捨てる（消した項目が localStorage に居座る）
  it('一覧に無いキーを捨てる', () => {
    const s = sanitize({
      ttsTelegramTextBlocks: {
        ...DEFAULTS.ttsTelegramTextBlocks, 昔のキー: false,
      } as unknown as AppSettings['ttsTelegramTextBlocks'],
    })
    expect(Object.keys(s.ttsTelegramTextBlocks)).toEqual([...TELEGRAM_TEXT_BLOCK_KEYS])
  })

  // 安全弁: 真偽でない値・オブジェクトでない値は既定へ落とす（壊れた localStorage で落ちない）
  it('壊れた値を既定へ落とす', () => {
    const s = sanitize({
      ttsTelegramTextBlocks: {
        ...DEFAULTS.ttsTelegramTextBlocks, nankaiBody: 'yes',
      } as unknown as AppSettings['ttsTelegramTextBlocks'],
    })
    expect(s.ttsTelegramTextBlocks.nankaiBody).toBe(true)

    for (const broken of [null, 'abc', 42, []]) {
      const t = sanitize({ ttsTelegramTextBlocks: broken as unknown as AppSettings['ttsTelegramTextBlocks'] })
      expect(TELEGRAM_TEXT_BLOCK_KEYS.every(key => t.ttsTelegramTextBlocks[key])).toBe(true)
    }
  })
})
