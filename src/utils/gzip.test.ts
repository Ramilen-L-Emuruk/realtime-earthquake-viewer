// gzip 展開の単体テスト。
// 背景: v4.10.1 で修正したデッドロック（自前の writer/reader を直列に回したことによる
// バックプレッシャの相互待ち）は、実機のブラウザ確認でしか発覚しなかった。同じ事故を
// 二度と通さないよう、展開後サイズが内部キューを超えるケースを回帰テストとして固定する。
import { describe, it, expect } from 'vitest'
import { gunzip } from './gzip'

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe('gunzip', () => {
  it('gzip したバイト列を元に戻せる', async () => {
    const original = new TextEncoder().encode(JSON.stringify({ type: 'VXSE53', hypocenter: '三陸沖' }))
    const restored = await gunzip(await gzipBytes(original))
    expect(restored).toEqual(original)
  })

  it('空データも扱える', async () => {
    const original = new Uint8Array(0)
    expect(await gunzip(await gzipBytes(original))).toEqual(original)
  })

  // 回帰テスト（v4.10.1）: 旧実装はここで永久に resolve しなくなり、テストは
  // タイムアウトで落ちる。展開後 1MB は DecompressionStream の内部キューを確実に超える。
  it('展開後が内部キューを超える大きさでも完了する（デッドロック回帰）', async () => {
    const original = new Uint8Array(1_000_000) // ゼロ埋め＝高圧縮率
    const gz = await gzipBytes(original)
    expect(gz.length).toBeLessThan(original.length / 10)

    const restored = await gunzip(gz)
    expect(restored.length).toBe(original.length)
  })

  it('複数チャンクにまたがっても順序どおり連結される', async () => {
    // 疑似ランダムで圧縮しにくいデータを作り、展開が複数チャンクに割れる状況を作る
    const original = new Uint8Array(300_000)
    let seed = 12345
    for (let i = 0; i < original.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      original[i] = seed & 0xff
    }
    expect(await gunzip(await gzipBytes(original))).toEqual(original)
  })

  it('gzip でないバイト列は reject する（無言で空を返さない）', async () => {
    await expect(gunzip(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow()
  })

  it('途中で切れた gzip は reject する', async () => {
    const gz = await gzipBytes(new TextEncoder().encode('x'.repeat(10_000)))
    await expect(gunzip(gz.subarray(0, Math.floor(gz.length / 2)))).rejects.toThrow()
  })
})
