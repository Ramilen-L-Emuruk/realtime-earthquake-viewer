# 根本原因の確定と修正 — EEW 区域塗りの冗長 setData による連続再描画

> 前提: [diagnosis-4](webgl-migration-hires-perf-diagnosis-4-2026-07-28.md)
> （時系列相関で「flyTo 中の重なり」仮説を否定・着地後の静止期がほぼ全ブロックと判明）。
> 本書は diagnosis-4 の「静止×複合負荷がなぜここまで重いのか」を dev 機での直接プローブで詰め、
> **根本原因を確定し修正・検証まで行った**記録。
>
> **結論: 真因は「EEW 区域塗りソース（eew-region-fill / eew-lpgm-region-fill）への完全に同一な
> 高精細ジオメトリの冗長 setData（EEW 中 ~12/s）」だった。これが geojson-vt のワーカー再タイル化と
> タイル再読込（_reloadTile ~150/s）を連鎖的に起こし、毎フレーム `_sourcesDirty` を立てて MapLibre に
> 自己再描画を予約させ続け、EEW 静止でも連続飽和（render ~56/s）していた。元をたどると App が
> eews 配列を JSX 内 `Array.from(...)` で毎レンダー生成しており、psWave 更新（100ms）で App が
> 再レンダーするたびに参照が変わって全 EEW 派生 useMemo/effect が再実行されていた。useMemo 2 か所と
> 検知点の sink ガードで修正。dev 機で render 56→6/s、setData 12→0/s、塗り表示は不変を確認。**

---

## 1. 切り分けの経路（dev 機・実アプリへの直接プローブ）

diagnosis-4 で「flyTo 中でなく着地後の静止期が重い」まで判明。そこから MapLibre の自己再描画条件を潰した:

| 検証 | 結果 |
|---|---|
| `hasTransitions()`（paint トランジション） | EEW 中も **0%**。トランジション駆動ではない |
| `_placementDirty`（シンボル配置/フェード）・`_styleDirty`・`_repaint` | いずれも **0**。配置フェードでもない |
| `_sourcesDirty` | EEW 中 **43% 継続 true**。これが自己再描画の予約源 |
| triggerRepaint 呼び出し元 | 全て `yp._render`（MapLibre 自身）＝ `_sourcesDirty` を見て自己予約 |
| `_sourcesDirty` を true 化する経路 | `fire`（source 'data' イベント）← `_tileLoaded`/`_updateWorkerData`/`_reloadTile` ＝ **タイル再読込ループ** |
| ソース別 reload 計数（EEW 中 2s） | `eew-region-fill`: `_updateWorkerData` 28・`_reloadTile` **300**／`eew-lpgm-region-fill` 同様。他は僅少 |
| eew-region-fill の setData payload（24回/2s） | **全て byte 一致（uniq=1）**・21 区域 5327 頂点＝完全に冗長 |

さらに容疑から外したもの: **PsWaveGL**（rAF でなくイベント駆動・テスト EEW では psWave 空・地図 render を起こさない）、
**KyoshinMaxEffectGL の波紋**（レイヤーに feature 0・rAF は波紋生存中のみ）、**震源 HTML マーカー**（CSS アニメは
地図再描画を起こさない）、**KyoshinSubThresholdGL カスタムレイヤー**（毎秒 1 回の triggerRepaint のみ）。

## 2. 根本原因

```
App.tsx: eews={Array.from(activeEEWsNoCancelled.values())}   ← JSX 内で毎レンダー新配列（未メモ化）
  ↑ App の再レンダー頻度で churn:
     ・平常 ~2/s（1秒クロック + kyoshin 更新）
     ・EEW 中 ~12/s（useDmdssWaves の psWave 更新 UPDATE_INTERVAL_MS=100ms）
  → useEewLayerData の eewAreaFills(useMemo[eews,…]) が中身同一のまま再計算（新配列）
  → EewRegionFillGL / EewLpgmRegionFillGL の [map, areaFills] effect が発火
  → 同一の高精細ジオメトリ（5327 頂点）を ~12/s setData
  → geojson-vt がワーカーで再タイル化 → _reloadTile ~150/s → 'data' 連発 → 毎フレーム _sourcesDirty
  → MapLibre が自己再描画を予約し続ける（EEW 静止でも render ~56/s の連続飽和）… 増幅器①
  → 各フレームで高精細塗り（~15ms）を描画 … コスト②
  → weak GPU で飽和 → カクつき
```

`activeEEWsNoCancelled` 自体は `useMemo([activeEEWs])` で安定（psWave tick では不変）。よって **churn の唯一の
原因は `Array.from(...)` を JSX 内で呼んでいて参照が毎レンダー変わること**だった。

## 3. diagnosis-3 の謎の解消

diagnosis-3 は「eew-nofills（塗りを消す）でも重い＝塗りは主因でない」とした。実際は **eew-nofills が塗り
レイヤーを `visibility:none` にしただけで、ソースの setData churn（＝再タイル化・連続再描画の駆動）は
止めていなかった**ため。可視ジオメトリ量でなく「同一データの冗長 setData」が真の駆動だった。

## 4. 全ソース横断監査（過剰更新の網羅確認）

3 モード（kyoshin 平常／EEW 中／quake）で全 GeoJSON ソースの setData・setFeatureState を計数した結果、
**過剰更新は EEW 区域塗り 2 本に集中**。他（quake 区域塗り・kyoshin 点・ベースマップ・ラベル・活断層・
プレート境界・津波）は**実データ変化時のみ**更新。kyoshin-detected のみ ~2/s の軽微な冗長（小 payload）。

## 5. 修正

- **App.tsx**: 地図・パネルへ渡す eews を `useMemo` で参照安定化
  （`eewsForMap=useMemo([activeEEWsNoCancelled])` / `eewsForPanel=useMemo([activeEEWs])`）。
  EEW データが実際に変わったときだけ配列を作り直し、psWave の 100ms tick では参照を維持する。
- **KyoshinDetectedPointsGL.tsx**: `points` は kyoshinView が indices tick（毎秒）で作り直されるため、
  構築 FC が前回と同一なら setData をスキップする sink ガードを追加（source 再生成時は署名リセット）。

## 6. 検証（dev 機・EEW 静止・EEW特別警報テスト）

| 指標 | 修正前 | 修正後 |
|---|---|---|
| EEW 区域塗り setData | 12/s ×2 本（全冗長） | **0/s** |
| render（EEW 静止） | 56〜58/s（連続飽和・飽和比 1.0） | **6/s（アイドル）** |
| EEW 区域塗り表示 | 29 feature | **29 feature（維持）** |

- 型チェック `npx tsc -b`：0 エラー。スクリーンショットで塗り／震源×／P波円／EEW カード 正常・**視覚回帰なし**。
- コンソールエラーは Yahoo 強震モニタ 403（良性）のみ。

## 7. 残件・次の一手

- **実機（Surface Go 2）で修正後の再計測**が最終確認。連続再描画が消えたので、`maxload-eew`/`eew-static` の
  `blockWhileStillMs`・longtask が実際に落ちるはず（dev 機は GPU 律速でないため render 頻度でしか見えない）。
  時系列フック（diagnosis-4）でそのまま裏取り可能。
- **②（塗りの 1 フレームコスト ~15ms の LOD 軽量化）は優先度低下**。連続再描画が消えたことで、塗りコストは
  実 EEW の続報更新時とカメラ操作時のみの一過性コストになる。実機で①の効果を見てから要否を判断する。

---

## 8. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| 自己再描画の予約源 | `_sourcesDirty`／triggerRepaint 呼び出し元を EEW 中にサンプル | `_render` 自己予約・`_sourcesDirty` 43% と確認 |
| dirty 化の経路 | `_sourcesDirty` セッターのスタック採取 | tile reload（`_reloadTile`/`_updateWorkerData`）の 'data' イベント発と確認 |
| 犯人ソースの名指し | ソース別に `_updateWorkerData`/`_reloadTile` を計数 | eew-region-fill / eew-lpgm-region-fill と特定 |
| 冗長性 | setData payload 署名を 24 回突合 | 全 byte 一致（uniq=1・完全冗長）と確認 |
| 根因のコード特定 | App.tsx の eews 生成と useEewLayerData の依存を読解 | JSX 内 `Array.from` 未メモ化が唯一の churn 源と確認 |
| 修正効果 | 修正後に render/s・setData/s・塗り feature 数を再計測 | 56→6/s・12→0/s・塗り 29 維持と確認 |
| 過剰更新の網羅 | 3 モードで全ソース setData/setFeatureState を計数 | 過剰更新は EEW 塗り 2 本のみと確認 |
