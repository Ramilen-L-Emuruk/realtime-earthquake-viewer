# レビュー: `ddb761a`・`d33ef0d`（データ駆動診断・アーキテクチャ検討・内訳切り分け）

> 前提: [webgl-migration-hires-perf-diagnosis-2-2026-07-28.md](webgl-migration-hires-perf-diagnosis-2-2026-07-28.md)
> の「予報円成長への反復flyTo」仮説（未確定）への回答コミット。
>
> **ステータス: 指摘なし。診断の質が一段上がった。**

---

## 1. `ddb761a`（`moveendCount`/`renderCount`計測フック・ベクタタイル検討）

### データ駆動での仮説決着

- **`moveendCount`**で反復flyTo仮説を直接否定（開発機で1回と確認）。前回私が提案した「flyToBounds発火回数を数える」という診断方針を正しく実装している。
- **`renderCount`/`renderPerSec`**でEEW発報中はカメラ静止でも約54回/秒の全体再描画が発生していることを機種非依存に捕捉。これが真因の決め手になっている。
- 実装（`map.on('moveend'/'render', ...)`・`measureWindow`終了時に`.off()`で解除）に問題なし。

### アーキテクチャ検討（`webgl-vector-tiles-investigation-2026-07-28.md`）

- **MapLibreのgeojsonソースが既に`geojson-vt`で実行時タイル化されている**という前提は技術的に正確
  （MapLibreの実装として広く知られている挙動）。「事前ベクタタイル vs 現状geojson」の差を
  実力以上に大きく見積もらず、冷静に効果を切り分けている。
- **区域塗りを静的ジオメトリ＋`setFeatureState`着色に変更する案（案2）**は、この種の動的choropleth
  表示に対するMapLibreの標準的な正攻法。発報のたびの`setData`再タイル化を排除できる。
- **区域データが震度集約の点内包判定にも使われる制約**（`useQuakeLayerData`）を認識し、
  「表示用はタイル化・集約用は軽量geojsonの二本立て」という現実的な構成を提案している——
  安易に「全部ベクタタイル化すればいい」と早合点していない。
- 優先順位（案2+2b先行・案3=PMTilesは後続別タスク）の根拠（「ベース単体は既に健全なためEEW問題への
  直接効果は限定的」）は、実機計測の対照結果と整合している。

## 2. `d33ef0d`（`eew-nofills`内訳切り分け）

**前提の検証**: 「予報円は自前canvas・震源はHTMLマーカーでWebGL描画の外」という主張を実装で確認した。

- `PsWaveGL.tsx`: `document.createElement('canvas')`で独立した2Dオーバーレイcanvasを
  `map.getCanvasContainer()`に追加・`getContext('2d')`で描画。MapLibreのWebGL描画パイプライン外。
- `EpicenterGL.tsx`: `maplibregl.Marker`（DOM要素）を使用。同じくWebGL描画パイプライン外。

したがって「`eew-static`と`eew-nofills`の差＝区域塗りレイヤーのper-renderコスト」という
切り分けの前提は正確であり、この対照実験は狙い通り区域塗りのコストを単離できる設計になっている。

視点座標をEEW予想震度塗りが実際に画角に入る震源近傍`[141.0, 38.3]`z7に修正した点も、
開発機での事前確認（`eew-static`でeewFill29件・`eew-nofills`で0件・landは両者59件で同一視点）を
伴っており、対照実験として成立する条件を満たしている。

---

## 3. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| moveend/renderフックの実装 | `map.on`/`map.off`の対応とmeasureWindow内の配置を確認 | リーク無く正しく実装 |
| 「予報円/震源はWebGL外」の前提検証 | `PsWaveGL.tsx`・`EpicenterGL.tsx`のソースを確認 | canvas 2D・DOM Markerと確認、前提は正確 |
| MapLibreのgeojson実行時タイル化の主張 | 検討文書の記述内容を確認 | 技術的に正確な前提に基づく検討 |
| 区域データの二重用途（表示/集約）への配慮 | 検討文書§3案3の記述を確認 | 二本立て構成を提案し早合点を回避 |
| 型チェック | `npx tsc -b` | エラー0 |
