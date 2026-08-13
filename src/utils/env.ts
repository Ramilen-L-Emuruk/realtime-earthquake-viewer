// ビルドバリアント判定。`vite.config.ts` の VITE_VARIANT でビルド時に固定される。
// standard/dmdss は別ビルド・別デプロイパスであり実行時に切り替わることは無い（`docs/spec/architecture-spec.md` §2）。
//
// 従来は各ファイル冒頭で `const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'` を
// コピーペーストしていた。DRY-3 で単一情報源へ集約した。
export const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'
