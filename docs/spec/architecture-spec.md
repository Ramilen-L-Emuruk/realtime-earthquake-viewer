# アーキテクチャ仕様書

> 本書は**現在の実装が何をどう組み立てているか**をまとめた仕様書。設計判断の経緯は
> 各機能仕様書の改訂履歴節や `docs/archive/` を参照。実コードと食い違う場合は実コードを正とする。

## 1. 概要

React 18 + TypeScript + Vite 6 で作られた PWA（Progressive Web App）。日本の地震情報・緊急地震速報（EEW）・
津波情報・リアルタイム震度をブラウザで表示する。地図は MapLibre GL JS（WebGL 描画）に統一されている。

**主要な設計原則**:
- 地図は常時表示、右パネルをタブで切り替える
- 全ての時刻は「サーバー同期時刻（`serverNow`）」を基準にする（壁時計は信用しない）
- データソースはバリアントごとに切り替える（standard vs DMDSS）

## 2. データフロー（俯瞰）

```
[外部データソース]
  ├─ DMDATA.JP  (WebSocket + REST)       ← DMDSS 版
  ├─ P2PQuake   (WebSocket + REST)       ← 標準版
  └─ Yahoo 強震モニタ (HTTPS JSON 1Hz)   ← 両バリアント共通

        ↓ services 層（`src/services/`）
        ↓ パーサー・接続管理・電文 → 内部型変換

[アプリ状態]
  ├─ useEarthquakes  … 地震・EEW・津波・LPGM の統合状態
  ├─ useKyoshinRealtime … リアルタイム震度データ
  ├─ useKyoshinAlerts   … 揺れ検知結果（震源非依存）
  └─ useSettings        … ユーザー設定（localStorage 永続化）

        ↓ hooks 層（派生データを計算・購読）
        ↓ useEewLayerData / useTsunamiLayerData / useQuakeLayerData / usePsWaveCalc

[UI]
  ├─ App.tsx          … 全体レイアウト・イベント連動
  ├─ MapView          … 地図（4 タブ共通で常時表示）
  ├─ IconNav          … 右端のタブナビ
  └─ 各タブパネル     … EarthquakeTab / RealtimeTab / TsunamiTab / TelegramTab / SettingsTab

[副作用]
  ├─ 通知音（alertSound）
  ├─ ブラウザ通知
  ├─ ウィンドウタイトル変更（useAlertTitle）
  ├─ VOICEVOX 読み上げ（任意）
  └─ 自動タブ切替・カメラ自動フィット
```

各層の詳細は個別仕様書へ:
- 電文パース・接続 → [`data-sources-spec.md`](data-sources-spec.md)
- 地図描画 → [`map-rendering-spec.md`](map-rendering-spec.md)
- 音・タブ切替 → [`audio-tts-spec.md`](audio-tts-spec.md)
- 各情報の処理 → [`eew-spec.md`](eew-spec.md) / [`tsunami-spec.md`](tsunami-spec.md) / [`quake-spec.md`](quake-spec.md)

## 3. ビルドバリアント（standard / DMDSS）

**2 種類のビルドが同一リポジトリから生成される**。切り替えは環境変数 `VITE_VARIANT`。

| バリアント | dev 起動 | ビルド出力 | 配信パス | 主データソース |
|---|---|---|---|---|
| standard | `npm run dev` | `dist/` | `/realtime-earthquake-viewer/` | P2PQuake + Yahoo |
| DMDSS | `npm run dev:dmdss` | `dist-dmdss/` | `/realtime-earthquake-viewer/dmdss/` | DMDATA + Yahoo |

`vite.config.ts` の `define`・`base`・`build.outDir`・`manifest.name` が `VITE_VARIANT` によって切り替わる。
コード側では各所で `const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'` として参照する
（現在 4〜7 ファイルで個別定義。共通化候補）。

**バリアント別に有効な機能マトリクス**:

| 機能 | standard | DMDSS |
|---|---|---|
| 地震情報のリアルタイム受信 | ○（P2PQuake WS） | ○（DMDATA WS） |
| 緊急地震速報（EEW） | ○（P2PQuake + Yahoo） | ○（DMDATA + Yahoo） |
| 津波情報 | ○（P2PQuake） | ○（DMDATA） |
| リアルタイム震度 | ○（Yahoo 共通） | ○（Yahoo 共通） |
| 揺れ検知エンジン | ○ | ○ |
| 長周期地震動階級（実データ） | × | ○ |
| 津波の cancelReason 出し分け | × | ○ |
| 詳細報での区域＋観測点同時表示 | ×（観測点のみ） | ○ |
| 南海トラフ・後発地震情報 | × | ○ |
| 実地震テスト再生 | ○ | ○ |
| VOICEVOX 読み上げ | ○ | ○ |
| ヒートマップ | ○ | ○ |

**GitHub Pages デプロイ**: `.github/workflows/deploy.yml` が `main` へ push されるたびに両バリアントをビルドし、
`dist-dmdss/` の内容を `dist/dmdss/` にマージしてから公開する。Service Worker のスコープは配信パスで自然に
分離されるため、独立した PWA として動作する。

## 4. 主要コンポーネント

### App.tsx（レイアウトの中枢）

- 地図（`MapView` 経由で `JapanMapGL`）を左に常時表示、右パネルをタブで切り替える
- 右端の `IconNav` から `mapTab` を切り替え。`mapTab === 'realtime'` は kyoshin モード
- 各種フック（`useEarthquakes` / `useKyoshinRealtime` / `useKyoshinAlerts` / `useKyoshinDetectorV2` /
  `usePsWaveCalc` / `useLiveEventHandler` / `useAlertTitle`）を配線する
- 通知音・ブラウザ通知・自動タブ切替・カメラ自動フィット・VOICEVOX 読み上げ・EEW 状態管理などの制御をここで行う

App は「1 秒毎更新」（強震モニタ・kyoshinIndices）と「100ms 更新」（EEW 発報中の psWave）の 2 つのタイマーを持ち、
その state を子コンポーネントに配る。過剰な再レンダーが伝播しないよう、下位で `useMemo`・`React.memo` を活用する
（詳細は [`map-rendering-spec.md`](map-rendering-spec.md) 参照）。

### MapView / JapanMapGL

`MapView` は App と地図実装（`JapanMapGL`）の間の薄いラッパー。`JapanMapGL` が MapLibre GL の中枢で、
地図の初期化・スタイル・全レイヤー配線・モード（`quake` / `tsunami` / `kyoshin`）別の表示制御を行う。

各レイヤーは独立したコンポーネント（`*GL.tsx`）として実装され、`mapGLContext` から map インスタンスを取得する。
描画順は `src/components/Map/gl/layerOrder.ts` の `MAP_LAYER_ORDER` が単一情報源。

### IconNav（右端タブナビ）

`ITEMS` 配列で 5 タブを定義（`earthquake` / `realtime` / `tsunami` / `telegrams` / `settings`）。
どのタブも標準版・DMDSS 版で常時表示される（`telegrams` は standard 版では常に空だが、UI は表示）。

### 各タブパネル

| タブ | ファイル | 内容 |
|---|---|---|
| EarthquakeTab | `src/components/EarthquakeTab/` | 地震情報カード一覧・選択 |
| RealtimeTab | `src/components/RealtimeTab/` | EEW カード・S 波カウントダウン・揺れ検知カード |
| TsunamiTab | `src/components/TsunamiTab/` | 津波警報・注意報・予報・観測情報 |
| TelegramTab | `src/components/TelegramTab/` | 受信電文ログ（DMDSS 版のみ実データ、standard は空表示） |
| SettingsTab | `src/components/SettingsTab/` | 各種設定・テストボタン・実地震テスト再生・API キー入力 |

## 5. 状態管理

Redux 等のグローバルストアは使わず、React のフック（`useState` / `useReducer` / `useRef`）で構成する。
主要な状態は `useEarthquakes`（`useReducer` の一種）で `earthquakes` / `activeEEWs` / `tsunamis` /
`lpgmByEventId` / `nankai` / `kohatsu` / `telegramLog` を管理する。

`activeEEWs` は `Map<eventId, EEWAlert>` で保持。eventId は `eew.issue?.eventId ?? eew.id` を統一キーとして
使う（続報が来ても同じキーで上書きされる）。

## 6. 時刻の扱い

**壁時計（`Date.now()`）は絶対値としては信用しない**。以下の時刻は必ずサーバー同期時刻を使う:

- EEW の P/S 波円計算
- EEW 自動解除タイミング
- 津波 `validDateTime` の期限判定
- Yahoo 強震モニタの取得ラグ計算
- 実地震テストシナリオの時刻シフト

実装は `src/utils/clock.ts` の `serverNow()` に統一されている。較正は Yahoo 強震モニタの登録済み秒・
未登録秒の境界（403 → 200 遷移）を捉える方式で 30 秒ごとに行う。詳細は
[`data-sources-spec.md`](data-sources-spec.md) の「クロック同期」節。

## 7. 生成データ（`public/data/`）

以下は事前生成された座標テーブル・境界データ。地図初回表示時または該当タブ表示時に fetch される。

| ファイル | 生成スクリプト | 用途 |
|---|---|---|
| `station-coords.json` | `scripts/build-station-coords.mjs` | 震度観測点の座標＋所属区域 |
| `tsunami-zones.json` | `scripts/build-tsunami-zones.mjs` | 津波予報区の海岸線 |
| `tsunami-obs-coords.json` | 手動整備 | 津波観測点（験潮所）座標 |
| `prefectures.json` | `scripts/build-prefectures.mjs` | 都道府県境界 |
| `subregions.json` | `scripts/build-subregions.mjs` | 一次細分区域境界 |
| `active-faults.json` | `scripts/build-active-faults.mjs` | 全国活断層線 |
| `plate-boundaries.json` | `scripts/build-plate-boundaries.mjs` | プレート境界線 |
| `tts-phrase-break-dict.json` | 手動整備 | 読み上げ用の句区切り辞書 |

`public/data/test-scenarios/*.json` は実地震テストのシナリオデータで、`.gitignore` されている
（DMDATA.JP 利用規約第 15 条により EEW 二次配信が個人契約で制限されるため）。詳細は
[`settings-pwa-spec.md`](settings-pwa-spec.md) の「実地震テスト」節。

## 8. PWA・Service Worker

`vite-plugin-pwa` + Workbox。バリアントごとに独立した Service Worker がキャッシュを管理する。
オフラインでも地図・UI は表示できるが、リアルタイム受信はネットワーク接続時のみ動作。

詳細は [`settings-pwa-spec.md`](settings-pwa-spec.md) の PWA 節。

## 9. 関連する既知の設計判断

- 地図の Leaflet 版は v4.0.0 で完全撤去、MapLibre GL に一本化された（`docs/archive/webgl-migration/` 参照）
- 予報円は Yahoo `psWave.items` から自前計算（`usePsWaveCalc`）に統一（両バリアント共通）
- 「テスト時刻設定（強震モニタ）」の replayTimeOffset は現状 P2PQuake WS も止める副作用がある（既知の HIGH 課題）

## 10. 改訂履歴

- 2026-08-10: 仕様書構造を再編（`docs/spec/` 配下に集約）。本ファイル新規作成
