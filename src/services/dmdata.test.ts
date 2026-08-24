// DMDATA クライアントの単体テスト。
// WebSocket そのものは jsdom でもモックしないため、ここではモジュール公開の
// ユーティリティ（close code 判定）と、fetch をモックできる REST 取得を対象にする。
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  isNonRecoverableCloseCode,
  fetchDmdataGdEarthquakes,
  fetchDmdataEarthquakes,
  fetchDmdataTsunamis,
  fetchDmdataLpgms,
  fetchDmdataNankai,
  fetchDmdataNankaiCommentary,
  fetchDmdataKohatsu,
  DmdataWebSocket,
} from './dmdata'
import { DmdataApiKeyError, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
import { log } from '../utils/logger'
import { serverNow } from '../utils/clock'

// スキップ時の警告を検証したいので、ロガーは差し替えて呼び出しを記録する。
vi.mock('../utils/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('isNonRecoverableCloseCode', () => {
  it('1008 (Policy Violation) のみ非回復扱い', () => {
    expect(isNonRecoverableCloseCode(1008)).toBe(true)
  })

  it('1008 以外はすべて false（現状 1008 のみ判定対象）', () => {
    // 1000: Normal Closure, 1001: Going Away, 1005: No Status, 1006: Abnormal,
    // 1011: Internal Server Error, 4xxx: application-defined, 5xxx: 範囲外
    for (const code of [1000, 1001, 1005, 1006, 1011, 4000, 4001, 4409, 4999, 5000, 9999]) {
      expect(isNonRecoverableCloseCode(code)).toBe(false)
    }
  })
})

// GD Earthquake List（震源カタログ）のレスポンス 1 件分を組み立てる。
// 実データの構造に合わせている（値はすべて文字列で返る）。
function gdItem(overrides: {
  eventId: string
  daysAgo: number
  lat?: string
  lng?: string
  magnitude?: string | null
  name?: string
  depth?: string
}) {
  // 実装側の cutoff は serverNow() 基準なので、テストデータも同じ時計から作る。
  const originTime = new Date(serverNow() - overrides.daysAgo * 24 * 60 * 60 * 1000).toISOString()
  return {
    id: 1,
    type: 'normal',
    eventId: overrides.eventId,
    originTime,
    arrivalTime: originTime,
    hypocenter: {
      code: '710',
      name: overrides.name ?? 'テスト地方',
      coordinate: {
        latitude: { text: '33.5˚N', value: overrides.lat ?? '33.5000' },
        longitude: { text: '130.1˚E', value: overrides.lng ?? '130.1000' },
      },
      depth: { type: '深さ', unit: 'km', value: overrides.depth ?? '10' },
    },
    ...(overrides.magnitude === null ? {} : { magnitude: { type: 'マグニチュード', unit: 'Mj', value: overrides.magnitude ?? '3.1' } }),
  }
}

// 震源が未決定の地震。震度速報だけが出た段階では originTime も hypocenter も返らない
// （実データで確認済み。持っているのは eventId・arrivalTime・maxInt のみ）。
function gdItemWithoutHypocenter(eventId: string) {
  return { id: 2, type: 'normal', eventId, arrivalTime: new Date(serverNow()).toISOString(), maxInt: '3' }
}

// 発生時刻と hypocenter は持つが、座標の値だけが読めない項目。
// API のフィールドが変わった場合を想定した、もう一方のスキップ経路。
function gdItemWithBrokenCoordinate(eventId: string) {
  const item = gdItem({ eventId, daysAgo: 1 }) as { hypocenter: { coordinate: unknown } }
  item.hypocenter.coordinate = { latitude: {}, longitude: {} }
  return item
}

/** ページごとのレスポンス本文を順に返す fetch。呼ばれた URL も記録する。 */
function stubPagedFetch(pages: Array<{ items: unknown[]; nextToken?: string }>) {
  const urls: string[] = []
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      const body = pages[call++] ?? { items: [] }
      return { ok: true, json: async () => body } as unknown as Response
    }),
  )
  return urls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('fetchDmdataGdEarthquakes', () => {
  it('震源・発生時刻を持たない項目を除き、残りを返す', async () => {
    stubPagedFetch([
      { items: [gdItem({ eventId: 'a', daysAgo: 1 }), gdItemWithoutHypocenter('b'), gdItem({ eventId: 'c', daysAgo: 2 })] },
    ])

    const items = await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(items.map(i => i.eventId)).toEqual(['a', 'c'])
    expect(items[0].latitude).toBe(33.5)
    expect(items[0].longitude).toBe(130.1)
  })

  it('震源を持たない項目でページングを打ち切らない（後続ページも取得する）', async () => {
    // 1 ページ目の先頭に欠測項目を置く。発生時刻を持たない項目で cutoff 判定を通すと
    // ここで全ページの探索が止まり、2 ページ目以降が丸ごと失われる。
    const urls = stubPagedFetch([
      { items: [gdItemWithoutHypocenter('x'), gdItem({ eventId: 'a', daysAgo: 1 })], nextToken: 'TOKEN2' },
      { items: [gdItem({ eventId: 'b', daysAgo: 2 })] },
    ])

    const items = await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(items.map(i => i.eventId)).toEqual(['a', 'b'])
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('cursorToken=TOKEN2')
  })

  it('期間より古い項目に達したら、その時点で取得を打ち切る', async () => {
    const urls = stubPagedFetch([
      { items: [gdItem({ eventId: 'a', daysAgo: 1 }), gdItem({ eventId: 'old', daysAgo: 40 })], nextToken: 'TOKEN2' },
      { items: [gdItem({ eventId: 'b', daysAgo: 2 })] },
    ])

    const items = await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(items.map(i => i.eventId)).toEqual(['a'])
    expect(urls).toHaveLength(1)
  })

  it('マグニチュードが無い・数値化できない場合は -1（不明）に落とす', async () => {
    stubPagedFetch([
      {
        items: [
          gdItem({ eventId: 'none', daysAgo: 1, magnitude: null }),
          gdItem({ eventId: 'nan', daysAgo: 1, magnitude: '不明' }),
          gdItem({ eventId: 'ok', daysAgo: 1, magnitude: '4.2' }),
        ],
      },
    ])

    const items = await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(items.map(i => i.magnitude)).toEqual([-1, -1, 4.2])
  })

  it('深さが無い・数値化できない場合は -1（不明）に落とす', async () => {
    stubPagedFetch([
      { items: [gdItem({ eventId: 'a', daysAgo: 1, depth: '不明' }), gdItem({ eventId: 'b', daysAgo: 1, depth: '20' })] },
    ])

    const items = await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(items.map(i => i.depth)).toEqual([-1, 20])
  })

  it('座標の値が読めない項目も除く（hypocenter はあるが値が欠けるケース）', async () => {
    stubPagedFetch([
      { items: [gdItem({ eventId: 'a', daysAgo: 1 }), gdItemWithBrokenCoordinate('broken')] },
    ])

    const items = await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(items.map(i => i.eventId)).toEqual(['a'])
  })

  it('項目を捨てたときは件数と理由の内訳を警告に出す（黙って捨てない）', async () => {
    stubPagedFetch([
      {
        items: [
          gdItem({ eventId: 'a', daysAgo: 1 }),
          gdItemWithoutHypocenter('b'),
          gdItemWithBrokenCoordinate('c'),
        ],
      },
    ])

    await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(log.warn).toHaveBeenCalledTimes(1)
    const message = String(vi.mocked(log.warn).mock.calls[0][0])
    expect(message).toContain('3 件中 2 件')
    expect(message).toContain('発生時刻なし 1 件')
    expect(message).toContain('震源座標なし 1 件')
  })

  it('全件を捨てたときは例外にする（空配列で既存のキャッシュを潰さない）', async () => {
    // API の形が変わって全項目が読めなくなった場合。空配列を正常な結果として返すと
    // 呼び出し側がそれをキャッシュし、直前まで出ていたヒートマップを消してしまう。
    stubPagedFetch([{ items: [gdItemWithoutHypocenter('a'), gdItemWithoutHypocenter('b')] }])

    await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).rejects.toThrow('地図に置ける項目がありません')
  })

  it('取得結果が最初から 0 件なら例外にしない（本当に地震が無かった場合と区別する）', async () => {
    stubPagedFetch([{ items: [] }])

    await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).resolves.toEqual([])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('期間の端まで読み切った結果 0 件なら例外にしない（正常な打ち切りと全滅を区別する）', async () => {
    // 期間内の項目が偶然すべて震源未決定で、その次が期間外だった並び。データは正常に読めており、
    // 「期間内に地図へ置ける地震が無かった」という結論なので、異常として扱ってはいけない。
    stubPagedFetch([
      { items: [gdItemWithoutHypocenter('a'), gdItem({ eventId: 'old', daysAgo: 40 })], nextToken: 'TOKEN2' },
    ])

    await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).resolves.toEqual([])
  })

  it('1 ページ丸ごと捨てたら後続ページを取りに行かない（空振りのリクエストを重ねない）', async () => {
    // 震源未決定の項目は期間の打ち切り判定を素通りするため、この歯止めが無いと
    // GD_EARTHQUAKE_MAX_PAGES ぶん（20 ページ）を空振りしてから例外になる。
    const urls = stubPagedFetch([
      { items: [gdItemWithoutHypocenter('a')], nextToken: 'T2' },
      { items: [gdItemWithoutHypocenter('b')], nextToken: 'T3' },
      { items: [gdItemWithoutHypocenter('c')], nextToken: 'T4' },
    ])

    await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).rejects.toThrow('地図に置ける項目がありません')
    expect(urls).toHaveLength(1)
  })

  it('全滅時の例外メッセージに理由の内訳を載せる', async () => {
    stubPagedFetch([{ items: [gdItemWithoutHypocenter('a'), gdItemWithBrokenCoordinate('b')] }])

    await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).rejects.toThrow(
      /発生時刻なし 1 件 \/ 震源座標なし 1 件/,
    )
  })

  it('捨てる項目が無ければ警告を出さない', async () => {
    stubPagedFetch([{ items: [gdItem({ eventId: 'a', daysAgo: 1 })] }])

    await fetchDmdataGdEarthquakes('dummy-key', 30)

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('HTTP エラーは例外にする（スコープ不足の 403 等を握り潰さない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response))

    await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).rejects.toThrow('gd/earthquake: 403')
  })

  // 401/403 は契約スコープ不足やキー誤りで、再試行しても直らない。500 等の一時的な失敗と
  // 同じ重さで流すと、コンソールを見た人が「待てば直る」と誤解する。
  it('認証エラー (401/403) は error として記録する', async () => {
    for (const status of [401, 403]) {
      vi.clearAllMocks()
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status }) as unknown as Response))

      await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).rejects.toThrow()

      expect(log.error).toHaveBeenCalledTimes(1)
      expect(String(vi.mocked(log.error).mock.calls[0][0])).toContain('認証エラー')
      expect(log.warn).not.toHaveBeenCalled()
    }
  })

  it('一時的な失敗 (500 等) は warn に留める', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))

    await expect(fetchDmdataGdEarthquakes('dummy-key', 30)).rejects.toThrow()

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('取得失敗')
    expect(log.error).not.toHaveBeenCalled()
  })
})
// 通信に載せられない文字（日本語入力の変換途中の値など）を含むキーが渡ったときの契約。
// 呼び出し側（useEarthquakes）が通信前に弾くのが本筋だが、そこが漏れても
// 「補助情報の取得は null / 空配列」「主系の取得は理由の分かる例外」という約束を守る。
describe('APIキーが不正なときの取得の振る舞い', () => {
  const INVALID_KEY = 'abc123あ'

  /** 呼ばれたら失敗する fetch。1 度も通信を試みないことを確かめる。 */
  function stubForbiddenFetch() {
    const spy = vi.fn(async () => { throw new Error('通信してはいけない') })
    vi.stubGlobal('fetch', spy)
    return spy
  }

  // 補助情報の 3 経路。以前はヘッダを組む行が try の外にあったため、ここの例外が
  // Promise.all の .catch まで飛び「想定外の失敗」として記録されていた。
  it.each([
    ['南海トラフ地震臨時情報', () => fetchDmdataNankai(INVALID_KEY)],
    ['後発地震注意情報', () => fetchDmdataKohatsu(INVALID_KEY)],
    ['南海トラフ地震関連解説情報', () => fetchDmdataNankaiCommentary(INVALID_KEY)],
  ])('%s は null を返し、例外を漏らさない', async (_name, call) => {
    const fetchSpy = stubForbiddenFetch()

    await expect(call()).resolves.toBeNull()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(log.error).mock.calls[0][0])).toContain(DMDATA_API_KEY_INVALID_MESSAGE)
  })

  it('長周期地震動観測情報は空配列を返し、例外を漏らさない', async () => {
    const fetchSpy = stubForbiddenFetch()

    await expect(fetchDmdataLpgms(INVALID_KEY, new Date().toISOString())).resolves.toEqual([])

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  // 主系（地震・津波・震源カタログ）は失敗を隠さず例外にする契約のまま。
  // 変えるのはメッセージだけで、DOMException ではなく理由の分かる型を投げる。
  it.each([
    ['地震履歴', () => fetchDmdataEarthquakes(INVALID_KEY, 10)],
    ['津波履歴', () => fetchDmdataTsunamis(INVALID_KEY, 10)],
    ['震源カタログ', () => fetchDmdataGdEarthquakes(INVALID_KEY, 30)],
  ])('%s は DmdataApiKeyError を投げる', async (_name, call) => {
    const fetchSpy = stubForbiddenFetch()

    await expect(call()).rejects.toThrow(DmdataApiKeyError)

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// 今回の修正の背景そのもの。以前は btoa の DOMException が `err.message === 'auth'` に一致せず、
// 30 秒間隔のバックオフで永久に再接続し続け、しかも失敗ログは debug 配下なので無音だった。
//
// authHeader はチケット取得の fetch より先に投げるため `new WebSocket()` へ到達しない。
// よって WebSocket をモックしなくてもこの分岐だけを検証できる。
describe('DmdataWebSocket: APIキーが不正なとき', () => {
  /** tryConnect は async。catch へ到達するまでマイクロタスクを流す。 */
  async function drain() {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it('再接続せず停止し、理由を error として記録する', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn(async () => { throw new Error('通信してはいけない') })
    vi.stubGlobal('fetch', fetchSpy)
    const ws = new DmdataWebSocket('abc123あ')
    const statuses: string[] = []
    ws.onStatusChange = (s) => { statuses.push(s) }

    try {
      ws.connect()
      await drain()

      expect(statuses).toEqual(['connecting', 'disconnected'])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(log.error).toHaveBeenCalledTimes(1)
      // 理由は第 2 引数（reason）に載る。**固定文の側で「不正」と言い切らないこと**——未設定でも
      // ここへ来うるため、言い切ると入れた覚えのない文字を探させる（2026-08-24 の言い分け対応）。
      expect(String(vi.mocked(log.error).mock.calls[0][0])).toContain('APIキーが使えない')
      expect(vi.mocked(log.error).mock.calls[0][1]).toMatchObject({
        reason: DMDATA_API_KEY_INVALID_MESSAGE,
      })

      // バックオフの上限（RECONNECT_MAX_MS = 30 秒）を大きく超えて進めても再接続しない。
      // ここが効いていないと、無音のまま延々とチケット取得を叩き続ける状態に戻る。
      await vi.advanceTimersByTimeAsync(120_000)

      expect(statuses).toEqual(['connecting', 'disconnected'])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      ws.disconnect()
      vi.useRealTimers()
    }
  })
})
