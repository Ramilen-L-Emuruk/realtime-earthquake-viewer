# リアルタイム地震ビューアー

気象庁の地震情報・緊急地震速報・津波情報・リアルタイム震度を表示する PWA アプリです。
React + TypeScript + MapLibre GL JS で構築されています。
[kotoho7/scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page) を参考にしています。

🌐 **通常版（P2PQuake）**: https://ramilen-l-emuruk.github.io/realtime-earthquake-viewer/
🌐 **DM-D.S.S 版（DMDATA.JP）**: https://ramilen-l-emuruk.github.io/realtime-earthquake-viewer/dmdss/

> 「DM-D.S.S」は DMDATA.JP のサービス名。以下のドキュメントとコード（`VITE_VARIANT=dmdss`）では表記を短縮して **DMDSS** と記載する。

## 主な機能

- **地震情報**: 過去の地震カード・観測点別震度・区域塗り・震源マーカーを地図に表示
- **緊急地震速報（EEW）**: 発報時に予報円・震源・警報区域を表示、S 波到達までカウントダウン
- **津波情報**: 大津波警報・警報・注意報・予報を海岸線に色分け、観測情報も併記
- **リアルタイム震度**: 強震モニタ由来の各地の震度を毎秒更新、震源非依存の揺れ検知エンジン付き
- **通知連携**: 種別ごとの通知音・ブラウザ通知・自動タブ切替・ウィンドウタイトル変更（AutoHotKey 等で監視可能）
- **PWA 対応**: ホーム画面へのインストールとオフラインキャッシュに対応
- **VOICEVOX 読み上げ**: ローカル VOICEVOX と連携して情報を音声で読み上げ（任意）
- **電文ログ**: 受信電文の一覧・生電文コピー・ダウンロード（開発・検証用途、DM-D.S.S 版のみ実データ）

各機能の詳細仕様は [`docs/spec/`](docs/spec/) 配下の機能別仕様書を参照。

## ビルドバリアント

standard 版と DM-D.S.S 版の 2 種類のビルドを同一リポジトリから生成できます。

| バリアント | dev 起動 | データソース | 配信パス |
|---|---|---|---|
| 通常版 | `npm run dev` | P2PQuake + Yahoo 強震モニタ | `/realtime-earthquake-viewer/` |
| DM-D.S.S 版 | `npm run dev:dmdss` | DMDATA.JP + Yahoo 強震モニタ | `/realtime-earthquake-viewer/dmdss/` |

バリアント別の有効機能マトリクスは [`docs/spec/architecture-spec.md`](docs/spec/architecture-spec.md) 参照。

## セットアップ

必要環境: Node.js 20 以上

```bash
# 依存関係インストール
npm install

# 開発サーバー起動（http://localhost:5173）
npm run dev            # 通常版
npm run dev:dmdss      # DM-D.S.S 版

# 本番ビルド
npm run build          # 通常版 → dist/
npm run build:dmdss    # DM-D.S.S 版 → dist-dmdss/

# 本番プレビュー
npm run preview
```

## 技術スタック

- **フレームワーク**: React 18 + TypeScript
- **ビルドツール**: Vite 6
- **スタイル**: Tailwind CSS（ダークテーマ）
- **地図**: MapLibre GL JS v6（WebGL 描画）
- **PWA**: vite-plugin-pwa + Workbox
- **音声合成**: VOICEVOX（任意・ローカル HTTP API 経由）

## ドキュメント

開発時は以下の仕様書を参照してください。**実コードと食い違う場合は実コードを正とします**。

- [`docs/spec/README.md`](docs/spec/README.md) — 仕様書一覧のインデックス
- [`docs/spec/architecture-spec.md`](docs/spec/architecture-spec.md) — 全体アーキテクチャ・バリアント切替
- [`docs/spec/eew-spec.md`](docs/spec/eew-spec.md) — 緊急地震速報
- [`docs/spec/tsunami-spec.md`](docs/spec/tsunami-spec.md) — 津波情報
- [`docs/spec/quake-spec.md`](docs/spec/quake-spec.md) — 地震情報
- [`docs/spec/map-rendering-spec.md`](docs/spec/map-rendering-spec.md) — 地図描画
- [`docs/spec/audio-tts-spec.md`](docs/spec/audio-tts-spec.md) — 通知音・読み上げ・タイトル連携
- [`docs/spec/data-sources-spec.md`](docs/spec/data-sources-spec.md) — DMDATA / P2PQuake / Yahoo の統合
- [`docs/spec/settings-pwa-spec.md`](docs/spec/settings-pwa-spec.md) — 設定・PWA・実地震テスト
- [`docs/spec/kyoshin-detection-spec.md`](docs/spec/kyoshin-detection-spec.md) — 強震モニタ揺れ検知エンジン
- [`CLAUDE.md`](CLAUDE.md) — 開発ワークフロー（Claude Code / 人間 共通）

完了済み PoC・移行記録は [`docs/archive/`](docs/archive/) にまとめています。

## 注意事項

- 本アプリが表示する情報は参考情報です。避難等の判断は気象庁や自治体の公式情報を確認してください。
- 強震モニタの震度は推定値であり、気象庁発表の震度と異なる場合があります。
- 緊急地震速報は予測情報のため、実際の揺れと異なる場合があります。
- P2PQuake API は非公式サービスのため、サービス継続性は保証されません。
- DM-D.S.S 版で使用する DMDATA.JP API キーはブラウザの `localStorage` に平文保存されます。共有端末での利用には注意してください。

## ライセンス

MIT License

**データ・地図の出典**:
- 地図データ: 「気象庁 予報区等 GIS データ（都道府県・地震情報／細分区域・津波予報区）」
- 海底地形: GEBCO; NOAA National Centers for Environmental Information (NCEI)
- 活断層データ: 「産総研 活断層データベース」（政府標準利用規約 2.0）
- プレート境界データ: PB2002 (Bird, 2003) — [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates)（Open Data Commons Attribution License）
