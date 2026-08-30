// 描画物の不調の集約を固定する。
// 背景は docs/spec/map-rendering-spec.md §16「描けているかを画面に出す」。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  reportRenderFailure,
  clearRenderFailure,
  subscribeRenderHealth,
  getRenderHealth,
  resetRenderHealthForTest,
} from './renderHealth'

beforeEach(() => {
  resetRenderHealthForTest()
})

describe('renderHealth', () => {
  // 正: 何も無ければ空。
  it('既定は空', () => {
    expect(getRenderHealth().broken).toEqual([])
    expect(getRenderHealth().uninteractive).toEqual([])
  })

  // 正: 種別ごとに分かれて出る。
  it('種別ごとに分けて持つ', () => {
    reportRenderFailure('a', '震源カタログ', 'draw')
    reportRenderFailure('b', '活断層', 'interact')
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])
    expect(getRenderHealth().uninteractive).toEqual(['活断層'])
  })

  // **正: 同じレイヤーが両方を抱えられる。**
  // 鍵に種別を含めていないと、描けない側が毎フレーム報告するので掴めない側が必ず消える。
  it('同じレイヤーが描けないと掴めないを同時に持てる', () => {
    reportRenderFailure('a', '震源カタログ', 'draw')
    reportRenderFailure('a', '震源カタログ', 'interact')
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])
    expect(getRenderHealth().uninteractive).toEqual(['震源カタログ'])
  })

  // 対照: 片方だけ解除しても、もう片方は残る。
  it('片方を解除しても他方は残る', () => {
    reportRenderFailure('a', '震源カタログ', 'draw')
    reportRenderFailure('a', '震源カタログ', 'interact')
    clearRenderFailure('a', 'draw')
    expect(getRenderHealth().broken).toEqual([])
    expect(getRenderHealth().uninteractive).toEqual(['震源カタログ'])
  })

  // **安全弁: 繰り返し報告しても増えない。** 描画ループから毎フレーム呼ばれる経路がある。
  it('同じ報告を繰り返しても 1 件のまま', () => {
    for (let i = 0; i < 100; i++) reportRenderFailure('a', '震源カタログ', 'draw')
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])
  })

  // **安全弁: 変化が無ければ通知しない。** 毎フレームの報告で購読側が再描画されると、
  // 不調を知らせるためにフレームを落とすことになる。
  it('変化が無ければ購読者を起こさない', () => {
    let calls = 0
    subscribeRenderHealth(() => { calls++ })
    reportRenderFailure('a', '震源カタログ', 'draw')
    expect(calls).toBe(1)
    for (let i = 0; i < 100; i++) reportRenderFailure('a', '震源カタログ', 'draw')
    expect(calls).toBe(1)
  })

  // **安全弁: 中身が同じならスナップショットの参照も変えない。**
  // `useSyncExternalStore` は参照で変化を見るため、作り直すと無駄な再描画になる。
  it('中身が同じならスナップショットの参照が変わらない', () => {
    reportRenderFailure('a', '震源カタログ', 'draw')
    const first = getRenderHealth()
    reportRenderFailure('a', '震源カタログ', 'draw')
    expect(getRenderHealth()).toBe(first)
  })

  // 対照: 中身が変われば参照も変わる（上の安全弁が「常に同じ」になっていないこと）。
  it('中身が変われば参照も変わる', () => {
    reportRenderFailure('a', '震源カタログ', 'draw')
    const first = getRenderHealth()
    reportRenderFailure('b', '震源', 'draw')
    expect(getRenderHealth()).not.toBe(first)
    expect(getRenderHealth().broken).toEqual(['震源カタログ', '震源'])
  })

  // 正: 解除で消え、購読者にも伝わる。
  it('解除すると消えて通知が飛ぶ', () => {
    let calls = 0
    reportRenderFailure('a', '震源カタログ', 'draw')
    subscribeRenderHealth(() => { calls++ })
    clearRenderFailure('a', 'draw')
    expect(getRenderHealth().broken).toEqual([])
    expect(calls).toBe(1)
  })

  // 安全弁: 記録が無いのに解除しても通知しない（消えたものを何度も消しにくる経路がある）。
  it('記録が無い解除では通知しない', () => {
    let calls = 0
    subscribeRenderHealth(() => { calls++ })
    clearRenderFailure('a', 'draw')
    expect(calls).toBe(0)
  })

  // **安全弁: ID に区切り文字が入っても別の組と混ざらない。**
  it('ID に区切り文字が入っても衝突しない', () => {
    reportRenderFailure('draw:a', 'まぎらわしい方', 'interact')
    reportRenderFailure('a', '素直な方', 'draw')
    expect(getRenderHealth().broken).toEqual(['素直な方'])
    expect(getRenderHealth().uninteractive).toEqual(['まぎらわしい方'])
  })

  // 正: 名前を変えて報告し直したら差し替わる。
  it('同じ ID で名前を変えたら差し替わる', () => {
    reportRenderFailure('a', '古い名前', 'draw')
    reportRenderFailure('a', '新しい名前', 'draw')
    expect(getRenderHealth().broken).toEqual(['新しい名前'])
  })
})
