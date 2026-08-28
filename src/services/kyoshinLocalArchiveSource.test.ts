import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { log } from '../utils/logger'
import { createLocalKyoshinArchiveSource, clearLocalKyoshinArchiveCache } from './kyoshinLocalArchiveSource'
import type { LocalKyoshinArchive } from '../types/localKyoshinArchive'

const validArchive: LocalKyoshinArchive = {
  id: '2018-iburi',
  sites: [[42.9, 141.9], [43.0, 141.8]],
  stationCodes: ['HKD127', 'HKD128'],
  frames: [
    { time: '2018-09-05T18:07:59.000Z', indices: [6, 6] },
    { time: '2018-09-05T18:08:00.000Z', indices: [12, -1] },
  ],
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** vite開発サーバーのSPAフォールバック（静的ファイル不在時に200・text/htmlでindex.htmlを返す）を模す。 */
function htmlFallbackResponse(): Response {
  return {
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'text/html' }),
    json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
  } as unknown as Response
}

describe('createLocalKyoshinArchiveSource', () => {
  beforeEach(() => {
    clearLocalKyoshinArchiveCache()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('正: 有効なアーカイブが取得できれば、全フレームをenqueueし観測点を解決できる', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, validArchive))
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const enqueue = vi.fn()
    const setStalled = vi.fn()
    source.start({ enqueue, setStalled })

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2))
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      dataTime: '2018-09-05T18:07:59.000Z',
      sitesKey: '2018-iburi',
      indices: [6, 6],
    })
    expect(enqueue.mock.calls[0][0].time).toEqual(new Date('2018-09-05T18:07:59.000Z'))
    expect(setStalled).toHaveBeenCalledWith(false)

    await expect(source.resolveSites('2018-iburi')).resolves.toEqual(validArchive.sites)
  })

  it('対照: ファイルが404（未生成）なら何もenqueueせず、警告も更新停止表示も出さない', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, {}))
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const enqueue = vi.fn()
    const setStalled = vi.fn()
    source.start({ enqueue, setStalled })

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(enqueue).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    expect(setStalled).not.toHaveBeenCalled()
    await expect(source.resolveSites('2018-iburi')).rejects.toThrow()
  })

  it('回帰: 開発サーバーのSPAフォールバック（200・text/html）は404と同じく静かに諦める', async () => {
    // 実機確認で判明した不具合: viteの開発サーバーは静的ファイルが無いGETに対し
    // index.html（200・text/html）を返す。これをJSONとして解析しようとすると
    // 「JSON解析に失敗しました」という誤った警告が、他のアーカイブを再生するたびに毎回出ていた。
    vi.mocked(fetch).mockResolvedValue(htmlFallbackResponse())
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const enqueue = vi.fn()
    const setStalled = vi.fn()
    source.start({ enqueue, setStalled })

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(enqueue).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    expect(setStalled).not.toHaveBeenCalled()
  })

  it('安全弁: 構造が不正なJSONは警告を出し、更新停止として可視化する', async () => {
    // ファイルは（開発サーバーのフォールバックと違って）実際に存在し中身も返ってきているため、
    // 「未生成」と同じ静かな扱いにすると、生成時の不具合が利用者に一切見えなくなる。
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { id: '2018-iburi' /* sites等が無い */ }))
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const enqueue = vi.fn()
    const setStalled = vi.fn()
    source.start({ enqueue, setStalled })

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled())
    expect(enqueue).not.toHaveBeenCalled()
    expect(setStalled).toHaveBeenCalledWith(true)
  })

  it('安全弁: framesが0件のアーカイブは構造不正として扱う', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ...validArchive, frames: [] }))
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const setStalled = vi.fn()
    source.start({ enqueue: vi.fn(), setStalled })

    await vi.waitFor(() => expect(setStalled).toHaveBeenCalledWith(true))
    expect(log.warn).toHaveBeenCalled()
  })

  it('回帰: 5xx等の取得失敗は「未生成」と区別して警告を出し、更新停止として可視化する', async () => {
    // silent-failure-hunterの指摘: 404（未生成）と5xx（本来取得できるはずが取れていない）を
    // 同じ静かな扱いにすると、一時的なサーバー障害が「地震活動なし」と見分けが付かなくなる。
    vi.mocked(fetch).mockResolvedValue(jsonResponse(503, {}))
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const setStalled = vi.fn()
    source.start({ enqueue: vi.fn(), setStalled })

    await vi.waitFor(() => expect(setStalled).toHaveBeenCalledWith(true))
    expect(log.warn).toHaveBeenCalled()
  })

  it('回帰: ネットワーク層の失敗は警告を出し、更新停止として可視化する', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const setStalled = vi.fn()
    source.start({ enqueue: vi.fn(), setStalled })

    await vi.waitFor(() => expect(setStalled).toHaveBeenCalledWith(true))
    expect(log.warn).toHaveBeenCalled()
  })

  it('回帰: 一過性の失敗（5xx・ネットワーク層）はキャッシュされず、次のstart()で再試行する', async () => {
    // 恒久的な404と違い、5xxやネットワーク層の失敗はセッション終了まで固定してよい理由が無い。
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(503, {}))
    const source1 = createLocalKyoshinArchiveSource('2018-iburi')
    const setStalled1 = vi.fn()
    source1.start({ enqueue: vi.fn(), setStalled: setStalled1 })
    // fetch呼び出し自体は同期的にカウントされるため、それだけを待つと「取得失敗の判定・キャッシュの
    // 破棄」という非同期の後始末より先にsource2を作ってしまい、破棄前の失敗結果をキャッシュから
    // 再利用してしまう（レビューで実際に踏んだ）。setStalled(true)まで待てば後始末は完了している。
    await vi.waitFor(() => expect(setStalled1).toHaveBeenCalledWith(true))

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, validArchive))
    const source2 = createLocalKyoshinArchiveSource('2018-iburi')
    const enqueue2 = vi.fn()
    source2.start({ enqueue: enqueue2, setStalled: vi.fn() })
    await vi.waitFor(() => expect(enqueue2).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stop()後に取得が解決しても、enqueueもsetStalledも呼ばれない', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    vi.mocked(fetch).mockReturnValue(new Promise((r) => { resolveFetch = r }))
    const source = createLocalKyoshinArchiveSource('2018-iburi')
    const enqueue = vi.fn()
    const setStalled = vi.fn()
    source.start({ enqueue, setStalled })
    source.stop()
    resolveFetch(jsonResponse(200, validArchive))

    await new Promise((r) => setTimeout(r, 0))
    expect(enqueue).not.toHaveBeenCalled()
    expect(setStalled).not.toHaveBeenCalled()
  })

  it('同一idの2回目のstart呼び出しはfetchをキャッシュから再利用する', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, validArchive))
    const source1 = createLocalKyoshinArchiveSource('2018-iburi')
    source1.start({ enqueue: vi.fn(), setStalled: vi.fn() })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    const source2 = createLocalKyoshinArchiveSource('2018-iburi')
    const enqueue2 = vi.fn()
    source2.start({ enqueue: enqueue2, setStalled: vi.fn() })
    await vi.waitFor(() => expect(enqueue2).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
