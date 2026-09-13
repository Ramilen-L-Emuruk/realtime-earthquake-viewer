// 推計震度分布図（IXAC41）の BUFR を組み立てる。**テスト専用。**
//
// 読み取り側（`src/utils/bufrEstimatedIntensity.ts`）と対になる。実電文は
// 最小でも 40KB あり、リポジトリへ置けるものではないので、**資料が「このビット列は
// この値」と書いている組をそのまま組み立てて**読み取りを固定する。
//
// 分割配信の結合（`src/services/dmdataReplay.ts`）からも使う。あちらは
// 「二進を文字列へ通していないか」を見るので、**中身が読める電文でないと確かめられない**。
class BitWriter {
  private bits: number[] = []
  write(value: number, width: number): this {
    for (let i = width - 1; i >= 0; i--) this.bits.push((value >> i) & 1)
    return this
  }
  /** バイト境界まで 0 で埋めてから、保留 1 オクテットを足す。 */
  finish(): Uint8Array {
    while (this.bits.length % 8 !== 0) this.bits.push(0)
    this.bits.push(...new Array(8).fill(0))
    const out = new Uint8Array(this.bits.length / 8)
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7)
    }
    return out
  }
}

export const DESCS_PLAIN = [
  '1-05-000', '0-31-001', '0-08-193', '0-08-198', '0-60-003', '0-60-002', '0-60-002',
  '0-01-242', '3-01-011', '3-01-012', '0-01-240',
  '0-05-002', '0-06-002', '2-02-123', '0-07-061', '2-02-000', '0-60-001',
  '1-13-000', '0-31-002', '0-05-240', '0-06-240', '0-05-241', '0-06-241',
  '1-07-000', '0-31-001', '0-05-242', '0-06-242',
  '1-03-000', '0-31-003', '0-05-243', '0-06-243', '0-60-002',
]
const TSUNAMI_BLOCK = ['0-08-194', '0-01-241', '0-05-021', '2-02-126', '0-06-021', '2-02-000']
export function withTsunamiBlock(list: string[]): string[] {
  const i = list.indexOf('0-01-240')
  return [...list.slice(0, i + 1), ...TSUNAMI_BLOCK, ...list.slice(i + 1)]
}

function descBytes(list: string[]): Uint8Array {
  const out = new Uint8Array(list.length * 2)
  list.forEach((d, i) => {
    const [f, x, y] = d.split('-').map(Number)
    const v = (f << 14) | (x << 8) | y
    out[i * 2] = v >> 8
    out[i * 2 + 1] = v & 0xff
  })
  return out
}

export interface Grade { mod: number; scale: number; lo: number; hi: number }
export interface Cell { half: number; quarter: number; si: number }
export interface Mesh3 {
  r3: number; w3: number; cells: Cell[]
  /**
   * 電文が名乗るセル数を実際とわざと食い違わせる。**読み取り側は反復回数に電文の値を
   * そのまま使う**ので、水増しすると第4節の外まで読み進めようとする（その歯止めの再現）。
   */
  declaredCellCount?: number
}
export interface Mesh2 {
  p1: number; u1: number; q2: number; v2: number; mesh3: Mesh3[]
  /** 電文が名乗る 3 次メッシュ数を実際とわざと食い違わせる（`declaredCellCount` と同じ狙い）。 */
  declaredMesh3Count?: number
}
export interface Build {
  grades: Grade[]
  kind?: number
  y?: number; mo?: number; d?: number; h?: number; mi?: number
  areaCode?: number
  latRaw: number; lonRaw: number; depthKm: number; magRaw: number
  mesh2: Mesh2[]
  tsunami?: boolean
  edition?: number
  descs?: string[]
  /** 宣言する全長を実際とわざと食い違わせる（結合漏れの再現） */
  declaredLengthOverride?: number
  /** 電文が名乗る 2 次メッシュ数を実際とわざと食い違わせる（`Mesh3.declaredCellCount` と同じ狙い）。 */
  declaredMesh2Count?: number
  /** 電文が名乗る凡例の件数を実際とわざと食い違わせる（同上）。 */
  declaredGradeCount?: number
  /**
   * 第4節が名乗る長さを実際とわざと食い違わせる。読み取り側は**セルを収める配列の長さも
   * 読み進める上限もこの値から決める**ので、どちらが先に効くかを確かめるのに使う。
   */
  section4LengthOverride?: number
}

export function build(b: Build): Uint8Array {
  const w = new BitWriter()
  w.write(b.declaredGradeCount ?? b.grades.length, 8)
  for (const g of b.grades) {
    w.write(90, 7).write(g.mod, 2).write(g.scale, 4).write(g.lo, 7).write(g.hi, 7)
  }
  w.write(b.kind ?? 0, 7)
  w.write(b.y ?? 2018, 12).write(b.mo ?? 6, 4).write(b.d ?? 17, 6)
  w.write(b.h ?? 22, 5).write(b.mi ?? 58, 6)
  w.write(b.areaCode ?? 520, 10)
  if (b.tsunami) { w.write(0, 7).write(0, 10).write(9000, 16).write(80, 13) }   // 合計 46 ビット
  w.write(b.latRaw, 15).write(b.lonRaw, 16).write(b.depthKm, 14).write(b.magRaw, 7)
  w.write(b.declaredMesh2Count ?? b.mesh2.length, 16)
  for (const m2 of b.mesh2) {
    w.write(m2.p1, 7).write(m2.u1, 7).write(m2.q2, 4).write(m2.v2, 4)
      .write(m2.declaredMesh3Count ?? m2.mesh3.length, 8)
    for (const m3 of m2.mesh3) {
      w.write(m3.r3, 4).write(m3.w3, 4).write(m3.declaredCellCount ?? m3.cells.length, 8)
      for (const c of m3.cells) w.write(c.half, 3).write(c.quarter, 3).write(c.si, 7)
    }
  }
  const payload = w.finish()

  const descs = b.descs ?? (b.tsunami ? withTsunamiBlock(DESCS_PLAIN) : DESCS_PLAIN)
  const db = descBytes(descs)
  let s3len = 7 + db.length
  if (s3len % 2 !== 0) s3len++
  let s4len = 4 + payload.length
  if (s4len % 2 !== 0) s4len++

  const total = 8 + 18 + s3len + s4len + 4
  const out = new Uint8Array(total)
  let o = 0
  out.set([0x42, 0x55, 0x46, 0x52], o); o += 4
  const declared = b.declaredLengthOverride ?? total
  out[o++] = (declared >> 16) & 0xff; out[o++] = (declared >> 8) & 0xff; out[o++] = declared & 0xff
  out[o++] = b.edition ?? 3
  // 第1節（18 オクテット）: 長さ・マスター表・副中枢・中枢 34・更新番号・フラグ・
  //   カテゴリー 255・副カテゴリー・マスター表版・ローカル表版・年月日時分・保留
  out.set([0, 0, 18, 0, 0, 34, 0, 0, 255, 0, 8, 0, 26, 4, 20, 8, 25, 0], o); o += 18
  out[o++] = (s3len >> 16) & 0xff; out[o++] = (s3len >> 8) & 0xff; out[o++] = s3len & 0xff
  out[o++] = 0
  out[o++] = 0; out[o++] = 1        // サブセット数 1
  out[o++] = 0x80                   // 観測資料・非圧縮
  out.set(db, o); o += s3len - 7
  // 節の中身の置き方は実際の長さで決め、名乗る値だけ差し替える。
  const declaredS4len = b.section4LengthOverride ?? s4len
  out[o++] = (declaredS4len >> 16) & 0xff
  out[o++] = (declaredS4len >> 8) & 0xff
  out[o++] = declaredS4len & 0xff
  out[o++] = 0
  out.set(payload, o); o += s4len - 4
  out.set([0x37, 0x37, 0x37, 0x37], o)
  return out
}


/** 別紙4 の凡例（震度4〜6弱ぶん）。計測震度の境界がそのまま気象庁震度階級。 */
export const SAMPLE_GRADES: Grade[] = [
  { mod: 0, scale: 4, lo: 35, hi: 44 },
  { mod: 1, scale: 5, lo: 45, hi: 49 },
  { mod: 2, scale: 5, lo: 50, hi: 54 },
  { mod: 1, scale: 6, lo: 55, hi: 59 },
]

/** 別紙4 の実バイナリ例そのもの。読み取れた値は同ファイルのテストが固定している。 */
export function buildSampleTelegram(over: Partial<Build> = {}): Uint8Array {
  return build({
    grades: SAMPLE_GRADES,
    latRaw: 12484, lonRaw: 31562, depthKm: 10, magRaw: 61,
    mesh2: [{
      p1: 52, u1: 35, q2: 0, v2: 6,
      mesh3: [{ r3: 0, w3: 0, cells: [
        { half: 1, quarter: 1, si: 42 },
        { half: 1, quarter: 2, si: 42 },
        { half: 1, quarter: 3, si: 42 },
        { half: 1, quarter: 4, si: 43 },
      ] }],
    }],
    ...over,
  })
}
