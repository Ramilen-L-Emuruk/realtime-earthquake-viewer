import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  noteRateLimited, rateLimitedUntil, noteRateLimitCleared, resetRateLimitsForTest,
} from './dmdataRequestGates'
import { log } from '../utils/logger'

vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogThrottle: () => (emit: () => void) => emit(),
}))

/**
 * 429 を受けたものをしばらく取りに行かない仕組み。
 *
 * **配信元が名指しで求めている** ——「429 エラーが発生した場合、『指数関数バックオフ』による
 * 再リクエスト処理の実施をお願いします」。アプリの REST は再試行しないので「バックオフして
 * 再試行」の形にはならないが、**操作のたびに同じ URL を取り直す形がある**（控えが効くのは
 * 成功した分だけで、「もっと見る」は範囲をまるごと問い合わせ直す）。
 *
 * **429 は id 単位で返る**（応答の本文が「Don't try to get the same data.」と書いている）ので、
 * 窓も id ごとに持つ。
 */
describe('429 を受けたものは、しばらく取りに行かない', () => {
  beforeEach(() => {
    resetRateLimitsForTest()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRateLimitsForTest()
  })

  // 正: 429 を受けたら窓が立ち、そのあいだは取りに行かない。
  it('429 を受けた id は、窓が明けるまで取りに行かない', () => {
    expect(rateLimitedUntil('body', 'd1')).toBeNull()

    noteRateLimited('body', 'd1')

    expect(rateLimitedUntil('body', 'd1')).not.toBeNull()
    // 黙って止めない
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('取りに行きません')
  })

  // 対照: 窓を持たない id は素通し。**他の id を巻き込まない**
  // （429 はアカウントでも IP でもなく id 単位で返るため）。
  it('窓を持たない id は素通しする', () => {
    noteRateLimited('body', 'd1')

    expect(rateLimitedUntil('body', 'd2')).toBeNull()
  })

  // 正: 窓が明けたら取りに行く。**明けても取りに行かない実装だと、回復しても永久に取れない。**
  it('窓が明けたら取りに行く', () => {
    noteRateLimited('body', 'd1')
    const until = rateLimitedUntil('body', 'd1')
    expect(until).not.toBeNull()

    vi.setSystemTime((until as number) + 1)

    expect(rateLimitedUntil('body', 'd1')).toBeNull()
  })

  // 正: 続けて受けると窓が倍になる（＝指数バックオフ）。
  // **これが無いと、429 が続いている間ずっと同じ間隔で取りに行く。**
  it('続けて 429 を受けると窓が倍になる', () => {
    noteRateLimited('body', 'd1')
    const first = (rateLimitedUntil('body', 'd1') as number) - Date.now()

    // 1 回目の窓が明けてから 2 回目を受ける
    vi.setSystemTime(Date.now() + first + 1)
    noteRateLimited('body', 'd1')
    const second = (rateLimitedUntil('body', 'd1') as number) - Date.now()

    expect(second).toBeGreaterThan(first)
  })

  // 安全弁: 電文本体とアーカイブ本体で窓を分ける。
  // **電文 id とアーカイブ id が同じ文字列になる保証はどこにも無い。** 1 つの表に混ぜると、
  // 衝突したときに片方の 429 が無関係なもう片方を最長 30 分止める —— しかも記録には
  // 「429 を受けたので待つ」としか出ないので、別のリソースの窓に巻き込まれたことが分からない。
  it('同じ id でも電文本体とアーカイブ本体で窓を分ける', () => {
    noteRateLimited('body', 'same-id')

    expect(rateLimitedUntil('body', 'same-id')).not.toBeNull()
    expect(rateLimitedUntil('archive', 'same-id')).toBeNull()

    // 逆向きも見る（成功の記録が相手の窓を消さないこと）
    noteRateLimited('archive', 'same-id')
    noteRateLimitCleared('body', 'same-id')
    expect(rateLimitedUntil('archive', 'same-id')).not.toBeNull()
  })

  // 安全弁: 窓が明けてから十分経ったものは忘れる。
  // **`step` を残すのは指数バックオフの趣旨**だが、永久に残すと記録だけが積み上がる。
  it('窓が明けてから十分経ったら連続回数ごと忘れる', () => {
    noteRateLimited('body', 'd1')
    noteRateLimited('body', 'd1')
    const until = rateLimitedUntil('body', 'd1') as number

    // 忘れる期限（窓が明けてから 1 時間）より先へ進める
    vi.setSystemTime(until + 61 * 60_000)
    expect(rateLimitedUntil('body', 'd1')).toBeNull()

    // 忘れているので、次の 429 は 1 回目として扱う
    vi.clearAllMocks()
    noteRateLimited('body', 'd1')
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('連続 1 回目')
  })

  // 安全弁: 成功したら窓と回数を捨てる。
  // **これが無いと、一度 429 を受けた id は回復後も長い窓を持ち続ける**
  // （次に 429 を受けたときの窓が、前回の続きから倍になる）。
  it('成功したら窓と回数を捨てる', () => {
    noteRateLimited('body', 'd1')
    noteRateLimited('body', 'd1')
    noteRateLimitCleared('body', 'd1')

    expect(rateLimitedUntil('body', 'd1')).toBeNull()

    // 捨てたあとの 429 は 1 回目として扱う（窓が最初の長さに戻る）
    vi.clearAllMocks()
    noteRateLimited('body', 'd1')
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('連続 1 回目')
  })
})
