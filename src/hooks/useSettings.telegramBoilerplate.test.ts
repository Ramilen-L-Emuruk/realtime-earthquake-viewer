// 読み上げから落とす定型文の指定（`ttsTelegramBoilerplate`）の保存と復元。
//
// 隣の `ttsTelegramTextBlocks`（→ `useSettings.telegramTextBlocks.test.ts`）と同じくオブジェクトで
// 持つので、**壊れた値の入り口が他の設定より広い**（キーの欠け・余り・真偽でない値）。
// `sanitize` がキーの一覧から作り直すことを固定する。
//
//   正  : 保存された指定が復元される
//   対照: 未設定なら 4 項目とも落とす（既定）。**隣のブロック指定とは向きが逆**
//   安全弁: 欠けたキーは既定で埋め、知らないキーは捨て、真偽でない値は既定へ落とす
import { describe, it, expect } from 'vitest'
import { sanitize, DEFAULTS, TELEGRAM_BOILERPLATE_KEYS } from './useSettings'
import type { AppSettings } from './useSettings'

describe('定型文の読み上げ指定', () => {
  // 対照: **既定は落とす側**（`＊` の説明はこの設定より前から無条件に落ちていたので、読む側を
  // 既定にすると設定を足した瞬間に鳴り出す）。隣の「ブロックの内訳」は既定で全部読むので、
  // **向きが逆であること自体をここで固定する**。
  it('未設定なら 4 項目とも読まない', () => {
    const s = sanitize({})
    expect(TELEGRAM_BOILERPLATE_KEYS.every(key => s.ttsTelegramBoilerplate[key] === false)).toBe(true)
    expect(Object.keys(s.ttsTelegramBoilerplate)).toHaveLength(TELEGRAM_BOILERPLATE_KEYS.length)
  })

  // 正: 保存された指定が戻る
  it('保存された指定を復元する', () => {
    const s = sanitize({
      ttsTelegramBoilerplate: { ...DEFAULTS.ttsTelegramBoilerplate, lpgmClassTable: true },
    })
    expect(s.ttsTelegramBoilerplate.lpgmClassTable).toBe(true)
    expect(s.ttsTelegramBoilerplate.starMark).toBe(false)
  })

  // 安全弁: 欠けたキーは既定で埋める。**後から足したキーが欠けたまま残ると、その項目だけ
  // `undefined` になって落とすかどうかが不定になる**
  it('欠けたキーを既定で埋める', () => {
    const s = sanitize({
      ttsTelegramBoilerplate: { starMark: true } as AppSettings['ttsTelegramBoilerplate'],
    })
    expect(s.ttsTelegramBoilerplate.starMark).toBe(true)
    for (const key of TELEGRAM_BOILERPLATE_KEYS) {
      expect(typeof s.ttsTelegramBoilerplate[key], `${key} が真偽値であること`).toBe('boolean')
    }
    expect(s.ttsTelegramBoilerplate.tsunamiHeightLegend).toBe(false)
  })

  // 安全弁: 知らないキーは捨てる（消した項目が localStorage に居座る）
  it('一覧に無いキーを捨てる', () => {
    const s = sanitize({
      ttsTelegramBoilerplate: {
        ...DEFAULTS.ttsTelegramBoilerplate, 昔のキー: true,
      } as unknown as AppSettings['ttsTelegramBoilerplate'],
    })
    expect(Object.keys(s.ttsTelegramBoilerplate)).toEqual([...TELEGRAM_BOILERPLATE_KEYS])
  })

  // 安全弁: 真偽でない値・オブジェクトでない値は既定へ落とす（壊れた localStorage で落ちない）
  it('壊れた値を既定へ落とす', () => {
    const s = sanitize({
      ttsTelegramBoilerplate: {
        ...DEFAULTS.ttsTelegramBoilerplate, eewIssued: 'yes',
      } as unknown as AppSettings['ttsTelegramBoilerplate'],
    })
    expect(s.ttsTelegramBoilerplate.eewIssued).toBe(false)

    for (const broken of [null, 'abc', 42, []]) {
      const t = sanitize({ ttsTelegramBoilerplate: broken as unknown as AppSettings['ttsTelegramBoilerplate'] })
      expect(TELEGRAM_BOILERPLATE_KEYS.every(key => t.ttsTelegramBoilerplate[key] === false)).toBe(true)
    }
  })
})
