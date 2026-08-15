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
//   node scripts/build-glyphs.mjs                    # 既定: 同梱の M PLUS Rounded 1c ExtraBold
//   GLYPH_FONT=path/to/Other.ttf \                   # 別フォントを使う場合のみ上書き
//     GLYPH_FAMILY="Internal Family" GLYPH_STACK="Other Family" node scripts/build-glyphs.mjs
//
// 本番フォント: 再配布可能な M PLUS Rounded 1c ExtraBold(OFL) を scripts/fonts/ に同梱し、既定で登録する
// （システム Meiryo / UD デジタル教科書体は再配布不可のため不採用）。出力 public/fonts/M PLUS Rounded 1c/ を
// MapLibre が配信する。丸ゴシック＋ExtraBold を選んだのは、暗い地図上の小さな地名ラベル（13〜17px）で
// 輪郭が識別しやすく太さも稼げるため。perf 特性（事前生成で TinySDF スパイクを消す）はフォントに依らず不変。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PbfReader, PbfWriter } from 'pbf'

// 検証モード（--check）は native 依存（@napi-rs/canvas）を読み込まない。native addon は環境差で読み込みに
// 失敗しうるため、ビルドの前段に置く検証がその都合で巻き添えになることは避けたい。そこで native 依存は
// 動的 import にし、実際に焼くとき（main）だけ読み込む。
// ただし完全に生成物だけで閉じるわけではなく、フォント指紋の照合のため scripts/fonts/ のフォント実体は
// --check でも読む（後述の buildFingerprint）。
const CHECK_ONLY = process.argv.includes('--check')

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

// SDF パラメータ（MapLibre 既定・サーバーグリフと一致させる）。
const FONT_SIZE = 24
// 【変更禁止】MapLibre クライアントは glyph atlas 構築時にグリフ境界を 3px 固定で前提し、
// ビットマップ寸法を (width+2*3)×(height+2*3) として再計算する（GLYPH_PBF_BORDER=3 の公開規約）。
// ここを変えると PBF に書く width/height と実ビットマップ長の対応が崩れ、無音で描画が壊れる。
const BUFFER = 3
const RADIUS = 8
const CUTOFF = 0.25
// フォントウェイト。既定 800(ExtraBold)＝ダーク地図上で細い文字が「非常に見づらい」とのユーザー指摘を
// 受け、視認性を最優先に太字化する。tiny-sdf は canvas の font 文字列にこの値を渡し、napi-rs/canvas
// (skia) が登録済みフォントから該当ウェイトを選ぶ（同梱フォントは ExtraBold 単体＝800 のみを持つため、
// ここを変える場合は対応ウェイトの TTF を GLYPH_FONT で併せて差し替えること）。
const FONT_WEIGHT = process.env.GLYPH_WEIGHT ?? '800'

// フォント指定。GLYPH_FONT にファイルパスが与えられれば登録して使う。既定は本リポジトリに同梱した
// M PLUS Rounded 1c ExtraBold(OFL・再配布可)。これにより `node scripts/build-glyphs.mjs` 一発で
// 開発機でも Linux CI でも同一の glyph を再生成できる（区域名の増減時に回し直す想定）。
const DEFAULT_FONT_FILE = path.join(ROOT, 'scripts', 'fonts', 'MPLUSRounded1c-ExtraBold.ttf')
const FONT_FILE = process.env.GLYPH_FONT ?? (fs.existsSync(DEFAULT_FONT_FILE) ? DEFAULT_FONT_FILE : '')
// canvas に渡す「内部」ファミリ名。M PLUS Rounded 1c は配布名と TTF 内部の名前が一致せず、ExtraBold は
// "Rounded Mplus 1c" の weight 800 として登録される。ここに配布名を書くと skia がフォントを見つけられず、
// 例外を出さないまま別フォントで焼いてしまうため実測値を使う（GLYPH_FAMILY で上書き可）。
const FONT_FAMILY = process.env.GLYPH_FAMILY ?? 'Rounded Mplus 1c'

/**
 * グリフ生成に必要な native 依存を読み込み、フォントを登録して設定の整合を検証する。
 * 検証モード（--check）からは呼ばない（生成物を読むだけの処理を native の可用性に依存させないため）。
 * @returns TinySDF コンストラクタ
 */
async function setupFont() {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas')
  // tiny-sdf は document.createElement('canvas') を使うため Node 上でシムする。
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
      return createCanvas(1, 1)
    },
  }
  const familiesBefore = new Set(GlobalFonts.families.map((f) => f.family))
  if (FONT_FILE) {
    const ok = GlobalFonts.registerFromPath(path.resolve(FONT_FILE))
    if (!ok) throw new Error(`failed to register font: ${FONT_FILE}`)
  }
  // registerFromPath が成功しても、canvas に渡す FONT_FAMILY が TTF 内部の名前と食い違っていれば skia は
  // 例外を投げずシステム既定フォントで描いてしまう（実測で確認済み。配布名 "M PLUS Rounded 1c" を渡すと
  // 別形状のグリフが無言で生成された）。ビルドは "glyphs generated" と成功ログを出したまま全グリフが化ける
  // ため、登録結果と突き合わせてここで失敗させる。GLYPH_FONT 未指定時はシステム側の全ファミリを対象にする。
  const candidates = FONT_FILE ? GlobalFonts.families.filter((f) => !familiesBefore.has(f.family)) : GlobalFonts.families
  const matched = candidates.find((f) => f.family === FONT_FAMILY)
  if (!matched) {
    throw new Error(
      `フォントファミリ名の不一致: GLYPH_FAMILY="${FONT_FAMILY}" が見つからない。skia は例外を出さず別フォントで` +
        `焼くため停止する。${
          FONT_FILE
            ? `${path.basename(FONT_FILE)} が登録したファミリ: ${candidates.map((f) => f.family).join(' / ') || '(なし)'}`
            : 'GLYPH_FONT でフォントファイルを指定するか、GLYPH_FAMILY を実在するファミリ名にすること。'
        }`,
    )
  }
  // ウェイトも同様に無言で代替される（同梱フォントは静的な ExtraBold 単体なので、400 を渡しても 800 が
  // 返るだけで指定ミスに気付けない）。持っていないウェイトを要求していたら止める。
  if (!matched.styles.some((s) => String(s.weight) === FONT_WEIGHT)) {
    throw new Error(
      `フォントウェイトの不一致: GLYPH_WEIGHT=${FONT_WEIGHT} は "${FONT_FAMILY}" に存在しない` +
        `（利用可能: ${matched.styles.map((s) => s.weight).join(' / ')}）。skia が近いウェイトで無言に代替するため停止する。`,
    )
  }
  return (await import('@mapbox/tiny-sdf')).default
}
// glyphs URL のディレクトリ名 ＝ style の text-font 値。上の FONT_FAMILY（TTF 内部名）とは別物なので、
// アプリ側の JP_FONT_STACK と一致する配布名を既定に置く（下の照合で不一致ならビルドを失敗させる）。
const STACK = process.env.GLYPH_STACK ?? 'M PLUS Rounded 1c'
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

async function main() {
  const TinySDF = await setupFont()
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

  // OFL 1.1 第2条は、フォントソフトウェアの派生物を配布する各コピーに著作権表示とライセンス全文を
  // 添付することを求める。エンドユーザーへ実際に配信されるのは public/fonts/<stack>/ 配下の SDF 派生物
  // なので、ライセンス文を出力先にも複製する（scripts/fonts/ はビルド時ソースで配信対象外のため）。
  // GLYPH_FONT で別フォントに差し替えた場合は同梱ライセンスと対応しなくなるので複製しない。
  // 判定は path.resolve で正規化してから行う（GLYPH_FONT に相対パスやフォワードスラッシュで同じ
  // ファイルを指定されたとき、素の文字列比較では別物と見なされ複製が漏れるため）。
  const LICENSE_SRC = path.join(ROOT, 'scripts', 'fonts', 'OFL.txt')
  const usesBundledFont = FONT_FILE !== '' && path.resolve(FONT_FILE) === path.resolve(DEFAULT_FONT_FILE)
  if (usesBundledFont && fs.existsSync(LICENSE_SRC)) {
    fs.copyFileSync(LICENSE_SRC, path.join(OUT_DIR, 'OFL.txt'))
  }

  // 焼いた条件を残す（--check がこれと現在の設定を突き合わせ、フォント差し替え後の焼き直し忘れを検知する）。
  fs.writeFileSync(path.join(OUT_DIR, BUILD_INFO_FILE), `${JSON.stringify(buildFingerprint(), null, 2)}\n`)

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

// 半角スペースは字形を持たないため幅・高さ 0 で焼かれるのが正常（実測でも空になるのはこれだけ）。
// 下の「空グリフ」検査から除外する。
const SPACE_CODEPOINT = 0x20

// グリフを焼いた条件を残すファイル（出力先に置く）。MapLibre は <start>-<end>.pbf しか取りに行かないため、
// 同居させてもグリフ取得には影響しない。**生成物と一緒にコミットすること**（CI は --check しか実行せず、
// このファイルが無いと「焼いた条件を確認できない」で停止する）。
const BUILD_INFO_FILE = 'build-info.json'

/**
 * 焼いたときの条件（フォント実体・ファミリ・ウェイト・SDF パラメータ）の指紋。
 *
 * 収録文字が同じでも、フォントやウェイトを差し替えて焼き直しを忘れれば、字形だけが古いまま配信される。
 * 「どの文字が入っているか」を見る検査では捕まえられないため、生成時に指紋を残して --check で照合する。
 * フォントはファイル名が同じでも中身が変わりうるのでハッシュを取る。
 *
 * 注意: これにより --check は scripts/fonts/ のフォント実体にも依存する（生成物だけでは完結しない）。
 */
function buildFingerprint() {
  // GLYPH_FONT で明示指定された場合は存在チェックを経ていないため、ここで確認する。
  // これが無いと readFileSync の生の ENOENT になり、他の失敗系と違って何をすべきか分からない。
  if (FONT_FILE && !fs.existsSync(FONT_FILE)) {
    throw new Error(`フォントが見つからない: ${FONT_FILE}（GLYPH_FONT の指定を確認すること）。指紋の照合にはフォント実体が要る。`)
  }
  return {
    font: FONT_FILE ? path.basename(FONT_FILE) : '(system font)',
    fontSha256: FONT_FILE ? crypto.createHash('sha256').update(fs.readFileSync(FONT_FILE)).digest('hex') : '',
    family: FONT_FAMILY,
    weight: FONT_WEIGHT,
    sdf: { fontSize: FONT_SIZE, buffer: BUFFER, radius: RADIUS, cutoff: CUTOFF },
  }
}

/** 指紋を 1 行で読める形にする（食い違いをその場で見比べられるように）。 */
function describeFingerprint(f) {
  const sha = String(f?.fontSha256 ?? '').slice(0, 12) || '-'
  const sdf = f?.sdf ?? {}
  return `font=${f?.font} sha=${sha} family="${f?.family}" weight=${f?.weight} sdf=${sdf.fontSize}/${sdf.buffer}/${sdf.radius}/${sdf.cutoff}`
}

/**
 * 指紋の相違点を列挙する（JSON 文字列の比較だとキーの並び順を変えられただけで誤検知するため、
 * 値そのものを項目ごとに突き合わせる）。
 */
function diffFingerprints(recorded, current) {
  const differences = []
  for (const key of ['font', 'fontSha256', 'family', 'weight']) {
    if (String(recorded?.[key] ?? '') !== String(current[key])) differences.push(key)
  }
  for (const key of ['fontSize', 'buffer', 'radius', 'cutoff']) {
    if (Number(recorded?.sdf?.[key]) !== current.sdf[key]) differences.push(`sdf.${key}`)
  }
  return differences
}

/**
 * 生成済み PBF から収録グリフを読み出す（glyphs.proto: fontstack=1 / glyphs=3 / id=1・width=3・height=4）。
 * PbfReader.readFields はコールバックが読まなかったフィールドを自動でスキップするため、必要な階層だけ辿る。
 *
 * 幅・高さまで読むのは、id は書かれているのに中身が空というグリフを見分けるため。writeGlyph は id を
 * 常に書く一方でビットマップは空なら省くので、id の有無だけを見ると「収録済みだが画面では空白」を
 * 収録済みと誤判定する。
 */
function readGlyphs(buf) {
  const glyphs = []
  new PbfReader(buf).readFields((tag, _res, pbf) => {
    if (tag !== 1) return
    pbf.readMessage((stackTag, _r, stackPbf) => {
      if (stackTag !== 3) return
      const g = { id: -1, width: 0, height: 0 }
      stackPbf.readMessage((glyphTag, _r2, glyphPbf) => {
        if (glyphTag === 1) g.id = glyphPbf.readVarint()
        else if (glyphTag === 3) g.width = glyphPbf.readVarint()
        else if (glyphTag === 4) g.height = glyphPbf.readVarint()
      }, null)
      if (g.id >= 0) glyphs.push(g)
    }, null)
  }, null)
  return glyphs
}

/**
 * ラベルに必要な文字が、生成済みグリフに全て収録されているかを検証する（--check）。
 *
 * 地名（地方・県・区域）を増減したのに再生成を忘れると、その文字は MapLibre 側でエラーにならず
 * 静かに欠ける（既存の 256 文字ブロック内に落ちた場合は警告すら出ない）。型チェックもビルドも通って
 * しまうため、ビルドの前段でここを機械的に突き合わせる。実際に配信される PBF を読んで確認する。
 */
function check() {
  const required = collectCodepoints()
  if (!fs.existsSync(OUT_DIR)) {
    throw new Error(
      `グリフ未生成: public/fonts/${STACK}/ が存在しない。` +
        '`node scripts/build-glyphs.mjs` を実行すること' +
        '（別のフォントスタック名で生成した名残が残っているだけの場合は、その古いディレクトリを削除すること）。',
    )
  }
  const present = new Map()
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (!file.endsWith('.pbf')) continue
    for (const g of readGlyphs(fs.readFileSync(path.join(OUT_DIR, file)))) present.set(g.id, g)
  }
  const describe = (cps) => cps.map((cp) => `${String.fromCodePoint(cp)}(U+${cp.toString(16).toUpperCase()})`).join(' ')

  const missing = [...required].filter((cp) => !present.has(cp))
  if (missing.length > 0) {
    throw new Error(
      `グリフ未生成の文字が ${missing.length} 件ある: ${describe(missing)}\n` +
        '地名データを更新したら `node scripts/build-glyphs.mjs` で焼き直すこと' +
        '（このまま配信すると、ラベル上でその文字だけが無警告で空白になる）。',
    )
  }
  // 収録されていても中身が空（幅・高さが 0）なら、その文字は画面上で空白になる。フォント側に字形が
  // 無いまま焼いた場合に起こるため、収録の有無とは別に検査する。
  const blank = [...required].filter(
    (cp) => cp !== SPACE_CODEPOINT && present.get(cp).width === 0 && present.get(cp).height === 0,
  )
  if (blank.length > 0) {
    throw new Error(
      `字形が空のグリフが ${blank.length} 件ある: ${describe(blank)}\n` +
        '使用中のフォントに該当する字形が無い可能性がある' +
        '（収録はされているため取りこぼしには見えないが、ラベル上では空白で描かれる）。',
    )
  }
  // ここまでで「どの文字が入っているか」は保証できるが、フォント自体を差し替えて焼き直しを忘れた場合は
  // 収録も字形も揃ったまま形だけが古い。生成時に残した指紋と現在の設定を突き合わせて検知する。
  const infoPath = path.join(OUT_DIR, BUILD_INFO_FILE)
  if (!fs.existsSync(infoPath)) {
    throw new Error(
      `${BUILD_INFO_FILE} が無く、グリフを焼いた条件を確認できない（生成物と一緒にコミットし忘れた可能性）。` +
        '`node scripts/build-glyphs.mjs` で焼き直すこと。',
    )
  }
  let recorded
  try {
    // Windows のエディタ等で保存し直されると先頭に BOM が付き、JSON.parse はこれを受け付けない。
    // 内容としては壊れていないので取り除いてから読む。
    recorded = JSON.parse(fs.readFileSync(infoPath, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    // 壊れた JSON をそのまま投げると用途不明な SyntaxError になる。どのファイルをどうすべきか添える。
    throw new Error(`${infoPath} を読めない（内容が壊れている）。\`node scripts/build-glyphs.mjs\` で焼き直すこと。 — ${e.message}`)
  }
  const differences = diffFingerprints(recorded, buildFingerprint())
  if (differences.length > 0) {
    throw new Error(
      `グリフを焼いた条件が現在の設定と食い違う（収録文字は足りているが、字形が古いまま配信される）。\n` +
        `  相違点  : ${differences.join(', ')}\n` +
        `  焼いた時: ${describeFingerprint(recorded)}\n` +
        `  現在    : ${describeFingerprint(buildFingerprint())}\n` +
        '`node scripts/build-glyphs.mjs` で焼き直すこと。',
    )
  }

  // 余分は害がない（使われなくなった文字が残っているだけ）ので停止はしない。再生成の目安として報告する。
  const extra = [...present.keys()].filter((cp) => !required.has(cp))
  const extraNote = extra.length > 0 ? ` / 未使用の収録文字 ${extra.length} 件（再生成で除去できる）` : ''
  console.log(`glyphs check: ok — stack="${STACK}" 必要 ${required.size} 文字が全て収録済み${extraNote}`)
}

if (CHECK_ONLY) check()
else await main()
