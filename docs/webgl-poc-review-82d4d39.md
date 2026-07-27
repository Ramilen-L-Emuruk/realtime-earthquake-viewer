# 検証項目2（Leaflet 比較）PoC（`82d4d39`）レビュー — 比較の成立は守られた。ドラッグ終了コストが窓の外

> 対象コミット: `82d4d39` chore: 検証項目2(Leaflet比較)のPoCを追加
> 対象ファイル: `poc/leaflet-index.html`（84行）/ `poc/leaflet-main.ts`（245行）/ `poc/leaflet-measure.ts`（252行）
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §2.4・§6 検証項目2 ／
> 対応する MapLibre 側 `poc/main.ts` / `poc/measure.ts`（層B・検証項目1）
> レビュー日: 2026-07-26（開発機 Chrome / DPR 1）
>
> **ステータス: HIGH 1・MEDIUM 2・HIGH 4 対応済み。実機投入可。**
> - **比較の枠組みは正しく作られている。** 特に `panBy` の `moveend` 罠を自力で見つけて回避したのは、
>   **この項目の成立自体を救った修正**（下記「最大の功績」）
> - **【対応済み】HIGH 1**: `startDrive` の停止関数が `moveend` の同期コストを ms で返すようにし、
>   `measureOnce` が結果へ `moveendMs` として名指しで記録するようにした。実測で `pan` は
>   `moveendMs:6.3`（31,646頂点の活断層線の再クリップ・再簡略化・再描画コスト）、他フェーズは
>   `null` になることを確認。詳細は下記「対応確認」
> - **【対応済み】MEDIUM 2**: `fps` を名目 `durationMs` ではなく実測経過時間（`elapsedMs`）で
>   割るように統一した（項目7 HIGH1 と同じ定義）
> - **【対応済み】HIGH 4**: `estimatedVsyncMs`（`static` の `frame.p50` を天井の証跡として記録）を
>   Leaflet 側に追加。**比較相手の `poc/measure.ts`（MapLibre側）にも同じフィールドを追加**し、
>   両者を同じ天井で測ったかを証跡で判別できるようにした
> - **【情報 3】Leaflet 有利なバイアスが2つある**（当たり判定ヒット線の省略・DPR 軸の不在）。
>   結果の読み方に効くため記録する（対応は不要・実機計測時に読み方の指針として参照する）
> - 型チェック エラー 0（`--strict`・DOM lib 付き単体チェック）。対応後も再確認済み

## この項目の位置づけ

検証項目2 は**移行判断で残る唯一の GO/NO-GO 論点**である。ここまでの項目（1・5・6・5×6・7）はすべて
「MapLibre が壊れないか」を測ってきたが、本項目だけが「**MapLibre は Leaflet より速いか**」を測る。

層B 2回目の訂正のとおり、Leaflet の pan は CSS transform のコンポジタ合成のみで再ペイントがほぼ走らない
のに対し、MapLibre は毎フレーム全ビューポートを塗り直す。**同じ 60fps でも仕事量は桁違いの可能性がある**。
飽和した指標では「余裕で 60fps」と「かろうじて 60fps」を区別できないため、Leaflet 側を実測しない限り
この項目は閉じられない。

---

## 最大の功績: `panBy` の `moveend` 罠を回避したこと

コメントに記録されている自己発見が、この PoC の価値の中心である。

`map.panBy(offset, {animate:false})` は内部で `move` と `moveend` を**同一呼び出しで発火する**
（`leaflet-src.js` L3460-3463）。そして `Renderer.getEvents()` は `moveend` を購読して
`_updatePaths()`——**全 SVG パスの再クリップ・再簡略化・再描画**——を起動する。

つまり毎フレーム `panBy` を呼ぶと、**実ドラッグでは絶対に起きないフル再描画を人為的に注入する**。
「Leaflet の pan は CSS transform 合成のみで軽い」という、本項目が検証したい仮説そのものを壊す罠である。

修正後は実ドラッグ（`Handler.Drag._onDrag`・L13817-13831）の経路を直接再現している。

```ts
rawMap._rawPanBy({ x: 6 * dir, y: 0 })
map.fire('move')          // 毎フレームは 'move' のみ
// 'moveend' はフェーズ終了時に1回だけ（＝指を離すタイミング相当）
```

**Leaflet のソースを行番号まで追って特定しており、比較の成立を救った修正**である。

### `zoom` を native / forced に分けた設計も正しい

| phase | 駆動 | 測るもの |
|---|---|---|
| `zoom-native` | `setZoom(target, {animate:true})` を 400ms 間隔で往復 | **本番はどれだけ軽いか**（Leaflet 自身のアニメ＝CSS transform で拡縮し着地時に1回だけ再描画） |
| `zoom-forced` | `setZoom(nz, {animate:false})` を毎フレーム | **MapLibre と直接比較できる数値**（アニメの近道が無い素の描画コスト） |

§2.4 の議論を正面から扱っている。`zoom-native` だけでは MapLibre と比較できず、`zoom-forced` だけでは
本番の実態を測れない——両方要るという判断は正しい。

### 条件の対称性も確認した

| 項目 | MapLibre 側（`poc/measure.ts`） | Leaflet 側 | 対称か |
|---|---|---|---|
| pan の駆動量 | `panBy([6*dir, 0])`・600px で往復 | `_rawPanBy({x:6*dir})`・600px で往復 | **完全対称** |
| `zoom-forced` の刻み | 0.02 / フレーム | 0.02 / フレーム | **対称** |
| `points` 軸の実装 | `circle-opacity` 0.85 ⇄ 0 | `fillOpacity` 0.85 ⇄ 0 | **対称** |
| 頂点数軸 | `active-faults-full.json` / `active-faults.json` | 同一ファイル | **対称** |
| 間引き | `floor`（項目6 LOW2 の教訓） | `floor` | **対称** |
| `START_ZOOM` | 5 | 5 | **対称** |

本番からの引き写しも丁寧である（SVG レンダラー・専用ペイン `line-layers` z=263 / `kyoshin-points` z=400・
`padding=2`・タイル設定 `maxNativeZoom=10` / `keepBuffer=4` / `updateWhenZooming=false` / `updateWhenIdle=true`）。
`faults` 切替時の再ウォームアップ（層B HIGH1 の教訓）と末尾の `baseline-warm`（層B HIGH4 の教訓）も入っている。

---

## HIGH 1. ドラッグ終了時の全パス再描画コストが計測窓の外に落ちている

```ts
const stopDrive = startDrive(map, phase)
await new Promise((r) => setTimeout(r, durationMs))
stopDrive()                    // ← ここで map.fire('moveend') → _updatePaths() 同期実行
cancelAnimationFrame(rafId)    // ← 直後に計測 rAF を止める
```

`startDrive` の `pan` 分岐のコメントはこう書いている。

> フェーズ終了 = 実ドラッグでの指を離すタイミング相当。ここで初めて 'moveend' を1回発火し、
> SVGレンダラーの全パス再描画（本来ドラッグ終了時に1回だけ起きるコスト）を**反映させる**。

**反映されていない。** `_updatePaths()` は同期実行なのでその間 rAF は呼ばれず、終わった直後に
`cancelAnimationFrame(rafId)` が走る。**フレーム統計（p50/p95/max）に一切現れない。**

`longTask` に出る可能性はあるが（`po.disconnect()` は後）、`PerformanceObserver` のコールバックは
非同期に配送されるため確実ではない。

### なぜ問題か: Leaflet 有利に偏る

Leaflet の pan の性質は「**動かしている間は transform で軽いが、離した瞬間に一括で払う**」である。
その「払う分」を測らずに「pan は軽い」と結論すると、比較が Leaflet に傾く。

`full` の活断層は 31,646 頂点。その全パスの再クリップ・再簡略化（`L.LineUtil.simplify`）・
DOM 属性書き換えが 1 回走るコストは安くない。**しかもこれは本項目が測るべき Leaflet の実コストそのもの**である。

### 提案: 項目7 の `areaEvents` と同じ扱いにする

窓を延ばして拾う（項目6 の `DRAIN_MS` 方式）よりも、**性質の違うコストを混ぜず名指しで記録する**方が明快。

```ts
// startDrive の pan 分岐の戻り値を変更し、moveend の同期コストを返す
return () => {
  cancelAnimationFrame(id)
  const t0 = performance.now()
  map.fire('moveend')
  return performance.now() - t0      // → 結果に moveendMs として記録
}
```

これで `pan` の結果に「動作中のフレーム時間」と「終了時の一括コスト」が並ぶ。
MapLibre 側には対応するコストが存在しない（毎フレーム塗り直すため終了時に何も起きない）ので、
**この非対称そのものが検証項目2 の答えの一部になる**。

> 補足: `zoom-native` にも同種の構造がある。Leaflet のズームアニメーションは着地時（`zoomend`）に
> 1 回再描画するが、400ms 間隔で往復させているため窓の内側で発火する。したがって `zoom-native` は
> 着地コストを含んでいる。**`pan` だけが窓外に落ちている**。

---

## MEDIUM 2. `fps` が名目 `durationMs` 割り

```ts
fps: round(sorted.length / (durationMs / 1000))
```

項目7 では同じ箇所を HIGH 1 として「実測経過時間（`elapsedMs`）で割る」に修正した経緯がある。
本 PoC は rAF 開始から `durationMs` 待つだけなのでズレは小さく実害は薄いが、
**指標の定義を PoC 間で揃えておく**方が後の解析で混乱しない。

---

## 情報 3. Leaflet 有利なバイアスが2つある（結果の読み方に効く）

どちらもコメントに正直に書かれているが、**結論を書くときに参照する必要がある**ため記録する。

### 3-1. 当たり判定用の透明 Canvas ヒット線を省略している

本番の `ActiveFaultsLayer.tsx` は可視線（SVG）と当たり判定用の透明 Canvas ヒット線を**重ねて持っている**。
本 PoC は MapLibre 版に対応物が無いため省略している。条件を揃える判断は妥当だが、
**本番の Leaflet より軽い状態を測っている**。

### 3-2. DPR 軸が振れない

Leaflet に `setPixelRatio` 相当の公開 API が無いため、層B の 3 軸のうち DPR 軸が対象外になっている。

これは「軸が無い」と読むべきではない。**SVG が解像度非依存であること自体が Leaflet の強み**であり、
比較の論点そのものである（MapLibre は DPR² に比例して塗る面積が増える。§6「フィルレート律速だった
場合の分岐」で DPR 抑制が対策として挙がっているのは、この非対称があるため）。

### 読み方の指針

比較の向きとしては「**Leaflet を有利にしてなお MapLibre が勝つなら強い結論**」になるため、
この設計は許容できる。ただし**逆の結果が出たとき**——Leaflet が勝ったとき——には
上記2点を差し引いて考える必要がある（3-1 は Leaflet に不利な方向へ、3-2 は MapLibre に不利な方向へ働く）。

---

## 推奨する対応順

1. **HIGH 1 を直す**（`moveend` の同期コストを `moveendMs` として記録）。
   これを測らずに実機を回すと、**Leaflet の pan コストを過小評価した数字**になり測り直しになる
2. MEDIUM 2（`fps` を実測経過時間割りへ）— 定義の統一
3. 実機スイート（`await window.__runLeafletBSuite('surface-go2-leafletB')`）。
   5 軸 × 4 フェーズ ＋ `baseline-warm` 2 本 = 22 計測。項目5×6 の経験から**同一ページで連続実行すると
   基準線が安定する**
4. **MapLibre 側（層B）の再計測も要る。** 層Bの実機3回計測は `poc/main.ts` の当時の版で取ったもので、
   Leaflet 側と同じ日・同じ端末状態で並べた数字ではない。**同一セッションで両者を回した方が比較の質が上がる**
5. 読み方の指針:
   - **`zoom-forced` が MapLibre と直接比較できる唯一の数値**
   - `zoom-native` と `pan` は「本番の Leaflet がどれだけ軽いか」＝**移行で失うもの**の実寸
   - `pan` は HIGH 1 の `moveendMs` と併せて読む（動作中の軽さと終了時の一括コストは別物）
   - フレーム時間で差が出なければ、ヘッダコメントの予告どおり
     **Performance トレースでのメインスレッド内訳計測**へ進む（飽和した指標では仕事量の差は見えない）

---

## 対応確認（HIGH 1・MEDIUM 2）

上記 1〜2 をコードに反映し、開発機（Chrome・DPR 1）で回帰確認した。

### HIGH 1: `moveendMs` として名指しで記録するようにした

`startDrive` の戻り値を `() => void` から `() => number | undefined` に変更し、`pan` の停止関数が
`map.fire('moveend')` の同期コストを計測して返すようにした。`measureOnce` はこれを結果へ
`moveendMs` として記録する（`pan` 以外は `null`）。

実測（`durationMs:2000`）:

```
pan         : frame.p50/p95/max = 16.7/16.9/17.0, moveendMs = 6.3
static      : frame.p50/p95/max = 16.7/16.9/17.0, moveendMs = null
zoom-native : frame.p50/p95/max = 16.7/16.9/17.0, moveendMs = null
zoom-forced : frame.p50/p95/max = 33.3/50.1/50.2, moveendMs = null
```

`pan` の動作中フレーム時間は `static` と同水準（軽い）を保ったまま、ドラッグ終了時の一括コスト
（31,646頂点の活断層線の再クリップ・再簡略化・再描画）が `moveendMs:6.3` として分離して見えるように
なった。この開発機では6.3msは天井(16.7ms)の半分以下だが、非力な実機ではもっと重くなりうる値であり、
以前は完全に見えなかったコストが可視化された。

### MEDIUM 2: `fps` の定義を統一

`fps` の分母を名目 `durationMs` から実測経過時間（`elapsedMs = performance.now() - frameCollectStart`。
`stopDrive()` 呼び出し後、`cancelAnimationFrame` 前に確定）に変更した。項目7 HIGH1 と同じ定義になった。

### 残作業

実機スイート（`__runLeafletBSuite`）は未実施。上記2点の修正により `pan` の測定精度が上がったため、
実機投入してよい状態になった。あわせて MapLibre 側（層B）の同一セッションでの再計測（推奨対応順4）も
実機作業時に検討すること。

---

## レビュー側での独立検証（`5145565`）— 対応は正しい。ただし HIGH 4 が新たに判明

対応コミット `5145565` を開発機で独立に検証した。**HIGH 1・MEDIUM 2 とも解消を確認。**
型チェック エラー 0。`moveendMs` が `pan` のみに出て他フェーズは `null` になることも確認した。

**しかしこの検証の過程で、対応側の実測値とレビュー側の実測値が食い違った。** 原因は
**証跡に vsync 天井が記録されていないこと**であり、これは実機投入前に埋めるべき欠落である（HIGH 4）。

### HIGH 4. Leaflet 側の証跡に `estimatedVsyncMs` が無い（実際に食い違いが発生した）

同じ「開発機」と記録された 2 つの測定が、**天井の違う環境で取られていた**。

| 指標 | 対応側の実測 | レビュー側の実測 |
|---|---|---|
| `static` p50 | **16.7ms** | **5.9ms** |
| `zoom-forced` p50 | 33.3 | 35.3 |
| `pan` `moveendMs` | 6.3 | 4.9 |
| `pan` p50 | 16.7 | 5.9 |

レビュー側では、Leaflet ページで**素の rAF 間隔を直接測って 5.9ms / 171fps** を確認している
（`screen 2560x1440`・DPR 1）。つまりレビュー側の環境は 170Hz、対応側は 60Hz 相当である。
Playwright のウィンドウがどのディスプレイに出たか等の違いと考えられる。

**問題は、証跡だけ見てもこの区別がつかないこと。** 項目5×6 のレビュー「情報 5」で MapLibre 側に
`meta.estimatedVsyncMs` を追加させたが、**Leaflet 側には入っていない**（`grep` 0 件）。

検証項目2 は **MapLibre 側と Leaflet 側を並べて比較する**項目である。両者を同じ天井で測ったことを
証跡で示せなければ、**比較そのものの根拠が崩れる**。`static` フェーズの `frame.p50` は
何も動かさないため天井の推定値そのものになる（項目7 で `baseline` の p50 を使ったのと同じ手）。

```ts
// measureOnce の meta へ追加する
estimatedVsyncMs: phase === 'static' ? round(pick(0.5)) : null,
```

### 収穫: `zoom-forced` だけが環境に依存しない実コストを出す

上表をもう一度見ると、**`static` と `pan` は天井に張り付いて環境をそのまま映すのに対し、
`zoom-forced` は 33.3 対 35.3 でほぼ一致している**。

| phase | 天井 16.7ms の環境 | 天井 5.9ms の環境 | 性質 |
|---|---|---|---|
| `static` | 16.7 | 5.9 | **飽和**（＝天井そのもの） |
| `pan` | 16.7 | 5.9 | **飽和**（CSS transform のみで軽いため） |
| `zoom-forced` | **33.3** | **35.3** | **飽和していない＝真のコスト** |

層B で学んだ「飽和した指標は情報を持たない」の裏返しである。**`zoom-forced` が唯一、
vsync 天井に隠されない実コストを出す指標**であり、**比較の主指標にすべき**。

### 開発機での暫定比較（下限のみ）

| | zoom の p50 | 状態 |
|---|---|---|
| MapLibre（項目5×6 で同じ開発機・170Hz で実測） | **5.9ms** | 天井に張り付き＝真値は不明 |
| Leaflet `zoom-forced` | **35.3ms** | 飽和していない実コスト |

**6 倍以上の差**だが、MapLibre 側が飽和しているため**言えるのは下限だけ**である
（真の差はこれより大きい可能性がある）。`pan` は両者とも天井に張り付くため比較できない。

`moveendMs 4.9ms` は 31,646 頂点の一括再描画コスト。HIGH 1 修正によって初めて分離して見えるように
なった値である。

### この暫定比較を確定にするために要ること

1. **HIGH 4 を埋める**（`estimatedVsyncMs` を Leaflet 側 meta へ）。どの天井で測ったかを証跡に残す
2. **MapLibre 側（層B）を同一セッションで再計測する**。現在の暫定比較は**別々の日に別々の環境で
   取った数字を並べているだけ**であり、比較として弱い。同じ端末・同じセッションで
   `__runLayerBSuite` と `__runLeafletBSuite` を続けて回すこと
3. **MapLibre 側が飽和したままなら差の下限しか出ない。** その場合はヘッダコメントの予告どおり
   **Performance トレースでのメインスレッド内訳計測**へ進む（両者が天井に張り付いたら
   フレーム時間はもう情報を持たない）

---

## 対応確認（HIGH 4）

`estimatedVsyncMs`（`static` フェーズの `frame.p50` を天井の証跡として記録）を
`poc/leaflet-measure.ts` の `meta` へ追加した。

セルフレビューで「比較相手の `poc/measure.ts`（MapLibre側）に同フィールドが無いままでは
非対称」という指摘を追加で受け、**`poc/measure.ts` 側にも同じ `estimatedVsyncMs` を追加した**
（HIGH4の元指摘は Leaflet 側の欠落のみを名指ししていたが、項目2が両者を並べて比較する項目である
以上、証跡は両方に無ければ本来の目的を満たさないため）。

実測（開発機）: Leaflet 側 `static` 実行で `estimatedVsyncMs:16.7`（`frame.p50` と一致・`pan` は
`null`）、MapLibre 側 `poc/index.html` の `static` 実行でも同様に `estimatedVsyncMs:16.7` を確認。
型チェックエラー0・console error 0。

### 残作業

実機スイート（`__runLeafletBSuite`・`__runLayerBSuite`）は未実施。両者の証跡に天井の手がかりが
入ったため、同一セッションでの再計測（推奨対応順2）を実施すれば、食い違いが起きても即座に
「環境が違う」と判別できる状態になった。
