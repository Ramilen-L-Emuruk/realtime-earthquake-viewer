# CLAUDE.md

realtime-earthquake-viewer（リアルタイム地震ビューアー）で作業するときの手順とルール。

## プロジェクト概要

- React 18 + TypeScript + Vite 6 製の PWA。MapLibre GL JS（WebGL）地図で地震情報・緊急地震速報・津波情報・リアルタイム震度を表示する。
- データ: DMDATA.JP API（WebSocket + REST）／ Yahoo リアルタイム震度（強震モニタ・HTTPS JSON）（DMDSS 版）、P2PQuake API v2（標準版）。
- GitHub Pages（サブパス配信 `/realtime-earthquake-viewer/`）へ GitHub Actions で自動デプロイ。

## ビルドバリアントと URL（重要）

このプロジェクトには **2 つのビルドバリアント** があり、**配信パスが異なる**。

| バリアント | dev 起動コマンド | ビルド出力 | 配信パス（URL） |
|---|---|---|---|
| standard | `npm run dev` | `dist/` | `/realtime-earthquake-viewer/` |
| DMDSS | `npm run dev:dmdss` | `dist-dmdss/` | `/realtime-earthquake-viewer/dmdss/` |

- **DMDSS 版の検証時は `npm run dev:dmdss` で起動し、必ず `/dmdss/` サブパスにアクセスすること**
  - dev URL 例: `http://localhost:5173/realtime-earthquake-viewer/dmdss/`（ポートはフォールバックで変わる）
- `npm run dev`（standard 版）では DMDSS 設定セクションが表示されず、P2PQuake 接続になる
- Windows で `cross-env` が動かない場合は PowerShell から `$env:VITE_VARIANT="dmdss"; npx vite` で代替起動する

## 変更時の基本フロー（必ずこの順で行う）

1. **状況整理・修正方針の確認**（実装に着手する前に必ず行う。自明な軽微修正でも省略しない）
   - 対象のコード・挙動を調査し、現状と問題点（原因・影響範囲）を整理する
   - 整理した内容と修正方針（どこを・なぜ・どう直すか）をユーザーに提示する
   - ユーザーの確認を得てから次のステップに進む。指摘や方針変更があれば整理からやり直す
2. **ワークツリー作成**（修正・機能追加時はワークツリーを作成してから作業する。ブランチ名は必ず `worktree/<type>/<name>` 形式にする: `worktree/fix/〇〇`・`worktree/feat/〇〇`・`worktree/refactor/〇〇`・`worktree/docs/〇〇`・`worktree/chore/〇〇` など）
   - **注意**: `EnterWorktree(name: ...)` はブランチ名を自動変換してしまうため使用しない。必ず以下の 2 ステップで行う:
     ```bash
     # Step 1: 正しいブランチ名でワークツリーを作成
     git worktree add -b worktree/<type>/<name> .claude/worktrees/<name>
     # Step 2: 作成したワークツリーに入る
     EnterWorktree(path: ".claude/worktrees/<name>")
     ```
3. **実装**（**ワークツリー内では `package.json` の `version` フィールドを変更しない**。理由は下記「バージョン管理」参照）
4. **検証**（下記「検証」を実施。型チェック必須＋**実行確認（ブラウザ確認）必須**）
5. **敵対的レビュー**（下記「敵対的レビュー」の手順で必ず実施。**全変更が対象。小規模修正でも省略しない**。指摘があれば実装に戻る）
6. **ドキュメント更新**（下記「ドキュメント更新」の条件に該当する場合。関連する仕様書（`docs/spec/`）・README.md・CLAUDE.md・コード内コメントを**同一コミットで**更新する）
7. **ドキュメント客観レビュー**（下記「ドキュメント客観レビュー」の手順で必ず実施。**ドキュメントを更新した場合のみ**・技術的すぎないか・初見の読み手に伝わるかをエージェントで客観的に検証。指摘があればドキュメント修正に戻る）
8. **コミット前確認**（実装・検証・敵対的レビュー・ドキュメント更新が終わったら、コミットする前に必ずユーザーに確認を取る。**省略しない**）
   - 何を・なぜ・どう直したかを簡潔に提示し、コミットしてよいか確認する
   - 確認が取れるまで次のステップに進まない
9. **コミット**（確認が取れたら、下記「コミット」の規約に従いコミットする。バージョンはまだ変更しない）
10. **main へのマージ**（**ユーザーから明示的に指示があったときのみ**。ワークツリーの変更を main にマージする前に必ず確認する。必ずマージコミットを作成する（`--no-ff`））
11. **バージョン更新**（**main へのマージ直後・main 上で実施**。下記「バージョン管理」の手順に従う。マージしない限りこのステップは発生しない）
12. **プッシュ**（**ユーザーから明示的に指示があったときのみ**。自動では行わない。バージョンを上げた場合は `npm version` が作成したタグも一緒に送る）
13. **リリース後のクリーンアップ**（プッシュ完了後に必ず実施する）
   - **ワークツリーの削除**:
     - ワークツリー内にいる場合は先に `ExitWorktree(action: "keep")` で抜けてから削除する
     - `git worktree remove .claude/worktrees/<name>` でワークツリーディレクトリを削除
     - `git branch -d worktree/<type>/<name>` でブランチを削除
   - **dev サーバーの停止**: 検証用に起動した dev サーバー（Vite）を停止する
     ```bash
     # ポート 5173（または起動ログで確認した実ポート）を使用しているプロセスを終了
     # Bash（Git Bash）の場合:
     kill $(netstat -ano | grep :5173 | awk '{print $5}' | head -1) 2>/dev/null || true
     ```
     - MCP サーバーを巻き込まないよう `Stop-Process -Name node` は使わないこと

> ユーザーから「修正前に状況を整理し問題点をまとめ、修正内容を確認してから作業する」方針の指示済み。
> ユーザーから「今後は必要に応じて README を更新して、コミットまで自動で行う」方針の指示済み（ただし後述の「コミット前確認」が優先。実装・検証・敵対的レビュー・ドキュメント更新の後に必ずユーザー確認を取ってからコミットする。「自動で行う」はワークフロー全体を止めないという意味であって、コミット前の一時停止をスキップする意味ではない）。
> ユーザーから「修正後（main へのマージ直後）は毎回バージョン種別（メジャー/マイナー/パッチ/なし）を確認する」方針の指示済み。
> ユーザーから「main へのマージはユーザーに確認してから行う」方針の指示済み。
> ユーザーから「リリース後はワークツリー削除と dev サーバー停止をクリーンアップとして実施する」方針の指示済み。
> ユーザーから「ソース修正後は全変更で敵対的レビューを行う」方針の指示済み（2026-08-10）。
> ユーザーから「修正時は関連仕様書・他ドキュメント類も合わせて修正する」方針の指示済み（2026-08-10）。
> ユーザーから「ドキュメント更新後は技術的すぎないか客観レビューを行う」方針の指示済み（2026-08-10）。
> 2026-07-12: 複数ワークツリーを並行して進めている場合に、各セッションがマージ前の古いバージョンを見て同じ番号（例: パッチ +1）を選んでしまい、結果的にバージョンが正しく積み上がらない事故が発生。対策として、バージョン確定を「ワークツリー内でのコミット時」から「main へのマージ直後・main 上」に移した（下記「バージョン管理」参照）。
> 2026-07-12: 上記の変更で「バージョン確認」がコミット前の一時停止ゲートを兼ねていたことが判明。バージョン確認をマージ後に移した結果、コミット前に立ち止まる仕組みが失われていたため、コミット前確認を独立したステップとして追加した（バージョンとは無関係に、コミットしてよいかを毎回確認する）。

## 検証

> **コードを修正した場合は、型チェックだけでなく必ずアプリを起動して実行確認（ブラウザ確認）まで行う。**
> 型チェックのみで完了とせず、**特に指定がない場合は `npm run dev:dmdss`（DMDSS 版）で起動し**、Playwright MCP で実際の表示・挙動を確認してからコミットする。

- **型チェック（必須）**: `npx tsc -b`。エラー0を確認する。
  - `npm run build` でも型チェックは走るが、その前段に**地名ラベル用グリフの検証**（`build-glyphs.mjs --check`）が入る。ここで落ちた場合は型エラーではなく「グリフの焼き直し忘れ」なので、メッセージを読んで切り分けること（下記「補助コマンド」参照）。
- **アプリ起動（デフォルト: DMDSS 版）**: **特にバリアントの指定がない場合は `npm run dev:dmdss` を使用する**。
  - DMDSS 版 URL: `http://localhost:5173/realtime-earthquake-viewer/dmdss/`
  - standard 版が明示的に必要な場合のみ `npm run dev` → `http://localhost:5173/realtime-earthquake-viewer/`
  - （5173 が使用中なら 5174 等にフォールバックするため、起動ログで実ポートを確認する）
  - **必ず `run_in_background: true` でバックグラウンドタスクとして起動する**（ユーザー指示）。フォアグラウンドで起動するとプロセスが応答を返さずハングするため。
  - **検証用に起動した dev サーバーは Claude のセッション中は停止せず起動したままにする**（ユーザー指示）。次の検証では新規起動せず、稼働中のサーバー（既定 5173）へ Playwright で接続して再利用する。セッションをまたぐ必要は無い。
- `__APP_VERSION__` はビルド時に `vite.config.ts` の `define` が `package.json` の `version` から注入する定数のため、dev サーバーは `package.json` の `version` を変更したあと**再起動しないと新しい値を反映しない**（HMR では拾えない）。
- **本番ビルド確認（大きめの変更時は必須）**: `npm run build` でビルドが通ることを確認するだけでなく、**`npm run preview`（本番ビルドのサブパス配信）を起動し Playwright MCP でブラウザ確認まで行う**。
  - preview URL: standard は `http://localhost:4173/realtime-earthquake-viewer/`／DMDSS は `npm run build:dmdss` → `npm run preview:dmdss`。
  - 地図系の変更では `map.isSourceLoaded(id)`・`queryRenderedFeatures` で **geojson ソースが実際にタイル化・描画されているか**まで確認する（ラスタ地形だけ出ていても油断しない）。
  - **理由（2026-07-28 v4.0.0→v4.0.1 の本番限定バグ）**: dev サーバー（`vite dev`）は未バンドルでモジュールを解決するため、**本番ビルド（rollup バンドル）でのみ壊れる不具合が dev では再現しない**。実例＝MapLibre GL v6 の `setWorkerUrl()` 欠落で geojson ワーカーのパスが本番だけ解決できず、地図のベクタ（県境・一次細分区域・震度点・活断層等）が全滅した（全ソース `isSourceLoaded=false`・ラスタ地形だけ描画）。dev のみで検証し preview を飛ばしたため見逃し、GitHub Pages で初めて発覚した。**worker/asset のパス解決・コード分割・minify 起因の壊れは dev では出ない**ため、大きな変更は必ず本番ビルドをブラウザで確認する。
- **ブラウザ確認（修正時は必須）**: **Playwright MCP**（`mcp__playwright__*` ツール群）で上記 URL を開き、`browser_take_screenshot`・`browser_evaluate` で表示や DOM を確認する。**`preview_start` / `preview_*` ツール（Claude Preview MCP）は使用しない。**
  - **起動確認時は必ず DMDSS 版（`npm run dev:dmdss`）を起動する**。ユーザーも実機確認を行うため、DMDSS 版が起動していることを必ず確認してからブラウザ検証を行う。
- **修正後の確認は徹底する**。型チェック・ブラウザ動作など複数の手段で確実に修正されたことを確認する。「たぶん直っているだろう」でコミットしない。
  - コンソールエラーが0件であることを確認する（以下は良性で無視してよい）。
    - リロード時の P2P WebSocket 再接続 warning。
    - 強震モニタのクロック同期（`kyoshin.ts` の `startClockSync`）が 30 秒ごとに出す `RealTimeData/...?_=...` への 403（未登録秒を叩いて 403→200 境界を捉える較正の正常動作。ネットワーク層の 403 は JS から抑制不可）。
  - 自動解除や時間経過で発火する挙動（自動タブ切替・アイドル復帰など）は、`localStorage` の書き換え＋リロードや DOM 検査で確認する。
  - **確認後も開発サーバーは停止しない**（セッション中は起動したまま残す）。`Stop-Process -Name node` のような一括停止は MCP サーバーまで巻き込むため使わない。
  - 検証用スクリーンショットはリポジトリ直下に出力されるが**一時ファイル。コミット前に必ず削除する**（コミットしない）。`.playwright-mcp/` の出力も同様に Git 管理対象外（`.gitignore` 済み）。
- **テスト機能の活用**: 設定タブのテストボタンで動作確認できる。各ボタンの詳細（対象電文・音・自動タブ切替・自動解除タイミング等）と DOM 検証手法は [`docs/spec/settings-pwa-spec.md`](docs/spec/settings-pwa-spec.md) §7、実データから P2PQuake 経由でシナリオを作る手順は同 §6 を参照する。

### 環境による制約

- 一部の外部ホストへ到達できない環境がある（例: 防災科研 kmoni の HTTPS）。Yahoo 強震モニタ（`weather-kyoshin.*.storage-yahoo.jp`）・DMDATA.JP API は到達可能。
- 予報円は自前計算（`usePsWaveCalc`）に統一済みのためテストボタンでも確認できるが、気象庁の実電文が発表初期に載せる「仮定震源要素」（単独観測点処理・震源未確定）の判別は、情報源によって精度が異なる（DMDATA/P2PQuakeは`condition`フィールドで判別可能、Yahoo hypoInfoには相当フィールドが無い）。この非対称性そのものの実地震での挙動は、実発報時の確認をユーザーに委ねる。

## 敵対的レビュー

**全変更（コード・ドキュメント問わず）でエージェントによる敵対的レビューを実施する**。目的:
- 実装から裏取りしたバグ・エッジケース・機能間競合を検出する
- コミット前に「レビュー観点の抜け」を客観的に潰す
- 既存コメント・ドキュメントの誤解を疑う（実コードを信じる）

### 実施タイミング

**検証（型チェック＋ブラウザ確認）が完了した後、ドキュメント更新の前**。指摘があれば実装に戻り、修正後に敵対的レビューをもう 1 度回す。

### エージェント構成(変更規模で可変)

| 変更規模 | 例 | エージェント構成 |
|---|---|---|
| 小規模 | 1〜2 ファイルの typo/スタイル修正・軽微なパラメータ調整 | `adversarial-reviewer` 1 エージェント |
| 中規模 | 機能追加・複数ファイル・条件分岐の変更 | `adversarial-reviewer` + `silent-failure-hunter` の並列 2 エージェント |
| 大規模 | アーキテクチャ変更・複数機能横断 | 領域別に `adversarial-reviewer` を複数並列 ＋ **機能間競合レビュー**（EEW×津波・地図×EEW 等）＋ **メタレビュー**（`meta-reviewer` で CRITICAL/HIGH の実装からの再検証） |

`adversarial-reviewer` / `meta-reviewer` の定義は [`.claude/agents/`](.claude/agents/) を参照（プロジェクトローカル・共通利用のため Git 管理）。

### レビュー観点（全エージェント共通）

- **実装から裏取り**: 既存コメント・仕様書・CLAUDE.md を鵜呑みにせず、実コードを読んで挙動を確認する
- **修正はしない**: レビュアーは変更をコミットしない。指摘のみ返す
- **分類**: CRITICAL / HIGH / MEDIUM / LOW で分類する
- **統一フォーマット**:
  ```
  [レベル] [ファイル:行] 見出し
  - 事実（実装からの引用）
  - 問題
  - 影響（どの機能・どのバリアント・どの経路）
  - 修正方針の候補（実施はしない）
  ```

### メタレビュー（大規模変更時）

CRITICAL / HIGH の指摘は **`meta-reviewer` エージェント**で実装から再検証する。目的:
- 過大評価（CRITICAL が実は HIGH 相当）を検出
- 修正方針の副作用（別バグを生む可能性）を検出
- 事実誤認・根拠の誤りを検出

判定は「確認済み / 過大評価 / 過小評価 / 誤検出 / 修正方針要再検討」のいずれか。

### 参考

過去のレビュー実施例は `.claude/review-reports/` にアーカイブされている（`.gitignore` 済み・共有はコミット外）。

## ドキュメント更新

コードの変更に応じて、関連するドキュメントを**同一コミットで**更新する。対象は以下:

- **`docs/spec/` 配下の該当機能仕様書**: 実装が仕様と 1 対 1 で対応する箇所（パラメータ・判定条件・データフロー等）を変更したら、必ず仕様書側も更新する。仕様書は冒頭で自ら「実コードを正とする」と宣言しているため、放置すると即座に嘘になる。
- **`README.md`**: 機能・技術スタック・バリアント差分・データソース・注意事項・ライセンス関連の変更のみ更新（README は概要と導線のみを残す方針。詳細はすべて `docs/spec/` 配下に集約する）
- **`CLAUDE.md`**: 変更時のワークフロー・検証手順・コード整合性チェックポイント・バージョン管理などに影響する変更のみ更新
- **コード内コメント**: 変更した処理のコメントを実装と一致させる（`common/comment-integrity.md` 参照）

スタイルの微調整・レイアウトの軽微な調整など、上記のいずれの記載にも影響しない変更ではドキュメント更新不要。

### 特殊ケース: 強震モニタ検知仕様書の更新

`src/utils/kyoshinDetector.ts`（強震モニタ揺れ検知エンジン）のパラメータ・判定ロジックを変更した場合は、上記の一般則に加えて**以下 2 つのドキュメントを同一コミットで**更新する:

- [`docs/spec/kyoshin-detection-spec.md`](docs/spec/kyoshin-detection-spec.md)（仕様書）: **現在の実装が何をどう処理するか**を書く文書。パラメータ一覧表（§5）と判定ロジックの記述（§4）は実装と 1 対 1 で対応させる。
- [`docs/spec/kyoshin-detection-v3-design.md`](docs/spec/kyoshin-detection-v3-design.md)（設計書）: **なぜそうしたか**の経緯・調査・検証履歴を節番号付きで追記する（§13 以降が改訂履歴。新しい変更は末尾に §N を足す）。仕様書側からは「設計書§N」の形で参照する（仕様書自身の節番号と紛らわしいので「§N」単独で書かない）。

パラメータ表と実装の一致は機械的に確認できる（`PARAMS` のキー・値を §5 の表と突き合わせる）。
2026-08-09 の高震度 fast path 追加時にこの照合を行い、37件全件一致を確認した。

> 2026-08-09: 検知ロジック修正時にこれらのドキュメントを更新すべき旨がどこにも明文化されておらず、更新するかどうかが作業者の判断に委ねられていた。次に触る人が同じ判断に至る保証が無いため、ルールとして明文化した。
> 2026-08-10: 「関連ドキュメントの更新」の一般則に格上げし、検知仕様書はその特殊ケースとして位置づけを変更した。

## ドキュメント客観レビュー

**ドキュメントを更新した場合のみ**、更新されたドキュメントを対象にエージェントで客観レビューを実施する。
目的: 技術的すぎないか・初見の読み手に伝わるか・実装と乖離していないかを検証する。

### 実施タイミング

**ドキュメント更新の直後、コミット前確認の前**。指摘があればドキュメントに戻る。

### エージェント構成

- 更新規模が小さい場合（1 ファイル・数行の追記）: `doc-objectivity-reviewer` 1 エージェント
- 更新規模が大きい場合（複数仕様書・README 大幅改訂・CLAUDE.md 追記）: `doc-objectivity-reviewer` + `code-explorer` の並列 2 エージェント（後者は「初見の開発者視点」で追加観点を担当）

`doc-objectivity-reviewer` の定義は [`.claude/agents/`](.claude/agents/) を参照（プロジェクトローカル・共通利用のため Git 管理）。

### レビュー観点

- **読者が誰か明示されているか**: 一般利用者向け / 開発者向け / 特定機能を触る人向け 等
- **前提知識のない読み手が理解できるか**: 過度な略語・専門用語の初出説明はあるか
- **実装との乖離がないか**: パラメータ値・関数名・行番号・ファイル名の正確性
- **冗長でないか**: 同じ内容が複数箇所に重複していないか（重複は単一情報源へ集約する候補）
- **技術的すぎないか**: 「実装の内部詳細」と「読者が知るべき挙動」の粒度が分離されているか
- **過剰でないか / 情報量が適切か**: 実装の複雑度・機能の重要度に対して分量が釣り合っているか。読者が知る必要のない詳細（内部変数の一時的な状態遷移・改訂履歴の細部・過去の失敗の詳述など）を延々書いていないか。「あって困らない」を理由に膨らませていないか
- **仕様書相互の整合性**: 別の仕様書と食い違う記述はないか

### README 特有の観点

README は「一般利用者・フォーカー・貢献者への導線」であることを念頭に:
- 実装内部の詳細（プロジェクト構成ツリー・パラメータ値等）が入り込んでいないか
- 詳細は `docs/spec/` 配下の仕様書へリンク委譲されているか
- 開発者専用の情報（デプロイ手順・EEW 二次配信の規約制限等）が混入していないか

### 出力形式

```
[レベル] [ファイル:節/行] 見出し
- 記述の該当箇所
- 何が伝わりにくいか / 何が実装と食い違うか
- 修正方針の候補
```

レベルは CRITICAL（誤情報・法的リスク）/ HIGH（読み手が誤解する）/ MEDIUM（冗長・重複）/ LOW（表現改善余地）。

## プランモード

- プランモードに入ったとき、前回のプランが**完了済み**（実装・コミット済み）の場合は、既存プランファイルを修正せず**新規プランファイルを作成**する。
- 前回プランが未完了（作業途中）の場合のみ、既存プランファイルを引き続き更新してよい。

## コミット

- **Conventional Commits**（`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `ci`）。説明は日本語。
- コミットメッセージ末尾に必ず付与する。**モデル名はその時作業している Claude モデルに合わせる**（ハーネスが指定するモデル名を使用する。特定モデルに固定しない）:
  ```
  Co-Authored-By: Claude <モデル名> <noreply@anthropic.com>
  ```
  例（Sonnet 5 で作業時）: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- 検証用スクリーンショット（`*.png`）はコミットに含めない。
- Windows 環境のため `LF will be replaced by CRLF` の警告が出るが正常（無視してよい）。
- ワークツリー内のコミットでは `package.json` の `version` を変更しない（下記「バージョン管理」参照）。バージョン確定は main へのマージ後に別途行う。
- **コミット前に必ずユーザーに確認を取る。省略しない**。同一セッション内で別の修正のコミット許可をもらっていても、その修正のコミット許可を個別にもらっていない場合は確認する。
- このリポジトリは `main` に直接コミットしている。

## マージ

- **ファストフォワード可能な場合でも、必ずマージコミットを作成する（`git merge --no-ff`）**。
  - 例: `git merge --no-ff worktree/feat/〇〇`
  - 理由: 各機能・修正の単位（ブランチ）を履歴上で明確に残すため。
- マージが完了したら、次に必ず下記「バージョン管理」の手順を行う。省略しない。

## バージョン管理

**バージョン確定は「main へのマージが完了した直後・main 上」でのみ行う。** ワークツリー内やマージ前のブランチでは `package.json` の `version` を変更しない。

- **理由**: 複数のワークツリーを並行して進めている場合、各セッションがワークツリー作成時点の（まだ更新されていない）古いバージョンを見て同じ番号を選んでしまい、結果的にバージョンが正しく積み上がらない事故が起きる（例: 1.0.0 から2つのセッションが同時にパッチ修正すると、両方とも 1.0.1 を選んでしまい最終的に 1.0.1 のままになる）。マージは順番に処理されるため、マージ直後の main 上でバージョンを決めれば常に最新の値を見て +1 できる。
- **手順**（main へのマージ後、毎回省略せず行う）:
  1. **AskUserQuestion ツール**で以下の選択肢を提示する:「メジャーバージョンを上げる」「マイナーバージョンを上げる」「パッチバージョンを上げる」「バージョンを上げない」
  2. バージョンを上げる場合、main 上で以下を実行する:
     ```bash
     npm version patch   # または minor / major
     ```
     `package.json` の更新・コミット作成・git tag（`vX.Y.Z`）作成までが自動で行われる。
  3. `src/components/SettingsTab/index.tsx` のバージョン表示は `vite.config.ts` の `define`（`__APP_VERSION__`）経由で `package.json` を参照しているため、**手動更新は不要**。
- 同一セッション内で複数回マージする場合も、マージのたびに毎回このステップを行う（省略しない）。
- プッシュ時（ユーザーの明示的指示があったとき）は `npm version` が作成したタグも一緒に送る: `git push && git push --tags`（または `git push --follow-tags`）。

## 補助コマンド

| コマンド | 用途 |
|----------|------|
| `npm run dev` | 開発サーバー |
| `npm run build` | 地名ラベル用グリフの検証 + 型チェック + 本番ビルド |
| `npm run preview` | 本番ビルドのプレビュー（サブパス配信） |
| `node scripts/build-station-coords.mjs` | 観測点座標テーブル（`public/data/station-coords.json`）の再生成 |
| `node scripts/build-tsunami-zones.mjs` | 津波予報区 海岸線データ（`public/data/tsunami-zones.json`）の再生成 |
| `node scripts/build-prefectures.mjs` | 都道府県境界データ（`public/data/prefectures.json`）の再生成（ベースマップ用） |
| `node scripts/build-subregions.mjs` | 一次細分区域境界データ（`public/data/subregions.json`）の再生成 |
| `node scripts/build-glyphs.mjs` | 地名ラベル用 SDF グリフ（`public/fonts/`）の再生成。**地名（地方・県・区域）が増減したら実行する**（`npm run build` が前段で `--check` を走らせ、未生成の文字があればビルドを止める。詳細は [`docs/spec/map-rendering-spec.md`](docs/spec/map-rendering-spec.md) §5）。県名・区域名は `public/data/*.json` から読むため、**`build-prefectures.mjs`・`build-subregions.mjs` を先に実行すること** |
| `npm version patch\|minor\|major` | バージョン更新・コミット・git tag 作成（main へのマージ直後に実行。詳細は「バージョン管理」参照） |

## 構成メモ

- `src/App.tsx`: レイアウトの中枢。地図常時表示＋アイコンナビでパネル内容を切替。地図内容・更新時刻・通知音・自動タブ切替・EEW 連携の制御もここ。
- レイアウトは画面の向き・高さで切り替わる（左右分割／上下分割）。分岐条件は `tailwind.config.js` の `screens`（`side` / `sideNarrow` / `roomy`）が単一情報源。上下分割時は境界のつまみで比率変更・折りたたみができる（`PanelResizeHandle`）。詳細は [`docs/spec/architecture-spec.md`](docs/spec/architecture-spec.md) の「画面サイズ別のレイアウト」。
- 地図は MapLibre GL JS（`JapanMapGL`）に一本化。`MapView` が App と地図実装の間の薄いラッパー。旧 Leaflet 版 JapanMap とエンジン切替フラグは F7 で撤去済み。
- 地図のモード（`JapanMapGL` の `mode`）: `quake`（地震）／`tsunami`（津波海岸線）／`kyoshin`（リアルタイム震度・予報円）。
- 生成データ（`public/data/*.json`）は座標が大きいため遅延読込（初回利用時に一度だけ fetch しキャッシュ）。  
  地図は常時表示のため、地図が使うもの（`prefectures.json` / `subregions.json` / `station-coords.json` / `tsunami-zones.json` / `active-faults.json` / `plate-boundaries.json` / `tsunami-obs-coords.json`）は表示モードに関わらず地図の初回表示時にまとめて要求する。実地震テストシナリオの本体だけは再生時に取得する。

## コード整合性チェックポイント

新機能追加・修正時にコメントと実装が乖離しやすい項目は、以下の仕様書（`docs/spec/`）に単一情報源として集約している。変更時に該当仕様書を参照し、コード修正と同一コミットで仕様書側も更新する（詳細は上記「ドキュメント更新」節）。

| 項目 | 単一情報源となる仕様書 |
|---|---|
| テストデータと UI 説明文（テストボタンの `scaleTo` 値等） | [`docs/spec/settings-pwa-spec.md`](docs/spec/settings-pwa-spec.md) §7 |
| 津波の解除経路（`cancelReason` 3 種・DMDSS 限定・standard 版フォールバック） | [`docs/spec/tsunami-spec.md`](docs/spec/tsunami-spec.md) §3 |
| EEW P/S 波予報円の計算・仮定震源要素の連動箇所 | [`docs/spec/eew-spec.md`](docs/spec/eew-spec.md) §5-§6 |
| EEW レベル判定（特別警報の条件・長周期の DMDATA 限定） | [`docs/spec/eew-spec.md`](docs/spec/eew-spec.md) §4 |
| 地図レイヤー描画順・EEW 予想レイヤーの kyoshin 限定・`maplibregl.Marker` の opacity | [`docs/spec/map-rendering-spec.md`](docs/spec/map-rendering-spec.md) §2・§3・§7・§10 |
| ズーム値の基準（MapLibre 512px タイル vs Leaflet 256px タイル）・`MAX_ZOOM` に揃える閾値群 | [`docs/spec/map-rendering-spec.md`](docs/spec/map-rendering-spec.md) §4・§6 |
| ラベルのフォントスタック名の一致・グリフ収録文字の網羅性・フォント適用範囲（ラベル限定） | [`docs/spec/map-rendering-spec.md`](docs/spec/map-rendering-spec.md) §5 |
| 画面サイズ別レイアウトの分岐条件（`side` / `sideNarrow` / `roomy`）・パネル比率・折りたたみ | [`docs/spec/architecture-spec.md`](docs/spec/architecture-spec.md) §4「画面サイズ別のレイアウト」 |
| 震度集約の単位（一次細分区域）・観測点 0 件時の集約維持 | [`docs/spec/quake-spec.md`](docs/spec/quake-spec.md) §7 |
| 地震電文の `points` 構造（バリアント経路差・`pref` 空の識別規則） | [`docs/spec/quake-spec.md`](docs/spec/quake-spec.md) §4 |
| 遠地地震の識別（VXSE53・`Head/Title`）・付加文コードと `forecastText` | [`docs/spec/quake-spec.md`](docs/spec/quake-spec.md) §3（遠地地震に関する情報） |
| `KyoshinSubThreshold` の対象範囲（index 1〜6）・慢性ノイズ床フィルタ | [`docs/spec/kyoshin-detection-spec.md`](docs/spec/kyoshin-detection-spec.md) |
| 実地震テストシナリオの時刻シフト・ID 再採番・利用規約制約 | [`docs/spec/settings-pwa-spec.md`](docs/spec/settings-pwa-spec.md) §6 |
| 生成データ（`public/data/*.json`）の取得タイムアウト値・失敗時の扱い（TTS 辞書のみ別値） | [`docs/spec/data-sources-spec.md`](docs/spec/data-sources-spec.md) §6 |

各仕様書は冒頭で「食い違う場合は実コードを正とする」と宣言している。放置すると即座に嘘になる文書なので、実装変更時に必ず追従させる。

