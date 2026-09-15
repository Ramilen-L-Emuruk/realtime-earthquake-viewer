import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchTelegramText, telegramBodyStats, resetTelegramBodyStatsForTest } from './telegramBody'
import { clearTelegramBodyCache, telegramCacheStats, MAX_ENTRIES } from '../utils/telegramBodyCache'

// 電文本体の控え。**配信元が名指しで求めている形**（「同じ`id`に対して短期間にリクエストを
// 繰り返さないように実装してください」）を満たしているかを固定する。
//
// 控えを持たなかった頃は、起動のたびに同じ id を取り直していた（実測 88 件/起動）。
//
// `fake-indexeddb/auto` はプロセス全体で 1 つの実装を共有するので、テストごとに控えを空にする。
describe('fetchTelegramText（電文本体の控え）', () => {
  const KEY = 'valid-key'
  const url = (id: string) => `https://data.api.dmdata.jp/v1/${id}`

  beforeEach(async () => {
    await clearTelegramBodyCache()
    resetTelegramBodyStatsForTest()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * 同時要求のまとめ（`inFlight`）から外れるのを待つ。
   *
   * **`await` した直後にはまだ残っている。** 登録を外すのは Promise の解決後（マイクロタスク
   * 1 つ後）なので、間を置かずに同じ id を要求すると「まとめ」として同じ結果を受け取り、
   * 控えからは読み直さない。結果は同じでリクエストも増えないので実害は無いが、
   * 「控えから読めたか」を確かめるテストでは 1 拍待つ必要がある。
   */
  const settle = () => new Promise((r) => setTimeout(r, 0))

  /** 取得回数を数える fetch。同じ id を 2 度取りに行っていないかを見る。 */
  function stubFetch(xmlById: Record<string, string>) {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const id = u.split('/').pop() ?? ''
      requested.push(id)
      const xml = xmlById[id]
      if (xml === undefined) return { ok: false, status: 404 } as unknown as Response
      return { ok: true, status: 200, text: async () => xml } as unknown as Response
    }))
    return requested
  }

  // 正: 2 度目は取得しない。**これがこの機能の目的そのもの**
  it('同じ id を 2 度取りに行かない', async () => {
    const requested = stubFetch({ abcdef0123: '<Report>1</Report>' })

    const first = await fetchTelegramText(KEY, url('abcdef0123'))
    await settle()
    const second = await fetchTelegramText(KEY, url('abcdef0123'))

    expect(first.xml).toBe('<Report>1</Report>')
    expect(second.xml).toBe('<Report>1</Report>')
    expect(requested).toEqual(['abcdef0123'])   // 1 回だけ
    expect(second.fromCache).toBe(true)
    expect(telegramBodyStats()).toMatchObject({ fetched: 1, fromCache: 1 })
  })

  // 対照: 別の id は取りに行く（控えが効きすぎて別の電文を返さないこと）
  it('別の id は取りに行く', async () => {
    const requested = stubFetch({ aaaaaaaa11: '<Report>A</Report>', bbbbbbbb22: '<Report>B</Report>' })

    const a = await fetchTelegramText(KEY, url('aaaaaaaa11'))
    const b = await fetchTelegramText(KEY, url('bbbbbbbb22'))

    expect(a.xml).toBe('<Report>A</Report>')
    expect(b.xml).toBe('<Report>B</Report>')
    expect(requested).toEqual(['aaaaaaaa11', 'bbbbbbbb22'])
  })

  // 安全弁: 失敗は控えない。**控えると、一度の失敗が以後ずっと「取得済みの失敗」として残る**
  it('取得に失敗したら控えない（次に取り直せる）', async () => {
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempt++
      if (attempt === 1) return { ok: false, status: 503 } as unknown as Response
      return { ok: true, status: 200, text: async () => '<Report>late</Report>' } as unknown as Response
    }))

    const failed = await fetchTelegramText(KEY, url('cccccccc33'))
    expect(failed.xml).toBeNull()
    expect(failed.status).toBe(503)

    // 復旧後は取り直せる
    await settle()
    const ok = await fetchTelegramText(KEY, url('cccccccc33'))
    expect(ok.xml).toBe('<Report>late</Report>')
  })

  // 安全弁: 通信そのものの例外は**潰さずに投げる**。
  // 呼び出し側の `Promise.allSettled` が「何件が例外で終わったか」をまとめて記録しており
  // （`warnRejectedTelegrams`）、ここで値へ潰すと**全件落ちたときに件数が分からなくなる**
  it('通信の例外は潰さずに投げる（呼び出し側が件数をまとめる）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    await expect(fetchTelegramText(KEY, url('dddddddd44'))).rejects.toThrow('network down')
    expect((await telegramCacheStats()).entries).toBe(0)
  })

  // 安全弁: 鍵を作れない URL では控えを使わず、素の取得へ落ちる。
  // **鍵が無いまま控えると、別の電文を同じ鍵で上書きしうる**
  it('id を取り出せない URL は控えず、毎回取りに行く', async () => {
    const requested = stubFetch({ '': '<Report>x</Report>' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '<Report>x</Report>' }) as unknown as Response))

    await fetchTelegramText(KEY, 'not-a-url')
    await fetchTelegramText(KEY, 'not-a-url')

    expect((await telegramCacheStats()).entries).toBe(0)
    expect(telegramBodyStats().fetched).toBe(2)   // 控えないので 2 回
    void requested
  })

  // 安全弁: 上限を超えたら古い順に捨てる。**捨てないと利用者の端末を無闇に使う**
  // （電文の大きさは桁で違い、各地の震度情報は 500KB を超えることがある）
  it('件数の上限を超えたら古い順に捨てる', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => ({
      ok: true, status: 200, text: async () => `<Report>${u.split('/').pop()}</Report>`,
    }) as unknown as Response))

    // 上限 +5 件を入れる（id は 8 文字以上でないと鍵にならない）
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      await fetchTelegramText(KEY, url(`telegram${String(i).padStart(6, '0')}`))
    }

    // **控えへの書き込みは待たない設計**（電文はもう手元にあるので先へ進む）。
    // そのぶんパージは非同期に走るので、収まるまで待つ
    await vi.waitFor(async () => {
      expect((await telegramCacheStats()).entries).toBeLessThanOrEqual(MAX_ENTRIES)
    }, { timeout: 20_000 })
    // 最後に入れたものは残っている（古い順に捨てるので）
    await settle()
    const last = await fetchTelegramText(KEY, url(`telegram${String(MAX_ENTRIES + 4).padStart(6, '0')}`))
    expect(last.fromCache).toBe(true)
  }, 60_000)
})

// 同じ id への同時要求を 1 本にまとめること。
//
// **控えは「取り終わってから」効くので、同時に走った要求には間に合わない。** 実測では
// dev サーバーで起動 1 回の取得が 85 件ではなく 170 件になっていた（React の `StrictMode` が
// effect を 2 回走らせ、その 2 本がほぼ同時に同じ id を取りに行っていた）。
describe('fetchTelegramText（同時要求のまとめ）', () => {
  const KEY = 'valid-key'
  const url = (id: string) => `https://data.api.dmdata.jp/v1/${id}`

  beforeEach(async () => {
    await clearTelegramBodyCache()
    resetTelegramBodyStatsForTest()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // 正: 同じ id を同時に要求しても取得は 1 回だけ
  it('同じ id を同時に要求しても取得は 1 回', async () => {
    let calls = 0
    // **`| null` を初期値にしない。** Promise のコールバックが同期的に走ることを型は知らないので、
    // `release` は `null` のまま推論され、`release?.()` が `never` になって型検査で落ちる
    // （`vitest` は通るのに `tsc -b` だけ落ちる形）。
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      await gate   // 1 本目を取得中のまま留める
      return { ok: true, status: 200, text: async () => '<Report>same</Report>' } as unknown as Response
    }))

    const both = Promise.all([
      fetchTelegramText(KEY, url('eeeeeeee55')),
      fetchTelegramText(KEY, url('eeeeeeee55')),
    ])
    release()
    const [a, b] = await both

    expect(calls).toBe(1)
    expect(a.xml).toBe('<Report>same</Report>')
    expect(b.xml).toBe('<Report>same</Report>')
    expect(telegramBodyStats()).toMatchObject({ fetched: 1, coalesced: 1 })
  })

  // 対照: 別の id は同時でもそれぞれ取りに行く（まとめすぎて取り違えない）
  it('別の id は同時でもそれぞれ取りに行く', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const id = u.split('/').pop() ?? ''
      requested.push(id)
      return { ok: true, status: 200, text: async () => `<Report>${id}</Report>` } as unknown as Response
    }))

    await Promise.all([
      fetchTelegramText(KEY, url('ffffffff66')),
      fetchTelegramText(KEY, url('gggggggg77')),
    ])

    expect(requested.sort()).toEqual(['ffffffff66', 'gggggggg77'])
  })

  // 安全弁: 失敗したまとめを残さない。**残すと、以後そのセッション中ずっと同じ失敗を返す**
  it('同時要求が失敗しても、あとから取り直せる', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls <= 1) throw new Error('network down')
      return { ok: true, status: 200, text: async () => '<Report>recovered</Report>' } as unknown as Response
    }))

    const results = await Promise.allSettled([
      fetchTelegramText(KEY, url('hhhhhhhh88')),
      fetchTelegramText(KEY, url('hhhhhhhh88')),
    ])
    expect(results.every(r => r.status === 'rejected')).toBe(true)

    // まとめが残っていれば、この取得も失敗した Promise を返してしまう
    const retry = await fetchTelegramText(KEY, url('hhhhhhhh88'))
    expect(retry.xml).toBe('<Report>recovered</Report>')
  })
})
