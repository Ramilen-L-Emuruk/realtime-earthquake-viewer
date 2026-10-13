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
const LOCAL_ID = `station-1-${T0 + 60_000}`

/** `/status`・`/events`・`/waves` を固定値で返す。`/events`・`/waves` の URL は控えておく。 */
function stubHost(
  eventsUrls: string[],
  options: { readonly ignoreHide?: boolean; readonly wavesUrls?: string[]; readonly eventsFail?: boolean } = {},
): void {
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
        const events = [
          wire(QUAKE_ID),
          ...(hide ? [] : [wire(LOCAL_ID, { startMs: T0 + 60_000, endMs: T0 + 70_000, verdict: 'local-like' })]),
        ]
        return { ok: true, status: 200, json: async () => ({ events, unreadableFiles: [], truncated: false, coveredFromMs: 0 }) }
      }
      // 区間の波形は取れなくてよい（開いたかどうかだけを見る）。
      if (url.startsWith('/waves?')) {
        options.wavesUrls?.push(url)
        return { ok: false, status: 503, json: async () => ({}) }
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
