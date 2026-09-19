// 分割配信された BUFR の結合。
//
// **実配信で観測できたのは 2 断片までだが、規約は最大 24 断片（RRA〜RRX）。** 3 断片以上と
// 順不同で壊れないことを、合成データで固定しておく——実物が来た日に静かに末尾を欠いた分布が
// 出るのがいちばん困る。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BufrFragmentStore, fragmentIndex, fragmentKey, stripWmoHeading } from './bufrTelegramAssembly'
import { withWmoHeading } from '../test-utils/bufrBuild'
import { log } from '../utils/logger'

// **部分モックにする。** 丸ごと置き換えると、logger が新しい関数を export した日に
// 「そんな export は無い」でファイルごと落ちる。差し替えたいのは `log` と
// `createLogThrottle`（間引きは素通しにする。ここで見たいのは「警告を出したか」であって
// 間引きの時間条件ではない）だけ。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  createLogThrottle: () => (fn: () => void) => fn(),
}))

beforeEach(() => { vi.clearAllMocks() })

/** 指定した全長を宣言する BUFR の先頭断片を作る（中身は連番の埋め草）。 */
function head(total: number, size: number): Uint8Array {
  const b = new Uint8Array(size)
  b.set([0x42, 0x55, 0x46, 0x52])
  b[4] = (total >> 16) & 0xff; b[5] = (total >> 8) & 0xff; b[6] = total & 0xff
  b[7] = 3
  for (let i = 8; i < size; i++) b[i] = i & 0xff
  return b
}
function tail(size: number, seed: number): Uint8Array {
  const b = new Uint8Array(size)
  for (let i = 0; i < size; i++) b[i] = (i + seed) & 0xff
  return b
}

const KEY = fragmentKey('IXAC41', 'RJTD', '2026-04-20T08:25:00.000Z')

describe('stripWmoHeading', () => {
  // 正: IXAC40 は全断片に見出しが付く。**剥がさないと 1 報目が BUFR で始まらず電文ごと捨てる**
  // ——実機で最初に落ちたのがこれ。
  it('WMO の見出しを剥がす', () => {
    const body = head(30, 10)
    expect([...stripWmoHeading(withWmoHeading('PAA', body), 'PAA')]).toEqual([...body])
    // 2 報目以降（BUFR で始まらない）も剥がせること。
    const cont = tail(10, 1)
    expect([...stripWmoHeading(withWmoHeading('PAB', cont), 'PAB')]).toEqual([...cont])
  })

  // 対照: IXAC41 の本体は `BUFR` で始まる（DMDATA が見出しを `designation` へ出す）。触らない。
  it('BUFR で始まる本体はそのまま', () => {
    const body = head(30, 10)
    expect(stripWmoHeading(body, null)).toBe(body)
    expect(stripWmoHeading(body, 'RRA')).toBe(body)
  })

  // 安全弁: 見出しが名乗る符号と `designation` が食い違えば剥がさない。
  // **緩めると本体の先頭 22 バイトを黙って削った電文を読もうとする。**
  it('見出しの符号が designation と違えば剥がさず記録する', () => {
    const wrong = withWmoHeading('PAB', head(30, 10))
    expect(stripWmoHeading(wrong, 'PAA')).toBe(wrong)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('designation と違う'))
  })

  // 安全弁: 見出しの書式でなければそのまま返す（二進データの先頭を削らない）。
  // **セグメント符号のときは記録する** —— IXAC40 は全断片に見出しが付く前提なので、
  // 無いのは配信の形が変わった印。剥がせないまま進むと「BUFR で始まっていない」や
  // 「宣言全長を超えました」として現れ、**どちらも根本原因を名指ししない**。
  it('セグメント断片に見出しが無ければ剥がさず記録する', () => {
    const b = tail(30, 5)
    expect(stripWmoHeading(b, 'PAB')).toBe(b)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('見出しが見つかりません'))
  })

  // 対照: 遅延報（IXAC41）の継続断片は見出しを持たないのが正常。
  // **ここで鳴らすと、正常な分割配信のたびに警告が出る。**
  it('遅延報の継続断片では記録しない', () => {
    const b = tail(30, 5)
    expect(stripWmoHeading(b, 'RRA')).toBe(b)
    expect(stripWmoHeading(b, null)).toBe(b)
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('fragmentIndex', () => {
  // 正: 1 報目は符号を持たない。2 報目以降が RRA から順に付く。
  it('分割報符号を並び順の番号にする', () => {
    expect(fragmentIndex(null)).toBe(0)
    expect(fragmentIndex(undefined)).toBe(0)
    expect(fragmentIndex('')).toBe(0)
    expect(fragmentIndex('RRA')).toBe(1)
    expect(fragmentIndex('RRB')).toBe(2)
    expect(fragmentIndex('RRX')).toBe(24)
  })

  // 安全弁: 規約の外（RRY・RRZ・小文字・別の符号）は番号にしない。
  // ここを通すと、どこに入る断片か分からないまま結合して順序が狂う。
  it('規約の外の符号は番号にしない', () => {
    for (const d of ['RRY', 'RRZ', 'rra', 'CCA', 'AAX', 'RR', 'RRAA']) {
      expect(fragmentIndex(d), d).toBeNull()
    }
  })

  // 正: IXAC40 のセグメント符号。**1 報目から符号が付く**ので、BUFR ヘッダを持つ `PAA` が 0。
  // 順序は 3 文字目で決まる（2 文字目は最終セグメントの印と見ている）。
  it('セグメント符号を並び順の番号にする', () => {
    expect(fragmentIndex('PAA')).toBe(0)
    expect(fragmentIndex('PAB')).toBe(1)
    expect(fragmentIndex('PZC')).toBe(2)   // 実配信の 3 断片目。2 文字目が Z
    expect(fragmentIndex('PAZ')).toBe(25)
    expect(log.warn).not.toHaveBeenCalled()
  })

  // 安全弁: 2 文字目が A・Z 以外でも順序は 3 文字目で決めるが、記録は残す。
  // **セグメント符号の読みが違っていたことに気づける場所が他に無い。**
  it('セグメント符号の 2 文字目が想定外なら記録する', () => {
    expect(fragmentIndex('PMC')).toBe(2)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('2 文字目が想定外'))
  })
})

describe('BufrFragmentStore', () => {
  // 正: 2 断片。実配信で観測できた形。
  it('2 断片を順に受けて結合する', () => {
    const s = new BufrFragmentStore()
    const p1 = head(150, 100), p2 = tail(50, 7)
    expect(s.add(KEY, null, p1, 0)).toBeNull()
    const out = s.add(KEY, 'RRA', p2, 1)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(150)
    expect([...out!.slice(0, 100)]).toEqual([...p1])
    expect([...out!.slice(100)]).toEqual([...p2])
    expect(s.pendingCount).toBe(0)
  })

  // 正: 3 断片。**実配信では観測できていない形**なので、ここでしか守れない。
  it('3 断片でも結合する', () => {
    const s = new BufrFragmentStore()
    const p1 = head(300, 100), p2 = tail(100, 1), p3 = tail(100, 2)
    expect(s.add(KEY, null, p1, 0)).toBeNull()
    expect(s.add(KEY, 'RRA', p2, 1)).toBeNull()
    const out = s.add(KEY, 'RRB', p3, 2)!
    expect(out.length).toBe(300)
    expect([...out.slice(200)]).toEqual([...p3])
  })

  // 正: 順不同。DMDATA のドキュメントの実装例は受信順に足すので、順が入れ替わると壊れる。
  // **こちらは分割報符号で位置を決める**ので、どの順で届いても同じ結果になる。
  it('順不同で届いても正しい順に結合する', () => {
    const p1 = head(300, 100), p2 = tail(100, 1), p3 = tail(100, 2)
    const expected = new Uint8Array(300)
    expected.set(p1, 0); expected.set(p2, 100); expected.set(p3, 200)
    for (const order of [
      [['RRB', p3], ['RRA', p2], [null, p1]],
      [['RRA', p2], [null, p1], ['RRB', p3]],
      [['RRB', p3], [null, p1], ['RRA', p2]],
    ] as [string | null, Uint8Array][][]) {
      const s = new BufrFragmentStore()
      let out: Uint8Array | null = null
      order.forEach(([d, b], i) => { out = s.add(KEY, d, b, i) })
      expect([...out!]).toEqual([...expected])
    }
  })

  // 対照: 揃うまでは返さない。**途中の断片が欠けている間は「合計が足りる」ことがあっても
  // 返さない**（0 から連続していることも条件にしている）。
  it('間が欠けている間は結合しない', () => {
    const s = new BufrFragmentStore()
    expect(s.add(KEY, null, head(300, 100), 0)).toBeNull()
    expect(s.add(KEY, 'RRB', tail(200, 1), 1)).toBeNull()   // 合計は 300 だが RRA が無い
    expect(s.pendingCount).toBe(1)
  })

  // 安全弁: 同じ断片が二度届いても二重に数えない。実電文で内容が同一の重複配信を観測している。
  it('同じ断片が二度届いても二重に数えない', () => {
    const s = new BufrFragmentStore()
    const p1 = head(150, 100), p2 = tail(50, 7)
    expect(s.add(KEY, null, p1, 0)).toBeNull()
    expect(s.add(KEY, null, p1, 1)).toBeNull()
    const out = s.add(KEY, 'RRA', p2, 2)!
    expect(out.length).toBe(150)
  })

  // 安全弁: 別の電文の断片を混ぜない。
  it('識別名が違えば別の電文として貯める', () => {
    const s = new BufrFragmentStore()
    const other = fragmentKey('IXAC41', 'RJTD', '2026-04-20T08:31:00.000Z')
    expect(s.add(KEY, null, head(150, 100), 0)).toBeNull()
    expect(s.add(other, 'RRA', tail(50, 1), 1)).toBeNull()
    expect(s.pendingCount).toBe(2)
    expect(s.add(KEY, 'RRA', tail(50, 7), 2)).not.toBeNull()
    expect(s.pendingCount).toBe(1)
  })

  // 安全弁: 知らない符号が来たら、その断片だけでなく**電文ごと**諦める。
  it('知らない分割報符号なら電文ごと捨てる', () => {
    const s = new BufrFragmentStore()
    s.add(KEY, null, head(150, 100), 0)
    expect(s.add(KEY, 'RRZ', tail(50, 1), 1)).toBeNull()
    expect(s.pendingCount).toBe(0)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('知らない分割報符号')
  })

  // 安全弁: 1 報目が BUFR で始まっていなければ捨てる（全長が分からず、完了を判定できない）。
  it('1 報目が BUFR で始まっていなければ捨てる', () => {
    const s = new BufrFragmentStore()
    expect(s.add(KEY, null, tail(100, 1), 0)).toBeNull()
    expect(s.pendingCount).toBe(0)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('BUFR で始まっていない')
  })

  // 安全弁: 合計が宣言全長を超えたら捨てる。**超えた状態で結合すると末尾が化ける。**
  it('断片の合計が宣言全長を超えたら捨てる', () => {
    const s = new BufrFragmentStore()
    s.add(KEY, null, head(150, 100), 0)
    expect(s.add(KEY, 'RRA', tail(100, 1), 1)).toBeNull()
    expect(s.pendingCount).toBe(0)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('宣言全長を超え')
  })

  // 安全弁: 揃わないまま残った断片は時限で捨てる。**ここでしか消えない。**
  it('時限を過ぎた断片を捨てる', () => {
    const s = new BufrFragmentStore({ ttlMs: 1000 })
    s.add(KEY, null, head(150, 100), 0)
    expect(s.pendingCount).toBe(1)
    // 別の電文を足した拍子に、古いほうが時限で落ちる
    s.add(fragmentKey('IXAC41', 'RJTD', 'other'), null, head(150, 100), 5000)
    expect(s.pendingCount).toBe(1)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('時限を過ぎ')
  })

  // 安全弁: 抱える電文の数に上限を置く。1 電文が 1MB 近くなるので、
  // 断片が欠け続ける障害で際限なく積み上がらないようにする。
  it('抱える電文が上限に達したら古いものから捨てる', () => {
    const s = new BufrFragmentStore({ maxGroups: 2 })
    s.add('a', null, head(150, 100), 0)
    s.add('b', null, head(150, 100), 1)
    s.add('c', null, head(150, 100), 2)
    expect(s.pendingCount).toBe(2)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('上限')
  })

  // 安全弁: **外から掃除できること。** `add()` の中だけで掃除すると、IXAC41 は 13 か月で
  // 28 通しか来ないので「次の分割電文が届くまで時限が働かない」——事象から数週間ずれた
  // 時刻に警告が出て、診断で見落とされる。
  it('sweep で時限を過ぎた断片を捨てられる', () => {
    const s = new BufrFragmentStore({ ttlMs: 1000 })
    s.add(KEY, null, head(150, 100), 0)
    s.sweep(500)
    expect(s.pendingCount).toBe(1)   // まだ時限内
    s.sweep(5000)
    expect(s.pendingCount).toBe(0)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('時限を過ぎ')
  })

  // 安全弁: **揃わなかった電文を呼び出し側が数えられること。** リプレイはこの入れ物を
  // 使い捨てるので、ここを見ないと残った断片は黙って消える。
  it('揃わないまま残っている電文の識別名を返す', () => {
    const s = new BufrFragmentStore()
    s.add(KEY, null, head(300, 100), 0)
    expect(s.pendingKeys).toEqual([KEY])
    s.add(KEY, 'RRA', tail(200, 1), 1)
    expect(s.pendingKeys).toEqual([])
  })

  // 安全弁: 再生の開始・リセットで空にできること（時間軸が変わると断片は意味を失う）。
  it('clear で抱えている断片を捨てる', () => {
    const s = new BufrFragmentStore()
    s.add(KEY, null, head(150, 100), 0)
    s.clear()
    expect(s.pendingCount).toBe(0)
  })

  // 正: IXAC40 のセグメント符号で 3 断片を結合する。**1 報目から符号が付く**体系なので、
  // `PAA` を 0 として扱えていないと全長を読む相手がおらず、永久に揃わない。
  it('セグメント符号の 3 断片を結合する', () => {
    const s = new BufrFragmentStore()
    expect(s.add(KEY, 'PAA', head(30, 10), 0)).toBeNull()
    expect(s.add(KEY, 'PAB', tail(10, 1), 0)).toBeNull()
    const out = s.add(KEY, 'PZC', tail(10, 2), 0)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(30)
    // 3 文字目の順に並ぶ（BUFR ヘッダを持つ `PAA` が先頭）。
    expect([...out!.slice(0, 4)]).toEqual([0x42, 0x55, 0x46, 0x52])
    expect([...out!.slice(10, 13)]).toEqual([...tail(10, 1).slice(0, 3)])
    expect([...out!.slice(20, 23)]).toEqual([...tail(10, 2).slice(0, 3)])
  })

  // 正: **実配信の形**（全断片に WMO の見出しが付く）で結合する。
  // **これが本番で最初に落ちた形** —— 見出しを剥がさないと 1 報目の全長が読めない。
  it('見出し付きのセグメント 3 断片を結合する', () => {
    const s = new BufrFragmentStore()
    const p0 = head(30, 10), p1 = tail(10, 1), p2 = tail(10, 2)
    expect(s.add(KEY, 'PAA', withWmoHeading('PAA', p0), 0)).toBeNull()
    expect(s.add(KEY, 'PAB', withWmoHeading('PAB', p1), 0)).toBeNull()
    const out = s.add(KEY, 'PZC', withWmoHeading('PZC', p2), 0)
    expect(out).not.toBeNull()
    // 見出しのぶん（22 バイト × 3）は落ちて、宣言どおりの 30 バイトになる。
    expect(out!.length).toBe(30)
    expect([...out!.slice(0, 4)]).toEqual([0x42, 0x55, 0x46, 0x52])
    expect([...out!.slice(20, 23)]).toEqual([...p2.slice(0, 3)])
  })

  // 正: 順不同でも 3 文字目の順に並ぶ。**最終セグメント（2 文字目 Z）が先に届いても**
  // 全長で完了を判定するので、末尾を欠いたまま結合することはない。
  it('セグメント符号が順不同で届いても正しい順に結合する', () => {
    const s = new BufrFragmentStore()
    expect(s.add(KEY, 'PZC', tail(10, 2), 0)).toBeNull()
    expect(s.add(KEY, 'PAB', tail(10, 1), 0)).toBeNull()
    const out = s.add(KEY, 'PAA', head(30, 10), 0)
    expect(out).not.toBeNull()
    expect([...out!.slice(0, 4)]).toEqual([0x42, 0x55, 0x46, 0x52])
    expect([...out!.slice(20, 23)]).toEqual([...tail(10, 2).slice(0, 3)])
  })
})
