import { describe, it, expect } from 'vitest'
import { buildSiteIndex, resolveMembers } from './kyoshinDetectionView'
import { siteKey } from './kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'

describe('buildSiteIndex: 座標衝突時も両方の観測点を索引に残す', () => {
  it('同一座標2点は kyoshinDetector.computeSiteKeys と同じ #2 サフィックスで両方引ける', () => {
    // 2026-08-08 天草・芦北地方の誤報調査で発覚: Yahoo 強震モニタの公開座標は同一値が複数回
    // 現れることがある（実例: site#561/#1358 がともに [32.2, 130.4]）。以前は Map のキーが
    // 座標だけだったため後発の点が先発を上書きし、カード表示・confirmedShocks から先発点の
    // 実測値が消えていた。
    const sites: SiteCoords = [
      [35.0, 139.0],
      [32.2, 130.4],
      [32.2, 130.4], // 座標衝突の別観測点
    ]
    const indices = [7, 11, 6] // 32.2,130.4 の1件目=震度3相当(11)・2件目=静穏(6)
    const byKey = buildSiteIndex(sites, indices)

    const base = siteKey(32.2, 130.4)
    expect(byKey.get(base)?.index).toBe(11)
    expect(byKey.get(`${base}#2`)?.index).toBe(6)
    expect(byKey.size).toBe(3)
  })

  it('resolveMembers で衝突した2点をどちらも別々に解決できる', () => {
    const sites: SiteCoords = [
      [32.2, 130.4],
      [32.2, 130.4],
    ]
    const indices = [11, 6]
    const byKey = buildSiteIndex(sites, indices)
    const base = siteKey(32.2, 130.4)
    const pts = resolveMembers([base, `${base}#2`], byKey)
    expect(pts.map((p) => p.index).sort((a, b) => a - b)).toEqual([6, 11])
  })
})
