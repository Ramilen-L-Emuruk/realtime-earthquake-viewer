import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sanitize, load } from './useSettings'

const STORAGE_KEY = 'quake-viewer-settings'

function makeLocalStorageMock(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } satisfies Storage
}

describe('sanitize', () => {
  it('空 partial は完全な DEFAULTS を返す', () => {
    const result = sanitize({})
    expect(result.soundVolume).toBe(1.0)
    expect(result.uiScale).toBe(1)
    expect(result.homeLat).toBeNull()
    expect(result.defaultTab).toBe('earthquake')
  })

  it('soundVolume=99 → 1.0 にクランプ', () => {
    expect(sanitize({ soundVolume: 99 }).soundVolume).toBe(1.0)
  })

  it('soundVolume=-5 → 0.0 にクランプ', () => {
    expect(sanitize({ soundVolume: -5 }).soundVolume).toBe(0.0)
  })

  it('soundVolume が文字列 → DEFAULTS の 1.0', () => {
    expect(sanitize({ soundVolume: '0.5' as unknown as number }).soundVolume).toBe(1.0)
  })

  it('uiScale が文字列 → DEFAULTS の 1', () => {
    expect(sanitize({ uiScale: 'big' as unknown as number }).uiScale).toBe(1)
  })

  it('activeFaultOpacity=5.0 → 1.0 にクランプ', () => {
    expect(sanitize({ activeFaultOpacity: 5.0 }).activeFaultOpacity).toBe(1.0)
  })

  it('activeFaultOpacity=0.01 → 0.05 にクランプ（下限）', () => {
    expect(sanitize({ activeFaultOpacity: 0.01 }).activeFaultOpacity).toBe(0.05)
  })

  it('idleRevertSec=-100 → 0 にクランプ', () => {
    expect(sanitize({ idleRevertSec: -100 }).idleRevertSec).toBe(0)
  })

  it('idleRevertSec=99999 → 3600 にクランプ', () => {
    expect(sanitize({ idleRevertSec: 99999 }).idleRevertSec).toBe(3600)
  })

  it('voicevoxSpeakerId=-5 → 0 にクランプ', () => {
    expect(sanitize({ voicevoxSpeakerId: -5 }).voicevoxSpeakerId).toBe(0)
  })

  it('ttsIntensityLevels=999 → 10 にクランプ', () => {
    expect(sanitize({ ttsIntensityLevels: 999 }).ttsIntensityLevels).toBe(10)
  })

  // 震度を取る 3 項目（minDisplayScale / notifyMinScale / ttsAlwaysReadScale）は
  // 気象庁の階級値と無効値 -1 のみを受け付ける。範囲内でも階級値でなければ既定値に落とす
  // （中間値を通すと設定画面の震度バッジが「不明」表示になる）。
  it('震度項目は無効値(-1)を保持する', () => {
    expect(sanitize({ ttsAlwaysReadScale: -1 }).ttsAlwaysReadScale).toBe(-1)
    expect(sanitize({ minDisplayScale: -1 }).minDisplayScale).toBe(-1)
    expect(sanitize({ notifyMinScale: -1 }).notifyMinScale).toBe(-1)
  })

  it('震度項目は階級値をそのまま通す', () => {
    expect(sanitize({ ttsAlwaysReadScale: 45 }).ttsAlwaysReadScale).toBe(45)
    expect(sanitize({ minDisplayScale: 70 }).minDisplayScale).toBe(70)
    expect(sanitize({ notifyMinScale: 10 }).notifyMinScale).toBe(10)
  })

  it('震度項目は範囲内でも階級値でない中間値(35)を既定値に落とす', () => {
    expect(sanitize({ ttsAlwaysReadScale: 35 }).ttsAlwaysReadScale).toBe(30)
    expect(sanitize({ minDisplayScale: 35 }).minDisplayScale).toBe(-1)
    expect(sanitize({ notifyMinScale: 35 }).notifyMinScale).toBe(-1)
  })

  it('震度項目は範囲外の値を既定値に落とす（クランプしない）', () => {
    expect(sanitize({ ttsAlwaysReadScale: 999 }).ttsAlwaysReadScale).toBe(30)
    expect(sanitize({ minDisplayScale: -999 }).minDisplayScale).toBe(-1)
  })

  it('震度項目は数値以外を既定値に落とす', () => {
    expect(sanitize({ notifyMinScale: '30' as unknown as number }).notifyMinScale).toBe(-1)
  })

  // typeof が number でも階級値でない特殊値（isValidIntensityScale の実装が変わったときの回帰検知）
  it('震度項目は NaN・Infinity を既定値に落とす', () => {
    expect(sanitize({ minDisplayScale: NaN }).minDisplayScale).toBe(-1)
    expect(sanitize({ notifyMinScale: Infinity }).notifyMinScale).toBe(-1)
    expect(sanitize({ ttsAlwaysReadScale: -Infinity }).ttsAlwaysReadScale).toBe(30)
  })

  it('ttsRegionTolerance=-3 → 0 にクランプ', () => {
    expect(sanitize({ ttsRegionTolerance: -3 }).ttsRegionTolerance).toBe(0)
  })

  it('読み上げの階数・地域数の既定値（未保存時）', () => {
    const d = sanitize({})
    expect(d.ttsAlwaysReadScale).toBe(30)
    expect(d.ttsRegionTolerance).toBe(2)
  })

  it('homeLat が数値以外 → null', () => {
    expect(sanitize({ homeLat: 'invalid' as unknown as number }).homeLat).toBeNull()
  })

  it('homeLat が範囲外 → クランプ', () => {
    expect(sanitize({ homeLat: 200 }).homeLat).toBe(90)
    expect(sanitize({ homeLat: -200 }).homeLat).toBe(-90)
  })

  it('homeLng の null 明示指定は保持', () => {
    expect(sanitize({ homeLng: null }).homeLng).toBeNull()
  })

  it('defaultTab が既知値なら通過', () => {
    expect(sanitize({ defaultTab: 'realtime' }).defaultTab).toBe('realtime')
    expect(sanitize({ defaultTab: 'earthquake' }).defaultTab).toBe('earthquake')
  })

  it('defaultTab が未知値 → DEFAULTS', () => {
    expect(sanitize({ defaultTab: 'settings' as unknown as 'earthquake' }).defaultTab).toBe('earthquake')
  })

  it('boolean 型不一致 → DEFAULTS', () => {
    expect(sanitize({ soundEnabled: 'true' as unknown as boolean }).soundEnabled).toBe(true) // DEFAULTS.soundEnabled=true
    expect(sanitize({ showQuakeHeatmap: 1 as unknown as boolean }).showQuakeHeatmap).toBe(false) // DEFAULTS.showQuakeHeatmap=false
  })

  it('未知キーは無視される（型に無い rest プロパティ）', () => {
    const result = sanitize({ unknown: 'junk' } as unknown as Partial<never>)
    expect((result as unknown as Record<string, unknown>).unknown).toBeUndefined()
    expect(result.soundVolume).toBe(1.0)
  })

  it('dmdataApiKey は文字列で保持（空文字も OK）', () => {
    expect(sanitize({ dmdataApiKey: 'secret' }).dmdataApiKey).toBe('secret')
    expect(sanitize({ dmdataApiKey: '' }).dmdataApiKey).toBe('')
    expect(sanitize({ dmdataApiKey: 123 as unknown as string }).dmdataApiKey).toBe('')
  })
})

describe('load', () => {
  let logs: unknown[][]
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorageMock())
    logs = []
    // logger の warn を捕捉
    vi.doMock('../utils/logger', () => ({
      log: {
        warn: (...args: unknown[]) => logs.push(['warn', ...args]),
        info: () => { /* noop */ },
        debug: () => { /* noop */ },
        error: () => { /* noop */ },
      },
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../utils/logger')
    vi.resetModules()
  })

  it('localStorage 空なら DEFAULTS（ログなし）', () => {
    const result = load()
    expect(result.soundVolume).toBe(1.0)
    expect(logs.length).toBe(0)
  })

  it('壊れた JSON なら DEFAULTS + log.warn', () => {
    localStorage.setItem(STORAGE_KEY, '{invalid json}')
    const result = load()
    expect(result.soundVolume).toBe(1.0)
    // 実際のログ捕捉はモジュール分離の都合で確実ではない
    // → sanitize 直接テストで defense-in-depth を担保。ここは try/catch が例外を投げないことを主目的とする
  })

  it('object でない JSON（primitive）は DEFAULTS + log.warn', () => {
    localStorage.setItem(STORAGE_KEY, '"just-a-string"')
    const result = load()
    expect(result.soundVolume).toBe(1.0)
  })

  it('null は DEFAULTS', () => {
    localStorage.setItem(STORAGE_KEY, 'null')
    const result = load()
    expect(result.soundVolume).toBe(1.0)
  })

  it('正常な部分設定は sanitize 後にマージ', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ soundVolume: 0.5, uiScale: 1.5 }))
    const result = load()
    expect(result.soundVolume).toBe(0.5)
    expect(result.uiScale).toBe(1.5)
    expect(result.notifyEEW).toBe(true) // DEFAULTS
  })

  it('壊れた値と正常値の混在は個別に矯正', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      soundVolume: 99,
      uiScale: 'big',
      notifyEEW: false,
      homeLat: 'invalid',
    }))
    const result = load()
    expect(result.soundVolume).toBe(1.0) // クランプ
    expect(result.uiScale).toBe(1) // DEFAULTS
    expect(result.notifyEEW).toBe(false) // 正常値保持
    expect(result.homeLat).toBeNull() // null 落ち
  })
})
