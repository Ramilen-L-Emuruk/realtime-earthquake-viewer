// @vitest-environment jsdom
//
// 自動タブ切替と読み上げの同調のテスト。
//
// 直したかった症状: 震度速報や大津波警報を読み上げているのに、画面のタブが切り替わらない。
// 受信の瞬間に出した要求が保持（読み終えた EEW の残り）に弾かれ、そのまま捨てられていた。
// 実測ログ: `[tab] → tsunami スキップ (優先度3 < 保持中6・残り12870ms)`。
//
// ここで固定するのは 2 つ。
//   1. 読み上げがある経路は、**発話の番が来たときに**画面を取る（受信の瞬間ではない）
//   2. 読み上げを持たない経路（読み上げ無効の端末）は従来どおり受信時に取る
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { TAB_PRIORITY } from '../utils/tabPriority'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, IssueType, EEWAlert } from '../types/earthquake'

// 発話の進行を外から終わらせられるようにする（ttsPriority.test.ts と同じ手口）。
// 新しい発話が来たら前の発話を完了扱いにするのは、実装が単一セッションを割り込みで
// 置き換える挙動に合わせるため。
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
}))
vi.mock('../utils/alertSound', () => ({ playAlertSound: vi.fn() }))
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** 通知音の遅延（最大 4200ms）と第 2 フェーズの待ち（6000ms）を消化して発話へ到達させる */
async function settle() {
  await vi.advanceTimersByTimeAsync(8000)
  await flush()
}

/**
 * 指定時間だけ進める。
 *
 * **EEW チェーンの待ちは `EEW_SPEECH_CHAIN_MAX_WAIT_MS`（8 秒）で打ち切られる**ため、
 * 「EEW を読んでいる間」を観察したいテストでは 8 秒を超えて進めてはいけない。
 * 超えると実装が「EEW の発話が異常に長引いた」と判断して待ちを解放し、
 * 後続が正しく割り込んでくる（それ自体は仕様どおりの挙動）。
 */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
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

function makeTsunami(): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'tsunami-1',
    eventId: 'tsunami-evt',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登', maxHeight: { description: '5m', value: 5 } }],
    observations: [],
  } as unknown as JMATsunami
}

function makeEEW(over: { serial?: string } = {}): EEWAlert {
  return {
    kind: 'eew',
    id: `eew-${over.serial ?? '1'}`,
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
    issue: { eventId: 'eew-evt', serial: over.serial ?? '1', time: '2026-01-01T12:00:00Z' },
    condition: '',
    areas: [{ pref: '石川県', name: '石川県能登', scaleFrom: 45, scaleTo: 55, kindCode: '10', arrivalTime: null }],
  } as unknown as EEWAlert
}

function setup(over: { voicevoxEnabled?: boolean } = {}) {
  const spies = {
    followSpeechTab: vi.fn(),
    setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(),
  }
  const settings = {
    voicevoxEnabled: over.voicevoxEnabled ?? true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  // title API は多数のメソッドを持つため、未知のプロパティも関数として返す Proxy で代替する
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(),
    revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
    ...spies,
  }))
  return { handle: result.current.handleLiveEvent, spies }
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('読み上げとタブ切替の同調', () => {
  it('読み上げが有効なら、地震情報の受信の瞬間にはタブを動かさない', () => {
    const { handle, spies } = setup()
    handle(makeQuake())
    expect(spies.setActiveTabNonRealtime).not.toHaveBeenCalled()
  })

  it('読み上げが無効な端末では、従来どおり受信の瞬間にタブを動かす', async () => {
    const { handle, spies } = setup({ voicevoxEnabled: false })
    handle(makeQuake())
    expect(spies.setActiveTabNonRealtime).toHaveBeenCalledWith('earthquake')
    await settle()
    expect(spies.followSpeechTab).not.toHaveBeenCalled()
  })

  it('地震情報の発話が始まると earthquake へ追従する', async () => {
    const { handle, spies } = setup()
    handle(makeQuake())
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('earthquake', TAB_PRIORITY.quake)
  })

  it('EEW の発話が始まると realtime へ追従する', async () => {
    const { handle, spies } = setup()
    handle(makeEEW())
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('realtime', TAB_PRIORITY.eewUpdate)
  })

  it('EEW を読み上げている間に届いた地震情報は、読み終わるまで earthquake を取らない', async () => {
    // これが報告された不具合の回帰テスト。従来は受信の瞬間に earthquake を要求し、
    // 保持に弾かれて捨てられていた（声は EEW → 地震情報の順に読むのに画面が付いてこない）。
    const { handle, spies } = setup()
    handle(makeEEW())
    await advance(2000)
    expect(spies.followSpeechTab).toHaveBeenCalledWith('realtime', TAB_PRIORITY.eewUpdate)
    spies.followSpeechTab.mockClear()

    // EEW の発話が進行中（明示的に終わらせていない）のまま地震情報を入れる。
    // 累計は 8 秒（EEW チェーンの待ち上限）を超えないようにする。
    handle(makeQuake())
    await advance(3000)
    const tookEarthquake = spies.followSpeechTab.mock.calls.some(c => c[0] === 'earthquake')
    expect(tookEarthquake).toBe(false)
  })

  // 「待ちきれずに割り込む」上限（`HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS` = 90 秒）の挙動は
  // ttsPriority.test.ts が読み上げ側で押さえている。追従はその発話開始に同乗するだけなので
  // ここでは重ねて検証しない。

  it('値が据え置きの EEW 続報でも、受信時の realtime 要求は従来どおり呼ばれる', async () => {
    // 第 2 フェーズは値が上がらないと黙るため、追従だけに寄せると realtime を取り戻せない。
    const { handle, spies } = setup()
    handle(makeEEW({ serial: '1' }))
    await settle()
    spies.setActiveTabRealtimeOnUpdate.mockClear()
    handle(makeEEW({ serial: '2' }))
    await settle()
    expect(spies.setActiveTabRealtimeOnUpdate).toHaveBeenCalled()
  })

  it('津波の新規発報も、受信時ではなく発話の番で tsunami を取る', async () => {
    const { handle, spies } = setup()
    handle(makeTsunami())
    expect(spies.setActiveTabNonRealtime).not.toHaveBeenCalled()
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('tsunami', TAB_PRIORITY.tsunami)
  })
})
