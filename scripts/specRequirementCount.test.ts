import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// `data-sources-spec.md` §2「配信元が定める要件」は、配信元の一次資料から数え上げた要件を
// A〜I の表で全部並べている。本文はその件数を「N 項目」と名乗る。
//
// **数が合わなくなっても、型チェックにもリンタにも掛からない。** そして**この節は
// 「機械的に数え上げた」ことを主張の核にしている** —— 語で拾う方式で 2 度漏らした経緯まで
// 書いてあるので、その数自体が合っていないと節ごと信用を失う。
//
// 実際に食い違っていた（2026-09-17 のドキュメント客観レビューで発覚。表は 44 行なのに
// 本文は 3 箇所そろって「45 項目」と書いていた）。項目を足し引きするときに本文を直し忘れる
// のが原因で、同じ間違いは繰り返される。混入をここで止める。

const SPEC = 'docs/spec/data-sources-spec.md'

/** 要件表の行（`| A1 | ... |` の形）を数える。群の記号は A〜I。 */
function countRequirementRows(text: string): number {
  return text.split(/\r?\n/).filter(l => /^\|\s*[A-I]\d+\s*\|/.test(l)).length
}

/** 本文が名乗っている件数を、出現順に取り出す。 */
function declaredCounts(text: string): number[] {
  return [...text.matchAll(/(\d+)\s*項目/g)].map(m => Number(m[1]))
}

describe('配信元が定める要件の件数', () => {
  const text = readFileSync(SPEC, 'utf8')

  // 正: 表の行数と、本文が名乗る件数が一致する。
  it('表の行数と本文の「N 項目」が一致する', () => {
    const rows = countRequirementRows(text)
    const declared = declaredCounts(text)

    // 名乗っている箇所が 1 つも無いなら、この検査は何も守っていない（節を作り替えたときに
    // 黙って無効になるのを防ぐ）
    expect(declared.length).toBeGreaterThan(0)
    for (const n of declared) expect(n).toBe(rows)
  })

  // 安全弁: 表そのものが消えていないこと。
  // **上の検査は「表 0 行・本文 0 箇所」でも通る** ——「一致している」の判定だけでは、
  // 節ごと失われたことに気づけない。
  it('要件の表が残っている', () => {
    expect(countRequirementRows(text)).toBeGreaterThan(30)
  })
})

/**
 * ページを辿るループの上限は、仕様書の表が単一情報源。
 *
 * **実装に定数を足しても、表に行を足し忘れても、型チェックには掛からない。**
 * 実際に食い違っていた（`ACTIVE_EEW_MAX_PAGES` が表に無く、本文は「5 箇所」と書いていた。
 * しかもその経路は同じ変更で門を足した先で、**直した当人が数え漏らしていた**）。
 *
 * ここで見るのは「実装にある定数が全部表に載っているか」だけ。ページ数・1 ページの件数・
 * 達したときの扱いは表の列が持つので、そこまでは照合しない（値を変えるときは表も見ること）。
 */
describe('ページを辿るループの上限', () => {
  /**
   * 走査するファイルを列挙する（ディレクトリの列挙だけは同期のまま。中身を読まないので軽い）。
   *
   * **`src` 配下を再帰で走査する。** いまは全部 `src/services` 直下にあるが、そこだけを見る
   * 形では**別のディレクトリへ足したときに黙って通る** —— 「機械的に数え上げたつもりで対象を
   * 取りこぼす」形（CLAUDE.md「調査レビュー」が挙げている失敗）そのものになる。
   */
  function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        listSourceFiles(p, out)
        continue
      }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue
      if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue
      out.push(p)
    }
    return out
  }

  /**
   * 実装にある `*_MAX_PAGES` / `MAX_PAGES_*` の定数名を集める。
   *
   * **ファイルを 1 件ずつ順番に読まない。** 対象は 236 件・4.49MB（2026-09-18 時点）で、
   * `readFileSync` で回すと待ちが件数だけ積み上がる。**並列実行のときだけ既定の 5 秒を超え、
   * 単独で回すと通る**という形で落ちた（`npm test` 全件で時間切れ・単独実行では 4 件とも 2 秒）。
   * `Promise.all` でまとめて投げれば待ちを重ねられる。
   *
   * 上限を延ばす手当て（`{ timeout: 15_000 }`）も、待ちをフックへ逃がす手当て（`beforeAll`）も
   * 採らない。**`npm test` 全件のなかでこのテストは 504 / 164 / 92ms**（2026-09-18・3 回の実測）で
   * **最も遅い回でも** 5 秒に対して 9 倍以上の余裕があるうえ、枠を緩めると**このテストに入り込んだ
   * 性能劣化を見逃す網**になる（`vitest.config.ts` が既定の 5 秒を据え置いている理由と同じ）。
   *
   * **走査の速さを測り直すときは、方式ごとにプロセスを分けること。** 同じプロセスで同期と
   * 非同期を交互に回すと後のラウンドの同期側が実際より遅く出る（同一プロセスでは 1209ms まで
   * 伸びたが、別プロセスで測ると同期 132〜212ms・非同期 43〜53ms）。**判断に使うのは並列実行下の
   * 値**（上記）—— 単体の実測は他ワーカーとの競合が乗らないぶん桁ひとつ小さく出ることがあり、
   * 余裕の根拠にはならない。
   */
  async function pageLimitConstants(root = 'src'): Promise<string[]> {
    const names = new Set<string>()
    const sources = await Promise.all(listSourceFiles(root).map(p => readFile(p, 'utf8')))
    for (const src of sources) {
      for (const m of src.matchAll(/^const (\w*MAX_PAGES\w*) = \d+/gm)) names.add(m[1])
    }
    return [...names].sort()
  }

  // 正: 実装にある定数はすべて表に載っている。
  it('実装の定数がすべて仕様書の表に載っている', async () => {
    const text = readFileSync(SPEC, 'utf8')
    const names = await pageLimitConstants()

    // 1 つも拾えないなら、この検査は何も守っていない（命名を変えたときに黙って無効になるのを防ぐ）
    expect(names.length).toBeGreaterThan(3)
    expect(names.filter(n => !text.includes(n))).toEqual([])
  })

  // 安全弁: 本文が名乗る「N 箇所」が、表に載っている行数と合っている。
  // **`LIST_MAX_PAGES` は 2 つのループで共有するが、上限としては 1 つ**なので行数で数える。
  it('本文の「N 箇所」が表の行数と一致する', () => {
    const text = readFileSync(SPEC, 'utf8')
    const declared = text.match(/上限を置いているのは (\d+) 箇所/)
    expect(declared).not.toBeNull()

    const rows = text.split(/\r?\n/)
      .filter(l => /^\| `\w*MAX_PAGES\w*` \|/.test(l)).length
    expect(Number(declared![1])).toBe(rows)
  })
})
