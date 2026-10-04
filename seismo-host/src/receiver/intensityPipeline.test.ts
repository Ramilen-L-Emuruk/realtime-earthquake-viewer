import { describe, expect, it } from 'vitest'

import type { SensorPacket } from '../protocol/types'
import { streamKeyOf } from '../timebase/segmenter'
import { IntensityPipeline, normalizeIntensity } from './intensityPipeline'
import type { IntensityReading, PacketOutcome } from './intensityPipeline'
import { StationDirectory } from './stationConfig'
import type { SensorCalibration, StationConfig } from './stationConfig'

/** 実際の記録と同じ起点。時刻が大きい状態で当てはめが効くことも併せて見る。 */
const BASE_MS = 1790181865671
const HZ = 100
const PER_PACKET = 30

/**
 * 刻み（1 秒）。**リアルタイム震度は先読みしない**ので、最初の答えは刻みの位置
 * （100 サンプル）まで届いた時点で出る。
 */
const OPTS = { stepSec: 1 }

/**
 * 机に置いた基板の第 3 軸が名乗る値。**約 1009 gal の直流がそのまま乗る。**
 * 差し引かずに通すと、これが強い揺れとして出る（下の「重力」のテスト）。
 */
const GRAVITY_COUNTS = 16880

/** フルスケール（±2g ≒ 2059 gal）を超えるカウント。換算が範囲の外になる。 */
const OVER_SCALE_COUNTS = 40000

/**
 * 決まった形の揺れ。**乱数を使わない** —— 閾値を実測で決めているので、
 * 走るたびに値が変われば境界のすぐ内側を通ったときに気づけない。
 */
function rows(firstSeq: number, n: number, amp: number): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const t = (firstSeq + i) / HZ
    return [
      Math.round(amp * Math.sin(2 * Math.PI * 3 * t)),
      Math.round(amp * Math.cos(2 * Math.PI * 5 * t)),
      GRAVITY_COUNTS + Math.round(amp * Math.sin(2 * Math.PI * 7 * t)),
    ]
  })
}

/** 静止している基板のゆらぎ（±20 カウント ≒ 1.2 gal）。 */
const QUIET = 20
/** 揺れている状態（±300 カウント ≒ 18 gal）。 */
const SHAKE = 300

function pkt(over: Partial<SensorPacket> = {}, amp = SHAKE): SensorPacket {
  const firstSeq = over.firstSeq ?? 0
  const hz = over.sampleRateHz ?? HZ
  return {
    version: 2,
    boardKey: 'mac:020000000003',
    bootId: '7f3a91c4',
    sensorId: 'i2c0-68',
    sensorType: 'MPU6050',
    channels: ['HN1', 'HN2', 'HN3'],
    ugPerLsb: 61.0352,
    fullScaleG: 2,
    sampleRateHz: hz,
    firstSampleMs: BASE_MS + (firstSeq * 1000) / hz,
    firstSeq,
    overflowCount: 0,
    samples: rows(firstSeq, PER_PACKET, amp),
    ...over,
  }
}

/** 連続した通し番号のパケットを `count` 個流し、集まった震度を返す。 */
function feed(
  pipeline: IntensityPipeline,
  count: number,
  amp = SHAKE,
  fromPacket = 0,
): { readings: IntensityReading[]; outcomes: PacketOutcome[] } {
  const readings: IntensityReading[] = []
  const outcomes: PacketOutcome[] = []
  for (let i = fromPacket; i < fromPacket + count; i++) {
    const out = pipeline.handlePacket(pkt({ firstSeq: i * PER_PACKET }, amp))
    outcomes.push(out)
    readings.push(...out.readings)
  }
  return { readings, outcomes }
}

/** 最初の答えが出るまでに要るパケットの数（刻み 1 秒＝100 サンプルを覆う 4 パケット）。 */
const PACKETS_FOR_FIRST = Math.ceil((HZ * OPTS.stepSec) / PER_PACKET)

const KEY = streamKeyOf(pkt())

/**
 * 内側の覚えを覗く。**公開の口からは見えないものを 2 つ確かめるために使う。**
 *
 * - 閉じた流れの覚えが残っていないか（残ると、二度と戻らない送り手のぶんだけ溜まる）
 * - 位置の食い違いで止まったときの後始末（いまの繋ぎ方では外から踏めない。下記）
 */
interface Innards {
  entries: Map<string, { stream: { push: () => never; end: () => never } | null }>
}

function innards(pipeline: IntensityPipeline): Innards {
  return pipeline as unknown as Innards
}

/** 覚えている流れの数。開いている区間の数と一致していなければならない。 */
function trackedCount(pipeline: IntensityPipeline): number {
  return innards(pipeline).entries.size
}

/**
 * 位置の食い違いを外から起こす手立てが無いので、流し込みの側を壊して投げさせる。
 *
 * **この守りは「将来の配線の誤り」に対するとりで。** いまの繋ぎ方では組み立てが返す
 * 位置と流し込みが待つ位置は必ず一致するので、公開の口からは踏めない。
 */
function breakPush(pipeline: IntensityPipeline, streamKey: string): void {
  const entry = innards(pipeline).entries.get(streamKey)
  if (entry === undefined || entry.stream === null) throw new Error('流し込みが見つからない')
  entry.stream.push = () => {
    throw new Error('渡された位置が続きになっていない（試験用）')
  }
}

/**
 * 締めくくり（`end()`）を投げさせる。**`push` と同じく外からは踏めない**ので、
 * 守りが効いていることを確かめるにはここを壊すしかない。
 */
function breakEnd(pipeline: IntensityPipeline, streamKey: string): void {
  const entry = innards(pipeline).entries.get(streamKey)
  if (entry === undefined || entry.stream === null) throw new Error('流し込みが見つからない')
  entry.stream.end = () => {
    throw new Error('締めくくれない（試験用）')
  }
}

describe('IntensityPipeline', () => {
  describe('繋がったパケットから震度を出す', () => {
    it('刻みの位置まで届いたところで最初の答えが出る', () => {
      const p = new IntensityPipeline(OPTS)
      const { readings } = feed(p, PACKETS_FOR_FIRST)
      expect(readings).toHaveLength(1)
      expect(readings[0].intensity).not.toBeNull()
      expect(readings[0].boardKey).toBe('mac:020000000003')
      expect(readings[0].sensorId).toBe('i2c0-68')
      expect(readings[0].streamKey).toBe(KEY)
    })

    it('答えの時刻は区間の当てはめから引く', () => {
      const p = new IntensityPipeline(OPTS)
      const { readings } = feed(p, PACKETS_FOR_FIRST)
      // 刻み 1 秒なので、最初の答えが代表するのは区間の先頭から 1 秒後。
      expect(readings[0].atMs).toBeCloseTo(BASE_MS + 1000, 6)
    })

    it('当てはめが効いていれば印は付かない（対照）', () => {
      const p = new IntensityPipeline(OPTS)
      const { readings } = feed(p, PACKETS_FOR_FIRST)
      expect(readings[0].timebaseNominalReason).toBeNull()
      expect(readings[0].timebaseResidualRmsMs).not.toBeNull()
    })

    it('時刻を公称値へ倒したら、その印を震度に載せる', () => {
      // **倒したことを隠さない。** 名乗る時刻が通し番号の進みと合っていない基板では、
      // 組み立ての側が当てはめを捨てて公称の間隔へ倒す。`atMs` は正常時と同じ形の
      // 値になるので、印が無ければ**時刻の根拠が崩れたまま震度だけが普通に出続ける。**
      const p = new IntensityPipeline(OPTS)
      const readings: IntensityReading[] = []
      for (let i = 0; i < PACKETS_FOR_FIRST; i++) {
        const firstSeq = i * PER_PACKET
        // **毎秒 100 回と名乗りながら、時刻は 13% 速く進む。**
        //
        // **2 倍の速さにしない。** 1 パケット（公称 300 ms）で 300 ms ぶん余計に
        // ずれるので、時刻の飛びとして区間が毎回切れ、当てはめが壊れるところまで
        // 育たない（2026-10-01 に飛びを切るようにしたので書き直した）。13% なら
        // 1 歩ぶんのずれは 40 ms で、物差しの 100 ms に届かない。
        const skewed = pkt({ firstSeq, firstSampleMs: BASE_MS + (firstSeq * 1000 * 1.133) / HZ })
        readings.push(...p.handlePacket(skewed).readings)
      }
      expect(readings).toHaveLength(1)
      expect(readings[0].timebaseNominalReason).toBe('slope-out-of-range')
    })

    it('埋まるまでは何も出さない（対照）', () => {
      const p = new IntensityPipeline(OPTS)
      const { readings } = feed(p, PACKETS_FOR_FIRST - 1)
      expect(readings).toEqual([])
    })

    it('刻みごとに 1 つずつ増える', () => {
      const p = new IntensityPipeline(OPTS)
      const { readings } = feed(p, PACKETS_FOR_FIRST + (HZ * 2) / PER_PACKET)
      expect(readings).toHaveLength(3)
      const gaps = readings.slice(1).map((r, i) => r.atMs - readings[i].atMs)
      expect(gaps).toEqual([1000, 1000])
    })
  })

  describe('重力の直流を引く', () => {
    // 静止時の第 3 軸に 16880 カウント＝約 1009 gal が乗る。直流を最初のサンプルで
    // 差し引かずに近似フィルタへ通すと、立ち上がりの段差が強い揺れとして出て、
    // 60 秒の窓に入ったまま 1 分間居座る（`realtimeIntensity.ts` の説明）。
    it('静止している基板は震度が跳ねない', () => {
      const p = new IntensityPipeline(OPTS)
      const { readings } = feed(p, PACKETS_FOR_FIRST, QUIET)
      const v = readings[0].intensity
      expect(v).not.toBeNull()
      // 直流を差し引くのをやめると段差がそのまま震度になるので、この上限がそれを止める。
      expect(v as number).toBeLessThan(2)
    })

    it('揺れていればその分だけ上がる（正）', () => {
      const p = new IntensityPipeline(OPTS)
      const { readings } = feed(p, PACKETS_FOR_FIRST, SHAKE)
      expect(readings[0].intensity as number).toBeGreaterThan(2.5)
      expect(readings[0].intensity as number).toBeLessThan(3.5)
    })
  })

  describe('区間が切れたら流し込みを作り直す', () => {
    it('通し番号が飛んだら新しい区間になり、位置が噛み合う', () => {
      const p = new IntensityPipeline(OPTS)
      feed(p, 4)
      // 1 パケットぶん飛ばす。
      const out = p.handlePacket(pkt({ firstSeq: 5 * PER_PACKET }))
      expect(out.dropped).toBeNull()
      expect(out.startedBecause).toBe('seq-gap')
      expect(out.closed).toHaveLength(1)
      // 作り直した流し込みが 0 から数え直すので、以降も投げずに答えが出る。
      const after = feed(p, PACKETS_FOR_FIRST, SHAKE, 6)
      expect(after.outcomes.every((o) => o.dropped === null)).toBe(true)
      expect(after.readings).toHaveLength(1)
    })

    it('閉じた区間の答えは閉じる前に出し切れている（締めくくりで出るものは無い）', () => {
      // **リアルタイム震度は先読みしない**ので、刻みの位置へ届いた時点で必ず出している。
      // 切った回に旧区間の答えが混ざるのは、かつての方式（2 秒先読み）の名残りだった。
      const p = new IntensityPipeline(OPTS)
      const before = feed(p, PACKETS_FOR_FIRST + 3)
      expect(before.readings.length).toBeGreaterThan(0)
      expect(before.readings.every((r) => r.segmentId === 1)).toBe(true)
      const out = p.handlePacket(pkt({ firstSeq: 100 * PER_PACKET }))
      expect(out.startedBecause).toBe('seq-gap')
      expect(out.readings.every((r) => r.segmentId !== 1)).toBe(true)
    })
  })

  describe('落とすもの', () => {
    it('換算が範囲の外ならパケットごと捨て、組み立ても受理しない', () => {
      const p = new IntensityPipeline(OPTS)
      p.handlePacket(pkt({ firstSeq: 0 }))
      const bad = pkt({ firstSeq: PER_PACKET })
      bad.samples[7][1] = OVER_SCALE_COUNTS
      const dropped = p.handlePacket(bad)
      expect(dropped.dropped).toBe('scale-out-of-range')
      expect(dropped.readings).toEqual([])
      // **どこで外れたかを残す。** 桁を取り違えたヘッダの基板は以後すべてのパケットで
      // ここへ落ちるので、内訳が無いと単発の異常値と設定の誤りを見分けられない。
      expect(dropped.detail).toContain('位置 7')
      expect(dropped.detail).toContain('軸 1（HN2）')
      expect(dropped.detail).toContain(String(OVER_SCALE_COUNTS))
      // **組み立てが受理していないことを、次のパケットの切れ目で確かめる。**
      // 受理していれば通し番号は繋がって見え、ここは null になる。
      const next = p.handlePacket(pkt({ firstSeq: 2 * PER_PACKET }))
      expect(next.startedBecause).toBe('seq-gap')
    })

    it('既に渡した範囲は重複として落とす', () => {
      const p = new IntensityPipeline(OPTS)
      p.handlePacket(pkt({ firstSeq: 0 }))
      p.handlePacket(pkt({ firstSeq: PER_PACKET }))
      const again = p.handlePacket(pkt({ firstSeq: 0 }))
      expect(again.dropped).toBe('duplicate')
      expect(again.readings).toEqual([])
    })

    it('3 成分でなければ震度は出さないが、パケットは受け取る', () => {
      const p = new IntensityPipeline(OPTS)
      const six = { channels: ['HN1', 'HN2', 'HN3', 'HG1', 'HG2', 'HG3'] }
      const first = p.handlePacket(pkt({ ...six, firstSeq: 0 }))
      expect(first.dropped).toBeNull()
      // **理由と区間を組で返す。** 同じパケットで旧区間の締めくくりが届くことがあり、
      // どちらが新しいかは区間の名指しでしか決まらない。
      expect(first.intensitySkipped).toMatchObject({ reason: 'axis-count', segmentId: 1 })
      // **捨てずに組み立てへは通す。** 時間軸のばらつきや落ちた件数は軸の数によらず数える。
      expect(p.openSegments()).toHaveLength(1)

      const second = p.handlePacket(pkt({ ...six, firstSeq: PER_PACKET }))
      expect(second.intensitySkipped).toBeNull()
      expect(second.readings).toEqual([])

      // 3 成分へ戻れば設定違いで区間が切れ、そこから震度が出る。
      const back = feed(p, PACKETS_FOR_FIRST, SHAKE, 2)
      expect(back.outcomes[0].startedBecause).toBe('config-changed')
      expect(back.outcomes[0].intensitySkipped).toBeNull()
      expect(back.readings).toHaveLength(1)
      expect(back.readings[0].intensity).not.toBeNull()
    })
  })

  describe('波形', () => {
    it('計測震度が食べた値を、換算済みでそのまま載せる', () => {
      const p = new IntensityPipeline(OPTS)

      const out = p.handlePacket(pkt())

      const w = out.wave
      if (w === null) throw new Error('波形が載っていない')
      expect(w.boardKey).toBe('mac:020000000003')
      expect(w.sensorId).toBe('i2c0-68')
      expect(w.segmentId).toBe(1)
      expect(w.channels).toEqual(['HN1', 'HN2', 'HN3'])
      expect(w.firstSampleIndex).toBe(0)
      expect(w.firstSampleMs).toBe(BASE_MS)
      expect(w.msPerSample).toBeCloseTo(1000 / HZ, 9)
      expect(w.gal.map((axis) => axis.length)).toEqual([PER_PACKET, PER_PACKET, PER_PACKET])
      // **生のカウント値は配らない。** 受け手側で換算し直す形にすると経路が 2 本になり、
      // 片方だけずれても出てくる数字はそれらしい形をしている。
      // 先頭の標本は x=0・y=+300・z=16880 カウントなので、gal なら 0・約 18・約 1010。
      expect(w.gal[0][0]).toBe(0)
      expect(w.gal[1][0]).toBeGreaterThan(17)
      expect(w.gal[1][0]).toBeLessThan(19)
      expect(w.gal[2][0]).toBeGreaterThan(1000)
      expect(w.gal[2][0]).toBeLessThan(1020)
    })

    it('3 成分でなければ波形も載せない', () => {
      const p = new IntensityPipeline(OPTS)

      const out = p.handlePacket(pkt({ channels: ['HN1', 'HN2', 'HN3', 'HG1', 'HG2', 'HG3'] }))

      // 合成できない以上、計測震度が食べた値は存在しない。
      expect(out.wave).toBeNull()
    })

    it('落としたパケットの波形は載せない', () => {
      const p = new IntensityPipeline(OPTS)

      const out = p.handlePacket(pkt({}, OVER_SCALE_COUNTS))

      expect(out.dropped).toBe('scale-out-of-range')
      // 落としたパケットの波形を配ると、計測震度が見ていないサンプルが画面に出る。
      expect(out.wave).toBeNull()
    })

    it('区間を畳み直した回でも波形は載せる', () => {
      const p = new IntensityPipeline(OPTS)
      feed(p, PACKETS_FOR_FIRST + 1)
      breakPush(p, KEY)

      const out = p.handlePacket(pkt({ firstSeq: (PACKETS_FOR_FIRST + 1) * PER_PACKET }))

      expect(out.dropped).toBe('stream-desync')
      // **サンプルそのものは本物。** どの区間のどの位置かは波形自身が名乗るので、
      // 受け手は切れ目を見分けられる。いちばん様子を見たい状態で波形だけ黙るほうが困る。
      expect(out.wave).not.toBeNull()
    })
  })

  describe('観測点校正の適用（REQUIREMENTS.md §16）', () => {
    /** `pkt()` の boardKey・sensorId に紐づく校正だけを持つ `StationDirectory` を作る。 */
    function stationsWith(sensor: Partial<SensorCalibration>): StationDirectory {
      const config: StationConfig = {
        stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
        boards: [
          {
            boardKey: 'mac:020000000003',
            stationId: 'study',
            sensors: [
              {
                sensorId: 'i2c0-68',
                enabled: true,
                rotation: [
                  [1, 0, 0],
                  [0, 1, 0],
                  [0, 0, 1],
                ],
                offset: [0, 0, 0],
                sensitivity: [1, 1, 1],
                noiseDensity: null,
                ...sensor,
              },
            ],
          },
        ],
      }
      return new StationDirectory(config)
    }

    it('対照: 割り当てが無ければ（既定の StationDirectory）波形は換算値のまま変わらない', () => {
      const withDefault = new IntensityPipeline(OPTS)
      const withEmpty = new IntensityPipeline({ ...OPTS, stations: StationDirectory.empty() })

      const outA = withDefault.handlePacket(pkt())
      const outB = withEmpty.handlePacket(pkt())

      // **両方 null では通した意味が無い。** `?.` だけの比較だと `undefined === undefined`
      // で素通りしてしまい、組み立て側の回帰で波形が両方とも消えても検知できない。
      if (outA.wave === null || outB.wave === null) throw new Error('波形が載っていない')
      expect(outA.wave.gal[0][0]).toBe(outB.wave.gal[0][0])
      expect(outA.wave.gal[1][0]).toBe(outB.wave.gal[1][0])
      expect(outA.wave.gal[2][0]).toBe(outB.wave.gal[2][0])
    })

    it('正: sensitivity が波形へ反映される（震度が食べる値と同じもの）', () => {
      const baseline = new IntensityPipeline(OPTS)
      const scaled = new IntensityPipeline({
        ...OPTS,
        stations: stationsWith({ sensitivity: [2, 2, 2] }),
      })

      const outBaseline = baseline.handlePacket(pkt())
      const outScaled = scaled.handlePacket(pkt())

      const base = outBaseline.wave?.gal[2][0]
      const applied = outScaled.wave?.gal[2][0]
      if (base === undefined || applied === undefined) throw new Error('波形が載っていない')
      expect(applied).toBeCloseTo(base * 2, 9)
    })

    it('正: offset を引いてから sensitivity・rotation を適用する（適用順序の固定）', () => {
      // 軸0を (v - 10) * 2 したうえで、回転で軸2へ足し込む（軸2' = 軸0' + 軸2）。
      const combo = new IntensityPipeline({
        ...OPTS,
        stations: stationsWith({
          offset: [10, 0, 0],
          sensitivity: [2, 1, 1],
          rotation: [
            [1, 0, 0],
            [0, 1, 0],
            [1, 0, 1],
          ],
        }),
      })
      const baseline = new IntensityPipeline(OPTS)

      const outCombo = combo.handlePacket(pkt())
      const outBaseline = baseline.handlePacket(pkt())

      const rawAxis0 = outBaseline.wave?.gal[0][0]
      const rawAxis2 = outBaseline.wave?.gal[2][0]
      if (rawAxis0 === undefined || rawAxis2 === undefined) throw new Error('波形が載っていない')
      const expectedAxis0 = (rawAxis0 - 10) * 2
      expect(outCombo.wave?.gal[0][0]).toBeCloseTo(expectedAxis0, 9)
      expect(outCombo.wave?.gal[2][0]).toBeCloseTo(expectedAxis0 + rawAxis2, 9)
    })

    it('安全弁: enabled: false のセンサーは震度も波形も出さず、組み立てにも渡らない', () => {
      const p = new IntensityPipeline({ ...OPTS, stations: stationsWith({ enabled: false }) })

      const out = p.handlePacket(pkt())

      expect(out.dropped).toBe('sensor-disabled')
      expect(out.wave).toBeNull()
      expect(out.readings).toEqual([])
      // 組み立て（Segmenter）にも渡していないので、区間が始まった扱いにもならない。
      expect(out.startedBecause).toBeNull()
    })
  })

  describe('updateStations（#313 段 B: /api/* からの実行時差し替え）', () => {
    /** `pkt()` の boardKey・sensorId に紐づく校正だけを持つ `StationDirectory` を作る。 */
    function stationsWith(sensor: Partial<SensorCalibration>): StationDirectory {
      const config: StationConfig = {
        stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
        boards: [
          {
            boardKey: 'mac:020000000003',
            stationId: 'study',
            sensors: [
              {
                sensorId: 'i2c0-68',
                enabled: true,
                rotation: [
                  [1, 0, 0],
                  [0, 1, 0],
                  [0, 0, 1],
                ],
                offset: [0, 0, 0],
                sensitivity: [1, 1, 1],
                noiseDensity: null,
                ...sensor,
              },
            ],
          },
        ],
      }
      return new StationDirectory(config)
    }

    it('対照: updateStations を呼ぶ前は既定の校正値のまま（換算値は変わらない）', () => {
      const p = new IntensityPipeline(OPTS)
      const out = p.handlePacket(pkt())
      const baseline = new IntensityPipeline(OPTS).handlePacket(pkt())
      expect(out.wave?.gal[2][0]).toBeCloseTo(baseline.wave?.gal[2][0] ?? NaN, 9)
    })

    it('正: updateStations を呼んだ後、以後のパケットへ新しい校正値が反映される', () => {
      // **コンストラクタで直接渡す（既存の「正」テストと同じ校正）とではなく、
      // 空の状態から `updateStations` で追いつかせて同じ結果になることを確かめる**——
      // これで初めて「実行時の差し替え」自体が効いていることの証明になる。
      const baseline = new IntensityPipeline(OPTS)
      const viaUpdate = new IntensityPipeline({ ...OPTS, stations: StationDirectory.empty() })
      viaUpdate.updateStations(stationsWith({ sensitivity: [2, 2, 2] }))

      const outBaseline = baseline.handlePacket(pkt())
      const outUpdated = viaUpdate.handlePacket(pkt())

      const base = outBaseline.wave?.gal[2][0]
      const applied = outUpdated.wave?.gal[2][0]
      if (base === undefined || applied === undefined) throw new Error('波形が載っていない')
      expect(applied).toBeCloseTo(base * 2, 9)
    })

    it('安全弁: 区間組み立ての途中で差し替えても、進行中の区間は打ち切られない', () => {
      const p = new IntensityPipeline(OPTS)
      feed(p, PACKETS_FOR_FIRST)

      // 区間が閉じる前に校正を差し替える。
      p.updateStations(stationsWith({ sensitivity: [2, 2, 2] }))
      const out = p.handlePacket(pkt({ firstSeq: PACKETS_FOR_FIRST * PER_PACKET }))

      // **`stream-desync` にならない。** 差し替えは校正値だけを変え、組み立て
      // （`Segmenter`）が持つ通し番号の連続性には触れないので、区間は続く。
      expect(out.dropped).not.toBe('stream-desync')
    })
  })

  describe('組み立てと震度を 1 つの操作で閉じる', () => {
    it('closeStream は両方を閉じる（出し残しは無い）', () => {
      const p = new IntensityPipeline(OPTS)
      feed(p, PACKETS_FOR_FIRST + 1)
      const { closed, readings, failures } = p.closeStream(KEY)
      expect(closed?.meta.streamKey).toBe(KEY)
      expect(readings).toEqual([])
      expect(failures).toEqual([])
      expect(p.openSegments()).toEqual([])
      // **組み立ても閉じているので、続きの通し番号でも新しい区間として始まる。**
      // 片方だけ閉じていれば、ここは null（続き）になり位置が噛み合わない。
      const next = p.handlePacket(pkt({ firstSeq: (PACKETS_FOR_FIRST + 1) * PER_PACKET }))
      expect(next.startedBecause).toBe('stream-start')
      expect(next.dropped).toBeNull()
    })

    it('知らない鍵を閉じても何も起きない', () => {
      const p = new IntensityPipeline(OPTS)
      expect(p.closeStream('mac:nope')).toEqual({ closed: null, readings: [], failures: [] })
    })

    it('流し込みが投げたら、組み立ても一緒に閉じる', () => {
      const p = new IntensityPipeline(OPTS)
      feed(p, PACKETS_FOR_FIRST + 1)
      breakPush(p, KEY)
      const out = p.handlePacket(pkt({ firstSeq: (PACKETS_FOR_FIRST + 1) * PER_PACKET }))
      expect(out.dropped).toBe('stream-desync')
      expect(out.detail).toContain('試験用')
      expect(out.closed).toHaveLength(1)
      expect(p.openSegments()).toEqual([])
      // 閉じ方が揃っているので、次のパケットから立て直せる。
      const after = feed(p, PACKETS_FOR_FIRST, SHAKE, PACKETS_FOR_FIRST + 2)
      expect(after.outcomes[0].startedBecause).toBe('stream-start')
      expect(after.readings).toHaveLength(1)
    })
  })

  describe('締めくくり', () => {
    it('closeAll はすべて閉じる（出し残しは無い）', () => {
      const p = new IntensityPipeline(OPTS)
      feed(p, PACKETS_FOR_FIRST + 1)
      const rest = p.closeAll()
      expect(rest.readings).toEqual([])
      expect(rest.failures).toEqual([])
      expect(p.openSegments()).toEqual([])
      // 二度目は何も残らない。
      expect(p.closeAll()).toEqual({ readings: [], failures: [] })
    })

    it('締めくくりに失敗した 1 本が、他の基板の後片付けを道連れにしない', () => {
      // **終了は 1 度きり。** ここで例外が抜けると、残りの基板が閉じられないまま
      // 後片付けにも終了にも到達しない。
      const p = new IntensityPipeline(OPTS)
      feed(p, PACKETS_FOR_FIRST + 1)
      const other = { boardKey: 'mac:aaaaaaaaaaaa' } as const
      for (let i = 0; i < PACKETS_FOR_FIRST + 1; i++) {
        p.handlePacket(pkt({ ...other, firstSeq: i * PER_PACKET }))
      }
      breakEnd(p, KEY)

      const rest = p.closeAll()
      expect(rest.failures).toHaveLength(1)
      expect(rest.failures[0].detail).toContain('試験用')
      expect(rest.failures[0].streamKey).toBe(KEY)
      // **どの基板のものかまで載せる。** 数える側は基板ごとに積むので、ここが
      // 流れの鍵（起動 ID まで入る）しか持っていないと、再起動のたびに別の行へ散る。
      const meta = pkt({})
      expect(rest.failures[0].boardKey).toBe(meta.boardKey)
      expect(rest.failures[0].sensorId).toBe(meta.sensorId)
      // 壊していないほうも閉じている（出し残しは無いので答えは空）。
      expect(rest.readings).toEqual([])
      expect(p.openSegments()).toEqual([])
    })

    it('流し込みの入れ物が消えていたら、黙って通さず閉じ直す', () => {
      // **起きないはずの食い違い。** 組み立ては「区間が続いている」と言っているのに
      // 震度側の入れ物が無い、という状態を外から作る手立てが無いので直接消す。
      // 黙って通す作りだと、その流れの震度は以後どこにも現れないのに
      // `dropped` も `intensitySkipped` も null で返るため、上の層からは
      // 「何も起きなかったパケット」と見分けが付かない。
      const p = new IntensityPipeline(OPTS)
      feed(p, 3)
      innards(p).entries.delete(KEY)

      const outcome = p.handlePacket(pkt({ firstSeq: 3 * PER_PACKET }))
      expect(outcome.dropped).toBe('stream-desync')
      expect(outcome.detail).toContain('入れ物が見つからない')
      // 組み立ての側も閉じてある。次のパケットは 0 から数え直す新しい区間になる。
      expect(p.openSegments()).toEqual([])
      expect(trackedCount(p)).toBe(0)

      const next = p.handlePacket(pkt({ firstSeq: 4 * PER_PACKET }))
      expect(next.startedBecause).toBe('stream-start')
      expect(next.dropped).toBeNull()
    })

    it('閉じた流れの覚えを残さない', () => {
      // **開いている区間の数と覚えの数は必ず一致する。** 閉じるときに覚えだけ残すと、
      // 二度と戻らない送り手（毎回違う名前を名乗る壊れた送り手を含む）のぶんだけ
      // 溜まり続ける。1 つが窓 1 本ぶんの配列を抱えるので、見えないまま効いてくる。
      const p = new IntensityPipeline({ ...OPTS, maxStreams: 1 })
      feed(p, 2)
      expect(trackedCount(p)).toBe(p.openSegments().length)

      // 上限に達して古いほうが閉じられる経路。
      p.handlePacket(pkt({ boardKey: 'mac:aaaaaaaaaaaa', firstSeq: 0 }))
      expect(trackedCount(p)).toBe(p.openSegments().length)

      // 名指しで閉じる経路。
      p.closeStream('["mac:aaaaaaaaaaaa","i2c0-68","7f3a91c4"]')
      expect(trackedCount(p)).toBe(0)
      expect(p.openSegments()).toEqual([])
    })

    it('流れの上限に達したら古いほうを閉じる（出し残しは無い）', () => {
      const p = new IntensityPipeline({ ...OPTS, maxStreams: 1 })
      feed(p, PACKETS_FOR_FIRST + 1)
      const other = p.handlePacket(pkt({ boardKey: 'mac:aaaaaaaaaaaa', firstSeq: 0 }))
      expect(other.closed).toHaveLength(1)
      expect(other.closed[0].meta.streamKey).toBe(KEY)
      expect(other.readings).toEqual([])
    })
  })
})

describe('normalizeIntensity', () => {
  it('数として出せる値はそのまま通す', () => {
    expect(normalizeIntensity(2.5)).toEqual({ value: 2.5, unusable: false })
    expect(normalizeIntensity(0)).toEqual({ value: 0, unusable: false })
    expect(normalizeIntensity(-1.5)).toEqual({ value: -1.5, unusable: false })
  })

  it('窓が足りない null は「出せなかった」と数えない', () => {
    // `null` は約束どおりの値。ここを数えると、正常な起動直後に件数が伸びる
    expect(normalizeIntensity(null)).toEqual({ value: null, unusable: false })
  })

  it('非有限は null へ倒して数える', () => {
    // `I = 2*log10(a) + 0.94` は a=0 で -Infinity を返す
    // （センサーが 0 を返し続ける壊れ方）。JSON では null に化けるので、
    // 倒さないと「窓が足りない」と見分けが付かない
    expect(normalizeIntensity(Number.NEGATIVE_INFINITY)).toEqual({ value: null, unusable: true })
    expect(normalizeIntensity(Number.POSITIVE_INFINITY)).toEqual({ value: null, unusable: true })
    expect(normalizeIntensity(Number.NaN)).toEqual({ value: null, unusable: true })
  })
})
