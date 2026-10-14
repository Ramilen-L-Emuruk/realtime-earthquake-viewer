import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanupOutdatedCachesForVariant } from './precacheCleanup'

// 結線の検査で読むファイル。テスト本体ではなくここで読む（理由は CLAUDE.md「検証」節）。
const VITE_CONFIG = readFileSync('vite.config.ts', 'utf8')

// standard 版の片付けは DMDSS 版の事前キャッシュを巻き込む（理由は precacheCleanup.ts）。
// 戻しても型チェックもビルドも通り、症状は両方の版を同じブラウザで開いた端末のオフライン起動にしか出ない。
describe('cleanupOutdatedCachesForVariant', () => {
  it('standard 版では片付けを走らせない（正）', () => {
    expect(cleanupOutdatedCachesForVariant('standard')).toBe(false)
  })

  it('バリアント未指定（npm run build）も standard 版として扱う（正）', () => {
    expect(cleanupOutdatedCachesForVariant(undefined)).toBe(false)
  })

  it('DMDSS 版は既定どおり片付ける（対照）', () => {
    expect(cleanupOutdatedCachesForVariant('dmdss')).toBe(true)
  })

  it('vite.config.ts はこの判定を通して設定する（安全弁 — 直書きへ戻さない）', () => {
    expect(VITE_CONFIG).toContain("from './scripts/precacheCleanup'")
    expect(VITE_CONFIG).toContain('cleanupOutdatedCaches: cleanupOutdatedCachesForVariant(variant)')
    expect(VITE_CONFIG.match(/cleanupOutdatedCaches:/g)).toHaveLength(1)
  })
})
