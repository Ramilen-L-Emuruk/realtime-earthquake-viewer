# 層B PoC 計測改訂（`4b0517c`）レビュー — ウォームアップ交絡の残存

> 対象コミット: `4b0517c` perf: 層B PoC計測を負荷上げ方向へ改訂（飽和・ウォームアップ交絡に対処）
> 対象ファイル: `poc/measure.ts` / `poc/main.ts` / `poc/README.md`
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §6 ／ 観点 [webgl-layerb-verification-points.md](webgl-layerb-verification-points.md) ／ 手順 [poc/README.md](../poc/README.md)
> レビュー日: 2026-07-25
> **ステータス: 対応済み（`ef18b34`）。HIGH 2件・LOW 3件すべて修正。下記「対応記録」参照**

## 結論

改訂の**方向は正しい**（負荷を上げる方向への転換・ウォームアップ導入・warm 対照の追加）。
ただし**ウォームアップが GeoJSON ソースの z6 を踏んでおらず、今回対処したはずの交絡が部分的に残る**。
加えて `verts-thin` だけが再タイル化コストを被る非対称がある。この2件は、律速判定に直接効く。

`poc/measure.ts` の型チェックは通過（`tsc --noEmit --strict`）。

## 良い点

- **負荷を上げる方向への改訂**（`overload-dpr2-lw12` → `dpr-2.0` → `fill-lw12` / `fill-lw8`）は
  計画書 §6 測定方法の「DPR を 1.0 / 1.5 / **2.0** で振る」指定どおり。飽和した baseline から
  負荷を下げても何も測れないという前回の失敗に正しく対処している。
- **`overload` を先頭に置く順序**が適切。まず vsync 天井（16.7ms）を破れるかを確認しないと
  後続の軸比較に意味が無いため、この配置は理にかなっている。
- **末尾の `baseline-warm` 対照**（zoom → pan の順）。warm 状態でも zoom が劣化するかで
  交絡仮説を実測で決着させられる。zoom を先に測る順序も、疑いが掛かっている局面を
  優先する点で正しい。
- **`performance.memory`（`jsHeapMB`）の追加**に「JS ヒープのみ・WebGL バッファ/テクスチャは
  含まないためタスクマネージャ併用が要る」旨のコメントが添えられている。§8「実行時メモリ」の
  制約を正確に反映している。
- README の計測数（17計測・約3分）は正確。内訳 = baseline 3（static/pan/zoom）＋ 軸 6種 × 2局面 12
  ＋ `baseline-warm` 2 = 17。

---

## 【HIGH】1. ウォームアップが GeoJSON ソースの z6 を踏んでいない

### 現象

`measure.ts` の `warmup()` は `[7, 4, 5]` を `setZoom` で巡る実装。**`setZoom` は瞬間移動なので
中間のズームレベルを訪れない**。一方、計測時の zoom drive（`startDrive`）は z4〜7 を
0.02 刻みで**連続的に**スイープするため、z6 を通過する。

結果、z6 のタイルはウォームアップで用意されず、**最初の zoom 計測（baseline zoom）の最中に
初回コストを払う**。

### 実測（開発機・Chrome 150）

ソース別に「そのズーム操作で `_inViewTiles` に載った z」を記録した結果:

| ソース | 現行 warmup `[7,4,5]` で到達した z | 連続スイープ 4→7 中に初出（＝漏れ） |
|---|---|---|
| `gebco`（ラスタ） | 5, 6, 7, 8 | なし |
| **`faults`（活断層 GeoJSON）** | 4, 5, **7** | **6** |
| **`points`（観測点 GeoJSON）** | 4, 5, **7** | **6** |

ラスタソースは map zoom と異なる z を引く（map z5 で gebco は z6/z7 を要求）ため、
`[7,4,5]` でも偶然 z6 が埋まる。**GeoJSON ソースは map zoom と 1:1 対応**なので、
z6 だけが丸ごと抜ける。

### なぜ重要か

前回（2026-07-25 1回目）の交絡の主因と目されるのは **geojson-vt によるジオメトリ再タイル化**
であって、ラスタタイルの取得だけではない。ラスタ分は今回埋まるので前回より軽くはなるが、
**最も高いコストが baseline zoom に残る**。同じ読み違い（初回コストを軸の反応と誤読する）を
繰り返す危険がある。

### 修正案

全整数ズームを踏ませる。下記で3ソースとも漏れゼロを実測確認済み:

```js
// warmup() 内
for (const z of [4, 5, 6, 7, 5]) {
  map.setZoom(z)
  await waitIdle(map, 5000)
}
// 末尾の 5 は計測開始位置（初期 zoom）へ戻すため
```

### 再現手順

PoC ページを開き、DevTools コンソールで:

```js
const tms = () => __pocMap.style.tileManagers
const zs = () => Object.fromEntries(Object.keys(tms()).map(k =>
  [k, [...new Set(Object.values(tms()[k]._inViewTiles._tiles)
    .map(t => t.tileID.canonical.z))].sort((a,b)=>a-b)]))

// 現行 warmup を手で再現し、各段で zs() を見る
for (const z of [7,4,5]) { __pocMap.setZoom(z); await new Promise(r=>__pocMap.once('idle',r)); console.log(z, zs()) }
```

`faults` / `points` に `6` が現れないことが確認できる。

> **計測上の注意**: この検証で**ソースを合算して集合を取ると、ラスタの z6 が GeoJSON の欠落を
> 隠してしまう**（実際に一度その誤りを踏んだ）。必ずソース別に見ること。

---

## 【HIGH】2. `verts-thin` だけが再タイル化コストを被る非対称

### 現象

`verts-thin` は `applyAxis` 経由で `loadFaults('thin')` ＋ `setData` を行い、活断層ジオメトリを
差し替える。GeoJSON ソースの差し替えは**全ズームレベルのタイル化を無効化**するため、
以降のズームで順次再タイル化が走る。

`applyAxis`（`main.ts`）は `setData` 後に idle 待ちを挟むが、これは**現在のズームでの完了しか
待たない**。そのため `verts-thin` の zoom 計測中に、z4 / z6 / z7 の再タイル化コストが乗る。

DPR 軸（`dpr-2.0` / `dpr-1.0`）と塗り面積軸（`fill-lw8` / `fill-lw12`）はジオメトリを触らないため
このコストが無い。**`verts-thin` のみが不利になる。**

### なぜ重要か

`verts-thin` は **CPU/頂点処理律速を判定する唯一の軸**。この軸だけに余計なコストが乗ると、
「頂点を減らしたのに改善しない（むしろ悪化）」という誤った読みを生み、CPU/頂点律速を
取りこぼす方向にバイアスがかかる。

### 修正案

ジオメトリを差し替えた run では、計測前にもう一度ウォームアップを通す。

`warmup()` は `measure.ts`・`applyAxis` は `main.ts` にあるため、**スイートのループ側
（`measure.ts`）で対処するのが素直**。例:

```js
for (const run of runs) {
  await deps.applyAxis(run.axis)
  // ジオメトリを差し替えた run は全ズームのタイル化がやり直しになるため再度温める
  if (run.axis.faults && run.axis.faults !== prevFaults) await warmup(deps.map)
  prevFaults = run.axis.faults
  for (const phase of run.phases) { ... }
}
```

（`applyAxis` 側に寄せる場合は `warmup` を `MeasureDeps` 経由で渡すか、`main.ts` へ複製が要る。）

---

## 【LOW】3. 軽微な指摘

### 3-1. `points-off` 軸が削除されている

観測点 1,458 点（`BASE_RADIUS` 2.5・`circle-opacity` 0.85）の描画寄与が測れなくなった。
円の塗り面積は無視できない量なので、フィルレート寄与の切り分け材料が1つ減る。
意図的な絞り込みであれば可。

### 3-2. `poc/README.md` のリード文が二重

「3軸と律速判定」節で、旧文「スイートは baseline から1軸だけ動かす。フレーム時間 p95 の
反応で律速が決まる:」と改訂文「スイートは 2026-07-25 の飽和を受け、負荷を上げて vsync
天井(16.7ms)を破る方向へ改訂済み:」が連続して置かれ、表が後に続く形になっている。

また `overload-dpr2-lw12` は DPR と線幅の**2軸を同時に動かす**ため、
「1軸だけ動かす」という記述と矛盾する。

### 3-3. `measure.ts` のファイル冒頭コメントが旧仕様のまま

冒頭（ファイル先頭のブロックコメント）は旧3軸の説明で、
「baseline(static/pan/zoom) と各軸(pan/zoom) の証跡」までしか触れていない。
**ウォームアップと `baseline-warm` 対照の記載が無い**。
`__runLayerBSuite` 直前の詳細コメントは改訂済みなので、頭だけが古い状態。

---

## 推奨対応順

1. **HIGH 1**（`warmup()` を `[4,5,6,7,5]` に）— 1行の変更で効果が大きい
2. **HIGH 2**（`applyAxis` のジオメトリ差し替え後に `warmup()` 再実行）
3. LOW 3件（README・冒頭コメントの整合、`points-off` の可否判断）
4. その後に実機で `__runLayerBSuite('surface-go2')` を実行

HIGH 2件を残したまま実機で回すと、交絡対策を入れた回でありながら最も高いコスト
（geojson-vt 再タイル化）が baseline と `verts-thin` に残るため、
**判定を誤る危険が対策前と同程度に残る**。

## 対応記録（`ef18b34`）

上記 HIGH 2件・LOW 3件はすべて対応済み（コミット `ef18b34` fix: 層B PoC計測のウォームアップ交絡残存を修正）。

| 指摘 | 対応 | 検証 |
|---|---|---|
| HIGH1 | `warmup()` を `[7,4,5]`→`[4,5,6,7,5]`（全整数ズームを踏む） | 実機ブラウザで faults/points の到達 z = `[4,5,6,7]`（z6 到達）を実測確認 |
| HIGH2 | スイートループで faults 差し替え(`verts-thin`)後に `warmup()` 再実行。`baseline-warm` 前の full 復帰時も温め直す | 19計測完走・`verts-thin` 後の再温めが破綻なく通過 |
| LOW 3-1 | `points-off` 軸を復活 | `pts=0` を確認 |
| LOW 3-2 | README のリード文二重・「1軸だけ」矛盾を解消 | — |
| LOW 3-3 | `measure.ts` 冒頭コメントをウォームアップ/`baseline-warm` 反映へ更新 | — |

計測数 17→19。`tsc -b` 通過。GPU フレーム時間・CPU スロットル・Leaflet 比較は下記のとおり引き続き別工数。

## 引き続き別工数の課題（このコミットの範囲外）

計画書 §6 測定方法の指定のうち、未対応のまま残っているもの:

- **GPU フレーム時間**（Performance の GPU トラック / `chrome://tracing`）— rAF 間隔は
  構造的に vsync でクランプされるため、飽和時に余力を読むにはこれが必要。
  なお `EXT_disjoint_timer_query_webgl2` は開発機 Chrome 150 では利用可能。
  **実機（Edge / UHD 615）での対応可否は未確認**。
- **CPU スロットル軸**（1× / 2× / 4×）
- **Leaflet 比較** — 検証項目2「現行 Leaflet 比で同等以上に軽いか」はこれ無しに閉じられない。
  本体側にフル解像度活断層を入れて同条件で測る必要があり、PoC の範囲外。
