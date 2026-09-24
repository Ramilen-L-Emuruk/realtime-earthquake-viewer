import { describe, expect, it } from 'vitest'

import { parseSensorPacket } from './parsePacket'

/** 実際に記録されている版 1 のヘッダ（`cap-night1/raw-seismo-3.txt` から採った）。 */
const REAL_V1_HEADER =
  '{"n":"seismo-3","s":"MPU6050","ug":61.0352,"hz":100,"r":2,'
  + '"t":1790185612727,"q":1085044,"c":30,"o":21}'

function packet(header: string, rows: string[]): string {
  return [header, ...rows].join('\n') + '\n'
}

function rows(n: number, width = 3): string[] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: width }, (_, j) => String(i * 10 + j)).join(','))
}

const V2_HEADER = JSON.stringify({
  v: 2, mac: '3c8a1f5d54d8', bid: '7f3a91c4', sid: 'i2c0-68', st: 'MPU6050',
  ch: ['HN1', 'HN2', 'HN3'], ug: 61.0352, fs: 2, hz: 100,
  t: 1790185612727, q: 1085044, c: 3, o: 21,
})

describe('parseSensorPacket', () => {
  describe('読めるもの', () => {
    it('版 2 を読む', () => {
      const r = parseSensorPacket(packet(V2_HEADER, rows(3)))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet).toMatchObject({
        version: 2,
        boardKey: 'mac:3c8a1f5d54d8',
        bootId: '7f3a91c4',
        sensorId: 'i2c0-68',
        channels: ['HN1', 'HN2', 'HN3'],
        sampleRateHz: 100,
        firstSeq: 1085044,
        overflowCount: 21,
      })
      expect(r.packet.samples).toEqual([[0, 1, 2], [10, 11, 12], [20, 21, 22]])
    })

    it('版 1（実際の記録から採ったヘッダ）を読む', () => {
      const r = parseSensorPacket(packet(REAL_V1_HEADER, rows(30)))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet.version).toBe(1)
      expect(r.packet.sensorType).toBe('MPU6050')
      expect(r.packet.samples).toHaveLength(30)
    })

    it('軸が 2 つのセンサーも、型番を知らずに読める', () => {
      // IIS2ICLX を想定。**軸数は `ch` の長さだけで決まる。**
      const head = JSON.stringify({
        v: 2, mac: 'aabbccddee01', bid: 'b0', sid: 'spi0-cs5', st: 'IIS2ICLX',
        ch: ['HN1', 'HN3'], ug: 15.3, fs: 2, hz: 100, t: 1, q: 0, c: 2, o: 0,
      })
      const r = parseSensorPacket(packet(head, rows(2, 2)))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet.channels).toEqual(['HN1', 'HN3'])
      expect(r.packet.samples).toEqual([[0, 1], [10, 11]])
    })

    it('負の値を読む（静止していても 3 軸のうち 2 つは負になりうる）', () => {
      const r = parseSensorPacket(packet(V2_HEADER, ['1136,-1036,16768', '-1,-2,-3', '0,0,0']))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet.samples).toEqual([[1136, -1036, 16768], [-1, -2, -3], [0, 0, 0]])
    })
  })

  describe('版 1 の時刻の補正', () => {
    // 版 1 のファームは「最新サンプルはたった今 採られた」と仮定していたため、
    // 名乗る時刻が平均して半サンプル分だけ遅い。読み取りの時点で引く。
    it('100 Hz では 5 ms 引く', () => {
      const r = parseSensorPacket(packet(REAL_V1_HEADER, rows(30)))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet.firstSampleMs).toBe(1790185612727 - 5)
    })

    it('補正量はサンプリング周波数で決まる（50 Hz なら 10 ms）', () => {
      const head = '{"n":"a","s":"MPU6050","ug":61,"hz":50,"r":2,"t":1000,"q":0,"c":1,"o":0}'
      const r = parseSensorPacket(packet(head, rows(1)))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet.firstSampleMs).toBe(990)
    })

    it('版 2 では引かない（ファーム側で補正済みのため）', () => {
      const r = parseSensorPacket(packet(V2_HEADER, rows(3)))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet.firstSampleMs).toBe(1790185612727)
    })
  })

  describe('落とすもの', () => {
    it('途中で切れたパケットは、少ないぶんだけ採らずに落とす', () => {
      // 30 件と名乗って 28 行しか無い。採ると以後の通し番号の連続性がずれる。
      const r = parseSensorPacket(packet(REAL_V1_HEADER, rows(28)))
      expect(r).toMatchObject({ ok: false, reason: 'sample-count-mismatch' })
    })

    it('空欄を 0 として通さない', () => {
      // `Number('')` は 0 を返す。静止した値として解析へ流れると気づけない。
      const r = parseSensorPacket(packet(V2_HEADER, ['1,2,3', '4,,6', '7,8,9']))
      expect(r).toMatchObject({ ok: false, reason: 'sample-not-integer' })
    })

    it('列の数が軸の数と合わなければ落とす', () => {
      const r = parseSensorPacket(packet(V2_HEADER, ['1,2,3', '4,5', '7,8,9']))
      expect(r).toMatchObject({ ok: false, reason: 'sample-column-mismatch' })
    })

    it('知らない版は黙って捨てず、版として記録する', () => {
      const head = JSON.stringify({ v: 3, mac: 'a', bid: 'b', sid: 'c', st: 'd',
        ch: ['HN1'], ug: 1, fs: 2, hz: 100, t: 1, q: 0, c: 1, o: 0 })
      const r = parseSensorPacket(packet(head, ['1']))
      expect(r).toMatchObject({ ok: false, reason: 'unsupported-version' })
    })

    it('JSON でない先頭行は、内容を添えて落とす', () => {
      const r = parseSensorPacket('not json\n1,2,3\n')
      expect(r).toMatchObject({ ok: false, reason: 'header-unreadable' })
      if (r.ok) return
      expect(r.detail).toContain('not json')
    })

    it('欠けている欄の名前を添える', () => {
      const head = '{"s":"MPU6050","ug":61,"hz":100,"r":2,"t":1,"q":0,"c":1,"o":0}'
      const r = parseSensorPacket(packet(head, rows(1)))
      expect(r).toMatchObject({ ok: false, reason: 'header-field-invalid', detail: 'n' })
    })

    it('数値として壊れた時刻を通さない', () => {
      // JSON に NaN は書けないので、文字列が入っている形で確かめる。
      const head = '{"n":"a","s":"b","ug":61,"hz":100,"r":2,"t":"x","q":0,"c":1,"o":0}'
      const r = parseSensorPacket(packet(head, rows(1)))
      expect(r).toMatchObject({ ok: false, reason: 'header-field-invalid', detail: 't' })
    })

    it('時刻として表せない大きさの値を通さない', () => {
      // **有限なだけでは足りない。** `Number.isFinite(1e20)` は真だが
      // `new Date(1e20).toISOString()` は投げる。ここで通すと、時刻として出せない値が
      // 波形に乗ったまま下流へ流れ、**出す側で初めて例外になる** ——
      // そのとき巻き添えで消えるのは、同じパケットに同梱された他の基板の震度のほう。
      for (const t of [1e20, -1e20, 8.64e15 + 1]) {
        const head = `{"n":"a","s":"b","ug":61,"hz":100,"r":2,"t":${t},"q":0,"c":1,"o":0}`
        expect(parseSensorPacket(packet(head, rows(1)))).toMatchObject({
          ok: false,
          reason: 'header-field-invalid',
          detail: 't',
        })
      }
      // 境界そのものは通す（`Date` が表せる端）。
      const edge = `{"n":"a","s":"b","ug":61,"hz":100,"r":2,"t":${8.64e15},"q":0,"c":1,"o":0}`
      expect(parseSensorPacket(packet(edge, rows(1))).ok).toBe(true)
    })

    it('空の中身を落とす', () => {
      expect(parseSensorPacket('')).toMatchObject({ ok: false, reason: 'empty' })
      expect(parseSensorPacket('\n')).toMatchObject({ ok: false, reason: 'empty' })
    })

    it('件数 0 を名乗るパケットを落とす', () => {
      // 中身の無い便りを「読めたパケット」として数えないため。
      const head = JSON.stringify({ ...JSON.parse(V2_HEADER), c: 0 })
      expect(parseSensorPacket(head + '\n')).toMatchObject({
        ok: false, reason: 'header-field-invalid', detail: 'c',
      })
    })

    it('10 進の整数でない書き方を通さない', () => {
      // `Number()` は `0x1A` を 26、`1e2` を 100 として受け、前後の空白も読み飛ばす。
      // どれも `Number.isInteger` を通ってしまうので、書式を先に見る。
      for (const bad of ['0x1A', '1e2', ' 5', '5 ', '1.0', '+5', '']) {
        const r = parseSensorPacket(packet(V2_HEADER, [`${bad},2,3`, '4,5,6', '7,8,9']))
        expect(r, `"${bad}" は落とすこと`).toMatchObject({ ok: false, reason: 'sample-not-integer' })
      }
    })

    it('正確に表せない桁数の値を通さない', () => {
      const r = parseSensorPacket(packet(V2_HEADER, ['99999999999999999999,2,3', '4,5,6', '7,8,9']))
      expect(r).toMatchObject({ ok: false, reason: 'sample-not-integer' })
    })

    it('空行は軸の数によらず同じ理由で落とす', () => {
      // `''.split(',')` は長さ 1 の配列を返すので、軸が 1 つのセンサーでは
      // 列数の検査を素通りする。同じ事象が軸数で別の理由へ振り分けられると、
      // 理由ごとの件数を数える意味が無くなる。
      const oneAxis = JSON.stringify({ ...JSON.parse(V2_HEADER), ch: ['HN1'], c: 3 })
      const three = parseSensorPacket(packet(V2_HEADER, ['1,2,3', '', '7,8,9']))
      const one = parseSensorPacket(packet(oneAxis, ['1', '', '7']))
      expect(three).toMatchObject({ ok: false, reason: 'sample-column-mismatch' })
      expect(one).toMatchObject({ ok: false, reason: 'sample-column-mismatch' })
    })

    it('識別子の前後の空白は落とす（同じ基板が別の流れに分かれないように）', () => {
      const head = '{"n":" seismo-3 ","s":"MPU6050","ug":61,"hz":100,"r":2,"t":1,"q":0,"c":1,"o":0}'
      const r = parseSensorPacket(packet(head, ['1,2,3']))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.packet.boardKey).toBe('name:seismo-3')
    })

    it('識別子が空白だけの値を通さない', () => {
      const head = '{"n":"   ","s":"MPU6050","ug":61,"hz":100,"r":2,"t":1,"q":0,"c":1,"o":0}'
      expect(parseSensorPacket(packet(head, ['1,2,3']))).toMatchObject({
        ok: false, reason: 'header-field-invalid', detail: 'n',
      })
    })
  })

  describe('識別の鍵', () => {
    it('版 2 は MAC、版 1 は名前。前置きで出どころが残る', () => {
      const v2 = parseSensorPacket(packet(V2_HEADER, rows(3)))
      const v1 = parseSensorPacket(packet(REAL_V1_HEADER, rows(30)))
      expect(v2.ok && v2.packet.boardKey).toBe('mac:3c8a1f5d54d8')
      expect(v1.ok && v1.packet.boardKey).toBe('name:seismo-3')
    })

    it('版 1 は起動ごとの値を持たない（通し番号の衝突を検知できない範囲）', () => {
      const r = parseSensorPacket(packet(REAL_V1_HEADER, rows(30)))
      expect(r.ok && r.packet.bootId).toBe('')
    })
  })
})
