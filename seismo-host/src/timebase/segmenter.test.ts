import { describe, expect, it } from 'vitest'

import type { SensorPacket } from '../protocol/types'
import { Segmenter, sampleTimeMs } from './segmenter'

/** 実際の記録と同じ起点。時刻が大きい状態で当てはめが効くことも併せて見る。 */
const BASE_MS = 1790181865671
const PER_PACKET = 30

function rows(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => [i, i + 1, i + 2])
}

function pkt(over: Partial<SensorPacket> = {}): SensorPacket {
  const firstSeq = over.firstSeq ?? 0
  const hz = over.sampleRateHz ?? 100
  return {
    version: 2,
    boardKey: 'mac:3c8a1f5d54d8',
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
    samples: rows(PER_PACKET),
    ...over,
  }
}

/** 連続した通し番号のパケットを順に流し、最後の結果を返す。 */
function feed(seg: Segmenter, count: number) {
  let last = seg.accept(pkt({ firstSeq: 0 }))
  for (let i = 1; i < count; i++) last = seg.accept(pkt({ firstSeq: i * PER_PACKET }))
  return last
}

describe('Segmenter', () => {
  describe('続きは 1 つの区間にまとめる', () => {
    it('通し番号が繋がっていれば同じ区間に収まる', () => {
      const seg = new Segmenter()
      const a = seg.accept(pkt({ firstSeq: 0 }))
      const b = seg.accept(pkt({ firstSeq: 30 }))
      const c = seg.accept(pkt({ firstSeq: 60 }))
      expect(a.ok && b.ok && c.ok).toBe(true)
      if (!a.ok || !b.ok || !c.ok) return
      expect(b.segment.meta.segmentId).toBe(a.segment.meta.segmentId)
      expect(c.segment.meta.segmentId).toBe(a.segment.meta.segmentId)
      expect([a.firstSampleIndex, b.firstSampleIndex, c.firstSampleIndex]).toEqual([0, 30, 60])
      expect(c.segment.sampleCount).toBe(90)
      expect([b.startedBecause, c.startedBecause]).toEqual([null, null])
      expect(c.closed).toEqual([])
    })

    it('最初のパケットは区間の始まりとして報せる', () => {
      const seg = new Segmenter()
      const r = seg.accept(pkt({ firstSeq: 1000 }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.startedBecause).toBe('stream-start')
      expect(r.segment.meta.firstSeq).toBe(1000)
      expect(r.firstSampleIndex).toBe(0)
    })
  })

  describe('時間軸', () => {
    it('アンカーが揃えば当てはめた値を使う', () => {
      const seg = new Segmenter()
      const last = feed(seg, 4)
      expect(last.ok).toBe(true)
      if (!last.ok) return
      const tb = last.segment.timebase
      expect(tb.nominalReason).toBeNull()
      expect(tb.anchorCount).toBe(4)
      expect(tb.msPerSample).toBeCloseTo(10, 9)
      expect(tb.firstSampleMs).toBeCloseTo(BASE_MS, 6)
      expect(tb.residualRmsMs).toBeCloseTo(0, 6)
      // 位置から時刻を引ける。
      expect(sampleTimeMs(tb, 100)).toBeCloseTo(BASE_MS + 1000, 6)
    })

    it('アンカーが 1 つなら公称値へ倒し、理由を残す', () => {
      const seg = new Segmenter()
      const r = seg.accept(pkt({ firstSeq: 0 }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.segment.timebase.nominalReason).toBe('too-few-anchors')
      expect(r.segment.timebase.msPerSample).toBe(10)
      expect(r.segment.timebase.firstSampleMs).toBe(BASE_MS)
      expect(r.segment.timebase.residualRmsMs).toBeNull()
    })

    it('当てはめた間隔が公称から大きく離れたら採らない', () => {
      // 30 サンプルで 1000 ms 進む形（100 Hz なら 300 ms のはず）。
      // 当てはめは通るが値が壊れているので、公称値へ倒して理由を出す。
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 0, firstSampleMs: BASE_MS }))
      const r = seg.accept(pkt({ firstSeq: 30, firstSampleMs: BASE_MS + 1000 }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.segment.timebase.nominalReason).toBe('slope-out-of-range')
      expect(r.segment.timebase.msPerSample).toBe(10)
    })
  })

  describe('繋いではいけない切れ目', () => {
    it('通し番号が飛んだら切る', () => {
      const seg = new Segmenter()
      const a = seg.accept(pkt({ firstSeq: 0 }))
      seg.accept(pkt({ firstSeq: 30 }))
      const r = seg.accept(pkt({ firstSeq: 90 }))
      expect(r.ok && a.ok).toBe(true)
      if (!r.ok || !a.ok) return
      expect(r.startedBecause).toBe('seq-gap')
      expect(r.segment.meta.segmentId).not.toBe(a.segment.meta.segmentId)
      expect(r.segment.meta.firstSeq).toBe(90)
      expect(r.firstSampleIndex).toBe(0)
      // 閉じた区間は落ちる前までの長さを持つ。
      expect(r.closed).toHaveLength(1)
      expect(r.closed[0].sampleCount).toBe(60)
    })

    it('FIFO があふれたら切る（番号が繋がっていても）', () => {
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 0, overflowCount: 12 }))
      const r = seg.accept(pkt({ firstSeq: 30, overflowCount: 13 }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.startedBecause).toBe('overflow')
      expect(r.closed).toHaveLength(1)
    })

    it('軸・周波数・換算が変わったら切る', () => {
      for (const changed of [
        { channels: ['HN1', 'HN3'], samples: rows(PER_PACKET).map((r) => [r[0], r[1]]) },
        { sampleRateHz: 50 },
        { ugPerLsb: 15.3 },
        { fullScaleG: 4 },
        { sensorType: 'IIS2ICLX' },
      ] satisfies Partial<SensorPacket>[]) {
        const seg = new Segmenter()
        seg.accept(pkt({ firstSeq: 0 }))
        const r = seg.accept(pkt({ firstSeq: 30, ...changed }))
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.startedBecause).toBe('config-changed')
      }
    })

    it('時計が進んだまま再起動したら切る', () => {
      // 版 1 の基板は起動ごとの識別子を持たないので、鍵は変わらないまま 0 へ戻る。
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 1000, firstSampleMs: BASE_MS + 10_000 }))
      seg.accept(pkt({ firstSeq: 1030, firstSampleMs: BASE_MS + 10_300 }))
      const r = seg.accept(pkt({ firstSeq: 0, firstSampleMs: BASE_MS + 30_000 }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.startedBecause).toBe('seq-reset')
      expect(r.segment.meta.firstSeq).toBe(0)
    })

    it('時計が合う前に再起動しても切る（時刻が大きく過去へ飛ぶ）', () => {
      // **向きは 2 つある。** 時刻合わせが済む前に送り始めた基板は、未来ではなく
      // 大きく過去（起点からの経過だけの値）を名乗る。戻り幅や「時刻が進んだか」で
      // 測る形だとこちらを取りこぼす。
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 1000, firstSampleMs: BASE_MS + 10_000 }))
      seg.accept(pkt({ firstSeq: 1030, firstSampleMs: BASE_MS + 10_300 }))
      const r = seg.accept(pkt({ firstSeq: 0, firstSampleMs: 12_345 }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.startedBecause).toBe('seq-reset')
    })

    it('起動から間もない再起動でも切る（戻り幅では見分けられない）', () => {
      // **戻り幅だけで判定すると、ここが素通りする。** 起動 0.6 秒で落ちた基板は
      // 通し番号がまだ 60 しか進んでおらず、並び替えの許容（300）に収まる。
      // その結果、再起動後のサンプルが再起動前の区間へ繋がり、10 秒の空白が詰められた
      // 段差になる —— 区間を切る仕組みが防ごうとしている当のもの。
      const seg = new Segmenter()
      const a = seg.accept(pkt({ firstSeq: 0, firstSampleMs: BASE_MS }))
      seg.accept(pkt({ firstSeq: 30, firstSampleMs: BASE_MS + 300 }))
      // 10 秒の空白のあと、通し番号 0 から再開する。
      const r = seg.accept(pkt({ firstSeq: 0, firstSampleMs: BASE_MS + 10_000 }))
      expect(r.ok && a.ok).toBe(true)
      if (!r.ok || !a.ok) return
      expect(r.startedBecause).toBe('seq-reset')
      expect(r.segment.meta.segmentId).not.toBe(a.segment.meta.segmentId)
      expect(r.closed).toHaveLength(1)
    })
  })

  describe('遅れて届いたもの', () => {
    it('既に渡した範囲は落とす', () => {
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 0 }))
      seg.accept(pkt({ firstSeq: 30 }))
      const r = seg.accept(pkt({ firstSeq: 30 }))
      expect(r).toMatchObject({ ok: false, reason: 'duplicate' })
    })

    it('遅れて届いたパケットは時刻の辻褄が合うので、再起動と取り違えない', () => {
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 0, firstSampleMs: BASE_MS }))
      seg.accept(pkt({ firstSeq: 30, firstSampleMs: BASE_MS + 300 }))
      const r = seg.accept(pkt({ firstSeq: 0, firstSampleMs: BASE_MS }))
      expect(r).toMatchObject({ ok: false, reason: 'duplicate' })
    })

    it('大きく遅れて届いても、時刻の辻褄が合えば区間を切らない', () => {
      // **戻り幅で測る形だとここが切れる。** しかも切れた区間は古い番号から始まるので、
      // 直後の正規のパケットでもう 1 度切れ、1 つの遅延で 2 回の段差ができる。
      const seg = new Segmenter()
      feed(seg, 21) // 通し番号 0〜629、時刻は BASE_MS + 10ms/サンプル
      const before = seg.openSegments()[0].meta.segmentId
      const r = seg.accept(pkt({ firstSeq: 0, firstSampleMs: BASE_MS }))
      expect(r).toMatchObject({ ok: false, reason: 'duplicate' })
      expect(seg.openSegments()[0].meta.segmentId).toBe(before)
    })

    it('区間の開始より前から遅れて届いても、偽の再起動にしない', () => {
      // **区間の当てはめを足場にすると、ここが切れる。** あふれで区間が切り替わった
      // 直後はアンカーが 2 つしか無く、抜き出しの揺れがそのまま傾きの誤差になる。
      // その傾きで区間の開始より前へ外挿すると、誤差が距離に比例して拡大し、
      // 正規の遅延パケットが「時刻の辻褄が合わない」と見なされてしまう。
      // 足場を最後に受理したパケットへ置き、間隔に公称値を使えば外挿が消える。
      const T0 = BASE_MS + 10_000
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 970, firstSampleMs: T0 - 300, overflowCount: 12 }))
      // あふれで区間が切り替わる。ここから新しい区間（先頭は 1000）。
      const started = seg.accept(pkt({ firstSeq: 1000, firstSampleMs: T0, overflowCount: 13 }))
      // 2 つ目のアンカーが 15 ms 揺れる（公称 300 ms に対し 5%）。
      seg.accept(pkt({ firstSeq: 1030, firstSampleMs: T0 + 315, overflowCount: 13 }))
      // あふれより前の正規のパケットが 3 秒遅れて届く。時刻は番号どおり。
      const late = seg.accept(pkt({ firstSeq: 700, firstSampleMs: T0 - 3000, overflowCount: 12 }))
      expect(late).toMatchObject({ ok: false, reason: 'duplicate' })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      // 区間は割れていない。
      expect(seg.openSegments()[0].meta.segmentId).toBe(started.segment.meta.segmentId)
    })

    it('辻褄のずれが許容ちょうどなら切らない', () => {
      const seg = new Segmenter()
      feed(seg, 21)
      const before = seg.openSegments()[0].meta.segmentId
      // 通し番号 600 にふさわしい時刻は BASE_MS + 6000。そこから 100 ms のずれ。
      const r = seg.accept(pkt({ firstSeq: 600, firstSampleMs: BASE_MS + 6100 }))
      expect(r).toMatchObject({ ok: false, reason: 'duplicate' })
      expect(seg.openSegments()[0].meta.segmentId).toBe(before)
    })

    it('辻褄のずれが許容を 1 ms でも超えたら切る', () => {
      const seg = new Segmenter()
      feed(seg, 21)
      const r = seg.accept(pkt({ firstSeq: 600, firstSampleMs: BASE_MS + 6101 }))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.startedBecause).toBe('seq-reset')
    })

    it('落としても区間は壊れない（次の正規のパケットが続きとして通る）', () => {
      const seg = new Segmenter()
      const a = seg.accept(pkt({ firstSeq: 0 }))
      seg.accept(pkt({ firstSeq: 30 }))
      seg.accept(pkt({ firstSeq: 30 }))
      const r = seg.accept(pkt({ firstSeq: 60 }))
      expect(r.ok && a.ok).toBe(true)
      if (!r.ok || !a.ok) return
      expect(r.startedBecause).toBeNull()
      expect(r.segment.meta.segmentId).toBe(a.segment.meta.segmentId)
      expect(r.firstSampleIndex).toBe(60)
    })

    it('古いパケットのあふれの数で偽の切れ目を作らない', () => {
      // あふれた後に、あふれる前のパケットが遅れて届く形。**番号の新旧を先に見ないと**
      // 古い `o` といまの `o` が食い違って切れ目が立ち、しかも古い番号から
      // 区間が始まるので次の正規のパケットでもう 1 度切れる。
      const seg = new Segmenter()
      seg.accept(pkt({ firstSeq: 0, overflowCount: 12 }))
      const after = seg.accept(pkt({ firstSeq: 30, overflowCount: 13 }))
      const late = seg.accept(pkt({ firstSeq: 0, overflowCount: 12 }))
      const next = seg.accept(pkt({ firstSeq: 60, overflowCount: 13 }))
      expect(late).toMatchObject({ ok: false, reason: 'duplicate' })
      expect(after.ok && next.ok).toBe(true)
      if (!after.ok || !next.ok) return
      expect(next.startedBecause).toBeNull()
      expect(next.segment.meta.segmentId).toBe(after.segment.meta.segmentId)
    })
  })

  describe('流れの分かれ方', () => {
    it('基板・センサー・起動が違えば別の区間になる', () => {
      const seg = new Segmenter()
      const a = seg.accept(pkt({ firstSeq: 0 }))
      const b = seg.accept(pkt({ firstSeq: 0, boardKey: 'mac:aabbccddee01' }))
      const c = seg.accept(pkt({ firstSeq: 0, sensorId: 'spi0-cs5' }))
      const d = seg.accept(pkt({ firstSeq: 0, bootId: 'b0' }))
      expect(a.ok && b.ok && c.ok && d.ok).toBe(true)
      if (!a.ok || !b.ok || !c.ok || !d.ok) return
      const ids = [a, b, c, d].map((r) => (r.ok ? r.segment.meta.segmentId : 0))
      expect(new Set(ids).size).toBe(4)
      expect(seg.openSegments()).toHaveLength(4)
    })

    it('上限に達したら、いちばん音沙汰の無い流れを閉じる', () => {
      // 受信口は LAN へ開くので、送り手の数はこちらで決められない。
      const seg = new Segmenter({ maxStreams: 2 })
      const a = seg.accept(pkt({ boardKey: 'mac:a1' }))
      seg.accept(pkt({ boardKey: 'mac:b2' }))
      // a を触り直すと、いちばん古いのは b2 になる。
      seg.accept(pkt({ boardKey: 'mac:a1', firstSeq: 30 }))
      const r = seg.accept(pkt({ boardKey: 'mac:c3' }))
      expect(r.ok && a.ok).toBe(true)
      if (!r.ok) return
      expect(r.closed).toHaveLength(1)
      expect(r.closed[0].meta.boardKey).toBe('mac:b2')
      expect(seg.openSegments().map((s) => s.meta.boardKey).sort()).toEqual(['mac:a1', 'mac:c3'])
    })

    it('識別子に区切り文字が入っても鍵が衝突しない', () => {
      // 受信口は LAN へ開くので、名乗る値の文字種をこちらで決められない。
      // `|` で繋ぐ鍵だと、この 2 つが同じ文字列になって別の場所の波形が混ざる。
      const seg = new Segmenter()
      const a = seg.accept(pkt({ boardKey: 'mac:X|Y', sensorId: 'Z' }))
      const b = seg.accept(pkt({ boardKey: 'mac:X', sensorId: 'Y|Z' }))
      expect(a.ok && b.ok).toBe(true)
      if (!a.ok || !b.ok) return
      expect(b.segment.meta.segmentId).not.toBe(a.segment.meta.segmentId)
      expect(b.startedBecause).toBe('stream-start')
      expect(seg.openSegments()).toHaveLength(2)
    })

    it('名指しで閉じられ、閉じたものは消える', () => {
      const seg = new Segmenter()
      const a = seg.accept(pkt({ firstSeq: 0 }))
      expect(a.ok).toBe(true)
      if (!a.ok) return
      const closed = seg.closeStream(a.segment.meta.streamKey)
      expect(closed?.sampleCount).toBe(30)
      expect(seg.openSegments()).toEqual([])
      expect(seg.closeStream(a.segment.meta.streamKey)).toBeNull()
    })
  })
})
