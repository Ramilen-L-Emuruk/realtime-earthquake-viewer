# 検証項目7（EEW 複合負荷）PoC（`b4524cd`）レビュー — 最悪局面が基準線から抜けている

> 対象コミット: `b4524cd` chore: 検証項目7(EEW発報シナリオの複合負荷)のPoCを追加
> 対象ファイル: `poc/eew-composite.html` / `poc/eew-composite.ts`（1,014行）
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §6 検証項目7・§8 ／
> 前レビュー [webgl-poc-review-b5d8bae.md](webgl-poc-review-b5d8bae.md)（項目5×6 交差点）
> レビュー日: 2026-07-26（開発機 Chrome / DPR 1 / 170Hz）
>
> **ステータス:**
> - **設計の骨格は良い。** 本番コード（`JapanMap.tsx` / `PsWaveLayer.tsx` / `useDmdssWaves.ts`）を調査して
>   タイムラインを再現しており、`composite-pause` / `composite-nopause` の対比は本番の緩和策の要否を
>   判定できる良い問いの立て方
> - **【HIGH 1】`flyto-only` と `baseline` で強震点カスタムレイヤーが実質存在しない**（実測: 描画 0点・
>   FBO 往復 0回）。**実機投入前に直すこと** — 一番測りたい「flyTo とカスタムレイヤー再描画の重なり」が
>   基準線から抜ける
> - **【HIGH 2】`wave.update()` が render サイクル外で GL を呼んでいる**。項目5×6 の dirty フラグ方式から
>   後退しており、`waveApply` の定義が項目5×6 の `apply` と揃わない
> - MEDIUM 3・LOW 4 は本設計への申し送り
> - 型チェック エラー 0（`--strict`・DOM lib 付き単体チェック）。`glError` 0

## 結論

**「EEW 発報中の複合負荷を測る」という枠組みは正しく作られている。** flyTo の多段発火、予報円の 100ms 周期、
強震点の毎秒更新、EEW 領域の `setData`（フィーチャ個数が変わる本番に忠実な形）——本番で同時に起きるものが
揃っている。`flyToFrame` を `movestart`〜`moveend` で別集計する設計も、項目6/5×6 の `updateFrame` と
同じ発想で正しい。

**ただし基準線（`flyto-only`）にカスタムレイヤーが乗っていないため、このままでは最悪局面を測れない。**
HIGH 1 を直さないと、`composite − flyto-only` の差に「強震点の描画コスト」が紛れ込み、
**何を測ったのか分からない数字**になる。

---

## 実測: GL 呼び出しを種別に数えた

`gl.drawElements` / `gl.drawArrays` をフックし、描画プリミティブ別に頂点数を積算した。

| 状態 | 強震点（POINTS） | FBO 合成 quad | S波扇形（TRIANGLE_FAN） | P波リング（LINE_LOOP） |
|---|---|---|---|---|
| **静止床**（`baseline` / `flyto-only`） | **0** | **0 回** | 0 | 0 |
| `composite` 実行中 | 1,725 | 6 回 | 50 頂点 | 48 頂点 |
| 停止後 | 0 | 0 回 | 0 | 0 |

---

## HIGH 1. `flyto-only` / `baseline` でカスタムレイヤーが実質存在しない

`makeKyoshinLayer` の初期状態は全点 index 0（非表示）である。

```ts
// 初期は静止床（index 0=非表示）に揃える
countingSort(new Uint8Array(n))
```

`resetToBaseline()` が呼ぶ `kyoshin.reset()` も同じく `countingSort(new Uint8Array(n))`。
そして `render()` は `if (!count) continue` で各レベルをスキップするため、**6 レベルすべてが飛ばされ
FBO 往復が 1 回も起きない**。実測どおり描画 0 点・quad 0 回である。

### なぜ致命的か

計画書 §8 に、この項目に対する注意を明記してある。

> `KyoshinSubThreshold` の再描画は標準 circle の 1.3〜2.7 倍重い（`repaint-only` の収束 15.8〜17.9ms vs
> 項目6 の 6.6〜12.0ms）。**項目7 ではこのレイヤーを有効にした状態で測ること。**

**`flyTo` 中は毎フレーム全画面が再描画される。** そこにカスタムレイヤーの再描画コストが乗るかどうかが
まさに項目7 で見たい点であり、現在の `flyto-only` にはそれが一切入っていない。

さらに `composite − flyto-only` の差に 3 つが混ざる。

1. 強震点の**描画**コスト（0 点 → 1,725 点 × 6 レベルの FBO 往復）
2. 強震点の**更新**コスト（カウンティングソート）
3. 予報円の更新＋描画コスト

**これは項目5×6 の HIGH 1 と同じ構造の誤り**である（あちらは静止床 1,725 点 vs 更新モード 1,465 点で
15% 差だった）。今回は 1,725 対 0 で全量が抜けており、しかも抜けている場所が最も効く局面である。

### 提案

静止床を index 1〜6 に揃える。項目5×6 の `initLevels` と同じ考え方でよい。

```ts
// 静止床: index 1〜6 を巡回（本番の EEW 発報中は強震点が必ず表示されている）
const initLevels = (n: number): Uint8Array => {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i++) a[i] = (i % MAX_SUB_IDX) + 1
  return a
}
```

これで `flyto-only` が「**強震点は表示されているが更新しない**」＝本番の EEW 発報中に最も近い基準線になり、
`composite − flyto-only` が純粋に「更新のコスト」を表すようになる。`baseline` も同様に揃える
（揃えないと `baseline` と `flyto-only` の差に描画コストが紛れる）。

---

## HIGH 2. `wave.update()` が render サイクル外で GL を呼んでいる

```ts
update(pRadiusKm, sRadiusKm, sInnerRadiusKm): void {
  const gl = glRef                          // onAdd で保存したコンテキスト
  …
  gl.bindBuffer(gl.ARRAY_BUFFER, ringBuf)
  gl.bufferData(gl.ARRAY_BUFFER, ringPos, gl.DYNAMIC_DRAW)   // ← render() の外
  …
  mapRef?.triggerRepaint()
}
```

項目5×6（`poc/subthreshold-rt.ts`）では **dirty フラグを立てて `render()` 内でアップロード**していた。
ここはその設計から後退している。

| 観点 | 内容 |
|---|---|
| **規約** | `CustomLayerInterface` の GL 呼び出しは `render()` 内で行うのが作法。MapLibre は毎回 bind し直すため実害は出にくいが、状態管理の前提から外れる |
| **指標の定義** | 項目5×6 の `apply` は**純粋な CPU**（GPU アップロードは `updateFrame` に乗る）。本 PoC の `waveApply` は**幾何計算＋GPU アップロードの合計**。**項目5×6 の数字と横並び比較できない** |
| **本設計** | context lost 後に stale な `glRef` を掴んだままになる。PoC では問題ないが本番に持ち込めない |

### 提案

`update()` は幾何計算と `dirtyWave = true` までにとどめ、`render()` の冒頭で `bufferData` する。
項目5×6 と同じ形になり、`waveApply` の定義も揃う。

---

## MEDIUM 3. P波リングが `LINE_LOOP`（本設計では成立しない）

`gl.drawArrays(gl.LINE_LOOP, …)` で P 波リングを描いているが、**WebGL の `gl.lineWidth()` は ANGLE
（Windows）でも Metal（Apple）でも 1px 以外サポートされないのが通例**である。本番の `PsWaveLayer.tsx` は
Canvas 2D の `ctx.arc` ＋ `lineWidth` で太い線を描いており、見た目を再現できない。

- **本設計では三角形ストリップでリングを組む必要がある**（内周・外周の 2 重リング → 頂点数が 2 倍以上）
- 負荷としては線が細い＝**過小評価**の方向。ただしリング 1 本のフィルレートは小さく影響は軽微
- PoC の計測結果を否定するものではないが、**本設計の工数見積りに影響する**ため申し送る

## LOW 4. `WAVE_SEGMENTS = 48` で円が粗い

`MAX_ZOOM = 8` で 400km 級の円を描くと目視でカクつく。本番の `ctx.arc` は滑らか。
頂点数の差（48 対 128 程度）は負荷としては無視できるが、**目視確認時に「実装のバグではない」と
知っておく必要がある**。

---

## 良い点

- **セルフレビュー 2 巡が効いている** — 二重起動ガード（`scenarioRunning`）、中断可能 sleep
  （`sleepAbortable`）、`elapsedMs` で fps を割る、`waitLayersReady` によるレイヤー初期化待ち
- **`waitForIdleEvent` と `waitIdle` の使い分け**と、その理由のコメントが秀逸。
  「`setData` 呼び出し 0.1ms 後に `areTilesLoaded()` が true に見えたが、本当の `idle` 発火は 300ms 以上後
  だった」という実測記録は、項目6 の `settle` 設計にも通じる貴重な知見
- **`flyToFrame` を `movestart`〜`moveend` で別集計** — コマ落ちを全体平均に埋もれさせない。
  項目6/5×6 の `updateFrame` と同じ発想
- **`DROPPED_FRAME_MS = 33.4` の閾値と根拠**（vsync 天井の約 2 倍。項目6 の「10ms台は実機で 2 倍ばらつく」
  を踏まえた区別）
- **本番コードを調査してタイムラインを再現している** — flyTo が単発でなく多段（新規発報・予報円成長に伴う
  再フィット・解除時の全国フィット）であること、予報円が `zoomstart`〜`zoomend` で停止する本番の緩和策を
  そのまま再現し、**その緩和の要否を測れる設計**（`composite-pause` / `composite-nopause`）にしている

---

## 再現手順

dev サーバー（`npm run dev:poc`・既定 5183）で `http://localhost:5183/poc/eew-composite.html` を開く。

```js
const map = window.__eewMap
const gl = map.painter.context.gl
let pts = 0, quad = 0
const oe = gl.drawElements.bind(gl), oa = gl.drawArrays.bind(gl)
gl.drawElements = (m, c, t, o) => { if (m === gl.POINTS) pts += c; return oe(m, c, t, o) }
gl.drawArrays = (m, f, c) => { if (m === gl.TRIANGLES && c === 6) quad++; return oa(m, f, c) }
const frame = async () => { pts = 0; quad = 0; await new Promise(r => { map.once('render', r); map.triggerRepaint() }); return { pts, quad } }

console.log('静止床:', await frame())              // → { pts: 0, quad: 0 }
document.getElementById('pauseBtn').click()
await new Promise(r => setTimeout(r, 1500))
console.log('composite 実行中:', await frame())     // → { pts: 1725, quad: 6 }
window.__eewStop()
```

---

## 推奨する対応順

1. **HIGH 1 を直す**（静止床を index 1〜6 に）。これを直さずに実機を回すと、
   **最悪局面が基準線から抜けたまま**の数字になり測り直しになる
2. **HIGH 2 を直す**（`wave.update()` を dirty フラグ方式へ）。`waveApply` の定義が項目5×6 と揃う
3. MEDIUM 3・LOW 4 は本設計への申し送り（PoC の修正は不要）
4. 実機スイート（`await window.__runEewSuite('surface-go2-eew')`）。1 スイート約 30 秒 × 4 モード。
   項目5×6 の経験から、**同一ページで連続実行すると基準線が安定する**（ページを開き直すと初回が重い）
5. 読み方の指針:
   - **`flyToFrame`** が主指標（`frame` 全体は `setData` の収束待ちを含み薄まる）
   - **`composite-pause` ≒ `flyto-only`** なら複合負荷でも問題なし＝GO
   - **`composite-nopause` だけ悪化**するなら「flyTo 中の予報円停止は MapLibre でも維持すべき」という
     設計制約が判明する（本番の緩和策に根拠が付く）
   - `settle` 系はモード比較に使わない（項目5×6 で判明した vsync 位相依存）
