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

// 検知点マーカー（KyoshinDetectedPointsGL）の描画対象は detectedPoints ＋ unconfirmedPoints の 2 本で、
// リアルタイムタブの検知カードが集計する集合（weak 以外の全イベント）と一致していなければならない。
// candidatePoints は候補カメラフィット専用（主 likely 1 件へ絞る）なので、こちらとは用途が別。
describe('deriveKyoshinView: unconfirmedPoints（検知点マーカーの描画対象）', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [35.1, 139.1],
    [35.2, 139.2],
    [35.3, 139.3],
  ]
  const keyA = siteKey(35.0, 139.0)
  const keyB = siteKey(35.1, 139.1)
  const keyC = siteKey(35.2, 139.2)
  const keyD = siteKey(35.3, 139.3)
  const indices = [9, 10, 11, 12]

  it('likely と faint のメンバーを全件含む（複数 likely を主 1 件へ絞らない）', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyB], maxIntensity: 4.0 }),
      fakeEvent({ id: 'evt-3', confidence: 'faint', memberKeys: [keyC], maxIntensity: 0.2 }),
    ]
    const view = deriveKyoshinView(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 10, 11])
    // 候補フィットは主 likely（maxIntensity 最大 = evt-2）1 件のみ
    expect(view.candidatePoints.map((p) => p.index)).toEqual([10])
  })

  it('weak と confirmed のメンバーは含まない（confirmed は detectedPoints 側）', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA], maxIntensity: 5.0 }),
      fakeEvent({ id: 'evt-2', confidence: 'weak', memberKeys: [keyB], maxIntensity: 0.1 }),
      fakeEvent({ id: 'evt-3', confidence: 'likely', memberKeys: [keyC], maxIntensity: 2.0 }),
    ]
    const view = deriveKyoshinView(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index)).toEqual([11]) // keyC のみ
    expect(view.detectedPoints.map((p) => p.index)).toEqual([9]) // keyA のみ
  })

  it('検知が無ければ空', () => {
    const view = deriveKyoshinView([], sites, indices)
    expect(view.unconfirmedPoints).toEqual([])
  })

  it('同一観測点が複数の likely に属していても重複しない', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA, keyD], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'faint', memberKeys: [keyD], maxIntensity: 0.2 }),
    ]
    const view = deriveKyoshinView(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 12])
  })

  // 描画側（buildDetectedFC）は重複を弾かない。同一座標に複数の実体がある観測点を取り違えて
  // 落とさないよう、confirmed との排除は観測点キーを持つこちらで済ませる。
  it('confirmed と likely の両方に属する観測点は unconfirmedPoints から除かれる', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA, keyB], maxIntensity: 3.0 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyB, keyC], maxIntensity: 1.5 }),
    ]
    const view = deriveKyoshinView(detections, sites, indices)
    expect(view.detectedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 10])
    expect(view.unconfirmedPoints.map((p) => p.index)).toEqual([11]) // keyB は confirmed 側にあるので除外
  })
})
