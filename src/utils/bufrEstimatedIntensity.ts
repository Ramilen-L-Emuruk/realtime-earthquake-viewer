// 推計震度分布図作図用データ（IXAC41）の読み取り。
//
// **このアプリで唯一の二進電文。** 他の種別は気象庁の XML だが、これは BUFR（二進形式汎用気象
// 通報式）第 3 版で届く。DMDATA は JSON 変換版を配らないので、自前で解くしかない。
//
// ## ビット幅の典拠
//
// ビット幅と参照値は**「配信資料に関するお知らせ 2023-01-11」の別紙4（第4節の実バイナリ例）**と
// **「配信資料に関する技術情報 第591号」**から採った。
//
// **同じお知らせの別紙3（記述子の定義表）は使ってはいけない。** あの表は列が崩れており、
// 崩れた結果が「0-01-242 電文の種類 = 2 ビット・00=なし/01=弱/10=強」という、どう見ても
// 0-08-198（階級震度の修飾）のものである定義に化ける。同じ崩れが仕様 No.40102 にも独立に
// 現れる。**別紙4 の実バイナリ例だけが、幅を一意に読み取れる形で書かれている。**
//
// 実電文 22 発表（2026-04〜08）で、ビット列が第4節の末尾ぴったりで終わることを確かめてある。
//
// ## なぜ記述子列を突き合わせるのか
//
// **ビット幅は電文に書かれていない。** 気象庁のローカル記述子（0-05-240 など）の幅は上記の
// 資料にしか無く、こちらが写し取った値を当てているだけ。だから**記述子列が既知の形と 1 つでも
// 違ったら読まない**——読めてしまうと、幅がずれたまま「それらしい値」が出て、画面に嘘の分布が
// 描かれる。例外を投げず `null` を返し、理由を記録する。
import { log } from './logger'
import type { JMAEstimatedIntensity, JMAEstimatedIntensityGrade } from '../types/earthquake'

const PREFIX = '[ixac41]'

/** 1 次メッシュの緯度の刻み（度）。経度は 1 度。 */
const LAT1 = 2 / 3

/**
 * 250m メッシュ 1 セルの寸法（度）。1/4 地域メッシュ＝3 次メッシュの 1/4。
 * 北緯 35 度で緯度 232m・経度 285m。
 */
export const CELL_LAT_DEG = LAT1 / 320
export const CELL_LON_DEG = 1 / 320

/**
 * 記述子列（既知の 2 形）。前者が通常、後者は**大津波警報・津波警報・津波注意報を発表した
 * 地震**のときの形で、震央補助表現（○○の△△◎◎◎km付近）の 4 記述子が挟まる。
 *
 * 実電文 22 発表ではこの 2 つしか現れなかった。
 */
const DESCRIPTORS_PLAIN = [
  '1-05-000', '0-31-001', '0-08-193', '0-08-198', '0-60-003', '0-60-002', '0-60-002',
  '0-01-242', '3-01-011', '3-01-012', '0-01-240',
  '0-05-002', '0-06-002', '2-02-123', '0-07-061', '2-02-000', '0-60-001',
  '1-13-000', '0-31-002', '0-05-240', '0-06-240', '0-05-241', '0-06-241',
  '1-07-000', '0-31-001', '0-05-242', '0-06-242',
  '1-03-000', '0-31-003', '0-05-243', '0-06-243', '0-60-002',
].join(' ')

/** 津波を発表した地震のときに挟まる 4 記述子（＋尺度変更 2 つ）。 */
const TSUNAMI_BLOCK = ['0-08-194', '0-01-241', '0-05-021', '2-02-126', '0-06-021', '2-02-000']
const DESCRIPTORS_TSUNAMI = DESCRIPTORS_PLAIN
  .replace('0-01-240 0-05-002', `0-01-240 ${TSUNAMI_BLOCK.join(' ')} 0-05-002`)

/**
 * 震央補助表現のブロックの合計ビット幅。
 *
 * **内訳は確定していない。** 別紙3 が読めず、実電文でも合計 46 ビットを満たす内訳が 480 通り
 * あって絞れなかった。**読まずに飛ばす**のでそれで足りる —— 震央地名の補助的表現はアプリが
 * XML 側（`Hypocenter/Area/NameFromMark`）から既に得ており、この電文から採る必要が無い。
 * 4 つとも固定幅なので合計は動かない。
 */
const TSUNAMI_BLOCK_BITS = 46

/** 電文の種類（0-01-242）が 0 以外なら訓練等。実配信 13 か月では 0 しか観測できていない。 */
const KIND_NORMAL = 0

/** マグニチュード（0-60-001）の特殊値。別紙4 ※1。 */
const MAG_UNKNOWN = 0
const MAG_HUGE = 127
export const MAG_CONDITION_UNKNOWN = 'Ｍ不明'
export const MAG_CONDITION_HUGE = 'Ｍ８を超える巨大地震'

/** ビット単位で読む。BUFR はオクテット境界を跨いでフィールドが並ぶ。 */
class BitReader {
  private p: number
  constructor(private readonly b: Uint8Array, bitPos: number) { this.p = bitPos }
  get pos(): number { return this.p }
  read(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1)
      this.p++
    }
    return v >>> 0
  }
  skip(n: number): void { this.p += n }
}

function u3(b: Uint8Array, o: number): number {
  return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]
}

/** 第0節が宣言する電文全長（オクテット）。分割の結合完了判定にも使う。 */
export function bufrDeclaredLength(bytes: Uint8Array): number | null {
  if (bytes.length < 8) return null
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'BUFR') return null
  return u3(bytes, 4)
}

/** 標準地域メッシュ（世界測地系）のセル南西端。1/2・1/4 の番号は 1=南西 2=南東 3=北西 4=北東。 */
function cellLat(p1: number, q2: number, r3: number, half: number, quarter: number): number {
  return p1 * LAT1
    + q2 * (LAT1 / 8)
    + r3 * (LAT1 / 80)
    + ((half - 1) >> 1) * (LAT1 / 160)
    + ((quarter - 1) >> 1) * (LAT1 / 320)
}
function cellLon(u1: number, v2: number, w3: number, half: number, quarter: number): number {
  return u1 + 100
    + v2 / 8
    + w3 / 80
    + ((half - 1) & 1) / 160
    + ((quarter - 1) & 1) / 320
}

function refuse(reason: string): null {
  log.warn(`${PREFIX} 推計震度分布図を読めませんでした: ${reason}`)
  return null
}

/**
 * 結合済みの BUFR を読む。読めなければ `null` を返し、理由を記録する。
 *
 * @param bytes 分割されていれば結合済みのもの（→ `bufrTelegramAssembly.ts`）
 * @param id 電文 id（結果に載せる。ログには出さない）
 * @param time 発表時刻（電文ヘッダの時刻）
 */
export function decodeEstimatedIntensity(
  bytes: Uint8Array,
  id: string,
  time: string,
): JMAEstimatedIntensity | null {
  const total = bufrDeclaredLength(bytes)
  if (total === null) return refuse('先頭が BUFR ではありません')
  if (bytes.length !== total) {
    // 分割の結合漏れがここへ来る。**読み進めない** —— 途中で切れたビット列は
    // 「それらしい値」を返しながら破綻するので、長さで弾くのがいちばん確実。
    return refuse(`長さが宣言と違います（宣言 ${total} / 実際 ${bytes.length}）`)
  }
  if (String.fromCharCode(...bytes.slice(-4)) !== '7777') return refuse('終端が 7777 ではありません')

  const edition = bytes[7]
  if (edition !== 3) return refuse(`BUFR の版が 3 ではありません（${edition}）`)

  const s1 = 8
  const s1len = u3(bytes, s1)
  let p = s1 + s1len
  // 第2節（任意節）。仕様は「省略する」と書いているが、フラグが立っていれば読み飛ばす。
  if (bytes[s1 + 7] & 0x80) p += u3(bytes, p)

  const s3 = p
  const s3len = u3(bytes, s3)
  const subsets = (bytes[s3 + 4] << 8) | bytes[s3 + 5]
  const s3flags = bytes[s3 + 6]
  if (subsets !== 1) return refuse(`データサブセット数が 1 ではありません（${subsets}）`)
  if (s3flags & 0x40) return refuse('圧縮された資料は扱えません')

  const descs: string[] = []
  for (let q = s3 + 7; q + 1 < s3 + s3len; q += 2) {
    const x = (bytes[q] << 8) | bytes[q + 1]
    descs.push(`${x >> 14}-${String((x >> 8) & 0x3f).padStart(2, '0')}-${String(x & 0xff).padStart(3, '0')}`)
  }
  const key = descs.join(' ')
  const hasTsunamiBlock = key === DESCRIPTORS_TSUNAMI
  if (!hasTsunamiBlock && key !== DESCRIPTORS_PLAIN) {
    // **ここで止めるのが肝。** 幅は電文に書かれておらず、こちらが資料から写した値を当てている
    // だけなので、並びが変われば幅もずれうる。読めてしまうと画面に嘘の分布が出る。
    return refuse(`記述子の並びが既知の 2 形のどちらとも違います（${descs.length} 個: ${key}）`)
  }

  const s4 = s3 + s3len
  const s4len = u3(bytes, s4)
  const endBit = (s4 + s4len) * 8
  const r = new BitReader(bytes, (s4 + 4) * 8)   // 長さ 3 + 保留 1 オクテット

  // ── 凡例（階級震度 ↔ 計測震度の対応表） ──
  const gradeCount = r.read(8)
  const grades: JMAEstimatedIntensityGrade[] = []
  const badGrades: string[] = []
  for (let i = 0; i < gradeCount; i++) {
    r.skip(7)                       // 0-08-193 要素の修飾（実電文では常に 90）
    const mod = r.read(2)           // 0-08-198
    const scale = r.read(4)         // 0-60-003 階級震度の整数部
    const lower = r.read(7)         // 0-60-002 計測震度の下限
    const upper = r.read(7)         // 0-60-002 同・上限
    grades.push({
      scale,
      modifier: mod === 1 ? 'weak' : mod === 2 ? 'strong' : 'none',
      lower,
      upper,
    })
    // **凡例の 1 行だけが妙でも記録する。** ここを黙って通すと、その階級に当たるセルだけが
    // 塗られず、**実際より狭い分布**が「気象庁の推計」の顔で出る。全滅していないので
    // 描画側の異常検知（`no-cell-drawn`）にも掛からず、画面にもログにも痕跡が残らない。
    if (scale < 4 || scale > 7 || lower > upper) {
      badGrades.push(`階級${scale}${mod === 1 ? '弱' : mod === 2 ? '強' : ''}[${lower}-${upper}]`)
    }
  }
  if (badGrades.length > 0) {
    log.warn(`${PREFIX} 想定外の凡例が ${badGrades.length} 行あります（この階級のセルは塗られません）: ${badGrades.join('・')}`)
  }

  const telegramKind = r.read(7)                                   // 0-01-242
  const year = r.read(12), month = r.read(4), day = r.read(6)      // 3-01-011
  const hour = r.read(5), minute = r.read(6)                       // 3-01-012
  const areaCode = r.read(10)                                      // 0-01-240
  if (hasTsunamiBlock) r.skip(TSUNAMI_BLOCK_BITS)

  const lat = (r.read(15) - 9000) / 100                            // 0-05-002
  const lon = (r.read(16) - 18000) / 100                           // 0-06-002
  const depthKm = r.read(14)                                       // 0-07-061（尺度変更で km）
  const magRaw = r.read(7)                                         // 0-60-001

  const arrivalTime = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (!Number.isFinite(arrivalTime.getTime())) {
    return refuse(`地震発現時刻を組み立てられません（${year}-${month}-${day} ${hour}:${minute} UTC）`)
  }

  // ── メッシュ ──
  const meshCount = r.read(16)                                     // 0-31-002 2 次メッシュの数
  // 上限の見積もり。1 セルは最短 13 ビット（1/2 3 + 1/4 3 + 計測震度 7）なので、
  // 第4節の長さから確保長を決めれば足りる。**足りないと静かに切れる**ので余裕を持たせる。
  const capacity = Math.ceil((s4len * 8) / 13) + 16
  const latArr = new Float32Array(capacity)
  const lonArr = new Float32Array(capacity)
  const siArr = new Uint8Array(capacity)
  let n = 0
  let maxSi = 0
  // 塗りがある範囲。**ここで一度だけ求める** —— カメラの寄り先に要るが、36 万セルを
  // 描画のたびに走査し直すのは無駄。
  let south = 90, north = -90, west = 180, east = -180
  let badMesh = 0
  const badMeshSamples: string[] = []

  for (let i = 0; i < meshCount; i++) {
    // **反復回数は電文の値をそのまま使うので、読み位置で歯止めを掛ける。**
    // 記述子列・全長・終端の検査をすべて通ったうえで第4節の中身だけが化けた場合、
    // 反復回数は最大 65535 × 255 × 255 になりうる。範囲外のセルは飛ばすだけで
    // `capacity` の判定にも掛からないため、走査量に上限が無くなる（画面が固まる）。
    if (r.pos >= endBit) return refuse(`メッシュの途中で第4節を超えました（2 次メッシュ ${i}/${meshCount}）`)
    const p1 = r.read(7), u1 = r.read(7)
    const q2 = r.read(4), v2 = r.read(4)
    const n3 = r.read(8)
    for (let j = 0; j < n3; j++) {
      if (r.pos >= endBit) return refuse(`メッシュの途中で第4節を超えました（3 次メッシュ ${j}/${n3}）`)
      const r3 = r.read(4), w3 = r.read(4)
      const n4 = r.read(8)
      for (let k = 0; k < n4; k++) {
        if (r.pos >= endBit) return refuse(`メッシュの途中で第4節を超えました（セル ${k}/${n4}）`)
        const half = r.read(3), quarter = r.read(3)
        const si = r.read(7)
        // 1/2・1/4 の番号は仕様上 1〜4 だが、幅は 3 ビットあるので 0 や 5〜7 も表せる。
        // 落とすのはそのセルだけにして、全体は捨てない（1 セル欠けても分布は読める）。
        if (half < 1 || half > 4 || quarter < 1 || quarter > 4) {
          badMesh++
          if (badMeshSamples.length < 3) badMeshSamples.push(`1/2=${half} 1/4=${quarter}`)
          continue
        }
        if (n >= capacity) {
          // 確保長の見積もりが外れた＝読み方がずれている。ここまでを捨てて記録する。
          return refuse(`セルが見積もり（${capacity}）を超えました。読み方がずれています`)
        }
        const cLat = cellLat(p1, q2, r3, half, quarter)
        const cLon = cellLon(u1, v2, w3, half, quarter)
        latArr[n] = cLat
        lonArr[n] = cLon
        siArr[n] = si
        if (si > maxSi) maxSi = si
        if (cLat < south) south = cLat
        if (cLat > north) north = cLat
        if (cLon < west) west = cLon
        if (cLon > east) east = cLon
        n++
      }
    }
  }

  // ビット列が第4節の末尾で終わること。残るのはバイト境界への詰め物（0〜7）と
  // 保留 1 オクテット（8）、それに偶数オクテット揃えの 1 オクテット（0 か 8）だけ。
  const leftover = endBit - r.pos
  if (leftover < 8 || leftover > 23) {
    return refuse(`ビット列が第4節の末尾で終わりませんでした（余り ${leftover} ビット）`)
  }

  if (badMesh > 0) {
    log.warn(`${PREFIX} 範囲外のメッシュ番号を持つセルを ${badMesh} 件落としました（${badMeshSamples.join('・')}）`)
  }
  if (n === 0) return refuse('セルを 1 件も読めませんでした')
  if (grades.length === 0) {
    // 凡例が無いと、どの計測震度がどの階級かを電文から言えなくなる。分布は描けるが
    // 色分けの根拠が消えるので、読めたことにしない。
    return refuse('階級震度の凡例が 1 件もありません')
  }
  if (telegramKind !== KIND_NORMAL) {
    log.warn(`${PREFIX} 電文の種類が通常（0）ではありません: ${telegramKind}`)
  }

  // **読めたことも記録する。** 他の種別と扱いを変えているのは、これが 13 か月で 28 通しか
  // 来ない・1 通が 36 万セルある電文で、しかも**画面に出る経路が地図の面だけ**だから。
  // 出ていないときに「届かなかった」のか「読めたが描けていない」のかを、ここでしか分けられない。
  log.info(`${PREFIX} 推計震度分布図を読みました ${n} セル・最大計測震度 ${(maxSi / 10).toFixed(1)}・凡例 ${grades.length} 段（${bytes.length} バイト）`)

  return {
    id,
    time,
    arrivalTime: arrivalTime.toISOString(),
    hypocenter: { lat, lon, depthKm },
    magnitude: magRaw === MAG_UNKNOWN || magRaw === MAG_HUGE ? NaN : magRaw / 10,
    magnitudeCondition: magRaw === MAG_UNKNOWN ? MAG_CONDITION_UNKNOWN
      : magRaw === MAG_HUGE ? MAG_CONDITION_HUGE : undefined,
    areaCode,
    telegramKind,
    grades,
    count: n,
    lat: latArr,
    lon: lonArr,
    si: siArr,
    // 配列が持つのはセルの南西端なので、北と東はセル 1 つ分を足して矩形を閉じる。
    bounds: { south, north: north + CELL_LAT_DEG, west, east: east + CELL_LON_DEG },
  }
}
