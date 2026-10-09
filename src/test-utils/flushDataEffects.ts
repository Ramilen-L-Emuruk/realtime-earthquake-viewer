import { act } from '@testing-library/react'

/**
 * 描いた直後に始まる生成データの読み込みを、`act()` の中で決着させる。**テスト専用**。
 *
 * `EarthquakeCard` の区域データ（`useSubRegions`）や津波観測点の座標（`useTsunamiObsCoords`）は、
 * マウントの effect で読み込みを始め、決着したところで state を書き換える。`render()` が戻った
 * 時点ではまだ決着していないので、そのまま確かめへ進むと、その書き換えは `act()` の外で起きる
 * （`src/vitestSetup.ts` が落とす）。
 *
 * **待つのはマイクロタスクだけ。** テスト環境では読み込み先の URL が相対のまま Node の `fetch` に
 * 渡り、URL として読めずにその場で失敗する（モックした読み込みも即座に解決する）ので、決着までに
 * 実時間は挟まらない。50 回は、読み込み口（`fetchJsonWithTimeout`）の Promise の連なりを抜けるのに
 * 足りる回数。
 *
 * **実時間を挟む読み込みに変わったら、ここでは待ちきれない。** そのとき門が知らせるとは限らない
 * —— 警告が遅れて出るので、次のテストの失敗として出るか、ファイルの最後のテストの後なら
 * `afterAll` で落ちるか、それより後なら拾われない（`src/vitestSetup.ts`）。
 */
export async function flushDataEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  })
}
