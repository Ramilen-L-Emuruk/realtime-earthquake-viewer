import { describe, it, expect } from 'vitest'
import { hasPendingEewSpeech, type EewPendingSpeechSources } from './eewPendingSpeech'

/** 何も予定が無い状態。テストごとに 1 つだけ埋めて確かめる。 */
function emptySources(): EewPendingSpeechSources {
  return {
    phase1: new Map(),
    warningRegions: new Map(),
    phase2: new Map(),
    scaleStability: new Map(),
    lpgmStability: new Map(),
    forecastMaxWait: new Map(),
    cancelSpeech: new Set(),
  }
}

/**
 * 「どれか 1 つに載っていれば真」を確かめるための、項目ごとの埋め方。
 *
 * **1 つずつ確かめる。** まとめて埋めると、どれか 1 つを式から落としても他が真を返して
 * 気づけない —— 落ちた項目に対応する予約だけが「語り残し」として数えられなくなり、
 * その段のあいだに印が消える。
 */
const FILLERS: { name: string; fill: (s: EewPendingSpeechSources, key: string) => void }[] = [
  { name: '第 1 フェーズの予約', fill: (s, k) => { (s.phase1 as Map<string, unknown>).set(k, {}) } },
  { name: '警報の対象地方の予約', fill: (s, k) => { (s.warningRegions as Map<string, unknown>).set(k, {}) } },
  { name: '第 2 フェーズの予約', fill: (s, k) => { (s.phase2 as Map<string, unknown>).set(k, {}) } },
  { name: '震度の安定待ち', fill: (s, k) => { (s.scaleStability as Map<string, unknown>).set(k, {}) } },
  { name: '長周期地震動階級の安定待ち', fill: (s, k) => { (s.lpgmStability as Map<string, unknown>).set(k, {}) } },
  { name: '予想震度を待つ上限', fill: (s, k) => { (s.forecastMaxWait as Map<string, unknown>).set(k, {}) } },
  { name: '誤報取消の読み上げの予約', fill: (s, k) => { (s.cancelSpeech as Set<string>).add(k) } },
]

describe('まだ声にする予定が残っているか（hasPendingEewSpeech）', () => {
  // 対照: どこにも載っていなければ偽。
  it('どの予約にも載っていなければ偽', () => {
    expect(hasPendingEewSpeech('A', emptySources())).toBe(false)
  })

  // 正: 7 つのどれか 1 つに載っていれば真。**1 つずつ確かめる**（上の FILLERS の説明）。
  for (const { name, fill } of FILLERS) {
    it(`${name}だけがあっても真`, () => {
      const s = emptySources()
      fill(s, 'A')
      expect(hasPendingEewSpeech('A', s)).toBe(true)
    })
  }

  // **対照（この述語の要）: 判定は eventId ごと。**
  //
  // `speechBlocker` も似た判定を持つが、あちらは「いま非 EEW を始めてよいか」を全 EEW 横断
  // （`.size > 0`）で見るもの。こちらを同じ形にすると、語り終わった地震の印が**別の地震の
  // 待ちが明けるまで**消えない。**式を `.size > 0` へ書き換えたらここが落ちる。**
  for (const { name, fill } of FILLERS) {
    it(`${name}が別の地震のものなら偽`, () => {
      const s = emptySources()
      fill(s, 'B')
      expect(hasPendingEewSpeech('A', s)).toBe(false)
    })
  }
})
