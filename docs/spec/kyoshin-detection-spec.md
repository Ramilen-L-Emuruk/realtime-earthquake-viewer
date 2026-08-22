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
       └─ src/services/kyoshinSource.ts: 供給元（ライブ／過去リプレイ）→ フレームを投入
            └─ src/utils/kyoshinFrameQueue.ts: データ時刻順に並べ、到来分の最新1件を放出
                 └─ src/hooks/useKyoshinRealtime.ts: 反映 → sites, indices, dataTime
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
（`step(state, frame, meta)` → `{ state, detections, triggers, recentOnsetKeys }`）。時刻はすべて `frame.dataTimeMs`
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

**同座標の重複点は別実体で保持する**。Yahoo は同一座標に複数の観測点を列挙するケースがあり（配列順で
#1, #2, #3... と現れる）、`computeSiteKeys` は出現順に別キーを与えて別実体として扱う。これは Yahoo 公式が
座標をマージせずそのまま扱っている挙動に合わせたもので、既存の最大値集計（`updateEventMetrics` 等）は
実体が別々でも同じ結果に自然と収束する。

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

再構築するのは**観測点集合が変わったときだけ**。判定は二段構えで、まず `sites` の**参照**を見て（同一
`siteConfigId` なら `fetchSiteList` が同じ配列を返すため通常運用はここで終わる）、参照が変わったときだけ
**全点**のシグネチャを比べる。内容が同じなら O(点数²) の再構築を省いて参照だけ差し替える。
全点を見るのは、配列の中間だけが差し替わる更新を取りこぼすと古い観測点キーを使い続け、表示側が毎回
作り直すキーとずれるため（そのとき §8 の `recentOnsetKeys` を使う判定が静かに効かなくなる。経緯は設計書 §23）。

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
   カバーされるが、群発地震で本震・大きめの余震の減衰過程が続く場合に重要。詳細は設計書§28）

### L2 近傍同時性（同期 onset の空間的広がり）

震源に依存しない面判定の核心部分。

1. 直近 `COINCIDENCE_MS` 以内に onset した観測点を集める（`recentOnset`）
2. `recentOnset` を K 近傍グラフ（`neighbors`）で連結成分に分解する
3. 成分サイズが `requiredClusterSize`（成分内の最大震度で決まる下限）以上の成分だけを「確定揺れ点
   （confirmed-shaking）」とする。通常は `MIN_CLUSTER`、震度3以上（`HIGH_CONFIRM_INTENSITY`）を含むなら
   `HIGH_CLUSTER_POINTS`、震度4以上（`SOLO_CLUSTER_INTENSITY`）を含むなら 1 点で認める（設計書§29）

散在する単発ノイズは近傍が揃わず成分が育たないため脱落する。時間差で onset した観測点（初期微動→
主要動など）も同一成分として束ねられる。

震度で点数要求を緩めるのは、**震源最近傍の1点だけが先に立ち上がる状態が実地震の初動として正常に
起こる**ため。隣の観測点（20〜30km 先）には S 波がまだ届いていないので、この数秒間は「単点だけ高震度・
周囲は静穏」という分布になり、機器故障と区別できない。点数では見分けられないので、震度がノイズ床
（`FLOOR_CAP`=1.5）からどれだけ離れているかで信頼度を決めている。判定は成分ごとに閉じているため、
他所のノイズの有無で本物の判定が変わることはない。

### L3 グループ化・イベント帰属

- **値が下がりきったメンバーを外す**（`pruneFadedMembers`）。levelActive を最後に満たしてから
  `MEMBER_DROP_MS` を超えた点をメンバーから落とす。今フレームに値が届いていない点（欠測・初出）は
  判定材料が無いので残す。占有セル（`cells`）は落とさない——同じ場所の再 onset を同一イベントへ戻す
  錨だから
- 各連結成分（クラスタ）を既存の `DetectionEvent` に帰属させる。判定は「メンバー重複率 `MERGE_MEMBER_FRAC`
  以上」または「格子セルの共有」のいずれか。該当が無ければ新規イベントを生成する
  - 重複率の分母は**成分側**（＝「この成分の何割が既存メンバーか」）。小さな成分が大きなイベントへ
    帰属する向きは分子＝分母で 1.0 になり従来どおり通るが、メンバーの少ないイベントが大きな成分を
    飲み込む向きは通らない
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
   - **(b) 高震度 fast path（設計書§20・§29）**: `HIGH_CONFIRM_INTENSITY`（震度3）以上に達した levelActive
     メンバーが `HIGH_CONFIRM_POINTS`（=1）点以上あり、**かつ** 次のどちらかを満たすとき成立する。
     - `intenseCount ≥ CONFIRM_INTENSE_POINTS`（§18 の第3ゲートを満たしている）
     - **今フレームにこのイベントへ L2 成分が帰属しており**、かつその点数が `MIN_CLUSTER` 未満
       （成分点数の緩和で認められた小さな成分。点数が足りず第3ゲートを課せないので震度の高さで代替する）。
       **帰属が無いフレーム（0 点）はこの条件に含めない**——含めると、揺れが収まって成分が来なくなった
       イベントすべてが免除対象になる。
       この判定に**時間の保持を持たせていない**（今フレームの成分だけで決める）。そのため単点・2点の
       イベントは値が 1 フレーム沈むと免除が切れ、`confirmStreak` がリセットされて確定が 2 フレーム遅れる。
       これは受容した挙動で、保持を持たせると別の誤確定経路が開くため（設計書§29）

     免除するのは点数ゲート（`effectiveConfirmReq`・慢性活性セルの引き上げ幅）だけで、**§18 の第3ゲートは
     成分の点数が足りる場面では必ず課す**（「1点だけ強く・周囲は震度0」という局所ノイズの分布を、震度3の
     バーで再び通さないため）。判定に `lastSize` を使わないのは、これが時間で減衰する量（`TRIG_ACTIVE_MS`
     の onset 途絶で 0 になる）で、成分の出自を表さないため。`confirmFramesReq` の連続要求は (a) (b) 共通で
     免除しない（単フレームの跳ね値を弾く安全弁）
   - `effectiveConfirmReq` は密度正規化済み: `max(MIN_LIKELY_POINTS, min(confirmPointsBase(+慢性活性なら
     CHRONIC_POINT_BUMP), ceil((局所実在近傍数+1) × CONFIRM_DENSITY_FRAC)))`。疎地域（離島等）は
     点数要件を自動的に下げる
   - `confirmPointsBase`・`confirmFramesReq` は `frame.eewActive`（呼び出し側が「震源要素が確定した
     （単独点処理=仮定震源要素でない）EEW が発表中か」を渡す。severity は推定震度の大小を示す軸に
     過ぎず判定に使わない）が true の間、`CONFIRM_POINTS`/`CONFIRM_FRAMES` の代わりに緩和値
     `EEW_CONFIRM_POINTS`/`EEW_CONFIRM_FRAMES` を使う（震源座標・距離は見ない＝震源非依存を維持したまま
     確定を早める）。単点ノイズを弾く `CONFIRM_INTENSE_POINTS`・`MIN_CONFIRM_INTENSITY`・
     `requiredClusterSize`（`MIN_CLUSTER`／`HIGH_CLUSTER_POINTS`／`SOLO_CLUSTER_INTENSITY`）・
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
（全国1725点）の実データでも value≥2.5 の出現が皆無だったことを確認している。第1軸（点別床）は fast path でも
維持される。第3軸（`CONFIRM_INTENSE_POINTS`）は成分の点数が足りる場面では維持され、成分点数の緩和で認められた
小さな成分（点数が足りず課せない場合）だけ震度の高さで代替する（条件の詳細は §4 の L4 (b)）。空間コヒーレンス
（L2 の `requiredClusterSize`）は震度に応じて段階的に緩む（理由は §4 の L2）。

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
| `HIGH_CLUSTER_POINTS` | 震度3以上を含む成分に要する点数（設計書§29） | 2 |
| `SOLO_CLUSTER_INTENSITY` | 単独の点でも成分として認める震度下限（設計書§29） | 3.5（震度4） |
| `COINCIDENCE_MS` | 同期とみなす時間窓 | 4,000 ms |
| `TRIG_ACTIVE_MS` | トリガー継続とみなす窓 | 8,000 ms |
| `CELL_DEG` | 固定格子セルの寸法 | 0.2°（≒20km） |
| `MERGE_MEMBER_FRAC` | イベント帰属のメンバー重複率下限 | 0.34 |
| `MERGE_EVENT_KM` | イベント併合距離 | 100 km |
| `MEMBER_DROP_MS` | メンバーを外すまでの猶予（設計書§30） | 20,000 ms |
| `MIN_LIKELY_POINTS` | likely に要する点数 | 3 |
| `MIN_LIKELY_INTENSITY` | likely の最大震度下限 | 0.5（震度1） |
| `CONFIRM_POINTS` | confirmed 点数（密な網の基準値） | 5 |
| `CONFIRM_DENSITY_FRAC` | 確定点数の密度正規化割合 | 0.6 |
| `MIN_CONFIRM_INTENSITY` | confirmed の最大震度下限 | 0.5（震度1） |
| `CONFIRM_INTENSE_POINTS` | confirmed に要する確定震度到達点数（単点ノイズ除去の第3軸） | 2 |
| `CONFIRM_FRAMES` | confirmed 連続フレーム数 | 2 |
| `HIGH_CONFIRM_INTENSITY` | 高震度 fast path の震度下限（点数ゲートを免除・設計書§20） | 2.5（震度3） |
| `HIGH_CONFIRM_POINTS` | 高震度 fast path に要する高震度到達点数（設計書§29） | 1 |
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
| `memberKeys` | 参加した確定揺れ点の座標キー。増える側は累積和集合だが、値が下がりきった点は `MEMBER_DROP_MS` の猶予を過ぎると外れる（§4 L3）。**イベントが生存している間に空にはならない**（猶予の下限がそれを保証する。設計書§30） |
| `cells` | 占有する固定格子セル |
| `maxIntensity` | 推定最大震度（value）。カード・音レベルの入力 |
| `lastSize` | 直近フレームのアクティブメンバー数 |
| `epicenter` | メンバー座標の重心（表示専用・震源ではない） |
| `everConfirmed` | 一度でも confirmed に達したか（明滅防止ラッチ） |

`weak` のイベントも内部状態としては保持されるが、`step()` が返す `detections` 配列・UI 側の判定
（`confirmed`/`candidate`）には `weak` は現れない（表示は confirmed/likely/faint のみ）。

## 7. 永続化と異常系（`useKyoshinDetectorV2`）

学習資産（点別ノイズ床 `floorMean`/`floorDev`・セル慢性活性 `cellActivity`）は座標キー／セルキー基準で
`localStorage['kyoshin-v3-learned']` に保存する（`siteConfigId` の版差に非依存）。一過性の状態
（`hist`・`triggeredAtMs`・アクティブイベント）は保存しない。保存間隔は 60 秒スロットル。

再読込・不連続リセット（欠測・巻き戻し・5時リロード等）が起きても学習資産は引き継がれ、コールドスタート
の warmup は不要（床は静的・長時定数なので初手から検知可能）。

**フレーム内の点別欠測**（`frame.missing[i]===true`）については、当該点の `SiteState` を丸ごと
消失させず前フレームの学習資産を保持する。以前は消失→次フレームで `initSiteState` から再学習に
入るため慢性ノイズ点の `floorDev` が 0 リセットされ検知閾値を崩す問題があった（KYO-1）。

### `step()` が例外を投げたとき

ログして次フレームで再試行する（`stateRef` は壊さない）。**`STEP_FAIL_RESET_FRAMES`(5) フレーム連続で
失敗したら検知結果（`detections` / `recentOnsetKeys`）を空にする**。学習資産は保持するため、復帰時に
学び直しにはならない。前フレームの結果を保持し続けると、凍結したメンバーを現在の震度に当てて描き続ける
ことになる（理由の詳細は設計書 §23）。

## 8. UI 連携

### 表示状態への変換（`deriveKyoshinView`）

`DetectionEvent[]` を UI 向けの `KyoshinView` に変換する:
- `confirmed` / `candidate`: confirmed / likely イベントが1件以上あるか
- `detectedPoints`: confirmed 全イベントのメンバー観測点の和集合。**「検知が続いているか」の判定専用**
- `detectedMarkerPoints`: 上記から孤立した震度0点を除いたもの。**検知点マーカーに描く分と、
  そこから作るカメラの寄り先**
- `candidatePoints`: 主 likely イベント（最大震度が最大の1件）のメンバー観測点。**候補カメラフィット専用**
- `unconfirmedPoints`: likely / faint 全イベントのメンバー観測点の和集合から confirmed の分を除いた差集合。
  **検知点マーカー専用**（フィットには使わない。複数 likely の和集合に寄せると境界が飛び跳ねるため）
- `confirmedShocks`: confirmed 各イベント（＝地域）の代表点（重心）＋メンバー最大震度。地域単位発報の入力

自動フィットは常にメンバー観測点のフットプリントを対象とし、`epicenter`（推定震央）へは飛ばさない
（深発・沖合で `epicenter` の誤差が大きくても地図が誤った場所へ飛ばないようにするため）。

カメラは**描かれている点**を寄り先にし、**検知が続いているかはメンバーの和集合で**判定する
（`FitToDetectionGL` の `points` と `hasDetection`）。この 2 つを兼ねさせてはならない——描ける点が
一時的にゼロになること（全メンバーが震度0未満・欠測になる、孤立した震度0として落ちる）は検知中にも
起きるため、それを検知終了と扱うと画が日本全体へ戻り、点が返った瞬間に寄り直す明滅になる（設計書 §22）。
分ける理由と縮小の追従は [`map-rendering-spec.md`](map-rendering-spec.md) §6「揺れ検知追従の目標範囲」。

### 検知点マーカーとカードの点数の一致

地図の検知点マーカー（`KyoshinDetectedPointsGL`）とリアルタイムタブの検知カードは、**同じ点集合・同じ下限**で
数える。どちらかだけを変えると表示が食い違う。

**点集合は `App` が用意した 1 本を両者で共有する**（`detectedMarkerPoints` ＋ `unconfirmedPoints`。カードへは
`RealtimeTab` の `kyoshinDetectedPoints` として渡る）。以前はカード側でも同じ入力から同じ計算を組み立てて
いたが、「同じ結果になること」に頼ると片方の実装を変えた時点で黙って食い違うため、計算を 1 箇所に寄せた。

| 揃えるもの | 内容 |
|---|---|
| 対象イベント | `weak` 以外の全イベント（confirmed ＋ likely ＋ faint） |
| 下限 | 現在**震度0以上**（計測震度 0.0 以上）の点だけ。判定は `kyoshinIndexToJma` / `kyoshinIndexToLabel`（`src/utils/kyoshinIntensity.ts`）が震度階級を返すかどうかに委ねる。震度0未満（`index` 0〜5。値は非負だが計測震度は負）と欠測（`index` が負のセンチネル）はどちらも階級が取れないため、数えず描かない |
| 孤立した震度0点の除外 | 共有する点列の時点で除かれている（下記 `dropIsolatedZeroPoints`） |

**メンバー観測点は値が下がりきってから `MEMBER_DROP_MS` を過ぎるまで残る**（`pruneFadedMembers`。現在
揺れている数は `lastSize` が別に持つ）。そのため「メンバー全件」を描いてしまうと、揺れが収まるほど地図が
「もう揺れていない点」で埋まり、震度0以上だけを数えるカードと桁違いにずれる。2026-08-18 まで地図側が
これに該当していた（階級が取れない点を震度0として描いていた。計測値は `gl/kyoshinDetectedFeatures.ts` のコメント）。

### 検知カードの震度分布バーの幅スケール（`scalePeakRef`）

カードは震度階級ごとの点数を横バーで並べる。幅の分母（＝100% にあたる点数）は、**カードが見えている間は
下げない**。上げるのは点数が増えたときだけなので、見ている間のバーの伸びは必ず実際の点数の増加を意味する。

分母を毎回いまの最大点数に合わせると、最大だった階級の点数が減っただけで他のバーが伸び、揺れが収まって
いく最中に「増えた」と見える（分母が動いただけで点数は減っている）。時間で減衰させる方式も同じで、
減衰した瞬間にバーが一斉に太る。

代わりに、**カードが見えていない間は毎回いまの点数へ張り直す**。跳ねても目に入らないうえ、次に見えた
瞬間は必ず「いまの点数」が基準になるため、前の揺れのピークを引きずらない。見えていないと判定するのは
次の 3 つ:

| 契機 | 判定 |
|---|---|
| 別のタブを開いている | `activeTab !== 'realtime'`（タブは常時マウントで、選ばれていなくても描画は走る） |
| パネルを畳んでいる | `panelCollapsed` |
| ブラウザのタブ・ウィンドウが裏 | `document.visibilityState !== 'visible'`（`usePageVisible`） |

前 2 つは `App` が `RealtimeTab` の `visible` へ渡し、3 つ目をカード側で合成する。

**副作用**: 大地震の長い減衰期にこのタブを見続けると、分母がピークのままなのでバーは細いままになる。
点数は各行の右端に数値で出ているので情報は失われず、タブを一度離れて戻れば張り直る。検知イベントが
すべて消えればカード自体がアンマウントされるため、地震と地震の間で分母が持ち越されることもない。

### 孤立した震度0点を落とす（`dropIsolatedZeroPoints`）

震度0以上に絞ってもなお、大地震のあと各地に震度0のバッジが点々と居座る。表面波が抜けた後も値が震度0
付近をうろつく点はメンバーに残り続けるためで、**残るのは主に confirmed イベントの「もう揺れていない点」**。

そこで、**confirmed イベントのメンバー**のうち次の 3 条件をすべて満たす点を、地図の検知点マーカーと
検知カードの双方から落とす:

1. 現在の震度が 0（震度1以上・震度0未満/欠測は対象外）
2. `ISOLATED_ZERO_RADIUS_KM`（30km）以内に震度1以上の検知点が無い
3. 直近に立ち上がっていない（`step()` が返す `recentOnsetKeys` に含まれない。窓は `TRIG_ACTIVE_MS`）

- **条件 3 が要る理由**: 空間条件だけで落とすと、揺れが広がっていく最初の数分で「まだ震度0だが直後に
  震度1以上へ育つ点」＝到達先端まで消える。
- **対象を confirmed に限る理由**: 残骸を溜めるのは長寿命の confirmed。likely / faint は短命で、faint は
  定義上メンバー全員が震度0のため、対象に含めるとイベントが生きている間に点だけが消えて
  「微弱な揺れの兆候」カードと地図が食い違う。
- **条件 2 の判定材料には対象外の点も使う**（confirmed の震度0点の隣にある likely の震度1点を見落とさない
  ため）。
- 条件 3 が拠る `recentOnsetKeys` の生成と、そのキーが表示側とずれないための仕組みは §4 の L0 と
  §7「`step()` が例外を投げたとき」を参照。

このフィルタは**表示だけを整えるもので、検知の判定には触れない**。`confirmed` / `candidate` /
`candidateMaxIndex` / `confirmedShocks`（音・自動タブ切替・地域単位発報の入力）と、カメラフィットに使う
`detectedPoints` / `candidatePoints` はフィルタ前の集合から算出する。

半径 30km・8 秒という値の選定根拠、実データでの計測値、カメラ追従との分離に至った経緯は
**設計書 §22**（[kyoshin-detection-v3-design.md](kyoshin-detection-v3-design.md)）にまとめている。

メンバーが全員震度0未満まで下がると、地図の検知点マーカーは 0 件になる。イベント自体は `HOLD_MS` /
`LIKELY_HOLD_MS` の間ラッチで生き残るためカードは残るが、点数の代わりに「観測点の反応は収まりました」と
表示し、あわせて確信度チップと見出しの色を灰へ置き換えて、地図が空であることと印象を揃える。
**確信度のラベル（検知／可能性／微弱）は判定結果なので変えない**——変えると明滅防止のラッチの
意味が失われる。枠色を最大震度に追従させているのと同じ考え方で、「判定の種類」と「現在の活動度」を
別の手段で示す。弱め方に不透明度を使わないのは、文字と背景の関係まで薄まって読みにくくなるため。

### 欠測の瞬断は直前値を保持して描く（`utils/kyoshinMissingHold.ts`）

強震モニタの秒データには欠測（負のセンチネル）が混ざり、**現に強く揺れている観測点でも 1〜2 秒だけ
単発で欠測する**。素通しすると震度階級が取れないため、強い揺れのバッジが 1 秒消えて次の秒で戻る
明滅になる（実データでの計測は**設計書 §25**）。

そこで表示に使うインデックスは、欠測になった点を**直前の有効値で 2 秒間だけ埋める**（`MISSING_HOLD_MS`）。
保持中の点は `DetectedPoint.stale` が立ち、地図では薄く（`MISSING_HOLD_OPACITY` = 0.35）描かれる。
2 秒を過ぎたら欠測のまま＝従来どおり消える（本物の観測点停止を残さないため）。カードの震度別点数も
保持中の点を同じように数える（地図と数える集合を揃える §8 の原則をそのまま適用する）。

保持値が及ぶ範囲は次のとおり。**これは上の孤立震度0点フィルタとは別の工程**——あちらは出来上がった点列
から描く点を選ぶフィルタなので判定に触れないが、こちらは判定より前段の `index` そのものを差し替えるため、
`index` を見る判定にも届く。

| 対象 | 保持値を使うか | 補足 |
|---|---|---|
| 検知エンジン（`kyoshinDetector`） | **使わない**（生値） | 欠測判定・慢性ノイズ床の学習を保持値で汚さない |
| 検知点マーカー（`KyoshinDetectedPointsGL`）・震度1以上のドット（`KyoshinPointsGL`） | 使う | 保持中は薄く描く |
| 震度0未満のドット（`KyoshinSubThresholdGL`） | 使う | **薄くはしない**（レベル単位で一括描画するカスタム GL レイヤーのため。ノイズ床の分布を見せる層で、1 点の保持状態を読む使い方をしない） |
| 検知カード（`RealtimeTab`。点数・推定最大震度） | 使う | 地図と同じ点列を共有するため自動的に一致する |
| 音・通知・地域単位発報（`useKyoshinAlerts` へ渡す `candidateMaxIndex` / `confirmedShocks`） | 使う | **意図的**。欠測を素通しすると最大震度を担う点の 1 秒欠測が「揺れが弱まった」と解釈され、復帰時に更新音が誤って鳴る（`postPeakMinLevel`）。検知エンジンが欠測を「揺れ 0」と扱わないのと同じ理由 |

同時に保持中の観測点が全体の 20% を超えた場合は警告を記録する（上流データの劣化に気づけるようにする。
`useKyoshinMissingHold`）。

### 発報ロジック（`useKyoshinAlerts`）

| トリガー | 挙動 |
|---|---|
| candidate 立ち上がり（confirmed 前） | realtime タブへ切替＋タイトル「🔍 揺れの可能性」＋控えめな候補音 |
| confirmed 立ち上がり（初検知） | realtime タブ＋タイトル「📈 揺れ検知」＋検知音＋ブラウザ通知 |
| confirmed 中の最大震度の再上昇（レベルアップ／再エスカレーション） | 更新音（同一地震の揺れ強まりを都度知らせる） |
| 検知中に別地域（`isSameEarthquake` が同一地震と判定しない距離）が新たに確定 | 検知音＋ブラウザ通知（「別の地点で揺れを検知」）。その地域の推定震度が `NEW_REGION_MIN_INDEX`（震度3）以上のときに限る。`REGION_PERSIST_MS`(2秒) 継続後・`NEW_REGION_COOLDOWN_MS`(5秒) のクールダウン付きで一過性の分裂を抑制 |
| 全イベント解除 | EEW 受信中でなければデフォルトタブへ復帰 |

**realtime タブへの切替は優先度付き**（規則の全体は [`audio-tts-spec.md`](audio-tts-spec.md) §6
「自動タブ切替の優先順位」が単一情報源）。揺れ検知の優先度は地震情報より重く津波より軽いが、
**揺れ検知が確保した画面は他の情報の移動を妨げない**（揺れ検知のあとに地震情報が届くのは実際に
起きた順序どおりで、そこで画面が留まる方が不自然なため）。揺れがレベルアップしたり別地点で
検知されれば、そのつど realtime を取り直す。

`useKyoshinAlerts` に渡されるタブ切替関数には App 側で揺れ検知の優先度が付いているため、
このフックの中では優先度を意識しない。

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
2. **EEW が無い場合のフォールバック**: **検知エピソード全体の起点**（最初に確定した地域の初検知時刻・
   `AlertRegionState.outbreakAtMs`）を仮の発生時刻、`DEFAULT_VIRTUAL_DEPTH_KM`(15km) を仮の震源深さ
   として同様に動的閾値を計算する。起点は `OUTBREAK_PROPAGATION_WINDOW_MS`(5分) を超えたら地域自身の
   初検知時刻へ戻す。
3. いずれも下限 `REGION_MATCH_KM`(300km)・上限 `PROPAGATION_MAX_KM`(800km) に収める。

距離の条件に加えて、次の 3 つが「別地点」の発報を絞る。

- **EEW の伝播範囲に一度でも入った地域は、その事実を記憶する**（`AlertRegion.absorbedByEew`）。EEW が
  解除された後も発報しない。判定は毎フレーム行い、発報の直前には座標を更新した後の位置でもう一度確認する。
- **震度の下限**（`NEW_REGION_MIN_INDEX`＝11・震度3の下端）。これを下回る地域は音を鳴らさない
  （検知カードと地図には出る）。
- **一度発報した地域は二度鳴らない**（`AlertRegion.fired`）。その地域の閾値の内側で後から別の地震が
  起きても音は出ない（検知カードと地図には出る）。

地域どうしの照合は**フレーム開始時の座標**で行う（代表点はマッチのたびに書き換わるため）。

持続（`REGION_PERSIST_MS`＝2秒）・クールダウン（`NEW_REGION_COOLDOWN_MS`＝5秒）・地域を破棄するまでの
猶予（`REGION_PRUNE_MS`＝3秒）は、いずれも**何フレーム届いたかではなく、観測データに付いている時刻の
経過で測る**。強震モニタのライブ取得は遅れると次の時刻へ飛んで途中のフレームを取りこぼすため、
フレームで数えるとライブと過去再生で同じ設定値が違う長さを意味してしまう。

この 3 つには次の性質がある。

- 持続は「観測できた回数」ではなく「初検知からの経過」で判定する。途中の観測が欠けても経過が足りていれば満たす。
- 破棄はフレームの末尾で判定するため、地域が実際に残る時間は猶予よりわずかに長い（1 秒間隔なら 1 フレーム分、
  取りこぼしがあればその分だけ伸びる）。

時刻で測ることにした経緯と破棄をこの位置に置いた理由は [設計書§31](kyoshin-detection-v3-design.md)、
値そのものをどう決めたか・検討して採らなかった案は [設計書§24](kyoshin-detection-v3-design.md) にある。

### 震度0ドット表示フィルタ（`kyoshinSubThresholdFilter.ts`）

震度0以下（index 1〜6）の面表示（`KyoshinSubThresholdGL`）専用。検知トリガー用の `effectiveFloor` とは
別に `chronicNoiseFloor`（下限 `FLOOR_MIN` を適用しない）を使い、`value ≥ floor + SUSTAIN_MARGIN` を
超えた点だけを表示する。慢性的にノイジーな観測点（大阪・岡山等）が平常時から常時ドット表示され続けるのを防ぐ。
震度1以上のドット表示・最大効果表示には適用しない（実測値をそのまま見せる）。

## 9. 既知の限界

- **単点微小地震の非検知**: 近傍同時性（L2）は本質的に「複数の近傍観測点が同時に反応すること」を
  要求する。震源近くに観測点が1点しかない・観測点間隔が広い地域で起きる微小地震（M2〜3程度）は、
  そもそも `requiredClusterSize` を満たす面が育たず検知できない。これは「散在ノイズを弾く」特異度の裏面であり、
  観測網の密度に依存する原理的な限界（震源を使わない設計そのものの帰結）。
  ただし単点でも**震度4以上**に達すれば検知する（`SOLO_CLUSTER_INTENSITY`・設計書§29）。非検知が残るのは
  震度3以下の単点で、そこは「機器故障と区別できない」という理由で意図的に検知しない
- **広域分裂**: 震度5以上の巨大地震は有感域が数百km に及び、山地・海洋のギャップで近傍グラフが複数の
  連結成分に割れることがある（`MERGE_EVENT_KM` で近い成分は統合するが、実際に離れた有感域は統合しない）。
  UI 側（`RealtimeTab`）で「広域・N地域」として集約表示することで対応している
- **深発地震の震央精度**: `epicenter` はメンバー観測点の重心であり、震源そのものではない。深発地震は
  実際の震源よりかなりずれることがあるため、自動フィットには使わない設計にしている
