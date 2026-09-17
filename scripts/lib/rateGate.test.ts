import { describe, it, expect, beforeEach, vi } from 'vitest'
// @ts-expect-error -- 型定義を持たない .mjs（`scripts/lib/stationSource.mjs` と同じ扱い）
import { gate, resetRateGateForTest } from './rateGate.mjs'

// 取得の間隔を守る唯一の仕組み。**ここが緩むと、控え（同じものを取り直さない）を入れても
// 初回の走査で配信元の制限を超える。**
//
// このテストを置いたのは、`gate()` が並列で直列化できていない不備を実際に作り込んだため
// （`lastRequestAt` の書き込みが `await` の後にあり、並列で入った呼び出しが同じ値を読んで
// 一斉に発火していた）。スクリプト側のロジックは `npm test` の網から外れやすいので、
// レート制御だけは明示的に固定する。
//
// **`kind` は取得元ごとに分ける。** このテストが `body` / `list` で確かめているのは
// DMDATA アーカイブの 2 経路だが、同じ門を P2PQuake の履歴走査・観測点索引の走査も通る。
describe('gate（取得のレート制御）', () => {
  const INTERVAL = 6_000

  beforeEach(() => {
    resetRateGateForTest()
    vi.useFakeTimers()
  })

  /** `gate` を n 本同時に呼び、それぞれが抜けた時刻（偽の時計）を記録する。 */
  async function raceGates(kind: string, n: number, intervalMs = INTERVAL): Promise<number[]> {
    const start = Date.now()
    const exitedAt: number[] = []
    const running = Array.from({ length: n }, async () => {
      await gate(kind, intervalMs)
      exitedAt.push(Date.now() - start)
    })
    // 予約は同期的に積まれるので、時計を進めれば順に抜ける
    await vi.advanceTimersByTimeAsync(intervalMs * n)
    await Promise.all(running)
    return exitedAt.sort((a, b) => a - b)
  }

  // 正: 並列に呼んでも間隔が守られる。**1 本ずつ階段状にずれる**こと。
  // これが崩れると「1 間隔ごとに並列数ぶんのバースト」になり、守るつもりの上限を
  // 並列数の分だけ超える
  it('並列に呼んでも 1 本ずつ間隔が空く', async () => {
    const exits = await raceGates('body', 5)

    expect(exits).toHaveLength(5)
    // 1 本目は即時、以降は前の枠から `INTERVAL` 以上あとに抜ける
    expect(exits[0]).toBe(0)
    for (let i = 1; i < exits.length; i++) {
      expect(exits[i] - exits[i - 1]).toBeGreaterThanOrEqual(INTERVAL)
    }
  })

  // 対照: 間隔が空いていれば待たない。控えから読めた分はゲートを通さない設計だが、
  // 通ったとしても時間が経っていれば待たされないこと（初回の走査以外を遅くしない）
  it('前回から間隔が空いていれば待たない', async () => {
    await gate('body', INTERVAL)
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)

    const start = Date.now()
    await gate('body', INTERVAL)

    expect(Date.now() - start).toBe(0)
  })

  // 安全弁: `kind` ごとに独立して数える。混ぜると、間隔の長い取得元に引っぱられて
  // 別の取得元まで遅くなる（DMDATA では 6 秒間隔の本体取得が 500ms の一覧取得を止めていた）
  it('kind が違えば互いに待たない', async () => {
    await gate('body', INTERVAL)

    const start = Date.now()
    await gate('list', 500)

    expect(Date.now() - start).toBe(0)
  })

  // 安全弁: 待ちは**積み上がる**こと。同じ時刻へ 2 本以上が並ばない。
  //
  // **2 本では足りない。** 不備があった実装（`await` の後に書き込む形）でも、2 本なら
  // 1 本目が即時・2 本目が 1 間隔後になって通ってしまう。症状が出るのは 3 本目からで、
  // そこから先が 2 本目と同じ時刻へ固まる。実際この安全弁を 2 本で書いていて、
  // 旧実装へ戻したときに**通ってしまった**（弱いテストは無いより悪い）。
  it('同時に入った何本も、同じ時刻へ固まらない', async () => {
    const exits = await raceGates('body', 5)

    expect(new Set(exits).size).toBe(5)
  })

  // 安全弁: 空にする関数が枠の予約を落とすこと。落ちないと、前のテストが積んだ
  // 予約が次のテストへ漏れて「間隔が空いていれば待たない」が実行順で落ちる
  it('resetRateGateForTest は枠の予約を落とす', async () => {
    await gate('body', INTERVAL)
    resetRateGateForTest()

    const start = Date.now()
    await gate('body', INTERVAL)

    expect(Date.now() - start).toBe(0)
  })
})
