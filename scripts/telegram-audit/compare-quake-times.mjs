// `fetch-quake-times.mjs` が抜き出した時刻を集計する。走査はやり直さない。
//
// 数えるもの
//   0. 想定外の形（「見ていない」を「無い」に潰さないための確認）
//   1. 訓練電文を除く
//   2. 電文単位のずれ
//   3. 地震（EventID）単位のずれ
//   4. ずれ方の偏り（規模・深さ・遠地かどうか）
//   5. 利用者の目に触れる形（地震情報と、津波／長周期が同じ地震に揃う場合）
//   6. 気象庁自身が利用者向けの文へ書く時刻はどちらか
//
// 使い方:
//   TELEGRAM_AUDIT_DIR=<作業ディレクトリ> node scripts/telegram-audit/compare-quake-times.mjs
//   （分類を変えるなら第 1 引数にファイル名の幹を渡す: `... compare-quake-times.mjs eew-forecast`）
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from './coverage-core.mjs'

const DATA = path.join(WORK, process.env.OUT_DIR || 'quake-times')
const file = process.argv[2] || 'telegram-earthquake'
const L = fs.readFileSync(path.join(DATA, `${file}.jsonl`), 'utf8')
  .trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
const meta = JSON.parse(fs.readFileSync(path.join(DATA, `${file}.meta.json`), 'utf8'))

const p = (n, d) => d ? `${n} 件（${(n / d * 100).toFixed(1)}%）` : `${n} 件`
const out = []
const say = (...a) => out.push(a.join(' '))
const count = (arr) => {
  const m = new Map()
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1)
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]))
}
// **気象庁の文は全角数字。** 半角で作った「0時13分」は全角の「０時１３分」に `includes` で
// 一致しない（正規化されない）。ここを落とすと §6 の照合が常に空振りする。
const toFullWidth = (s) => s.replace(/[0-9]/g, d => String.fromCharCode(d.charCodeAt(0) + 0xFEE0))

say(`# 地震の時刻（発生時刻 / 発現時刻）のずれ`)
say(`走査: ${meta.classification}  指定 ${meta.from} ~ ${meta.to}`)
const days = meta.dayList.map(d => d.day).sort()
say(`  実際に返った日: ${days[0]} ~ ${days[days.length - 1]}（${meta.days} 日）`)
say(`  XML ${meta.xmlTotal} 通 / 取得できなかった日 ${meta.failedDays.length}${meta.failedDays.length ? '（' + meta.failedDays.map(f => f.day).join(', ') + '）' : ''}`)

say('')
say('## 0. 想定外の形')
say(`  パース失敗 ${L.filter(r => r.parseFail).length} 通 / 抽出エラー ${L.filter(r => r.extractError).length} 通`)
say(`  Earthquake 要素が 2 つ以上ある電文: ${L.filter(r => r.eqs && r.eqs.length > 1).length} 通`)
say(`  同じ Earthquake に時刻が 2 つ以上: ${L.flatMap(r => (r.eqs ?? []).filter(e => e.originChild.length > 1 || e.arrivalChild.length > 1)).length} 件`)
say(`  運用種別（Control/Status）: ${JSON.stringify(count(L.map(r => r.status)))}`)
let docA = 0, eqA = 0
for (const r of L) { docA += r.docArrival ?? 0; eqA += (r.eqs ?? []).reduce((s, e) => s + e.arrivalChild.length, 0) }
say(`  ArrivalTime: 電文全体 ${docA} 個 / Earthquake 直下 ${eqA} 個`)
say(`    （差 ${docA - eqA} は区域の第 1 波到達時刻など。Earthquake の外にあるものを混ぜていない）`)
let docO = 0, eqO = 0
for (const r of L) { docO += r.docOrigin ?? 0; eqO += (r.eqs ?? []).reduce((s, e) => s + e.originChild.length, 0) }
say(`  OriginTime: 電文全体 ${docO} 個 / Earthquake 直下 ${eqO} 個（差 ${docO - eqO}）`)
let diffChildDesc = 0
for (const r of L) for (const e of r.eqs ?? []) {
  if ((e.arrivalChild[0] ?? '') !== (e.arrivalDesc[0] ?? '') || (e.originChild[0] ?? '') !== (e.originDesc[0] ?? '')) diffChildDesc++
}
say(`  実装の読み方の差（地震情報の子孫検索 / 津波の直下検索）が結果を変えた電文: ${diffChildDesc} 件`)
// **以降の集計は直下の値だけを使う。** 差が出たら、地震情報側（子孫検索）について
// 数字が実際の画面と食い違う可能性があるので、黙って進めない。
if (diffChildDesc > 0) {
  say('    ← 0 件でない。**以降の集計は直下の値だけを使っているので、地震情報側の数字は')
  say('      画面に出る値と食い違いうる。** 子孫側（originDesc / arrivalDesc）で数え直すこと')
  console.error(`警告: 読み方の差が ${diffChildDesc} 件あります。§2 以降の集計は補正していません`)
}

// 実装の座標読み取り（`parseJmaCoord`）と同じ正規表現。**3 つ目のグループが無ければ深さ不明。**
// `/` の直前の数値を採ると、深さを持たない遠地地震の座標（`-06.1+105.4/`）で経度を深さと誤る。
const COORD = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\//
// **`type` に「度分」を含むものを先に採る**（実装の `readHypocenterCoord` と同じ選び方）。
// VXSE61 はもう一方に丸め値を持っており、そちらを採ると深さが数 km ずれる。
// 深さの読み方自体は度分でも度単位でも同じ（第 3 グループはどちらもメートル）。
function depthKmOf(coords) {
  const list = Array.isArray(coords) ? coords : []
  const pick = list.find(c => String(c?.type ?? '').includes('度分')) ?? list[0]
  const m = String(pick?.text ?? '').match(COORD)
  return (!m || m[3] == null) ? null : Math.abs(parseFloat(m[3])) / 1000
}

const all = []
for (const r of L) {
  const e = r.eqs?.[0]
  if (!e) continue
  const o = e.originChild[0] ?? '', a = e.arrivalChild[0] ?? ''
  all.push({
    day: r.day, type: r.type, eventId: r.eventId, serial: r.serial, reportDateTime: r.reportDateTime ?? '',
    status: r.status, title: r.title ?? '', headline: r.headline ?? '', bodyText: r.bodyText ?? '',
    origin: o, arrival: a, hypo: e.hypo, magnitude: e.magnitude, depthKm: depthKmOf(e.coordinate),
    both: Boolean(o && a), same: Boolean(o && a) && o === a,
    diffMin: (o && a) ? Math.round((new Date(a) - new Date(o)) / 60000) : null,
  })
}
const drill = all.filter(r => r.status === '訓練')
const recs = all.filter(r => r.status !== '訓練')
say('')
say('## 1. 訓練電文を除く')
say(`  訓練電文 ${drill.length} 通（うち Earthquake を持つ ${drill.filter(r => r.both).length} 通）`)
say('  理由: 同じ EventID の訓練電文が種別ごとに別の時刻を名乗る')
say('  （2024-03-14 の訓練は VXSE53 が 12:05・VXSE62 が 12:13。実運用のずれではない）')
say(`  以降の数字はすべて訓練を除いたもの（対象 ${recs.length} 通）`)

say('')
say('## 2. 電文単位のずれ')
const both = recs.filter(r => r.both)
say(`  Earthquake を持つ電文 ${recs.length} 通 / うち両方の時刻を持つ ${p(both.length, recs.length)}`)
say(`  片方だけ: 発生のみ ${recs.filter(r => r.origin && !r.arrival).length} 通 / 発現のみ ${recs.filter(r => !r.origin && r.arrival).length} 通`)
const mismatch = both.filter(r => !r.same)
say(`  一致 ${p(both.length - mismatch.length, both.length)} / ずれる ${p(mismatch.length, both.length)}`)
say(`  ずれ幅（分）: ${JSON.stringify(count(mismatch.map(r => String(r.diffMin))))}`)
const big = new Map()
for (const r of mismatch) if (Math.abs(r.diffMin) >= 2) big.set(`${r.eventId}|${r.type}`, r)
say(`  ずれ幅 2 分以上（${big.size} 件・全件）:`)
for (const r of big.values()) say(`    ${r.eventId} ${r.type} ${r.diffMin}分 ${r.hypo} M${r.magnitude}${r.title === '遠地地震に関する情報' ? '（遠地）' : ''}`)
say('  種別ごと:')
for (const t of [...new Set(recs.map(r => r.type))].sort()) {
  const b = recs.filter(r => r.type === t && r.both)
  if (!b.length) continue
  say(`    ${t}: 両方あり ${b.length} 通 / ずれ ${p(b.filter(r => !r.same).length, b.length)}`)
}

const byEvent = new Map()
for (const r of recs) {
  if (!r.eventId) continue
  if (!byEvent.has(r.eventId)) byEvent.set(r.eventId, [])
  byEvent.get(r.eventId).push(r)
}
const evBoth = [], evMismatchSet = new Set(), evInconsistent = []
for (const [id, rs] of byEvent) {
  const b = rs.filter(r => r.both)
  if (!b.length) continue
  evBoth.push(id)
  if (b.some(r => !r.same)) evMismatchSet.add(id)
  if (b.some(r => !r.same) && b.some(r => r.same)) evInconsistent.push(id)
}
say('')
say('## 3. 地震（EventID）単位のずれ')
say(`  地震の数 ${byEvent.size} / 1 通でもずれる地震 ${p(evMismatchSet.size, evBoth.length)}`)
say(`  同じ地震の中でずれる報とずれない報が混在: ${p(evInconsistent.length, evBoth.length)}`)
say('    （続報で発生時刻そのものが更新されるため。震源要素更新 VXSE61 で起きる）')
for (const id of evInconsistent.slice(0, 6)) {
  say(`    ${id}: ${byEvent.get(id).filter(r => r.both).map(r => `${r.type}#${r.serial} 発生=${r.origin.slice(11, 16)} 発現=${r.arrival.slice(11, 16)}`).join(' / ')}`)
}

say('')
say('## 4. ずれ方の偏り（地震単位・その地震の 1 通でもずれるか）')
const evRec = (id) => byEvent.get(id).filter(r => r.both)[0]
const isFar = (id) => byEvent.get(id).some(r => r.title === '遠地地震に関する情報')
const bucketM = (m) => { const v = parseFloat(m); return isNaN(v) ? '規模不明' : v < 4 ? 'M4未満' : v < 5 ? 'M4台' : v < 6 ? 'M5台' : v < 7 ? 'M6台' : 'M7以上' }
const bucketD = (km) => km == null ? '深さ不明' : km < 30 ? '30km未満' : km < 80 ? '30-80km' : km < 200 ? '80-200km' : '200km以上'
const order = { 'M4未満': 1, 'M4台': 2, 'M5台': 3, 'M6台': 4, 'M7以上': 5, '規模不明': 9, '30km未満': 1, '30-80km': 2, '80-200km': 3, '200km以上': 4, '深さ不明': 9, '国内': 1, '遠地': 2 }
for (const [label, fn] of [
  ['規模', id => bucketM(evRec(id).magnitude)],
  ['深さ', id => bucketD(evRec(id).depthKm)],
  ['遠地地震か（Head/Title で判定）', id => isFar(id) ? '遠地' : '国内'],
]) {
  const tally = new Map()
  for (const id of evBoth) {
    const k = fn(id)
    if (!tally.has(k)) tally.set(k, { all: 0, mis: 0 })
    tally.get(k).all++
    if (evMismatchSet.has(id)) tally.get(k).mis++
  }
  say(`  ${label}: ${[...tally].sort((a, b) => (order[a[0]] ?? 8) - (order[b[0]] ?? 8)).map(([k, v]) => `${k} ${v.mis}/${v.all}(${(v.mis / v.all * 100).toFixed(0)}%)`).join('  /  ')}`)
}

// 画面に残る値の決め方は `mergeQuakeInto`（`src/utils/quakeMerge.ts`）に合わせる。
//   - 地震情報: VXSE61（震源要素更新）は `earthquake` の時刻を更新しないので除き、
//     発表時刻が最も早い報を採る（既存が実震度を持てば据え置かれるため）
//   - 相手側: 原因地震は続報で引き継がれないので、発表時刻が最も新しい報を採る
const isQuake = (t) => /^VXSE(51|52|53|61)$/.test(t)
const byReport = (a, b) => String(a.reportDateTime).localeCompare(String(b.reportDateTime))
function pairReport(label, pred, otherLabel) {
  let events = 0, mis = 0
  const samples = []
  for (const [id, rs] of byEvent) {
    const qAll = rs.filter(r => isQuake(r.type) && (r.arrival || r.origin))
    const qMerge = qAll.filter(r => r.type !== 'VXSE61').sort(byReport)
    const q = qMerge.length ? qMerge : qAll.slice().sort(byReport)
    const s = rs.filter(r => pred(r.type) && r.origin).sort(byReport)
    if (!q.length || !s.length) continue
    events++
    const qTime = q[0].arrival || q[0].origin
    const sTime = s[s.length - 1].origin
    if (qTime && sTime && qTime !== sTime) { mis++; samples.push({ id, hypo: q[0].hypo, m: q[0].magnitude, far: isFar(id), q: qTime, s: sTime }) }
  }
  say('')
  say(`## 5${label}. 地震情報と${otherLabel}が同じ地震に揃う場合`)
  say(`  揃った地震 ${events} 件 / 画面に出る時刻が食い違う ${p(mis, events)}`)
  for (const x of samples) {
    say(`    ${x.id}  ${x.hypo} M${x.m}${x.far ? '（遠地）' : ''}  地震情報=${x.q.slice(0, 16).replace('T', ' ')}  ${otherLabel}=${x.s.slice(0, 16).replace('T', ' ')}`)
  }
}
pairReport('a', t => /^VTSE/.test(t), '津波')
pairReport('b', t => t === 'VXSE62', '長周期')

say('')
say('## 6. 気象庁自身が利用者向けの文へ書く時刻はどちらか')
say('  解説資料は 2 つの要素を定義するだけで、**どちらを文へ書くかは述べていない**。')
say('  見出し文（Head/Headline/Text）と本文（Body/Text）に現れる時刻を、両者がずれた電文に')
say('  かぎって突き合わせる（一致する電文では、どちらを書いていても区別が付かない）。')
const hhmmForms = (iso) => {
  const m = iso.match(/T(\d{2}):(\d{2})/)
  if (!m) return []
  const half = `${Number(m[1])}時${Number(m[2])}分`
  const padded = `${m[1]}時${m[2]}分`
  return [...new Set([half, padded, toFullWidth(half), toFullWidth(padded)])]
}
const tally6 = { 発生のみ: 0, 発現のみ: 0, 両方: 0, どちらも無い: 0, 文が空: 0 }
const byType6 = new Map()
const samples6 = []
for (const r of mismatch) {
  const text = `${r.headline} ${r.bodyText}`
  if (!text.trim()) { tally6['文が空']++; continue }
  const hasO = hhmmForms(r.origin).some(f => text.includes(f))
  const hasA = hhmmForms(r.arrival).some(f => text.includes(f))
  const k = hasO && hasA ? '両方' : hasO ? '発生のみ' : hasA ? '発現のみ' : 'どちらも無い'
  tally6[k]++
  if (!byType6.has(r.type)) byType6.set(r.type, { 発生のみ: 0, 発現のみ: 0, 両方: 0, 'どちらも無い': 0 })
  byType6.get(r.type)[k]++
  if (samples6.length < 10 && (k === '発生のみ' || k === '発現のみ')) samples6.push({ ...r, verdict: k })
}
say(`  対象（ずれた電文）: ${mismatch.length} 通`)
say(`  ${JSON.stringify(tally6)}`)
// **検算。** 0 件なら照合そのものが壊れている（全角・半角の取り違えなど）。
// 実際に半角で当てていて 1,997 通すべてが「どちらも無い」へ落ちていたことがある。
const matched6 = tally6['発生のみ'] + tally6['発現のみ'] + tally6['両方']
say(`  検算: 時刻を本文から拾えた電文 ${matched6} 通${matched6 === 0 ? '  ← 0 件。照合が機能していない（要調査）' : ''}`)
say('  種別ごと:')
for (const [t, v] of [...byType6].sort()) say(`    ${t}: ${JSON.stringify(v)}`)
say('  例:')
for (const s of samples6) {
  say(`    [${s.verdict}] ${s.type} ${s.eventId}  発生=${s.origin.slice(11, 16)} 発現=${s.arrival.slice(11, 16)}`)
  if (s.headline) say(`        見出し: ${s.headline.replace(/\s+/g, ' ').slice(0, 110)}`)
  if (s.bodyText) say(`        本文  : ${s.bodyText.replace(/\s+/g, ' ').slice(0, 110)}`)
}

const text = out.join('\n')
console.log(text)
fs.writeFileSync(path.join(DATA, `report-${file}.txt`), text)
