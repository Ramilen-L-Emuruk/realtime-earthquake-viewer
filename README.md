# リアルタイム地震ビューアー

気象庁の地震情報・緊急地震速報・津波情報をリアルタイムに表示する PWA アプリです。  
[kotoho7/scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page) を参考に React + TypeScript で構築しています。

🌐 **公開ページ**: https://ramilen-l-emuruk.github.io/realtime-earthquake-viewer/

---

## 機能

**地図を常時表示し、右端のアイコンボタンで右パネルの内容を切り替える**構成です。地図の表示内容も選択に応じて変化します。

- **地震情報タブ**
  - 過去の地震をカード表示（最大震度・震源地・M値・深さ・津波の有無・発表種別）
  - 日本地図に **各観測点の震度を震度別の色付きマーカー＋震度ラベルで表示**（震源は×印）
  - **カードをクリックすると、その地震の情報を地図に表示**（選択中のカードを強調）
  - 地図は **震源＋全観測点が収まるよう自動ズーム**
  - マーカー／震源クリックで地点名・震度などの詳細ポップアップを表示
  - P2PQuake WebSocket によるリアルタイム自動更新

- **リアルタイムタブ**
  - 各観測点（約1725点）のリアルタイム震度を Leaflet 地図に毎秒更新で色分け表示（Yahoo リアルタイム震度の JSON データを使用・HTTPS）
  - EEW 非発報時にタブを開くと日本全体を表示
  - 緊急地震速報の発報時は **予報円（青=P波 / 赤=S波）と震源（震源地名ラベル付き）**を地図に重ねて表示し、右パネルに EEW 情報カードを表示
  - 強震モニタの推定震度が震度1相当以上の揺れを検知すると、右パネルに **「揺れを検知中」カード**を表示（推定最大震度を震度スケール色付きで表示）
  - 右パネルに震度カラースケール凡例・注記

- **津波情報タブ**
  - 大津波警報 / 津波警報 / 津波注意報をリアルタイム表示
  - **警報・注意報の海域を地図の海岸線に等級色で描画**（大津波警報＝紫／警報＝赤／注意報＝橙）し、対象区域へ自動ズーム
  - 到達予想時刻・予想高さを表示

- **設定タブ**
  - 通知音・ブラウザ通知のオン/オフ、最低表示震度・通知最低震度・リスト表示件数・**UI 倍率**の設定
  - **デフォルトタブ**（地震情報／リアルタイム）・**津波発表中の津波情報優先**・**自動復帰までの時間**の設定
  - ブラウザ通知の許可・各種テスト送信

- **通知音**
  - 地震情報・緊急地震速報・津波情報の受信時に、種別ごとの音を再生（Web Audio API で生成）
  - 設定でオン/オフ可能（既定オン）。ブラウザの自動再生制限により初回操作後に有効化

- **自動タブ切替**
  - 地震情報・津波情報の受信時に該当タブを、緊急地震速報の発報時にリアルタイムタブを自動的に表示
  - 情報更新・操作が一定時間（既定30秒・設定で変更可／無効化も可能）ないとデフォルトタブへ自動的に復帰（津波発表中は設定により津波情報を優先）

- **緊急地震速報 (EEW)**
  - 発報時にリアルタイムタブを自動表示し、予報円（P波/S波）・震源を地図に、情報カードを右パネルに表示
  - 発報直後は震源を中心に表示し、予報円の拡大に合わせて自動的にズームアウト
  - 情報番号（#N）・対象地域・最大震度予想を表示

- **PWA 対応**
  - ホーム画面へのインストール（Android / iOS / デスクトップ）
  - Service Worker によるオフラインキャッシュ

- **ウィンドウタイトル連携**
  - 情報更新時（地震・緊急地震速報・津波の受信、揺れ検知）にウィンドウタイトルを変更
  - デフォルトタブへ復帰するタイミングで平常時タイトルに戻る
  - AutoHotKey 等の外部ツールがウィンドウタイトルを監視してイベントを発火する用途に利用可能

---

## 技術スタック

| カテゴリ | 使用技術 |
|---|---|
| フレームワーク | React 18 + TypeScript |
| ビルドツール | Vite 6 |
| スタイル | Tailwind CSS（ダークテーマ） |
| 地図 | React-Leaflet + CARTO Dark タイル |
| PWA | vite-plugin-pwa + Workbox |
| データ | [P2PQuake API v2](https://api.p2pquake.net/v2/docs/) |
| リアルタイム震度 | [Yahoo!天気・災害 リアルタイム震度](https://typhoon.yahoo.co.jp/weather/jp/earthquake/kyoshin/)（防災科研 強震モニタ由来） |
| デプロイ | GitHub Pages + GitHub Actions |

---

## セットアップ

### 必要環境

- Node.js 20 以上

### インストール・起動

```bash
# 依存関係インストール
npm install

# 開発サーバー起動（http://localhost:5173）
npm run dev

# 本番ビルド
npm run build

# 本番プレビュー
npm run preview
```

### npm スクリプト

| スクリプト | 説明 |
|---|---|
| `npm run dev` | 開発サーバー起動 |
| `npm run build` | 型チェック + 本番ビルド（`dist/`） |
| `npm run preview` | 本番ビルドのプレビュー |

> 地図表示用のデータテーブルは以下のスクリプトで再生成できます（通常は更新不要）。
> - 観測点座標（`public/data/station-coords.json`）: `node scripts/build-station-coords.mjs`
> - 津波予報区の海岸線（`public/data/tsunami-zones.json`）: `node scripts/build-tsunami-zones.mjs`

---

## GitHub Pages へのデプロイ

`main` ブランチへの push で GitHub Actions が自動的にビルドして GitHub Pages に公開します（`.github/workflows/deploy.yml`）。

### 初回のみ必要な設定

1. GitHub リポジトリの **Settings → Pages → Build and deployment → Source** を **「GitHub Actions」** に設定する
2. `main` に push すると自動でビルド & デプロイされる

### ベースパスについて

GitHub Pages のプロジェクトサイトはサブパス配信（`/<リポジトリ名>/`）になるため、`vite.config.ts` の `base` をリポジトリ名に合わせています。

```ts
// vite.config.ts
const base = '/realtime-earthquake-viewer/'
```

- リポジトリ名を変更する場合は、この `base` も合わせて変更してください。
- 独自ドメイン等でルート配信する場合は `base` を `'/'` にしてください。

---

## ウィンドウタイトル連携（AutoHotKey 等）

情報更新があるとウィンドウ（ブラウザ）のタイトルが変化するため、AutoHotKey などの外部ツールからタイトルを監視してイベントを発火できます。

| 状態 | ウィンドウタイトル |
|---|---|
| 平常時 | `リアルタイム地震ビューアー` |
| 地震情報の受信 | `🔴 地震情報 <震源> 最大震度<N>` |
| 緊急地震速報の発報 | `🚨 緊急地震速報 <震源> 最大震度<N>予想` |
| 津波情報の発表 | `🌊 津波情報 発表中` |
| 揺れ検知 | `📈 揺れ検知` |

- タイトルは**デフォルトタブへ復帰するタイミング**（情報更新・操作が一定時間ない＝設定の「自動復帰までの時間」経過時）で平常時に戻ります。
- 「自動復帰までの時間」を「無効」にしている場合は、次の情報更新まで変化後のタイトルが維持されます。

**AutoHotKey の例**（緊急地震速報の検知）

```autohotkey
SetTimer, CheckTitle, 1000
return

CheckTitle:
    if WinExist("🚨 緊急地震速報")
    {
        ; ここに発火したい処理を書く
    }
return
```

> ブラウザのタブタイトルがウィンドウタイトルに反映されるよう、対象タブを開いた状態（またはキオスク／アプリモード）で使用してください。

---

## データソース

| データ | 提供元 | 説明 |
|---|---|---|
| 地震情報・津波情報 | [P2PQuake API v2](https://api.p2pquake.net/v2/docs/) | 無料・認証不要。WebSocket + REST |
| 緊急地震速報 | P2PQuake API v2 (code: 556) | リアルタイム WebSocket |
| リアルタイム震度 | [Yahoo!天気・災害 リアルタイム震度](https://typhoon.yahoo.co.jp/weather/jp/earthquake/kyoshin/) | 観測点ごとのリアルタイム震度 JSON（HTTPS・1秒更新、防災科研 強震モニタ由来） |
| 観測点座標 | 気象庁 震度観測点一覧（[iku55 氏による JSON 化](https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1)） | 地図に各地点をプロットするための座標テーブル |
| 津波予報区の海岸線 | 気象庁 予報区等 GIS データ（[Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)） | 津波の海域を海岸線として描画するためのライン座標 |
| 地図タイル | [CARTO Dark Matter](https://carto.com/attributions) | © OpenStreetMap contributors |

### P2PQuake イベントコード

| コード | 内容 |
|---|---|
| 551 | JMA 地震情報（震度速報・震源情報・各地の震度） |
| 552 | JMA 津波情報 |
| 556 | 緊急地震速報（EEW） |

### 震度スケール

| 値 | 震度 |
|---|---|
| 10 | 1 |
| 20 | 2 |
| 30 | 3 |
| 40 | 4 |
| 45 | 5弱 |
| 50 | 5強 |
| 55 | 6弱 |
| 60 | 6強 |
| 70 | 7 |

> P2PQuake の観測点データには座標が含まれないため、`pref`（都道府県）+ `addr`（観測点名／細分区域名）を
> キーに座標テーブルを引き当てて地図にプロットしています。

---

## プロジェクト構成

```
realtime-earthquake-viewer/
├── .github/
│   └── workflows/
│       └── deploy.yml              # GitHub Pages 自動デプロイ
├── public/
│   ├── icons/                      # アプリアイコン
│   └── data/
│       ├── station-coords.json     # 震度観測点・細分区域の座標テーブル（生成物）
│       └── tsunami-zones.json      # 津波予報区の海岸線座標（生成物）
├── scripts/
│   ├── build-station-coords.mjs    # 観測点座標テーブル生成スクリプト
│   └── build-tsunami-zones.mjs     # 津波予報区 海岸線データ生成スクリプト
├── src/
│   ├── App.tsx                     # 地図常時表示 + タブ別パネル + 通知音/自動タブ切替/ウィンドウタイトル連携
│   ├── components/
│   │   ├── IconNav.tsx             # アイコンボタンによるナビゲーション
│   │   ├── MapUpdateTime.tsx       # 地図左上の更新時刻オーバーレイ
│   │   ├── EarthquakeTab/          # 地震情報パネル（カード一覧・選択）
│   │   ├── Map/
│   │   │   ├── JapanMap.tsx        # Leaflet 日本地図（震度マーカー / 津波海岸線 / 強震モニタ）
│   │   │   └── KyoshinPoints.tsx   # 強震モニタ観測点の Canvas 描画レイヤー
│   │   ├── RealtimeTab/            # 凡例・注記パネル（地図は JapanMap が担当）
│   │   ├── SettingsTab/            # 設定パネル
│   │   └── TsunamiTab/             # 津波情報パネル
│   ├── hooks/
│   │   ├── useEarthquakes.ts       # P2PQuake WS + REST 状態管理
│   │   ├── useKyoshinRealtime.ts   # Yahoo リアルタイム震度のポーリング
│   │   ├── useSettings.ts          # アプリ設定（localStorage 永続化）
│   │   ├── useStationCoords.ts     # 観測点座標テーブルの読み込み
│   │   └── useTsunamiZones.ts      # 津波予報区 海岸線データの読み込み
│   ├── services/
│   │   ├── kyoshin.ts              # Yahoo リアルタイム震度の取得・デコード
│   │   └── p2pquake.ts             # P2PQuake API クライアント（自動再接続）
│   ├── types/
│   │   └── earthquake.ts           # P2PQuake API 型定義
│   └── utils/
│       ├── alertSound.ts           # 通知音生成（Web Audio API）
│       ├── intensity.ts            # 震度スケール色・ラベル
│       ├── kyoshinColor.ts         # リアルタイム震度のカラースケール
│       ├── stationCoords.ts        # 地点名→座標の引き当て
│       ├── tsunamiZones.ts         # 津波予報区 海岸線データの引き当て
│       └── formatters.ts           # 日時・数値フォーマッター
├── index.html
├── package.json
├── vite.config.ts                  # Vite + PWA 設定（base 設定含む）
└── tailwind.config.js
```

---

## 注意事項

- 本アプリが表示する情報は参考情報です。避難等の判断は気象庁や自治体の公式情報を確認してください。
- 強震モニタの震度は推定値であり、気象庁発表の震度と異なる場合があります。
- 緊急地震速報は予測情報のため、実際の揺れと異なる場合があります。
- P2PQuake API は非公式サービスのため、サービス継続性は保証されません。

---

## ライセンス

MIT License

地図データ: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, © [CARTO](https://carto.com/attributions)
