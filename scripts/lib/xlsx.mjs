// xlsx（Office Open XML）の読み取り。シートを「行の配列」として返すだけの最小実装。
//
// **専用ライブラリを足していない理由**: 読むのは気象庁が配る個別コード表だけで、必要なのは
// 値の取り出しのみ（数式・書式・日付の解釈はいらない）。xlsx の実体は zip + XML なので、
// 既に依存にある fflate で展開できる。
//
// 扱わないもの（いずれも気象庁のコード表には現れない）:
//   - 数式の再計算（`<f>` は無視し、キャッシュ済みの値 `<v>` を採る）
//   - 日付・時刻のシリアル値の解釈（数値のまま返す）
//   - 複数ブックにまたがる参照
import { unzipSync, strFromU8 } from 'fflate'

/** XML の実体参照を戻す。 */
function unescapeXml(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name]
  })
}

/** セル参照（`A1` / `AB12`）の列を 0 始まりの番号にする。 */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)
  if (!letters) return 0
  let index = 0
  for (const ch of letters[1]) index = index * 26 + (ch.charCodeAt(0) - 64)
  return index - 1
}

/**
 * `<si>` を 1 つの文字列にする（`<r>` で分割された書式付き文字列もつなぐ）。
 *
 * **ふりがな（`<rPh>`）は捨てる。** Excel で入力した日本語にはふりがなが付いていることがあり、
 * 残すと「潮位観測地点番号チョウイカンソクチテンバンゴウ」のように本文へ連結されてしまう。
 */
function sharedStrings(xml) {
  if (!xml) return []
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    collectText(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')),
  )
}

/** `<t>` の中身を順につないで 1 つの文字列にする。 */
function collectText(xml) {
  return [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join('')
}

/**
 * zip 内の 1 ファイル（xlsx 本体）を、シート名 → 行配列の Map にする。
 * 行は値の配列で、空セルは `null`。文字列・数値以外（真偽値・エラー）は文字列のまま返す。
 */
function readWorkbook(bytes) {
  const files = unzipSync(bytes)
  const text = (path) => (files[path] ? strFromU8(files[path]) : '')
  const strings = sharedStrings(text('xl/sharedStrings.xml'))

  // シート名 → シート XML のパス（r:id 経由で解決する。sheet1.xml が 1 番目とは限らない）。
  const rels = new Map(
    [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1],
      /Target="([^"]+)"/.exec(m[0])?.[1],
    ]),
  )
  const sheets = new Map()
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? '')
    const target = rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1])
    if (!target) continue
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    sheets.set(name, readSheet(text(path), strings))
  }
  return sheets
}

function readSheet(xml, strings) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    // 属性を非貪欲にすること。`[^>]*` だと空セル `<c r="D4" s="184"/>` の `/` まで飲み込んで
    // `/>` の枝が選ばれず、次のセルの中身をこのセルの値として拾ってしまう（値が左へずれる）。
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]
      const body = cell[2] ?? ''
      const index = columnIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '')
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      let value = null
      if (type === 'inlineStr') {
        value = collectText(body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''))
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        if (raw !== undefined) {
          if (type === 's') value = strings[Number(raw)] ?? null
          else if (type === 'str' || type === 'e') value = unescapeXml(raw)
          else if (type === 'b') value = raw === '1'
          else value = Number(raw)
        }
      }
      while (row.length < index) row.push(null)
      row[index] = value
    }
    rows.push(row)
  }
  return rows
}

/**
 * zip の中から、条件に合う xlsx を 1 つ選んでシートを読む。
 *
 * **ファイル名で探さないこと。** 気象庁のコード表 zip は日本語のファイル名を Shift_JIS のまま
 * 格納しており、UTF-8 として読むと化ける。中身（シート名）で判定すれば名前の文字コードに
 * 依存しない。
 *
 * @param {Uint8Array} zipBytes zip の中身
 * @param {(sheets: Map<string, unknown[][]>) => boolean} matches 目的のブックかを判定する
 * @returns {Map<string, unknown[][]>} シート名 → 行配列
 */
export function findWorkbookInZip(zipBytes, matches) {
  const entries = unzipSync(zipBytes)
  const unreadable = []
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/\.xlsx$/i.test(name)) continue
    let sheets
    try {
      sheets = readWorkbook(bytes)
    } catch (err) {
      // 読めないブックがあっても探索は続ける。**ただし黙らないこと** —— 拡張子で `.xlsx` に
      // 絞った後なので、ここへ来るのは「読めるはずのブックが壊れている（構造が変わった）」場合。
      // 握り潰すと、目的のブックが壊れていても「シートが無い」という別の理由に見える。
      unreadable.push(`${name}（${err.message}）`)
      continue
    }
    if (matches(sheets)) return sheets
  }
  if (unreadable.length) {
    console.warn(`[xlsx] 読めなかったブックが ${unreadable.length} 件あります: ${unreadable.join(' / ')}`)
  }
  return null
}
