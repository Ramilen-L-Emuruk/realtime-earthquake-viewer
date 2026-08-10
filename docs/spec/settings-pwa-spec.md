# 設定・PWA 仕様書

> 本書は**設定タブ・localStorage・PWA・実地震テストの仕様**をまとめた文書。
> 実コードと食い違う場合は実コードを正とする。

## 1. 概要

以下 4 領域をカバー:

- 設定タブの構成と各項目の意味
- localStorage キー・データ形式
- PWA（Progressive Web App）と Service Worker
- 実地震テスト（合成データによるテストボタン群 + 実電文シナリオ再生）
- DMDSS 版の API キー管理

## 2. 設定タブの構成（`src/components/SettingsTab/index.tsx`）

セクション別に以下の設定を提供:

### 全般設定
- **通知音**: ON/OFF ＋ 音量（0〜1）
- **VOICEVOX 読み上げ**: ON/OFF ＋ URL 設定 ＋ 話者選択 ＋ テスト読み上げ
- **ブラウザ通知**: 種別ごとに独立トグル 3 種（`notifyEEW` / `notifyTsunami` / `notifyDetection`）＋ 通知しきい値（`notifyMinScale`。`震度1以上`〜`震度7`から選択）
- **デフォルトタブ**: 平常時に表示するタブ
- **自動復帰までの時間**: `idleRevertSec` = **ユーザー操作が止まってから**デフォルトタブへ戻る秒数（`0` で無効）

### 表示設定
- **UI 倍率**: 画面全体の UI 拡大縮小
- **地図アイコン倍率**: 地図上のバッジ・観測点ドットのサイズ
- **表示件数**: 地震カードの表示数上限
- **ダークモード**: 常時 ON（切替なし）
- **ホーム地点**: 現在地の緯度経度（震源距離表示に使用）

### バリアント固有（DMDSS 版のみ）
- **DMDATA.JP API キー**: BYOK 方式の入力欄
- **接続状態**: WebSocket 接続の状態表示
- **試験報を受信**: 毎正時の配信テスト受信を有効化

### テスト機能
- **地震テスト** / **EEW 特別警報テスト** / **EEW 警報テスト** / **EEW 予報テスト** / **EEW 誤報取消テスト**
- **大警報テスト** / **警報テスト** / **注意報テスト** / **予報テスト** / **誤報取消テスト**（津波系）
- **揺れの候補テスト** / **揺れ検知テスト**（強震モニタ）
- **実地震テスト**: シナリオ一覧から再生

### 開発者向け
- **定期自動リロード**: N 時間毎にページをリロード（キオスク運用向け）
- **バージョン表示**: `__APP_VERSION__`（`vite.config.ts` の define 経由）

## 3. localStorage キー

| キー | 内容 | 保存先 |
|---|---|---|
| `quake-viewer-settings` | 標準版のユーザー設定 | ブラウザ |
| `quake-viewer-settings-dmdss` | DMDSS 版のユーザー設定 | ブラウザ |
| `kyoshin-v3-learned` | 揺れ検知エンジンの学習資産（chronicNoiseFloor 等） | ブラウザ |
| `quake-heatmap-cache-v2` / `quake-heatmap-cache-dmdss-v2` | 地震活動ヒートマップのキャッシュ | ブラウザ |

`useSettings.ts` が読み書きを担う。バリアントごとにキーが分離されているため、両バリアントを
同一ブラウザで並用しても設定は混ざらない。

**API キーの保存**: DMDSS 版で `dmdataApiKey` フィールドを平文で localStorage に保存する（BYOK 方式）。
XSS が発生した場合に盗まれるリスクは残るが、静的 PWA（サーバーレス）ではこれ以上の防御は難しい。
README・CLAUDE.md にも明記されている運用。

## 4. デフォルト値と読み込み時の防御

`useSettings.ts` の `load()`:

- `localStorage.getItem` → `JSON.parse` → 型キャストで読む
- 失敗（パース例外）時はデフォルト値にフォールバック
- 値の型・範囲検証は現状ほぼ無し（HIGH 課題・過去バージョンの残骸で型不一致が混入すると `<select>` の
  表示状態が不定になる）

## 5. PWA と Service Worker

`vite-plugin-pwa` + Workbox で構築。バリアントごとに独立した Service Worker を生成する。

### バリアント別の設定（`vite.config.ts`）

- **base path**: `/realtime-earthquake-viewer/`（標準）または `/realtime-earthquake-viewer/dmdss/`
- **outDir**: `dist/` または `dist-dmdss/`
- **manifest.name / short_name / description**: バリアントで切り替え
- **manifest.icons**: `vite.config.ts` は `icons/icon-192.png` / `icons/icon-512.png` を参照するが、`public/icons/` には実 PNG が無く SVG のみ（MEDIUM 課題）。`includeAssets` の glob は未マッチ時に警告なく通るため、生成 manifest.json のエントリは残るが実運用の影響（Android/Chrome インストール時のアイコン欠落）は未検証

### Service Worker のスコープ

配信パスの違い（`/realtime-earthquake-viewer/` vs `/dmdss/`）で SW スコープが自然に分離される。
ただし standard 版を先に開いた端末で DMDSS 版へ初回アクセスした瞬間は、standard の NavigationRoute が
横取りしうる（既知の MEDIUM 課題）。

### キャッシュポリシー

- 静的リソース（JS/CSS/HTML/フォント SDF PBF/画像）は precache
- DMDATA / P2PQuake / Yahoo エンドポイントはランタイムキャッシュ対象外（キー付きレスポンスを残さない）
- `cleanupOutdatedCaches()` で古いバージョンのキャッシュを削除

### オフライン動作

ネットワーク接続時のみリアルタイム受信が動作。オフラインでも地図・UI は表示できる（キャッシュされた
JS + 事前生成 GeoJSON のみで動く）。

## 6. 実地震テスト（シナリオ再生）

### 目的

合成テストデータ（`testData.ts`）では再現できない実データ由来の挙動（区域集約・震度分布・続報の推移）を
検証するための機能。**標準版・DMDSS 版共通**で動作する。

### データ形式

`public/data/test-scenarios/*.json` にシナリオ本体を置く。

```ts
// docs/spec/settings-pwa-spec.md の参考記述
// 正の型は src/types/testScenario.ts と src/services/dmdataReplay.ts の ReplayPayload を参照
type TestScenarioFile = {
  id: string
  label: string
  description: string
  category: 'eew-special' | 'eew-warning' | 'eew-forecast' | 'quake' | 'tsunami' | 'lpgm' | 'foreign'
  durationMs: number
  baseTime: string   // ISO
  entries: Array<{
    offsetMs: number
    // ReplayPayload は 4 バリアント（実装: dmdataReplay.ts）
    payload:
      | { kind: 'event'; event: AppEvent }         // quake / eew / tsunami
      | { kind: 'lpgm'; data: JMALpgm }            // 長周期地震動観測情報（VXSE62）
      | { kind: 'nankai'; data: JMANankai }        // 南海トラフ地震関連情報（VYSE50/51）
      | { kind: 'kohatsu'; data: JMAKohatsu }      // 後発地震注意情報（VYSE60）
    silent?: boolean                                // true のとき音・通知・読み上げを抑制（続報の連投で多重発火を避けたい場合等）
  }>
}
```

`public/data/test-scenarios/index.json` にメタ情報の一覧（`baseTime`・`entries` を除いたもの）を置く。

### シナリオ本体の扱い

- **`public/data/test-scenarios/*.json`（`index.json` を除く）は `.gitignore` 済み・コミット禁止**
- 理由: DMDATA.JP 利用規約第 15 条により、EEW の二次配信は個人契約では制限される
- GitHub Pages で公開されるため、EEW を含むシナリオをコミットすると規約違反のおそれ
- `index.json` は空配列 `[]` のテンプレートとしてのみ管理し、実データは各自のローカルに留める

### 再生ロジック（`src/utils/testScenarioReplay.ts`）

`instantiateScenario(scenario, now)` が「今」基準に時刻をシフトして返す:

1. **時刻シフト**: `now - baseTime` の差分を全時刻フィールド（`originTime`・`arrivalTime`・`validDateTime` 等）に一律加算
2. **ID 再採番**: `makeIdRemapper` で元 eventId → 新 ID の対応を作り、同じシナリオ内の続報は同じ新 ID にマップする（`\d{14}` 正規表現互換の 14 桁数字）
3. **再生**: 各エントリを `offsetMs` に応じて `eventQueue` に積む → `useEarthquakes.ts` が時刻順にディスパッチ

**時刻シフトの理由**: EEW P/S 波円計算・自動解除・津波 `validDateTime` は絶対時刻を見て動くため、
シフトしないと「もう過去のイベント」として即座にキャンセルされる。

**ID 再採番の理由**: 同じシナリオを連打すると `activeEEWs`（Map<eventId, EEWAlert>）等のキーが衝突するのを防ぐ。

### クロック全体をずらす方式は使わない

DMDATA リプレイ機能の `setReplayOffset` は使わない（ライブ接続を維持したまま追加投入する既存の合成テストボタンと同じ思想）。
時刻シフトはシナリオ内のイベントに対してのみ適用する。

### シナリオのキャプチャ（`scripts/capture-test-scenario.ts`）

- DMDATA archive API から実電文を取得
- パース済みの内部型として JSON に保存（生電文は保存しない）
- 南海トラフ・後発地震（VYSE50/51/60）の XML パースは `jsdom` でグローバル `DOMParser` を代替
- 要 DMDATA.JP API キー

**既知の課題**:
- **archive リプレイの `EEW_TYPES` から `VXSE43`（警報）が抜けており**（`src/services/dmdataReplay.ts:8` は `new Set(['VXSE45'])`）、警報級 EEW が archive リプレイ時に捨てられる（VXSE44 は廃止予定のため live 側と同様に除外は仕様通り）
- `idPrefix` の 7 文字部分一致で誤マッチの可能性

### P2PQuake からシナリオを作る手順（DMDATA 契約なし）

1. P2PQuake API v2 `history` から対象電文を取得（認証不要）
2. `kind` と 14 桁 eventId を付与
3. `issue.type`・`issue.correct`・`earthquake.domesticTsunami` を日本語化（`convertEvent` と同じ変換）
4. `TestScenarioFile` に包む
5. `public/data/test-scenarios/<id>.json` に配置、`index.json` にメタを追加
6. 検証後: `index.json` を空配列に戻す（`git checkout -- public/data/test-scenarios/index.json`）＋ シナリオ本体を削除

## 7. 合成テストデータ（`src/utils/testData.ts`）

各テストボタンで生成する合成イベントの実装。本節が単一情報源（CLAUDE.md「コード整合性チェック
ポイント」表からこの節がリンクされる側）。

| ボタン | 実装関数 | 最大 scaleTo | 生成イベント |
|---|---|---|---|
| EEW 特別警報テスト | `createTestEEW()` | 60 | 震度 6 強・特別警報（三陸沖 M7.2）※長周期地震動階級 4 |
| EEW 警報テスト | `createTestEEWWarning()` | 50 | 震度 5 強相当・警報（日向灘 M6.5） |
| EEW 予報テスト | `createTestEEWForecast()` | 25 | 震度 2 程度・予報（宮城県沖 M4.5） |
| EEW 誤報取消テスト | `createTestEEWWarning()` + `EEW_RETRACTION_CANCEL_MS`(10s) 後に取消 | 50→取消 | 10 秒後に `cancelled:true` 電文で `eewCancel` 音・通知・読み上げを検証 |
| 地震テスト | `createTestEarthquake()` | - | 令和 6 年能登半島地震の実データベース（`src/data/noto-honshin-2024-*.json`）を採用 |
| 大津波警報テスト | `createTestTsunami()` | - | 大津波警報（無引数で MajorWarning） |
| 津波警報テスト | `createTestTsunamiWarning()` | - | 津波警報 |
| 津波注意報テスト | `createTestTsunamiWatch()` | - | 津波注意報 |
| 津波予報テスト | `createTestTsunamiForecast()` | - | 津波予報（`TEST_AUTO_DISMISS_MS`=90 秒後に `expired` 経路で解除） |
| 津波誤報取消テスト | `createTestTsunamiRetraction()` + 90 秒後に取消電文 | - | 警報・注意報混在の発表 → 90 秒後に電文全体が取り消される（`retracted` 経路） |
| 揺れの候補テスト（強震モニタ） | `runSimulateKyoshinFaint`／`runSimulateKyoshinLikely`（実装は `useEarthquakes.ts`） | - | 弱い揺れ検知の候補（`faint`／`likely`）を UI に反映して発報経路を検証 |
| 揺れ検知テスト（強震モニタ） | `runSimulateKyoshinConfirmed`（実装は `useEarthquakes.ts`） | - | 揺れ検知（`confirmed`）を発報。`detected` 音・カメラ自動フィット・カード表示を検証 |

「10 秒以内に再クリックで続報」「押さなければ自動確定」（`EEW_FINAL_SILENCE_MS`=10 秒）等の
ロジックは `useEarthquakes.ts` の `runSimulateEEW` 系で実装。

### 通知音の対応

- `eewSpecial` — EEW 特別警報テスト
- `eew` — EEW 警報テスト
- `eewForecast` — EEW 予報テスト
- `eewCancel` — EEW 誤報取消テスト（10 秒後の取消電文で発火）
- `eewUpdate` — 続報時（`isNew:false`）
- `eewFinal` — 最終報（無音の自動消去ではなく明示的な最終報用）
- `tsunamiMajor` — 大津波警報テスト
- `tsunami` — 津波警報テスト
- `tsunamiWatch` — 津波注意報テスト
- `tsunamiForecast` — 津波予報テスト
- `detected` / `foreshock` — 揺れ検知テスト（`confirmed`／`likely`・`faint`）

### 自動解除・自動確定のタイミング

- **EEW 誤報取消**: `EEW_RETRACTION_CANCEL_MS`（10 秒）後に明示取消電文が届き、カードに「誤報として取り消されました」を 10 秒表示 → 消去
- **EEW 続報の受付**: `EEW_FINAL_SILENCE_MS`（10 秒）以内に再度テストボタンを押すと続報として発報。押さなければ `isFinal:true` として自動確定 → 無音消去
- **津波予報の期限切れ**: `TEST_AUTO_DISMISS_MS`（90 秒）で `validDateTime` に到達し `expired` 経路で解除
- **津波誤報取消**: `TEST_AUTO_DISMISS_MS`（90 秒）後に取消電文が届き `retracted` 経路で 10 秒間「取消」表示

### DOM 検証テクニック（動作確認用）

Playwright / Chrome DevTools でボタン発火後の DOM 状態を確認したいときの主要な取り出し方:

- **地図の震度バッジ集計**: `maplibregl.Marker` の `element.textContent` に震度文字列（`1`〜`7`）が入る。`document.querySelectorAll('.maplibregl-marker')` から集計できる
- **地図ソースの内容**: `await window.__mapGL.getSource('<sourceId>').getData()` で GeoJSON を取り出せる（本番ビルドでも `window.__mapGL` は露出。`src/components/Map/JapanMapGL.tsx`）
- **レイヤーの表示状態**: `window.__mapGL.getLayoutProperty('<layerId>', 'visibility')`
- **時間経過を伴う挙動の再現**: 自動解除・アイドル復帰・続報自動確定は `localStorage` の書き換え＋リロード、または `setTimeout` の時間送りで確認する

## 8. 定期自動リロード

キオスク運用（ディスプレイに常設）向けに、N 時間ごとに **毎日午前 5 時基準**でページ全体をリロードする機能。
`useSettings.ts` の `periodicReloadHours` で設定。**デフォルトは `1`（毎日午前 5 時にリロード）**。`0` で無効化。

## 9. ホーム地点

ユーザーの現在地の緯度経度を設定できる。設定すると:
- 震度観測点をクリックしたときのポップアップにホーム地点からの距離を表示
- ヒートマップの中心表示に使用

## 10. バージョン表示

`__APP_VERSION__` はビルド時に `vite.config.ts` の `define` が `package.json` の `version` から注入する定数。
`SettingsTab` の下部に表示される。

**注意**: dev サーバーは `package.json` の `version` を変更したあと**再起動しないと反映されない**（HMR では拾えない）。

## 11. 関連実装ファイル

- `src/components/SettingsTab/index.tsx` — 設定 UI
- `src/hooks/useSettings.ts` — localStorage 読み書き
- `src/hooks/useTestScenarios.ts` — シナリオ一覧・再生管理
- `src/utils/testData.ts` — 合成テストデータ生成
- `src/utils/testScenarioReplay.ts` — 時刻シフト・ID 再採番
- `src/types/testScenario.ts` — シナリオデータ型
- `scripts/capture-test-scenario.ts` — シナリオキャプチャ CLI
- `vite.config.ts` — PWA・バリアント切替設定

## 12. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
