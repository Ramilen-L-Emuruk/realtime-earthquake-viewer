// @vitest-environment jsdom
//
// 津波の「カードの並び」を使う 3 経路が、フックの結線ごと同じ材料を受け取ることを固定するテスト。
//
// 並べ替えそのものは `tsunami.test.ts`、読み上げ文の組み立ては `ttsText.test.ts` が見ている。
// ここで守るのは**フックが渡すもの**だけ。
//
// 区域の並びは「その区域で最も深刻な実測波高」で決まる（`sortAreasForCardDisplay`）。ところが
// 等級を切り替える報（大津波警報 → 津波警報 → 津波注意報）は観測点をほとんど載せないため、
// 電文の観測点だけで並べると電文順（気象庁の地理順）へ戻る。カードは前報までに積んだ観測点で
// 並び替わっているので、そこで食い違うと読み上げに追従するスクロールがカード上を往復する
// （2024/01/01 20:30 の切替で実際に起きた。→ docs/spec/tsunami-spec.md §9）。
//
// **渡し忘れても例外もログも出ない。** 3 経路とも「並びが違うだけ」で動いてしまうため、
// 配線が外れたことはここでしか検出できない。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { showBrowserNotification } from '../utils/notifications'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }
  }
  let finish!: () => void
  const p = new Promise<void>(r => { finish = r })
  speeches.push({ text, finish, done: false })
  return p
})
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** 通知音の遅延を消化し、発話を終わらせる */
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
  for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
  await flush()
}

const area = (name: string, code: string, grade: string, height: string): TsunamiArea =>
  ({ name, code, grade, immediate: false, maxHeight: { description: height, value: 0 } }) as TsunamiArea

const obs = (name: string, district: string, code: string, value: number): TsunamiObservation =>
  ({ name, districtCode: code, districtName: district, height: { value, description: `${value}m` } })

/** 電文 1 通。等級を切り替える報は観測点を載せない（`observations` を省く）。 */
function makeTsunami(over: {
  id?: string
  eventId?: string
  areas: TsunamiArea[]
  observations?: TsunamiObservation[]
}): JMATsunami {
  return {
    kind: 'tsunami',
    id: over.id ?? 'tsunami-1',
    eventId: over.eventId,
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: over.areas,
    observations: over.observations,
  } as unknown as JMATsunami
}

function setup(displayed: JMATsunami[] = [], over: Partial<AppSettings> = {}) {
  const settings = {
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
    ...over,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: displayed },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
  vi.mocked(showBrowserNotification).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

// 切替後の 3 区域。予想波高が同じなので、並びは実測波高だけで決まる
const watchAreas = [
  area('岩手県', '030', 'Watch', '１ｍ'),
  area('宮城県', '040', 'Watch', '１ｍ'),
  area('福島県', '050', 'Watch', '１ｍ'),
]

/** 画面が出している津波（前報までに観測点を積んでいる）。宮城 > 福島 の順に深刻。 */
const displayedWithObservations = makeTsunami({
  id: 'tsunami-prev',
  eventId: 'E1',
  areas: [
    area('岩手県', '030', 'Warning', '３ｍ'),
    area('宮城県', '040', 'Warning', '３ｍ'),
    area('福島県', '050', 'Warning', '３ｍ'),
  ],
  observations: [obs('石巻港', '宮城県', '040', 7.2), obs('小名浜', '福島県', '050', 3.1)],
})

/** 等級を切り替える報。観測点は載せない（実電文と同じ） */
const downgradeReport = makeTsunami({ id: 'tsunami-next', eventId: 'E1', areas: watchAreas })

describe('津波の等級切替: カードの並びを 3 経路で共有する', () => {
  // 正: 読み上げの区域列挙が、カードが持つ観測点で決まる並び（実測の深刻な順）になる
  it('読み上げの区域はカードの並びで読む', async () => {
    const handle = setup([displayedWithObservations])
    handle(downgradeReport as never)
    await settle()
    expect(speeches[0]?.text).toContain('宮城県、福島県、岩手県で1メートルが予想されています。')
  })

  // 対照: 画面に津波が出ていなければ引き継ぐものが無く、電文順のまま読む
  it('引き継ぐ前報が無ければ電文順で読む', async () => {
    const handle = setup([])
    handle(downgradeReport as never)
    await settle()
    expect(speeches[0]?.text).toContain('岩手県、宮城県、福島県で1メートルが予想されています。')
  })

  // 安全弁: 別の地震の津波からは引き継がない（カードも新しい電文だけを描く。
  // 判定は `isTsunamiContinuation` でカードの状態更新と共有する）
  it('別の地震の津波からは観測点を引き継がない', async () => {
    const other = makeTsunami({ ...displayedWithObservations, eventId: 'E2' } as never)
    const handle = setup([other])
    handle(downgradeReport as never)
    await settle()
    expect(speeches[0]?.text).toContain('岩手県、宮城県、福島県で1メートルが予想されています。')
  })

  // 正: ブラウザ通知の本文も同じ並び。上位 5 件しか出さないので、電文順で切ると
  // カードの先頭に並ぶ深刻な区域が通知から落ちる
  it('ブラウザ通知の区域もカードの並びで挙げる', async () => {
    const handle = setup([displayedWithObservations], { notifyMinScale: 0, notifyTsunami: true })
    handle(downgradeReport as never)
    await settle()
    const body = vi.mocked(showBrowserNotification).mock.calls[0]?.[1]
    expect(body).toBe('宮城県、福島県、岩手県')
  })
})
