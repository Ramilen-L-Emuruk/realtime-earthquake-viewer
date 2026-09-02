// @vitest-environment jsdom
//
// 揺れ検知の診断記録を「保存するかどうか」を固定するテスト。
//
// 録画モードでは保存を止める（IndexedDB への書き込みと、上限を超えたときの読み戻しが
// 地震の最中に集中するため）。**止めるのは保存だけで、前後の切り出しは通したまま**という
// ところが要点で、ここを一緒に止めると録画モードを解いた直後の検知で前側が欠ける。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { initGates } from '../utils/kyoshinDetector'
import type { DetectionEvent } from '../utils/kyoshinDetector'

const saveRecord = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../utils/detectionDiagnosticsDb', () => ({ saveRecord }))

import { useDetectionDiagnostics } from './useDetectionDiagnostics'

const SITES: [number, number][] = [
  [35.0, 139.0],
  [35.1, 139.1],
]
const INDICES = [7, 6]

/** 画面に出る検知（confirmed）1 件。記録を開かせるのに要る分だけ埋める。 */
const DETECTION = {
  id: 'evt-1',
  confidence: 'confirmed',
  memberKeys: [],
  maxIntensity: 3.2,
  lastSize: 4,
  epicenter: [35.05, 139.05],
  gates: initGates(),
  confirmedBy: null,
} as unknown as DetectionEvent

/** 保存の鎖（`persist` の Promise チェーン）が回るまで待つ。 */
function flushChain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function mount(enabled: boolean) {
  return renderHook(() =>
    useDetectionDiagnostics(
      [DETECTION],
      SITES,
      INDICES,
      '2026-09-02T00:00:00.000Z',
      '20260123000000',
      enabled,
    ),
  )
}

describe('useDetectionDiagnostics の保存', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '0.0.0-test')
    saveRecord.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('正: 通常は記録を保存する', async () => {
    // アンマウント（画面を閉じる相当）で、開いている記録が後ろ側の足りないまま確定する
    mount(true).unmount()
    await flushChain()
    expect(saveRecord).toHaveBeenCalled()
  })

  it('対照: 録画モードでは保存しない', async () => {
    mount(false).unmount()
    await flushChain()
    expect(saveRecord).not.toHaveBeenCalled()
  })

  it('安全弁: 録画モードを解けばまた保存する（止めているのは保存だけ）', async () => {
    mount(false).unmount()
    await flushChain()
    expect(saveRecord).not.toHaveBeenCalled()

    mount(true).unmount()
    await flushChain()
    expect(saveRecord).toHaveBeenCalled()
  })
})
