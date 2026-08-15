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
| 遠地地震 | VXSE53（電文標題が「遠地地震に関する情報」） | Foreign | 国外の地震。国内で震度を観測しないため観測点・区域震度なし |
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

**QUAKE-6 の既知の制約（P2PQuake API 仕様上）**: 実データ検証（`api.p2pquake.net/v2/history?codes=551`）で確認
した通り、P2PQuake API は**観測点電文（DetailScale）と区域速報電文（ScalePrompt）を別々に送信**する仕様に
なっており、両者を 1 電文で束ねる仕組みがない。よって標準版では:
- **DetailScale**（詳細な震度情報・観測点別）: `points[].isArea: false` のみ（区域なし）
- **ScalePrompt**（震度速報・区域別）: `points[].isArea: true` のみ（観測点なし）

いずれも `pref` は非空で届く（P2PQuake の JSON 構造上の仕様）。`EarthquakeCard` は「pref 非空を都道府県
ロールアップ点として扱う」設計なので、DetailScale 時に「都道府県別最大震度」だけが表示され、DMDSS 版のように
「県内の一次細分区域ごとに震度が割れている場合の内訳」は原理的に出せない（区域粒度データが電文に含まれていない）。
これはバグではなく **P2PQuake API 仕様と DMDATA との情報粒度差**。区域粒度を必要な用途では DMDSS 版を使う。

**識別規則**（**DMDSS 経路限定**）: DMDATA JSON / XML 経路の points について `pref` の有無で
「点の役割」を識別する。P2PQuake 経路は上記の通り常に `pref` 非空で届くため、この規則の対象外。
- 区域は必ず `pref: ''` で積む（`isArea: true`）
- 観測点も `pref: ''` で積む（`isArea: false`）。DMDSS の JSON 経路と XML 経路の両方で統一（QUAKE-2）
- JSON 経路のみ、`prefectures[]` 由来の**都道府県ロールアップ点**を `pref: '<都道府県名>', isArea: false` で追加する

**QUAKE-2 の対応（2026-08-13）**: 以前は XML 経路（`parseEarthquakeFromXml`）が観測点に `pref: prefName` を
積んでおり JSON 経路と非対称だった。`EarthquakeCard.prefGroups` は「pref 非空＝都道府県ロールアップ点」
前提で処理するため、XML 経路のみ「観測点値」を都道府県別最大震度と誤解して区域最大震度を上書きしていた。
現在は XML 側も `pref: ''` に統一済み。

**pref 逆引きが必要な派生データ**: `pref` が空でも `station-coords.json` の逆引き（`buildAreaPrefIndex` /
`buildStationPrefIndex`）で都道府県は復元可能。以下の派生データは pref が空でも都道府県を再構築する:
- `useQuakeLayerData.intensityMarkers` — 地図に置く観測点マーカーの色・位置
- `useQuakeLayerData.prefIntensities` — 震源ポップアップの都道府県別最大震度
- `ttsText.regionNamesForScale` — 読み上げの都道府県名フォールバック

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

## 7. 地図描画の切替（区域集約と観測点表示）

`useQuakeLayerData` の `stationMarkers` と `intensityMarkers`:

- `stationMarkers`（`isArea:false` のみ）: `QuakeIntensityPointsGL` の入力。観測点ごとの震度ドット
- `intensityMarkers`（全点）: カメラフィットのフォールバック専用（描画には使わない）

### 7.1 ズームによる集約の切替

区域データ（`subregions.json`）が読めていることが前提。読めていない場合は §7.2 が優先し、
以下の条件に関わらず観測点個別表示になる。

- ズームが `QUAKE_MAX_ZOOM`（= 7）以下 → 区域集約表示
- ズームが超 7 → 観測点個別表示
- **観測点が 0 件の電文（震度速報等）** → ズームに関わらず区域集約を維持
  （拡大しても増える情報が無いうえ、区域重心をドットにすると「その地点の観測値」に見えてしまうため）

判定は `useQuakeLayerData.aggregateByRegion` の OR 条件。LPGM 表示中が対象外になるのは
**3 番目（観測点 0 件による維持）だけ**で、ズームによる切替と §7.2 のフォールバックは LPGM にも
同じように効く（3 番目だけを外すのは、選択中の quake と表示中の LPGM が別イベントのことがあるため）。

### 7.2 区域データ取得失敗時のフォールバック

取得失敗が確定すると、ズーム・観測点数に関わらず観測点個別表示へ切り替える（§7.1 の
どの条件よりも優先する）。塗る区域ポリゴンが 1 件も作れないうえ、区域塗りと観測点ドットは
排他で切り替わるため、集約を維持したままだと地図から震度が消えてしまうため。

**限界**: このフォールバックは観測点ドットで震度を描くものなので、観測点を持たない電文
（震度速報）には代替表示が無い。震度速報は震源も未確定（§5）で震源マーカーすら出ないため、
**地図は空白になる**（震度は一覧カードにのみ出る）。緊急地震速報の予想震度も区域単位でしか
表現できないため同様に地図へ出ない。

**復帰**: 区域データは震度・EEW の予想震度・ベースマップの境界線・区域名ラベルがそれぞれ
要求し、失敗しても次の要求で再取得される。震度側の要求は地図の初期化前、ベースマップ側は
初期化後に走るため、震度側が先に失敗してもベースマップ側の再取得が成功すれば区域集約に戻る
（EEW の予想震度塗りも同じ仕組みで復帰する）。

**残存リスク**: 上記は「取得が失敗として確定する」ことが前提。通信がハングして応答も
エラーも返らない場合は読み込み中の扱いのまま留まり、フォールバックもログ出力も発生しない。
これは生成データ全般に共通する制約（[`map-rendering-spec.md`](map-rendering-spec.md) §4）。

失敗時の `console` 出力は、震度側が `error`（「観測点ドットで代替」の旨）で 1 度だけ。
ベースマップの境界線・区域名ラベル側の警告は
[`map-rendering-spec.md`](map-rendering-spec.md) §4・§5 を参照。

`QUAKE_MAX_ZOOM` は自動フィットの寄り上限（`gl/camera.ts` の `MAX_ZOOM`）から導出した同値。
自動フィットの着地点が常にこの閾値以下＝必ず区域集約になる、という前提に描画側が依存しているため、
値を独自に持たせてはならない（ズーム値の基準は [map-rendering-spec.md](map-rendering-spec.md) §6 参照）。

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
