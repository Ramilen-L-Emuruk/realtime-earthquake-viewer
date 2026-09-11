import { describe, it, expect } from 'vitest'
import nodePath, { join, resolve } from 'node:path'
import { isInsideClaudeDir } from './dev-watch-ignore'

// 判定の境界を 1 つずつ固定する（なぜこの判定なのかは `dev-watch-ignore.ts` の JSDoc）。
describe('isInsideClaudeDir', () => {
  // メインリポジトリ直下で dev サーバーを起動した場合
  const repo = resolve('/repo')
  const claudeDir = join(repo, '.claude')

  it('ワークツリーのファイルは対象（外すと別セッションの編集でページがリロードされる）', () => {
    expect(isInsideClaudeDir(claudeDir, join(repo, '.claude', 'worktrees', 'wt', 'index.html'))).toBe(true)
  })

  it('`.claude` ディレクトリ自身も対象', () => {
    expect(isInsideClaudeDir(claudeDir, claudeDir)).toBe(true)
  })

  it('アプリのソースは対象外（含めると HMR が効かなくなる）', () => {
    expect(isInsideClaudeDir(claudeDir, join(repo, 'src', 'App.tsx'))).toBe(false)
  })

  it('接頭辞が同じだけの兄弟ディレクトリは対象外', () => {
    expect(isInsideClaudeDir(claudeDir, join(repo, '.claudex', 'a.ts'))).toBe(false)
  })

  // ワークツリー内で dev サーバーを起動した場合。root 自身のパスが `.claude/worktrees/<name>` を
  // 含むため、判定を glob（`**/.claude/**`）へ書き換えるとここが全部 true になり HMR が死ぬ。
  describe('ワークツリー内で起動したとき', () => {
    const worktree = join(repo, '.claude', 'worktrees', 'wt')
    const worktreeClaudeDir = join(worktree, '.claude')

    it('root 配下のソースは対象外', () => {
      expect(isInsideClaudeDir(worktreeClaudeDir, join(worktree, 'src', 'App.tsx'))).toBe(false)
    })

    it('root 自身も対象外', () => {
      expect(isInsideClaudeDir(worktreeClaudeDir, worktree)).toBe(false)
    })

    it('そのワークツリー自身の `.claude/` 配下は対象', () => {
      expect(isInsideClaudeDir(worktreeClaudeDir, join(worktree, '.claude', 'logs', 'dev.log'))).toBe(true)
    })

    it('隣のワークツリーは対象外（root の外なので、そもそも監視対象に入らない）', () => {
      expect(isInsideClaudeDir(worktreeClaudeDir, join(repo, '.claude', 'worktrees', 'other', 'index.html'))).toBe(false)
    })
  })

  // 実運用では、監視側が渡すパスと `claudeDir` で区切り文字の流儀が違う。chokidar（内部で使う
  // anymatch）は常にスラッシュへ正規化して渡すのに対し、`claudeDir` は `fileURLToPath` の戻り値
  // なので Windows ではバックスラッシュになる。CI は Linux で走るため、Windows での挙動は
  // `path.win32` を差し込んで固定する。
  describe('Windows（区切り文字が混在する経路）', () => {
    const win = nodePath.win32
    const winClaudeDir = 'C:\\repo\\.claude'

    it('claudeDir がバックスラッシュ・監視側がスラッシュでも対象と判定する', () => {
      expect(isInsideClaudeDir(winClaudeDir, 'C:/repo/.claude/worktrees/wt/index.html', win)).toBe(true)
    })

    it('同じ混在でも、アプリのソースは対象外のまま', () => {
      expect(isInsideClaudeDir(winClaudeDir, 'C:/repo/src/App.tsx', win)).toBe(false)
    })

    it('別ドライブは対象外（relative が絶対パスを返すため isAbsolute で弾く）', () => {
      expect(isInsideClaudeDir(winClaudeDir, 'D:/other/.claude/x.ts', win)).toBe(false)
    })
  })
})
