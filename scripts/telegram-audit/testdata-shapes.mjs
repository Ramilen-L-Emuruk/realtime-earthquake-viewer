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
  IXAC41: 'estimatedIntensity',
}

const byKind = new Map()
const perType = new Map()
const sourceFiles = {}   // 種別 -> 採ったファイル名（公式サンプル由来を後で見分けるため）
const failed = []
let parsed = 0

// ---- 1. 実電文（XML） ----
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

// ---- 2. 推計震度分布図（IXAC41・BUFR） ----
// **このアプリで唯一の二進電文。** XML の経路に載らないので別に扱う。分割配信されるため、
// 同じ発表時刻の断片を本物の結合器へ順に入れてから復号する。
{
  const byTime = new Map()
  for (const f of all.filter(f => /^IXAC41_.*\.bin$/i.test(f))) {
    const m = /^IXAC41_RJTD_(RR[A-X]_)?(\d{17})_/.exec(f)
    if (!m) { failed.push(`${f}: ファイル名を読めません`); continue }
    const t = m[2].slice(0, 12)
    if (!byTime.has(t)) byTime.set(t, [])
    byTime.get(t).push({ f, designation: m[1] ? m[1].slice(0, 3) : null })
  }
  const store = new M.BufrFragmentStore()
  for (const [t, parts] of byTime) {
    let joined = null
    for (const p of parts.sort((a, b) => a.f.localeCompare(b.f))) {
      joined = store.add(M.fragmentKey('IXAC41', 'RJTD', t), p.designation, new Uint8Array(fs.readFileSync(path.join(CACHE, p.f))), Date.now())
    }
    if (!joined) { failed.push(`IXAC41 ${t}: 断片が揃いませんでした`); continue }
    let obj = null
    try { obj = M.decodeEstimatedIntensity(joined, `audit-${t}`, `${t}`) }
    catch (e) { failed.push(`IXAC41 ${t}: ${e.message}`); continue }
    if (!obj) { failed.push(`IXAC41 ${t}: null`); continue }
    parsed++
    ;(sourceFiles.IXAC41 ??= []).push(parts.map(p => p.f).join('+'))
    if (!perType.has('dmdata:IXAC41')) perType.set('dmdata:IXAC41', new Map())
    walk(obj, '', perType.get('dmdata:IXAC41'))
    if (!byKind.has('dmdata:estimatedIntensity')) byKind.set('dmdata:estimatedIntensity', new Map())
    walk(obj, '', byKind.get('dmdata:estimatedIntensity'))
  }
}

// ---- 3. 実 P2PQuake データ ----
const histPath = path.join(WORK, 'p2p-history.json')
const p2pCounts = {}
if (fs.existsSync(histPath)) {
  for (const [code, items] of Object.entries(JSON.parse(fs.readFileSync(histPath, 'utf8')))) {
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
} else {
  failed.push(`p2p-history.json がありません（fetch-p2p-history.mjs を先に実行）: ${histPath}`)
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

result.meta = { xmlFiles: xmlFiles.length, parsed, p2pCounts, failed, cache: CACHE, sourceFiles }
result.byKind = Object.fromEntries([...byKind].sort().map(([k, v]) => [k, dump(v)]))
result.perType = Object.fromEntries([...perType].sort().map(([k, v]) => [k, dump(v)]))
result.testData = td
fs.writeFileSync(path.join(WORK, 'testdata-shapes.json'), JSON.stringify(result, null, 1))
console.log(JSON.stringify({
  ...result.meta,
  sourceFiles: Object.fromEntries(Object.entries(sourceFiles).map(([k, v]) => [k, v.length])),
}, null, 1))
