import { describe, expect, it } from 'vitest'

import { WaveBuffer, WaveStore } from './waveBuffer'
import type { WaveChunkView } from './waveBuffer'

const MS_PER_SAMPLE = 10
const SAMPLES = 30

/**
 * チャンクの上書き。
 *
 * **`boardKey`・`sensorId` を平らに書ける形を残す。** 出どころは判別共用体
 * （`WaveSourceKey`）になったが、テストの読みやすさのためここで組み立てる。
 */
type ChunkOverrides = Partial<WaveChunkView> & {
  readonly boardKey?: string
  readonly sensorId?: string
}

/** 全軸に同じ値を並べたチャンク。既定は 100 Hz・30 サンプル（実機の 1 パケットぶん）。 */
function chunk(overrides: ChunkOverrides = {}): WaveChunkView {
  const { boardKey, sensorId, ...rest } = overrides
  const values = rest.gal?.[0] ?? Array.from({ length: SAMPLES }, (_, i) => i)
  const axis = [...values]
  return {
    source: { kind: 'sensor', boardKey: boardKey ?? 'board-1', sensorId: sensorId ?? 'accel-0' },
    streamKey: 'board-1/accel-0/boot-1',
    segmentId: 1,
    firstSampleMs: 0,
    msPerSample: MS_PER_SAMPLE,
    timebaseNominalReason: null,
    gal: [axis, axis, axis],
    memberCount: null,
    ...rest,
  }
}

/** 観測点の合成波形 1 まとまり（#315）。 */
function stationChunk(overrides: Partial<WaveChunkView> = {}): WaveChunkView {
  const axis = Array.from({ length: SAMPLES }, (_, i) => i)
  return {
    source: { kind: 'station', stationId: 'garage' },
    // **合成には区間の識別子が無い。** 連続性は時刻の隔たりで見る。
    streamKey: null,
    segmentId: null,
    firstSampleMs: 0,
    msPerSample: MS_PER_SAMPLE,
    timebaseNominalReason: null,
    gal: [axis, axis, axis],
    memberCount: Array.from({ length: SAMPLES }, () => 9),
    ...overrides,
  }
}

/** 先頭が `startMs` で、値が全部 `value` のチャンク。 */
function flat(startMs: number, value: number, overrides: ChunkOverrides = {}): WaveChunkView {
  const axis = Array.from({ length: SAMPLES }, () => value)
  return chunk({ firstSampleMs: startMs, gal: [axis, axis, axis], ...overrides })
}

function buffer(options?: ConstructorParameters<typeof WaveBuffer>[1]): WaveBuffer {
  return new WaveBuffer({ kind: 'sensor', boardKey: 'board-1', sensorId: 'accel-0' }, options)
}

describe('WaveBuffer', () => {
  it('積んだチャンクの時間の範囲が出る', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 1000 }))

    expect(b.range()).toEqual({ fromMs: 1000, toMs: 1000 + SAMPLES * MS_PER_SAMPLE })
  })

  it('1 件も積んでいなければ範囲は無い', () => {
    expect(buffer().range()).toBeNull()
  })

  it('列へ畳むと、その列に入ったサンプルの上下の両端が出る', () => {
    const b = buffer()
    b.push(chunk()) // 値は 0..29

    const window = b.readWindow(0, 300, 3)

    // 列 0 は 0〜99 ms のサンプル（値 0..9）。
    expect(window.axes[0][0]).toEqual({ minGal: 0, maxGal: 9, gapBefore: false })
    expect(window.axes[0][1]).toEqual({ minGal: 10, maxGal: 19, gapBefore: false })
    expect(window.axes[0][2]).toEqual({ minGal: 20, maxGal: 29, gapBefore: false })
  })

  it('1 点だけの尖りが列に残る（平均や間引きなら消えるもの）', () => {
    // **これが上下の両端を採っている理由。** 30 サンプル中 1 点だけが跳ねている波形を
    // 3 列へ畳むと、平均は 10 前後・単純な間引きは 0 になる。**揺れを見に来た画面で、
    // いちばん見たい一瞬が落ちる。**
    const values = Array.from({ length: SAMPLES }, () => 0)
    values[5] = 300
    const b = buffer()
    b.push(chunk({ gal: [values, values, values] }))

    expect(b.readWindow(0, 300, 3).axes[0][0]).toEqual({
      minGal: 0,
      maxGal: 300,
      gapBefore: false,
    })
  })

  it('窓の外のサンプルは入らない', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 })) // 0〜300 ms

    const window = b.readWindow(1000, 1300, 3)

    expect(window.axes[0]).toEqual([null, null, null])
    expect(window.stats[0]).toBeNull()
  })

  it('列数が 0 以下、または窓が逆向きなら何も返さない', () => {
    const b = buffer()
    b.push(chunk())

    expect(b.readWindow(0, 300, 0).axes[0]).toEqual([])
    expect(b.readWindow(300, 0, 3).axes[0]).toEqual([])
    expect(b.readWindow(300, 300, 3).axes[0]).toEqual([])
  })

  it('軸ごとの平均と、そこからの最大の隔たりを返す', () => {
    // **重力が乗った軸でこれが要る。** 校正を通しても重力は残るので、上向き軸は
    // 980 gal 付近が定常値（実機の静止窓で `axisMeanGal: [0.00, -0.00, 980.67]`）。
    // 0 を中心に描くと、見たい数 gal の揺れが 980 の目盛りに埋もれる。
    const values = Array.from({ length: SAMPLES }, () => 980)
    values[5] = 985
    values[9] = 977
    const b = buffer()
    b.push(chunk({ gal: [values, values, values] }))

    const stats = b.readWindow(0, 300, 3).stats[2]
    expect(stats?.sampleCount).toBe(SAMPLES)
    expect(stats?.meanGal).toBeCloseTo(980.07, 1)
    // 上へ 4.93、下へ 3.07。**遠いほうを採る。**
    expect(stats?.maxDeviationGal).toBeCloseTo(4.93, 1)
  })

  it('負の側が遠ければ、そちらを最大の隔たりにする（対照）', () => {
    const values = Array.from({ length: SAMPLES }, () => 0)
    values[3] = -250
    values[7] = 100
    const b = buffer()
    b.push(chunk({ gal: [values, values, values] }))

    const stats = b.readWindow(0, 300, 3).stats[0]
    expect(stats?.maxDeviationGal).toBeCloseTo(245, 0)
  })

  it('区間が変わったら切れ目の印が立つ', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 }))
    b.push(chunk({ firstSampleMs: 300, segmentId: 2 }))

    expect(b.readWindow(300, 600, 1).axes[0][0]?.gapBefore).toBe(true)
  })

  it('基板が再起動したら切れ目の印が立つ（時刻が続いていても）', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 }))
    b.push(chunk({ firstSampleMs: 300, streamKey: 'board-1/accel-0/boot-2' }))

    expect(b.readWindow(300, 600, 1).axes[0][0]?.gapBefore).toBe(true)
  })

  it('時刻が飛んだら切れ目の印が立つ', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 }))
    b.push(chunk({ firstSampleMs: 1000 })) // 300 ms で終わるはずの続きが 1000 ms から

    expect(b.readWindow(1000, 1300, 1).axes[0][0]?.gapBefore).toBe(true)
  })

  it('続いていれば切れ目は立たない（対照）', () => {
    // **これが無いと、切れ目を出す変更が「常に切れ目」へ化けても気づけない。**
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 }))
    b.push(chunk({ firstSampleMs: 300 }))

    expect(b.readWindow(300, 600, 1).axes[0][0]?.gapBefore).toBe(false)
  })

  it('最初のチャンクは切れ目にしない（対照）', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 }))

    expect(b.readWindow(0, 300, 1).axes[0][0]?.gapBefore).toBe(false)
  })

  it('半サンプルぶんまでのずれは続きとして扱う', () => {
    // 時刻は区間の当てはめから引いた値なので、丸めのぶんだけ揺らぐ。
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 }))
    b.push(chunk({ firstSampleMs: 304 })) // 刻み 10 ms の半分（5 ms）未満

    expect(b.readWindow(304, 604, 1).axes[0][0]?.gapBefore).toBe(false)
  })

  it('切れ目の印は、同じ列に続くサンプルに消されない', () => {
    // 切れ目の後ろのサンプルが同じ列へ入るとき、後から上書きすると印が消える。
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0 }))
    b.push(chunk({ firstSampleMs: 1000, segmentId: 2 }))

    // 窓を広く取り、2 つ目のチャンク全部が 1 列に収まるようにする。
    expect(b.readWindow(1000, 2000, 1).axes[0][0]?.gapBefore).toBe(true)
  })

  it('時刻が巻き戻ったら、持っているものを捨てて積み直す（安全弁）', () => {
    // **並びが時刻順であることを切り出しが当てにしている。** 基板の入れ替えや
    // 時計の飛びで崩れた並びを抱えると、窓の切り出しが黙って壊れる。
    const b = buffer()
    b.push(chunk({ firstSampleMs: 10_000 }))
    b.push(chunk({ firstSampleMs: 1000 }))

    expect(b.chunkCount).toBe(1)
    expect(b.range()).toEqual({ fromMs: 1000, toMs: 1300 })
  })

  it('捨てた回数を数える（安全弁）', () => {
    // **黙って捨てない。** 数えないと「開いた直後で溜まりが少ない」のと
    // 「5 分ぶんが消えた」のを運用者が区別できない。
    const b = buffer()
    expect(b.rewindCount).toBe(0)

    b.push(chunk({ firstSampleMs: 10_000 }))
    b.push(chunk({ firstSampleMs: 1000 }))
    b.push(chunk({ firstSampleMs: 500 }))

    expect(b.rewindCount).toBe(2)
  })

  it('捨てた直後の 1 つは切れ目にする（安全弁）', () => {
    // **`isGap` は捨てた後だと比べる相手が無く、必ず「続き」と答える。**
    // そのままだと 5 分ぶんが消えたのに「普通に波形が始まった」としか見えない
    // （レビューが 2 本とも指した形）。
    const b = buffer()
    b.push(chunk({ firstSampleMs: 10_000 }))
    b.push(chunk({ firstSampleMs: 1000 }))

    expect(b.readWindow(1000, 1300, 1).axes[0][0]?.gapBefore).toBe(true)
  })

  it('件数の上限で落とした回数は、保持時間で落ちた分と分けて数える', () => {
    // 前者は「5 分遡れる」という約束が破れた印、後者は約束どおりの振る舞い。
    const b = buffer({ maxChunks: 2 })
    b.push(flat(0, 1))
    b.push(flat(300, 2))
    expect(b.droppedByCountLimit).toBe(0)

    b.push(flat(600, 3))
    expect(b.droppedByCountLimit).toBe(1)
  })

  it('保持時間で落ちただけなら、件数上限の数には入れない（対照）', () => {
    const b = buffer({ retainMs: 500 })
    b.push(flat(0, 1))
    b.push(flat(2000, 2))

    expect(b.chunkCount).toBe(1)
    expect(b.droppedByCountLimit).toBe(0)
  })

  it('保持する長さを過ぎたチャンクだけを捨てる（安全弁と対照）', () => {
    const b = buffer({ retainMs: 1800 })
    b.push(flat(0, 1))
    b.push(flat(300, 2))
    b.push(flat(600, 3))
    expect(b.chunkCount).toBe(3)

    // 最新の終端は 2300 ms。保持の境目は 500 ms なので、終端 300 ms の先頭だけが
    // 外れる —— 終端 600 ms の 2 つ目は残る（**まとめて捨てないことの対照**）。
    b.push(flat(2000, 4))

    expect(b.chunkCount).toBe(3)
    expect(b.range()?.fromMs).toBe(300)
  })

  it('件数の上限に達したら、古いものから捨てる（安全弁）', () => {
    // **時間だけで区切ると足りない。** 刻みの細かいチャンクが届くと、同じ長さでも
    // 件数だけが膨らむ。
    const b = buffer({ maxChunks: 2 })
    b.push(flat(0, 1))
    b.push(flat(300, 2))
    b.push(flat(600, 3))

    expect(b.chunkCount).toBe(2)
    expect(b.range()?.fromMs).toBe(300)
  })

  it('時刻の当てはめが倒れた区間が窓に入れば、そのことが出る', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0, timebaseNominalReason: 'too-few-points' }))

    expect(b.readWindow(0, 300, 3).timebaseNominal).toBe(true)
  })

  it('倒れた区間が窓の外なら出さない（対照）', () => {
    const b = buffer()
    b.push(chunk({ firstSampleMs: 0, timebaseNominalReason: 'too-few-points' }))
    b.push(chunk({ firstSampleMs: 300 }))

    expect(b.readWindow(300, 600, 3).timebaseNominal).toBe(false)
  })

  it('3 軸の長さが違えば、短いものに合わせる（安全弁）', () => {
    const b = buffer()
    b.push(chunk({ gal: [[1, 2, 3], [1, 2], [1, 2, 3, 4]] }))

    expect(b.range()).toEqual({ fromMs: 0, toMs: 2 * MS_PER_SAMPLE })
  })

  it('中身の無いチャンクは積まない', () => {
    const b = buffer()
    b.push(chunk({ gal: [[], [], []] }))

    expect(b.chunkCount).toBe(0)
    expect(b.range()).toBeNull()
  })

})

describe('WaveStore', () => {
  it('センサーごとに分け、届いた順に並べる', () => {
    const store = new WaveStore()
    store.push(chunk({ boardKey: 'b2', sensorId: 's1' }))
    store.push(chunk({ boardKey: 'b1', sensorId: 's1' }))
    store.push(chunk({ boardKey: 'b2', sensorId: 's1', firstSampleMs: 300 }))

    const buffers = store.buffersInOrder()
    expect(
      buffers.map((b) =>
        b.source.kind === 'sensor' ? `${b.source.boardKey}/${b.source.sensorId}` : b.source.stationId,
      ),
    ).toEqual(['b2/s1', 'b1/s1'])
    expect(buffers[0].chunkCount).toBe(2)
  })

  it('境目の違う名前を別のセンサーとして扱う（安全弁）', () => {
    // **区切り文字で鍵を作ると、この 2 本が同じ鍵に化ける。** 症状は「2 本の波形が
    // 1 本へ混ざる」で、画面では片方が黙っただけにしか見えない。
    const store = new WaveStore()
    store.push(chunk({ boardKey: 'ab', sensorId: 'c' }))
    store.push(chunk({ boardKey: 'a', sensorId: 'bc' }))

    expect(store.buffersInOrder()).toHaveLength(2)
  })

  it('受け付ける本数に上限があり、断った件数を数える（安全弁）', () => {
    // `boardKey`・`sensorId` は無認証の UDP パケット由来で検証が無い。名前を変えながら
    // 投げ続けられたときに、溜め場所が際限なく増えないこと。
    const store = new WaveStore({ maxSources: 2 })
    store.push(chunk({ boardKey: 'b1', sensorId: 's1' }))
    store.push(chunk({ boardKey: 'b2', sensorId: 's2' }))
    store.push(chunk({ boardKey: 'b3', sensorId: 's3' }))
    store.push(chunk({ boardKey: 'b4', sensorId: 's4' }))

    expect(store.buffersInOrder()).toHaveLength(2)
    expect(store.rejectedSources).toBe(2)
  })

  it('上限に達していても、既に受け付けたセンサーは積み続ける（対照）', () => {
    const store = new WaveStore({ maxSources: 1 })
    store.push(chunk({ boardKey: 'b1', sensorId: 's1' }))
    store.push(chunk({ boardKey: 'b9', sensorId: 's9' }))
    store.push(chunk({ boardKey: 'b1', sensorId: 's1', firstSampleMs: 300 }))

    expect(store.get({ kind: 'sensor', boardKey: 'b1', sensorId: 's1' })?.chunkCount).toBe(2)
  })

  it('捨てた回数・落とした回数を全センサーぶん合わせて出す', () => {
    const store = new WaveStore({ maxChunks: 2 })
    store.push(chunk({ boardKey: 'b1', firstSampleMs: 10_000 }))
    store.push(chunk({ boardKey: 'b1', firstSampleMs: 1000 })) // 巻き戻り
    store.push(chunk({ boardKey: 'b2', firstSampleMs: 10_000 }))
    store.push(chunk({ boardKey: 'b2', firstSampleMs: 1000 })) // 巻き戻り
    store.push(chunk({ boardKey: 'b2', firstSampleMs: 1300 }))
    store.push(chunk({ boardKey: 'b2', firstSampleMs: 1600 })) // 件数上限

    expect(store.rewindCount).toBe(2)
    expect(store.droppedByCountLimit).toBe(1)
  })

  it('全センサーを通した範囲を返す', () => {
    const store = new WaveStore()
    store.push(chunk({ boardKey: 'b1', sensorId: 's1', firstSampleMs: 1000 }))
    store.push(chunk({ boardKey: 'b2', sensorId: 's2', firstSampleMs: 2000 }))

    expect(store.range()).toEqual({ fromMs: 1000, toMs: 2300 })
  })

  it('1 本も届いていなければ範囲は無い', () => {
    expect(new WaveStore().range()).toBeNull()
  })

  it('正: 観測点の合成も同じ溜め場所へ入り、混ざった本数が出る（#315）', () => {
    const store = new WaveStore()
    store.push(stationChunk())

    const buffer = store.get({ kind: 'station', stationId: 'garage' })
    expect(buffer?.chunkCount).toBe(1)
    // **待ちが効いていれば台数と同じ値で最小＝最大。** 幅が出ていること自体が
    // 顔ぶれの入れ替わり（#362 の症状）の印。
    expect(buffer?.memberRange).toEqual({ min: 9, max: 9 })
  })

  it('対照: センサー単独では混ざった本数を持たない', () => {
    const store = new WaveStore()
    store.push(chunk())

    expect(store.get({ kind: 'sensor', boardKey: 'board-1', sensorId: 'accel-0' })?.memberRange).toBeNull()
  })

  it('安全弁: 観測点の識別子とセンサーの鍵が同じ文字列に化けない', () => {
    // **種別の印が無いと、この 2 本が同じ行へ混ざりうる。** 症状は「合成の波形と
    // センサー単独の波形が 1 本に見える」で、画面では片方が黙っただけにしか見えない。
    const store = new WaveStore()
    store.push(stationChunk({ source: { kind: 'station', stationId: '7:board-1accel-0' } }))
    store.push(chunk())

    expect(store.buffersInOrder()).toHaveLength(2)
  })

  it('安全弁: 合成の本数が揺れていたら、最小と最大が食い違う形で出る', () => {
    const store = new WaveStore()
    store.push(stationChunk({ memberCount: [1, 4, 7, 2] }))

    expect(store.get({ kind: 'station', stationId: 'garage' })?.memberRange).toEqual({ min: 1, max: 7 })
  })

  it('知らないセンサーを引いたら null', () => {
    expect(new WaveStore().get({ kind: 'sensor', boardKey: 'b1', sensorId: 's1' })).toBeNull()
  })
})
