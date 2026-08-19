// @vitest-environment jsdom
//
// useKyoshinDetectorV2 の「結線」のテスト。検知そのものは kyoshinDetector.test.ts で見ているため、
// ここで見るのは React ラッパーが持つ 2 つの守り:
//   1. 観測点集合が変わったことを取りこぼさないか（近傍メタのキャッシュ判定）
//   2. step() が壊れ続けたときに、凍結した結果を表示に流し続けないか
// どちらも「静かに劣化する」タイプの問題で、検知コアの単体テストでは捉えられない。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { siteSignature, STEP_FAIL_RESET_FRAMES, useKyoshinDetectorV2 } from './useKyoshinDetectorV2'
import * as detector from '../utils/kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'

describe('siteSignature: 観測点集合の変化を取りこぼさない', () => {
  it('点数・先頭・末尾が同じでも、中間が差し替わればシグネチャが変わる', () => {
    // 以前は「点数＋先頭・末尾座標」だけで判定していたため、この差し替えを検知できなかった。
    // 検知できないと古い近傍メタ（＝観測点キーの割り当て）を使い続け、表示側が毎回作り直す
    // キーとずれる（座標が重複する観測点で `#2` の割り当て順が変わりうる）。
    const before: SiteCoords = [[35.0, 139.0], [36.0, 140.0], [37.0, 141.0]]
    const after: SiteCoords = [[35.0, 139.0], [36.5, 140.5], [37.0, 141.0]]
    expect(siteSignature(before)).not.toBe(siteSignature(after))
  })

  it('同じ内容なら別配列でも同じシグネチャ（無駄な近傍メタ再構築を避ける）', () => {
    const a: SiteCoords = [[35.0, 139.0], [36.0, 140.0]]
    const b: SiteCoords = [[35.0, 139.0], [36.0, 140.0]]
    expect(siteSignature(a)).toBe(siteSignature(b))
  })

  it('空配列は空文字', () => {
    expect(siteSignature([])).toBe('')
  })

  it('座標の丸め単位（約100m）より細かい違いは同一とみなす', () => {
    // siteKey は小数第3位で丸める。sitelist 更新時の丸め誤差で別集合と誤判定しないため。
    const a: SiteCoords = [[35.00001, 139.00001]]
    const b: SiteCoords = [[35.00002, 139.00002]]
    expect(siteSignature(a)).toBe(siteSignature(b))
  })
})

describe('useKyoshinDetectorV2: step() が壊れ続けたら検知結果を空にする', () => {
  const sites: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
  const indices = [12, 12, 12]

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  /** dataTime を進めながらフックを再レンダーする（step() は dataTime 更新でのみ走る）。 */
  function driveFrames(count: number, startMs = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    const { result, rerender } = renderHook(
      ({ t }: { t: string }) => useKyoshinDetectorV2(sites, indices, t, 'cfg', 'cfg', true, false),
      { initialProps: { t: new Date(startMs).toISOString() } },
    )
    for (let i = 1; i < count; i++) {
      rerender({ t: new Date(startMs + i * 1000).toISOString() })
    }
    return result
  }

  it('連続失敗が閾値に達したら detections と recentOnsetKeys を空にする', () => {
    const spy = vi.spyOn(detector, 'step').mockImplementation(() => {
      throw new Error('boom')
    })
    const result = driveFrames(STEP_FAIL_RESET_FRAMES + 1)
    expect(spy).toHaveBeenCalled()
    expect(result.current.detections).toEqual([])
    expect(result.current.recentOnsetKeys.size).toBe(0)
  })

  it('閾値に達する前の一過性の失敗では直前の結果を保持する（明滅させない）', () => {
    const real = detector.step
    let calls = 0
    vi.spyOn(detector, 'step').mockImplementation((state, frame, meta) => {
      calls++
      // 1フレーム目は成功させて結果を持たせ、以降は閾値未満だけ失敗させる
      if (calls === 1) return real(state, frame, meta)
      throw new Error('boom')
    })
    const result = driveFrames(STEP_FAIL_RESET_FRAMES)
    // 1回成功 → (閾値-1)回失敗。まだリセットされないため dataTime は保持されている
    expect(result.current.dataTime).not.toBe('')
  })
})

describe('useKyoshinDetectorV2: 近傍メタのキャッシュ判定', () => {
  const indices = [12, 12, 12]

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  /** sites も差し替えられるハーネス。dataTime を進めて step() を走らせる。 */
  function drive(frames: { sites: SiteCoords; t: string }[]) {
    const { rerender } = renderHook(
      ({ sites, t }: { sites: SiteCoords; t: string }) =>
        useKyoshinDetectorV2(sites, indices, t, 'cfg', 'cfg', true, false),
      { initialProps: frames[0] },
    )
    for (const f of frames.slice(1)) rerender(f)
  }

  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()

  it('同じ内容の別配列では近傍メタを組み直さない（O(点数²) を走らせない）', () => {
    const spy = vi.spyOn(detector, 'buildStationMeta')
    const a: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
    const b: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]] // 同内容・別参照
    drive([{ sites: a, t: at(0) }, { sites: b, t: at(1) }])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('点数・先頭・末尾が同じでも中間が差し替わったら組み直す', () => {
    // 以前の簡易シグネチャ（点数＋先頭・末尾）はこの差し替えを取りこぼしていた。
    const spy = vi.spyOn(detector, 'buildStationMeta')
    const a: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
    const b: SiteCoords = [[35.0, 139.0], [36.5, 140.5], [35.2, 139.2]]
    drive([{ sites: a, t: at(0) }, { sites: b, t: at(1) }])
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
