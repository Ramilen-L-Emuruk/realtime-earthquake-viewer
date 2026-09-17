import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// **調査スクリプトのファイル読み書きを 1 件残らず数え上げ、1 件ずつ理由を付けさせる。**
//
// 不完全さの印（「取得・解析できなかったものがある」）は `scripts/lib/incompleteness.mjs` の
// `readArtifact` / `writeArtifact` が運ぶ。読んだ時点で自動的に引き継がれる作りなので、
// **通してさえいれば引き継ぎのコードは要らない** —— 裏を返すと、**通さない経路を 1 本足せば
// そこで印が消える**。ヘルパーを作っただけでは同じ穴が残る。
//
// **「怪しい書き方」を探す形にはしない。** 最初はそう書いた（1 行の中に `readFileSync` と
// `JSON.parse` が同居しているか等）が、変数へ入れる・複数行に分ける・非同期版を使う、の
// どれでも素通りした。CLAUDE.md が `triage.mjs` の設計変更理由として記録している
// 「静的解析は 4 巡の敵対的レビューで毎巡新しい取りこぼしが出た。**JavaScript の書き方が
// 増えるたびに穴が開く構造**だった」と同じ形を、この検査でもう一度作っていた。
//
// **代わりに、読み書きの呼び出しを AST で全部拾って許可制にしてある。** 見るのは呼び出しの
// 名前だけなので、引数をどう書こうと・何行に分けようと漏れない。新しい読み書きを足すと必ず
// ここで落ち、書いた人は「`readArtifact` / `writeArtifact` を通す」か「中間成果物ではない
// 理由を書く」かを選ぶことになる。**許可リストが増えること自体は問題ではない** ——
// 判断が記録に残ることのほうが大事。

const AUDIT_DIR = join('scripts', 'telegram-audit')

/** 監査スクリプト以外で、同じ作業ディレクトリのファイルを扱うもの。 */
const EXTRA_TARGETS = [join('src', 'services', 'dmdataCoverage.probe.test.ts')]

/**
 * 拾う名前。**同期・非同期の両方**（`fs.promises` も同じ名前で来る）と、
 * 中身を少しずつ書き出すもの（`createWriteStream`）。
 *
 * **「使っていないから」で外さない。** 外したものは「見落とし」と「意図して外した」の
 * 区別が付かなくなる。使う理由があるものは下の許可リストへ理由付きで載せる。
 */
const IO_NAMES = new Set([
  'readFileSync', 'writeFileSync', 'appendFileSync',
  'readFile', 'writeFile', 'appendFile',
  'createReadStream', 'createWriteStream',
])

/**
 * 素の `fs` での読み書きを許すもの。**1 件ずつ理由を書く。**
 *
 * 理由を書けないものは足さないこと —— 「動かないから外した」を積むと、この検査は
 * 何も守らなくなる。`call` は AST から取った字面（空白を 1 つに潰したもの）で、
 * **完全一致で照合する**。書き換えれば落ちるので、そのとき理由を見直すことになる。
 */
const ALLOWED: { file: string; call: string; why: string }[] = [
  // --- 取得の控え（同じスクリプトが書いて読む。パイプラインの中間成果物ではない） ---
  {
    file: 'archive-cache.mjs',
    call: 'fs.readFileSync(cachePath)',
    why: 'DMDATA アーカイブ本体の控え（gzip の生バイト）。不変のファイルで、取りこぼしは別途 `pushFailure` が記録する',
  },
  {
    file: 'archive-cache.mjs',
    call: 'fs.writeFileSync(tmp, gz)',
    why: '同じ控えの書き出し（一時ファイルへ出してから rename する形の途中）',
  },
  {
    file: 'fetch-p2p-history.mjs',
    call: "fs.readFileSync(p, 'utf8')",
    why: 'P2PQuake 履歴の控え（期限付き）。同じスクリプトが書いて同じスクリプトが読む',
  },
  {
    file: 'fetch-p2p-history.mjs',
    call: 'fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), items }))',
    why: '同じ控えの書き出し（一時ファイルへ出してから rename する形の途中）',
  },

  // --- 実電文そのもの（ファイルの山。印は収集の札が運ぶ → `collection-mark.mjs`） ---
  {
    file: 'coverage-core.mjs',
    call: "fs.readFileSync(path.join(CACHE, f), 'utf8')",
    why: '集めた実電文の XML。収集の取りこぼしは札が運ぶ',
  },
  {
    file: 'testdata-shapes.mjs',
    call: "fs.readFileSync(path.join(CACHE, f), 'utf8')",
    why: '集めた実電文の XML を本物のパーサーへ流すために読む。収集の取りこぼしは札が運ぶ',
  },
  {
    file: 'testdata-shapes.mjs',
    call: 'fs.readFileSync(path.join(CACHE, p.f))',
    why: '推計震度分布図の二進電文（分割配信の断片）。JSON ではないので印を載せる場所が無い',
  },
  {
    file: 'header-survey.mjs',
    call: "fs.readFileSync(path.join(DIR, f), 'utf8')",
    why: '集めた実電文を実装を通さず直接読む（ヘッダの中身を種別ごとに並べるため）',
  },
  {
    file: 'dmdataCoverage.probe.test.ts',
    call: "fs.readFileSync(path.join(CACHE, f), 'utf8')",
    why: '集めた実電文を計測台が本物のパーサーへ流すために読む',
  },
  {
    file: 'fetch-samples.mjs',
    call: 'fs.writeFileSync(path.join(CACHE, n), b)',
    why: '集めた実電文の書き出し。印はこの走査の札（`_collection-samples.json`）が持つ',
  },
  {
    file: 'fetch-rare-samples.mjs',
    call: "fs.writeFileSync(path.join(CACHE, 'big-' + n), b)",
    why: '名指しで集めた実電文の書き出し（条件付きの要素を持つ緊急地震速報）。印は対象ごとの札が持つ',
  },
  {
    file: 'fetch-rare-samples.mjs',
    call: 'fs.writeFileSync(path.join(CACHE, n), b)',
    why: '名指しで集めた実電文の書き出し（推計震度分布図・発表頻度の低い種別）。印は対象ごとの札が持つ',
  },

  // --- リポジトリ内のソース・資料（作業ディレクトリの外） ---
  {
    file: 'coverage-core.mjs',
    call: 'fs.readFileSync(`${REPO}/src/services/dmdataParser.ts`, \'utf8\')',
    why: '実装のソース。計測の来歴（パーサーの内容のハッシュ）に使う',
  },
  {
    file: 'triage.mjs',
    call: 'fs.readFileSync(`${REPO}/src/services/dmdataParser.ts`, \'utf8\')',
    why: '同上（計測が古くないかの照合）',
  },
  {
    file: 'dmdataCoverage.probe.test.ts',
    call: "fs.readFileSync(PARSER_PATH, 'utf8')",
    why: '同上（来歴を焼き込む側）',
  },
  {
    file: 'testdata-compare.mjs',
    call: "fs.readFileSync(file, 'utf8')",
    why: '`p2pquake.ts` / `kyoshin.ts` のソース。TypeScript の AST を読むため',
  },
  {
    file: 'coverage-core.mjs',
    call: "fs.readFileSync(path.join(WORK, 'eq_manual.txt'), 'utf8')",
    why: '解説資料のテキスト。JSON ではないので印を載せる場所が無く、読めなければ例外で止まる',
  },
  {
    file: 'archive-cache.mjs',
    call: "fs.readFileSync(envPath, 'utf8')",
    why: '`.env.local` から API キーを読む。読めなければ例外で止まる',
  },

  // --- 人が読むレポート（印は本文へ `incompletenessBanner` で入れてある） ---
  {
    file: 'testdata-compare.mjs',
    call: "fs.writeFileSync(path.join(WORK, 'testdata-report.md'), out.join('\\n'))",
    why: '突き合わせレポート。印は本文の冒頭と E 節に入れてある',
  },
  {
    file: 'triage.mjs',
    call: "fs.writeFileSync(path.join(WORK, 'triage-result.txt'), out.join('\\n'), 'utf8')",
    why: '点検の結果。印は本文の「入力の取りこぼし」節に入れてある',
  },
  {
    file: 'compare-quake-times.mjs',
    call: "fs.writeFileSync(path.join(DATA, `report-${file}.txt`), text)",
    why: '集計レポート。印は本文の冒頭に入れてある',
  },
  {
    file: 'compare-quake-times.mjs',
    call: "fs.readFileSync(path.join(DATA, `${file}.jsonl`), 'utf8')",
    why: '抽出結果の羅列（1 行 1 電文）。印を載せる場所が無いので、対になる `meta.json` が運ぶ',
  },
  {
    file: 'fetch-quake-times.mjs',
    call: 'fs.createWriteStream(outPath)',
    why: '抽出結果を 1 行 1 電文で書き出す（全期間で数十万行になるため少しずつ流す）。'
      + '印は対になる `meta.json` が運ぶ',
  },
]

/**
 * **`fs` の中身を名前で取り出している箇所**を返す（別名インポート・分割代入・ブラケット記法・
 * 呼び出し以外の位置でのプロパティ参照）。
 *
 * **これが無いと `ioCalls` は名前を付け替えるだけで抜けられる。**
 * `import { readFileSync as rfs } from 'node:fs'` としてから `rfs(p)` を呼ぶと、
 * 呼び出し箇所の識別子は `rfs` なので `IO_NAMES` に当たらない。
 * 追いかける（束縛を辿る）のではなく、**取り出すこと自体を禁じる**ことで塞ぐ ——
 * 辿る形にすると「どこまで辿れるか」の穴がまた開く。
 *
 * ここに挙がるものは許可リストを持たない。`fs.readFileSync(...)` の形で直接呼べば済むので、
 * 名前を付け替える理由が無い。
 */
export function ioIndirections(source: string, fileName = 'x.mjs'): string[] {
  const src = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const text = (n: ts.Node) => n.getText().replace(/\s+/g, ' ')
  const visit = (n: ts.Node): void => {
    // import { readFileSync } from 'node:fs' / import { readFileSync as rfs } from 'node:fs'
    if (ts.isImportSpecifier(n)) {
      const original = (n.propertyName ?? n.name).text
      if (IO_NAMES.has(original)) out.push(text(n.parent.parent.parent))
    }
    // const { readFileSync } = fs / const { readFileSync: rfs } = fs
    if (ts.isBindingElement(n)) {
      const original = n.propertyName && ts.isIdentifier(n.propertyName)
        ? n.propertyName.text
        : (ts.isIdentifier(n.name) ? n.name.text : '')
      if (IO_NAMES.has(original)) out.push(text(n))
    }
    // fs['readFileSync'](...)
    if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression
      if (arg && ts.isStringLiteralLike(arg) && IO_NAMES.has(arg.text)) out.push(text(n))
    }
    // const rfs = fs.readFileSync （呼び出しではない位置での参照）
    if (ts.isPropertyAccessExpression(n) && IO_NAMES.has(n.name.text)) {
      const p = n.parent
      const isCallee = p && ts.isCallExpression(p) && p.expression === n
      if (!isCallee) out.push(text(n))
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return out
}

/** ファイル内の読み書き呼び出しを、字面（空白を潰したもの）で返す。 */
export function ioCalls(source: string, fileName = 'x.mjs'): string[] {
  const src = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression
      const name = ts.isPropertyAccessExpression(e)
        ? e.name.text
        : (ts.isIdentifier(e) ? e.text : null)
      if (name && IO_NAMES.has(name)) out.push(n.getText().replace(/\s+/g, ' '))
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return out
}

function targets(): string[] {
  const audit = readdirSync(AUDIT_DIR)
    .filter(f => f.endsWith('.mjs'))
    .map(f => join(AUDIT_DIR, f))
  return [...audit, ...EXTRA_TARGETS]
}

function isAllowed(file: string, call: string): boolean {
  return ALLOWED.some(a => file.endsWith(a.file) && a.call === call)
}

describe('不完全さの印を運ぶ経路を迂回しない', () => {
  // 正: 許可していない読み書きが 1 つも無いこと
  it('ファイルの読み書きはすべて、ヘルパー経由か理由付きの許可を持つ', () => {
    const offenders: string[] = []
    for (const file of targets()) {
      for (const call of ioCalls(readFileSync(file, 'utf8'), file)) {
        if (isAllowed(file, call)) continue
        offenders.push(`${file}\n    ${call}`)
      }
    }

    expect(
      offenders,
      'ファイルの読み書きが増えています。中間成果物なら `scripts/lib/incompleteness.mjs` の\n'
      + '`readArtifact` / `writeArtifact` を通してください（読んだ時点で不完全さの印が\n'
      + '自分の台帳へ入り、書くときに自動で出ていきます）。\n'
      + 'そうでないなら、このテストの ALLOWED へ**理由付きで**足してください。',
    ).toEqual([])
  })

  // 正: **名前を付け替えて呼び出し箇所から `fs` を隠す書き方が無いこと。**
  // これが無いと、上の検査は `import { readFileSync as rfs }` ひとつで抜けられる
  it('fs の中身を名前で取り出していない（呼び出しの形を隠さない）', () => {
    const offenders: string[] = []
    for (const file of targets()) {
      for (const hit of ioIndirections(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${file}\n    ${hit}`)
      }
    }

    expect(
      offenders,
      '`fs` の読み書きを別名・分割代入・ブラケット記法で取り出しています。\n'
      + '`fs.readFileSync(...)` のように直接呼んでください —— 名前を付け替えると、\n'
      + '上の検査（呼び出しの名前で拾う）が効かなくなります。',
    ).toEqual([])
  })

  // 安全弁: **この検査自身が何も検出しない形になっていないこと。**
  // 走査対象が空になる・AST の判定が壊れるといった壊れ方は、上のテストが通り続けるので
  // 気づけない（「何も見つからなかった」と「見ていない」が同じ結果になる）
  it('検査そのものが素通りしない', () => {
    // 1 行の単純な形
    expect(ioCalls("const s = fs.readFileSync(p, 'utf8')")).toHaveLength(1)

    // **複数行に分けても拾う**（最初の実装はここで素通りした）
    expect(ioCalls('const S = JSON.parse(\n  fs.readFileSync(\n    histPath,\n    "utf8"\n  )\n)')).toHaveLength(1)

    // **変数を経由しても拾う**（呼び出しの名前しか見ていないので引数の書き方に依存しない）
    expect(ioCalls('const raw = fs.readFileSync(p)\nconst S = JSON.parse(raw)')).toHaveLength(1)

    // **非同期版も拾う**
    expect(ioCalls('const raw = await fs.promises.readFile(p)')).toHaveLength(1)
    expect(ioCalls("await writeFile(p, JSON.stringify(x))")).toHaveLength(1)

    // 対照: コメントの中は拾わない（AST なので当然だが、壊れたときに気づけるよう固定する）
    expect(ioCalls("// fs.readFileSync(p, 'utf8')")).toHaveLength(0)
    // 対照: 別の fs 呼び出しは拾わない
    expect(ioCalls('fs.readdirSync(dir)\nfs.mkdirSync(dir)\nfs.rmSync(p)')).toHaveLength(0)

    // **名前を付け替える形は `ioIndirections` が拾う**（`ioCalls` は拾えない）
    const aliasCases = [
      "import { readFileSync as rfs } from 'node:fs'\nrfs(p)",
      "import { readFileSync } from 'node:fs'\nreadFileSync(p)",
      'const { readFileSync: rfs } = fs\nrfs(p)',
      'const { writeFileSync } = fs',
      "fs['readFileSync'](p, 'utf8')",
      'const rfs = fs.readFileSync',
    ]
    for (const src of aliasCases) {
      expect(ioIndirections(src), `隠す書き方を拾えていません: ${src}`).not.toHaveLength(0)
    }
    // 対照: 直接呼ぶ形は「隠している」に数えない（そちらは `ioCalls` の担当）
    expect(ioIndirections("fs.readFileSync(p, 'utf8')")).toHaveLength(0)
    expect(ioIndirections("import fs from 'node:fs'")).toHaveLength(0)

    // 走査対象が空になっていないこと（対象の解決が壊れると上のテストが無条件で通る）
    expect(targets().length).toBeGreaterThan(5)
  })

  // 安全弁: 許可リストが実態から外れたまま残らないこと。
  // **対象の呼び出しが消えた許可は、次に同じ形が現れたとき黙って通す**
  it('許可リストの項目は実在し、理由が書いてある', () => {
    const seen = new Map<string, string[]>()
    for (const file of targets()) seen.set(file, ioCalls(readFileSync(file, 'utf8'), file))

    for (const a of ALLOWED) {
      expect(a.why.length, `${a.file} / ${a.call} の許可に理由がありません`).toBeGreaterThan(10)
      const hit = [...seen].some(([file, calls]) => file.endsWith(a.file) && calls.includes(a.call))
      expect(
        hit,
        `許可した呼び出しが見つかりません（実装が変わったなら許可も見直すこと）:\n  ${a.file}\n  ${a.call}`,
      ).toBe(true)
    }
  })
})
