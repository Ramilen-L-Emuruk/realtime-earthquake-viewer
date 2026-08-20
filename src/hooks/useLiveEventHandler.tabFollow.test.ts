// @vitest-environment jsdom
//
// 自動タブ切替と読み上げの同調のテスト。
//
// 直したかった症状: 震度速報や大津波警報を読み上げているのに、画面のタブが切り替わらない。
// 受信の瞬間に出した要求が保持（読み終えた EEW の残り）に弾かれ、そのまま捨てられていた。
// 実測ログ: `[tab] → tsunami スキップ (優先度3 < 保持中6・残り12870ms)`。
//
// ここで固定するのは 3 つ。
//   1. 読み上げがある経路は、**発話の番が来たときに**画面を取る（受信の瞬間ではない）
//   2. ただし待たされずに読めそうなら、通知音と同じ瞬間に先出しする（遅延は最大 4.2 秒あり、
//      その間画面が留まると「音が鳴ったのに変わらない」ように見えるため）
//   3. 読み上げを持たない経路（読み上げ無効の端末）は従来どおり受信時に取る
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

/**
 * 区域を持たない津波電文（観測情報のみの続報）。
 *
 * 進行中の津波の途中でページを読み直すと直前の状態が分からず、この電文が「新規発報」と
 * 判定される。区域が無いので読み上げ文が組めず、追従が発火しない経路になる。
 */
function makeTsunamiObsOnly(): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'tsunami-obs-1',
    eventId: 'tsunami-evt',
    time: '2026-01-01T12:10:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:10:00Z', type: 'Focus' },
    areas: [],
    // 波高が既に確定している観測点だけを含む（到達確認の文も組めない）
    observations: [{ name: '輪島港', height: { value: 1.2, over: false, description: '1.2m' }, time: '2026-01-01T12:08:00Z' }],
  } as unknown as JMATsunami
}

/** 同一イベントの観測点更新（grade は変わらず、観測点の波高だけが伸びた続報）。 */
function makeTsunamiObsUpdate(): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'tsunami-2',
    eventId: 'tsunami-evt',
    time: '2026-01-01T12:05:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:05:00Z', type: 'Focus' },
    areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登', maxHeight: { description: '5m', value: 5 } }],
    observations: [{ name: '輪島港', height: { value: 3.4, over: false, description: '3.4m' }, time: '2026-01-01T12:04:00Z' }],
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
    preSpeechTab: vi.fn(),
    expandPanelForSpecialInfo: vi.fn(),
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
  // 津波の「新規発報か続報か」は App が持つ現在の津波リストを見て判定される
  // （`isTsunamiNewFire`）。続報を模すテストでは、App が state を更新した状態を
  // ここへ書き込んでから次の電文を渡す。
  const tsunamisRef = { current: [] as JMATsunami[] }
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef,
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(),
    revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
    ...spies,
  }))
  return { handle: result.current.handleLiveEvent, spies, tsunamisRef }
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
    // 新規発報の追従は eewUrgent。手動選択より強い側の通知なので、発話の直前に手動で
    // 別タブへ移られていても画面を取り戻す（受信時要求の使い分けと揃えてある）。
    const { handle, spies } = setup()
    handle(makeEEW())
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('realtime', TAB_PRIORITY.eewUrgent)
  })

  it('EEW を読み上げている間に届いた地震情報は、読み終わるまで earthquake を取らない', async () => {
    // これが報告された不具合の回帰テスト。従来は受信の瞬間に earthquake を要求し、
    // 保持に弾かれて捨てられていた（声は EEW → 地震情報の順に読むのに画面が付いてこない）。
    const { handle, spies } = setup()
    handle(makeEEW())
    await advance(2000)
    expect(spies.followSpeechTab).toHaveBeenCalledWith('realtime', TAB_PRIORITY.eewUrgent)
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

  it('津波の観測点更新（grade 不変の続報）でも、読み上げが起きるなら画面が動く', async () => {
    // 従来は続報でタブを奪わなかった（CRIT-4）。その理由は「毎回 15 秒の抑制が再セットされて
    // EEW 続報が realtime へ戻れなくなる」ことだったが、EEW 続報の抑制は
    // `shouldAcceptAutoTab` 側で明示的に扱うようにしたので、ここは声に合わせて動かす。
    const { handle, spies, tsunamisRef } = setup()
    handle(makeTsunami())
    await settle()
    spies.followSpeechTab.mockClear()

    // App が受信済みの津波を保持している状態にする（これが無いと続報も新規発報と判定される）
    tsunamisRef.current = [makeTsunami()]
    handle(makeTsunamiObsUpdate())
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('tsunami', TAB_PRIORITY.tsunami)
  })

  it('読み上げが無効でも、津波の観測点更新でタブを要求する', async () => {
    // 判定は UI 更新側（obsUpdateStatus / focusedDistrict）の「観測が動いたか」を再利用している。
    // 変化のない再送では動かない（同じ判定の else 節へ行く）。
    const { handle, spies, tsunamisRef } = setup({ voicevoxEnabled: false })
    handle(makeTsunami())
    spies.setActiveTabNonRealtime.mockClear()
    tsunamisRef.current = [makeTsunami()]
    handle(makeTsunamiObsUpdate())
    await settle()
    expect(spies.setActiveTabNonRealtime).toHaveBeenCalledWith('tsunami')
  })

  it('区域を持たない津波電文（観測情報のみ）は観測点更新として読み、追従で tsunami を取る', async () => {
    // 区域が無い電文は等級を伝えていないだけで、観測値は載っている。
    // 等級の比較から外して観測点更新として扱う（`isTsunamiObservationOnly`）。
    const { handle, spies } = setup()
    handle(makeTsunamiObsOnly())
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('tsunami', TAB_PRIORITY.tsunami)
    expect(speeches.map(s => s.text).join('')).toContain('輪島港')
  })

  it('津波警報の発表中に区域を持たない続報が来ても、全解除の文言を読まない', async () => {
    // 区域が空だと最大等級が Unknown（最下位）になり、発表中の警報と比べて必ず「降格」に
    // 見える。降格の読み上げは区域が空だと全解除の文言へフォールバックするため、
    // 警報の発表中に「津波警報等は全て解除されました」と読み上げていた。
    const { handle, tsunamisRef } = setup()
    handle(makeTsunami())
    await settle()
    tsunamisRef.current = [makeTsunami()]
    handle(makeTsunamiObsOnly())
    await settle()
    const spoken = speeches.map(s => s.text).join('')
    expect(spoken).not.toContain('解除')
    expect(spoken).toContain('輪島港')
  })

  it('待ちが無ければ、通知音と同じ瞬間にタブが移る', async () => {
    // 遅延（震度速報は 500ms）を待たずに画面を合わせる。待たされずに読めると分かっている
    // ときに画面だけ遅れると「音が鳴ったのに何も変わらない」ように見えるため。
    const { handle, spies } = setup()
    handle(makeQuake())
    expect(spies.preSpeechTab).toHaveBeenCalledWith('earthquake', TAB_PRIORITY.quake)
  })

  it('先出しは最小滞留時間の床を消費しない（後から声が出る側の追従を弾かない）', async () => {
    // 先出しで床を消費すると、こうなっていた:
    //   大津波警報を受信 → tsunami を先出し（声が出るのは 4.2 秒後）
    //   → 直後の震度速報（0.5 秒後に声）が床で弾かれ、声が始まっても画面は tsunami のまま
    // 先出しは「これから読む予定」にすぎないので、実際に声が出る側の追従を妨げてはいけない。
    const { handle, spies } = setup()
    handle(makeTsunami())
    // 先出しは起きるが、床は消費しない
    expect(spies.preSpeechTab).toHaveBeenCalledWith('tsunami', TAB_PRIORITY.tsunami)
    handle(makeQuake())
    // 震度速報の声（0.5 秒）は大津波警報の声（4.2 秒）より先に始まる
    await advance(1000)
    expect(spies.followSpeechTab).toHaveBeenCalledWith('earthquake', TAB_PRIORITY.quake)
  })

  it('高い優先度の読み上げ中は先出しせず、自分の番が来てから移る', async () => {
    const { handle, spies } = setup()
    handle(makeTsunami())
    await settle()
    spies.followSpeechTab.mockClear()
    spies.preSpeechTab.mockClear()
    // 津波（high）を読んでいる最中なので、地震情報（normal）は待たされる
    handle(makeQuake())
    expect(spies.preSpeechTab).not.toHaveBeenCalled()
    expect(spies.followSpeechTab).not.toHaveBeenCalled()
    // 津波の発話が終われば順番が来る
    for (const s of speeches) { if (!s.done) { s.done = true; s.finish() } }
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('earthquake', TAB_PRIORITY.quake)
  })

  it('津波の新規発報も、受信時ではなく発話の番で tsunami を取る', async () => {
    const { handle, spies } = setup()
    handle(makeTsunami())
    expect(spies.setActiveTabNonRealtime).not.toHaveBeenCalled()
    await settle()
    expect(spies.followSpeechTab).toHaveBeenCalledWith('tsunami', TAB_PRIORITY.tsunami)
  })
})
