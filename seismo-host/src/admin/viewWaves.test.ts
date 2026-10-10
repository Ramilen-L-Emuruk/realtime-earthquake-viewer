// @vitest-environment jsdom
//
// **`initWavesView` の統合と、`/status` の読み取り。**
//
// 描き直しは `requestAnimationFrame` で回るので、確かめたいことは「時間を進めてから」
// でないと現れない。**jsdom には canvas の 2D 文脈が無い**ので、絵そのものは見られない ——
// 逆に「文脈が取れない環境でも落ちない」ことをここで固定できる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initWavesView, readStatus } from './viewWaves'
import type { WaveChunkView } from './waveBuffer'
import type { WaveStreamOptions } from './waveStream'

let captured: WaveStreamOptions | null = null

vi.mock('./waveStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./waveStream')>()
  return {
    ...actual,
    openWaveStream: (options: WaveStreamOptions) => {
      captured = options
    },
  }
})

function statusJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAtMs: 1_700_000_000_000,
    sensors: [
      {
        boardKey: 'board-1',
        sensorId: 'accel-0',
        lastPacketMs: 1_700_000_000_000,
        lastIntensity: 0.5,
        enabled: true,
        calibrationConfigured: true,
        station: { stationId: 'station-1', displayName: '自宅' },
      },
    ],
    stream: { subscribers: [{ id: 1 }], limit: 8 },
    // 差分を見られる組（#372）。**選ぶ元はここだけ**で、画面は手で組み立てない。
    stationIntensities: [
      {
        stationId: 'station-1',
        pairDiffs: [
          {
            a: { boardKey: 'board-1', sensorId: 'accel-0' },
            b: { boardKey: 'board-2', sensorId: 'accel-1' },
            rmsGal: [0.1, 0.1, 0.2],
            sampleCount: [30, 30, 30],
          },
        ],
      },
    ],
    ...overrides,
  }
}

/** センサー対の差分波形（#372）。**欠けたサンプルは `NaN`。** */
function pairChunk(overrides: Partial<WaveChunkView> = {}): WaveChunkView {
  const axis = Array.from({ length: 30 }, (_, i) => (i === 29 ? Number.NaN : Math.sin(i) * 0.05))
  return {
    source: {
      kind: 'pair',
      stationId: 'station-1',
      boardKeyA: 'board-1',
      sensorIdA: 'accel-0',
      boardKeyB: 'board-2',
      sensorIdB: 'accel-1',
    },
    streamKey: null,
    segmentId: null,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    timebaseNominalReason: null,
    gal: [axis, axis, axis],
    memberCount: null,
    directions: null,
    axisNames: null,
    ...overrides,
  }
}

/**
 * チャンクの上書き。**`boardKey`・`sensorId` を平らに書ける形を残す**
 * （出どころは判別共用体になったので、ここで組み立てる）。
 */
type ChunkOverrides = Partial<WaveChunkView> & {
  readonly boardKey?: string
  readonly sensorId?: string
}

/** 観測点の合成波形（#315）。**直流を足し戻した後の形**で来る。 */
function stationChunk(overrides: Partial<WaveChunkView> = {}): WaveChunkView {
  const axis = Array.from({ length: 30 }, (_, i) => 980 + Math.sin(i) * 0.5)
  return {
    source: { kind: 'station', stationId: 'station-1' },
    streamKey: null,
    segmentId: null,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    timebaseNominalReason: null,
    gal: [axis, axis, axis],
    memberCount: Array.from({ length: 30 }, () => 9),
    directions: null,
    axisNames: null,
    ...overrides,
  }
}

function chunk(overrides: ChunkOverrides = {}): WaveChunkView {
  const { boardKey, sensorId, ...rest } = overrides
  const axis = Array.from({ length: 30 }, (_, i) => 980 + Math.sin(i) * 2)
  return {
    source: { kind: 'sensor', boardKey: boardKey ?? 'board-1', sensorId: sensorId ?? 'accel-0' },
    streamKey: 'board-1/accel-0/boot-1',
    segmentId: 1,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    timebaseNominalReason: null,
    gal: [axis, axis, axis],
    memberCount: null,
    directions: null,
    axisNames: null,
    ...rest,
  }
}

/** 描き直しが 1 度走るまで待つ（`requestAnimationFrame` ＋ 間引きの 100 ms）。 */
async function letItDraw(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200))
}

function mockStatus(body: Record<string, unknown> | Error): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (body instanceof Error) throw body
      return { ok: true, json: async () => body } as unknown as Response
    }),
  )
}

/**
 * 2D 文脈の偽物。
 *
 * **jsdom は本物を持たない**（`getContext` は「未実装」を告げて null を返す）。
 * 差し替えないと**描く側の経路が一度も走らない** —— そこに例外があっても
 * テストは通ってしまう。
 */
function fakeContext(): { calls: string[] } & Record<string, unknown> {
  const calls: string[] = []
  const note =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}(${args.length})`)
    }
  return {
    calls,
    setTransform: note('setTransform'),
    clearRect: note('clearRect'),
    strokeRect: note('strokeRect'),
    beginPath: note('beginPath'),
    moveTo: note('moveTo'),
    lineTo: note('lineTo'),
    stroke: note('stroke'),
    fillText: note('fillText'),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  }
}

let controller: AbortController
let context: ReturnType<typeof fakeContext> | null

beforeEach(() => {
  captured = null
  controller = new AbortController()
  context = fakeContext()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D | null,
  )
})

afterEach(() => {
  controller.abort()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(body: Record<string, unknown> | Error = statusJson()): Promise<HTMLElement> {
  mockStatus(body)
  const container = document.createElement('div')
  document.body.append(container)
  await initWavesView(container, controller.signal)
  return container
}

describe('readStatus', () => {
  it('センサーの名前・受信時刻・校正の有無を読む', () => {
    const status = readStatus(statusJson())

    expect(status.sensors).toHaveLength(1)
    expect(status.sensors[0].stationName).toBe('自宅')
    expect(status.sensors[0].calibrationConfigured).toBe(true)
    expect(status.generatedAtMs).toBe(1_700_000_000_000)
  })

  it('押し出しの枠の空きを読む', () => {
    expect(readStatus(statusJson()).stream).toEqual({ open: 1, limit: 8 })
  })

  it('識別子が欠けたセンサーは落とす', () => {
    const status = readStatus(statusJson({ sensors: [{ boardKey: '', sensorId: 'accel-0' }] }))

    expect(status.sensors).toEqual([])
  })

  it('観測点を割り当てていなければ名前は null（空文字で埋めない）', () => {
    const status = readStatus(
      statusJson({ sensors: [{ boardKey: 'b', sensorId: 's', station: null }] }),
    )

    expect(status.sensors[0].stationName).toBeNull()
  })

  it('正: ずれを見られる台を stationIntensities[].residuals から読む（#688）', () => {
    const status = readStatus({
      stationIntensities: [
        {
          stationId: 'garage',
          pairDiffs: [],
          residuals: [
            { member: { boardKey: 'mac:aa', sensorId: 's0' }, channels: ['HN1'], axes: [] },
            { member: { boardKey: '', sensorId: 's1' } },
          ],
        },
      ],
    })
    expect(status.residuals).toEqual([{ stationId: 'garage', boardKey: 'mac:aa', sensorId: 's0' }])
  })

  it('対照: 欄の無い版のホストでは、ずれの一覧は空', () => {
    expect(readStatus({ stationIntensities: [{ stationId: 'garage', pairDiffs: [] }] }).residuals).toEqual([])
  })

  it('形が違っても落ちない', () => {
    expect(readStatus(null).sensors).toEqual([])
    expect(readStatus({ sensors: 'x', stream: 7 }).stream).toBeNull()
    expect(readStatus({}).generatedAtMs).toBeNull()
  })
})

describe('initWavesView', () => {
  it('操作と 3 つの軸を並べる', async () => {
    const container = await mount()

    expect(container.querySelector('.wave-span')).not.toBeNull()
    expect(container.querySelector('.wave-follow')).not.toBeNull()
    expect(container.querySelectorAll('.wave-canvas')).toHaveLength(3)
  })

  it('押し出しへ繋ぎ、波形を欲しがる（差分は頼まない）', async () => {
    await mount()

    expect(captured?.wave).toBe(true)
    // **差分は既定で頼まない。** 選ぶと購読の中身が変わる（繋ぎ直す）ので、
    // 勝手に流し始めない —— 実機は全ペアで 36 組・毎秒 240 KB（実測） ある（#372）。
    expect(captured?.diff).toBeNull()
  })

  it('タブを離れたら、購読の札も畳む（#372 で札を 1 段挟んだ）', async () => {
    await mount()
    const inner = captured?.signal
    expect(inner).toBeDefined()
    // **タブの札そのものは渡していない。** 差分の組を変えるには繋ぎ直しが要るので、
    // 購読 1 本ごとに畳める札を挟んである。
    expect(inner).not.toBe(controller.signal)
    expect(inner?.aborted).toBe(false)

    controller.abort()

    // **伝わらないと、タブを離れた後も購読が開いたまま残る**（同時購読は 8 本まで）。
    expect(inner?.aborted).toBe(true)
  })

  // センサー対の差分（#372）。**選ぶ元は `/status` の `pairDiffs` だけ。**
  it('正: 組を選ぶと、その組を頼んで繋ぎ直す', async () => {
    const container = await mount()
    const select = container.querySelector<HTMLSelectElement>('.wave-diff')
    expect(select).not.toBeNull()
    // 既定は「選ばない」＋ 組が 1 つ。
    expect(select?.options).toHaveLength(2)
    const before = captured?.signal

    select!.value = select!.options[1].value
    select!.dispatchEvent(new Event('change'))

    expect(captured?.diff).toEqual({
      stationId: 'station-1',
      boardKeyA: 'board-1',
      sensorIdA: 'accel-0',
      boardKeyB: 'board-2',
      sensorIdB: 'accel-1',
    })
    // **前の購読を畳んでから開く。** 畳まずに開くと同時購読が 2 本になる。
    expect(before?.aborted).toBe(true)
    expect(captured?.signal.aborted).toBe(false)
  })

  it('正: 選んだ直後は「まだ届いていない」と伝え、届いたら件数へ変わる', async () => {
    const container = await mount()
    const select = container.querySelector<HTMLSelectElement>('.wave-diff')!
    select.value = select.options[1].value
    select.dispatchEvent(new Event('change'))

    // **黙らない。** 設定が変わって組が無くなった場合の症状は 1 件も届かないことだけ。
    expect(container.querySelector('.wave-diff-note')?.textContent).toContain('まだ 1 件も届いていない')

    captured?.onPairDiff?.(pairChunk())

    expect(container.querySelector('.wave-diff-note')?.textContent).toContain('1 まとまり')
  })

  it('対照: 選ばなければ添え書きは出さず、差分も頼まない', async () => {
    const container = await mount()

    expect(container.querySelector('.wave-diff-note')?.textContent).toBe('')
    expect(captured?.diff).toBeNull()
  })

  it('安全弁: 届いた差分は先着枠を使わず必ず描く', async () => {
    const container = await mount()
    const select = container.querySelector<HTMLSelectElement>('.wave-diff')!
    select.value = select.options[1].value
    select.dispatchEvent(new Event('change'))
    captured?.onPairDiff?.(pairChunk())
    await letItDraw()

    // **選んだのは運用者。** 枠に埋もれて見えないと選んだ意味が無い。
    const names = [...container.querySelectorAll('.wave-sensor')].map((el) => el.textContent ?? '')
    const row = names.find((n) => n.includes('差分'))
    expect(row).toBeDefined()
    expect(container.querySelector<HTMLInputElement>('.wave-sensor-check[data-key^="d:"]')?.checked).toBe(true)
  })

  it('波形が届いていないうちは、そう伝える', async () => {
    const container = await mount()
    await letItDraw()

    expect(container.querySelector('.wave-received')?.textContent).toContain('まだ波形が届いていない')
  })

  it('届いた波形を線で描く', async () => {
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()

    expect(container.querySelector('.wave-received')?.textContent).toContain('溜まっている範囲')
    // 枠と中心線だけでなく、波形の線が引かれている。
    expect(context?.calls.filter((c) => c.startsWith('lineTo')).length ?? 0).toBeGreaterThan(3)
    expect(context?.calls).toContain('clearRect(4)')
  })

  it('正: 2 軸のセンサーは自分の段に、測る向きの凡例つきで描く（2026-10-09 ユーザー承認の形）', async () => {
    const container = await mount()
    const axis = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 2)
    captured?.onWave?.(
      chunk({ gal: [axis, axis], directions: [[0.866, 0.5, 0], [-0.5, 0.866, 0]], axisNames: ['HN1', 'HN2'] }),
    )
    await letItDraw()

    const own = container.querySelectorAll('.wave-own')
    expect(own).toHaveLength(1)
    expect(own[0]?.querySelector('h3')?.textContent).toContain('（2 軸・測る向きのまま）')
    const legend = own[0]?.querySelector('.wave-own-legend')?.textContent ?? ''
    expect(legend).toContain('HN1 の向き: 東 +0.87・北 +0.50・上 0.00')
    expect(legend).toContain('HN2 の向き: 東 -0.50・北 +0.87・上 0.00')
    expect(own[0]?.querySelector('.wave-own-range')?.textContent).toMatch(/^±.+ gal$/)
  })

  it('正: 組からずれへ・ずれから組へ選び直すと、頼むものが入れ替わり、届いた件数は数え直す', async () => {
    // **1 つの選択欄に組とずれが並ぶ。** 選べるのはどちらか 1 つで、前のものは頼み直しで外す。
    const container = await mount(
      statusJson({
        stationIntensities: [
          {
            stationId: 'station-1',
            pairDiffs: [
              {
                a: { boardKey: 'board-1', sensorId: 'accel-0' },
                b: { boardKey: 'board-2', sensorId: 'accel-1' },
                rmsGal: [0.1, 0.1, 0.2],
                sampleCount: [30, 30, 30],
              },
            ],
            residuals: [{ member: { boardKey: 'board-3', sensorId: 'i2c0-6a' }, channels: ['HN1', 'HN2'], axes: [] }],
          },
        ],
      }),
    )
    const select = container.querySelector<HTMLSelectElement>('.wave-diff')!
    expect(select.options).toHaveLength(3)

    select.value = select.options[1]!.value
    select.dispatchEvent(new Event('change'))
    expect(captured?.diff).not.toBeNull()
    expect(captured?.residual).toBeNull()
    captured?.onPairDiff?.(pairChunk())
    expect(container.querySelector('.wave-diff-note')?.textContent).toContain('1 まとまり')

    select.value = select.options[2]!.value
    select.dispatchEvent(new Event('change'))
    expect(captured?.diff).toBeNull()
    expect(captured?.residual).toEqual({ stationId: 'station-1', boardKey: 'board-3', sensorId: 'i2c0-6a' })
    // **数え直す。** 前の組の件数を引き継ぐと、ずれが届いていないのに「受け取っている」と出る。
    expect(container.querySelector('.wave-diff-note')?.textContent).toBe(
      'このセンサーのずれはまだ 1 件も届いていない（合成が作っていないか、設定が変わった可能性）',
    )

    select.value = select.options[1]!.value
    select.dispatchEvent(new Event('change'))
    expect(captured?.residual).toBeNull()
    expect(captured?.diff).not.toBeNull()
  })

  it('正: ずれを選ぶと 1 台を頼み直し、届いたずれを測る向きのまま自分の段に描く（2026-10-09 ユーザー承認の文言）', async () => {
    const container = await mount(
      statusJson({
        stationIntensities: [
          {
            stationId: 'station-1',
            pairDiffs: [],
            residuals: [{ member: { boardKey: 'board-3', sensorId: 'i2c0-6a' }, channels: ['HN1', 'HN2'], axes: [] }],
          },
        ],
      }),
    )
    const select = container.querySelector<HTMLSelectElement>('.wave-diff')!
    const labels = [...select.options].map((o) => o.textContent)
    expect(labels).toContain('board-3 / i2c0-6a − ほかのセンサーの合成（ずれ）')

    select.value = select.options[1]!.value
    select.dispatchEvent(new Event('change'))
    expect(captured?.residual).toEqual({ stationId: 'station-1', boardKey: 'board-3', sensorId: 'i2c0-6a' })
    expect(captured?.diff).toBeNull()
    expect(container.querySelector('.wave-diff-note')?.textContent).toBe(
      'このセンサーのずれはまだ 1 件も届いていない（合成が作っていないか、設定が変わった可能性）',
    )

    const axis = Array.from({ length: 30 }, (_, i) => (i === 29 ? Number.NaN : Math.sin(i) * 0.05))
    captured?.onResidual?.(
      chunk({
        source: { kind: 'residual', stationId: 'station-1', boardKey: 'board-3', sensorId: 'i2c0-6a' },
        streamKey: null,
        segmentId: null,
        gal: [axis, axis],
        directions: [
          [0.866, 0.5, 0],
          [0, 0, 1],
        ],
        axisNames: ['HN1', 'HN2'],
      }),
    )
    await letItDraw()

    const own = container.querySelectorAll('.wave-own')
    expect(own).toHaveLength(1)
    expect(own[0]?.querySelector('h3')?.textContent).toBe('board-3 / i2c0-6a（ずれ・測る向きのまま）')
    expect(own[0]?.querySelector('.wave-own-legend')?.textContent).toContain('HN1 の向き: 東 +0.87・北 +0.50・上 0.00')
    expect(container.querySelector('.wave-diff-note')?.textContent).toBe('このセンサーのずれを 1 まとまり受け取っている')

    // 「選ばない」へ戻すと頼み直し、ずれの段は消える。
    select.value = ''
    select.dispatchEvent(new Event('change'))
    await letItDraw()
    expect(captured?.residual).toBeNull()
    expect(container.querySelectorAll('.wave-own')).toHaveLength(0)
  })

  it('対照: 3 軸（東・北・上）のセンサーだけなら、2 軸の段は出さない', async () => {
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()
    expect(container.querySelectorAll('.wave-own')).toHaveLength(0)
  })

  it('安全弁: 基板が名乗る軸の名前は HTML として解釈しない', async () => {
    const container = await mount()
    const axis = Array.from({ length: 30 }, () => 1)
    captured?.onWave?.(
      chunk({ gal: [axis, axis], directions: [[1, 0, 0], [0, 1, 0]], axisNames: ['<img src=x>', 'HN2'] }),
    )
    await letItDraw()
    expect(container.querySelector('.wave-own-legend img')).toBeNull()
    expect(container.querySelector('.wave-own-legend')?.textContent).toContain('<img src=x> の向き')
  })

  it('溜まりが窓より短くても、最新を右端に置く（安全弁）', async () => {
    // **右端を先へ出すと波形が左端へ貼り付き、止まっているように見える。**
    // 開いた直後は必ずこの形になるので、いちばん最初に目に入る不具合になる
    // （実機を繋いで気づいた）。
    const container = await mount()
    captured?.onWave?.(chunk()) // 0.3 秒ぶんだけ。既定の窓は 30 秒。
    await letItDraw()

    const text = container.querySelector('.wave-received')?.textContent ?? ''
    const shown = /表示中: (\d\d:\d\d:\d\d) 〜 (\d\d:\d\d:\d\d)/.exec(text)
    const stored = /溜まっている範囲: (\d\d:\d\d:\d\d) 〜 (\d\d:\d\d:\d\d)/.exec(text)
    expect(shown).not.toBeNull()
    expect(stored).not.toBeNull()
    // 右端どうしが一致する（窓の左端は溜まりより古くてよい）。
    expect(shown?.[2]).toBe(stored?.[2])
  })

  it('いま見ている範囲と、溜まっている範囲の両方を出す', async () => {
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()

    const text = container.querySelector('.wave-received')?.textContent ?? ''
    expect(text).toContain('表示中')
    expect(text).toContain('溜まっている範囲')
  })

  it('ホイールで見る幅が段ごとに動き、一覧の表示と食い違わない', async () => {
    // **連続に変えると一覧の値と食い違う。** 1 段ぶんに届かないホイールでは
    // 「効いていない」ようにしか見えない（ブラウザでの確認で気づいた）。
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()
    const span = container.querySelector<HTMLSelectElement>('.wave-span')
    const canvas = container.querySelector<HTMLCanvasElement>('.wave-canvas')
    expect(span?.value).toBe('30000')

    canvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
    expect(span?.value).toBe('15000')

    canvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))
    canvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))
    expect(span?.value).toBe('60000')
  })

  it('ホイールは幅の上限・下限で止まる（安全弁）', async () => {
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()
    const span = container.querySelector<HTMLSelectElement>('.wave-span')
    const canvas = container.querySelector<HTMLCanvasElement>('.wave-canvas')

    for (let i = 0; i < 10; i++) {
      canvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
    }
    expect(span?.value).toBe('5000')

    for (let i = 0; i < 20; i++) {
      canvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))
    }
    expect(span?.value).toBe('300000')
  })

  it('ホイールで幅を変えると追従を止める', async () => {
    // **掴んだ位置を保つため。** 追従したままだと、拡大した瞬間に右端へ飛ぶ。
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()
    const follow = container.querySelector<HTMLInputElement>('.wave-follow')
    expect(follow?.checked).toBe(true)

    container
      .querySelector<HTMLCanvasElement>('.wave-canvas')
      ?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))

    expect(follow?.checked).toBe(false)
  })

  it('1 本だけ表示しているときは、縦の幅と中心の値を出す', async () => {
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()

    const labels = [...container.querySelectorAll('.wave-axis-range')].map((el) => el.textContent ?? '')
    expect(labels).toHaveLength(3)
    for (const label of labels) expect(label).toMatch(/^中心 [-\d.]+ gal ／ ±[\d.]+ gal$/)
  })

  it('複数を重ねているときは中心の数値を並べない', async () => {
    // **9 本の実機で潰れた。** センサーごとに中心が違うので、重ねた本数ぶん
    // 数字が並ぶ —— 読めないだけでなく、絵の左上を塞ぐ。
    const container = await mount()
    captured?.onWave?.(chunk())
    captured?.onWave?.(chunk({ boardKey: 'board-2', streamKey: 'board-2/accel-0/boot-1' }))
    await letItDraw()

    const label = container.querySelector('.wave-axis-range')?.textContent ?? ''
    expect(label).toContain('中心は各センサーの平均')
    expect(label).not.toMatch(/中心 [-\d.]+ gal/)
  })

  it('開いた直後に重ねるのは上限までで、残りは印を外して並べる（安全弁）', async () => {
    // **実機は 9 本。全部重ねると真っ黒な塊になって 1 本も読めない**
    // （2 本の偽データでは起きず、実機へ繋いで初めて分かった）。
    const container = await mount()
    for (let i = 0; i < 6; i++) {
      captured?.onWave?.(chunk({ sensorId: `accel-${i}`, streamKey: `board-1/accel-${i}/boot-1` }))
    }
    await letItDraw()

    const checks = [...container.querySelectorAll<HTMLInputElement>('.wave-sensor-check')]
    expect(checks).toHaveLength(6)
    expect(checks.filter((c) => c.checked)).toHaveLength(3)
  })

  it('正: 観測点の合成は「観測点名（合成）」で並び、混ざった本数を添える（#315）', async () => {
    const container = await mount()
    captured?.onStationWave?.(stationChunk())
    await letItDraw()

    const text = container.querySelector('.wave-sensor')?.textContent ?? ''
    expect(text).toContain('自宅（合成）')
    expect(text).toContain('9 本')
  })

  it('正: 合成は先着枠を使わず、センサーが埋まっていても既定で表示に入る', async () => {
    // **この画面で合成を見る目的は「平均した 1 本が単体より静かか」の確認**（#362）。
    // センサー 9 本の先着枠に埋もれて既定で非表示だと、開いた意味が無い。
    const container = await mount()
    for (let i = 0; i < 6; i++) {
      captured?.onWave?.(chunk({ sensorId: `accel-${i}`, streamKey: `board-1/accel-${i}/boot-1` }))
    }
    captured?.onStationWave?.(stationChunk())
    await letItDraw()

    const checks = [...container.querySelectorAll<HTMLInputElement>('.wave-sensor-check')]
    expect(checks).toHaveLength(7)
    // センサーは上限の 3 本まで、合成はそれと別に 1 本。
    expect(checks.filter((c) => c.checked)).toHaveLength(4)
    expect(checks.find((c) => c.dataset.key === 't:station-1')?.checked).toBe(true)
  })

  it('安全弁: 混ざった本数が揺れていたら、幅で出す（#362 の症状）', async () => {
    const container = await mount()
    captured?.onStationWave?.(stationChunk({ memberCount: [1, 4, 7] }))
    await letItDraw()

    expect(container.querySelector('.wave-sensor')?.textContent).toContain('1〜7 本')
  })

  it('canvas の 2D 文脈が取れない環境でも落ちない（安全弁）', async () => {
    // **文脈の数が上限に達した端末では null が返りうる。** そこで投げると画面ごと止まる。
    context = null
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()

    // 描き直しが走った印として、溜まっている範囲が出ている。
    expect(container.querySelector('.wave-received')?.textContent).toContain('溜まっている範囲')
  })

  it('初めて届いたセンサーは既定で表示に入る', async () => {
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()

    const check = container.querySelector<HTMLInputElement>('.wave-sensor-check')
    expect(check).not.toBeNull()
    expect(check?.checked).toBe(true)
  })

  it('観測点を割り当てていれば、その名前で並べる', async () => {
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()

    expect(container.querySelector('.wave-sensors')?.textContent).toContain('自宅')
  })

  it('観測点が未割当なら基板とセンサーの名前で並べる', async () => {
    const container = await mount(statusJson({ sensors: [] }))
    captured?.onWave?.(chunk())
    await letItDraw()

    expect(container.querySelector('.wave-sensors')?.textContent).toContain('board-1 / accel-0')
  })

  it('読めない波形が届いたら件数と、取るべき行動を出す', async () => {
    // **生の診断文字列は画面へ出さない。** 他の警告は必ず行動で締めているのに、
    // これだけ `SyntaxError` の文言が末尾に付くだけでは、運用者に次の一手が無い
    // （理由はコンソールへ出す）。
    const container = await mount()
    captured?.onUnreadable?.(3, 'wave: 形が合わない')
    await letItDraw()

    const warn = container.querySelector('.wave-warn')?.textContent ?? ''
    expect(warn).toContain('3 件')
    expect(warn).toContain('開発者へ伝えること')
    expect(warn).not.toContain('形が合わない')
  })

  it('繋げないとき、枠が埋まっているならそう言い当てる', async () => {
    // **`EventSource` は 503 の本文を読ませない**（`waveStream.ts`）。
    // 理由は `/status` の押し出しの枠から引く。
    const container = await mount(statusJson({ stream: { subscribers: [1, 2, 3, 4, 5, 6, 7, 8], limit: 8 } }))
    captured?.onState('closed')
    await letItDraw()

    expect(container.querySelector('.wave-warn')?.textContent).toContain('枠が埋まっている')
  })

  it('繋げないが枠に空きがあるなら、ホスト側を疑う文にする（対照）', async () => {
    const container = await mount()
    captured?.onState('closed')
    await letItDraw()

    const warn = container.querySelector('.wave-warn')?.textContent ?? ''
    expect(warn).toContain('繋げない')
    expect(warn).not.toContain('枠が埋まっている')
  })

  it('時刻の当てはめが倒れた区間が窓にあれば、そう出す', async () => {
    const container = await mount()
    captured?.onWave?.(chunk({ timebaseNominalReason: 'too-few-points' }))
    await letItDraw()

    expect(container.querySelector('.wave-warn')?.textContent).toContain('時刻の当てはめ')
  })

  it('機材の名前が取れなくても、波形の表示は続ける', async () => {
    // **波形は別の口から来る。** `/status` の失敗で画面ごと止める理由が無い。
    const container = await mount(new Error('offline'))
    captured?.onWave?.(chunk())
    await letItDraw()

    expect(container.querySelector('.wave-error')?.textContent).toContain('offline')
    expect(container.querySelector('.wave-received')?.textContent).toContain('溜まっている範囲')
  })

  it('手で印を外した後に新しいセンサーが届いても、自動で埋め直さない（安全弁）', async () => {
    // **`shown` の大きさで数えると埋め直してしまう。** 絞り込んでいる最中に、
    // まさに読めなくなる形（9 本重ね）へ戻される。
    const container = await mount()
    for (let i = 0; i < 3; i++) {
      captured?.onWave?.(chunk({ sensorId: `accel-${i}`, streamKey: `board-1/accel-${i}/boot-1` }))
    }
    await letItDraw()

    const checks = [...container.querySelectorAll<HTMLInputElement>('.wave-sensor-check')]
    expect(checks.filter((c) => c.checked)).toHaveLength(3)
    for (const c of checks.slice(1)) {
      c.checked = false
      c.dispatchEvent(new Event('change', { bubbles: true }))
    }

    captured?.onWave?.(chunk({ sensorId: 'accel-9', streamKey: 'board-1/accel-9/boot-1' }))
    await letItDraw()

    const after = [...container.querySelectorAll<HTMLInputElement>('.wave-sensor-check')]
    expect(after).toHaveLength(4)
    expect(after.filter((c) => c.checked)).toHaveLength(1)
  })

  it('溜めた分を捨てたら画面に出す', async () => {
    const container = await mount()
    captured?.onWave?.(chunk({ firstSampleMs: 1_700_000_060_000 }))
    captured?.onWave?.(chunk({ firstSampleMs: 1_700_000_000_000 })) // 時刻が巻き戻る
    await letItDraw()

    expect(container.querySelector('.wave-warn')?.textContent).toContain('時刻が巻き戻った')
  })

  it('描き直しが例外を投げても輪を止めず、画面に出す（安全弁）', async () => {
    // **囲わないと次の登録へ届かず、以後二度と描き直さない。** しかも見出しは
    // 別の間隔で更新され続けるので「文字は生きているのに絵だけ凍る」形になる。
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()
    if (context !== null) {
      context.clearRect = () => {
        throw new Error('壊れた文脈')
      }
    }

    captured?.onWave?.(chunk({ firstSampleMs: 1_700_000_000_300 }))
    await letItDraw()
    expect(container.querySelector('.wave-error')?.textContent).toContain('壊れた文脈')

    // **輪は続いている。** 直れば描き直せる。
    const calls: string[] = []
    if (context !== null) {
      context.clearRect = (...args: unknown[]) => {
        calls.push(`clearRect(${args.length})`)
      }
    }
    captured?.onWave?.(chunk({ firstSampleMs: 1_700_000_000_600 }))
    await letItDraw()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('機材の名前を引けていないセンサーへ「向き未設定」と言い切らない（安全弁）', async () => {
    // **「引けなかった」と「未設定」は別。** 校正済みのセンサーを未設定だと
    // 誤って伝えることになる（隣の受信バッジは同じとき何も言わない）。
    const container = await mount(statusJson({ sensors: [] }))
    captured?.onWave?.(chunk())
    await letItDraw()

    expect(container.querySelector('.wave-sensors')?.textContent).not.toContain('向き未設定')
  })

  it('校正を設定していないと分かっているセンサーには出す（対照）', async () => {
    const container = await mount(
      statusJson({
        sensors: [
          {
            boardKey: 'board-1',
            sensorId: 'accel-0',
            lastPacketMs: 1_700_000_000_000,
            calibrationConfigured: false,
            station: { stationId: 'station-1', displayName: '自宅' },
          },
        ],
      }),
    )
    captured?.onWave?.(chunk())
    await letItDraw()

    expect(container.querySelector('.wave-sensors')?.textContent).toContain('向き未設定')
  })

  it('打ち切られたら描き直しをやめる（安全弁）', async () => {
    // **タブを離れても回り続けると、見ていない画面のために毎秒描き続ける。**
    const container = await mount()
    captured?.onWave?.(chunk())
    await letItDraw()
    const before = container.querySelector('.wave-received')?.textContent ?? ''

    controller.abort()
    captured?.onWave?.(chunk({ firstSampleMs: 1_700_000_060_000 }))
    await letItDraw()

    expect(container.querySelector('.wave-received')?.textContent).toBe(before)
  })
})
