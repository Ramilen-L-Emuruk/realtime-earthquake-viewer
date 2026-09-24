// @vitest-environment jsdom
//
// 録画ツール向けイベントログの配線（`window.__replay.drainEvents()` が返すもの）。
//
// **ここで固定したいのは「読み上げが融けないこと」。** 外から観測できるのが `isSpeaking()` の
// 真偽だけだった頃は、連続して読み上げると 1 本に見えていた（2024-01-01 18:27 の実配信で、
// 津波観測の 36 秒と震源・震度情報の 24 秒が 60.3 秒 1 本として記録され、動画から落とすと
// 決めた電文の読み上げが本編に入った）。1 本ごとに別の記録が出て、それぞれが**どの電文の
// ものか**を指していれば、編集側はその取り違えをしない。
//
// モックの流儀は `useLiveEventHandler.ttsPriority.test.ts` に合わせてある（発話ごとに解決関数を
// 控え、割り込みで前の発話が完了扱いになる連鎖まで再現する）。
import type { SpeechOutcome } from '../utils/voicevox'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import {
  drainReplayEvents,
  __resetReplayEventLogForTest,
  type ReplaySpeechStartEvent,
  type ReplaySpeechEndEvent,
  type ReplayTelegramEvent,
} from '../utils/replayEventLog'
import type { JMAQuake, JMATsunami, IssueType, EEWAlert } from '../types/earthquake'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }
  }
  let finish!: () => void
  const p = new Promise<SpeechOutcome>(r => { finish = () => r({ spoke: true }) })
  speeches.push({ text, finish, done: false })
  return p
})
function finishSpeech(index: number) {
  const s = speeches[index]
  if (s && !s.done) { s.done = true; s.finish() }
}
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
  isAudioPlaying: () => false,
  stopSpeech: vi.fn(),
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
}

function makeQuake(over: { id?: string; type?: IssueType } = {}): JMAQuake {
  return {
    kind: 'quake',
    id: over.id ?? 'quake-1',
    time: '2026-01-01T12:00:00Z',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: over.type ?? '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 6.1 },
      maxScale: 50,
      domesticTsunami: '警報等',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 50 }],
  } as JMAQuake
}

/** 津波の観測情報（等級を伝えない続報）。18:27 の形の前半。 */
function makeTsunamiObs(over: { id?: string, eventId?: string } = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: over.id ?? 'tsunami-obs-1',
    eventId: over.eventId ?? 'tsunami-evt',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [],
    observations: [{
      name: '輪島港',
      height: { value: 0.3, description: '0.3m' },
      districtCode: '360', districtName: '石川県能登',
    }],
  } as unknown as JMATsunami
}

/**
 * 等級を語る津波（区域を持つ）。**同じ `eventId` を保つ**ので、続けて渡すと続報として扱われる。
 */
function makeTsunamiGraded(grade: 'MajorWarning' | 'Warning' | 'Watch', id: string): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    eventId: 'tsunami-graded',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [{ code: '100', name: 'テスト予報区', grade, immediate: false }],
    observations: [],
  } as unknown as JMATsunami
}

function makeEEW(over: { serial?: number } = {}): EEWAlert {
  const serial = over.serial ?? 1
  return {
    kind: 'eew',
    id: `eew-${serial}`,
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '能登半島沖', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: 'eew-evt', serial: String(serial), time: '2026-01-01T12:00:00Z' },
    areas: [{ pref: '石川県', name: '石川県能登', scaleFrom: 45, scaleTo: 55, kindCode: '10', arrivalTime: null }],
  } as unknown as EEWAlert
}

function setup() {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  // **画面が出している津波。** 続報の判定（新規発報か・等級が動いたか）はここを見るので、
  // 等級の変化を試すテストは、アプリと同じように報を受けたあとでこれを進める。
  const tsunamisRef = { current: [] as JMATsunami[] }
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef,
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(() => false),
    closeDistributionOnQuakeReport: vi.fn(),
  }))
  return { handle: result.current.handleLiveEvent, tsunamisRef }
}

const starts = (events: ReturnType<typeof drainReplayEvents>['events']): ReplaySpeechStartEvent[] =>
  events.filter((e): e is ReplaySpeechStartEvent => e.type === 'speechStart')
const ends = (events: ReturnType<typeof drainReplayEvents>['events']): ReplaySpeechEndEvent[] =>
  events.filter((e): e is ReplaySpeechEndEvent => e.type === 'speechEnd')
const telegrams = (events: ReturnType<typeof drainReplayEvents>['events']): ReplayTelegramEvent[] =>
  events.filter((e): e is ReplayTelegramEvent => e.type === 'telegram')

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
  __resetReplayEventLogForTest()
})
afterEach(() => {
  vi.useRealTimers()
  __resetReplayEventLogForTest()
})

describe('読み上げは 1 本ずつ記録される', () => {
  it('1 本の読み上げで開始と終了が 1 組だけ出る', async () => {
    const { handle } = setup()
    handle(makeQuake())
    await settle()
    finishSpeech(0)
    await flush()

    const events = drainReplayEvents().events
    expect(starts(events)).toHaveLength(1)
    expect(ends(events)).toHaveLength(1)
    // 開始と終了は同じ識別子で結べる
    expect(ends(events)[0].speechId).toBe(starts(events)[0].speechId)
  })

  // 本題。連続して読み上げても融けないこと
  it('続けて読み上げた 2 本が、別々の電文を指して 2 組出る', async () => {
    const { handle } = setup()
    handle(makeTsunamiObs())
    await settle()
    handle(makeQuake())
    await settle()
    // 津波の読み上げが終わってから地震情報が読まれる（優先度の規則）
    finishSpeech(0)
    await flush()
    await settle()
    finishSpeech(1)
    await flush()

    const events = drainReplayEvents().events
    const s = starts(events)
    expect(s).toHaveLength(2)
    // それぞれが自分の電文を指している。ここが融けていると、編集側は頭だけ見て
    // 2 本まとめて採用してしまう
    expect(s[0].telegram?.kind).toBe('tsunami')
    expect(s[1].telegram?.kind).toBe('quake')
    // 識別子も別。同じ値だと start と end の対応が崩れる
    expect(s[0].speechId).not.toBe(s[1].speechId)
    expect(ends(events)).toHaveLength(2)
  })

  it('読み上げた文が残る', async () => {
    const { handle } = setup()
    handle(makeQuake())
    await settle()

    const s = starts(drainReplayEvents().events)
    expect(s[0].text).toContain('震度速報')
    expect(s[0].textTruncated).toBe(false)
  })

  it('緊急地震速報には地震の鍵が付き、列が分かれる', async () => {
    const { handle } = setup()
    handle(makeEEW())
    await settle()

    const s = starts(drainReplayEvents().events)
    expect(s.length).toBeGreaterThanOrEqual(1)
    expect(s[0].channel).toBe('eew')
    expect(s[0].eewKey).toBe('eew-evt')
    // 対照: 非 EEW では主題が入り、鍵は空
    expect(s[0].topic).toBeNull()
  })

  it('非 EEW には主題が入る', async () => {
    const { handle } = setup()
    handle(makeTsunamiObs())
    await settle()

    const s = starts(drainReplayEvents().events)
    expect(s[0].channel).toBe('other')
    expect(s[0].topic).not.toBeNull()
    expect(s[0].eewKey).toBeNull()
  })
})

describe('電文の受信が記録される', () => {
  it('種別と識別子が残る', async () => {
    const { handle } = setup()
    handle(makeQuake())
    await settle()

    const t = telegrams(drainReplayEvents().events)
    expect(t).toHaveLength(1)
    expect(t[0].kind).toBe('quake')
    expect(t[0].infoType).toBe('震度速報')
    expect(t[0].cancelled).toBe(false)
    // 画面と音へ回ったので、見送りの印は付かない
    expect(t[0].skipped).toBeNull()
  })

  it('据え置いた電文には見送りの印が付く', async () => {
    const { handle } = setup()
    handle(makeQuake(), { quakeHeldBack: true })
    await settle()

    const t = telegrams(drainReplayEvents().events)
    expect(t).toHaveLength(1)
    expect(t[0].skipped).toBe('heldBack')
    // 安全弁: 届いたことは残る。記録ごと落とすと「来なかった」と区別が付かない
    expect(t[0].kind).toBe('quake')
  })

  it('読み上げより先に電文が記録される（持ち主を指せる）', async () => {
    const { handle } = setup()
    handle(makeQuake())
    await settle()

    const events = drainReplayEvents().events
    const t = telegrams(events)[0]
    const s = starts(events)[0]
    expect(t.seq).toBeLessThan(s.seq)
    // 読み上げが指している番号が、その電文のもの
    expect(s.telegram?.seq).toBe(t.seq)
  })

  it('緊急地震速報も記録される', async () => {
    const { handle } = setup()
    handle(makeEEW())
    await settle()

    const t = telegrams(drainReplayEvents().events)
    expect(t).toHaveLength(1)
    expect(t[0].kind).toBe('eew')
    expect(t[0].eventId).toBe('eew-evt')
    expect(t[0].serial).toBe('1')
  })
})

// 等級が動いた報だけを `alert` に出す（観測情報の続報は数分おきに届くので、すべて残すと
// 「警報の状態が動いた」という問いに答えられなくなる）。
//
// **`tsunamisRef` を手で進めないこと。** あれは画面がいま出しているもので、レンダー時にしか
// 進まない。テストが手で同期させると「同じティックで複数の電文を捌く」場面（アーカイブ再生の
// 追いつき）を再現できず、記録がその写しを見る実装に戻しても落ちなくなる。
describe('津波の等級が動いた報を記録する', () => {
  const changes = () => drainReplayEvents().events
    .flatMap(e => e.type === 'alert' ? [e.change] : [])

  it('正: 引き下げは downgraded として出る', async () => {
    const { handle } = setup()
    handle(makeTsunamiGraded('MajorWarning', 't1'))
    await settle()
    handle(makeTsunamiGraded('Watch', 't2'))
    await settle()
    expect(changes()).toEqual(['issued', 'downgraded'])
  })

  it('正: 引き上げは upgraded として出る', async () => {
    const { handle } = setup()
    handle(makeTsunamiGraded('Watch', 't1'))
    await settle()
    handle(makeTsunamiGraded('MajorWarning', 't2'))
    await settle()
    expect(changes()).toEqual(['issued', 'upgraded'])
  })

  // 対照: 等級が変わらない続報では出さない。ここが崩れると、観測情報が届くたびに
  // 「状態が動いた」が並び、編集する側は本当の変わり目を見つけられなくなる。
  it('対照: 等級が変わらない続報では出さない', async () => {
    const { handle } = setup()
    handle(makeTsunamiGraded('Warning', 't1'))
    await settle()
    handle(makeTsunamiGraded('Warning', 't2'))
    await settle()
    expect(changes()).toEqual(['issued'])
  })

  // 安全弁: **等級を語らない報を「前の等級」として数えない。** 区域が空の観測情報を挟むと
  // `tsunamiMaxGrade` は `Unknown`（最下位）を返すので、そこを基準にすると変化のない
  // 継続報が「格上げ」に化ける。満潮時刻の報は等級の発表の直後に必ず届くので、実運用で頻出する。
  it('安全弁: 観測のみの報を挟んでも、等級が変わらなければ出さない', async () => {
    const { handle } = setup()
    handle(makeTsunamiGraded('MajorWarning', 't1'))
    await settle()
    handle(makeTsunamiObs({ id: 't2', eventId: 'tsunami-graded' }))   // 区域を持たない（等級を語らない）続報
    await settle()
    handle(makeTsunamiGraded('MajorWarning', 't3'))
    await settle()
    expect(changes()).toEqual(['issued'])
  })

  it('安全弁: 観測のみの報を挟んだあとの引き下げは downgraded になる', async () => {
    const { handle } = setup()
    handle(makeTsunamiGraded('MajorWarning', 't1'))
    await settle()
    handle(makeTsunamiObs({ id: 't2', eventId: 'tsunami-graded' }))
    await settle()
    handle(makeTsunamiGraded('Watch', 't3'))
    await settle()
    expect(changes()).toEqual(['issued', 'downgraded'])
  })
})
