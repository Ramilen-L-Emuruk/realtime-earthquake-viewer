// 自分で書いた XML を読むための、小さな読み手と書き手の部品。
//
// **読むのは `stationXml.ts` が書いたファイルだけ。** 外から来る任意の XML を読むためのものではないので、
// 扱う形を絞ってある —— 要素・属性・文字・コメント・XML 宣言・文字参照（`&amp;` などの 5 つと数値参照）。
// **DOCTYPE と CDATA は受け付けない**（書く側が使わないうえ、DOCTYPE は実体の展開で
// 中身を膨らませる入口になる）。読めない形に出会ったら、どこで何に詰まったかを添えて投げる。
//
// **名前空間は接頭辞ではなく URI で引く。** 書いた側と同じ接頭辞が使われている前提で照合すると、
// 道具で整形し直されただけのファイルが読めなくなる。

/** 要素 1 つ。名前は名前空間の URI と局所名に分けて持つ。 */
export interface XmlElement {
  readonly ns: string | null
  readonly local: string
  readonly attrs: ReadonlyMap<string, string>
  readonly children: readonly XmlElement[]
  /** 直下の文字をつないだもの（子要素の中の文字は含まない）。 */
  readonly text: string
}

export class XmlReadError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message}（${offset} 文字目）`)
    this.name = 'XmlReadError'
  }
}

const NAME_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/y
const PREDEFINED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(raw: string, at: number): string {
  return raw.replace(/&([^;]*);/g, (_, body: string) => {
    if (body.startsWith('#x')) return fromCodePoint(Number.parseInt(body.slice(2), 16), body, at)
    if (body.startsWith('#')) return fromCodePoint(Number.parseInt(body.slice(1), 10), body, at)
    const ch = PREDEFINED[body]
    if (ch === undefined) throw new XmlReadError(`知らない実体参照 &${body};`, at)
    return ch
  })
}

function fromCodePoint(cp: number, body: string, at: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw new XmlReadError(`読めない文字参照 &${body};`, at)
  const ch = String.fromCodePoint(cp)
  if (!isXmlChars(ch)) throw new XmlReadError(`読めない文字参照 &${body};`, at)
  return ch
}

/**
 * XML 1.0 に書ける文字だけでできているか（`Char` の生成規則）。**制御文字（TAB・LF・CR 以外）と
 * 対になっていないサロゲートは書けない** —— 書いてしまうと、標準の道具（ObsPy など）で読めない
 * ファイルになる。こちらの読み手は文字の範囲を見ないので、書く側で止めないと気づけない。
 */
export function isXmlChars(text: string): boolean {
  return /^[\t\n\r -퟿-�\u{10000}-\u{10FFFF}]*$/u.test(text)
}

interface RawElement {
  readonly name: string
  readonly attrs: Map<string, string>
  readonly children: RawElement[]
  text: string
  readonly at: number
}

/** XML の文字列を読み、根の要素を返す。**投げる**（`XmlReadError`）。 */
export function parseXml(source: string): XmlElement {
  let i = 0
  const stack: RawElement[] = []
  let root: RawElement | null = null

  const fail = (message: string): never => {
    throw new XmlReadError(message, i)
  }
  const readName = (): string => {
    NAME_RE.lastIndex = i
    const m = NAME_RE.exec(source)
    if (m === null) return fail('名前が読めない')
    i += m[0].length
    return m[0]
  }
  const skipSpace = (): void => {
    while (i < source.length && /\s/.test(source[i] ?? '')) i += 1
  }

  if (source.charCodeAt(0) === 0xfeff) i = 1
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      if (stack.length > 0) {
        i = source.length
        fail(`<${stack[stack.length - 1]?.name}> が閉じていない`)
      }
      if (source.slice(i).trim() !== '') fail('根の要素の外に文字がある')
      break
    }
    const between = source.slice(i, lt)
    if (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top !== undefined) top.text += decodeEntities(between, i)
    } else if (between.trim() !== '') {
      fail('根の要素の外に文字がある')
    }
    i = lt
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i)
      if (end === -1) fail('処理命令が閉じていない')
      i = end + 2
      continue
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i)
      if (end === -1) fail('コメントが閉じていない')
      i = end + 3
      continue
    }
    if (source.startsWith('<!', i)) fail('DOCTYPE と CDATA は扱わない')
    if (source.startsWith('</', i)) {
      i += 2
      const name = readName()
      skipSpace()
      if (source[i] !== '>') fail(`</${name}> の後に > が無い`)
      i += 1
      const open = stack.pop()
      if (open === undefined || open.name !== name) fail(`</${name}> が開いた要素と合わない`)
      continue
    }
    // 開始タグ。
    const at = i
    i += 1
    const name = readName()
    const attrs = new Map<string, string>()
    for (;;) {
      skipSpace()
      if (source.startsWith('/>', i) || source[i] === '>') break
      const attr = readName()
      skipSpace()
      if (source[i] !== '=') fail(`属性 ${attr} に = が無い`)
      i += 1
      skipSpace()
      const quote = source[i]
      if (quote !== '"' && quote !== "'") fail(`属性 ${attr} の値が引用符で囲まれていない`)
      const end = source.indexOf(quote as string, i + 1)
      if (end === -1) fail(`属性 ${attr} の値が閉じていない`)
      if (attrs.has(attr)) fail(`属性 ${attr} が 2 度ある`)
      attrs.set(attr, decodeEntities(source.slice(i + 1, end), i))
      i = end + 1
    }
    const selfClosing = source.startsWith('/>', i)
    i += selfClosing ? 2 : 1
    const el: RawElement = { name, attrs, children: [], text: '', at }
    const parent = stack[stack.length - 1]
    if (parent !== undefined) parent.children.push(el)
    else if (root === null) root = el
    else fail('根の要素が 2 つある')
    if (!selfClosing) stack.push(el)
  }
  // **最後の開始タグで文字列が尽きた形**（`<a>`）は、上の「`<` が見つからない」分岐を通らない。
  const unclosed = stack[stack.length - 1]
  if (unclosed !== undefined) throw new XmlReadError(`<${unclosed.name}> が閉じていない`, i)
  if (root === null) throw new XmlReadError('要素が 1 つも無い', i)
  return resolve(root, new Map())
}

/** 接頭辞を名前空間の URI へ引き当てる。**宣言の効く範囲は子孫まで**（XML の名前空間の規則）。 */
function resolve(el: RawElement, inherited: ReadonlyMap<string, string | null>): XmlElement {
  const scope = new Map(inherited)
  const attrs = new Map<string, string>()
  for (const [k, v] of el.attrs) {
    if (k === 'xmlns') scope.set('', v === '' ? null : v)
    else if (k.startsWith('xmlns:')) scope.set(k.slice(6), v)
    else attrs.set(k, v)
  }
  const colon = el.name.indexOf(':')
  const prefix = colon === -1 ? '' : el.name.slice(0, colon)
  const local = colon === -1 ? el.name : el.name.slice(colon + 1)
  const ns = scope.get(prefix)
  if (ns === undefined && prefix !== '') {
    throw new XmlReadError(`接頭辞 ${prefix} が宣言されていない`, el.at)
  }
  return {
    ns: ns ?? null,
    local,
    attrs,
    children: el.children.map((c) => resolve(c, scope)),
    text: el.text,
  }
}

/**
 * 文字と属性値の両方で安全に使えるよう、5 文字と TAB・LF・CR を逃がす。**XML に書けない文字が
 * あれば投げる**（`isXmlChars`）。TAB・LF・CR を文字参照にするのは、属性値に生のまま書くと
 * 読み手が空白へ置き換える（XML の規則）ため —— 読み戻した値が書いた値と変わる。
 */
export function escapeXml(text: string): string {
  if (!isXmlChars(text)) throw new Error(`XML に書けない文字を含む: ${JSON.stringify(text)}`)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
}

/** 子要素のうち、名前空間と局所名が合うもの。 */
export function childrenOf(el: XmlElement, ns: string, local: string): readonly XmlElement[] {
  return el.children.filter((c) => c.ns === ns && c.local === local)
}

/** 子要素のうち、名前空間と局所名が合う最初の 1 つ。無ければ `null`。 */
export function childOf(el: XmlElement, ns: string, local: string): XmlElement | null {
  return el.children.find((c) => c.ns === ns && c.local === local) ?? null
}
