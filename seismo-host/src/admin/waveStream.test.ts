import { describe, expect, it, vi } from 'vitest'

import { openWaveStream, readSensorReading, readWaveChunk } from './waveStream'
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
  readonly unreadable: { count: number; detail: string }[]
  readonly controller: AbortController
}

function open(options: { wave?: boolean; withWaveHandler?: boolean } = {}): Harness {
  const controller = new AbortController()
  const states: WaveStreamState[] = []
  const waves: WaveChunkView[] = []
  const unreadable: { count: number; detail: string }[] = []
  let source: FakeSource | null = null

  openWaveStream({
    wave: options.wave ?? true,
    signal: controller.signal,
    onState: (state) => states.push(state),
    onWave: options.withWaveHandler === false ? undefined : (chunk) => waves.push(chunk),
    onUnreadable: (count, detail) => unreadable.push({ count, detail }),
    create: (url) => {
      source = new FakeSource(url)
      return source
    },
  })

  if (source === null) throw new Error('押し出しが作られなかった')
  return { source, states, waves, unreadable, controller }
}

describe('readWaveChunk', () => {
  it('ホストが押し出す形をそのまま読む', () => {
    const chunk = readWaveChunk(waveJson())

    expect(chunk).not.toBeNull()
    expect(chunk?.boardKey).toBe('board-1')
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
    expect(h.waves[0].sensorId).toBe('accel-0')
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
