import { describe, expect, it } from 'vitest'

import { SensorHealthBook } from './sensorHealth'

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

describe('SensorHealthBook', () => {
  it('同じ基板でもセンサーごとに別の行になる', () => {
    const book = new SensorHealthBook()
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'k0' })
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's1', streamKey: 'k1' })

    // **基板で丸めると、3 個のうち 1 個が死んでも健全に見える。**
    expect(book.size).toBe(2)
  })

  it('基板が再起動しても同じ行のまま（流れの鍵だけ新しくなる）', () => {
    const book = new SensorHealthBook()
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'mac:aa|s0|boot1' })
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'mac:aa|s0|boot2' })

    // 流れの鍵で覚えると、古い行が「黙ったセンサー」として永久に残る
    expect(book.size).toBe(1)
    expect(book.snapshot()[0].streamKey).toBe('mac:aa|s0|boot2')
  })

  it('最後にパケットが届いた時刻は受け手の時計で進む', () => {
    const t = clock()
    const book = new SensorHealthBook({ now: t.now })
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'k' })
    const first = book.snapshot()[0].lastPacketMs

    t.advance(5_000)
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'k' })

    expect(book.snapshot()[0].lastPacketMs).toBe(first + 5_000)
  })

  it('震度が出せなかった回でも、直前まで出ていた値を消さない', () => {
    const book = new SensorHealthBook()
    const base = {
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'k',
      segmentId: 1,
      timebaseNominalReason: null,
    } as const
    book.noteReading({ ...base, atMs: 1_000, intensity: 2.5 })
    book.noteReading({ ...base, atMs: 2_000, intensity: null })

    const s = book.snapshot()[0]
    // 「時刻は進んでいるのに値が古い」組が、いま値を出せていない印になる
    expect(s.lastIntensity).toBe(2.5)
    expect(s.lastReadingAtMs).toBe(2_000)
  })

  it('時刻の当てはめが倒れていたら理由を残す', () => {
    const book = new SensorHealthBook()
    book.noteReading({
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'k',
      segmentId: 1,
      atMs: 1_000,
      intensity: 1,
      timebaseNominalReason: 'too-few-anchors',
    })

    expect(book.snapshot()[0].lastNominalReason).toBe('too-few-anchors')
  })

  it('上限に達したら、いちばん長く音沙汰の無いものを押し出して数える', () => {
    const t = clock()
    const book = new SensorHealthBook({ maxSensors: 2, now: t.now })
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'k' })
    t.advance(1_000)
    book.notePacket({ boardKey: 'mac:bb', sensorId: 's0', streamKey: 'k' })
    t.advance(1_000)
    // 1 つ目に触れ直すと、押し出される順が入れ替わる
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'k' })
    t.advance(1_000)

    book.notePacket({ boardKey: 'mac:cc', sensorId: 's0', streamKey: 'k' })

    expect(book.size).toBe(2)
    expect(book.evictions).toBe(1)
    expect(book.snapshot().map((s) => s.boardKey).sort()).toEqual(['mac:aa', 'mac:cc'])
  })

  it('音沙汰の新しい順に返す（黙ったものが末尾へ寄る）', () => {
    const t = clock()
    const book = new SensorHealthBook({ now: t.now })
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'k' })
    t.advance(1_000)
    book.notePacket({ boardKey: 'mac:bb', sensorId: 's0', streamKey: 'k' })
    t.advance(1_000)
    book.notePacket({ boardKey: 'mac:cc', sensorId: 's0', streamKey: 'k' })

    expect(book.snapshot().map((s) => s.boardKey)).toEqual(['mac:cc', 'mac:bb', 'mac:aa'])
  })

  it('パケットが届いただけでは区間の番号を埋めない', () => {
    const book = new SensorHealthBook()
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'k' })

    // 0 を入れると、実在しない「0 番の区間」が状態の口に出る
    expect(book.snapshot()[0].segmentId).toBeNull()
  })

  it('震度を出せない理由を覚え、震度が出たら落とす', () => {
    const book = new SensorHealthBook()
    // **流れの名乗りは実運用と同じに揃える。** パケットと震度は同じ流れから来るので、
    // ここを食い違わせると「古い世代の読み」の門に当たって落ちる。
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'mac:aa|s0|boot1' })
    book.noteSkip({
      boardKey: 'mac:aa',
      sensorId: 's0',
      reason: 'axis-count',
      streamKey: 'mac:aa|s0|boot1',
      segmentId: 2,
    })

    // この理由は区間が始まった回にしか返らない。覚えないと起動直後の 1 行きり
    expect(book.snapshot()[0].lastSkipReason).toBe('axis-count')

    book.noteReading({
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'mac:aa|s0|boot1',
      segmentId: 3,
      atMs: 1_000,
      intensity: 1,
      timebaseNominalReason: null,
    })

    // 直ったのに古い理由が居座ると、いつのものか読めなくなる
    expect(book.snapshot()[0].lastSkipReason).toBeNull()
  })

  it('区間が再開した回に届く旧区間の締めくくりでは、理由を消さない', () => {
    const book = new SensorHealthBook()
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'mac:aa|s0|boot1' })
    // 軸が 2 本になった区間（2 番）が始まり、震度を出せないと決まる
    book.noteSkip({
      boardKey: 'mac:aa',
      sensorId: 's0',
      reason: 'axis-count',
      streamKey: 'mac:aa|s0|boot1',
      segmentId: 2,
    })
    // **同じパケットの中で**、閉じた旧区間（1 番）の締めくくりが届く。
    // 区間の再開は前の区間を閉じるので、末尾に溜まっていた窓がそこで吐き出される。
    book.noteReading({
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'mac:aa|s0|boot1',
      segmentId: 1,
      atMs: 1_000,
      intensity: 2.5,
      timebaseNominalReason: null,
    })

    // 消すと、**壊れたセンサーが「つい今しがた震度を出したばかり」に見える**
    // （`lastReadingAtMs` も同時に進むので、状態の口を後から見た人には健全としか映らない）
    expect(book.snapshot()[0].lastSkipReason).toBe('axis-count')
    // 値そのものは受け取る —— 実際に出た震度で、捨てる理由が無い
    expect(book.snapshot()[0].lastIntensity).toBe(2.5)
  })

  it('枠の上限で追い出された古い起動セッションの締めくくりでは、何も進めない', () => {
    const book = new SensorHealthBook()
    // いま届いているのは再起動後の流れ（boot2）。そこでは震度を出せていない。
    book.notePacket({ boardKey: 'mac:aa', sensorId: 's0', streamKey: 'mac:aa|s0|boot2' })
    book.noteSkip({
      boardKey: 'mac:aa',
      sensorId: 's0',
      reason: 'axis-count',
      streamKey: 'mac:aa|s0|boot2',
      segmentId: 1,
    })

    // 再起動前の流れ（boot1）が、別のセンサーの再起動で枠を押し出されて閉じられ、
    // その締めくくりが同じ入れ物へ届く。**区間の番号は流れごとの連番なので、
    // 番号の比較だけでは新しい読みと見分けられない。**
    book.noteReading({
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'mac:aa|s0|boot1',
      segmentId: 9,
      atMs: 1_000,
      intensity: 2.5,
      timebaseNominalReason: null,
    })

    const got = book.snapshot()[0]
    // 受け取ると、直っていないセンサーが「つい今しがた震度を出した」ように見える
    expect(got.lastSkipReason).toBe('axis-count')
    expect(got.lastIntensity).toBeNull()
    expect(got.lastReadingAtMs).toBeNull()
    // 流れの名乗りも巻き戻さない —— 状態の口が死んだ起動セッションを指してしまう
    expect(got.streamKey).toBe('mac:aa|s0|boot2')
  })

  it('まだパケットを受けていないセンサーの読みは受け取る', () => {
    const book = new SensorHealthBook()

    // 比べる相手が無いので、古い世代かどうかを判定できない。
    // ここで落とすと、締めくくりだけが届いた流れの値がどこにも残らない。
    book.noteReading({
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'mac:aa|s0|boot1',
      segmentId: 1,
      atMs: 1_000,
      intensity: 2.5,
      timebaseNominalReason: null,
    })

    expect(book.snapshot()[0].lastIntensity).toBe(2.5)
  })

  it('別の流れで震度が出たら理由を落とす', () => {
    const book = new SensorHealthBook()
    book.noteSkip({
      boardKey: 'mac:aa',
      sensorId: 's0',
      reason: 'axis-count',
      streamKey: 'mac:aa|s0|boot1',
      segmentId: 2,
    })
    // 基板が再起動して別の流れになり、そちらでは震度が出ている。
    // 区間の番号は流れごとの連番なので、若返っても「古い読み」ではない。
    book.noteReading({
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'mac:aa|s0|boot2',
      segmentId: 1,
      atMs: 2_000,
      intensity: 1,
      timebaseNominalReason: null,
    })

    expect(book.snapshot()[0].lastSkipReason).toBeNull()
  })

  it('震度だけ先に届いた流れも覚える', () => {
    const book = new SensorHealthBook()
    book.noteReading({
      boardKey: 'mac:aa',
      sensorId: 's0',
      streamKey: 'k',
      segmentId: 3,
      atMs: 10,
      intensity: 1,
      timebaseNominalReason: null,
    })

    expect(book.size).toBe(1)
    expect(book.snapshot()[0].segmentId).toBe(3)
  })
})
