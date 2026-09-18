import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetArchiveCacheForTest, listArchive, archiveCacheStats, runArchiveScript } from './archive-cache.mjs'
// @ts-expect-error -- 型定義を持たない .mjs（`scripts/lib/stationSource.mjs` と同じ扱い）
import { markResult, incompleteNotes, noteIncomplete } from '../lib/incompleteness.mjs'

// **中身は使わない。** どのテストも `fetch` をスタブするのでネットワークへは出ない。
// 型が要求するので置いてあるだけで、実際のキーとは関係しない。
const auth = { Authorization: 'Basic (テスト)' }

// **レート制御（`gate`）のテストは `scripts/lib/rateGate.test.ts` にある。**
// あの門は DMDATA 専用ではなく取得元ごとに `kind` を分ける汎用の仕組みなので、
// 実装と一緒に `scripts/lib/` へ移した。

// 走査できなかった範囲を、**結果そのもの**へ印として残すこと。
//
// 失敗の内訳は標準エラーへ出るが、これらのスクリプトの出力（標準出力の JSON）だけを
// 保存・受け渡しする運用では見えない。「集めたが 0 件」と「集められなかった」が
// 区別できない形で残ると、それが「この種別は実配信に無い」という主張の根拠になる。
describe('走査の不完全さが結果へ載る', () => {
  beforeEach(() => {
    // **統計も空にする。** 前のテストが残した失敗が見えると、「失敗が無いとき」の
    // 振る舞いを確かめるテストが実行順によって落ちる
    resetArchiveCacheForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // 対照: 失敗が無ければ結果に手を加えない（平常時に余計なキーを混ぜない）
  it('失敗が無ければ結果をそのまま返す', () => {
    expect(archiveCacheStats().failures).toHaveLength(0)

    const result = { VXSE53: 8 }
    expect(markResult(result)).toEqual({ VXSE53: 8 })
  })

  // 正: 一覧の取得に失敗した範囲があれば、結果へ印が載る。
  // **0 件と区別できること**がこのテストの主眼
  it('走査できなかった範囲があれば結果へ印を載せる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 500,
      ok: false,
      json: async () => ({ status: 'error' }),
    })))

    const pending = listArchive({
      classification: 'telegram.earthquake',
      from: '2026-01-01',
      to: '2026-01-02',
      auth,
    }).catch((e: unknown) => e)
    // 待ち直し（指数バックオフ）を飛ばす
    await vi.advanceTimersByTimeAsync(120_000)
    await pending

    expect(archiveCacheStats().failures.length).toBeGreaterThan(0)
    // **共有の台帳へも積まれること。** ここが下流への引き継ぎの入口で、内訳
    // （`archiveCacheStats().failures`）だけに書くと `writeArtifact` の印に載らない
    expect(incompleteNotes().some((n: string) => n.startsWith('アーカイブの取得:'))).toBe(true)

    // 「0 件だった」ように見える結果に、不完全であることの印が付く
    const marked = markResult({ areas: 0, warning: 0, lgint: 0 }) as Record<string, any>
    expect(marked._incomplete.warning).toContain('「無い」の根拠にしないこと')
    // 元の値は保つ（印を足すだけで、集計を書き換えない）
    expect(marked.areas).toBe(0)
  })
})

// **ページを辿るループに上限が無いと、1 回の走査で数百リクエストが飛ぶ。**
// 2026-09-15 にアプリ側の同じ形のループで踏んだ —— 範囲外の日付を渡したところ、配信元は
// 範囲指定を無視したかのように `nextToken` を返し続け、合計 399 リクエストを辿った。
describe('一覧のページ送りは上限で打ち切る', () => {
  beforeEach(() => {
    resetArchiveCacheForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** **無限に `nextToken` を返す**一覧。範囲指定が効かなくなった状態の再現。 */
  function endlessList() {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'ok', items: [], nextToken: `t${calls}` }),
      }
    }))
    return () => calls
  }

  // 正: 上限で止まり、**失敗として記録される**。止まらなければこのテストは終わらない
  // （無限ループになる）ので、「通った」こと自体が上限が効いている証拠になる。
  //
  // 黙って切ってはいけない —— この script は網羅性を主張するために使うので、走査できなかった
  // 期間が「アーカイブが無かった」に化けて集計へ混ざる。
  it('正: 20 ページで打ち切り、失敗として記録する', async () => {
    const listCalls = endlessList()

    const pending = listArchive({
      classification: 'telegram.earthquake',
      from: '2026-01-01',
      to: '2026-01-02',
      auth,
    }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(300_000)
    const outcome = await pending

    expect(String((outcome as Error)?.message ?? outcome)).toContain('ページ上限')
    expect(listCalls()).toBe(20)
    expect(archiveCacheStats().failures.length).toBeGreaterThan(0)
    // 集計へ「無いの根拠にしないこと」の印が載る
    const marked = markResult({ VXSE53: 0 }) as Record<string, any>
    expect(marked._incomplete).toBeDefined()
  })

  // 対照: `nextToken` が尽きれば上限より手前で止まり、失敗としても記録しない。
  it('対照: ページが尽きれば上限に触れず、失敗として記録しない', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'ok', items: [], ...(calls < 3 ? { nextToken: `t${calls}` } : {}) }),
      }
    }))

    const pending = listArchive({
      classification: 'telegram.earthquake',
      from: '2026-01-01',
      to: '2026-01-02',
      auth,
    })
    await vi.advanceTimersByTimeAsync(300_000)
    await pending

    expect(calls).toBe(3)
    expect(archiveCacheStats().failures).toHaveLength(0)
  })
})

// `runArchiveScript` は、3 本の生成スクリプト（`build-test-quake` / `build-test-lpgm` /
// `build-test-estimated-intensity`）が共有する実行の定型。
//
// **1 箇所に寄せた意義は「報告の形を変えるときに 1 箇所で直せる」ことだが、振る舞いを
// 固定していないと次に触ったときの退行を検出できない。** もともと 3 本それぞれが
// `try / finally` を書いていて、寄せた結果ここが単一の急所になった。
describe('アーカイブを取るスクリプトの定型', () => {
  let saved: typeof process.exitCode

  beforeEach(() => {
    resetArchiveCacheForTest()
    // **終了コードを退避する。** このテストが立てた値を残すと、`npm test` 全体が失敗扱いになる。
    //
    // **プロセス全体の状態に触っているが、他のテストファイルへは漏れない** —— vitest は
    // 既定でファイルごとに別プロセスへ隔離する（`pool: 'forks'` ＋ `isolate: true`。
    // `vitest.config.ts` はどちらも指定していないので既定のまま）。
    // **隔離を切る設定を入れるなら、このテストを見直すこと。**
    saved = process.exitCode
  })
  afterEach(() => {
    process.exitCode = saved
    vi.restoreAllMocks()
  })

  // 正: 取りこぼしが残ったまま本体が完走したら、終了コードを立てて中身も出す
  it('取りこぼしが残って完走したら終了コードを立てる', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runArchiveScript('テストの定型', async () => {
      noteIncomplete('テストの取得', '2026-01-01 は読めなかった')
    })

    expect(process.exitCode).toBe(1)
    // **終了コードだけでは「何を見ていないか」が分からない。** 内容も出ること
    expect(errors.mock.calls.flat().join(' ')).toContain('2026-01-01 は読めなかった')
  })

  // 対照: 取りこぼしが無ければ終了コードを触らない（正常終了を失敗に見せない）
  it('取りこぼしが無ければ終了コードを触らない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0

    await runArchiveScript('テストの定型', async () => { /* 何も取りこぼさない */ })

    expect(process.exitCode).toBe(0)
  })

  // 安全弁: **本体が投げても実測値を出す。** 失敗した回こそ「何件を控えで済ませ、何回
  // 待ち直したか」が要る。あわせて例外を握り潰さないこと（`finally` が元の例外を置き換えない）
  it('本体が投げても実測値を出し、例外はそのまま通す', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = new Error('取得に失敗しました')

    await expect(runArchiveScript('テストの定型', async () => { throw boom })).rejects.toBe(boom)

    expect(errors.mock.calls.flat().join(' ')).toContain('控えから')
  })
})
