// @vitest-environment jsdom
//
// **`initRecordsView` の配線**（何を取りに行き、何を画面へ出すか）。jsdom には canvas の 2D 文脈が無いので
// 絵そのものは見られない —— 逆に「文脈が取れなくても落ちない」ことをここで固定する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TOKEN_STORAGE_KEY } from './api'
import { initRecordsView } from './viewRecords'

const H0 = new Date(2026, 9, 7, 12, 0, 0).getTime()
const HOUR = 3_600_000

function channel(id: string, kind: 'raw' | 'station', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind, unit: 'gal', firstHourMs: H0 - 2 * HOUR, lastHourMs: H0, hours: 3, sensor: null, board: null, station: null, ...extra }
}

const CHANNELS = {
  channels: [
    channel('station/home/X', 'station', { station: { stationId: 'home', displayName: '<自宅>' } }),
    channel('station/home/Y', 'station', { station: { stationId: 'home', displayName: '<自宅>' } }),
    channel('station/home/Z', 'station', { station: { stationId: 'home', displayName: '<自宅>' } }),
    channel('FDSN:XX_A1_S1_H_N_1', 'raw', { sensor: 'FDSN:XX_A1_S1', unit: 'count' }),
  ],
  unreadable: 1,
}

function envelope(): Record<string, unknown> {
  return {
    source: 'coarse',
    unit: 'gal',
    columnMs: 60_000,
    firstColumnMs: H0,
    n: [5],
    min: [-1],
    max: [1],
    mean: [0],
    std: [0.5],
    noiseStd: [0.5],
    hours: { ok: 1, stale: 0, pending: 2, failed: 0, absent: 0 },
    irregularHours: [{ hourStartMs: H0 - HOUR, state: 'pending' }],
    files: null,
    problems: { skippedBytes: 0, badRecords: 0, unscaledHours: 0 },
  }
}

let requested: string[] = []
let respond: (url: string) => { status: number; body: unknown }

beforeEach(() => {
  requested = []
  localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token')
  respond = (url) => {
    if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
    if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
    return { status: 404, body: { error: 'not-found' } }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      const r = respond(url)
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('initRecordsView', () => {
  it('トークンが無ければ何も取りに行かず、そう書く', async () => {
    localStorage.clear()
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    expect(requested).toEqual([])
    expect(root.querySelector('.records-list-note')!.textContent).toBe('管理トークンを設定すると読める')
  })

  it('一覧を記録に束ねて選ぶ欄へ並べ（名前はエスケープ）、1 本目の新しい側 1 時間を列で取りに行く', async () => {
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    await settle()
    const select = root.querySelector<HTMLSelectElement>('.records-group')!
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['観測点の合成波形', 'センサーの生データ'])
    expect(select.innerHTML).toContain('&lt;自宅&gt;')
    expect(root.querySelector('.records-list-note')!.textContent).toBe('読めない要約が 1 件あり、一覧から漏れているかもしれない')
    expect(root.querySelector('.records-period')!.textContent).toContain('（3 時間ぶん）')
    // 合成波形には単位の切り替えが無い
    expect(root.querySelector<HTMLElement>('.records-unit')!.hidden).toBe(true)
    const envelopes = requested.filter((u) => u.startsWith('/api/records/envelope'))
    const views = envelopes.filter((u) => u.includes(`from=${H0}`) && u.includes(`to=${H0 + HOUR}`))
    expect(views.map((u) => new URLSearchParams(u.split('?')[1]).get('channel'))).toEqual(['station/home/X', 'station/home/Y', 'station/home/Z'])
    // 範囲が 10 分を超えるので、合成と震度の段は文言だけ
    expect(root.textContent).toContain('合成は 10 分以内まで寄せると出る')
    expect(root.textContent).toContain('震度の推移は 10 分以内まで寄せると出る')
    // 要約の不調の行
    expect(root.querySelector('.records-note')!.textContent).toContain('要約がまだ無い時が 2')
  })

  it('10 分の幅を押すと、軸ごとの生のサンプルと震度の推移を取りに行く', async () => {
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
      if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
      if (url.startsWith('/api/records/samples'))
        return {
          status: 200,
          body: { unit: 'gal', runs: [{ firstSampleMs: H0 + 50 * 60_000, msPerSample: 10, origin: 'live', timeQuestionable: false, values: [1, -2, null] }], problems: { skippedBytes: 0, badRecords: 0, unscaledHours: 0 } },
        }
      if (url.startsWith('/api/records/intensity'))
        return { status: 200, body: { maxRealtime: 1.2, maxRealtimeAtMs: H0 + 55 * 60_000, measured: 0.8, realtimeSeries: [] } }
      return { status: 404, body: { error: 'not-found' } }
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const root = document.createElement('div')
      await initRecordsView(root, new AbortController().signal)
      await settle()
      requested = []
      root.querySelector<HTMLButtonElement>('button[data-span-index="5"]')!.click()
      await vi.advanceTimersByTimeAsync(200)
      await settle()
      expect(requested.filter((u) => u.startsWith('/api/records/samples'))).toHaveLength(3)
      const intensity = requested.find((u) => u.startsWith('/api/records/intensity'))!
      expect(new URLSearchParams(intensity.split('?')[1]).get('station')).toBe('home')
      expect(root.querySelector('.records-intensity-header')!.textContent).toMatch(/^最大 1\.2（\d\d:\d\d:\d\d） 計測 0\.8$/)
      expect(root.querySelector('.records-source')!.textContent).toBe('生のサンプルから描いている')
    } finally {
      vi.useRealTimers()
    }
  })

  it('取れなかったら理由を添えて書く', async () => {
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
      return { status: 400, body: { error: 'range-too-wide' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    await settle()
    expect(root.querySelector('.records-note')!.textContent).toContain('波形の記録を取得できていない（range-too-wide）')
  })

  it('軸の段は消せるが、最後の 1 本は消さない', async () => {
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    await settle()
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.records-axes button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['X 軸（東が ＋）', 'Y 軸（北が ＋）', 'Z 軸（上が ＋）'])
    buttons[0]!.click()
    buttons[1]!.click()
    buttons[2]!.click()
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
    expect(root.querySelectorAll('canvas.records-axis')).toHaveLength(1)
  })

  it('印の段: 合成波形は観測点 ID で気象庁の地震と揺れの記録を取り、受信は割り当てのセンサーぶんを重ねる', async () => {
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
      if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
      if (url.startsWith('/api/records/reception')) {
        return { status: 200, body: { sensors: [], unreadable: { items: [], truncated: false, cappedHours: 0 }, unreadableLogs: 0, hours: { ok: 0, stale: 0, pending: 3, failed: 0, absent: 0 } } }
      }
      if (url.startsWith('/api/records/quakes')) {
        return {
          status: 200,
          body: {
            off: false,
            located: true,
            quakes: [],
            failedDays: ['2026-10-06'],
            unreadable: 0,
            problem: 'P2PQuake: HTTP 503',
            refineFailedDays: { hypocenter: ['2026-10-05'], eew: [] },
          },
        }
      }
      if (url.startsWith('/events')) {
        return { status: 200, body: { events: [{ id: 'broken' }], truncated: true, coveredFromMs: H0, unreadableFiles: ['2026-10/x.json'] } }
      }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    await settle()
    const quakes = requested.find((u) => u.startsWith('/api/records/quakes'))!
    expect(new URLSearchParams(quakes.split('?')[1]).get('station')).toBe('home')
    const events = requested.find((u) => u.startsWith('/events'))!
    expect(new URLSearchParams(events.split('?')[1]).get('station')).toBe('home')
    expect(requested.some((u) => u.startsWith('/api/records/reception'))).toBe(true)
    const note = root.querySelector('.records-marks-note')!.textContent!
    expect(note).toContain('受信の帯は、いまこの観測点に割り当てている基板のもの')
    expect(note).toContain('受信の記録の要約がまだ無い時が 3（作り終えると出る）')
    expect(note).toContain('地震一覧を取れていない日がある（10/06。P2PQuake: HTTP 503）')
    expect(note).toContain('発生時刻を秒まで寄せる材料を取れていない日がある（震源リスト: 10/05）')
    expect(note).toContain('揺れの記録が多く、新しい 500 件だけ印を付けている')
    // 形の違う記録 1 件と、ホストが読めなかったファイル 1 本
    expect(note).toContain('読めなかった揺れの記録が 2 件ある')
    // 1 時間の範囲は 10 分を超えるので、波形の下の線の凡例は出さない
    expect(root.querySelector('.records-marks-legend')!.textContent).not.toContain('波形の下の線')
  })

  it('印の段: 割り当ての無いセンサーは揺れの記録を取らず、P・S を引けないと書く', async () => {
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
      if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
      if (url.startsWith('/api/records/reception')) {
        return { status: 200, body: { sensors: [], unreadable: { items: [], truncated: false, cappedHours: 0 }, unreadableLogs: 0, hours: { ok: 1, stale: 0, pending: 0, failed: 0, absent: 0 } } }
      }
      if (url.startsWith('/api/records/quakes')) {
        return {
          status: 200,
          body: { off: false, located: false, quakes: [], failedDays: [], unreadable: 0, problem: null, refineFailedDays: { hypocenter: [], eew: [] } },
        }
      }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    await settle()
    const select = root.querySelector<HTMLSelectElement>('.records-group')!
    select.value = 'FDSN:XX_A1_S1'
    requested = []
    select.dispatchEvent(new Event('change'))
    await settle()
    expect(requested.some((u) => u.startsWith('/events'))).toBe(false)
    const quakes = requested.find((u) => u.startsWith('/api/records/quakes'))!
    expect(new URLSearchParams(quakes.split('?')[1]).get('station')).toBeNull()
    expect(root.querySelector('.records-marks-note')!.textContent).toContain('このセンサーの基板は観測点に割り当てていないので、P・S の線は引けない')
  })

  it('周波数: 軸ごとにスペクトログラムと範囲のスペクトルを取り、見出しと色の物差しを書く', async () => {
    const problems = { skippedBytes: 0, badRecords: 0, unscaledHours: 0 }
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
      if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
      if (url.startsWith('/api/records/spectrogram')) {
        return {
          status: 200,
          body: {
            source: 'minutes',
            unit: 'gal',
            binEdgesHz: [0.1, 1, 10, 50],
            columnMs: 60_000,
            firstColumnMs: H0,
            segments: [11],
            power: [[1e-4, 1e-5, null]],
            hours: { ok: 1, stale: 0, pending: 0, failed: 0, absent: 0 },
            irregularHours: [],
            files: null,
            problems,
          },
        }
      }
      if (url.startsWith('/api/records/spectrum')) {
        return { status: 200, body: { source: 'minutes', unit: 'gal', binEdgesHz: [0.1, 1, 10, 50], power: [1e-4, 1e-5, null], segments: 660, problems } }
      }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    await settle()
    const grams = requested.filter((u) => u.startsWith('/api/records/spectrogram'))
    const spectra = requested.filter((u) => u.startsWith('/api/records/spectrum'))
    expect(grams.map((u) => new URLSearchParams(u.split('?')[1]).get('channel'))).toEqual(['station/home/X', 'station/home/Y', 'station/home/Z'])
    expect(spectra).toHaveLength(3)
    expect(root.querySelectorAll('canvas.records-spectrogram')).toHaveLength(3)
    expect(root.querySelector('.records-spectrogram-header')!.textContent).toBe('0.1〜50 Hz（縦は対数）・列の幅 1 分')
    // 1e-4・1e-5 gal²/Hz は −80・−90 dB（0 dB = 1 (m/s²)²/Hz）
    expect(root.querySelector('.records-db-scale')!.textContent).toBe('色: −90〜−80 dB（0 dB = 1 (m/s²)²/Hz）')
    expect(root.querySelector('.records-spectrum-header')!.textContent).toBe('約 10 秒の区間 660 本の平均（1 分ごとの PSD から）')
    expect(root.querySelector('.records-spectrum-legend')!.textContent).toContain('破線: Peterson の低ノイズ・高ノイズのモデル（NLNM・NHNM）')
    // ノイズの段は要約の noiseStd（0.5 gal）から
    expect(root.querySelector('.records-noise-header')!.textContent).toBe('1 秒より速い揺れの RMS（縦は対数）　0.50〜0.50 gal')
  })

  it('生データを選ぶと単位の切り替えが出て、生の値を選ぶと native で取り直す', async () => {
    const root = document.createElement('div')
    await initRecordsView(root, new AbortController().signal)
    await settle()
    const select = root.querySelector<HTMLSelectElement>('.records-group')!
    select.value = 'FDSN:XX_A1_S1'
    select.dispatchEvent(new Event('change'))
    await settle()
    expect(root.querySelector<HTMLElement>('.records-unit')!.hidden).toBe(false)
    expect(root.textContent).toContain('震度の推移は観測点の合成波形にだけ出る')
    requested = []
    root.querySelector<HTMLButtonElement>('button[data-unit="native"]')!.click()
    await settle()
    expect(requested.length).toBeGreaterThan(0)
    expect(requested.every((u) => u.includes('unit=native'))).toBe(true)
  })
})
