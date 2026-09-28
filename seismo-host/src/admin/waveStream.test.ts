import { describe, expect, it, vi } from 'vitest'

import { openWaveStream, readSensorReading, readStationWaveChunk, readWaveChunk } from './waveStream'
import type { WaveStreamLike, WaveStreamState } from './waveStream'
import type { WaveChunkView } from './waveBuffer'

/** ホストが押し出す波形 1 件（`statusServer.ts` の `sseEvent('wave', ...)` の中身）。 */
function waveJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    streamKey: 'board-1/accel-0/boot-1',
    segmentId: 1,
    boardKey: 'board-1',
    sensorId: 'accel-0',
    channels: ['x', 'y', 'z'],
    firstSampleIndex: 0,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    timebaseNominalReason: null,
    gal: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
    ...overrides,
  }
}

/** 観測点の合成波形（`FusedWaveChunk`・#315）。 */
function stationWaveJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stationId: 'garage',
    driver: { boardKey: 'board-1', sensorId: 'accel-0' },
    firstSampleIndex: 0,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    // 変動分（直流を落とした値）。
    gal: [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
    // 落とした直流。足し戻すと校正済み gal の重み付き平均になる。
    dcGal: [
      [0, 0],
      [0, 0],
      [980, 980],
    ],
    memberCount: [9, 9],
    ...overrides,
  }
}

/** 押し出しの偽物。**Node には `EventSource` が無い**ので、注入して試す。 */
class FakeSource implements WaveStreamLike {
  readyState = 0
  closeCount = 0
  readonly url: string
  private readonly listeners = new Map<string, ((event: { readonly data?: unknown }) => void)[]>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
    const found = this.listeners.get(type)
    if (found === undefined) this.listeners.set(type, [listener])
    else found.push(listener)
  }

  close(): void {
    this.closeCount++
    this.readyState = 2
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

interface Harness {
  readonly source: FakeSource
  readonly states: WaveStreamState[]
  readonly waves: WaveChunkView[]
  readonly stationWaves: WaveChunkView[]
  readonly unreadable: { count: number; detail: string }[]
  readonly controller: AbortController
}

function open(options: { wave?: boolean; withWaveHandler?: boolean } = {}): Harness {
  const controller = new AbortController()
  const states: WaveStreamState[] = []
  const waves: WaveChunkView[] = []
  const stationWaves: WaveChunkView[] = []
  const unreadable: { count: number; detail: string }[] = []
  let source: FakeSource | null = null

  openWaveStream({
    wave: options.wave ?? true,
    signal: controller.signal,
    onState: (state) => states.push(state),
    onWave: options.withWaveHandler === false ? undefined : (chunk) => waves.push(chunk),
    onStationWave: (chunk) => stationWaves.push(chunk),
    onUnreadable: (count, detail) => unreadable.push({ count, detail }),
    create: (url) => {
      source = new FakeSource(url)
      return source
    },
  })

  if (source === null) throw new Error('押し出しが作られなかった')
  return { source, states, waves, stationWaves, unreadable, controller }
}

describe('readWaveChunk', () => {
  it('ホストが押し出す形をそのまま読む', () => {
    const chunk = readWaveChunk(waveJson())

    expect(chunk).not.toBeNull()
    expect(chunk?.source.kind === 'sensor' && chunk.source.boardKey).toBe('board-1')
    expect(chunk?.msPerSample).toBe(10)
    expect(chunk?.gal[1]).toEqual([4, 5, 6])
  })

  it('識別子が欠けていれば通さない', () => {
    expect(readWaveChunk(waveJson({ boardKey: '' }))).toBeNull()
    expect(readWaveChunk(waveJson({ sensorId: undefined }))).toBeNull()
    expect(readWaveChunk(waveJson({ streamKey: 42 }))).toBeNull()
  })

  it('時刻や刻みが数として読めなければ通さない', () => {
    expect(readWaveChunk(waveJson({ firstSampleMs: '1700000000000' }))).toBeNull()
    expect(readWaveChunk(waveJson({ segmentId: null }))).toBeNull()
    expect(readWaveChunk(waveJson({ msPerSample: Number.NaN }))).toBeNull()
  })

  it('刻みが 0 以下なら通さない（時刻が進まない）', () => {
    // 進まないと全サンプルが同じ時刻に積まれ、窓の切り出しが 1 列へ潰れる。
    expect(readWaveChunk(waveJson({ msPerSample: 0 }))).toBeNull()
    expect(readWaveChunk(waveJson({ msPerSample: -10 }))).toBeNull()
  })

  it('軸が 3 本揃っていなければ通さない', () => {
    expect(readWaveChunk(waveJson({ gal: [[1], [2]] }))).toBeNull()
    expect(readWaveChunk(waveJson({ gal: 'x' }))).toBeNull()
  })

  it('サンプルに数として読めない値が混じれば、チャンクごと通さない（安全弁）', () => {
    // **読めない点だけを飛ばさない。** 抜いて前後を詰めると、そこだけ時間が縮んだ
    // 波形になる —— 絵としては普通に見えるので、見ている人に確かめる手立てが無い。
    expect(readWaveChunk(waveJson({ gal: [[1, Number.NaN, 3], [4, 5, 6], [7, 8, 9]] }))).toBeNull()
    expect(readWaveChunk(waveJson({ gal: [[1, null, 3], [4, 5, 6], [7, 8, 9]] }))).toBeNull()
  })

  it('基板が名乗る軸の名前は持ち回らない（校正を通した値は共通座標のため）', () => {
    // 押し出しには `channels` が乗っているが、回転を適用した後の値にセンサーの
    // 軸名は当てはまらない。**使えないものを運ばない。**
    expect(readWaveChunk(waveJson())).not.toHaveProperty('channels')
  })

  it('時刻の当てはめの理由は、そのまま持つ', () => {
    expect(readWaveChunk(waveJson({ timebaseNominalReason: 'too-few-points' }))?.timebaseNominalReason).toBe(
      'too-few-points',
    )
    expect(readWaveChunk(waveJson())?.timebaseNominalReason).toBeNull()
  })

  it('物でなければ通さない', () => {
    expect(readWaveChunk(null)).toBeNull()
    expect(readWaveChunk('wave')).toBeNull()
    expect(readWaveChunk(7)).toBeNull()
  })
})

describe('readStationWaveChunk', () => {
  it('正: 直流を足し戻して、センサー単独と同じ単位（校正済み gal）で返す（#315）', () => {
    const chunk = readStationWaveChunk(stationWaveJson())

    expect(chunk).not.toBeNull()
    expect(chunk?.source).toEqual({ kind: 'station', stationId: 'garage' })
    // **上向き軸は 980 gal 付近が定常値。** 足し戻さないと、センサー単独と
    // 同じ画面に重ねたとき縦の目盛りが 2 つの意味を持つ。
    expect(chunk?.gal[2]).toEqual([985, 986])
    expect(chunk?.gal[0]).toEqual([1, 2])
    expect(chunk?.memberCount).toEqual([9, 9])
  })

  it('正: 区間の識別子は持たない（連続性は時刻の隔たりで見る）', () => {
    const chunk = readStationWaveChunk(stationWaveJson())

    expect(chunk?.streamKey).toBeNull()
    expect(chunk?.segmentId).toBeNull()
  })

  it('対照: 足し戻す相手（dcGal）が無ければ通さない', () => {
    // **変動分だけを「校正済み gal」として出すことになる。** 画面では
    // 「合成だけ 0 gal 付近にいる」としか見えない。
    const { dcGal: _dcGal, ...withoutDc } = stationWaveJson()
    expect(readStationWaveChunk(withoutDc)).toBeNull()
  })

  it('安全弁: gal と dcGal の長さが違えば通さない', () => {
    // 短いほうに合わせると、足し戻せた分と足し戻せなかった分が 1 本の中に混ざる。
    expect(
      readStationWaveChunk(
        stationWaveJson({
          dcGal: [
            [0],
            [0, 0],
            [980, 980],
          ],
        }),
      ),
    ).toBeNull()
  })

  it('安全弁: 観測点の識別子・刻み・混ざった本数のどれかが欠けたら通さない', () => {
    expect(readStationWaveChunk(stationWaveJson({ stationId: '' }))).toBeNull()
    expect(readStationWaveChunk(stationWaveJson({ msPerSample: 0 }))).toBeNull()
    expect(readStationWaveChunk(stationWaveJson({ memberCount: null }))).toBeNull()
  })

  it('安全弁: 混ざった本数の長さがサンプル数と揃っていなければ通さない', () => {
    // **通すと、要約が「描いているサンプル範囲と別の範囲」を数えた値になる**
    // ——エラーもログも出ない（2026-09-28 のレビューが指摘）。
    expect(readStationWaveChunk(stationWaveJson({ memberCount: [9] }))).toBeNull()
    expect(readStationWaveChunk(stationWaveJson({ memberCount: [9, 9, 9] }))).toBeNull()
  })
})

describe('readSensorReading', () => {
  it('計測震度を読む', () => {
    const reading = readSensorReading({
      boardKey: 'board-1',
      sensorId: 'accel-0',
      atMs: 1_700_000_000_000,
      intensity: 1.23,
    })

    expect(reading?.intensity).toBe(1.23)
    expect(reading?.atMs).toBe(1_700_000_000_000)
  })

  it('震度が無い（窓の中身が足りない）ときは null のまま持つ（0 へ倒さない）', () => {
    // **`null` は「揺れていない」ではない。** 0 を埋めると、震度が出ていない
    // センサーが「揺れていない」と読めてしまう。
    const reading = readSensorReading({
      boardKey: 'board-1',
      sensorId: 'accel-0',
      atMs: 1,
      intensity: null,
    })

    expect(reading?.intensity).toBeNull()
  })

  it('識別子が欠けていれば通さない', () => {
    expect(readSensorReading({ boardKey: '', sensorId: 'accel-0' })).toBeNull()
  })
})

describe('openWaveStream', () => {
  it('波形が要るときだけ問い合わせに付ける', () => {
    expect(open({ wave: true }).source.url).toBe('/stream?wave=1')
    expect(open({ wave: false }).source.url).toBe('/stream')
  })

  it('繋ぎ始めたことを最初に伝える', () => {
    expect(open().states).toEqual(['connecting'])
  })

  it('繋がったら伝える', () => {
    const h = open()
    h.source.readyState = 1
    h.source.emit('open')

    expect(h.states).toEqual(['connecting', 'open'])
  })

  it('切れたが繋ぎ直す途中なら、そう伝える', () => {
    const h = open()
    h.source.readyState = 1
    h.source.emit('open')
    h.source.readyState = 0
    h.source.emit('error')

    expect(h.states).toEqual(['connecting', 'open', 'reconnecting'])
  })

  it('向こうが繋ぎ直しをやめたら「繋げない」と伝える', () => {
    // 上限で断られた（503）等。**放っておいても直らない状態**なので、
    // 繋ぎ直し中と区別する。
    const h = open()
    h.source.readyState = 2
    h.source.emit('error')

    expect(h.states).toEqual(['connecting', 'closed'])
  })

  it('同じ状態を連呼しない（対照）', () => {
    // 切れている間はエラーが何度も来る。そのたび画面を書き換える理由が無い。
    const h = open()
    h.source.readyState = 0
    h.source.emit('error')
    h.source.emit('error')
    h.source.emit('error')

    expect(h.states).toEqual(['connecting', 'reconnecting'])
  })

  it('波形を読んで渡す', () => {
    const h = open()
    h.source.emit('wave', JSON.stringify(waveJson()))

    expect(h.waves).toHaveLength(1)
    expect(h.waves[0].source.kind === 'sensor' && h.waves[0].source.sensorId).toBe('accel-0')
    expect(h.unreadable).toEqual([])
  })

  it('正: station-wave は合成の受け口へ届き、センサー単独の受け口へは混ざらない（#315）', () => {
    const h = open()
    h.source.emit('station-wave', JSON.stringify(stationWaveJson()))

    expect(h.stationWaves).toHaveLength(1)
    expect(h.stationWaves[0].source).toEqual({ kind: 'station', stationId: 'garage' })
    // **名前で振り分ける。** 混ざると、合成の 1 本がセンサーの 1 本として
    // 数えられて画面の行が食い違う。
    expect(h.waves).toEqual([])
    expect(h.unreadable).toEqual([])
  })

  it('読めない押し出しは数え、理由を添える', () => {
    const h = open()
    h.source.emit('wave', '{壊れた')
    h.source.emit('wave', JSON.stringify(waveJson({ msPerSample: 0 })))
    h.source.emit('wave', 42)

    expect(h.unreadable).toHaveLength(3)
    expect(h.unreadable[2].count).toBe(3)
    expect(h.unreadable[1].detail).toContain('形が合わない')
    expect(h.unreadable[2].detail).toContain('文字列でない')
    expect(h.waves).toEqual([])
  })

  it('欲しがっていない種別は読まない（対照）', () => {
    // 使う気の無いものを毎回パースする理由が無い。読めない形でも数に入れない。
    const h = open({ withWaveHandler: false })
    h.source.emit('wave', '{壊れた')

    expect(h.unreadable).toEqual([])
  })

  it('打ち切られたら閉じる', () => {
    const h = open()
    h.controller.abort()

    expect(h.source.closeCount).toBe(1)
  })

  it('打ち切られた後に届いたものは無視する（安全弁）', () => {
    // **閉じた後にも届きうる。** 偽物では明示的に流せるが、実物でも
    // 閉じる前に配られたイベントが後から回ることがある。差し替わった画面へ
    // 書き込まないこと（`viewStatus.ts` の `signal.aborted` 確認と同じ）。
    const h = open()
    h.controller.abort()
    h.source.emit('wave', JSON.stringify(waveJson()))
    h.source.emit('open')

    expect(h.waves).toEqual([])
    expect(h.states).toEqual(['connecting'])
  })

  it('既に打ち切られていれば、そもそも繋がない', () => {
    const controller = new AbortController()
    controller.abort()
    const create = vi.fn((url: string) => new FakeSource(url))

    openWaveStream({
      wave: true,
      signal: controller.signal,
      onState: () => undefined,
      create,
    })

    expect(create).not.toHaveBeenCalled()
  })
})
