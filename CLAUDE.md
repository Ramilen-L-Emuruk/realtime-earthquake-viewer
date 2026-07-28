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
5. **README 更新**（下記「README 更新」の条件に該当する場合）
6. **コミット前確認**（実装・検証・README 更新が終わったら、コミットする前に必ずユーザーに確認を取る。**省略しない**）
   - 何を・なぜ・どう直したかを簡潔に提示し、コミットしてよいか確認する
   - 確認が取れるまで次のステップに進まない
7. **コミット**（確認が取れたら、下記「コミット」の規約に従いコミットする。バージョンはまだ変更しない）
8. **main へのマージ**（**ユーザーから明示的に指示があったときのみ**。ワークツリーの変更を main にマージする前に必ず確認する。必ずマージコミットを作成する（`--no-ff`））
9. **バージョン更新**（**main へのマージ直後・main 上で実施**。下記「バージョン管理」の手順に従う。マージしない限りこのステップは発生しない）
10. **プッシュ**（**ユーザーから明示的に指示があったときのみ**。自動では行わない。バージョンを上げた場合は `npm version` が作成したタグも一緒に送る）
11. **リリース後のクリーンアップ**（プッシュ完了後に必ず実施する）
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
> ユーザーから「今後は必要に応じて README を更新して、コミットまで自動で行う」方針の指示済み。
> ユーザーから「修正後（main へのマージ直後）は毎回バージョン種別（メジャー/マイナー/パッチ/なし）を確認する」方針の指示済み。
> ユーザーから「main へのマージはユーザーに確認してから行う」方針の指示済み。
> ユーザーから「リリース後はワークツリー削除と dev サーバー停止をクリーンアップとして実施する」方針の指示済み。
> 2026-07-12: 複数ワークツリーを並行して進めている場合に、各セッションがマージ前の古いバージョンを見て同じ番号（例: パッチ +1）を選んでしまい、結果的にバージョンが正しく積み上がらない事故が発生。対策として、バージョン確定を「ワークツリー内でのコミット時」から「main へのマージ直後・main 上」に移した（下記「バージョン管理」参照）。
> 2026-07-12: 上記の変更で「バージョン確認」がコミット前の一時停止ゲートを兼ねていたことが判明。バージョン確認をマージ後に移した結果、コミット前に立ち止まる仕組みが失われていたため、コミット前確認を独立したステップとして追加した（バージョンとは無関係に、コミットしてよいかを毎回確認する）。

## 検証

> **コードを修正した場合は、型チェックだけでなく必ずアプリを起動して実行確認（ブラウザ確認）まで行う。**
> 型チェックのみで完了とせず、**特に指定がない場合は `npm run dev:dmdss`（DMDSS 版）で起動し**、Playwright MCP で実際の表示・挙動を確認してからコミットする。

- **型チェック（必須）**: `npx tsc -b`（または `npm run build`）。エラー0を確認する。
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
- **テスト機能の活用**: 設定タブのテストボタンで動作確認できる。
  - 地震テスト → 地震カード追加・地図の震度マーカー・自動タブ切替
  - EEW 特別警報テスト → 震度6強・特別警報（三陸沖 M7.2）→ `eewSpecial` 音・EEW カード（特別警報/赤）・震源マーカー
  - EEW 警報テスト → 震度5強相当・警報（茨城県沖 M6.5）→ `eew` 音・EEW カード（警報/赤）
  - EEW 予報テスト → 震度2程度・予報（宮城県沖 M4.5）→ `eewForecast` 音・EEW カード（予報/オレンジ）
  - 大警報テスト → 大津波警報（岩手・宮城・福島等）→ `tsunamiMajor` 音・津波タブの海岸線描画
  - 警報テスト → 津波警報（青森・茨城等）→ `tsunami` 音・津波タブの海岸線描画
  - 注意報テスト → 津波注意報（北海道）→ `tsunamiWatch` 音・津波タブの海岸線描画
  - 予報テスト → 津波予報・若干の海面変動（北海道）→ `tsunamiForecast` 音・津波タブの海岸線描画
  - EEW は約30秒で自動解除（解除音）。同ボタン再クリックで続報（`eewUpdate` 音）。異なるボタンを押すと前の EEW タイマーをキャンセルし新規発報。
  - 津波テスト（大警報・警報・注意報・予報）はいずれも約30秒で自動解除。
  - ※予報円は実データ依存のため平常時は表示されない。

### 環境による制約

- 一部の外部ホストへ到達できない環境がある（例: 防災科研 kmoni の HTTPS）。Yahoo 強震モニタ（`weather-kyoshin.*.storage-yahoo.jp`）・DMDATA.JP API は到達可能。
- **予報円（Yahoo `psWave`）は実 EEW 発報時のみデータが入る**ため、平常時は実地確認できない。コードのみ確認し、実発報時の確認をユーザーに委ねる。

## README 更新

機能・画面構成・データソース・依存・デプロイ方法・設定項目・プロジェクト構成に影響する変更では、`README.md` の該当箇所（機能一覧／技術スタック／データソース／プロジェクト構成 等）も合わせて最新化する。
スタイルの微調整やレイアウトの軽微な調整など、README の記載に影響しない変更では更新不要。

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
| `npm run build` | 型チェック + 本番ビルド |
| `npm run preview` | 本番ビルドのプレビュー（サブパス配信） |
| `node scripts/build-station-coords.mjs` | 観測点座標テーブル（`public/data/station-coords.json`）の再生成 |
| `node scripts/build-tsunami-zones.mjs` | 津波予報区 海岸線データ（`public/data/tsunami-zones.json`）の再生成 |
| `node scripts/build-prefectures.mjs` | 都道府県境界データ（`public/data/prefectures.json`）の再生成（ベースマップ用） |
| `node scripts/build-subregions.mjs` | 一次細分区域境界データ（`public/data/subregions.json`）の再生成 |
| `npm version patch\|minor\|major` | バージョン更新・コミット・git tag 作成（main へのマージ直後に実行。詳細は「バージョン管理」参照） |

## 構成メモ

- `src/App.tsx`: レイアウトの中枢。地図常時表示＋アイコンナビ（右端）でパネル内容を切替。地図内容・更新時刻・通知音・自動タブ切替・EEW 連携の制御もここ。
- 地図は MapLibre GL JS（`JapanMapGL`）に一本化。`MapView` が App と地図実装の間の薄いラッパー。旧 Leaflet 版 JapanMap とエンジン切替フラグは F7 で撤去済み。
- 地図のモード（`JapanMapGL` の `mode`）: `quake`（地震）／`tsunami`（津波海岸線）／`kyoshin`（リアルタイム震度・予報円）。
- 生成データ（`public/data/*.json`）は座標が大きいため遅延読込（初回利用時に一度だけ fetch しキャッシュ）。  
  ベースマップ用（`prefectures.json` / `subregions.json`）は地図初回表示時、地震/津波用（`station-coords.json` / `tsunami-zones.json`）は該当タブ表示時に fetch する。

## コード整合性チェックポイント

新機能追加・修正時にコメントと実装が乖離しやすい箇所。変更前後に必ず照合すること。

### テストデータと UI 説明文
- `SettingsTab/index.tsx` の `description` 文字列（例: 「震度5強相当」）は、`src/utils/testData.ts` の対応するテスト関数の実 `scaleTo` 値と一致させる。
  - EEW 警報テスト（`createTestEEWWarning`）: 最大 `scaleTo: 50` = 震度5強
  - EEW 特別警報テスト（`createTestEEW`）: 最大 `scaleTo: 60` = 震度6強
  - EEW 予報テスト（`createTestEEWForecast`）: 最大 `scaleTo: 25` = 震度2程度
- 同じ説明文が `CLAUDE.md` の「テスト機能の活用」セクションにも記載されているため、変更時は両方を合わせて修正する。

### 地図レイヤーの描画順
- 描画順（背面→前面）の単一情報源は `src/components/Map/gl/layerOrder.ts` の `MAP_LAYER_ORDER`。各レイヤーコンポーネントは `addOrderedLayer` で追加し、この配列上で自分より前面に来るべき既存レイヤーの直前へ挿入することで、データ到着タイミングに依存せず順序を保証する。
  - 新レイヤーを足すときは `MAP_LAYER_ORDER` に id を追加し、コンポーネントの `id` と一致させる。配列に無い id は最上段へ積まれる。
  - custom レイヤー（`kyoshin-subthreshold`）は `getStyle().layers` に現れない（MapLibre 仕様）。順序確認は `map.style._order` を見る。

### 震度集約の単位
- ズームアウト時の集約単位は**一次細分区域**（`subregions.json` 由来）。「都道府県」という表現はコメント・ドキュメントで使わない。
  - 閾値定数は `useQuakeLayerData.ts` の `QUAKE_MAX_ZOOM`（= 8。gl/camera.ts の MAX_ZOOM と一致）。この zoom 以下で区域集約に切り替える。

### KyoshinSubThreshold の対象範囲
- 対象は **index 1〜6**（震度0以下）。index 0 はデータ無し（`gl/subThresholdLayer.ts` の `subThresholdOpacity(0) = 0`）のため非表示。「0〜6」とコメントしない。
- `KyoshinPointsGL.tsx` が気象庁配色で描画するのは **index 7+**（震度1以上）。
- `KyoshinSubThresholdGL.tsx` は「同レベルのドット同士が重なっても濃くならない」非加算合成を FBO 二層合成のカスタムレイヤー（`gl/subThresholdLayer.ts`）で再現する。毎秒更新は index バッファのカウンティングソート＋`triggerRepaint`。

### README プロジェクト構成ツリー
- `src/components/`・`src/hooks/`・`src/utils/` に新ファイルを追加した場合は、`README.md` の「プロジェクト構成」ツリーにも追記する（README 更新の条件に含める）。
