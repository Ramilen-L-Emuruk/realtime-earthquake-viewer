// テストごとに、描いたコンポーネントとフックを片付ける（`vitest.config.ts` の `setupFiles`）。
//
// **RTL（React Testing Library・`@testing-library/react`）の自動の片付けは、ここでは効かない。**
// RTL はグローバルの `afterEach` があるときだけ自分で登録するが、この設定は `globals` を
// 立てていないので、何もしなければ `render` / `renderHook` で立てたものはファイルの最後まで
// 生き残る。生き残ったフックは実時間のタイマーを
// 回し続け、後のテストと共有しているモックを叩く。**単独では通り、全件を並列で回したときだけ
// 落ちる**（1 件の実時間が伸びて、その間にタイマーが割り込む）。2026-10-08 に
// `useSeismoQuakeWaves.test.ts` で踏んだ —— 前のテストのフックの 0.3 秒の巡回が、偽の時計で
// 進めた時刻を見て震度を訊きに行き、「1 回のはず」の呼び出しが増えた。
//
// 各ファイルで `afterEach(cleanup)` を書く形では、書き忘れたファイルが黙って同じ穴を持つ
// （この時点で RTL を使う 82 本のうち 35 本が `cleanup` を呼んでいなかった。うち 2 本は
// 1 件のテストで `unmount()` するだけ）。
//
// **この片付けは、各ファイルの `afterEach` より後に走る**（`afterEach` は登録の逆順に走り、
// ここは各ファイルより先に登録される）。つまりアンマウントは、ファイルが `vi.restoreAllMocks()`
// や `vi.useRealTimers()` で元へ戻した後に起きる。**アンマウント時の処理（effect の後始末）が
// モックした関数を呼ぶなら、そのファイルの `afterEach` の先頭で `cleanup()` を呼ぶこと** ——
// 呼ばないと、モックではなく本物が呼ばれる。
//
// **DOM のある環境でだけ読む。** 大半のテストは node の環境で走り、React を使わない。
// そこで RTL を読むと、ファイルごとに読み込みの待ちが乗るだけになる。

import { afterEach } from 'vitest'

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(() => {
    cleanup()
  })
}
