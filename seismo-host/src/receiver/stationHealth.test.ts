import { describe, expect, it } from 'vitest'

import type { FusedWaveChunk, SensorPairDiff } from './sensorFusion'
import { StationHealthBook, pairDiffStrength } from './stationHealth'

/** センサー対 1 組ぶんの差分。 */
function pairDiff(overrides: Partial<SensorPairDiff> = {}): SensorPairDiff {
  return {
    stationId: 'garage',
    memberA: { boardKey: 'mac:aa', sensorId: 's0' },
    memberB: { boardKey: 'mac:bb', sensorId: 's0' },
    firstSampleIndex: 0,
    firstSampleMs: 1_000,
    msPerSample: 10,
    diffGal: [
      [3, 4],
      [0, 0],
      [1, 1],
    ],
    ...overrides,
  }
}

/** 合成波形 1 まとまり。`memberCount` 以外はこの帳面が読まない。 */
function fused(memberCount: readonly number[], stationId = 'garage'): FusedWaveChunk {
  return {
    stationId,
    driver: { boardKey: 'mac:aa', sensorId: 's0' },
    firstSampleIndex: 0,
    firstSampleMs: 1_000,
    msPerSample: 10,
    gal: [[1], [2], [3]],
    dcGal: [[0], [0], [980]],
    memberCount,
  }
}

/** 差し替えられる時計。 */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

describe('pairDiffStrength', () => {
  it('正: 軸ごとの RMS を出す（#315）', () => {
    const s = pairDiffStrength(pairDiff())

    // √((3² + 4²) / 2) = √12.5
    expect(s.rmsGal[0]).toBeCloseTo(Math.sqrt(12.5), 10)
    expect(s.rmsGal[1]).toBe(0)
    expect(s.rmsGal[2]).toBe(1)
    expect(s.sampleCount).toEqual([2, 2, 2])
    expect(s.a).toEqual({ boardKey: 'mac:aa', sensorId: 's0' })
  })

  it('対照: 両方の値が揃わないサンプル（null）は計算へ混ぜない', () => {
    // **欠けを 0 として混ぜると「差が無かった」方向へ引っ張る** ——
    // 離れている対を見落とす向きに倒れる。
    const s = pairDiffStrength(
      pairDiff({
        diffGal: [
          [3, null, 4, null],
          [0, 0, 0, 0],
          [1, 1, 1, 1],
        ],
      }),
    )

    expect(s.rmsGal[0]).toBeCloseTo(Math.sqrt(12.5), 10)
    expect(s.sampleCount[0]).toBe(2)
  })

  it('安全弁: 揃うサンプルが 1 つも無い軸は 0 ではなく null', () => {
    // **0 は「2 台がぴったり一致した」を意味してしまう。** ここで起きているのは
    // 「測れなかった」——別の事実。
    const s = pairDiffStrength(
      pairDiff({
        diffGal: [
          [null, null],
          [0, 0],
          [1, 1],
        ],
      }),
    )

    expect(s.rmsGal[0]).toBeNull()
    expect(s.sampleCount[0]).toBe(0)
    expect(s.rmsGal[1]).toBe(0)
  })
})

describe('StationHealthBook', () => {
  it('正: センサー対ごとの差分の強さを覚える（#315）', () => {
    const book = new StationHealthBook()
    book.notePairDiffs('garage', [pairDiff()])

    const s = book.snapshot()[0]
    expect(s.pairDiffs).toHaveLength(1)
    expect(s.pairDiffs[0].rmsGal[0]).toBeCloseTo(Math.sqrt(12.5), 10)
  })

  it('安全弁: 差分が 1 組も無くなったら、古い対を消す（#315 のレビュー）', () => {
    // **センサーを無効化して観測点が 2 台から 1 台へ縮小すると、差分は空になる。**
    // 黙って据え置くと「混ざった本数は 1 本」なのに「差分の最大はもう存在しない対」
    // が同時に出たまま固まる —— しかもこの帳面は起動時に 1 度作るだけなので、
    // プロセスを入れ直すまで解消しない。
    const book = new StationHealthBook()
    book.notePairDiffs('garage', [pairDiff()])
    expect(book.snapshot()[0].pairDiffs).toHaveLength(1)

    book.notePairDiffs('garage', [])

    expect(book.snapshot()[0].pairDiffs).toEqual([])
  })

  it('安全弁: 観測点が混ざった一覧でも、渡された観測点のぶんだけ採る', () => {
    // `SensorFusion.ingest()` は 1 観測点ぶんしか返さないが、型はそれを保証しない。
    const book = new StationHealthBook()
    book.notePairDiffs('garage', [pairDiff(), pairDiff({ stationId: 'study' })])

    const byId = new Map(book.snapshot().map((s) => [s.stationId, s]))
    expect(byId.get('garage')?.pairDiffs).toHaveLength(1)
    // **別の観測点は触らない。** 渡された一覧に混ざっていても、勝手に覚えない。
    expect(byId.has('study')).toBe(false)
  })


  it('震度が出た観測点を覚える', () => {
    const book = new StationHealthBook()
    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 2.5 })

    const s = book.snapshot()[0]
    expect(s.stationId).toBe('garage')
    expect(s.lastIntensity).toBe(2.5)
    expect(s.lastReadingAtMs).toBe(1_000)
  })

  it('震度が出せなかった回でも、直前まで出ていた値を消さない', () => {
    const book = new StationHealthBook()
    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 2.5 })
    book.noteReading({ stationId: 'garage', atMs: 2_000, intensity: null })

    const s = book.snapshot()[0]
    // 「時刻は進んでいるのに値が古い」組が、いま値を出せていない印になる
    expect(s.lastIntensity).toBe(2.5)
    expect(s.lastReadingAtMs).toBe(2_000)
  })

  it('震度を出せない理由を覚え、震度が出たら落とす', () => {
    const book = new StationHealthBook()
    book.noteSkip('garage', 'stream-rejected')
    expect(book.snapshot()[0].lastSkipReason).toBe('stream-rejected')

    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 1 })
    // 直ったのに古い理由が居座ると、いつのものか読めなくなる
    expect(book.snapshot()[0].lastSkipReason).toBeNull()
  })

  it('正: 合成波形が出たら、混ざった本数の最小と最大を覚える（#315）', () => {
    const book = new StationHealthBook()
    book.noteWave(fused([9, 9, 9, 9]))

    const s = book.snapshot()[0]
    // **待ちが効いていれば、割り当てた台数と同じ値で最小＝最大になる。**
    expect(s.lastMemberCountMin).toBe(9)
    expect(s.lastMemberCountMax).toBe(9)
  })

  it('対照: 震度しか出ていない観測点では、混ざった本数は分からないまま', () => {
    const book = new StationHealthBook()
    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 2.5 })

    const s = book.snapshot()[0]
    // **0 で埋めない。** 「まだ合成していない」と「0 本で合成した」は別の事実で、
    // 0 と書くと後者に見える（そんな状態は起きない）。
    expect(s.lastMemberCountMin).toBeNull()
    expect(s.lastMemberCountMax).toBeNull()
  })

  it('安全弁: 本数が揺れ動いていたら、最小と最大が食い違う形で出る（#362 の症状）', () => {
    const book = new StationHealthBook()
    // 手当て前の実機で起きていた形——1 まとまり（30 サンプル）の中で顔ぶれが
    // 入れ替わり、センサー間の直流差が段差として乗って震度が跳ねていた。
    book.noteWave(fused([1, 4, 7, 2, 5]))

    const s = book.snapshot()[0]
    expect(s.lastMemberCountMin).toBe(1)
    expect(s.lastMemberCountMax).toBe(7)
  })

  it('安全弁: 空のまとまりでは何も覚えない（音沙汰の印も動かさない）', () => {
    const c = clock()
    const book = new StationHealthBook({ now: c.now })
    book.noteWave(fused([]))

    // **触ると `lastPacketMs` だけが動いて本数は null のまま**という、
    // 読み手に「合成したのに本数が分からない」と見える形になる。
    expect(book.snapshot()).toEqual([])
  })

  it('理由が null（正常）のときは何も書き換えない', () => {
    const book = new StationHealthBook()
    book.noteSkip('garage', 'stream-rejected')
    // `FusionOutcome.intensitySkipReason` は駆動役の到着のたびに「いまの状態」を
    // 返すため、null を無条件に反映すると `noteReading` が置いた震度出た印より
    // 先にここが通ったとき、震度が出た事実のほうを消してしまう。
    book.noteSkip('garage', null)

    expect(book.snapshot()[0].lastSkipReason).toBe('stream-rejected')
  })

  it('締めくくりに失敗した回数と理由を覚える', () => {
    const book = new StationHealthBook()
    book.noteCloseFailure('garage', 'push が投げた')
    book.noteCloseFailure('garage', 'end が投げた')

    const s = book.snapshot()[0]
    expect(s.closeFailures).toBe(2)
    expect(s.lastCloseFailure).toBe('end が投げた')
  })

  it('上限に達したら、いちばん長く音沙汰の無いものを押し出して数える', () => {
    const t = clock()
    const book = new StationHealthBook({ maxStations: 2, now: t.now })
    book.noteReading({ stationId: 'a', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    book.noteReading({ stationId: 'b', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    // 1 つ目に触れ直すと、押し出される順が入れ替わる
    book.noteReading({ stationId: 'a', atMs: 2_000, intensity: 1 })
    t.advance(1_000)

    book.noteReading({ stationId: 'c', atMs: 1_000, intensity: 1 })

    expect(book.size).toBe(2)
    expect(book.evictions).toBe(1)
    expect(book.snapshot().map((s) => s.stationId).sort()).toEqual(['a', 'c'])
  })

  it('音沙汰の新しい順に返す（黙ったものが末尾へ寄る）', () => {
    const t = clock()
    const book = new StationHealthBook({ now: t.now })
    book.noteReading({ stationId: 'a', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    book.noteReading({ stationId: 'b', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    book.noteReading({ stationId: 'c', atMs: 1_000, intensity: 1 })

    expect(book.snapshot().map((s) => s.stationId)).toEqual(['c', 'b', 'a'])
  })

  it('駆動役が生きている限り、合成が恒久的に壊れていても lastPacketMs は動き続ける', () => {
    // **`lastReadingAtMs`（震度が出た時刻）の代わりにはならない。** 合成が壊れて
    // 震度が二度と出なくなっても、駆動役からの到着ごとに `noteSkip` は呼ばれ続ける
    // ので、`lastPacketMs` だけは進む——これが無いと、観測点が丸ごと沈黙したのか
    // 駆動役は生きているが合成だけ壊れているのかを `/status` から見分けられない。
    const t = clock()
    const book = new StationHealthBook({ now: t.now })
    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 2.5 })
    const first = book.snapshot()[0].lastPacketMs

    t.advance(5_000)
    book.noteSkip('garage', 'stream-rejected')

    expect(book.snapshot()[0].lastPacketMs).toBe(first + 5_000)
    // 震度そのものは、壊れる前に出ていた値のまま残る。
    expect(book.snapshot()[0].lastIntensity).toBe(2.5)
  })

  it('まだ何も届いていない観測点は数に入らない', () => {
    const book = new StationHealthBook()
    expect(book.size).toBe(0)
    expect(book.snapshot()).toEqual([])
  })
})
