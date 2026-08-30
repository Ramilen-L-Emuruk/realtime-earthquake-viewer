import { describe, expect, it } from 'vitest'
import { attributionLine, DEFAULT_SHARE_CARD_FORMAT, shareCardMapHeight } from './shareCard'

// 地図に割ける高さは「カード全体 − 見出し帯 − 出典帯」で決まり、撮影側（useShareCard）と
// 合成側（composeShareCard）の両方が同じ計算を通す。ここが崩れると、撮った地図が貼るときに
// 引き伸ばされて縮尺が狂う——型では捕まらないので値で固定する。

describe('shareCardMapHeight', () => {
  const format = DEFAULT_SHARE_CARD_FORMAT

  it('出典が増えるほど地図は縮む', () => {
    const h0 = shareCardMapHeight(format, 0)
    const h1 = shareCardMapHeight(format, 1)
    const h2 = shareCardMapHeight(format, 2)
    expect(h0).toBeGreaterThan(h1)
    expect(h1).toBeGreaterThan(h2)
  })

  it('どの行数でも地図の高さは正で、カード全体に収まる', () => {
    for (const count of [0, 1, 2, 3, 4]) {
      const h = shareCardMapHeight(format, count)
      expect(h).toBeGreaterThan(0)
      expect(h).toBeLessThan(format.height)
    }
  })

  // 出典が 1 行も無ければ帯ごと出さない。そのぶん 1 行目の減り幅だけが、2 行目以降
  // （行送りのみ）より大きくなる。
  it('出典が 0 行のときは帯ごと出ない', () => {
    const firstLineCost = shareCardMapHeight(format, 0) - shareCardMapHeight(format, 1)
    const secondLineCost = shareCardMapHeight(format, 1) - shareCardMapHeight(format, 2)
    expect(firstLineCost).toBeGreaterThan(secondLineCost)
  })

  it('既定の寸法は X のタイムラインに合わせた 16:9', () => {
    expect(format.width / format.height).toBeCloseTo(16 / 9, 4)
  })
})

describe('attributionLine', () => {
  // 境界線や活断層は元データを変換して使う（加工にあたる）が、海底地形は配信されるタイルを
  // そのまま描いている。まとめて括ると、加工していないものまで加工したと述べることになる。
  it('加工したものだけを「を加工して作成」で括る', () => {
    const line = attributionLine({ derived: ['気象庁'], asIs: ['GEBCO'] })
    expect(line).toBe('出典: GEBCO／気象庁 を加工して作成')
  })

  it('加工していないものが無ければ、加工の句だけを出す', () => {
    expect(attributionLine({ derived: ['気象庁'], asIs: [] })).toBe('出典: 気象庁 を加工して作成')
  })

  it('加工したものが無ければ、加工の句を出さない', () => {
    const line = attributionLine({ derived: [], asIs: ['GEBCO'] })
    expect(line).toBe('出典: GEBCO')
    expect(line).not.toContain('加工')
  })
})
