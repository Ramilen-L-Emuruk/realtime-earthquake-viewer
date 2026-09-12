// @vitest-environment jsdom
//
// リプレイの開始・停止で、別地点発報のエピソード状態を落とすことのテスト。
//
// 「別の地点で揺れを検知」は、一度鳴らした地域に「発報済み」の印を立てて二度鳴らさない。この印は
// 時間軸に紐づく（前の再生で鳴らしたことは、次の再生とは関係がない）。純関数側は時刻の巻き戻りで
// エピソードを切り替えるが、**それは時刻が後退したときだけ**で、前へ飛ばした切替では発火しない。
// 3 秒（`REGION_PRUNE_MS`）で地域が刈られるため実害が出る窓は狭いが、残れば新しい時間軸で鳴るべき
// 発報が黙って抑え込まれる（例外もログも出ない）。
//
// ここで固定するのは 3 つ。
//   1. 正: リセットの後なら、同じ地域で再び別地点発報が鳴る
//   2. 対照: リセットしなければ鳴らない（印が抑制していることの対比）
//   3. 安全弁: リセットは進行中の検知そのものを消さない（呼んだだけで画面・音が動かない）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKyoshinAlerts, type KyoshinAlertsDeps } from './useKyoshinAlerts'
import { playAlertSound } from '../utils/alertSound'
import { showBrowserNotification } from '../utils/notifications'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'

vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn(), playKyoshinUpdateSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const NOTO = { lat: 37.5, lng: 137.0, index: 20, peak: { lat: 37.45, lng: 137.15 } }
// 能登から約 700km。別地点として扱われる距離。
const FUKUOKA = { lat: 33.6, lng: 130.4, index: 20, peak: { lat: 33.58, lng: 130.35 } }

const T0 = Date.UTC(2024, 0, 1, 7, 10, 0)
const iso = (ms: number) => new Date(ms).toISOString()

function makeDeps(over: Partial<KyoshinAlertsDeps> = {}): KyoshinAlertsDeps {
  return {
    confirmed: false,
    candidate: false,
    candidateMaxIndex: 0,
    confirmedShocks: [],
    dataTime: '',
    stalled: false,
    settings: { soundEnabled: true, notifyMinScale: 0, notifyDetection: true } as unknown as AppSettings,
    title: { setTitle: vi.fn(), applyPriority: vi.fn() } as unknown as AlertTitleApi,
    activeEEWsRef: { current: new Map<string, EEWAlert>() },
    defaultTabRef: { current: 'earthquake' as TabId },
    setActiveTab: vi.fn(),
    revertToDefaultTab: vi.fn(),
    onShakeFocus: vi.fn(),
    ...over,
  }
}

describe('useKyoshinAlerts: リプレイの切替で別地点発報の記憶を落とす', () => {
  beforeEach(() => {
    vi.mocked(playAlertSound).mockClear()
    vi.mocked(showBrowserNotification).mockClear()
  })

  /**
   * 能登で検知が始まり、福岡が遅れて加わって別地点発報に至るまでを流す。
   *
   * `stepAlertRegions` は「登録 → 持続 → 発報」と数フレームかけるので、その分だけ進める。
   * 戻り値の `at` は最後に流したデータ時刻（続きを流すときの起点）。
   */
  function driveToFarAlert(
    rerender: (p: KyoshinAlertsDeps) => void,
    startMs: number,
  ): { at: number } {
    rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: iso(startMs) }))
    for (let i = 1; i <= 3; i++) {
      rerender(makeDeps({
        confirmed: true,
        confirmedShocks: [NOTO, FUKUOKA],
        dataTime: iso(startMs + i * 1000),
      }))
    }
    return { at: startMs + 3000 }
  }

  it('[正] リセットの後なら、同じ地域で別地点発報がもう一度鳴る', () => {
    const { result, rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps(),
    })
    const first = driveToFarAlert(rerender, T0)
    expect(playAlertSound).toHaveBeenCalledWith('kyoshin')

    // 時間軸を切り替えた（リプレイの開始・停止）。**時刻は前へ進める** —— 巻き戻しなら
    // 純関数側の切り替えが働くので、この経路の検証にならない。
    act(() => { result.current.resetForReplay() })
    vi.mocked(playAlertSound).mockClear()
    vi.mocked(showBrowserNotification).mockClear()

    // 前へ飛ばす幅は `REGION_PRUNE_MS`（3 秒）より短く取る。3 秒を超えると旧い地域が自然に
    // 刈られて、リセットの有無に関わらず鳴ってしまう（下の対照が成立しなくなる）。
    // **実害が出る窓が狭いのはこのため**だが、狭いだけで無くはない。
    driveToFarAlert(rerender, first.at + 1000)
    expect(playAlertSound).toHaveBeenCalledWith('kyoshin')
    expect(showBrowserNotification).toHaveBeenCalled()
  })

  it('[対照] リセットしなければ鳴らない（発報済みの印が抑制していることの対比）', () => {
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps(),
    })
    const first = driveToFarAlert(rerender, T0)
    expect(playAlertSound).toHaveBeenCalledWith('kyoshin')

    vi.mocked(playAlertSound).mockClear()
    vi.mocked(showBrowserNotification).mockClear()

    // 正のテストと同じ幅で流す。違うのはリセットを挟んだかどうかだけ。
    driveToFarAlert(rerender, first.at + 1000)
    expect(playAlertSound).not.toHaveBeenCalled()
    expect(showBrowserNotification).not.toHaveBeenCalled()
  })

  it('[安全弁] リセットを呼ぶだけでは、画面も音も動かない', () => {
    const setActiveTab = vi.fn()
    const revertToDefaultTab = vi.fn()
    const { result, rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ setActiveTab, revertToDefaultTab }),
    })
    rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: iso(T0), setActiveTab, revertToDefaultTab }))
    vi.mocked(playAlertSound).mockClear()
    setActiveTab.mockClear()
    revertToDefaultTab.mockClear()

    act(() => { result.current.resetForReplay() })

    expect(playAlertSound).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revertToDefaultTab).not.toHaveBeenCalled()
  })
})
