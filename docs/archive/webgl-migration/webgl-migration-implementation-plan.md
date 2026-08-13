# 地図描画 Leaflet → MapLibre GL JS 一本化 本番移行 実装計画

> **本文書はアーカイブ（歴史資料）**。移行は 2026-07-28 に **v4.0.0** としてリリース済み（`main` タグ v4.0.0）。
> 以下のチェックボックスは起案時点の未達成表記だが、成功基準はリリース時に**実質的に達成**（実機 fps 目標
> 59-60 は最終計測で 55-57 前後まで達し、残る 3 割は別タスク扱いで受容判断）。移行作業中に発覚した
> EEW 区域塗りの冗長 setData 問題は [`webgl-migration-hires-perf-diagnosis-5-2026-07-28.md`](webgl-migration-hires-perf-diagnosis-5-2026-07-28.md)
> で v4.0.0 リリース前に解消済み。

> 起案: 2026-07-28。`docs/webgl-rendering-migration-plan.md` §7 移行戦略を段階化・具体化したもの。
> 前提となる PoC 検証は全て完了（GO 確定）。PoC の参照実装は使い捨てブランチ `worktree/feat/webgl-poc`
> の `poc/` にある。本枝 `worktree/feat/webgl-migration` は `main` から分岐。

## 戦略

地図基盤の置換は部分適用できないため、**MapLibre 版 `JapanMapGL` を `JapanMap`(Leaflet) と同一 Props で
並行実装し、フラグ behind で切替可能にしたまま、レイヤー単位でリスク順に移植・検証する**。全機能の回帰が
済むまで Leaflet を残し、最後にデフォルト切替→撤去する。移行の主眼は「**移動中の描画コスト**」
（段階0の差分更新は静止時にしか効かない・本番実データで確認済み）。安全重要アプリのため big-bang は避ける。

## 前提（PoC 確定・再検証不要）

- 全描画項目が MapLibre で成立・GO 確定（律速切り分け・非加算合成 FBO・feature-state 毎秒更新・
  複合負荷 fps59-60・カメラ MapLibre 優位・自前当たり判定）。
- テキスト=B案（グリフ PBF 自前生成・Noto Sans JP OFL・`localIdeographFontFamily:false` 必須・起動時ウォーム）。
- カスタムレイヤーの罠: `optimizeDeps.exclude:['maplibre-gl']`／maplibre-gl 6 は `import * as`／mainFBO 取得は resize 前。
- モバイル復帰・context lost 復帰はリリース後対応（ユーザー確定）。実行時メモリ30分 PASS。
- 2 バリアント（standard/DMDSS）の地図描画は共通。差はデータ側のみ。

## Leaflet pane → MapLibre レイヤー対応（描画順 = 挿入順）

MapLibre は z-index を持たず**挿入順**で重なりが決まる。現行 pane の z 順を挿入順で再現する:

| 現行 pane (z) | MapLibre レイヤー | type |
|---|---|---|
| tilePane (200) / tile-tint (220) | `gebco`（raster paint で暗色化） | raster |
| basemap (250) | `land-fill` / `sub-borders`(0.5) / `pref-borders`(1.0) | fill / line |
| quake-heat (255) | `quake-heat`（leaflet.heat 廃止→native heatmap） | heatmap |
| quake-region-fill / eew-region-fill (260-261) | 震度色塗り・LPGM 塗り | fill |
| line-layers (263-264) | `plate-boundaries` / `active-faults`（フル解像度）＋当たり判定は queryRenderedFeatures | line |
| tsunami-lines (270) / obs-bars / ps-wave (280) | 海岸線 line・観測棒・予報円カスタム | line / custom |
| kyoshin-points / quake-points (400) | 強震4種（SubThreshold は FBO カスタム）・震度点 | circle / custom |
| basemap-labels (450) | 地方/県/区域/震度ラベル | symbol（グリフ PBF） |

## 統合時のハマりどころ

- **投影**: 両者 Web メルカトル一致。`public/data/*.json` は `[lat,lng]`・GeoJSON は `[lng,lat]`＝並び替え必須。
  震源経度は `normalizeEpicenterLng`（日付変更線）を GeoJSON 変換前に適用。
- **ズーム**: 現行 `zoomSnap:0.5`。MapLibre は連続ズーム既定＝感度調整で近づける。`MAX_ZOOM=8` は camera の maxZoom で維持。
- **当たり判定**: tolerance 相当なし。`hittest.ts` の bbox＋点-線分距離（r=8px）移植。cursor は mousemove で手動切替。
- **ラベル**: DOM(divIcon)→symbol(GPU)。text-shadow グロー→`text-halo-width`+`text-halo-blur` 近似。ズーム帯排他は minzoom/maxzoom。
- **カメラ制御群**（約400行・最難関の一つ）: `FitToBounds`/`FitToEEW`/`FitToDetection`/`FitToCandidate`/
  `TsunamiFitToBounds`/`FitJapanOnEnter`/`FocusObsPoint` を MapLibre camera API へ移植。`flyToLite.ts` は撤去。
  duration 秒→ms。ユーザー操作抑制・`idleRevertSec` を同等イベントで再実装。
- **react-leaflet 除去**: `leaflet`/`react-leaflet`/`leaflet.heat`/`@types/*` 削除・`maplibre-gl` 追加。
  Leaflet 実体依存は `src/components/Map/` 配下に閉じる（App/hooks/utils は型のみ）。map ref は Context 配布へ。

## フェーズ

各フェーズは Leaflet 既定のまま独立マージ可。F2〜F6 は同一 map にレイヤーを積むだけなので順不同で並行可
（**リスク・主眼順では F3 強震点と F2 グリフを優先**）。

- **F0 足場**: `optimizeDeps.exclude:['maplibre-gl']`・エンジン切替フラグ（`MapView` が `JapanMap`/`JapanMapGL`
  を同一 Props 出し分け・既定 leaflet）・空 MapLibre 地図の骨格＋map Context。完了=フラグ ON で空地図表示・tsc0・既定無変更。
- **F1 ベース+カメラ**〔高〕: GEBCO raster＋暗色化・行政区域 fill/line（座標変換）・カメラ制御群移植。完了=背景+区域が現行同等・カメラ現行同等（実機計測）。
- **F2 ラベル**〔高〕: グリフ生成本番化（Noto・`scripts/build-glyphs.mjs`・SW precache `**/*.pbf`）・symbol レイヤー
  （`glyphs`＋`localIdeographFontFamily:false`・起動時ウォーム）。**新規未解決を確定**: 自動ズームは `MAX_ZOOM=8`＝
  県帯(7.5–9)止まりで区域(≥9)へ直行しない→区域 cold 95ms は主に手動ズーム時。F2 実機計測で区域ウォーム/表示遅延の要否を決める。
- **F3 強震点4種**〔高・主眼〕: KyoshinPoints(circle・feature-state毎秒更新)・SubThreshold(FBO 非加算合成)・
  DetectedPoints・MaxEffect(波紋)。完了=非加算合成が現行 SVG と目視一致・**パン中も軽い**・毎秒 fps59-60。
- **F4 線+当たり判定**〔中〕: 活断層/プレート境界 line（フル解像度）・bbox＋点-線分距離当たり判定・Popup。
- **F5 地震モード**〔中〕: 震度 circle・区域集約 fill＋ラベル・LPGM・震源×・native heatmap。完了=地震テストで現行同等。
- **F6 津波・EEW・予報円**〔高・複合負荷の核〕: 津波 line＋点滅＋観測棒・EEW 区域塗り・予報円カスタム(`eew-composite.ts`移植・
  flyTo 中停止の緩和維持)・EEW 震源。完了=EEW/津波テスト全種現行同等・**複合負荷で実機 fps59-60**。
- **F7 切替・撤去**: 全機能回帰→フラグ既定を MapLibre へ→Leaflet 一式・`flyToLite.ts`・`mapCanvasPadding.ts`・
  関連 CSS・依存削除→間引き緩和→README/CLAUDE.md のペイン名等を MapLibre 基準へ更新。

## 依存グラフ

```
F0 → F1 ┬→ F2(ラベル) ├→ F3(強震・主眼) ├→ F4(線+hit) ├→ F5(地震,一部F2依存) └→ F6(津波EEW,F3/F4依存)
F2〜F6 完了 → F7(撤去)
```

## テスト戦略

- 型チェック（必須・各フェーズ tsc0）。
- ブラウザ確認（必須・`npm run dev:dmdss`→`/dmdss/`・フラグ ON・Playwright MCP・コンソールエラー0・設定タブのテストボタンで回帰）。
- 実機計測（F1・F2・F3・F6 で必須・PoC の `scripts/perf` を本体へ流用・Surface Go 2 で Leaflet 版と同条件比較）。
  F3=パン中の軽さ・F6=複合負荷。

## 成功基準

- [ ] フラグで Leaflet↔MapLibre 無停止切替・各フェーズ独立マージ可
- [ ] 全レイヤーが現行と見た目・挙動同一
- [ ] **パン中含め**強震毎秒更新が実機 fps59-60（主眼）
- [ ] EEW 複合シナリオで実機 fps59-60
- [ ] フル解像度化後も実機で現行以上に軽い
- [ ] 両バリアント・GitHub Pages サブパスで動作・コンソールエラー0
- [ ] react-leaflet 依存完全除去・ドキュメント整合

## 参照

- PoC 参照実装（使い捨て枝 `worktree/feat/webgl-poc` の `poc/`）: `subthreshold.ts`(FBO 合成)・
  `realtime.ts`(feature-state)・`hittest.ts`(当たり判定)・`label.ts`(グリフ B案)・`eew-composite.ts`(複合)。
- 設計・実機計測の記録: 本 docs/ の `webgl-*.md`（PoC 枝からコピー）。
