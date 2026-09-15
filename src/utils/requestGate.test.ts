import { describe, it, expect } from 'vitest'
import { createRateGate } from './requestGate'

// 起動時の履歴取得は `Promise.allSettled(items.map(...))` で全件を同時に投げる。
// 配信元の上限（電文本体は 50req/5min）を守れるかは、**この門が並列呼び出しを
// 直列化できているか**だけで決まる。
//
// **判定は実時間で行うが、閾値は間隔より十分ゆるく取る。** Windows のタイマー分解能は
// 約 15.6ms あり、間隔ぎりぎりで判定すると**正しい実装でも落ちる**（実測で 5 回中 3 回）。
// 一方、検出したい誤り（待つ前に予約せず、並列呼び出しが一斉発火する形）では差が 0ms 付近に
// なるので、ゆるめても見分けは付く。
const INTERVAL = 100
/** 1 本ぶんの待ちとみなす下限。タイマーの取りこぼしを見込んで間隔の 7 割。 */
const AT_LEAST_ONE_SLOT = INTERVAL * 0.7

describe('createRateGate', () => {
  /** `n` 本を同時に入れて、それぞれが通った時刻（開始からの経過 ms）を昇順で返す。 */
  async function passTimesOf(gate: ReturnType<typeof createRateGate>, n: number): Promise<number[]> {
    const start = Date.now()
    const passedAt: number[] = []
    await Promise.all(
      Array.from({ length: n }, () => gate.wait().then(() => { passedAt.push(Date.now() - start) })),
    )
    return passedAt.sort((a, b) => a - b)
  }

  // 正: 並列で入った呼び出しが、間隔ぶんずつ階段状にずれる。**これが門の目的そのもの**
  it('並列に入った 5 本が、間隔ぶんずつずれて通る', async () => {
    const passedAt = await passTimesOf(createRateGate(INTERVAL), 5)

    expect(passedAt[0]).toBeLessThan(AT_LEAST_ONE_SLOT)   // 1 本目は待たない
    for (let i = 1; i < passedAt.length; i++) {
      expect(passedAt[i] - passedAt[i - 1]).toBeGreaterThanOrEqual(AT_LEAST_ONE_SLOT)
    }
  })

  // 安全弁: **同時に入った全部が別々の枠へ並ぶこと**。
  // 「2 本が同じ時刻へ並ばない」だけを見るテストでは足りない —— 予約を `await` の後に書く
  // 誤った実装でも 2 本なら通ってしまい、症状は 3 本目から出る（段 A で実際に踏んだ）。
  // 全体の所要で見るのは、丸めて段を数える形が実測でタイマー精度に負けたため。
  it('同時に入った 5 本が、同じ枠へ固まらない（全体で 4 本ぶん待つ）', async () => {
    const passedAt = await passTimesOf(createRateGate(INTERVAL), 5)

    // 一斉発火する実装だと、最後の 1 本も 1 本ぶんの待ちで通ってしまう
    expect(passedAt[passedAt.length - 1]).toBeGreaterThanOrEqual(AT_LEAST_ONE_SLOT * 4)
  })

  // 対照: 間隔を空けて呼べば待たない（**使われていない枠を溜め込まない**）
  it('前回から間隔が過ぎていれば待たない', async () => {
    const gate = createRateGate(INTERVAL)
    await gate.wait()
    await new Promise(r => setTimeout(r, INTERVAL * 2))

    const start = Date.now()
    await gate.wait()
    expect(Date.now() - start).toBeLessThan(AT_LEAST_ONE_SLOT)
  })

  // 待っている件数が読めること（初回起動の進み具合の検証に使う）
  it('待っている件数を読める', async () => {
    const gate = createRateGate(INTERVAL)
    const all = Promise.all([gate.wait(), gate.wait(), gate.wait()])
    await new Promise(r => setTimeout(r, INTERVAL * 0.2))   // 1 本目は即時に通る
    expect(gate.waiting()).toBe(2)
    await all
    expect(gate.waiting()).toBe(0)
  })
})
