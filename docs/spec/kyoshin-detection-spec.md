# 強震モニタ揺れ検知 仕様書（V3・現状版）

> 本書は**現在の実装が何をどう処理するか**をまとめた仕様書。設計判断の経緯・調査過程・検証履歴は
> `kyoshin-detection-v3-design.md`（設計書）を参照。パラメータ値・処理内容に食い違いがある場合は
> 実コード（`src/utils/kyoshinDetector.ts`）を正とする。

## 1. 概要

Yahoo!天気・災害「リアルタイム震度」（防災科研 強震モニタ由来、約1725観測点・1秒更新）から、震源情報を
使わずに「今どこかで地震が揺れているか」をリアルタイムに検知するエンジン。震源非依存（source-free）の
面判定方式で、JMA EEW の PLUM 法（近傍観測点の実測震度で判定）に理論的裏付けを持つ。

検知結果は以下を駆動する:
- 検知カード表示（`RealtimeTab`）
- 地図上の観測点ドット表示（震度1以上・震度0以下で別レイヤー）
- 通知音・ブラウザ通知・ウィンドウタイトル・自動タブ切替
- 地図の自動フィット（検知メンバー観測点のフットプリントへ）

## 2. データフロー

```
Yahoo RealTimeData (1Hz JSON)
  └─ src/services/kyoshin.ts: fetchRealtimeIntensity() / fetchSiteList()
       └─ src/hooks/useKyoshinRealtime.ts: ポーリング → sites, indices, dataTime
            └─ src/hooks/useKyoshinDetectorV2.ts: step() を毎フレーム呼ぶ Reactラッパー
                 │    (localStorage 'kyoshin-v3-learned' から学習資産を復元・定期保存)
                 └─ src/utils/kyoshinDetector.ts: step(state, frame, meta) ← 検知コア本体
                      └─ DetectionEvent[] (confidence, memberKeys, maxIntensity, epicenter, ...)
                           ├─ src/utils/kyoshinDetectionView.ts: deriveKyoshinView()
                           │    → confirmed/candidate フラグ、地図フィット用の点列、confirmedShocks
                           │         ├─ src/hooks/useKyoshinAlerts.ts: タブ切替・音・通知・地域単位発報
                           │         └─ 地図レイヤー（KyoshinDetectedPointsGL 等）
                           └─ src/utils/kyoshinSubThresholdFilter.ts: chronicNoiseFloor を使った
                                震度0ドット表示（KyoshinSubThresholdGL）専用フィルタ
```

検知コア（`kyoshinDetector.ts`）は React・DOM・現在時刻に依存しない純粋関数として実装されている
（`step(state, frame, meta)` → `{ state, detections, triggers }`）。時刻はすべて `frame.dataTimeMs`
から供給されるため、決定的でユニットテスト・オフラインリプレイの両方が可能。

## 3. 入力データ

| 項目 | 内容 |
|---|---|
| 観測点座標 | `SiteList/sitelist_{siteConfigId}.json`。約1725点（2026年版 `siteConfigId=20260123000000`）。年により点数・配列順が変わる |
| リアルタイム震度 | `RealTimeData/yyyyMMdd/yyyyMMddHHmmss.json`。`intensity` 文字列（1文字＝1観測点、`charCodeAt(0)-100` が index 0〜20） |
| 計測震度への変換 | `indexToValue(index) = -3.0 + index * 0.5`（0.5刻み量子化。index 6 = 震度0 = value 0.0） |
| エッジ | west/east の2エッジ。west を優先し失敗時 east にフォールバック |

観測点集合（`siteConfigId`）は年単位で変わるため、検知コアは座標キー `siteKey(lat,lng)`（小数第3位＝
約100mで丸め）で観測点を管理する。近傍グラフ・格子割当は起動時（または観測点集合が変わったとき）に
実行時の座標から都度計算し、事前生成データは持たない（版差によるキーずれを構造的に避けるため）。

これは検知コアのメタデータキャッシュを版差から守るための対策で、これとは別のレイヤーに
「1 フレーム内の `sites[i]` と `indices[i]` の位置対応ずれ」を防ぐガードがある（切替直後の
数フレームで `sites` と `indices` の siteConfigId が食い違う一時状態を検知して step() をスキップ）。
詳細は [`data-sources-spec.md`](data-sources-spec.md) §4 参照。

## 4. 検知パイプライン

`step()` は毎フレーム、以下の順で処理する。

### L0 静的メタ（`buildStationMeta`）

観測点座標配列から次を計算する（観測点集合が変わらない限りキャッシュ）:
- `neighbors[key]`: 各点の K 近傍（`R_KM` 以内で近い順に `K` 点）
- `avail[key]`: `R_KM` 以内に実在する近傍数（疎地域救済の分母に使う）
- `cellOf[key]`: 各点が属する固定格子セル（`CELL_DEG` 度の等間隔ビン）

### L1 点トリガー（観測点ごと）

各観測点について、点別のノイズ床（`floorMean`・`floorDev` の長時定数 EWMA）と現在値を比較する。

- **実効床** `effectiveFloor = clamp(floorMean + FLOOR_SIGMA_K・floorDev, FLOOR_MIN, FLOOR_CAP)`
- **levelActive**: `value ≥ effFloor + LEVEL_MARGIN`（かつ `value ≥ TRIG_FLOOR`）。「平常を超えたか」
- **sustained**: `value ≥ effFloor + SUSTAIN_MARGIN`。「明確に揺れ続けているか」（継続点数・保持に使用。
  `LEVEL_MARGIN=0` だと平常の震度0も levelActive になるため、継続判定は一段高い床で行う）
- **rate**: 直近 `RATE_DT_MS` 窓での value 上昇量（1フレーム差でなく窓で見て欠測・ジッタを吸収）
- **onset（トリガー成立）**: `levelActive && rate ≥ RATE_MIN`

床の学習（EWMA更新）は「揺れていない静穏点」だけで行う。以下のいずれかに該当する点は学習をスキップ
（凍結）する:
1. 現フレームで `levelActive` な点（揺れている最中）
2. 現フレームで近傍同時性（後述 L2）を満たした確定揺れ点
3. **`triggeredAtMs`（最後に onset した時刻）から `FLOOR_FREEZE_MS` 未満しか経過していない点**
   （揺れの残響を静穏点のノイズとして誤学習しないための猶予期間。単発の onset なら1と2でほぼ
   カバーされるが、群発地震で本震・大きめの余震の減衰過程が続く場合に重要。詳細は設計書§18）

### L2 近傍同時性（同期 onset の空間的広がり）

震源に依存しない面判定の核心部分。

1. 直近 `COINCIDENCE_MS` 以内に onset した観測点を集める（`recentOnset`）
2. `recentOnset` を K 近傍グラフ（`neighbors`）で連結成分に分解する
3. 成分サイズが `MIN_CLUSTER` 以上の成分だけを「確定揺れ点（confirmed-shaking）」とする

散在する単発ノイズは近傍が揃わず成分が育たないため脱落する。時間差で onset した観測点（初期微動→
主要動など）も同一成分として束ねられる。

### L3 グループ化・イベント帰属

- 各連結成分（クラスタ）を既存の `DetectionEvent` に帰属させる。判定は「メンバー重複率 `MERGE_MEMBER_FRAC`
  以上」または「格子セルの共有」のいずれか。該当が無ければ新規イベントを生成する
- イベントの指標（`lastSize`・`maxIntensity`・`epicenter`）を `updateEventMetrics` で再計算する
  - `lastSize`: 現在「揺れているメンバー数」＝ sustained なメンバー、または直近 `TRIG_ACTIVE_MS` 以内に
    onset したメンバー
  - `maxIntensity`: levelActive なメンバーの現在 value の最大（震度0も含む＝ faint 判定用）
  - `epicenter`: levelActive なメンバー座標の重心（**表示専用・震源推定ではない**。検知判定・自動フィット
    には使わない）
- フレーム末に `mergeAdjacentEvents` で、重心が `MERGE_EVENT_KM` 以内のイベントを1本化する（沖合・深発の
  揺れ域が海/山ギャップで近傍グラフ上は複数成分に割れても、同一地震として統合する）
- セル別慢性活性 `cellActivity`（後述 L4 特異度第2軸）を長時定数で更新する

### L4 確信度分類・保持

各イベントの `confidence` を次の優先順位で決める（`Confidence = 'confirmed' | 'likely' | 'faint' | 'weak'`）:

1. **confirmed 判定**: 次の (a) (b) のいずれかが `confirmFramesReq` 連続で成立したら `everConfirmed=true` の
   ラッチが立つ。一度立つと `HOLD_MS` の間は（揺れが弱まっても）`confirmed` を維持する（明滅防止）
   - **(a) 通常経路**: `lastSize ≥ effectiveConfirmReq` かつ `maxIntensity ≥ confirmIntensityReq` かつ
     `intenseCount ≥ CONFIRM_INTENSE_POINTS`
   - **(b) 高震度 fast path（設計書§20）**: `HIGH_CONFIRM_INTENSITY`（震度3）以上に達した levelActive メンバーが
     `HIGH_CONFIRM_POINTS` 点以上。点数ゲート（`effectiveConfirmReq`・慢性活性セルの引き上げ幅を含む）を
     免除する。`confirmFramesReq` の連続要求は (a) (b) 共通で免除しない（単フレームの跳ね値を弾く安全弁）
   - `effectiveConfirmReq` は密度正規化済み: `max(MIN_LIKELY_POINTS, min(confirmPointsBase(+慢性活性なら
     CHRONIC_POINT_BUMP), ceil((局所実在近傍数+1) × CONFIRM_DENSITY_FRAC)))`。疎地域（離島等）は
     点数要件を自動的に下げる
   - `confirmPointsBase`・`confirmFramesReq` は `frame.eewActive`（呼び出し側が「震源要素が確定した
     （単独点処理=仮定震源要素でない）EEW が発表中か」を渡す。severity は推定震度の大小を示す軸に
     過ぎず判定に使わない）が true の間、`CONFIRM_POINTS`/`CONFIRM_FRAMES` の代わりに緩和値
     `EEW_CONFIRM_POINTS`/`EEW_CONFIRM_FRAMES` を使う（震源座標・距離は見ない＝震源非依存を維持したまま
     確定を早める）。単点ノイズを弾く `CONFIRM_INTENSE_POINTS`・`MIN_CONFIRM_INTENSITY`・`MIN_CLUSTER`・
     慢性活性の引き上げ幅は EEW 中でも変えない
   - `confirmIntensityReq` は通常 `MIN_CONFIRM_INTENSITY`、慢性活性セルでは `CHRONIC_CONFIRM_INTENSITY`
     （後述の第2軸）
   - `intenseCount`（`confirmIntensityReq` 以上に達した levelActive メンバー数）が `CONFIRM_INTENSE_POINTS`
     未満なら confirmed にしない（「単点だけ確定震度・周囲は震度0」という局所ノイズの分布を弾く第3軸）
2. **likely / faint 判定**: `everConfirmed` でなければ、`lastSize ≥ MIN_LIKELY_POINTS` を一度でも
   満たした（`hasSpread`）イベントは `LIKELY_HOLD_MS` の間ティアを保持する（`spreadHeld`）。保持中は
   `maxIntensity ≥ MIN_LIKELY_INTENSITY` なら `likely`、それ未満（震度0級）なら `faint`
3. どちらも満たさなければ `weak`（非表示）

イベントは「揺れが続く限り」（`lastSize > 0` の間）`lastOnsetAtMs` が毎フレーム更新され、揺れが収まって
から `HOLD_MS` 経過で配列から除去される。

### 特異度（誤検知抑制）の三軸

| 軸 | 対策 | 対象 |
|---|---|---|
| 第1軸: 点別ノイズ床 | `FLOOR_CAP` を上限に、慢性的にノイジーな点は自動的に鈍くなる | 単一観測点の慢性ノイズ・火山性微動等 |
| 第2軸: セル別慢性活性 `cellActivity` | 平常時に確定揺れ点をよく出すセルでは確定バー（点数・震度）を引き上げる | 北関東等、複数観測点が間欠的にコヒーレントに反応する地域ノイズ（点別床だけでは防げない） |
| 第3軸: 確定震度到達点数 `CONFIRM_INTENSE_POINTS` | 確定震度以上に達した levelActive メンバーが一定数未満なら confirmed にしない | 「単点だけ確定震度・周囲は震度0」という局所ノイズの分布（茨城県北部 2026-07-27 の誤 confirmed が実例） |

いずれの軸も EEW（震源要素確定）発表中の確定緩和（`EEW_CONFIRM_POINTS`/`EEW_CONFIRM_FRAMES`）で変わらない。
緩和されるのは確定点数・確定連続フレーム数のバーのみで、単点ノイズを弾く仕組み自体は EEW 中でも維持される。

高震度 fast path（設計書§20）だけは第2軸（慢性活性セルの確定バー引き上げ）も併せて免除する。慢性ノイズの学習床は
`FLOOR_CAP`=1.5（震度2相当）で頭打ちになるため `HIGH_CONFIRM_INTENSITY`=2.5 はその外側にあり、平常時2時間
（全国1725点）の実データでも value≥2.5 の出現が皆無だったことを確認している。第1軸（点別床）と `MIN_CLUSTER`
（空間コヒーレンス）は fast path でも維持される——fast path が数えるのは同一イベントのメンバーだけなので、
遠く離れた点が偶然同時に高震度でも別イベントとして扱われ発火しない。

`cellActivity` は `CELL_FREEZE_INTENSITY`（震度3相当）以上の高震度イベントが属するセルでは学習を凍結し、
実地震で地域軸を汚さないようにしている。この閾値は `HIGH_CONFIRM_INTENSITY` と同値であり、どちらも
「震度3以上は明らかに実地震」という同一の判断に立つ。片方だけ動かすと非対称が生まれるため揃えて扱うこと。

## 5. パラメータ一覧（`PARAMS`・単位は計測震度 value か ms/km/度）

| 記号 | 意味 | 値 |
|---|---|---|
| `LEVEL_MARGIN` | levelActive の床上乗せ | 0.0 |
| `SUSTAIN_MARGIN` | sustained（継続揺れ）の床上乗せ | 0.4 |
| `RATE_MIN` | onset に要する上昇量 | 0.5 |
| `RATE_DT_MS` | 上昇量の評価窓 | 2,500 ms |
| `TRIG_FLOOR` | トリガー評価の絶対下限 | -1.5 |
| `FLOOR_TAU_MS` | ノイズ床学習の時定数 | 900,000 ms（15分） |
| `FLOOR_FREEZE_MS` | onset 後の床学習フリーズ期間 | 600,000 ms（10分） |
| `FLOOR_SIGMA_K` | 実効床＝floorMean＋この係数×floorDev | 3.0 |
| `FLOOR_MIN` | 点別床の下限 | 0.0 |
| `FLOOR_CAP` | 点別床の上限 | 1.5（震度2相当） |
| `MAX_DT_GAP_MS` | 不連続リセットの閾値 | 10,000 ms |
| `K` | 近傍点数 | 12 |
| `R_KM` | 近傍半径 | 40 km |
| `MIN_CLUSTER` | 揺れクラスタの連結成分サイズ下限 | 3 |
| `COINCIDENCE_MS` | 同期とみなす時間窓 | 4,000 ms |
| `TRIG_ACTIVE_MS` | トリガー継続とみなす窓 | 8,000 ms |
| `CELL_DEG` | 固定格子セルの寸法 | 0.2°（≒20km） |
| `MERGE_MEMBER_FRAC` | イベント帰属のメンバー重複率下限 | 0.34 |
| `MERGE_EVENT_KM` | イベント併合距離 | 100 km |
| `MIN_LIKELY_POINTS` | likely に要する点数 | 3 |
| `MIN_LIKELY_INTENSITY` | likely の最大震度下限 | 0.5（震度1） |
| `CONFIRM_POINTS` | confirmed 点数（密な網の基準値） | 5 |
| `CONFIRM_DENSITY_FRAC` | 確定点数の密度正規化割合 | 0.6 |
| `MIN_CONFIRM_INTENSITY` | confirmed の最大震度下限 | 0.5（震度1） |
| `CONFIRM_INTENSE_POINTS` | confirmed に要する確定震度到達点数（単点ノイズ除去の第3軸） | 2 |
| `CONFIRM_FRAMES` | confirmed 連続フレーム数 | 2 |
| `HIGH_CONFIRM_INTENSITY` | 高震度 fast path の震度下限（点数ゲートを免除・設計書§20） | 2.5（震度3） |
| `HIGH_CONFIRM_POINTS` | 高震度 fast path に要する高震度到達点数 | 2 |
| `EEW_CONFIRM_POINTS` | EEW（震源要素確定）発表中に CONFIRM_POINTS の代わりに使う確定点数 | 3 |
| `EEW_CONFIRM_FRAMES` | EEW 発表中に CONFIRM_FRAMES の代わりに使う確定連続フレーム数 | 1 |
| `HOLD_MS` | confirmed イベントの保持 | 10,000 ms |
| `LIKELY_HOLD_MS` | likely/faint ティアの保持 | 10,000 ms |
| `CELL_ACTIVITY_TAU_MS` | セル慢性活性の学習時定数 | 1,800,000 ms（30分） |
| `CHRONIC_THRESHOLD` | 慢性活性セルとみなす閾値 | 0.25 |
| `CHRONIC_POINT_BUMP` | 慢性活性セルでの点数引き上げ幅 | 4 |
| `CHRONIC_CONFIRM_INTENSITY` | 慢性活性セルでの震度下限 | 1.5（震度2） |
| `CELL_FREEZE_INTENSITY` | セル慢性活性の学習凍結震度 | 2.5（震度3） |

## 6. 出力（`DetectionEvent`）

| フィールド | 内容 |
|---|---|
| `id` | 安定 ID（`evt-N`）。帰属が続く限り同一 ID を維持 |
| `confidence` | `confirmed` \| `likely` \| `faint` \| `weak` |
| `memberKeys` | 参加した確定揺れ点の座標キー（累積和集合） |
| `cells` | 占有する固定格子セル |
| `maxIntensity` | 推定最大震度（value）。カード・音レベルの入力 |
| `lastSize` | 直近フレームのアクティブメンバー数 |
| `epicenter` | メンバー座標の重心（表示専用・震源ではない） |
| `everConfirmed` | 一度でも confirmed に達したか（明滅防止ラッチ） |

`weak` のイベントも内部状態としては保持されるが、`step()` が返す `detections` 配列・UI 側の判定
（`confirmed`/`candidate`）には `weak` は現れない（表示は confirmed/likely/faint のみ）。

## 7. 永続化（`useKyoshinDetectorV2`）

学習資産（点別ノイズ床 `floorMean`/`floorDev`・セル慢性活性 `cellActivity`）は座標キー／セルキー基準で
`localStorage['kyoshin-v3-learned']` に保存する（`siteConfigId` の版差に非依存）。一過性の状態
（`hist`・`triggeredAtMs`・アクティブイベント）は保存しない。保存間隔は 60 秒スロットル。

再読込・不連続リセット（欠測・巻き戻し・5時リロード等）が起きても学習資産は引き継がれ、コールドスタート
の warmup は不要（床は静的・長時定数なので初手から検知可能）。

## 8. UI 連携

### 表示状態への変換（`deriveKyoshinView`）

`DetectionEvent[]` を UI 向けの `KyoshinView` に変換する:
- `confirmed` / `candidate`: confirmed / likely イベントが1件以上あるか
- `detectedPoints`: confirmed 全イベントのメンバー観測点の和集合（自動フィット対象）
- `candidatePoints`: 主 likely イベント（最大震度が最大の1件）のメンバー観測点
- `confirmedShocks`: confirmed 各イベント（＝地域）の代表点（重心）＋メンバー最大震度。地域単位発報の入力

自動フィットは常にメンバー観測点のフットプリントを対象とし、`epicenter`（推定震央）へは飛ばさない
（深発・沖合で `epicenter` の誤差が大きくても地図が誤った場所へ飛ばないようにするため）。

### 発報ロジック（`useKyoshinAlerts`）

| トリガー | 挙動 |
|---|---|
| candidate 立ち上がり（confirmed 前） | realtime タブへ切替＋タイトル「🔍 揺れの可能性」＋控えめな候補音 |
| confirmed 立ち上がり（初検知） | realtime タブ＋タイトル「📈 揺れ検知」＋検知音＋ブラウザ通知 |
| confirmed 中の最大震度の再上昇（レベルアップ／再エスカレーション） | 更新音（同一地震の揺れ強まりを都度知らせる） |
| 検知中に別地域（`isSameEarthquake` が同一地震と判定しない距離）が新たに確定 | 検知音＋ブラウザ通知（「別の地点で揺れを検知」）。`REGION_PERSIST_TICKS` 継続後・`NEW_REGION_COOLDOWN_TICKS` のクールダウン付きで一過性の分裂を抑制 |
| 全イベント解除 | EEW 受信中でなければデフォルトタブへ復帰 |

同一地域の余震は、揺れが収まって地域情報が破棄された後に来れば「別地点」として、収まる前に来れば
「全体の再エスカレーション」として発報される（地域ごとの独立した再検知ではない）。

#### 「別地点」判定の動的距離閾値（`isSameEarthquake`）

固定距離（`REGION_MATCH_KM`=300km）だけで判定すると、能登半島地震のような広域巨大地震で揺れが
観測網へ伝播していく数十秒〜数分の間に、周辺地域が次々「別地点」と誤発報される（2026-08-10 の
実地震リプレイ検証で発覚）。`isSameEarthquake` は次の優先順位で判定する:

1. **アクティブな EEW（震源要素確定済み）ごとの個別判定**: 各 EEW について、震源・発生時刻から
   S波の地表到達半径（`usePsWaveCalc` と同じ2層速度モデル）×安全マージン係数
   `DYNAMIC_THRESHOLD_SAFETY_FACTOR`(1.2) を動的閾値とし、既存地域・新規確定点の**両方**が
   その閾値内にあれば同一地震とみなす（EEW ごとの OR 条件）。「地理的に最も近い震源を1つだけ
   選ぶ」設計だと、たまたま近くにある別の（まだ経過時間が短い）地震の震源に判定を乗っ取られる
   ことがある（検証実例: 近畿地方の揺れが、94秒経過した能登の震源より地理的にわずかに近いだけの
   19秒経過の新島・神津島近海の震源を誤って基準にされた）。EEW ごとに独立評価してこれを避ける。
2. **EEW が無い場合のフォールバック**: 地域の初検知時刻を仮の発生時刻、`DEFAULT_VIRTUAL_DEPTH_KM`
   (15km) を仮の震源深さとして同様に動的閾値を計算する。
3. いずれも下限 `REGION_MATCH_KM`(300km) を保証する（発生直後の判定を安定させるため）。

未発報の地域は、登録された瞬間の座標に固定されたまま（自分自身の確定点と距離ほぼ0で毎フレーム
再マッチし続けるため、動的閾値が後から拡大しても自然には他の地域と合流しない）。これを救済する
ため、毎フレーム末に未発報の地域を `isRegionWithinAnyEew` で再評価し、いずれかの EEW の動的閾値
内に収まっていれば静かに削除して吸収する。さらに発報の直前にも同じ再評価を行い、動的閾値が
追いついていれば発報自体を取りやめる（自己マッチによる持続フレーム数の積み上がりが、動的閾値の
拡大と無関係に発報条件を満たしてしまうのを防ぐ）。

### 震度0ドット表示フィルタ（`kyoshinSubThresholdFilter.ts`）

震度0以下（index 1〜6）の面表示（`KyoshinSubThresholdGL`）専用。検知トリガー用の `effectiveFloor` とは
別に `chronicNoiseFloor`（下限 `FLOOR_MIN` を適用しない）を使い、`value ≥ floor + SUSTAIN_MARGIN` を
超えた点だけを表示する。慢性的にノイジーな観測点（大阪・岡山等）が平常時から常時ドット表示され続けるのを防ぐ。
震度1以上のドット表示・最大効果表示には適用しない（実測値をそのまま見せる）。

## 9. 既知の限界

- **単点微小地震の非検知**: 近傍同時性（L2）は本質的に「複数の近傍観測点が同時に反応すること」を
  要求する。震源近くに観測点が1点しかない・観測点間隔が広い地域で起きる微小地震（M2〜3程度）は、
  そもそも `MIN_CLUSTER` を満たす面が育たず検知できない。これは「散在ノイズを弾く」特異度の裏面であり、
  観測網の密度に依存する原理的な限界（震源を使わない設計そのものの帰結）
- **広域分裂**: 震度5以上の巨大地震は有感域が数百km に及び、山地・海洋のギャップで近傍グラフが複数の
  連結成分に割れることがある（`MERGE_EVENT_KM` で近い成分は統合するが、実際に離れた有感域は統合しない）。
  UI 側（`RealtimeTab`）で「広域・N地域」として集約表示することで対応している
- **深発地震の震央精度**: `epicenter` はメンバー観測点の重心であり、震源そのものではない。深発地震は
  実際の震源よりかなりずれることがあるため、自動フィットには使わない設計にしている
