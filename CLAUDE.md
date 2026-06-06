# CLAUDE.md

realtime-earthquake-viewer（リアルタイム地震ビューアー）で作業するときの手順とルール。

## プロジェクト概要

- React 18 + TypeScript + Vite 6 製の PWA。Leaflet 地図で地震情報・緊急地震速報・津波情報・リアルタイム震度を表示する。
- データ: P2PQuake API v2（WebSocket + REST）／ Yahoo リアルタイム震度（強震モニタ・HTTPS JSON）。
- GitHub Pages（サブパス配信 `/realtime-earthquake-viewer/`）へ GitHub Actions で自動デプロイ。

## 変更時の基本フロー（必ずこの順で行う）

1. **実装**
2. **検証**（下記「検証」を実施。型チェック必須＋**実行確認（ブラウザ確認）必須**）
3. **README 更新**（下記「README 更新」の条件に該当する場合）
4. **バージョン更新確認**（コミット前に **AskUserQuestion ツール**で必ず以下の選択肢をユーザーに提示する。**省略しない**）
   - 「メジャーバージョンを上げる」「マイナーバージョンを上げる」「パッチバージョンを上げる」「バージョンを上げない」
   - バージョンを上げる場合は `package.json` の `version` フィールドと `src/components/SettingsTab/index.tsx` のバージョン表示を合わせて更新してからコミットする
5. **コミット**（下記「コミット」の規約に従い、確認を求めず自動で行う）
6. **プッシュ**（**ユーザーから明示的に指示があったときのみ**。自動では行わない）

> ユーザーから「今後は必要に応じて README を更新して、コミットまで自動で行う」方針の指示済み。
> ユーザーから「修正後は毎回バージョン種別（メジャー/マイナー/パッチ/なし）を確認する」方針の指示済み。

## 検証

> **コードを修正した場合は、型チェックだけでなく必ずアプリを起動して実行確認（ブラウザ確認）まで行う。**
> 型チェックのみで完了とせず、`npm run dev` で起動し Playwright MCP で実際の表示・挙動を確認してからコミットする。

- **型チェック（必須）**: `npx tsc -b`（または `npm run build`）。エラー0を確認する。
- **アプリ起動**: `npm run dev` → `http://localhost:5173/realtime-earthquake-viewer/`
  （`vite.config.ts` の `base` によりサブパス配信になる点に注意。5173 が使用中なら 5174 等にフォールバックするため、起動ログで実ポートを確認する）。
  - **検証用に起動した dev サーバーは Claude のセッション中は停止せず起動したままにする**（ユーザー指示）。次の検証では新規起動せず、稼働中のサーバー（既定 5173）へ Playwright で接続して再利用する。セッションをまたぐ必要は無い。
- **本番ビルド確認**（大きめの変更時）: `npm run build`。
- **ブラウザ確認（修正時は必須）**: Playwright MCP で上記 URL を開き、スクリーンショット・`browser_evaluate` で表示やDOMを確認する。
  - コンソールエラーが0件であることを確認する（リロード時の P2P WebSocket 再接続 warning は良性で無視してよい）。
  - 自動解除や時間経過で発火する挙動（自動タブ切替・アイドル復帰など）は、`localStorage` の書き換え＋リロードや DOM 検査で確認する。
  - **確認後も開発サーバーは停止しない**（セッション中は起動したまま残す）。`Stop-Process -Name node` のような一括停止は MCP サーバーまで巻き込むため使わない。
  - 検証用スクリーンショットはリポジトリ直下に出力されるが**一時ファイル。コミット前に必ず削除する**（コミットしない）。`.playwright-mcp/` の出力も同様に Git 管理対象外（`.gitignore` 済み）。
- **テスト機能の活用**: 設定タブのテストボタンで動作確認できる。
  - 地震テスト → 地震カード追加・地図の震度マーカー・自動タブ切替
  - EEW 特別警報テスト → 震度6弱以上・警報（三陸沖 M7.2）→ `eewSpecial` 音・EEW カード（警報/赤）・震源マーカー
  - EEW 警報テスト → 震度5弱相当・警報（茨城県沖 M6.5）→ `eew` 音・EEW カード（警報/赤）
  - EEW 予報テスト → 震度2程度・予報（宮城県沖 M4.5）→ `eewForecast` 音・EEW カード（予報/オレンジ）
  - 大警報テスト → 大津波警報（岩手・宮城・福島等）→ `tsunamiMajor` 音・津波タブの海岸線描画
  - 注意報テスト → 津波注意報（北海道）→ `tsunamiWatch` 音・津波タブの海岸線描画
  - EEW は約10秒で自動解除（解除音）。同ボタン再クリックで続報（`eewUpdate` 音）。異なるボタンを押すと前の EEW タイマーをキャンセルし新規発報。
  - 大警報テストは約15秒、注意報テストは約10秒で自動解除。
  - ※予報円は実データ依存のため平常時は表示されない。

### 環境による制約

- 一部の外部ホストへ到達できない環境がある（例: 防災科研 kmoni の HTTPS）。Yahoo 強震モニタ（`weather-kyoshin.*.storage-yahoo.jp`）・P2PQuake API は到達可能。
- **予報円（Yahoo `psWave`）は実 EEW 発報時のみデータが入る**ため、平常時は実地確認できない。コードのみ確認し、実発報時の確認をユーザーに委ねる。

## README 更新

機能・画面構成・データソース・依存・デプロイ方法・設定項目・プロジェクト構成に影響する変更では、`README.md` の該当箇所（機能一覧／技術スタック／データソース／プロジェクト構成 等）も合わせて最新化する。
スタイルの微調整やレイアウトの軽微な調整など、README の記載に影響しない変更では更新不要。

## コミット

- **Conventional Commits**（`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `ci`）。説明は日本語。
- コミットメッセージ末尾に必ず付与:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- 検証用スクリーンショット（`*.png`）はコミットに含めない。
- Windows 環境のため `LF will be replaced by CRLF` の警告が出るが正常（無視してよい）。
- このリポジトリは `main` に直接コミットしている。

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

## 構成メモ

- `src/App.tsx`: レイアウトの中枢。地図常時表示＋アイコンナビ（右端）でパネル内容を切替。地図内容・更新時刻・通知音・自動タブ切替・EEW 連携の制御もここ。
- 地図のモード（`JapanMap` の `mode`）: `quake`（地震）／`tsunami`（津波海岸線）／`kyoshin`（リアルタイム震度・予報円）。
- 生成データ（`public/data/*.json`）は座標が大きいため遅延読込（必要なタブ表示時のみ fetch）。
