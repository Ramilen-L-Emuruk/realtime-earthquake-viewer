// @vitest-environment jsdom
//
// 区域単位で等級が動いた報（一部解除・一部引き上げ）をフックの結線ごと固定するテスト。
//
// 文の組み立て自体は `ttsText.test.ts`、変化の抽出は `tsunami.test.ts` が見ている。
// ここで守るのは、フックの枝分けが正しいかという 3 点。
//
// 1. **最上位等級が動かない報でも読み上げること**（気象庁は一部解除を区域の降格として載せるため、
//    他の区域に注意報が残る限り最上位は動かない。従来はこれが観測点更新の枠へ落ち、観測波高の
//    更新が無ければ読み上げ文が空になって受信音だけが鳴っていた）
// 2. **同じ変化を載せ続ける続報で二度読みしないこと**（`LastKind` は変化後の報にも残る）
// 3. **観測点更新の読み上げを潰さないこと**（既読になった後の続報は従来どおり観測情報として読む）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'

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

type AreaSpec = { name: string; code: string; grade: TsunamiGrade; lastGrade?: TsunamiGrade }

let serial = 0

function makeReport(
  areas: AreaSpec[],
  observations: { name: string; district: string; code: string; value?: number }[] = [],
): JMATsunami {
  serial += 1
  return {
    kind: 'tsunami',
    id: `tsunami-${serial}`,
    eventId: '20240101161010',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: areas.map(a => ({ ...a, immediate: false } as TsunamiArea)),
    observations: observations.map(o => ({
      name: o.name,
      districtCode: o.code,
      districtName: o.district,
      height: o.value === undefined ? undefined : { value: o.value, description: `${o.value}m` },
    })),
  } as JMATsunami
}

// 2024 年能登半島地震の 01/02 の流れを縮めたもの。
// 注意報が 3 区域 → うち 2 区域が予報へ降格（02:30 の「一部解除」）
const WATCH_ALL: AreaSpec[] = [
  { name: '石川県能登', code: '360', grade: 'Watch' },
  { name: '福岡県日本海沿岸', code: '711', grade: 'Watch' },
  { name: '佐賀県北部', code: '720', grade: 'Watch' },
]
const PARTIAL_LIFT: AreaSpec[] = [
  { name: '石川県能登', code: '360', grade: 'Watch', lastGrade: 'Watch' },
  { name: '福岡県日本海沿岸', code: '711', grade: 'Forecast', lastGrade: 'Watch' },
  { name: '佐賀県北部', code: '720', grade: 'Forecast', lastGrade: 'Watch' },
]

function setup(voicevoxEnabled = true) {
  const settings = {
    voicevoxEnabled, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const setActiveTabNonRealtime = vi.fn()
  // App が画面に出している津波（1 件スロット）。**空のままにしないこと** ―― `isTsunamiNewFire` が
  // 毎報「新規発報」と判定し、続報でタブを奪う経路が常に通ってしまう。
  const displayed: JMATsunami[] = []
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: displayed },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime,
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
  }))
  // 受信して、App が state を更新したあとの姿（次の報が見る `tsunamisRef`）まで進める
  const handle = (tsunami: JMATsunami) => {
    result.current.handleLiveEvent(tsunami as never)
    displayed[0] = tsunami
  }
  return { handle, setActiveTabNonRealtime, keys: () => result.current.areaGradeChangedKeys }
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

describe('区域単位で等級が動いた報の読み上げ', () => {
  it('正: 最上位等級が動かない一部解除でも、動いた区域を読み上げる', async () => {
    const { handle } = setup()
    handle(makeReport(WATCH_ALL))
    await settle()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    expect(spokenTexts()[1]).toBe('福岡県日本海沿岸、佐賀県北部の津波注意報が津波予報に切り替えられました。')
  })

  it('対照: 同じ変化を載せ続ける続報では読み直さない', async () => {
    const { handle } = setup()
    handle(makeReport(WATCH_ALL))
    await settle()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    // 02:31・02:33 の続報は同じ「予報 / 前回は注意報」を載せてくる（観測点の変化は無い）
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
  })

  it('安全弁: 既読になった後の続報でも、観測点の更新は従来どおり読む', async () => {
    const { handle } = setup()
    handle(makeReport(WATCH_ALL))
    await settle()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    handle(makeReport(PARTIAL_LIFT, [
      { name: '輪島港', district: '石川県能登', code: '360', value: 0.4 },
    ]))
    await settle()
    expect(spokenTexts()).toHaveLength(3)
    expect(spokenTexts()[2]).toContain('輪島港で0.4メートル')
    // 等級変化は既読なので混ざらない
    expect(spokenTexts()[2]).not.toContain('切り替えられました')
  })

  it('安全弁: 最上位等級が下がる報は従来の切替の文（全体の降格）で読む', async () => {
    const { handle } = setup()
    handle(makeReport(WATCH_ALL))
    await settle()
    // 全区域が予報へ落ちる（10:00 の「津波注意報を解除しました」に相当。最上位が Watch → Forecast）
    handle(makeReport(WATCH_ALL.map(a => ({ ...a, grade: 'Forecast' as TsunamiGrade, lastGrade: 'Watch' as TsunamiGrade }))))
    await settle()
    expect(spokenTexts()[1]).toContain('津波予報に切り替えられました')
    // 区域ごとの言い方（「〜の津波注意報が」）ではなく、従来の全体降格の文になる
    expect(spokenTexts()[1]).not.toContain('の津波注意報が津波予報に')
  })

  // 実電文の第一報は全区域が `LastKind=00`（津波なし）で届く。**この報を区域ごとの専用文へ
  // 流してはいけない** ―― 発表そのものなので、従来の発表文が全区域を等級ごとに読む。
  it('安全弁: 新規発表の第一報（全区域が「前回は津波なし」）は従来の発表文で読む', async () => {
    const { handle } = setup()
    handle(makeReport(WATCH_ALL.map(a => ({ ...a, lastGrade: 'Unknown' as TsunamiGrade }))))
    await settle()
    expect(spokenTexts()[0]).toContain('津波注意報が発表されました')
    // 区域ごとの遷移を述べる文（「〜の津波△△報が津波□□報に」）にはならない
    expect(spokenTexts()[0]).not.toContain('に切り替えられました')
    expect(spokenTexts()[0]).not.toContain('に引き上げられました')
  })

  // カードは「直近の受信で動いた区域」だけに印を出す。区域が持つ `lastGrade` は変化後の続報にも
  // 残るため、それだけを見て出すと何通も後まで「たった今切り替わった」ように見え続ける
  // （読み上げは既読で 1 回に絞っているのに、画面だけ持続する非対称になる）。
  it('正: 等級が動いた報では、その区域のキーをカードへ渡す', async () => {
    const { handle, keys } = setup()
    handle(makeReport(WATCH_ALL))
    await settle()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    expect([...keys()].sort()).toEqual(['711', '720'])
  })

  it('対照: 同じ変化を載せ続ける続報では空にする（印が出続けない）', async () => {
    const { handle, keys } = setup()
    handle(makeReport(WATCH_ALL))
    await settle()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    expect([...keys()]).toEqual([])
  })

  it('安全弁: 観測点だけが動いた報でも空にする', async () => {
    const { handle, keys } = setup()
    handle(makeReport(WATCH_ALL))
    await settle()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    handle(makeReport(PARTIAL_LIFT, [
      { name: '輪島港', district: '石川県能登', code: '360', value: 0.4 },
    ]))
    await settle()
    expect([...keys()]).toEqual([])
  })

  // 読み上げが無効な端末では画面が唯一の伝達手段になる。**その場で既読へ移す**ので、
  // 同じ変化を載せ続ける続報で画面を奪い直さない（声が出る端末は発話の瞬間に既読へ移す）。
  it('読み上げが無効な端末: 等級が動いた報で津波タブを要求し、続報では要求しない', async () => {
    const { handle, setActiveTabNonRealtime } = setup(false)
    handle(makeReport(WATCH_ALL))
    await settle()
    setActiveTabNonRealtime.mockClear()

    handle(makeReport(PARTIAL_LIFT))
    await settle()
    expect(setActiveTabNonRealtime).toHaveBeenCalledWith('tsunami')

    setActiveTabNonRealtime.mockClear()
    handle(makeReport(PARTIAL_LIFT))
    await settle()
    expect(setActiveTabNonRealtime).not.toHaveBeenCalled()
  })
})
