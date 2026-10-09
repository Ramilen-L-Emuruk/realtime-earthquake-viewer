// @vitest-environment jsdom
//
// 「いま語っている地震のカード」を一覧へ知らせる受け口（`quakeSpeakingCard`）の**配線**のテスト。
//
// 寄せる相手の選び方は `src/utils/quakeCardScroll.test.ts` が押さえている。ここで固定するのは
// `useLiveEventHandler` 側でしか壊れないこと ——
//
// 1. **地震情報と、その取消の読み上げで begin / end が対で呼ばれること。** 呼ばれないと、
//    読み上げが有効な端末で一覧が寄らないだけになり、例外もログも出ない。
// 2. **津波の読み上げでは呼ばれないこと。** 津波の読み上げも原因地震の鍵を `subject` に持つので、
//    主題（`topic`）で見分けないと、津波を語るたびに地震情報の一覧が動く。
// 3. **リプレイのリセットで印が落ちること。**
import type { SpeechOutcome } from '../utils/voicevox'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, TsunamiArea } from '../types/earthquake'

const speeches: { finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  let finish!: () => void
  const p = new Promise<SpeechOutcome>(r => { finish = () => r({ spoke: true, spokenChunks: [text] }) })
  speeches.push({ finish, done: false })
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

/** 鳴っている発話をその都度完了させながら時間を進める（間を置く読み上げの発火を待つ）。 */
async function drain() {
  await act(async () => {
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(300)
      for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
      await flush()
    }
  })
}

const EVENT_ID = '20260101120000'

function makeQuake(over: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2026-01-01T12:00:00Z',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 5.2 },
      maxScale: 40,
      domesticTsunami: 'なし',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 40 }],
    ...over,
  } as JMAQuake
}

function makeTsunami(): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'tsunami-1',
    eventId: EVENT_ID,
    time: '2026-01-01T12:05:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:05:00Z', type: 'Focus' },
    areas: [{ name: '石川県能登', code: '360', grade: 'Warning', immediate: false } as TsunamiArea],
  } as JMATsunami
}

const calls: { kind: 'begin' | 'end' | 'reset'; key?: string; token?: number; pending?: boolean }[] = []
const quakeSpeakingCard = {
  begin: (key: string) => {
    calls.push({ kind: 'begin', key })
    return calls.length
  },
  // 地震情報は 1 回の発話で語り終えるので、「まだ語る予定があるか」は常に偽を渡す（印は残像のあと落ちる）。
  end: (token: number, hasPendingSpeech: () => boolean) => { calls.push({ kind: 'end', token, pending: hasPendingSpeech() }) },
  reset: () => { calls.push({ kind: 'reset' }) },
}

function setup(overSettings: Partial<AppSettings> = {}) {
  const settings: AppSettings = {
    ...DEFAULTS,
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    minDisplayScale: -1,
    ttsReadTelegramText: false,
    ...overSettings,
  }
  const title = new Proxy({ alertTitle: null, setTitle: vi.fn() } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const earthquakesRef = { current: [] as JMAQuake[] }
  const { result } = renderHook(() => useLiveEventHandler({
    telegramTextFollow: null,
    settings, title: title as never,
    earthquakesRef,
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    quakeSpeakingCard,
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  } as never))
  // `handleLiveEvent` / `resetTracking` は state を更新するので act() で包む。
  const handleLiveEvent: typeof result.current.handleLiveEvent = (...args) => {
    act(() => { result.current.handleLiveEvent(...args) })
  }
  const resetTracking: typeof result.current.resetTracking = (...args) => {
    act(() => { result.current.resetTracking(...args) })
  }
  return { ...result.current, handleLiveEvent, resetTracking, earthquakesRef }
}

beforeEach(() => {
  calls.length = 0
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('語っている地震のカードを一覧へ知らせる（配線）', () => {
  // 正: 地震情報の読み上げで、その地震の鍵を渡して begin し、語り終わりに同じトークンで end する。
  it('地震情報の読み上げで begin(地震の鍵) → end が対で呼ばれる', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake())
    await drain()
    expect(speakMock).toHaveBeenCalled()
    const begins = calls.filter(c => c.kind === 'begin')
    expect(begins.map(c => c.key)).toEqual([EVENT_ID])
    const token = calls.indexOf(begins[0]) + 1
    expect(calls.filter(c => c.kind === 'end').map(c => c.token)).toEqual([token])
    expect(calls.filter(c => c.kind === 'end').map(c => c.pending)).toEqual([false])
  })

  // 正: 取消の読み上げでも、取り消された地震の鍵で begin する（取消カードへ寄せるため）。
  it('地震情報の取消の読み上げでも、取り消された地震の鍵で begin する', async () => {
    const { handleLiveEvent, earthquakesRef } = setup()
    const original = makeQuake()
    earthquakesRef.current = [original]
    handleLiveEvent(makeQuake({ id: `dmdata-quake-${EVENT_ID}-2`, cancelled: true } as Partial<JMAQuake>))
    await drain()
    expect(speakMock).toHaveBeenCalled()
    expect(calls.filter(c => c.kind === 'begin').map(c => c.key)).toEqual([EVENT_ID])
    expect(calls.filter(c => c.kind === 'end')).toHaveLength(1)
  })

  // 正: 暫定 EventID が付け替えられた地震では、カードの鍵（最初の報の値）が電文の EventID と違う。
  //     取消の鍵はカードから作らないと、一覧が取消カードを見つけられない。
  it('カードの鍵が電文の EventID と違うとき、取消はカードの鍵で begin する', async () => {
    const { handleLiveEvent, earthquakesRef } = setup()
    earthquakesRef.current = [makeQuake({ eventKey: 'provisional-key' } as Partial<JMAQuake>)]
    handleLiveEvent(makeQuake({ id: `dmdata-quake-${EVENT_ID}-2`, cancelled: true } as Partial<JMAQuake>))
    await drain()
    expect(calls.filter(c => c.kind === 'begin').map(c => c.key)).toEqual(['provisional-key'])
  })

  // 対照: 津波の読み上げは原因地震の鍵を subject に持つが、地震情報の一覧は動かさない。
  //       **原因地震のカードを置いておく** —— 津波が subject を立てるのはカードがあるときだけで、
  //       無いと主題の判定を外しても begin が呼ばれず、この対照が何も確かめなくなる。
  it('津波の読み上げでは begin が呼ばれない', async () => {
    const { handleLiveEvent, earthquakesRef } = setup()
    earthquakesRef.current = [makeQuake()]
    handleLiveEvent(makeTsunami())
    await drain()
    expect(speakMock).toHaveBeenCalled()
    expect(calls.filter(c => c.kind === 'begin')).toEqual([])
  })

  // 対照: 読み上げが無効なら声が出ないので、印も立てない（一覧は受信した時点で寄る側へ回る）。
  it('読み上げが無効なら begin が呼ばれない', async () => {
    const { handleLiveEvent } = setup({ voicevoxEnabled: false })
    handleLiveEvent(makeQuake())
    await drain()
    expect(speakMock).not.toHaveBeenCalled()
    expect(calls.filter(c => c.kind === 'begin')).toEqual([])
  })

  // 安全弁: リプレイのリセットで印を落とす。
  it('resetTracking で reset が呼ばれる', () => {
    const { resetTracking } = setup()
    resetTracking()
    expect(calls.filter(c => c.kind === 'reset')).toHaveLength(1)
  })
})
