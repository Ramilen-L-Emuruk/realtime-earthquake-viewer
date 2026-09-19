import { describe, it, expect, vi } from 'vitest'
import { createRateGate } from './requestGate'

// 起動時の履歴取得は `Promise.allSettled(items.map(...))` で全件を同時に投げる。
// 配信元の上限（電文本体は 50req/5min）を守れるかは、**上限に達したあとこの門が
// 並列呼び出しを直列化できているか**だけで決まる。
//
// **判定は実時間で行うが、閾値は間隔より十分ゆるく取る。** Windows のタイマー分解能は
// 約 15.6ms あり、間隔ぎりぎりで判定すると**正しい実装でも落ちる**（実測で 5 回中 3 回）。
// 一方、検出したい誤り（待つ前に予約せず、並列呼び出しが一斉発火する形）では差が 0ms 付近に
// なるので、ゆるめても見分けは付く。
const INTERVAL = 100
/** 1 本ぶんの待ちとみなす下限。タイマーの取りこぼしを見込んで間隔の 7 割。 */
const AT_LEAST_ONE_SLOT = INTERVAL * 0.7

/**
 * 「`INTERVAL` に 1 件」の制限。**固定間隔を窓の一般形で書いたもの。**
 *
 * この describe が見ているのは**並列呼び出しを直列化できているか**と**追い越しの順序**で、
 * どちらも上限が 1 件のときがいちばん厳しく出る（上限に達した状態が最初の 1 本から続くため）。
 * 窓の中に複数の枠がある本番の形（50req/5min ほか）は `窓ごとの上限` の describe で見る。
 */
const ONE_PER_INTERVAL = [{ windowMs: INTERVAL, max: 1 }]

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
    const passedAt = await passTimesOf(createRateGate(ONE_PER_INTERVAL), 5)

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
    const passedAt = await passTimesOf(createRateGate(ONE_PER_INTERVAL), 5)

    // 一斉発火する実装だと、最後の 1 本も 1 本ぶんの待ちで通ってしまう
    expect(passedAt[passedAt.length - 1]).toBeGreaterThanOrEqual(AT_LEAST_ONE_SLOT * 4)
  })

  // 対照: 間隔を空けて呼べば待たない（**使われていない枠を溜め込まない**）
  it('前回から間隔が過ぎていれば待たない', async () => {
    const gate = createRateGate(ONE_PER_INTERVAL)
    await gate.wait()
    await new Promise(r => setTimeout(r, INTERVAL * 2))

    const start = Date.now()
    await gate.wait()
    expect(Date.now() - start).toBeLessThan(AT_LEAST_ONE_SLOT)
  })

  // 正: **待っている通常の要求を追い越して先に通る。** 起動時に発表中の緊急地震速報を
  // 復元する経路がこれを使う（履歴の後ろに並ぶと最悪 24 秒遅れて画面に出る）。
  it('urgent は待っている通常の要求を追い越す', async () => {
    const gate = createRateGate(ONE_PER_INTERVAL)
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
    const gate = createRateGate(ONE_PER_INTERVAL)
    const order: number[] = []
    await gate.wait()
    await Promise.all([0, 1, 2].map(i => gate.wait().then(() => { order.push(i) })))

    expect(order).toEqual([0, 1, 2])
  })

  // 安全弁: **追い越しても枠は増やさない。** ここが緩むと優先度がレート制限の抜け道になる
  // （配信元の上限は緊急かどうかに関係なく掛かる）。
  it('urgent を並べても間隔ぶんずつずれて通る', async () => {
    const gate = createRateGate(ONE_PER_INTERVAL)
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
      const gate = createRateGate(ONE_PER_INTERVAL)
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
    const gate = createRateGate(ONE_PER_INTERVAL)
    const all = Promise.all([gate.wait(), gate.wait(), gate.wait()])
    await new Promise(r => setTimeout(r, INTERVAL * 0.2))   // 1 本目は即時に通る
    expect(gate.waiting()).toBe(2)
    await all
    expect(gate.waiting()).toBe(0)
  })
})

// 配信元が定めているのは**窓ごとの上限**であって配り方ではない（`utils/requestGate.ts` の冒頭）。
// ここで見るのは「上限に達するまで待たせない」こと ―― 均等割りに戻すと、この describe が落ちる。
describe('窓ごとの上限', () => {
  /** 判定に使う窓。実時間で測るので、タイマーの分解能（Windows で約 15.6ms）より十分長く取る。 */
  const WINDOW = 300
  /** その窓で通してよい件数。 */
  const MAX = 3

  // 正: **上限に達するまでは 1 件も待たせない。** これが均等割りをやめた理由そのもので、
  // 起動時の履歴（7 本）とリプレイの開始（16 本）がここに乗る。
  it('上限の件数までは、同時に入れても待たない', async () => {
    const gate = createRateGate([{ windowMs: WINDOW, max: MAX }])
    const start = Date.now()
    await Promise.all(Array.from({ length: MAX }, () => gate.wait()))

    // 均等割り（`{ windowMs: WINDOW, max: 1 }`）なら (MAX-1) × WINDOW かかる
    expect(Date.now() - start).toBeLessThan(WINDOW * 0.5)
  })

  // 対照: **上限を超えた分は待たせる。** 待たせないなら、それは門ではない。
  it('上限を超えた 1 本は、窓が空くまで待つ', async () => {
    const gate = createRateGate([{ windowMs: WINDOW, max: MAX }])
    await Promise.all(Array.from({ length: MAX }, () => gate.wait()))

    const start = Date.now()
    await gate.wait()
    // いちばん古い 1 件が窓から抜けるまで待つ（＝おおよそ WINDOW）
    expect(Date.now() - start).toBeGreaterThanOrEqual(WINDOW * 0.7)
  })

  // 安全弁: **窓は移動するので、上限に達しても「その窓ぶん全部止まる」わけではない。**
  // ここが崩れると、1 本待たせたあと次も満杯のまま延々と詰まる。
  it('窓が移動すれば、1 件ずつ枠が空く', async () => {
    const gate = createRateGate([{ windowMs: WINDOW, max: MAX }])
    await Promise.all(Array.from({ length: MAX }, () => gate.wait()))

    const start = Date.now()
    // 2 本続けて通す。1 本目で窓が空き、2 本目はその次の 1 件が抜けるのを待つ
    await gate.wait()
    await gate.wait()
    const elapsed = Date.now() - start
    // 「窓ぶん全部止まる」実装なら 2 × WINDOW 近くかかる。1 件ずつ空くなら WINDOW 強で済む
    expect(elapsed).toBeLessThan(WINDOW * 1.6)
    expect(elapsed).toBeGreaterThanOrEqual(WINDOW * 0.7)
  })

  // 安全弁: **複数の制限はすべて同時に満たす。** 本番は 50req/5min と 2000req/10min を
  // 並べて渡している。厳しいほうに合わせないと、片方を素通しする。
  it('制限を 2 つ渡したら、厳しいほうに合わせる', async () => {
    const gate = createRateGate([
      { windowMs: WINDOW, max: 10 },
      { windowMs: WINDOW, max: 2 },
    ])
    await Promise.all([gate.wait(), gate.wait()])

    const start = Date.now()
    await gate.wait()
    expect(Date.now() - start).toBeGreaterThanOrEqual(WINDOW * 0.7)
  })

  // 制限を 1 つも渡さなければ素通し（テストで門を無効にするときに使う形）
  it('制限が空なら、何本入れても待たない', async () => {
    const gate = createRateGate([])
    const start = Date.now()
    await Promise.all(Array.from({ length: 50 }, () => gate.wait()))

    expect(Date.now() - start).toBeLessThan(WINDOW * 0.5)
  })
})

// 画面へ「取得制限中」を出すための口（→ `hooks/useFetchThrottled.ts`）。
describe('throttledUntil', () => {
  const WINDOW = 300

  // 対照: **待っている相手が居なければ「制限中」ではない。** 枠が埋まっていること自体は
  // 利用者に関係がなく、実際に誰かが待たされて初めて画面へ出す意味が生まれる。
  it('待っている相手が居なければ null', async () => {
    const gate = createRateGate([{ windowMs: WINDOW, max: 1 }])
    await gate.wait()   // 枠は使い切ったが、待っている相手は居ない

    expect(gate.throttledUntil()).toBeNull()
  })

  // 正: 待たされている相手が居るあいだは、明ける時刻を返す
  it('待たされている相手が居れば、明ける時刻を返す', async () => {
    const gate = createRateGate([{ windowMs: WINDOW, max: 1 }])
    await gate.wait()
    const pending = gate.wait()

    const until = gate.throttledUntil()
    expect(until).not.toBeNull()
    expect(until as number).toBeGreaterThan(Date.now())

    await pending
    // 待ちが解けたら消える
    expect(gate.throttledUntil()).toBeNull()
  })
})
