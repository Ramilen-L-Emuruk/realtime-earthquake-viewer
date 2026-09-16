// 未読要素の仕分け。実装が実際に読んだ要素（動的計測）と、解説資料が定義する要素を
// 突き合わせ、種別ごとに未読を並べる。
//
// 静的解析（正規表現でアクセサ呼び出しを追う）は 4 巡の敵対的レビューで毎巡新しい
// 取りこぼしが出た。**JavaScript の書き方が増えるたびに穴が開く構造**だったので、
// 推論をやめて実測へ切り替えた（`src/services/dmdataCoverage.probe.test.ts`）。
//
// 「読んだ」の定義は **`textContent` を取ったか、`getAttribute` を呼んだか**。
// 走査（`localName` の比較）は読み取りに数えない。
//
// **実測にも盲点はある** —— サンプルに現れなかった要素は見えない。だから解説資料からの
// 数え上げと**和を取る**（乗り換えると、資料だけが見つけていた分が黙って落ちる。実績あり）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HANDLED } from './handled.mjs'
import {
  WORK, REPO, CACHE, DECIDED_PATHS,
  loadScopes, scanTelegrams, scanManual, occurrencesOf, decidedPathOf,
} from './coverage-core.mjs'
import { readArtifact, incompleteNotes, incompletenessBanner, reportIncompleteness } from '../lib/incompleteness.mjs'
import { absorbSampleCollectionMarks } from './collection-mark.mjs'
import { buildReadModel, readsElement, readsAttr } from './read-model.mjs'

// **`readArtifact` を通す。** 計測台が引き継いだ取りこぼし（実電文サンプルの収集が
// 途中で落ちた等）は、読んだ時点で自分の台帳へ入る。
const dyn = readArtifact(path.join(WORK, 'dynamic-coverage.json'), { source: '実装の計測' })
if (!dyn) {
  throw new Error(`dynamic-coverage.json を読めません（計測台を先に実行してください）: ${path.join(WORK, 'dynamic-coverage.json')}`)
}
// 資料との突き合わせは `telegram-cache/` のファイルを直接数えるので、収集の札もここで読む
absorbSampleCollectionMarks(CACHE)
const tele = scanTelegrams()
const manual = scanManual()
const modelOf = new Map([...loadScopes()].map(([t, parts]) => [t, buildReadModel(parts)]))

// ---- 自己診断 ----
//
// **この点検が黙って嘘をつく形を先に潰す。** 読み落としを見つけるための道具なので、
// 「何も検出しなかった」が「壊れていた」を意味しうる状態を残さない。
const selfCheck = []

// (1) 生データの新しさ。**計測は失敗すると書き出さない**（書き出しはループ完走後）ので、
// 前回成功したときのファイルが残る。ここで見分けないと、実装を変えたのに古い計測を
// そのまま使い「問題なし」と報告する。
{
  // **改行を揃えてからハッシュを取る。** 生バイトで取ると、作業ツリーの改行が LF と CRLF で
  // 入れ替わるだけで中身が同じでもハッシュが変わり、要らない再計測を促す。
  // **揃え方は計測台（`src/services/dmdataCoverage.probe.test.ts` の `parserSha`）と同じに
  // すること** —— 共有モジュールにできないのは、あちらが型検査の対象で `.mjs` を取り込めないため。
  const sha = crypto.createHash('sha256')
    .update(fs.readFileSync(`${REPO}/src/services/dmdataParser.ts`, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex').slice(0, 16)
  if (!dyn.__meta) {
    selfCheck.push('生データに計測の来歴が無い（来歴を焼く前の計測台で作られた）。計測をやり直すこと')
  } else if (dyn.__meta.parserSha !== sha) {
    selfCheck.push(`生データはパーサーが別の内容だったときの計測（${dyn.__meta.measuredAt}`
      + ` / 計測時 ${dyn.__meta.parserSha} ≠ いま ${sha}）。計測をやり直すこと`)
  }
}

// 属性の値・出現回数は**経路ごと**に数え、**種別は跨いで合算する**。
// 同じ経路なら構造上同じ位置なので合算してよく、種別ごとに切ると標本の薄さを属性の性質と
// 取り違える。**経路を跨いで合算してはいけない**理由は `coverage-core.mjs` の `scanTelegrams`。
const pathCount = new Map()   // 経路 -> その要素が現れた回数
const attrStat = new Map()    // `経路@属性名` -> { values:Set, count }
for (const [, bag] of tele) {
  for (const [, rec] of bag) for (const [full, pr] of rec.paths) {
    pathCount.set(full, (pathCount.get(full) ?? 0) + pr.count)
    for (const [an, ar] of pr.attrs) {
      const k = `${full}@${an}`
      const s = attrStat.get(k) ?? { values: new Set(), count: 0 }
      for (const v of ar.values) s.values.add(v)
      s.count += ar.count
      attrStat.set(k, s)
    }
  }
}

const out = []
const push = (...xs) => out.push(...xs)

let leafTotal = 0, leafRead = 0, leafUnread = 0, attrTotal = 0, attrUnread = 0
const rows = []          // { type, kind, path, name, why }
const staticFalseAlarm = []   // 静的が「未読」と言い、実測では読んでいた
const staticMissed = []       // 静的が「読んでいる」と言い、実測では読んでいなかった
const declaredRows = []       // 単位・型の宣言として作業対象から外したもの
const decidedRows = []        // 読まないと決めた／条件付きで読んでいるもの（§3）
const decidedHit = new Set()  // 実際に当たった `DECIDED_PATHS` の項目
const keyMiss = []            // 計測台の経路を電文の走査側で引けなかったもの

for (const type of Object.keys(HANDLED)) {
  const r = dyn[type]
  if (!r) continue
  const read = new Set(r.read)
  const readAttrs = new Set(r.readAttrs)
  const bag = tele.get(type)
  const model = modelOf.get(type)

  // 容器かどうかは電文の構造から決める（配下に別の経路があれば容器）
  const isContainer = p => r.all.some(q => q.startsWith(p + '/'))
  // 容器は自分の本文を持たないので「読んでいない」のは当たり前。**葉だけを数える。**
  for (const p of r.all) {
    if (isContainer(p)) continue
    leafTotal++
    const name = p.split('/').slice(-1)[0]
    const parent = p.split('/').slice(-2)[0]
    // **属性を読んでいればその要素は読んでいる。** `<Epicenter rank="4"/>` のように
    // 値が属性にしか無い要素は本文を持たず、本文だけで数えると必ず未読になる。
    const touched = read.has(p) || [...readAttrs].some(a => a.startsWith(p + '@'))
    if (touched) {
      leafRead++
      // 実測では読んでいる。静的が未読と言っていたら、静的の誤報
      const occ = occurrencesOf(bag, name).find(o => o.parent === parent)
      const v = readsElement(model, name, parent, occ?.ancestors ?? [], (bag.get(name)?.chains.size ?? 0) > 1)
      if (v === 'no' || v === 'other-parent') staticFalseAlarm.push(`${type} ${p}`)
      continue
    }
    // §3 で決めてあるものは作業対象から外す。**要素も属性も同じ登録簿を通す** ——
    // `Head/Headline/Information` のように配下ごと読まないと決めた枝は、要素も属性も
    // 同じ理由で外れる。**外した分は下で出力に並べる。**
    const decidedLeaf = decidedPathOf(p, type)
    if (decidedLeaf) { decidedHit.add(decidedLeaf); decidedRows.push({ type, path: p, ...decidedLeaf }); continue }
    // **祖先は実測の経路からそのまま取る。** 名前で電文の出現箇所を引き直すと、
    // 同じ名前・同じ直近の親が別の場所にもある電文（`Estimation/Item/MaxHeight` と
    // `Observation/Item/Station/MaxHeight`）で別の枝を掴む。経路は手元にある。
    const parts = p.split('/')
    const v = readsElement(model, name, parent, parts.slice(0, -2), (bag.get(name)?.chains.size ?? 0) > 1)
    // 静的に「コードはありそう」と出たものは、`ReportDateTime || DateTime` の後段や
    // 取消電文だけを通る分岐 —— **このサンプルでは通らなかっただけ**の可能性がある。
    //
    // **だが落とさない。** 篩に使う静的モデルは推論で、実在しないコードを「ある」と
    // 言うことがある（実際にレビューで 6 件確定した）。**落とす判断に壊れた道具を使うと、
    // 本物の漏れが黙って消える** —— この作業で 2 度やった失敗。印を付けて全部残す。
    if (v === 'yes') staticMissed.push(`${type} ${p}`)
    leafUnread++
    rows.push({
      type, kind: '要素', path: p, name,
      why: [...(bag.get(name)?.texts ?? [])].slice(0, 3).join(' / '),
      ja: manual.get(`${type}\t${name}`)?.ja ?? '',
      note: v === 'yes' ? '静的にはコードがありそう。このサンプルで通らなかっただけかは人が確認する' : '',
    })
  }

  for (const a of r.allAttrs) {
    attrTotal++
    if (readAttrs.has(a)) {
      const [p, an] = a.split('@')
      const el = p.split('/').slice(-1)[0]
      if (readsAttr(model, el, an, p.split('/')) === 'no') staticFalseAlarm.push(`${type} ${a}`)
      continue
    }
    const [p, an] = a.split('@')
    const el = p.split('/').slice(-1)[0]
    // §3 で決めてあるものは作業対象から外す。**外した分は下で出力に並べる。**
    const decided = decidedPathOf(a, type)
    if (decided) { decidedHit.add(decided); decidedRows.push({ type, path: a, ...decided }); continue }
    // **鍵が引けなかったことを「値が無い」と混ぜない。** `attrStat` は電文の走査側
    // （`scanTelegrams`）が組んだ経路で、引く側の `a` は計測台が組んだ経路。別々の実装なので
    // 将来ずれうる。ずれると値 0 種類として未読へ倒れる（安全側だが件数が爆発して点検が
    // 役に立たなくなる）ので、**ずれたこと自体を数える。**
    if (!attrStat.has(a)) keyMiss.push(`${type} ${a}`)
    if (!pathCount.has(p)) keyMiss.push(`${type} ${p}`)
    const st = attrStat.get(a) ?? { values: new Set(), count: 0 }
    const vs = [...st.values]
    const elCount = pathCount.get(p) ?? 0
    // 単位・型の宣言 ＝ **値が 1 種類**かつ**その経路に必ず付く**。
    //
    // **「必ず付く」を外さないこと。** 付かないことがある属性は、値が固定でも
    // **出現そのものが情報**を運ぶ（`jmx_eb:Magnitude@condition` は規模が不明のときだけ
    // 出る）。値の一様さだけで落とすと、それを「情報を持たない宣言」と誤る。
    //
    // **これでも標本の厚みの限界は残る。** 常に付いていて値も 1 種類だった属性は、
    // 資料が値を固定しているのか、**この標本で 1 種類しか出なかっただけ**なのかを
    // 実測では区別できない。だから落としたものを下に全部並べて、値と標本の厚みを添える。
    if (vs.length === 1 && st.count === elCount) {
      declaredRows.push({ type, path: a, value: vs[0], attrCount: st.count, elCount })
      continue
    }
    attrUnread++
    rows.push({
      type, kind: '属性', path: a, name: `${el}@${an}`,
      why: `値が ${vs.length} 種類: ${vs.slice(0, 6).join(' / ')}`
        + `（この属性 ${st.count} 回 / 要素 ${elCount} 回）`,
      ja: manual.get(`${type}\t${el}`)?.ja ?? '',
    })
  }
}

// 資料にしか現れないもの（サンプルに出なかった条件付きの要素）。**実測では原理的に見えない。**
const manualOnly = []
for (const [k, def] of manual) {
  const [type, name] = k.split('\t')
  if (!HANDLED[type]) continue
  if (tele.get(type)?.has(name)) continue          // 電文に現れたものは上で扱った
  // **名前がどこかで読まれているだけで落とさない。** 資料にしか現れない要素は場所の
  // 裏取りができないので、`readsElement` は親を問わない緩い判定になる。同じ名前が
  // 電文の別の場所で読まれていれば「読んでいる」と言ってしまう。印を付けて残す。
  const readSomewhere = readsElement(modelOf.get(type), name) !== 'no'
  manualOnly.push({ type, name, ja: def.ja, chapter: def.chapter, readSomewhere })
}

// (2) 経路の鍵がずれていないか。**この数が 0 でないなら下の数字は信用できない。**
if (keyMiss.length) {
  selfCheck.push(`計測台の経路を電文の走査側で引けなかった: ${keyMiss.length} 件`
    + `（例: ${[...new Set(keyMiss)].slice(0, 3).join(' / ')}）。`
    + `2 つの経路の組み立てがずれている（coverage-core.mjs の scanTelegrams と計測台の pathOf）`)
}

// (3) 効いていない `DECIDED_PATHS` の項目。**綴りを間違えても照合が当たらないだけ**で、
// エラーにも記録にもならない。「決めたつもりで効いていない」項目を見えるようにする。
// **0 件でないことは異常とは限らない** —— 標本にその形の電文が無いだけのこともある。
{
  const unused = DECIDED_PATHS.filter(d => !decidedHit.has(d))
  if (unused.length) {
    selfCheck.push(`この標本で一度も当たらなかった §3 の登録項目: ${unused.length} 件`
      + `（${unused.map(d => d.path ?? `*${d.contains}*`).join(' / ')}）。`
      + `経路の綴り違いか、標本にその形の電文が無いだけか、どちらかを確かめること`)
  }
}

// **入力の取りこぼしは自己診断より先に断る。** この点検の数字はどれも「全 N のうち未読 M」の
// 形で出るので、標本が欠けていることを先に言わないと、集められなかった種別が
// 「読む要素が無かった」と読める。自己診断（点検そのものの壊れ）とは別の話なので節も分ける。
const inputIncomplete = incompleteNotes()
if (inputIncomplete.length) {
  push('== 入力の取りこぼし ==')
  for (const line of incompletenessBanner('plain')) push(`  ${line}`)
  push('')
}

if (selfCheck.length) {
  push('== 自己診断（この点検そのものが壊れていないか）==')
  for (const s of selfCheck) push(`  ! ${s}`)
  push('')
  for (const s of selfCheck) console.error(`[triage] ${s}`)
}

push(`== 動的計測（実電文を本物のパーサーへ流して、値を取り出した要素・属性を記録）==`)
// **「読んでいる」と「決めてある」を足して引き算で出さない。** 混ぜると、読まないと決めた
// ものが「読んでいる」の数に紛れ、点検の進み具合を実際より良く見せる。
push(`葉の要素: 全 ${leafTotal} のうち 読んでいる ${leafRead} / 未読 ${leafUnread}`
  + ` / §3 で決めてある ${leafTotal - leafRead - leafUnread}`)
push(`属性: 未読 ${attrUnread}`)
push(`§3 で決めてあるもの ${decidedRows.length} 行（要素と属性の両方を含む）と、`
  + `単位・型の宣言 ${declaredRows.length} 行は作業対象から外した。どちらも下に並べてある`)
push(`資料にのみ現れる（サンプルに出ず、実測では見えない）: ${manualOnly.length}`)
push(`合計の作業対象: ${leafUnread + attrUnread + manualOnly.length}`)
push('')
push(`静的解析との食い違い —— 静的が「未読」と言ったが実測では読んでいた: ${staticFalseAlarm.length} 件`)
push(`                     静的が「読んでいる」と言ったが実測では読まなかった: ${staticMissed.length} 件`)
push(`  後者は**落とさず印を付けて残している**。静的モデルは推論で、実在しないコードを`)
push(`  「ある」と言うことがある（レビューで 6 件確定）。落とす判断に使えない。`)
push('')

push('==== 未読（種別ごと・実測） ====')
for (const type of Object.keys(HANDLED)) {
  const rs = rows.filter(r => r.type === type)
  if (!rs.length) continue
  push(`[${type}] ${rs.length} 件`)
  for (const r of rs) {
    push(`  ${r.kind}  ${r.path.padEnd(52)} ${r.ja}${r.why ? `  ← ${r.why}` : ''}`)
    if (r.note) push(`        ※ ${r.note}`)
  }
  push('')
}

push('==== 未読を名前でまとめたもの（作業の単位はこの数） ====')
{
  const by = new Map()
  for (const r of rows) {
    const key = r.kind === '属性' ? r.name : r.path.split('/').slice(-2).join('/')
    const g = by.get(key) ?? { types: new Set(), ja: '', why: '', kind: r.kind }
    g.types.add(r.type); if (!g.ja) g.ja = r.ja; if (!g.why) g.why = r.why
    by.set(key, g)
  }
  push(`名前の種類: ${by.size}`)
  for (const [k, g] of [...by].sort((a, b) => b[1].types.size - a[1].types.size)) {
    push(`  ${g.kind}  ${k.padEnd(40)} ${String(g.types.size).padStart(2)}種別  ${g.ja}`)
    push(`      種別: ${[...g.types].join(' ')}${g.why ? `\n      例: ${g.why}` : ''}`)
  }
  push('')
}

push('==== 資料にのみ現れるもの（実測では見えない。条件付きで出る要素） ====')
for (const m of manualOnly) {
  push(`  ${m.type} ${m.name.padEnd(24)} ${m.ja}${m.chapter === 'Ⅰ' ? '  [資料の共通部（Ⅰ章）由来。この種別に本当に現れるかは資料からは決まらない]' : ''}${m.readSomewhere ? '  [同じ名前を別の場所で読んでいる。ここの分かは人が確認する]' : ''}`)
}
push('')
push('==== 属性: 単位・型の宣言として作業対象から外したもの ====')
push('  値が 1 種類で、かつその経路に必ず付いていたもの。**落ちたことを見えるようにしてある** ——')
push('  「読まないと決めた」（上の §3 の節）と「読み落とした」を混ぜないため。')
push('  値が資料で固定されているかは、標本からは分からない。下の「厚み」を見て判断すること。')
{
  const by = new Map()
  for (const r of declaredRows) {
    const g = by.get(r.path) ?? { types: new Set(), value: r.value, attrCount: r.attrCount, elCount: r.elCount }
    g.types.add(r.type)
    by.set(r.path, g)
  }
  for (const [p, g] of [...by].sort()) {
    push(`  ${p}`)
    push(`      値: ${g.value}　厚み: この属性 ${g.attrCount} 回 / 要素 ${g.elCount} 回`
      + `　種別: ${[...g.types].join(' ')}`)
  }
}
push('')
push('==== §3 で決めてあるもの（読まないと決めた／条件付きで読んでいる）====')
push('  要素も属性も同じ登録簿（`coverage-core.mjs` の `DECIDED_PATHS`）を通している。')
{
  const by = new Map()
  for (const r of decidedRows) {
    const k = `${r.kind}\t${r.path}\t${r.why}`
    const g = by.get(k) ?? { types: new Set(), kind: r.kind, path: r.path, why: r.why, source: r.source }
    g.types.add(r.type)
    by.set(k, g)
  }
  for (const [, g] of [...by].sort()) {
    const label = g.kind === 'decided' ? '読まないと決めた' : '条件付きで読んでいる'
    push(`  [${label}] ${g.path}`)
    push(`      ${g.why}`)
    push(`      根拠: ${g.source}　種別: ${[...g.types].join(' ')}`)
  }
}
push('')
push('==== 静的が「未読」と言ったが、実測では読んでいたもの（静的の誤報） ====')
for (const s of staticFalseAlarm) push(`  ${s}`)
push('')
push('==== 静的が「読んでいる」と言ったが、実測では読んでいなかったもの（静的の見逃し） ====')
for (const s of staticMissed) push(`  ${s}`)

fs.writeFileSync(path.join(WORK, 'triage-result.txt'), out.join('\n'), 'utf8')
// 自己診断・入力の取りこぼしが出た分だけ切り出す行を増やす（既定の 8 行では要約が押し出される）
const extraHead = (selfCheck.length ? selfCheck.length + 3 : 0)
  + (inputIncomplete.length ? incompletenessBanner('plain').length + 2 : 0)
console.log(out.slice(0, 8 + extraHead).join('\n'))
if (reportIncompleteness('点検の入力') > 0) process.exitCode = 1
