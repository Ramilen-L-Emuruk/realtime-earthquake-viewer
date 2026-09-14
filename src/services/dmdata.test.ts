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
  decodeTelegramText,
  needsBodyDecode,
} from './dmdata'
import { isBinaryTelegramType } from './dmdataTelegramPayload'
import { DmdataApiKeyError, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
import { log } from '../utils/logger'
import { serverNow } from '../utils/clock'

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
// 個別電文の取得で落ちた分を記録する。
//
// 取得できなかった電文は履歴からそのまま消え、**件数が減ったことにも気づけない**——
// `cutoffTime` は取得できた分だけで決まるため、欠けたまま「揃った履歴」に見える。
describe('個別電文の取得に失敗したときの記録', () => {
  const KEY = 'valid-key'
  // 実電文の一覧と同じ形（`head.time` は UTC 表記）。時刻を落とすと、時刻窓の計算が
  // 「窓を決められない」経路へ落ちてこの describe の対象外の分岐を通る
  const LIST_ITEM = {
    id: 'x1',
    url: 'https://data.api.dmdata.jp/v1/x1',
    head: { type: 'VXSE53', time: '2026-09-14T10:00:00.000Z' },
  }

  /**
   * 電文一覧は成功させ、個別電文の取得だけを `onTelegram` に委ねる fetch。
   * 一覧（`/v2/telegram`）と本体（`data.api.dmdata.jp`）で応答を分ける。
   */
  function stubTelegramFetch(onTelegram: () => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('data.api.dmdata.jp')) return onTelegram()
      // VXSE53 の一覧にだけ 1 件入れる（他の種別は空でよい）
      const items = url.includes('type=VXSE53') ? [LIST_ITEM] : []
      return { ok: true, json: async () => ({ items }) } as unknown as Response
    }))
  }
  const warnings = () => vi.mocked(log.warn).mock.calls.map(c => c.join(' '))

  // 正: HTTP エラーで落ちた電文を記録する
  it('HTTP エラーで取得できなかった電文を記録する', async () => {
    stubTelegramFetch(async () => ({ ok: false, status: 404 }) as unknown as Response)

    await fetchDmdataEarthquakes(KEY, 10)

    expect(warnings().filter(w => w.includes('電文を取得できませんでした'))).toHaveLength(1)
    expect(warnings().find(w => w.includes('電文を取得できませんでした'))).toContain('404')
  })

  // 正: 例外（ネットワーク断・DNS 失敗）で落ちた件数を記録する。
  // `Promise.allSettled` の `fulfilled` だけを残す形は、これを件数ごと消してしまう
  it('例外で終わった電文の件数を記録する', async () => {
    stubTelegramFetch(async () => { throw new Error('network down') })

    await fetchDmdataEarthquakes(KEY, 10)

    const hit = warnings().filter(w => w.includes('例外で終わりました'))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toContain('network down')
  })

  // 対照: すべて取得できたときは何も記録しない。平常運転でログが埋まらないことの歯止め
  it('すべて取得できれば記録しない', async () => {
    stubTelegramFetch(async () => ({
      ok: true,
      // **中身がパースできる必要はない。** このファイルは node 環境で動くため `DOMParser` が
      // 無く、電文の解釈は必ず失敗する。見たいのは「取得の層」の記録だけなので、
      // 判定はその 2 つの文言に絞っている（解釈の失敗は別の文言で出る）
      text: async () => '<Report/>',
    }) as unknown as Response)

    await fetchDmdataEarthquakes(KEY, 10)

    expect(warnings().filter(w => w.includes('電文を取得できませんでした'))).toHaveLength(0)
    expect(warnings().filter(w => w.includes('例外で終わりました'))).toHaveLength(0)
  })
})

// 長周期地震動の履歴取得で、ページ送りを打ち切った理由を残す。
//
// **黙って `break` すると、取れたところまでが「全部取れた」ように返る。** 件数が減ったことに
// 気づく手立てが無い。個別電文の取得側（`warnRejectedTelegrams`）と同じ形の穴が、
// 同じ関数の一覧取得側に残っていた。
// 電文本体を取りに行く前に時刻窓で絞ることの契約。
//
// 一覧（`/v2/telegram`）は電文の発表時刻を `head.time` に持つので、本体を取らなくても
// 窓は決まる。本体は配信元が「同じ `id` に対して短期間にリクエストを繰り返さないように
// 実装してください」と明記した 50req/5min のエンドポイントなので、窓の外側を取ってから
// 捨てる形にしない（→ docs/spec/data-sources-spec.md §2「リクエスト数を抑える」）。
describe('地震履歴は時刻窓の外側の本体を取りに行かない', () => {
  const KEY = 'valid-key'

  /**
   * 種別ごとの一覧を差し替え、**本体を要求された id** を記録する fetch。
   * 判定したいのは「どの電文の本体を取りに行ったか」なので、本体の中身は見ない
   * （このファイルは node 環境で `DOMParser` が無く、電文の解釈は必ず失敗する）。
   */
  function stubLists(listsByType: Record<string, Array<{ id: string; time?: string }>>) {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('data.api.dmdata.jp')) {
        requested.push(url.split('/').pop() ?? '')
        return { ok: true, text: async () => '<Report/>' } as unknown as Response
      }
      const type = /type=(\w+)/.exec(url)?.[1] ?? ''
      const items = (listsByType[type] ?? []).map(it => ({
        id: it.id,
        url: `https://data.api.dmdata.jp/v1/${it.id}`,
        head: { type, ...(it.time ? { time: it.time } : {}) },
      }))
      return { ok: true, json: async () => ({ items }) } as unknown as Response
    }))
    return requested
  }
  const warnings = () => vi.mocked(log.warn).mock.calls.map(c => c.join(' '))

  // 正: 窓（= 各種別の最古のうち最も新しいもの）より古い電文の本体は要求しない。
  // 実運用ではここが効く —— 発表頻度の低い種別は同じ `limit` でも何十日も遡るため、
  // その大半が窓の外側になる
  it('窓より古い電文の本体は要求しない', async () => {
    const requested = stubLists({
      // いちばん発表が多い種別。最古が窓を決める
      VXSE53: [{ id: 'new53', time: '2026-09-14T10:00:00.000Z' }],
      // 発表頻度が低く古い側まで遡る種別。窓の外側が混じる
      VXSE51: [
        { id: 'new51', time: '2026-09-14T11:00:00.000Z' },
        { id: 'old51', time: '2026-08-01T00:00:00.000Z' },
      ],
    })

    await fetchDmdataEarthquakes(KEY, 50)

    expect(requested).toContain('new53')
    expect(requested).toContain('new51')
    expect(requested).not.toContain('old51')
  })

  // 対照: 窓の内側は取りに行く。**窓と同じ時刻のものも含む** ——
  // 境界を `>` にすると、窓を与えた電文自身が落ちて最古の 1 件が永久に取れない
  it('窓と同じ時刻の電文は取りに行く', async () => {
    const requested = stubLists({
      VXSE53: [{ id: 'a', time: '2026-09-14T10:00:00.000Z' }],
      VXSE52: [{ id: 'b', time: '2026-09-14T10:00:00.000Z' }],
    })

    await fetchDmdataEarthquakes(KEY, 50)

    expect(requested).toEqual(expect.arrayContaining(['a', 'b']))
    expect(requested).toHaveLength(2)
  })

  // 安全弁: 発表時刻を読めない一覧アイテムは**窓の計算から外し、取得する側へ倒す**。
  // 落とすと気象庁が出した電文が画面から消えるうえ、件数が減ったことにも気づけない
  it('発表時刻を読めない一覧アイテムは取りに行き、記録を残す', async () => {
    const requested = stubLists({
      VXSE53: [{ id: 'dated', time: '2026-09-14T10:00:00.000Z' }],
      // 時刻が無いもの・日時として読めないもの。どちらも窓の外側扱いにしない
      VXSE51: [{ id: 'undated' }, { id: 'broken', time: 'not-a-date' }],
    })

    await fetchDmdataEarthquakes(KEY, 50)

    expect(requested).toEqual(expect.arrayContaining(['dated', 'undated', 'broken']))
    const hit = warnings().filter(w => w.includes('発表時刻を読めませんでした'))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toContain('2 件')
  })

  // 安全弁: どの一覧も発表時刻を持たないときは窓を決められない。
  // そのとき全件取りに行く（窓が無いことを「全部窓の外」と解釈すると履歴が空になる）
  it('窓を決められないときは全件取りに行く', async () => {
    const requested = stubLists({
      VXSE53: [{ id: 'p' }, { id: 'q' }],
    })

    await fetchDmdataEarthquakes(KEY, 50)

    expect(requested).toEqual(expect.arrayContaining(['p', 'q']))
  })
})

describe('長周期地震動の一覧取得を打ち切ったときの記録', () => {
  const KEY = 'valid-key'
  const warnings = () => vi.mocked(log.warn).mock.calls.map(c => c.join(' '))

  // 正: 一覧取得が HTTP エラーなら理由を残す
  it('一覧が HTTP エラーなら打ち切りを記録する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response))

    await fetchDmdataLpgms(KEY, '2026-09-01T00:00:00+09:00')

    const hit = warnings().filter(w => w.includes('打ち切ります'))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toContain('503')
  })

  // 正: 例外（ネットワーク断）でも理由を残す
  it('一覧が例外で終わっても打ち切りを記録する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    await fetchDmdataLpgms(KEY, '2026-09-01T00:00:00+09:00')

    const hit = warnings().filter(w => w.includes('打ち切ります'))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toContain('network down')
  })

  // 対照: 一覧が空で正常に終わるページ送りでは鳴らない。
  // 「取り終えた」と「途中で諦めた」を混ぜると、平常運転でログが埋まる
  it('一覧が空なら打ち切りを記録しない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ items: [] }),
    }) as unknown as Response))

    await fetchDmdataLpgms(KEY, '2026-09-01T00:00:00+09:00')

    expect(warnings().filter(w => w.includes('打ち切ります'))).toHaveLength(0)
  })
})

// ライブ受信の body を復号できなかった理由を記録する。
//
// 呼び出し側（WebSocket の onmessage）は電文ログへ「復号に失敗した」とだけ残すので、
// **4 つある失敗の別はここでしか分からない**。理由を debug 専用のログに書くと既定では
// 何も残らないのに、コードは「記録しているから追える」と読める。
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
