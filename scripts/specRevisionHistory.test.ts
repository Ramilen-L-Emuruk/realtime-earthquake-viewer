import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 仕様書（`docs/spec/*.md`）の改訂履歴は**日付の昇順**で並べる。新しい項は末尾へ足す。
//
// **崩れても型チェックでは捕まらず、人が読むまで残る。** 実際に 3 ファイル
// （settings-pwa / data-sources / map-rendering）で独立に崩れており、いずれも
// 「新しい項を末尾ではなく先頭付近に足した」形だった（2026-08-31 に並べ直した）。
// 主題の近い項の隣へ挿し込みたくなるのが原因で、同じ間違いは繰り返される。混入をここで止める。
//
// 日付が同じ項どうしの順序は見ない（同じ日の変更は前後を機械的に判別できないため）。

const SPEC_DIR = 'docs/spec'

/**
 * 改訂履歴の節から日付を出現順に取り出す。節を持たない仕様書では null を返す。
 *
 * 節の範囲は「改訂履歴」を含む見出しから次の見出しまで。項は行頭の `- YYYY-MM-DD:` で始まる行で、
 * 継続行や本文中の日付（`（2026-08-10 に…）` のような括弧内）は拾わない。
 */
function revisionDates(text: string): string[] | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => /^#{2,}\s.*改訂履歴/.test(l))
  if (start < 0) return null
  const dates: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,}\s/.test(lines[i])) break
    const m = lines[i].match(/^-\s*(\d{4}-\d{2}-\d{2})[:：]/)
    if (m) dates.push(m[1])
  }
  return dates
}

describe('仕様書の改訂履歴', () => {
  const files = readdirSync(SPEC_DIR).filter(n => n.endsWith('.md'))

  // パスを取り違えると、以下の検査が 1 件も走らないまま緑になる。
  it('検査対象の仕様書が見つかる', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s の改訂履歴が日付の昇順である', name => {
    const dates = revisionDates(readFileSync(join(SPEC_DIR, name), 'utf8'))
    // 改訂履歴の節そのものを持たない文書もある（設計書・README のほか、
    // action-checklist / kyoshin-detection / share-card のように節を置いていない仕様書も含む）。
    if (dates === null) return
    const firstBad = dates.findIndex((d, i) => i > 0 && d < dates[i - 1])
    expect(
      firstBad,
      firstBad < 0 ? '' : `${dates[firstBad - 1]} のあとに ${dates[firstBad]} が来ている（新しい項は末尾へ足す）`,
    ).toBe(-1)
  })
})
