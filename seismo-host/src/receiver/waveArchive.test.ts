import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FusedWaveChunk } from './sensorFusion'
import {
  WaveArchive,
  decodeWaveFile,
  encodeWaveChunk,
  readWaveRange,
  stationFileToken,
  waveFileName,
} from './waveArchive'

/** 2026-09-25 23:00 JST。日本時間では 25 日、UTC では 24 日 —— **境目の向きを見分ける値**。 */
const AT_2026_09_25_2300_JST = Date.parse('2026-09-25T14:00:00.000Z')

const HOUR_MS = 60 * 60 * 1000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seismo-wave-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * `want()` が真になるまで待つ。**固定時間で待たない。**
 *
 * 待っているのはファイル書き込みの非同期のコールバックで、届くまでの時間は
 * その機械の都合で決まる。
 */
async function until(want: () => boolean, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!want()) {
    if (Date.now() > deadline) throw new Error('待ちきれませんでした')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function makeChunk(overrides: Partial<FusedWaveChunk> = {}): FusedWaveChunk {
  return {
    stationId: 'station-1',
    driver: { boardKey: 'mac:aabbccddee01', sensorId: 'i2c0-68' },
    firstSampleIndex: 0,
    firstSampleMs: AT_2026_09_25_2300_JST,
    msPerSample: 10,
    gal: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
    dcGal: [
      [100, 102, 104],
      [0, 0, 0],
      [980, 980, 980],
    ],
    memberCount: [3, 3, 2],
    ...overrides,
  }
}

describe('stationFileToken', () => {
  it('ファイル名に使えない文字を落とす', () => {
    expect(stationFileToken('../etc/passwd')).toMatch(/^\.\.?|^[A-Za-z0-9_-]+$/)
    expect(stationFileToken('a/b')).not.toContain('/')
    expect(stationFileToken('C:\\x')).not.toContain('\\')
  })

  it('均すと同じになる 2 つを別の名前にする', () => {
    // **指紋が無ければここが同じ名前になる** —— 別の観測点の波形が 1 本へ混ざる。
    expect(stationFileToken('a/b')).not.toBe(stationFileToken('a_b'))
  })

  it('同じ識別子からは何度でも同じ名前になる', () => {
    expect(stationFileToken('station-1')).toBe(stationFileToken('station-1'))
  })
})

describe('encodeWaveChunk', () => {
  it('書いたものをそのまま読み返せる', () => {
    const buf = encodeWaveChunk(makeChunk())
    expect(buf).not.toBeNull()
    const { chunks, skippedBytes } = decodeWaveFile(buf as Buffer, 0, Number.MAX_SAFE_INTEGER)
    expect(skippedBytes).toBe(0)
    expect(chunks).toHaveLength(1)
    const c = chunks[0]
    expect(c.firstSampleMs).toBe(AT_2026_09_25_2300_JST)
    expect(c.msPerSample).toBe(10)
    expect([...c.gal[0]]).toEqual([1, 2, 3])
    expect([...c.gal[1]]).toEqual([4, 5, 6])
    expect([...c.gal[2]]).toEqual([7, 8, 9])
    expect([...c.memberCount]).toEqual([3, 3, 2])
  })

  it('直流はまとまりごとの平均になる', () => {
    const buf = encodeWaveChunk(makeChunk())
    const { chunks } = decodeWaveFile(buf as Buffer, 0, Number.MAX_SAFE_INTEGER)
    expect(chunks[0].dcGal[0]).toBeCloseTo(102, 3)
    expect(chunks[0].dcGal[1]).toBeCloseTo(0, 3)
    expect(chunks[0].dcGal[2]).toBeCloseTo(980, 3)
  })

  it('読めない値はそのまま残す（欠測を埋めない）', () => {
    const buf = encodeWaveChunk(makeChunk({ gal: [[Number.NaN, 2, 3], [4, 5, 6], [7, 8, 9]] }))
    const { chunks } = decodeWaveFile(buf as Buffer, 0, Number.MAX_SAFE_INTEGER)
    expect(Number.isNaN(chunks[0].gal[0][0])).toBe(true)
    expect(chunks[0].gal[0][1]).toBe(2)
  })

  it('3 軸の長さが揃っていなければ形にしない', () => {
    expect(encodeWaveChunk(makeChunk({ gal: [[1, 2], [4, 5, 6], [7, 8, 9]] }))).toBeNull()
  })

  it('効いた本数の並びが短ければ形にしない', () => {
    expect(encodeWaveChunk(makeChunk({ memberCount: [3, 3] }))).toBeNull()
  })

  it('刻みが正でなければ形にしない', () => {
    expect(encodeWaveChunk(makeChunk({ msPerSample: 0 }))).toBeNull()
    expect(encodeWaveChunk(makeChunk({ msPerSample: Number.NaN }))).toBeNull()
  })

  it('時刻が数でなければ形にしない', () => {
    expect(encodeWaveChunk(makeChunk({ firstSampleMs: Number.NaN }))).toBeNull()
  })

  it('3 成分でなければ形にしない（投げない）', () => {
    // **型の組（タプル）だけに頼らない。** ここで投げると、このまとまりを運んできた
    // データグラムの処理が丸ごと落ちる（受け手は例外を囲わない方針）。
    const twoAxes = makeChunk() as unknown as { gal: unknown; dcGal: unknown }
    twoAxes.gal = [[1], [2]]
    expect(encodeWaveChunk(twoAxes as unknown as FusedWaveChunk)).toBeNull()

    const twoDc = makeChunk() as unknown as { dcGal: unknown }
    twoDc.dcGal = [[0], [0]]
    expect(encodeWaveChunk(twoDc as unknown as FusedWaveChunk)).toBeNull()
  })

  it('1 まとまりが覆う長さが上限を超えたら形にしない', () => {
    // **読み返しは「まとまりは高々 1 時間ぶん」を前提に 1 時間だけ遡る。**
    // 超えるまとまりは、後の時から問い合わせたときに読み落とされる。
    expect(encodeWaveChunk(makeChunk({ msPerSample: 600_000 }))).toBeNull()
    // 対照: 上限の内側なら通る（3 サンプル・10 分刻みは 20 分ぶんで超過、5 分なら 10 分ちょうど）
    expect(encodeWaveChunk(makeChunk({ msPerSample: 300_000 }))).not.toBeNull()
  })
})

describe('decodeWaveFile', () => {
  it('範囲に重ならないまとまりは返さない', () => {
    const buf = encodeWaveChunk(makeChunk()) as Buffer
    const { chunks } = decodeWaveFile(buf, AT_2026_09_25_2300_JST + 10_000, AT_2026_09_25_2300_JST + 20_000)
    expect(chunks).toHaveLength(0)
  })

  it('範囲の端を跨ぐまとまりは返す', () => {
    // 3 サンプル・10ms 刻みなので [t, t+20]。範囲を末尾のサンプルだけに重ねる。
    const buf = encodeWaveChunk(makeChunk()) as Buffer
    const { chunks } = decodeWaveFile(buf, AT_2026_09_25_2300_JST + 20, AT_2026_09_25_2300_JST + 5_000)
    expect(chunks).toHaveLength(1)
  })

  it('末尾が切れていればそこで打ち切り、読まなかった量を返す', () => {
    const whole = encodeWaveChunk(makeChunk()) as Buffer
    const cut = Buffer.concat([whole, whole.subarray(0, 10)])
    const { chunks, skippedBytes } = decodeWaveFile(cut, 0, Number.MAX_SAFE_INTEGER)
    expect(chunks).toHaveLength(1)
    expect(skippedBytes).toBe(10)
  })

  it('知らない版はそこで打ち切る', () => {
    const buf = Buffer.from(encodeWaveChunk(makeChunk()) as Buffer)
    buf.writeUInt8(99, 4)
    const { chunks, skippedBytes } = decodeWaveFile(buf, 0, Number.MAX_SAFE_INTEGER)
    expect(chunks).toHaveLength(0)
    expect(skippedBytes).toBe(buf.length)
  })

  it('頭の目印が合わなければそこで打ち切る', () => {
    const buf = Buffer.from(encodeWaveChunk(makeChunk()) as Buffer)
    buf.writeUInt16LE(0x1234, 0)
    const { chunks, skippedBytes } = decodeWaveFile(buf, 0, Number.MAX_SAFE_INTEGER)
    expect(chunks).toHaveLength(0)
    expect(skippedBytes).toBe(buf.length)
  })
})

describe('WaveArchive', () => {
  it('書いたまとまりを時刻の範囲で読み返せる', async () => {
    const archive = new WaveArchive({ dir })
    expect(archive.write(makeChunk()).saved).toBe(true)
    await archive.close()

    const got = await readWaveRange({
      dir,
      stationId: 'station-1',
      fromMs: AT_2026_09_25_2300_JST - 1_000,
      toMs: AT_2026_09_25_2300_JST + 1_000,
    })
    expect(got.chunks).toHaveLength(1)
    expect([...got.chunks[0].gal[0]]).toEqual([1, 2, 3])
    expect(got.filesRead).toBe(1)
    expect(got.skippedBytes).toBe(0)
    expect(got.truncated).toBe(false)
  })

  it('時が変わると別のファイルへ書く', async () => {
    const archive = new WaveArchive({ dir })
    archive.write(makeChunk())
    archive.write(makeChunk({ firstSampleMs: AT_2026_09_25_2300_JST + HOUR_MS }))
    await archive.close()

    expect(readdirSync(dir).filter((f) => f.endsWith('.bin'))).toHaveLength(2)
    expect(archive.rotated).toBe(1)
  })

  it('時の境目を跨いだまとまりも、後の時を問い合わせれば拾える', async () => {
    // **1 つ前の時のファイルの末尾にいる。** ここを読まないと、境目の直前に届いた
    // まとまりが範囲から落ちる。
    const archive = new WaveArchive({ dir })
    const justBefore = AT_2026_09_25_2300_JST + HOUR_MS - 10
    archive.write(makeChunk({ firstSampleMs: justBefore }))
    await archive.close()

    const got = await readWaveRange({
      dir,
      stationId: 'station-1',
      fromMs: justBefore + 15,
      toMs: justBefore + 5_000,
    })
    expect(got.chunks).toHaveLength(1)
  })

  it('観測点ごとに別のファイルへ書く', async () => {
    const archive = new WaveArchive({ dir })
    archive.write(makeChunk())
    archive.write(makeChunk({ stationId: 'station-2' }))
    await archive.close()

    expect(readdirSync(dir).filter((f) => f.endsWith('.bin'))).toHaveLength(2)
    const got = await readWaveRange({
      dir,
      stationId: 'station-2',
      fromMs: AT_2026_09_25_2300_JST - 1_000,
      toMs: AT_2026_09_25_2300_JST + 1_000,
    })
    expect(got.chunks).toHaveLength(1)
  })

  it('記録の無い時は「無かった」として数え、失敗と分ける', async () => {
    const got = await readWaveRange({
      dir,
      stationId: 'station-1',
      fromMs: AT_2026_09_25_2300_JST,
      toMs: AT_2026_09_25_2300_JST + 1_000,
    })
    expect(got.chunks).toHaveLength(0)
    expect(got.filesRead).toBe(0)
    expect(got.filesFailed).toBe(0)
    expect(got.filesMissing).toBeGreaterThan(0)
  })

  it('サンプルの無いまとまりは書かないが、失ったとは数えない', () => {
    const archive = new WaveArchive({ dir })
    const result = archive.write(makeChunk({ gal: [[], [], []], dcGal: [[], [], []], memberCount: [] }))
    expect(result).toEqual({ saved: true, empty: true })
    expect(archive.lostRecords).toBe(0)
    expect(archive.badChunks).toBe(0)
    expect(archive.written).toBe(0)
  })

  it('3 成分でないまとまりを渡されても投げず、形にできないものとして数える', () => {
    // **空かどうかの判定で `gal[0]` へ直に触ると、ここで `undefined.length` を読む。**
    // 投げた先はこのまとまりを運んできたデータグラムの処理全体で、震度も自己診断も
    // まとめて落ちるうえ、どの数え上げにも現れない。
    const archive = new WaveArchive({ dir })
    const broken = makeChunk() as unknown as { gal: unknown }
    broken.gal = []
    expect(archive.write(broken as unknown as FusedWaveChunk)).toEqual({
      saved: false,
      reason: 'bad-chunk',
    })
    expect(archive.badChunks).toBe(1)
  })

  it('形にできないまとまりは捨て、ディスクの異常とは分けて数える', () => {
    const archive = new WaveArchive({ dir })
    expect(archive.write(makeChunk({ msPerSample: 0 })).saved).toBe(false)
    expect(archive.badChunks).toBe(1)
    expect(archive.lostRecords).toBe(0)
    expect(archive.writeErrors).toBe(0)
  })

  it('時刻として表せなければ捨てる', () => {
    const archive = new WaveArchive({ dir })
    const result = archive.write(makeChunk({ firstSampleMs: Number.POSITIVE_INFINITY }))
    expect(result).toEqual({ saved: false, reason: 'bad-chunk' })
    expect(archive.badChunks).toBe(1)
  })

  it('締めたあとは断る', async () => {
    const archive = new WaveArchive({ dir })
    await archive.close()
    expect(archive.write(makeChunk())).toEqual({ saved: false, reason: 'closed' })
  })

  it('流し口を開けなければ間隔を空けて待つ', () => {
    let now = 1_000
    let opened = 0
    const archive = new WaveArchive({
      dir,
      now: () => now,
      reopenIntervalMs: 5_000,
      openStream: () => {
        opened += 1
        throw new Error('開けません')
      },
    })
    expect(archive.write(makeChunk())).toEqual({ saved: false, reason: 'no-stream' })
    expect(opened).toBe(1)
    // **すぐには開き直さない。** 詰まったディスクを叩き続けないため。
    expect(archive.write(makeChunk())).toEqual({ saved: false, reason: 'no-stream' })
    expect(opened).toBe(1)
    now += 5_000
    expect(archive.write(makeChunk())).toEqual({ saved: false, reason: 'no-stream' })
    expect(opened).toBe(2)
    expect(archive.writeErrors).toBe(2)
    // **開けなかった間に来たぶんも「失った」に数える。** 流し口が壊れた回数は
    // 開き直しの間隔ごとにしか増えないので、あれだけでは失った量が桁で分からない。
    expect(archive.lostRecords).toBe(3)
  })

  it('締めくくりを待ちきれなければ諦め、その事実を残す', async () => {
    // `end()` のコールバックを呼ばない流し口。**閉じ終わらない。**
    const archive = new WaveArchive({
      dir,
      closeBudgetMs: 20,
      openStream: () =>
        new Writable({
          write(_chunk, _enc, done) {
            done()
          },
          final() {
            // 呼ばない（閉じ終わらない相手）
          },
        }),
    })
    archive.write(makeChunk())
    await archive.close()
    // **諦めても失ってはいない**（渡し終えた分は OS が引き取っている）。
    expect(archive.slowClose).toBe(true)
    expect(archive.lostRecords).toBe(0)
  })

  it('締めくくりが間に合えば、待ちきれなかったとは言わない（対照）', async () => {
    const archive = new WaveArchive({ dir, closeBudgetMs: 2_000 })
    archive.write(makeChunk())
    await archive.close()
    expect(archive.slowClose).toBe(false)
  })

  it('書き込みが投げたら本を捨て、失ったと数える', () => {
    const archive = new WaveArchive({
      dir,
      openStream: () =>
        new Writable({
          write() {
            throw new Error('書けません')
          },
        }),
    })
    expect(archive.write(makeChunk())).toEqual({ saved: false, reason: 'write-failed' })
    expect(archive.lostRecords).toBe(1)
    expect(archive.writeErrors).toBe(1)
    expect(archive.openBooks).toBe(0)
  })

  it('抱えた量が上限を超えたら捨てる', () => {
    // 流れを進めない（コールバックを呼ばない）流し口。**抱えたまま増える。**
    const archive = new WaveArchive({
      dir,
      maxPendingBytes: 100,
      openStream: () => new Writable({ write() {} }),
    })
    // 1 まとまり = 頭 32 + 3 サンプル × 13 = 71 バイト。2 つ目で 142 となり上限を超える。
    expect(archive.write(makeChunk()).saved).toBe(true)
    expect(archive.write(makeChunk())).toEqual({ saved: false, reason: 'backpressure' })
    expect(archive.lostRecords).toBe(1)
    // **流し口は壊れていない。** 混ぜると、遅いだけの記憶装置が「壊れた」と報される。
    expect(archive.writeErrors).toBe(0)
  })

  it('ファイル名は観測点と時から決まる', async () => {
    const archive = new WaveArchive({ dir })
    archive.write(makeChunk())
    await archive.close()
    await until(() => readdirSync(dir).length > 0)
    expect(readdirSync(dir)).toContain(waveFileName('station-1', '2026-09-25T23'))
  })

  it('壊れたファイルがあっても、読めるところまでは返す', async () => {
    const archive = new WaveArchive({ dir })
    archive.write(makeChunk())
    await archive.close()
    await until(() => readdirSync(dir).length > 0)

    const path = join(dir, waveFileName('station-1', '2026-09-25T23'))
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([1, 2, 3])]))

    const got = await readWaveRange({
      dir,
      stationId: 'station-1',
      fromMs: AT_2026_09_25_2300_JST - 1_000,
      toMs: AT_2026_09_25_2300_JST + 1_000,
    })
    expect(got.chunks).toHaveLength(1)
    expect(got.skippedBytes).toBe(3)
  })

  it('範囲が逆順なら何も読まない', async () => {
    const got = await readWaveRange({
      dir,
      stationId: 'station-1',
      fromMs: AT_2026_09_25_2300_JST + 1_000,
      toMs: AT_2026_09_25_2300_JST,
    })
    expect(got.chunks).toHaveLength(0)
    expect(got.filesMissing).toBe(0)
  })

  it('範囲が広すぎれば上限で切り、切ったことを知らせる', async () => {
    const got = await readWaveRange({
      dir,
      stationId: 'station-1',
      fromMs: AT_2026_09_25_2300_JST,
      toMs: AT_2026_09_25_2300_JST + 48 * HOUR_MS,
    })
    expect(got.truncated).toBe(true)
  })
})
