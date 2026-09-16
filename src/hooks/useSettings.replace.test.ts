// @vitest-environment jsdom
//
// `replaceSettings`（設定の読み込みで全項目をまとめて置き換える）の回帰テスト。
//
// **`useSettings.test.ts` と分けてあるのは実行環境が違うから。** あちらは純関数だけを
// 相手にしていて node で動くが、こちらはフックを描画するので jsdom が要る。1 つのファイルに
// 混ぜると、純関数のテストまで jsdom を起こすことになる。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { sanitize, useSettings } from './useSettings'

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

describe('replaceSettings', () => {
  let storage: Storage
  beforeEach(() => {
    storage = makeLocalStorageMock()
    vi.stubGlobal('localStorage', storage)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const read = () => JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>

  it('正: 全項目を置き換えて localStorage へ保存し、保存できたと返す', () => {
    const { result } = renderHook(() => useSettings())
    let ok = false
    act(() => { ok = result.current.replaceSettings(sanitize({ uiScale: 1.5, soundVolume: 0.25 })) })
    expect(ok).toBe(true)
    expect(result.current.settings.uiScale).toBe(1.5)
    expect(read().uiScale).toBe(1.5)
    expect(read().soundVolume).toBe(0.25)
  })

  it('安全弁: 保存に失敗したら false を返す（state へは反映する）', () => {
    // 呼び出し側はこれを見て「次回起動で元へ戻る」と伝える。黙ると画面は成功にしか見えない。
    const { result } = renderHook(() => useSettings())
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded') })
    let ok = true
    act(() => { ok = result.current.replaceSettings(sanitize({ uiScale: 2 })) })
    expect(ok).toBe(false)
    expect(result.current.settings.uiScale).toBe(2)
  })

  it('正: 1 回の呼び出しで 1 回だけ保存する', () => {
    // `updateSetting` を項目の数だけ呼ぶ形にしていないことの裏取り。
    const { result } = renderHook(() => useSettings())
    const spy = vi.spyOn(storage, 'setItem')
    act(() => { result.current.replaceSettings(sanitize({ uiScale: 1.25 })) })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('正: APIキーが保存まで届く', () => {
    const { result } = renderHook(() => useSettings())
    act(() => { result.current.replaceSettings(sanitize({ dmdataApiKey: 'typed-by-hand' })) })
    expect(read().dmdataApiKey).toBe('typed-by-hand')
  })

  // **`keepApiKey` の分岐そのものはここでは確かめられない。** テスト環境では
  // `resolveDevApiKey` が常に `undefined` を返す（`MODE === 'test'`・`isDmdss` が false）ため、
  // 注入値が無く、どちらの枝を通っても結果が同じになる。分岐の中身は純関数へ切り出してあり、
  // `useSettings.test.ts` の `settingsToStore` で正・対照・安全弁を固定している。
})
