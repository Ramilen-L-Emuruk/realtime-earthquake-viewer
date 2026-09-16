import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  readArchiveBody, writeArchiveBody, clearArchiveBodyCacheForTest,
  MAX_ENTRIES,
} from './archiveBodyCache'
import { log } from './logger'

vi.mock('./logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogThrottle: () => (emit: () => void) => emit(),
}))

/**
 * アーカイブ本体（`data.api.dmdata.jp/v1/archive/:id`）の控え。
 *
 * **配信元がこのエンドポイント固有に「同じ id に対して短期間にリクエストを繰り返さないように
 * 実装してください」と求めている**（`Archive Data v1` の「注意」）。控えが無かった頃は
 * ページを再読込するたびに同じ日のアーカイブを取り直していた。
 */
describe('アーカイブ本体の控え', () => {
  beforeEach(async () => {
    await clearArchiveBodyCacheForTest()
    vi.clearAllMocks()
  })

  // 正: 書いたものが読める。これが控えの本体。
  it('書いたものが読める', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    await writeArchiveBody('d1', bytes)

    expect(await readArchiveBody('d1')).toEqual(bytes)
  })

  // 対照: 控えていない id では null。**取得側は null を「取りに行け」と読む**ので、
  // ここが誤って値を返すと別の日のアーカイブを使うことになる。
  it('控えていない id では null を返す', async () => {
    expect(await readArchiveBody('unknown')).toBeNull()
  })

  // 安全弁: 上限を超えたら古い順に捨て、**そのことを記録する**。
  // 上限に達した状態が続くと控えはほとんど効かなくなるが、「上限を守っている」だけでは
  // 正常と見分けが付かない。しかも**いちばん効いてほしい場面（「もっと見る」を上限まで
  // 押したとき）で起こる**。
  it('件数の上限を超えたら古い順に捨て、記録を残す', async () => {
    const body = new Uint8Array(16)
    // 上限 +2 件を書き、古いものが消えることを見る。
    // **`lastUsedAt` 昇順で捨てる**ので、先に書いたものから消える。
    for (let i = 0; i < MAX_ENTRIES + 2; i++) {
      await writeArchiveBody(`d${i}`, body)
      // 同じミリ秒に並ぶと順序が決まらないので、書き込みのあいだに時刻を進める
      vi.setSystemTime(Date.now() + 1)
    }

    // 最初に書いたものは落ちている
    expect(await readArchiveBody('d0')).toBeNull()
    // 最後に書いたものは残っている
    expect(await readArchiveBody(`d${MAX_ENTRIES + 1}`)).toEqual(body)
    // 黙って捨てない
    const warns = vi.mocked(log.warn).mock.calls.map(c => String(c[0]))
    expect(warns.some(m => m.includes('アーカイブの控えが上限に達しています'))).toBe(true)
  })

  // 安全弁: 有効期限を過ぎたものは返さない。
  // アーカイブの中身は生成後に変わらないので**古くなったから捨てるのではなく、読む見込みが
  // 無くなったから捨てる**（「もっと見る」の上限 59 日より先に置いてある）。
  it('有効期限を過ぎたものは返さない', async () => {
    const body = new Uint8Array([9])
    await writeArchiveBody('old', body)

    // 期限（70 日）より先へ進める
    vi.setSystemTime(Date.now() + 71 * 24 * 60 * 60 * 1000)

    expect(await readArchiveBody('old')).toBeNull()
  })
})
