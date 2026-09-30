// 「値が来ていない」の判定の回帰テスト。
//
// 固定するのは 3 つ ——**一度も来ていない**を「途絶えた」へ倒さないこと・境界が
// 閾値ちょうどで倒れること・**時刻が巻き戻っても倒れない**こと。
//
// 1 つ目がいちばん重い。購読を始めた直後は必ずここを通るので、混ぜると
// **繋いだ瞬間に「値が来ていない」と名乗る**（→ `seismoSilence.ts` の `never`）。

import { describe, it, expect } from 'vitest'
import { judgeSilence } from './seismoSilence'

/** 5 秒。**実際に渡される値と同じ桁**（`READING_STALE_MS`・`WAVE_STALE_MS` が 5000）。 */
const STALE_MS = 5000

describe('judgeSilence', () => {
  it('正: 閾値を超えて何も来なければ「途絶えた」', () => {
    const result = judgeSilence({
      lastReceivedAt: 1000,
      now: 1000 + STALE_MS + 1,
      staleMs: STALE_MS,
    })
    expect(result).toEqual({ kind: 'silent', forMs: STALE_MS + 1 })
  })

  it('対照: 閾値の手前では「来ている」', () => {
    const result = judgeSilence({
      lastReceivedAt: 1000,
      now: 1000 + STALE_MS - 1,
      staleMs: STALE_MS,
    })
    expect(result).toEqual({ kind: 'flowing' })
  })

  it('境界: 閾値ちょうどで「途絶えた」へ倒れる', () => {
    // **既存の判定が `>=` で倒していた**のに合わせる（`useSeismoStation` の `waveStale` は
    // `now - waveReceivedAt >= WAVE_STALE_MS`）。ここを `>` にすると、あちらを置き換えた
    // 瞬間に 1 ms だけ判定がずれる。
    const result = judgeSilence({ lastReceivedAt: 1000, now: 1000 + STALE_MS, staleMs: STALE_MS })
    expect(result).toEqual({ kind: 'silent', forMs: STALE_MS })
  })

  it('安全弁: 一度も来ていなければ、どれだけ経っても「途絶えた」にしない', () => {
    // **購読を始めた直後が必ずこの形。** ここが `silent` へ倒れると、繋いだ瞬間から
    // 画面が「値が来ていない」と名乗り続ける。
    const result = judgeSilence({ lastReceivedAt: null, now: 9_999_999, staleMs: STALE_MS })
    expect(result).toEqual({ kind: 'never' })
  })

  it('安全弁: 時刻が巻き戻っても「途絶えた」にしない', () => {
    // **`serverNow()` は較正で跳ねる**（`utils/clock.ts`）。未来の時刻を最後の受信として
    // 持っている間に「途絶えた」と出すと、時計が直った拍子に赤が消える —— 揺れとも
    // 障害とも関わりのない理由で画面が動く。
    const result = judgeSilence({ lastReceivedAt: 10_000, now: 1000, staleMs: STALE_MS })
    expect(result).toEqual({ kind: 'flowing' })
  })

  it('経過は最後の受信からの実測を返す（記録へ添えるため）', () => {
    const result = judgeSilence({ lastReceivedAt: 0, now: 43_000, staleMs: STALE_MS })
    expect(result).toEqual({ kind: 'silent', forMs: 43_000 })
  })
})
