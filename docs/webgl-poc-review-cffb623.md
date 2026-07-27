# 本番ベースライン計測スクリプト（`cffb623`）レビュー — HIGH 1件。fps が名目時間割りで、比較相手と揃っていない

> 対象コミット: `cffb623` feat: 本番アプリの移動中ベースライン計測スクリプトを追加（依頼91343ea対応）
> 対象ファイル: `scripts/perf/measure-moving-baseline.js`（225行・新規）/
> `scripts/perf/vite-plugin-perf-report.ts`（+25行）/ 依頼書
> 依頼: [webgl-production-baseline-request.md](webgl-production-baseline-request.md)
> レビュー日: 2026-07-27（型チェック `npx tsc -b` **エラー 0**）
>
> **ステータス: 実機投入前に HIGH 1件の修正が要る。**
> - **【HIGH】`fps` と `domWrites` の毎秒換算が名目 `durationMs` 割り。** 比較相手の PoC 側は
>   実測 `elapsedMs` 割りで、**揃っていない**。しかも**重い区間ほど過大評価される**向きのバイアスで、
>   「本番の重さを測る」という本計測の目的と逆行する
> - **【対応確認】その他の仕様は満たしている**。3区間・`estimatedVsyncMs`・`blockMaxMs`・
>   `domWrites`・本番コード非改変
> - **【評価】`?file=` の allowlist 方式**（パストラバーサル防止）

---

## 【HIGH】`fps` が名目時間割り — 比較相手と定義が違う

### 事実

| 実装 | 計算式 |
|---|---|
| `measure-moving-baseline.js:173` | `fps: round(sorted.length / (**durationMs** / 1000))` |
| `measure-moving-baseline.js:150` | `perSec = (n) => n / (**durationMs** / 1000)`（`domWrites` の毎秒換算） |
| **比較相手** `poc/measure.ts:108` | `fps: round(sorted.length / (**elapsedMs** / 1000))` |

`durationMs` は呼び出し時に指定する**名目値**（15000 等）であり、実測経過時間ではない。

なお冒頭コメント（L29）には「**fps は実測 durationMs 割り**」とあるが、
`durationMs` は名目値であるため**この記述自体が矛盾している**。

### なぜ問題か

計測窓は `setTimeout(durationMs)` で閉じるため、**メインスレッドがブロックされた分だけ実測時間が延びる**。
本計測が狙う「移動中の本番アプリ」はまさにブロックが起きる局面である。

段階0 の実測（本番・静止時・15秒）では **longtask 合計 1593〜1691ms**（改修前）が観測されている。
**計測窓の 10% を超える**規模であり、移動中はさらに大きくなりうる。

名目値で割ると:

- **`fps` が過大に出る**（実測 16.5 秒かかったフレーム数を 15 秒で割る）
- **`domWrites` の毎秒換算も過大に出る**

**重い区間ほど誤差が大きくなり、しかも「実際より良く見える」向きに働く。**
「本番は重い」という体感を数字で確かめるための計測が、**重さを過小に報告する**ことになる。

さらに致命的なのは、**比較相手の PoC 側が実測割りである**こと。
定義が違うまま並べると、**本番側だけが有利に出る**。

### 同型の再発（3度目）

| 回 | 箇所 | 指摘 |
|---|---|---|
| 1 | 項目7 PoC | `fps` が名目 `durationMs` 割り → 実測割りへ統一 |
| 2 | 項目2 Leaflet PoC | 同上（MEDIUM 2） |
| **3** | **本件** | **同上** |

依頼書 §2「取得すべき指標」で
「**`fps` は名目時間ではなく実測 `elapsedMs` 割り**」と明示していた項目でもある。

### 修正

計測窓の開始時刻を記録し、終了時の実測経過を使う:

```js
const tStart = performance.now()
// … 計測窓 …
const elapsedMs = performance.now() - tStart
// fps: sorted.length / (elapsedMs / 1000)
// perSec: (n) => n / (elapsedMs / 1000)
```

`meta` に `durationMs`（名目）と `elapsedMs`（実測）の**両方**を残すと、
後からズレの大きさ自体を確認できる。冒頭コメントの「実測 durationMs 割り」も併せて修正されたい。

---

## 【対応確認】その他の仕様は満たしている

| 依頼項目 | 実装 | |
|---|---|---|
| 3区間（手動パン / 手動ズーム / 自動ズーム） | `segment: 'pan' / 'zoom' / 'autozoom'` | **○** |
| `estimatedVsyncMs`（先頭の静止2秒で取得・必須） | 実装あり・`meta` に格納 | **○** |
| `blockMaxMs` / `blockTop3Ms` | `MessageChannel` 検出器 | **○** |
| `domWrites`（`mapPane` / `kyoshin` 分計） | `MutationObserver` 2系統 | **○** |
| `frame` p50/p95/max | 実装あり | **○** |
| `longTask` count/totalMs/maxMs | 実装あり | **○** |
| meta（viewport / DPR / pathCount / circleCount / mode） | 実装あり | **○** |
| **本番コードを改変しない** | 注入型・`src/` に変更なし | **○** |

`estimatedVsyncMs` を**移動窓ではなく先頭の静止2秒で取る**設計は依頼どおりで正しい。
移動中に取ると負荷で歪み、天井の実測にならない。

区間の起動を**人の操作に委ねる**（合図後にドラッグ／ホイール／地震テストボタン）構成も、
本番コードを触らずに済ませる方法として妥当。

## 【評価】`?file=` の allowlist 方式

`vite-plugin-perf-report.ts` の `/__perf-script` に `?file=` を追加した際、
**任意パスを受け付けず allowlist（`PERF_SCRIPTS`）で解決**し、未知の値は 400 を返す実装にしている。

```ts
const PERF_SCRIPTS: Record<string, string> = {
  'kyoshin-static': 'scripts/perf/measure-kyoshin-static.js',
  'moving-baseline': 'scripts/perf/measure-moving-baseline.js',
}
```

`?file=../../..` のようなパストラバーサルを構造的に防いでいる。
既定値を従来の `kyoshin-static` にして**後方互換を保った**点も適切。

なお本プラグインは `apply: 'serve'` で**本番ビルドには含まれない**ことを確認済み。

---

## 実機投入前のチェックリスト

1. **`fps` / `perSec` を実測割りに直す**（上記 HIGH）
2. 修正後、`meta.elapsedMs` と `meta.durationMs` の差を1回確認する
   （ズレが小さければ以降の解釈も楽になる）
3. 実機条件を既存証跡と揃える（Surface Go 2・DPR 1.5・viewport 1272x768・`kyoshin` モード）
4. **各区間を複数回**（依頼書 §4 のとおり。人の操作依存で再現性が落ちるため）

---

## レビュー側での独立検証

| 確認項目 | 手段 | 結果 |
|---|---|---|
| `fps` の定義 | 新スクリプトと `poc/measure.ts` を照合 | **名目割り 対 実測割り＝不一致** |
| `perSec` の定義 | 同上 | **名目割り** |
| 仕様項目の網羅 | 依頼書の必須項目を grep で照合 | **fps 以外は全て充足** |
| パストラバーサル | `?file=` の解決方式 | **allowlist・未知値は 400** |
| 本番コードの非改変 | 差分に `src/` が含まれるか | **含まれない** |
| 型チェック | `npx tsc -b` | **エラー 0** |
