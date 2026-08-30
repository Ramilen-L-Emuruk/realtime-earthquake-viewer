import { describe, it, expect } from 'vitest'
import { gateNotes, gateRows, gateShortfall } from './detectionGates'
import { initGates, type ConfirmSnapshot, type DetectionEvent, type DetectionGates } from './kyoshinDetector'

/** テスト用の最小 DetectionEvent。関心のあるフィールドだけ上書きする。 */
function ev(overrides: Partial<DetectionEvent> & Pick<DetectionEvent, 'confidence'>): DetectionEvent {
  return {
    id: 'evt-1',
    memberKeys: [],
    cells: [],
    originTimeMs: 0,
    lastOnsetAtMs: 0,
    maxIntensity: 1.0,
    lastSize: 0,
    epicenter: null,
    confirmStreak: 0,
    everConfirmed: overrides.confidence === 'confirmed',
    firstConfirmedAtMs: 0,
    everMultiPoint: false,
    lastSpreadAtMs: 0,
    everNeighborRise: false,
    gates: initGates(),
    confirmedBy: null,
    ...overrides,
  }
}

/** 確定の凍結。`gates` の一部だけ差し替えられる。 */
function confirmedBy(
  size: number,
  intensity: number,
  gates: Partial<DetectionGates> = {},
): ConfirmSnapshot {
  return { atMs: 0, size, intensity, gates: { ...initGates(), ...gates } }
}

describe('gateShortfall: 確定したものは「なぜ確定したか」を言う', () => {
  it('通常の確定は点数と震度で言う', () => {
    const e = ev({ confidence: 'confirmed', confirmedBy: confirmedBy(6, 2.0) })
    expect(gateShortfall(e)).toBe('6点・震度2で確定')
  })

  it('高震度 fast path での確定は、点数ではなく震度の条件で言う', () => {
    const e = ev({
      confidence: 'confirmed',
      confirmedBy: confirmedBy(1, 3.0, { fastPath: true, highIntenseCount: 2, highIntensityReq: 2.5 }),
    })
    expect(gateShortfall(e)).toBe('震度3以上が2点で確定')
  })

  // 対照: 確定の内訳は**現フレーム**ではなく凍結から採る。減衰後の値で言い直さない
  it('確定後に震度が落ちても、凍結した内訳のまま言う', () => {
    const e = ev({
      confidence: 'confirmed',
      maxIntensity: 0.0, // 減衰して震度0級まで落ちた
      lastSize: 1,
      confirmedBy: confirmedBy(6, 2.0),
    })
    expect(gateShortfall(e)).toBe('6点・震度2で確定')
  })

  // 安全弁: 凍結が無い確定（併合で内訳を引き継げなかった場合）は黙る。現フレームの値で
  // でっち上げると、確定していない条件を「確定した根拠」として提示することになる
  it('凍結を持たない確定は何も言わない', () => {
    expect(gateShortfall(ev({ confidence: 'confirmed', confirmedBy: null }))).toBeNull()
  })
})

describe('gateShortfall: まだのものは「何が足りないか」を言う', () => {
  it('震度が届いていない faint は震度の不足を言う', () => {
    const e = ev({ confidence: 'faint', maxIntensity: 0.0 })
    expect(gateShortfall(e)).toBe('震度1に届いていません')
  })

  // 対照: 秒読みに入っていなければ（confirmStreak = 0）、裏付け待ちが残り条件になる
  it('震度は出ているが裏付けの無い faint は裏付け待ちと言う', () => {
    const e = ev({ confidence: 'faint', maxIntensity: 1.5, everNeighborRise: false, confirmStreak: 0 })
    expect(gateShortfall(e)).toBe('周囲の観測点の裏付け待ち')
  })

  // 正: 確定の秒読みに入っていれば、確信度が faint でもそれを言う
  it('確信度が faint でも、確定の秒読みに入っていれば残り時間を言う', () => {
    // 確定の条件（meetsConfirm）は周囲の裏付けを見ないが、likely へ上げる条件は見る。
    // そのため「確定へ向けて秒読み中なのに確信度は faint」が起こる。ここで likely への
    // 条件（裏付け待ち）を残り条件として示すと、確定には要らないものを要ると言うことになる
    const e = ev({
      confidence: 'faint',
      maxIntensity: 3.0,
      everNeighborRise: false,
      confirmStreak: 1,
      gates: { ...initGates(), streakReq: 2, fastPath: true, intenseCount: 2, intenseReq: 2 },
    })
    expect(gateShortfall(e)).toBe('確定まで あと約1秒')
  })

  it('点数が足りない likely は不足点数を言う', () => {
    const e = ev({
      confidence: 'likely',
      lastSize: 3,
      gates: { ...initGates(), sizeReq: 5, intenseCount: 2, intenseReq: 2 },
    })
    expect(gateShortfall(e)).toBe('確定まで あと2点')
  })

  it('確定震度に達した点も足りなければ併せて言う', () => {
    const e = ev({
      confidence: 'likely',
      lastSize: 3,
      gates: { ...initGates(), sizeReq: 5, intenseCount: 0, intenseReq: 2, intensityReq: 0.5 },
    })
    expect(gateShortfall(e)).toBe('確定まで あと2点・震度1以上が あと2点')
  })

  // 対照: 連続フレーム待ちの間は点数の不足を並べない（他の条件は満たしているため）
  it('連続一致の待ちのときは残り時間だけを言う', () => {
    const e = ev({
      confidence: 'likely',
      lastSize: 5,
      confirmStreak: 1,
      gates: { ...initGates(), sizeReq: 5, streakReq: 3, intenseCount: 2, intenseReq: 2 },
    })
    expect(gateShortfall(e)).toBe('確定まで あと約2秒')
  })

  // 安全弁: fast path が効いている間は点数条件が免除されるので、不足として挙げない
  it('高震度 fast path が成立している間は点数の不足を挙げない', () => {
    const e = ev({
      confidence: 'likely',
      lastSize: 1,
      gates: { ...initGates(), sizeReq: 5, fastPath: true, intenseCount: 2, intenseReq: 2 },
    })
    expect(gateShortfall(e)).toBeNull()
  })

  it('広がりが続かず取り下げたものはその旨を言う', () => {
    const e = ev({ confidence: 'weak', gates: { ...initGates(), soloStale: true } })
    expect(gateShortfall(e)).toBe('広がりが続かなかったため取り下げ')
  })
})

describe('gateRows', () => {
  it('要求を満たした行だけ met が真になる', () => {
    const e = ev({
      confidence: 'likely',
      lastSize: 5,
      maxIntensity: 1.0,
      confirmStreak: 0,
      gates: { ...initGates(), sizeReq: 5, intensityReq: 0.5, intenseCount: 2, intenseReq: 2, streakReq: 2 },
    })
    const byLabel = new Map(gateRows(e).map((r) => [r.label, r]))
    expect(byLabel.get('揺れ継続中の点')).toMatchObject({ value: '5', req: '5', met: true })
    expect(byLabel.get('連続して満たした回数')).toMatchObject({ value: '0', req: '2', met: false })
    expect(byLabel.get('最大震度')).toMatchObject({ value: '震度1', req: '震度1', met: true })
  })

  it('要求を持たない行は req も met も null（真偽で描かせない）', () => {
    const rows = gateRows(ev({ confidence: 'faint' }))
    const spread = rows.find((r) => r.label === '揺れの範囲が続いている')!
    expect(spread.req).toBeNull()
    expect(spread.met).toBeNull()
  })

  it('震度の要求が上がると、行の見出しも追従する（慢性活性セル）', () => {
    const e = ev({ confidence: 'likely', gates: { ...initGates(), intensityReq: 2.5, chronic: true } })
    expect(gateRows(e).some((r) => r.label === '震度3以上の点')).toBe(true)
  })
})

describe('gateNotes', () => {
  it('要求が動いた理由をすべて挙げる', () => {
    const e = ev({
      confidence: 'likely',
      gates: { ...initGates(), eewActive: true, chronic: true, sparse: true },
    })
    expect(gateNotes(e)).toHaveLength(3)
  })

  it('既定の条件で判定したなら何も挙げない', () => {
    expect(gateNotes(ev({ confidence: 'likely' }))).toEqual([])
  })
})
