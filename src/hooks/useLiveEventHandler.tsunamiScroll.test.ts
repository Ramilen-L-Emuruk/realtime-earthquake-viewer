// @vitest-environment jsdom
//
// 津波カードのスクロール要求（`focusedDistrict`）が「寄せ先が無い」と「先頭へ戻せ」を
// 言い分けることを固定するテスト。
//
// 空配列だけで両方を表していたころ、**各地の満潮時刻・津波到達予想時刻に関する情報**が
// 「変化なし」として先頭戻しに回り、直前の報が変更区域へ寄せた位置を捨てていた。
// 沖合の観測情報も同じ穴に落ちる（新しい観測点はあるが、沖合の観測点は津波予報区を
// 持たないため寄せ先の一覧が空になる）。
//
// 実際にスクロールが動くかどうかは受け取る側（`TsunamiTab` の受信時スクロール）の担当で、
// ここで固定するのは**要求の中身**。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami } from '../types/earthquake'

vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: () => Promise.resolve(),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
  warmFixedPhrases: () => undefined,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const EVENT_ID = 'evt-scroll-1'

/** 津波警報等（VTSE41）。区域一覧だけを運び、観測点は持たない。 */
function makeGradeReport(
  areas: { name: string; code: string; grade: string }[],
  id: string,
): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    eventId: EVENT_ID,
    time: '2026-04-20T08:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-04-20T08:00:00Z', type: 'Focus' },
    infoName: '津波警報・津波注意報・津波予報',
    areas: areas.map(a => ({ ...a, immediate: false })),
    observations: [],
  } as unknown as JMATsunami
}

/**
 * 各地の満潮時刻・津波到達予想時刻に関する情報。
 *
 * **実電文の形**: 区域一覧は前報と同じ等級のまま運び、観測点は載せず、区域の潮位観測点に
 * 満潮時刻を付ける（2026-04-20 の実電文で 26〜28 地点）。
 */
function makeHighTideReport(
  areas: { name: string; code: string; grade: string }[],
  id: string,
): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    eventId: EVENT_ID,
    time: '2026-04-20T08:05:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-04-20T08:05:00Z', type: 'Focus' },
    infoName: '各地の満潮時刻・津波到達予想時刻に関する情報',
    areas: areas.map(a => ({
      ...a,
      immediate: false,
      stations: [{ name: '宮古', highTideDateTime: '2026-04-20T09:19:00Z' }],
    })),
    observations: [],
  } as unknown as JMATsunami
}

/** 沖合の津波観測に関する情報。観測点は津波予報区を持たない。 */
function makeOffshoreReport(names: string[], id: string): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    eventId: EVENT_ID,
    time: '2026-04-20T08:10:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-04-20T08:10:00Z', type: 'Focus' },
    infoName: '沖合の津波観測に関する情報',
    areas: [],
    observations: names.map(n => ({ name: n, offshore: true })),
  } as unknown as JMATsunami
}

/** 解除（全区域が解除）。 */
function makeCancelReport(id: string): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    eventId: EVENT_ID,
    time: '2026-04-20T09:00:00Z',
    cancelled: true,
    cancelReason: 'cleared',
    issue: { source: 'JMA', time: '2026-04-20T09:00:00Z', type: 'Focus' },
    areas: [],
    observations: [],
  } as unknown as JMATsunami
}

const AREAS_WARNING = [
  { name: '岩手県', code: '221', grade: 'Warning' },
  { name: '宮城県', code: '222', grade: 'Watch' },
]

function setup(displayed: JMATsunami[] = []) {
  const settings = {
    // **読み上げは無効にする。** 有効だと受信時スクロールが猶予を待つ経路へ入り、
    // このテストが見たい「要求の中身」とは別の分岐が混ざる。
    voicevoxEnabled: false, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: 2, ttsMaxRegions: 10, ttsAlwaysReadScale: 30, ttsRegionTolerance: 2,
    minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
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
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(), openEstimatedIntensity: vi.fn(),
  } as never))
  return result
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('寄せ先が無い受信で先頭へ戻すかどうか', () => {
  it('正: 満潮時刻の報では先頭へ戻さない', () => {
    const displayed: JMATsunami[] = []
    const h = setup(displayed)
    act(() => { h.current.handleLiveEvent(makeGradeReport(AREAS_WARNING, 't1') as never) })
    displayed[0] = makeGradeReport(AREAS_WARNING, 't1')

    act(() => { h.current.handleLiveEvent(makeHighTideReport(AREAS_WARNING, 't2') as never) })

    // 寄せ先は無い（観測点も等級の変化も無い）が、位置を捨てる理由も無い
    expect(h.current.focusedDistrict?.districts).toEqual([])
    expect(h.current.focusedDistrict?.resetToTop).toBe(false)
  })

  it('正: 沖合の観測情報では、寄せ先が空でも先頭へ戻さない', () => {
    const displayed: JMATsunami[] = []
    const h = setup(displayed)
    act(() => { h.current.handleLiveEvent(makeGradeReport(AREAS_WARNING, 't1') as never) })
    displayed[0] = makeGradeReport(AREAS_WARNING, 't1')

    act(() => { h.current.handleLiveEvent(makeOffshoreReport(['岩手沖６０ｋｍＡ'], 't2') as never) })

    // 新しい観測点はあるが、沖合の観測点は津波予報区を持たないため寄せ先が作れない
    expect(h.current.focusedDistrict?.districts).toEqual([])
    expect(h.current.focusedDistrict?.resetToTop).toBe(false)
  })

  it('対照: 新規発報では先頭へ戻す', () => {
    const h = setup([])
    act(() => { h.current.handleLiveEvent(makeGradeReport(AREAS_WARNING, 't1') as never) })

    expect(h.current.focusedDistrict?.districts).toEqual([])
    expect(h.current.focusedDistrict?.resetToTop).toBe(true)
  })

  it('対照: 等級が下がった報（観測点なし）でも先頭へ戻す', () => {
    // 新規発報と同じ枝だが、**前報の等級がある状態からの変化**はそこを通っていない。
    // 最上位の区域群が入れ替わるので、カードの先頭から見せ直すのが正しい。
    const displayed: JMATsunami[] = []
    const h = setup(displayed)
    act(() => { h.current.handleLiveEvent(makeGradeReport(AREAS_WARNING, 't1') as never) })
    displayed[0] = makeGradeReport(AREAS_WARNING, 't1')

    const downgraded = [
      { name: '岩手県', code: '221', grade: 'Watch' },
      { name: '宮城県', code: '222', grade: 'Watch' },
    ]
    act(() => { h.current.handleLiveEvent(makeGradeReport(downgraded, 't2') as never) })

    expect(h.current.focusedDistrict?.districts).toEqual([])
    expect(h.current.focusedDistrict?.resetToTop).toBe(true)
  })

  it('対照: 解除では先頭へ戻す', () => {
    const displayed: JMATsunami[] = []
    const h = setup(displayed)
    act(() => { h.current.handleLiveEvent(makeGradeReport(AREAS_WARNING, 't1') as never) })
    displayed[0] = makeGradeReport(AREAS_WARNING, 't1')

    act(() => { h.current.handleLiveEvent(makeCancelReport('t2') as never) })

    expect(h.current.focusedDistrict?.districts).toEqual([])
    expect(h.current.focusedDistrict?.resetToTop).toBe(true)
  })

  it('安全弁: 寄せ先がある受信は従来どおり区域へ寄せる（先頭へは戻さない）', () => {
    const displayed: JMATsunami[] = []
    const h = setup(displayed)
    act(() => { h.current.handleLiveEvent(makeGradeReport(AREAS_WARNING, 't1') as never) })
    displayed[0] = makeGradeReport(AREAS_WARNING, 't1')

    // 等級は変えず、区域に紐づく観測点に波高が付いた続報
    const obs = {
      ...makeHighTideReport(AREAS_WARNING, 't2'),
      infoName: '津波観測に関する情報',
      observations: [{
        name: '宮古', districtCode: '221', districtName: '岩手県',
        height: { value: 0.4, description: '0.4m' },
      }],
    } as unknown as JMATsunami
    act(() => { h.current.handleLiveEvent(obs as never) })

    expect(h.current.focusedDistrict?.districts).toEqual([{ code: '221', name: '岩手県' }])
    expect(h.current.focusedDistrict?.resetToTop).toBe(false)
  })
})
