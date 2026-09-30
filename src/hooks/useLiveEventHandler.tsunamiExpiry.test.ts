// @vitest-environment jsdom
//
// 津波の失効時刻の読み上げを**フックの結線ごと**固定するテスト。
//
// 文の組み立ては `ttsText.test.ts` が見ている。ここで守るのは 1 点だけ ——
// **実電文で失効時刻を載せるのは「警報・注意報が解除されて予報だけが残った」報で、
// それは等級の引き下げとして届く**（→ docs/spec/tsunami-spec.md §3「有効期限は報ではなく
// 津波に付く」の実電文の表）。フックはその報を降格文（`tsunamiDowngradeToSegments`）へ流すので、
// **発表文（`tsunamiToSegments`）にだけ失効時刻を足すと、実運用では一度も声にならない。**
//
// この穴は他のどの検証にも掛からなかった。
//   - 型チェック: 通る（既読は任意引数だった）
//   - `ttsText.test.ts`: 発表文を直接呼ぶので通る
//   - 実機のテストボタン: `createTestTsunamiForecast` は単発注入で、直前の等級が無いため
//     降格と判定されない —— ボタンを押すと発表文の経路で正しく聞こえる
// 残るのは「等級が下がる並びをフックへ流す」この形だけ。
import type { SpeechOutcome } from '../utils/voicevox'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }
  }
  let finish!: () => void
  // 文全体が声になった扱い（このモックはチャンクへ割らない）
  const p = new Promise<SpeechOutcome>(r => { finish = () => r({ spoke: true, spokenChunks: [text] }) })
  speeches.push({ text, finish, done: false })
  return p
})
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
}))
// 音の実体だけ差し替える。通知音との間（`ttsDelayFor`）は本物を使う
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

function spokenTexts(): string[] {
  return speeches.map(s => s.text)
}

async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** 通知音の遅延を消化し、直前の発話を終わらせてから次を待てる状態にする */
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
  for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
  await flush()
}

// 2024 年能登半島地震の実値。10:00 発表の報が同日 17:00 の失効時刻を載せた
const ISSUED = '2024-01-02T10:00:00+09:00'
const EXPIRY = '2024-01-02T17:00:00+09:00'

type AreaSpec = { name: string; code: string; grade: TsunamiGrade; lastGrade?: TsunamiGrade }

let serial = 0

function makeReport(areas: AreaSpec[], validDateTime?: string): JMATsunami {
  serial += 1
  return {
    kind: 'tsunami',
    id: `tsunami-${serial}`,
    eventId: '20240101161010',
    time: ISSUED,
    cancelled: false,
    issue: { source: 'JMA', time: ISSUED, type: 'Focus' },
    areas: areas.map(a => ({ ...a, immediate: false } as TsunamiArea)),
    ...(validDateTime ? { validDateTime } : {}),
  } as JMATsunami
}

const AREAS = ['石川県能登', '新潟県上中下越', '富山県'] as const
const CODES = ['360', '350', '340'] as const
/** 全区域を同じ等級に置いた報を作る（`lastGrade` を付けると引き下げになる） */
function allAt(grade: TsunamiGrade, lastGrade?: TsunamiGrade): AreaSpec[] {
  return AREAS.map((name, i) => ({ name, code: CODES[i], grade, ...(lastGrade ? { lastGrade } : {}) }))
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
  // App が画面に出している津波（1 件スロット）。**空のままにしないこと** ―― `isTsunamiNewFire` が
  // 毎報「新規発報」と判定し、続報でタブを奪う経路が常に通ってしまう。
  const displayed: JMATsunami[] = []
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
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  // 受信して、App が state を更新したあとの姿（次の報が見る `tsunamisRef`）まで進める
  const handle = (tsunami: JMATsunami) => {
    result.current.handleLiveEvent(tsunami as never)
    displayed[0] = tsunami
  }
  return { handle }
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  serial = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('津波の失効時刻の読み上げ（フックの結線）', () => {
  // 正: 等級が下がる報に期限が付いていれば、降格文の末尾で失効時刻を読む。
  // **これが実電文の形** —— 発表文だけに足していたときはここが黙っていた。
  it('正: 予報へ引き下げる報で失効時刻を読む', async () => {
    const { handle } = setup()
    handle(makeReport(allAt('Warning')))
    await settle()
    handle(makeReport(allAt('Forecast', 'Warning'), EXPIRY))
    await settle()
    expect(spokenTexts()[1]).toContain('津波予報に切り替えられました')
    expect(spokenTexts()[1]).toContain('この津波予報の失効時刻は、17時0分です。')
  })

  // 対照: 期限を持たない引き下げ報では言わない。**実電文では期限が付くのは 1 通だけ**で、
  // 警報から注意報への引き下げはふつう期限を持たない。
  it('対照: 期限を持たない引き下げ報では言わない', async () => {
    const { handle } = setup()
    handle(makeReport(allAt('MajorWarning')))
    await settle()
    handle(makeReport(allAt('Warning', 'MajorWarning')))
    await settle()
    expect(spokenTexts()[1]).toContain('津波警報に切り替えられました')
    expect(spokenTexts()[1]).not.toContain('失効時刻')
  })

  // 安全弁: 降格でない報（発表文の経路）も引き続き読む。**降格側へ足したことで発表側を
  // 落としていない**ことの確認 —— 予報だけで始まる津波（前の等級が無い初報）はこちらを通る。
  it('安全弁: 引き下げでない初報でも失効時刻を読む', async () => {
    const { handle } = setup()
    handle(makeReport(allAt('Forecast'), EXPIRY))
    await settle()
    expect(spokenTexts()[0]).toContain('津波予報が発表されました')
    expect(spokenTexts()[0]).toContain('この津波予報の失効時刻は、17時0分です。')
  })

  // **「一度言ったら黙る」はここでは見ていない。** この経路の既読は
  // `applySpokenRefs` が受け取る参照で進むが、参照はチャンクごとに引かれ、
  // `mapChunksToRefs` は区域と事実が混ざったチャンクでは**区域の参照だけ**を返す
  // （カードの追従で区域行を優先するため）。上のモックは文全体を 1 チャンクにするので、
  // 実運用では別チャンクになる失効時刻の参照がここでは引けない。
  // **既読の固定は `ttsText.test.ts`（断片列を直接見る）が担う。**
})
