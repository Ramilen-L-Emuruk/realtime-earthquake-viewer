# リアルタイム地震ビューアー

気象庁の地震情報・緊急地震速報・津波情報をリアルタイムに表示する PWA アプリです。  
[kotoho7/scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page) を参考に React + TypeScript で構築しています。

🌐 **通常版（P2PQuake）**: https://ramilen-l-emuruk.github.io/realtime-earthquake-viewer/  
🌐 **DM-D.S.S 版（DMDATA.JP）**: https://ramilen-l-emuruk.github.io/realtime-earthquake-viewer/dmdss/

---

## 機能

地図を常時表示し、右端のアイコンボタンで右パネルの内容を切り替える構成です。

- **地震情報タブ**: 過去の地震をカード表示。地図に各観測点の震度を色付きドットで表示し、震源をマーク。カードを選択するとその地震の情報に切り替わる。
- **リアルタイムタブ**: 各観測点のリアルタイム震度を毎秒更新で地図に表示。緊急地震速報の発報時は予報円・震源を地図に重ねて表示し、右パネルに EEW 情報カードを表示。揺れ検知時は検知カードを表示。
- **津波情報タブ**: 大津波警報・津波警報・津波注意報・津波予報（若干の海面変動）を表示。対象海域を地図の海岸線に等級色で描画し対象区域へ自動ズーム。
- **設定タブ**: 通知音・ブラウザ通知・表示件数・UI 倍率・デフォルトタブ・自動復帰時間などを設定。各種テスト送信も可能。DM-D.S.S 版では DMDATA.JP の API キー設定・接続状態確認も行える。
- **通知音**: 地震情報・緊急地震速報・津波情報の受信時に種別ごとの音を再生。
- **自動タブ切替**: 情報受信時に該当タブを自動表示。一定時間操作がなければデフォルトタブへ復帰。
- **PWA 対応**: ホーム画面へのインストールとオフラインキャッシュに対応。
- **ウィンドウタイトル連携**: 情報受信時にウィンドウタイトルを変更。AutoHotKey 等の外部ツールから監視可能。

---

## 技術スタック

| カテゴリ | 使用技術 |
|---|---|
| フレームワーク | React 18 + TypeScript |
| ビルドツール | Vite 6 |
| スタイル | Tailwind CSS（ダークテーマ） |
| 地図 | React-Leaflet + 自前の行政区域ベースマップ（タイル不使用・ダーク／地方・県・都市ラベル） |
| PWA | vite-plugin-pwa + Workbox |
| データ | 通常版: [P2PQuake API v2](https://api.p2pquake.net/v2/docs/) / DM-D.S.S 版: [DMDATA.JP API](https://dmdata.jp/) |
| リアルタイム震度 | [Yahoo!天気・災害 リアルタイム震度](https://typhoon.yahoo.co.jp/weather/jp/earthquake/kyoshin/)（防災科研 強震モニタ由来）|
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
| `npm run dev` | 通常版 開発サーバー起動 |
| `npm run dev:dmdss` | DM-D.S.S 版 開発サーバー起動 |
| `npm run build` | 型チェック + 通常版 本番ビルド（`dist/`） |
| `npm run build:dmdss` | 型チェック + DM-D.S.S 版 本番ビルド（`dist-dmdss/`） |
| `npm run preview` | 本番ビルドのプレビュー |

> 地図表示用のデータテーブルは以下のスクリプトで再生成できます（通常は更新不要）。
> - 観測点座標（`public/data/station-coords.json`）: `node scripts/build-station-coords.mjs`
> - 津波予報区の海岸線（`public/data/tsunami-zones.json`）: `node scripts/build-tsunami-zones.mjs`
> - 都道府県境界（`public/data/prefectures.json`）: `node scripts/build-prefectures.mjs`
> - 一次細分区域境界（`public/data/subregions.json`）: `node scripts/build-subregions.mjs`

---

## GitHub Pages へのデプロイ

`main` ブランチへの push で GitHub Actions が自動的にビルドして GitHub Pages に公開します（`.github/workflows/deploy.yml`）。

### 初回のみ必要な設定

1. GitHub リポジトリの **Settings → Pages → Build and deployment → Source** を **「GitHub Actions」** に設定する
2. `main` に push すると自動でビルド & デプロイされる

### ベースパスについて

GitHub Pages のプロジェクトサイトはサブパス配信（`/<リポジトリ名>/`）になるため、`vite.config.ts` の `base` をリポジトリ名に合わせています。

| バリアント | base パス | ビルド出力 |
|---|---|---|
| 通常版 | `/realtime-earthquake-viewer/` | `dist/` |
| DM-D.S.S 版 | `/realtime-earthquake-viewer/dmdss/` | `dist-dmdss/` |

GitHub Actions のデプロイでは `dist-dmdss/` の内容を `dist/dmdss/` にマージしてから Pages に公開するため、両版が同一サイトに共存します。  
各バリアントは Service Worker のスコープが異なり、独立した PWA として動作します。

- リポジトリ名を変更する場合は `vite.config.ts` の `base` 変数も合わせて変更してください。
- 独自ドメイン等でルート配信する場合は通常版の `base` を `'/'` にしてください。

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

### 通常版（P2PQuake）

| データ | 提供元 | 説明 |
|---|---|---|
| 地震情報・津波情報 | [P2PQuake API v2](https://api.p2pquake.net/v2/docs/) | 無料・認証不要。WebSocket + REST |
| 緊急地震速報 | P2PQuake API v2 (code: 556) | リアルタイム WebSocket |
| リアルタイム震度 | [Yahoo!天気・災害 リアルタイム震度](https://typhoon.yahoo.co.jp/weather/jp/earthquake/kyoshin/) | 観測点ごとのリアルタイム震度 JSON（HTTPS・1秒更新、防災科研 強震モニタ由来） |
| 観測点座標 | 気象庁 震度観測点一覧（[iku55 氏による JSON 化](https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1)） | 地図に各地点をプロットするための座標テーブル |
| 津波予報区の海岸線 | 気象庁 予報区等 GIS データ（[Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)） | 津波の海域を海岸線として描画するためのライン座標 |
| 行政区域（都道府県境界） | 気象庁 予報区等 GIS データ（[Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)） | ベースマップの陸地・県境を自前描画（タイル不使用）。一次細分区域と同一ソースで海岸線が整合。`scripts/build-prefectures.mjs` で生成 |
| 一次細分区域（地震情報の地域） | 気象庁 予報区等 GIS データ（[Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)） | 区域境界・区域名ラベル・地震の区域別震度集約に使用。`scripts/build-subregions.mjs` で生成 |
| 海底地形（背景・任意） | [Esri World Ocean Base](https://www.arcgis.com/home/item.html?id=1e126e7520f9466c9ca28b8f28b5e500) | 背景に海底地形を表示（設定で ON/OFF）。Esri, GEBCO, NOAA ほか |

### DM-D.S.S 版（DMDATA.JP）

| データ | 提供元 | 説明 |
|---|---|---|
| 緊急地震速報（EEW） | [DMDATA.JP API](https://dmdata.jp/) VXSE42/43/44/45 | WebSocket。気象庁発表から1秒未満で取得。地域別予想震度・到達予想時刻・警報/予報区域の色分け表示。要 API キー（VXSE45=地震動予報、VXSE43=警報、VXSE44=予報、VXSE42=配信テスト） |
| 地震情報 | DMDATA.JP VXSE51/52/53 | WebSocket + REST 履歴。VXSE53（震源・各地震度）は地域別震度をリアルタイムに表示 |
| 津波情報 | DMDATA.JP VTSE41/51/52 | WebSocket リアルタイム受信 + REST 履歴。VTSE52（沖合観測）は観測点名・波高・到達時刻を表示 |
| リアルタイム震度 | Yahoo!天気・災害 リアルタイム震度 | 通常版と同一（DMDATA.JP はリアルタイム震度を提供しないため） |

DMDATA.JP のAPIキーは設定タブから入力し、ブラウザの localStorage に保存されます。APIキーは [dmdata.jp](https://dmdata.jp/) で取得できます。

WebSocket で受信する電文本体（`body`）は base64 + gzip で配信されるため、ブラウザネイティブの `DecompressionStream('gzip')` で復号してから解析します。また設定タブの「試験報を受信（検証用）」を有効にすると、毎正時に配信される EEW 配信テスト（VXSE42）等の試験報・訓練報を受信でき、実地震を待たずにリアルタイム受信経路を検証できます（受信した試験 EEW は通常の発報と同様にカード・音・地図へ表示）。

### P2PQuake イベントコード（通常版）

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
│       ├── tsunami-zones.json      # 津波予報区の海岸線座標（生成物）
│       ├── prefectures.json        # 都道府県の境界ポリゴン（ベースマップ用・生成物）
│       └── subregions.json         # 一次細分区域の境界ポリゴン（生成物）
├── scripts/
│   ├── build-station-coords.mjs    # 観測点座標テーブル生成スクリプト
│   ├── build-tsunami-zones.mjs     # 津波予報区 海岸線データ生成スクリプト
│   ├── build-prefectures.mjs       # 都道府県境界データ生成スクリプト
│   └── build-subregions.mjs        # 一次細分区域境界データ生成スクリプト
├── src/
│   ├── App.tsx                     # 地図常時表示 + タブ別パネル + 通知音/自動タブ切替/ウィンドウタイトル連携
│   ├── components/
│   │   ├── IconNav.tsx             # アイコンボタンによるナビゲーション
│   │   ├── MapUpdateTime.tsx       # 地図左上の更新時刻オーバーレイ
│   │   ├── EarthquakeTab/          # 地震情報パネル（カード一覧・選択）
│   │   ├── Map/
│   │   │   ├── JapanMap.tsx           # Leaflet 日本地図（震度マーカー / 津波海岸線 / 強震モニタ）
│   │   │   ├── BaseMap.tsx            # 行政区域ベースマップ（県境・一次細分区域境界・陸地・地方/県/区域名ラベル）
│   │   │   ├── IntensityPoints.tsx    # 地震情報タブの観測点震度マーカー（Leaflet CircleMarker）
│   │   │   ├── KyoshinPoints.tsx      # 強震モニタ観測点の Canvas 描画レイヤー（震度1以上）
│   │   │   ├── KyoshinSubThreshold.tsx # 強震モニタの震度0以下（index 1〜6）の OffscreenCanvas 描画
│   │   │   ├── KyoshinDetectedPoints.tsx # 揺れ検知された観測点の可変サイズ描画
│   │   │   └── KyoshinMaxEffect.tsx   # 強震モニタの最大震度エフェクト描画
│   │   ├── RealtimeTab/            # 凡例・注記パネル（地図は JapanMap が担当）
│   │   ├── SettingsTab/            # 設定パネル
│   │   ├── TelegramTab/            # 受信電文ログビューアー（DM-D.S.S 版）
│   │   └── TsunamiTab/             # 津波情報パネル
│   ├── hooks/
│   │   ├── useEarthquakes.ts       # P2PQuake / DMDATA.JP WS + REST 状態管理（VITE_VARIANT で切替）
│   │   ├── useKyoshinRealtime.ts   # Yahoo リアルタイム震度のポーリング
│   │   ├── useKyoshinDetection.ts  # 強震モニタの揺れ検知（6層フィルタ）
│   │   ├── useDmdssWaves.ts        # DM-D.S.S 版 EEW の P波・S波地表到達半径アニメーション
│   │   ├── useSWaveCountdown.ts    # S波到達カウントダウン
│   │   ├── useSettings.ts          # アプリ設定（localStorage 永続化）
│   │   ├── useStationCoords.ts     # 観測点座標テーブルの読み込み
│   │   ├── useTsunamiZones.ts      # 津波予報区 海岸線データの読み込み
│   │   └── useSubRegions.ts        # 一次細分区域境界データの読み込み
│   ├── services/
│   │   ├── kyoshin.ts              # Yahoo リアルタイム震度の取得・デコード
│   │   ├── p2pquake.ts             # P2PQuake API クライアント（自動再接続）
│   │   ├── dmdata.ts               # DMDATA.JP WebSocket クライアント（DM-D.S.S 版用）
│   │   └── dmdataParser.ts         # DMDATA.JP JSON 電文 → 内部型変換（DM-D.S.S 版用）
│   ├── types/
│   │   └── earthquake.ts           # P2PQuake API 型定義
│   └── utils/
│       ├── alertSound.ts           # 通知音生成（Web Audio API）
│       ├── eew.ts                  # EEW 対象地域・最大震度・情報番号の算出
│       ├── intensity.ts            # 震度スケール色・ラベル
│       ├── kyoshinIntensity.ts     # リアルタイム震度インデックス→震度階級/色（気象庁配色）
│       ├── lpgm.ts                 # 長周期地震動階級のラベル・色
│       ├── tsunami.ts              # 津波情報の等級算出
│       ├── stationCoords.ts        # 地点名→座標の引き当て
│       ├── tsunamiZones.ts         # 津波予報区 海岸線データの引き当て
│       ├── prefectures.ts          # 都道府県境界データの読み込み
│       ├── subregions.ts           # 一次細分区域境界データの読み込み
│       ├── regions.ts              # 地方区分ラベル一覧
│       ├── geo.ts                  # 点の多角形内包判定（区域別集約用）
│       ├── formatters.ts           # 日時・数値フォーマッター
│       └── testData.ts             # 設定タブのテストボタン用サンプルデータ生成
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
- DM-D.S.S 版で使用する DMDATA.JP API キーはブラウザの localStorage に平文で保存されます。共有端末での利用には注意してください。

---

## ライセンス

MIT License

地図データ: 「気象庁 予報区等GISデータ（都道府県・地震情報／細分区域・津波予報区）」
海底地形: © Esri, GEBCO, NOAA, National Geographic, and other contributors
