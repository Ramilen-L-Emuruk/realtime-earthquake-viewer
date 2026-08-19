// @vitest-environment jsdom
//
// EEW 読み上げ第 2 フェーズ（予想震度・長周期階級）の発話タイミングのテスト。
//
// ここで守りたいのは「初報から予想値を読むまでの間」。かつては第 2 フェーズを 3 秒デバウンスし、
// 続報のたびに張り直していたため、続報が立て続けに届く大地震ほど読み上げが遅れ、上限の 15 秒まで
// 引っ張られていた（2024/08/08 日向灘 M7.1 で実際に発生）。値が確定した時点で読み、以降の
// 引き上げは差分の短句で追う方式に変えたので、その挙動を固定する。
//
// タイマー制御はブラウザでの目視確認が難しいため、fake timers で検証する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { EEWAlert, EEWRegion, IntensityScale, LpgmClass, JMAQuake, JMATsunami } from '../types/earthquake'

const speakMock = vi.fn(() => Promise.resolve())
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [])),
}))
vi.mock('../utils/alertSound', () => ({ playAlertSound: vi.fn() }))
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

/** 発話されたテキストだけを配列で取り出す（speakWithVoicevox の第 2 引数） */
function spokenTexts(): string[] {
  return speakMock.mock.calls.map(c => (c as unknown as unknown[])[1] as string)
}

/**
 * Phase 1 の完了 Promise は `.then()` で繋がっているため、fake timers を進めるだけでは
 * Phase 2 の発話まで到達しない。保留中のマイクロタスクを流し切る。
 */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function makeEEW(over: {
  eventId?: string
  serial?: number
  scaleTo?: IntensityScale
  lgIntTo?: LpgmClass
  condition?: string
  noAreas?: boolean
  severity?: 'Forecast' | 'Warning'
  cancelled?: boolean
  hypocenter?: { name: string; latitude: number; longitude: number }
} = {}): EEWAlert {
  const hypo = over.hypocenter ?? { name: '日向灘', latitude: 32.0, longitude: 132.0 }
  const areas: EEWRegion[] = over.noAreas ? [] : [{
    pref: '宮崎県',
    name: '宮崎県北部平野部',
    scaleFrom: 30,
    scaleTo: over.scaleTo ?? 45,
    kindCode: '10',
    arrivalTime: null,
    lgIntTo: over.lgIntTo,
  }]
  return {
    kind: 'eew',
    id: `eew-${over.serial ?? 1}`,
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: over.condition ?? '',
      hypocenter: { ...hypo, depth: 30, magnitude: 6.5 },
    },
    severity: over.severity ?? 'Warning',
    cancelled: over.cancelled ?? false,
    issue: { eventId: over.eventId ?? 'evt-1', serial: String(over.serial ?? 1), time: '2026-01-01T12:00:00Z' },
    areas,
  } as EEWAlert
}

function setup() {
  const settings = {
    voicevoxEnabled: true,
    voicevoxUrl: 'http://localhost:50021',
    voicevoxSpeakerId: 1,
    soundEnabled: false,
    soundVolume: 1,
    notifyMinScale: -1,
    notifyEEW: false,
  } as unknown as AppSettings

  const title = {
    alertTitle: null,
    setTitle: vi.fn(),
    applyPriority: vi.fn(),
    scheduleTitleRevert: vi.fn(),
    clearTitleTimer: vi.fn(),
  }

  const { result } = renderHook(() => useLiveEventHandler({
    settings,
    title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTab: vi.fn(),
    setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(),
    setActiveLpgmEventId: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('EEW 読み上げ第2フェーズの発話タイミング', () => {
  it('初報に予想震度があれば、デバウンスを挟まず第1フェーズの直後に読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()

    // 時間を一切進めずに、震源名（第1フェーズ）と予想値（第2フェーズ）の両方が出ている
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度5強。'])
  })

  it('初報に予想震度が無ければ待ち、値が付いた続報の時点で読む（上限を待たない）', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true, condition: '仮定震源要素' }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

    // 2 秒後に予想震度が付いた続報が届く
    await vi.advanceTimersByTimeAsync(2000)
    handle(makeEEW({ serial: 2, scaleTo: 45 }))
    await flushMicrotasks()
    expect(spokenTexts()).toContain('予想最大震度5弱。')

    // 上限（6秒）を過ぎても二重に読まない
    await vi.advanceTimersByTimeAsync(10000)
    await flushMicrotasks()
    expect(spokenTexts().filter(t => t.startsWith('予想最大震度'))).toHaveLength(1)
  })

  it('予想震度が最後まで付かない場合は上限で打ち切り、理由付きで読む', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true, condition: '仮定震源要素' }))
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(5999)
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(1)   // まだ第1フェーズだけ

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(spokenTexts()).toContain('単独点処理のため、予想震度なし。')
  })

  // 震度 6 弱（55）以上はレベルが特別警報へ上がるため、ここでは 5弱→5強 の範囲で確かめる
  // （レベルが動く格上げは下の専用ケースで扱う）
  it('続報で震度が上がったら差分の短句で追う', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 45 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50 }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['震度5強に引き上げ。'])
  })

  it('引き上げが連投されても、静まってから最新値だけを 1 回読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 30 }))
    await flushMicrotasks()
    speakMock.mockClear()

    // 1 秒間隔で 3 回引き上がる（デバウンスが張り直され続ける）
    for (const [i, s] of [40, 45, 50].entries()) {
      handle(makeEEW({ serial: i + 2, scaleTo: s as IntensityScale }))
      await vi.advanceTimersByTimeAsync(1000)
      await flushMicrotasks()
    }
    expect(spokenTexts()).toHaveLength(0)   // 連投中は読まない

    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['震度5強に引き上げ。'])   // 途中の 4・5弱 は読まない
  })

  // 階級だけが上がる続報は、震度にもレベル（特別警報は階級 4 以上）にも現れないため、
  // 専用の追跡を持たないと検出できず、従来は無言のまま取りこぼしていた。
  it('震度据え置きで長周期階級だけ上がった続報も読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 2 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 3 }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['長周期階級3に引き上げ。'])
  })

  // 第2フェーズは第1フェーズの再生完了を待って発話する。従来はその手前に 3 秒デバウンスがあり、
  // 取消が来ればタイマーを消して止められたが、即時化でその防御が無くなった。Promise は途中で
  // 止められないため、発話の直前に対象がまだ発表中かを見る必要がある。
  it('第1フェーズの再生中に誤報取消が届いたら、取り消された予想震度を読み上げない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    // マイクロタスクを流す前＝第1フェーズの再生中に相当する時点で取消が届く
    handle(makeEEW({ serial: 2, cancelled: true }))
    await flushMicrotasks()

    expect(spokenTexts()).not.toContain('予想最大震度5強。')
  })

  // 予報→警報のように severity だけが変わる続報では、震度・階級に差が無く差分の短句が空になる。
  // 値の差分だけを追うと最も重い区分変化が無言になるため、区分を述べてから予想値を読み直す。
  it('震度据え置きでレベルだけ上がった続報は、区分の変化を述べて読み直す', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['警報に切り替わりました。予想最大震度5強。'])
  })

  // 震度が伸びて特別警報の条件（震度6弱以上）を跨ぐ形の格上げが、実運用でもっとも起きやすい。
  // 「震度も上がっているのだから差分で足りる」と扱うと、まさにこの一番重い場面で
  // 「特別警報に切り替わった」ことだけが声から抜け落ちる。
  it('震度とレベルが同時に上がった続報でも、区分の変化を述べる', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))          // 5強 → 警報
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 55 }))   // 6弱 → 特別警報
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['特別警報に切り替わりました。予想最大震度6弱。'])
  })

  // 仮定震源要素のまま severity だけ確定する地震では、予想震度が付くのを待つと最大 6 秒無言になる。
  it('予想震度待ちの最中にレベルが上がったら、上限を待たず知らせる', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true, condition: '仮定震源要素', severity: 'Forecast' }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, noAreas: true, condition: '仮定震源要素', severity: 'Warning' }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['警報に切り替わりました。単独点処理のため、予想震度なし。'])
  })

  // 震源が大きく動いた続報（地名が変わり 50km 超移動）は第1フェーズから読み直す。
  // 以下 2 件は、この既存経路と今回追加した分岐との組み合わせを確かめるもの。
  // 分岐ごとに前置きを付け外ししていた頃は、この組み合わせで区分の格上げが脱落していた。
  const FAR_HYPO = { name: '安芸灘', latitude: 34.0, longitude: 132.5 }   // 日向灘から約 230km

  it('震源が大きく動いた続報は、新しい震源で読み直す', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 45 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 45, hypocenter: FAR_HYPO }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['震源を更新、安芸灘で地震。', '予想最大震度5弱。'])
  })

  it('震源更新とレベル格上げが重なっても、区分の変化を述べる', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))          // 5強 → 警報
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 55, hypocenter: FAR_HYPO }))   // 6弱 → 特別警報
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['震源を更新、安芸灘で地震。', '特別警報に切り替わりました。予想最大震度6弱。'])
  })

  it('引き下げの続報では発話しない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 55 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 40 }))
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(0)
  })
})
