# 検証項目6（毎秒更新）PoC（`9b97a37`）レビュー — 設計は妥当。指標の選び方に問題

> 対象コミット: `9b97a37` chore: 検証項目6(毎秒更新)の PoC を追加 — setData vs feature-state を本番相当ベースマップ込みで計測
> 対象ファイル: `poc/realtime.html` / `poc/realtime.ts`（472行）
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §6 検証項目6 ／ 前レビュー [webgl-poc-review-3c2ddaf.md](webgl-poc-review-3c2ddaf.md)・[webgl-poc-review-4b0517c.md](webgl-poc-review-4b0517c.md)
> レビュー日: 2026-07-25（開発機 Chrome 150 / RTX 4070 Ti / DPR 1 / **165Hz モニタ**）
>
> **ステータス: 実機計測の前に MEDIUM 1件の対応を推奨**
> - 設計・実装は妥当。**前レビューの教訓が全て反映されている**
> - **【未対応】MEDIUM 1**: `p95` は毎秒スパイクを**構造的に拾えない**。このまま実機で回すと
>   「p95 は問題なし」と読めてしまい、肝心のカクつきを見逃す
> - **【未対応】LOW 2件**（点数が目標の 85% / ベースマップ頂点数の数え方）・**提案 1件**

## 結論

**設計は項目6 の問いに正しく向いている。** 本番相当のベースマップ（県境 fill＋細分区域境界＋県境線）を
敷いた上で baseline / feature-state / setData を比較する構成は妥当で、`feature-state` が
`circle-color` に正しく配線されていることも実地確認した。

ただし **`p95` を主指標にすると毎秒スパイクが観測できない**。実機に持ち込む前に指標を直したい。

`poc/realtime.ts` の型チェック・本体 `tsc -b` ともエラー 0。

## 評価できる点（前レビューの教訓が反映されている）

- **`BASE_RADIUS = 2.5`（本番半径）を使用** — 前回 `webgl-poc-review-3c2ddaf.md` の【情報4】で
  「`TEST_RADIUS=9` は本番の約13倍の塗り面積」と指摘した点が解消されている。
- **`START_ZOOM = 5` を全計測の冒頭で固定**（`measure.ts` と同思想）— `webgl-poc-review-4b0517c.md`
  の【HIGH4】の教訓。
- **全整数ズーム `[4,5,6,7,START_ZOOM]` のウォームアップ** — 同【HIGH1】の教訓。
- **`resetToBaseline()` で phase 間の状態を素に戻す** — feature-state の残り・setData の色残りを排除。
- **`setData` の `applyMs` が下界である旨をコメントで明記** — geojson-vt の再タイル化が worker で
  非同期のため同期部分しか測れない、という限界を正しく認識している。
- **`__benchApply` で更新 CPU 単独を測れる**（描画を挟まない）。
- **全点ランダム更新＝毎秒全点変化の最悪ケース**という設計。WebGL は変化数に依らず全画面再描画に
  なるため、上界を取る方針は正しい。
- **`feature-state` の配線が正しい**: `['coalesce', ['feature-state','lvl'], ['get','lvl'], 0]` で
  `circle-color` に届いている（配線が抜けていると色が変わらず再描画も起きず「速い」と誤読しうる）。
  `match` のケース割当（0〜8 を明示・9 は default）も正しい。

---

## 【MEDIUM】1. `p95` は毎秒スパイクを構造的に拾えない

### 測定

毎秒 1 回の更新は、全フレームのごく一部にしか現れない:

| | 開発機（165Hz） | 実機（60Hz） |
|---|---|---|
| 12 秒間のフレーム数 | **2,039**（実測） | 720（60fps 想定） |
| 更新回数 | 12 | 12 |
| **更新起因フレームの割合** | **0.59%** | **1.67%** |

**`p95` は上位 5% を切る**ため、1.67%（実機）も 0.59%（開発機）も **`p95` の外側に埋もれる**。

開発機で分布を実測した結果（各 12 秒・毎秒更新）:

| mode | p50 | p95 | p99 | max | 20ms 超のフレーム |
|---|---|---|---|---|---|
| feature-state | 5.9 | 6.0 | 6.1 | 6.2 | 0 |
| setData | 5.9 | 6.0 | 6.1 | **8.5** | 0 |

p50 / p95 / p99 がほぼ同値で、**唯一スパイクの痕跡を残しているのは `max`**（setData 8.5ms）。
※開発機（RTX 4070 Ti）では負荷自体が軽くスパイクが顕在化しない。判定は実機で行う前提だが、
**指標が拾えない構造は機種に依らない**。

### 影響

`measureRealtime` のコメントに

> setData の真の負荷は **frame.p95** / longTask（再タイル化がフレーム遅延・longtask に現れる）で読む

とあるが、**`p95` では読めない**。実装自体は `max` と `longTask` も出力しているため、
**指標の選び方だけの問題**である。ただしこのまま実機で回すと
「p95 は 16.9ms なので問題なし」と誤読する危険が高い。

### 修正案（後者を推奨）

1. **`p99` と「1 vsync（16.7ms）超のフレーム数」を追加する** — 分位数を増やす対症療法。
2. **更新直後のフレーム時間を直接記録する（本命）** — 項目6 の問いは「毎秒カクつくか」であり、
   分位数で薄めるより**当該フレームを名指しで測る**方が答えに直結する。

```ts
// measureRealtime 内
const updateFrameMs: number[] = []
let pendingUpdate = false
// rAF ループ内
if (pendingUpdate) { updateFrameMs.push(t - last); pendingUpdate = false }
// setInterval 内（apply の直後）
pendingUpdate = true
```

これで「毎秒の更新フレームが何 ms だったか」の 12 サンプルが直接得られる。
`stats(updateFrameMs)` を結果に含め、**判定はこの値と `longTask` で行う**。
併せてコメントの「frame.p95 で読む」を `max` / `longTask` / `updateFrame` へ修正する。

### 再現手順

```js
// 毎秒更新を UI から回しつつ、フレーム分布を自前で取る
const map = window.__rtMap
map.setZoom(5)
document.getElementById('fsBtn').click()          // または sdBtn
const d = []; let last = performance.now()
let raf = requestAnimationFrame(function loop(t){ d.push(t-last); last=t; raf=requestAnimationFrame(loop) })
await new Promise(r => setTimeout(r, 12000))
cancelAnimationFrame(raf); document.getElementById('stopBtn').click()
d.shift(); const s=[...d].sort((a,b)=>a-b); const q=p=>s[Math.floor(s.length*p)]
console.log({frames:s.length, p50:q(.5), p95:q(.95), p99:q(.99), max:s[s.length-1],
             over20: d.filter(x=>x>20).length})
```

---

## 【LOW】2. 点数が 1,458 で目標 1,725 の 85% にとどまる

### 原因

```ts
const step = Math.max(1, Math.round(coords.length / TARGET_POINTS))  // round(4372/1725)=round(2.53)=3
const sampled = coords.filter((_, i) => i % step === 0).slice(0, TARGET_POINTS)
```

`step` が **3** に切り上がるため `4372 / 3 = 1458` 点しか残らず、`slice(0, 1725)` では増えない。
実測でも `stat` 表示が `points : 1,458`。

### 修正案

```ts
const step = Math.max(1, Math.floor(coords.length / TARGET_POINTS))  // floor(2.53)=2
// → 2,186 点 → slice(0, 1725) でちょうど 1,725
```

本 PoC は「本番相当の負荷」を掲げているため、15% の不足は直す価値がある。
（同じサンプリングは `poc/main.ts` にもあり、そちらも 1,458 になっている）

---

## 【LOW】3. ベースマップ頂点数の数え方が曖昧でコメントと合わない

### 測定

| | 頂点数 |
|---|---|
| 県境リング | 12,444 |
| 細分区域リング | 16,029 |
| **コードの `basemapVertices`**（pref + sub を各 1 回） | **28,473** |
| **実際に描画される頂点**（**県境リングは fill と line の両方**に使用） | **40,917** |
| ファイル冒頭コメントの記載 | 「約 6 万頂点」 |

`loadBasemap()` は 1 つの県境リングから `fill` feature と `prefLines` feature の**両方**を作るが、
`v` はリングを 1 回しか数えていない。したがって `basemapVertices` は**描画される量を過小に表す**。

### 位置づけ

この数字は「本番の全画面再描画コストを再現している」という主張の根拠になるため、
**描画ベース（40,917）で数える**か、**コメントを実測値へ合わせる**かを決めたい。
どちらでも負荷そのものは変わらない（表示上の問題）。

---

## 【提案】4. `repaint-only` の対照モードがあると項目6 に直接答えられる

計画書 §6 検証項目6 の問いは

> WebGL は 1 点の変化でも全ビューポート再描画になる（…）。層 A の「毎秒の属性更新」が MapLibre 化後は
> 「毎秒 1 回の全画面描画」へ置き換わるため、フィルレート律速の実機で**毎秒のカクつきとして体感されないか**

である。現在の構成では `feature-state − baseline` に

- 毎秒 1 回の**全画面再描画**コスト
- `setFeatureState` × 1,725 の**更新 CPU** コスト

が混ざる。`map.triggerRepaint()` を毎秒呼ぶだけの `repaint-only` mode を足せば
**再描画コスト単独**が取れ、項目6 の問いにそのまま答えられる（3 行程度）。

`__benchApply` は更新 CPU の同期部分を測れるが、`setFeatureState` のコストは一部が描画時へ
繰り延べられるため、`feature-state − benchApply` では再描画コストを綺麗に分離できない。

---

---

## 【情報】5. `gebco` ソースに `maxzoom` 未指定（計測には影響しない）

```ts
gebco: { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256 }   // maxzoom なし → 既定 22
```

タイルセットの実カバレッジを確認したところ **z7 は 200・z12 は 404**。
`maxzoom` が無いため、タイルセットの範囲を超えてズームすると存在しないタイルを要求して 404 が出る。

**スイートの計測範囲（z4〜7）では発生しない**（実測: 要求されたタイル z は 5 / 7 / 8 のみ）ため
計測結果には影響しないが、**実機で手動ズームすると 404 がコンソールを埋める**。
`ERROR:` の目視確認と紛らわしいので、`maxzoom` を指定しておくと実機確認が楽になる。
本番移植時にはいずれ必要になる指定でもある。

## 未検証（実機側の課題）

- **UHD 615 で毎秒の全画面再描画が体感のカクつきになるか**（項目6 の本題）。
- **`setData` の再タイル化コスト**。geojson-vt が worker で 1,725 点を毎秒再タイル化する負荷は、
  非力な CPU では main thread のタイルアップロード待ちとして現れうる。
- **長時間稼働**（毎秒更新を数分〜数十分継続したときのメモリ・context lost）。
- 実行時メモリ（`jsHeapMB` は取得済みだが JS ヒープのみ）。

## 推奨対応順

1. **【MEDIUM】1** 更新フレーム時間の直接記録を追加し、判定指標を `p95` から
   `updateFrame` / `max` / `longTask` へ移す ← **実機で回す前に**
2. **【LOW】2** サンプリングを `Math.floor` にして 1,725 点にそろえる（同上・1 行）
3. 実機で `__runRealtimeSuite('surface-go2-rt')` を実行
4. **【LOW】3**（頂点数の数え方）・**【提案】4**（`repaint-only` 対照）は任意。
   4 を入れると項目6 の結論がより明確になる
