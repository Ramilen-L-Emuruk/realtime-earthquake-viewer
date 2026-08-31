// @vitest-environment jsdom
//
// 地震情報の「報ごとの扱い」のテスト。固定するのは 2 つ。
//
// 1. **同じ種別を 2 度目に見たら「更新されました」と言う。** 判定のキーには種別が入るので、
//    記憶が直近 1 件だと種別の異なる報が交互に届いたときに互いの記憶を上書きし、2 度目の
//    震度速報が「初めて見た」扱いに戻っていた（震度速報 → 震源情報 → 震度速報 で「震度速報。」
//    を 2 回読む）。見た報は全部覚える。
//
// 2. **震度を伝えない電文でウィンドウタイトルの震度を消さない。** 震源情報（VXSE52）は震度を
//    持たないため、そのままタイトルにすると「最大震度不明」に落ちる。以前は `isNewQuake` を
//    条件に含めていたが、震源情報は「その種別としての初報」＝新規になるため歯止めが一度も効いて
//    いなかった。判定は既存カードが震度を持つかどうかで行う。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, IssueType } from '../types/earthquake'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }   // 割り込まれた側は完了扱いになる（実装と同じ連鎖）
  }
  let finish!: () => void
  const p = new Promise<void>(r => { finish = r })
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
  // 鳴ったチャンクの判定に使う（このモックはチャンクの通知を出さないので常に null で足りる）
  getSpeechClock: () => null,
}))
// 音の実体だけ差し替える。**通知音との間（`ttsDelayFor`）は本物を使う** ―― 読み上げの順番と
// 待ち合わせはこの間の長さで決まるため、模擬すると検証の前提が変わる。
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

/** 通知音との間（最長 2720ms＝津波警報）を消化してから発話に到達させる */
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
}

// 同一イベントとして扱わせるため earthquake.time と震源名は固定する（`sameQuakeEntry` は
// eventId を持たない電文を「発生時刻が同じで震源が矛盾しない」で束ねる）。
function makeQuake(over: { type?: IssueType; addr?: string; maxScale?: number; magnitude?: number } = {}): JMAQuake {
  const maxScale = over.maxScale ?? 40
  return {
    kind: 'quake',
    id: `quake-${over.type ?? '震度速報'}`,
    time: '2026-01-01T12:00:00Z',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: over.type ?? '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00Z',
      hypocenter: {
        name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10,
        magnitude: over.magnitude ?? 5.2,
      },
      maxScale,
      domesticTsunami: 'なし',
    },
    points: maxScale < 0 ? [] : [{ pref: '石川県', addr: over.addr ?? '石川県能登', isArea: true, scale: maxScale }],
  } as JMAQuake
}

const titles: string[] = []

/** @param existingCards `earthquakesRef` の中身（統合済みカード。既存カードの震度判定に使う） */
function setup(existingCards: JMAQuake[] = []) {
  const settings = {
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  // setTitle だけ捕捉し、それ以外のメソッドは呼ばれても無害な関数で受ける
  const title = new Proxy({ alertTitle: null, setTitle: (t: string) => { titles.push(t) } } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: existingCards },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  titles.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('地震情報の続報判定（読み上げの冒頭）', () => {
  it('間に別種別が挟まっても、2 度目の震度速報は更新として読む', async () => {
    const handle = setup()
    handle(makeQuake({ type: '震度速報' }))
    await settle(); finishSpeech(0); await flush()
    handle(makeQuake({ type: '震源情報', maxScale: -1 }))
    await settle(); finishSpeech(1); await flush()
    handle(makeQuake({ type: '震度速報', addr: '石川県加賀' }))
    await settle()

    expect(spokenTexts()).toHaveLength(3)
    expect(spokenTexts()[0]).toContain('震度速報。')
    expect(spokenTexts()[1]).toContain('震源情報。')
    expect(spokenTexts()[2]).toContain('震度速報が更新されました。')
  })

  // 対照。初報を更新扱いにしてはいけない（記憶を全部持つようにしたので、覚えていない報は
  // 必ず新規になる）。
  it('初めて見た種別は新規として読む', async () => {
    const handle = setup()
    handle(makeQuake({ type: '震源情報', maxScale: -1 }))
    await settle()
    expect(spokenTexts()[0]).toContain('震源情報。')
    expect(spokenTexts()[0]).not.toContain('更新されました')
  })

  // 安全弁。同一種別が続けて届く場合の扱いは従来どおり（ここを一緒に緩めていないこと）。
  it('同じ種別が続けて届いたら更新として読む', async () => {
    const handle = setup()
    handle(makeQuake({ type: '震度速報' }))
    await settle(); finishSpeech(0); await flush()
    handle(makeQuake({ type: '震度速報', addr: '石川県加賀' }))
    await settle()
    expect(spokenTexts()[1]).toContain('震度速報が更新されました。')
  })
})

describe('地震情報のウィンドウタイトル', () => {
  it('震度を伝えない電文では、既存カードの震度を残す', async () => {
    // 震度速報で最大震度 4 を出したあとの状態を、既存カードとして渡す
    const handle = setup([makeQuake({ type: '震度速報' })])
    handle(makeQuake({ type: '震源情報', maxScale: -1 }))
    await flush()
    // タイトルを更新しない＝「最大震度不明」に落とさない
    expect(titles).toHaveLength(0)
  })

  // 対照。既存カードが震度を持たないなら、出せる情報が他に無いので従来どおり出す。
  it('既存カードが無ければ、震源情報でも最大震度不明で出す', async () => {
    const handle = setup()
    handle(makeQuake({ type: '震源情報', maxScale: -1 }))
    await flush()
    expect(titles).toEqual(['地震情報 石川県能登地方 最大震度不明'])
  })

  // 安全弁。遠地地震は国内震度を観測しないため maxScale が常に -1 だが、同一イベントのカードも
  // 震度を持たないのでこの歯止めに掛からない。規模が確定した続報はタイトルに反映される。
  it('遠地地震の続報は、震度が無くてもタイトルを更新する', async () => {
    const existing = makeQuake({ type: '遠地地震', maxScale: -1 })
    const handle = setup([existing])
    handle(makeQuake({ type: '遠地地震', maxScale: -1, magnitude: 7.4 }))
    await flush()
    expect(titles).toEqual(['遠地地震 石川県能登地方 M7.4'])
  })

  // 震度を持つ電文は当然そのまま出す（歯止めが広すぎないことの確認）。
  it('震度を伝える電文はタイトルを更新する', async () => {
    const handle = setup([makeQuake({ type: '震度速報' })])
    handle(makeQuake({ type: '各地の震度情報', maxScale: 50 }))
    await flush()
    expect(titles).toEqual(['地震情報 石川県能登地方 最大震度5強'])
  })
})
