// 推計震度分布図（IXAC41）の BUFR 読み取り。
//
// **正にしているのは「配信資料に関するお知らせ 2023-01-11」の別紙4**（第4節の実バイナリ例）。
// 資料が「このビット列はこの値」と書いている組をそのまま組み立てて、同じ値が返ることを見る。
//
// 実電文で「ビット列が第4節の末尾ぴったりで終わる」ことは確認済みだが、**あの判定だけでは
// 足りない** —— 詰め物の余地が 8〜23 ビットあるので、幅が 1 ビットずれた読み方も通りうる。
// 資料の値と突き合わせて初めて幅が確定する。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeEstimatedIntensity, bufrDeclaredLength, CELL_LAT_DEG, CELL_LON_DEG } from './bufrEstimatedIntensity'
// 組み立て側はリプレイのテストと共有する（`src/test-utils/bufrBuild.ts`）。
import { build, DESCS_PLAIN, SAMPLE_GRADES } from '../test-utils/bufrBuild'
import { log } from './logger'

vi.mock('./logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  createLogThrottle: () => (fn: () => void) => fn(),
}))

beforeEach(() => { vi.clearAllMocks() })

describe('decodeEstimatedIntensity（別紙4 の実バイナリ例）', () => {
  // 正: 資料が「このビット列はこの値」と書いている組がそのまま返る。
  // ここが通らなければ、ビット幅の写し取りが間違っている。
  it('資料の値をそのまま読み取る', () => {
    const bytes = build({
      grades: SAMPLE_GRADES,
      latRaw: 12484,     // 資料: 124.84 度（北緯 34.84 度）
      lonRaw: 31562,     // 資料: 315.62 度（東経 135.62 度）
      depthKm: 10,       // 資料: 10km
      magRaw: 61,        // 資料: マグニチュード 6.1
      mesh2: [{
        p1: 52, u1: 35, q2: 0, v2: 6,
        mesh3: [{ r3: 0, w3: 0, cells: [
          { half: 1, quarter: 1, si: 42 },
          { half: 1, quarter: 2, si: 42 },
          { half: 1, quarter: 3, si: 42 },
          { half: 1, quarter: 4, si: 43 },
        ] }],
      }],
    })
    const r = decodeEstimatedIntensity(bytes, 'id1', '2026-04-20T08:25:00Z')
    expect(r).not.toBeNull()
    expect(r!.hypocenter).toEqual({ lat: 34.84, lon: 135.62, depthKm: 10 })
    expect(r!.magnitude).toBeCloseTo(6.1, 5)
    expect(r!.magnitudeCondition).toBeUndefined()
    // 資料: 年月日 2018年6月17日 / 時分 22時58分（UTC）
    expect(r!.arrivalTime).toBe('2018-06-17T22:58:00.000Z')
    expect(r!.areaCode).toBe(520)   // 資料: 震央地名番号 520 ＝ 大阪府北部
    expect(r!.telegramKind).toBe(0)
    expect(r!.count).toBe(4)
    expect([...r!.si.slice(0, 4)]).toEqual([42, 42, 42, 43])
    expect(log.warn).not.toHaveBeenCalled()
  })

  // 正: 凡例は電文が名乗ったものをそのまま持つ。自前の階級表を当てない。
  it('階級震度の凡例を電文から読む', () => {
    const bytes = build({
      grades: SAMPLE_GRADES, latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw: 61,
      mesh2: [{ p1: 52, u1: 35, q2: 0, v2: 6, mesh3: [{ r3: 0, w3: 0, cells: [{ half: 1, quarter: 1, si: 42 }] }] }],
    })
    const r = decodeEstimatedIntensity(bytes, 'id', 't')!
    expect(r.grades).toEqual([
      { scale: 4, modifier: 'none', lower: 35, upper: 44 },
      { scale: 5, modifier: 'weak', lower: 45, upper: 49 },
      { scale: 5, modifier: 'strong', lower: 50, upper: 54 },
      { scale: 6, modifier: 'weak', lower: 55, upper: 59 },
    ])
  })

  // 正: 1/2・1/4 の番号（1=南西 2=南東 3=北西 4=北東）がセルの南西端へ効く。
  // **ここが狂うと分布が砂嵐になる。** 4 象限が 1 セルぶんずつずれることを見る。
  it('1/2・1/4 地域メッシュ番号から南西端の緯度経度を出す', () => {
    const bytes = build({
      grades: SAMPLE_GRADES, latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw: 61,
      mesh2: [{ p1: 52, u1: 35, q2: 0, v2: 0, mesh3: [{ r3: 0, w3: 0, cells: [
        { half: 1, quarter: 1, si: 40 },   // 南西の南西
        { half: 1, quarter: 2, si: 41 },   // 南西の南東
        { half: 1, quarter: 3, si: 42 },   // 南西の北西
        { half: 4, quarter: 4, si: 43 },   // 北東の北東
      ] }] }],
    })
    const r = decodeEstimatedIntensity(bytes, 'id', 't')!
    const baseLat = 52 * (2 / 3), baseLon = 135
    // 小数 4 桁（約 11m）で見る。**Float32 で持っているため**、経度 135 度付近では
    // 表せる刻みが約 1.3m あり、5 桁（約 1m）だと量子化そのものに引っかかる。
    // セルは 250m 角なので、この誤差は下の安全弁が確かめるとおり無視できる。
    expect(r.lat[0]).toBeCloseTo(baseLat, 4)
    expect(r.lon[0]).toBeCloseTo(baseLon, 4)
    expect(r.lat[1]).toBeCloseTo(baseLat, 4)
    expect(r.lon[1]).toBeCloseTo(baseLon + CELL_LON_DEG, 4)
    expect(r.lat[2]).toBeCloseTo(baseLat + CELL_LAT_DEG, 4)
    expect(r.lon[2]).toBeCloseTo(baseLon, 4)
    // 北東の北東は 3 次メッシュの中で 3 セルぶん北東
    expect(r.lat[3]).toBeCloseTo(baseLat + 3 * CELL_LAT_DEG, 4)
    expect(r.lon[3]).toBeCloseTo(baseLon + 3 * CELL_LON_DEG, 4)
  })

  // 安全弁: セルの座標を Float32 で持つことの誤差が、セルの寸法に対して十分小さいこと。
  // **Float64 へ広げれば 365k セルで 2.9MB 増える**ので、そこまでの精度は要らないと
  // 決めた判断そのものを固定する。日本の東端付近（経度が最も大きい＝刻みが最も粗い）で見る。
  it('Float32 の量子化はセル寸法に対して十分細かい', () => {
    const exactLon = 145 + 7 / 8 + 9 / 80 + 1 / 160 + 1 / 320
    const err = Math.abs(Math.fround(exactLon) - exactLon)
    // 度 → m（経度・北緯 35 度）。セル 1 辺の 0.1% 未満に収まっていること。
    const errMeters = err * 111_320 * Math.cos(35 * Math.PI / 180)
    const cellMeters = CELL_LON_DEG * 111_320 * Math.cos(35 * Math.PI / 180)
    expect(errMeters).toBeLessThan(cellMeters * 0.001)
  })

  // 正: 数値にならない規模。**電文は全ビット 0 と全ビット 1 で言い分ける**（別紙4 ※1）。
  // アプリの既存の扱い（`magnitudeCondition`）へそのまま載せる。
  it.each([
    [0, 'Ｍ不明'],
    [127, 'Ｍ８を超える巨大地震'],
  ])('マグニチュード %i を説明へ落とす', (magRaw, expected) => {
    const bytes = build({
      grades: SAMPLE_GRADES, latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw,
      mesh2: [{ p1: 52, u1: 35, q2: 0, v2: 6, mesh3: [{ r3: 0, w3: 0, cells: [{ half: 1, quarter: 1, si: 42 }] }] }],
    })
    const r = decodeEstimatedIntensity(bytes, 'id', 't')!
    expect(Number.isNaN(r.magnitude)).toBe(true)
    expect(r.magnitudeCondition).toBe(expected)
  })

  // 正: 津波を発表した地震では震央補助表現の 4 記述子が挟まる。**読まずに 46 ビット飛ばす**
  // だけだが、飛ばし損ねると以降の震源も分布も丸ごとずれる。
  it('津波発表時の記述子列でも震源とセルがずれない', () => {
    const common = {
      grades: SAMPLE_GRADES, latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw: 61,
      mesh2: [{ p1: 52, u1: 35, q2: 0, v2: 6, mesh3: [{ r3: 0, w3: 0, cells: [{ half: 2, quarter: 3, si: 55 }] }] }],
    }
    const plain = decodeEstimatedIntensity(build(common), 'id', 't')!
    const tsu = decodeEstimatedIntensity(build({ ...common, tsunami: true }), 'id', 't')!
    expect(tsu.hypocenter).toEqual(plain.hypocenter)
    expect(tsu.arrivalTime).toBe(plain.arrivalTime)
    expect([...tsu.si.slice(0, 1)]).toEqual([...plain.si.slice(0, 1)])
    expect(tsu.lat[0]).toBeCloseTo(plain.lat[0], 6)
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('decodeEstimatedIntensity（読めないもの）', () => {
  const ok = {
    grades: SAMPLE_GRADES, latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw: 61,
    mesh2: [{ p1: 52, u1: 35, q2: 0, v2: 6, mesh3: [{ r3: 0, w3: 0, cells: [{ half: 1, quarter: 1, si: 42 }] }] }],
  }

  // 安全弁: 記述子の並びが変わったら読まない。**ビット幅は電文に書かれていない**ので、
  // 並びが違えば幅もずれうる。読めてしまうと画面に嘘の分布が出る。
  it('知らない記述子の並びは読まずに記録する', () => {
    const bytes = build({ ...ok, descs: [...DESCS_PLAIN, '0-01-999'] })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('記述子の並び')
  })

  // 安全弁: 分割の結合漏れ。長さで弾かないと、途中で切れたビット列を読み進めてしまう。
  it('宣言された全長と実際の長さが違えば読まない', () => {
    const bytes = build({ ...ok, declaredLengthOverride: 999999 })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('長さが宣言と違います')
  })

  it('BUFR の版が 3 でなければ読まない', () => {
    const bytes = build({ ...ok, edition: 4 })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('版が 3 ではありません')
  })

  it('BUFR で始まらなければ読まない', () => {
    const bytes = build(ok)
    bytes[0] = 0x00
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
  })

  // 対照: 範囲外のメッシュ番号はそのセルだけ落として、残りは読む。
  // **1 セル欠けても分布は読めるので、電文ごと捨てるのは過剰。**
  it('範囲外のメッシュ番号はそのセルだけ落として記録する', () => {
    const bytes = build({
      ...ok,
      mesh2: [{ p1: 52, u1: 35, q2: 0, v2: 6, mesh3: [{ r3: 0, w3: 0, cells: [
        { half: 0, quarter: 1, si: 42 },   // 1/2 が範囲外
        { half: 1, quarter: 7, si: 43 },   // 1/4 が範囲外
        { half: 2, quarter: 2, si: 44 },   // 正常
      ] }] }],
    })
    const r = decodeEstimatedIntensity(bytes, 'id', 't')
    expect(r).not.toBeNull()
    expect(r!.count).toBe(1)
    expect(r!.si[0]).toBe(44)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('範囲外のメッシュ番号')
  })

  // 安全弁: セルが 1 件も無い電文は「読めた」ことにしない（空の分布を描いても意味が無い）。
  it('セルが 1 件も無ければ読まない', () => {
    const bytes = build({ ...ok, mesh2: [] })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
  })

  // 安全弁: 凡例が無いと、どの計測震度がどの階級かを電文から言えない。
  it('凡例が 1 件も無ければ読まない', () => {
    const bytes = build({ ...ok, grades: [] })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
  })

  // 安全弁: **凡例の 1 行だけが妙でも黙らない。** 全滅していないので描画側の異常検知には
  // 掛からず、その階級のセルだけが塗られない「実際より狭い分布」が公式の顔で出る。
  it('想定外の凡例の行を記録する（読み取りは続ける）', () => {
    const bytes = build({
      ...ok,
      grades: [
        { mod: 0, scale: 4, lo: 35, hi: 44 },
        { mod: 0, scale: 9, lo: 45, hi: 49 },   // 階級 9 は存在しない
        { mod: 0, scale: 5, lo: 60, hi: 50 },   // 下限 > 上限
      ],
    })
    const r = decodeEstimatedIntensity(bytes, 'id', 't')
    expect(r).not.toBeNull()
    expect(r!.grades).toHaveLength(3)
    const msg = String(vi.mocked(log.warn).mock.calls[0][0])
    expect(msg).toContain('想定外の凡例が 2 行')
  })

  // 対照: まともな凡例では鳴らない（正常運転でログを埋めない）。
  it('凡例が揃っていれば記録しない', () => {
    decodeEstimatedIntensity(build(ok), 'id', 't')
    expect(log.warn).not.toHaveBeenCalled()
  })

  // 対照: 訓練等の電文（種類 0 以外）は読むが記録する。実配信 13 か月では 0 しか出ていない。
  it('電文の種類が通常でなければ記録する（読み取りは続ける）', () => {
    const bytes = build({ ...ok, kind: 1 })
    const r = decodeEstimatedIntensity(bytes, 'id', 't')
    expect(r).not.toBeNull()
    expect(r!.telegramKind).toBe(1)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('電文の種類')
  })
})

describe('bufrDeclaredLength', () => {
  it('第0節の宣言全長を返す', () => {
    const bytes = build({
      grades: SAMPLE_GRADES, latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw: 61,
      mesh2: [{ p1: 52, u1: 35, q2: 0, v2: 6, mesh3: [{ r3: 0, w3: 0, cells: [{ half: 1, quarter: 1, si: 42 }] }] }],
    })
    expect(bufrDeclaredLength(bytes)).toBe(bytes.length)
  })

  it('BUFR で始まらなければ null', () => {
    expect(bufrDeclaredLength(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull()
  })

  it('8 バイト未満なら null', () => {
    expect(bufrDeclaredLength(new Uint8Array([0x42, 0x55, 0x46, 0x52]))).toBeNull()
  })
})
