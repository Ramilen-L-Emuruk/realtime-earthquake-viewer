# 層B PoC — MapLibre 律速切り分け（使い捨て）

地図描画 MapLibre 一本化（`docs/webgl-rendering-migration-plan.md`）の **層 B = フル解像度の線/面の描画負荷** について、
律速が **CPU（頂点処理）** か **GPU フィルレート（塗り面積）** かを実機で切り分けるための使い捨て PoC。
本体（React/Leaflet）とは独立して動く。

## 構成

| ファイル | 役割 |
|---|---|
| `poc/index.html` / `poc/main.ts` | 素の maplibre-gl で 背景(GEBCO raster)＋活断層(line)＋観測点(circle) を描画。3軸を実行時に切替 |
| `poc/measure.ts` | 静止/パン/ズームのフレーム時間・longtask 計測ランナー。証跡を `/__perf-report` へ送る |
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
4. baseline（静止/パン/ズーム）＋各軸（パン）を順に自動計測し、
   開発機の `scripts/perf/results/perf-*-surface-go2-*.json` へ自動保存される
   （各10秒・全体で約1.5分）。進行は `[layerB]` コンソールログで分かる。

補助:
- 単発計測: `await window.__measureLayerB({ phase:'pan', durationMs:10000, label:'xxx' })`
- 右上の UI で手動に軸（活断層 full/thin・線幅・pixelRatio・観測点 on/off）を変えられる。

## 3軸と律速判定

スイートは baseline から1軸だけ動かす。**パン時**の FPS / フレーム時間 p95 の反応で律速が決まる:

| 動かす軸 | run 名 | こう出たら |
|---|---|---|
| DPR を下げる | `dpr-1.0` / `dpr-0.75` | **改善 → GPU フィルレート律速** |
| 頂点を減らす | `verts-thin` | **改善 → CPU/頂点処理律速** |
| 線を太く | `fill-lw4` | **悪化 → GPU フィルレート律速** |
| 観測点を消す | `points-off` | 点の描画寄与の切り分け |

- **フィルレート律速**（DPR下げで改善・線太らせで悪化・頂点減らしても不変）
  → 計画書 §6「フィルレート律速だった場合の分岐」へ。間引き廃止は保留、DPR 抑制(`pixelRatio`)が本命。
- **CPU/頂点律速**（頂点減で改善・DPR に鈍感）
  → MapLibre 化 GO。PoC 項目2以降（軽さ・カメラ・当たり判定・非加算合成）へ進む。

## 結果の読み方

各 JSON の `frame.p95`（体感を決めるフレーム時間の95%）・`frame.fps`・`longTask` を run 横断で比較する。
`meta` に軸パラメータ（`faults` / `faultVertices` / `lineWidth` / `pixelRatio` / `canvasW`×`canvasH` / `devicePixelRatio`）が入る。

## トラブルシュート

- **活断層・観測点が出ない（背景だけ）**: GeoJSON worker が動いていない。`vite.poc.config.ts` の
  `optimizeDeps.exclude:['maplibre-gl']` が効いているか、`--force` 付きで起動し直したかを確認する。
- **`ERROR: ...` が左下に出る**: WebGL 初期化失敗（`GPUInitializationError` など）。実機の GPU/ドライバ状況を記録する
  （これ自体が §8「非力 GPU での MapLibre 安定性・context lost」の重要な観測データ）。
