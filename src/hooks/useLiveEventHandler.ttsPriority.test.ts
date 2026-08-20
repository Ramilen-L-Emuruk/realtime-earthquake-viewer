// @vitest-environment jsdom
//
// 非 EEW の読み上げの優先度のテスト。
//
// `speakWithVoicevox` は待ち行列ではなく割り込み（既存の再生を stop し、進行中の合成を abort
// する）。優先度を持たせないと緊急度の低い情報が重い情報を途中で消す。2024/1/1 能登の実電文を
// 再生したとき、大津波警報の読み上げがその 30 秒後に始まった地震情報に消されていた。
//
// ここで固定するのは 1 つの規則だけ。**割り込みを許すのは「自分の優先度が読み上げ中のものと
// 同じか高いとき」だけ**。同格どうしは新しい方が勝つ（震度速報の更新が古い震度速報を置き換える
// のは正しい挙動で、ここを待ち行列にすると最新の震度がいつまでも出てこない）。
//
// 読み上げの完了を任意の時点で起こせるよう、モックは解決関数を外に出して保持する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, IssueType, EEWAlert } from '../types/earthquake'

/**
 * 発話ごとに「まだ再生中」の Promise を返し、解決関数を控えておく。
 *
 * **新しい発話が来たら、前の発話の Promise を解決する。** 実装（`voicevox.ts`）は単一の
 * グローバルセッションを持ち、新しい `speakWithVoicevox` が古いセッションを無効化すると
 * 古い呼び出し自身が完了扱いで resolve する。ここを再現しないと「割り込みで待ちが明ける」
 * という実際の連鎖がテストで一度も踏まれない。
 */
const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }   // 割り込みで打ち切られた側は完了扱いになる
  }
  let finish!: () => void
  const p = new Promise<void>(r => { finish = r })
  speeches.push({ text, finish, done: false })
  return p
})

/** 明示的に読み上げを終わらせる（割り込みではなく自然終了を模擬する） */
function finishSpeech(index: number) {
  const s = speeches[index]
  if (s && !s.done) { s.done = true; s.finish() }
}
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
}))
vi.mock('../utils/alertSound', () => ({ playAlertSound: vi.fn() }))
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

function spokenTexts(): string[] {
  return speeches.map(s => s.text)
}

/** 読み上げは Promise チェーンで繋がっているため、保留中のマイクロタスクを流し切る */
async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** 通知音の遅延（最大 4200ms）を消化してから発話に到達させる */
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
}

function makeQuake(over: { id?: string; type?: IssueType; addr?: string } = {}): JMAQuake {
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
    points: [{ pref: '石川県', addr: over.addr ?? '石川県能登', isArea: true, scale: 50 }],
  } as JMAQuake
}

function makeTsunami(over: { id?: string } = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: over.id ?? 'tsunami-1',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登', maxHeight: { description: '5m', value: 5 } }],
  } as unknown as JMATsunami
}

function makeEEW(over: { noAreas?: boolean } = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'eew-1',
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
    issue: { eventId: 'eew-evt', serial: '1', time: '2026-01-01T12:00:00Z' },
    // 予想震度が取れない初報（仮定震源要素）を作れるようにする。第 2 フェーズが最大 6 秒待つ
    condition: over.noAreas ? '仮定震源要素' : '',
    areas: over.noAreas
      ? []
      : [{ pref: '石川県', name: '石川県能登', scaleFrom: 45, scaleTo: 55, kindCode: '10', arrivalTime: null }],
  } as unknown as EEWAlert
}

function setup() {
  const settings = {
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
    // 解説情報の読み上げはこの設定で切れるため、優先度を見るテストでは明示的に有効にする
    nankaiCommentaryAlerts: true,
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
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('非 EEW の読み上げの優先度', () => {
  // 能登で実際に起きた誤りがこれ。大津波警報の読み上げが後続の地震情報に消えていた。
  it('地震情報は、津波の読み上げが終わるまで待つ', async () => {
    const handle = setup()
    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('大津波警報')

    // 津波の読み上げが続いている間に地震情報が届く
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // まだ割り込んでいない

    // 津波の読み上げが終われば地震情報が読まれる
    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('震度速報')
  })

  it('津波は、地震情報の読み上げを待たずに割り込む', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeTsunami())
    await settle()
    // 緊急度が上なので待たない（読み上げ中の地震情報は割り込みで消える）
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('大津波警報')
  })

  it('長周期地震動情報は、地震情報の読み上げが終わるまで待つ', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle({
      kind: 'lpgm',
      data: {
        eventId: 'lpgm-1', cancelled: false, time: '2026-01-01T12:00:00Z',
        areas: [{ pref: '石川県', name: '石川県能登', lpgmClass: 4 }],
      },
    } as never)
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 地震情報を切らない

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('長周期')
  })

  // 南海トラフ関連解説情報は最下位。臨時情報の発表期間中は毎日届くため、既存のどの層と同格に
  // しても何かを切ってしまう（同格は待たずに割り込む規則のため）。「解説情報は何も切らない」を
  // 両方向から固定する。
  function handleCommentary(handle: ReturnType<typeof setup>) {
    handle({
      kind: 'nankaiCommentary',
      data: {
        id: 'commentary-1', time: '2026-01-01T12:00:00Z', eventId: 'commentary-evt',
        serialCode: '210', serialName: '臨時解説',
        headline: '南海トラフ地震関連解説情報（第１号）', summary: '要約', body: '本文',
        cancelled: false, reportDateTime: '2026-01-01T12:00:00Z',
        expireAt: '2026-01-08T12:00:00Z',
      },
    } as never)
  }

  it('解説情報は、地震情報の読み上げが終わるまで待つ', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handleCommentary(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 地震情報を切らない

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('解説情報')
  })

  it('解説情報は、長周期地震動の読み上げが終わるまで待つ（最下位なので何も切らない）', async () => {
    const handle = setup()
    handle({
      kind: 'lpgm',
      data: {
        eventId: 'lpgm-1', cancelled: false, time: '2026-01-01T12:00:00Z',
        areas: [{ pref: '石川県', name: '石川県能登', lpgmClass: 4 }],
      },
    } as never)
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('長周期')

    handleCommentary(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 長周期を切らない

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('解説情報')
  })

  it('長周期地震動は、解説情報の読み上げを待たずに割り込む', async () => {
    const handle = setup()
    handleCommentary(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('解説情報')

    handle({
      kind: 'lpgm',
      data: {
        eventId: 'lpgm-1', cancelled: false, time: '2026-01-01T12:00:00Z',
        areas: [{ pref: '石川県', name: '石川県能登', lpgmClass: 4 }],
      },
    } as never)
    await settle()
    // 解説情報より上なので待たない
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('長周期')
  })

  // 待ちきれなかったときは割り込むことを選ぶ。ここが無いと、VOICEVOX が無応答になった端末で
  // 優先度の低い読み上げが永久に出てこなくなる。
  it('優先度の高い読み上げが終わらなくても、上限を過ぎれば割り込んで読む', async () => {
    const handle = setup()
    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 待っている

    // 津波の読み上げは終わらせない（VOICEVOX の無応答を模擬）
    await vi.advanceTimersByTimeAsync(90000)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('震度速報')
  })

  // 待ちの条件は毎周回で作り直す必要がある。一度きりの判定にすると、待っている間に始まった
  // EEW を待ち明けの非 EEW が後ろから切り、「EEW は常に最優先」の前提が崩れる。
  it('優先度待ちの最中に EEW が始まったら、待ち明けでも EEW を切らない', async () => {
    const handle = setup()
    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 津波を待っている

    // 待っている最中に EEW が発報する（EEW は待たずに割り込む）
    handle(makeEEW())
    await settle()
    const afterEew = spokenTexts().length
    expect(spokenTexts().some(t => t.startsWith('緊急地震速報'))).toBe(true)

    // 津波の読み上げが終わっても、EEW が読み上げ中なので地震情報はまだ読まない
    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(afterEew)
    expect(spokenTexts().some(t => t.includes('震度速報'))).toBe(false)
  })

  // 初報に予想震度が無い EEW は、値が付くのを最大 6 秒待つ。その待機中は EEW の発話が途切れて
  // 見えるため、進行中かどうかだけを見ていると地震情報が滑り込み、6 秒後の第 2 フェーズに
  // **必ず**切られる（2024/1/1 能登 16:08 の震源情報が残り 5.7 秒で消えていた）。
  it('EEW が予想震度の確定を待っている間も、地震情報は待つ', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true }))
    await flush()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('緊急地震速報')

    // 震源の読み上げが終わる。第 2 フェーズは値を待っている状態
    finishSpeech(0)
    await flush()

    handle(makeQuake())
    await vi.advanceTimersByTimeAsync(1000)   // 地震情報の通知音の遅延
    await flush()
    expect(spokenTexts()).toHaveLength(1)     // 滑り込まない

    // 上限で第 2 フェーズが読まれ、そのあとに地震情報が続く
    await vi.advanceTimersByTimeAsync(6000)
    await flush()
    expect(spokenTexts()[1]).toContain('予想震度なし')
    finishSpeech(1)
    await flush()
    expect(spokenTexts()[2]).toContain('震度速報')
  })

  // 待ち行列にしてはいけない側。新しい震度速報が古い震度速報を置き換えるのは正しい挙動で、
  // 待たせると最新の震度がいつまでも読まれない。
  it('同格どうしは待たず、新しい方が読み上げを置き換える', async () => {
    const handle = setup()
    handle(makeQuake({ id: 'quake-1' }))
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeQuake({ id: 'quake-2', type: '各地の震度情報', addr: '富山県東部' }))
    await settle()
    // 1 件目は解決させていない。それでも 2 件目が読まれるので待っていない
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('富山県東部')
  })
})
