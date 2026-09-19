// @vitest-environment jsdom
//
// 合成済みチャンクの控え（`speechAudioCache.ts`）。
//
// **jsdom で回すのは `window.__speechCache()` の口を確かめるため。** 控え自体は `window` に
// 依らないが、診断の窓口だけがブラウザを要る（既定の `node` 環境では `installSpeechCacheProbe`
// が何もせずに戻る ―― そのガードがあること自体は、この指定が無くても壊れない）。
//
// **正・対照・安全弁の 3 種を対にして固定する**（→ CLAUDE.md「検証」）。ここでの分担は
//   正   ＝ 同じ鍵なら控えから出る
//   対照 ＝ 鍵が 1 つでも違えば別物として扱う
//   安全弁＝ 上限を超えたら追い出す・使ったものは残る
import { describe, it, expect, beforeEach } from 'vitest'
import {
  speechChunkKey, takeCachedChunk, putCachedChunk, clearSpeechAudioCache,
  speechAudioCacheStats, registerSpeechCacheExtraStats, installSpeechCacheProbe,
  __resetSpeechAudioCacheForTest,
} from './speechAudioCache'

/**
 * `AudioBuffer` の代役。控えが見るのは実寸の計算に使う 2 つだけ（`bufferBytes`）。
 *
 * @param seconds 24kHz 換算の秒数。**実寸は「長さ × チャンネル数 × 4 バイト」**
 */
function fakeBuffer(seconds: number, channels = 1): AudioBuffer {
  return { length: Math.round(seconds * 24000), numberOfChannels: channels } as AudioBuffer
}

const KEY = (chunk: string, hasNext = false) => speechChunkKey('http://vv', 1, chunk, hasNext)

beforeEach(() => {
  __resetSpeechAudioCacheForTest()
})

describe('合成済みチャンクの控え', () => {
  it('同じ鍵で収めたものは引ける（正）', () => {
    const buf = fakeBuffer(2)
    putCachedChunk(KEY('石川県能登地方で地震がありました。'), buf)
    expect(takeCachedChunk(KEY('石川県能登地方で地震がありました。'))).toBe(buf)
    expect(speechAudioCacheStats().hits).toBe(1)
  })

  it('収めていない鍵は引けない（対照）', () => {
    putCachedChunk(KEY('石川県能登地方で地震がありました。'), fakeBuffer(2))
    expect(takeCachedChunk(KEY('宮城県沖で地震がありました。'))).toBeNull()
    expect(speechAudioCacheStats().misses).toBe(1)
  })

  // **末尾の間の有無は鍵に含める。** 後続のチャンクがあるときだけ句読点に間を足すので
  // （`CHUNK_BREAK_PAUSE`）、同じ文字列でも音が違う。含め忘れると、どちらが先に控えを
  // 埋めたかで末尾の間が変わる非決定的な不揃いになる。
  it('末尾の間の有無が違えば別物として扱う（対照）', () => {
    const withPause = fakeBuffer(2)
    putCachedChunk(KEY('震度7を観測しました。', true), withPause)
    expect(takeCachedChunk(KEY('震度7を観測しました。', false))).toBeNull()
    expect(takeCachedChunk(KEY('震度7を観測しました。', true))).toBe(withPause)
  })

  it('接続先・話者が違えば別物として扱う（対照）', () => {
    const buf = fakeBuffer(2)
    putCachedChunk(speechChunkKey('http://vv', 1, '津波の心配はありません。', false), buf)
    expect(takeCachedChunk(speechChunkKey('http://vv', 2, '津波の心配はありません。', false))).toBeNull()
    expect(takeCachedChunk(speechChunkKey('http://other', 1, '津波の心配はありません。', false))).toBeNull()
  })

  it('同じ鍵を二重に収めても、先に入れたものを保つ（安全弁）', () => {
    const first = fakeBuffer(2)
    putCachedChunk(KEY('同じ句。'), first)
    putCachedChunk(KEY('同じ句。'), fakeBuffer(3))
    expect(takeCachedChunk(KEY('同じ句。'))).toBe(first)
    expect(speechAudioCacheStats().entries).toBe(1)
  })

  it('捨てれば引けなくなる（安全弁）', () => {
    putCachedChunk(KEY('捨てられる句。'), fakeBuffer(2))
    clearSpeechAudioCache()
    expect(takeCachedChunk(KEY('捨てられる句。'))).toBeNull()
    expect(speechAudioCacheStats().entries).toBe(0)
    expect(speechAudioCacheStats().bytes).toBe(0)
  })
})

describe('控えの上限', () => {
  // 上限は 96MB / 400 件。**バイト数のほうが先に当たるのが普通**（1 チャンクが数百 KB）。
  it('バイト数の上限を超えたら古いものから捨てる（安全弁）', () => {
    // 1 件 48MB（= 24000 × 500 秒 × 4 バイト）。3 件入れれば上限（96MB）を超える。
    const big = () => fakeBuffer(500)
    putCachedChunk(KEY('A。'), big())
    putCachedChunk(KEY('B。'), big())
    expect(speechAudioCacheStats().entries).toBe(2)

    putCachedChunk(KEY('C。'), big())
    // いちばん古く使われた A が落ちる
    expect(takeCachedChunk(KEY('A。'))).toBeNull()
    expect(takeCachedChunk(KEY('C。'))).not.toBeNull()
    expect(speechAudioCacheStats().evicted).toBeGreaterThan(0)
  })

  // **使ったものは残る。** 追い出しの順序が「入れた順」だと、いま読んでいる文の続きが
  // 先に捨てられる。
  it('引いたものは新しく使われた扱いになり、追い出されない（正）', () => {
    const big = () => fakeBuffer(500)
    putCachedChunk(KEY('A。'), big())
    putCachedChunk(KEY('B。'), big())
    // A を読み直して「いま使った」印を付ける
    expect(takeCachedChunk(KEY('A。'))).not.toBeNull()

    putCachedChunk(KEY('C。'), big())
    // 落ちるのは、使われてから最も時間が経っている B
    expect(takeCachedChunk(KEY('A。'))).not.toBeNull()
    expect(takeCachedChunk(KEY('B。'))).toBeNull()
  })

  // **連番で順序を持つ理由。** `Date.now()` で順序を持つと、1 回の投機で続けて焼いた数十件が
  // 同じミリ秒になり、読み直した印が効かずに「いま使ったものから追い出す」ことが起こる。
  it('同じティックで続けて収めても、追い出す順序が壊れない（安全弁）', () => {
    const big = () => fakeBuffer(500)
    // 時計を進めずに 3 件（実際の投機はこの形で数十件を続けて焼く）
    putCachedChunk(KEY('1。'), big())
    putCachedChunk(KEY('2。'), big())
    putCachedChunk(KEY('3。'), big())
    // 上限で 1 件目が落ち、後から入れた 2 件は残る
    expect(takeCachedChunk(KEY('1。'))).toBeNull()
    expect(takeCachedChunk(KEY('2。'))).not.toBeNull()
    expect(takeCachedChunk(KEY('3。'))).not.toBeNull()
  })

  it('1 件で上限を超えるものは持たない（安全弁）', () => {
    // 200MB 相当。収めた直後に自分を追い出すことになるので、最初から持たない。
    putCachedChunk(KEY('巨大な句。'), fakeBuffer(2100))
    expect(speechAudioCacheStats().entries).toBe(0)
    expect(takeCachedChunk(KEY('巨大な句。'))).toBeNull()
  })
})

describe('window.__speechCache()', () => {
  it('控えと投機の統計をまとめて返す（正）', () => {
    registerSpeechCacheExtraStats(() => ({ prefetchSynthesized: 42 }))
    installSpeechCacheProbe()
    const read = (window as unknown as Record<string, () => Record<string, unknown>>).__speechCache
    expect(typeof read).toBe('function')
    const stats = read()
    // 控え側の数字と、投機側が差し込んだ数字が同じ窓口から読める
    expect(stats).toHaveProperty('entries')
    expect(stats.prefetchSynthesized).toBe(42)
  })
})
