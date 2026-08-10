# 地震情報仕様書

> 本書は**現在の実装が地震情報をどう処理するか**をまとめた仕様書。実コードと食い違う場合は実コードを正とする。
> 関連: [`data-sources-spec.md`](data-sources-spec.md) の電文受信、[`map-rendering-spec.md`](map-rendering-spec.md) の地図描画。

## 1. 概要

地震情報（震度速報・震源情報・各地の震度）を受信・表示するモジュール群。以下を扱う:

- 電文パース（DMDATA JSON / XML、P2PQuake JSON）
- 同一 eventId の続報統合（速報 → 詳細報の順で情報を上書き）
- 地図の表示: 観測点別震度ドット・区域別震度塗り・震源マーカー
- ズームレベルによる集約表示切替（詳細 ↔ 区域）
- 訂正・取消の表示

### 用語: 「一次細分区域」

気象庁が定める地震情報用の地域区分単位。都道府県より細かく、市区町村より粗い（1 都道府県あたり数個〜十数個。全国で約 380 区域）。震度速報・各地の震度で「宮城県南部」「岩手県沿岸北部」のように区域名で震度が発表される。境界データは `public/data/subregions.json`、区域名↔観測点の紐付けは `public/data/station-coords.json` の `areas` で管理する。本仕様書と関連仕様書（[`map-rendering-spec.md`](map-rendering-spec.md) 等）では単に「区域」と略すことがある。

## 2. データフロー

```
[電文]
  DMDATA WS/REST (VXSE51/52/53/61) ──┐
  P2PQuake WS (code=551)  ────────────┴── parseIntensityPoints / parseEarthquakeFromXml / convertEvent
                                                    ↓
                                              JMAQuake 型
                                                    ↓
                                        useEarthquakes.ts handleEvent
                                                    ↓
                                     quakeMerge.mergeQuakeInto（同一 eventId 統合）
                                                    ↓
                                          state.earthquakes: JMAQuake[]
                                                    ↓
                          ┌─────────────────────────┴──────────────────────┐
                          ↓                                                 ↓
                   useQuakeLayerData                                EarthquakeTab
                （観測点点・区域塗り・震源）                        （カード一覧）
                          ↓
              QuakeIntensityPointsGL / QuakeRegionFillGL / EpicenterGL
```

## 3. 電文種別

| 種別 | DMDATA | P2PQuake | 内容 |
|---|---|---|---|
| 震度速報 | VXSE51 | ScalePrompt | 震源未確定・区域別震度のみ |
| 震源情報 | VXSE52 | Destination | 震源のみ・震度なし |
| 各地の震度 | VXSE53 | ScaleAndDestination（DetailScale） | 震源＋観測点・区域震度 |
| 訂正 | VXSE61 | — | 顕著な地震の震源要素更新 |
| 取消 | — | — | 誤発表の取消 |

## 4. points 構造（バリアント・経路差）

`JMAQuake.points` には観測点（`isArea:false`）と一次細分区域（`isArea:true`）が混在しうる。
**区域の点は区域内観測点の重心**（`station-coords.json` の `areas`）であって観測値の位置ではないため、
**ドット描画には使わない**。

| 経路 | 震度速報 | 詳細報 |
|---|---|---|
| DMDSS: WebSocket JSON（`parseIntensityPoints`） | 区域のみ | **区域＋観測点** |
| DMDSS: REST XML（`parseEarthquakeFromXml`） | 区域のみ | 区域＋観測点 |
| 標準版: P2PQuake | 区域のみ（ScalePrompt） | **観測点のみ**（DetailScale は区域を落とす） |

**識別規則**: `pref` の有無で「都道府県の点」と「区域の点」を識別する。
- 区域は必ず `pref: ''` で積む
- 観測点は `pref: '<都道府県名>'` で積む

**既知の非対称（MEDIUM）**: XML 経路（`parseEarthquakeFromXml`）は観測点に `pref: prefName` を積んでおり、
JSON 経路（`pref: ''`）と非対称。`EarthquakeCard` の `prefGroups` は「pref 非空＝都道府県ロールアップ点」
「pref 空＝一次細分区域点」の 2 経路を明確に分けて処理するため、値の誤りは起きない。ただし XML 経路では
区域点にも `pref` が付くと想定した場合、区域単位の内訳表示（isWholePref による「県内で震度が割れているとき
個別表示、揃っていれば県単位にまとめる」ロジック）が使われず、県単位に丸まる可能性がある。実データで
症状が発生するかは未検証のため MEDIUM 相当。

## 5. 震源未確定（震度速報）の扱い

- VXSE51（震度速報）は震源が未確定のため `Earthquake` 要素・`body.earthquake` を**持たない**
- 座標は `-200`（位置不明センチネル）、発生時刻は `TargetDateTime`（JSON は `data.targetDateTime`）を使う
- 両パーサとも震源なしを許容する分岐がある
- 表示側は `EarthquakeCard.hasLocation`（lat > -200）で震源系の表示を切り分ける

## 6. 続報マージ（`quakeMerge.mergeQuakeInto`）

同一 eventId（14 桁数字）の電文が来た場合、時刻順で 1 枚のカードに統合する。

- 同一判定は `extractQuakeEventId(quake)` で正規表現 `\d{14}` を抽出
- 速報 → 詳細報の順で情報が積み重なる（震度速報の後に詳細報が来れば震源・観測点情報が追加される）
- VXSE61（震源要素更新）は既存カードの震源情報のみを更新
- 取消は既存カードを削除

**訂正の扱い**:
- XML パーサ（`parseEarthquakeFromXml`）は `InfoType === '訂正'` を判定して `correct: '訂正'` を設定
- **JSON パーサ（`parseEarthquake`）は現状 `correct: 'なし'` 固定で訂正フラグを握り潰す**（HIGH 課題）
- P2PQuake 経路（`convertEvent`）は `CORRECT_TYPE_MAP` で日本語化

## 7. 地図描画の切替（ズームによる集約）

`useQuakeLayerData` の `stationMarkers` と `intensityMarkers`:

- `stationMarkers`（`isArea:false` のみ）: `QuakeIntensityPointsGL` の入力。観測点ごとの震度ドット
- `intensityMarkers`（全点）: カメラフィットのフォールバック専用（描画には使わない）

**集約の切替条件**:
- ズームが `QUAKE_MAX_ZOOM`（= 8）以下 → 区域集約表示
- ズームが超 8 → 観測点個別表示
- **観測点が 0 件の電文（震度速報等）** → ズームに関わらず区域集約を維持
  （拡大しても増える情報が無いうえ、区域重心をドットにすると「その地点の観測値」に見えてしまうため）

判定は `useQuakeLayerData.aggregateByRegion` の OR 条件。LPGM 表示中は同関数を共用しているため
アグリゲート対象外（選択中の quake と表示中の LPGM は別イベントのことがあるため）。

## 8. カード表示（`EarthquakeCard`）

主な要素:
- 見出し: 「震度速報」「震源に関する情報」「各地の震度に関する情報」等
- 震源情報: 座標・深さ・マグニチュード（震源確定時のみ）
- 最大震度・津波の見通し
- `prefGroups`: 都道府県ごとに集約した震度リスト
- 訂正バッジ（`correct !== 'なし'` のとき）

**`prefGroups` の集約規則**（`src/components/EarthquakeTab/EarthquakeCard.tsx` の `prefGroups`）:
- ここでの「集約」は `§7 地図描画のズーム集約`（一次細分区域単位）とは別軸で、**カード表示専用に都道府県単位で集約**する処理
- 「pref 非空＝都道府県ロールアップ点」「pref 空＝一次細分区域点」の 2 経路に分けて処理
- 都道府県内で震度が割れているケースは区域単位で個別表示
- 全区域が同一震度の場合は都道府県単位でまとめて表示

**既知の課題**（QUAKE-4）: `EarthquakeTab` の `key={quake.id}` が続報のたびに変わり、
`EarthquakeCard` がリマウントする。`isSelected` の副作用（scrollIntoView）が毎回発火して
ユーザーの手動スクロールを妨害する。`key={extractQuakeEventId(quake) ?? quake.id}` にすべき
（ただし standard 版の id は `dmdata-...` パターンに一致しないためフォールバックで同じ挙動になる点は要注意）。

## 9. 地図レイヤー

### QuakeIntensityPointsGL（観測点ドット）
- 各観測点を「震度ラベル付きの丸バッジ」として描画
- ラベルは Canvas2D で事前ラスタライズした icon-image を map.addImage で登録
- ホバーで観測点名と震度、クリックで所属区域と震源距離まで表示

### QuakeRegionFillGL（区域塗り）
- 一次細分区域ごとの最大震度で塗り分け（fill+line）
- 区域中心に震度バッジ（icon-image・symbol レイヤー）
- 2026-08-10 のコミット 55dcc42 で HTML Marker から icon-image に移行済み

### EpicenterGL（震源マーカー）
- ×印 + ポップアップ
- HTML `maplibregl.Marker` で実装（座標に紐づく DOM 要素）

## 10. 状態管理

- `state.earthquakes: JMAQuake[]` — 過去の地震カード一覧（最新順・件数上限あり）
- `state.lpgmByEventId: Map<eventId, LpgmData>` — 長周期地震動階級（DMDATA 版のみ）
- `quakeIntensityCacheRef` — 震度速報時の観測点データを保持し、後続の詳細報で補完する用途

## 11. 関連実装ファイル

- `src/services/dmdataParser.ts` — DMDATA JSON/XML パース
- `src/services/p2pquake.ts` — P2PQuake の convertEvent（quake ケース）
- `src/utils/quakeMerge.ts` — 続報マージ
- `src/utils/quakeMerge.test.ts` — テスト
- `src/hooks/useEarthquakes.ts` — 状態管理
- `src/hooks/useQuakeLayerData.ts` — 描画データ生成・区域集約
- `src/components/EarthquakeTab/index.tsx` — カード一覧
- `src/components/EarthquakeTab/EarthquakeCard.tsx` — カード表示
- `src/components/Map/QuakeIntensityPointsGL.tsx` — 観測点ドット
- `src/components/Map/QuakeRegionFillGL.tsx` — 区域塗り＋区域バッジ
- `src/components/Map/EpicenterGL.tsx` — 震源マーカー

## 12. テストカバレッジ

- `quakeMerge.test.ts`: 続報マージのケースをカバー
- `dmdataParser.test.ts`: XML の VXSE51/53 のみカバー（JSON パーサは無テスト・HIGH 課題）

## 13. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
