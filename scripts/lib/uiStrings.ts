/**
 * 画面に出うる日本語の文字列を、ソースの構文木から抜き出す（docs/ui-wording-procedure.md「1. 棚卸しは機械で取る」）。
 *
 * **構文木から取るのは、コメントを拾わないため。** 行を grep するとコメント（このリポジトリでは
 * 画面の文字列より多い）が混ざり、どれが利用者の目に触れるのかを読み違える。構文木にコメントは乗らない。
 *
 * **HTML を組む文字列は、地の文と属性に分ける。** 管理コンソールは HTML をテンプレート文字列で組むので、
 * 1 つの文字列にタグ・`<!-- -->` のコメント・見出し・説明が全部入っている。コメントは配られるが画面には
 * 出ないので外す。属性は名前で選ばず、日本語を含む値をすべて拾う（`title` だけでなく `optgroup` の
 * `label`・`button` の `value` も画面に出る。名前の一覧で絞ると、載せ忘れた属性が黙って落ちる）。
 *
 * **読めなかったことは `problems` で返す。** 構文エラーのあるソースでも TypeScript は木を返すので、
 * 黙っていると「一部だけ読んだ」のに全部読んだように見える。UTF-8 として読めるかは、バイト列を
 * `decodeUtf8Strict` で読むときに見分ける。
 *
 * **`<style>`・`<script>` の中身を外すのは `.html` のファイルだけ。** テンプレート文字列の中に
 * 書かれたものは外さない（2026-10-12 時点の管理コンソールには無い）。
 */

import ts from 'typescript'

export type UiStringKind = 'text' | 'error' | 'log'

export interface UiString {
  line: number
  /** `error` = 例外の文（`new Error` / `throw`）、`log` = コンソールやログへ書く文、`text` = それ以外 */
  kind: UiStringKind
  text: string
}

export interface TextSegment {
  text: string
  /** 元の文字列の中で、この断片が始まる位置 */
  offset: number
}

/** ひらがな・カタカナ（長音・半角を含む）・漢字（々を含む）。 */
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ーｦ-ﾟ]/u
const ATTRIBUTE = /([^\s=<>"'/]+)\s*=\s*("([^"]*)"|'([^']*)')/g
/** 埋め込み式の代わりに置く印。式の中身は別の文字列として拾う。 */
export const PLACEHOLDER = '${…}'

/** `<` から始まるタグの終わり（`>` の次）を返す。引用符の中の `>` では切らない。閉じていなければ -1。 */
function tagEnd(s: string, start: number): number {
  let quote: string | null = null
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i]
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return i + 1
    } else if (c === '<') {
      return -1
    }
  }
  return -1
}

/**
 * 文字列を、利用者に見える断片へ分ける。タグを含まなければ空白を詰めた 1 つを返す。
 *
 * タグの始まりとみなすのは `<` の直後が英字・`/`・`!` で、かつ `>` で閉じているときだけ。
 * 閉じていない `<`（`a<b の場合` のような地の文）はタグとみなさない —— 末尾まで捨てると、その後ろの文を落とす。
 * **閉じていない `<!--` は末尾まで外す** —— 途中で止めると、コメントの中身を地の文として拾う。
 */
export function htmlTextSegments(s: string): TextSegment[] {
  const out: TextSegment[] = []
  const flush = (start: number, end: number) => {
    const raw = s.slice(start, end)
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text !== '') out.push({ text, offset: start + (raw.length - raw.trimStart().length) })
  }
  let textStart = 0
  let i = 0
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      flush(textStart, i)
      const end = s.indexOf('-->', i + 4)
      i = end < 0 ? s.length : end + 3
      textStart = i
      continue
    }
    if (s[i] === '<' && /[A-Za-z/!]/.test(s[i + 1] ?? '')) {
      const end = tagEnd(s, i)
      if (end >= 0) {
        flush(textStart, i)
        const tag = s.slice(i, end)
        for (const m of tag.matchAll(ATTRIBUTE)) {
          const value = m[3] ?? m[4] ?? ''
          const text = value.replace(/\s+/g, ' ').trim()
          if (text !== '') out.push({ text, offset: i + (m.index ?? 0) + m[0].indexOf(value) })
        }
        i = end
        textStart = i
        continue
      }
    }
    i += 1
  }
  flush(textStart, s.length)
  return out
}

/** 文字列のどこが元のソースのどこに当たるか（埋め込み式を印へ置き換えたぶんを戻すため）。 */
interface Piece {
  /** 組み立てた文字列の中での始まり */
  from: number
  /** ソースの中での始まり */
  sourcePos: number
}

/**
 * 文字列がどの引数の中にあるかで種類を決める。**関数の本体を越えては遡らない** ——
 * `throw new Error(format(() => show('…')))` の `show` の文は、例外の文ではない。
 */
function kindOf(node: ts.Node, sf: ts.SourceFile): UiStringKind {
  for (let p: ts.Node | undefined = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isBlock(p)) return 'text'
    if (ts.isThrowStatement(p)) return 'error'
    if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText(sf))) return 'error'
    if (ts.isCallExpression(p)) {
      const callee = p.expression.getText(sf)
      // `log.warn(…)`・`console.error(…)` の形と、ホストが使う `this.opts.log('warn', …)`・`deps.logError(…)` の形
      if (/(?:^|\.)(?:console|log|logger)\.\w+$/.test(callee)) return 'log'
      if (/(?:^|\.)(?:log|logError|logWarn|logInfo|logDebug)$/.test(callee)) return 'log'
    }
  }
  return 'text'
}

/**
 * HTML のファイルから、日本語を含む断片を返す。
 *
 * **`<style>` と `<script>` の中身は同じ長さの空白で潰してから読む。** CSS のコメントには日本語の
 * 説明が並んでいる（管理コンソールの `index.html`）が、画面には出ない。消さずに潰すのは、
 * 位置と行番号を元のファイルとずらさないため。
 */
function extractFromHtml(source: string): UiString[] {
  const blanked = source.replace(/(<(style|script)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (_m, open: string, _t, body: string, close: string) =>
    open + body.replace(/[^\n]/g, ' ') + close,
  )
  const lineOf = (pos: number) => source.slice(0, pos).split('\n').length
  return htmlTextSegments(blanked)
    .filter((seg) => JAPANESE.test(seg.text))
    .map((seg) => ({ line: lineOf(seg.offset), kind: 'text' as const, text: seg.text }))
}

export interface ParseResult {
  strings: UiString[]
  /** 読めなかったこと（構文エラー）。空でなければ、`strings` は一部かもしれない */
  problems: string[]
}

/**
 * バイト列を UTF-8 として厳密に読む。読めなければ `ok: false`（中身は置き換え文字入りで返す）。
 *
 * **読めたかどうかは、復号した文字列に U+FFFD があるかでは見分けない。** ソースには正当な U+FFFD が
 * 書かれていることがある（ホストの `xmlLite.ts` の正規表現）。見分けるのは復号そのものが失敗したかどうか。
 */
export function decodeUtf8Strict(buf: Uint8Array): { text: string; ok: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), ok: true }
  } catch {
    return { text: new TextDecoder('utf-8').decode(buf), ok: false }
  }
}

/**
 * ソース 1 本から、日本語を含む断片を出てくる順に返す。読めなかったことは `problems` に入れる。
 * `fileName` の拡張子が `.tsx` なら JSX として読む（地の文も拾う）。`.html` は HTML として読む。
 *
 * **改行は先に `\n` へ揃える。** TypeScript はテンプレートの中身の `\r\n` を `\n` にして返すので、
 * CRLF のままだと 1 行ごとに位置が 1 文字ずれ、複数行のテンプレートの行番号が狂う（行の数は変わらない）。
 */
export function parseUiStrings(fileName: string, rawSource: string): ParseResult {
  const source = rawSource.replace(/\r\n?/g, '\n')
  const problems: string[] = []
  if (fileName.endsWith('.html')) return { strings: extractFromHtml(source), problems }

  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  // 構文エラーは公開の型に載っていないが、createSourceFile が付けて返す
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  for (const d of diagnostics) {
    const line = sf.getLineAndCharacterOfPosition(d.start).line + 1
    problems.push(`${line} 行目: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }

  const strings: UiString[] = []
  const emit = (node: ts.Node, joined: string, pieces: Piece[]) => {
    for (const seg of htmlTextSegments(joined)) {
      if (!JAPANESE.test(seg.text)) continue
      let piece = pieces[0]
      for (const p of pieces) if (p.from <= seg.offset) piece = p
      const pos = piece.sourcePos + (seg.offset - piece.from)
      strings.push({ line: sf.getLineAndCharacterOfPosition(pos).line + 1, kind: kindOf(node, sf), text: seg.text })
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      emit(node, node.text, [{ from: 0, sourcePos: node.getStart(sf) + 1 }])
    } else if (ts.isJsxText(node)) {
      // `node.text` は先頭の改行と字下げを含むので、数え始めは `getStart`（空白を飛ばした位置）ではなく `pos`
      emit(node, node.text, [{ from: 0, sourcePos: node.pos }])
    } else if (ts.isTemplateExpression(node)) {
      // 頭・各区切りの文字の位置は、その直前の `` ` `` または `}` の次から数える
      const pieces: Piece[] = [{ from: 0, sourcePos: node.head.getStart(sf) + 1 }]
      let joined = node.head.text
      for (const span of node.templateSpans) {
        pieces.push({ from: joined.length, sourcePos: span.expression.getStart(sf) })
        joined += PLACEHOLDER
        pieces.push({ from: joined.length, sourcePos: span.literal.getStart(sf) + 1 })
        joined += span.literal.text
      }
      emit(node, joined, pieces)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { strings, problems }
}

/** `parseUiStrings` の文字列だけを返す（読めなかったことを気にしない呼び出し向け）。 */
export function extractUiStrings(fileName: string, source: string): UiString[] {
  return parseUiStrings(fileName, source).strings
}
