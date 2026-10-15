import { describe, expect, it } from 'vitest'
import type { SeismoQuakeWave } from '../hooks/useSeismoQuakeWaves'
import { mergeQuakeWaves } from './mergeQuakeWaves'

const wave = (stationId: string): SeismoQuakeWave => ({ stationId }) as unknown as SeismoQuakeWave

describe('mergeQuakeWaves', () => {
  // 正: 自作地震計を先に、続けて公開観測点を並べる。
  it('自作地震計を先に、公開観測点を後に並べる', () => {
    const own = [wave('s1')]
    const pub = [wave('public:JMM'), wave('public:YOJ')]
    const got = mergeQuakeWaves(new Map([['q', own]]), new Map([['q', pub]]), new Map())
    expect(got.get('q')!.map((w) => w.stationId)).toEqual(['s1', 'public:JMM', 'public:YOJ'])
  })

  // 対照: 公開観測点が無い地震は、自作地震計の配列をそのまま使う（参照を変えない）。
  it('自作地震計だけの地震は、その配列をそのまま使う', () => {
    const own = [wave('s1')]
    const got = mergeQuakeWaves(new Map([['q', own]]), new Map(), new Map())
    expect(got.get('q')).toBe(own)
  })

  // 安全弁: 中身が同じなら前回の配列を使い回す（カードを描き直させない）。中身が変われば作り直す。
  it('中身が同じなら前回の配列を使い回し、変われば作り直す', () => {
    const a = wave('s1')
    const b = wave('public:JMM')
    const first = mergeQuakeWaves(new Map([['q', [a]]]), new Map([['q', [b]]]), new Map())
    const second = mergeQuakeWaves(new Map([['q', [a]]]), new Map([['q', [b]]]), first)
    expect(second.get('q')).toBe(first.get('q'))
    const c = wave('public:JMM')
    const third = mergeQuakeWaves(new Map([['q', [a]]]), new Map([['q', [c]]]), second)
    expect(third.get('q')).not.toBe(second.get('q'))
  })

  // 公開観測点だけの地震（自作地震計が届かない遠い地震）も載せる。
  it('公開観測点だけの地震も載せる', () => {
    const pub = [wave('public:JMM')]
    const got = mergeQuakeWaves(new Map(), new Map([['q', pub]]), new Map())
    expect(got.get('q')!.map((w) => w.stationId)).toEqual(['public:JMM'])
  })
})
