// テストデータと実データの「形」を実測する。
//
// **静的解析はしない**（`docs/spec/telegram-coverage-audit.md` と同じ理由）。実電文・実 P2PQuake
// データを本物のパーサーへ通し、テストデータは本物のファクトリを呼び、**出来上がった内部型の
// オブジェクトを走査する**。ソースの文字列から推し量ると、条件分岐の中身も、パーサーが
// 落とした要素も見えない。
//
// 出力は `<作業ディレクトリ>/testdata-shapes.json`。突き合わせは `testdata-compare.mjs`。
//
//   TELEGRAM_AUDIT_DIR=<作業ディレクトリ> node scripts/telegram-audit/testdata-shapes.mjs
//
// 前提: `fetch-samples.mjs`（＋頻度の低い種別は `fetch-rare-samples.mjs`）で実電文を、
// `fetch-p2p-history.mjs` で P2PQuake の履歴を集めてあること。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { REPO, WORK, CACHE } from './coverage-core.mjs'
import { noteIncomplete, readArtifact, writeArtifact, reportIncompleteness } from '../lib/incompleteness.mjs'
import { absorbSampleCollectionMarks } from './collection-mark.mjs'

const req = createRequire(path.join(REPO, 'package.json'))
const esbuild = req('esbuild')
const { JSDOM } = req('jsdom')

const ENTRY = `
import {
  parseEEWFromXml, parseEarthquakeFromXml, parseTsunamiFromXml,
  parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml,
  parseQuakeNoticeFromXml, parseEarthquakeCountFromXml,
} from './services/dmdataParser'
import { convertEvent } from './services/p2pquake'
import { hypoInfoItemToEEW } from './services/kyoshin'
import { decodeEstimatedIntensity } from './utils/bufrEstimatedIntensity'
import { BufrFragmentStore, fragmentKey } from './services/bufrTelegramAssembly'
import * as TD from './utils/testData'
export const XML_PARSERS = {
  VTSE41: (h, x) => parseTsunamiFromXml(h, x),
  VTSE51: (h, x) => parseTsunamiFromXml(h, x),
  VTSE52: (h, x) => parseTsunamiFromXml(h, x),
  VXSE45: (h, x) => parseEEWFromXml(h, x),
  VXSE51: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE52: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE53: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE61: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE62: (h, x) => parseLpgmFromXml(x),
  VYSE50: (h, x) => parseNankaiFromXml(x),
  VYSE51: (h, x) => parseNankaiCommentaryFromXml(x),
  VYSE52: (h, x) => parseNankaiCommentaryFromXml(x),
  VYSE60: (h, x) => parseVyse60FromXml(x),
  VZSE40: (h, x) => parseQuakeNoticeFromXml(x),
  VXSE60: (h, x) => parseEarthquakeCountFromXml(x),
}
export { convertEvent, hypoInfoItemToEEW, decodeEstimatedIntensity, BufrFragmentStore, fragmentKey, TD }
`

// パーサーは DOMParser を使うので、先に jsdom を立てる
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const k of ['window', 'document', 'DOMParser', 'Node', 'Element', 'navigator', 'localStorage', 'XMLSerializer']) {
  try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }) }
  catch { /* 既に同等のものがある（navigator 等）ので触らない */ }
}

const bundlePath = path.join(WORK, 'testdata-shapes-bundle.mjs')
await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: path.join(REPO, 'src'), loader: 'ts', sourcefile: 'entry.ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: bundlePath,
  loader: { '.json': 'json' },
  define: {
    'import.meta.env.VITE_VARIANT': '"dmdss"', 'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true', '__APP_VERSION__': '"0.0.0"',
  },
  logLevel: 'warning',
})
const M = await import('file://' + bundlePath.replace(/\\/g, '/'))

// ---- 形の走査 ----
const MAX_VALUES = 40
function walk(o, prefix, out) {
  if (o === null || o === undefined) return
  // **型付き配列も配列として畳む。** `Array.isArray` は `Float32Array` に false を返すので、
  // 素直に書くと `lat.0`〜`lat.1699` のように添字ごとの経路が数千件生まれ、突き合わせの
  // 意味が消える（推計震度分布図のセル列がこれに当たる。1 ファクトリで 5,097 経路になった）。
  if (Array.isArray(o) || ArrayBuffer.isView(o)) {
    if (o instanceof DataView) { record(out, prefix, '<DataView>'); return }
    for (const v of o) walk(v, prefix + '[]', out)
    return
  }
  if (o instanceof Date) { record(out, prefix, '<Date>'); return }
  if (typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue   // undefined は経路として数えない
      walk(v, prefix ? `${prefix}.${k}` : k, out)
    }
    return
  }
  record(out, prefix, o)
}
function record(out, p, v) {
  let e = out.get(p)
  if (!e) { e = { count: 0, values: new Set() }; out.set(p, e) }
  e.count++
  if (e.values.size < MAX_VALUES) {
    const s = typeof v === 'string' ? v : String(v)
    e.values.add(s.length > 60 ? s.slice(0, 60) + '…' : s)
  }
}
const dump = m => Object.fromEntries([...m].sort().map(([k, v]) => [k, { count: v.count, values: [...v.values].sort() }]))

const result = {}
const TYPE_TO_KIND = {
  VTSE41: 'tsunami', VTSE51: 'tsunami', VTSE52: 'tsunami', VXSE45: 'eew',
  VXSE51: 'quake', VXSE52: 'quake', VXSE53: 'quake', VXSE61: 'quake',
  VXSE62: 'lpgm', VYSE50: 'nankai', VYSE51: 'nankaiCommentary', VYSE52: 'nankaiCommentary',
  VYSE60: 'kohatsu', VZSE40: 'quakeNotice', VXSE60: 'earthquakeCount',
  IXAC41: 'estimatedIntensity', IXAC40: 'estimatedIntensity',
}

const byKind = new Map()
const perType = new Map()
const sourceFiles = {}   // 種別 -> 採ったファイル名（公式サンプル由来を後で見分けるため）
const failed = []
let parsed = 0

// ---- 1. 実電文（XML） ----
// **収集の札を先に読む。** ここから下はディレクトリに並んだファイルを数えるだけなので、
// 収集が途中で失敗していても「その種別は 0 件」としか見えない（→ `collection-mark.mjs`）。
absorbSampleCollectionMarks(CACHE)
const all = fs.readdirSync(CACHE)
const xmlFiles = all.filter(f => /\.xml$/i.test(f))
for (const f of xmlFiles) {
  // 接頭辞（`big-` = 名指しで足した分）を外してから種別を採る。
  // **`headType` は電文の種別コード**（'VXSE51' 等）で、本文の `<Title>` ではない
  const type = f.replace(/^big-/, '').split('_')[0]
  const run = M.XML_PARSERS[type]
  if (!run) continue
  const xml = fs.readFileSync(path.join(CACHE, f), 'utf8')
  let obj = null
  try { obj = run(type, xml) } catch (e) { failed.push(`${f}: ${e.message}`); continue }
  if (!obj) { failed.push(`${f}: null`); continue }
  parsed++
  ;(sourceFiles[type] ??= []).push(f)
  const pt = `dmdata:${type}`
  if (!perType.has(pt)) perType.set(pt, new Map())
  walk(obj, '', perType.get(pt))
  const bk = `dmdata:${TYPE_TO_KIND[type]}`
  if (!byKind.has(bk)) byKind.set(bk, new Map())
  walk(obj, '', byKind.get(bk))
}

// ---- 2. 推計震度分布図（IXAC41・IXAC40・BUFR） ----
// **このアプリで唯一の二進電文。** XML の経路に載らないので別に扱う。分割配信されるため、
// 同じ発表時刻の断片を本物の結合器へ順に入れてから復号する。
//
// **2 種別を数える。** IXAC41（250m メッシュ）と IXAC40（1km メッシュ・2026-02-02 に配信終了）。
// 片方だけを走査すると、**アーカイブに実在するのに「1 通も無い」と読める** —— 走査先が対象を
// 含んでいない形の事故（CLAUDE.md「調査レビュー」の 2026-09-11）と同じ穴になる。
//
// **ファイル名の形が違う。** IXAC41 は分割されたときだけ符号が入る（`IXAC41_RJTD_RRA_…`）が、
// IXAC40 は常に入る（`IXAC40_RJTD_PAA_…`）。
{
  const byKey = new Map()
  for (const f of all.filter(f => /^IXAC4[01]_.*\.bin$/i.test(f))) {
    const m = /^(IXAC4[01])_RJTD_(?:(RR[A-X]|P[A-Z][A-Z])_)?(\d{17})_/.exec(f)
    if (!m) { failed.push(`${f}: ファイル名を読めません`); continue }
    const [, type, designation, stamp] = m
    const t = stamp.slice(0, 12)
    const key = `${type} ${t}`
    if (!byKey.has(key)) byKey.set(key, { type, t, parts: [] })
    byKey.get(key).parts.push({ f, designation: designation ?? null })
  }
  const store = new M.BufrFragmentStore()
  for (const [key, { type, t, parts }] of byKey) {
    let joined = null
    for (const p of parts.sort((a, b) => a.f.localeCompare(b.f))) {
      joined = store.add(M.fragmentKey(type, 'RJTD', t), p.designation, new Uint8Array(fs.readFileSync(path.join(CACHE, p.f))), Date.now())
    }
    if (!joined) { failed.push(`${key}: 断片が揃いませんでした`); continue }
    let obj = null
    // **第 4 引数（種別）を渡す。** 読み取りは記述子列に従うが、記録の接頭辞と
    // 「名乗りと中身の食い違い」の検出にこれを使う。渡さないと例外で落ちる。
    try { obj = M.decodeEstimatedIntensity(joined, `audit-${t}`, `${t}`, type) }
    catch (e) { failed.push(`${key}: ${e.message}`); continue }
    if (!obj) { failed.push(`${key}: null`); continue }
    parsed++
    ;(sourceFiles[type] ??= []).push(parts.map(p => p.f).join('+'))
    if (!perType.has(`dmdata:${type}`)) perType.set(`dmdata:${type}`, new Map())
    walk(obj, '', perType.get(`dmdata:${type}`))
    // **種別をまたいで 1 つの読み取り結果へ集める。** 同じ型（`JMAEstimatedIntensity`）へ
    // 読むので、要素の網羅性は種別で分けずに数える。
    if (!byKind.has('dmdata:estimatedIntensity')) byKind.set('dmdata:estimatedIntensity', new Map())
    walk(obj, '', byKind.get('dmdata:estimatedIntensity'))
  }
}

// ---- 3. 実 P2PQuake データ ----
const histPath = path.join(WORK, 'p2p-history.json')
const p2pCounts = {}
{
  // **`readArtifact` を通す。** 取得が不完全だったことは、読んだ時点で自分の台帳へ入り、
  // 下の `writeArtifact` で自動的に出ていく（引き継ぎのコードをここへ書かない）。
  // ファイルが無い・読めない場合も、それ自体が印として積まれる。
  const hist = readArtifact(histPath, { source: 'P2PQuake の履歴' })
  // **古い形（種別を直下に持つ）は読まない。** 読めてしまうと、取得が不完全だったことを伝える
  // 印が無いまま件数だけが通り、**0 件が「この種別は実配信に無い」の根拠に化ける**。
  if (hist && !hist.codes) {
    failed.push(`p2p-history.json が古い形です（fetch-p2p-history.mjs を再実行してください）: ${histPath}`)
  } else if (hist) {
    for (const [code, items] of Object.entries(hist.codes)) {
      p2pCounts[code] = items.length
      for (const it of items) {
        let ev = null
        try { ev = M.convertEvent(it) } catch (e) { failed.push(`p2p ${code}: ${e.message}`); continue }
        if (!ev) continue
        const bk = `p2p:${ev.kind}`
        if (!byKind.has(bk)) byKind.set(bk, new Map())
        walk(ev, '', byKind.get(bk))
      }
    }
  }
}

// ---- 4. Yahoo 強震モニタ由来の EEW ----
// `hypoInfoItemToEEW` は分岐の無い単一のオブジェクトリテラルなので、1 件流せば出る形が確定する
{
  const m = new Map()
  walk(M.hypoInfoItemToEEW({
    reportId: 'r1', reportNum: '2', reportTime: '2026-09-10T12:00:00+09:00',
    originTime: '2026-09-10T11:59:50+09:00', regionName: '日向灘',
    latitude: 'N32.0', longitude: 'E132.0', depth: '30km', magnitude: '6.5',
    calcintensity: '5+', isFinal: 'false', isCancel: 'false', isTraining: 'false',
  }), '', m)
  byKind.set('yahoo:eew', m)
}

// ---- 5. テストデータ ----
// **バリアント引数を持つものは両方**、続報で形が変わるものは serial 1 と 2 の両方を呼ぶ。
// 片方だけだと、バリアント差も遷移も測れない。
const factories = {
  'createTestEarthquake(dmdss)': () => M.TD.createTestEarthquake(true),
  'createTestEarthquake(standard)': () => M.TD.createTestEarthquake(false),
  'createTestEarthquake(訓練報)': () => M.TD.createTestEarthquake(true, '訓練'),
  'createTestForeignQuake(dmdss)': () => M.TD.createTestForeignQuake(true),
  'createTestForeignQuake(standard)': () => M.TD.createTestForeignQuake(false),
  'createTestForeignQuakeHuge(dmdss)': () => M.TD.createTestForeignQuakeHuge(true),
  'createTestForeignQuakeHuge(standard)': () => M.TD.createTestForeignQuakeHuge(false),
  'createTestLpgm': () => M.TD.createTestLpgm('20240101161000'),
  'createTestEEW(dmdss,1)': () => M.TD.createTestEEW(true, 'e', 1),
  'createTestEEW(dmdss,2)': () => M.TD.createTestEEW(true, 'e', 2),
  'createTestEEW(standard,1)': () => M.TD.createTestEEW(false, 'e', 1),
  'createTestEEW(standard,2)': () => M.TD.createTestEEW(false, 'e', 2),
  'createTestEEWWarning(dmdss,1)': () => M.TD.createTestEEWWarning(true, 'e', 1),
  'createTestEEWWarning(dmdss,2)': () => M.TD.createTestEEWWarning(true, 'e', 2),
  'createTestEEWWarning(standard,1)': () => M.TD.createTestEEWWarning(false, 'e', 1),
  'createTestEEWForecast(dmdss)': () => M.TD.createTestEEWForecast(true, 'e', 1),
  'createTestEEWForecast(standard)': () => M.TD.createTestEEWForecast(false, 'e', 1),
  'createTestEEWAssumed(dmdss,1)': () => M.TD.createTestEEWAssumed(true, 'e', 1),
  'createTestEEWAssumed(dmdss,2)': () => M.TD.createTestEEWAssumed(true, 'e', 2),
  'createTestEEWAssumed(standard,2)': () => M.TD.createTestEEWAssumed(false, 'e', 2),
  'createTestEEWDeep(dmdss)': () => M.TD.createTestEEWDeep(true, 'e', 1),
  'createTestEEWDeep(standard)': () => M.TD.createTestEEWDeep(false, 'e', 1),
  'createTestTsunami(dmdss)': () => M.TD.createTestTsunami(true),
  'createTestTsunami(standard)': () => M.TD.createTestTsunami(false),
  'createTestTsunamiGradeChange(dmdss)': () => M.TD.createTestTsunamiGradeChange(M.TD.createTestTsunami(true)),
  'createTestTsunamiWarning(dmdss)': () => M.TD.createTestTsunamiWarning(true),
  'createTestTsunamiWarning(standard)': () => M.TD.createTestTsunamiWarning(false),
  'createTestTsunamiWatch(dmdss)': () => M.TD.createTestTsunamiWatch(true),
  'createTestTsunamiWatch(standard)': () => M.TD.createTestTsunamiWatch(false),
  'createTestTsunamiForecast(dmdss)': () => M.TD.createTestTsunamiForecast(true),
  'createTestTsunamiForecast(standard)': () => M.TD.createTestTsunamiForecast(false),
  'createTestTsunamiRetraction(dmdss)': () => M.TD.createTestTsunamiRetraction(true),
  'createTestTsunamiRetraction(standard)': () => M.TD.createTestTsunamiRetraction(false),
  'createTestNankai(調査中)': () => M.TD.createTestNankai('調査中'),
  'createTestNankai(巨大地震注意)': () => M.TD.createTestNankai('巨大地震注意'),
  'createTestNankai(巨大地震警戒)': () => M.TD.createTestNankai('巨大地震警戒'),
  'createTestNankaiRetraction': () => M.TD.createTestNankaiRetraction(M.TD.createTestNankai('巨大地震注意')),
  'createTestNankaiCommentary(臨時解説)': () => M.TD.createTestNankaiCommentary('臨時解説'),
  'createTestNankaiCommentary(定例解説)': () => M.TD.createTestNankaiCommentary('定例解説'),
  'createTestKohatsu': () => M.TD.createTestKohatsu(),
  'createTestQuakeNotice': () => M.TD.createTestQuakeNotice(),
  'createTestEarthquakeCount': () => M.TD.createTestEarthquakeCount(),
  'createTestEarthquakeCountRetraction': () => M.TD.createTestEarthquakeCountRetraction(M.TD.createTestEarthquakeCount()),
  'createTestEstimatedIntensity.quake': () => M.TD.createTestEstimatedIntensity().quake,
  'createTestEstimatedIntensity.estimated': () => M.TD.createTestEstimatedIntensity().estimated,
}
const td = {}
for (const [name, fn] of Object.entries(factories)) {
  const m = new Map()
  try { walk(fn(), '', m) } catch (e) { failed.push(`${name}: ${e.message}`); continue }
  td[name] = dump(m)
}

// **自分が取りこぼした分も台帳へ積む。** `meta.failed` は構造のまま残す内訳で、台帳は
// 下流へ運ぶための印。ここで積まないと、`testdata-shapes.json` を単体で見たときに
// 「解析に失敗したものがある」ことが読み取れない。
for (const m of failed) noteIncomplete('テストデータの形の収集', m)

result.meta = { xmlFiles: xmlFiles.length, parsed, p2pCounts, failed, cache: CACHE, sourceFiles }
result.byKind = Object.fromEntries([...byKind].sort().map(([k, v]) => [k, dump(v)]))
result.perType = Object.fromEntries([...perType].sort().map(([k, v]) => [k, dump(v)]))
result.testData = td
writeArtifact(path.join(WORK, 'testdata-shapes.json'), result)
console.log(JSON.stringify({
  ...result.meta,
  sourceFiles: Object.fromEntries(Object.entries(sourceFiles).map(([k, v]) => [k, v.length])),
}, null, 1))
if (reportIncompleteness('テストデータの形の収集') > 0) process.exitCode = 1
