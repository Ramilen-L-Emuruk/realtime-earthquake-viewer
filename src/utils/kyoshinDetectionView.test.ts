import { describe, it, expect } from 'vitest'
import { buildSiteIndex, resolveMembers, deriveKyoshinView } from './kyoshinDetectionView'
import { siteKey, type DetectionEvent } from './kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'

/** テスト用の最小 DetectionEvent。指定しないフィールドは無関係な既定値で埋める。 */
function fakeEvent(overrides: Partial<DetectionEvent> & Pick<DetectionEvent, 'id' | 'confidence' | 'memberKeys' | 'maxIntensity'>): DetectionEvent {
  return {
    cells: [],
    originTimeMs: 0,
    lastOnsetAtMs: 0,
    lastSize: overrides.memberKeys.length,
    epicenter: null,
    confirmStreak: 0,
    everConfirmed: overrides.confidence === 'confirmed',
    lastSpreadAtMs: 0,
    ...overrides,
  }
}

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

describe('deriveKyoshinView: candidateMaxIndex（likely 中の音レベル追跡の基準値）', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [35.1, 139.1],
    [35.2, 139.2],
  ]
  const keyA = siteKey(35.0, 139.0)
  const keyB = siteKey(35.1, 139.1)
  const keyC = siteKey(35.2, 139.2)

  it('likely イベントが無ければ 0', () => {
    const view = deriveKyoshinView([], sites, [9, 7, 6])
    expect(view.candidateMaxIndex).toBe(0)
  })

  it('主 likely イベントのメンバー観測点の最大インデックスを返す', () => {
    const indices = [9, 11, 6] // keyB=11 が最大だが、keyC はメンバーではないので無視される
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA, keyB], maxIntensity: 2.5 }),
    ]
    const view = deriveKyoshinView(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(11)
  })

  it('複数 likely イベントがあれば maxIntensity が最大の主イベント側を採用する', () => {
    const indices = [9, 11, 13]
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyC], maxIntensity: 4.0 }),
    ]
    const view = deriveKyoshinView(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(13) // evt-2 (keyC) 側
  })

  it('confirmed イベントのみのときは candidateMaxIndex は 0（likely が無いため）', () => {
    const indices = [9, 11, 6]
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA, keyB], maxIntensity: 2.5 }),
    ]
    const view = deriveKyoshinView(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(0)
  })
})
