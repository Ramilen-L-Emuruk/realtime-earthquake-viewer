# 津波情報仕様書

> 本書は**現在の実装が津波情報をどう処理するか**をまとめた仕様書。実コードと食い違う場合は実コードを正とする。
> 関連: [`data-sources-spec.md`](data-sources-spec.md) の津波電文受信、[`audio-tts-spec.md`](audio-tts-spec.md) の津波音・読み上げ。

## 1. 概要

大津波警報・津波警報・津波注意報・津波予報を受信・表示するモジュール群。以下を扱う:

- 電文パース（DMDATA JSON / XML、P2PQuake JSON）
- 区域別の警報等級の統合
- 観測情報（津波観測点の波高・到達時刻）のマージ
- 解除・取消・期限切れの 3 経路の出し分け（DMDSS 版のみ完全対応）
- 海岸線描画（対象海域を色分け）
- カード表示（区域グループ・観測情報）

## 2. データフロー

```
[電文]
  DMDATA WS / REST (VTSE41/51/52) ──┐
  P2PQuake WS (code=552)  ───────────┴── parseTsunami / parseTsunamiFromXml
                                                   ↓
                                            JMATsunami 型
                                                   ↓
                                    useEarthquakes.ts の handleEvent（tsunami ケース）
                                                   ↓
                                          state.tsunamis: JMATsunami[]（実質 1 件スロット）
                                                   ↓
                        ┌────────────┴────────────┐
                        ↓                          ↓
              useTsunamiLayerData          TsunamiTab
              （海岸線・観測バー）        （カード表示）
                        ↓
              TsunamiLinesGL / TsunamiObsBarsGL
```

## 3. 3 経路の解除フロー

津波が消える経路は 3 種類ある。`JMATsunami.cancelReason` で区別する（型: `'lifted' | 'retracted' | 'expired'`）。
**3 経路とも同じ流れを通る**: `cancelledAt` セット → 10 秒間の解除表示 → `purge-cancelled-tsunami` で消去。

| cancelReason | 電文条件 | 検出箇所 | 表示文言 |
|---|---|---|---|
| `lifted`（解除） | `InfoType === '発表'` かつ区域が消える | `dmdataParser.ts` の `areas.length === 0` フォールバック | 「解除されました」 |
| `retracted`（取消） | `InfoType === '取消'` | `dmdataParser.ts` の InfoType 判定 | 「取り消されました」 |
| `expired`（期限切れ） | `validDateTime` の満了 | `useEarthquakes.ts` がタイマー予約 | 「有効期間終了」 |

**表示文言の単一情報源**: `src/components/TsunamiTab/index.tsx` の `CANCEL_REASON_LABEL`（3 経路 + undefined フォールバック）。
新しい cancelReason を追加する場合はここと型定義（`src/types/earthquake.ts`）を同時に更新する。

### バリアント差

- **DMDSS 版**: 3 経路すべて出し分け可能（DMDATA 電文が `InfoType` と `ValidDateTime` を持つため）
- **standard 版**: P2PQuake API v2 スキーマに `InfoType`・`ValidDateTime` に相当するフィールドが**無い**ため、
  `cancelReason` は常に `undefined`。`CANCEL_REASON_LABEL` のフォールバックで常に「解除」表示になる

**`validDateTime` が付く条件**（気象庁仕様）: 「津波予報（若干の海面変動）のみ発表の場合」または
「警報・注意報解除後に予報のみが残る場合」の 2 パターンのみ。警報・注意報が 1 区域でも残っている間は付与されない。

## 4. 電文パース

### DMDATA JSON（`parseTsunami`）
- `src/services/dmdataParser.ts` の `parseTsunami` 関数
- `tsunami.forecasts` から区域別の等級・波高・到達時刻を抽出
- `tsunami.observations` から観測情報を抽出
- 未知の Kind/Code は `Unknown` → 除外される（現状は既知コードが固定のため実害は限定的）

### DMDATA XML 履歴（`parseTsunamiFromXml`）
- 同上ファイルの XML パーサ側
- REST 履歴取得時に使用

### P2PQuake（`convertEvent`）
- `src/services/p2pquake.ts` の code=552 分岐
- `JMATsunami` 型に変換（`InfoType` / `ValidDateTime` は付与されない）
- 津波の等級（`areas[].grade`）は英語のまま（`MajorWarning` / `Warning` / `Watch` / `Forecast`）で内部型に流れ、`useLiveEventHandler.ts` 等の分岐で直接 `grade === 'MajorWarning'` として判定される（`DOMESTIC_TSUNAMI_MAP` は地震情報 code=551 の `earthquake.domesticTsunami` 用で、津波の等級には使われない）

## 5. 状態管理（`useEarthquakes.ts` の tsunami ケース）

- `state.tsunamis: JMATsunami[]` は**実質 1 件スロット**（別 eventId の津波が来ると無警告で置換）
- 新規・非キャンセル: `sameEvent` なら更新、そうでなければ配列を丸ごと置換
- キャンセル（3 経路のいずれか）: `cancelledAt: now` と `cancelReason` をセット、10 秒後に purge をキューイング
- 期限切れ検出: 電文受信時に `validDateTime` を見て、未来なら expired キャンセルを予約

**既知の課題**:
- expired 予約が同一 eventId の後続更新で取り消されず、10 秒表示が早期打ち切りされる可能性
- `purge-cancelled-tsunami` アクションが識別子を持たないため、連続キャンセルのレースで前の解除表示が
  早期消去される可能性

## 6. 観測情報のマージ（`mergeTsunamiObservations`）

`src/utils/tsunami.ts` の関数。津波観測点の連続電文で、同一観測点の観測値を最新に更新する。

- キーは `${o.districtCode ?? o.districtName ?? ''}|${o.name}`（区域コード or 区域名 と観測点名を `|` で連結。同じ区域内の複数観測点を区別するため）
- 同一キーで既存があれば更新、なければ追加
- `over` フラグ（既定波高を超えたかどうか）は JSON 経路のみ設定される（XML 経路では常に undefined）

## 7. 区域と海岸線

- 電文の区域コード（`areas[].code`）に対応する海岸線ライン座標を `public/data/tsunami-zones.json` から引く
- ソースは気象庁 予報区等 GIS データ（`Ichihai1415/JMA-GIS-GeoJSON`）
- 生成スクリプト: `scripts/build-tsunami-zones.mjs`

### 描画（`TsunamiLinesGL`）

- 等級ごとの色・線幅は `src/utils/tsunamiStyle.ts` で定義
- 大津波警報（紫）・警報（赤）・注意報（橙）・予報（シアン）で色分け
- 点滅アニメーション: `requestAnimationFrame` で `line-opacity` を周期変化
- MapLibre の paint プロパティは既定で 300ms トランジションが付くため、`line-opacity-transition:
  { duration: 0 }` を明示的に設定して点滅の途切れを防ぐ

## 8. 観測点バー（`TsunamiObsBarsGL`）

- 各津波観測点に「実測波高を高さで表した棒」を地図上に立てる
- 高さは値の対数変換で見やすくスケーリング
- 更新は電文受信のたびに setData で全置換

## 9. カード表示（`TsunamiTab`）

以下の順序で表示:
1. 見出し（大津波警報・警報・注意報・予報のいずれか）
2. 区域リスト（同一階級内で予想波高が同じ区域はグルーピング）
3. 観測情報（区域コードが一致する観測点は該当区域の直下に、それ以外は別カードにフォールバック）
4. キャンセル時は `cancelReason` に応じた見出しに切り替え（10 秒間）

## 10. 音・通知・読み上げの連動

`useLiveEventHandler.ts` の tsunami 分岐で発火する。

| 状態 | 音種別 | 通知 | 読み上げ |
|---|---|---|---|
| 大津波警報の新規発表 | `tsunamiMajor` | あり | あり |
| 津波警報の新規発表 | `tsunami` | あり | あり |
| 津波注意報の新規発表 | `tsunamiWatch` | あり | あり |
| 津波予報の新規発表 | `tsunamiForecast` | あり | あり |
| 続報（レベル変化なし） | 抑制（読み上げのみ） | 抑制 | あり |
| 解除・取消・期限切れ | **無音**（既知の課題） | 抑制 | あり |

**既知の課題**: 津波の解除/取消/期限切れで通知音が鳴らない（`useLiveEventHandler.ts:163-176` に
`playAlertSound` 呼び出しが無い）。地震取消・EEW 取消は音があるのに津波だけ非対称。

## 11. 自動タブ切替

新規 tsunami イベント（`!event.cancelled`）で `setActiveTabNonRealtime('tsunami')` を呼ぶ。
同時に `realtimeTabSuppressedUntilRef = Date.now() + 15000` をセットして、以後 15 秒は
EEW 続報での realtime タブへの自動切替を抑制する。

**既知の課題**: 津波の観測点更新電文が連続する状況では、続報判定なしでこの抑制が繰り返し
リセットされるため、EEW 発報中でも realtime タブに戻れなくなる可能性（HIGH 課題）。

## 12. 関連実装ファイル

- `src/services/dmdataParser.ts` — DMDATA JSON/XML パース（tsunami 分岐）
- `src/services/p2pquake.ts` — P2PQuake 経路の convertEvent
- `src/utils/tsunami.ts` — 等級算出・観測情報マージ
- `src/utils/tsunamiStyle.ts` — 等級ごとの色・線幅定義
- `src/hooks/useEarthquakes.ts` — 状態管理（tsunami ケース）
- `src/hooks/useTsunamiLayerData.ts` — 描画データ生成
- `src/components/TsunamiTab/index.tsx` — カード表示・`CANCEL_REASON_LABEL`
- `src/components/Map/TsunamiLinesGL.tsx` — 海岸線描画
- `src/components/Map/TsunamiObsBarsGL.tsx` — 観測バー描画

## 13. テスト

- `dmdataParser.test.ts` は現状 VXSE51/53（地震 XML）のみカバー
- `parseTsunami` / `parseTsunamiFromXml` / `mergeTsunamiObservations` の単体テストは無し（HIGH 課題）

## 14. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成。既存の CLAUDE.md から津波関連の記述を集約
