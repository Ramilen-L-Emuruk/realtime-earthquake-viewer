import nodePath from 'node:path'

/** 判定に使うパス操作。テストから `path.win32` を差し込めるように型で絞ってある。 */
type PathApi = Pick<typeof nodePath, 'relative' | 'isAbsolute'>

/**
 * `filePath` が `claudeDir` の中にあるか。`claudeDir` 自身も「中」とみなす。
 *
 * dev サーバーの監視対象から `.claude/` を外すための判定（外す理由は `vite.config.ts` 側の
 * コメント）。判定材料を引数で受け取り `vite.config.ts` から切り離してあるのはユニットテストで
 * 固定するため。ここを緩めると「別セッションの編集でページがリロードされる」状態へ戻り、逆に
 * 広げると「編集しても画面が変わらない」に倒れるが、どちらもエラーを出さないので、境界を動かした
 * ときに CI が気づける形にしておく。
 *
 * `pathApi` は実行環境のパス操作を既定にする。テストが `path.win32` を渡せるようにしてあるのは、
 * CI（Linux）でも Windows での挙動を固定するため。
 */
export function isInsideClaudeDir(
  claudeDir: string,
  filePath: string,
  pathApi: PathApi = nodePath,
): boolean {
  // glob（`**/.claude/**`）では書けない。ワークツリーを `.claude/worktrees/<name>` に置く規約の
  // ため、ワークツリー内で dev を起動すると root 自身のパスが `.claude/` を含み、プロジェクト全体が
  // 監視対象から外れる。基準を「呼び出し側が渡した 1 つの `.claude/`」に固定して、そこだけを見る。
  //
  // 文字列の前方一致ではなく relative を使うのは、chokidar（内部で使う anymatch）が渡すパスが
  // 常にスラッシュ区切りへ正規化されるのに対し、`claudeDir` 側は実行環境のパス区切りになるため。
  // 両者の流儀の違いをここで吸収する。
  //
  // `rel` が空文字列になるのは `filePath` が `claudeDir` 自身のとき。これも対象に含める（外すと
  // chokidar がこのディレクトリへ監視ハンドルを張る。中身は除外されるので誤リロードには至らないが、
  // 張る意味も無い）。`isAbsolute` を見るのは別ドライブへの備えで、Windows で `C:` と `D:` を跨ぐと
  // relative は相対パスを作れず絶対パスをそのまま返す。
  const rel = pathApi.relative(claudeDir, filePath)
  return !rel.startsWith('..') && !pathApi.isAbsolute(rel)
}
