// 日本語ラベル用 SDF グリフ PBF を事前生成する（§8 テキスト描画 B案・移行計画 docs/webgl-rendering-migration-plan.md §8）。
//
// 背景: MapLibre は glyphs 未設定だと text-font の文字を実行時に TinySDF でクライアント
// ラスタライズする。日本語（漢字数百字）の初回生成が実機 Surface Go 2 で 75〜260ms のメイン
// スレッドブロックを生み、区域名初出＝地震検知の自動ズームと重なる最悪局面で 100〜260ms 停止し
// うる（実機計測 docs/webgl-production-build-measure-result 系・計画書 §8）。B案は SDF グリフを
// ビルド時に PBF へ焼き、実行時はフェッチするだけにして生成スパイクを恒久的に消す。
//
// 生成器: @mapbox/tiny-sdf（MapLibre 本体が使うのと同一の SDF 生成器。fontSize24/buffer3/
// radius8/cutoff0.25 の既定でグリフ PBF フォーマットにそのまま対応）。Node には DOM canvas が
// 無いため document.createElement('canvas') を @napi-rs/canvas（プリビルド配布・native コンパイル
// 不要）でシムする。標準の node-fontnik は native ビルドが Node 24 で通らず不採用（この経路なら
// Windows 開発機でも Linux CI でも同一スクリプトが動く）。
//
// 出力: public/fonts/<STACK>/<start>-<end>.pbf（MapLibre の glyphs URL 規約）。
//       必要な codepoint を含む 256 ブロックだけを生成する（ラベルは既知有限集合のため軽量）。
//
// 使い方:
//   node scripts/build-glyphs.mjs                    # 既定: 同梱の Noto Sans JP(scripts/fonts/NotoSansJP-VF.ttf)
//   GLYPH_FONT=path/to/Other.ttf \                   # 別フォントを使う場合のみ上書き
//     GLYPH_STACK="Other Family" node scripts/build-glyphs.mjs
//
// 本番フォント: 再配布可能な Noto Sans JP(OFL) の可変フォントを scripts/fonts/ に同梱し、既定で登録する
// （システム Yu Gothic は再配布不可のため不採用）。出力 public/fonts/Noto Sans JP/ を MapLibre が配信する。
// 見た目はフォント差で微変するが perf 特性（事前生成で TinySDF スパイクを消す）は不変。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { PbfWriter } from 'pbf'

// tiny-sdf は document.createElement('canvas') を使うため Node 上でシムする。
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
    return createCanvas(1, 1)
  },
}
const TinySDF = (await import('@mapbox/tiny-sdf')).default

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

// SDF パラメータ（MapLibre 既定・サーバーグリフと一致させる）。
const FONT_SIZE = 24
// 【変更禁止】MapLibre クライアントは glyph atlas 構築時にグリフ境界を 3px 固定で前提し、
// ビットマップ寸法を (width+2*3)×(height+2*3) として再計算する（GLYPH_PBF_BORDER=3 の公開規約）。
// ここを変えると PBF に書く width/height と実ビットマップ長の対応が崩れ、無音で描画が壊れる。
const BUFFER = 3
const RADIUS = 8
const CUTOFF = 0.25
// フォントウェイト。可変フォント(Noto Sans JP・wght 軸)から太めのインスタンスでグリフを焼く。
// 既定 700(Bold)＝ダーク地図上で細い文字が「非常に見づらい」とのユーザー指摘を受け、視認性を最優先に
// 太字化する(Regular=400・SemiBold=600 より更に太い)。tiny-sdf は canvas の font 文字列にこの値を渡し、
// napi-rs/canvas(skia) が可変フォントの wght 軸を選択する。
const FONT_WEIGHT = process.env.GLYPH_WEIGHT ?? '700'

// フォント指定。GLYPH_FONT にファイルパスが与えられれば登録して使う。既定は本リポジトリに同梱した
// Noto Sans JP(OFL・再配布可)の可変フォント。これにより `node scripts/build-glyphs.mjs` 一発で
// 開発機でも Linux CI でも同一の glyph を再生成できる（区域名の増減時に回し直す想定）。
const DEFAULT_FONT_FILE = path.join(ROOT, 'scripts', 'fonts', 'NotoSansJP-VF.ttf')
const FONT_FILE = process.env.GLYPH_FONT ?? (fs.existsSync(DEFAULT_FONT_FILE) ? DEFAULT_FONT_FILE : '')
let FONT_FAMILY = process.env.GLYPH_FAMILY ?? 'Noto Sans JP'
if (FONT_FILE) {
  const ok = GlobalFonts.registerFromPath(path.resolve(FONT_FILE))
  if (!ok) throw new Error(`failed to register font: ${FONT_FILE}`)
}
// glyphs URL のディレクトリ名 ＝ style の text-font 値。両者を一致させる必要がある。
const STACK = process.env.GLYPH_STACK ?? FONT_FAMILY
const OUT_DIR = path.join(ROOT, 'public', 'fonts', STACK)

// フォントスタック名の単一情報源(src/components/Map/gl/fontStack.ts の JP_FONT_STACK)と、これから
// 出力する STACK が一致することをビルド時に照合する。ずれると MapLibre は該当テキストを無音で描かなく
// なる(glyphs URL の {fontstack} と public/fonts/<stack>/ が食い違うサイレント障害)ため、ここで早期失敗
// させる。.mjs は .ts を import できないためソースを読んでリテラルを取り出して突き合わせる。
function readAppFontStack() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Map', 'gl', 'fontStack.ts'), 'utf8')
  const m = src.match(/JP_FONT_STACK\s*=\s*'([^']+)'/)
  if (!m) throw new Error('fontStack.ts から JP_FONT_STACK を読み取れなかった')
  return m[1]
}
const APP_FONT_STACK = readAppFontStack()
if (STACK !== APP_FONT_STACK) {
  throw new Error(
    `フォントスタック名の不一致: build-glyphs の STACK="${STACK}" ≠ アプリの JP_FONT_STACK="${APP_FONT_STACK}"。` +
      `public/fonts/<stack>/ と text-font がずれるとテキストが無音で消える。fontStack.ts と GLYPH_STACK/GLYPH_FAMILY を揃えること。`,
  )
}

/** ラベルに実際に使われる Unicode コードポイント集合を集める。 */
function collectCodepoints() {
  const cps = new Set()
  const add = (s) => {
    for (const ch of s) cps.add(ch.codePointAt(0))
  }
  // 地方 9。単一情報源 src/utils/regions.ts の REGIONS から名前を読む（リテラル再定義だと LabelsGL が
  // 使う REGIONS と非連動になり、地方区分変更時に新しい地方名だけ空白表示になる。.mjs は .ts を import
  // できないためソースを読んで name を取り出す）。
  const regionsSrc = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'regions.ts'), 'utf8')
  const regionNames = [...regionsSrc.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
  if (regionNames.length === 0) throw new Error('regions.ts から地方名を読み取れなかった')
  regionNames.forEach(add)
  // 震度ラベル（poc/label.ts の INTENSITY_LABELS と一致）
  ;['1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'].forEach(add)
  // 県 47（prefectures.json のキー）
  const prefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'prefectures.json'), 'utf8'))
  Object.keys(prefs).forEach(add)
  // 区域 192（subregions.json の name）
  const subs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'subregions.json'), 'utf8'))
  for (const s of subs) add(s.name)
  // ASCII 基本ラテン（数字・記号の保険）
  for (let c = 0x20; c < 0x7f; c++) cps.add(c)
  return cps
}

/** codepoint 集合を 256 ブロック単位に振り分ける。 */
function groupByBlock(cps) {
  const blocks = new Map() // block -> number[]
  for (const cp of cps) {
    const b = Math.floor(cp / 256)
    if (!blocks.has(b)) blocks.set(b, [])
    blocks.get(b).push(cp)
  }
  return blocks
}

/** 1 グリフを PBF へ書く（glyphs.proto の glyph メッセージ）。 */
function writeGlyph(g, pbf) {
  pbf.writeVarintField(1, g.id)
  if (g.bitmap && g.bitmap.length) pbf.writeBytesField(2, g.bitmap)
  pbf.writeVarintField(3, g.width)
  pbf.writeVarintField(4, g.height)
  pbf.writeSVarintField(5, g.left)
  pbf.writeSVarintField(6, g.top)
  pbf.writeVarintField(7, g.advance)
}

/** 1 fontstack を PBF へ書く（glyphs.proto の fontstack メッセージ）。 */
function writeStack(stack, pbf) {
  pbf.writeStringField(1, stack.name)
  pbf.writeStringField(2, stack.range)
  for (const g of stack.glyphs) pbf.writeMessage(3, writeGlyph, g)
}

/** glyphs（トップレベル・stacks は repeated fontstack= field 1）を書く。 */
function writeGlyphsProto(data, pbf) {
  pbf.writeMessage(1, writeStack, data)
}

function main() {
  const sdf = new TinySDF({
    fontSize: FONT_SIZE,
    buffer: BUFFER,
    radius: RADIUS,
    cutoff: CUTOFF,
    fontFamily: FONT_FAMILY,
    fontWeight: FONT_WEIGHT,
  })
  const cps = collectCodepoints()
  const blocks = groupByBlock(cps)
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const sortedBlocks = [...blocks.keys()].sort((a, b) => a - b)
  let totalGlyphs = 0
  for (const b of sortedBlocks) {
    const start = b * 256
    const end = start + 255
    const glyphs = []
    for (const cp of blocks.get(b).sort((a, c) => a - c)) {
      const d = sdf.draw(String.fromCodePoint(cp))
      glyphs.push({
        id: cp,
        bitmap: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength),
        width: d.glyphWidth,
        height: d.glyphHeight,
        left: d.glyphLeft,
        top: d.glyphTop,
        // advance は unsigned varint で書くため負値を渡すと桁あふれする。異常系フォントで
        // measureText().width が負を返しても安全側に倒す。
        advance: Math.max(0, Math.round(d.glyphAdvance)),
      })
    }
    const pbf = new PbfWriter()
    writeGlyphsProto({ name: STACK, range: `${start}-${end}`, glyphs }, pbf)
    fs.writeFileSync(path.join(OUT_DIR, `${start}-${end}.pbf`), pbf.finish())
    totalGlyphs += glyphs.length
  }
  console.log(
    `glyphs generated: stack="${STACK}" font="${FONT_FILE || FONT_FAMILY}" weight=${FONT_WEIGHT} ` +
      `codepoints=${cps.size} blocks=${sortedBlocks.length} glyphs=${totalGlyphs} -> public/fonts/${STACK}/`,
  )
}

main()
