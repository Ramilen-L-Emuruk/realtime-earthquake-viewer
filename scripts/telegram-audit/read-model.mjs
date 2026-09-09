// 「実装がその要素・属性を読んでいるか」を、**呼び出しの構造**から判定する。
//
// 判定の履歴（同じ欠陥クラスで 2 度 CRITICAL を出している。読んでから触ること）:
//
//   第 1 版: 要素名の文字列がパーサーのどこかに出てくれば「読んでいる」
//     → `Headline` を読まないパーサーでも、無関係な `xmlChild(cancelBodyEl, 'Text')` が
//       あるだけで「Headline の子（Text）は全部読んでいる」と判定した。落としていたのは
//       南海トラフ臨時情報の呼びかけ文
//   第 2 版: アクセサ呼び出しの第 1 引数を**要素名**へ解決して親子を見る
//     → 名前が同じなら別の枝でも一致する。`Comments/VarComment/Code` を読む
//       `xmlAll(varCommentEl, 'Code')` が `Pref/Code` を読んでいることになり、
//       区域・市町村・観測点のコードが未読一覧から丸ごと消えた
//   第 3 版（いま）: 第 1 引数を**根からの経路**へ解決する
//     → `Hypocenter/Area` と `Pref/Area` を別物として扱える
//
// **共通する失敗は「名前で同一視したこと」。** 名前は場所を決めない。
//
// このパーサーは要素を `xmlQ` / `xmlChild` / `xmlAll` の第 2 引数か
// `getElementsByTagName` で引き、属性は `<変数>.getAttribute('名前')` で読む。

const ACCESSOR = 'xmlQ|xmlChild|xmlAll'
const UNKNOWN = '?'
const ROOT = 'DOC'

/** 経路を伸ばす。`DOC` → `DOC>Hypocenter` → `DOC>Hypocenter>Area` */
function extend(path, name) {
  return `${path || UNKNOWN}>${name}`
}

/** 子孫の平坦走査を表す末尾の `>*` を落とす */
function stripWildcard(path) {
  return path.endsWith('>*') ? path.slice(0, -2) : path
}

/** 経路から既知の区間（先頭の `DOC` / `?` を除いた要素名の並び）を取る */
function segmentsOf(path) {
  const parts = path.split('>')
  const head = parts[0]
  return { known: parts.slice(1), rooted: head === ROOT, unknown: head === UNKNOWN }
}

/**
 * 変数名 → その変数が指す**経路**（解決できなければ入れない）
 *
 * **空白を畳んでから当てる。** 行内に限ると、複数行にまたがるループ束縛
 * （`xmlAll(doc, 'Item')` の `.map(itemEl =>` が次の行にある形）を丸ごと取り逃がす。
 */
function bindVars(raw, seed = new Map()) {
  const src = raw.replace(/\s+/g, ' ')
  const varEl = new Map()
  const set = (v, path) => {
    const old = varEl.get(v)
    if (old === undefined || old === path) { varEl.set(v, path); return }
    // **「起点が後から判った」を衝突と数えない。** 経路は起点が先に解決されている
    // 必要があるため、1 周目では `?>Magnitude` のように前が不明なまま入る。2 周目で
    // `DOC>Earthquake>Magnitude` に精緻化されるのを衝突として潰すと、その変数が
    // 丸ごと不明へ落ちる（実際に規模の `description` の判定がこれで壊れた）。
    const tailOf = p => p.split('>').slice(-1)[0]
    if (tailOf(old) === tailOf(path)) {
      const better = old.startsWith(UNKNOWN + '>') ? path : old.length >= path.length ? old : path
      varEl.set(v, better)
      return
    }
    // 指す先そのものが違うなら「不明」へ倒す（安全側）
    varEl.set(v, UNKNOWN)
  }
  const pathOf = expr => {
    const id = (String(expr).match(/[A-Za-z_$][\w$]*/) ?? [])[0]
    if (!id) return UNKNOWN
    if (id === 'doc' || id === 'document') return ROOT
    return varEl.get(id) ?? seed.get(id) ?? UNKNOWN
  }

  // **隙間は次の宣言をまたがせない。** ただの `[^;]{0,200}?` だと、手前の
  // `const x = parseOperationStatus(doc)` が次の行の `xmlQ(doc, 'Head')` を
  // 自分の束縛として食べてしまい、本来の `const headEl` が束縛されないまま残る。
  // **テンプレートリテラルの中では `\b` は後退（U+0008）になる。** `\\b` と書くこと。
  const GAP = n => `(?:(?!\\bconst\\b|\\blet\\b)[^;]){0,${n}}?`

  // [正規表現, 変数の組番号, スコープの組番号, 要素名の組番号]
  const direct = [
    // const areaEl = xmlChild(hypoEl, 'Area') / cond ? xmlQ(x, 'Area') : null
    [new RegExp(`(?:const|let) ([A-Za-z_$][\\w$]*) =${GAP(200)}(?:${ACCESSOR})\\( *([^,)]*), *'([\\w:]+)' *\\)`, 'g'), 1, 2, 3],
    // xmlAll(prefEl, 'Area').map(areaEl => ...) / .forEach / .filter / .some
    [new RegExp(`(?:${ACCESSOR})\\( *([^,)]*), *'([\\w:]+)' *\\)${GAP(120)}\\.(?:map|forEach|filter|find|some|every|flatMap)\\( *\\(? *([A-Za-z_$][\\w$]*)`, 'g'), 3, 1, 2],
    // for (const areaEl of xmlAll(prefEl, 'Area'))
    [new RegExp(`for \\( *const ([A-Za-z_$][\\w$]*) of ${GAP(160)}(?:${ACCESSOR})\\( *([^,)]*), *'([\\w:]+)' *\\)`, 'g'), 1, 2, 3],
    // const stationEls = itemEl.getElementsByTagName('Station')
    [/(?:const|let) ([A-Za-z_$][\w$]*) = *([A-Za-z_$][\w$]*) *\??\. *getElementsByTagName\( *'([\w:]+)' *\)/g, 1, 2, 3],
  ]
  // 経路は「スコープが先に解決されていること」に依存するので、増えなくなるまで回す
  for (let pass = 0; pass < 4; pass++) {
    const before = JSON.stringify([...varEl])
    for (const [re, vi, si, ei] of direct) {
      re.lastIndex = 0
      for (let m; (m = re.exec(src));) set(m[vi], extend(pathOf(m[si]), m[ei]))
    }
    // `const descendants = prefEl.getElementsByTagName('*')` —— 子孫を平坦に走査する形。
    // 起点は分かるので `<起点>>*` として持ち、`localName` の振り分けで名前が決まる。
    for (const m of src.matchAll(/(?:const|let) ([A-Za-z_$][\w$]*) = *([A-Za-z_$][\w$]*) *\??\. *getElementsByTagName\( *'\*' *\)/g)) {
      set(m[1], extend(pathOf(m[2]), '*'))
    }
    for (const m of src.matchAll(/(?:const|let) ([A-Za-z_$][\w$]*) = *doc *\??\. *getElementsByTagName\( *'\*' *\)/g)) {
      set(m[1], extend(ROOT, '*'))
    }
    // `if (allEls[i].localName === 'Item') itemEls.push(…)` —— 振り分けた先を配列へ貯める形
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\[[^\]]*\]\.localName === '([\w:]+)'\)? *([A-Za-z_$][\w$]*)\.push\(/g)) {
      set(m[3], extend(stripWildcard(pathOf(m[1])), m[2]))
    }
    // 呼び出し側から渡された引数
    for (const [v, p] of seed) if (!varEl.has(v)) varEl.set(v, p)
    // 「変数 ← 別の変数（配列）」。**間接の推定で既存の束縛を壊さない**（不明が伝染する）
    const indirect = [
      [/for \( *const ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*) *\)/g, 1, 2],
      [/(?:const|let) ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*)\[/g, 1, 2],
      [/([A-Za-z_$][\w$]*) *\.(?:map|forEach|filter|find|some|every|flatMap)\( *\(? *([A-Za-z_$][\w$]*)/g, 2, 1],
    ]
    for (const [re, vi, si] of indirect) {
      re.lastIndex = 0
      for (let m; (m = re.exec(src));) {
        const from = varEl.get(m[si])
        if (from !== undefined && !varEl.has(m[vi])) varEl.set(m[vi], from)
      }
    }
    if (JSON.stringify([...varEl]) === before) break
  }
  return varEl
}

/**
 * `name(...)` の呼び出しを探して実引数の配列を返す。
 *
 * **正規表現の `\\(([^)]*)\\)` では切り出せない。** 最初の閉じ括弧で止まるため、
 * `intAttr(xmlChild(el, 'Epicenter'), 'rank')` が引数 1 つに見える。括弧を数える。
 */
function callSites(flat, name) {
  const out = []
  const head = new RegExp(`\\b${name}(?:<[^(]*>)? *\\(`, 'g')
  for (let m; (m = head.exec(flat));) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < flat.length && depth > 0; i++) {
      if (flat[i] === '(') depth++
      else if (flat[i] === ')') depth--
    }
    if (depth === 0) out.push(splitArgs(flat.slice(m.index + m[0].length, i - 1)))
  }
  return out
}

/** 実引数を上位のカンマだけで割る */
function splitArgs(s) {
  const out = ['']
  let depth = 0
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) { out.push(''); continue }
    out[out.length - 1] += ch
  }
  return out
}

/**
 * 「名前を引数で受け取って要素・属性を引く」呼び出し先を洗い出す。
 * 本体内で定義したアロー関数と、その関数自身の引数（`__self__`）の両方を返す。
 */
function nameTakers(flat, ownParams) {
  const out = []
  const arrows = new Map()
  for (const m of flat.matchAll(/(?:const|let) ([A-Za-z_$][\w$]*) = (?:<[^>]*> *)?\(?([^)=]*)\)? *(?::[^=]*)?=>/g)) {
    arrows.set(m[1], m[2].split(',').map(p => (p.trim().match(/^([A-Za-z_$][\w$]*)/) ?? [])[1]).filter(Boolean))
  }
  const add = (params, callee, ident, kind, scopeExpr) => {
    const index = params.indexOf(ident)
    if (index < 0) return
    out.push({ callee, index, kind, scopeExpr: (scopeExpr.match(/[A-Za-z_$][\w$]*/) ?? [])[0] ?? UNKNOWN })
  }
  for (const m of flat.matchAll(/(?:xmlQ|xmlAll|xmlChild)\( *([^,)]*), *([A-Za-z_$][\w$]*) *\)/g)) {
    for (const [name, params] of arrows) add(params, name, m[2], 'el', m[1])
    add(ownParams, '__self__', m[2], 'el', m[1])
  }
  for (const m of flat.matchAll(/([A-Za-z_$][\w$]*) *\??\. *getAttribute\( *([A-Za-z_$][\w$]*) *\)/g)) {
    for (const [name, params] of arrows) add(params, name, m[2], 'attr', m[1])
    add(ownParams, '__self__', m[2], 'attr', m[1])
  }
  return out
}

/**
 * @returns {{
 *   elements: Map<string, Set<string>>,   // 要素名 → `種類:経路`（種類は child / first / all / via）
 *   attrs: Map<string, Set<string>>,      // 属性名 → その属性を読んだ要素の経路
 *   unresolved: number,
 *   unresolvedNames: Set<string>,
 * }}
 *
 * **変数は関数ごとに束ねる。** 閉包を 1 本の文字列に繋いでから解決すると、別の関数の
 * 同名変数どうしが衝突して「不明」へ倒れる（`el` は関数が違えば別物）。
 */
export function buildReadModel(parts) {
  const bodies = Array.isArray(parts) ? parts : [parts]
  const elements = new Map()
  const attrs = new Map()
  let unresolved = 0
  const unresolvedNames = new Set()

  let varEl = new Map()
  const resolve = expr => {
    const id = (String(expr).match(/[A-Za-z_$][\w$]*/) ?? [])[0]
    if (!id) return UNKNOWN
    if (id === 'doc' || id === 'document') return ROOT
    const v = varEl.get(id)
    if (v === undefined) { unresolved++; unresolvedNames.add(id); return UNKNOWN }
    if (v === UNKNOWN) unresolvedNames.add(id + '（複数の場所を指していて特定できない）')
    return v
  }
  const put = (map, k, v) => {
    if (!map.has(k)) map.set(k, new Set())
    map.get(k).add(v)
  }

  // 関数名と引数名。**引数は呼び出し側からしか解決できない。**
  const sig = bodies.map(b => {
    const m = b.match(/function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/)
    if (!m) return null
    const params = m[2].split(',').map(p => (p.trim().match(/^([A-Za-z_$][\w$]*)/) ?? [])[1]).filter(Boolean)
    return { name: m[1], params }
  })
  const own = bodies.map(b => bindVars(b))
  const seedOf = new Map()   // 関数名 -> Map<引数名, 経路>
  bodies.forEach((b, i) => {
    const flat = b.replace(/\s+/g, ' ')
    for (const s of sig) {
      if (!s || !s.params.length) continue
      for (const args of callSites(flat, s.name)) {
        args.forEach((a, k) => {
          const p = s.params[k]
          if (!p) return
          const inner = a.match(/(?:xmlQ|xmlChild|xmlAll)\( *([^,)]*), *'([\w:]+)' *\)/)
          const id = (a.match(/[A-Za-z_$][\w$]*/) ?? [])[0]
          const path = inner
            ? extend(id === 'doc' ? ROOT : (own[i].get((inner[1].match(/[A-Za-z_$][\w$]*/) ?? [])[0]) ?? UNKNOWN), inner[2])
            : (id === 'doc' ? ROOT : own[i].get(id))
          if (path === undefined || path === UNKNOWN) return
          if (!seedOf.has(s.name)) seedOf.set(s.name, new Map())
          const cur = seedOf.get(s.name)
          if (cur.has(p) && cur.get(p) !== path) cur.set(p, UNKNOWN)
          else cur.set(p, path)
        })
      }
    }
  })

  // **`xmlQ` / `xmlAll` / `getElementsByTagName` は子孫探索、`xmlChild` だけが直下。**
  // `xmlQ` は最初の 1 件だけを返すので、全件を返す `xmlAll` とは分けて記録する。
  // **`localName` で振り分ける平坦走査を読む。**
  // 実装は `prefEl.getElementsByTagName('*')` で子孫を平坦に並べ、
  // `if (el.localName === 'Area') { … xmlChild(el, 'Name') … }` の形で振り分けている。
  // これを見ないと、確かに読んでいる市町村・区域・観測点を「未読」と誤報する。
  // 分岐の中では `el` はその要素を指すので、**その区間だけ束縛を差し替えて**読む。
  const scanBranches = (src, base) => {
    // 否定の門番（`if (el.localName !== 'IntensityStation') continue`）。
    // これ以降その変数はその要素を指す。ブロックの終わりを厳密に取らず、以降を対象にする
    // （その変数はループの外では使われないため、広く取っても他所へ波及しない）。
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\.localName !== '([\w:]+)'\)\s*continue/g)) {
      const scope = stripWildcard(base.get(m[1]) ?? UNKNOWN)
      put(elements, m[2], 'all:' + scope)
      const inner = new Map(base)
      inner.set(m[1], extend(scope, m[2]))
      scanAccessors(src.slice(m.index), inner)
    }
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\.localName === '([\w:]+)'/g)) {
      const scope = stripWildcard(base.get(m[1]) ?? UNKNOWN)
      // 振り分けそのものが「その要素を子孫から拾う」読み取りにあたる
      put(elements, m[2], 'all:' + scope)
      // 分岐の中身（`{` から対応する `}` まで）で、その変数をその要素として読む
      const open = src.indexOf('{', m.index)
      if (open < 0) continue
      let depth = 1
      let j = open + 1
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
      }
      if (depth !== 0) continue
      const inner = new Map(base)
      inner.set(m[1], extend(scope, m[2]))
      scanAccessors(src.slice(open, j), inner)
    }
  }
  const scanAccessors = (src, vars) => {
    const prev = varEl
    varEl = vars
    let m
    const first = /xmlQ\(\s*([^,)]*),\s*'([\w:]+)'\s*\)/g
    while ((m = first.exec(src))) put(elements, m[2], 'first:' + resolve(m[1]))
    const all = /xmlAll\(\s*([^,)]*),\s*'([\w:]+)'\s*\)/g
    while ((m = all.exec(src))) put(elements, m[2], 'all:' + resolve(m[1]))
    const child = /xmlChild\(\s*([^,)]*),\s*'([\w:]+)'\s*\)/g
    while ((m = child.exec(src))) put(elements, m[2], 'child:' + resolve(m[1]))
    const at = /([A-Za-z_$][\w$]*)\s*\??\.\s*getAttribute\(\s*'([\w:-]+)'\s*\)/g
    while ((m = at.exec(src))) put(attrs, m[2], resolve(m[1]))
    varEl = prev
  }

  bodies.forEach((src, i) => {
    varEl = bindVars(src, seedOf.get(sig[i]?.name) ?? new Map())
    scanBranches(src, varEl)
    let m
    const first = /xmlQ\(\s*([^,)]*),\s*'([\w:]+)'\s*\)/g
    while ((m = first.exec(src))) put(elements, m[2], 'first:' + resolve(m[1]))
    const all = /xmlAll\(\s*([^,)]*),\s*'([\w:]+)'\s*\)/g
    while ((m = all.exec(src))) put(elements, m[2], 'all:' + resolve(m[1]))
    const child = /xmlChild\(\s*([^,)]*),\s*'([\w:]+)'\s*\)/g
    while ((m = child.exec(src))) put(elements, m[2], 'child:' + resolve(m[1]))
    const byTag = /([A-Za-z_$][\w$]*)\s*\??\.\s*getElementsByTagName\(\s*'([\w:]+)'\s*\)/g
    while ((m = byTag.exec(src))) put(elements, m[2], 'all:' + resolve(m[1]))
    const at = /([A-Za-z_$][\w$]*)\s*\??\.\s*getAttribute\(\s*'([\w:-]+)'\s*\)/g
    while ((m = at.exec(src))) put(attrs, m[2], resolve(m[1]))

    // **要素名・属性名を引数で受け渡す書き方**（`pick('MaxIntChange')` → `xmlChild(el, name)`）。
    // アクセサ呼び出しの第 2 引数がリテラルでないため上の走査では見えない。放っておくと、
    // 実装済みの項目（EEW の予想変化など）を「未読」と誤報する。別の印を付けて拾う。
    const flat = src.replace(/\s+/g, ' ')
    for (const t of nameTakers(flat, sig[i]?.params ?? [])) {
      if (t.callee === '__self__') continue   // 呼び出し側で解決する（下記）
      for (const args of callSites(flat, t.callee)) {
        const lit = (args[t.index] ?? '').match(/^\s*'([\w:-]+)'\s*$/)
        if (!lit) continue
        const scope = t.scopeExpr === 'doc' ? ROOT : (varEl.get(t.scopeExpr) ?? UNKNOWN)
        if (t.kind === 'attr') put(attrs, lit[1], scope)
        else put(elements, lit[1], 'via:' + scope)
      }
    }
  })

  // **名前を自分の引数で受けるトップレベルの補助関数**（`function intAttr(el, name)`）。
  // 名前もスコープも呼び出し側にしか無いので、呼び出し側の実引数から両方を解決する。
  bodies.forEach((b, i) => {
    const s = sig[i]
    if (!s) return
    const selfTakers = nameTakers(b.replace(/\s+/g, ' '), s.params).filter(t => t.callee === '__self__')
    for (const t of selfTakers) {
      const scopeIndex = s.params.indexOf(t.scopeExpr)
      bodies.forEach((cb, ci) => {
        const cflat = cb.replace(/\s+/g, ' ')
        for (const args of callSites(cflat, s.name)) {
          const lit = (args[t.index] ?? '').match(/^\s*'([\w:-]+)'\s*$/)
          if (!lit) continue
          let scope = UNKNOWN
          if (scopeIndex >= 0) {
            const a = args[scopeIndex] ?? ''
            const inner = a.match(/(?:xmlQ|xmlChild|xmlAll)\( *([^,)]*), *'([\w:]+)' *\)/)
            if (inner) {
              const base = (inner[1].match(/[A-Za-z_$][\w$]*/) ?? [])[0]
              scope = extend(base === 'doc' ? ROOT : (own[ci].get(base) ?? UNKNOWN), inner[2])
            } else {
              const id = (a.match(/[A-Za-z_$][\w$]*/) ?? [])[0]
              scope = id === 'doc' ? ROOT : (own[ci].get(id) ?? UNKNOWN)
            }
          }
          if (t.kind === 'attr') put(attrs, lit[1], scope)
          else put(elements, lit[1], 'via:' + scope)
        }
      })
    }
  })

  return { elements, attrs, unresolved, unresolvedNames }
}

/** 記録した経路 `path` が、電文の経路 `chain`（根から親まで）の**その位置**を指しているか */
function coversAsParent(path, chain) {
  if (path === ROOT || path === UNKNOWN) return path === ROOT ? chain.length === 0 : false
  const { known } = segmentsOf(path)
  if (!known.length) return false
  // 直下アクセサ: 記録した経路が chain の末尾と一致すること
  return known.every((s, i) => chain[chain.length - known.length + i] === s)
}

/** 記録した経路 `path` が、`chain` のどこか（自分自身を含む祖先）を指しているか */
function coversAsAncestor(path, chain) {
  if (path === ROOT) return true
  if (path === UNKNOWN) return false
  const { known } = segmentsOf(path)
  if (!known.length) return false
  for (let start = 0; start + known.length <= chain.length; start++) {
    if (known.every((s, i) => chain[start + i] === s)) return true
  }
  return false
}

/**
 * 要素を読んでいるか。
 * @param parent    電文でのその要素の直接の親（null なら親を問わない）
 * @param ancestors 根からその親の 1 つ手前までの並び
 * @param multiPlace その名前が電文の複数の場所に現れるか（`xmlQ` は最初の 1 件しか返さない）
 * @returns 'yes' | 'maybe' | 'via-helper' | 'other-parent' | 'no'
 */
export function readsElement(model, name, parent = null, ancestors = [], multiPlace = false) {
  const got = model.elements.get(name)
  if (!got) return 'no'
  // 親を問わないなら、アクセサの引数として現れた時点で「読んでいる」
  if (!parent) return 'yes'
  const chain = [...ancestors, parent]
  const paths = k => [...got].filter(g => g.startsWith(k + ':')).map(g => g.slice(k.length + 1))

  // 直下アクセサは親そのものを指していること
  if (paths('child').some(p => coversAsParent(p, chain))) return 'yes'
  // 子孫を全件返すアクセサは、親か祖先のどこを指していても届く
  if (paths('all').some(p => coversAsAncestor(p, chain))) return 'yes'
  // 最初の 1 件だけを返すアクセサ。**起点がその親そのものなら確実に届く**
  const firsts = paths('first')
  if (firsts.some(p => coversAsParent(p, chain))) return 'yes'
  // 起点が祖先の場合だけ、同名要素が複数の場所にあると別のものを取りうる
  if (firsts.some(p => coversAsAncestor(p, chain))) return multiPlace ? 'maybe' : 'yes'

  if ([...got].some(g => g.endsWith(':' + UNKNOWN))) return 'maybe'
  if (paths('via').some(p => coversAsAncestor(p, chain) || p === UNKNOWN)) return 'via-helper'
  return 'other-parent'
}

/** 属性を読んでいるか。**受け側の変数が指す経路**が、その要素を指していること。 */
export function readsAttr(model, elName, attrName, chain = null) {
  const got = model.attrs.get(attrName)
  if (!got) return 'no'
  for (const p of got) {
    if (p === UNKNOWN) continue
    if (chain ? coversAsParent(p, chain) : segmentsOf(p).known.slice(-1)[0] === elName) return 'yes'
  }
  if (got.has(UNKNOWN)) return 'maybe'
  return 'other-parent'
}

/** 前版（文字列リテラルの出現だけを見る緩い判定）。**差分を出すために残す。** */
export function looseRead(src, name) {
  if (name.includes('@')) {
    const [el, at] = name.split('@')
    return new RegExp(`['"\`]${el}['"\`]`).test(src) && new RegExp(`['"\`]${at}['"\`]`).test(src)
  }
  return new RegExp(`['"\`]${name}['"\`]`).test(src)
}
