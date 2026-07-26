# 検証項目6（毎秒更新）PoC（`9b97a37`）レビュー — 設計は妥当。指標の選び方に問題

> 対象コミット: `9b97a37` chore: 検証項目6(毎秒更新)の PoC を追加 — setData vs feature-state を本番相当ベースマップ込みで計測
> 対象ファイル: `poc/realtime.html` / `poc/realtime.ts`（472行）
> 関連: 計画書 [webgl-rendering-migration-plan.md](webgl-rendering-migration-plan.md) §6 検証項目6 ／ 前レビュー [webgl-poc-review-3c2ddaf.md](webgl-poc-review-3c2ddaf.md)・[webgl-poc-review-4b0517c.md](webgl-poc-review-4b0517c.md)
> レビュー日: 2026-07-25（開発機 Chrome 150 / RTX 4070 Ti / DPR 1 / **165Hz モニタ**）
>
> **ステータス: HIGH 7 まで対応済み・方式差の分離を実測確認。残るは LOW 8 のみ（実機計測は可）**
> - **【未対応・新規】LOW 8**: 計測終了時に最後の apply の裾が切れ、`settle` に ~0ms の打ち切り
>   サンプルが混入（`mean` が約 17% 下振れ）・`updateFrame` が 1 件欠ける（`n = applyN − 1`）。
>   **`p50` / `max` は無傷で結論は変わらない**ため、実機計測はこのまま進めてよい（下記「8.」）
> - 設計・実装は妥当で、前レビューの教訓が全て反映されていた。指摘はいずれも指標・負荷の精度に関するもの
> - **【対応済み `e27552b`】HIGH 7**: `updateFrame` が `setData` の負荷（worker 再タイル化の数百ms バースト）を
>   捉えない問題を、apply→次の idle までの収束時間 `settle` を計測項目に追加して解消（feature-state は render
>   1回で収束し settle≈updateFrame、setData は 336ms のバーストを丸ごと含む。p95/max>1000ms で素朴 setData 不可）。
>   併せて `updateFrame` を固定窓から render 発火ベースへ、`settle` を FIFO（全 apply 個別解決・非収束は timeout
>   打ち切り）へ再設計し、セルフレビュー3巡で「最悪ケースで指標が沈黙/逆転する」穴を実機前に潰した
> - **【対応済み `aa7067d`／HIGH7 で再設計】HIGH 6**: `updateFrame` が全画面再描画を取りこぼす問題（計測用 rAF が
>   `render` より先に発火する）を是正。当初の固定窓 `UPDATE_FRAME_WINDOW` は HIGH7 対応で render 発火ベースに置換
> - **【対応済み `3560156`】MEDIUM 1**: 更新起因フレームを名指しで記録する `updateFrame` を追加し、
>   判定指標を `frame.p95` から `updateFrame` / `max` / `longTask` へ移した（記録フレームのずれは HIGH6/7 で是正）
> - **【対応済み `3560156`】提案 4**: `repaint-only` モード（属性更新なしで全画面再描画のみ＝再描画
>   コスト単独）を追加し、スイートに 1 phase 追加。項目6「毎秒1回の全画面描画がカクつくか」に直答できる
> - **【対応済み `3560156`】LOW 2**: サンプリングを `round`→`floor` にし 1,458→1,725 点
> - **【対応済み `3560156`】LOW 3**: 県境リングを fill+line で 2 回計上し basemapVertices を 40,917 へ是正
> - **【対応済み `3560156`】情報 5**: `gebco` に `maxzoom:7` を指定
> - 開発機で確認: points 1,725 / base 40,917 / settle が setData 336ms・feature-state 8ms と方式差を分離・
>   applyN===settleN（記録漏れ0）・コンソールエラー0。実機（Surface Go 2）で `__runRealtimeSuite('surface-go2-rt')` が次のステップ

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

---

## 【HIGH】6. `updateFrame` が全画面再描画を取りこぼしている（**`aa7067d` で対応済み**）

MEDIUM 1 の対策として入った `updateFrame` の**方針は正しい**（分位数で薄めず更新フレームを名指しで
測る）。しかし**記録するフレームが 1 つ手前**で、肝心の全画面再描画が入っていない。

### 測定（イベント時系列・2 回とも同じ並び）

```
apply-end@401.1  →  raf@403  →  render@406.4  →  raf@408.8
                     ↑ここを updateFrame として記録        ↑再描画はこの区間(403→408.8)に入る

apply-end@1401   →  raf@1403.1 → render@1407.3 → raf@1409
```

### 原因

`setInterval` で `apply()` が走った後、次のフレームで

1. **計測用 rAF が先に発火**（先に登録されているため）→ ここで `dt` を `updateFrameMs` に入れる
2. **その後に MapLibre が再描画**（`render` イベント）

という順になる。したがって `updateFrame` に入るのは **`apply()` の CPU コストだけ**で、
**全画面再描画のコストは次のフレームの `dt` へ落ちる**。

これは rAF コールバックの登録順という**構造的な事実**であり、機種・負荷に依らない
（開発機では全フレーム 5.9ms 前後で差が出ないため、時間差ではなくイベント順序で確認した）。

### なぜ重大か

検証項目6 の問いは「**毎秒 1 回の全画面再描画が体感のカクつきになるか**」であり、
取りこぼしているのが**まさにその全画面再描画**である。

コードには `// 【判定はこれで読む】` と明記されているため、実機で `updateFrame.max = 16.7ms` と
出れば「問題なし」と読んでしまう。しかし実際の再描画フレームはその次にあり、
`3560156` のコミットメッセージ自身が記録している

> feature-state で frame.max 50.1 に対し updateFrame.max 16.7

も、**50.1ms のフレームが 1 つ後ろにずれていた**と考えれば整合する。

なお `frame.max` と `longTask` は出力されているため**計測全体が盲目なわけではない**。
ただし「判定はこれで読む」と名指しした指標が外している以上、誤読の危険は高い。

### 修正案（前者を推奨）

**1. 更新後の複数フレームを拾って最大を取る**（単純・確実）

```ts
let pendingUpdate = 0
// setInterval 内（apply / triggerRepaint の直後）
pendingUpdate = 2                    // 直後 2 フレームを見る
// rAF 内
if (pendingUpdate > 0) {
  pendingUpdate--
  span.push(dt)                      // 2 つ集めたら max を 1 サンプルとして updateFrameMs へ
}
```

**2. `render` イベントを基準にする**（厳密）

`map.on('render')` で再描画の発生を捉え、**その `render` を含むフレーム区間**の `dt` を記録する。

いずれの場合も、`repaint-only` phase も同じ経路を通るため同時に是正される。

### 再現手順

```js
const map = window.__rtMap
const log = []; const t0 = performance.now()
const mark = k => log.push(`${k}@${(performance.now()-t0).toFixed(1)}`)
map.on('render', () => mark('render'))
let raf = requestAnimationFrame(function l(){ mark('raf'); raf = requestAnimationFrame(l) })
setTimeout(() => {
  mark('apply-start')
  for (let i = 0; i < 1725; i++) map.setFeatureState({source:'points', id:i}, {lvl:(Math.random()*10)|0})
  mark('apply-end')
}, 400)
await new Promise(r => setTimeout(r, 1200))
cancelAnimationFrame(raf)
console.log(log.slice(log.findIndex(x => x.startsWith('apply-end')), -1).slice(0, 5))
// → apply-end, raf, render, raf, raf の順（raf が render より先）
```

---

## 【HIGH】7. `updateFrame` は `setData` の負荷をほぼ全く捉えていない（**`e27552b` で対応済み**）

HIGH 6 の対策（`UPDATE_FRAME_WINDOW = 2`）は **`feature-state` については正しい**が、
**`setData` には効いていない**。両方式で `render` の発生タイミングが根本的に違うため。

### 測定

`apply` 直後を 1 フレーム目として、`render` イベントが発生したフレーム番号:

| 方式 | `render` 発生フレーム | ウィンドウ(1〜2)内 | ウィンドウ外 |
|---|---|---|---|
| feature-state | **[1]** | **1 件** | 0 件 |
| **setData** | **[4, 7, 8, 9, 10, … 56]** | **0 件** | **51 件** |

`apply` から地図が `idle` へ落ち着くまでの所要時間:

| 方式 | `applyMs`（同期部分） | **収束まで（apply → idle）** | `render` 回数 |
|---|---|---|---|
| feature-state | 0.4ms | **4.9ms** | 1 |
| **setData** | 0.2ms | **315ms** | **51** |

### 何が起きているか

`setData` は geojson-vt が **worker で再タイル化**するため、

1. 同期部分（properties 書き換え＋`setData` 呼び出し）は **0.2ms** で戻る
2. `render` は **4 フレーム目から始まり**、タイルの再生成・アップロードが終わるまで
   **51 フレーム・315ms にわたって断続的に続く**（MapLibre はソースが loading の間描き続ける）

つまり **`setData` のコストは単発スパイクではなく持続的な再描画バースト**であり、
「更新直後の N フレーム」という窓の考え方そのものが `setData` には合わない。

### なぜ重大か — 比較の順位が逆転する

`updateFrame` は

- `feature-state`: 再描画を含む**実コスト**
- `setData`: **同期部分（0.2ms）のみ**、再描画バーストは全て窓の外

を測ることになる。両者を並べると **`setData` の方が安く見える** — 事実と正反対の順位になる。
検証項目6 は「素朴な `setData` が可か、`feature-state` が必須か」を決める項目であり、
この逆転はそのまま移植方針の誤りにつながる。

なお開発機（RTX 4070 Ti・165Hz）で既に **315ms** かかっている。実機（UHD 615）では更に伸びるため、
**毎秒更新の周期 1,000ms に収まらず、地図が常時再描画状態になる**可能性がある。
これは項目6 の結論を左右する重要な観測点でありながら、現在の指標では検出できない。

### 修正案

**`settleMs`（apply → 次の `idle` までの時間）を計測項目に追加する。** これが `setData` の
負荷を最も素直に表し、「毎秒周期に収まるか」に直答する。

```ts
// setInterval 内（apply 直後）
const tApply = performance.now()
map.once('idle', () => settleMs.push(performance.now() - tApply))
```

- `feature-state` では `settleMs ≈ updateFrame` になる（render 1 回で収束するため）
- `setData` では `settleMs` が本体のコストを表す
- `settleMs > 1000ms` なら**更新が周期内に収束していない**＝素朴な `setData` は不可、と即断できる

`updateFrame` は `feature-state` 用の指標として残してよい（そちらでは正しく機能している）。
併せて「【判定はこれで読む】」のコメントに、**方式によって見るべき指標が違う**旨を明記したい。

### 再現手順

```js
const map = window.__rtMap
// PoC と同じ FC を組む（floor サンプリング・id 付与）は省略、fc / N を用意した前提
const t0 = performance.now()
for (let i = 0; i < N; i++) fc.features[i].properties.lvl = (Math.random()*10)|0
map.getSource('points').setData(fc)
console.log('sync', performance.now() - t0)          // → 0.2ms
map.once('idle', () => console.log('settle', performance.now() - t0))  // → 315ms
```

---

## 【LOW】8. 計測終了時に最後の apply の裾が切られる（`e27552b` 時点で**未対応**）

HIGH 7 の対応で入った `settle` は**方式差を正しく分離できている**（下記「検証」）。
ただし**計測ウィンドウの末端で最後の apply の裾が切れる**ため、2 つの副作用がある。

### 測定（setData・durationMs=6000）

```
settle:      n=6  p50=315.7  max=315.9  mean=263.52   ← mean だけ大きく下振れ
updateFrame: n=5                                       ← apply n=6 に 1 件足りない
apply:       n=6
```

`(5 × 315.8 + 0) / 6 = 263.2` が実測 mean 263.52 と一致する。すなわち
**1 件が ~0ms として `settleMs` に積まれている**。

### 原因

`setInterval(…, 1000)` は `durationMs`=6000 のとき t≈1000…6000 の 6 回発火し、
**最後の apply（t≈6000）は計測終了と同時**になる。このとき

- `settle`: 終了処理 `for (const t of pendingApplies) settleMs.push(tEnd - t)` が
  **`tEnd - t ≈ 0`** を積む。「収束しなかったので下限値で打ち切る」ための処理が、
  **「まだ時間が経っていないだけ」の apply にも適用されている**。
- `updateFrame`: 記録には apply → `render` → 次の rAF が要るが、その前に
  `cancelAnimationFrame` が走るため**最後の 1 件が失われる**（全モードで `n = applyN − 1`）。

### 影響と位置づけ

- **`p50` / `max` は無傷**（ドキュメントもそこを読めと指示している）ため、**結論は変わらない**。
- ただし **`mean` は約 17% 下振れ**する（サンプル数が少ないほど悪化）。
- **`console.assert(settleMs.length === applyMs.length)` は通ってしまう**
  （`settleMs` は 6 件あるため）。**`updateFrameMs` は検査対象外**なので、
  「記録漏れ 0」と表示されながら `updateFrame` は 1 件欠けている。assert が誤った安心を与える。

### 修正案

**計測終了後に排水期間を設ける。** `durationMs` 経過で `setInterval` を止め、
そこから数百 ms（例: 1 周期分 or `min(SETTLE_TIMEOUT_MS, 1000)`）待ってから確定する。
これで「本当に収束しなかった apply」だけが打ち切り対象になり、`updateFrame` の
最後の 1 件も記録される。

併せて `console.assert` に `updateFrameMs.length` の検査も加えると、この種の漏れを自己検知できる。

### 検証: HIGH 7 の対応は正しく効いている

| mode | `settle` p50 / max | `updateFrame` p50 / max | `settleTimeouts` | applyN / settleN |
|---|---|---|---|---|
| repaint-only | 5.8 / 6.2 | 5.9 / 6.0 | 0 | 6 / 6 |
| feature-state | **7.7 / 8.6** | 5.9 / 5.9 | 0 | 6 / 6 |
| **setData** | **317 / 317.5** | 5.8 / 5.9 | 0 | 6 / 6 |

`setData` と `feature-state` で **約 40 倍**の差が出ており、HIGH 7 以前は見えなかった方式差が
明確に分離されている。`console.assert` も沈黙（`settleN === applyN`）。
`updateFrame` は render 発火起点になり、**apply ごとに 1 サンプル**を保つ設計も確認した。

## 未検証（実機側の課題）

- **UHD 615 で毎秒の全画面再描画が体感のカクつきになるか**（項目6 の本題）。
- **`setData` の再タイル化コスト**。geojson-vt が worker で 1,725 点を毎秒再タイル化する負荷は、
  非力な CPU では main thread のタイルアップロード待ちとして現れうる。
- **長時間稼働**（毎秒更新を数分〜数十分継続したときのメモリ・context lost）。
- 実行時メモリ（`jsHeapMB` は取得済みだが JS ヒープのみ）。

## 推奨対応順

1. ~~**【MEDIUM】1** 更新フレーム時間の直接記録を追加し、判定指標を `p95` から移す~~
   → **`3560156` で対応。ただし記録フレームが 1 つ手前で全画面再描画が入っていない（HIGH 6）**
2. ~~**【LOW】2** サンプリングを `Math.floor` にして 1,725 点にそろえる~~ → **対応確認済み**（`points : 1,725`）
3. ~~**【LOW】3** 頂点数の数え方~~ → **対応確認済み**（`base : 40,917 頂点`＝描画ベースと一致）
4. ~~**【提案】4** `repaint-only` 対照~~ → **対応確認済み**
   （静止時 `render` 0 件 → `triggerRepaint`×3 で 3 件＝no-op でないことを実測。スイートに 4 phase）
5. ~~**【情報】5** `gebco` の `maxzoom`~~ → **対応確認済み**（`maxzoom = 7`）
6. ~~**【HIGH】6** `updateFrame` の記録フレームを 1 つ後ろへ（または `render` 基準に）~~
   → **`aa7067d` で対応（案1: apply 直後 2 フレームの最大を採用）。render の乗る次フレームを捕捉すると実測確認**
7. ~~**【HIGH】7** `settleMs`（apply → 次の `idle`）を計測項目に追加する~~
   → **`e27552b` で対応（settle 追加＋updateFrame の render ベース化＋settle の FIFO 化）。セルフレビュー3巡で PASS**
8. 実機で `__runRealtimeSuite('surface-go2-rt')` を実行 ← **準備完了。次はこれ**
