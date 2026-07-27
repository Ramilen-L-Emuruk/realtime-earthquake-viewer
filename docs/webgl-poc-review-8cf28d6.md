# fps の実測割り統一（`8cf28d6`）レビュー — 対応は正しい。ただし「最後の1箇所」ではなく5箇所残っている

> 対象コミット: `8cf28d6` fix: fps/毎秒換算を実測elapsedMs割りに統一（レビューcffb623 HIGH＋MEDIUM）
> 対象ファイル: `poc/measure.ts`（+9行）/ `scripts/perf/measure-moving-baseline.js`（+14行）
> 前レビュー: [webgl-poc-review-cffb623.md](webgl-poc-review-cffb623.md)
> レビュー日: 2026-07-27（型チェック `npx tsc -b` **エラー 0**）
>
> **ステータス: 修正内容は正しい。ただし MEDIUM 1件と、レビュー側の記述訂正が1件。**
> - **【対応確認】`measure-moving-baseline.js` と `poc/measure.ts:measureOnce` が実測割りになった。**
>   `meta.elapsedMs` を併記して名目とのズレを後から見られるようにした点も良い
> - **【訂正】レビュー側の「比較相手の PoC 側は実測 `elapsedMs` 割り」は不正確だった。**
>   `measureOneFly` はそうだったが、**`measureOnce` は名目割りだった**
> - **【MEDIUM】コメントの「fps 名目割りの最後の1箇所」は誤り。まだ5箇所残っている。**
>   うち `measure-kyoshin-static.js` は**段階0 の before/after を測った計測器**であり、
>   **その表と新しい移動中計測を並べられない**

---

## 【訂正】レビュー側の記述が不正確だった

前回わたくしはこう書いた:

> | **比較相手** `poc/measure.ts:108` | `fps: round(sorted.length / (**elapsedMs** / 1000))` |

**これは `summarizeFrames` の関数定義（引数名が `elapsedMs`）を見たものだった。**
呼び出し側が何を渡しているかは確認していなかった。

実際には:

| 呼び出し | 渡していた値 |
|---|---|
| `measureOneFly`（カメラ計測） | `elapsedMs`（実測）**○** |
| **`measureOnce`（層B 計測）** | **`durationMs`（名目）✗** |

**関数の中を見て「実測割り」と判断し、引数に何が渡るかを見なかった。**
指摘そのもの（本番スクリプトが名目割り）は正しかったが、
**「比較相手は実測割りだから揃っていない」という根拠の半分が誤り**だった——
実際には**両方とも名目割りの箇所を持っていた**。

対応側が `measureOnce` まで直したのは、レビューの指摘を超えて正しい範囲を見つけた結果である。

### 帰結: 層B の既存証跡の fps は名目割り

`measureOnce` は検証項目1（律速切り分け）と検証項目2（Leaflet 比較）の MapLibre 側で使われている。
**それらの証跡の `fps` は名目割りで記録されている。**

項目2 のレビュー（`82d4d39` MEDIUM 2）で Leaflet 側を実測割りに統一した際、
**MapLibre 側は直していなかった**——つまり項目2 の比較は `fps` について定義が揃っていなかった。

**ただし項目2 の結論は揺らがない。** あの判定は `frame.p50`（Leaflet 150.0ms＝9F 対 MapLibre 16.7ms＝1F）
で出したものであり、`fps` は主指標ではなかった。**`p50` は割り算を含まないため定義差の影響を受けない。**

---

## 【MEDIUM】「最後の1箇所」ではない — 5箇所残っている

`poc/measure.ts` のコメントに次の記述がある:

> レビュー(cffb623) MEDIUM: 層B の本関数だけ名目割りが残っていた＝**fps 名目割りの最後の1箇所**

**誤りである。** `durationMs / 1000` での除算は以下に残っている:

| 箇所 | 対応する検証項目 | 影響 |
|---|---|---|
| `poc/realtime.ts:496` | 検証項目6（毎秒更新） | 小（結論は `apply` の収束時間ベース） |
| `poc/subthreshold-rt.ts:781` | 検証項目5×6 交差点 | 小（同上） |
| `poc/subthreshold.ts:510` | 検証項目5（非加算合成） | 小（結論はピクセル一致・追加コスト） |
| **`scripts/perf/measure-kyoshin-static.js:97`**（`perSec`） | **段階0 before/after** | **大（下記）** |
| **`scripts/perf/measure-kyoshin-static.js:113`**（`fps`） | **段階0 before/after** | **大（下記）** |

### `measure-kyoshin-static.js` が残っているのが問題

これは**段階0（`KyoshinPoints` 差分更新化）の before/after を測った計測器**である。
依頼書 `91343ea` §1 で「移動中の比較の土台」として提示した表——

| | 改修前 | 改修後（現行 v3.23.1） |
|---|---|---|
| fps | 48.2 / 50.5 | **56.8** |
| DOM 属性書き込み | 10,368〜10,730 回/秒 | **21.8 回/秒** |

——の **`fps` と「回/秒」は、いずれも名目割りで算出されている。**

**一方、新しい `measure-moving-baseline.js` は実測割りになった。**
したがって**この表と移動中計測の数字を直接並べることはできない。**

しかも向きが悪い。名目割りは**重い区間ほど値を過大に出す**ため、
**静止時（段階0 の表）のほうが実際より良い数字**になっている。
「移動中は静止時よりどれだけ悪いか」を見ようとすると、**差が実際より小さく見える。**

### 対処

- **`before`（改修前）は測り直せない**（改修前のコードが要る）。
  したがって**注記で対応するしかない**——「段階0 の表は名目割り・移動中計測は実測割り」と明示する
- **`after`（現行 v3.23.1）は測り直せる。** `measure-kyoshin-static.js` を実測割りに直し、
  **静止時を新定義で1回測れば、移動中と同じ物差しで比較できる。** これは実機作業に追加1回で済む
- 残る3箇所（`realtime` / `subthreshold-rt` / `subthreshold`）は結論への影響が小さいが、
  **直すなら既存証跡との比較不能が生じる**点に注意（今から直す実益は薄い）

---

## 【対応確認】修正内容そのものは正しい

```js
// measure-moving-baseline.js
const tStart = performance.now()
// … 計測窓 …
const elapsedMs = performance.now() - tStart
const perSec = (n) => Math.round((n / (elapsedMs / 1000)) * 10) / 10
fps: round(sorted.length / (elapsedMs / 1000)),
```

`meta` に `durationMs`（名目）と `elapsedMs`（実測）**両方**を残したのは良い。
**ズレの大きさ自体が「計測窓内でどれだけブロックされたか」の指標になる**ため、
移動中の重さを読む材料が1つ増えている。

冒頭コメントの「fps は実測 durationMs 割り」という矛盾した記述も
「名目でなく実測 elapsedMs 割り」に修正済み。

`poc/measure.ts:measureOnce` にも `meta.elapsedMs` が追加され、
**層B の新規計測は名目とのズレを記録するようになった**。

---

## レビュー側での独立検証

| 確認項目 | 手段 | 結果 |
|---|---|---|
| `measureOnce` が名目割りだったか | 修正前の `summarizeFrames(frameDeltas, durationMs)` を確認 | **名目割りだった（レビュー側の前回記述が不正確）** |
| 修正後の定義 | 両ファイルの計算式 | **実測 `elapsedMs` 割りに統一** |
| 「最後の1箇所」の真偽 | `durationMs / 1000` を `poc/` と `scripts/perf/` で全検索 | **5箇所残存** |
| `summarizeFrames` の呼び出し3箇所 | 引数を確認 | **全て `elapsedMs`（実測）を渡している** |
| 型チェック | `npx tsc -b` | **エラー 0** |
