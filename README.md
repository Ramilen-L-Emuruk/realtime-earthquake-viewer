# リアルタイム地震ビューアー

気象庁の地震情報・緊急地震速報・津波情報をリアルタイムに表示する PWA アプリです。  
[kotoho7/scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page) を参考に React + TypeScript で構築しています。

🌐 **通常版（P2PQuake）**: https://ramilen-l-emuruk.github.io/realtime-earthquake-viewer/  
🌐 **DM-D.S.S 版（DMDATA.JP）**: https://ramilen-l-emuruk.github.io/realtime-earthquake-viewer/dmdss/

---

## 機能

地図を常時表示し、右端のアイコンボタンで右パネルの内容を切り替える構成です。

- **地震情報タブ**: 過去の地震をカード表示。地図に各観測点の震度を色付きドットで表示し、震源をマーク。観測点はホバーで観測点名と震度、クリックで所属する一次細分区域と震源距離まで表示する。カードを選択するとその地震の情報に切り替わる。
- **リアルタイムタブ**: 各観測点のリアルタイム震度を毎秒更新で地図に表示。緊急地震速報の発報時は予報円・震源を地図に重ねて表示し、右パネルに EEW 情報カードを表示。揺れの候補クラスタが立った時点でタブ切替・タイトル変更・控えめな通知音・地図フィットで早期に知らせ、確定すると検知カード・通知音・ブラウザ通知を伴う本検知へ切り替わる。
- **津波情報タブ**: 大津波警報・津波警報・津波注意報・津波予報（若干の海面変動）を表示。同一階級内で予想波高が同じ区域はグルーピングして表示し、津波予報区コードが一致する観測情報（観測点名・波高・到達時刻）は該当区域の直下に表示。紐づけできない観測（沖合観測など）は別カードにフォールバック表示。対象海域を地図の海岸線に等級色で描画し対象区域へ自動ズーム。
- **設定タブ**: 通知音・ブラウザ通知・表示件数・UI 倍率・デフォルトタブ・自動復帰時間などを設定。合成データによる各種テスト送信に加え、実際に発生した地震の電文データを発生時と同じ間隔で再生する「実地震テスト」も可能（標準版・DM-D.S.S 版共通）。DM-D.S.S 版では DMDATA.JP の API キー設定・接続状態確認も行える。
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
| 地図 | MapLibre GL JS（WebGL 描画）+ 自前の行政区域ベースマップ（陸/境界＋海底地形タイル・ダーク／地方・県・区域名ラベルは事前生成 SDF グリフの symbol 描画）+ ネイティブ heatmap（地震活動）+ 震度0以下ドットは FBO 非加算合成のカスタムレイヤー |
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

> 実地震テストのシナリオ（`public/data/test-scenarios/*.json`）は、DMDATA.JP の archive API から実際の電文を取得して追加できます（要 DMDATA.JP API キー。取得した電文はパース済みの内部型として保存し、生電文は保存しません）。APIキーはシェル履歴に残らないよう環境変数での指定を推奨します。
> ```bash
> DMDATA_API_KEY=<APIキー> npm run capture-scenario -- \
>   --from=<開始日時ISO> --to=<終了日時ISO> \
>   --id=<シナリオID> --label=<表示名> --description=<説明文> --category=<カテゴリ>
> ```
> `category` は `eew-special` / `eew-warning` / `eew-forecast` / `quake` / `tsunami` / `lpgm` / `foreign` のいずれか。
>
> ⚠️ **生成した `public/data/test-scenarios/*.json`（`index.json` を除く）はコミットしないでください**（`.gitignore` 済み）。DMDATA.JP [利用規約](https://dmdata.jp/terms/)第15条により、緊急地震速報（EEW）の二次配信は法人契約以外では「公開APIへの使用」「許可なき第三者への表示・鳴動」が制限されています。本リポジトリは GitHub Pages で公開されるため、EEWを含むシナリオをコミットするとこの制限に抵触するおそれがあります。取得したシナリオは各自のローカル環境でのみ利用してください。

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
| 揺れ検知の候補（未確定） | `🔍 揺れの可能性` |
| 揺れ検知 | `📈 揺れ検知` |

- タイトルは**デフォルトタブへ復帰するタイミング**（情報更新・操作が一定時間ない＝設定の「自動復帰までの時間」経過時）で平常時に戻ります。
- 「自動復帰までの時間」を「無効」にしている場合は、次の情報更新まで変化後のタイトルが維持されます。
- 津波情報のタイトルは既定では**発表が解除されるまでずっと表示**されます（緊急地震速報も同様）。設定の「津波タイトル表示を一定時間に制限」を ON にすると、受信のたびに「自動復帰までの時間」だけ表示し、発表中でも自動的に平常時タイトルへ戻ります。

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
| 観測点座標・所属区域 | 気象庁 震度観測点一覧（[iku55 氏による JSON 化](https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1)） | 地図に各地点をプロットするための座標テーブル。あわせて各観測点が属する一次細分区域も保持し、区域別震度集約の帰属に使う（座標は約1km粒度のため、ポリゴンとの内包判定では細い島や海岸沿いの観測点が海側に落ちる） |
| 津波予報区の海岸線 | 気象庁 予報区等 GIS データ（[Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)） | 津波の海域を海岸線として描画するためのライン座標 |
| 行政区域（都道府県境界） | 気象庁 予報区等 GIS データ（[Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)） | ベースマップの陸地・県境を自前描画（タイル不使用）。一次細分区域と同一ソースで海岸線が整合。`scripts/build-prefectures.mjs` で生成 |
| 一次細分区域（地震情報の地域） | 気象庁 予報区等 GIS データ（[Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)） | 区域境界・区域名ラベル・地震の区域別震度集約に使用。`scripts/build-subregions.mjs` で生成 |
| 海底地形（背景・任意） | [GEBCO Basemap (NCEI)](https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer) | 背景に海底地形を表示（設定で ON/OFF）。GEBCO, NOAA/NCEI |
| 活断層線（任意） | 産業技術総合研究所（産総研）[活断層データベース](https://gbank.gsj.jp/activefault/) | 地震情報・リアルタイムタブの地図に全国の活断層線を表示（設定で ON/OFF・濃さ調整）。政府標準利用規約2.0。`scripts/build-active-faults.mjs` で生成 |
| 地震活動ヒートマップ（任意） | P2PQuake API v2 `/jma/quake` | 直近1ヶ月の地震活動を地図にヒートマップ表示（設定で ON/OFF）。初回表示時に取得し localStorage に一定時間キャッシュ |
| プレート境界線（任意） | [PB2002](http://peterbird.name/publications/2003_pb2002/2003_pb2002.htm)（[fraxen/tectonicplates](https://github.com/fraxen/tectonicplates) GeoJSON化） | 地震情報・リアルタイムタブの地図に日本周辺のプレート境界線を表示（設定で ON/OFF）。Open Data Commons Attribution License。`scripts/build-plate-boundaries.mjs` で生成 |

### DM-D.S.S 版（DMDATA.JP）

| データ | 提供元 | 説明 |
|---|---|---|
| 緊急地震速報（EEW） | [DMDATA.JP API](https://dmdata.jp/) VXSE42/43/44/45 | WebSocket。気象庁発表から1秒未満で取得。地域別予想震度・到達予想時刻・警報/予報区域の色分け表示。要 API キー（VXSE45=地震動予報、VXSE43=警報、VXSE44=予報、VXSE42=配信テスト） |
| 地震情報 | DMDATA.JP VXSE51/52/53 | WebSocket + REST 履歴。VXSE53（震源・各地震度）は地域別震度をリアルタイムに表示 |
| 津波情報 | DMDATA.JP VTSE41/51/52 | WebSocket リアルタイム受信 + REST 履歴。観測情報（VTSE51/VTSE52）は観測点名・波高・到達時刻を表示し、津波予報区コードが一致する発表区域に紐づけて表示。観測のみの電文（区域情報を含まない）が届いても直前の区域情報を保持し、観測値のみ更新 |
| リアルタイム震度 | Yahoo!天気・災害 リアルタイム震度 | 通常版と同一（DMDATA.JP はリアルタイム震度を提供しないため） |
| 地震活動ヒートマップ（任意） | DMDATA.JP API `GD Earthquake List`（`gd.earthquake` スコープ） | 直近1ヶ月の地震活動を地図にヒートマップ表示（設定で ON/OFF）。電文個別取得を伴わず一覧取得のみで完結 |

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
│   ├── fonts/                      # 地名ラベル用の事前生成 SDF グリフ PBF（Noto Sans JP/・build-glyphs.mjs 生成物）
│   └── data/
│       ├── station-coords.json     # 震度観測点・細分区域の座標＋観測点の所属区域テーブル（生成物）
│       ├── tsunami-zones.json      # 津波予報区の海岸線座標（生成物）
│       ├── tsunami-obs-coords.json # 津波観測点（験潮所等）の座標テーブル
│       ├── prefectures.json        # 都道府県の境界ポリゴン（ベースマップ用・生成物）
│       ├── subregions.json         # 一次細分区域の境界ポリゴン（生成物）
│       ├── active-faults.json      # 全国活断層線データ（生成物）
│       ├── plate-boundaries.json   # 日本周辺のプレート境界線データ（生成物）
│       └── test-scenarios/         # 実地震テストのシナリオデータ（生成物・capture-test-scenario.ts で追加）
│           ├── index.json          # シナリオ一覧（id/label/description/category/durationMs）
│           └── <id>.json           # シナリオ本体（時刻オフセット付きのパース済み電文列）
├── scripts/
│   ├── build-station-coords.mjs    # 観測点座標テーブル生成スクリプト
│   ├── build-tsunami-zones.mjs     # 津波予報区 海岸線データ生成スクリプト
│   ├── build-prefectures.mjs       # 都道府県境界データ生成スクリプト
│   ├── build-subregions.mjs        # 一次細分区域境界データ生成スクリプト
│   ├── build-active-faults.mjs     # 全国活断層線データ生成スクリプト
│   ├── build-plate-boundaries.mjs  # プレート境界線データ生成スクリプト
│   ├── build-glyphs.mjs            # 地名ラベル用 SDF グリフ PBF 生成（同梱 Noto Sans JP を @mapbox/tiny-sdf で焼く）
│   ├── capture-test-scenario.ts    # 実地震テストのシナリオキャプチャ CLI（DMDATA archive → 内部型JSON、tsx実行）
│   ├── fonts/                      # グリフ生成のソースフォント（Noto Sans JP・OFL・非配信）
│   └── perf/                          # 描画負荷計測（WebGL 移行計画 段階0）
│       ├── measure-kyoshin-static.js  # 計測スクリプト（ブラウザ注入・自動実行/自動送信対応）
│       ├── vite-plugin-perf-report.ts # dev 専用: 計測スクリプト配信・実機からの証跡受信
│       └── results/                   # 計測証跡 JSON（実機 before/after）
├── src/
│   ├── App.tsx                     # 地図常時表示 + タブ別パネル + 通知音/自動タブ切替/ウィンドウタイトル連携
│   ├── components/
│   │   ├── IconNav.tsx             # アイコンボタンによるナビゲーション
│   │   ├── MapUpdateTime.tsx       # 地図左上の更新時刻オーバーレイ
│   │   ├── EarthquakeTab/          # 地震情報パネル（カード一覧・選択）
│   │   ├── Map/                       # MapLibre GL JS 地図。全レイヤーを WebGL で描画（*GL.tsx）
│   │   │   ├── MapView.tsx            # 地図ラッパー（App と JapanMapGL の間で Props 契約を仲介）
│   │   │   ├── mapTypes.ts            # 地図 Props / モード型の単一情報源
│   │   │   ├── JapanMapGL.tsx         # MapLibre 地図の中枢（map 生成・スタイル・全レイヤー配線）
│   │   │   ├── mapGLContext.ts        # map インスタンス購読 Context（react-leaflet useMap 相当を自前実装）
│   │   │   ├── BaseMapGL.tsx          # 行政区域ベースマップ（陸地塗り・県境・一次細分区域境界・海底地形タイル暗色化）
│   │   │   ├── LabelsGL.tsx           # 地方/県/区域名ラベル（symbol + 事前生成 SDF グリフ・ズーム帯で粒度切替）
│   │   │   ├── QuakeIntensityPointsGL.tsx # 地震情報タブの観測点震度点（circle＋ホバー/クリックのポップアップ）
│   │   │   ├── QuakeRegionFillGL.tsx  # 一次細分区域別の震度塗り＋震度バッジ
│   │   │   ├── EpicenterGL.tsx        # 震源マーカー（×）＋ポップアップ
│   │   │   ├── QuakeHeatmapGL.tsx     # 直近1ヶ月の地震活動ヒートマップ（MapLibre ネイティブ heatmap）
│   │   │   ├── LpgmPointsGL.tsx / LpgmRegionFillGL.tsx # 長周期地震動の観測点点（ポップアップ付き）・区域塗り
│   │   │   ├── KyoshinPointsGL.tsx    # 強震モニタ観測点（震度1以上・feature-state 毎秒更新）
│   │   │   ├── KyoshinSubThresholdGL.tsx # 震度0以下（index 1〜6）。FBO 二層合成のカスタムレイヤー（非加算合成）
│   │   │   ├── KyoshinDetectedPointsGL.tsx / KyoshinMaxEffectGL.tsx # 揺れ検知点・最大震度波紋エフェクト
│   │   │   ├── ActiveFaultsGL.tsx / PlateBoundariesGL.tsx # 活断層線・プレート境界線（line＋当たり判定ポップアップ）
│   │   │   ├── TsunamiLinesGL.tsx / TsunamiObsBarsGL.tsx # 津波海岸線（等級色・点滅）・津波観測棒
│   │   │   ├── EewRegionFillGL.tsx / EewLpgmRegionFillGL.tsx / EewEpicentersGL.tsx # EEW 予想震度塗り・予想長周期塗り・震源
│   │   │   ├── PsWaveGL.tsx           # EEW P波・S波地表到達円（getCanvasContainer 上のオーバーレイ Canvas）
│   │   │   ├── CameraFollowsGL.tsx    # カメラ追従一括（地震/検知/候補/EEW/津波フィット・観測フォーカス・idle 抑制）
│   │   │   └── gl/                    # GL 補助（layerOrder=描画順の単一情報源 / geojson / camera / linePopup / pointPopup / popupHtml / subThresholdLayer）
│   │   ├── SpecialInfoBanner/      # 南海トラフ臨時情報・国民保護情報バナー
│   │   ├── RealtimeTab/            # 強震モニタ検知(V2)カード・EEW情報・凡例・注記パネル（地図は JapanMapGL が担当）
│   │   ├── SettingsTab/            # 設定パネル
│   │   ├── TelegramTab/            # 受信電文ログビューアー（DM-D.S.S 版）
│   │   └── TsunamiTab/             # 津波情報パネル
│   ├── hooks/
│   │   ├── useEarthquakes.ts       # DMDATA.JP / P2PQuake WS + REST 状態管理（VITE_VARIANT で切替）
│   │   ├── useLiveEventHandler.ts  # ライブイベント受信時の通知音・タイトル・タブ切替・読み上げ
│   │   ├── useAlertTitle.ts        # ウィンドウタイトル（情報タイトル）管理
│   │   ├── useKyoshinAlerts.ts     # 強震モニタ検知（候補=likely・確定=confirmed）に応じたタブ切替・タイトル・通知音
│   │   ├── useKyoshinRealtime.ts   # Yahoo リアルタイム震度のポーリング
│   │   ├── useKyoshinDetectorV2.ts # 強震モニタの揺れ検知エンジン（純粋コア step の React ラッパー）
│   │   ├── usePsWaveCalc.ts        # EEW の P波・S波地表到達半径アニメーション（標準版・DM-D.S.S 版共通の自前計算）
│   │   ├── useSWaveCountdown.ts    # S波到達カウントダウン
│   │   ├── useSettings.ts          # アプリ設定（localStorage 永続化）
│   │   ├── useTestScenarios.ts     # 実地震テストのシナリオ一覧・再生管理（標準版・DM-D.S.S 版共通）
│   │   ├── useStationCoords.ts     # 観測点座標テーブルの読み込み
│   │   ├── useTsunamiZones.ts      # 津波予報区 海岸線データの読み込み
│   │   ├── useTsunamiObsCoords.ts  # 津波観測点座標テーブルの読み込み
│   │   ├── useSubRegions.ts        # 一次細分区域境界データの読み込み
│   │   ├── useActiveFaults.ts      # 全国活断層線データの読み込み
│   │   ├── useQuakeHeatmap.ts      # 直近1ヶ月の地震活動ヒートマップ用データの取得・キャッシュ
│   │   ├── usePlateBoundaries.ts   # プレート境界線データの読み込み
│   │   ├── useQuakeLayerData.ts    # 地震モードの描画派生データ（震度点・区域集約・震源・LPGM）を計算する共有フック
│   │   ├── useTsunamiLayerData.ts  # 津波モードの描画派生データ（海岸線・観測棒）を計算する共有フック
│   │   └── useEewLayerData.ts      # EEW の描画派生データ（予想震度塗り・予想長周期塗り・震源）を計算する共有フック
│   ├── services/
│   │   ├── kyoshin.ts              # Yahoo リアルタイム震度の取得・デコード
│   │   ├── p2pquake.ts             # P2PQuake API クライアント（自動再接続）
│   │   ├── dmdata.ts               # DMDATA.JP WebSocket クライアント（DM-D.S.S 版用）
│   │   └── dmdataParser.ts         # DMDATA.JP JSON 電文 → 内部型変換（DM-D.S.S 版用）
│   ├── types/
│   │   ├── earthquake.ts           # 地震情報・EEW・津波情報の型定義
│   │   └── testScenario.ts         # 実地震テストのシナリオデータ型定義
│   └── utils/
│       ├── alertSound.ts           # 通知音生成（Web Audio API）
│       ├── eew.ts                  # EEW 対象地域・最大震度・情報番号の算出、自動解除時刻の計算、hypoInfo差分からのEEW導出
│       ├── quakeMerge.ts           # 地震電文の統合コア（同一eventIdの電文を時刻順に1枚へ統合。live/履歴/P2Pで共通）
│       ├── intensity.ts            # 震度スケール色・ラベル
│       ├── kyoshinIntensity.ts     # リアルタイム震度インデックス→震度階級/色（気象庁配色）
│       ├── kyoshinDetector.ts      # 強震モニタ検知エンジン（純粋コア: トリガー→アソシエーション→確信度スコア→分裂統合）
│       ├── kyoshinDetectionView.ts # V2 検知イベント→表示状態（確信度・検知点・候補点）への変換
│       ├── kyoshinSubThresholdFilter.ts # 震度0ドット表示専用: 検知エンジンが学習した慢性ノイズ床でフィルタ
│       ├── notifications.ts        # ブラウザ通知の表示
│       ├── lpgm.ts                 # 長周期地震動階級のラベル・色
│       ├── tsunami.ts              # 津波情報の等級算出・観測情報のマージ
│       ├── tsunamiStyle.ts         # 津波等級ごとの海岸線色・線幅・重なり順の定義
│       ├── stationCoords.ts        # 地点名→座標の引き当て
│       ├── tsunamiZones.ts         # 津波予報区 海岸線データの引き当て
│       ├── tsunamiObsCoords.ts     # 津波観測点座標テーブルの読み込み
│       ├── prefectures.ts          # 都道府県境界データの読み込み
│       ├── subregions.ts           # 一次細分区域境界データの読み込み
│       ├── activeFaults.ts         # 全国活断層線データの読み込み
│       ├── quakeHeatmap.ts         # マグニチュード→ヒートマップ重みの変換
│       ├── plateBoundaries.ts      # プレート境界線データの読み込み
│       ├── regions.ts              # 地方区分ラベル一覧
│       ├── geo.ts                  # 点の多角形内包判定（区域別集約用）
│       ├── formatters.ts           # 日時・数値フォーマッター
│       ├── ttsText.ts              # 読み上げテキスト生成（地震・EEW・津波）
│       ├── voicevox.ts             # VOICEVOX 連携（音声合成・話者一覧取得）
│       ├── clock.ts                # アプリ全体の時刻基準（サーバー同期・壁時計ずれ非依存の serverNow）
│       ├── logger.ts               # console ログへの時刻付与（clock の serverNow に追従）
│       ├── gebcoPrefetch.ts        # 海底地形タイル（GEBCO）の先読み: 沖縄〜択捉相当をアイドル時に低ズーム優先でバックグラウンド fetch
│       ├── testData.ts             # 設定タブのテストボタン用サンプルデータ生成
│       └── testScenarioReplay.ts   # 実地震テストシナリオの時刻シフト・ID再採番（「今」基準にインスタンス化）
├── index.html
├── package.json
├── vite.config.ts                  # Vite + PWA 設定（base 設定含む）
└── tailwind.config.js
```

---

## 開発者向けドキュメント

- 強震モニタ揺れ検知エンジンの詳細仕様: [`docs/kyoshin-detection-spec.md`](docs/kyoshin-detection-spec.md)

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
海底地形: GEBCO; NOAA National Centers for Environmental Information (NCEI)
活断層データ: 「産総研 活断層データベース」（政府標準利用規約2.0）
プレート境界データ: PB2002 (Bird, 2003) — [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates)（Open Data Commons Attribution License）
