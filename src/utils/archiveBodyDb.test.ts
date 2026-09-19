// アーカイブ本体の永続層（IndexedDB）の挙動を固定する。
//
// **フェイクの `ArchivePersistence`（`archiveBodyCache.test.ts`）では代われない。** あちらが
// 見るのは二層の繋ぎ方で、こちらは**本物の IndexedDB で追い出し・期限・トランザクションが
// 意図どおり動くか**。この層が黙って効かなくなると、症状は「なぜか毎回時間がかかる」だけになる。
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  readArchiveBody, writeArchiveBody, archiveBodyDbStats, clearArchiveBodyDb,
  hasArchiveCacheError, archiveCachePurgeStats, onArchiveCacheChanged,
  MAX_ENTRIES, MAX_TOTAL_BYTES,
} from './archiveBodyDb'

/**
 * `fake-indexeddb/auto` はプロセス全体で 1 つの実装を共有するので、テストごとに空にする。
 * 鍵（URL）も衝突しないよう、テストごとに変える。
 */
beforeEach(async () => {
  await clearArchiveBodyDb()
})
afterEach(() => { vi.restoreAllMocks() })

/** `n` バイトの gzip もどき（中身は問われないので 0 埋め）。 */
function gz(n: number, seed = 0): Uint8Array {
  const a = new Uint8Array(n)
  a[0] = seed
  return a
}

describe('archiveBodyDb', () => {
  // 正: 書いたものが読める（この層の存在理由そのもの）
  it('書いた本体を gzip のまま読み戻せる', async () => {
    await writeArchiveBody('https://x/a', gz(16, 7))

    const got = await readArchiveBody('https://x/a')
    expect(got).toBeInstanceOf(Uint8Array)
    expect(got?.byteLength).toBe(16)
    expect(got?.[0]).toBe(7)
  })

  // 対照: 書いていない鍵は null（「無い」と「読めない」を混ぜない入口）
  it('書いていない鍵は null を返す', async () => {
    expect(await readArchiveBody('https://x/never')).toBeNull()
  })

  // 正: 件数と容量を数えられる（設定タブが読む値）
  it('件数と合計バイト数を数える', async () => {
    await writeArchiveBody('https://x/b1', gz(100))
    await writeArchiveBody('https://x/b2', gz(200))

    expect(await archiveBodyDbStats()).toEqual({ entries: 2, bytes: 300 })
  })

  // 対照: 本当に空のときは 0 件（`null`＝読めなかった、とは別）
  it('空のときは 0 件を返す（読めなかったときの null とは別）', async () => {
    expect(await archiveBodyDbStats()).toEqual({ entries: 0, bytes: 0 })
  })

  // 安全弁: **バッファ全体を抱えているビューはコピーしてから置く。**
  // 切り出しをそのまま渡すと、置いた覚えのない大きさが積み上がる。
  it('切り出し（subarray）を渡しても、その長さだけを控える', async () => {
    const big = new Uint8Array(1000)
    const view = big.subarray(10, 30)   // byteOffset を持つビュー

    await writeArchiveBody('https://x/view', view)

    const stats = await archiveBodyDbStats()
    expect(stats?.bytes).toBe(20)
    expect((await readArchiveBody('https://x/view'))?.byteLength).toBe(20)
  })

  // 正: 合計バイト数の上限を超えたら古い順に捨てる
  it('合計バイト数が上限を超えたら、古い順に捨てる', async () => {
    // 上限の 1/3 強を 3 本入れると、3 本目で超える
    const size = Math.ceil(MAX_TOTAL_BYTES / 2.5)
    await writeArchiveBody('https://x/old', gz(size))
    await writeArchiveBody('https://x/mid', gz(size))
    await writeArchiveBody('https://x/new', gz(size))

    // いちばん古いものが落ちる
    expect(await readArchiveBody('https://x/old')).toBeNull()
    expect(await readArchiveBody('https://x/new')).not.toBeNull()
    expect(archiveCachePurgeStats().purged).toBeGreaterThan(0)
  })

  // 安全弁: **控えた直後に捨てた本数を数える。** 上限が足りていないと開始のたびに
  // 追い出しと取り直しを繰り返すが、件数を守っているだけでは正常と見分けが付かない。
  it('控えた直後に捨てた本数を数える', async () => {
    const size = Math.ceil(MAX_TOTAL_BYTES / 2.5)
    const before = archiveCachePurgeStats().purgedRecent
    await writeArchiveBody('https://x/t1', gz(size))
    await writeArchiveBody('https://x/t2', gz(size))
    await writeArchiveBody('https://x/t3', gz(size))

    expect(archiveCachePurgeStats().purgedRecent).toBeGreaterThan(before)
  })

  // 対照: 上限の内側では捨てない
  it('上限の内側なら捨てない', async () => {
    const before = archiveCachePurgeStats().purged
    await writeArchiveBody('https://x/s1', gz(10))
    await writeArchiveBody('https://x/s2', gz(10))

    expect(archiveCachePurgeStats().purged).toBe(before)
    expect((await archiveBodyDbStats())?.entries).toBe(2)
  })

  // 正: 期限を過ぎた控えは使わない（配信元の設計が変わったときに気づく手立て）
  it('期限を過ぎた控えは使わず、その場で捨てる', async () => {
    await writeArchiveBody('https://x/stale', gz(8))
    // 控えた時刻を 31 日後から見る（期限は 30 日）
    const later = Date.now() + 31 * 24 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(later)

    expect(await readArchiveBody('https://x/stale')).toBeNull()
    vi.restoreAllMocks()
    // 読んだ時点で捨てているので、件数からも消えている
    expect((await archiveBodyDbStats())?.entries).toBe(0)
  })

  // 対照: 期限の内側なら使う
  it('期限の内側なら読める', async () => {
    await writeArchiveBody('https://x/fresh', gz(8))
    const later = Date.now() + 29 * 24 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(later)

    expect(await readArchiveBody('https://x/fresh')).not.toBeNull()
  })

  // 正: 増減を購読できる（設定タブが読み直す契機）
  it('書き込みと消去を購読者へ知らせる', async () => {
    let calls = 0
    const off = onArchiveCacheChanged(() => { calls++ })
    try {
      await writeArchiveBody('https://x/n1', gz(8))
      // 通知はまとめて届く（500ms）
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 2000 })
    } finally {
      off()
    }
  })

  // 対照: 解除したら届かない
  it('購読を解除したら知らせない', async () => {
    let calls = 0
    const off = onArchiveCacheChanged(() => { calls++ })
    off()
    await writeArchiveBody('https://x/n2', gz(8))
    await new Promise(r => setTimeout(r, 700))

    expect(calls).toBe(0)
  })

  // 安全弁: **使えているあいだは「使えません」と言わない。**
  // 一度立てたままにすると、一時的な不調から回復したあとも警告が残る。
  it('読み書きが通っているあいだは、使えない扱いにしない', async () => {
    await writeArchiveBody('https://x/ok', gz(8))
    await readArchiveBody('https://x/ok')

    expect(hasArchiveCacheError()).toBe(false)
  })

  // 上限の値そのものが、まとまった取得で落とす量を下回らないこと
  // （下回ると同じ取得の中で追い出しが起き、次の取得で落とし直す＝控えの意味が消える）
  it('上限は、まとまった取得が同時に落とす量を上回る', () => {
    // リプレイの開始は最大 16 本・「もっと見る」は最大 59 本
    expect(MAX_ENTRIES).toBeGreaterThan(16 + 59)
    // 実測: 8 日 × 2 分類で展開 55MB ＝ gz でおよそ 1/12〜1/18。gz で数えるので桁の余裕を見る
    expect(MAX_TOTAL_BYTES).toBeGreaterThanOrEqual(100 * 1024 * 1024)
  })
})
