// @vitest-environment jsdom
//
// 録画モードのとき、窓の手前（`restorePreWindowTracking`）で伝えた内容も既読として復元すること。
//
// 通常の再生で復元しないのは「窓から聞き始めた人は一度も聞いていない」ため。録画は区間を繋いで
// 1 本の動画にするので、その前提が成り立たない —— 前の区間で既に画面にも声にも出ており、
// 復元しないと区間の境目で同じ内容を読み直す。
//
// **気象庁が書いた文（`spokenTelegramTextRef`）の分は `useLiveEventHandler.telegramText.test.ts`。**
// あちらは文単位の差分と同じ主題なので、そちらへ置いてある。
import type { SpeechOutcome } from '../utils/voicevox'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler, createPreWindowQuakeTopics } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import { quakeEventKey } from '../utils/quakeMerge'
import type { JMAQuake, JMATsunami, LiveEvent } from '../types/earthquake'

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

/** 鳴っている発話を細かく完了させながら時間を進める（telegramText のテストと同じ形）。 */
async function drain() {
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(300)
    for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
    await flush()
  }
}

/** 電文本体の読み上げだけを拾う（気象庁が書いた文の発話と混ざらないように）。 */
function mainSpeeches(): string[] {
  return speeches.map(s => s.text).filter(t => !t.includes('気象庁の発表文をお伝えします'))
}

/**
 * 各地の震度情報（確定情報）。**区間の最初の確定情報は地域を通しで読む**ので、
 * 復元が効いているかはここに現れる。
 */
function makeQuake(over: { id?: string; p2p?: boolean } = {}): JMAQuake {
  return {
    kind: 'quake',
    // **既定は DMDATA の形。** 地震の同一性は `id` から取り出した `EventID`（14 桁）で決まる
    // （`quakeEventKey`）。素の文字列にすると報ごとに別の地震と見なされる。
    // `p2p: true` は識別子を持たない経路（P2PQuake）の形で、そちらの鍵の寄せ方を確かめるのに使う。
    id: over.p2p ? `p2p-${over.id ?? 'quake-1'}` : `dmdata-xml-quake-20260101120000-${over.id ?? 'quake-1'}`,
    time: '2026-01-01T12:00:00Z',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: '各地の震度情報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 5.2 },
      maxScale: 40,
      domesticTsunami: 'なし',
    },
    points: [
      { pref: '石川県', addr: '石川県能登', isArea: true, scale: 40 },
      { pref: '富山県', addr: '富山県東部', isArea: true, scale: 30 },
    ],
  } as JMAQuake
}

/** 津波の取消（解除）。読み上げは 1 回だけで、区間をまたいでも繰り返さない。 */
function makeTsunamiCancel(): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'tsunami-cancel-1',
    eventId: 'tsunami-event-1',
    time: '2026-01-01T13:00:00Z',
    cancelled: true,
    cancelReason: 'lifted',
    areas: [],
    issue: { source: 'JMA', time: '2026-01-01T13:00:00Z', type: 'Focus' },
  } as unknown as JMATsunami
}

function setup(overSettings: Partial<AppSettings> = {}) {
  const settings: AppSettings = {
    ...DEFAULTS,
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    minDisplayScale: -1,
    // **気象庁が書いた文の復元を走らせるのに要る。** 既定は false で、そのままだと
    // `telegramTextToSpeak` が入口で降りて復元が一度も呼ばれない（壊れた電文のテストが空振りする）。
    ttsReadTelegramText: true,
    ...overSettings,
  }
  const title = new Proxy({ alertTitle: null, setTitle: vi.fn() } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const earthquakesRef = { current: [] as JMAQuake[] }
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef,
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  return { ...result.current, earthquakesRef }
}

/** 窓の手前の電文を `silent` で流したことにする（リプレイの初期状態の再現と同じ形）。 */
function preWindow(...events: LiveEvent[]) {
  return events.map(event => ({ payload: { kind: 'event', event }, replayTime: new Date(0), silent: true })) as never
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('録画モードの既読復元', () => {
  // 正: 窓の手前で伝えた地域は読み直さない（区間の最初の確定情報が通しで読まれない）。
  it('地震の地域を読み直さない', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    restorePreWindowTracking(preWindow(makeQuake({ id: 'pre' }) as unknown as LiveEvent))
    handleLiveEvent(makeQuake({ id: 'quake-1' }) as unknown as LiveEvent)
    await drain()
    const said = mainSpeeches().join('')
    expect(said, '窓の手前で伝えた地域が読み直されている').not.toContain('石川県能登')
    expect(said, '窓の手前で伝えた地域が読み直されている').not.toContain('富山県東部')
  })

  // 対照: 録画モードが無効なら従来どおり通しで読む（聞き手はまだ一度も聞いていない）。
  it('録画モードでなければ地域を通しで読む', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup()
    restorePreWindowTracking(preWindow(makeQuake({ id: 'pre' }) as unknown as LiveEvent))
    handleLiveEvent(makeQuake({ id: 'quake-1' }) as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join('')).toContain('石川県能登')
  })

  // 安全弁: 復元しても、窓に入ってから震度が上がった地域は読む（黙らせすぎていないこと）。
  it('窓の手前より震度が上がった地域は読む', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    restorePreWindowTracking(preWindow(makeQuake({ id: 'pre' }) as unknown as LiveEvent))
    const stronger = makeQuake({ id: 'quake-1' })
    stronger.points = [{ pref: '富山県', addr: '富山県東部', isArea: true, scale: 50 }]
    // 最大震度も揃える。読み上げは最大震度を基準に階級を数えるので、据え置くと
    // 上がった地域が「最大より上の階級」として選抜から外れる。
    stronger.earthquake = { ...stronger.earthquake, maxScale: 50 }
    handleLiveEvent(stronger as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join('')).toContain('富山県東部')
  })

  // 正: 津波の取消も、窓の手前で伝えていれば読み直さない。
  it('津波の取消を読み直さない', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    restorePreWindowTracking(preWindow(makeTsunamiCancel() as unknown as LiveEvent))
    handleLiveEvent(makeTsunamiCancel() as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join('')).not.toContain('津波')
  })

  // 対照: 録画モードが無効なら取消を読む。
  it('録画モードでなければ津波の取消を読む', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup()
    restorePreWindowTracking(preWindow(makeTsunamiCancel() as unknown as LiveEvent))
    handleLiveEvent(makeTsunamiCancel() as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join('')).toContain('津波')
  })
  // 安全弁: 窓の手前の 1 件が壊れていても、残りの復元は続く。
  //
  // 投げたまま抜けると呼び出し元の `catch` まで飛び、**「リプレイデータ取得失敗」として
  // 電文の再生自体が始まらない**（原因と表示が食い違う）。
  //
  // **種別を問わず隔離する**（緊急地震速報・津波の分も含む。→ 下の describe）。
  it('壊れた電文が混ざっても、残りの復元は続く', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    // 気象庁が書いた文の復元だけが触る種別で壊す。
    const broken = { payload: { kind: 'nankai', data: null }, replayTime: new Date(0), silent: true }
    const ok = { payload: { kind: 'event', event: makeQuake({ id: 'pre' }) }, replayTime: new Date(0), silent: true }
    expect(() => restorePreWindowTracking([broken, ok] as never)).not.toThrow()
    handleLiveEvent(makeQuake({ id: 'quake-1' }) as unknown as LiveEvent)
    await drain()
    // 2 件目（正常な電文）の復元が効いていれば、地域は読み直されない。
    expect(mainSpeeches().join('')).not.toContain('富山県東部')
  })

  // 対照: 取消の報は復元の対象にしない。
  //
  // 取消電文の震源要素はセンチネル（震央名が空・規模 0）で埋まっており、`hasMagnitude(0)` は
  // 真なので「Ｍ０．０」として記録される。既読へ入れると、窓に入った最初の報が
  // 「マグニチュードが更新されました」と余計に言う。
  it('取消の報では震源要素を既読にしない', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    const cancelled = makeQuake({ id: 'pre' })
    cancelled.cancelled = true
    cancelled.earthquake = {
      ...cancelled.earthquake,
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 },
      maxScale: -1,
    }
    restorePreWindowTracking(preWindow(cancelled as unknown as LiveEvent))
    handleLiveEvent(makeQuake({ id: 'quake-1' }) as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join('')).not.toContain('マグニチュードが更新されました')
  })
  // 正: 識別子を持たない経路（P2PQuake）で、窓の手前に同じ地震の報が 2 通あっても両方復元される。
  //
  // **報ごとに鍵を作ると、2 通目以降の記憶がライブ経路から参照されない鍵の下へ入る** ——
  // `quakeEventKey` は識別子が無いと `p2p:<地震の時刻>#<その報の id>` へ落ち、続報のたびに
  // 別の鍵になるため。ライブ経路が使うのはカードの `eventKey`（最初に処理された報で固定）。
  it('識別子を持たない経路でも、窓の手前の 2 通目の地域を読み直さない', async () => {
    const { handleLiveEvent, restorePreWindowTracking, earthquakesRef } = setup({ recordingMode: true })
    const first = makeQuake({ id: 'r1', p2p: true })
    const second = makeQuake({ id: 'r2', p2p: true })
    // 2 通目で初めて現れる地域。ここが復元されないと、窓内の報で読み直される。
    second.points = [...second.points, { pref: '新潟県', addr: '新潟県上越', isArea: true, scale: 20 }]
    restorePreWindowTracking(preWindow(first as unknown as LiveEvent, second as unknown as LiveEvent))
    // **実運用の流れを再現する。** 復元のあと、同じ窓手前の電文が `loadReplayEvents` で流れて
    // カードができる。カードの `eventKey` は**最初に処理された報**で固定されるので、窓内の報は
    // その鍵を引き継ぐ（`existingCard`）。ここを空のままにすると、窓内の報が自分の id から
    // 別の鍵を作ってしまい、復元の有無に関わらずテストが落ちる。
    earthquakesRef.current = [{ ...first, eventKey: quakeEventKey(first) }]
    // 窓内の報にも同じ地域を持たせる。**持たせないと復元の有無で差が出ず、テストが空振りする。**
    const third = makeQuake({ id: 'r3', p2p: true })
    third.points = [...third.points, { pref: '新潟県', addr: '新潟県上越', isArea: true, scale: 20 }]
    handleLiveEvent(third as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join(''), '2 通目で現れた地域が読み直されている').not.toContain('新潟県上越')
  })
})

/**
 * 窓の手前の地震へ主題を割り当てる処理（`createPreWindowQuakeTopics`）。
 *
 * **読み上げ経由では観測できない。** 主題が食い違っても症状は「既読が参照されない」だけで、
 * 読み上げ文の差として出るとは限らない。純関数として直接固定する。
 */
describe('窓の手前の地震に割り当てる主題', () => {
  function quakeFor(over: {
    id: string
    type?: JMAQuake['issue']['type']
    correct?: JMAQuake['issue']['correct']
    name?: string
    points?: unknown[]
  }): JMAQuake {
    const q = makeQuake({ id: over.id, p2p: true })
    if (over.type) q.issue = { ...q.issue, type: over.type }
    if (over.correct) q.issue = { ...q.issue, correct: over.correct }
    if (over.name !== undefined) {
      q.earthquake = { ...q.earthquake, hypocenter: { ...q.earthquake.hypocenter, name: over.name } }
    }
    if (over.points) q.points = over.points as JMAQuake['points']
    return q
  }

  // 正: 同じ地震の 2 通目以降は、最初の報に与えた主題を使う。
  it('同じ地震の続報は最初の報の主題を使う', () => {
    const topicFor = createPreWindowQuakeTopics()
    const first = quakeFor({ id: 'r1' })
    const second = quakeFor({ id: 'r2' })
    expect(topicFor(second)).toBe(topicFor(first))
  })

  // 安全弁: 震源名が空の報（震度速報）が先に来ても、同じ分の別の地震を吸い込まない。
  //
  // `sameQuakeEntry` の震源名の照合は「片方が空なら矛盾なし」へ倒れる（実測で確認）。
  // 突き合わせる相手を初出の報のまま握り続けると、区域を持たない別地震の報まで合流する。
  it('震源名が空の報が先に来ても、同じ分の別の地震は別の主題にする', () => {
    const topicFor = createPreWindowQuakeTopics()
    const flash = quakeFor({ id: 'a1', type: '震度速報', name: '' })
    const full = quakeFor({ id: 'a2' })
    // 同じ分の別の地震。**区域を持たない**ので、区域では分離できない
    const other = quakeFor({ id: 'b1', type: '震源情報', name: '茨城県沖', points: [] })
    const topicA = topicFor(flash)
    expect(topicFor(full), '同じ地震の続報が別の主題になっている').toBe(topicA)
    expect(topicFor(other), '別の地震を吸い込んでいる').not.toBe(topicA)
  })

  // 対照: 地震の時刻が違えば、束ねる先が別になる（同一性の判定は時刻の一致を必ず要求する）。
  it('地震の時刻が違えば別の主題にする', () => {
    const topicFor = createPreWindowQuakeTopics()
    const first = quakeFor({ id: 'r1' })
    const later = quakeFor({ id: 'r2' })
    later.earthquake = { ...later.earthquake, time: '2026-01-01T13:00:00Z' }
    expect(topicFor(later)).not.toBe(topicFor(first))
  })
  // 安全弁: 訂正報で震源名が変わっても、以後の続報が同じ主題に留まる。
  //
  // 代表の報を「震源名が空 → 判明」のときだけ差し替える形では、**名前の再変更に追随できない**。
  // 訂正報自体は照合を通る（震源名の変更を許す報なので矛盾と見なされない）が、代表が古い名前の
  // ままだと、その後の通常の続報が「名前が食い違う」として別の地震にされる。
  it('訂正報で震源名が変わっても、以後の続報は同じ主題に留まる', () => {
    const topicFor = createPreWindowQuakeTopics()
    const first = quakeFor({ id: 'r1', name: '石川県能登地方' })
    const amended = quakeFor({ id: 'r2', name: '能登半島沖', correct: '震源を訂正' })
    const next = quakeFor({ id: 'r3', name: '能登半島沖' })
    const topic = topicFor(first)
    expect(topicFor(amended), '訂正報が別の主題になっている').toBe(topic)
    expect(topicFor(next), '訂正後の続報が別の主題になっている').toBe(topic)
  })
})

// 窓の手前の復元は、電文 1 通ごとに例外を受け止める。
//
// 復元が投げると呼び出し元（`useReplayController`）の `catch` へ飛び、**取得は成功している
// のに「リプレイデータ取得失敗」と表示されたまま電文が 1 通も再生されない**。
//
// **録画モードの分だけを囲っていた頃の非対称は解いた。** 呼ぶ処理の分岐の数（＝投げる確率）は
// 違っても、投げたときに起きることは緊急地震速報・津波の復元とまったく同じ。
//
// **ここで作る「壊れた電文」は隔離の機構そのものを試すためのもので、実際の入力形状の再現では
// ない。** 型定義上ありえない値（配列でない区域・区域の欠落）を差し込んでいるので、本物の
// パーサーの出力がこの形になることはない。**通っても「実運用で安全」の保証にはならず、
// 保証するのは「投げたときに 1 通ぶんで止まる」ことだけ。**
describe('窓の手前の復元は電文 1 通ずつ隔離する', () => {
  /** 津波の復元で投げる形（`tsunamiMaxGrade` が `tsunami.areas` を無ガードで舐める）。 */
  function makeBrokenTsunami(): JMATsunami {
    return {
      kind: 'tsunami', id: 't-broken', eventId: 'e-broken', time: '2026-01-01T12:30:00Z',
      cancelled: false,
      issue: { source: 'JMA', time: '2026-01-01T12:30:00Z', type: 'Focus' },
      // `areas` を持たせない。
    } as unknown as JMATsunami
  }

  /** 緊急地震速報の復元で投げる形（`eewMaxScaleInfo` が区域を舐める）。 */
  function makeBrokenEew(): LiveEvent {
    return {
      kind: 'eew', id: 'eew-broken', time: '2026-01-01T12:30:00Z',
      issue: { source: 'JMA', time: '2026-01-01T12:30:00Z', eventId: 'evt-1' },
      areas: 1 as never, // 配列ではないので `for...of` が投げる
    } as unknown as LiveEvent
  }

  // 正: 津波の復元で投げても、後続の電文の復元は効く。
  it('津波の復元で投げても、後続の電文の復元は効く', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    const entries = preWindow(makeBrokenTsunami() as unknown as LiveEvent, makeQuake({ id: 'pre' }) as unknown as LiveEvent)
    expect(() => restorePreWindowTracking(entries)).not.toThrow()
    handleLiveEvent(makeQuake({ id: 'quake-1' }) as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join('')).not.toContain('富山県東部')
  })

  // 正: 緊急地震速報の復元で投げても同じ。
  it('緊急地震速報の復元で投げても、後続の電文の復元は効く', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    const entries = preWindow(makeBrokenEew(), makeQuake({ id: 'pre' }) as unknown as LiveEvent)
    expect(() => restorePreWindowTracking(entries)).not.toThrow()
    handleLiveEvent(makeQuake({ id: 'quake-1' }) as unknown as LiveEvent)
    await drain()
    expect(mainSpeeches().join('')).not.toContain('富山県東部')
  })

  /** 正常な緊急地震速報（警報級）。壊れた復元のあとに続報として流す。 */
  function makeEew(serial: number): LiveEvent {
    return {
      kind: 'eew', id: `eew-${serial}`, time: '2026-01-01T12:00:00Z', test: false,
      earthquake: {
        originTime: '2026-01-01T12:00:00Z', arrivalTime: '2026-01-01T12:00:20Z', condition: '',
        hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
      },
      severity: 'Warning', cancelled: false,
      issue: { eventId: 'evt-1', serial: String(serial), time: '2026-01-01T12:00:00Z' },
      areas: [{ pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 30, scaleTo: 45, kindCode: '10', arrivalTime: null }],
    } as unknown as LiveEvent
  }

  // 正: 緊急地震速報の復元が投げたら、**新規かどうかの判定に使う記録も残さない**。
  //
  // この分岐は複数の記録を順に埋めるが、`activeEEWLevelsRef` だけは意味が違う ——
  // ライブ経路の「新規発報か」がこれだけを見る。先に書いてから投げると、続報が「既存」と
  // 判定されて**第 1 フェーズ（「緊急地震速報、〇〇で地震。」）が一度も鳴らない**。
  // 他の記録は欠けても「既読が足りない＝読み直す」側なので、ここだけ失敗の向きが逆になる。
  it('緊急地震速報の復元が投げたら、続報を新規として読む', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    restorePreWindowTracking(preWindow(makeBrokenEew()))
    handleLiveEvent(makeEew(2))
    await drain()
    // **語ではなく文で見る。** 部分適用のまま続報を受けると「緊急地震速報に切り替わりました。」
    // という格上げの告知に化けるので、語の一致では素通りする（実際に素通りした）。第 1 フェーズは
    // 震源名を伴う。
    expect(mainSpeeches().join(''), '第 1 フェーズが鳴っていない').toContain('日向灘で地震')
  })

  // 対照: 復元が通った緊急地震速報では、続報で第 1 フェーズを読み直さない。
  //
  // **上の正が「投げたら全部書かない」を確かめるには、これと対で要る** —— 片方だけだと
  // 「そもそも復元が何も効いていない」状態でも通ってしまう。
  it('復元が通った緊急地震速報は、続報で読み直さない', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    restorePreWindowTracking(preWindow(makeEew(1)))
    handleLiveEvent(makeEew(2))
    await drain()
    expect(mainSpeeches().join(''), '復元したのに第 1 フェーズが鳴っている').not.toContain('日向灘で地震')
  })
  // 対照: 壊れた電文が無ければ記録も残さない。
  //
  // **握り潰しが常時発火していないことの確認。** ここが鳴りっぱなしだと、本物の異常が
  // 埋もれて痕跡を残す意味が無くなる。
  it('壊れた電文が無ければ復元の失敗を記録しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { restorePreWindowTracking } = setup({ recordingMode: true })
      restorePreWindowTracking(preWindow(makeQuake({ id: 'pre' }) as unknown as LiveEvent))
      const messages = warn.mock.calls.map(c => c.map(v => String(v)).join(' '))
      expect(messages.filter(m => m.includes('窓の手前の電文から状態を復元できませんでした'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  // 安全弁: 飛ばしたことは記録に残す（黙って捨てない）。
  it('飛ばした電文は記録に残す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { restorePreWindowTracking } = setup({ recordingMode: true })
      restorePreWindowTracking(preWindow(makeBrokenTsunami() as unknown as LiveEvent))
      const messages = warn.mock.calls.map(c => c.map(v => String(v)).join(' '))
      expect(messages.some(m => m.includes('窓の手前の電文から状態を復元できませんでした'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
