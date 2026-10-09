import { vi } from 'vitest'

/** React が「act() の外で更新した」ときに出す警告か。門（`src/vitestSetup.ts`）とここで共有する。 */
export function isActWarning(args: readonly unknown[]): boolean {
  const first = args[0]
  return typeof first === 'string' && first.includes('not wrapped in act')
}

/**
 * `console.error` を黙らせる。**テスト専用**。DOM（jsdom）のテストは、素の
 * `vi.spyOn(console, 'error').mockImplementation(...)` ではなくこちらを使う（`scripts/consoleErrorMute.test.ts`
 * が落とす）。
 *
 * **黙らせても、act() の外の更新の警告だけは門へ流す。** 門（`src/vitestSetup.ts`）は
 * `console.error` に届いた警告を数えるので、素のまま中身を空にすると警告がそこで消え、
 * act() の外で更新したテストが黙って通る。2026-10-09 に `useHypocenterCatalog.test.ts` の
 * `retry()` がまさにこの形で残っていた（黙らせるのを外すと門で落ちた）。
 *
 * 戻り値は `vi.spyOn` のスパイそのもので、`mock.calls` で呼ばれた中身を確かめられる
 * （流した警告も記録に残る）。
 *
 * @param impl 警告以外を受けたときの処理。省けば何もしない
 */
export function muteConsoleError(impl: (...args: unknown[]) => void = () => {}) {
  // 差し替える前の `console.error`（DOM のテストでは門が置いた関数）を掴んでおき、警告だけそこへ渡す
  const gate = console.error
  return vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (isActWarning(args)) {
      gate(...args)
      return
    }
    impl(...args)
  })
}
