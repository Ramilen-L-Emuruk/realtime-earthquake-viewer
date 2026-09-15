// DMDATA クライアントの単体テスト。
// WebSocket そのものは jsdom でもモックしないため、ここではモジュール公開の
// ユーティリティ（close code 判定）と、fetch をモックできる REST 取得を対象にする。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  isNonRecoverableCloseCode,
  fetchDmdataGdEarthquakes,
  fetchDmdataActiveEews,
  DmdataWebSocket,
  decodeTelegramText,
  needsBodyDecode,
} from './dmdata'
import { isBinaryTelegramType } from './dmdataTelegramPayload'
import { DmdataApiKeyError, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
import { log } from '../utils/logger'
import { serverNow } from '../utils/clock'
import { setBodyGateIntervalForTest, resetTelegramBodyStatsForTest } from './telegramBody'

// スキップ時の警告を検証したいので、ロガーは差し替えて呼び出しを記録する。
// 間引き（createLogThrottle）は素通しにする。ここで見たいのは「警告を出したか」であって
// 間引きの時間条件ではない（間引き自体の挙動は utils/logger.ts 側の責務）。
//
// **部分モックにする。** 丸ごと置き換えると、logger が新しい関数を export した日に
// 「そんな export は無い」でファイルごと落ちる（`createFirstSeenLogGate` を足したときに
// 実際に起きた）。差し替えたいのは `log` と `createLogThrottle` だけ。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogThrottle: () => (emit: () => void) => emit(),
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

// 発表中の緊急地震速報の復元は、電文本体を `fetchTelegramText` 経由で取る（控えと門を通すため。
// → `services/telegramBody.ts`）。**本番の門は 6 秒に 1 件**なので、そのままでは 1 件取るだけで
// 既定のタイムアウト（5 秒）を超える。門が効いているかは `utils/requestGate.test.ts` が本物の
// 間隔で確かめているので、ここでは 0 にして経路だけを見る。
beforeEach(() => {
  setBodyGateIntervalForTest(0)
  resetTelegramBodyStatsForTest()
})

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
describe('電文の body を復号できなかったときの記録', () => {
  const warnings = () => vi.mocked(log.warn).mock.calls.map(c => String(c[0]))

  // 対照: 正常な body は読めて、何も記録しない
  it('base64 の XML は読めて記録も出さない', async () => {
    const body = btoa(String.fromCharCode(...new TextEncoder().encode('<Report/>')))
    const got = await decodeTelegramText({ body, encoding: 'base64', format: 'xml' })
    expect(got).toBe('<Report/>')
    expect(warnings()).toHaveLength(0)
  })

  // 正: 失敗の理由をそれぞれ別のものとして記録する
  // base64 の復号は圧縮形式の判定より**先**に走る。不正な base64 を渡すと
  // ここではなく「復号で例外」の側へ落ちるので、読める base64 を渡すこと
  it('未対応の圧縮形式を記録する', async () => {
    const got = await decodeTelegramText({ body: btoa('x'), encoding: 'base64', compression: 'zip', format: 'xml' })
    expect(got).toBeNull()
    expect(warnings().filter(w => w.includes('未対応の圧縮形式: zip'))).toHaveLength(1)
  })

  it('復号の例外を記録する', async () => {
    // gzip として解けない base64 を渡して例外を起こさせる
    const got = await decodeTelegramText({ body: 'not-base64-@@@', encoding: 'base64', compression: 'gzip', format: 'xml' })
    expect(got).toBeNull()
    expect(warnings().filter(w => w.includes('復号で例外が出ました'))).toHaveLength(1)
  })

  // 正: `formatMode: 'raw'` なら format は xml のはず。違えば配信形態が変わった印。
  // **ただし本文は返す** —— 復号は成功しているので、値が変わっただけで電文を捨てない。
  it('XML 以外の format は記録するが本文は返す', async () => {
    const got = await decodeTelegramText({ body: '{"a":1}', encoding: 'utf-8', format: 'json' })
    expect(got).toBe('{"a":1}')
    const hit = warnings().filter(w => w.includes('XML 以外の format: json'))
    expect(hit).toHaveLength(1)
    // 安全弁: 本文は返せているので「復号できませんでした」と書かない。
    // 同じ文言にすると、ログを読んだ人が電文を落としたと取り違える。
    expect(hit[0]).not.toContain('復号できませんでした')
  })

  // 安全弁: `typeof null` は 'object' を返すので、そのまま流すと読み手が形を取り違える
  it('body が null なら shape を null と書く', async () => {
    const got = await decodeTelegramText({ body: null })
    expect(got).toBeNull()
    const hit = warnings().filter(w => w.includes('文字列ではありません'))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toContain('null')
    expect(hit[0]).not.toContain(': object')
  })

  // 安全弁: 配列も object と書かない
  it('body が配列なら shape を array と書く', async () => {
    const got = await decodeTelegramText({ body: [1, 2] })
    expect(got).toBeNull()
    expect(warnings().filter(w => w.includes('array'))).toHaveLength(1)
  })

  // 安全弁: かつて VYSE 系で想定していた `{ uri }` の形もここへ落ちる（別扱いしない）
  it('body が { uri } でも shape として記録する', async () => {
    const got = await decodeTelegramText({ body: { uri: 'https://example.invalid/x' } })
    expect(got).toBeNull()
    expect(warnings().filter(w => w.includes('文字列ではありません'))).toHaveLength(1)
  })
})

// 通信に載せられない文字（日本語入力の変換途中の値など）を含むキーが渡ったときの契約。
// 呼び出し側（useEarthquakes）が通信前に弾くのが本筋だが、そこが漏れても
// 「主系の取得は理由の分かる例外」という約束を守る。
describe('APIキーが不正なときの取得の振る舞い', () => {
  const INVALID_KEY = 'abc123あ'

  // 失敗を隠さず例外にする契約。投げるのは DOMException ではなく理由の分かる型。
  it('震源カタログは DmdataApiKeyError を投げ、通信を試みない', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('通信してはいけない') })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(fetchDmdataGdEarthquakes(INVALID_KEY, 30)).rejects.toThrow(DmdataApiKeyError)

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


// 同時接続数の上限（HTTP 409）で断られたときの待ち方。
//
// この状態は**こちら側の異常ではない**（契約の枠を別のタブ・端末が使っているだけ）ので
// 停止させない。一方で通常の上限（30 秒）のまま待ち続けると、繋がらないと分かっている
// 要求を毎時 120 回投げ続ける（実測 2026-09-13: 1 セッションが 2 時間 27 分・304 回）。
describe('DmdataWebSocket: 同時接続数の上限で断られたとき', () => {
  /** tryConnect は async。catch へ到達するまでマイクロタスクを流す。 */
  async function drain() {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  /**
   * チケット要求に指定の `status` を返し続ける fetch と、**予約された待ち時間**を記録する
   * `setTimeout` を仕込む。待ちの長さは private なので、予約の引数から見るしかない。
   */
  function stubCrowdedTicket(status: number) {
    const requests = { count: 0 }
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests.count++
      return {
        status,
        json: async () => ({ error: { code: status, message: 'The maximum number of simultaneous connections is full.' } }),
      } as unknown as Response
    }))
    const delays: number[] = []
    const fakeSetTimeout = globalThis.setTimeout
    vi.stubGlobal('setTimeout', ((fn: Parameters<typeof globalThis.setTimeout>[0], ms?: number) => {
      delays.push(ms ?? 0)
      return fakeSetTimeout(fn, ms)
    }) as typeof globalThis.setTimeout)
    return { requests, delays }
  }

  // 通常の再接続の上限。`dmdata.ts` の RECONNECT_MAX_MS と揃える（export していないため写す）
  const NORMAL_MAX_MS = 30_000

  // 正: 409 が続くと待ちが通常の上限を超えて伸びる
  it('409 が続くと待ちが通常の上限（30 秒）を超えて伸びる', async () => {
    vi.useFakeTimers()
    const { requests, delays } = stubCrowdedTicket(409)
    const ws = new DmdataWebSocket('valid-key')

    try {
      ws.connect()
      await drain()
      // 上限へ達するまで進める（3 秒から 1.5 倍ずつなので 10 分あれば頭打ちに入る）
      await vi.advanceTimersByTimeAsync(600_000)

      expect(Math.max(...delays)).toBeGreaterThan(NORMAL_MAX_MS)
      // 安全弁: 伸ばしただけで、止めてはいない（枠が空いたら自動で繋がるため）
      expect(requests.count).toBeGreaterThan(1)
    } finally {
      ws.disconnect()
      vi.useRealTimers()
    }
  })

  // 対照: 409 以外の失敗では通常の上限に収まる。伸ばすのは「枠が埋まっている」ときだけで、
  // ネットワーク断まで 5 分待たせると復帰がそのぶん遅れる
  it('409 以外の失敗では通常の上限に収まる', async () => {
    vi.useFakeTimers()
    const { requests, delays } = stubCrowdedTicket(500)
    const ws = new DmdataWebSocket('valid-key')

    try {
      ws.connect()
      await drain()
      await vi.advanceTimersByTimeAsync(600_000)

      expect(Math.max(...delays)).toBeLessThanOrEqual(NORMAL_MAX_MS)
      expect(requests.count).toBeGreaterThan(1)
    } finally {
      ws.disconnect()
      vi.useRealTimers()
    }
  })

  // 安全弁: 「切断」ではなく専用の状態を通知する。利用者がすべきことが違う
  // （キーや回線ではなく、別のタブを閉じる）ため、画面の文言を分ける必要がある
  it('接続状態に crowded を通知する', async () => {
    vi.useFakeTimers()
    stubCrowdedTicket(409)
    const ws = new DmdataWebSocket('valid-key')
    const statuses: string[] = []
    ws.onStatusChange = (s) => { statuses.push(s) }

    try {
      ws.connect()
      await drain()

      expect(statuses).toContain('crowded')
      expect(statuses).not.toContain('disconnected')
    } finally {
      ws.disconnect()
      vi.useRealTimers()
    }
  })
})

// 電文の本文の復号。`formatMode: 'raw'` で購読しているので、届くのは base64 + gzip の XML。
// ここが壊れると電文が 1 通も読めなくなるが、型検査では気づけない（`body` は unknown 由来）。
describe('decodeTelegramText', () => {
  /** base64 + gzip に包む（DMDATA が配る形）。 */
  async function pack(text: string): Promise<string> {
    const gz = new Blob([new TextEncoder().encode(text) as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('gzip'))
    const bytes = new Uint8Array(await new Response(gz).arrayBuffer())
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }

  const XML = '<?xml version="1.0" encoding="UTF-8"?><Report><Control><Title>震源・震度に関する情報</Title></Control></Report>'

  // 正: 実際の配信形態（base64 + gzip）を解いて XML のテキストが返る。
  it('base64 + gzip の本文を XML のテキストへ戻す', async () => {
    const body = await pack(XML)
    const text = await decodeTelegramText({ body, encoding: 'base64', compression: 'gzip', format: 'xml' })
    expect(text).toBe(XML)
  })

  // 対照: 圧縮なしの base64 も読める（配信形態が変わっても本文を落とさない）。
  it('圧縮なしの base64 も読める', async () => {
    let bin = ''
    for (const b of new TextEncoder().encode(XML)) bin += String.fromCharCode(b)
    const text = await decodeTelegramText({ body: btoa(bin), encoding: 'base64', format: 'xml' })
    expect(text).toBe(XML)
  })

  // 安全弁: 本文が文字列でない形（かつて VYSE 系で想定していた `{ uri }` 等）は null にする。
  // 読めないものを読めたことにすると、空の電文が正常系として下流へ流れる。
  it('本文が文字列でなければ null', async () => {
    expect(await decodeTelegramText({ body: { uri: 'https://example.invalid/x' } })).toBeNull()
    expect(await decodeTelegramText({})).toBeNull()
  })

  // 安全弁: 解けない圧縮形式（zip 等）は null。ブラウザの DecompressionStream が扱えない。
  it('対応していない圧縮形式は null', async () => {
    expect(await decodeTelegramText({ body: 'AAAA', encoding: 'base64', compression: 'zip' })).toBeNull()
  })
})

// 本文を復号する種別の絞り込み。**扱わない電文のためだけに base64 デコード → gunzip →
// 文字列化が走っていた**のを止めた（2026-09-10）。効き目より **絞りすぎていないこと** の
// ほうが大事な変更なので、安全弁を厚めに置く。
describe('needsBodyDecode', () => {
  // 正: 購読の網に掛かるが扱わない種別は復号しない。分類 telegram.earthquake には
  // アプリが読まない種別がいくつも流れており、以前はその全部を base64 デコード →
  // gunzip → 文字列化してから捨てていた。
  it('扱わない種別の本文は復号しない', () => {
    expect(needsBodyDecode('VXSE56')).toBe(false)
    expect(needsBodyDecode('WEPA60')).toBe(false)
    expect(needsBodyDecode('VZSE50')).toBe(false)
  })

  // 対照: IXAC41（推計震度分布図）は**扱うようになったので本文が要る**。ただし通るのは
  // 二進の経路で、`TextDecoder` は通さない（`decodeTelegramBytes` → `BufrFragmentStore`）。
  // 文字列へ落とすと不正なバイトが U+FFFD へ潰れて元へ戻せなくなる。
  it('二進電文は本文が要る（ただし文字列にはしない）', () => {
    expect(needsBodyDecode('IXAC41')).toBe(true)
    expect(isBinaryTelegramType('IXAC41')).toBe(true)
    // XML の種別を二進の経路へ流さないこと
    expect(isBinaryTelegramType('VXSE53')).toBe(false)
  })

  // 対照: パーサーへ渡す種別はこれまでどおり復号する。ここが偽になると電文が 1 通も読めなくなる。
  it('扱う種別の本文は復号する', () => {
    for (const t of ['VXSE45', 'VXSE51', 'VXSE52', 'VXSE53', 'VXSE61', 'VXSE62',
      'VTSE41', 'VTSE51', 'VTSE52', 'VYSE50', 'VYSE51', 'VYSE52', 'VYSE60',
      'VZSE40', 'VXSE60']) {
      expect(needsBodyDecode(t), t).toBe(true)
    }
  })

  // 安全弁: パーサーへ渡さないが `handleMessage` の分岐が扱う 3 種を巻き込んでいないこと。
  // **とくに VXSE43** —— 購読していない電文が届いたことを知らせる警告を上げる唯一の経路で、
  // 「扱う種別だけ復号する」と素朴に書くとここが黙る。配信分類の変わり目に気づけなくなる。
  it('パーサーへ渡さないが分岐が扱う種別は巻き込まない', () => {
    expect(needsBodyDecode('VXSE42')).toBe(true)   // 配信テスト（疎通確認として記録する）
    expect(needsBodyDecode('VXSE43')).toBe(true)   // 購読外。届いたら警告＋電文ログ
    expect(needsBodyDecode('VXSE44')).toBe(true)   // 廃止予定の旧 EEW。電文ログへ残す
  })
})

// 起動時の復元で「いま発表中の緊急地震速報」を取る経路。
//
// **電文の中身には踏み込まない。** ここで確かめるのは取得の組み立て（どのイベントの詳細を
// 引くか・どの URL を叩くか・失敗をどう扱うか）で、XML の読み取りは `dmdataParser.test.ts`、
// 有効性の判定は `utils/eew.test.ts` の `selectActiveEews` が持っている。
describe('fetchDmdataActiveEews', () => {
  const KEY = 'valid-key'
  const warnings = () => vi.mocked(log.warn).mock.calls.map(c => c.join(' '))

  /**
   * 一覧・詳細・電文本体を URL で振り分ける fetch。叩かれた URL を記録して返す。
   *
   * 電文本体は 404 にする。中身を読ませたいわけではなく、**どの URL を叩いたか**だけを
   * 見たいため（本文を返すとパーサーが走り、検証したい範囲の外の失敗が混ざる）。
   */
  function stubEewFetch(events: unknown[], reports: unknown[]): string[] {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('data.api.dmdata.jp')) return { ok: false, status: 404 } as unknown as Response
      if (url.includes('/gd/eew/')) {
        return { ok: true, json: async () => ({ items: reports }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ items: events }) } as unknown as Response
    }))
    return urls
  }

  const telegram = (o: Record<string, unknown>) => ({ items: [{ serial: 1, telegrams: [o] }] })

  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('正: 窓の中で終わったイベントは詳細まで辿る', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    const urls = stubEewFetch(
      [{ eventId: 'ev-recent', dateTime: recent }],
      telegram({ id: 'xml-1', head: { type: 'VXSE45', test: false } }).items,
    )

    await fetchDmdataActiveEews(KEY)

    expect(urls.some(u => u.includes('/gd/eew/ev-recent'))).toBe(true)
  })

  it('対照: 窓より前に終わったイベントは詳細を引かない（1 件につきリクエストがかかるため）', async () => {
    const old = new Date(serverNow() - 60 * 60_000).toISOString()
    const urls = stubEewFetch([{ eventId: 'ev-old', dateTime: old }], [])

    await fetchDmdataActiveEews(KEY)

    expect(urls.some(u => u.includes('/gd/eew/ev-old'))).toBe(false)
  })

  it('安全弁: 最終報の時刻を読めないイベントは落とさず詳細を引く', async () => {
    const urls = stubEewFetch(
      [{ eventId: 'ev-broken', dateTime: '壊れた値' }],
      telegram({ id: 'xml-1', head: { type: 'VXSE45', test: false } }).items,
    )

    await fetchDmdataActiveEews(KEY)

    expect(urls.some(u => u.includes('/gd/eew/ev-broken'))).toBe(true)
  })

  it('安全弁: 訓練・試験の報は電文本体を取りに行かない', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    const urls = stubEewFetch(
      [{ eventId: 'ev-test', dateTime: recent }],
      telegram({ id: 'xml-1', head: { type: 'VXSE45', test: true } }).items,
    )

    await fetchDmdataActiveEews(KEY)

    expect(urls.some(u => u.includes('data.api.dmdata.jp'))).toBe(false)
  })

  it('JSON 版を指す報は、元の XML の id へ組み替えて取りに行く', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    const urls = stubEewFetch(
      [{ eventId: 'ev1', dateTime: recent }],
      telegram({ id: 'json-1', originalId: 'xml-1', head: { type: 'VXSE45', test: false } }).items,
    )

    await fetchDmdataActiveEews(KEY)

    expect(urls.some(u => u.endsWith('/xml-1'))).toBe(true)
    expect(urls.some(u => u.endsWith('/json-1'))).toBe(false)
  })

  it('報番号がいちばん大きいものを最新として採る', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    const urls = stubEewFetch([{ eventId: 'ev1', dateTime: recent }], [
      { serial: 3, telegrams: [{ id: 'xml-3', head: { type: 'VXSE45', test: false } }] },
      { serial: 1, telegrams: [{ id: 'xml-1', head: { type: 'VXSE45', test: false } }] },
    ])

    await fetchDmdataActiveEews(KEY)

    expect(urls.some(u => u.endsWith('/xml-3'))).toBe(true)
    expect(urls.some(u => u.endsWith('/xml-1'))).toBe(false)
  })

  it('一覧が失敗したら空配列を返し、失敗した事実を記録する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response))

    await expect(fetchDmdataActiveEews(KEY)).resolves.toEqual([])

    expect(warnings().some(w => w.includes('発表中の緊急地震速報の一覧'))).toBe(true)
  })
})

describe('fetchDmdataActiveEews の部分失敗', () => {
  const KEY = 'valid-key'
  const warnings = () => vi.mocked(log.warn).mock.calls.map(c => c.join(' '))

  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('安全弁: 1 件の詳細で例外が出ても、他の地震の取得は続ける', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      // `!res.ok` では捕まらない失敗（ネットワーク断・JSON 破損）を再現する。
      if (url.includes('/gd/eew/ev-broken')) throw new Error('network down')
      if (url.includes('data.api.dmdata.jp')) return { ok: false, status: 404 } as unknown as Response
      if (url.includes('/gd/eew/')) {
        return {
          ok: true,
          json: async () => ({ items: [{ serial: 1, telegrams: [{ id: 'xml-ok', head: { type: 'VXSE45', test: false } }] }] }),
        } as unknown as Response
      }
      return {
        ok: true,
        json: async () => ({ items: [{ eventId: 'ev-broken', dateTime: recent }, { eventId: 'ev-ok', dateTime: recent }] }),
      } as unknown as Response
    }))

    await fetchDmdataActiveEews(KEY)

    // 壊れた 1 件に引きずられず、健全な側の電文本体まで辿り着いている
    expect(urls.some(u => u.endsWith('/xml-ok'))).toBe(true)
    expect(warnings().some(w => w.includes('ev-broken'))).toBe(true)
  })

  it('安全弁: 2 ページ目の一覧が失敗しても、1 ページ目で得た地震は捨てない', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('data.api.dmdata.jp')) return { ok: false, status: 404 } as unknown as Response
      if (url.includes('/gd/eew/')) {
        return {
          ok: true,
          json: async () => ({ items: [{ serial: 1, telegrams: [{ id: 'xml-page1', head: { type: 'VXSE45', test: false } }] }] }),
        } as unknown as Response
      }
      // 2 ページ目（cursorToken 付き）だけ落とす
      if (url.includes('cursorToken')) return { ok: false, status: 503 } as unknown as Response
      return {
        ok: true,
        json: async () => ({ items: [{ eventId: 'ev-page1', dateTime: recent }], nextToken: 'next' }),
      } as unknown as Response
    }))

    await fetchDmdataActiveEews(KEY)

    expect(urls.some(u => u.endsWith('/xml-page1'))).toBe(true)
    expect(warnings().some(w => w.includes('ページ目'))).toBe(true)
  })

  it('安全弁: 読める電文が 1 通も無ければ記録する（訓練報だけのときは黙る）', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('data.api.dmdata.jp')) return { ok: false, status: 404 } as unknown as Response
      if (url.includes('/gd/eew/')) {
        // 種別を名乗らない報だけ＝訓練ではないのに読めない
        return {
          ok: true,
          json: async () => ({ items: [{ serial: 1, telegrams: [{ id: 'x', head: {} }] }] }),
        } as unknown as Response
      }
      return { ok: true, json: async () => ({ items: [{ eventId: 'ev1', dateTime: recent }] }) } as unknown as Response
    }))

    await fetchDmdataActiveEews(KEY)

    expect(warnings().some(w => w.includes('読み取れませんでした'))).toBe(true)
  })

  it('対照: 訓練・試験の報だけだったときは「読み取れない」と記録しない', async () => {
    const recent = new Date(serverNow() - 60_000).toISOString()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('data.api.dmdata.jp')) return { ok: false, status: 404 } as unknown as Response
      if (url.includes('/gd/eew/')) {
        return {
          ok: true,
          json: async () => ({ items: [{ serial: 1, telegrams: [{ id: 'x', head: { type: 'VXSE45', test: true } }] }] }),
        } as unknown as Response
      }
      return { ok: true, json: async () => ({ items: [{ eventId: 'ev1', dateTime: recent }] }) } as unknown as Response
    }))

    await fetchDmdataActiveEews(KEY)

    expect(warnings().some(w => w.includes('読み取れませんでした'))).toBe(false)
  })
})
