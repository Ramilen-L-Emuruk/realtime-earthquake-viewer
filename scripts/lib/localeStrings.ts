/**
 * ほかのアプリの日本語の文言を、手元にある言語ファイルから引く（docs/ui-wording-procedure.md「3. 語の出どころを探す」）。
 *
 * **検索ではなく言語ファイルから引くのは、Web 検索では実際の画面の文字列がほとんど出てこないため**
 * （2026-10-11 に試した）。読めるのは 2 種類:
 *
 * - Chrome の `Locales/ja.pak`（版 5）。文字列が区切りなしに並んでいるので、**先頭の項目表で切り出す**。
 *   ボタン名などは別名の表（alias）にだけ載っていることがある
 * - VS Code の日本語パックの `*.i18n.json`。値をたどればよい
 *
 * **pak は作りを確かめてから読む。** Edge の `ja.pak` は版・符号化の値が Chrome と同じなのに、項目表の
 * 位置が逆順やファイルの外を指していて、確かめずに切り出すとメモリを使い切って落ちた（2026-10-12）。
 * 作りが合わなければ、文字列を 1 つも作らずに止める。
 */

export interface PakString {
  id: number
  text: string
  /** 別名の表から引いたもの */
  alias: boolean
}

const PAK_HEADER = 12
const PAK_ENTRY = 6
const PAK_ALIAS = 4
const PAK_UTF8 = 1

/** Chrome の pak（版 5・UTF-8）を読む。作りが合わなければ止める（黙って化けた文字列を返さない）。 */
export function readPakStrings(buf: Buffer): PakString[] {
  if (buf.length < PAK_HEADER) throw new Error(`pak として短すぎる（${buf.length} バイト）`)
  const version = buf.readUInt32LE(0)
  if (version !== 5) throw new Error(`pak の版が 5 ではない（${version}）`)
  const encoding = buf.readUInt8(4)
  if (encoding !== PAK_UTF8) throw new Error(`pak の符号化が UTF-8 ではない（${encoding}）`)
  const count = buf.readUInt16LE(8)
  const aliasCount = buf.readUInt16LE(10)
  const aliasBase = PAK_HEADER + (count + 1) * PAK_ENTRY
  const dataStart = aliasBase + aliasCount * PAK_ALIAS
  if (dataStart > buf.length) throw new Error(`pak の表がファイルに収まらない（表の終わり ${dataStart}・ファイル ${buf.length} バイト）`)

  const entries: Array<{ id: number; offset: number }> = []
  for (let i = 0; i <= count; i++) {
    entries.push({ id: buf.readUInt16LE(PAK_HEADER + i * PAK_ENTRY), offset: buf.readUInt32LE(PAK_HEADER + i * PAK_ENTRY + 2) })
  }
  // 位置は表の後ろから始まり、減らずに進み、ファイルの終わりを越えない
  let previous = dataStart
  for (let i = 0; i <= count; i++) {
    const { offset } = entries[i]
    if (offset < previous || offset > buf.length) {
      throw new Error(`pak の ${i} 番目の項目の位置（${offset}）が、前の項目（${previous}）より前か、ファイルの外（${buf.length} バイト）`)
    }
    previous = offset
  }

  const text = (i: number) => buf.subarray(entries[i].offset, entries[i + 1].offset).toString('utf8')
  const out: PakString[] = []
  for (let i = 0; i < count; i++) out.push({ id: entries[i].id, text: text(i), alias: false })
  for (let j = 0; j < aliasCount; j++) {
    const id = buf.readUInt16LE(aliasBase + j * PAK_ALIAS)
    const index = buf.readUInt16LE(aliasBase + j * PAK_ALIAS + 2)
    if (index >= count) throw new Error(`別名 ${id} が範囲の外の項目（${index}）を指している`)
    out.push({ id, text: text(index), alias: true })
  }
  return out
}

/** JSON の値をたどり、文字列だけを、それを持っていた鍵と一緒に返す（配列の中は親の鍵を引き継ぐ）。 */
export function jsonStrings(value: unknown, key = ''): Array<{ key: string; text: string }> {
  if (typeof value === 'string') return [{ key, text: value }]
  if (Array.isArray(value)) return value.flatMap((v) => jsonStrings(v, key))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => jsonStrings(v, k))
  }
  return []
}

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

export interface FindResult {
  /** 当たったものを表示用の行にしたもの */
  lines: string[]
  /** 読んだ文字列の数 */
  total: number
  /** そのうち日本語を含むもの */
  japanese: number
}

/**
 * 日本語の言語ファイルとして読めたとみなす、日本語を含む文字列の割合の下限。
 *
 * **「1 件以上」では足りない。** Chrome の `en-US.pak` にも日本語を含む文字列が 1 件ある
 * （12462 件中。2026-10-12 実測）。日本語のファイルは Chrome 154 の `ja.pak` が 95%、
 * VS Code の Git の訳が 98% で、半分を下回るものは別の言語か、読み方が合っていない。
 */
export const JAPANESE_FILE_MIN_RATIO = 0.5

/** 日本語の言語ファイルとして読めたか。読めていなければ、0 件は「その言い方をしていない」の根拠にならない。 */
export function looksJapanese(r: FindResult): boolean {
  return r.total > 0 && r.japanese / r.total >= JAPANESE_FILE_MIN_RATIO
}

/**
 * ファイルの中身から、語のどれかを含む文字列を探す。拡張子が `.pak` なら pak、それ以外は JSON。
 *
 * **突き合わせは両辺を NFKC で揃えてから行う。** 同じ問いでも Chrome は全角の「？」、VS Code は半角の
 * 「?」を使うので、そのまま比べると片方を取りこぼす。語が 1 つも無い・空の語があるときは止める
 * （空の語はすべてに当たり、数万件で画面を埋める）。
 */
export function findLocaleStrings(fileName: string, buf: Buffer, words: string[]): FindResult {
  if (words.length === 0 || words.some((w) => w.trim() === '')) throw new Error('探す語を 1 つ以上、空でなく渡す')
  const norm = (s: string) => s.normalize('NFKC')
  const wanted = words.map(norm)
  const hit = (s: string) => {
    const n = norm(s)
    return wanted.some((w) => n.includes(w))
  }
  const entries = fileName.toLowerCase().endsWith('.pak')
    ? readPakStrings(buf).map((s) => ({ label: `${s.alias ? '別名 ' : ''}${s.id}`, text: s.text }))
    : jsonStrings(JSON.parse(buf.toString('utf8').replace(/^﻿/, '')) as unknown).map((s) => ({ label: s.key, text: s.text }))
  return {
    lines: entries.filter((e) => hit(e.text)).map((e) => `[${e.label}] ${e.text}`),
    total: entries.length,
    japanese: entries.filter((e) => JAPANESE.test(e.text)).length,
  }
}
