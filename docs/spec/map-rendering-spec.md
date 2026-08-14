# 地図描画仕様書

> 本書は**現在の実装が地図をどう描画するか**をまとめた仕様書。実コードと食い違う場合は実コードを正とする。
> 関連: [`architecture-spec.md`](architecture-spec.md) の全体構成、各情報の描画詳細は
> [`eew-spec.md`](eew-spec.md) / [`tsunami-spec.md`](tsunami-spec.md) / [`quake-spec.md`](quake-spec.md)。

## 1. 概要

MapLibre GL JS v6（WebGL 描画）で地図を表示する。全レイヤーが WebGL / DOM Marker のいずれかで実装され、
ラスタタイル画像は最小限（背景の海底地形のみ、オプショナル）。地図モードは 3 種類:

- `quake` — 地震情報タブで表示（観測点ドット・区域塗り・震源）
- `tsunami` — 津波情報タブで表示（海岸線・観測バー）
- `kyoshin` — リアルタイム震度タブで表示（強震モニタドット・EEW 予想塗り・予報円）

## 2. モード決定

`App.tsx` で `mapTab` から派生:

```ts
const mapMode = mapTab === 'tsunami' ? 'tsunami'
              : mapTab === 'realtime' ? 'kyoshin'
              : 'quake'
```

`JapanMapGL` は `mode` prop を受け取り、各レイヤーコンポーネントに visible prop を配る。

**EEW 予想レイヤーの kyoshin モード限定**: `eew-region-fill` / `eew-lpgm-region-fill` は kyoshin モードでのみ
描画される。担保は `JapanMapGL` の JSX の `visible={mode === 'kyoshin' && ...}` で行う（フック側は
モード非依存で計算する設計）。地震情報タブでの実測と予想が同じ配色で見分けにくくなる問題を避けるため。

**EEW 震源×印は全モード表示**: 発報中の震源位置だけは常に地図に載る（kyoshin 以外では半透明 0.4 で薄く）。

## 3. レイヤー順（描画順の単一情報源）

`src/components/Map/gl/layerOrder.ts` の `MAP_LAYER_ORDER` 配列が単一情報源。背面 → 前面の順。

各レイヤーコンポーネントは `addOrderedLayer(map, layer)` で追加する。この関数は `MAP_LAYER_ORDER` で
自分より前面に来るべき id の直前に挿入するため、データ到着タイミングに依存せず順序が保証される。

配列に無い id は最上段に積まれる（警告なし）。新レイヤーを足すときは配列への登録を忘れないこと。

**カスタムレイヤーの注意**: MapLibre の `type: 'custom'` レイヤー（現状 `kyoshin-subthreshold`・`pswave`）は
`getStyle().layers` に現れない。順序確認は `map.style._order` を見る。

## 4. ベースマップ

`BaseMapGL` が担当。以下を描画:

- 陸地塗り
- 都道府県境界（`prefectures.json`）
- 一次細分区域境界（`subregions.json`）
- 海底地形（GEBCO ラスタタイル・任意）

タイル取得は不要で、全て事前生成された GeoJSON から自前描画する。海底地形タイルは唯一の外部ラスタで、
設定で ON/OFF 切替可能。

**ズームアウト時の非表示化**: 都道府県境界・一次細分区域境界（`BaseMapGL`）と活断層（`ActiveFaultsGL`）は、
`gl/zoomLevels.ts` の `DETAIL_MIN_ZOOM`（3.5）を下回るズームでは描画しない（線を簡略化するのではなく
レイヤーごと消す）。遠地地震のフィットのように世界規模まで引くと、これらの線が潰れて列島が塗り潰された
塊になるため。陸地塗りとプレート境界は対象外で、引いた画でも列島の位置は分かる。
なお通常の日本全体表示は地図の幅で決まり、スマホ幅（375px）で約 3.8・デスクトップで約 5.0 のため、
どちらも従来どおり描画される。

**地形先読み**: `src/utils/gebcoPrefetch.ts` が沖縄〜択捉相当の低ズームタイルをアイドル時に
バックグラウンド fetch する。GEBCO は 256px タイルのソースなので MapLibre が要求するタイル z は
マップズーム +1 になる（§6 のズーム基準とは別の座標系）。先読み範囲もタイル座標系で決めるため、
`MAX_ZOOM` をそのままタイル z として使わないこと。

## 5. ラベル描画（`LabelsGL`）

- 地方名・県名・区域名を symbol + icon-image で描画
- ズーム帯で表示粒度を切替（低ズームは地方名、高ズームは区域名）
- 事前生成 **SDF グリフ**（Noto Sans JP・`public/fonts/`）を使用
  - **SDF**（Signed Distance Field / 符号付き距離場）: 文字の輪郭を「各ピクセルから輪郭までの符号付き距離」として保存する画像形式。拡大縮小してもエッジが滲まないため MapLibre GL の文字描画に採用されている
- グリフ生成スクリプト: `scripts/build-glyphs.mjs`（`@mapbox/tiny-sdf` で焼く）
- 震度バッジ・観測点ドット等のマーカーと画面上で実際に重なっている間は `text-opacity` を下げる
  （`src/components/Map/gl/labelOverlap.ts` の `queryRenderedFeatures` ベース判定）

## 6. カメラ制御（`CameraFollowsGL`）

以下のシチュエーションでカメラを自動フィットする:

- 地震カード選択時 → 該当地震の震源＋主要観測点を含む範囲
  - **遠地地震**（[`quake-spec.md`](quake-spec.md) §3）は国内で震度を観測せず対象が震源 1 点だけになるため、
    離島を含む日本全体の枠（`gl/bounds.ts` の `JAPAN_WIDE_BOUNDS`）を合成してフィットする
- 揺れ検知時（confirmed） → 検知メンバー観測点のフットプリント
- EEW 発報時 → 震源＋警報区域を含む範囲（**kyoshin モード時のみ**。下記「既知の限界」参照）
- 津波情報表示時 → 対象海域を含む範囲

**寄り上限とズーム値の基準**: 自動フィットが寄る上限は `gl/camera.ts` の `MAX_ZOOM`（現在 7）。
MapLibre GL JS のズームは 512px タイル基準で数えるため、Leaflet（256px 基準）の同じ数値より 1 段深い
（MapLibre の z は Leaflet の z+1 相当）。コードに書くズーム値は常に MapLibre 基準に統一し、Leaflet 版
から値を移す場合は 1 段引く。`MAX_ZOOM` を変えるときは、同じ基準で揃えている以下も併せて見直すこと:

- ラベル粒度の切替帯（§5・値は `LabelsGL.tsx` の定数）
- 細線を消す下限ズーム（§4。`gl/zoomLevels.ts` の `DETAIL_MIN_ZOOM`）
- 震度の区域集約の閾値（[quake-spec.md](quake-spec.md) §7。`MAX_ZOOM` から導出しており独自の値を持たない）
- ヒートマップの収束ズーム（`QuakeHeatmapGL` の `HEAT_MAX_ZOOM`）
- 地形先読みの最大タイル z（§4。タイル座標系なので `MAX_ZOOM` そのものではない）

**ユーザー操作の尊重**: `gl/camera.ts` の `ensureUserInteractionState` が `zoomstart`・`dragstart` を
購読し、ユーザーが地図を操作している間は自動フィットを抑制する。

**明示選択によるバイパス**: 上記の抑制は「電文更新起点の自動追従」を対象とした挙動であり、
ユーザー自身が明示的に選択した操作（地震カードのクリック・津波タブから地震情報へのリンク）は
抑制の対象外として扱う。App 側の `quakeSelectionTick` が明示クリック時のみ +1 され、
`QuakeFitGL` はこの tick が進んだフレームでは `isUserInteracting` を無視して強制フィットする。
EEW も同様に「新規 EEW 受信時は `resetUserInteraction()` してからフィットする」（`FitToEEWGL`）
という同種のバイパスを持つ。

**カメラの重複制御**: `beginProgrammaticFlight` / `isProgrammaticFlight` カウンタで自動アニメーション中の
判定を持ち、重複した flyTo/fitBounds が壊れないようにする。

**既知の限界（MAP-5）**: EEW 追従の `FitToEEWGL` は `mode === 'kyoshin'` のときのみマウントされる。
kyoshin モードから tsunami/quake モードへ切り替えるとアンマウントされ、以降その EEW を追従できない。
初回の敵対的レビューで「常時マウント化」を試みたが、`QuakeFitGL`/`TsunamiFitGL` との flyTo 争い・
EEW 解除後の他モード帰還が未実装等の副作用が広範に発生することが判明し revert した。正しい修正には
mode を全 Fit*GL に配って優先度で調停する大規模リファクタが必要で、スコープ外とした。

## 7. mode 別レイヤー一覧

### quake モード
- `BaseMapGL`（ベース）
- `QuakeHeatmapGL`（ヒートマップ・任意）
- `QuakeRegionFillGL`（区域塗り＋区域中心震度バッジ）
- `QuakeIntensityPointsGL`（観測点ドット）
- `LpgmPointsGL` / `LpgmRegionFillGL`（長周期・DMDSS 版のみ）
- `EpicenterGL`（震源×印）
- `EewEpicentersGL`（EEW 震源×印・全モード表示だが kyoshin 以外は半透明）
- `LabelsGL`（地名ラベル）
- `ActiveFaultsGL` / `PlateBoundariesGL`（任意）

### tsunami モード
- `BaseMapGL`
- `TsunamiLinesGL`（海岸線・等級色・点滅）
- `TsunamiObsBarsGL`（観測点バー）
- `EewEpicentersGL`（EEW 震源×印）
- `LabelsGL`

### kyoshin モード
- `BaseMapGL`
- `KyoshinSubThresholdGL`（震度 0 以下ドット・カスタムレイヤー）
- `KyoshinPointsGL`（震度 1+ 観測点）
- `KyoshinDetectedPointsGL`（揺れ検知点ハイライト）
- `KyoshinMaxEffectGL`（最大震度エフェクト・rAF アニメ）
- `EewRegionFillGL`（EEW 予想震度塗り・kyoshin 限定）
- `EewLpgmRegionFillGL`（EEW 予想長周期塗り・kyoshin 限定）
- `PsWaveGL`（P/S 波予報円・カスタムレイヤー・100ms 更新）
- `EewEpicentersGL`（EEW 震源×印）
- `ActiveFaultsGL` / `PlateBoundariesGL`（任意）
- `LabelsGL`

## 8. 毎秒更新レイヤー（強震モニタ 1Hz）

Yahoo リアルタイム震度は 1 秒毎に更新される。以下のレイヤーが毎秒 setData / setFeatureState する:

- `KyoshinPointsGL` — 各観測点の feature-state を更新
- `KyoshinSubThresholdGL` — カスタムレイヤーで indices バッファを更新して triggerRepaint
- `KyoshinMaxEffectGL` — 波紋 rAF アニメ
- `KyoshinDetectedPointsGL` — 検知点の GeoJSON を setData

**トランジション対策**: MapLibre GL v6 は全 paint プロパティに既定 300ms トランジションが付く。
毎秒更新するレイヤーで painter の値が動く場合、`-transition: { duration: 0 }` を明示的に設定して
アニメーション残像・点滅を防ぐ。過去に津波点滅（v4.1.1）と強震モニタ（v4.2.2）で 2 回踏んだ実績あり。

## 9. パフォーマンス上の要点

### setData churn 対策
- 同じデータでの setData は避ける（React で参照同一性を保つよう useMemo で囲む）
- 過去に `App.tsx` の `Array.from(activeEEWs.values())` を毎レンダー生成していて fps 17→55 の劣化を起こした事故あり

### rAF の停止
- `KyoshinMaxEffectGL`・`TsunamiLinesGL`（点滅）・`PsWaveGL` は `requestAnimationFrame` を使う
- 停止条件（`activeEEWs.length === 0` 等）で `cancelAnimationFrame` を呼ぶ
- コンポーネント unmount 時にも cleanup が必要

### カスタムレイヤーの GL リソース
- `KyoshinSubThresholdGL` は **FBO 二層合成**で「同レベルドットの重畳を非加算合成」を実現
  - **FBO**（Framebuffer Object）: 画面ではなくオフスクリーンのテクスチャに描画するための WebGL の仕組み。1 層目に「その点が塗られているかどうか」を書き込み、2 層目でその結果を通常の paint に合成することで、同じ震度階級のドットが何個重なっても濃くならないブレンドを実現している
- `PsWaveGL` は `type: 'custom'` のカスタムレイヤーで、内部でオフスクリーンの 2D canvas に円を描画してから `gl.texImage2D` で WebGL テクスチャに転送する構造（旧実装は `getCanvasContainer` 上の DOM Canvas オーバーレイだったが、カスタムレイヤー方式に置換済み）

### 大量マーカーの実装方針
- 座標に強く紐づく DOM 要素（震源×印・観測バー）は `maplibregl.Marker` を使う
- それ以外は GL レイヤー（circle / fill / line / symbol）で描画

## 10. maplibregl.Marker の注意点

`maplibregl.Marker` の不透明度は **`element.style.opacity` ではなく Marker のオプション**
（`opacity` / `opacityWhenCovered`）で渡す。Marker は「地形に隠れたとき薄くする」機能があり、
これが element の style.opacity を自前で上書きするため、cssText 経由の設定は無視される。

`opacityWhenCovered` を省くと地形有効時に既定 0.2 が効くため、隠蔽時も同じ濃さにしたいなら同値を渡す。

## 11. デバッグ用の公開

`window.__mapGL`（`JapanMapGL` が露出）から map インスタンスに直接アクセスできる。本番ビルドでも有効。

- ソース内容の集計: `await map.getSource(id).getData()`
- レイヤーの表示切替確認: `map.getLayoutProperty(id, 'visibility')`（未設定＝表示）
- レイヤー順の確認: `map.style._order`

**注意**: `source._data` は MapLibre v6 に存在しない（undefined を空データと誤読しがち）。
`queryRenderedFeatures` / `querySourceFeatures` はビューポート内のタイルに限られるため全件集計には使えない。

## 12. WebGL コンテキストロスト

MapLibre v6 は WebGL コンテキストロスト時、内蔵レイヤーは `_contextRestored` の
`setStyle(style, {diff:false})` 経由で復元するが、custom レイヤーは復元しない
（公式コードが `console.warn("Custom layer ... cannot be restored")` で明示）。

本アプリでは `map.on('webglcontextrestored', ...)` を各 custom レイヤーコンポーネントで購読し、
restore 時に手動で `addOrderedLayer` 経由で再追加する:

- `pswave`（`PsWaveGL.tsx`）: 同一の `customLayer` オブジェクトを再追加。onAdd が新しい gl から
  program/buffer/texture 参照を作り直す。
- `kyoshin-subthreshold`（`KyoshinSubThresholdGL.tsx`）: `makeSubThresholdLayer` で
  レイヤーオブジェクトごと作り直し、成功後に `layerRef` を差し替えて setLevels/setIconScale/setVisible の
  窓口を維持する。restore 直後にマウント時点の値ではなく現在の props/直近 levels を再適用する
  （`iconScaleRef` / `visibleRef` / `levelsRef` で保持）。

### タイミング設計上の注意

MapLibre v6 の `_contextRestored` は `setStyle(..., {diff:false})` を呼んだ直後、**同じ同期実行内**で
`webglcontextrestored` を発火する。この時点で新しい `Style` は `_load()` が次フレームまで遅延され
`_loaded=false` のため、直接 `addLayer` を呼ぶと `_checkLoaded` が `Error: Style is not done loading.`
を投げる。さらに MapLibre の `Evented.fire` はリスナー単位で try/catch しないため、1 つの例外が
後続の custom layer のハンドラを止めうる。

対策:
- `map.isStyleLoaded()` を確認し、false のときは `map.once('style.load', ...)` で待ってから追加
- 各コンポーネントで try/catch し、失敗は `log.error` で記録（他 custom layer のハンドラは巻き添えにしない）

モバイル常駐 PWA で GPU リソース回収時（バックグラウンド長時間放置後の復帰・端末リソース逼迫）に
発生しうる。

## 13. 関連実装ファイル

- `src/components/Map/JapanMapGL.tsx` — 地図の中枢（初期化・スタイル・全レイヤー配線）
- `src/components/Map/MapView.tsx` — App との仲介
- `src/components/Map/mapGLContext.ts` — map インスタンス購読
- `src/components/Map/mapTypes.ts` — Props 型定義
- `src/components/Map/CameraFollowsGL.tsx` — カメラ自動追従
- `src/components/Map/gl/` — 補助ユーティリティ
  - `layerOrder.ts` — 描画順の単一情報源
  - `camera.ts` — カメラ操作・ユーザー操作検知
  - `bounds.ts` — 追従範囲の合成・包含判定
  - `zoomLevels.ts` — 複数レイヤーで共有する表示ズーム閾値（`DETAIL_MIN_ZOOM`）
  - `labelOverlap.ts` — ラベルの重なり検知
  - `popupRegistry.ts` — ポップアップの当たり判定調停
  - `popupHtml.ts` — ポップアップ HTML 生成
  - `geojson.ts` — GeoJSON 生成ヘルパー
  - `subThresholdLayer.ts` — 震度 0 ドットのカスタムレイヤー
  - `fontStack.ts` — グリフスタック設定
  - `intensityIcons.ts` / `lpgmIcons.ts` / `kyoshinDetectedIcons.ts` — 事前ラスタライズアイコン

## 14. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
