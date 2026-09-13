// 推計震度分布図（IXAC41）の BUFR 読み取り。
//
// **正にしているのは「配信資料に関するお知らせ 2023-01-11」の別紙4**（第4節の実バイナリ例）。
// 資料が「このビット列はこの値」と書いている組をそのまま組み立てて、同じ値が返ることを見る。
//
// 実電文で「ビット列が第4節の末尾ぴったりで終わる」ことは確認済みだが、**あの判定だけでは
// 足りない** —— 詰め物の余地が 8〜23 ビットあるので、幅が 1 ビットずれた読み方も通りうる。
// 資料の値と突き合わせて初めて幅が確定する。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  decodeEstimatedIntensity, bufrDeclaredLength, cellCapacityFor, CELL_LAT_DEG, CELL_LON_DEG,
} from './bufrEstimatedIntensity'
// 組み立て側はリプレイのテストと共有する（`src/test-utils/bufrBuild.ts`）。
import { build, DESCS_PLAIN, SAMPLE_GRADES, type Build, type Mesh2, type Mesh3 } from '../test-utils/bufrBuild'
import { log } from './logger'

vi.mock('./logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  createLogThrottle: () => (fn: () => void) => fn(),
}))

beforeEach(() => { vi.clearAllMocks() })

/**
 * 第4節の位置と長さを、読み取り側と同じ手順で辿る。**辿り方がずれれば確保長の再現も嘘になる**
 * ので、読めた値が電文全体の長さと噛み合うことを呼び出し側で併せて確かめる。
 */
function section4(bytes: Uint8Array): { offset: number; length: number } {
  const u3 = (o: number) => (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]
  let p = 8 + u3(8)
  if (bytes[8 + 7] & 0x80) p += u3(p)   // 第2節（任意節）
  const offset = p + u3(p)
  return { offset, length: u3(offset) }
}

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

  // 安全弁: 第4節の長さが電文に収まらない値を名乗ったら読まない。**第0節が名乗る全長とは
  // 別のフィールド**なので突き合わせる相手がおらず、過大だとセルを収める配列がそのまま
  // 膨らむ（上限値を名乗らせると 88.6MB を確保してから捨てていた）。読み位置の歯止めも
  // 電文の外へ後退するので、**「第4節の中」という言い方が成り立たなくなる**。
  it('第4節の長さが電文に収まらなければ読まない', () => {
    const bytes = build({ ...ok, section4LengthOverride: 0xffffff })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('第4節の長さが電文に収まりません')
  })

  // 対照: 第5節（終端の `7777`・4 オクテット固定）の直前を指す長さは弾かない。**正しい電文は
  // 必ずここを指す**ので、境界を 1 オクテットでも内側へ詰めると分布が丸ごと読めなくなる。
  it('第4節の長さが第5節の直前を指すなら弾かない', () => {
    const origin = build(ok)
    const bytes = build({ ...ok, section4LengthOverride: origin.length - 4 - section4(origin).offset })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).not.toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
  })

  // 安全弁: 短すぎる側も弾く。**読み始めは第4節の 4 オクテット目**（長さ 3 ＋ 保留 1）なので、
  // 4 を下回ると読み始めの時点でもう歯止めの外にいて、最初の 1 オクテットが素通しで読まれる。
  it.each([0, 3])('第4節の長さが %i オクテットなら読まない', (s4len) => {
    const bytes = build({ ...ok, section4LengthOverride: s4len })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('第4節の長さが電文に収まりません')
  })

  // 安全弁: 境界のすぐ外側。1 オクテットでも第5節へ食い込めば読まない。
  it('第4節の長さが第5節へ 1 オクテット食い込めば読まない', () => {
    const origin = build(ok)
    const bytes = build({ ...ok, section4LengthOverride: origin.length - 3 - section4(origin).offset })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('第4節の長さが電文に収まりません')
  })

  // 安全弁: 凡例の件数も電文の値をそのまま使うので、メッシュの 3 段と同じ歯止めが要る。
  // ここだけ素通しだと、**1 件 27 ビット × 最大 255 件を読み進めた先で震源も時刻もメッシュ数も
  // 無関係な値で組み上がる**（配列外は 0 が返るだけで例外にならない）。
  it('凡例の件数を水増しした電文は読み位置で止める', () => {
    const bytes = build({ ...ok, declaredGradeCount: 255 })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('凡例の途中で第4節を超えました')
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

// セルを収める配列の確保長（`capacity`）は、読み方がずれたときの最後の砦として
// 「積んだ件数が確保長に届いたら電文ごと捨てる」分岐を持っている。**だがその分岐へは到達しない**
// —— 読み位置の歯止め（`r.pos >= endBit`）が必ず先に効く。ここで固定するのはその包含関係で、
// 分岐を消さずに残している理由は実装側のコメントにある。
describe('decodeEstimatedIntensity（確保長は読み位置の歯止めに包まれている）', () => {
  const base = { grades: SAMPLE_GRADES, latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw: 61 }

  // 確保長は**実装の関数をそのまま呼ぶ**。式を書き写すと、1 セルのビット幅を変えたときに
  // 片方だけ直っても、ここはずれた関係を検査したまま緑で通る。
  const capacityOf = (bytes: Uint8Array) => cellCapacityFor(section4(bytes).length)

  /**
   * セルを最も密に詰めた電文の中身。1 つの 3 次メッシュへ 255 件（セル数の幅の上限）まで
   * 入れるとメッシュのヘッダが占める割合が最小になり、**確保長にいちばん近づく形**になる。
   */
  function densest(cellCount: number): Mesh2[] {
    const mesh3: Mesh3[] = []
    for (let left = cellCount, i = 0; left > 0; i++) {
      const take = Math.min(255, left)
      left -= take
      mesh3.push({
        r3: i % 8, w3: 0,
        cells: Array.from({ length: take }, (_, k) => ({ half: (k % 4) + 1, quarter: (k % 4) + 1, si: 40 })),
      })
    }
    return [{ p1: 52, u1: 35, q2: 0, v2: 6, mesh3 }]
  }

  // 正: 最も密に詰めても、読めた件数は確保長へ届かない。**余裕が 16 セルぶん以上残る**ことまで
  // 見る —— 確保長の末尾に足している `+ 16` がこの関係を作っている。
  it.each([255, 1020, 2550])('最も密に詰めた %i セルの電文でも確保長には届かない', (cellCount) => {
    const bytes = build({ ...base, mesh2: densest(cellCount) })
    const s4 = section4(bytes)
    expect(s4.offset + s4.length + 4).toBe(bytes.length)   // 辿り方の自己確認（末尾 4 オクテットは 7777）
    const r = decodeEstimatedIntensity(bytes, 'id', 't')
    expect(r).not.toBeNull()
    expect(r!.count).toBe(cellCount)
    expect(capacityOf(bytes) - r!.count).toBeGreaterThanOrEqual(16)
  })

  // 安全弁: 確保長が実際のセル数に足りない電文でも、返るのは**読み位置の歯止め**のほう。
  // 確保長は第4節の長さから決まるので、短く名乗らせれば縮む。
  it('確保長がセル数に足りなくても、先に効くのは読み位置の歯止め', () => {
    const bytes = build({ ...base, mesh2: densest(255), section4LengthOverride: 200 })
    expect(capacityOf(bytes)).toBeLessThan(255)
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('第4節を超えました')
  })

  // 安全弁: 第4節の長さをどう名乗らせても、確保長の分岐は 1 度も発火しない。
  // **確保長・読み進められるビット数・積める件数の上限はどれも第4節の長さだけで決まる**ので、
  // そこを振り切れば経路を覆える。読み方がずれた電文は読み位置の歯止めか、
  // ビット列の終わり方の検査で捕まる。
  it('第4節の長さをどう名乗らせても確保長の分岐は発火しない', () => {
    // 組み立ては 1 度だけ行い、名乗る値だけ書き換える（毎回組み直すと 500 通りで時間がかかる）。
    const origin = build({ ...base, mesh2: densest(255) })
    const { offset, length } = section4(origin)
    for (let s4len = 0; s4len <= length + 32; s4len++) {
      vi.clearAllMocks()
      const bytes = Uint8Array.from(origin)
      bytes[offset] = (s4len >> 16) & 0xff
      bytes[offset + 1] = (s4len >> 8) & 0xff
      bytes[offset + 2] = s4len & 0xff
      decodeEstimatedIntensity(bytes, 'id', 't')
      const msgs = vi.mocked(log.warn).mock.calls.map((c) => String(c[0]))
      expect(msgs.filter((m) => m.includes('セルが確保長'))).toEqual([])
    }
  })

  // 安全弁: 反復回数は電文の値をそのまま使うので、水増しされたら読み位置で止める。
  // **止まる段は水増しした段とは限らない** —— 外側の段は次の周へ入る前にヘッダを読み進めて
  // しまい、そこで読んだ値がそのまま内側の反復回数になるので、詰め物や末尾の `7777` の
  // 中身しだいで内側の段が先に捕まえる。ここでは段を問わず「第4節を超えたこととして止まる」
  // ことを見る（セルの段で止まることは次のテストが見る）。
  it.each<[string, Build]>([
    ['2 次メッシュ', { ...base, mesh2: densest(255), declaredMesh2Count: 100 }],
    ['3 次メッシュ', { ...base, mesh2: [{ ...densest(255)[0], declaredMesh3Count: 100 }] }],
  ])('%s の数を水増しした電文は読み位置で止める', (_label, spec) => {
    expect(decodeEstimatedIntensity(build(spec), 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('メッシュの途中で第4節を超えました')
  })

  // 安全弁: セルの段の歯止めだけは重みが違う。**1 周が 13 ビットの読み取りを伴う**ので、
  // ここが抜けると名乗られた件数ぶんだけ実際に読み進める（外側 2 段の 1 周はヘッダを
  // 読むだけで、しかも電文の中身が尽きれば読む値が 0 になって内側の段が立たなくなる）。
  // セル数を水増しした電文がセルの段で捕まることを見る。
  it('水増しされたセル数はセルの段で止まる', () => {
    const bytes = build({
      ...base,
      mesh2: [{
        p1: 52, u1: 35, q2: 0, v2: 6,
        mesh3: [{ r3: 0, w3: 0, cells: [{ half: 1, quarter: 1, si: 42 }], declaredCellCount: 100 }],
      }],
    })
    expect(decodeEstimatedIntensity(bytes, 'id', 't')).toBeNull()
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('（セル ')
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
