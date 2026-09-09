// 突き合わせの中核。**判定を 1 箇所へ寄せる**（handled.mjs と同じ理由。同じ判定を複数の
// スクリプトが持つと、片方だけ直したときに数字が食い違い、どちらが正しいか分からなくなる）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HANDLED, assertRoots } from './handled.mjs'

// リポジトリの根は自身の位置から導く。ワークツリーへ持っていっても、そのワークツリーの
// 実装を読む（絶対パスを書くと、別の作業場の古い実装を測ってしまう）。
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// **実電文のサンプルと解説資料はリポジトリに入っていない。** 前者は配信元の利用規約、
// 後者は資料の再配布にあたるため。置き場所は環境変数で渡す
// （中身と揃え方は docs/spec/telegram-coverage-audit.md §2）。
export const WORK = process.env.TELEGRAM_AUDIT_DIR
if (!WORK) {
  throw new Error(
    'TELEGRAM_AUDIT_DIR に作業ディレクトリを渡してください。'
    + '中には eq_manual.txt（解説資料のテキスト）と dynamic-coverage.json（計測結果）を置き、'
    + '実電文は同ディレクトリの telegram-cache/ か TELEGRAM_CACHE で指す'
  )
}
export const CACHE = process.env.TELEGRAM_CACHE || path.join(WORK, 'telegram-cache')

// ---- 実装側: 関数ごとに本体を切り出し、呼び出し関係で閉包を取る ----
export function loadScopes() {
  const parserSrc = fs.readFileSync(`${REPO}/src/services/dmdataParser.ts`, 'utf8')
  const fnBodies = new Map()
  const re = /(?:^|\n)(?:export )?(?:async )?function\s+([A-Za-z0-9_]+)/g
  const starts = []
  let m
  while ((m = re.exec(parserSrc))) starts.push({ name: m[1], at: m.index })
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : parserSrc.length
    fnBodies.set(s.name, parserSrc.slice(s.at, end))
  })
  assertRoots(fnBodies)
  const closure = roots => {
    const seen = new Set(); const stack = [...roots]
    while (stack.length) {
      const n = stack.pop()
      if (seen.has(n) || !fnBodies.has(n)) continue
      seen.add(n)
      for (const c of fnBodies.keys()) {
        if (c !== n && !seen.has(c) && fnBodies.get(n).includes(c + '(')) stack.push(c)
      }
    }
    return [...seen].map(n => fnBodies.get(n))
  }
  return new Map(Object.entries(HANDLED).map(([t, r]) => [t, closure(r)]))
}

/** 前版の緩い判定と比べるために、閉包を 1 本の文字列でも返す */
export function loadScopeSources() {
  return new Map([...loadScopes()].map(([t, parts]) => [t, parts.join('\n')]))
}

// ---- 「実装が読んでいるか」の判定 ----
//
// **属性は近さまで見る。** 要素名と属性名が別々にどこかへ出ていればよい、という判定だと
// `Magnitude@type` は `'Magnitude'` と、無関係な場所の `'type'` の同居だけで「読んでいる」に
// なる。実際には `el.getAttribute('type')` の `el` が Magnitude 由来かどうかが問題なので、
// **同じ処理のかたまりの中に両方があること**を求める。文字数での近接はその代理。
export const PROXIMITY = 400

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function offsetsOf(src, token) {
  const re = new RegExp(`['"\`]${escapeRe(token)}['"\`]`, 'g')
  const out = []
  let m
  while ((m = re.exec(src))) out.push(m.index)
  return out
}

function lineAt(src, at) {
  const s = src.lastIndexOf('\n', at) + 1
  const e = src.indexOf('\n', at)
  return src.slice(s, e < 0 ? src.length : e).trim()
}

/** @returns {{read:boolean, evidence?:string, looseOnly?:boolean}} */
export function judge(src, name, proximity = PROXIMITY) {
  if (!name.includes('@')) {
    const o = offsetsOf(src, name)
    return o.length ? { read: true, evidence: lineAt(src, o[0]) } : { read: false }
  }
  const [el, at] = name.split('@')
  const eo = offsetsOf(src, el)
  const ao = offsetsOf(src, at)
  if (!eo.length || !ao.length) return { read: false }
  let best = Infinity; let bestAt = -1
  for (const a of ao) for (const e of eo) {
    const d = Math.abs(a - e)
    if (d < best) { best = d; bestAt = Math.min(a, e) }
  }
  if (best <= proximity) return { read: true, evidence: lineAt(src, bestAt) }
  // 要素名も属性名も出てくるが離れている ＝ 緩い判定だけが「読んでいる」と言う
  return { read: false, looseOnly: true }
}

export function isRead(src, name) { return judge(src, name).read }

// ---- 入力①: 実電文 ----
// rec = { count, withChildren, emptyText, texts:Set, children:Set, parents:Set, attrs: Map<名前, {count, values:Set}> }
//
// **子と親は「直接の」ものだけを数える。** 内側のタグを全部拾うと子孫が全部「子」になり、
// `CodeDefine/Type` のような「親で意味が決まる名前」を判定できない（Type の親が
// CodeDefine・Tsunami・Body… と並び、どれが本当の親か分からなくなる）。
export function scanTelegrams() {
  const TOKEN = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^>]*?)?)(\/?)>/g
  const perType = new Map()
  for (const f of fs.readdirSync(CACHE)) {
    if (!f.endsWith('.xml')) continue
    const type = f.split('_')[0]
    if (!HANDLED[type]) continue
    const xml = fs.readFileSync(path.join(CACHE, f), 'utf8')
    if (!perType.has(type)) perType.set(type, new Map())
    const bag = perType.get(type)
    const stack = []
    let m
    TOKEN.lastIndex = 0
    while ((m = TOKEN.exec(xml))) {
      const name = m[2].replace(/^[\w]+:/, '')
      if (m[1] === '/') { stack.pop(); continue }
      const rec = bag.get(name) ?? {
        count: 0, withChildren: 0, emptyText: 0,
        texts: new Set(), children: new Set(), parents: new Set(),
        chains: new Set(), attrs: new Map(),
      }
      rec.count++
      const parent = stack[stack.length - 1]
      if (parent) { rec.parents.add(parent.name); parent.rec.children.add(name) }
      // **根からの経路をそのまま覚える。** 「親の集合」だけだと、同じ名前が別の枝にも
      // 現れたとき、無関係な枝の親まで祖先として混ざる（実例: `Comments/VarComment/Code`
      // の親 `VarComment` が `Pref/Code` の祖先として扱われ、別の枝の `xmlAll` を
      // 「この Code を読んでいる」と誤認した）。経路で持てば枝ごとに切り分けられる。
      rec.chains.add(stack.map(s => s.name).join('/'))
      for (const a of (m[3] ?? '').matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) {
        if (a[1] === 'xmlns' || a[1].startsWith('xmlns:')) continue
        const an = a[1].replace(/^[\w]+:/, '')
        const ar = rec.attrs.get(an) ?? { count: 0, values: new Set() }
        ar.count++
        if (ar.values.size < 12) ar.values.add(a[2])
        rec.attrs.set(an, ar)
      }
      bag.set(name, rec)
      if (m[4] === '/') { rec.emptyText++; continue }
      // 本文の有無は閉じタグまでの中身で見る（子要素の記録はスタック側が担う）
      const close = xml.indexOf(`</${m[2]}>`, m.index)
      if (close > 0) {
        const inner = xml.slice(m.index + m[0].length, close)
        if (/<[A-Za-z_]/.test(inner)) rec.withChildren++
        else if (inner.trim() === '') rec.emptyText++
        else if (rec.texts.size < 12) rec.texts.add(inner.trim().slice(0, 40))
      }
      stack.push({ name, rec })
    }
  }
  return perType
}

/**
 * `name` が電文のどこに現れたかを、**根からの経路ごと**に返す。
 *
 * **枝を合併しない。** 「親の名前が一致する経路の祖先をまとめる」ところまでは
 * 直したが、それでも**同じ親の名前が構造的に別の場所にある**場合（`Hypocenter/Area` と
 * `Intensity/Observation/Pref/Area`）に枝が混ざる。混ざると、無関係な枝から引いている
 * 呼び出しを「この要素を読んでいる」と誤認する —— 1 巡目・2 巡目の CRITICAL がどちらも
 * この形だった。**経路のまま渡して、経路ごとに判定する。**
 *
 * @returns [{ chain, parent, ancestors }]
 */
export function occurrencesOf(bag, name) {
  const out = []
  for (const ch of bag.get(name)?.chains ?? []) {
    const parts = ch.split('/').filter(Boolean)
    if (!parts.length) { out.push({ chain: '', parent: null, ancestors: [] }); continue }
    out.push({ chain: ch, parent: parts[parts.length - 1], ancestors: parts.slice(0, -1) })
  }
  return out.length ? out : [{ chain: '', parent: null, ancestors: [] }]
}

// ---- 入力②: 解説資料（章 → 種別） ----
export const CHAPTER_TYPE = {
  'Ⅱ.11': ['VTSE41'], 'Ⅱ.12': ['VTSE51'], 'Ⅱ.13': ['VTSE52'], 'Ⅱ.21': ['VXSE45'],
  'Ⅱ.31': ['VXSE51'], 'Ⅱ.32': ['VXSE52'], 'Ⅱ.33': ['VXSE53'], 'Ⅱ.36': ['VXSE61'],
  'Ⅱ.37': ['VXSE62'], 'Ⅱ.41': ['VYSE50', 'VYSE51', 'VYSE52'], 'Ⅱ.42': ['VYSE60'],
  // Ⅰ（管理部・ヘッダ部）は全種別に効く
  'Ⅰ': Object.keys(HANDLED),
}

/**
 * Ⅰ章の要素のうち、**この点検の対象種別（地震・津波の 13 種別）には現れないもの。**
 *
 * Ⅰ章は気象庁 XML 全体の共通部で、火山や気象の電文で使う要素も同じ章に載っている。
 * `CHAPTER_TYPE` は Ⅰ章を 13 種別すべてへ機械的に撒くため、そのままでは**構造上出現し得ない
 * 要素まで「未読」に数える**。数え上げの分母が膨らみ、本当に検討すべき要素が埋もれる。
 *
 * **除外してよいのは、資料が適用範囲を明示しているものだけ。** 出典（章・項番）を必ず添える
 * —— 根拠の無い除外は「読み落としを見えなくする」方向に働き、点検そのものを壊す。
 *
 * 値は「その要素が現れる種別」。空配列なら 13 種別のどれにも現れない。
 */
export const CHAPTER_I_SCOPE = {
  // 「噴火に関する火山観測報、噴火速報、推定噴煙流向報で用いる場合があり」（Ⅰ.（ⅱ）4）
  // → 火山の電文専用。地震・津波の 13 種別には現れない。
  TargetDTDubious: [],
  // 「津波警報・注意報・予報の電文及び降灰予報の電文において情報の失効時刻を記載する」
  // （Ⅰ.（ⅱ）5）→ 13 種別のうち VTSE41 だけ。**そこでは既に読んでいる。**
  ValidDateTime: ['VTSE41'],
}

/**
 * 見出し部（`Head/Headline/Information` 配下）に現れる要素の名前。
 *
 * **§3 で「読まないと決めた」場所。** 内容部（`Body`）の部分集合で、読むと同じ事実を
 * 二重に持つことになる（→ 手引き §3・`quake-spec.md` §8）。決めてあるのに集計が知らず、
 * 未読として数え続けていた。
 *
 * **同名の要素が内容部にもある**ことに注意（`Kind`・`Area`・`Name`・`Code`・`LastKind`・
 * `Condition` は内容部で読んでいる）。ここで落とすのは Ⅰ章由来の分だけで、
 * 内容部（Ⅱ章）由来の同名要素は落とさない —— 落とすと本物の未読が消える。
 */
export const HEADLINE_INFORMATION_ELEMENTS = new Set([
  'Information', 'Areas', 'Item', 'Kind', 'Area', 'Name', 'Code', 'LastKind', 'Condition',
])

/**
 * Ⅰ章（共通部）の要素 `name` が、この点検の対象種別のうちどれに現れるか。
 *
 * 既定は「13 種別すべて」。**絞るのは根拠があるものだけ**で、いまは 2 つ。
 *
 * 1. 資料が適用範囲を明示しているもの（`CHAPTER_I_SCOPE`）
 * 2. 見出し部の要素（`HEADLINE_INFORMATION_ELEMENTS`）—— §3 で読まないと決めた場所
 *
 * **`CHAPTER_I_SCOPE` を先に見る。** `ValidDateTime` のように「資料が範囲を明示していて、
 * かつ見出し部の名前とは無関係」なものを、名前の一致だけで消してしまわないため。
 */
function chapterIScopeOf(name) {
  // **空配列も「絞り込みの結果」。** `[]` は truthy なので、キーの有無で分岐しないと
  // 「その種別には現れない」と「表に載っていない」を書き分けられない。
  if (Object.prototype.hasOwnProperty.call(CHAPTER_I_SCOPE, name)) return CHAPTER_I_SCOPE[name] ?? []
  if (HEADLINE_INFORMATION_ELEMENTS.has(name)) return []
  return CHAPTER_TYPE['Ⅰ']
}

/**
 * ページの柱（`Ⅰ－1`・`Ⅱ.11－3`）。**行がどの章か**を決める唯一の手掛かり。
 * 資料の表記が変わったらここだけを直す（→ `chapterOfLines`）。
 */
export const PILLAR = /(Ⅰ|Ⅱ\.\d+)－\d+/

/**
 * 要素の定義（`Kind【種類】`）。**項番まで取る**（`2-1-3-3-3-2．Revise【…】`）。
 * 番号接頭辞は括弧を含みうる（`11-2(1)-1-1．Kind【…】`）。
 *
 * グループは 1=項番（省略されうる）・2=要素名・3=和名。
 */
export const DEF = /(?:^|\s)([\d\-()（）]+．)?([A-Za-z_][A-Za-z0-9_:]*)【([^】]*)】/g

/** 解説資料のテキストを行ごとに読む。 */
export function readManualLines() {
  return fs.readFileSync(path.join(WORK, 'eq_manual.txt'), 'utf8').split('\n')
}

/**
 * 行ごとの章を決める。**柱は本文の後ろに来る**ので、末尾から遡って割り当てる。
 *
 * **この規則を書き写さないこと。** かつて `where-defined.mjs` が同じロジックを持っており、
 * 片方だけ直せば 2 つの点検ツールの章の割り当てが無言で食い違う形になっていた
 *（→ 手引き §2「同じ判定を複数のスクリプトに持たせない」）。
 *
 * @returns 行番号 → 章（`Ⅰ` / `Ⅱ.33` 等。決まらない行は null）
 */
export function chapterOfLines(lines) {
  const chapterOf = new Array(lines.length).fill(null)
  let cur = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(PILLAR)
    if (m) cur = m[1]
    chapterOf[i] = cur
  }
  return chapterOf
}

/** @returns Map<`種別\t名前`, 和名> */
export function scanManual() {
  const lines = readManualLines()
  const chapterOf = chapterOfLines(lines)
  const out = new Map()
  lines.forEach((line, i) => {
    const ch = chapterOf[i]
    if (!ch || !CHAPTER_TYPE[ch]) return
    DEF.lastIndex = 0
    let m
    while ((m = DEF.exec(line))) {
      const name = m[2].replace(/^jmx_eb:/, '')
      // **Ⅰ章由来の分だけを絞り込む。** 内容部（Ⅱ章）由来の同名要素は落とさない ——
      // `Kind`・`Area`・`LastKind`・`Condition` などは内容部で実際に読んでおり、
      // 名前だけで落とすと本物の未読が消える。
      const types = ch === 'Ⅰ' ? chapterIScopeOf(name) : CHAPTER_TYPE[ch]
      for (const t of types) {
        const k = `${t}\t${name}`
        // **章も返す。** `Ⅰ`（共通部）の要素は 13 種別すべてへ機械的に撒かれるので、
        // その種別に本当に現れるかは資料からは決まらない。読み手が見分けられるようにする。
        // 和名は `DEF` の 3 番目のグループ（1=項番・2=要素名・3=和名）。
        if (!out.has(k) || (!out.get(k).ja && m[3])) out.set(k, { ja: m[3], chapter: ch })
      }
    }
  })
  return out
}

// XML の骨組み（データではない）
export const SKELETON = new Set(['Report', 'Control', 'Head', 'Body'])
