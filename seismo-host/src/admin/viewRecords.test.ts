// @vitest-environment jsdom
//
// **`initRecordsView` の配線**（何を取りに行き、何を画面へ出すか）。jsdom には canvas の 2D 文脈が無いので
// 絵そのものは見られない —— 逆に「文脈が取れなくても落ちない」ことをここで固定する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TOKEN_STORAGE_KEY } from './api'
import { initRecordsView } from './viewRecords'
import { memoryTabContext } from './tabState'

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

/** 10 分を超える幅の合成と震度（要約から）の応答。 */
function derived(url: string): { status: number; body: unknown } | null {
  const hours = { ok: 1, stale: 0, pending: 0, failed: 0, absent: 0 }
  if (url.startsWith('/api/records/composite')) {
    const group = new URLSearchParams(url.split('?')[1]).get('group')!
    const axes = CHANNELS.channels.filter((c) => String(c.id).startsWith(`${group}/`) || c.sensor === group).map((c) => String(c.id))
    return {
      status: 200,
      body: {
        group,
        source: 'coarse',
        unit: 'gal',
        columnMs: 60_000,
        firstColumnMs: H0,
        subsets: axes.length >= 2 ? [{ channels: axes, n: [5], max: [2] }] : [],
        hours,
        irregularHours: [],
        unscaledHours: 0,
      },
    }
  }
  if (url.startsWith('/api/records/intensity') && new URLSearchParams(url.split('?')[1]).has('columns')) {
    return {
      status: 200,
      body: {
        station: 'home',
        source: 'coarse',
        columnMs: 60_000,
        firstColumnMs: H0,
        realtime: [1.2],
        maxRealtime: 1.2,
        maxRealtimeAtMs: H0 + 3 * 60_000,
        maxRealtimeBucketMs: 60_000,
        measured: 0.86,
        hours,
        irregularHours: [],
      },
    }
  }
  return null
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
      const r = derived(url) !== null && respond(url).status === 404 ? derived(url)! : respond(url)
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
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    expect(requested).toEqual([])
    expect(root.querySelector('.records-list-note')!.textContent).toBe('管理トークンを入力してください')
  })

  it('一覧を記録に束ねて選ぶ欄へ並べ（名前はエスケープ）、1 本目の新しい側 1 時間を列で取りに行く', async () => {
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    const select = root.querySelector<HTMLSelectElement>('.records-group')!
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['観測点の合成波形', 'センサーの生データ'])
    expect(select.innerHTML).toContain('&lt;自宅&gt;')
    expect(root.querySelector('.records-list-note')!.textContent).toBe('読めない要約が 1 件ある。一覧に出ていない記録がある')
    expect(root.querySelector('.records-period')!.textContent).toContain('（3 時間ぶん）')
    // 合成波形には単位の切り替えが無い
    expect(root.querySelector<HTMLElement>('.records-unit')!.hidden).toBe(true)
    const envelopes = requested.filter((u) => u.startsWith('/api/records/envelope'))
    const views = envelopes.filter((u) => u.includes(`from=${H0}`) && u.includes(`to=${H0 + HOUR}`))
    expect(views.map((u) => new URLSearchParams(u.split('?')[1]).get('channel'))).toEqual(['station/home/X', 'station/home/Y', 'station/home/Z'])
    // 範囲が 10 分を超えても、合成と震度の推移を要約から取って出す（記録の組すべてを 1 回で取る）
    const composite = requested.filter((u) => u.startsWith('/api/records/composite'))
    expect(composite.map((u) => new URLSearchParams(u.split('?')[1]).get('group'))).toContain('station/home')
    const intensity = requested.find((u) => u.startsWith('/api/records/intensity') && u.includes(`to=${H0 + HOUR}`))!
    expect(new URLSearchParams(intensity.split('?')[1]).get('columns')).not.toBeNull()
    expect(root.querySelector('canvas.records-composite')).not.toBeNull()
    expect(root.querySelector('.records-intensity-header')!.textContent).toBe('最大 1.2（12:03 ごろ） 計測 0.8')
    // 「全体」の描き方はホバーで出す（2026-10-13 ユーザー承認）
    const overviewTip = [...root.querySelectorAll<HTMLElement>('button.tip')].find((b) => b.textContent === '全体')
    expect(overviewTip?.dataset.tip).toBe('振れ幅がいちばん大きい軸を描いています。押すと、その時刻へ寄ります。')
    expect(root.textContent).not.toContain('10 分以内まで寄せると出る')
    // 要約の不調の行
    expect(root.querySelector('.records-note')!.textContent).toContain('要約がまだ無い: 2 時間')
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
      await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
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
      // 10 分以内なら、凡例に波形の下の線の説明も入る（10 分を超える側の対照は「印の段」のテスト）
      expect(root.querySelector<HTMLElement>('.records-marks-legend button.tip')!.dataset.tip).toContain('波形の下の線')
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
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    expect(root.querySelector('.records-note')!.textContent).toContain('波形の記録を取得できていない: range-too-wide')
  })

  it('震度の推移だけ取れなくても、軸の段と合成は描き、理由を添えて書く', async () => {
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
      if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
      if (url.startsWith('/api/records/intensity')) return { status: 400, body: { error: 'range-too-wide' } }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    const note = root.querySelector('.records-note')!.textContent!
    expect(note).toContain('波形の記録を取得できていない: range-too-wide')
    // 軸の段の応答を読めていれば、その要約の不調の行も出る（捨てていれば出ない）
    expect(note).toContain('要約がまだ無い: 2 時間')
  })

  it('軸の段は消せるが、最後の 1 本は消さない', async () => {
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
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
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    const quakes = requested.find((u) => u.startsWith('/api/records/quakes'))!
    expect(new URLSearchParams(quakes.split('?')[1]).get('station')).toBe('home')
    const events = requested.find((u) => u.startsWith('/events'))!
    expect(new URLSearchParams(events.split('?')[1]).get('station')).toBe('home')
    expect(requested.some((u) => u.startsWith('/api/records/reception'))).toBe(true)
    const note = root.querySelector('.records-marks-note')!.textContent!
    // **受信の帯がどの基板のものかは、凡例のホバーの説明へ移した**（2026-10-13 ユーザー承認）。
    const legendTip = root.querySelector<HTMLElement>('.records-marks-legend button.tip')!.dataset.tip!
    expect(legendTip).toContain('受信の帯は、いまこの観測点に割り当てている基板のもの')
    expect(note).not.toContain('受信の帯は')
    expect(note).toContain('受信の記録の要約がまだ無い: 3 時間')
    expect(note).toContain('地震一覧を取得できていない日がある: 10/06。P2PQuake: HTTP 503')
    expect(note).toContain('発生時刻の秒を取得できていない日がある: 震源リスト 10/05')
    expect(note).toContain('揺れの記録が多く、新しい 500 件だけ印を付けている')
    // 形の違う記録 1 件と、ホストが読めなかったファイル 1 本
    expect(note).toContain('読めなかった揺れの記録が 2 件ある')
    // 1 時間の範囲は 10 分を超えるので、波形の下の線の凡例は出さない
    expect(root.querySelector<HTMLElement>('.records-marks-legend button.tip')!.dataset.tip).not.toContain('波形の下の線')
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
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
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
    // 対照: センサーの生データでは、受信の帯がどの基板のものかを凡例へ足さない（基板は 1 枚に決まっている）
    expect(root.querySelector<HTMLElement>('.records-marks-legend button.tip')!.dataset.tip).not.toContain('受信の帯は')
  })

  it('対照: いまの設定に無い観測点の記録では、受信の帯の注を凡例へ足さず、帯を出せないと書く', async () => {
    const gone = {
      channels: ['X', 'Y', 'Z'].map((a) => channel(`station/gone/${a}`, 'station', { station: null })),
      unreadable: 0,
    }
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: gone }
      if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    expect(root.querySelector('.records-marks-note')!.textContent).toContain('この観測点はいまの設定に無いので、受信の帯は出せない')
    expect(root.querySelector<HTMLElement>('.records-marks-legend button.tip')!.dataset.tip).not.toContain('受信の帯は')
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
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
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
    // 破線の説明は見出しのホバーへ移した（gal のときだけ。2026-10-13 ユーザー承認）。
    expect(root.querySelector<HTMLElement>('.records-spectrum-title button.tip')!.dataset.tip).toBe(
      '破線は Peterson の低ノイズ・高ノイズのモデル（NLNM・NHNM）です。',
    )
    expect(root.querySelector('.records-spectrum-legend')!.textContent).not.toContain('Peterson')
    // ノイズの段は要約の noiseStd（0.5 gal）から
    expect(root.querySelector('.records-noise-header')!.textContent).toBe('1 秒より速い揺れの RMS（縦は対数）　0.50〜0.50 gal')
  })

  // 一覧が空でも、読めない要約があるなら「記録はありません」と言わない（2026-10-13 ユーザー承認）
  it('正: 要約が全部読めず一覧が空なら、「記録はありません」を出さず、読めない件数だけを出す', async () => {
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: { channels: [], unreadable: 2 } }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    expect(root.querySelector('.records-list-note')!.textContent).toBe('読めない要約が 2 件ある。一覧に出ていない記録がある')
    expect(root.textContent).not.toContain('この範囲に記録はありません')
  })

  it('対照: 読めない要約も無く一覧が空なら、「記録はありません」を出す', async () => {
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: { channels: [], unreadable: 0 } }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    expect(root.textContent).toContain('この範囲に記録はありません')
  })

  it('対照: スペクトルが gal でなければ、見出しに破線の説明（ホバー）を付けない', async () => {
    const problems = { skippedBytes: 0, badRecords: 0, unscaledHours: 0 }
    respond = (url) => {
      if (url.startsWith('/api/records/channels')) return { status: 200, body: CHANNELS }
      if (url.startsWith('/api/records/envelope')) return { status: 200, body: envelope() }
      if (url.startsWith('/api/records/spectrogram')) {
        return {
          status: 200,
          body: {
            source: 'minutes',
            unit: 'count',
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
        return { status: 200, body: { source: 'minutes', unit: 'count', binEdgesHz: [0.1, 1, 10, 50], power: [1e-4, 1e-5, null], segments: 660, problems } }
      }
      return { status: 404, body: { error: 'not-found' } }
    }
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
    await settle()
    // スペクトルが画面へ渡ったこと（見出しが出る）を先に確かめる。渡っていなければ対照にならない
    expect(root.querySelector('.records-spectrum-header')!.textContent).toBe('約 10 秒の区間 660 本の平均（1 分ごとの PSD から）')
    expect(root.querySelector('.records-spectrum-title button.tip')).toBeNull()
    expect(root.querySelector('.records-spectrum-title')!.textContent).toBe('いま映している範囲のスペクトル')
  })

  it('生データを選ぶと単位の切り替えが出て、生の値を選ぶと native で取り直す', async () => {
    const root = document.createElement('div')
    await initRecordsView(root, memoryTabContext(new AbortController().signal, 'records'))
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

/** リロード・タブ移動で、見ていた記録と範囲・単位・隠した軸を保つ（2026-10-10・2026-10-11 ユーザー承認）。 */
describe('波形の記録タブの状態を保つ', () => {
  const RAW = 'FDSN:XX_A1_S1'

  const envelopeRanges = (): string[] =>
    requested
      .filter((u) => u.startsWith('/api/records/envelope'))
      .map((u) => {
        const q = new URLSearchParams(u.split('?')[1])
        return `${q.get('from')}-${q.get('to')}`
      })

  it('見ていた記録と範囲を URL の選択から開き直す（範囲は絶対時刻）', async () => {
    const from = H0 - 30 * 60_000
    const to = H0
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: RAW, from: String(from), to: String(to) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(root.querySelector<HTMLSelectElement>('.records-group')!.value).toBe(RAW)
    expect(envelopeRanges()).toContain(`${from}-${to}`)
  })

  it('範囲を動かすと選択にも載る', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const ctx = memoryTabContext(new AbortController().signal, 'records')
      const root = document.createElement('div')
      await initRecordsView(root, ctx)
      await settle()
      expect(ctx.selection.get('group')).toBe('station/home')
      root.querySelector<HTMLButtonElement>('button[data-span-index="5"]')!.click()
      const from = Number(ctx.selection.get('from'))
      const to = Number(ctx.selection.get('to'))
      expect(to - from).toBe(10 * 60_000)
    } finally {
      vi.useRealTimers()
    }
  })

  // **覚えた後に記録が消える・URL を書き換えることがある。** 消えた記録のまま開くと本体が隠れて何も出ない。
  it('一覧に無い記録は先頭へ戻し、そのときは覚えていた範囲も当てない', async () => {
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: 'gone', from: String(H0 - 5_000), to: String(H0) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(root.querySelector<HTMLSelectElement>('.records-group')!.value).toBe('station/home')
    expect(ctx.selection.get('group')).toBe('station/home')
    expect(envelopeRanges()).toContain(`${H0}-${H0 + HOUR}`)
  })

  // **揺れの記録の「波形の記録で開く」から来たとき**（2026-10-15 ユーザー承認「進めて」）。記録はホストが添えた札で探す。
  const handoffNote = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('.records-handoff-note')!

  it('正: 札で渡されたら、その合成波形を選び、渡された範囲を当てる（前の記録の選択より優先）', async () => {
    const from = H0 - 30 * 60_000
    const to = H0 - 29 * 60_000
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: RAW, station: 'home', stationKey: 'home', from: String(from), to: String(to) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(root.querySelector<HTMLSelectElement>('.records-group')!.value).toBe('station/home')
    expect(ctx.selection.get('group')).toBe('station/home')
    expect(ctx.selection.get('from')).toBe(String(from))
    expect(ctx.selection.get('to')).toBe(String(to))
    expect(handoffNote(root).hidden).toBe(true)
  })

  it('正: 観測点 ID が変わっていても（設定から外した・付け替えた）、札が合えばその記録を開く', async () => {
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: RAW, station: 'old-id', stationKey: 'home', from: String(H0 - 60_000), to: String(H0) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(root.querySelector<HTMLSelectElement>('.records-group')!.value).toBe('station/home')
  })

  it('安全弁: 渡された札・観測点 ID は一度使ったら選択から消す（残すと選び直した記録へ毎回勝つ）', async () => {
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { station: 'home', stationKey: 'home', from: String(H0 - 60_000), to: String(H0) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(ctx.selection.get('station')).toBeNull()
    expect(ctx.selection.get('stationKey')).toBeNull()
  })

  it('対照: 札が一覧に無ければ先頭を範囲なしで開き、そのことを一行で知らせる', async () => {
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: RAW, station: 'gone', stationKey: 'gone-0123', from: String(H0 - 5_000), to: String(H0) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(root.querySelector<HTMLSelectElement>('.records-group')!.value).toBe('station/home')
    expect(ctx.selection.get('from')).not.toBe(String(H0 - 5_000))
    expect(handoffNote(root).hidden).toBe(false)
    expect(handoffNote(root).textContent).toBe('観測点 gone の合成波形は波形の記録に無いので、先頭の記録を開いた')
  })

  it('安全弁: 一覧が読めなかった回も、渡された札と範囲を消す（後で読めた回に別の記録へ当てない）', async () => {
    respond = (url) => (url.startsWith('/api/records/channels') ? { status: 503, body: {} } : { status: 404, body: {} })
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: RAW, station: 'home', stationKey: 'home', from: String(H0 - 5_000), to: String(H0) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(ctx.selection.get('stationKey')).toBeNull()
    expect(ctx.selection.get('from')).toBeNull()
    expect(ctx.selection.get('to')).toBeNull()
  })

  it('対照: 揺れの記録から来ていなければ、覚えていた範囲は消さない', async () => {
    respond = (url) => (url.startsWith('/api/records/channels') ? { status: 503, body: {} } : { status: 404, body: {} })
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: RAW, from: String(H0 - 5_000), to: String(H0) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    expect(ctx.selection.get('from')).toBe(String(H0 - 5_000))
  })

  it('期間の外の範囲は記録の期間へ収めて当てる', async () => {
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: 'station/home', from: String(H0 - 100 * HOUR), to: String(H0 - 100 * HOUR + 60_000) },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    const from = Number(ctx.selection.get('from'))
    expect(from).toBeGreaterThanOrEqual(H0 - 2 * HOUR)
    expect(Number(ctx.selection.get('to')) - from).toBe(60_000)
  })

  it('隠した軸を記録ごとに覚え、開き直すと隠したまま出す', async () => {
    const first = memoryTabContext(new AbortController().signal, 'records')
    const root = document.createElement('div')
    await initRecordsView(root, first)
    await settle()
    root.querySelector<HTMLButtonElement>('.records-axes button')!.click()
    const saved = first.prefs.load()

    const again = memoryTabContext(new AbortController().signal, 'records', { prefs: saved })
    const root2 = document.createElement('div')
    await initRecordsView(root2, again)
    await settle()
    const pressed = [...root2.querySelectorAll<HTMLButtonElement>('.records-axes button')].map((b) => b.getAttribute('aria-pressed'))
    expect(pressed).toEqual(['false', 'true', 'true'])
  })

  // 安全弁: 覚えていた軸がいまの記録に全部当たると、段が 1 つも無くなる。
  it('覚えていた隠し方で全部隠れるなら、全部出す', async () => {
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      prefs: { unit: 'gal', hidden: [['station/home', ['station/home/X', 'station/home/Y', 'station/home/Z']]] },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    const pressed = [...root.querySelectorAll<HTMLButtonElement>('.records-axes button')].map((b) => b.getAttribute('aria-pressed'))
    expect(pressed).toEqual(['true', 'true', 'true'])
  })

  it('生データの単位は覚え、合成の記録には当てない（合成は gal しか無い）', async () => {
    const ctx = memoryTabContext(new AbortController().signal, 'records', {
      selection: { group: RAW },
      prefs: { unit: 'native', hidden: [] },
    })
    const root = document.createElement('div')
    await initRecordsView(root, ctx)
    await settle()
    const pressedUnit = (): string | undefined =>
      root.querySelector<HTMLButtonElement>('.records-unit button[aria-pressed="true"]')?.dataset.unit
    expect(pressedUnit()).toBe('native')

    const select = root.querySelector<HTMLSelectElement>('.records-group')!
    select.value = 'station/home'
    select.dispatchEvent(new Event('change'))
    expect(root.querySelector<HTMLElement>('.records-unit')!.hidden).toBe(true)
    expect(pressedUnit()).toBe('gal')
  })
})
