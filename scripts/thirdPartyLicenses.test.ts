// 同梱する第三者ソフトウェアのライセンス全文（public/third-party-licenses.txt）が、
// 実際に配布物へ入る依存を網羅しているかを検査する。
//
// **依存を足しただけでは誰も気づかない。** MIT・ISC・BSD はいずれも著作権表示と
// ライセンス文を配布物に含めることを条件としているのに、足りなくても型チェックも
// ビルドも通り、画面にも何も出ない。ここで落とす。
//
// **見るのは 3 つ**——網羅（全件が載っているか）・鮮度（版が一致するか）・中身
// （著作権表示があるか）。最初の版は網羅しか見ておらず、`fft-js` の著作権者が
// 空欄のまま「緑」で通っていた。
//
// 落ちたら `npm run build-third-party-licenses` を走らせて生成物を更新すること。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 生成スクリプトから「対象の集合」と「区切り線」を借りる。**書き写さない**——
// 集合の取り方が生成側と食い違うと、この検査が別の集合を見て緑になる。
import {
  NO_COPYRIGHT_HOLDER,
  RULE,
  copyrightHolder,
  findPackageDir,
  resolveProdPackages,
  sourcePathOf,
} from './build-third-party-licenses.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const licenses = readFileSync(join(ROOT, 'public', 'third-party-licenses.txt'), 'utf8')
const packages = resolveProdPackages(ROOT)
const names = [...packages.keys()].sort()

/**
 * `node_modules` が宣言する版。生成物に焼かれた版と突き合わせる。
 *
 * **置き場所は生成側が解決したものを使う。** `<ROOT>/node_modules/<名前>` と組み立てると、
 * git のワークツリー（`node_modules` の実体がメインの checkout にある）で読めずに落ちる。
 */
function installedVersion(name: string): string {
  const dir = packages.get(name)!
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
  return meta.version
}

/**
 * 生成物を 1 依存ぶんのブロックへ割る。
 *
 * 区切り線は**行まるごと一致で探す**（`/^={78}$/m`）。長さだけで `split` すると、
 * ライセンス本文の中に同じ記号が並んだときそこでも切れ、**本文の後半が黙って落ちる**。
 * 落ちた残りが十分長ければ検査は緑のまま通るので、気づく手立てが無い。
 */
const BLOCK_SEPARATOR = new RegExp(`^${RULE}$`, 'm')

function entryOf(name: string): string | null {
  const blocks = licenses.split(BLOCK_SEPARATOR)
  const at = blocks.findIndex((b) => b.includes(`\n${name} `))
  if (at < 0) return null
  return blocks[at] + (blocks[at + 1] ?? '')
}

describe('第三者ライセンスの同梱', () => {
  it('前提: 対象の依存が 1 件以上ある', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  it('前提: 推移的な依存まで辿れている（直接の dependencies だけではない）', () => {
    // `react-dom` は `scheduler` を引く。直接の dependencies だけを見ていた頃は
    // これが漏れていた（バンドルには入る）。
    expect(names).toContain('scheduler')
  })

  it('正: 対象の全件がライセンス一覧に載っている', () => {
    const missing = names.filter((n) => entryOf(n) === null)
    expect(missing, `public/third-party-licenses.txt に無い依存: ${missing.join(', ')}`).toEqual([])
  })

  it('対照: 存在しない依存名では引っかからない（検査が常に真を返していない）', () => {
    expect(entryOf('this-package-does-not-exist')).toBeNull()
  })

  it.each(names)('鮮度: %s の版が node_modules と一致する', (name) => {
    const entry = entryOf(name)
    expect(entry).not.toBeNull()
    expect(entry, `${name} の版が生成物と食い違う（再生成してください）`).toContain(
      `\n${name} ${installedVersion(name)}\n`,
    )
  })

  it.each(names)('安全弁: %s のライセンス本文が中身を持っている', (name) => {
    const entry = entryOf(name)!
    // 見出し 3 行（名前・SPDX・出どころ）を除いた本文が、ライセンス文として成立する長さか。
    // いちばん短い ISC でも 700 字を超える。
    expect(entry.length).toBeGreaterThan(400)
    // **著作権者を読み取れること。** 生成側が `Copyright (c) ` まで書いて名前を入れ損ねる形を
    // 落とす（実際に `fft-js` でそうなっていた）。
    //
    // 判定は生成側の `copyrightHolder` を借りる。**この検査は 2 度すり抜けている**ので、
    // 同じ述語を両側で使って食い違いを作らない。
    //   1 度目: 文全体へ `/copyright\s*(\(c\)|©)?\s*(.*)/i` を当てた版。`\s` が改行を食い、
    //           `Copyright (c) ` の次の行にある「Permission is hereby granted...」を拾っていた
    //   2 度目: 行頭一致だけで探した版。免責条項が折り返した
    //           `COPYRIGHT HOLDERS BE LIABLE...` を著作権者として拾っていた（`minimist`）
    const holder = copyrightHolder(entry)
    if (NO_COPYRIGHT_HOLDER.has(name)) {
      // **両方向で見る。** 上流が書くようになったら、この列挙から外す合図。
      expect(
        holder,
        `${name} は上流が著作権者を書いていない前提だが、書かれている。NO_COPYRIGHT_HOLDER から外すこと`,
      ).toBeNull()
    } else {
      expect(holder, `${name} のライセンス文から著作権者を読み取れない`).not.toBeNull()
    }
  })

  it('安全弁: 手で書き換えたときに気づけるよう、生成物である旨が残っている', () => {
    expect(licenses).toContain('自動生成しています')
  })
})

// 上の検査は「いま `node_modules` に実在する依存」を経由した間接の確認でしかない。
// **それだけだと、直した穴を再現するパッケージが依存グラフから外れた瞬間に、
// 回帰を検出する手段がリポジトリから消える**（`minimist` が閉包から抜ければ
// `NO_COPYRIGHT_HOLDER` からもテスト対象からも静かに居なくなる）。
// 文面を固定して、述語そのものを直接確かめる。
describe('copyrightHolder（述語そのもの）', () => {
  /** 許諾条項より前に著作権表示がある、ありふれた形。 */
  const MIT_WITH_HOLDER = [
    'MIT License',
    '',
    'Copyright (c) 2018 Example Author',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software ...',
    '',
    'IN NO EVENT SHALL THE AUTHORS OR',
    'COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER',
    'IN AN ACTION OF CONTRACT, TORT OR OTHERWISE.',
  ].join('\n')

  /**
   * 著作権表示が 1 行も無い形（`minimist` の LICENSE がこれ）。
   *
   * **免責条項の折り返しで `COPYRIGHT HOLDERS BE LIABLE...` が行頭へ来る。**
   * 行頭一致だけで探すと、これを著作権者として拾って検査が素通りした。
   */
  const MIT_WITHOUT_HOLDER = [
    'This software is released under the MIT license:',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of',
    'this software ...',
    '',
    'IN NO EVENT SHALL THE AUTHORS OR',
    'COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER',
    'IN AN ACTION OF CONTRACT, TORT OR OTHERWISE.',
  ].join('\n')

  it('正: 許諾条項より前の著作権表示から名前を取り出す', () => {
    expect(copyrightHolder(MIT_WITH_HOLDER)).toBe('Example Author')
  })

  it('対照: 免責条項の「COPYRIGHT HOLDERS BE LIABLE」を著作権者として拾わない', () => {
    expect(copyrightHolder(MIT_WITHOUT_HOLDER)).toBeNull()
  })

  it('安全弁: 著作権表示はあるが名前が空なら読み取れないと答える', () => {
    // 生成側が `Copyright (c) ` まで書いて名前を入れ損ねた形（`fft-js` で実際に起きた）。
    // **`\s` が改行も食う正規表現だと、次の行の許諾文を名前として拾ってしまう。**
    const empty = MIT_WITH_HOLDER.replace('Copyright (c) 2018 Example Author', 'Copyright (c) ')
    expect(copyrightHolder(empty)).toBeNull()
  })

  it('安全弁: 「The above copyright notice ...」は著作権表示として扱わない', () => {
    const noticeOnly = [
      'Permission is hereby granted, free of charge, ...',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
    ].join('\n')
    expect(copyrightHolder(noticeOnly)).toBeNull()
  })

  it.each([
    ['年の範囲', 'Copyright (c) 2016-2024 Example Org', 'Example Org'],
    ['年の列挙', 'Copyright (c) 2016, 2024 Example Org', 'Example Org'],
    ['(c) なし', 'Copyright 2018 Google LLC', 'Google LLC'],
    ['年なし', 'Copyright (c) Example Author', 'Example Author'],
  ])('正: 著作権表示の書き方の揺れ（%s）を吸収する', (_label, line, expected) => {
    expect(copyrightHolder(`${line}\n\nPermission is hereby granted, ...`)).toBe(expected)
  })
})

// 上の検査は、走らせた端末の `node_modules` がたまたまフラットに置かれていることに頼っている。
// **ワークツリーで落ちていたのは、その置き場所を `<root>/node_modules/<名前>` と決め打ちしていたため**
// （ワークツリーの `node_modules` は空で、実体はメインの checkout にある）。
// 実物の配置では再現できない形（入れ子・版の衝突）があるので、一時ディレクトリに組んで確かめる。
describe('依存の置き場所の解決', () => {
  let tmp: string

  /** `<dir>/node_modules/<名前>/package.json` を置く。 */
  function pkg(dir: string, name: string, version: string, dependencies: Record<string, string> = {}) {
    const at = join(dir, 'node_modules', name)
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, 'package.json'), JSON.stringify({ name, version, dependencies }))
    return at
  }

  function project(dir: string, dependencies: Record<string, string>) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies }))
    return dir
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'third-party-licenses-'))
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('正: 起点に node_modules が無くても、親の node_modules まで遡って見つける（ワークツリーの形）', () => {
    const repo = join(tmp, 'ascend')
    const a = pkg(repo, 'a', '1.0.0')
    const worktree = project(join(repo, '.claude', 'worktrees', 'w'), { a: '*' })
    expect(resolveProdPackages(worktree).get('a')).toBe(a)
  })

  it('正: 依存の依存は、それを必要としている側の入れ子を先に見る', () => {
    const repo = join(tmp, 'nested')
    pkg(repo, 'a', '1.0.0', { b: '*' })
    const nestedB = pkg(join(repo, 'node_modules', 'a'), 'b', '2.0.0')
    const root = project(repo, { a: '*' })
    expect(resolveProdPackages(root).get('b')).toBe(nestedB)
  })

  it('対照: 入れ子にしか無いものは、外からは見えない', () => {
    // 上の配置で b を持つのは a の中だけ。プロジェクトの起点から探して当たるなら、
    // 解決が入れ子の中まで潜り込んでいる（Node の解決と違う）。
    expect(findPackageDir('b', join(tmp, 'nested'))).toBeNull()
  })

  it('安全弁: 同じ名前が 2 か所に解決されたら、どちらかを黙って採らずに止める', () => {
    const repo = join(tmp, 'conflict')
    pkg(repo, 'a', '1.0.0', { b: '*' })
    pkg(join(repo, 'node_modules', 'a'), 'b', '2.0.0')
    pkg(repo, 'b', '1.0.0')
    pkg(repo, 'c', '1.0.0', { b: '*' })
    const root = project(repo, { a: '*', c: '*' })
    expect(() => resolveProdPackages(root)).toThrow(/2 か所に解決/)
  })

  it('安全弁: どこまで遡っても無ければ止める（黙って閉包から落とさない）', () => {
    const root = project(join(tmp, 'missing'), { 'no-such-package-xyz': '*' })
    expect(() => resolveProdPackages(root)).toThrow(/no-such-package-xyz: node_modules に見当たりません/)
  })

  it('正: 出どころは最初の node_modules から先だけを書く（走らせた checkout で変わらない）', () => {
    const repo = join(tmp, 'source')
    const a = pkg(repo, 'a', '1.0.0')
    const nested = pkg(a, 'b', '1.0.0')
    expect(sourcePathOf(a, 'LICENSE')).toBe('node_modules/a/LICENSE')
    expect(sourcePathOf(nested, 'LICENSE')).toBe('node_modules/a/node_modules/b/LICENSE')
  })
})
