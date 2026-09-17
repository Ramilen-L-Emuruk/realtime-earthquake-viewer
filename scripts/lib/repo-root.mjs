import path from 'node:path'
import { fileURLToPath } from 'node:url'

// リポジトリの根は自身の位置から導く。ワークツリーへ持っていっても、そのワークツリーの
// 実装を読む（絶対パスを書くと、別の作業場の古い実装を測ってしまう）。
//
// **`coverage-core.mjs` から切り出してある。** あちらは import した時点で
// `TELEGRAM_AUDIT_DIR`（作業ディレクトリ）の指定を要求して throw するため、
// 根のパスだけが必要なモジュールまで環境変数に縛られていた。実際、レート制御を
// 単体テストへ掛けようとしたところ、import しただけで落ちた。
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
