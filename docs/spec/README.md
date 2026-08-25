# 仕様書インデックス

このディレクトリには「現在参照される仕様書」のみを置く。実装は仕様書より速く動くため、
**食い違いがある場合は実コードを正とする**（各仕様書の冒頭でも個別に宣言）。

過去の設計調査・PoC 記録・移行計画などの完了済みドキュメントは
[`docs/archive/`](../archive/) に移動されている（現在は WebGL 移行関連のみ）。

**まだ実装していない**機能の計画と可否判断は [`docs/implementation-plan.md`](../implementation-plan.md) にある。
このディレクトリが扱うのは実装済みの仕様だけ。

## 仕様書一覧

| 仕様書 | 対象範囲 | 主な実装ファイル |
|---|---|---|
| [architecture-spec.md](architecture-spec.md) | 全体アーキテクチャ・バリアント切替・データフロー | `src/App.tsx`, `vite.config.ts` |
| [eew-spec.md](eew-spec.md) | 緊急地震速報（レベル判定・自動解除・仮定震源・P/S 波円） | `src/utils/eew.ts`, `src/hooks/usePsWaveCalc.ts` |
| [tsunami-spec.md](tsunami-spec.md) | 津波情報（3 経路の解除・海岸線・観測点） | `src/hooks/useEarthquakes.ts`（tsunami）, `src/components/TsunamiTab/` |
| [quake-spec.md](quake-spec.md) | 地震情報（電文パース・区域集約・カード表示） | `src/utils/quakeMerge.ts`, `src/components/EarthquakeTab/`, `src/hooks/useQuakeLayerData.ts` |
| [map-rendering-spec.md](map-rendering-spec.md) | MapLibre GL・レイヤー順・描画パフォーマンス | `src/components/Map/`, `src/components/Map/gl/` |
| [audio-tts-spec.md](audio-tts-spec.md) | 通知音・VOICEVOX・ウィンドウタイトル | `src/utils/alertSound.ts`, `src/utils/voicevox.ts`, `src/hooks/useAlertTitle.ts` |
| [data-sources-spec.md](data-sources-spec.md) | DMDATA / P2PQuake / Yahoo 統合仕様・クロック同期・生成データ | `src/services/`, `src/utils/clock.ts`, `src/utils/fetchJson.ts` |
| [settings-pwa-spec.md](settings-pwa-spec.md) | 設定タブ・localStorage・PWA・実地震テスト | `src/components/SettingsTab/`, `src/hooks/useSettings.ts`, `vite.config.ts` |
| [action-checklist-spec.md](action-checklist-spec.md) | 行動チェックリスト（出す条件・登録地点の周り・畳む挙動） | `src/hooks/useActionChecklist.ts`, `src/utils/actionChecklistTrigger.ts` |
| [kyoshin-detection-spec.md](kyoshin-detection-spec.md) | 強震モニタ揺れ検知エンジン（詳細仕様） | `src/utils/kyoshinDetector.ts` |
| [kyoshin-detection-v3-design.md](kyoshin-detection-v3-design.md) | 強震モニタ検知の設計判断・調査・改訂履歴 | 同上（経緯資料） |
| [kyoshin-detection-design.md](kyoshin-detection-design.md) | 強震モニタ検知の旧設計書（歴史資料・V3 に置換済み） | 同上 |

## 推奨読了順（初めて触る開発者向け）

上の一覧はアルファベット順ではなく、以下の推奨順に並べている:

1. **[architecture-spec.md](architecture-spec.md)** — 全体像・バリアント切替・データフローの俯瞰
2. **[data-sources-spec.md](data-sources-spec.md)** — DMDATA / P2PQuake / Yahoo の電文コード・エンドポイント（後続の spec で参照される用語の予備知識）
3. **[eew-spec.md](eew-spec.md) / [tsunami-spec.md](tsunami-spec.md) / [quake-spec.md](quake-spec.md)** — 主要 3 機能。触りたい機能から読む
4. **[map-rendering-spec.md](map-rendering-spec.md)** — 地図描画のレイヤー構成・描画順（上記 3 機能の描画側を触るなら必読）
5. **[audio-tts-spec.md](audio-tts-spec.md) / [settings-pwa-spec.md](settings-pwa-spec.md)** — 音・通知・設定 UI
6. **[kyoshin-detection-spec.md](kyoshin-detection-spec.md)** — 強震モニタ検知エンジン（他機能と独立性が高いので後回しでよい）
7. **[action-checklist-spec.md](action-checklist-spec.md)** — 行動チェックリスト（上の 3 機能の出力を受けて出し分けるだけなので、読む順の依存は薄い）

## 仕様書の書き方（新規追加時）

1. **冒頭に位置づけを書く**: 何のための文書か・実コードとの関係性を明示
2. **章立ての順序**: 概要 → データフロー → 入力/出力 → 主要処理 → パラメータ → エッジケース → 改訂履歴
3. **実装との対応**: 各節の末尾か表内に「対応ファイル・関数名・行番号」を書く（行番号はドリフトしやすいので参考程度、関数名を主）
4. **図**: Mermaid か ASCII 図を優先。画像は最終手段
5. **技術用語**: 読者は「開発者だが該当機能を初めて触る人」を想定。過度な略語は避け、初出で説明

## 仕様書更新のルール

CLAUDE.md「変更時の基本フロー」で規定されている通り、以下は**同一コミットで更新する**:

- コードの挙動を変えた場合 → 該当機能の仕様書
- 新機能を追加した場合 → 新規仕様書追加または既存仕様書への節追加
- 設定・データソース・依存関係が変わった場合 → 関連する複数の仕様書

更新後は「客観レビュー」（技術的すぎないか・初見の読み手に伝わるか）を行う。詳細は CLAUDE.md 参照。
