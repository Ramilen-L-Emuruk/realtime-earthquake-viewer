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
//
// ## `act()` の外で React を更新したテストは落とす
//
// **React の描き直しは、偽のタイマーの下でも実時間で回る。** React のスケジューラは読み込みの
// 時点で本物の `setImmediate` と `performance` を掴むので、`vi.useFakeTimers()` の後でも
// 描き直しは本物の時計で動き、5ms を超えると続きを後へ回す。`renderHook` の `result.current`
// を書き換えるのはその続き（effect）なので、`act()` の外で更新したテストは「描き直しが
// 確かめより先に終わる」ことに賭けている。**単独では通り、並列で描画が遅くなったときだけ落ちる**
// （2026-10-09 に `useLiveEventHandler.tsunamiAreaGradeChange.test.ts` の寿命の安全弁で踏んだ。
// 偽の時計で 60 秒進めて印を消したのに、消えた値をまだ読めていなかった）。`act()` の中の更新は
// スケジューラを通らず、`act()` を抜ける時点で effect まで描き切る。
//
// **RTL は本来これを警告させるが、ここでは黙っている。** 警告の要否を決める
// `IS_REACT_ACT_ENVIRONMENT` を、RTL はグローバルの `beforeAll` があるときだけ立てる（片付けと
// 同じ理由で効かない）。立てて数えると、この時点で 24 本・820 回の更新が `act()` の外だった。
// **警告を出すだけでは足りない** —— 出しても通るなら、新しく書いたテストが同じ賭けを黙って
// 足していく。だから警告が出たテストは、ここで落とす。
//
// 直し方は、更新を起こす操作を `act()` で包むこと。偽の時計を進めるなら
// `await act(() => vi.advanceTimersByTimeAsync(ms))`、フックの関数を直に呼ぶなら
// `act(() => { result.current.f() })`、Promise の解決を待つなら `await act(async () => {})`。
// 描いた直後に始まる生成データの読み込み（区域データ・津波観測点の座標など）を待つだけなら、
// `src/test-utils/flushDataEffects.ts` の `await flushDataEffects()` を `render` の直後に置く。
//
// **門が見られるのは、`console.error` に届いた警告だけ。** 拾えない形が 2 つある。
//
// - **テストが `console.error` を黙らせている。** 素の `vi.spyOn(console, 'error').mockImplementation(() => {})`
//   は警告をそこで消す。DOM のテストは `src/test-utils/muteConsoleError.ts` を通すこと（警告だけは
//   ここへ流す）。素のまま書くと `scripts/consoleErrorMute.test.ts` が落とす。
// - **警告が遅れて出る。** 確かめた後に決着する非同期の更新は、そのテストの `afterEach` に間に合わず、
//   次のテストの失敗として出るか、ファイルの最後のテストの後なら下の `afterAll` が拾う。
//   `afterAll` より後に出たものは拾えない。

import { afterAll, afterEach } from 'vitest'
import { isActWarning } from './test-utils/muteConsoleError'

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  // 警告そのものは React が出す（`console.error`）。ここでは数えるだけで、表示は止めない。
  const outsideAct: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    if (isActWarning(args)) outsideAct.push(String(args[1] ?? ''))
    originalError(...args)
  }

  const failIfOutsideAct = (where: string) => {
    if (outsideAct.length === 0) return
    const names = [...new Set(outsideAct)].filter(n => n !== '').join(', ')
    const count = outsideAct.length
    outsideAct.length = 0
    throw new Error(
      `act() の外で React を更新した（${where}・${count} 回${names === '' ? '' : `・${names}`}）。` +
      'このテストは描き直しが確かめより先に終わることに賭けていて、並列で遅くなると落ちる。' +
      '更新を起こす操作を act() で包むこと（理由と包み方は src/vitestSetup.ts）',
    )
  }

  afterEach(() => {
    cleanup()
    failIfOutsideAct('このテスト')
  })
  // ファイルの最後のテストの後に遅れて出た警告。どのテストが起こしたかは分からない
  afterAll(() => {
    failIfOutsideAct('このファイルの最後のテストの後')
  })
}
