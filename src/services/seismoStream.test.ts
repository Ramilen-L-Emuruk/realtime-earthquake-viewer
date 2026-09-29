// 自作地震計ホストへ繋ぐ受け口のテスト。
//
// **形は 3 種を対にする**（正＝効くこと／対照＝境界の手前では効かないこと／
// 安全弁＝併せて緩めなかったものが残っていること。CLAUDE.md「検証」）。
//
// **`fetch` は差し替える。** 実際のホストへ繋ぐ形にすると、走らせる端末に
// seismo-host が動いているかどうかで結果が変わる。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log } from '../utils/logger'
import {
  connectSeismoStream,
  createSseParser,
  fetchSeismoStatus,
  isValidSeismoHostUrl,
  SeismoStationNames,
  type SeismoMessage,
} from './seismoStream'

/** 押し出しの本文を、指定した切れ目で小分けにして返す応答を作る。 */
function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]))
      i += 1
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 押し出しが 1 件も来ないまま閉じる応答（繋がったことだけを確かめたいとき）。 */
function emptyStream(): Response {
  return streamResponse([])
}

/**
 * 1 回だけ本文を流し、2 回目の繋ぎで閉じる `fetch`。
 *
 * **押し出しは「終わったら繋ぎ直す」もの**なので、同じ応答を返し続ける差し替えでは
 * 本文が何度も読まれる。届いた件数を数えるテストではここを通す。
 */
function streamOnce(ctrl: AbortController, chunks: readonly string[]): typeof fetch {
  let calls = 0
  return vi.fn(async () => {
    calls += 1
    if (calls === 1) return streamResponse(chunks)
    ctrl.abort()
    return emptyStream()
  }) as unknown as typeof fetch
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('isValidSeismoHostUrl', () => {
  it('正: http / https の URL を通す', () => {
    expect(isValidSeismoHostUrl('http://192.0.2.137:50506')).toBe(true)
    expect(isValidSeismoHostUrl('https://seismo.example.ts.net')).toBe(true)
    // 末尾のスラッシュ・経路が付いていても URL としては成立する。
    expect(isValidSeismoHostUrl('http://host:50506/')).toBe(true)
  })

  it('対照: スキームが無い・空欄は通さない', () => {
    expect(isValidSeismoHostUrl('192.0.2.137:50506')).toBe(false)
    expect(isValidSeismoHostUrl('')).toBe(false)
    expect(isValidSeismoHostUrl('   ')).toBe(false)
  })

  it('安全弁: http / https 以外のスキームは通さない', () => {
    // **ここを緩めると `fetch` が投げる先を設定へ書けてしまう。**
    expect(isValidSeismoHostUrl('file:///etc/passwd')).toBe(false)
    expect(isValidSeismoHostUrl('javascript:alert(1)')).toBe(false)
    expect(isValidSeismoHostUrl('ws://host:50506')).toBe(false)
    expect(isValidSeismoHostUrl('data:text/plain,x')).toBe(false)
  })
})

describe('createSseParser', () => {
  it('正: event と data の組を 1 件として渡す', () => {
    const got: Array<readonly [string, string]> = []
    const parse = createSseParser((e, d) => got.push([e, d]))
    parse('event: reading\ndata: {"a":1}\n\n')
    expect(got).toEqual([['reading', '{"a":1}']])
  })

  it('対照: コメント行（生存確認）と retry は 1 件として渡さない', () => {
    const got: Array<readonly [string, string]> = []
    const parse = createSseParser((e, d) => got.push([e, d]))
    // ホストが実際に送る 2 つ（`statusServer.ts`）。
    parse('retry: 3000\n\n')
    parse(': ping\n\n')
    expect(got).toEqual([])
  })

  it('安全弁: 枠の途中で切れて届いても 1 件も落とさない', () => {
    // **TCP は枠の境界を保たない。** ここを緩めると、ちょうど切れ目に当たった
    // 押し出しだけが黙って消える（絵が数秒飛ぶだけなので気づけない）。
    const got: Array<readonly [string, string]> = []
    const parse = createSseParser((e, d) => got.push([e, d]))
    parse('event: rea')
    parse('ding\ndata: {"a":')
    parse('1}\n')
    expect(got).toEqual([])
    parse('\n')
    expect(got).toEqual([['reading', '{"a":1}']])
  })

  it('安全弁: 1 回の読み取りに複数の枠が入っていても全部渡す', () => {
    const got: Array<readonly [string, string]> = []
    const parse = createSseParser((e, d) => got.push([e, d]))
    parse('event: reading\ndata: 1\n\n: ping\n\nevent: station-reading\ndata: 2\n\n')
    expect(got).toEqual([['reading', '1'], ['station-reading', '2']])
  })

  it('安全弁: data が複数行なら改行で繋ぐ（SSE の定め）', () => {
    const got: Array<readonly [string, string]> = []
    const parse = createSseParser((e, d) => got.push([e, d]))
    parse('event: reading\ndata: {"a":\ndata: 1}\n\n')
    expect(got).toEqual([['reading', '{"a":\n1}']])
  })

  it('安全弁: CRLF の区切りも受ける', () => {
    const got: Array<readonly [string, string]> = []
    const parse = createSseParser((e, d) => got.push([e, d]))
    parse('event: reading\r\ndata: 1\r\n\r\n')
    expect(got).toEqual([['reading', '1']])
  })

  it('安全弁: 区切りが来ないまま溜まり続けたら捨てて申告する', () => {
    // **これが無いと溜めが際限なく伸びる。** ホストが枠の末尾の空行を落とす版
    // だった場合・間に挟まる機器が本文を書き換えた場合に起きる。**停滞の検出では
    // 見つからない** —— あちらは「何かバイトが届いたか」しか見ないので、
    // 壊れた本文が流れ続けている間は「元気に届いている」と判定する。
    const got: Array<readonly [string, string]> = []
    const overflows: number[] = []
    const parse = createSseParser(
      (e, d) => got.push([e, d]),
      (dropped) => overflows.push(dropped),
    )
    // 空行を 1 つも含まない本文を 1.2 MB ぶん流す。
    const chunk = 'data: '.padEnd(100_000, 'x')
    for (let i = 0; i < 12; i += 1) parse(chunk)
    expect(overflows).toHaveLength(1)
    expect(overflows[0]).toBeGreaterThan(1_000_000)
    expect(got).toEqual([])

    // **捨てたあとは仕切り直せる。** 捨てた時点より後に届いた分はまだ溜めに
    // 残っているので、次の区切りでそれを締める（その断片は枠として読まれるが、
    // 中身は JSON にならないので `readMessage` が弾く）。
    parse('\n\n')
    const before = got.length
    parse('event: reading\ndata: 1\n\n')
    expect(got.slice(before)).toEqual([['reading', '1']])
  })

  it('対照: 正常な途切れ方では捨てない（上限に達しない）', () => {
    // 枠の途中で切れて届くのは正常。1 件は数 KB なので上限には遠く及ばない。
    const got: Array<readonly [string, string]> = []
    const overflows: number[] = []
    const parse = createSseParser(
      (e, d) => got.push([e, d]),
      (dropped) => overflows.push(dropped),
    )
    const body = JSON.stringify({ stationId: 'home', gal: Array.from({ length: 90 }, () => 1.5) })
    for (let i = 0; i < 200; i += 1) {
      parse(`event: station-wave\ndata: ${body}`)
      parse('\n\n')
    }
    expect(overflows).toEqual([])
    expect(got).toHaveLength(200)
  })
})

describe('fetchSeismoStatus', () => {
  it('正: sensors[].station から観測点を読み、同じ観測点は畳む', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        sensors: [
          { station: { stationId: 'home', displayName: '自宅', lat: 35.1, lon: 139.2 } },
          { station: { stationId: 'home', displayName: '自宅', lat: 35.1, lon: 139.2 } },
          { station: null },
        ],
      }),
    ) as unknown as typeof fetch
    const result = await fetchSeismoStatus('http://host:50506', fetchImpl)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.stations).toEqual([
      { stationId: 'home', displayName: '自宅', lat: 35.1, lon: 139.2 },
    ])
    // センサーの本数は畳まない（観測点へ割り当てていないものも数える）。
    expect(result.sensorCount).toBe(3)
  })

  it('正: 末尾のスラッシュを落として繋ぐ', async () => {
    // **落とさないと二重スラッシュで 404 になる。** VOICEVOX 側で実際に踏んだ罠で、
    // 症状は「動いているのに繋がらない」。
    const fetchImpl = vi.fn(async () => jsonResponse({ sensors: [] })) as unknown as typeof fetch
    await fetchSeismoStatus('http://host:50506///', fetchImpl)
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe('http://host:50506/status')
  })

  it('対照: sensors が無ければ「読めない」（観測点 0 件にしない）', async () => {
    // **「機材がまだ 1 本も無い」と「相手が seismo-host ではない」を混ぜない。**
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: 'world' })) as unknown as typeof fetch
    expect(await fetchSeismoStatus('http://host:50506', fetchImpl)).toEqual({
      kind: 'unreadable',
      detail: 'sensors が無い',
    })
  })

  it('対照: sensors が空配列なら「繋がったが観測点 0 件」', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sensors: [] })) as unknown as typeof fetch
    const result = await fetchSeismoStatus('http://host:50506', fetchImpl)
    expect(result).toEqual({ kind: 'ok', stations: [], sensorCount: 0 })
  })

  it('安全弁: HTTP エラー・到達不能・URL 不正を言い分ける', async () => {
    const httpError = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    expect(await fetchSeismoStatus('http://host:50506', httpError)).toEqual({
      kind: 'http-error',
      status: 503,
    })

    const threw = vi.fn(async () => {
      throw new Error('Failed to fetch')
    }) as unknown as typeof fetch
    const unreachable = await fetchSeismoStatus('http://host:50506', threw)
    expect(unreachable.kind).toBe('unreachable')

    // **URL の形が違うなら 1 件も投げない。**
    const never = vi.fn() as unknown as typeof fetch
    expect(await fetchSeismoStatus('host:50506', never)).toEqual({
      kind: 'unreadable',
      detail: 'URL の形が正しくない',
    })
    expect(vi.mocked(never)).not.toHaveBeenCalled()
  })

  it('正: 失敗の理由を記録へ残す（画面には出さないので、ここが唯一の手掛かり）', async () => {
    // 画面に出るのは「何を確かめればよいか」だけ（`seismoStatusLine.ts`）。
    // **ここが無いと、DNS か TLS か CORS か JSON の破損かを誰も切り分けられない。**
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const threw = vi.fn(async () => {
        throw new Error('Failed to fetch')
      }) as unknown as typeof fetch
      await fetchSeismoStatus('http://host:50506', threw)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('Failed to fetch')

      warn.mockClear()
      const httpError = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
      await fetchSeismoStatus('http://host:50506', httpError)
      expect(String(warn.mock.calls[0][0])).toContain('503')

      warn.mockClear()
      const notSeismo = vi.fn(async () => jsonResponse({ hello: 'world' })) as unknown as typeof fetch
      await fetchSeismoStatus('http://host:50506', notSeismo)
      expect(String(warn.mock.calls[0][0])).toContain('sensors')

      // **通信する前に弾く経路も残す。** ここを飛ばすと、`SeismoStationNames` を
      // 不正な URL で作られたときに「名前が引けないのに理由がどこにも無い」状態に
      // なる（あちらは `baseUrl` を検めずに受け取る）。
      warn.mockClear()
      const never = vi.fn() as unknown as typeof fetch
      await fetchSeismoStatus('host:50506', never)
      expect(String(warn.mock.calls[0][0])).toContain('URL の形')
      expect(vi.mocked(never)).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('対照: 成功したときは記録へ出さない', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const fetchImpl = vi.fn(async () => jsonResponse({ sensors: [] })) as unknown as typeof fetch
      await fetchSeismoStatus('http://host:50506', fetchImpl)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('安全弁: 表示名が空なら観測点 ID をそのまま名前にする', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ sensors: [{ station: { stationId: 'home', displayName: '' } }] }),
    ) as unknown as typeof fetch
    const result = await fetchSeismoStatus('http://host:50506', fetchImpl)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.stations[0].displayName).toBe('home')
  })
})

describe('connectSeismoStream', () => {
  /** 待ちを即座に返す（バックオフの長さは戻り値で見る）。 */
  const noSleep = async (): Promise<void> => {}

  /** `onState` が落ち着くまで待つ。 */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }

  it('正: 押し出しの 3 種を読んで渡す', async () => {
    const got: SeismoMessage[] = []
    const ctrl = new AbortController()
    const fetchImpl = streamOnce(ctrl, [
      'event: reading\ndata: {"boardKey":"b1","sensorId":"s1","atMs":100,"intensity":1.5}\n\n',
      'event: station-reading\ndata: {"stationId":"home","atMs":200,"intensity":2.5}\n\n',
      'event: station-wave\ndata: {"stationId":"home","firstSampleMs":300,"msPerSample":10,'
        + '"gal":[[1,2],[3,4],[5,6]],"memberCount":[2,2]}\n\n',
    ])

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'station',
      signal: ctrl.signal,
      onMessage: (m) => got.push(m),
      onState: () => {},
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    expect(got.map((m) => m.kind)).toEqual(['reading', 'station-reading', 'station-wave'])
    expect(got[1]).toEqual({
      kind: 'station-reading',
      reading: { stationId: 'home', atMs: 200, intensity: 2.5 },
    })
  })

  it('正: 波形が要るときだけ ?wave=station を付ける', async () => {
    const ctrl = new AbortController()
    const fetchImpl = vi.fn(async () => emptyStream()) as unknown as typeof fetch

    connectSeismoStream({
      baseUrl: 'http://host:50506/',
      wave: 'none',
      signal: ctrl.signal,
      onMessage: () => {},
      onState: () => {},
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()
    // 末尾のスラッシュも落ちている。
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe('http://host:50506/stream')

    const ctrl2 = new AbortController()
    const fetch2 = vi.fn(async () => emptyStream()) as unknown as typeof fetch
    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'station',
      signal: ctrl2.signal,
      onMessage: () => {},
      onState: () => {},
      fetchImpl: fetch2,
      sleep: noSleep,
    })
    await settle()
    ctrl2.abort()
    expect(vi.mocked(fetch2).mock.calls[0][0]).toBe('http://host:50506/stream?wave=station')
  })

  it('対照: 知らない種別・要求していない波形は「読めない」に数えない', async () => {
    const got: SeismoMessage[] = []
    const unreadable: string[] = []
    const ctrl = new AbortController()
    const fetchImpl = streamOnce(ctrl, [
      // センサー単独の波形。**要求していないのに届くのはホストが古い版のときだが、
      // 画面が壊れるわけではないので黙って捨てる。**
      'event: wave\ndata: {"boardKey":"b1"}\n\n',
      'event: future-thing\ndata: {}\n\n',
      'event: station-reading\ndata: {"stationId":"home","atMs":1,"intensity":1}\n\n',
    ])

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'station',
      signal: ctrl.signal,
      onMessage: (m) => got.push(m),
      onState: () => {},
      onUnreadable: (_n, d) => unreadable.push(d),
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    expect(got.map((m) => m.kind)).toEqual(['station-reading'])
    expect(unreadable).toEqual([])
  })

  it('対照: 形が違う押し出しは捨てて、捨てたことを申告する', async () => {
    const got: SeismoMessage[] = []
    const unreadable: string[] = []
    const ctrl = new AbortController()
    const fetchImpl = streamOnce(ctrl, [
        'event: station-reading\ndata: {壊れた\n\n',
        'event: station-reading\ndata: {"atMs":1}\n\n',
        // **`memberCount` が `gal` と揃わない。** そのまま描くと別のサンプルの
        // 本数を見せることになる。
        'event: station-wave\ndata: {"stationId":"home","firstSampleMs":1,"msPerSample":10,'
          + '"gal":[[1,2],[3,4],[5,6]],"memberCount":[2]}\n\n',
        // **刻みが 0。** 全サンプルが同じ時刻に重なり、絵の横軸が壊れる。
        'event: station-wave\ndata: {"stationId":"home","firstSampleMs":1,"msPerSample":0,'
          + '"gal":[[1],[2],[3]],"memberCount":[1]}\n\n',
        // **数として読めない点が混ざっている。** 読めない点だけ飛ばして繋ぐと
        // そこだけ時間が縮んだ波形になる。
        'event: station-wave\ndata: {"stationId":"home","firstSampleMs":1,"msPerSample":10,'
          + '"gal":[[1,null],[3,4],[5,6]],"memberCount":[2,2]}\n\n',
    ])

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'station',
      signal: ctrl.signal,
      onMessage: (m) => got.push(m),
      onState: () => {},
      onUnreadable: (_n, d) => unreadable.push(d),
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    expect(got).toEqual([])
    expect(unreadable).toHaveLength(5)
    expect(unreadable[0]).toContain('JSON')
    expect(unreadable[1]).toContain('stationId')
    expect(unreadable[2]).toContain('memberCount')
    expect(unreadable[3]).toContain('刻み')
    expect(unreadable[4]).toContain('gal')
  })

  it('安全弁: 断られた理由が状態に載る（購読の上限を「落ちている」と混ぜない）', async () => {
    // **これが `EventSource` をやめた理由そのもの。** あちらは本文を読ませないので、
    // 上限で断られたことが利用者に伝わらない。
    const states: string[] = []
    const ctrl = new AbortController()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('too-many-subscribers', { status: 503 })
      ctrl.abort()
      return emptyStream()
    }) as unknown as typeof fetch

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'none',
      signal: ctrl.signal,
      onMessage: () => {},
      onState: (s) => {
        if (s.kind === 'reconnecting') states.push(s.detail)
      },
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    expect(states[0]).toContain('503')
    expect(states[0]).toContain('too-many-subscribers')
  })

  it('安全弁: 繋ぎ直しの待ちを倍々にし、繋がったら戻す', async () => {
    // **失敗しても同じ間隔で撃ち続けない**（`data-sources-spec.md` §4）。
    // **かつ、繋がったら戻す** —— 戻さないと、1 日 1 回切れる程度の繋ぎでも
    // 待ちが上限へ張り付いたままになる。
    const waits: number[] = []
    const ctrl = new AbortController()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      // 3 回落として、4 回目で繋がって即座に切れる。
      if (calls <= 3) throw new Error('boom')
      if (calls >= 6) ctrl.abort()
      return emptyStream()
    }) as unknown as typeof fetch

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'none',
      signal: ctrl.signal,
      onMessage: () => {},
      onState: (s) => {
        if (s.kind === 'reconnecting') waits.push(s.nextAttemptInMs)
      },
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000])
    // 4 回目で繋がったので、そのあとの待ちは最小へ戻っている。
    expect(waits[3]).toBe(1000)
  })

  it('安全弁: 上限（30 秒）を超えて待ちを伸ばさない', async () => {
    const waits: number[] = []
    const ctrl = new AbortController()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls > 12) ctrl.abort()
      throw new Error('boom')
    }) as unknown as typeof fetch

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'none',
      signal: ctrl.signal,
      onMessage: () => {},
      onState: (s) => {
        if (s.kind === 'reconnecting') waits.push(s.nextAttemptInMs)
      },
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    expect(Math.max(...waits)).toBe(30_000)
  })

  it('安全弁: 受け手が投げても繋ぎ直しの輪は止まらない', async () => {
    // **これが無いと、受け手の不具合 1 つで押し出しが永久に止まる。** しかも
    // 停滞の検出（STALL_MS）はもう回っていないので効かず、画面には最後に届いた
    // 震度が残り続ける ——「揺れていない」と区別が付かなくなる。
    const ctrl = new AbortController()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls >= 4) ctrl.abort()
      return streamResponse(['event: station-reading\ndata: {"stationId":"home","atMs":1,"intensity":1}\n\n'])
    }) as unknown as typeof fetch

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'none',
      signal: ctrl.signal,
      // 届いた 1 件目で投げる。
      onMessage: () => { throw new Error('受け手の不具合') },
      // 状態が変わるたびに投げる。
      onState: () => { throw new Error('受け手の不具合') },
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    // **投げても繋ぎ直しは続いた。** 1 回で止まっていれば 1 になる。
    expect(vi.mocked(fetchImpl).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('対照: 受け手が投げた例外を「切れた理由」に混ぜない', async () => {
    // **混ぜると、受け手の不具合が「回線が切れた」として画面へ出る。** しかも
    // 繋がった時点で待ちは最小へ戻っているので、1 秒ごとに繋ぎ直して同じ例外を
    // 繰り返す（購読の枠は 8 本しかない）。
    const details: string[] = []
    const ctrl = new AbortController()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls >= 3) ctrl.abort()
      return streamResponse(['event: station-reading\ndata: {"stationId":"home","atMs":1,"intensity":1}\n\n'])
    }) as unknown as typeof fetch

    connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'none',
      signal: ctrl.signal,
      onMessage: () => { throw new Error('受け手の不具合') },
      onState: (s) => { if (s.kind === 'reconnecting') details.push(s.detail) },
      fetchImpl,
      sleep: noSleep,
    })
    await settle()
    ctrl.abort()

    // 切れた理由は「押し出しが終わった」（読み取りが尽きた）だけで、
    // 受け手の例外の文面は 1 つも混ざっていない。
    expect(details.length).toBeGreaterThan(0)
    for (const d of details) expect(d).not.toContain('受け手の不具合')
  })

  it('安全弁: 既に落ちている signal では 1 件も投げない', async () => {
    // **`AbortSignal` は発火済みの `abort` を後から登録した相手へ配らない。**
    // ここを見ないと、呼び出し側が「もう要らない」と渡した接続が始まってしまい、
    // `close()` を明示的に呼ぶまで購読の枠を食い続ける。
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = vi.fn(async () => emptyStream()) as unknown as typeof fetch
    const states: string[] = []

    const handle = connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'none',
      signal: ctrl.signal,
      onMessage: () => {},
      onState: (s) => states.push(s.kind),
      fetchImpl,
      sleep: noSleep,
    })
    await settle()

    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled()
    expect(states).toEqual([])
    // 返った handle の `close()` は呼んでも無害。
    expect(() => handle.close()).not.toThrow()
  })

  it('安全弁: 閉じたあとは繋ぎ直さない', async () => {
    const ctrl = new AbortController()
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch

    const handle = connectSeismoStream({
      baseUrl: 'http://host:50506',
      wave: 'none',
      signal: ctrl.signal,
      onMessage: () => {},
      onState: () => {},
      fetchImpl,
      sleep: noSleep,
    })
    handle.close()
    await settle()
    const after = vi.mocked(fetchImpl).mock.calls.length
    await settle()
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(after)
  })
})

describe('SeismoStationNames', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const statusOnce = (displayName: string): typeof fetch =>
    vi.fn(async () =>
      jsonResponse({ sensors: [{ station: { stationId: 'home', displayName } }] }),
    ) as unknown as typeof fetch

  it('正: 取り直すと表示名を引ける', async () => {
    const names = new SeismoStationNames('http://host:50506', statusOnce('自宅'), () => 0)
    await names.refresh()
    expect(names.displayName('home')).toBe('自宅')
  })

  it('対照: 知らない観測点は識別子をそのまま返す', async () => {
    const names = new SeismoStationNames('http://host:50506', statusOnce('自宅'), () => 0)
    await names.refresh()
    // **空文字を返さない。** 画面が名無しになる。
    expect(names.displayName('office')).toBe('office')
  })

  it('安全弁: 知らない観測点が毎秒来ても、下限の間隔より頻繁には叩かない', async () => {
    // **震度は毎秒届く。** ここを緩めると、引けない観測点があるあいだ
    // 毎秒 `/status` を叩く形になる。
    const fetchImpl = statusOnce('自宅')
    let nowMs = 0
    const names = new SeismoStationNames('http://host:50506', fetchImpl, () => nowMs)
    for (let i = 0; i < 10; i += 1) {
      names.require('office')
      await vi.advanceTimersByTimeAsync(0)
      nowMs += 1000
    }
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(1)

    // 下限（60 秒）を越えれば取り直す。
    nowMs += 60_000
    names.require('office')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(2)
  })

  it('安全弁: 既に知っている観測点では問い合わせない', async () => {
    const fetchImpl = statusOnce('自宅')
    const names = new SeismoStationNames('http://host:50506', fetchImpl, () => 0)
    await names.refresh()
    names.require('home')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(1)
  })
})
