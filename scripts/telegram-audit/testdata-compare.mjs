// テストデータと実データの「形」を突き合わせる（`testdata-shapes.mjs` の出力を読む）。
//
//   TELEGRAM_AUDIT_DIR=<作業ディレクトリ> node scripts/telegram-audit/testdata-compare.mjs
//
// 出す表は 5 つ。
//   A. standard 版のテストボタンが、P2PQuake 経路では作れない項目を持っていないか
//   B. DMDSS 版のテストデータが、実電文からは出てこない項目を持っていないか
//   C. 実電文が持つのに、どのテストデータにも無い項目（＝実機で一度も画面に出ない）
//   D. 同じ経路で値域が食い違う欄
//   E. 突き合わせできなかったもの（標本 0 件）――**「見つからなかった」と「見ていない」を分ける**
//
// A の「P2PQuake 経路で作れる項目」は 2 つの入力から作る。
//   ①実データを本物のパーサーへ通した実測
//   ②`p2pquake.ts` / `kyoshin.ts` のオブジェクトリテラルのキー（TypeScript の AST）。
//     **実データが 0 件の種別があるため、実測だけでは「見ていない」と「作れない」を
//     区別できない。** この 2 ファイルの parse 関数は固定のキーを持つリテラルを返すだけなので、
//     リテラルのキーの集合が「その経路が作れる項目」の上限そのものになる。
//
// **②は経路の全セグメントで見る。** リーフ名だけで照合すると、`estimations[].name` のように
// P2PQuake には配列ごと存在しない構造が、`name` が別の場所（`Hypocenter` 等）で使われている
// という理由だけで「作れる」と誤判定される（2026-09-10 の点検で津波 17 経路がこれで漏れていた）。
//
// **それでも②には偽陽性が残る。** 別々の関数のキー名がたまたま同じ並びを作れば通ってしまう。
// ②で救われた経路は「作れないとは言い切れない」であって「作れる」の証明ではない。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { REPO, WORK } from './coverage-core.mjs'

const ts = createRequire(path.join(REPO, 'package.json'))('typescript')
const S = JSON.parse(fs.readFileSync(path.join(WORK, 'testdata-shapes.json'), 'utf8'))

/** ファイル内のオブジェクトリテラルのキー名をすべて集める（作れる項目の上限） */
function literalKeys(file) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const keys = new Set()
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
      const name = n.name
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.add(name.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return keys
}
const p2pKeys = literalKeys(path.join(REPO, 'src/services/p2pquake.ts'))
const kyoshinKeys = literalKeys(path.join(REPO, 'src/services/kyoshin.ts'))

const segments = p => p.split('.').map(s => s.replace(/\[\]$/, ''))
const allSegmentsIn = (p, ...sets) => segments(p).every(s => sets.some(set => set.has(s)))
const paths = k => new Set(Object.keys(S.byKind[k] ?? {}))

const standardReachable = {
  quake: new Set([...paths('p2p:quake')]),
  tsunami: new Set([...paths('p2p:tsunami')]),
  eew: new Set([...paths('p2p:eew'), ...paths('yahoo:eew')]),
}

// standard 版で押せるテストボタン → 内部型
const STD = {
  'createTestEarthquake(standard)': 'quake',
  'createTestForeignQuake(standard)': 'quake',
  'createTestForeignQuakeHuge(standard)': 'quake',
  'createTestTsunami(standard)': 'tsunami',
  'createTestTsunamiWarning(standard)': 'tsunami',
  'createTestTsunamiWatch(standard)': 'tsunami',
  'createTestTsunamiForecast(standard)': 'tsunami',
  'createTestTsunamiRetraction(standard)': 'tsunami',
  'createTestEEW(standard,1)': 'eew',
  'createTestEEW(standard,2)': 'eew',
  'createTestEEWWarning(standard,1)': 'eew',
  'createTestEEWForecast(standard)': 'eew',
  'createTestEEWAssumed(standard,2)': 'eew',
  'createTestEEWDeep(standard)': 'eew',
}

// DMDSS 版のテストボタン → 実電文の内部型
const DM = {
  'createTestEarthquake(dmdss)': 'quake',
  'createTestEarthquake(訓練報)': 'quake',
  'createTestForeignQuake(dmdss)': 'quake',
  'createTestForeignQuakeHuge(dmdss)': 'quake',
  'createTestLpgm': 'lpgm',
  'createTestEEW(dmdss,1)': 'eew',
  'createTestEEW(dmdss,2)': 'eew',
  'createTestEEWWarning(dmdss,1)': 'eew',
  'createTestEEWWarning(dmdss,2)': 'eew',
  'createTestEEWForecast(dmdss)': 'eew',
  'createTestEEWAssumed(dmdss,1)': 'eew',
  'createTestEEWAssumed(dmdss,2)': 'eew',
  'createTestEEWDeep(dmdss)': 'eew',
  'createTestTsunami(dmdss)': 'tsunami',
  'createTestTsunamiGradeChange(dmdss)': 'tsunami',
  'createTestTsunamiWarning(dmdss)': 'tsunami',
  'createTestTsunamiWatch(dmdss)': 'tsunami',
  'createTestTsunamiForecast(dmdss)': 'tsunami',
  'createTestTsunamiRetraction(dmdss)': 'tsunami',
  'createTestNankai(調査中)': 'nankai',
  'createTestNankai(巨大地震注意)': 'nankai',
  'createTestNankai(巨大地震警戒)': 'nankai',
  'createTestNankaiRetraction': 'nankai',
  'createTestNankaiCommentary(臨時解説)': 'nankaiCommentary',
  'createTestNankaiCommentary(定例解説)': 'nankaiCommentary',
  'createTestKohatsu': 'kohatsu',
  'createTestQuakeNotice': 'quakeNotice',
  'createTestEarthquakeCount': 'earthquakeCount',
  'createTestEarthquakeCountRetraction': 'earthquakeCount',
  'createTestEstimatedIntensity.quake': 'quake',
  'createTestEstimatedIntensity.estimated': 'estimatedIntensity',
}

const out = []
const w = s => out.push(s)
const unchecked = []

w('# テストデータと実電文の突き合わせ\n')
w('生成: `testdata-shapes.mjs` → `testdata-shapes.json` → `testdata-compare.mjs`。')
w('**測っているのは内部型のオブジェクトの経路**で、ソースの文字列ではない。\n')

w('## 標本\n')
w('| 入力 | 件数 |')
w('|---|---|')
for (const [t, fs_] of Object.entries(S.meta.sourceFiles ?? {})) {
  const note = fs_.some(f => /jmasample/.test(f)) ? '（**気象庁公式サンプル電文**。実配信の観測実績が無い）' : ''
  w(`| DMDATA ${t} | ${fs_.length} ${note}|`)
}
for (const [code, n] of Object.entries(S.meta.p2pCounts)) w(`| P2PQuake code=${code} | ${n} |`)
w('')

w('\n## A. standard 版のテストボタンが持つ、P2PQuake 経路では作れない項目\n')
w('実測と `p2pquake.ts` / `kyoshin.ts` のリテラルのキー（**経路の全セグメント**で照合）の')
w('どちらにも無いものだけを挙げる。\n')
for (const [f, kind] of Object.entries(STD)) {
  const td = S.testData[f]
  if (!td) { w(`- **${f}**: 走らせられなかった`); continue }
  const bad = Object.keys(td).filter(p =>
    !standardReachable[kind].has(p) && !allSegmentsIn(p, p2pKeys, ...(kind === 'eew' ? [kyoshinKeys] : [])))
  if (bad.length) w(`\n**${f}** (${bad.length})\n` + bad.map(p => `  - \`${p}\` = ${JSON.stringify(td[p].values.slice(0, 3))}`).join('\n'))
}

w('\n\n## B. DMDSS 版のテストデータが持つ、実電文の標本には無い項目\n')
w('標本は種別ごとに独立事象 8 件前後。**無いことは「作り物」の証拠にならない**')
w('（条件付きで出る要素は 8 件に現れないことがある）。候補として挙げるだけ。\n')
for (const [f, kind] of Object.entries(DM)) {
  const td = S.testData[f]
  const real = paths(`dmdata:${kind}`)
  if (!td) continue
  if (real.size === 0) { unchecked.push([f, kind]); continue }
  const bad = Object.keys(td).filter(p => !real.has(p))
  if (bad.length) w(`\n**${f}** (${bad.length})\n` + bad.map(p => `  - \`${p}\` = ${JSON.stringify(td[p].values.slice(0, 3))}`).join('\n'))
}

w('\n\n## C. 実電文が持つのに、どのテストデータにも無い項目\n')
const kindToFactories = {}
for (const [f, kind] of Object.entries(DM)) (kindToFactories[kind] ??= []).push(f)
for (const [kind, fs_] of Object.entries(kindToFactories)) {
  const real = paths(`dmdata:${kind}`)
  if (real.size === 0) continue
  const have = new Set(fs_.flatMap(f => Object.keys(S.testData[f] ?? {})))
  const miss = [...real].filter(p => !have.has(p))
  if (miss.length) w(`\n**${kind}** (${miss.length})\n` + miss.map(p => `  - \`${p}\` = ${JSON.stringify(S.byKind[`dmdata:${kind}`][p].values.slice(0, 4))}`).join('\n'))
}

w('\n\n## D. 同じ経路で値域が食い違う欄（テストデータの値が実電文の標本に無い）\n')
w('**値の種類が少ない欄だけを見る**（座標・時刻のような連続値は毎回食い違うので意味が無い）。\n')
for (const [f, kind] of Object.entries(DM)) {
  const td = S.testData[f]
  const real = S.byKind[`dmdata:${kind}`]
  if (!td || !real) continue
  const rows = []
  for (const [p, e] of Object.entries(td)) {
    const r = real[p]
    if (!r || r.values.length > 12 || e.values.length > 12) continue
    const unseen = e.values.filter(v => !r.values.includes(v))
    if (unseen.length) rows.push(`  - \`${p}\`: テスト=${JSON.stringify(unseen)} / 実電文=${JSON.stringify(r.values)}`)
  }
  if (rows.length) w(`\n**${f}**\n` + rows.join('\n'))
}

w('\n\n## E. 突き合わせできなかったもの（実電文の標本 0 件）\n')
w('**「一致していた」ではなく「見ていない」。** B・C・D はこれらを黙って飛ばすので、ここへ明示する。\n')
if (unchecked.length === 0) w('無し（DM 表のすべての内部型に実電文の標本がある）。')
else for (const [f, kind] of unchecked) w(`- **${f}** … 内部型 \`${kind}\` の実電文標本が 0 件`)

fs.writeFileSync(path.join(WORK, 'testdata-report.md'), out.join('\n'))
console.log(out.join('\n'))
