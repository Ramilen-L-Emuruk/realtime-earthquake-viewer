// @vitest-environment jsdom
//
// 自作地震計の震度と波形を観測点ごとに畳む層のテスト。
//
// **見るのは結線。** SSE の解き方は `services/seismoStream.test.ts`、波形の環状の
// 入れ物は `utils/seismoWaveBuffer.test.ts` が見ている。こちらが見るのは
// 「押し出しの 1 件が観測点の姿へどう届くか」だけ。
//
// **差し替えるのは押し出しの口だけ。** 観測点の台帳（`SeismoHostDirectory`）は
// 本物を使い、`fetch` を差し替える —— `reading` を観測点へ寄せる経路がこの層の
// 主題なので、台帳をモックすると確かめたいものが消える。
//
// **形は 3 種を対にする**（正／対照／安全弁。CLAUDE.md「検証」）。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useSeismoStation } from './useSeismoStation'
import { log } from '../utils/logger'
import {
  connectSeismoStream,
  SeismoHostDirectory,
  type SeismoMessage,
  type SeismoStreamHandle,
  type SeismoStreamOptions,
} from '../services/seismoStream'

vi.mock('../services/seismoStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/seismoStream')>()
  return { ...actual, connectSeismoStream: vi.fn() }
})

/** 直前に張られた購読の引数。 */
let lastOptions: SeismoStreamOptions | null = null
let closeCalls = 0

/** 押し出しを 1 件配る。 */
function deliver(message: SeismoMessage): void {
  act(() => {
    lastOptions?.onMessage(message)
  })
}

/** 姿を作り直す巡回を 1 周ぶん進める（実装は 500 ms 間隔）。 */
async function tick(ms = 500): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** センサー単独の震度。 */
function reading(boardKey: string, sensorId: string, intensity: number): SeismoMessage {
  return { kind: 'reading', reading: { boardKey, sensorId, atMs: 1000, intensity } }
}

/** 観測点の合成震度。 */
function stationReading(stationId: string, intensity: number): SeismoMessage {
  return { kind: 'station-reading', reading: { stationId, atMs: 2000, intensity } }
}

/** 観測点の合成波形（10 ms 刻み・3 サンプル）。 */
function stationWave(stationId: string, firstSampleMs: number): SeismoMessage {
  return {
    kind: 'station-wave',
    wave: {
      stationId,
      firstSampleMs,
      msPerSample: 10,
      gal: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
      memberCount: [9, 9, 1],
    },
  }
}

/**
 * `/status` の応答。**基板 `mac:aa` と `mac:cc` を観測点 `home`（自宅）へ割り当てる。**
 *
 * **2 基板にしてあるのは、基板を跨ぐ最大値の選抜を通すため**（実機は 1 観測点へ
 * 3 基板 × 3 センサーを割り当てている）。`mac:zz` はどの観測点にも属さない
 * （設定に無い基板）。
 */
const STATUS = {
  sensors: [
    { boardKey: 'mac:aa', sensorId: 'i2c0-68', station: { stationId: 'home', displayName: '自宅' } },
    { boardKey: 'mac:aa', sensorId: 'i2c0-69', station: { stationId: 'home', displayName: '自宅' } },
    { boardKey: 'mac:cc', sensorId: 'i2c0-68', station: { stationId: 'home', displayName: '自宅' } },
    { boardKey: 'mac:zz', sensorId: 'i2c0-68', station: null },
  ],
}

beforeEach(() => {
  vi.useFakeTimers()
  lastOptions = null
  closeCalls = 0
  vi.mocked(connectSeismoStream).mockImplementation((options): SeismoStreamHandle => {
    lastOptions = options
    return { close: () => (closeCalls += 1) }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(STATUS), { status: 200 })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** 台帳を引く問い合わせ（`/status`）が済むまで待つ。 */
async function settleDirectory(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('useSeismoStation', () => {
  const options = { enabled: true, baseUrl: 'http://host:50506', wave: 'none' as const }

  it('正: 合成の震度が届いたら、観測点の姿になる', async () => {
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(stationReading('home', 0.25))
    await tick()

    expect(h.result.current.stations).toEqual([
      {
        stationId: 'home',
        displayName: '自宅',
        intensity: 0.25,
        atMs: 2000,
        source: { kind: 'station' },
        waveSampleCount: 0,
        // **一度も届いていないうちは「止まっている」と言わない**（購読を始めた直後と
        // 区別が付かない）。
        waveStale: false,
        // 波形が届いていなければすべて 0。
        waveTally: { gapSamples: 0, restarts: 0, droppedSamples: 0 },
      },
    ])
  })

  it('正: 合成が来ない観測点は、センサー単独の震度から採る（#309 の穴）', async () => {
    // **ホストは有効なセンサーが 2 台未満の観測点に合成を作らない**
    // （`sensorFusion.ts` の `buildGroups`）。`station-reading` だけを見ていると、
    // そういう観測点の震度が 1 件も出ない。
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(reading('mac:aa', 'i2c0-68', 0.4))
    await tick()

    const station = h.result.current.stations[0]
    expect(station.stationId).toBe('home')
    expect(station.displayName).toBe('自宅')
    expect(station.intensity).toBe(0.4)
    expect(station.source).toEqual({ kind: 'sensor', sensorCount: 1 })
  })

  it('正: 台帳に無い基板の震度は、取り直しで寄せられるようになる', async () => {
    // **`require`/`requireBoard` の呼び出し自体を守るテスト。** 最初から全部を含む
    // `/status` だけで試すと、あの 2 行を消しても落ちない（敵対的レビューの指摘）。
    //
    // **「割り当てが `null` として既にある基板」の境界はここでは見ていない**
    // （`mac:bb` はキー自体が不在なので、`has()` でも `!= null` でも同じ）。
    // その境界は `services/seismoStream.test.ts` の
    // 「割り当ての無い基板も取り直しの対象に残す」が持つ。
    //
    // **1 回目は `mac:bb` を含まない答えを返す。**
    let withBoardBb = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sensors: withBoardBb
              ? [
                  ...STATUS.sensors,
                  {
                    boardKey: 'mac:bb',
                    sensorId: 'i2c0-68',
                    station: { stationId: 'shed', displayName: '倉庫' },
                  },
                ]
              : STATUS.sensors,
          }),
          { status: 200 },
        ),
      ),
    )

    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    // 台帳に無いので寄せられず、並ばない。
    deliver(reading('mac:bb', 'i2c0-68', 0.5))
    await tick()
    expect(h.result.current.stations).toEqual([])

    // ホスト側で割り当てられた（管理コンソールの `PUT /api/boards/:boardKey`）。
    withBoardBb = true
    // 取り直しの下限（60 秒）を越えさせる。
    await tick(61_000)
    // **この 1 件で取り直しが始まる。** 自身は捨てられる（まだ引けていない）。
    deliver(reading('mac:bb', 'i2c0-68', 0.5))
    await tick()
    expect(h.result.current.stations).toEqual([])
    // **次の 1 件で寄せられる。** 震度は毎秒届くので、実際には 1 秒後。
    deliver(reading('mac:bb', 'i2c0-68', 0.5))
    await tick()

    const station = h.result.current.stations[0]
    expect(station.stationId).toBe('shed')
    expect(station.displayName).toBe('倉庫')
    expect(station.intensity).toBe(0.5)
  })

  it('正: 別の基板のセンサーも同じ観測点へ寄せ、跨いで最大値を採る', async () => {
    // 実機は 1 観測点に 3 基板 × 3 センサーを割り当てている（`mac:aa` だけで
    // 試すと、基板を跨ぐ選抜が一度も通らない）。
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(reading('mac:aa', 'i2c0-68', 0.4))
    deliver(reading('mac:cc', 'i2c0-68', 1.5))
    await tick()

    expect(h.result.current.stations[0].intensity).toBe(1.5)
    expect(h.result.current.stations[0].source).toEqual({ kind: 'sensor', sensorCount: 2 })
  })

  it('正: 単独から採るときは最大値を選び、見た本数を添える', async () => {
    // 合成が組めていない＝裏付けが無い状態なので、平均や中央で薄める根拠が無い。
    // **何本から採ったかを添える**ので、裏付けの有無は受け取る側が示せる。
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(reading('mac:aa', 'i2c0-68', 0.4))
    deliver(reading('mac:aa', 'i2c0-69', 1.2))
    await tick()

    expect(h.result.current.stations[0].intensity).toBe(1.2)
    expect(h.result.current.stations[0].source).toEqual({ kind: 'sensor', sensorCount: 2 })
  })

  it('対照: 合成が届いていれば、センサー単独は使わない', async () => {
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(reading('mac:aa', 'i2c0-68', 9.9))
    deliver(stationReading('home', 0.25))
    await tick()

    expect(h.result.current.stations[0].intensity).toBe(0.25)
    expect(h.result.current.stations[0].source).toEqual({ kind: 'station' })
  })

  it('安全弁: 合成が届かなくなったら、単独へ落ちる', async () => {
    // **落とす判断をこの層に置く理由。** 届かなくなると再描画も起きないので、
    // 表示側からは「値が古い」を検出できない。
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(stationReading('home', 0.25))
    await tick()
    expect(h.result.current.stations[0].source).toEqual({ kind: 'station' })

    // 単独だけが届き続ける（合成は止まった）。
    for (let i = 0; i < 12; i += 1) {
      deliver(reading('mac:aa', 'i2c0-68', 0.4))
      await tick()
    }
    expect(h.result.current.stations[0].source).toEqual({ kind: 'sensor', sensorCount: 1 })
    expect(h.result.current.stations[0].intensity).toBe(0.4)
  })

  it('安全弁: 震度が 1 件も届かなくなったら、その観測点を並べない', async () => {
    // **残すと「最後に届いた震度」が画面に居座り、揺れていないのと区別が付かない。**
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(stationReading('home', 0.25))
    await tick()
    expect(h.result.current.stations.length).toBe(1)

    await tick(6000)
    expect(h.result.current.stations).toEqual([])
  })

  it('安全弁: 止まったセンサーの値は、最大値の選抜から外れる', async () => {
    // **落とさないと、止まったセンサーの値が「いまの震度」として残り続ける。**
    // 同じ観測点の別のセンサーが届いている間はその観測点が並び続けるので、
    // 「震度が 1 件も届かなくなったら並べない」の側では捉えられない。
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    // 強く振れたほうが先に止まる。
    deliver(reading('mac:aa', 'i2c0-69', 1.2))
    await tick()
    expect(h.result.current.stations[0].intensity).toBe(1.2)
    expect(h.result.current.stations[0].source).toEqual({ kind: 'sensor', sensorCount: 1 })

    // もう 1 本だけが届き続ける。
    for (let i = 0; i < 12; i += 1) {
      deliver(reading('mac:aa', 'i2c0-68', 0.4))
      await tick()
    }
    expect(h.result.current.stations[0].intensity).toBe(0.4)
    expect(h.result.current.stations[0].source).toEqual({ kind: 'sensor', sensorCount: 1 })
  })

  it('対照: 古さの境目の手前では落とさない', async () => {
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(stationReading('home', 0.25))
    // 5 秒の手前（巡回 8 周ぶん = 4 秒）。
    await tick(4000)
    expect(h.result.current.stations.length).toBe(1)
  })

  it('対照: 観測点へ割り当てられていないセンサーの震度は持たない', async () => {
    // 画面に出せるのは観測点の単位まで。`mac:zz` を利用者へ見せる意味が無い。
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(reading('mac:zz', 'i2c0-68', 0.4))
    await tick()
    expect(h.result.current.stations).toEqual([])
  })

  it('正: 合成波形を抱え、読み出せる', async () => {
    const h = renderHook(() => useSeismoStation({ ...options, wave: 'station' }))
    await settleDirectory()
    expect(lastOptions?.wave).toBe('station')

    deliver(stationWave('home', 1000))
    deliver(stationReading('home', 0.25))
    await tick()

    expect(h.result.current.stations[0].waveSampleCount).toBe(3)
    const window = h.result.current.readWave('home')
    expect(window).not.toBeNull()
    if (window === null) return
    expect(window.firstSampleMs).toBe(1000)
    expect([...window.gal[0]]).toEqual([1, 2, 3])
    // **効いたセンサーの本数が保たれる**（段 4 が 1 本の区間を示すため）。
    expect([...window.memberCount]).toEqual([9, 9, 1])
  })

  // 波形だけが止まる形は実際に起きる —— **観測点の有効なセンサーが 2 台を切ると
  // 合成だけが止まり、震度は単独へ落ちて生き続ける**（`sensorFusion.ts` の `buildGroups`）。
  // 接続層の停滞検出（45 秒）も震度が届いていれば発火しない。抱えた中身は時間で
  // 薄れないので、これを見ないと**止まった絵を「いま静かに揺れている」として描き続ける**。
  describe('波形が届かなくなったら', () => {
    it('正: 止まっていることを立てる', async () => {
      const h = renderHook(() => useSeismoStation({ ...options, wave: 'station' }))
      await settleDirectory()
      deliver(stationWave('home', 1000))
      deliver(stationReading('home', 0.25))
      await tick()
      expect(h.result.current.stations[0].waveStale).toBe(false)

      // 震度だけを届け続ける（波形は止まる）
      for (let i = 0; i < 12; i += 1) {
        deliver(stationReading('home', 0.25))
        await tick()
      }
      expect(h.result.current.stations[0].waveStale).toBe(true)
      // **震度の側は生きたまま** —— だから画面から見分けが付かない。
      expect(h.result.current.stations[0].intensity).toBe(0.25)
    })

    // 対照: 一度も届いていないうちは立てない（購読を始めた直後と区別が付かない）。
    it('対照: 一度も届いていなければ立てない', async () => {
      const h = renderHook(() => useSeismoStation({ ...options, wave: 'station' }))
      await settleDirectory()
      for (let i = 0; i < 12; i += 1) {
        deliver(stationReading('home', 0.25))
        await tick()
      }
      expect(h.result.current.stations[0].waveStale).toBe(false)
      expect(h.result.current.stations[0].waveSampleCount).toBe(0)
    })

    // 安全弁: 届き続けている間は立てない。
    it('安全弁: 届き続けていれば立てない', async () => {
      const h = renderHook(() => useSeismoStation({ ...options, wave: 'station' }))
      await settleDirectory()
      for (let i = 0; i < 12; i += 1) {
        deliver(stationWave('home', 1000 + i * 100))
        deliver(stationReading('home', 0.25))
        await tick()
      }
      expect(h.result.current.stations[0].waveStale).toBe(false)
    })
  })

  it('安全弁: 複数の観測点が同時に作り直されても、どちらの記録も残る', async () => {
    // **記録の間引きを観測点ごとに持つ。** 1 つを共有すると、ホストの再起動や
    // 時刻の補正で複数の観測点が同時に作り直されたとき**最初の 1 件しか残らない**
    // （他は間引きの間ずっと隠れる）。
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const h = renderHook(() => useSeismoStation({ ...options, wave: 'station' }))
      await settleDirectory()
      warn.mockClear()

      // **どちらも「最初のまとまり」なので作り直しになる。** 枠を共有していると
      // 先に届いた側だけが記録され、もう一方は間引きの間ずっと隠れる。
      deliver(stationWave('home', 1000))
      deliver(stationWave('shed', 1000))
      await tick()

      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.filter((m) => m.includes('波形を作り直した')).length).toBe(2)
      expect(messages.some((m) => m.includes('home'))).toBe(true)
      expect(messages.some((m) => m.includes('shed'))).toBe(true)
      void h
    } finally {
      warn.mockRestore()
    }
  })

  it('対照: 波形が届いていない観測点の読み出しは空', async () => {
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(stationReading('home', 0.25))
    await tick()
    expect(h.result.current.readWave('home')).toBeNull()
    expect(h.result.current.readWave('office')).toBeNull()
  })

  it('安全弁: 震度が途切れても波形は捨てない', async () => {
    // 入れ物を捨てると、震度が戻ったときに絵が 60 秒ぶん巻き戻る。
    const h = renderHook(() => useSeismoStation({ ...options, wave: 'station' }))
    await settleDirectory()
    deliver(stationWave('home', 1000))
    deliver(stationReading('home', 0.25))
    await tick()

    await tick(6000)
    expect(h.result.current.stations).toEqual([])
    expect(h.result.current.readWave('home')).not.toBeNull()
  })

  it('対照: トグルが切れている・URL の形が違うなら繋がない', async () => {
    const off = renderHook(() => useSeismoStation({ ...options, enabled: false }))
    await settleDirectory()
    expect(vi.mocked(connectSeismoStream)).not.toHaveBeenCalled()
    expect(off.result.current.stream).toBeNull()
    off.unmount()

    // **形が違えば `fetch` が投げるだけだが、繋ぎ直しの輪が 1 秒ごとに
    // 同じ例外を繰り返すことになる。**
    const bad = renderHook(() => useSeismoStation({ ...options, baseUrl: 'host:50506' }))
    await settleDirectory()
    expect(vi.mocked(connectSeismoStream)).not.toHaveBeenCalled()
    expect(bad.result.current.stream).toBeNull()
  })

  // **App は再生（テスト時刻設定）のあいだ `enabled` を落とす。** ホストが押し出すのは
  // 「いまの震度」だけなので、繋いだままにすると画面の他が過去なのにここだけ現在になる
  // （→ `docs/spec/data-sources-spec.md` §4.5「地図の左上へ重ねる」）。
  // **繋いだ後で落ちる経路**は上の「切れているなら繋がない」（最初から false）では通らない。
  it('正: 繋いだ後で enabled が落ちたら、購読を閉じて震度も落とす', async () => {
    const h = renderHook(
      ({ enabled }: { enabled: boolean }) => useSeismoStation({ ...options, enabled }),
      { initialProps: { enabled: true } },
    )
    await settleDirectory()
    deliver(stationReading('home', 1.2))
    await tick()
    expect(h.result.current.stations).toHaveLength(1)
    const closedBefore = closeCalls

    h.rerender({ enabled: false })
    await tick()
    expect(h.result.current.stations).toEqual([])
    expect(h.result.current.stream).toBeNull()
    expect(closeCalls).toBe(closedBefore + 1)
  })

  it('安全弁: 画面を離れたら購読を落とす（枠は 8 本しかない）', async () => {
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    expect(lastOptions?.signal.aborted).toBe(false)

    h.unmount()
    expect(lastOptions?.signal.aborted).toBe(true)
    expect(closeCalls).toBe(1)
  })

  it('安全弁: URL を書き換えたら帳面を捨てる（前のホストの観測点を混ぜない）', async () => {
    const h = renderHook((props: typeof options) => useSeismoStation(props), {
      initialProps: options,
    })
    await settleDirectory()
    deliver(stationReading('home', 0.25))
    await tick()
    expect(h.result.current.stations.length).toBe(1)

    h.rerender({ ...options, baseUrl: 'http://other:50506' })
    await settleDirectory()
    expect(h.result.current.stations).toEqual([])
  })

  it('安全弁: 姿の作り直しが投げても、巡回は止まらず次で回復する', async () => {
    // **この巡回は「古い震度を落とす」を担う。** 止まると、画面に最後の震度が
    // 残って「揺れていない」と区別が付かなくなる（この層の主目的そのもの）。
    //
    // 現状のロジックでは投げる経路が無いので、外から投げさせて確かめる。
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    const displayName = vi.spyOn(SeismoHostDirectory.prototype, 'displayName')
    try {
      const h = renderHook(() => useSeismoStation(options))
      await settleDirectory()

      displayName.mockImplementation(() => {
        throw new Error('boom')
      })
      deliver(stationReading('home', 0.25))
      await tick()
      // 投げたので姿は作られないが、**記録へ残る**。
      expect(h.result.current.stations).toEqual([])
      expect(error).toHaveBeenCalled()
      expect(String(error.mock.calls[0][0])).toContain('姿の作り直しが投げた')

      // **次の巡回で回復する**（`setInterval` は止まっていない）。
      displayName.mockRestore()
      deliver(stationReading('home', 0.25))
      await tick()
      expect(h.result.current.stations[0].intensity).toBe(0.25)
    } finally {
      displayName.mockRestore()
      error.mockRestore()
    }
  })

  it('正: 繋がり具合を伝える', async () => {
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()

    act(() => {
      lastOptions?.onState({ kind: 'open' })
    })
    expect(h.result.current.stream).toEqual({ kind: 'open' })
  })

  // **読めない押し出しは画面へ出さないと決めた**（累計と理由は接続層が記録へ出す。
  // → `docs/spec/data-sources-spec.md` §4.5「繋がらなくなったことを地図の右上へ出す」）。
  // **受け取らないことを固定する** —— 受け取って state に載せると、ホストと PWA の版が
  // 食い違っている間は押し出しが毎秒 10 件とも読めないので、**誰も読まない値のために
  // 毎秒 10 回の再描画が起きる**（障害が起きているときほど重くなる）。
  it('安全弁: 読めない押し出しは受け取らない', async () => {
    renderHook(() => useSeismoStation(options))
    await settleDirectory()

    expect(lastOptions?.onUnreadable).toBeUndefined()
  })

  it('安全弁: 台帳が引けなくても、識別子のまま震度を出す', async () => {
    // 名前が引けないことと震度が出せないことは別の事実。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    )
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(stationReading('home', 0.25))
    await tick()

    expect(h.result.current.stations[0].displayName).toBe('home')
    expect(h.result.current.stations[0].intensity).toBe(0.25)
  })

  it('安全弁: 震度が出せない（null）観測点も、届いていることは伝える', async () => {
    // **`null` を 0 へ倒さない。** 0 は「揺れていない」を意味してしまう。
    const h = renderHook(() => useSeismoStation(options))
    await settleDirectory()
    deliver(stationReading('home', 0 as number))
    await tick()
    expect(h.result.current.stations[0].intensity).toBe(0)

    deliver({ kind: 'station-reading', reading: { stationId: 'home', atMs: 3000, intensity: null } })
    await tick()
    expect(h.result.current.stations[0].intensity).toBeNull()
  })
})
