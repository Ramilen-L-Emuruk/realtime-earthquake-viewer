// @vitest-environment jsdom
//
// 津波の解除・取消・失効を受けたとき、**受信処理はウィンドウタイトルに触れない**ことを固定する。
//
// 終わったことをタイトルへ出す（「津波予報 失効」など。2026-10-12 ユーザー承認）のは App の解除の検出で、
// 画面の状態だけを見て決める（`findEndedTsunami`）。受信処理がここで出そうとすると、「この解除は画面に
// 出ている津波に向いているか」を受信処理の記憶と画面の記憶から推し量り直すことになり、両者が食い違う形
// （同じ tick に捌けた・起動時の取り直しで画面へ黙って入った）で、続いている津波の最中に「解除」と名乗る。
// どの津波に向いた解除かは画面の更新（`useEarthquakes` の津波の分岐）が既に決めている。
//
// 既存の受信テストの title は何でも受ける Proxy なので、呼ばれたかどうかを見ていなかった。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, TsunamiArea } from '../types/earthquake'

vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: vi.fn(() => Promise.resolve({ spoke: true, spokenChunks: [] })),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const ISSUED = '2024-01-02T10:00:00+09:00'

function makeReport(eventId: string, id: string): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    eventId,
    time: ISSUED,
    cancelled: false,
    issue: { source: 'JMA', time: ISSUED, type: 'Focus' },
    areas: [{ name: '石川県能登', code: '360', grade: 'Forecast', immediate: false } as TsunamiArea],
  } as JMATsunami
}

function cancelOf(t: JMATsunami, cancelReason: JMATsunami['cancelReason']): JMATsunami {
  return { ...t, id: `${t.id}-cancel`, cancelled: true, cancelReason } as JMATsunami
}

function setup() {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: false, soundEnabled: false, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
  } as unknown as AppSettings
  // タイトルの関数だけを見張る（他のメソッドは何を呼ばれても無害に受ける）
  const titleCalls: string[] = []
  const watched = new Set([
    'setTitle', 'setOngoingTitle', 'applyPriority', 'showTsunamiTitle', 'showTsunamiEndTitle',
    'endTsunamiTitleWindow', 'scheduleTitleRevert', 'clearTitleTimer',
  ])
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => {
      if (k in t) return t[k as string]
      return (...args: unknown[]) => { if (watched.has(String(k))) titleCalls.push(String(k)); void args }
    },
  })
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
    quakeSpeakingCard: null,
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  const receive = (t: JMATsunami) => { act(() => { result.current.handleLiveEvent(t as never) }) }
  return { titleCalls, receive, displayed }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('津波の解除を受けたとき、受信処理はタイトルに触れない', () => {
  // 安全弁: 発表中の津波への失効（本題の経路）。タイトルは App の解除の検出が出す
  it('発表中の津波の失効で、タイトルの関数を 1 つも呼ばない', () => {
    const { titleCalls, receive, displayed } = setup()
    const t = makeReport('20240101161010', 'tsunami-1')
    receive(t)
    displayed[0] = t
    titleCalls.length = 0
    receive(cancelOf(t, 'expired'))
    expect(titleCalls).toEqual([])
  })

  // 安全弁: 別の津波が続いているときの遅れた解除。続いている津波のタイトルを閉じない
  // （以前はここで表示ウィンドウを閉じていたので、「一定時間に制限」の端末では既定へ戻っていた）
  it('別の津波への遅れた解除で、タイトルの関数を 1 つも呼ばない', () => {
    const { titleCalls, receive, displayed } = setup()
    const current = makeReport('20240102100000', 'tsunami-2')
    receive(current)
    displayed[0] = current
    titleCalls.length = 0
    receive(cancelOf(makeReport('20240101161010', 'tsunami-1'), 'lifted'))
    expect(titleCalls).toEqual([])
  })

  // 安全弁: 受信処理の記憶と画面が食い違う形（起動時の取り直しで、画面へ黙って別の津波が入った）
  it('受信処理の記憶と画面の津波が食い違っても、タイトルの関数を 1 つも呼ばない', () => {
    const { titleCalls, receive, displayed } = setup()
    const old = makeReport('20240101161010', 'tsunami-1')
    receive(old)
    displayed[0] = makeReport('20240102100000', 'tsunami-2')
    titleCalls.length = 0
    receive(cancelOf(old, 'lifted'))
    expect(titleCalls).toEqual([])
  })

  // 対照: 発表の報では従来どおりタイトルを出す（見張りが働いていることの確かめ）
  it('発表の報では発表中のタイトルを出す', () => {
    const { titleCalls, receive } = setup()
    receive(makeReport('20240101161010', 'tsunami-1'))
    expect(titleCalls).toContain('showTsunamiTitle')
  })
})
