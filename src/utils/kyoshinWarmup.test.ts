// 助走をどこまで遡るかの規則（utils/kyoshinWarmup）のテスト。
//
// ここで固定するのは「静穏と認める水準」と「穴で切る位置」の 2 つ。どちらも実データの測定から
// 決めた値で、動かすと助走の効きが変わる（根拠は kyoshinWarmup.ts のコメント）。
import { describe, it, expect } from 'vitest'
import {
  isQuietFrame,
  firstContinuousIndex,
  WARMUP_QUIET_MAX_POINTS,
} from './kyoshinWarmup'
import { PARAMS } from './kyoshinDetector'

/** value = -3.0 + index * 0.5。value 0.5 は index 7、value 0.0 は index 6。 */
const INDEX_AT_QUIET_THRESHOLD = 7
const INDEX_BELOW_QUIET_THRESHOLD = 6

/** `count` 点だけしきい値以上、残りはそれ未満のフレームを作る。 */
function frameWith(count: number, total = 1000): number[] {
  const out = new Array<number>(total).fill(INDEX_BELOW_QUIET_THRESHOLD)
  for (let i = 0; i < count; i++) out[i] = INDEX_AT_QUIET_THRESHOLD
  return out
}

describe('isQuietFrame: 助走をここまで遡れば十分か', () => {
  it('正: しきい値以上の観測点が上限未満なら静穏', () => {
    expect(isQuietFrame(frameWith(WARMUP_QUIET_MAX_POINTS - 1))).toBe(true)
  })

  it('対照: 上限ちょうどに達したら静穏ではない（まだ遡る）', () => {
    expect(isQuietFrame(frameWith(WARMUP_QUIET_MAX_POINTS))).toBe(false)
  })

  it('安全弁: 欠測（負のインデックス）は数えない', () => {
    // 欠測は「揺れていない証拠」にならないが「揺れている証拠」にもならない。数に入れると、
    // 観測点が落ちているだけの時間帯を「揺れている」と読んで際限なく遡る。
    const values = new Array<number>(1000).fill(-1)
    expect(isQuietFrame(values)).toBe(true)
  })

  it('安全弁: しきい値未満の点がいくら並んでも静穏のまま', () => {
    expect(isQuietFrame(new Array<number>(2000).fill(INDEX_BELOW_QUIET_THRESHOLD))).toBe(true)
  })
})

describe('firstContinuousIndex: 助走に使える連続区間', () => {
  const GAP = PARAMS.MAX_DT_GAP_MS

  it('正: 穴が無ければ先頭から使える', () => {
    const t = [0, 1000, 2000, 3000]
    expect(firstContinuousIndex(t)).toBe(0)
  })

  it('対照: 検知エンジンが不連続とみなす幅を超える穴があれば、その後ろから使う', () => {
    // 穴より前を食わせても、検知エンジンが状態を作り直して捨てるだけ。
    const t = [0, 1000, 1000 + GAP + 1000, 1000 + GAP + 2000]
    expect(firstContinuousIndex(t)).toBe(2)
  })

  it('対照: 不連続とみなす幅ちょうどなら切らない（超えたときだけ切る）', () => {
    const t = [0, 1000, 1000 + GAP, 2000 + GAP]
    expect(firstContinuousIndex(t)).toBe(0)
  })

  it('安全弁: 穴が複数あれば最後の穴より後ろだけを使う', () => {
    const t = [0, GAP * 2, GAP * 4, GAP * 4 + 1000]
    expect(firstContinuousIndex(t)).toBe(2)
  })

  it('安全弁: 空でも落ちない', () => {
    expect(firstContinuousIndex([])).toBe(0)
  })
})
