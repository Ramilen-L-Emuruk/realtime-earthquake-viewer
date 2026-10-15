// @vitest-environment jsdom
//
// **揺れの記録タブのうち、リロード・タブ移動で状態を保つ振る舞い**（2026-10-10・10-11 ユーザー承認）。
// 開いていた記録は一覧を読み終えてから開き直し、いま見えている範囲に無ければ閉じた形にする。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initShakesView } from './viewShakes'
import { memoryTabContext } from './tabState'

vi.mock('./waveStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./waveStream')>()
  return { ...actual, openWaveStream: () => {} }
})

// 2026-10-06 13:26:04 JST。ホストの時計はその 1 時間後（直近 7 日に入る）。
const T0 = Date.UTC(2026, 9, 6, 4, 26, 4)
const HOST_NOW = T0 + 3_600_000

/** ホストが書く記録の形（`detection/shakeEvent.ts` の `ShakeEventRecord`）。値は架空。 */
function wire(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    rev: 1,
    writtenAtMs: T0 + 30_000,
    stationId: 'station-1',
    // ホストが送るときに添える札（`statusServer.ts` の `wireShakeEvent`）。
    stationKey: 'station-1-0123456789ab',
    detectorVersion: 1,
    startMs: T0,
    endMs: T0 + 12_300,
    endReason: 'quiet',
    sMs: null,
    sSnr: null,
    pMs: null,
    pSnr: null,
    sMinusPSec: null,
    phaseWindow: 'picked',
    peakAccelGal: 3.456,
    peakHorizontalGal: 3.1,
    maxIntensity: 1.24,
    peakRatio: 5.31,
    baselineGal: 0.16,
    verticalRatio: 0.4,
    bandRatios: [1, 2, 3],
    shakeClass: 'quake-like',
    sensors: [],
    spatialConsistency: 'not-evaluated',
    verdict: 'pending',
    matchedQuake: null,
    ...overrides,
  }
}

const QUAKE_ID = `station-1-${T0}`

/** 照合した地震（ホストの地震情報のまま。分の頭・幅 60 秒）。値は架空。 */
const MATCHED = {
  name: '千葉県北西部',
  originMs: T0 - 64_000,
  originPrecisionMs: 60_000,
  lat: 35.7,
  lon: 140.1,
  magnitude: 4.2,
  depthKm: 50,
  maxScale: 30,
  distanceKm: 60,
}

/** `/api/records/quakes` の応答。発生時刻は震源リストで秒まで寄せてある。 */
function quakesBody(quakes: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { off: false, located: true, quakes, failedDays: [], problem: null, refineFailedDays: { hypocenter: [], eew: [] }, ...extra }
}
const JMA_QUAKE = {
  name: '千葉県北西部',
  originMs: T0 - 15_000,
  originPrecisionMs: 100,
  magnitude: 4.2,
  maxScale: 30,
  distanceKm: 60,
  p: { fromMs: T0 - 5_000, toMs: T0 - 5_000 },
  s: { fromMs: T0 + 2_000, toMs: T0 + 2_000 },
}
const LOCAL_ID = `station-1-${T0 + 60_000}`

/** `/status`・`/events`・`/waves` を固定値で返す。`/events`・`/waves` の URL は控えておく。 */
function stubHost(
  eventsUrls: string[],
  options: {
    readonly ignoreHide?: boolean
    readonly wavesUrls?: string[]
    readonly eventsFail?: boolean
    /** 記録を照合済み（`matchedQuake` つき）で返す。 */
    readonly matched?: boolean
    /** `/api/records/quakes` の応答（`'fail'` なら 503）。省けばその口は叩かれない前提（叩かれたら投げる）。 */
    readonly quakes?: unknown
    readonly quakesUrls?: string[]
    /** `/api/records/quakes` の返事を返さずに止めておく（遅い地震一覧）。 */
    readonly quakesHang?: boolean
    /** この回数目（0 から）以降の `/events` を照合済みで返す（照合が後から済む記録）。 */
    readonly matchedFromEventsCall?: number
    /** `/waves` の返事をこの約束が解けるまで待たせる。 */
    readonly wavesGate?: Promise<void>
  } = {},
): void {
  let eventsCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: unknown) => {
      const url = String(path)
      if (url === '/status') {
        return { ok: true, status: 200, json: async () => ({ generatedAtMs: HOST_NOW, stations: [] }) }
      }
      if (url.startsWith('/events?')) {
        eventsUrls.push(url)
        if (options.eventsFail === true) return { ok: false, status: 503, json: async () => ({}) }
        const hide = url.includes('hide=local') && options.ignoreHide !== true
        const call = eventsCalls++
        const matched =
          options.matched === true || (options.matchedFromEventsCall !== undefined && call >= options.matchedFromEventsCall)
        const events = [
          wire(QUAKE_ID, matched ? { rev: 1 + call, verdict: 'quake', matchedQuake: MATCHED } : {}),
          ...(hide ? [] : [wire(LOCAL_ID, { startMs: T0 + 60_000, endMs: T0 + 70_000, verdict: 'local-like' })]),
        ]
        return { ok: true, status: 200, json: async () => ({ events, unreadableFiles: [], truncated: false, coveredFromMs: 0 }) }
      }
      // 区間の波形は取れなくてよい（開いたかどうかだけを見る）。
      if (url.startsWith('/waves?')) {
        options.wavesUrls?.push(url)
        if (options.wavesGate !== undefined) await options.wavesGate
        return { ok: false, status: 503, json: async () => ({}) }
      }
      if (url.startsWith('/api/records/quakes?') && options.quakes !== undefined) {
        options.quakesUrls?.push(url)
        if (options.quakesHang === true) return new Promise(() => {})
        if (options.quakes === 'fail') return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => options.quakes }
      }
      throw new Error(`unexpected fetch path: ${url}`)
    }),
  )
}

describe('揺れの記録タブの状態を保つ', () => {
  let eventsUrls: string[]
  let controller: AbortController
  beforeEach(() => {
    eventsUrls = []
    controller = new AbortController()
    stubHost(eventsUrls)
  })
  afterEach(() => {
    // 30 秒ごとの読み直しを止める。
    controller.abort()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const detailOpen = (c: HTMLElement): boolean => c.querySelector<HTMLElement>('.shake-detail')?.hidden === false

  it('正: 開いていた記録を、一覧を読み終えてから開き直す', async () => {
    const ctx = memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    expect(detailOpen(container)).toBe(true)
    expect(container.querySelector('tr.shake-row.selected')?.getAttribute('data-shake-id')).toBe(QUAKE_ID)
    expect(ctx.selection.get('shake')).toBe(QUAKE_ID)
  })

  it('対照: 一覧に無い記録は開かず、選択からも外す', async () => {
    const ctx = memoryTabContext(controller.signal, 'shakes', { selection: { shake: 'station-1-0' } })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    expect(detailOpen(container)).toBe(false)
    expect(ctx.selection.get('shake')).toBeNull()
  })

  // **読んではいるが見せていない記録を開かない。** 隠した行の下に詳細の欄は付けられない。
  // ホストが隠す指定を無視して返しても、画面の側で隠れるなら開かず、区間の波形も取りに行かない
  // （開いてから一覧の描き直しで閉じる形だと、見えない記録の波形を 1 回取りに行く）。
  it('安全弁: 「生活振動らしいものを隠す」で隠れる記録は開かない', async () => {
    const wavesUrls: string[] = []
    stubHost(eventsUrls, { ignoreHide: true, wavesUrls })
    const ctx = memoryTabContext(controller.signal, 'shakes', {
      selection: { shake: LOCAL_ID },
      prefs: { period: { kind: 'days', days: 7 }, hideLocal: true },
    })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    expect(detailOpen(container)).toBe(false)
    expect(ctx.selection.get('shake')).toBeNull()
    expect(wavesUrls).toEqual([])
  })

  // **読めていない空の一覧で「一覧に無い」と決めない。** 通信の途切れだけで選択を消す。
  it('一覧を取れなかったときは、覚えていた選択に触らない', async () => {
    stubHost(eventsUrls, { eventsFail: true })
    const ctx = memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    expect(detailOpen(container)).toBe(false)
    expect(ctx.selection.get('shake')).toBe(QUAKE_ID)
  })

  it('行を押すと選択に載り、もう一度押すと外れる', async () => {
    const ctx = memoryTabContext(controller.signal, 'shakes')
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    const row = (): HTMLElement | null => container.querySelector<HTMLElement>(`tr.shake-row[data-shake-id="${QUAKE_ID}"]`)
    row()?.click()
    expect(ctx.selection.get('shake')).toBe(QUAKE_ID)
    row()?.click()
    expect(ctx.selection.get('shake')).toBeNull()
  })

  it('覚えていた日数の期間と「隠す」を、ボタン・欄・問い合わせへ映す', async () => {
    const ctx = memoryTabContext(controller.signal, 'shakes', {
      prefs: { period: { kind: 'days', days: 30 }, hideLocal: true },
    })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    const pressed = [...container.querySelectorAll('.period-buttons button[aria-pressed="true"]')].map((b) => b.textContent)
    expect(pressed).toEqual(['30 日'])
    expect(container.querySelector<HTMLInputElement>('.shake-hide-local')?.checked).toBe(true)
    expect(eventsUrls[0]).toContain('hide=local')
  })

  it('覚えていた日付の期間は、どのボタンも押さずに日付の欄へ戻す（終わりの日は 1 ミリ秒手前）', async () => {
    // 2026-10-01 0 時〜10-08 0 時（JST）= 10/01〜10/07 の 7 日間。
    const fromMs = Date.UTC(2026, 8, 30, 15)
    const toMs = Date.UTC(2026, 9, 7, 15)
    const ctx = memoryTabContext(controller.signal, 'shakes', {
      prefs: { period: { kind: 'dates', fromMs, toMs }, hideLocal: false },
    })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    expect(container.querySelectorAll('.period-buttons button[aria-pressed="true"]')).toHaveLength(0)
    expect(container.querySelector<HTMLInputElement>('.shake-from')?.value).toBe('2026-10-01')
    expect(container.querySelector<HTMLInputElement>('.shake-to')?.value).toBe('2026-10-07')
    expect(eventsUrls[0]).toContain(`from=${fromMs}&to=${toMs}`)
  })

  it('期間のボタンと「隠す」を変えると、表示の好みへ書く', async () => {
    const ctx = memoryTabContext(controller.signal, 'shakes')
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    container.querySelector<HTMLButtonElement>('.period-buttons button[data-days="90"]')?.click()
    const hide = container.querySelector<HTMLInputElement>('.shake-hide-local')
    if (hide === null) throw new Error('隠す指定の欄が無い')
    hide.checked = true
    hide.dispatchEvent(new Event('change'))
    expect(ctx.prefs.load()).toEqual({ period: { kind: 'days', days: 90 }, hideLocal: true })
  })
})

// **照合した地震の気象庁の P・S と、波形の記録へ移る口**（2026-10-15 ユーザー承認「進めて」・文言も同日承認）。
describe('揺れの記録の詳細 — 照合した地震と波形の記録', () => {
  let controller: AbortController
  beforeEach(() => {
    controller = new AbortController()
  })
  afterEach(() => {
    controller.abort()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const jmaNote = (c: HTMLElement): HTMLElement | null => c.querySelector<HTMLElement>('.shake-detail-jma')

  it('正: 照合した記録は、詳細の区間と観測点で地震一覧を取り、引けたら凡例を添える', async () => {
    const quakesUrls: string[] = []
    stubHost([], { matched: true, quakes: quakesBody([JMA_QUAKE]), quakesUrls })
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    await vi.waitFor(() => expect(jmaNote(container)?.textContent).toContain('気象庁: 破線'))
    expect(quakesUrls).toHaveLength(1)
    const q = new URLSearchParams(quakesUrls[0]!.split('?')[1])
    expect(q.get('station')).toBe('station-1')
    // 問い合わせは広げうる左端（始まりの 60 秒前）から。
    expect(q.get('from')).toBe(String(T0 - 60_000))
    expect(jmaNote(container)?.className).toContain('muted')
  })

  it('正: 気象庁 P が始まりの 10 秒前より前なら、既定の範囲で描いたあと、その P の 5 秒前から取り直す', async () => {
    const wavesUrls: string[] = []
    const early = { ...JMA_QUAKE, p: { fromMs: T0 - 20_000, toMs: T0 - 20_000 } }
    stubHost([], { matched: true, quakes: quakesBody([early]), wavesUrls })
    const ctx = memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    await vi.waitFor(() => expect(wavesUrls).toHaveLength(2))
    expect(new URLSearchParams(wavesUrls[0]!.split('?')[1]).get('from')).toBe(String(T0 - 10_000))
    expect(new URLSearchParams(wavesUrls[1]!.split('?')[1]).get('from')).toBe(String(T0 - 25_000))
    // 「波形の記録で開く」も広げた範囲で開く。
    container.querySelector<HTMLButtonElement>('.shake-detail-records')?.click()
    expect(ctx.opened[0]?.selection.from).toBe(String(T0 - 25_000))
  })

  it('安全弁: 地震一覧の返事が来なくても、波形は待たずに既定の範囲で取る', async () => {
    const wavesUrls: string[] = []
    stubHost([], { matched: true, quakes: quakesBody([JMA_QUAKE]), quakesHang: true, wavesUrls })
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    await vi.waitFor(() => expect(wavesUrls).toHaveLength(1))
    expect(new URLSearchParams(wavesUrls[0]!.split('?')[1]).get('from')).toBe(String(T0 - 10_000))
  })

  it('正: 照合待ちで開き、波形を取っている間に照合が済んだら、開き直して地震一覧を引く', async () => {
    const quakesUrls: string[] = []
    let release = (): void => {}
    const wavesGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const eventsUrls: string[] = []
    stubHost(eventsUrls, { matchedFromEventsCall: 1, quakes: quakesBody([JMA_QUAKE]), quakesUrls, wavesGate })
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    expect(quakesUrls).toHaveLength(0)
    // 波形の返事を待たせたまま、期間を選び直して一覧を読み直す（2 回目からは照合済みで返る）。
    container.querySelector<HTMLButtonElement>('.period-buttons button[data-days="30"]')?.click()
    await vi.waitFor(() => expect(eventsUrls.length).toBeGreaterThanOrEqual(2))
    release()
    await vi.waitFor(() => expect(quakesUrls).toHaveLength(1))
    await vi.waitFor(() => expect(jmaNote(container)?.textContent).toContain('気象庁: 破線'))
    // 安全弁: 開き直しは 1 回で止まる（照合済みの記録は地震一覧を引いた印を持つので、もう一度は開かない）。
    await new Promise((r) => setTimeout(r, 50))
    expect(quakesUrls).toHaveLength(1)
  })

  it('対照: 照合していない記録の波形は、これまでどおり始まりの 10 秒前から', async () => {
    const wavesUrls: string[] = []
    stubHost([], { wavesUrls })
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    await vi.waitFor(() => expect(wavesUrls).toHaveLength(1))
    expect(new URLSearchParams(wavesUrls[0]!.split('?')[1]).get('from')).toBe(String(T0 - 10_000))
  })

  it('対照: 照合していない記録は地震一覧を取らない（取れば投げる）', async () => {
    stubHost([])
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    expect(jmaNote(container)?.textContent).toBe('')
  })

  it('対照: 一覧に照合した地震が無ければ、そう書く', async () => {
    stubHost([], { matched: true, quakes: quakesBody([{ ...JMA_QUAKE, name: '茨城県南部' }]) })
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    await vi.waitFor(() =>
      expect(jmaNote(container)?.textContent).toBe('照合した地震が気象庁の地震一覧に見つからないので、気象庁の P・S の線は引けない'),
    )
  })

  it('対照: 観測点の位置が分からなければ、そう書く', async () => {
    stubHost([], { matched: true, quakes: quakesBody([], { located: false }) })
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    await vi.waitFor(() => expect(jmaNote(container)?.textContent).toBe('この観測点の位置が分からないので、気象庁の P・S の線は引けない'))
  })

  it('安全弁: 一覧を取れなければ注意の色で出し、波形の側は止めない', async () => {
    const wavesUrls: string[] = []
    stubHost([], { matched: true, quakes: 'fail', wavesUrls })
    const container = document.createElement('div')
    await initShakesView(container, memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } }))
    await vi.waitFor(() => expect(jmaNote(container)?.textContent).toContain('気象庁の地震一覧を取得できていない: '))
    expect(jmaNote(container)?.className).toContain('error')
    expect(wavesUrls).toHaveLength(1)
  })

  it('正: 「波形の記録で開く」で、同じ観測点・同じ範囲の波形の記録を開く', async () => {
    stubHost([])
    const ctx = memoryTabContext(controller.signal, 'shakes', { selection: { shake: QUAKE_ID } })
    const container = document.createElement('div')
    await initShakesView(container, ctx)
    const button = container.querySelector<HTMLButtonElement>('.shake-detail-records')
    expect(button?.textContent).toBe('波形の記録で開く')
    button?.click()
    expect(ctx.opened).toEqual([
      {
        key: 'records',
        selection: {
          from: String(T0 - 10_000),
          station: 'station-1',
          stationKey: 'station-1-0123456789ab',
          to: String(T0 + 12_300 + 20_000),
        },
      },
    ])
  })
})
