/**
 * JMA2001 走時表（`src/data/jma2001TravelTime.ts`）を気象庁の配布ファイルから作り直す。
 *
 * 気象庁は緊急地震速報の主要動到達予測時刻を、速度構造 JMA2001 を基に作った走時表から
 * 出している（「緊急地震速報の概要や処理手法に関する技術的参考資料」令和 6 年 4 月 11 日
 * https://www.jma.go.jp/jma/kishou/know/jishin/eew/katsuyou/reference.pdf
 * p.15）。アプリの予報円・S 波到達予測も同じ表を引くことで、電文が名乗る時刻と同じ
 * 根拠に揃える。
 *
 * **生成物はバンドルへ埋め込む。** 予報円と自動解除は電文を受け取った瞬間に同期で決まるので、
 * 表が「まだ読み込めていない」状態を作れない（詳細は `src/utils/travelTime.ts` の冒頭）。
 *
 * 上流のファイルは 2005-04-14 付けで固定されており、定期実行は要らない。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

export const SOURCE_URL =
  'https://www.data.jma.go.jp/svd/eqev/data/bulletin/catalog/appendix/trtime/tjma2001.zip'
/** zip の中の唯一のエントリ名。増えていたら上流の形が変わったということ。 */
const ENTRY_NAME = 'tjma2001'
const CACHE_PATH = resolve(REPO_ROOT, '.claude/jma2001-cache/tjma2001.zip')
const OUT_PATH = resolve(REPO_ROOT, 'src/data/jma2001TravelTime.ts')

/** 走時は 0.01 秒単位の整数へ丸めて持つ。丸め誤差 0.005 秒は表の刻み幅より 2 桁細かい。 */
const CENTI = 100

interface Row {
  p: number
  s: number
  depth: number
  dist: number
}

/**
 * 既知の値。**上流が差し替わったことに気づくための錨**なので、生成のたびに全部照合する。
 * 値は 2026-09-22 に取得した配布ファイルから採った。
 */
const ANCHORS: [depth: number, dist: number, p: number, s: number][] = [
  [0, 0, 0.0, 0.0],
  [0, 2, 0.416, 0.703],
  [0, 100, 17.683, 30.048],
  [0, 2000, 252.705, 451.912],
  [10, 0, 1.773, 3.007],
  [30, 100, 16.424, 28.225],
  [100, 200, 30.364, 53.324],
  [700, 0, 79.996, 143.377],
  [700, 2000, 213.863, 384.747],
]

/** 表の格子。刻み幅は気象庁のページが明記している（0-50 は 2km・50-200 は 5km・以降 10km）。 */
function expectedGrid(max: number): number[] {
  const out: number[] = []
  for (let v = 0; v <= Math.min(50, max); v += 2) out.push(v)
  for (let v = 55; v <= Math.min(200, max); v += 5) out.push(v)
  for (let v = 210; v <= max; v += 10) out.push(v)
  return out
}

async function loadZip(): Promise<Uint8Array> {
  if (existsSync(CACHE_PATH)) return new Uint8Array(readFileSync(CACHE_PATH))
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`走時表を取得できません: HTTP ${res.status} ${SOURCE_URL}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  mkdirSync(dirname(CACHE_PATH), { recursive: true })
  writeFileSync(CACHE_PATH, bytes)
  return bytes
}

function parseTable(text: string): Row[] {
  const rows: Row[] = []
  let unreadable = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = /^P\s+([\d.]+)\s+S\s+([\d.]+)\s+(\d+)\s+(\d+)$/.exec(t)
    if (!m) {
      unreadable += 1
      continue
    }
    rows.push({ p: Number(m[1]), s: Number(m[2]), depth: Number(m[3]), dist: Number(m[4]) })
  }
  if (unreadable > 0) throw new Error(`走時表に読めない行が ${unreadable} 行あります`)
  return rows
}

/** 走時を 0.01 秒単位の整数へ。丸め方は全値で揃える。 */
const centi = (sec: number) => Math.round(sec * CENTI)

function encode(depths: number[], dists: number[], byKey: Map<string, Row>): string {
  const n = depths.length * dists.length
  const buf = new Int16Array(n * 2)
  for (let phase = 0; phase < 2; phase += 1) {
    for (let di = 0; di < depths.length; di += 1) {
      let prev = 0
      for (let xi = 0; xi < dists.length; xi += 1) {
        const row = byKey.get(`${depths[di]}|${dists[xi]}`)!
        const v = centi(phase === 0 ? row.p : row.s)
        buf[phase * n + di * dists.length + xi] = v - prev
        prev = v
      }
    }
  }
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64')
}

/** 書き出す base64 を復号し直して、全ての組が元の値と一致することを確かめる。 */
function verifyRoundTrip(
  base64: string,
  depths: number[],
  dists: number[],
  byKey: Map<string, Row>,
): void {
  const bytes = Buffer.from(base64, 'base64')
  const deltas = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const n = depths.length * dists.length
  for (let phase = 0; phase < 2; phase += 1) {
    for (let di = 0; di < depths.length; di += 1) {
      let acc = 0
      for (let xi = 0; xi < dists.length; xi += 1) {
        acc += deltas[phase * n + di * dists.length + xi]
        const row = byKey.get(`${depths[di]}|${dists[xi]}`)!
        const want = centi(phase === 0 ? row.p : row.s)
        if (acc !== want) {
          const phaseName = phase === 0 ? 'P' : 'S'
          throw new Error(
            `符号化が元の値と一致しません: ${phaseName} 深さ${depths[di]}km 距離${dists[xi]}km ${acc} != ${want}`,
          )
        }
      }
    }
  }
}

export async function main(): Promise<void> {
  const zip = await loadZip()
  const files = unzipSync(zip)
  const names = Object.keys(files)
  if (names.length !== 1 || names[0] !== ENTRY_NAME) {
    throw new Error(`zip の中身が想定と違います: ${names.join(', ')}（想定: ${ENTRY_NAME} のみ）`)
  }
  const rows = parseTable(Buffer.from(files[ENTRY_NAME]).toString('utf8'))

  const depths = [...new Set(rows.map((r) => r.depth))].sort((a, b) => a - b)
  const dists = [...new Set(rows.map((r) => r.dist))].sort((a, b) => a - b)
  if (depths.join() !== expectedGrid(700).join()) throw new Error('深さの格子が想定と違います')
  if (dists.join() !== expectedGrid(2000).join()) throw new Error('震央距離の格子が想定と違います')

  const byKey = new Map(rows.map((r) => [`${r.depth}|${r.dist}`, r]))
  if (byKey.size !== rows.length) throw new Error('同じ深さ・距離の組が重複しています')
  if (byKey.size !== depths.length * dists.length) {
    throw new Error(`格子が埋まっていません: ${byKey.size} / ${depths.length * dists.length}`)
  }

  for (const [depth, dist, p, s] of ANCHORS) {
    const row = byKey.get(`${depth}|${dist}`)
    if (!row) throw new Error(`既知の値が表にありません: 深さ${depth}km 距離${dist}km`)
    if (row.p !== p || row.s !== s) {
      throw new Error(
        `既知の値と合いません: 深さ${depth}km 距離${dist}km P=${row.p}(想定${p}) S=${row.s}(想定${s})`,
      )
    }
  }

  // 距離方向に非減少であること。崩れていると半径の逆引き（二分探索）が成り立たない。
  // **求めるのは非減少で、厳密な増加ではない** —— 0.01 秒へ丸めるので隣り合う格子が同値になる
  // 平坦部がある（実データで P 296 組・S 172 組）。逆引き側はそれを前提に書いてある。
  let maxCenti = 0
  for (const depth of depths) {
    let prevP = -1
    let prevS = -1
    for (const dist of dists) {
      const row = byKey.get(`${depth}|${dist}`)!
      if (centi(row.p) < centi(prevP) || centi(row.s) < centi(prevS)) {
        throw new Error(`走時が距離方向に単調でありません: 深さ${depth}km 距離${dist}km`)
      }
      if (row.p > row.s) throw new Error(`P が S より遅い組があります: 深さ${depth}km 距離${dist}km`)
      prevP = row.p
      prevS = row.s
      maxCenti = Math.max(maxCenti, centi(row.s))
    }
  }
  // 復号側は Uint16Array で持つ。0.01 秒単位で 65535 を超えると桁があふれる。
  if (maxCenti > 65535) throw new Error(`走時が 0.01 秒単位で Uint16 に収まりません: ${maxCenti}`)

  const base64 = encode(depths, dists, byKey)
  verifyRoundTrip(base64, depths, dists, byKey)

  const lines = [
    '// 自動生成。手で編集しない（`npm run build-travel-time-table` で作り直す）。',
    '//',
    '// 気象庁 JMA2001 走時表。出典・取得元・格子の刻み幅・表の外の扱いは',
    '// docs/spec/data-sources-spec.md §6「JMA2001 走時表」を参照。',
    `// 出典: 気象庁 走時表（JMA2001） ${SOURCE_URL}`,
    '',
    '/** 表が持つ深さ [km]。昇順。 */',
    `export const TT_DEPTHS_KM: readonly number[] = ${JSON.stringify(depths)}`,
    '',
    '/** 表が持つ震央距離 [km]。昇順。 */',
    `export const TT_DISTANCES_KM: readonly number[] = ${JSON.stringify(dists)}`,
    '',
    '/**',
    ' * 走時 [0.01 秒単位] を距離方向の一次差分（Int16LE）で並べたもの。',
    ' * 前半が P・後半が S で、どちらも深さの昇順 × 距離の昇順。',
    ' */',
    'export const TT_DELTAS_BASE64 =',
    `  '${base64}'`,
    '',
  ]
  writeFileSync(OUT_PATH, lines.join('\n'))
  console.log(
    `走時表を書き出しました: ${OUT_PATH}\n` +
      `  深さ ${depths.length} 点 × 距離 ${dists.length} 点 = ${rows.length} 組` +
      ` / base64 ${(base64.length / 1024).toFixed(0)}KB`,
  )
}

/**
 * **直接実行されたときだけ走らせる。**
 *
 * このファイルは `scripts/travelTimeTable.test.ts` が `SOURCE_URL` を読むために import する。
 * 読み込みだけで `main()` が動くと、`npm test` が気象庁へ取りに行き生成物を書き換える
 * （→ `scripts/scriptEntrypoints.test.ts`）。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
