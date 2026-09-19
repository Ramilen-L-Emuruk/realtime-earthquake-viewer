// 推計震度分布図作図用データ（IXAC41・IXAC40）の読み取り。
//
// **このアプリで唯一の二進電文。** 他の種別は気象庁の XML だが、これは BUFR（二進形式汎用気象
// 通報式）第 3 版で届く。DMDATA は JSON 変換版を配らないので、自前で解くしかない。
//
// ## 2 種別を 1 つの読み取りで扱う
//
// IXAC41 は 250m メッシュ（1/4 地域メッシュ）、**IXAC40 はその前身で 1km メッシュ**
// （3 次メッシュ）。気象庁は 2026-02-02 に IXAC40 の配信を終了したので、ライブで届くのは
// IXAC41 だけ ―― IXAC40 は IXAC41 提供開始前（2022 年度後半より前）の地震を再生したときに
// だけ現れる（→ `docs/spec/data-sources-spec.md` §2「扱う電文種別」）。
//
// **記述子列は前半 17 個が完全に同一で、メッシュの段数だけが違う。** だから読み取りは 1 本で、
// 形の違い（`FORMS`）で分岐する。
//
// ## ビット幅の典拠
//
// 資料は 3 つ。**「配信資料に関する仕様 No.40102『推計震度分布図』」**が本体で、
// **「配信資料に関するお知らせ 2023-01-11」の別紙4（第4節の実バイナリ例）**と
// **「配信資料に関する技術情報 第591号」**が補う（No.40102 の発行日・改訂日は
// `docs/spec/quake-spec.md` §8「この電文だけ二進（BUFR）で届く」）。
//
// **メッシュとセルの幅は No.40102 の本文が平文で書いている**（1 次メッシュ緯度・経度が各 7、
// 2 次・3 次メッシュが各 4、1/2 と 1/4 の地域メッシュが各 3、計測震度が 7）。下の読み取り順は
// これと 1 対 1。
//
// **IXAC40 の幅も同じ資料から出る。** 幅は記述子番号ごとの定義なので、IXAC40 の記述子列
// （IXAC41 の部分集合）に当てれば足りる ―― **IXAC40 専用の幅を推測してはいない。**
// IXAC40 時代の資料（技術情報 第172 号の別添資料）は公開されているが、No.40102 は
// 2023-02-01 の改訂で IXAC41 の内容に置き換わっており、旧版は手に入らない。
//
// **記述子ごとの幅を表から読むときは、列を行で対応させてはいけない。** No.40102 の「資料記述子の
// フォーマット」も、お知らせ 2023-01-11 の別紙3 も、**記述子の列と幅の列で行の高さが違う**——
// 同じ行に並んだものを組にすると「0-60-003 階級震度 = 2 ビット・00=なし/01=弱/10=強」という、
// どう見ても 0-08-198（階級震度の修飾）のものである定義に化ける。**幅の列を上から順に当てれば
// 参照値まで一致する**（緯度 15 ビット・参照値 -9000、経度 16 ビット・参照値 -18000 等）。
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


/** 1 次メッシュの緯度の刻み（度）。経度は 1 度。 */
const LAT1 = 2 / 3

/**
 * 250m メッシュ 1 セルの寸法（度）。1/4 地域メッシュ＝3 次メッシュの 1/4。
 * 北緯 35 度で緯度 232m・経度 285m。**IXAC41 の値。**
 *
 * **描く側はこの定数ではなく結果の `cellLatDeg` を読むこと** —— IXAC40 は 1 セルが
 * 3 次メッシュそのもの（4 倍）で、定数から引くと片方の種別で必ずずれる。
 */
export const CELL_LAT_DEG = LAT1 / 320
export const CELL_LON_DEG = 1 / 320

/** 1km メッシュ 1 セルの寸法（度）。3 次メッシュそのもの。北緯 35 度で緯度 927m・経度 1139m。**IXAC40 の値。** */
export const CELL_LAT_DEG_1KM = LAT1 / 80
export const CELL_LON_DEG_1KM = 1 / 80

/**
 * 記述子列の前半。**凡例・電文の種類・地震発現時刻・震央地名・震源・深さ・規模**で、
 * IXAC41 と IXAC40 で**完全に同一**（実電文で 1 つずつ突き合わせた）。
 */
const DESCRIPTORS_HEAD = [
  '1-05-000', '0-31-001', '0-08-193', '0-08-198', '0-60-003', '0-60-002', '0-60-002',
  '0-01-242', '3-01-011', '3-01-012', '0-01-240',
  '0-05-002', '0-06-002', '2-02-123', '0-07-061', '2-02-000', '0-60-001',
].join(' ')

/**
 * メッシュ部（IXAC41）。1 次 → 2 次 → 3 次 → 1/2・1/4 の 4 段で、最下段に計測震度が付く。
 */
const DESCRIPTORS_MESH_QUARTER = [
  '1-13-000', '0-31-002', '0-05-240', '0-06-240', '0-05-241', '0-06-241',
  '1-07-000', '0-31-001', '0-05-242', '0-06-242',
  '1-03-000', '0-31-003', '0-05-243', '0-06-243', '0-60-002',
].join(' ')

/**
 * メッシュ部（IXAC40）。**IXAC41 から 1 段少ない** —— 1 次 → 2 次 → 3 次 で、
 * 最下段の 3 次メッシュに計測震度が付く（`0-05-243`/`0-06-243` の段が無い）。
 *
 * **ビット幅は IXAC41 と同じ資料から導ける。** 幅は記述子番号ごとに定義されており
 * （No.40102 本文「1 次メッシュ緯度・経度が各 7、2 次・3 次メッシュが各 4、計測震度が 7」）、
 * IXAC40 の記述子列はその部分集合。**IXAC40 専用の幅を推測してはいない。**
 */
const DESCRIPTORS_MESH_THIRD = [
  '1-09-000', '0-31-002', '0-05-240', '0-06-240', '0-05-241', '0-06-241',
  '1-03-000', '0-31-001', '0-05-242', '0-06-242', '0-60-002',
].join(' ')

/** 津波を発表した地震のときに挟まる 4 記述子（＋尺度変更 2 つ）。前半に入るので 2 種別で共通。 */
const TSUNAMI_BLOCK = ['0-08-194', '0-01-241', '0-05-021', '2-02-126', '0-06-021', '2-02-000']
const DESCRIPTORS_HEAD_TSUNAMI = DESCRIPTORS_HEAD
  .replace('0-01-240 0-05-002', `0-01-240 ${TSUNAMI_BLOCK.join(' ')} 0-05-002`)

/** セルの最下段の形。`quarter`＝1/4 地域メッシュ（IXAC41）／`third`＝3 次メッシュ（IXAC40）。 */
type MeshKind = 'quarter' | 'third'

interface TelegramForm {
  mesh: MeshKind
  hasTsunamiBlock: boolean
  /** 1 セルのビット幅。確保長の計算に使う */
  cellBits: number
  cellLatDeg: number
  cellLonDeg: number
  /**
   * 第4節の余りビットの許容範囲。**気象庁の実装が種別ごとに違う** —— データの後に
   * IXAC41 は 1 オクテット、IXAC40 は 2 オクテット余分に置く（実電文で確かめた）。
   * そこへバイト境界の詰め物（0〜7）と偶数オクテット揃え（0 か 8）が乗る。
   */
  leftoverMin: number
  leftoverMax: number
  /** 記録に出す名前 */
  label: string
}

/**
 * 既知の記述子列（4 形）。**1 つでも違ったら読まない。**
 *
 * 幅は電文に書かれておらず資料から写した値を当てているだけなので、並びが変われば幅もずれ、
 * 画面に嘘の分布が出る。
 *
 * **IXAC40 の津波形は標本を持たない。** 実配信で観測できたのは通常形の 2 通
 * （2022-01-22 日向灘）だけ。それでも登録するのは、津波ブロックが入る位置が
 * **2 種別で同一の前半**にあり、IXAC41 の形から機械的に導けるため。
 */
const FORMS: ReadonlyArray<TelegramForm & { key: string }> = [
  {
    key: `${DESCRIPTORS_HEAD} ${DESCRIPTORS_MESH_QUARTER}`,
    mesh: 'quarter', hasTsunamiBlock: false, cellBits: 13,
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
    leftoverMin: 8, leftoverMax: 23, label: 'IXAC41',
  },
  {
    key: `${DESCRIPTORS_HEAD_TSUNAMI} ${DESCRIPTORS_MESH_QUARTER}`,
    mesh: 'quarter', hasTsunamiBlock: true, cellBits: 13,
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
    leftoverMin: 8, leftoverMax: 23, label: 'IXAC41（津波）',
  },
  {
    key: `${DESCRIPTORS_HEAD} ${DESCRIPTORS_MESH_THIRD}`,
    mesh: 'third', hasTsunamiBlock: false, cellBits: 15,
    cellLatDeg: CELL_LAT_DEG_1KM, cellLonDeg: CELL_LON_DEG_1KM,
    leftoverMin: 16, leftoverMax: 31, label: 'IXAC40',
  },
  {
    key: `${DESCRIPTORS_HEAD_TSUNAMI} ${DESCRIPTORS_MESH_THIRD}`,
    mesh: 'third', hasTsunamiBlock: true, cellBits: 15,
    cellLatDeg: CELL_LAT_DEG_1KM, cellLonDeg: CELL_LON_DEG_1KM,
    leftoverMin: 16, leftoverMax: 31, label: 'IXAC40（津波）',
  },
]

/**
 * 震央補助表現のブロックの合計ビット幅。
 *
 * 内訳は現象の位置の修飾 7・地点番号 10・方位 16・距離 13（仕様 No.40102 の幅の列を上から
 * 順に当てて読む。冒頭「ビット幅の典拠」）。合計は実電文で測った 46 ビットと一致する。
 * **ただし実電文で 4 つを個別に読んで確かめてはいない** —— 前後の記述子の幅がこの当て方で
 * 実装の値と一致することと、合計が合うことから導いた。**個別の `read` へ分解するなら、まず
 * 実電文で 1 つずつ確かめること。**
 *
 * **いまは読まずに飛ばす。** 震央地名の補助的表現はアプリが XML 側
 * （`Hypocenter/Area/NameFromMark`）から既に得ており、この電文から採る必要が無い。
 * 4 つとも固定幅なので合計は動かない。
 */
const TSUNAMI_BLOCK_BITS = 46

/**
 * 電文の種類（0-01-242）が 0 以外なら訓練等。実配信 13 か月では 0 しか観測できていない。
 *
 * **この値は抑制の判定に使う。** 非 XML 電文（この BUFR がアプリで唯一のもの）では
 * 一覧・WebSocket の `test` フラグが**常に false** で、`test: "no"` を指定しても試験配信は
 * 届く —— 配信元のリファレンスが両方を明記している（`socket.start` の `test` パラメータと、
 * `telegram.list` / `websocket` の `test` フィールド）。**だから本文のこの値しか手掛かりが無い。**
 * 判定は `services/dmdataTelegramPayload.ts` の `isFilteredBinaryTelegram` に集約している。
 */
export const TELEGRAM_KIND_NORMAL = 0

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

/**
 * 標準地域メッシュ（世界測地系）のセル南西端。1/2・1/4 の番号は 1=南西 2=南東 3=北西 4=北東。
 *
 * **IXAC40（3 次メッシュが最下段）では `half` / `quarter` に 1 を渡す** —— どちらも 1 なら
 * 追加の 2 項が 0 になり、3 次メッシュの南西端そのものになる。式を分けていないのは、
 * 分けると同じ規約（メッシュ番号から座標を組む順序）を 2 箇所で持つことになるため。
 */
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

/**
 * セルを収める配列の確保長。1 セルのビット幅は種別で決まる（IXAC41 は 13＝1/2 が 3 + 1/4 が 3
 * + 計測震度 7、IXAC40 は 15＝3 次メッシュが 4 + 4 + 計測震度 7）ので、第4節の長さから決まる。
 *
 * **この長さへは届かない。** セルに使えるのは高々 `8·s4len − 32` ビット（読み始めが第4節の
 * 4 オクテット目）なのに対し、積んだ件数がここへ達するにはセルだけで `cellBits·capacity`
 * ビット要る。切り上げの性質から差は `+ 16` が無くても 32 ビット以上あり、**不到達そのものは
 * `+ 16` に依存しない**（`+ 16` はその余裕を広げているだけ）。実際には 2 次・3 次メッシュの
 * ヘッダもこの上に乗るので、**読み位置の歯止め（`r.pos >= endBit`）が必ず先に効く**。
 *
 * **`cellBits` は省略できない。** 既定値を置くと、種別を足したときに判断しないまま
 * 通ってしまう（確保長が過小になるとセルを落とし、`count` だけが実データを超えて報告される）。
 *
 * **テスト側もこの関数を通すこと。** 式を書き写すと、1 セルのビット幅を変えたときに片方だけ
 * 直っても、テストはずれた関係を検査したまま緑で通る。
 */
export function cellCapacityFor(section4Length: number, cellBits: number): number {
  return Math.ceil((section4Length * 8) / cellBits) + 16
}

/**
 * 結合済みの BUFR を読む。読めなければ `null` を返し、理由を記録する。
 *
 * @param bytes 分割されていれば結合済みのもの（→ `bufrTelegramAssembly.ts`）
 * @param id 電文 id（結果に載せる。ログには出さない）
 * @param time 発表時刻（電文ヘッダの時刻）
 * @param headType 電文種別（`IXAC41` / `IXAC40`）。**記録の接頭辞と、名乗りとの食い違いの
 *   検出に使う。読み取り自体は記述子列に従う** —— 中身が正で、名乗りは手掛かりにすぎない
 */
export function decodeEstimatedIntensity(
  bytes: Uint8Array,
  id: string,
  time: string,
  headType: string,
): JMAEstimatedIntensity | null {
  const prefix = `[${headType.toLowerCase()}]`
  const refuse = (reason: string): null => {
    log.warn(`${prefix} 推計震度分布図を読めませんでした: ${reason}`)
    return null
  }
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
  const form = FORMS.find((f) => f.key === key)
  if (!form) {
    // **ここで止めるのが肝。** 幅は電文に書かれておらず、こちらが資料から写した値を当てている
    // だけなので、並びが変われば幅もずれうる。読めてしまうと画面に嘘の分布が出る。
    return refuse(`記述子の並びが既知の ${FORMS.length} 形のどれとも違います（${descs.length} 個: ${key}）`)
  }
  const hasTsunamiBlock = form.hasTsunamiBlock
  // **名乗りと中身が食い違ったら記録する。** 読み取りは記述子列（中身）に従うので分布は正しく
  // 出るが、気象庁が種別の使い分けを変えたことに気づける場所が他に無い。
  if (!form.label.startsWith(headType)) {
    log.warn(`${prefix} 電文の名乗りと中身が食い違います（中身は ${form.label} の形）`)
  }

  const s4 = s3 + s3len
  const s4len = u3(bytes, s4)
  if (s4len < 4 || s4 + s4len > bytes.length - 4) {
    // 第4節の長さは、第0節が名乗る全長とは**別のフィールド**（最大 16,777,215）で、
    // 突き合わせる相手がいない。末尾の 4 は第5節（終端の `7777`）の固定長で、**正しい電文では
    // `s4 + s4len` がちょうどその直前を指す**（全長は上で実際の長さと一致を見ている）。
    // **以降の「第4節の中」という言い方はこの 1 行が裏付けている。** 過大だと下の確保長が
    // そのまま膨らみ（上限値で実測 88.6MB）、読み位置の歯止めも電文の外まで広がる。
    // 過少の側も見るのは、**読み始めが第4節の 4 オクテット目**（長さ 3 ＋ 保留 1）だから ——
    // 4 を下回ると読み始めがもう歯止めの外にいて、最初の 1 オクテットが素通しで読まれる。
    return refuse(`第4節の長さが電文に収まりません（第4節 ${s4} + ${s4len} / 全長 ${bytes.length}）`)
  }
  const endBit = (s4 + s4len) * 8
  const r = new BitReader(bytes, (s4 + 4) * 8)   // 長さ 3 + 保留 1 オクテット

  // ── 凡例（階級震度 ↔ 計測震度の対応表） ──
  const gradeCount = r.read(8)
  const grades: JMAEstimatedIntensityGrade[] = []
  const badGrades: string[] = []
  for (let i = 0; i < gradeCount; i++) {
    // 凡例の件数も電文の値をそのまま使うので、メッシュの 3 段と同じ歯止めを掛ける。
    // 化けた `gradeCount` は 1 件 27 ビット × 最大 255 件を読み進め、その先の震源・時刻・
    // メッシュ数を無関係な値で組み上げる（配列外は 0 が返るだけで例外にならない）。
    if (r.pos >= endBit) return refuse(`凡例の途中で第4節を超えました（${i}/${gradeCount}）`)
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
    log.warn(`${prefix} 想定外の凡例が ${badGrades.length} 行あります（この階級のセルは塗られません）: ${badGrades.join('・')}`)
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
  const capacity = cellCapacityFor(s4len, form.cellBits)
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

  /**
   * セルを 1 つ積む。確保長を超えたら `false`（呼び出し側が読み取りを諦める）。
   *
   * **2 種別で書き分けない。** 最下段の形が違うだけで、積み方（配列・最大値・外接矩形）は
   * 同じ。書き分けると片方だけ直る形になり、**画面にもログにも出ない食い違い**になる。
   */
  const pushCell = (cLat: number, cLon: number, si: number): boolean => {
    if (n >= capacity) return false
    latArr[n] = cLat
    lonArr[n] = cLon
    siArr[n] = si
    if (si > maxSi) maxSi = si
    if (cLat < south) south = cLat
    if (cLat > north) north = cLat
    if (cLon < west) west = cLon
    if (cLon > east) east = cLon
    n++
    return true
  }
  // **ここへは来ない。** `cellCapacityFor` の説明のとおり、読み位置の歯止めが先に効く
  // （`bufrEstimatedIntensity.test.ts` の「確保長は読み位置の歯止めに包まれている」が
  // 固定している）。それでも残すのは、到達しない根拠が「1 セル＝`cellBits` ビット」という
  // **資料から写した仮定**に乗っているため。型付き配列への範囲外書き込みは例外を出さずに
  // 捨てられ、`count` だけが実データを超えて報告される —— 描画側から見れば
  // 「セルが在るのに空」で、画面にもログにも痕跡が残らない。
  const capacityExceeded = (): null =>
    refuse(`セルが確保長（${capacity}）を超えました。読み方がずれています`)

  /**
   * メッシュ番号が仕様の値域を外れたセルを数える。**落とすのはそのセルだけで、全体は捨てない**
   * （1 セル欠けても分布は読める）。
   *
   * **見るのは最下段だけ。** 値が仕様を外れると隣のメッシュへはみ出した座標になり、有効な
   * 座標の形をしているので画面では気づけない。最下段は種別で違う ——
   * IXAC41 は 1/2・1/4（1〜4 だが幅 3 ビットなので 0 と 5〜7 も表せる）、
   * IXAC40 は 3 次メッシュ（0〜9 だが幅 4 ビットなので 10〜15 も表せる）。
   *
   * **IXAC41 の中間段（3 次メッシュ）は見ていない** —— そこが壊れると配下のセルがまとめて
   * ずれるが、実配信 22 発表では起きていない。塞ぐなら「何件のセルを読み飛ばすか」を
   * 別に決める必要があるので、今回は手を付けていない。
   */
  const outOfRange = (label: string): void => {
    badMesh++
    if (badMeshSamples.length < 3) badMeshSamples.push(label)
  }

  for (let i = 0; i < meshCount; i++) {
    // **反復回数は電文の値をそのまま使うので、読み位置で歯止めを掛ける。**
    // 記述子列・全長・終端の検査をすべて通ったうえで第4節の中身だけが化けた場合、
    // 最大 65535 × 255 × 255 回を名乗りうる。範囲外のセルは飛ばすだけで配列も埋まらないので、
    // ここで止めないと名乗られたぶんだけ空回りする（電文の中身が尽きれば読む値が 0 になって
    // 内側の段は立たなくなるが、外側だけでも 65535 周する）。
    if (r.pos >= endBit) return refuse(`メッシュの途中で第4節を超えました（2 次メッシュ ${i}/${meshCount}）`)
    const p1 = r.read(7), u1 = r.read(7)
    const q2 = r.read(4), v2 = r.read(4)
    const n3 = r.read(8)
    for (let j = 0; j < n3; j++) {
      if (r.pos >= endBit) return refuse(`メッシュの途中で第4節を超えました（3 次メッシュ ${j}/${n3}）`)
      const r3 = r.read(4), w3 = r.read(4)
      if (form.mesh === 'third') {
        // IXAC40。**3 次メッシュが最下段**で、計測震度がそこに付く（1/2・1/4 の段が無い）。
        const si = r.read(7)
        if (r3 > 9 || w3 > 9) { outOfRange(`3次=${r3},${w3}`); continue }
        // `half` / `quarter` に 1 を渡すと 3 次メッシュの南西端そのものになる（`cellLat` 参照）。
        if (!pushCell(cellLat(p1, q2, r3, 1, 1), cellLon(u1, v2, w3, 1, 1), si)) return capacityExceeded()
        continue
      }
      const n4 = r.read(8)
      for (let k = 0; k < n4; k++) {
        if (r.pos >= endBit) return refuse(`メッシュの途中で第4節を超えました（セル ${k}/${n4}）`)
        const half = r.read(3), quarter = r.read(3)
        const si = r.read(7)
        if (half < 1 || half > 4 || quarter < 1 || quarter > 4) {
          outOfRange(`1/2=${half} 1/4=${quarter}`)
          continue
        }
        if (!pushCell(cellLat(p1, q2, r3, half, quarter), cellLon(u1, v2, w3, half, quarter), si)) {
          return capacityExceeded()
        }
      }
    }
  }

  // ビット列が第4節の末尾で終わること。残るのはバイト境界への詰め物（0〜7）と、気象庁が
  // データの後に置く余分（IXAC41 は 1 オクテット・IXAC40 は 2 オクテット）、それに偶数
  // オクテット揃えの 1 オクテット（0 か 8）だけ。**範囲は種別ごとに持つ**（`FORMS`）。
  //
  // **この検査だけでは読み落としを捕まえきれない。** 許容幅（16 ビット）が 1 セルのビット幅
  // （13・15）より広いので、1 セル読み落としてもこの範囲に収まりうる。主な歯止めは記述子列の
  // 照合・全長・終端・読み位置の上限で、これはその上積み。
  const leftover = endBit - r.pos
  if (leftover < form.leftoverMin || leftover > form.leftoverMax) {
    return refuse(`ビット列が第4節の末尾で終わりませんでした（余り ${leftover} ビット・${form.label} の想定は ${form.leftoverMin}〜${form.leftoverMax}）`)
  }

  if (badMesh > 0) {
    log.warn(`${prefix} 範囲外のメッシュ番号を持つセルを ${badMesh} 件落としました（${badMeshSamples.join('・')}）`)
  }
  if (n === 0) return refuse('セルを 1 件も読めませんでした')
  if (grades.length === 0) {
    // 凡例が無いと、どの計測震度がどの階級かを電文から言えなくなる。分布は描けるが
    // 色分けの根拠が消えるので、読めたことにしない。
    return refuse('階級震度の凡例が 1 件もありません')
  }
  if (telegramKind !== TELEGRAM_KIND_NORMAL) {
    log.warn(`${prefix} 電文の種類が通常（0）ではありません: ${telegramKind}`)
  }

  // **読めたことも記録する。** 他の種別と扱いを変えているのは、これが 13 か月で 28 通しか
  // 来ない・1 通が 36 万セルある電文で、しかも**画面に出る経路が地図の面だけ**だから。
  // 出ていないときに「届かなかった」のか「読めたが描けていない」のかを、ここでしか分けられない。
  // **読んだ形も出す** —— セルの寸法が 4 倍違うので、分布の粒度が想定と違うときの切り分けに要る。
  log.info(`${prefix} 推計震度分布図を読みました（${form.label}）${n} セル・最大計測震度 ${(maxSi / 10).toFixed(1)}・凡例 ${grades.length} 段（${bytes.length} バイト）`)

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
    cellLatDeg: form.cellLatDeg,
    cellLonDeg: form.cellLonDeg,
    // 配列が持つのはセルの南西端なので、北と東はセル 1 つ分を足して矩形を閉じる。
    // **足す値は形から採る** —— 定数を使うと IXAC40 で 4 分の 1 しか閉じない。
    bounds: {
      south, north: north + form.cellLatDeg,
      west, east: east + form.cellLonDeg,
    },
  }
}
