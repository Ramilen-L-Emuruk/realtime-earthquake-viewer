import { describe, it, expect, vi } from 'vitest'
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

  // 正: **待っている通常の要求を追い越して先に通る。** 起動時に発表中の緊急地震速報を
  // 復元する経路がこれを使う（履歴の後ろに並ぶと最悪 24 秒遅れて画面に出る）。
  it('urgent は待っている通常の要求を追い越す', async () => {
    const gate = createRateGate(INTERVAL)
    const order: string[] = []
    // 1 本目で枠を使い切らせ、そのあいだに通常 2 本と urgent 1 本を積む
    await gate.wait()
    const normalA = gate.wait().then(() => { order.push('normalA') })
    const normalB = gate.wait().then(() => { order.push('normalB') })
    const urgent = gate.wait({ urgent: true }).then(() => { order.push('urgent') })
    await Promise.all([normalA, normalB, urgent])

    expect(order[0]).toBe('urgent')
    // 通常どうしの相対順は崩さない（到来順）
    expect(order).toEqual(['urgent', 'normalA', 'normalB'])
  })

  // 対照: **追い越すのは urgent だけ。** 通常の要求は積んだ順に通る（順番を入れ替える仕組みが
  // 通常の要求まで巻き込んでいないこと）。
  it('通常の要求どうしは到来順で通る', async () => {
    const gate = createRateGate(INTERVAL)
    const order: number[] = []
    await gate.wait()
    await Promise.all([0, 1, 2].map(i => gate.wait().then(() => { order.push(i) })))

    expect(order).toEqual([0, 1, 2])
  })

  // 安全弁: **追い越しても間隔は守る。** ここが緩むと優先度がレート制限の抜け道になる
  // （配信元の上限は 50req/5min ＝ 6 秒に 1 件で、緊急かどうかは関係ない）。
  it('urgent を並べても間隔ぶんずつずれて通る', async () => {
    const gate = createRateGate(INTERVAL)
    const start = Date.now()
    const passedAt: number[] = []
    await Promise.all(
      Array.from({ length: 4 }, () =>
        gate.wait({ urgent: true }).then(() => { passedAt.push(Date.now() - start) })),
    )
    passedAt.sort((a, b) => a - b)

    expect(passedAt[0]).toBeLessThan(AT_LEAST_ONE_SLOT)
    for (let i = 1; i < passedAt.length; i++) {
      expect(passedAt[i] - passedAt[i - 1]).toBeGreaterThanOrEqual(AT_LEAST_ONE_SLOT)
    }
  })

  // 安全弁: **枠が空いていればタイマーを待たずに通る。** 順番を入れ替えられるようにした
  // ときに `setTimeout` を必ず通る形へ変えてしまい、**偽のタイマーを使うテストが 1 件も
  // 進まなくなった**（門を挟んだ経路のテストが 6 件そろって時間切れになった）。
  // 間隔 0 でも 1 タスク遅れる形は、待つ理由が無いところで待つことになる。
  it('枠が空いていれば、タイマーを進めなくても通る', async () => {
    vi.useFakeTimers()
    try {
      const gate = createRateGate(INTERVAL)
      let passed = false
      void gate.wait().then(() => { passed = true })
      // マイクロタスクだけ回す（タイマーは進めない）
      await Promise.resolve()
      await Promise.resolve()
      expect(passed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
