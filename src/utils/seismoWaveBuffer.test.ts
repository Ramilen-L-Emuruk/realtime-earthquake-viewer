// 自作地震計の合成波形を抱える入れ物のテスト。
//
// **形は 3 種を対にする**（正＝効くこと／対照＝境界の手前では効かないこと／
// 安全弁＝併せて緩めなかったものが残っていること。CLAUDE.md「検証」）。
//
// **末尾の 2 本は敵対的レビューが数値で覆した不具合の再現。** どちらも
// 「1 回の遷移だけを見るテスト」では捉えられず、連続稼働で初めて出る形だった ——
// 実装を戻せばこの 2 本が落ちる。

import { describe, it, expect } from 'vitest'
import { SeismoWaveBuffer, type SeismoWaveChunk } from './seismoWaveBuffer'

/** 実機と同じ形のまとまり（10 ms 刻み・30 サンプル）。 */
function chunk(
  firstSampleMs: number,
  options: {
    length?: number
    msPerSample?: number
    /** 各サンプルの値（3 成分すべてから作る）。既定は通番。 */
    value?: (i: number) => number
    members?: (i: number) => number
  } = {},
): SeismoWaveChunk {
  const length = options.length ?? 30
  const value = options.value ?? ((i) => i)
  const members = options.members ?? (() => 9)
  const axis = Array.from({ length }, (_, i) => value(i))
  return {
    firstSampleMs,
    msPerSample: options.msPerSample ?? 10,
    gal: [axis, axis.map((v) => v * 2), axis.map((v) => v * 3)],
    memberCount: Array.from({ length }, (_, i) => members(i)),
  }
}

describe('SeismoWaveBuffer', () => {
  it('正: 連続したまとまりを繋ぎ、時刻の昇順で読み出せる', () => {
    const buffer = new SeismoWaveBuffer(60)
    expect(buffer.push(chunk(1000)).kind).toBe('restarted')
    expect(buffer.push(chunk(1300)).kind).toBe('appended')

    const window = buffer.snapshot()
    expect(window).not.toBeNull()
    if (window === null) return
    expect(window.firstSampleMs).toBe(1000)
    expect(window.msPerSample).toBe(10)
    expect(window.gal[0].length).toBe(60)
    // 1 まとまり目の先頭と、2 まとまり目の先頭。
    expect(window.gal[0][0]).toBe(0)
    expect(window.gal[0][30]).toBe(0)
    // 成分ごとに別の値が入っていること（軸を取り違えていない）。
    expect(window.gal[1][5]).toBe(10)
    expect(window.gal[2][5]).toBe(15)
    expect(buffer.lastSampleMs).toBe(1000 + 59 * 10)
  })

  it('正: 届かなかった区間は NaN で残す（詰めて繋がない）', () => {
    // **詰めると、そこだけ時間の縮んだ絵になる。** 見ている人には確かめる手立てが無い。
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000))
    // 1 まとまり（300 ms）を飛ばした位置。
    const result = buffer.push(chunk(1600))
    expect(result).toEqual({ kind: 'gap', missingSamples: 30 })

    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    expect(window.gal[0].length).toBe(90)
    // 飛んだ 30 サンプルは NaN・本数は 0。
    expect(Number.isNaN(window.gal[0][30])).toBe(true)
    expect(Number.isNaN(window.gal[2][59])).toBe(true)
    expect(window.memberCount[45]).toBe(0)
    // 隙間の後は正しい位置から続く。
    expect(window.gal[0][60]).toBe(0)
    expect(window.memberCount[60]).toBe(9)
    // **末尾の時刻はまとまり自身が名乗る値から引く**（隙間を埋めた数から
    // 積み上げるのではない）。
    expect(buffer.lastSampleMs).toBe(1600 + 29 * 10)
    expect(buffer.tally.gapSamples).toBe(30)
  })

  it('安全弁: 数として読めない時刻・刻みは入口で弾く（数え上げを NaN で汚さない）', () => {
    // **通すと `offset` が `NaN` になり、大小の比較がすべて偽になるので
    // 「重なりの受け入れ」へ落ちて `droppedSamples` が `NaN` へ化ける。**
    // そこが `NaN` だと受け取る側の等値比較（`sameTally`）が常に「違う」を返し、
    // 毎巡回で画面を差し替え続ける（`NaN !== NaN`）。
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000))

    expect(buffer.push(chunk(Number.NaN)).kind).toBe('stale')
    expect(buffer.push(chunk(Number.POSITIVE_INFINITY)).kind).toBe('stale')
    expect(buffer.push(chunk(1300, { msPerSample: 0 })).kind).toBe('stale')
    expect(buffer.push(chunk(1300, { msPerSample: Number.NaN })).kind).toBe('stale')

    expect(Number.isFinite(buffer.tally.droppedSamples)).toBe(true)
    expect(buffer.tally.droppedSamples).toBe(120)
    // **弾いた後も続きは繋がる**（起点も末尾の時刻も壊れていない）。
    expect(buffer.push(chunk(1300)).kind).toBe('appended')
    expect(buffer.sampleCount).toBe(60)
  })

  it('正: 効いたセンサーの本数をサンプルごとに保つ（1 本の区間を見分ける）', () => {
    // 合成を名乗れない区間（1 台だけ）を段 4 が示せるようにするための値。
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000, { length: 4, members: (i) => (i < 2 ? 9 : 1) }))
    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    expect([...window.memberCount]).toEqual([9, 9, 1, 1])
  })

  it('正: 刻みが大きく変われば作り直す', () => {
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000))
    // 100 Hz → 50 Hz（サンプリング周波数の設定を変えた）。
    const result = buffer.push(chunk(1300, { msPerSample: 20 }))
    expect(result.kind).toBe('restarted')
    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    expect(window.msPerSample).toBe(20)
    expect(window.firstSampleMs).toBe(1300)
    // 前の刻みのサンプルは残さない。
    expect(window.gal[0].length).toBe(30)
  })

  it('対照: 刻みのわずかな揺らぎでは作り直さず、最新の刻みを取り込む', () => {
    // **ホスト側の刻みは区間の当てはめが進むたびわずかに動く。** 実機の実測では
    // センサー 9 本で 10.0018〜10.0174 ms（幅 0.16%）。ここで作り直すと
    // まとまりごとに絵が消える。
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000, { msPerSample: 10.0018 }))
    const result = buffer.push(chunk(1000 + 30 * 10.0018, { msPerSample: 10.0174 }))
    expect(result.kind).toBe('appended')
    expect(buffer.sampleCount).toBe(60)
    // **取り込んだことを見る。** 取り込まないと誤差が積み上がる（末尾の再現テスト）。
    expect(buffer.snapshot()?.msPerSample).toBe(10.0174)
  })

  it('正: 一部が既に置いた区間なら、重なりだけ捨てて残りを繋ぐ', () => {
    // まとまりごと捨てると、まだ誰も書いていない末尾の新規分まで失う。
    const buffer = new SeismoWaveBuffer(60)
    // 1 まとまり目は 1000〜1290（30 サンプル・10 ms 刻み）。
    buffer.push(chunk(1000, { length: 30, value: () => 1 }))
    // 2 まとまり目は 1200〜1490。**重なるのは 1200〜1290 の 10 サンプル**で、
    // 1300 以降の 20 サンプルが新規。
    const result = buffer.push(chunk(1200, { length: 30, value: () => 7 }))
    expect(result).toEqual({ kind: 'overlap', droppedSamples: 10 })
    expect(buffer.sampleCount).toBe(50)
    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    // 重なった部分は最初に置いた値のまま（上書きしない）。
    expect(window.gal[0][25]).toBe(1)
    expect(window.gal[0][29]).toBe(1)
    // 新規分は置かれている。
    expect(window.gal[0][30]).toBe(7)
    expect(window.gal[0][49]).toBe(7)
    expect(buffer.tally.droppedSamples).toBe(10)
    // 末尾の時刻はまとまり自身が名乗る値から引く（捨てた分でずらさない）。
    expect(buffer.lastSampleMs).toBe(1200 + 29 * 10)
  })

  it('対照: 全部が既に置いた区間なら捨てる（上書きしない）', () => {
    // 刻みの推定が進むと同じ区間の時刻がわずかに動くので、重なりは正常に起きうる。
    // **上書きすると、同じ絵の中に 2 つの推定が混ざる。**
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000, { length: 30, value: () => 1 }))
    const result = buffer.push(chunk(1000, { length: 30, value: () => 999 }))
    expect(result).toEqual({ kind: 'stale' })
    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    expect(window.gal[0].length).toBe(30)
    expect([...window.gal[0]].every((v) => v === 1)).toBe(true)
  })

  it('安全弁: 抱える長さを超えたら古いほうから押し出す', () => {
    // 1 秒ぶん（10 ms 刻みで 100 サンプル）だけ抱える。
    const buffer = new SeismoWaveBuffer(1)
    for (let i = 0; i < 10; i += 1) {
      buffer.push(chunk(1000 + i * 300, { value: () => i }))
    }
    expect(buffer.sampleCount).toBe(100)
    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    // 最後の 100 サンプルだけが残る。
    expect(window.gal[0][99]).toBe(9)
    expect(window.firstSampleMs).toBe(1000 + (300 - 100) * 10)
  })

  it('安全弁: 隙間が抱える長さ以上なら作り直す', () => {
    // 埋めても全部が「届いていない」になるので、環状に書き回す意味が無い。
    const buffer = new SeismoWaveBuffer(1)
    buffer.push(chunk(1000))
    const result = buffer.push(chunk(1000 + 200 * 10))
    expect(result.kind).toBe('restarted')
    expect(buffer.sampleCount).toBe(30)
  })

  it('安全弁: 1 まとまりを超えて巻き戻ったら即座に作り直す', () => {
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1_000_000))
    const result = buffer.push(chunk(1000))
    expect(result.kind).toBe('restarted')
    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    expect(window.firstSampleMs).toBe(1000)
  })

  it('安全弁: 空のまとまりでは起点を動かさない', () => {
    // 起点だけ進めると、次のまとまりとの間に意味の無い隙間ができる。
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000))
    const result = buffer.push(chunk(1300, { length: 0 }))
    expect(result).toEqual({ kind: 'stale' })
    expect(buffer.sampleCount).toBe(30)
    // 続きは元の位置から繋がる。
    expect(buffer.push(chunk(1300)).kind).toBe('appended')
  })

  it('安全弁: 抱える長さより 1 まとまりが長くても先頭を落とさない', () => {
    // 保持長を短く設定されたときに、まとまりの先頭が黙って消えるのを避ける。
    const buffer = new SeismoWaveBuffer(0.1)
    buffer.push(chunk(1000, { length: 30 }))
    expect(buffer.sampleCount).toBe(30)
  })

  it('対照: 1 件も置いていなければ窓は空', () => {
    const buffer = new SeismoWaveBuffer(60)
    expect(buffer.snapshot()).toBeNull()
    expect(buffer.lastSampleMs).toBeNull()
    expect(buffer.sampleCount).toBe(0)
  })

  it('正: 捨てると次のまとまりが起点を引き直す（数え上げは残す）', () => {
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000))
    buffer.push(chunk(1600)) // 隙間を作って数え上げへ乗せる
    buffer.clear()
    expect(buffer.snapshot()).toBeNull()
    expect(buffer.tally.gapSamples).toBe(30)
    expect(buffer.push(chunk(5000)).kind).toBe('restarted')
    const window = buffer.snapshot()
    if (window === null) throw new Error('窓が空')
    expect(window.firstSampleMs).toBe(5000)
  })

  // ── 以下 2 本は敵対的レビューが数値で覆した不具合の再現 ──

  it('安全弁: 刻みが揺らぎ続けても偽の隙間を作らない（10 分ぶんを流す）', () => {
    // **時刻の持ち方が誤差を溜める形だと、実機と同じ揺らぎ（0.16%）で偽の隙間が出る。**
    // レビューの実測・このテストでの再現ともに**10 分で 94 回**（最初の 1 回は約 3 秒後）。
    //
    // **守っているのは 2 つで、どちらを外しても落ちる** ——「直前との相対で測る」ことと、
    // 末尾の時刻を「まとまり自身が名乗る値から引く」こと（置いた数から積み上げる形に
    // 変えると溜まる）。刻みの取り込みだけを外しても落ちないので、そちらは根本ではない。
    //
    // **1 回の遷移を見るテスト（上の「対照」）では捉えられない。** 連続で流して初めて出る。
    const buffer = new SeismoWaveBuffer(60)
    const ms = 10.0174
    buffer.push(chunk(0, { msPerSample: 10.0018 }))
    let at = 30 * 10.0018
    let anomalies = 0
    for (let i = 0; i < 2000; i += 1) {
      const result = buffer.push(chunk(at, { msPerSample: ms }))
      if (result.kind !== 'appended') anomalies += 1
      at += 30 * ms
    }
    expect(anomalies).toBe(0)
    expect(buffer.tally.gapSamples).toBe(0)
    expect(buffer.tally.droppedSamples).toBe(0)
  })

  it('安全弁: 数秒の巻き戻りでも、新しく届いたデータを捨て続けない', () => {
    // **復旧の閾値を緩めた形（抱える長さの 2 倍を要求する）は、緩い間ずっと
    // 新しいデータを捨てる。** レビューの実測では 5 秒の巻き戻りで 17 まとまり
    // （510 サンプル）を続けて捨て、回復時に申告した欠測は 10 サンプルだけだった。
    const buffer = new SeismoWaveBuffer(60)
    for (let i = 0; i < 10; i += 1) buffer.push(chunk(100_000 + i * 300))

    // 5 秒巻き戻して、以後は正常に続ける。
    let at = 100_000 + 10 * 300 - 5000
    const kinds: string[] = []
    for (let i = 0; i < 20; i += 1) {
      kinds.push(buffer.push(chunk(at)).kind)
      at += 300
    }
    // **1 まとまり目で作り直し、以後はすべて繋がる。**
    expect(kinds[0]).toBe('restarted')
    expect(kinds.slice(1).every((k) => k === 'appended')).toBe(true)
    // 巻き戻った後のデータが全部残っている（20 まとまり × 30）。
    expect(buffer.sampleCount).toBe(600)
  })
})

// 取り戻した区間で穴を埋める（#597）。ホストが作り直した合成波形を `/waves` から取り、
// **届かなかったところへだけ**書く。
describe('SeismoWaveBuffer.fill', () => {
  /** 1000 ms から 3 まとまり、真ん中の 1 まとまり（1300〜1590 ms）が届かなかった入れ物。 */
  function withHole(): SeismoWaveBuffer {
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000))
    buffer.push(chunk(1600))
    return buffer
  }

  it('正: 穴の時刻に合うサンプルを書き、届かなかった数から埋めた分を引く', () => {
    const buffer = withHole()
    expect(buffer.tally.gapSamples).toBe(30)

    const filled = buffer.fill([chunk(1300, { value: (i) => 100 + i, members: () => 3 })])

    expect(filled).toBe(30)
    const w = buffer.snapshot()
    if (w === null) throw new Error('窓が空')
    expect(w.gal[0][30]).toBe(100)
    expect(w.gal[1][59]).toBe(129 * 2)
    expect(w.gal[2][45]).toBe(115 * 3)
    expect(w.memberCount[40]).toBe(3)
    // 「欠測」は届かなかったうち埋まらなかった数（2026-10-07 ユーザー承認）。
    expect(buffer.tally.gapSamples).toBe(0)
  })

  it('対照: 届いた値は、取り戻した値が重なっていても上書きしない', () => {
    const buffer = withHole()
    // 0〜90 サンプルぶん（1000〜1890 ms）を丸ごと覆う取り戻し。
    const filled = buffer.fill([chunk(1000, { length: 90, value: () => -1 })])

    // 埋まるのは穴の 30 だけ。
    expect(filled).toBe(30)
    const w = buffer.snapshot()
    if (w === null) throw new Error('窓が空')
    expect(w.gal[0][0]).toBe(0)
    expect(w.gal[0][29]).toBe(29)
    expect(w.gal[0][30]).toBe(-1)
    expect(w.gal[0][60]).toBe(0)
  })

  it('対照: 取り戻した区間が穴の一部しか覆わなければ、残りは穴のまま数える', () => {
    const buffer = withHole()
    const filled = buffer.fill([chunk(1300, { length: 10 })])

    expect(filled).toBe(10)
    const w = buffer.snapshot()
    if (w === null) throw new Error('窓が空')
    expect(Number.isNaN(w.gal[0][40])).toBe(true)
    expect(buffer.tally.gapSamples).toBe(20)
  })

  it('安全弁: 最寄りのサンプルが半サンプルを超えて離れた穴は埋めない', () => {
    const buffer = withHole()
    // 6 ms ずれた取り戻し（1306〜1596 ms）。穴 1310〜1590 ms は 4 ms 先のサンプルで埋まるが、
    // **穴 1300 ms の最寄りは 1306 ms（6 ms 離れる）なので埋めない**。
    const filled = buffer.fill([chunk(1306)])

    expect(filled).toBe(29)
    const w = buffer.snapshot()
    if (w === null) throw new Error('窓が空')
    expect(Number.isNaN(w.gal[0][30])).toBe(true)
    expect(w.gal[0][31]).toBe(0)
  })

  it('安全弁: 読めない値（NaN）のサンプルでは穴を埋めない', () => {
    const buffer = withHole()
    const filled = buffer.fill([chunk(1300, { value: (i) => (i < 5 ? Number.NaN : i) })])

    expect(filled).toBe(25)
    expect(buffer.tally.gapSamples).toBe(5)
  })

  it('安全弁: 抱える長さを過ぎて押し出された穴は埋めない（窓の外を書かない）', () => {
    // 1 秒しか抱えない入れ物（100 サンプル）。
    const buffer = new SeismoWaveBuffer(1)
    buffer.push(chunk(1000))
    buffer.push(chunk(1600))
    // 先へ流して穴（1300〜1590 ms）を押し出す。
    for (let t = 1900; t < 3000; t += 300) buffer.push(chunk(t))

    expect(buffer.fill([chunk(1300)])).toBe(0)
  })

  it('正: 穴の範囲を返す。範囲に掛からなければ null', () => {
    const buffer = withHole()

    // **半開区間で返す**（終わりは最後の穴の 1 サンプル先。そのまま `/waves` の `to` へ渡せる）。
    expect(buffer.holesIn(0, 10_000)).toEqual({ fromMs: 1300, toMs: 1600 })
    // 1450 ms の穴は範囲の外（終わりは含まない）。
    expect(buffer.holesIn(1400, 1450)).toEqual({ fromMs: 1400, toMs: 1450 })
    expect(buffer.holesIn(1600, 2000)).toBeNull()

    buffer.fill([chunk(1300)])
    expect(buffer.holesIn(0, 10_000)).toBeNull()
  })

  it('正: 刻みが揺らいでいても、穴の時刻は前後の届いた値の間へ均して置く', () => {
    // 前のまとまりは 10 ms 刻み、次のまとまりは 1601 ms から（隙間ぶんが 30 サンプルと 1 ms）。
    const buffer = new SeismoWaveBuffer(60)
    buffer.push(chunk(1000))
    buffer.push(chunk(1601))
    const hole = buffer.holesIn(0, 10_000)
    if (hole === null) throw new Error('穴が無い')
    // 起点からの「位置 × 刻み」で測ると 1300 ms で、均した値と 1 ms 未満しか違わない。
    expect(hole.fromMs).toBeGreaterThan(1300)
    expect(hole.fromMs).toBeLessThan(1301)
    // 最後の穴は 1591 ms 手前・終わりはその 1 刻み先（次に届いた値の 1601 ms を越えない）。
    expect(hole.toMs).toBeLessThanOrEqual(1601)
  })
})

describe('SeismoWaveBuffer.prepend', () => {
  /** 10000 ms から 1 まとまり（30 サンプル）だけ届いた入れ物。起動直後の形。 */
  function justStarted(retainSec = 60): SeismoWaveBuffer {
    const buffer = new SeismoWaveBuffer(retainSec)
    buffer.push(chunk(10_000))
    return buffer
  }

  it('正: 空きがあれば最も古いサンプルの手前へ継ぎ足し、時刻の昇順で読み出せる', () => {
    const buffer = justStarted()
    expect(buffer.oldestSampleMs).toBe(10_000)

    const placed = buffer.prepend([chunk(9700, { value: (i) => 100 + i })])

    expect(placed).toBe(30)
    const w = buffer.snapshot()
    if (w === null) throw new Error('窓が空')
    expect(w.firstSampleMs).toBe(9700)
    expect(w.gal[0].length).toBe(60)
    expect(w.gal[0][0]).toBe(100)
    expect(w.gal[0][29]).toBe(129)
    expect(w.gal[0][30]).toBe(0)
    expect(buffer.oldestSampleMs).toBe(9700)
    // 続けて届いたまとまりは、継ぎ足した分と関係なく末尾へ繋がる。
    expect(buffer.push(chunk(10_300)).kind).toBe('appended')
  })

  it('対照: 既に抱えている時刻のサンプルは継ぎ足さない（届いた値を上書きしない）', () => {
    const buffer = justStarted()
    // 9850〜10140 ms。手前の 15 サンプル（9850〜9990 ms）だけが継ぎ足せる。
    const placed = buffer.prepend([chunk(9850, { value: () => -1 })])

    expect(placed).toBe(15)
    const w = buffer.snapshot()
    if (w === null) throw new Error('窓が空')
    expect(w.gal[0][14]).toBe(-1)
    expect(w.gal[0][15]).toBe(0)
  })

  it('安全弁: 空きを超えては書かない（新しい側を押し出さない）', () => {
    // 1 秒しか抱えない入れ物（100 サンプル）に 30 サンプル。空きは 70。
    const buffer = justStarted(1)
    expect(buffer.freeSamples).toBe(70)

    const placed = buffer.prepend([chunk(9000, { length: 100, value: () => 5 })])

    expect(placed).toBe(70)
    expect(buffer.freeSamples).toBe(0)
    const w = buffer.snapshot()
    if (w === null) throw new Error('窓が空')
    // 残るのは新しい側の 70（9300〜9990 ms）と元の 30。
    expect(w.firstSampleMs).toBe(9300)
    expect(w.gal[0][69]).toBe(5)
    expect(w.gal[0][70]).toBe(0)
  })

  it('正: 取り戻した値と最も古いサンプルの間が空いていれば、穴として置いて欠測に数える', () => {
    const buffer = justStarted()
    // 9600〜9890 ms。9900〜9990 ms の 10 サンプルが控えにも無かった形。
    const placed = buffer.prepend([chunk(9600)])

    expect(placed).toBe(30)
    expect(buffer.tally.gapSamples).toBe(10)
    expect(buffer.holesIn(0, 20_000)).toEqual({ fromMs: 9900, toMs: 10_000 })
    // **後から埋まれば引く**（穴埋めの数え方と同じ）。
    expect(buffer.fill([chunk(9900, { length: 10 })])).toBe(10)
    expect(buffer.tally.gapSamples).toBe(0)
  })

  it('正: 読めない値（NaN）のサンプルは穴として置き、継ぎ足した数には数えない', () => {
    const buffer = justStarted()
    const placed = buffer.prepend([chunk(9700, { value: (i) => (i >= 25 ? Number.NaN : i) })])

    expect(placed).toBe(25)
    expect(buffer.tally.gapSamples).toBe(5)
    expect(buffer.holesIn(0, 20_000)).toEqual({ fromMs: 9950, toMs: 10_000 })
  })

  it('安全弁: 取り戻した値まで空きを超える隙間があれば、穴だけで空きを埋めない', () => {
    // 1 秒しか抱えない入れ物（空き 70）。取り戻した値は最も古いサンプルの 2 秒前（間が 200 サンプル）。
    const buffer = justStarted(1)
    const placed = buffer.prepend([chunk(8000)])

    expect(placed).toBe(0)
    expect(buffer.freeSamples).toBe(70)
    expect(buffer.tally.gapSamples).toBe(0)
    expect(buffer.snapshot()?.firstSampleMs).toBe(10_000)
  })

  it('安全弁: 刻みの違う取り戻しは継ぎ足さない（時間軸を混ぜない）', () => {
    const buffer = justStarted()
    expect(buffer.prepend([chunk(9400, { msPerSample: 20 })])).toBe(0)
    expect(buffer.snapshot()?.firstSampleMs).toBe(10_000)
  })

  it('安全弁: 何も抱えていなければ継ぎ足さない（起点は届いたまとまりが決める）', () => {
    const buffer = new SeismoWaveBuffer(60)
    expect(buffer.prepend([chunk(9700)])).toBe(0)
    expect(buffer.oldestSampleMs).toBeNull()
    expect(buffer.snapshot()).toBeNull()
  })
})
