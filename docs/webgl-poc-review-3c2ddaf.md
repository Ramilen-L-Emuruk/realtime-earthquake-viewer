# 検証項目5（非加算合成）PoC（`3c2ddaf`）レビュー — 合成は数値的に正しい

> 対象コミット: `3c2ddaf` chore: 検証項目5(非加算合成)の PoC を追加 — カスタムレイヤーで二層合成を再現
> 対象ファイル: `poc/subthreshold.html` / `poc/subthreshold.ts`（594行）
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §5・§6 検証項目5 ／ 前レビュー [webgl-poc-review-4b0517c.md](webgl-poc-review-4b0517c.md)
> レビュー日: 2026-07-25（開発機 Chrome 150 / RTX 4070 Ti / DPR 1）
>
> **ステータス:**
> - **核心の主張は検証済み**: ①同レベル非加算 / ②レベル間加算 の二層合成が**数値的に正しい**（解析期待値と一致）
> - **MEDIUM 1（feedback loop）・LOW 3（GL 状態復元）は `3a42d36` で対応済み**（feedback loop warning 0 件を実測確認・下記「対応記録」）
> - **LOW 2・情報 4 はコード修正不要**（実機結果の解釈時に参照）
> - **LOW 5（点が 1 つも無いフレームで FBO 束縛が漏れる）も対応済み**（`3a42d36` の検証中に発見。
>   `render` 末尾の復元に `bindFramebuffer(mainFBO)` を追加し、復元を一箇所へ集約。下記「5.」）
> - レビュー側で立てた懸念のうち **2件は実測で外れたため取り下げ**（下記「取り下げた懸念」）

## 結論

**検証項目5 は「再現可能」で結論が出たと言える。** WebGL 共通の最難関だった非加算合成が、
カスタムレイヤーの FBO 二層合成で**現行 SVG と等価に**再現できている。MEDIUM の 1 件は
実機に持ち込む前に潰したいが、結論を覆すものではない。

`poc/subthreshold.ts` の型チェック・本体 `tsc -b` ともエラー 0。

---

## 検証: 合成の正しさ（数値）

目視比較では判定できないため、**解析的な期待値**を立てて実測ピクセルと突き合わせた。

- 背景 `#111418` = (17,20,24)、点色 `SHINDO0_COLOR` `#9ca3af` = (156,163,175)
- `subThresholdOpacity(3)` = 0.13214、`subThresholdOpacity(5)` = 0.26500
- 期待値（over 合成を 8bit sRGB 空間で計算。CSS/SVG の合成と同じ空間）
  - index3 のみ = `bg*(1-o3) + C*o3` = (35.4, 38.9, 44.0)
  - index5 のみ = `bg*(1-o5) + C*o5` = (53.8, 57.9, 64.0)
  - index3→5 = 上の index3 結果に index5 を over = (67.3, 71.8, 78.7)

| クラスタ | 期待値 | カスタムレイヤー実測 | 標準 circle 実測（①違反の対照） |
|---|---|---|---|
| A: index3 を80点密集 | (35,39,44) | **(36,38,44)** ✓ | (127,129,142) |
| B: index5 を80点密集 | (54,58,64) | **(53,58,64)** ✓ | (153,160,171) |
| C: index3+index5 重ね | (67,72,79) | **(67,71,78)** ✓ | (152,160,171) |

- **① 成立**: 80点が密集しても単独円と同じ濃さ（±1）。加算されていない。
- **② 成立**: レベル間の重なりが解析通りに濃くなる。
- **負の対照が機能**: 標準 circle は 127〜153 まで飛び、①違反の見本として正しく振る舞う。

> **計測上の注意（一度踏んだ罠）**: MapLibre は `preserveDrawingBuffer` を立てないため、
> `readPixels` は **`map.once('render', ...)` ハンドラの中**で呼ばないと空バッファ（0,0,0）を読む。
> ハンドラ外で読んで「背景色すら取れない」結果になり、最初の判定を誤った。

### 再現手順

**初期表示のまま**（パンしていない状態）で実行すること。地図を動かすとクラスタ中心が
ずれて背景を読む。動かした場合はページを再読込する。

```js
const map = window.__subMaps.custom            // std / svg / custom
const gl = map.getCanvas().getContext('webgl2')
const dpr = window.devicePixelRatio || 1
await new Promise((res) => {
  map.once('render', () => {                    // ← 必ず render 内で読む
    const p = map.project([135.0, 37.0])        // クラスタA中心
    const buf = new Uint8Array(5 * 5 * 4)
    gl.readPixels(Math.round(p.x*dpr)-2, map.getCanvas().height - (Math.round(p.y*dpr)+2) - 1,
                  5, 5, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    console.log(buf.slice(0, 4))                // → 36,38,44,255
    res()
  })
  map.triggerRepaint()
})
```

## 評価できる設計点

- **AA の縁の扱いが近似ではなく現行と等価**。premultiplied over（`blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`）
  だと「縁(a<1) が内部(a=1) に重なる」場合 `rgb = C*a + C*(1-a) = C`・`alpha = a + (1-a) = 1` に
  飽和し、**継ぎ目が出ない**。「縁と縁」の重なりだけ僅かに濃くなるが、**現行 SVG の `<g opacity>` も
  グループ内で同じ over 合成をする**ため挙動が一致する。①の破れではない。
- **FBO をレベル間で 1 枚使い回している**（6枚確保していない）。合成が次レベルのクリアより先に
  走るため安全で、テクスチャは 1908×1152 RGBA = 約 8.8MB の 1 枚に収まる。RAM 4GB 機に優しい。
- **`mainFBO` を `getParameter(FRAMEBUFFER_BINDING)` で実行時に控える**のは素直で、
  MapLibre 側の描画先が変わっても追従する。
- **scissor でクリアと合成を BBox に限定**する発想自体は正しい（ただし下記 LOW 参照）。
- 3 ペイン比較（標準 / SVG 正解 / カスタム）の構成が、①違反の見本と正解を同一データで
  並べられていて検証しやすい。

---

## 【MEDIUM】1. フィードバックループの GL エラーが出ている

### 現象

ページを開くとコンソールに出る:

```
GL_INVALID_OPERATION: glDrawArrays: Feedback loop formed between Framebuffer and active Texture.
```

合成パス末尾で `tex` を TEXTURE0 に bind したまま、次レベルの FBO パスで
**同じ `tex` を attach した `fbo`** を描画先にしているため。

### 測定した事実

**描画自体は成功している。** `drawArrays` を包み、**呼び出し前にエラーを排出**してから
計測すると、4 フレーム・28 回の描画すべて `ok`（`INVALID_OPERATION` 0 件）だった。
`pointProg` がサンプラーを持たないため、ANGLE は実際にはこの構成を拒否していない。
出力ピクセルが正しいのはそのため。

### なぜ直すべきか

- **規格上グレーな構成**であり、成立している理由は「アクティブプログラムが偶然そのテクスチャ
  ユニットを参照していない」に依存する。**実機（UHD 615）は同じ ANGLE でもバックエンド経路が
  異なる**ため、同じ判定になる保証はない。
- **既に GL エラーを吐いている状態**なので、この先に本物のエラーが出ても埋もれて気づけない。

### 修正案

FBO パスに入る前にテクスチャを外す（1 行）:

```ts
gl.bindTexture(gl.TEXTURE_2D, null)   // ← 追加
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
gl.viewport(0, 0, w, h)
```

### 再現手順

```js
const gl = window.__subMaps.custom.getCanvas().getContext('webgl2')
const orig = gl.drawArrays
gl.drawArrays = function (mode, first, count) {
  while (gl.getError() !== 0) {}                 // ← 排出しないと帰属を誤る
  orig.call(gl, mode, first, count)
  console.log(mode === 0 ? 'POINTS' : 'TRIANGLES', gl.getError())
}
window.__subMaps.custom.triggerRepaint()
```

---

## 【LOW】2. scissor 最適化は実データではほぼ効かない

### 測定

実際の観測点テーブル `public/data/station-coords.json` で確認した:

- 観測点 **4,372 点**、全点 BBox = lng 122.95〜145.80 / lat 24.06〜45.51（＝日本全域）
- **あるレベルが全国に散った 8 割の点を持つ場合、その BBox は全点 BBox の 99.2%**
  → scissor による削減は**ほぼゼロ**

これは**平常時に低レベル（index 1 付近）へ大半の点が入るケースそのもの**で、
`KyoshinSubThreshold` の常態に当たる。

### 位置づけ

地震時に高レベルが震源周辺へ regionally 集まる場合は効くため、最適化として持つ価値はある。
ただし **PoC のクラスタ状テストデータは効果を過大に見せている**。
「塗り面積を BBox に限定できる」を実機性能の前提にしてはいけない。

---

## 【LOW】3. GL 状態を復元していない

`render()` を抜けた時点で以下が残る: `BLEND` 有効 / `blendFunc` 変更 / `tex` が TEXTURE0 に bind /
`aPos`・`aQuad` の attrib 配列が有効 / `quadProg` が current。

MapLibre は自前の状態を再設定するため今回は破綻していないが、`CustomLayerInterface` の作法としては
復元すべきで、上記 MEDIUM 1 と地続き。

---

## 【情報】4. 実機計測（`__runSubSuite`）の読み方に注意

PoC は重なりを目視しやすくするため **`TEST_RADIUS = 9`** を使う（本番は `BASE_RADIUS 2.5 × iconScale`）。

| | PoC | 本番想定 |
|---|---|---|
| 半径 | 9px | 2.5 × iconScale |
| 1点あたり塗り面積 | — | **約 1/13**（半径比 3.6 の二乗） |
| 点数 | 320（index3=160 / index5=160） | 約 1,725（index 1〜6 に分布） |

塗り面積と点数が**逆方向にずれる**ため、`__runSubSuite` の絶対値は本番の負荷ではない。
**方式間の相対比較（標準 / SVG / カスタム）には有効**という位置づけで扱う。

---

## 取り下げた懸念（レビュー側で立てたが実測で外れた）

記録として残す。いずれも仕様知識からの推論で、測ったら成立しなかった。

| 立てた懸念 | 実測結果 |
|---|---|
| 「2 番目以降のレベルの点描画が `INVALID_OPERATION` で破棄されている」 | **外れ**。`getError` の帰属が甘く、溜まっていたエラーを拾っていた。呼び出し前に排出すると 28/28 成功 |
| 「`GL_POINTS` は中心が clip 外に出るとスプライトごと捨てられ、画面端で円が消える（現行 SVG と挙動が違う）」 | **外れ**。ANGLE は点スプライトを quad にエミュレートするため**部分描画される**（NDC x=-1.02 の単独点で左端 9px の描画を確認）。実機も Windows/Edge → ANGLE のため問題なし |
| 「`gl_PointSize` の上限が低いドライバで破綻しうる」 | **外れ**。`ALIASED_POINT_SIZE_RANGE` = [1, 1024] で余裕。本番半径は 2.5×iconScale と小さく実害なし |

> 教訓: ドライバ挙動は規格からの推論では決まらない。**単独試験で機構を切り出して測る**。

## 未検証（実機側の課題）

- **UHD 615 で FBO 経路が通るか**。オフスクリーン FBO ＋ レベル数回の往復が、非力な統合 GPU で
  成立するか（描画崩れ・context lost の有無）。§8 の最悪障害モード（地図が黒画面）に直結する。
- **標準 circle 比の追加負荷**。FBO 往復とレベル数分のフルスクリーン quad 合成のコスト。
- **実行時メモリ**。FBO テクスチャ 8.8MB は小さいが、DPR 変動時の再確保挙動と合わせて確認。
- 本番点数（約1,725）・本番半径での再現（上記「情報」参照）。

## 推奨対応順

1. ~~**【MEDIUM】1** フィードバックループの解消~~ → **`3a42d36` で対応済み**（真因は mainFBO 取得位置。warning 0 件を確認）
2. ~~**【LOW】3** GL 状態の復元~~ → **`3a42d36` で対応済み**
3. ~~実機で `__runSubSuite('surface-go2-sub')` を実行し、動作可否＋方式間の相対負荷を取る~~
   → **実施済み（証跡 `perf-2026-07-25T15-0[7-8]-*-surface-go2-sub-*` 9件）。検証項目5 はクリア**
   — 実機で 59〜60fps・longtask 0・`ERROR:` なし・描画崩れなし・SVG 見本と濃さ一致。
   標準 circle 比の追加コストは測定限界以下。結果は計画書 §6 結果記録（検証項目5）
4. **【LOW】2 と【情報】4** は実機結果の**解釈時**に参照（コード修正は不要）
5. ~~**【LOW】5** FBO 束縛の漏れ（`render` 末尾の復元に `bindFramebuffer(mainFBO)` を 1 行追加）~~
   → **対応済み**（復元を末尾一箇所へ集約。正常フレームでは冪等＝見た目不変・回帰なし・feedback loop warning 0 件・中=SVG と右=カスタムの一致を実測確認・`tsc -b` 通過）

## 対応記録（`3a42d36`）

| 指摘 | 対応 | 検証 |
|---|---|---|
| MEDIUM1 feedback loop | **真因は mainFBO(本描画先)の取得が resize の後**だったこと。resize が内部で fbo を bind するため初回フレームのみ mainFBO=fbo になり、合成が tex を読みつつ tex を attach した fbo へ描いていた（2フレーム目以降は resize が走らず正常＝初回 2 件だけ残存）。mainFBO 取得を resize の前へ移動。tex を使用直後/resize 直後/FBO 描画前に `bindTexture(null)` する多重防御も追加 | feedback loop warning **0 件**を実測確認・見た目(中=SVG 正解と右=カスタムの一致)不変・`tsc -b` 通過 |
| LOW3 GL 状態復元 | `render` 末尾で tex/blend/attrib を復元 | 同上 |
| LOW2 / 情報4 | コード修正不要（実機結果の解釈時に参照） | — |

> MEDIUM1 の真因は「規格グレーだが偶然動く」ではなく **本描画先の取り違え**だった。レビューの
> `bindTexture` 外し案（1 行）だけでは初回フレームの `mainFBO=fbo` が残り解消しない。**取得位置の修正**で根治した。

### `3a42d36` の独立検証（レビュー側で再実測）

| 項目 | 結果 |
|---|---|
| **初回フレームからの feedback loop** | iframe で `subthreshold.html` を新規ロードし初回フレームから監視 → **warn/error なし・GL エラー滞留なし** |
| **回帰**（合成の正しさ） | (36,38,44) / (53,58,64) / (67,71,78) — **修正前と完全一致**。壊れていない |
| **resize フレームの FBO 経路** | `bindFramebuffer` を包んで追跡 → `main → fbo(resize) → fbo(描画) → main(合成)` と正しく復元。`mainFBO` が `null` で取れている |
| 型チェック | `tsc -b` エラー 0 |

> **レビュー側の反省**: 「描画は 28/28 成功」と報告したが、`triggerRepaint()` 後を測っていたため
> **バグが起きる初回フレームを一度も観測していなかった**。resize が走るフレームだけの不具合は、
> ページを開いた直後を含めて測らないと見えない。**新しいコンテキストを作って初回から監視する**
> （今回は iframe を使った）のが正しい手順だった。

---

## 【LOW】5. 点が 1 つも無いフレームで FBO 束縛が漏れる（**対応済み**）

### 現象

`resize` ブロックは `framebufferTexture2D` のために `fbo` を bind したまま抜ける。
それを `mainFBO` へ戻すのは**レベルループ内の合成パスだけ**（`bindFramebuffer` の追跡でも
復元は合成でしか起きていないことを確認）。

したがって **「resize が走る」かつ「どのレベルにも点が無い」フレームでは、`fbo` が bind された
まま `render()` を抜ける**。

### PoC では顕在化しない理由

1. テストデータに index3・index5 の点が常にある（`if (!count) continue` を全レベルが通ることがない）
2. カスタムレイヤーが**最後のレイヤー**（`addLayer` に `beforeId` なし）なので、漏れても後続の描画が無い

### 本番移植では両方崩れる

- `KyoshinSubThreshold` の対象は index 1〜6。**初回ロード時（強震データ到着前）は点がゼロ**で、
  これは resize が走る初回フレームと重なる。
- 本番ではこの上に `KyoshinPoints` / `KyoshinDetectedPoints` / `KyoshinMaxEffect` / ラベルが乗る。
  追跡で見たとおり **MapLibre はレイヤーごとに framebuffer を貼り直さない**ため、
  漏れたフレームでは**上のレイヤーがオフスクリーン FBO へ描かれて消える**。

### 修正案

`render` 末尾の状態復元ブロック（`3a42d36` で追加済み）に 1 行足すのが素直:

```ts
gl.bindFramebuffer(gl.FRAMEBUFFER, mainFBO)   // ← 追加。復元を一箇所にまとめる
gl.bindTexture(gl.TEXTURE_2D, null)
gl.disable(gl.BLEND)
gl.disableVertexAttribArray(aPos)
gl.disableVertexAttribArray(aQuad)
```

`resize` ブロック末尾で戻す形でも成立するが、復元を一箇所に集約する方が漏れにくい。

### 位置づけ

**PoC の結論（合成は正しい）を覆さない**。実機計測にも影響しない（点が常にあるため）。
~~**本番移植時に踏む穴**としての記録。~~ → **PoC 段階で対応済み**。`poc/subthreshold.ts` の `render` 末尾の
復元ブロック先頭に `gl.bindFramebuffer(gl.FRAMEBUFFER, mainFBO)` を追加した。正常フレームでは合成パス
（count>0 のレベル）で既に `mainFBO` へ戻っているため**冪等（見た目不変）**で、`resize` ＋ 全レベル点ゼロ
の合流フレームでのみ実効。参照実装をそのまま移植して穴を踏まないようにした。
