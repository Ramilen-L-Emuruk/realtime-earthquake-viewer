import { describe, it, expect } from 'vitest'
import { buildSiteIndex, dropIsolatedZeroPoints, resolveMembers, deriveKyoshinView, type DetectedPoint } from './kyoshinDetectionView'
import { siteKey, type DetectionEvent } from './kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'

/**
 * テスト用ラッパー。`deriveKyoshinView` は `recentOnsetKeys` を必須にしている（既定値のまま呼ぶ経路を
 * 作らないため）が、多くのテストは「直近の立ち上がりなし」で足りるのでここで空集合を補う。
 */
function derive(
  detections: DetectionEvent[],
  sites: SiteCoords,
  indices: number[],
  recentOnsetKeys: ReadonlySet<string> = new Set(),
) {
  return deriveKyoshinView(detections, sites, indices, recentOnsetKeys)
}

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
    const view = derive([], sites, [9, 7, 6])
    expect(view.candidateMaxIndex).toBe(0)
  })

  it('主 likely イベントのメンバー観測点の最大インデックスを返す', () => {
    const indices = [9, 11, 6] // keyB=11 が最大だが、keyC はメンバーではないので無視される
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA, keyB], maxIntensity: 2.5 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(11)
  })

  it('複数 likely イベントがあれば maxIntensity が最大の主イベント側を採用する', () => {
    const indices = [9, 11, 13]
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyC], maxIntensity: 4.0 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(13) // evt-2 (keyC) 側
  })

  it('confirmed イベントのみのときは candidateMaxIndex は 0（likely が無いため）', () => {
    const indices = [9, 11, 6]
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA, keyB], maxIntensity: 2.5 }),
    ]
    const view = derive(detections, sites, indices)
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
    const view = derive(detections, sites, indices)
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
    const view = derive(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index)).toEqual([11]) // keyC のみ
    expect(view.detectedPoints.map((p) => p.index)).toEqual([9]) // keyA のみ
  })

  it('検知が無ければ空', () => {
    const view = derive([], sites, indices)
    expect(view.unconfirmedPoints).toEqual([])
  })

  it('同一観測点が複数の likely に属していても重複しない', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA, keyD], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'faint', memberKeys: [keyD], maxIntensity: 0.2 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 12])
  })

  // 描画側（buildDetectedFC）は重複を弾かない。同一座標に複数の実体がある観測点を取り違えて
  // 落とさないよう、confirmed との排除は観測点キーを持つこちらで済ませる。
  it('confirmed と likely の両方に属する観測点は unconfirmedPoints から除かれる', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA, keyB], maxIntensity: 3.0 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyB, keyC], maxIntensity: 1.5 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.detectedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 10])
    expect(view.unconfirmedPoints.map((p) => p.index)).toEqual([11]) // keyB は confirmed 側にあるので除外
  })
})

describe('dropIsolatedZeroPoints: 揺れが去った後に残る孤立した震度0点を落とす', () => {
  // 緯度 0.1 度 ≈ 11km。ISOLATED_ZERO_RADIUS_KM(30km) の内外を緯度差・経度差で作る。
  const P = (key: string, lat: number, lng: number, index: number): DetectedPoint => ({ key, lat, lng, index })
  const NONE: ReadonlySet<string> = new Set()
  /** 全点を間引きの対象にする（＝全点が confirmed のメンバーである状況）。 */
  const ALL = (pts: DetectedPoint[]): ReadonlySet<string> => new Set(pts.map((p) => p.key))

  it('震度1以上の点が近く（30km以内）にある震度0点は残す', () => {
    const pts = [P('a', 35.0, 139.0, 7), P('b', 35.1, 139.0, 6)]
    expect(dropIsolatedZeroPoints(pts, ALL(pts), NONE).map((p) => p.key)).toEqual(['a', 'b'])
  })

  it('震度1以上の点が遠く（30km超）にしかない震度0点は落とす', () => {
    const pts = [P('a', 35.0, 139.0, 7), P('far', 36.0, 139.0, 6)] // 約111km
    expect(dropIsolatedZeroPoints(pts, ALL(pts), NONE).map((p) => p.key)).toEqual(['a'])
  })

  it('遠くても直近に立ち上がった点は残す（揺れの到達先端を消さない）', () => {
    const pts = [P('a', 35.0, 139.0, 7), P('far', 36.0, 139.0, 6)]
    expect(dropIsolatedZeroPoints(pts, ALL(pts), new Set(['far'])).map((p) => p.key)).toEqual(['a', 'far'])
  })

  it('震度1以上の点は距離に関わらず残す', () => {
    const pts = [P('a', 35.0, 139.0, 7), P('lone', 43.0, 141.0, 7)]
    expect(dropIsolatedZeroPoints(pts, ALL(pts), NONE).map((p) => p.key)).toEqual(['a', 'lone'])
  })

  it('震度0未満・欠測は判定対象外で素通しする（描画側・集計側が別途落とす）', () => {
    // index 5 = value -0.5（震度0未満）・index -1 = 欠測。どちらも kyoshinIndexToJma が null。
    const pts = [P('sub', 35.0, 139.0, 5), P('missing', 43.0, 141.0, -1)]
    expect(dropIsolatedZeroPoints(pts, ALL(pts), NONE).map((p) => p.key)).toEqual(['sub', 'missing'])
  })

  it('震度1以上が1点も無ければ、直近に立ち上がった震度0点だけが残る', () => {
    const pts = [P('old', 35.0, 139.0, 6), P('new', 35.1, 139.0, 6)]
    expect(dropIsolatedZeroPoints(pts, ALL(pts), new Set(['new'])).map((p) => p.key)).toEqual(['new'])
  })

  it('緯度が同じでも経度方向に遠ければ落とす（緯度差の足切りで取りこぼさない）', () => {
    const pts = [P('a', 35.0, 139.0, 7), P('east', 35.0, 140.0, 6)] // 約91km
    expect(dropIsolatedZeroPoints(pts, ALL(pts), NONE).map((p) => p.key)).toEqual(['a'])
  })

  it('対象キーに含まれない点は孤立していても落とさない（likely / faint のメンバー）', () => {
    const pts = [P('conf', 35.0, 139.0, 6), P('faint', 40.0, 139.0, 6)]
    expect(dropIsolatedZeroPoints(pts, new Set(['conf']), NONE).map((p) => p.key)).toEqual(['faint'])
  })

  it('対象外の点が持つ震度1以上も近傍判定の材料に使う', () => {
    // 'conf' は confirmed の震度0点。近くにある震度1点は likely 側（対象外）だが、これで救われる。
    const pts = [P('conf', 35.0, 139.0, 6), P('likely', 35.1, 139.0, 7)]
    expect(dropIsolatedZeroPoints(pts, new Set(['conf']), NONE).map((p) => p.key)).toEqual(['conf', 'likely'])
  })
})

describe('deriveKyoshinView: 孤立した震度0点の除外', () => {
  const farSites: SiteCoords = [
    [35.0, 139.0], // 震度1（揺れの芯）
    [35.1, 139.0], // 震度0・芯の近く（約11km）
    [40.0, 139.0], // 震度0・遠い残り（約556km）
  ]
  const keyStrong = siteKey(35.0, 139.0)
  const keyNear = siteKey(35.1, 139.0)
  const keyFar = siteKey(40.0, 139.0)
  const farIndices = [7, 6, 6]
  const confirmedFar = () =>
    fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyStrong, keyNear, keyFar], maxIntensity: 0.5 })

  it('confirmed の遠い震度0メンバーは detectedMarkerPoints から落ち、近いメンバーは残る', () => {
    const view = derive([confirmedFar()], farSites, farIndices)
    expect(view.detectedMarkerPoints.map((p) => p.key).sort()).toEqual([keyNear, keyStrong].sort())
  })

  // カメラ追従（CameraFollowsGL）は detectedPoints が空になったことを「検知終了」と解釈して日本全体へ
  // 戻すため、間引きでここを削ってはいけない（実測: 削ると検知中に20秒間カメラが引いた）。
  it('detectedPoints（カメラフィット用）は間引かず全メンバーを保つ', () => {
    const view = derive([confirmedFar()], farSites, farIndices)
    expect(view.detectedPoints.map((p) => p.key).sort()).toEqual([keyFar, keyNear, keyStrong].sort())
  })

  it('直近に立ち上がった点は遠くても描く', () => {
    const view = derive([confirmedFar()], farSites, farIndices, new Set([keyFar]))
    expect(view.detectedMarkerPoints.map((p) => p.key).sort()).toEqual([keyFar, keyNear, keyStrong].sort())
  })

  // faint はメンバー全員が定義上震度0。間引きの対象にすると、イベントが生きている間に点だけが消えて
  // 「微弱な揺れの兆候」カードと地図が食い違う。
  it('faint / likely のメンバーは間引かない（unconfirmedPoints は素通し）', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-2', confidence: 'faint', memberKeys: [keyNear, keyFar], maxIntensity: 0.0 })],
      farSites,
      [6, 6, 6], // 震度1以上が1点も無い
    )
    expect(view.unconfirmedPoints.map((p) => p.key).sort()).toEqual([keyFar, keyNear].sort())
  })

  it('確信度フラグ・地域発報の入力（confirmedShocks）はフィルタの影響を受けない', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyFar], maxIntensity: 0.0, epicenter: [40.0, 139.0] })],
      farSites,
      [6, 6, 6], // 震度1以上が1点も無い＝遠い震度0は描かれない
    )
    expect(view.detectedMarkerPoints).toEqual([])
    expect(view.confirmed).toBe(true)
    expect(view.confirmedShocks).toEqual([{ lat: 40.0, lng: 139.0, index: 6 }])
  })
})

// 欠測ホールド（utils/kyoshinMissingHold.ts）で作った保持値を渡したときの振る舞い。
// 保持は「表示の補完」だが、地域の最大震度（音・通知・地域単位発報の入力）にも意図的に効かせている。
// 欠測を素通しすると、最大震度を担う観測点が 1 秒欠測した瞬間に「揺れが弱まった」と解釈され、
// 復帰時に更新音が誤って鳴る（useKyoshinAlerts の postPeakMinLevel）。
describe('deriveKyoshinView: 欠測ホールドの保持値と stale フラグ', () => {
  const holdSites: SiteCoords = [
    [35.0, 139.0],
    [35.1, 139.1],
  ]
  const hKeyA = siteKey(35.0, 139.0)
  const hKeyB = siteKey(35.1, 139.1)
  const confirmedEvent = fakeEvent({
    id: 'evt-1',
    confidence: 'confirmed',
    memberKeys: [hKeyA, hKeyB],
    maxIntensity: 5.0,
    epicenter: [35.05, 139.05],
  })

  it('保持中フラグが DetectedPoint へ伝わる（描画側が薄く描くため）', () => {
    // hKeyA が欠測 → 直前値 17 を保持中。hKeyB は生きている。
    const view = deriveKyoshinView([confirmedEvent], holdSites, [17, 15], new Set(), [true, false])
    const byKey = new Map(view.detectedMarkerPoints.map((p) => [p.key, p]))
    expect(byKey.get(hKeyA)?.stale).toBe(true)
    expect(byKey.get(hKeyB)?.stale).toBe(false)
  })

  it('最大震度を担う点が欠測しても、保持値なら confirmedShocks の index が落ちない', () => {
    const held = deriveKyoshinView([confirmedEvent], holdSites, [17, 15], new Set(), [true, false])
    expect(held.confirmedShocks).toEqual([{ lat: 35.05, lng: 139.05, index: 17 }])
    // 保持しない場合（欠測を素通し）は次点の 15 まで落ちる＝揺れが弱まったように見える
    const raw = deriveKyoshinView([confirmedEvent], holdSites, [-1, 15], new Set())
    expect(raw.confirmedShocks).toEqual([{ lat: 35.05, lng: 139.05, index: 15 }])
  })

  it('likely 中の音レベルの基準（candidateMaxIndex）も保持値で落ちない', () => {
    const likely = fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [hKeyA, hKeyB], maxIntensity: 4.0 })
    const held = deriveKyoshinView([likely], holdSites, [15, 11], new Set(), [true, false])
    expect(held.candidateMaxIndex).toBe(15)
    const raw = deriveKyoshinView([likely], holdSites, [-1, 11], new Set())
    expect(raw.candidateMaxIndex).toBe(11)
  })

  it('stale を渡さない経路では stale=false になる（保持を通さない呼び出し）', () => {
    const view = derive([confirmedEvent], holdSites, [17, 15])
    expect(view.detectedMarkerPoints.every((p) => p.stale === false)).toBe(true)
  })
})
