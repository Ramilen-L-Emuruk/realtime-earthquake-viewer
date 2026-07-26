# 検証項目5×6 交差点 PoC（`b5d8bae`）レビュー — 実装は正しい。測れる負荷になっていない

> 対象コミット: `b5d8bae` chore: 検証項目5×6(カスタムレイヤーの毎秒更新)の PoC を追加 — インデックスバッファ方式で計測
> 対象ファイル: `poc/subthreshold-rt.html` / `poc/subthreshold-rt.ts`（820行）
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §6「検証項目5×6 の交差点」／
> 前レビュー [webgl-poc-review-3c2ddaf.md](webgl-poc-review-3c2ddaf.md)（項目5）・[webgl-poc-review-9b97a37.md](webgl-poc-review-9b97a37.md)（項目6）
> レビュー日: 2026-07-26（開発機 Chrome / DPR 1 / **リフレッシュレート 170Hz** / canvas 1904×929）
>
> **ステータス: HIGH 1・MEDIUM 3・情報 5 を対応済み。HIGH 2 は負荷軸のコード対応済み・実機での分離点探しが残**
> - **【対応済み】HIGH 1**: `genLevels` を index 1〜6 に閉じ、`repaint-only`（1,725点）と更新モード（1,725点）の
>   描画点数を一致させた。ピクセル等価性（差0）も回帰なしで再確認済み（下記「検証」）
> - **【コード対応済み・実機計測は未実施】HIGH 2**: `TARGET_POINTS` を `?points=N` の URL クエリで振れるようにした
>   （既定①1,725／②4,372／③17,250）。①②③ のいずれでも点数どおりに描画され、④の複製ロジック（実観測点を
>   巡回して埋める）も含め動作は確認済み。**ただし「どこで custom/naive が分離するか」は実機スイートでの計測が
>   必要**（下記「8.」）。開発機/検証環境では3モードとも vsync 天井に張り付くため、この環境での計測に意味は無い
> - **【対応済み】MEDIUM 3**: `apply` 統計のコメントを「差分不要・単体で更新CPU」に修正
> - **【対応済み】情報 5**: `meta.estimatedVsyncMs`（baseline の `frame.p50`）を追加し、天井の手がかりを証跡に残した
> - **実装の正しさは検証済み**: `custom-update` と `naive-rebuild` の描画結果が**ピクセル完全一致**（差 0）。
>   index バッファ方式は静的座標＋レンジ描画で素朴実装と等価な絵を出している
> - **項目5・項目6 のレビュー指摘は全件踏襲されている**（下記「踏襲の確認」）。手戻りなし
> - LOW 4 は本設計への申し送りのまま（PoC 側の対応は不要）

## 結論

**「カスタムレイヤーを毎秒更新できるか」には答えられる PoC になっている。**
FBO 二層合成のカスタムレイヤーに毎秒更新の経路が通り、index バッファ方式が素朴実装と同じ絵を
出すことは実測で確認できた。両 PoC の狭間に落ちていた穴は、少なくとも「実装可能」の側では埋まった。

**ただし「index 方式が naive より軽い」という第二の狙いは、今の負荷では判定できない。**
3モードすべてが vsync 天井に張り付き、`apply` は `performance.now()` の分解能に埋もれる。
層B 検証項目1 で踏んだ vsync クランプの再来で、**負荷を上げる軸を持たない限り検出力はゼロ**。

`poc/subthreshold-rt.ts` の型チェックはエラー 0（`--strict`・DOM lib 付き単体チェック）。
`glError` 0・`longTask` 0・`settleTimeouts` 0。

---

## 踏襲の確認（項目5・6 のレビュー指摘）

前レビューで挙げた項目が漏れなく入っている。列挙しておく。

| 出典 | 指摘 | 本 PoC の対応箇所 |
|---|---|---|
| 項目5 MEDIUM1 | `mainFBO` の取得を resize より**前**に置く（初回フレームの feedback loop） | `render` 冒頭 260行 |
| 項目5 MEDIUM1 | 合成で bind した tex を FBO 描画前・使用後に外す | 303行・343行 |
| 項目5 LOW3/LOW5 | GL 状態復元。点ゼロのフレームでも `mainFBO` へ戻す | `render` 末尾 348-353行 |
| 項目5 LOW2 | scissor は敷かない（毎秒更新では BBox が全画面化して効かない） | 294-296行のコメントで明示 |
| 項目6 HIGH6 | `updateFrame` を `render` 発火起点で名指し測定 | 611-635行・653-663行 |
| 項目6 HIGH7 | `settle`（apply→idle 収束）と `SETTLE_TIMEOUT_MS` | 617-621行・685-692行 |
| 項目6 LOW8 | 窓終了後 `DRAIN_MS` で末尾 apply を排水 | 698-704行 |
| 項目6 | `console.assert` で n の三者一致を検査 | 714-717行 |
| 項目6 LOW2 | `floor` で間引き間隔（`round` だと目標の85%になる） | 399行 |
| 層B | 全整数ズームのウォームアップ＋`START_ZOOM` 固定 | 581-586行 |

## 検証: 両経路の等価性（ピクセル差 0）

同一のレベル配列を `applyCustom` / `applyNaive` に渡し、`render` ハンドラ内で `readPixels` して比較した。

| 項目 | 結果 |
|---|---|
| 比較領域 | 512×400（204,800 px・画面中央） |
| custom / naive の描画点数 | 1,485 / 1,485（一致） |
| 差のあるピクセル数 | **0**（0.000%） |
| 最大チャンネル差 | **0** |
| `glError` | 0 / 0 |

**index バッファ方式は実装として正しい。** 静的な座標バッファをレベル順 index のレンジで
`drawElements(POINTS, count, UNSIGNED_SHORT, rangeStart*2)` する経路が、レベル別に座標を持つ
素朴実装と 1 ビットも違わない絵を出している。offset のバイト換算（Uint16=2）も正しい。

---

## HIGH 1. `repaint-only` と更新モードで描画点数が15%違う（差分の土台が揃っていない）

`gl.drawElements` / `gl.drawArrays` をフックして POINTS の頂点数を積算した実測。

| mode | レベル生成 | 描画点数 | POINTS drawcall |
|---|---|---|---|
| `repaint-only`（静止床） | `initLevels` = `(i % 6) + 1` → index **1〜6** | **1,725** | 6 |
| `custom-update` / `naive-rebuild` | `genLevels` = `(random * 7) \| 0` → index **0**〜6 | **1,465** | 6 |

**差 260点が `genLevels` の index 0 の個数（260）と完全に一致する。** index 0 は
`subThresholdOpacity(0) = 0` で非表示のため描画から抜けるが、静止床の `initLevels` には
index 0 が一切現れない。

### 影響

- `custom-update − repaint-only` の差分に「描画量が約15%少ない」バイアスが乗る。
  drawcall 数（FBO 往復6回）は同じなので、差は純粋にフィルレート。
- バイアスの向きは**更新コストの過小評価**。「更新は思ったより軽い」と読み間違える方向に効く。
- ファイル冒頭 63-64行の宣言「**毎秒全点変化の最悪ケース＝上界**」と逆行している。
  上界を測る意図なら、更新モードの方が点数が少ないのは不整合。
- `custom-update` vs `naive-rebuild` の比較は**公平**（同じ `genLevels` を使い、実測でも点数一致）。
  崩れているのは `repaint-only` を基準にした差分だけ。

### 提案

`genLevels` を index 1〜6 に閉じる。

```ts
for (let i = 0; i < n; i++) a[i] = ((Math.random() * MAX_SUB_IDX) | 0) + 1
```

これで両モードが 1,725点で揃い、「全点変化の上界」という記述とも整合する。
本番の平常時は index 0（データ無し）も現れるが、**上界を測る PoC では点数を減らす向きの
現実性より、差分の土台を揃える方が優先**（現実の部分変化は上界の内側に必ず収まる）。

---

## HIGH 2. 今の負荷では3モードの差が測定分解能を下回る（検出力ゼロ）

開発機で全モードを 5秒窓で測った実測。

| mode | fps | frame p50 | `updateFrame` p50 | `settle` p50 | `apply` p50 |
|---|---|---|---|---|---|
| `repaint-only` | 169.8 | 5.9 | **5.9** | 4.3 | 0.0 |
| `custom-update` | 169.8 | 5.9 | **5.9** | 4.9 | 0.0 |
| `naive-rebuild` | 169.8 | 5.9 | **5.8** | 4.8 | 0.0 |

**開発機は 170Hz で vsync 天井が 5.9ms。3モードとも天井に張り付いている。**
層B 検証項目1 と同じ構図で、軸を振っても差が出ない。

`apply` 側も分解能に負けている（60反復・描画なしの単体ベンチ）。

| 対象 | p50 | p95 | max |
|---|---|---|---|
| `applyCustom`（カウンティングソート） | 0.0 | 0.1 | 0.1 |
| `applyNaive`（レベル別座標再構築） | 0.0 | 0.1 | 0.1 |
| `triggerRepaint` 単体 | 0.000 | 0.000 | 0.000 |

`performance.now()` はブラウザ側で 0.1ms 粒度に粗視化されるため、1,725点の O(n) 処理は
**原理的に測れない**。倍率の計算すら成立しない（0 除算）。

### 実機でも同じになる見込み

項目6 の実機3回計測で `repaint-only` の settle p50 は **6.6〜12.0ms**（60Hz 天井 16.7ms の下）。
本 PoC の `custom-update` はそこへ「カウンティングソート（0.1ms 未満）＋ `bufferSubData` 3.4KB」を
足すだけ。`naive-rebuild` の「`bufferData` 13.8KB × 6回」も GPU アップロードとしては極小。

つまり実機でも3モードは同じ帯に落ち、**項目6 で判明した「10ms台は約2倍ばらつく」に埋もれる**。
3回計測してもモード間の順序が安定しない可能性が高い。

### これは PoC の失敗ではない（が、狙いの半分は空振りする）

- **GO 判定には十分**: 「毎秒更新が天井内で回り、longtask も出ない」ことは示せる。
  項目7（EEW 複合負荷）へ積む材料としては足りている。
- **空振りするのは第二の狙い**: 冒頭 15-16行「index 方式の優位を数値で示す対照」は達成できない。
  「差が無い」という結果を「index 方式に優位が無い」と読むのも誤り（どちらも分解能以下、が正しい）。

### 提案: 点数を軸にする

層B の教訓（**負荷を下げて動かないのは無情報／上げて動かないのは余力の上界を示す積極的結果**）に従い、
`TARGET_POINTS` を振れるようにする。

| 段 | 点数 | 意味 |
|---|---|---|
| ① | 1,725 | 現行の強震モニタ観測点（現状） |
| ② | 4,372 | `station-coords.json` の全観測点（間引きなし） |
| ③ | 17,250 | 現行の10倍。差が出る点を探す |

どこかで `custom` と `naive` が分離すれば方式の優位が数値で示せる。③まで振って分離しないなら
「**10倍規模まで両方式とも余力あり**」という上界の証明になり、これは十分に価値のある結論。

---

## MEDIUM 3. `apply` 統計のコメントが実装と食い違う

755行のコメント:

> 更新処理そのものの同期コスト。（…）`custom-update` − `repaint-only` ≒ 更新 CPU の実体

実装はこうなっている。

| mode | `applyMs` に入るもの | `triggerRepaint` の位置 |
|---|---|---|
| `custom-update` / `naive-rebuild` | `applyCustom` / `applyNaive` のみ（670-672行） | 計測**後**（674行） |
| `repaint-only` | `triggerRepaint` のみ（677-679行） | 計測**内** |

差を取ると「カウンティングソート − `triggerRepaint`」という意味のない量になる。
実測で `triggerRepaint` は p50/p95/max すべて 0.000ms なので実害は無いが、
**`custom-update` の `applyMs` 単体がすでに純粋な更新 CPU** であり、差分を取る理由が無い。

冒頭 18行の判定式（`custom-update − repaint-only` ≒ 更新 CPU）は `updateFrame` について述べたもので、
そちらは GPU アップロード＋再描画を含むため差分に意味がある。**この2つが混ざっている。**
コメントを「`apply` は差分不要。単体で更新 CPU」と直すのが正しい。

---

## LOW 4. `Uint16Array` index の上限（本設計への申し送り）

`sortedIndices` が `Uint16Array` なので **65,535点が上限**。

- 現状 1,725点・本番の全観測点 4,372点なら余裕
- HIGH 2 の負荷軸を③（17,250点）まで振っても収まる
- 将来 `KyoshinPoints`（index 7+）も同方式に寄せて合算する場合も余裕
- 超える場合、WebGL2 は `UNSIGNED_INT` を**標準サポート**（WebGL1 の `OES_element_index_uint` 拡張は不要）。
  `drawElements` の offset 換算が `*2` → `*4` に変わる点だけ注意

制約としては緩いが、本設計に持ち込むとき「なぜ Uint16 で足りると判断したか」の根拠は残す価値がある。

---

## 情報 5. 開発機は 170Hz（天井 5.9ms）。実機 60Hz（16.7ms）と天井が違う

`fps 169.8` は開発機のリフレッシュレートが 170Hz であることを意味する。

- **開発機で「天井内」を確認しても実機の判定にはならない**（天井が 5.9ms と 16.7ms で別物。
  さらに GPU 性能も違う）。逆に開発機の方が天井は厳しい
- 現在の証跡 `meta` には DPR・canvas サイズ・viewport はあるが**天井の手がかりが無い**。
  baseline の `frame.p50`（＝実質 vsync 間隔）から逆算はできるが、明示されている方が読み違えない
- 提案（軽微）: `meta` に baseline 実測の vsync 間隔か、`screen` 由来のリフレッシュレートを残す

---

## 再現手順

dev サーバー（`npm run dev:poc`・既定 5183）で `http://localhost:5183/poc/subthreshold-rt.html` を開く。

### 描画点数の非対称（HIGH 1）

```js
const map = window.__subRtMap, subRt = window.__subRt
const gl = map.painter.context.gl
let pts = 0
const oe = gl.drawElements.bind(gl), oa = gl.drawArrays.bind(gl)
gl.drawElements = (m, c, t, o) => { if (m === gl.POINTS) pts += c; return oe(m, c, t, o) }
gl.drawArrays = (m, f, c) => { if (m === gl.POINTS) pts += c; return oa(m, f, c) }
const frame = async () => { pts = 0; await new Promise(r => { map.once('render', r); map.triggerRepaint() }); return pts }

subRt.setMode('custom'); subRt.reset()
await new Promise(r => map.once('idle', r))
console.log('repaint-only(initLevels):', await frame())   // → 1725

const lv = new Uint8Array(1725)
for (let i = 0; i < 1725; i++) lv[i] = (Math.random() * 7) | 0
subRt.applyCustom(lv)
console.log('custom-update(genLevels):', await frame())   // → 約1465
```

### 両経路の等価性（ピクセル差 0）

`readPixels` は **`map.once('render', ...)` ハンドラの中**で呼ぶ（`preserveDrawingBuffer` が無いため。
項目5 レビューで一度踏んだ罠）。同一の `lv` を `applyCustom` / `applyNaive` に渡し、
それぞれのフレーム内で同じ矩形を読んで差分を取る。

### 分解能の限界（HIGH 2）

```js
window.__benchSubRtApply('custom-update', 60)   // p50 0.0 / max 0.1
window.__benchSubRtApply('naive-rebuild', 60)   // p50 0.0 / max 0.1
```

開発機で3モードを測る場合は `window.fetch` の `__perf-report` 宛だけ潰して、
実機証跡（`scripts/perf/results/`）を開発機の数字で汚さないこと。

---

## 推奨する対応順

1. **HIGH 1 を直す**（`genLevels` を 1〜6 に）。点数が揃っていない状態で実機を回すと測り直しになる
2. **HIGH 2 の負荷軸を入れる**（`TARGET_POINTS` を URL クエリか定数で振れるように）。
   ①1,725 → ②4,372 → ③17,250。分離点を探すか、上界を証明する
3. MEDIUM 3 のコメント修正（実装変更なし）
4. 実機スイート（`await window.__runSubRtSuite('surface-go2-subrt')`）。項目6 に倣い**3回**測る
   （ミリ秒スケールのばらつきが約2倍あるため単発では信頼区間が不明）
5. 結果を計画書 §6「検証項目5×6 の交差点」へ記録し、項目7（EEW 複合負荷）へ進む

---

## 8. 対応確認（HIGH 1・HIGH 2・MEDIUM 3・情報 5）

上記 1〜3（＋情報5）をコードに反映し、検証環境（Chrome・DPR 1・60Hz 相当）で回帰確認した。

### HIGH 1: 点数の非対称は解消

`genLevels` を `((Math.random() * MAX_SUB_IDX) | 0) + 1` に変更（index 1〜6 のみ生成）。

```
repaint-only(initLevels): 1,725
custom-update(genLevels): 1,725   ← 修正前は約1,465（差260=index0の個数）
```

`custom-update` と `naive-rebuild` の等価性（ピクセル差0・最大チャンネル差0）も回帰なしを再確認した。

### HIGH 2: 負荷軸をコードに追加（実機での分離点探しは未実施）

`TARGET_POINTS` を `?points=N` の URL クエリから読む `readTargetPoints()` に変更（既定 1,725 は不変）。
`loadPositions` は `TARGET_POINTS` が実観測点数（station-coords 約4,372）を超える場合、実測点を巡回で
複製して埋めるようにした（GPU/CPU 負荷の測定が目的で観測点の実在性は問わないため）。

```
?points=4372  → points: 4,372（station-coords 全点・間引きなし）
?points=17250 → points: 17,250（複製ロジックで生成・描画点数も17,250と一致）
```

①②③ いずれも指定どおりの点数で描画されることは確認した。**「どの点数で custom/naive が分離するか」を
確かめる実機スイートの実行はこの対応に含まない**（検証環境・開発機のいずれも vsync 天井に張り付き、
分解能以下の環境で測っても情報が無いため）。実機（Surface Go 2 等）で
`await window.__runSubRtSuite('surface-go2-subrt', 12000)` を `?points=` を変えながら回す作業が残る。

### MEDIUM 3: コメント修正のみ（実装変更なし）

`apply` のコメントを「差分は取らない — apply 値そのものが単体で更新CPU。差分を見るべきは updateFrame」
に修正。数値・ロジックの変更はない。

### 情報 5: `meta.estimatedVsyncMs` を追加

`baseline` 計測の `frame.p50` を `meta.estimatedVsyncMs` としても記録するようにした（`baseline` 以外は
`null`）。検証環境での実測は `frame.p50 = estimatedVsyncMs = 16.7ms`（60Hz 相当）で一致を確認した。

### 残作業

実機スイート（`__runSubRtSuite`）を `?points=1725 / 4372 / 17250` の3水準で回し、分離点の有無を
計画書 §6「検証項目5×6 の交差点」に記録する。項目4・5（推奨対応順）はここに引き継ぐ。
