# リアルタイム地震ビューアー

気象庁の地震情報・緊急地震速報・津波情報をリアルタイムに表示する PWA アプリです。  
[kotoho7/scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page) を参考に React + TypeScript で構築しています。

---

## 機能

- **地震情報タブ**
  - 過去30件の地震をカード表示（震度・震源地・M値・深さ・津波の有無）
  - 日本地図に最新の震源地マーカーを表示（クリックで都道府県別震度サマリー）
  - P2PQuake WebSocket によるリアルタイム自動更新

- **リアルタイムタブ**
  - 防災科研・強震モニタ画像を毎秒更新表示
  - 震度カラースケール凡例

- **津波情報タブ**
  - 大津波警報 / 津波警報 / 津波注意報をリアルタイム表示
  - 到達予想時刻・予想高さを表示

- **緊急地震速報 (EEW)**
  - 警報 / 予報をヘッダー下にアニメーションバナーで表示
  - 対象地域・最大震度予想を表示

- **PWA 対応**
  - ホーム画面へのインストール（Android / iOS / デスクトップ）
  - Service Worker によるオフラインキャッシュ

- **Home Assistant 連携**
  - Webhook サーバー経由のプッシュ通知（SSE）
  - URL パラメータによるアラート起動（キオスクモード対応）

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
| リアルタイム監視 | [防災科研 強震モニタ](https://www.kmoni.bosai.go.jp/) |

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

---

## Home Assistant 連携

地震発生時に Home Assistant から通知を受け取り、ビューアーを自動表示に切り替える機能です。

### 方法1: Webhook サーバー（リアルタイムプッシュ）

**サーバー起動**

```bash
npm run server
# → http://localhost:3001 で待機
```

**Home Assistant 設定例**

`configuration.yaml` に以下を追加し、HA を再起動します。

```yaml
rest_command:
  earthquake_alert:
    url: "http://<このPCのIPアドレス>:3001/webhook"
    method: POST
    content_type: application/json
    payload: '{"type": "earthquake_alert", "message": "地震が発生しました"}'
```

**オートメーション例**

```yaml
automation:
  - alias: "地震アラートをビューアーに通知"
    trigger:
      - platform: state
        entity_id: sensor.earthquake_alert  # HA の地震センサー
        to: "on"
    action:
      - service: rest_command.earthquake_alert
```

**アラートを解除する場合**

```bash
curl -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "dismiss"}'
```

### 方法2: URL パラメータ（Kiosk モード）

Fully Kiosk Browser や HA ダッシュボードの「URL を開く」アクションで使用できます。

```
http://localhost:5173/?ha_alert=1&message=地震発生
```

| パラメータ | 説明 |
|---|---|
| `ha_alert=1` | アラートバナーを表示 |
| `message=テキスト` | バナーに表示するメッセージ（任意） |

アラートは **5分後に自動消去** されます。

### Webhook サーバーのエンドポイント

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/webhook` | POST | HA からアラートを受信 |
| `/sse` | GET | PWA が SSE で接続するエンドポイント |
| `/status` | GET | サーバーステータス確認 |

**ポート変更**

```bash
PORT=3002 npm run server
```

---

## データソース

| データ | 提供元 | 説明 |
|---|---|---|
| 地震情報・津波情報 | [P2PQuake API v2](https://api.p2pquake.net/v2/docs/) | 無料・認証不要。WebSocket + REST |
| 緊急地震速報 | P2PQuake API v2 (code: 556) | リアルタイム WebSocket |
| リアルタイム震度 | [防災科研 強震モニタ](https://www.kmoni.bosai.go.jp/) | 1秒更新の観測画像 |
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

---

## プロジェクト構成

```
realtime-earthquake-viewer/
├── public/
│   └── icons/
│       └── icon.svg            # アプリアイコン
├── server/
│   └── webhook.js              # HA Webhook サーバー（標準ライブラリのみ）
├── src/
│   ├── components/
│   │   ├── ConnectionStatus.tsx # WebSocket 接続状態インジケーター
│   │   ├── EEWBanner.tsx        # 緊急地震速報バナー
│   │   ├── Header.tsx           # アプリヘッダー
│   │   ├── TabBar.tsx           # タブナビゲーション
│   │   ├── EarthquakeTab/       # 地震情報タブ
│   │   ├── Map/
│   │   │   └── JapanMap.tsx     # Leaflet 日本地図
│   │   ├── RealtimeTab/         # 強震モニタ表示タブ
│   │   └── TsunamiTab/          # 津波情報タブ
│   ├── hooks/
│   │   ├── useEarthquakes.ts    # P2PQuake WS + REST 状態管理
│   │   └── useWebhookAlert.ts   # HA アラート状態管理
│   ├── services/
│   │   └── p2pquake.ts          # P2PQuake API クライアント（自動再接続）
│   ├── types/
│   │   └── earthquake.ts        # P2PQuake API 型定義
│   └── utils/
│       ├── intensity.ts         # 震度スケール色・ラベル
│       └── formatters.ts        # 日時・数値フォーマッター
├── index.html
├── package.json
├── vite.config.ts               # Vite + PWA 設定
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
