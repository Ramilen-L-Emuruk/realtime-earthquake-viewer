# ベクタタイル化の検討（描画アーキテクチャの見直し）— 2026-07-28

> 発端: 高精細化後、EEW 発報時のカクつき（`maxload-eew` が HIGH）。原因切り分けで
> [diagnosis](webgl-migration-hires-perf-diagnosis-2026-07-28.md)→[diagnosis-2](webgl-migration-hires-perf-diagnosis-2-2026-07-28.md)
> を経て「反復 flyTo」「最密域飛行」の両仮説を否定。開発機での機種非依存計測（`moveendCount`/`renderCount`）で
> **真因は「EEW 発報中の連続再描画（~54回/秒・カメラ静止でも）× EEW 複合（高精細区域ポリゴンの塗り＋予報円）」**
> と確定しつつある。これを受け「そもそも描画方法にもっと良いものは？」の検討。

---

## 1. 出発点の重要事実 — MapLibre は geojson を既に実行時タイル化している

- ベースマップ（陸/県境/区域）・活断層・区域塗りは**すべて `{ type: 'geojson' }` ソース**で、`tolerance`/
  `maxzoom`/`buffer` を**一切指定していない**（＝MapLibre 既定）。
- MapLibre の geojson ソースは内部で **geojson-vt** により実行時にタイル化＋ズーム別簡略化している。
  つまり「geojson＝タイル化しない」ではない。既に LOD の一部は効いている。
- MapLibre 公式「Large Data」ガイドは、大規模 geojson の性能改善策として**ソースの `maxzoom` を下げる・
  `tolerance` を上げる**を推奨している（未使用のレバー）。

**含意**: 「事前生成ベクタタイル vs 現状 geojson」の差は見た目より小さい。事前生成が増分で本当に買えるのは
「実行時タイル化コストの排除（コールドスタート改善）」「ビルド時のより細かい per-zoom 簡略化・feature 間引き」
「巨大 geojson の一括 fetch/parse をやめる（初回転送の削減・range 取得）」であって、LOD 自体は既に一部ある。

## 2. 再診断の反映 — 真因は「ベース頂点数」ではなく「EEW 複合の連続描画」

実機計測（温状態）の対照:

| シナリオ | 判定 |
|---|---|
| static-kyoshin（高精細ベース＋kyoshin・EEW無） | 健全 |
| pan-maxzoom-kyoshin（＋カメラ移動） | 健全 |
| eew-static / maxload-eew（＋EEW 複合） | **重い** |

→ **高精細ベースマップ単体は weak GPU でも健全**。重くするのは **EEW 複合の追加分**（予想震度の区域塗り＝
高精細な一次細分区域ジオメトリを使う面塗り＋予報円）が **~54回/秒の連続再描画で乗り続けること**。
当初レビューの「ベース頂点 8.75 倍が主因」は半分だけ正しく、**主因は動的な区域塗りの描画経路**だった。

**したがって「ベースマップのベクタタイル化」は、この EEW 問題を直接は解かない**（ベース単体は既に健全）。
効くのは主にコールドスタート・初回転送・LOD の整理。EEW 問題に直接効くのは「区域塗りの描画方式」の改善。

## 3. 選択肢（小さい順・トレードオフ）

### 案1: 既存 geojson ソースの `tolerance`/`maxzoom` を調整（最小）
- ベース・塗りの geojson ソースに `maxzoom: 9〜10`・`tolerance` 引き上げを設定 → geojson-vt が使用ズーム帯で
  より積極的に簡略化 → 描画頂点減。
- 新パイプライン不要・即時。ただし既定でも簡略化は効いており増分は中程度。**連続再描画そのものは減らない。**

### 案2: 区域塗りを「静的ジオメトリ＋feature-state 着色」に（中・EEW 問題に直撃）推し
- 現状: `addSource(EMPTY_FC)` → 発報ごと `setData(buildFC(areaFills))`。**高精細な区域ポリゴンを発報のたびに
  geojson-vt で再タイル化**し、以後毎フレーム塗り直す。
- 改善: **全一次細分区域を安定 ID 付きで1つの静的ソースに1度だけ載せ**、発報時は `setFeatureState` で
  各区域の色（震度）を与え、paint は `['feature-state', ...]` 式で着色。→ 発報時の再タイル化が消え、
  ジオメトリは1度だけタイル化して再利用。動的なのは色だけ。
- feature-state は `id` 付き feature ＋ `feature-state` 式で setData 無し着色が可能（Context7 で裏取り済み）。
- **EEW/地震の区域塗りコストを直接下げつつ、海岸線の高精細は一切犠牲にしない。** 新ツール不要。
- 対象: `QuakeRegionFillGL`・`EewRegionFillGL`・`LpgmRegionFillGL`・`EewLpgmRegionFillGL`。

### 案2b: 連続再描画（~54回/秒）の無駄取り（中・案2と直交）
- データは1秒/100ms周期でしか変わらないのに毎フレーム再描画している。発生源（予報円アニメ/検知波紋/
  MapLibre 内部遷移）を特定し、不要な `triggerRepaint` を throttle する。案2と併用で相乗効果。

### 案3: 静的ベースを PMTiles ベクタタイル化（大・王道アーキテクチャ）
- 県境/区域/活断層/プレート境界を tippecanoe で MVT 化 → **PMTiles 単一ファイル**にし、`addProtocol('pmtiles', …)`
  で GitHub Pages から range 取得（タイルサーバー不要・Context7 で addProtocol 裏取り済み）。
- 買えるもの: **実行時タイル化コスト排除（コールドスタート改善）**・per-zoom の細かい LOD/feature 間引き・
  初回転送削減・手動 EPSILON 綱引きからの解放・MapLibre 本来の設計に整合。
- コスト/注意:
  - **tippecanoe は native C++**（Windows 開発機で不便・Linux CI は可）。JS/WASM 代替（`@mapbox/mvt` 系・
    `geojson2mvt` 等）の実現性は要調査。
  - **区域は震度集約にも使う**（`useQuakeLayerData` の点内包判定）。表示をタイル化しても集約はポリゴン幾何が要る
    → 集約用に軽量 `subregions.json` を残す二本立て、が現実的（表示＝タイル / 集約＝軽量 geojson）。
  - 動的塗りは案2同様 feature-state（vector tile は `promoteId` で安定 ID を付与）。
  - **移行直後にまた大きめの再アーキテクチャ**。EEW 問題への直接効果は限定的（ベース単体は既に健全なため）。

## 4. 推奨と段階

真因（EEW 複合の連続描画）に照らすと、**ベクタタイル化（案3）は「正しい長期アーキテクチャ」だが、いま起きている
EEW カクつきの直接解ではない**（ベース単体は健全・タイル化が効くのはコールドスタート/LOD/転送量）。
費用対効果の順は:

1. **案2（区域塗りを feature-state 化）** — EEW 問題に直撃・高精細を犠牲にしない・新ツール不要。**最優先。**
2. **案2b（連続再描画の無駄取り）** — 直交して効く。案2と併せて EEW カクつきを潰す本命。
3. **案3（PMTiles ベクタタイル）** — 長期の正攻法。コールドスタート・LOD・転送量・保守性で効くが、EEW への
   直接効果は限定的で工数中〜大。EEW を案2/2b で解消した後、腰を据えて別タスクで検討する価値がある。

## 5. 決定（2026-07-28・ユーザー判断）

**「案2＋2b を先に実施して EEW カクつきを解消し、案3（ベクタタイル）は後続の別タスクで検討する」** に決定。

- **今フェーズ**: 案2（区域塗り4コンポーネントを静的ジオメトリ＋feature-state 着色へ）＋案2b（EEW 発報中の
  連続再描画 ~54回/秒の発生源を特定し無駄な `triggerRepaint` を throttle）。高精細は一切犠牲にしない。
- **後続タスク**: 案3（PMTiles ベクタタイル化）＝描画アーキテクチャの長期正攻法。tippecanoe の Windows/CI
  ツーリング・区域集約データの二本立て・PMTiles 配信の実現性調査から着手する。EEW を案2/2b で解消した後に。
- 案1（geojson tolerance/maxzoom の底上げ）は案2 実装時に併せて検討（併用可能な軽い底上げ）。

## 6. 顛末（追記・2026-07-28）— 案2/2b は未実施のまま真因が別で解消

上記の決定後に切り分けを進めた結果、真因は「区域ジオメトリそのものの重さ」ではなく
**App の JSX 内 `Array.from(activeEEWsNoCancelled.values())` の毎レンダー新配列生成による
EEW 派生の連鎖再実行 → 同一ジオメトリの冗長 setData**であることが判明した
（[diagnosis-5](webgl-migration-hires-perf-diagnosis-5-2026-07-28.md) を参照）。

- **修正**: App 側の `useMemo` 2 か所と検知点 sink ガード。案2（feature-state 化）にも案2b（`triggerRepaint` throttle）にも
  一切手を入れずに解消した。dev 機で render 56→6/s、setData 12→0/s、塗り表示は不変を確認。
- **本書 §5 の位置づけ**: 案2/2b の実装は**行われていない**。実装コードは高精細 geojson のままで、静的化・feature-state 化は
  未実装。案2/2b は「必要になったときの選択肢」として保留。
- **案3（PMTiles ベクタタイル化）**: 未着手。EEW カクつきが上記修正で解消したため優先度は下がったが、
  コールドスタート・LOD・転送量の観点では依然として有効な選択肢として残る。
