# 検証項目3・4／§8（テキスト・メモリ）PoC（`8c75e49`）レビュー — 当たり判定は「差の出ない軸」で測っている

> 対象コミット: `539627b..8c75e49`（6コミット・1,234行追加）
> 対象ファイル: `poc/hittest.ts`（178行・新規）/ `poc/label.ts`（228行・新規）/
> `poc/webglMemoryTracker.ts`（322行・新規）/ `poc/measure.ts`（+284行）/ `poc/main.ts`（+44行）
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §6 検証項目3・4／§8
> レビュー日: 2026-07-27（開発機 Chrome）
>
> **ステータス: HIGH 2 件（うち HIGH 2 は実機計測より先に直すべき）・MEDIUM 1・LOW 1・情報 2。**
> - **HIGH 1**: 当たり判定の「r=8 が tolerance:8 と境界一致」は、**正方形と円の差が原理的に
>   現れない軸だけ**で確認している。Leaflet は円（ユークリッド距離）・bbox は正方形で、
>   斜め方向では最大 √2 倍（8px → 11.3px）まで拾う
> - **HIGH 2**: 新設の `measureOneFly` に `estimatedVsyncMs` が無い。項目2 の HIGH 4 で
>   `measureOnce` / `leaflet-measure.ts` に入れた対策が、**新設パスで再発している**。
>   カメラ計測は実機未実施のため、**投入前に直せば撮り直しを避けられる**
> - **追認**: `glyphs` 不要は MapLibre 実装で裏が取れた（`!this.url` 分岐が実在）。
>   `webglMemoryTracker` は二重ラップまで含めて安全性を確認。いずれも結論を支持する
> - **MEDIUM 3**: glyphs 無しは全グリフのクライアント生成を意味するが、そのコストが未計測
> - **LOW 4**: `webglMemoryTracker` は webgl1 環境で静かに 0 を返す

---

## 前提: 前回レビューの訂正（`539627b`）は正しい

`zoom-native` の「最大 90〜**304**ms」が誤りで、`frame.max`（303.8ms）と `longTask.maxMs`
（実測 90〜279ms）を混同していたという指摘は**そのとおり**。生データを開きながら別の指標を
拾っていた。90〜279ms への訂正、および `baseline-warm`（最大 293ms）が表の範囲外である旨の
明記を受け入れる。結論（一本化は GO・9倍以上）に影響しないことも確認した。

---

## HIGH 1 — 当たり判定の「境界一致」は、差が出ない軸だけを測っている

### 事実: Leaflet の許容域は円、bbox は正方形

Leaflet の当たり判定は `node_modules/leaflet/dist/leaflet-src.js` で以下のとおり:

| 箇所 | 内容 |
|---|---|
| `:8733` | `if (pointToSegmentDistance(p, part[k], part[j]) <= w) return true` |
| `:6335` | `function pointToSegmentDistance(p, p1, p2) { return Math.sqrt(_sqClosestPointOnSegment(...)) }` |
| `:8240` | `w = (stroke ? weight/2 : 0) + (renderer.options.tolerance \|\| 0)` |

`Math.sqrt` を通した**ユークリッド距離**との比較であり、許容域は**半径 w の円**である。

対して [`hittest.ts:124`](../poc/hittest.ts) の bbox 方式:

```ts
const bbox = [[x - r, y - r], [x + r, y + r]]
```

これは**1辺 2r の正方形**。円と正方形は、軸方向では一致し、斜め方向では最大 √2 倍ずれる。

### 問題: 検証がその「一致する軸」だけを見ている

テスト線は `TEST_LINE_LAT = JAPAN_CENTER[1]` 固定の**水平線**で（[`hittest.ts:62-81`](../poc/hittest.ts)）、
コメントも「この線からのオフセットは常に**南北方向**の見かけピクセル距離」と明示している。
南北方向は画面上では**垂直方向**である。

水平線に対する垂直オフセットでは:

- 円の判定: `√(0² + dy²) ≤ r` ⇔ `|dy| ≤ r`
- 正方形の判定: `|dy| ≤ r`（`|dx| = 0` なので x 側の条件は常に成立）

**両者は恒等的に同一。** つまり「8px 以内は必ずヒット・9px 以上は必ず非ヒット」という観測は
正しいが、それは**この軸では方式の違いが出ないから**であって、`tolerance:8` と等価であることの
証拠にはならない。層B で学んだ「飽和した指標は情報を持たない」と同じ構造で、
**差が出ない条件で差が出なかった**という無情報な結果を根拠にしている。

### 差の実寸

`r = 8` のとき、斜め45度方向では正方形の角まで `8√2 ≈ 11.3px`。線の端点付近や
斜めに走る断層では常にこの向きの差が効く。**面積比では約 1.27 倍、最大距離では約 1.41 倍**、
本番より広い当たり判定になる。活断層データは任意角度に走るため、これは例外的な条件ではない。

### 対処（3択）

| 案 | 内容 | 評価 |
|---|---|---|
| **(a)** | 検証を斜め45度オフセットに拡張し、差の実寸を測ってから採否を決める | 最小の追加作業。まず事実を得る |
| **(b)** | bbox で候補を絞り、`queryRenderedFeatures` の結果に対して点-線分距離で円に絞り込む | **推奨**。正確。コストは候補数ぶんのみ |
| **(c)** | 「約41%広い」を仕様として受け入れ、計画書に明記する | 判断としては有り。ただし暗黙にしない |

レビュー側の推奨は **(b)**。bbox は所詮ブロードフェーズであり、ナローフェーズを足すのが素直。
ただし (c) も正当な判断で、**選ぶこと自体は問題ではない**。問題は現在の計画書が
「境界一致を確認済み」＝**等価**と読める書き方をしている点にある。どの案を採るにせよ、
**根拠が軸に依存していることの明記が要る。**

---

## HIGH 2 — カメラ計測に `estimatedVsyncMs` が無い（項目2 HIGH 4 の再発）

項目2 のレビュー（`82d4d39`）で「vsync 周期の実測が無いため、フレーム時間が何フレーム分なのかを
後から判別できない」と指摘し、以下に対策が入った:

- [`measure.ts:184`](../poc/measure.ts) — `estimatedVsyncMs: phase === 'static' ? frame.p50 : null`
- [`leaflet-measure.ts:204`](../poc/leaflet-measure.ts) — 同上

**新設の `measureOneFly` の `meta` にはこのフィールドが無い。**
さらに [`measure.ts:445-478`](../poc/measure.ts) の `__runCameraSuite` は `measureOneFly` のみを
`rounds` 回まわし、`measureOnce(deps, 'static', ...)` を**一度も呼ばない**。

結果として、**カメラ計測の証跡群には vsync 周期の実測が一件も含まれない。**

### 兆候: 開発機の vsync 周期に食い違いがある

計画書 §6 検証項目3 には「開発機は高性能GPUのため全計測が **vsync天井16.7ms付近**」とある。
一方、レビュー綴り `b5d8bae` の情報5 では開発機を **170Hz**（vsync ≈ 5.88ms）と記録している。
**両立しない。** どちらかが誤っているか、ブラウザ側が 60Hz に制限されている
（電源設定・外部モニタ等）かのいずれかだが、**現在の証跡では判別できない**。
これはまさに `estimatedVsyncMs` を仕込む理由そのものである。

### 対処と、直す順序

`measureOneFly` の `meta` に `estimatedVsyncMs` を足し、`__runCameraSuite` の先頭で
`measureOnce(deps, 'static', ...)` を一度踏ませる（既存スイートと同じ形）。

**実機（Surface Go 2）計測はまだ走らせていない。** 走らせてから気づくと全証跡が撮り直しになる。
**この修正を先に入れてから実機に投入すること。**

---

## MEDIUM 3 — glyphs 無しはクライアント生成を意味するが、そのコストが未計測

「`glyphs` 不要」の結論自体は正しい（下記「追認1」）。ただしその機序は
「**glyphs URL が無いので全文字を TinySDF でローカル描画する**」である。副作用として:

- 通常（glyphs あり）ならラテン文字・数字はサーバー生成 PBF から来るが、**本構成では全文字がクライアント生成**
- グリフは `fontSize = 24 * textureScale(2) = 48px` の SDF として Canvas2D でラスタライズされる
  （`maplibre-gl-dev.mjs:1335`・`textureScale` のコメントは「CJK はより精細なので 2×」）
- 生成回数は**文字種のユニーク数**で決まる。区域名192件＋県名47件＋地方9件の日本語地名では
  ユニーク漢字は数百種に達する

[`label.ts`](../poc/label.ts) には計測フックが無く、確認は目視のみ。
**「描ける」は確認済みだが「安い」は未確認。** 実機（Surface Go 2）の初回ラベル表示時の
longtask を測っておくのが望ましい。ズーム帯をまたぐたびに新しい文字種が来るため、
`z6 → z8 → z11` の遷移で測ると本番の挙動に近い。

計画書の「テキスト描画は開発機検証済み・**大部分解消**」という記述は、
描画可否については正しいが、コスト面が残っていることを併記すべきである。

---

## LOW 4 — `webglMemoryTracker` は webgl1 環境で静かに 0 を返す

[`webglMemoryTracker.ts:308`](../poc/webglMemoryTracker.ts):

```ts
if (ctx && type === 'webgl2') {
  wrapContext(ctx as WebGL2RenderingContext)
}
```

`webgl` へフォールバックする環境では一切ラップされず、`snapshotWebglMemory()` が
**全項目 0 を返す**。0 は「WebGL を使っていない」とも「計測できていない」とも読めてしまう。
MapLibre v6 は webgl2 前提なので現行の対象環境では起きないが、警告を一行出すか、
スナップショットに `tracked: boolean` を持たせておくと事故らない。

---

## 追認1 — `glyphs` 不要は MapLibre 実装で裏が取れた

`node_modules/maplibre-gl/dist/maplibre-gl-dev.mjs` の `GlyphManager`:

```js
// _getAndCacheGlyphsPromise（:1240 付近）
if (!this.url || this._charUsesLocalIdeographFontFamily(id)) {
    glyph = entry.glyphs[id] = await this._drawGlyph(entry, stack, id);
    return { stack, id, glyph };
}
return await this._downloadAndCacheRangePromise(stack, id);
```

**`!this.url`**（glyphs URL 未設定）が第一条件のため、CJK かどうかに関わらず
**すべてのコードポイント**がローカル描画に回る。震度ラベルの ASCII 数字（`"1"`〜`"7"`）も同様。
`glyphs` を持たない style で数字が描けるのは、この分岐によるものである。

`text-font` の扱いも意図どおり機能する（`_createTinySDF`・`:1331-1334`）:

```js
const fontFamilies = stack ? stack.split(",") : [];
fontFamilies.push(defaultGenericFontFamily);   // "sans-serif"
const fontFamily = fontFamilies.map(...).join(",");
```

`text-font` の配列がそのまま CSS の font-family リストに組み立てられ、末尾に `sans-serif` が
フォールバックとして足される。`['Yu Gothic UI', 'Meiryo', 'MS Gothic', 'Noto Sans CJK JP']` は
Windows で先頭が効き、**これらを持たない環境（iOS/Android）でも `sans-serif` に落ちて描画は成立する**
（字形は変わる）。モバイルは「リリース後に問題が発覚してから対応」の方針が確定しているため、
対応は不要。字形が環境依存になる事実のみ記録する。

なお `stack === defaultStack` の分岐（`:1295`）により、`text-font` を明示している本構成では
`localIdeographFontFamily`（既定 `"sans-serif"`・`:22508`）ではなく `text-font` 側が使われる。
これも意図どおりの挙動。

---

## 追認2 — `webglMemoryTracker` は二重ラップまで含めて安全

セルフレビューで潰した3点（`bind` による `Illegal invocation`・`texStorage2D` 未フック・
context lost 時のカウンタ残留）はいずれも妥当な修正。加えてレビュー側で以下を確認した:

**`getContext` は同一 canvas に対して複数回呼べる**（同じコンテキストを返す）。その場合
`wrapContext` が再実行され、`gl.texImage2D` 等が**二重ラップ**される。しかし:

- `setTextureSize` / `setBufferSize` / `setRenderbufferSize` はいずれも
  **差分方式**（`bytes - prev` を加算して `prev` を更新）
- したがって同一オブジェクトに同じ値で2回呼ばれても、2回目の差分は 0
- `addEventListener('webglcontextlost', resetTrackerState)` は**同一の関数参照**なので重複登録されない

**冪等であり、実害は無い。** 差分方式を選んだことが、意図していたかは別として
この経路の安全性を担保している。

---

## レビュー側での独立検証

| 確認項目 | 手段 | 結果 |
|---|---|---|
| Leaflet の当たり判定が円か | `leaflet-src.js:8733 / 6335 / 8240` を直読 | **円（ユークリッド距離）で確定** |
| テスト線が水平か | `hittest.ts:62-81` の `TEST_LINE_LAT` 固定を確認 | **水平・オフセットは垂直方向のみ** |
| `estimatedVsyncMs` の所在 | `grep` で `measure.ts` / `leaflet-measure.ts` を横断 | **`measureOnce` のみ・`measureOneFly` に無し** |
| `__runCameraSuite` が static を踏むか | `measure.ts:445-478` を直読 | **踏まない（`measureOneFly` のみ）** |
| glyphs 無しで ASCII が描けるか | `maplibre-gl-dev.mjs` の `GlyphManager` を直読 | **`!this.url` 分岐で全文字ローカル生成** |
| `text-font` が効くか | `_createTinySDF:1331-1334` を直読 | **CSS font-family として組み立て・`sans-serif` フォールバック付き** |
| 二重ラップの安全性 | `webglMemoryTracker.ts` の差分方式を検証 | **冪等・実害なし** |

## 計測の落とし穴（記録）

本レビューで「`localIdeographFontFamily` が既定 `"sans-serif"` だから CJK は描けるが、
ASCII 数字は glyphs が要るのでは」と疑ったが、これは**誤りだった**。
`localIdeographFontFamily` の経路（`_charUsesLocalIdeographFontFamily`）は
**glyphs URL がある場合の分岐**であり、URL が無い場合はその手前の `!this.url` で
全文字がローカルに回る。

**条件式の第一項を読まずに第二項の意味だけで推論すると、こうなる。**
`if (A || B)` の B だけを検討して A を見落とした形で、
「両方が同じ向きに倒れているときは切り分けの軸そのものを疑う」（項目7 の教訓）と同系統の失敗。
今回は実装を直読したため報告前に自己訂正できた。
