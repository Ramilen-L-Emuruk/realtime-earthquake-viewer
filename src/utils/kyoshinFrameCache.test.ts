// 強震モニタの秒フレームの控えの挙動を固定する。
//
// 守りたいのは「同じ秒を取り直さない」こと。ただし残しすぎない・並べ替えずに追い出す・
// 助走が欲しがる範囲を割らないことも同時に要る。
import { describe, it, expect } from 'vitest'
import { createKyoshinFrameCache, MAX_FRAMES } from './kyoshinFrameCache'
// 上限の下限保証を**助走の定数から導く**ために読む（数字を写すと助走を伸ばしたとき無反応になる）
import { WARMUP_BLOCK_SEC, WARMUP_MAX_BLOCKS } from './kyoshinWarmup'

function frame(intensity: string) {
  return { dataTime: '2024-01-01T16:16:29', siteConfigId: '20220301000000', intensity, hypoInfo: [] }
}

describe('createKyoshinFrameCache', () => {
  // 正
  it('控えたものを鍵で引ける', () => {
    const cache = createKyoshinFrameCache()
    cache.set('20240101/20240101161629', frame('abc'))

    expect(cache.get('20240101/20240101161629')?.intensity).toBe('abc')
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 0, entries: 1 })
  })

  // 対照
  it('控えていない鍵は無い（miss として数える）', () => {
    const cache = createKyoshinFrameCache()
    expect(cache.get('20240101/20240101161630')).toBeUndefined()
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1 })
  })

  // 安全弁: 上限を超えたら古い順に追い出す
  it('上限を超えると、いちばん古く使ったものから追い出す', () => {
    const cache = createKyoshinFrameCache({ maxFrames: 3 })
    cache.set('a', frame('a'))
    cache.set('b', frame('b'))
    cache.set('c', frame('c'))
    // a を読んで新しくする → 追い出されるのは b
    cache.get('a')
    cache.set('d', frame('d'))

    expect(cache.stats().entries).toBe(3)
    expect(cache.get('a')?.intensity).toBe('a')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')?.intensity).toBe('c')
    expect(cache.get('d')?.intensity).toBe('d')
    expect(cache.stats().evicted).toBe(1)
  })

  // 安全弁: 同じ鍵の入れ直しで件数が増えない・古い位置に取り残されない
  it('同じ鍵を入れ直しても件数は増えず、新しいものとして扱われる', () => {
    const cache = createKyoshinFrameCache({ maxFrames: 2 })
    cache.set('a', frame('a1'))
    cache.set('b', frame('b'))
    // a を入れ直す → a が末尾へ。次に足すと追い出されるのは b
    cache.set('a', frame('a2'))
    cache.set('c', frame('c'))

    expect(cache.stats().entries).toBe(2)
    expect(cache.get('a')?.intensity).toBe('a2')
    expect(cache.get('b')).toBeUndefined()
  })

  it('空にできる（件数も数えた値も戻る）', () => {
    const cache = createKyoshinFrameCache()
    cache.set('a', frame('a'))
    cache.get('a')
    cache.clear()

    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, evicted: 0, entries: 0 })
    expect(cache.get('a')).toBeUndefined()
  })

  // **上限は「次の助走が欲しがる範囲」を割ってはいけない。**
  // 割ると区間を送るたびに助走が取り直しになり、この控えを入れた意味が消える。
  //
  // **数字を写さずに助走の定数から導く** —— 写すと、助走を伸ばしたとき
  // （`WARMUP_MAX_BLOCKS` を増やす等）にこの境界テストが無反応で通り続ける。
  it('上限は、助走 2 回ぶんのフレーム数を上回る', () => {
    const warmupMaxFrames = WARMUP_MAX_BLOCKS * WARMUP_BLOCK_SEC
    // 1 つ分はいまの助走、もう 1 つ分は次の助走が遡る範囲（＝直前の再生で取った分）
    expect(MAX_FRAMES).toBeGreaterThanOrEqual(warmupMaxFrames * 2)
  })
})
