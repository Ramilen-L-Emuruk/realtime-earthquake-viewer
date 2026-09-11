// 解説資料が同じ要素名を**どこで何回定義しているか**を列挙する。
//
// **`triage.mjs` の一覧は要素名でまとめる。** 同じ名前が 1 つの章の複数の階層で定義されて
// いても 1 行にしか見えないため、**片方だけ読んでいる状態が一覧からは分からない**。
// 実例: 震度の `Revise` は Ⅱ.33 の都道府県・地域・市町村の 3 箇所にあり、実装は
// 前 2 つだけを読んでいた（一覧には「VXSE53 Revise」の 1 行しか出ない）。
//
// **未読を仕分けるときは、名前ごとにここを通して定義の数を確かめること。**
// 「1 箇所だと思っていたら 3 箇所あった」は一覧の側からは見えない。
//
// 使い方:
//   node scripts/telegram-audit/where-defined.mjs            # 定義が 2 箇所以上ある要素を全部
//   node scripts/telegram-audit/where-defined.mjs Revise Source   # 名前を指定
//
// 置き場所の解決は `coverage-core.mjs` と共有する（`TELEGRAM_AUDIT_DIR`）。
// **章の割り当ても要素定義の正規表現も本体から借りる。** 書き写すと、資料の表記が変わった
// ときに片方だけ直して 2 つの点検ツールの出力が無言で食い違う（手引き §2「同じ判定を
// 複数のスクリプトに持たせない」）。
import { CHAPTER_TYPE, DEF, readManualLines, chapterOfLines } from './coverage-core.mjs'

const lines = readManualLines()
const chapterOf = chapterOfLines(lines)

/** @type {Map<string, {chapter: string, section: string, ja: string, line: number}[]>} */
const defs = new Map()
lines.forEach((line, i) => {
  const ch = chapterOf[i]
  if (!ch || !CHAPTER_TYPE[ch]) return
  DEF.lastIndex = 0
  let m
  while ((m = DEF.exec(line))) {
    const name = m[2].replace(/^jmx_eb:/, '')
    const list = defs.get(name) ?? []
    list.push({ chapter: ch, section: (m[1] ?? '').replace(/．$/, ''), ja: m[3], line: i + 1 })
    defs.set(name, list)
  }
})

const wanted = process.argv.slice(2)
const targets = wanted.length
  ? wanted
  // 既定は「畳まれうる」ものだけ。1 箇所しか定義が無い要素は一覧と食い違いようがない。
  : [...defs.keys()].filter(n => (defs.get(n) ?? []).length > 1).sort()

if (wanted.length) {
  const missing = wanted.filter(n => !defs.has(n))
  // **空振りを「定義が無い」と読ませない。** 全角・半角や綴りの違いで外れることがある
  // （手引き §5「検索が空振りしたことを『無い』の根拠にしない」）。
  if (missing.length) console.log(`※ 資料に定義が見つかりません（綴りを確かめること）: ${missing.join(' / ')}\n`)
}

for (const name of targets) {
  const list = defs.get(name)
  if (!list) continue
  // 種別は章から引く。同じ名前が別の種別に出るのは普通のことで、**問題になるのは
  // 同じ種別の中で階層が分かれている場合**なので、章ごとにまとめて見せる。
  const byChapter = new Map()
  for (const d of list) {
    const k = d.chapter
    if (!byChapter.has(k)) byChapter.set(k, [])
    byChapter.get(k).push(d)
  }
  const multi = [...byChapter.values()].some(ds => ds.length > 1)
  console.log(`${name}  （定義 ${list.length} 箇所 / ${byChapter.size} 章）${multi ? '  ★同じ章に複数の階層' : ''}`)
  for (const [ch, ds] of byChapter) {
    const types = (CHAPTER_TYPE[ch] ?? []).join(' ')
    for (const d of ds) {
      console.log(`    ${ch} ${d.section || '（項番なし）'}  ${d.ja}  [${types}]  ${d.line} 行目`)
    }
  }
  console.log('')
}

console.log(`対象 ${targets.length} 件（★ が付いたものは、同じ電文種別の中で階層が分かれている）`)
