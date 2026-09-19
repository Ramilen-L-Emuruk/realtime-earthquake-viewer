// アーカイブ本体の控えの挙動を固定する。
//
// 守りたいのは「同じアーカイブを落とし直さない」こと。ただし残しすぎてメモリを食わない・
// 古い中身を永久に返さない・失敗を控え続けないことも同時に要る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createArchiveBodyCache, MAX_ENTRIES, MAX_TOTAL_BYTES } from './archiveBodyCache'
// 上限の下限保証を**窓の定数から導く**ために読む（数字を写すと窓を広げたとき無反応になる）。
//
// **フックのモジュールを読む結合は承知のうえ。** 定数 3 つのために `react` まで含む依存を
// 引き込むが、ここで欲しいのは「窓の定義と上限がずれたら落ちる」ことそのもの。
// トップレベルで読んでいるので、待ちは 1 件目の所要時間には乗らない
// （→ `rules/common/testing.md`「テスト本体の中で対象モジュールを初めて読まないこと」）。
import { QUAKE_HISTORY_MAX_DAYS, PRE_WINDOW_MS, WINDOW_MS } from '../hooks/useReplayController'
import { MAX_HISTORY_DAYS } from '../services/dmdataReplay'

/** 展開済みアーカイブの代わり。`bytes` は展開後の tar の長さに相当する。 */
function archive(name: string, bytes = 1000) {
  return { files: new Map([[name, new Uint8Array(1)]]), bytes }
}

describe('createArchiveBodyCache', () => {
  let warns: string[]
  beforeEach(() => {
    warns = []
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  // 正: 2 度目は取得しない
  it('同じ URL の 2 度目は控えから返し、取得を呼ばない', async () => {
    const cache = createArchiveBodyCache()
    const download = vi.fn(async () => archive('a'))

    const first = await cache.get('https://x/a', download)
    const second = await cache.get('https://x/a', download)

    expect(download).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 })
  })

  // 対照: 別の URL は別物として取る（URL でしか同一性を判定しない）
  it('別の URL は取得する', async () => {
    const cache = createArchiveBodyCache()
    const download = vi.fn(async () => archive('a'))

    await cache.get('https://x/a', download)
    await cache.get('https://x/b', download)

    expect(download).toHaveBeenCalledTimes(2)
  })

  // 安全弁: 本数の上限を超えたら古い順に追い出す
  it('本数の上限を超えると、いちばん古く使ったものを追い出す', async () => {
    const cache = createArchiveBodyCache({ maxEntries: 2, maxTotalBytes: 1e9 })
    const download = vi.fn(async (n: string) => archive(n))

    await cache.get('a', () => download('a'))
    await cache.get('b', () => download('b'))
    // a を読んで新しくする → 追い出されるのは b
    await cache.get('a', () => download('a'))
    await cache.get('c', () => download('c'))

    expect(cache.stats().entries).toBe(2)
    // a は残っている（取得は増えない）
    await cache.get('a', () => download('a'))
    expect(download).toHaveBeenCalledTimes(3)
    // b は追い出されたので取り直しになる
    await cache.get('b', () => download('b'))
    expect(download).toHaveBeenCalledTimes(4)
  })

  // 安全弁: 本数が収まっていてもバイト数で追い出す
  it('バイト数の上限を超えると追い出す（本数が収まっていても）', async () => {
    const cache = createArchiveBodyCache({ maxEntries: 100, maxTotalBytes: 2500 })

    await cache.get('a', async () => archive('a', 1000))
    await cache.get('b', async () => archive('b', 1000))
    await cache.get('c', async () => archive('c', 1000))

    expect(cache.stats().entries).toBe(2)
    expect(cache.stats().bytes).toBeLessThanOrEqual(2500)
  })

  it('控えたばかりを追い出したら記録を残す（上限が足りていない印）', async () => {
    const cache = createArchiveBodyCache({ maxEntries: 1, maxTotalBytes: 1e9 })

    await cache.get('a', async () => archive('a'))
    await cache.get('b', async () => archive('b'))

    expect(cache.stats().evictedRecent).toBeGreaterThan(0)
    expect(warns.join('\n')).toMatch(/アーカイブの控えが上限に達しています/)
  })

  it('同じ URL への同時要求は 1 本にまとめる', async () => {
    const cache = createArchiveBodyCache()
    let resolve: (v: ReturnType<typeof archive>) => void = () => {}
    const download = vi.fn(() => new Promise<ReturnType<typeof archive>>(r => { resolve = r }))

    const a = cache.get('https://x/a', download)
    const b = cache.get('https://x/a', download)
    resolve(archive('a'))

    expect(await a).toBe(await b)
    expect(download).toHaveBeenCalledTimes(1)
    expect(cache.stats().coalesced).toBe(1)
  })

  // **失敗した直後に `await` を挟まずに取り直す形**。取得中の印を外すのを `catch` の先の
  // チェーンへ繋いでいた頃は、外すのが 1 マイクロタスク遅れていたため、ここで reject 済みの
  // Promise を「相乗り」として受け取り**同じ失敗が即座に返っていた**（新しい取得にならない）。
  // 逐次に `await` を挟むテストではこの形は再現しない。
  it('失敗を掴んだ直後に取り直しても、新しい取得になる（相乗りしない）', async () => {
    const cache = createArchiveBodyCache()
    const download = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(archive('a'))

    const result = await cache.get('https://x/a', download)
      .catch(() => cache.get('https://x/a', download))

    expect(result).toBeInstanceOf(Map)
    expect(download).toHaveBeenCalledTimes(2)
    expect(cache.stats().coalesced).toBe(0)
  })

  it('取得の失敗は控えない（次の要求で取り直せる）', async () => {
    const cache = createArchiveBodyCache()
    const download = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(archive('a'))

    await expect(cache.get('https://x/a', download)).rejects.toThrow('boom')
    // 失敗した Promise を控えていると、以後そのセッション中は永久に同じ失敗を返す
    await expect(cache.get('https://x/a', download)).resolves.toBeInstanceOf(Map)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('期限を過ぎた控えは使わず取り直す', async () => {
    let t = 1_000_000
    const cache = createArchiveBodyCache({ now: () => t })
    const download = vi.fn(async () => archive('a'))

    await cache.get('https://x/a', download)
    t += 11 * 60 * 60 * 1000 // 期限内
    await cache.get('https://x/a', download)
    expect(download).toHaveBeenCalledTimes(1)

    t += 2 * 60 * 60 * 1000 // 合計 13 時間 → 期限切れ
    await cache.get('https://x/a', download)
    expect(download).toHaveBeenCalledTimes(2)
    expect(cache.stats().expired).toBe(1)
  })

  // 期限は「控えた時刻」で測る。読むたびに更新される値で測ると、読み続ける限り永久に切れない
  it('期限は読み直しでは延びない', async () => {
    let t = 1_000_000
    const cache = createArchiveBodyCache({ now: () => t })
    const download = vi.fn(async () => archive('a'))

    await cache.get('https://x/a', download)
    // 11 時間ごとに読んでも、控えた時刻からの経過で切れる
    for (let i = 0; i < 2; i++) {
      t += 11 * 60 * 60 * 1000
      await cache.get('https://x/a', download)
    }
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('控えるなと言われたものは控えない（値は返す）', async () => {
    const cache = createArchiveBodyCache()
    const download = vi.fn(async () => ({ ...archive('a'), cacheable: false }))

    const first = await cache.get('https://x/a', download)
    expect(first).toBeInstanceOf(Map)
    // 控えていないので 2 度目も取りに行く
    await cache.get('https://x/a', download)

    expect(download).toHaveBeenCalledTimes(2)
    expect(cache.stats()).toMatchObject({ entries: 0, uncacheable: 2, hits: 0 })
  })

  // **上限は「1 回のまとまった取得が同時に落とす本数」を下回ってはいけない。**
  // 割ると同じ取得の中で追い出しが起き、次の取得で落とし直す（控えの意味が消える）。
  //
  // **数字を写さずに窓の定数から導く。** 写すと、窓を広げたとき（`QUAKE_HISTORY_MAX_DAYS` を
  // 7 → 14 日にする等）にこの境界テストが無反応で通り続ける。**片方の取得だけを見て上限を
  // 決めると足りない** —— 再生の開始（16 本）に合わせた値では「もっと見る」（59 本）を割る。
  it('上限は、まとまった取得が同時に落とす本数を上回る', () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    // リプレイの開始: 履歴の窓 ∪ 初期状態 ∪ 本編。分類は 2 つ（eew.forecast / telegram.earthquake）
    const replayDays = QUAKE_HISTORY_MAX_DAYS
      + Math.ceil(PRE_WINDOW_MS / DAY_MS) + Math.ceil(WINDOW_MS / DAY_MS)
    const replayNeed = (replayDays + 1) * 2
    // 「もっと見る」を限界まで押した状態。分類は telegram.earthquake だけ
    const loadMoreNeed = MAX_HISTORY_DAYS + 1

    expect(MAX_ENTRIES).toBeGreaterThanOrEqual(replayNeed + loadMoreNeed)
    // バイト数は実測から（8 日 × 2 分類で約 55MB・「もっと見る」は測れた 58 日で約 41MB）。
    // 日数ではなく「地震の多い日を何本抱えるか」で決まるので、こちらは実測値を下限に置く
    expect(MAX_TOTAL_BYTES).toBeGreaterThanOrEqual((55 + 41) * 1024 * 1024)
  })
})

// 端末に残す二層目（本番は IndexedDB）。**タブを開き直したあとに効く層**で、
// ここが無いと起動・リプレイの開始のたびにアーカイブを落とし直す。
describe('端末の控え（persist）', () => {
  /** 偽の永続層。実体の代わりに Map を持つ。 */
  function fakePersist(seed?: Map<string, Uint8Array>) {
    const store = seed ?? new Map<string, Uint8Array>()
    const calls = { read: 0, write: 0, expand: 0 }
    return {
      store,
      calls,
      persist: {
        read: async (key: string) => { calls.read++; return store.get(key) ?? null },
        write: async (key: string, gz: Uint8Array) => { calls.write++; store.set(key, gz) },
        expand: async (gz: Uint8Array) => {
          calls.expand++
          return { files: new Map([[`from-disk-${gz[0]}`, new Uint8Array(1)]]), bytes: 1000 }
        },
      },
    }
  }

  // 正: **メモリが空でも、端末の控えに当たれば配信元へ出ない。**
  // これがタブを開き直したときに効く経路そのもの。
  it('端末の控えに当たれば、取得を呼ばない', async () => {
    const f = fakePersist(new Map([['u1', new Uint8Array([7])]]))
    const cache = createArchiveBodyCache({ persist: f.persist })
    const download = vi.fn()

    const files = await cache.get('u1', download)

    expect(download).not.toHaveBeenCalled()
    expect([...files.keys()]).toEqual(['from-disk-7'])
    // 配信元へ出ていないので `misses` では数えない（数えると控えの効きが読めなくなる）
    expect(cache.stats().persistHits).toBe(1)
    expect(cache.stats().misses).toBe(0)
  })

  // 正: 取得したものは端末へ書く（次のタブで効くように）
  it('取得したアーカイブを gzip のまま端末へ書く', async () => {
    const f = fakePersist()
    const cache = createArchiveBodyCache({ persist: f.persist })
    const gz = new Uint8Array([1, 2, 3])

    await cache.get('u1', async () => ({ ...archive('a.xml'), gz }))
    // 書き込みは待たないので、マイクロタスクを 1 周回す
    await Promise.resolve()

    expect(f.store.get('u1')).toBe(gz)
  })

  // 対照: **「控えるな」と言われたら端末へも書かない。** 当日ぶんのアーカイブがこれ。
  // メモリだけ弾いて端末へ書くと、寿命の長い側に育ち途中の中身が残る。
  it('cacheable が false なら端末へ書かない', async () => {
    const f = fakePersist()
    const cache = createArchiveBodyCache({ persist: f.persist })

    await cache.get('u1', async () => ({ ...archive('a.xml'), gz: new Uint8Array([1]), cacheable: false }))
    await Promise.resolve()

    expect(f.store.size).toBe(0)
  })

  // 対照: gzip を渡さない取得元では書かない（書くものが無い）
  it('gz を渡さなければ端末へ書かない', async () => {
    const f = fakePersist()
    const cache = createArchiveBodyCache({ persist: f.persist })

    await cache.get('u1', async () => archive('a.xml'))
    await Promise.resolve()

    expect(f.store.size).toBe(0)
  })

  // 安全弁: **控えが壊れていても取得へ落ちるだけ。** 速くするための仕組みが
  // 機能そのものを止めてはいけない。
  it('端末の控えが読めなくても、取得へ落ちて値を返す', async () => {
    const cache = createArchiveBodyCache({
      persist: {
        read: async () => { throw new Error('disk broken') },
        write: async () => {},
        expand: async () => ({ files: new Map(), bytes: 0 }),
      },
    })

    const files = await cache.get('u1', async () => archive('a.xml'))

    expect([...files.keys()]).toEqual(['a.xml'])
  })

  // 安全弁: 展開に失敗した場合も同じ（壊れた gzip が居座らない）
  it('端末の控えを展開できなくても、取得へ落ちて値を返す', async () => {
    const cache = createArchiveBodyCache({
      persist: {
        read: async () => new Uint8Array([9]),
        write: async () => {},
        expand: async () => { throw new Error('bad gzip') },
      },
    })

    const files = await cache.get('u1', async () => archive('a.xml'))

    expect([...files.keys()]).toEqual(['a.xml'])
  })

  // 安全弁: **書き込みの失敗で取得そのものを壊さない。** 端末へ残すのは次回以降のためで、
  // この呼び出しの結果には関係がない。
  it('端末へ書けなくても、取得した値はそのまま返る', async () => {
    const cache = createArchiveBodyCache({
      persist: {
        read: async () => null,
        write: async () => { throw new Error('quota exceeded') },
        expand: async () => ({ files: new Map(), bytes: 0 }),
      },
    })

    const files = await cache.get('u1', async () => ({ ...archive('a.xml'), gz: new Uint8Array([1]) }))
    await Promise.resolve()

    expect([...files.keys()]).toEqual(['a.xml'])
  })

  // 対照: メモリに載っていれば端末を読みに行かない（二層の順序）
  it('メモリに載っていれば端末を読まない', async () => {
    const f = fakePersist()
    const cache = createArchiveBodyCache({ persist: f.persist })
    await cache.get('u1', async () => ({ ...archive('a.xml'), gz: new Uint8Array([1]) }))
    const before = f.calls.read

    await cache.get('u1', () => { throw new Error('取得も端末も見てはいけない') })

    expect(f.calls.read).toBe(before)
  })

  // 対照: **persist を渡さなければ従来どおりメモリだけで動く。**
  it('persist を渡さなければ、端末の層は無いものとして動く', async () => {
    const cache = createArchiveBodyCache()
    const download = vi.fn(async () => archive('a.xml'))

    await cache.get('u1', download)
    await cache.get('u1', download)

    expect(download).toHaveBeenCalledTimes(1)
    expect(cache.stats().persistHits).toBe(0)
  })
})
