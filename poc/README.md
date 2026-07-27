# 層B PoC — MapLibre 律速切り分け（使い捨て）

地図描画 MapLibre 一本化（`docs/webgl-rendering-migration-plan.md`）の **層 B = フル解像度の線/面の描画負荷** について、
律速が **CPU（頂点処理）** か **GPU フィルレート（塗り面積）** かを実機で切り分けるための使い捨て PoC。
本体（React/Leaflet）とは独立して動く。

## 構成

| ファイル | 役割 |
|---|---|
| `poc/index.html` / `poc/main.ts` | 素の maplibre-gl で 背景(GEBCO raster)＋活断層(line)＋観測点(circle) を描画。3軸を実行時に切替 |
| `poc/measure.ts` | 静止/パン/ズームのフレーム時間・longtask 計測ランナー（層B）＋検証項目3（カメラ操作）の flyTo/fitBounds 計測。証跡を `/__perf-report` へ送る |
| `poc/hittest.html` / `poc/hittest.ts` | 検証項目4: bbox方式（`queryRenderedFeatures`でブロードフェーズ）＋点-線分距離の円判定（ナローフェーズ）の当たり判定 PoC。既知の直線でオフセット距離を制御して検証 |
| `poc/label.html` / `poc/label.ts` | §8「テキスト描画」: glyphs未設定・text-fontにOS日本語フォント名のみでラベルが描けるかの検証 |
| `poc/webglMemoryTracker.ts` | §8「実行時メモリ」: WebGLコンテキストをプロキシしバッファ/テクスチャ確保量を推定するユーティリティ。`poc/main.ts` に統合済み |
| `vite.poc.config.ts` | PoC専用の最小 vite（react/PWA/サブパスを外す。`optimizeDeps.exclude:['maplibre-gl']` で GeoJSON worker を有効化） |
| `scripts/perf/build-active-faults-full.mjs` | フル解像度活断層(31,646頂点)生成。thin(9,874頂点) は本体の `active-faults.json` |

## 起動（開発機）

```bash
npm run dev:poc -- --host --port 5180
```

（`dev:poc` = `vite --config vite.poc.config.ts`。`--host` で LAN 公開する。）

- 開発機で開く: `http://localhost:5180/poc/index.html`
- 実機で開く: `http://<開発機のLAN IP>:5180/poc/index.html`

## 実機計測手順（Surface Go 2）

1. 開発機で上記を `--host` 付きで起動する。
2. 実機の Edge/Chrome で `http://<開発機のIP>:5180/poc/index.html` を開く。
   地図・**赤い活断層線**・**灰色の観測点**が出るのを確認する（出ない場合は下記トラブルシュート）。
3. DevTools コンソールで次を **1回** 実行する:
   ```js
   await window.__runLayerBSuite('surface-go2')
   ```
4. **冒頭に全整数ズームのウォームアップ**（z4〜7・非計測。geojson-vt 再タイル化の交絡を除く）を挟み、
   baseline（静止/パン/ズーム）＋各軸（パン/ズーム）＋末尾に `baseline-warm` 対照を順に自動計測し、
   開発機の `scripts/perf/results/perf-*-surface-go2-*.json` へ自動保存される
   （19計測・各10秒＋faults 切替時の追加ウォームアップで全体 約3.5分）。進行は `[layerB]` コンソールログで分かる。

補助:
- 単発計測: `await window.__measureLayerB({ phase:'pan', durationMs:10000, label:'xxx' })`
- 右上の UI で手動に軸（活断層 full/thin・線幅・pixelRatio・観測点 on/off）を変えられる。

## 検証項目3: カメラ操作（flyTo/fitBounds）スイート

`poc/index.html`（`poc/main.ts`/`poc/measure.ts`）と同じページで実行する。本番の flyTo パターン
（`JapanMap.tsx`調査: 単一点は zoom=8 固定、複数点フィットは padding 60/48/20、duration 0.8秒(EEW系)/
1.0秒(それ以外)）を再現し、flyTo/fitBounds 呼び出し〜`moveend` までのフレーム時間・longtask を計測する。

```js
await window.__runCameraSuite('surface-go2-camera')
```

補助:
- 単発計測: `await window.__measureCameraFly({ kind:'point', durationSec:0.8 })` /
  `await window.__measureCameraFly({ kind:'bounds', padding:60, durationSec:1.0 })`
- 右上 UI の「flyTo試験」「fitBounds試験」ボタンでも単発実行できる。

### Leaflet 側の同条件比較（項目3 の GO/NO-GO 判定に必須）

MapLibre 側だけでは優劣を判定できない（実機で MapLibre がカメラ操作中に vsync 天井を破ったが、
比較対象が無い）。`poc/leaflet-index.html`（`poc/leaflet-main.ts`/`poc/leaflet-measure.ts`）で、
上記 `__runCameraSuite` と **apples-to-apples**（同一の GEBCO＋活断層＋観測点構成・同じ flyTo パターン・
同形式のラベル）の Leaflet 版カメラ計測を実行できる。座標順（Leaflet は `[lat,lng]`）と duration 単位
（Leaflet は**秒**）だけ Leaflet 仕様に合わせてある。

```js
await window.__runLeafletCameraSuite('surface-go2-leaflet-camera')
```

先頭で `static` を1回踏んで vsync を証跡（`estimatedVsyncMs`）に残し、単一点 flyTo（zoom8）⇔
flyToBounds（padding 60/48/20）を 8 往復・duration 0.8/1.0秒交互で計測する（計 17 計測。MapLibre 側と同数）。
- 単発計測: `await window.__measureLeafletCameraFly({ kind:'point', durationSec:0.8 })` /
  `await window.__measureLeafletCameraFly({ kind:'bounds', padding:60, durationSec:1.0 })`
- 実機で `surface-go2-leaflet-camera*` として保存された証跡を、MapLibre 側 `surface-go2-camera*`（34件）と
  fps・`frame.p95`・`frame.max`・longtask で突き合わせて判定する。

## 検証項目4: 当たり判定（bbox方式＋点-線分距離の円判定）

`http://localhost:5180/poc/hittest.html`（実機は `http://<開発機のIP>:5180/poc/hittest.html`）を開く。
右上スライダーで許容半径 r（px）を変え、地図（オレンジ=活断層、シアン=テスト線）をクリックすると
左下にヒット結果が出る。当たり判定は「bboxで候補を粗く絞る（ブロードフェーズ）→候補に対し実際の
点-線分距離をユークリッドで計算し円判定する（ナローフェーズ）」の2段構成（本番Leafletの
tolerance判定＝円と一致させるため。bboxのみの正方形判定だと斜め方向で最大√2倍まで拾ってしまう
問題をレビュー指摘で解消した）。開発機での自動検証は `docs/webgl-rendering-migration-plan.md`
§6 検証項目4を参照（r=8px でオフセット8px以内=ヒット・9px以上=非ヒットの境界一致を zoom5/8/11 で
確認済み・決着）。

## 検証項目: テキスト描画（§8「テキスト描画」）

`http://localhost:5180/poc/label.html`（実機は `http://<開発機のIP>:5180/poc/label.html`）を開く。
`glyphs` 未設定・`text-font` にOS日本語フォント名のみを指定した構成で、地方/県/区域名・震度ラベルが
描けるかを検証する。グリフ生成コストは以下で計測する:

```js
await window.__runLabelZoomSuite()
```

**【必ずページをリロードしてから1回だけ実行すること】** グリフキャッシュ（`map.style.glyphManager`）
はページを閉じるまで消えないため、2回目以降の実行では`glyphsGenerated`が全段で変化しなくなる
（既に生成済みのグリフを再描画するだけになり計測が無効化される）。

結果の`blockMaxMs`がグリフ生成コストの**主指標**（MessageChannel でメインスレッドの最長連続
ブロックを vsync 非依存で計測）。開発機（headed・60Hz・Intel Iris Xe）で `__runLabelZoomSuite()`
を4回実行した実測レンジ: regions 15→3.4〜5.6ms・prefectures 84→9.5〜24.8ms・
**subregions 209→16.9〜24.4ms**・intensity 218→5.2〜5.8ms。**実行間ばらつきが小さくない**
（prefectures/subregionsは2倍前後・regions/intensityは小さい）。**レンジを見て「軸が効いて
いない」と読まないこと**——ただし読み方には注意が要る。生成量の多い2段（prefectures・
subregions）の値域は生成量の少ない2段（regions・intensity、全4回とも6ms未満）と一切重ならず、
**「小群 対 大群」の分離は4回とも崩れていない**。一方、同一実行内で prefectures と
subregions を1対1で比べると、**4回中3回は subregions が上回るが、1回（生成量が多い方の
prefectures 24.8 対 subregions 24.4）は逆転している**。したがって言えるのは「生成量が
明確に違う2群の分離」までで、「隣接する2段の同一実行内での順序が常に保たれる」とまでは
このデータからは言えない（レビュー側の別環境n=4では4/4で順序が保たれたが、これは環境固有の
結果であり本環境でそのまま再現するとは限らない）。原因（実行毎のOS/GCタイミング差等）は未調査。
これとは別に、subregionsだけをリロード後に毎回フレッシュな状態で単独計測（他レイヤーの生成を
挟まない）した3回試行では20.6/19.6/20.2msとより安定していた（σ~0.5ms）。suite内計測と単独計測で
分散の大きさが違うのは、測定文脈（先行する生成の有無・実行順）が違うためで、どちらかが
誤りというわけではない。
`frame.max`（rAFフレーム時間）は**副指標**で、vsync に量子化されるため 60Hz では全段16.9msのまま
生成コストに反応しない（＝60Hz 開発機では frame.max は不適な計測器。当初「開発機では検出
できない」と結論したのは計測器の誤選択が原因で、`blockMaxMs` に替えれば検出できる）。
vsync 5.9〜6.1ms(≒164Hz)の環境では同種のブロックが frame.max でも明確に浮く（レビュー機の
単独計測で subregions 35.3ms・suite計測で18.6ms）。**両環境の観測差は headed/headless でも
Playwright/実Chrome でもない**（双方 headed 確認済み）。**ただし vsync 差そのものの原因は
未特定**（別モニタか別実行コンテキストか未検証。断定しない）。`blockMaxMs` は両環境で
同程度の範囲（16.7ms環境は上記レンジ・5.9ms環境は単発計測で18.6ms）に収まり vsync 非依存と
実証済みのため、原因を追う実務上の必要はない。longtask は全段0（観測した最大24.8msも
50ms閾値未満）だが、非力な実機（Surface Go 2、`blockMaxMs` が 2〜3倍に伸びうる）では閾値を
跨ぐ可能性があり、実機計測の価値はその絶対値を知る点にある（「開発機で測れないから」ではない）。

## 3軸と律速判定

スイートは 2026-07-25 の飽和を受け、**負荷を上げて vsync 天井(16.7ms)を破る方向**へ改訂済み。
フレーム時間 p95 の反応で律速を読む（`overload` は DPR と線幅を同時に動かす最重設定）:

| 動かす軸 | run 名 | こう出たら |
|---|---|---|
| 最重（DPR2.0＋線幅12） | `overload-dpr2-lw12` | 天井を破れるか（破れなければ headroom 大＝現行負荷では律速に届かない） |
| DPR を上げる | `dpr-2.0` | **悪化 → GPU フィルレート律速** |
| 線を太く（塗り面積↑） | `fill-lw8` / `fill-lw12` | **悪化 → GPU フィルレート律速** |
| 頂点を減らす | `verts-thin` | **改善 → CPU/頂点処理律速** |
| DPR を下げる（対照） | `dpr-1.0` | 天井を破れたときのみ有効 |
| 観測点を消す | `points-off` | 点(circle)の描画寄与の切り分け |

- **フィルレート律速**（DPR下げで改善・線太らせで悪化・頂点減らしても不変）
  → 計画書 §6「フィルレート律速だった場合の分岐」へ。間引き廃止は保留、DPR 抑制(`pixelRatio`)が本命。
- **CPU/頂点律速**（頂点減で改善・DPR に鈍感）
  → MapLibre 化 GO。PoC 項目2以降（軽さ・カメラ・当たり判定・非加算合成）へ進む。

### 【重要】p95 が 16.7ms 付近なら、その局面では判定できない

**2026-07-25 実機（Surface Go 2・60Hz）の結果**: pan は全軸そろって p95 **16.9ms 一定**だった。
塗り面積を 1/4 にしても頂点を 68% 削っても線幅を 3.3 倍にしても動かない。これは
**baseline が既に vsync 上限（16.7ms）に張り付いていて、天井より上の余裕が原理的に測れない**ため。
軸を振る前に **baseline が p95 > 16.7ms を出しているか**を必ず確認すること。

- **飽和は「律速が無い」ことの証明ではない。検出に失敗しただけ**。「余裕で 60fps」と
  「かろうじて 60fps」を区別できないため、残り余力（headroom）は未知のまま残る。
- **天井を破るには負荷を上げる**（DPR を 2.0 へ・線幅を大きく・CPU スロットル）か、
  **vsync にクランプされない指標**（GPU フレーム時間）を使う。**下げる方向に振っても無意味**。
- **2回目（zoom 拡張）で判明**: 1回目に zoom が 33.3ms を出したのは軸の反応ではなく
  **初訪問ズームレベルのタイル読み込み（ウォームアップ）**だった。線幅を 4 に増やした run が
  逆に 16.9ms へ改善し、longtask が実行順に 3→2→1→0→0→0 と減衰したのが証拠。
  **負荷を増やした軸が「改善」したら交絡を疑うこと**。計測前にウォームアップパスを置く。
- `max` は判定に使わない。単発のタイル読み込み・GC・`pixelRatio` 変更時の描画バッファ再確保が
  乗って軸と無関係に上下する（実機では DPR を下げた run の方が max が悪化する非単調が出た）。

数値・判定・次アクションの全文は
[docs/webgl-layerb-verification-points.md](../docs/webgl-layerb-verification-points.md) と
計画書 §6「結果記録」にある。

## 結果の読み方

各 JSON の `frame.p95`（体感を決めるフレーム時間の95%）・`frame.fps`・`longTask` を run 横断で比較する。
`meta` に軸パラメータ（`faults` / `faultVertices` / `lineWidth` / `pixelRatio` / `canvasW`×`canvasH` / `devicePixelRatio`）と、
`jsHeapMB`（JSヒープ）・`webglMemory`（WebGL推定メモリ、下記参照）が入る。

## 実行時メモリ推定（検証項目: §8「実行時メモリ」）

`performance.memory` は JS ヒープのみで WebGL バッファ・テクスチャ・レンダーバッファを含まない。
`poc/webglMemoryTracker.ts` が WebGL コンテキストをプロキシして `bufferData`/`texStorage2D`/
`renderbufferStorage` 等の呼び出しから確保量を推定し、`poc/main.ts` の stat パネル・計測レポート
（`meta.webglMemory` = `{bufferBytes, textureBytes, renderbufferBytes, totalBytes}`）に統合済み。

- stat パネルの「WebGL推定(buf/tex/rb)」「推定実行時メモリ」を見れば、開発機でも軸を振ったときの
  反応（実測: DPR 1.0→2.0 でテクスチャ推定値が約1.89倍＝DPR¹に近い線形。塗り面積のDPR²則とは
  別軸で、主に可視タイル枚数の増加として効いていると見られる）を確認できる。
- あくまで概算（ミップレベル未考慮・不明フォーマットは安全側に丸め）。
- `webglcontextlost` 時はカウンタ・bind状態をリセットする（旧コンテキストのオブジェクトは
  `delete*()` されないまま失効するため、リセットしないと二重計上になる）。

### 長時間稼働の安定性観測スイート（§8 実行時メモリの本命判定・実機で実行）

**【計測方針（2026-07-27 ユーザー判断）】** VRAM（GPU テクスチャ）はブラウザ/OS から観測できず
`performance.memory` は JS ヒープのみのため、バイトの厳密計測は原理的に不可能。そこで §8 の問い
（＝移行で 4GB 機が不安定化するか）に直答するため、**実機で長時間稼働させてタブ kill / context lost /
OOM という「結果」が起きるかを観測**する（バイト計測でなく結果を見る）。

```js
await window.__runStabilitySuite('surface-go2-stability', 30)  // 30分・30秒ごとにサンプル
window.__stopStabilitySuite()  // 途中で止める
```

実利用（常時表示＋時々 EEW で flyTo）を模し、sampleEverySec ごとに軽くカメラを動かして
（ランダム地点へ flyTo → 日本全体へ戻す＝タイル/テクスチャの確保・解放を促す）、その都度
`jsHeapMB`・`webglMemory` 推定・`contextLost` 回数・longtask をスナップショットして `/__perf-report` へ送る。
末尾に first/last/min/max とデルタの要約（`surface-go2-stability-summary`）を送る。
- **判定は人が読む**: `contextLost > 0` は不安定。`webglTotalMB`/`jsHeapMB` の `deltaFirstToLast` が
  持続的に増え続けるならリーク疑い（単発の増減・初期ウォームアップの立ち上がりは無視）。
- **タブ kill 自体はページ消滅のため自己申告できない**。最後に届いたサンプルの `elapsedSec`/`when` が
  「いつまで生きていたか」を示す（実機側でサンプルが途切れたら kill/reload と判断する）。

## トラブルシュート

- **活断層・観測点が出ない（背景だけ）**: GeoJSON worker が動いていない。`vite.poc.config.ts` の
  `optimizeDeps.exclude:['maplibre-gl']` が効いているか、`--force` 付きで起動し直したかを確認する。
- **`ERROR: ...` が左下に出る**: WebGL 初期化失敗（`GPUInitializationError` など）。実機の GPU/ドライバ状況を記録する
  （これ自体が §8「非力 GPU での MapLibre 安定性・context lost」の重要な観測データ）。
