import { describe, it, expect, afterEach, vi } from 'vitest'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'
import { DICT_FETCH_TIMEOUT_MS } from './ttsPhraseBreakDict'

// この辞書のローダは読み上げ本体（speakWithVoicevox）が取得を待つため、
// 生成データ共通の 60 秒ではなく短いタイムアウトを使う。その差が保たれているかを検証する。

async function freshModule() {
  vi.resetModules()
  return await import('./ttsPhraseBreakDict')
}

const SAMPLE = {
  _comment: 'テスト用',
  _terms: ['深発地震'],
  能登地方: 'ノトチホー',
  深発地震: 'シンパツジシン',
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

/** signal が abort されるまで解決しない fetch（応答が返らない回線の再現）。 */
function hangingFetch(init?: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// resetModules ＋動的 import の再評価コストで既定タイムアウトを割ることがある（理由は prefectures.test.ts）。
describe('loadTtsPhraseBreakDict', { timeout: 15_000 }, () => {
  it('取得に成功すると _comment / _terms を除いた辞書を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadTtsPhraseBreakDict, isPlaceNameKey } = await freshModule()

    const dict = await loadTtsPhraseBreakDict()

    expect(dict).toEqual({ 能登地方: 'ノトチホー', 深発地震: 'シンパツジシン' })
    // _terms に載っているものは地名ではない（読み上げ後のポーズを付けない側）
    expect(isPlaceNameKey('能登地方')).toBe(true)
    expect(isPlaceNameKey('深発地震')).toBe(false)
  })

  it('読み上げを長く止めないよう、生成データ共通より短い専用の値で打ち切る', async () => {
    expect(DICT_FETCH_TIMEOUT_MS).toBeLessThan(DATA_FETCH_TIMEOUT_MS)

    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { signal?: AbortSignal }) => hangingFetch(init)),
    )
    const { loadTtsPhraseBreakDict } = await freshModule()

    let settled = false
    const p = loadTtsPhraseBreakDict().catch(() => { settled = true })

    // 時間ちょうどまでは待つ（早すぎる打ち切りで正常な取得を殺していないこと）
    await vi.advanceTimersByTimeAsync(DICT_FETCH_TIMEOUT_MS - 1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(settled).toBe(true)
  })

  it('タイムアウト後に呼び直すと再取得する', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => hangingFetch(init))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadTtsPhraseBreakDict, getTtsPhraseBreakDictCache } = await freshModule()

    const assertion = expect(loadTtsPhraseBreakDict()).rejects.toThrow(
      `tts-phrase-break-dict fetch timed out after ${DICT_FETCH_TIMEOUT_MS}ms`,
    )
    await vi.advanceTimersByTimeAsync(DICT_FETCH_TIMEOUT_MS)
    await assertion
    expect(getTtsPhraseBreakDictCache()).toBeNull()

    expect(await loadTtsPhraseBreakDict()).toEqual({ 能登地方: 'ノトチホー', 深発地震: 'シンパツジシン' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
