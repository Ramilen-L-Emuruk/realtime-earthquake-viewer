import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPublicWaveDb, publicWaveKey, readPublicWave, writePublicWave } from './publicQuakeWaveDb'

const base = (key: string, originMs: number) => ({ key, originMs, state: 'settled' as const, toMs: originMs + 240_000, fetchedAtMs: 0, retries: 0 })

describe('publicQuakeWaveDb', () => {
  beforeEach(async () => {
    await clearPublicWaveDb()
  })

  it('書いた生バイトと目録をそのまま読み戻す', async () => {
    const key = publicWaveKey('JMM', 1000)
    expect(await writePublicWave(base(key, 1000), new Uint8Array([9, 8, 7]))).toBe(true)
    const got = await readPublicWave(key)
    expect(got?.meta).toMatchObject({ key, originMs: 1000, bytes: 3, state: 'settled' })
    expect(Array.from(got!.bytes!)).toEqual([9, 8, 7])
  })

  // 確かな不在は本体を持たず、目録だけ残す（取り直さないため）。
  it('不在は本体なしで残る', async () => {
    const key = publicWaveKey('JMM', 2000)
    await writePublicWave({ ...base(key, 2000), state: 'absent' }, null)
    const got = await readPublicWave(key)
    expect(got?.meta.state).toBe('absent')
    expect(got?.bytes).toBeNull()
  })

  it('無い鍵は null', async () => {
    expect(await readPublicWave('nope')).toBeNull()
  })

  // 切り出しのビューを渡しても、切り出した分だけが置かれる。
  it('切り出しのビューは切り出した長さで数える', async () => {
    const whole = new Uint8Array(100)
    const key = publicWaveKey('YOJ', 3000)
    await writePublicWave(base(key, 3000), whole.subarray(10, 20))
    expect((await readPublicWave(key))?.meta.bytes).toBe(10)
  })
})
