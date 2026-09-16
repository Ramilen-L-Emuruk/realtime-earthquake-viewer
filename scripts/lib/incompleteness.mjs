// 「取得・解析できなかった」という**不完全さの印**を、調査スクリプトのあいだで運ぶ仕組み。
//
// これらのスクリプトの出力は「この種別は 0 件だった」という**網羅性の主張の根拠**になる。
// だから「集めたが 0 件」と「集められなかった」が区別できない形で残ってはいけない
// （CLAUDE.md「調査レビュー」に、走査先を間違えて誤った 0 件結論を出した前例がある）。
//
// **個別の `if` で引き継ぐ形は破れる。** 実際、印を下流へ運ぶ手当ては 3 巡の敵対的レビューで
// 1 段ずつ下流へ再発した —— 永続化するファイルへ書いていない、下流が読んでいない、
// その先が読んでいない。どれも「動くけれど印だけが消える」形で、型検査もテストも通っていた。
// パイプラインが 3 段だったから 3 巡で末端へ届いただけで、設計が正しかったからではない。
//
// **ここでは「読んだら引き継ぐ」を読み取りの副作用にしてある。** `readArtifact` を通せば
// それだけで台帳へ積まれ、`writeArtifact` / `markResult` で自動的に出ていく。呼び出し側が
// 引き継ぎのコードを書くことはない。
//
// **迂回はできる**（素の `JSON.parse(fs.readFileSync(...))` で読めばよい）ので、そこは
// `scripts/incompletenessPropagation.test.ts` が静的に落とす。仕組みと検査は対で使うこと。
import fs from 'node:fs'
import path from 'node:path'

/** 印を載せるキー。**トップレベルに置く**（データの形は変えない）。 */
export const INCOMPLETE_KEY = '_incomplete'

const WARNING = 'この結果を「無い」の根拠にしないこと（取得・解析できなかったものがあります）'

/**
 * 台帳を 2 本に分ける理由。
 *
 * `own` は**自分が取りこぼした分**で、源ごとに 1 行へ畳んで出す（件数が増えても行数は
 * 源の数で止まる）。`inherited` は**上流から受け取った行**で、畳み直さずそのまま持ち回る。
 *
 * **引き継いだ分を畳み直さない**のは、畳むと源が「上流」へ丸められ、どこで取りこぼしたのかが
 * 段を下るほど薄くなるため。段数が増えても最初の源の名前が末端まで残る。
 */
const own = new Map()   // source -> string[]（理由）
const inherited = []    // string[]（上流の行をそのまま）

/**
 * 自分が取りこぼしたことを積む。
 *
 * @param source どこで取りこぼしたか（`'アーカイブの取得'` 等）。**源ごとに畳むための鍵**
 * @param reason 個別の事実（`'telegram.earthquake 2026-01-03: HTTP 500'` 等）。
 *   ここに「N 件あります」のような要約を書かないこと —— 件数はこの仕組みが数える
 */
export function noteIncomplete(source, reason) {
  if (!source) throw new Error('noteIncomplete には source が要ります（どこで取りこぼしたかを印に残すため）')
  const list = own.get(source) ?? []
  list.push(String(reason))
  own.set(source, list)
}

/**
 * 1 行へ畳むときに並べる見本の数。
 *
 * **少数の取りこぼしは全部見せる。** 畳みは「件数が増えても行数が源の数で止まる」ための
 * 仕組みで、2〜3 件しか無いときまで要約すると中身が読めなくなる。数は既存の記録の作法
 * （読めなかった値を見本で最大 3 件載せる）に揃えてある。
 */
const FOLD_SAMPLES = 3

/** 源と理由の並びを 1 行へ畳む。 */
function foldLine(source, reasons) {
  const n = reasons.length
  if (n <= FOLD_SAMPLES) return `${source}: ${n} 件（${reasons.join(' / ')}）`
  const shown = reasons.slice(0, FOLD_SAMPLES).join(' / ')
  return `${source}: ${n} 件（例: ${shown} ほか ${n - FOLD_SAMPLES} 件）`
}

/**
 * 台帳の現在位置を覚える。`writeArtifact` の `since` へ渡すと、**その位置より後に
 * 積まれた分だけ**が印になる。
 *
 * **区切りたくなるのは、1 つのプロセスが複数の独立した成果物を書くとき。**
 * `fetch-quake-times.mjs` は分類（`telegram.earthquake` / `eew.forecast` / …）ごとに
 * `meta.json` を書き、下流はそれを**分類ごとに別々に**読む。区切らないと、ある分類の
 * 走査が完璧でも、同じ実行で流した別の分類が 1 件落ちただけで
 * 「このレポートのどの節も『無い』の根拠にするな」と出る —— 事実に反する警告は、
 * 本物の警告を軽く見せる。
 *
 * **分類名の字面で振り分けない。** 理由の文面に分類名は入っているが、それで絞るのは
 * 事実（どの走査で落ちたか）を代理値（文字列の一致）で判定することになる。
 */
export function checkpoint() {
  return {
    own: new Map([...own].map(([source, reasons]) => [source, reasons.length])),
    inherited: inherited.length,
  }
}

/**
 * 積まれている印の行。自分の分（畳み済み）→ 引き継いだ分の順。
 *
 * @param since `checkpoint()` の戻り値。渡すと**それより後に積まれた分だけ**を返す
 */
export function incompleteNotes(since = null) {
  const mine = []
  for (const [source, reasons] of own) {
    const from = since ? (since.own.get(source) ?? 0) : 0
    const rest = reasons.slice(from)
    if (rest.length > 0) mine.push(foldLine(source, rest))
  }
  return [...mine, ...inherited.slice(since ? since.inherited : 0)]
}

/**
 * 引き継ぎ・不明を積む内部用。`own` と混ぜない（畳み直さないため）。
 *
 * **同じ行は 2 度積まない。** 上流の印は複数の経路で届きうる —— `triage.mjs` は
 * 計測台の生データ（そこにサンプル収集の札の印が入っている）を読んだうえで、同じ札を
 * 自分でも読む。除かないと、まったく同じ 1 行がレポートに 2 度並ぶ。
 */
function inherit(line) {
  if (!inherited.includes(line)) inherited.push(line)
}

/**
 * 中間成果物から印を吸い上げる。
 *
 * **キーが無いことを「完全」と読まない。** `writeArtifact` は取りこぼしが無くても
 * `_incomplete: { notes: [] }` を必ず書くので、キーが無いファイルは「この仕組みを
 * 通っていない」＝いつどう作られたか分からないもの。手元に残った旧い中間ファイルが
 * 黙って「完全」に化けるのを防ぐ。
 */
function absorb(obj, source, filePath) {
  const mark = obj?.[INCOMPLETE_KEY]
  const name = path.basename(filePath)

  if (mark === undefined) {
    inherit(`${source}: 古い形の入力です（不完全さの印を持たない ${name}）。作り直すまで、この結果を「無い」の根拠にしないこと`)
    return
  }
  // 旧 `withCompletenessMark` が書いた文字列形式。**形が違うことを理由に捨てない** ——
  // 捨てると上流が伝えてきた取りこぼしがここで消える
  if (typeof mark === 'string') {
    inherit(`${source}: ${mark}`)
    return
  }
  if (Array.isArray(mark?.notes)) {
    for (const line of mark.notes) inherit(String(line))
    return
  }
  inherit(`${source}: 不完全さの印の形を読めません（${name}）。作り直すまで、この結果を「無い」の根拠にしないこと`)
}

/**
 * 中間成果物（JSON）を読む。**読んだ時点で、そのファイルの印が自分の台帳へ積まれる。**
 *
 * **例外を投げない。** 1 つの入力が欠けても他の集計は続けたいので、読めなかったことは
 * 印として積み、`null` を返す。呼び出し側は `null` を見て自分の判断（その節を飛ばす等）をする。
 *
 * @param {string} filePath
 * @param {{ source: string, optional?: boolean }} opts
 *   `source` は印に残す名前（必須）。`optional` を立てたときだけ、ファイルが無くても積まない
 *   —— **「ファイルが無い」は既定では「0 件だった」ではなく「見ていない」**
 * @returns 読めた中身。読めなければ `null`
 */
export function readArtifact(filePath, opts = {}) {
  const { source, optional = false } = opts
  if (!source) throw new Error('readArtifact には source が要ります（どの入力かを印に残すため）')

  if (!fs.existsSync(filePath)) {
    if (!optional) {
      inherit(`${source}: 入力がありません（${path.basename(filePath)}）。生成するスクリプトを先に実行してください`)
    }
    return null
  }
  let obj
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    // 壊れたファイルを「空」と読まない。読めないことは取りこぼしより重い事実
    inherit(`${source}: 入力を読めませんでした（${path.basename(filePath)}）: ${e?.message ?? e}`)
    return null
  }
  absorb(obj, source, filePath)
  return obj
}

/** ファイルへ載せる印。**取りこぼしが無くても `notes` は必ず書く**（上の `absorb` 参照）。 */
function fileMark(since) {
  const notes = incompleteNotes(since)
  // 取りこぼしが無いのに警告文を置くと、平常時の出力まで「疑わしい」と読める
  return notes.length === 0 ? { notes: [] } : { warning: WARNING, notes }
}

/**
 * 中間成果物を書く。台帳の中身が `_incomplete` として載る。
 *
 * **`data` が持つ `_incomplete` は台帳の内容で上書きする。** 台帳が正 —— 上流から来た分は
 * `readArtifact` を通った時点で台帳に入っているので、ここで消えるのは迂回して読んだ分だけ。
 *
 * @param {string} filePath
 * @param {object} data 印を除いた本体。**形は変えない**（既存の消費者を壊さないため）
 * @param {{ space?: number, since?: object }} opts
 *   `space` は `JSON.stringify` の整形幅。既定 1。巨大な中間物（`p2p-history.json` 等）は 0 を渡す。
 *   `since` は `checkpoint()` の戻り値で、**1 つのプロセスが独立した成果物を複数書くとき**に渡す
 *   （渡さなければ台帳の全部が載る）
 */
export function writeArtifact(filePath, data, opts = {}) {
  const { space = 1, since = null } = opts
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('writeArtifact にはオブジェクトを渡してください（印を載せる場所が要ります）')
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({ ...data, [INCOMPLETE_KEY]: fileMark(since) }, null, space))
  return filePath
}

/**
 * 標準出力へ出す結果に印を載せる（旧 `archive-cache.mjs` の `withCompletenessMark`）。
 *
 * **ファイルとは前提が違う。** あちらは別のスクリプトが読むので常に印の欄を置くが、
 * こちらは人が読むので、取りこぼしが無ければ何も足さない。
 *
 * **exit code はここで立てない。** 副作用を「結果を整える関数」へ隠すと、テストが
 * ランナーの終了コードを汚す。終了コードは `reportIncompleteness` の戻り値を見て
 * 呼び出し側が立てる。
 */
export function markResult(result) {
  const notes = incompleteNotes()
  if (notes.length === 0) return result
  return { ...result, [INCOMPLETE_KEY]: { warning: WARNING, notes } }
}

/**
 * 標準エラーへ報告する。
 *
 * @returns 印の行数。**呼び出し側はこれを見て exit code を立てる**
 *   （`if (reportIncompleteness('…') > 0) process.exitCode = 1`）
 */
export function reportIncompleteness(label = '入力') {
  const notes = incompleteNotes()
  if (notes.length === 0) return 0
  console.error(`${label}: 取得・解析できなかったものがあります（${notes.length} 件）—— ここは「見ていない」ので、0 件を「無い」と読まないこと`)
  for (const n of notes) console.error(`  ${n}`)
  return notes.length
}

/**
 * 人が読むレポート（`.md` / `.txt`）の頭へ差す文面。
 *
 * **装飾を呼び出し側に書かせない。** 書かせると `.md` 側と `.txt` 側で文面が割れ、
 * 片方だけが古くなる。
 *
 * **区間（`checkpoint()`）は取れない。** いま使っているのはどれも 1 プロセスで 1 つの
 * レポートを書くスクリプトなので足していない。**複数の成果物を書くスクリプトで断りを
 * 出したくなったら、ここに `since` が要る** —— 無いまま使うと全区間ぶんが載る。
 *
 * @param {'markdown'|'plain'} style `markdown` は引用ブロック、`plain` は装飾なし
 * @returns 行の配列。取りこぼしが無ければ空
 */
export function incompletenessBanner(style = 'plain') {
  const notes = incompleteNotes()
  if (notes.length === 0) return []
  const lines = [
    `**入力の取得・解析に失敗したものがあります（${notes.length} 件）。**`,
    '**このレポートのどの節も「無い」の根拠にしないこと** —— 集計は失敗した入力の分を黙って飛ばしている。',
    ...notes.map(n => `- ${n}`),
  ]
  return style === 'markdown' ? lines.map(l => `> ${l}`) : lines.map(l => l.replace(/\*\*/g, ''))
}

/**
 * テスト用。台帳を空にする。
 *
 * **自分の分と引き継いだ分の両方を空にすること。** 片方だけ残ると、「印が無いとき」の
 * 振る舞いを確かめるテストが実行順によって落ちる（`archive-cache.mjs` の
 * `resetArchiveCacheForTest` と同じ理由）。
 */
export function resetIncompletenessForTest() {
  own.clear()
  inherited.length = 0
}
