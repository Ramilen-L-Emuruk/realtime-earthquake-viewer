import { describe, it, expect } from 'vitest'
import { shouldInjectDevApiKey, shouldInjectDevArrivalToken } from './dev-api-key-gate'

// dev サーバーへ実キーを渡してよい条件。ここが緩むと、認証を持たない dev サーバー経由で
// API キーが配られる。条件ごとに 1 件ずつ固定して、条件を消したら落ちるようにしておく。
describe('shouldInjectDevApiKey', () => {
  const serve = { command: 'serve' }

  it('dev サーバー・DMDSS 版・LAN 公開なしなら投入する', () => {
    expect(shouldInjectDevApiKey(serve, true, ['node', 'vite'])).toBe(true)
  })

  it('build では投入しない', () => {
    expect(shouldInjectDevApiKey({ command: 'build' }, true, ['node', 'vite', 'build'])).toBe(false)
  })

  it('vite preview では投入しない（command は serve になる）', () => {
    expect(shouldInjectDevApiKey({ command: 'serve', isPreview: true }, true, ['node', 'vite', 'preview'])).toBe(false)
  })

  it('standard 版では投入しない', () => {
    expect(shouldInjectDevApiKey(serve, false, ['node', 'vite'])).toBe(false)
  })

  it('--host を付けた起動では投入しない', () => {
    expect(shouldInjectDevApiKey(serve, true, ['node', 'vite', '--host'])).toBe(false)
  })

  it('--host=0.0.0.0 の形でも投入しない', () => {
    expect(shouldInjectDevApiKey(serve, true, ['node', 'vite', '--host=0.0.0.0'])).toBe(false)
  })

  it('--host 以外の引数は投入を妨げない', () => {
    expect(shouldInjectDevApiKey(serve, true, ['node', 'vite', '--port', '5173', '--strictPort'])).toBe(true)
  })

  // `--hostname` のような別オプションを `--host` と誤認すると、公開していないのに投入を
  // やめてしまう（安全側だが原因が分かりにくい）。前方一致は `--host=` に限る。
  it('--host で始まる別名オプションは LAN 公開と見なさない', () => {
    expect(shouldInjectDevApiKey(serve, true, ['node', 'vite', '--hostname', 'example'])).toBe(true)
  })
})

describe('shouldInjectDevArrivalToken', () => {
  const serve = { command: 'serve' }

  it('dev サーバーなら投入する', () => {
    expect(shouldInjectDevArrivalToken(serve, ['node', 'vite'])).toBe(true)
  })

  it('build には投入しない（配信される JS にトークンが載るため）', () => {
    expect(shouldInjectDevArrivalToken({ command: 'build' }, ['node', 'vite', 'build'])).toBe(false)
  })

  it('preview には投入しない', () => {
    expect(shouldInjectDevArrivalToken({ command: 'serve', isPreview: true }, ['node', 'vite', 'preview'])).toBe(false)
  })

  it('--host（LAN 公開）では投入しない', () => {
    expect(shouldInjectDevArrivalToken(serve, ['node', 'vite', '--host'])).toBe(false)
    expect(shouldInjectDevArrivalToken(serve, ['node', 'vite', '--host=0.0.0.0'])).toBe(false)
  })

  it('バリアントを問わない（API キーと違う点）', () => {
    // トークンが開くのはホーム地点への到達予想で、standard 版・DMDSS 版のどちらにもある機能。
    // 引数にバリアントを取らないこと自体がその表明なので、standard 版の起動でも true になる。
    expect(shouldInjectDevArrivalToken(serve, ['node', 'vite'])).toBe(true)
  })
})
