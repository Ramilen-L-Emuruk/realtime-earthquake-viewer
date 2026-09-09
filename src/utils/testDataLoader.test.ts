// テストデータの遅延読み込みの入口（`testDataLoader.ts`）。
//
// **確かめたいのは 3 つ**。どれも壊れても画面には何も出ないので、ここで固定する。
//   - 2 回目以降は読み直さない（押すたびに取りに行かない）
//   - **失敗を覚えない**（覚えると、ページを開き直すまで全テストボタンが無反応になる）
//   - 先読みは失敗しても投げない（設定タブを開いただけで画面が壊れない）
//
// 取り込みそのものは引数で差し替える。本物の `./testData` は 800KB 超の JSON を引き込むうえ、
// **モジュールを差し替える方法では回数を数えられない** —— 実行環境が解決済みのモジュールを
// 使い回すので、ファクトリが 1 度しか走らない。
//
// **トップレベルで一度読んでおく** —— テスト本体の中で初めて解決すると、その解決待ちが
// 1 件目の所要時間に丸ごと乗る（→ CLAUDE.md「検証」）。
import { describe, it, expect, vi } from 'vitest'
import './testDataLoader'

type Loader = typeof import('./testDataLoader')

/** 呼ばれた回数を数える差し替え用の取り込み。`fail` が真のあいだは失敗する。 */
function makeImporter() {
  const calls = { count: 0, fail: false }
  const importer = () => {
    calls.count++
    return calls.fail
      ? Promise.reject(new Error('chunk 404'))
      : Promise.resolve({ TEST_AUTO_DISMISS_MS: 90000 } as unknown as typeof import('./testData'))
  }
  return { calls, importer }
}

/** `pending` はモジュールスコープの状態なので、テストごとに作り直す。 */
async function freshLoader(): Promise<Loader> {
  vi.resetModules()
  return await import('./testDataLoader')
}

describe('testDataLoader', () => {
  // 正: 2 回目以降は読み直さない。
  it('2 回目以降は読み込み済みのものを返す', async () => {
    const { loadTestData } = await freshLoader()
    const { calls, importer } = makeImporter()
    const a = await loadTestData(importer)
    const b = await loadTestData(importer)
    expect(a).toBe(b)
    expect(calls.count).toBe(1)
  })

  // 正: **失敗は覚えない。** 握ったままにすると、以後ずっと同じ失敗を返し、ページを
  // 開き直すまで全てのテストボタンが無反応になる。
  it('失敗したら覚えず、次の呼び出しで取り直す', async () => {
    const { loadTestData } = await freshLoader()
    const { calls, importer } = makeImporter()
    calls.fail = true
    await expect(loadTestData(importer)).rejects.toThrow('chunk 404')
    calls.fail = false
    await expect(loadTestData(importer)).resolves.toBeDefined()
    expect(calls.count).toBe(2)
  })

  // 安全弁: 先読みは失敗しても投げない（設定タブを開いただけで画面を壊さない）。
  it('先読みは失敗しても例外を投げない', async () => {
    const { prefetchTestData } = await freshLoader()
    const { calls, importer } = makeImporter()
    calls.fail = true
    expect(() => prefetchTestData(importer)).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
    expect(calls.count).toBe(1)
  })

  // 対照: 先読みしておけば、そのあとの読み込みは取りに行かない（押したときの待ちが無くなる）。
  it('先読みしたあとの読み込みは取りに行かない', async () => {
    const { loadTestData, prefetchTestData } = await freshLoader()
    const { calls, importer } = makeImporter()
    prefetchTestData(importer)
    await loadTestData(importer)
    expect(calls.count).toBe(1)
  })
})
