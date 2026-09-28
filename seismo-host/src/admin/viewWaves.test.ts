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
        station: { displayName: '自宅' },
      },
    ],
    stream: { subscribers: [{ id: 1 }], limit: 8 },
    ...overrides,
  }
}

function chunk(overrides: Partial<WaveChunkView> = {}): WaveChunkView {
  const axis = Array.from({ length: 30 }, (_, i) => 980 + Math.sin(i) * 2)
  return {
    boardKey: 'board-1',
    sensorId: 'accel-0',
    streamKey: 'board-1/accel-0/boot-1',
    segmentId: 1,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    timebaseNominalReason: null,
    gal: [axis, axis, axis],
    ...overrides,
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

  it('押し出しへ繋ぎ、波形を欲しがる', async () => {
    await mount()

    expect(captured?.wave).toBe(true)
    expect(captured?.signal).toBe(controller.signal)
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
            station: { displayName: '自宅' },
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
