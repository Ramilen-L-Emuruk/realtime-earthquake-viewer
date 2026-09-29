import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PRECACHE_BUDGET_BYTES,
  PRECACHE_BUDGET_RATIO,
  PRECACHE_EXTENSIONS,
  PRECACHE_GLOB_PATTERNS,
  PRECACHE_MAX_FILE_BYTES,
  evaluatePrecacheBudget,
  formatPrecacheBudget,
  isServiceWorkerAsset,
} from './precacheBudget'
import { outDirForVariant } from './buildOutDir'

// 結線の検査で読むファイル。テスト本体ではなくここで読む（読み込みの待ちを 1 件目の
// 所要時間へ乗せないため。理由は CLAUDE.md「検証」節）。
const VITE_CONFIG = readFileSync('vite.config.ts', 'utf8')
const PACKAGE_JSON = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
}

// precache の 1 ファイル上限に対する「予算」。上限そのものは vite-plugin-pwa が見ているので、
// ここで固定するのは**上限の手前で止まること**と、**上限側を緩めていないこと**の 2 つ。
describe('evaluatePrecacheBudget', () => {
  it('予算を超えたファイルがあれば ok=false になる（正）', () => {
    const r = evaluatePrecacheBudget([
      { path: 'assets/index.js', size: PRECACHE_BUDGET_BYTES + 1 },
      { path: 'assets/small.js', size: 1000 },
    ])
    expect(r.ok).toBe(false)
    expect(r.over.map(f => f.path)).toEqual(['assets/index.js'])
  })

  it('予算ちょうどでは ok=true のまま（対照・境界）', () => {
    const r = evaluatePrecacheBudget([{ path: 'assets/index.js', size: PRECACHE_BUDGET_BYTES }])
    expect(r.ok).toBe(true)
    expect(r.over).toEqual([])
  })

  it('予算は上限より小さい（安全弁 — 上限まで使い切る形へ緩めない）', () => {
    expect(PRECACHE_BUDGET_BYTES).toBeLessThan(PRECACHE_MAX_FILE_BYTES)
    expect(PRECACHE_BUDGET_RATIO).toBeGreaterThan(0)
    expect(PRECACHE_BUDGET_RATIO).toBeLessThan(1)
  })

  it('上限は workbox の既定（2 MiB）と同値（安全弁 — 引き上げで済ませない）', () => {
    expect(PRECACHE_MAX_FILE_BYTES).toBe(2 * 1024 * 1024)
  })

  it('大きい順に並べて返す', () => {
    const r = evaluatePrecacheBudget([
      { path: 'a', size: 10 },
      { path: 'b', size: 300 },
      { path: 'c', size: 200 },
    ])
    expect(r.files.map(f => f.path)).toEqual(['b', 'c', 'a'])
  })

  it('超過が複数あれば全件を大きい順に返す', () => {
    const r = evaluatePrecacheBudget([
      { path: 'small.js', size: 1 },
      { path: 'x.js', size: PRECACHE_BUDGET_BYTES + 10 },
      { path: 'y.js', size: PRECACHE_BUDGET_BYTES + 99 },
    ])
    expect(r.over.map(f => f.path)).toEqual(['y.js', 'x.js'])
  })
})

// Service Worker 自身は precache の中身ではなく、precache を配る側。数えると
// 「対象 N 件」が実際の precache 件数とずれる。
describe('isServiceWorkerAsset', () => {
  it('sw.js と workbox-<hash>.js は数えない', () => {
    expect(isServiceWorkerAsset('sw.js')).toBe(true)
    expect(isServiceWorkerAsset('workbox-e4022e15.js')).toBe(true)
  })

  it('バンドルやグリフは数える', () => {
    expect(isServiceWorkerAsset('assets/index-DVrtTHiI.js')).toBe(false)
    expect(isServiceWorkerAsset('fonts/M PLUS Rounded 1c/0-255.pbf')).toBe(false)
    // 名前が似ているだけのアプリ側のファイルを取りこぼさない。
    expect(isServiceWorkerAsset('assets/workbox-helper.js')).toBe(false)
    expect(isServiceWorkerAsset('sub/sw.js')).toBe(false)
  })
})

// 拡張子の一覧と glob を別々に持つと、拡張子を足したときに検査の網だけが古いまま残る。
describe('PRECACHE_GLOB_PATTERNS', () => {
  it('拡張子の一覧から組み立てる', () => {
    expect(PRECACHE_GLOB_PATTERNS).toEqual([`**/*.{${PRECACHE_EXTENSIONS.join(',')}}`])
  })

  it('地名ラベルのグリフ（pbf）を含む', () => {
    expect(PRECACHE_EXTENSIONS).toContain('pbf')
  })
})

describe('formatPrecacheBudget', () => {
  it('予算内でも最大ファイルと使用率を出す（すれすれで走っていることが見えるように）', () => {
    const out = formatPrecacheBudget(
      evaluatePrecacheBudget([{ path: 'assets/index.js', size: 1024 * 1024 }]),
    )
    expect(out).toContain('ok')
    expect(out).toContain('assets/index.js')
    expect(out).toContain('50.0%')
  })

  it('超過時は分割を促し、上限の引き上げを勧めない', () => {
    const out = formatPrecacheBudget(
      evaluatePrecacheBudget([{ path: 'assets/index.js', size: PRECACHE_BUDGET_BYTES + 1 }]),
    )
    expect(out).toContain('予算超過')
    expect(out).toContain('manualChunks')
    expect(out).toContain('上限を引き上げて済ませないこと')
  })
})

// 出力先を取り違えると、**存在するけれど中身が別バリアントのディレクトリ**を検査してしまう。
// その場合ファイルは見つかるので「0 件」のガードに掛からず、予算内として通ってしまう。
describe('outDirForVariant', () => {
  it('dmdss は dist-dmdss、それ以外は dist', () => {
    expect(outDirForVariant('dmdss')).toBe('dist-dmdss')
    expect(outDirForVariant('standard')).toBe('dist')
    expect(outDirForVariant(undefined)).toBe('dist')
  })
})

// **この仕組みは 3 つのファイルに跨って初めて働く**（定数・vite.config.ts・package.json）。
// どれか 1 つだけ書き換えても型検査は通り、ビルドも成功するので、検査が無効になったことに
// 気づく手掛かりが残らない。その結線をここで固定する。
describe('検査の結線', () => {
  it('vite.config.ts は上限と globPatterns を precacheBudget から取る', () => {
    expect(VITE_CONFIG).toContain("from './scripts/precacheBudget'")
    expect(VITE_CONFIG).toContain('maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES')
    expect(VITE_CONFIG).toContain('globPatterns: [...PRECACHE_GLOB_PATTERNS]')
  })

  it('vite.config.ts は出力先を buildOutDir から取る', () => {
    expect(VITE_CONFIG).toContain("from './scripts/buildOutDir'")
    expect(VITE_CONFIG).toContain('outDir: outDirForVariant(')
  })

  it('build・build:dmdss の両方が検査を呼ぶ', () => {
    for (const name of ['build', 'build:dmdss']) {
      expect(PACKAGE_JSON.scripts[name]).toContain('check-precache-budget')
    }
  })

  // DMDSS 版のビルドから VITE_VARIANT が落ちると、検査だけが standard の `dist/`（前回の
  // ビルドが残っていれば存在する）を見て通る。段ごとに分けて確かめる。
  it('DMDSS 版は検査にも VITE_VARIANT=dmdss を渡す', () => {
    const step = PACKAGE_JSON.scripts['build:dmdss']
      .split('&&')
      .map(s => s.trim())
      .find(s => s.includes('check-precache-budget'))
    expect(step).toBeDefined()
    expect(step).toContain('VITE_VARIANT=dmdss')
  })

  it('standard 版は VITE_VARIANT を渡さない（既定の dist を見る）', () => {
    const step = PACKAGE_JSON.scripts.build
      .split('&&')
      .map(s => s.trim())
      .find(s => s.includes('check-precache-budget'))
    expect(step).toBeDefined()
    expect(step).not.toContain('VITE_VARIANT')
  })

  it('検査はビルドより後に走る（成果物が無ければ意味が無い）', () => {
    for (const name of ['build', 'build:dmdss']) {
      const steps = PACKAGE_JSON.scripts[name].split('&&').map(s => s.trim())
      const build = steps.findIndex(s => s.includes('vite build'))
      const check = steps.findIndex(s => s.includes('check-precache-budget'))
      expect(build).toBeGreaterThanOrEqual(0)
      expect(check).toBeGreaterThan(build)
    }
  })
})
