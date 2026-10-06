import { describe, expect, it } from 'vitest'

import { buildAdminConsoleAssets } from './adminConsoleAssets'
import type { AdminConsoleAssets } from './adminConsoleAssets'

// **ビルドはファイル読み込み時に済ませ、テスト本体ではビルドしない。** 1 回のビルドは管理コンソールを
// 丸ごと esbuild でまとめ直す重い処理で、全テストファイルを並列実行すると他のワーカーと CPU を
// 取り合って伸びる。テスト本体の中でビルドすると、その伸びが所要時間に乗って既定の 5 秒を超える
// （実測: 最初の 1 回が 5707ms で時間切れ。最初の 1 回だけを先に済ませても、高負荷のときは 2 回目以降の
// ビルドが 5 秒を超えた）。読み込み時なら testTimeout の対象から外れる。
//
// **2 回ビルドする。** 2 回目は「複数回呼んでも同じ内容を返す」を確かめるためだけのもの。
//
// **ここで投げても握り、結果に持たせる。** 投げるとファイル単位の失敗 1 件として報告され、4 つの検査の
// どれが落ちたのか見えなくなる。各テストが `assetsOf` で投げ直す。
type Built = { readonly ok: true; readonly assets: AdminConsoleAssets } | { readonly ok: false; readonly error: unknown }

function build(): Built {
  try {
    return { ok: true, assets: buildAdminConsoleAssets() }
  } catch (error) {
    return { ok: false, error }
  }
}

function assetsOf(built: Built): AdminConsoleAssets {
  if (!built.ok) throw built.error
  return built.assets
}

const first = build()
const second = build()

describe('buildAdminConsoleAssets（#313 段 C: 管理コンソール本体）', () => {
  it('正: html・js の両方を空でなく返す', () => {
    const assets = assetsOf(first)
    expect(assets.html).toContain('<html')
    expect(assets.html).toContain('app.js')
    expect(assets.js.length).toBeGreaterThan(0)
  })

  it('正: js に app.ts の中身がバンドルされている', () => {
    const assets = assetsOf(first)
    expect(assets.js).toContain('/api/stations')
    expect(assets.js).toContain('/api/boards')
  })

  it('対照: js は素の TypeScript のままではない（型注釈が除去されている）', () => {
    const assets = assetsOf(first)
    // TypeScript 由来の型注釈構文はバンドル後の JS には残らない。
    expect(assets.js).not.toContain(': StationInfo')
  })

  it('安全弁: 複数回呼んでも同じ内容を返す（べき等）', () => {
    const a = assetsOf(first)
    const b = assetsOf(second)
    expect(a.html).toBe(b.html)
    expect(a.js).toBe(b.js)
  })
})
