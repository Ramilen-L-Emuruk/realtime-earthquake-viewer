#!/usr/bin/env node
// Scratch 3.0 プロジェクトのブロック定義を取得・展開する道具。
// 使い方は同ディレクトリの SKILL.md を参照。
import { writeFileSync, readFileSync } from 'node:fs'

const [cmd, ...rest] = process.argv.slice(2)

// プロジェクトページの URL を渡されても通るようにする。
// **採るのは最後の数字列。** 最初の数字列を採ると、`/studios/12345/projects/636244032` の
// ような URL で studio の番号を掴み、エラーも出さずに別プロジェクトを読み込む。
// クエリとフラグメント（`#comments-98765` 等）は先に落とす。
// 限界: ID の後ろにさらに数字のセグメントが続く URL では後ろを採ってしまう。
// 共有・編集・studio 経由のいずれの形でも起きないため、この取り方で足りる。
function toProjectId(arg) {
  if (arg === undefined) throw new Error('プロジェクトの URL または ID を指定してください')
  const id = String(arg).split(/[?#]/)[0].match(/\d{2,}/g)?.pop()
  if (!id) throw new Error(`プロジェクト ID を読み取れません: ${arg}`)
  return id
}

// 端末へ出す前に制御文字を落とす。プロジェクト名・変数名・作者の説明文は外部の誰かが
// 自由に書ける値で、ANSI エスケープや改行が混ざると 1 ヒット 1 行の前提が崩れる。
const plain = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
// 改行とタブを保つ版。複数行が本来の形である説明文に使う（潰すと読めなくなる）。
const plainText = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')

// --- 取得 -------------------------------------------------------------------
async function fetchMeta(id) {
  const res = await fetch(`https://api.scratch.mit.edu/projects/${id}`)
  // ok を見ずに .json() を呼ぶと、5xx やレート制限で返る HTML が JSON パースエラーになり、
  // 「非公開かもしれない」という本来の見立てへ辿り着けない。
  if (!res.ok) throw new Error(`メタ情報の取得に失敗: HTTP ${res.status}`)
  return res.json()
}

// project_token は発行から数分で失効するため、メタ取得と本体取得は必ず続けて行う。
async function fetchProject(id, out) {
  const meta = await fetchMeta(id)
  if (!meta.project_token) throw new Error(`project_token を取得できません（非公開・削除済み・ID 誤り）: ${JSON.stringify(meta).slice(0, 200)}`)
  const res = await fetch(`https://projects.scratch.mit.edu/${id}?token=${meta.project_token}`)
  if (!res.ok) throw new Error(`project.json の取得に失敗: HTTP ${res.status}`)
  writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  return meta
}

// --- 読み込み ---------------------------------------------------------------
// PowerShell 5.1 の ConvertFrom-Json はキーの大文字小文字を区別せず重複キーで落ちる。
// Node の JSON.parse を使うのはそのため。
const load = path => {
  // パスを渡し忘れると readFileSync が Node の生エラーを投げ、何を忘れたか判らない。
  if (!path) throw new Error('project.json のパスを指定してください（fetch で取得したファイル）')
  return JSON.parse(readFileSync(path, 'utf8'))
}

const findTarget = (proj, name) => {
  const t = proj.targets.find(t => t.name === name)
  if (!t) throw new Error(`ターゲットが見つかりません: ${name}（候補: ${proj.targets.map(t => plain(t.name)).join(', ')}）`)
  return t
}

// --- ブロックの整形 ---------------------------------------------------------
// inputs の形は [shadowType, value] または [3, value, fallback]（3 は「ブロックを差し込んで
// あるが、抜いたときのリテラルも保持している」状態）。value と fallback には
//   [4..8, "10"]        リテラル（数値・文字列）
//   [12, "名前", "id"]  変数参照
//   [13, "名前", "id"]  リスト参照
//   "blockId"           入れ子のブロック（レポーター）
// のいずれかが入る。
//
// **変数・リストは blocks マップに実体を持たず、inputs へ配列のまま埋め込まれる。**
// そのため shadowType 3 でも value がブロック ID とは限らず、実データでは 3 の 2 割弱が
// value 自身が [12,...] の配列だった。「value はブロック、fallback はリテラル」と
// 決めつけると読み違える。

// 深さ上限は**壊れたデータの暴走を止める安全弁**で、表示できる深さの上限ではない。
// renderBlock -> renderInput -> renderBlock の 2 ホップで数えるため、入れ子 1 段につき 2 増える。
// 実データでは 1 スプライトで depth 30（`operator_join` を 15 段連ねてレコードを組む処理）に
// 達していた。正常な入れ子を切らないよう、実測値から十分に離した値を置く。
const MAX_DEPTH = 500

function renderInput(blocks, input, depth = 0) {
  if (input == null) return '?'
  const [, value, fallback] = input
  if (typeof value === 'string' && blocks[value]) return `(${renderBlock(blocks, value, depth + 1)})`
  const cell = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : null
  if (!cell) return String(value)
  if (cell[0] === 12) return `var:${plain(cell[1])}`
  if (cell[0] === 13) return `list:${plain(cell[1])}`
  return JSON.stringify(cell[1])
}

// カスタムブロックは opcode が procedures_call / procedures_definition で共通のため、
// mutation.proccode（例: `読み上げ %s 追加 %s`）を名前として使う。定義側は入れ子の
// procedures_prototype が proccode を持つ。
function renderBlock(blocks, id, depth = 0) {
  const b = blocks[id]
  if (!b) return `<欠落 ${id}>`
  // 壊れた project.json が入れ子で自分を指していると再帰が止まらないため、深さで打ち切る。
  if (depth > MAX_DEPTH) return `<深すぎ ${b.opcode}>`
  if (b.opcode === 'procedures_definition') {
    const proto = blocks[b.inputs?.custom_block?.[1]]
    return `define ${plain(proto?.mutation?.proccode ?? '?')}`
  }
  if (b.opcode === 'procedures_call') {
    // 引数は argumentids の順に inputs へ入る。proccode の %s / %b / %n を実引数で埋める。
    const ids = JSON.parse(b.mutation?.argumentids ?? '[]')
    const values = ids.map(i => renderInput(blocks, b.inputs?.[i], depth + 1))
    let n = 0
    const filled = plain(b.mutation?.proccode ?? '?').replace(/%[sbn]/g, () => values[n++] ?? '?')
    return `call ${filled}`
  }
  const args = [
    ...Object.entries(b.fields ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v[0])}`),
    ...Object.entries(b.inputs ?? {})
      .filter(([k]) => !['SUBSTACK', 'SUBSTACK2'].includes(k))
      .map(([k, v]) => `${k}=${renderInput(blocks, v, depth + 1)}`),
  ]
  return `${b.opcode}${args.length ? ' ' + args.join(' ') : ''}`
}

// スクリプト（積み上がったブロック列）を字下げして出す。
// if や repeat の中身は `SUBSTACK:` の見出し行を挟み、その下をさらに 1 段下げて出す。
// visited は循環したデータで無限に回らないための歯止め（正常な木では循環しない）。
function dumpStack(blocks, id, depth, outLines, visited = new Set()) {
  let cur = id
  while (cur) {
    if (visited.has(cur)) {
      outLines.push('  '.repeat(depth) + `<循環検出 ${cur}>`)
      return
    }
    visited.add(cur)
    const b = blocks[cur]
    if (!b) break
    outLines.push('  '.repeat(depth) + renderBlock(blocks, cur))
    for (const key of ['SUBSTACK', 'SUBSTACK2']) {
      const sub = b.inputs?.[key]
      if (sub && typeof sub[1] === 'string') {
        outLines.push('  '.repeat(depth) + `  ${key}:`)
        dumpStack(blocks, sub[1], depth + 2, outLines, visited)
      }
    }
    cur = b.next
  }
}

// --- サブコマンド -----------------------------------------------------------
if (cmd === 'fetch') {
  const [arg, out = 'project.json'] = rest
  const meta = await fetchProject(toProjectId(arg), out)
  console.log(`${plain(meta.title)} / @${plain(meta.author?.username)} / 更新 ${meta.history?.modified}`)
  console.log(`→ ${out}`)
} else if (cmd === 'meta') {
  // 作者の説明文（instructions）は project.json には入らない。読むならこちら。
  const meta = await fetchMeta(toProjectId(rest[0]))
  console.log(`title: ${plain(meta.title)}`)
  console.log(`author: @${plain(meta.author?.username)}`)
  console.log(`created ${meta.history?.created} / modified ${meta.history?.modified}`)
  console.log(`--- instructions\n${plainText(meta.instructions) || '(なし)'}`)
  if (meta.description) console.log(`--- description\n${plainText(meta.description)}`)
} else if (cmd === 'targets') {
  const proj = load(rest[0])
  for (const t of proj.targets) {
    console.log(`${t.isStage ? '[Stage] ' : '[Sprite]'} ${plain(t.name)}: blocks ${Object.keys(t.blocks).length}, vars ${Object.keys(t.variables).length}, lists ${Object.keys(t.lists).length}, comments ${Object.keys(t.comments ?? {}).length}`)
  }
} else if (cmd === 'names') {
  // 変数名・リスト名・コメント本文から当たりを付ける。全ブロック走査より先にこれを見る。
  const [path, pattern] = rest
  const re = new RegExp(pattern ?? '.', 'i')
  for (const t of load(path).targets) {
    const hits = [
      ...Object.values(t.variables).map(v => `var ${plain(v[0])}`),
      ...Object.values(t.lists).map(v => `list ${plain(v[0])}`),
      ...Object.values(t.comments ?? {}).map(c => `comment ${plain(c.text).replace(/\s+/g, ' ').slice(0, 300)}`),
    ].filter(s => re.test(s))
    if (hits.length) console.log(`=== ${plain(t.name)}\n` + hits.map(s => '  ' + s).join('\n'))
  }
} else if (cmd === 'grep') {
  // ブロック 1 個単位で当てる。出るのはヒットしたブロックの 1 行だけなので、
  // 前後の流れを見るにはヒットした文言を dump の --filter へ渡す。
  const [path, pattern] = rest
  const re = new RegExp(pattern, 'i')
  for (const t of load(path).targets) {
    for (const id of Object.keys(t.blocks)) {
      const line = renderBlock(t.blocks, id)
      if (re.test(line)) console.log(`${plain(t.name)} ${id} ${line}`)
    }
  }
} else if (cmd === 'dump') {
  // ターゲットの全スクリプトを字下げして出す。--filter はスクリプト全体に当てる。
  const [path, name, ...opts] = rest
  const fi = opts.indexOf('--filter')
  const re = fi >= 0 ? new RegExp(opts[fi + 1], 'i') : null
  const t = findTarget(load(path), name)
  const tops = Object.keys(t.blocks).filter(id => t.blocks[id].topLevel)
  for (const id of tops) {
    const lines = []
    dumpStack(t.blocks, id, 0, lines)
    const text = lines.join('\n')
    if (re && !re.test(text)) continue
    console.log(`--- ${plain(t.name)} / ${id}\n${text}\n`)
  }
} else {
  console.log(`使い方:
  node scratch-blocks.mjs fetch   <URL または ID> [out.json]
  node scratch-blocks.mjs meta    <URL または ID>
  node scratch-blocks.mjs targets <project.json>
  node scratch-blocks.mjs names   <project.json> [正規表現]
  node scratch-blocks.mjs grep    <project.json> <正規表現>
  node scratch-blocks.mjs dump    <project.json> <ターゲット名> [--filter 正規表現]`)
}
