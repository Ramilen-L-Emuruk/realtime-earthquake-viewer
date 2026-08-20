// @vitest-environment jsdom
//
// アプリ時計の較正状態のテスト。
//
// 見るのは「較正されているか」と「その較正がいつのものか」の 2 つ。後者（鮮度）を取り違えると、
// 較正が止まっているのに値だけは返る状態を「正常」と読んでしまう。診断ログはこの区別に依存して
// いるため、壊れてもユーザーには見えない一方で、障害の切り分けを静かに誤らせる。
//
// visibilitychange を扱うため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  feedServerSample,
  getServerClockOffsetMs,
  getServerClockSampleAgeMs,
  serverNow,
  setReplayOffset,
} from './clock'

// 未較正フォールバックの警告を黙らせる（console を潰すと本物の異常が見えなくなるためロガー側を差し替える）。
vi.mock('./logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** タブ復帰を模す。 */
function fireVisible() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('サーバー時刻の較正状態', () => {
  beforeEach(() => {
    setReplayOffset(null)
    // 各テストを未較正から始める。K の破棄経路（タブ復帰）を使う。
    fireVisible()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    setReplayOffset(null)
    vi.restoreAllMocks()
  })

  it('較正前は オフセットも鮮度も null（壁時計フォールバック中であることが分かる）', () => {
    expect(getServerClockOffsetMs()).toBeNull()
    expect(getServerClockSampleAgeMs()).toBeNull()
  })

  it('サンプルを与えると較正され、鮮度が返るようになる', () => {
    feedServerSample(Date.now() + 500)

    expect(getServerClockOffsetMs()).not.toBeNull()
    const age = getServerClockSampleAgeMs()
    expect(age).not.toBeNull()
    expect(age).toBeLessThan(1000)
  })

  it('鮮度は時間の経過とともに増える（止まった較正を見分けられる）', async () => {
    feedServerSample(Date.now())
    const first = getServerClockSampleAgeMs()!

    // performance.now() を進める。壁時計ではなく単調時計を基準にしているため。
    const base = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(base + 5000)

    expect(getServerClockSampleAgeMs()!).toBeGreaterThanOrEqual(first + 4000)
  })

  it('タブ復帰で K を捨てるとき、鮮度も一緒に捨てる', () => {
    feedServerSample(Date.now())
    expect(getServerClockSampleAgeMs()).not.toBeNull()

    fireVisible()

    // 片方だけ残ると「未較正なのに直近で較正済み」と読める矛盾した診断になる。
    expect(getServerClockOffsetMs()).toBeNull()
    expect(getServerClockSampleAgeMs()).toBeNull()
  })

  it('リプレイ中はサンプルを受け付けない（アーカイブ時刻で K を汚さない）', () => {
    setReplayOffset(-3600_000)
    feedServerSample(Date.now())

    expect(getServerClockSampleAgeMs()).toBeNull()
    // リプレイ中の serverNow はオフセット適用の壁時計。
    expect(serverNow()).toBeLessThan(Date.now())
  })

  it('有限でない値は較正に使わない', () => {
    feedServerSample(Number.NaN)
    expect(getServerClockSampleAgeMs()).toBeNull()

    feedServerSample(Number.POSITIVE_INFINITY)
    expect(getServerClockSampleAgeMs()).toBeNull()
  })
})
