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
  - EEW 警報テスト → 震度5強相当・警報（日向灘 M6.5）→ `eew` 音・EEW カード（警報/赤）
  - EEW 予報テスト → 震度2程度・予報（宮城県沖 M4.5）→ `eewForecast` 音・EEW カード（予報/オレンジ）
  - この3ボタンはいずれも、10秒以内に再クリックすると続報（`eewUpdate` 音）、押さなければその時点のイベントを最終報（`isFinal:true`）として確定する。確定後は本番と同じ `calcEEWCancelTime`（司・翠川式の距離減衰から算出したS波到達時刻＋30秒、最終報から最低60秒）で数分後に**無音・即消去**（キャンセルオーバーレイなし）。**DMDSS版の実運用経路をそのまま再現**（Standard版は実データに `isFinal` が来ないため実運用ではこの検知経路自体を通らないが、解除後の無音・即消去ロジックはバリアント共通のため検証できる）。
  - EEW 誤報取消テスト → 警報相当（日向灘 M6.5）→ `eew` 音で発報後、10秒後に明示的な取消電文（`cancelled:true`、`isFinal`無し）を送信 → `eewCancel` 音・ブラウザ通知・読み上げを伴う「誤報取消」を検証（上記3ボタンの「自動解除（無音）」との対比用）。
  - 大警報テスト → 大津波警報（岩手・宮城・福島等）→ `tsunamiMajor` 音・津波タブの海岸線描画
  - 警報テスト → 津波警報（青森・茨城等）→ `tsunami` 音・津波タブの海岸線描画
  - 注意報テスト → 津波注意報（北海道）→ `tsunamiWatch` 音・津波タブの海岸線描画
  - 予報テスト → 津波予報・若干の海面変動（北海道）→ `tsunamiForecast` 音・津波タブの海岸線描画
  - 誤報取消テスト → 津波警報＋注意報（青森・北海道等）→ `tsunami` 音・津波タブの海岸線描画
  - 津波は実際の電文と同じく「解除」「取消」「期限切れ」の3経路とも10秒間の解除表示を経る（`JMATsunami.cancelReason`で出し分け）。
    大警報・警報・注意報テストは約90秒後に「解除」表示、誤報取消テストは約90秒後に「取消」表示、予報テストは
    `validDateTime` の期限切れにより約90秒後に「有効期間終了」表示になる（実運用でも予報は明示的な解除電文を伴わない）。
  - P波・S波の予報円は震源要素（震源・深さ・マグニチュード・発生時刻）から自前計算する（標準版・DMDSS版共通）ため、上記のEEWテストボタンでも実際に円が拡大する様子を検証できる。
  - **実地震テスト**（設定タブ「実地震テスト」セクション）→ 実際に発生した地震の電文（EEW・地震情報・津波情報等）を、発生時と同じ間隔でキューに投入し再生する。合成データのテストボタンと異なり本物の電文を時刻シフト・ID再採番のみ行って再現するため、続報の推移（例: 津波警報→大津波警報への引き上げ）もそのまま検証できる。標準版・DMDSS版共通。再生中は対象ボタンが「再生中…」表示でdisabledになり、シナリオ末尾+安全マージン後に再度押せるようになる。**シナリオデータはリポジトリに同梱していない**（DMDATA.JP利用規約上の理由。後述）ため、リポジトリを取得した直後は「利用可能なシナリオがありません」の空表示になる。試すには各自の DMDATA.JP 契約で `capture-scenario` を実行してローカルにシナリオを追加する必要がある。シナリオの追加方法・設計判断は「実地震テストシナリオの時刻シフト・ID再採番」節を参照。DMDATA.JP 契約が無い場合でも、下記「実データからテストシナリオを作る」の手順で P2PQuake から作成できる。

### 実データからテストシナリオを作る（DMDATA 契約なしで可能）

区域集約・震度分布・続報の推移など、**合成テストデータ（`testData.ts`）では再現できない実データ由来の挙動**を検証したいときは、
過去に実際に発生した地震を P2PQuake API v2（認証不要）から取得してシナリオ化する。`scripts/capture-test-scenario.ts` は
DMDATA.JP の契約が要るが、この手順は契約不要で、標準版・DMDSS版のどちらでも再生できる。

1. **対象の電文を取得する**（P2PQuake API v2 `history`・認証不要）
   - `https://api.p2pquake.net/v2/history?codes=551&limit=100&offset=<N>` を offset を進めながら探す。
     `codes` は 551=地震情報 / 552=津波情報 / 556=EEW。offset 100 でおよそ 8 日前まで遡れる（地震の発生頻度による）。
   - 同じ地震でも `points: []` の速報が混在するため、観測点別震度が要る検証では `points` の入った報を選ぶ。
2. **内部型に包む**
   - P2PQuake のスキーマは内部型に近い。`kind`（551→`'quake'` / 552→`'tsunami'` / 556→`'eew'`）と 14 桁数字の `eventId` を足す。
   - ただし **`issue.type`・`issue.correct`・`earthquake.domesticTsunami` は英語のまま返る**ため、
     `src/services/p2pquake.ts` の `convertEvent` と同じ日本語化を通すこと。飛ばすとカード見出しが `DetailScale` のような
     英語のまま表示される（2026-08-09 の検証で実際に踏んだ。地図の区域塗りには影響しないが、カード表示を見る検証では必須）。
   - それを `TestScenarioFile`（`src/types/testScenario.ts`）に包む:
     `{ id, label, description, category, durationMs, baseTime, entries: [{ offsetMs: 0, payload: { kind: 'event', event } }] }`
   - `baseTime` は先頭エントリの絶対時刻（ISO）。再生時に `instantiateScenario` がここを基準に「今」へ一律シフトする。
3. **配置する** — 本体を `public/data/test-scenarios/<id>.json`（`id` はファイル名と一致させる）に置き、
   `index.json` にメタ（`baseTime`・`entries` を除いた部分）を 1 件追加する。
4. **再生する** — 設定タブ「実地震テスト」の該当行の「再生」ボタン。
   - 履歴には同じ地震の**本物**が並ぶため、`earthquake.hypocenter.name` に目印（例: 「【検証】」）を付けておくと取り違えずに済む。再生時に時刻はシフトされるので、時刻での判別は当てにならない。
5. **後始末（必須）**
   - **`index.json` は Git 管理対象**。検証が終わったら必ず空配列 `[]` に戻す（`git checkout -- public/data/test-scenarios/index.json`）。
   - シナリオ本体は `.gitignore` 済みだが、混乱を避けるため削除する。

**検証結果の裏取りはスクリーンショットの目視ではなく DOM で行う。** 区域塗りの震度ラベルは symbol レイヤーではなく
HTML マーカー（`QuakeRegionFillGL` の `maplibregl.Marker`）なので、`browser_evaluate` から数値で照合できる。

```js
// 区域ラベルを「震度ラベル / 背景色」で集計する（震源マーカーはテキストが空なので自然に除外される）
[...document.querySelectorAll('.maplibregl-marker')]
  .map(m => { const el = m.firstElementChild || m; return { t: el.textContent.trim(), bg: getComputedStyle(el).backgroundColor } })
  .filter(x => x.t)
```

同じ集約ロジックを Node 側でも再現して突き合わせると、データと描画の両方を確実に確認できる。
実例（2026-08-09 の区域集約修正）では、Node 側の再現と DOM 集計がともに「震度1×6・震度2×3・震度3×1」で一致することを確認した。
配色の差は目視だと見落とすため、色は名前ではなく `rgb()` の実値で照合する。

地図の内部状態は `window.__mapGL`（`JapanMapGL` が露出。本番ビルドでも有効）から読む。
geojson ソースの中身を数えるときは **`await map.getSource(id).getData()`** を使うこと。
`source._data` は MapLibre v6 には存在せず（`undefined` を空データと誤読して「0件」に見える）、
`queryRenderedFeatures` / `querySourceFeatures` はビューポート内のタイルに限られるため全件集計には使えない。
レイヤーの表示切替は `map.getLayoutProperty(id, 'visibility')` で確認する（未設定時は `undefined` ＝表示）。

### 環境による制約

- 一部の外部ホストへ到達できない環境がある（例: 防災科研 kmoni の HTTPS）。Yahoo 強震モニタ（`weather-kyoshin.*.storage-yahoo.jp`）・DMDATA.JP API は到達可能。
- 予報円は自前計算（`usePsWaveCalc`）に統一済みのためテストボタンでも確認できるが、気象庁の実電文が発表初期に載せる「仮定震源要素」（単独観測点処理・震源未確定）の判別は、情報源によって精度が異なる（DMDATA/P2PQuakeは`condition`フィールドで判別可能、Yahoo hypoInfoには相当フィールドが無い）。この非対称性そのものの実地震での挙動は、実発報時の確認をユーザーに委ねる。

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

### 津波情報の解除理由（cancelReason）
- 津波が消える経路は実際の電文でも3つあり、`JMATsunami.cancelReason`（`'lifted' | 'retracted' | 'expired'`）で区別する。**3経路とも `cancelledAt` セット→10秒間表示→purge という同じ流れを通る**（[useEarthquakes.ts](src/hooks/useEarthquakes.ts) の tsunami ケース）。
  - `lifted`（解除）: 気象庁の正式解除。`InfoType` は `発表` のまま、区域(Item)が電文から消えることで検出（`dmdataParser.ts` の `areas.length === 0` フォールバック）
  - `retracted`（取消）: 誤って発表した電文の撤回。`InfoType === '取消'` で検出
  - `expired`（期限切れ）: `validDateTime` の満了をアプリが検出。予報（若干の海面変動）は明示的な解除電文を伴わずこの経路で消えることが多い
  - 表示文言（見出し・説明文・オーバーレイ短文）は `TsunamiTab/index.tsx` の `CANCEL_REASON_LABEL` が単一の情報源。新しい cancelReason を増やす場合はここと型定義（`types/earthquake.ts`）を同時に直す。
  - **この出し分けは DMDSS 版（DMDATA.JP）限定**。P2PQuake API v2 の公式スキーマ（`JMATsunami`）には `InfoType`・`ValidDateTime` に相当するフィールドが存在しない（[epsp-specifications/json-api-v2.yaml](https://github.com/p2pquake/epsp-specifications/blob/master/json-api-v2.yaml)）ため、通常版（P2PQuake経由）では `cancelReason` は常に `undefined` になり、`CANCEL_REASON_LABEL` のフォールバックで常に「解除」表示になる（クラッシュ等はしない）。
  - `ValidDateTime` が付くのは「津波予報（若干の海面変動）のみ発表の場合」「警報・注意報解除後に予報のみが残る場合」の2パターンのみ、と気象庁の電文解説資料に明記されている（[地震火山関連XML電文解説資料](https://dmdata.jp/docs/jma/manual/0101-0185.pdf) 5.ValidDateTime）。警報・注意報が1区域でも残っている間は付与されない。

### EEW P波・S波予報円の計算元（usePsWaveCalc）
- P波・S波の地表到達円は `usePsWaveCalc.ts`（旧 `useDmdssWaves.ts`）が2層速度モデル（地殻＋マントル・Pn/Sn屈折波）で自前計算する。**標準版・DMDSS版で共通**（2026-07-29 統合。以前は標準版のみ Yahoo `RealTimeData` の `psWave.items` をそのまま使っていたが、Yahoo側は実発報時にしかデータが入らずテストボタンとも無関係だった）。
  - 入力は `EEWAlert.earthquake.hypocenter`（lat/lng/depth/magnitude）と `originTime`。ソースが DMDATA・P2PQuake・Yahoo hypoInfo のいずれでも同じ形なら動く。
  - `condition === '仮定震源要素'`（単独観測点処理・震源未確定の初期報）は円を生成しない（[usePsWaveCalc.ts](src/hooks/usePsWaveCalc.ts)）。DMDATA・P2PQuakeは電文の `condition` フィールドでこれを正しく判別できるが、**Yahoo hypoInfo には相当フィールドが無く常に `condition:'以上'` 固定**（[kyoshin.ts](src/services/kyoshin.ts) の `hypoInfoItemToEEW`）。標準版でYahoo hypoInfoが先にEEWを検知した場合、この判別が効かない非対称性が残る。
  - 標準版はYahoo hypoInfoを主系のEEW検知源とし、P2PQuake WS（code=556）は基本 `areas`（地域別予想震度）の補完役だったが、P2PQuakeの方が `condition`・`hypocenter` とも数値型で正確なため、`enrichEEW`（[useEarthquakes.ts](src/hooks/useEarthquakes.ts)）はこれらも上書きするようにした（報番号が古い場合は上書きしない）。

### EEWレベル判定（特別警報の条件）
- EEWの警報級別（0=予報／1=警報／2=特別警報）は `computeSingleEEWLevel`（[eew.ts](src/utils/eew.ts)）が単一の情報源。`RealtimeTab/index.tsx` の `EEWCard`（カード見出し・配色）もここに一本化しており、別ロジックで再計算しない。
  - 気象庁の実基準に合わせ、特別警報（レベル2）は「震度6弱以上」**または**「長周期地震動階級4以上」のいずれかで判定する（`eewMaxScale(eew) >= 55` or `eewMaxLpgmClass(eew) >= 4`）。
  - **長周期地震動階級のデータは DMDATA（DMDSS版）限定**。`forecastMaxLpgmClass`・地域別 `EEWRegion.lgIntTo` とも DMDATA 電文からのみパースされる（[dmdataParser.ts](src/services/dmdataParser.ts)）。Yahoo hypoInfo（[kyoshin.ts](src/services/kyoshin.ts) の `hypoInfoItemToEEW`）・P2PQuake API v2（[epsp-specifications/json-api-v2.yaml](https://github.com/p2pquake/epsp-specifications/blob/master/json-api-v2.yaml)）とも該当フィールドが存在しないため、標準版では `eewMaxLpgmClass` が常に0になり、震度のみでレベルが決まる。
  - `condition === '仮定震源要素'`（単独点処理）かつ areas が空の場合は、`eewMaxLpgmClass` も `eewMaxScale` と同様に0を返す（単独点PLUM検知では地域別の詳細予想が発表されないため）。
  - `RealtimeTab/index.tsx` の「推定長周期地震動」バナー表示・`App.tsx` の選択解除判定とも、電文全体の `forecastMaxLpgmClass` 単体ではなく `eewMaxLpgmClass(eew)` を参照する。地域別 `lgIntTo` のみで階級4以上に達したケースでも根拠バナーと地図トグルが表示されるようにするため。

### 地図レイヤーの描画順
- 描画順（背面→前面）の単一情報源は `src/components/Map/gl/layerOrder.ts` の `MAP_LAYER_ORDER`。各レイヤーコンポーネントは `addOrderedLayer` で追加し、この配列上で自分より前面に来るべき既存レイヤーの直前へ挿入することで、データ到着タイミングに依存せず順序を保証する。
  - 新レイヤーを足すときは `MAP_LAYER_ORDER` に id を追加し、コンポーネントの `id` と一致させる。配列に無い id は最上段へ積まれる。
  - custom レイヤー（`kyoshin-subthreshold`）は `getStyle().layers` に現れない（MapLibre 仕様）。順序確認は `map.style._order` を見る。

### 震度集約の単位
- ズームアウト時の集約単位は**一次細分区域**（`subregions.json` 由来）。「都道府県」という表現はコメント・ドキュメントで使わない。
  - 閾値定数は `useQuakeLayerData.ts` の `QUAKE_MAX_ZOOM`（= 8。gl/camera.ts の MAX_ZOOM と一致）。この zoom 以下で区域集約に切り替える。
  - **観測点を1つも持たない電文（震度速報）では zoom に関わらず集約を維持する**（`aggregateByRegion` の第2条件 `stationMarkers.length === 0`）。拡大しても増える情報が無いうえ、区域の代表点をドットにすると「その地点の観測値」に見えてしまうため。判定は電文種別ではなく**データの粒度**で行う。LPGM 表示中は `aggregateByRegion` を LPGM と共用しているため対象外にしている（選択中の quake と表示中の LPGM は別イベントのことがある）。

### 地震電文の points 構造（バリアント・経路差）

`JMAQuake.points` には観測点（`isArea:false`）と一次細分区域（`isArea:true`）が混在しうる。
**区域の点は区域内観測点の重心**（`station-coords.json` の `areas`）であって観測値の位置ではないため、**ドット描画には使わない**。

- `useQuakeLayerData` の `stationMarkers`（`isArea:false` のみ）が `QuakeIntensityPointsGL` に渡る唯一の入力。`intensityMarkers`（全点）はカメラフィットのフォールバック専用。取り違えると区域の重心に「観測していない震度」のドットが立つ。
- 電文ごとの中身（2026-08-09 に実電文で確認）:

| 経路 | 震度速報 | 詳細報 |
|---|---|---|
| DMDSS: WebSocket（JSON・`parseIntensityPoints`） | 区域のみ | **区域＋観測点** |
| DMDSS: REST 履歴（XML・`parseEarthquakeFromXml`） | 区域のみ | 区域＋観測点 |
| 標準版: P2PQuake | 区域のみ（`ScalePrompt`） | **観測点のみ**（`DetailScale` は区域を落とす） |

- DMDATA の JSON スキーマで出現条件の注記があるのは `stations`（「VXSE53、VXSE62時のみ出現」）だけで、`regions`・`prefectures` は全種別に出る（[earthquake-information](https://dmdata.jp/docs/reference/conversion/json/schema/earthquake-information)）。**詳細報でも区域が必ず来る**のが標準版との最大の差。
- 震度速報（VXSE51）は震源が未確定のため **`Earthquake` 要素／`body.earthquake` を持たない**。座標は `-200`（位置不明センチネル）、発生時刻は `TargetDateTime`（JSON は `data.targetDateTime`）を使う。両パーサともこの電文だけ震源なしを許容する。**XML パーサ側にこの例外が無く、DMDSS 版はリロードすると震度速報が丸ごと消えていた**（2026-08-09 に修正）。
- `pref` の有無が「都道府県の点」と「区域の点」の識別子を兼ねる（`EarthquakeCard` の `prefGroups`）。**区域は必ず `pref: ''` で積む**。都道府県名を入れると区域が都道府県として誤読される。座標側は `useQuakeLayerData` が区域名から都道府県を逆引きして引き当てる。

### KyoshinSubThreshold の対象範囲
- 対象は **index 1〜6**（震度0以下）。index 0 はデータ無し（`gl/subThresholdLayer.ts` の `subThresholdOpacity(0) = 0`）のため非表示。「0〜6」とコメントしない。
- `KyoshinPointsGL.tsx` が気象庁配色で描画するのは **index 7+**（震度1以上）。
- `KyoshinSubThresholdGL.tsx` は「同レベルのドット同士が重なっても濃くならない」非加算合成を FBO 二層合成のカスタムレイヤー（`gl/subThresholdLayer.ts`）で再現する。毎秒更新は index バッファのカウンティングソート＋`triggerRepaint`。
- `KyoshinSubThresholdGL` に渡す `indices` は **Yahoo の生 index をそのまま渡さない**。`App.tsx` が `kyoshinSubThresholdFilter.ts` の `filterSubThresholdIndices` で、検知エンジン（`kyoshinDetector.ts`）が観測点ごとに学習した慢性ノイズ床（`chronicNoiseFloor`）＋`SUSTAIN_MARGIN` を超えた点だけに絞った `kyoshinSubIndices` を作り、`JapanMapGL` の `kyoshinSubIndices` prop 経由で渡す（`kyoshinIndices`＝生データは `KyoshinPointsGL`/`KyoshinMaxEffectGL` にそのまま渡り続ける・震度1+表示には影響しない）。大阪・岡山のような慢性的にノイジーな観測点が平常時ずっと点灯し続ける問題への対策（2026-07-29）。`floors` が空（検知エンジン未学習の起動直後1フレーム目）はフィルタなしで生データを返す。

### 実地震テストシナリオの時刻シフト・ID再採番
- 実地震テストのシナリオデータ（`public/data/test-scenarios/*.json`）は、キャプチャ時点の絶対時刻（`baseTime`＋各エントリの `offsetMs`）をそのまま保持している。再生時は `testScenarioReplay.ts` の `instantiateScenario` が `now - baseTime` の差分を全イベントの時刻フィールドに一律加算して「今」基準にシフトしてから、`useEarthquakes.ts` の `loadReplayEvents`（`eventQueueRef` の時刻順キュー）に渡す。**クロック全体をずらす方式（DMDATA リプレイ機能の `setReplayOffset`）は使わない**——ライブ接続を維持したまま追加投入する既存の合成テストボタンと同じ思想のため。
- 時刻シフトが必須な理由: EEW の P波・S波円計算（`usePsWaveCalc.ts`）・EEW 自動解除（`calcEEWCancelTime`）・津波の期限切れ判定（`validDateTime`）はいずれも絶対時刻を見て動く。シフトしないとロード直後に「もう過去」と判定され即座にキャンセルされる。
- ID 再採番が必要な理由: 同じシナリオを連打した場合に `activeEEWs`（`Map<eventId, EEWAlert>`）等のキーが衝突し、前回の再生と表示が混線するのを防ぐため。`instantiateScenario` 内の `makeIdRemapper` が元の `eventId` 文字列→新 ID の対応を 1 回の再生を通して一貫させる（同じ元 ID の続報は必ず同じ新 ID になる）。新 ID は `useEarthquakes.ts` の `\d{14}` 正規表現（quake 関連の同一イベント判定）と互換な 14 桁数字にする。
- キャプチャは `scripts/capture-test-scenario.ts`（`tsx` 実行）が `dmdataReplay.ts` の `fetchDmdataReplayEvents` をそのまま再利用し、DMDATA archive から取得した電文をパース済みの内部型（`AppEvent` 等）として JSON 化する。**生電文は保存しない**（standard 版は DMDATA 形式の生電文をパースできないため、両バリアント共通で使うにはパース後の内部型で保存する必要がある）。南海トラフ・後発地震（VYSE50/51/60）の XML パースはブラウザの `DOMParser` に依存するため、キャプチャスクリプトは `jsdom` でグローバルに代替している。
- **`public/data/test-scenarios/*.json`（`index.json` を除く）は `.gitignore` 済みでコミット禁止**。DMDATA.JP [利用規約](https://dmdata.jp/terms/)第15条により、EEW の二次配信は法人契約以外では「公開APIへの使用」「許可なき第三者への表示・鳴動」が制限される。本リポジトリは GitHub Pages で公開されるため、EEW を含むシナリオをコミットすると抵触するおそれがある（2026-07-30 に判明。個人契約下で `capture-scenario` を実行して得たサンプルをコミットしようとして発覚）。`index.json` は空配列 `[]` のテンプレートとしてのみ管理し、実データは各自のローカル環境に留める。

### README プロジェクト構成ツリー
- `src/components/`・`src/hooks/`・`src/utils/` に新ファイルを追加した場合は、`README.md` の「プロジェクト構成」ツリーにも追記する（README 更新の条件に含める）。
