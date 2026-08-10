# 実機計測 第2回（Surface Go 2・2026-07-27）— 検証項目3: Leaflet が優った。ただし物差しが揃っていない疑いがある

> 計測機: Surface Go 2（Windows・Edge 150・**vsync 16.7ms / 60Hz**・DPR 1.5・viewport 1272x768）
> 対象: 検証項目3（カメラ操作）の Leaflet 側計測（`7755ee8` で追加した `__runLeafletCameraSuite`）
> 証跡: `surface-go2-leaflet-camera*` **34件**（2スイート × 17）／比較相手 `surface-go2-camera*` 34件
> 前報: [webgl-poc-surface-go2-2026-07-27.md](webgl-poc-surface-go2-2026-07-27.md)（MapLibre 側）
> 関連: [webgl-poc-review-61fdcaa.md](webgl-poc-review-61fdcaa.md)（資材レビュー・本文書の留保2件を事前に予告）
>
> **結論の要約**
> - **Leaflet PoC が明確に優った。** longtask は **0 対 13件**（MapLibre は32計測中13件で発火）。
>   2スイート目の `frame.p95` 中央値は **Leaflet 17.1ms（1フレーム）対 MapLibre 49.9ms（3フレーム）**
> - **しかし「Leaflet が優る」と結論してはならない。** 両エンジンで**同じ物差しになっていない疑い**がある。
>   Leaflet の着地（`moveend`）コストが計測窓から漏れている可能性が高く、**未計測**
> - **必要な追加作業は1つ**: `measureOneFlyLeaflet` に `moveendMs` を足して Leaflet 側のみ再計測
> - **移行判断（GO）そのものは動かない。** 項目3 は引き続き**保留**

---

## 1. 実測

`__runLeafletCameraSuite` を2スイート連続実行（各 17計測＝`vsync-check` 1 + 飛行 16）。
軸は MapLibre 側と同一（`faults=full` 31,646頂点・`points=1725`・`lw=1.2`・DPR 1.5）。
`estimatedVsyncMs` は全証跡で **16.7ms**、両エンジンで一致。

### 飛行 16計測の要約（`vsync-check` を除く）

| | fps 最小 / **中央** / 最大 | `frame.p95` 最小 / **中央** / 最大 | `frame.max` **中央** | **longtask 発火** |
|---|---|---|---|---|
| **MapLibre 1st** | 37.9 / **48.3** / 52.7 | 33.3 / **33.4** / 83.3 | 50.0 | **5 / 16件**（最大95ms） |
| **MapLibre 2nd** | 28.2 / **42.5** / 51.2 | 33.3 / **49.9** / 83.3 | 66.6 | **8 / 16件**（最大66ms） |
| **Leaflet 1st** | 43.4 / **49.8** / 54.0 | 16.8 / **33.1** / 50.0 | 50.0 | **0 / 16件** |
| **Leaflet 2nd** | 44.8 / **51.8** / 57.1 | 16.8 / **17.1** / 50.2 | 50.1 | **0 / 16件** |

### 読み取れること

- **longtask の差が最も大きい。0 対 13件**（MapLibre は32計測中13件で発火・最大95ms）。
  Leaflet は**両スイート・全32計測で1件も出していない**
- **2スイート目の `frame.p95` 中央値が決定的**。Leaflet **17.1ms＝1フレーム**に対し
  MapLibre **49.9ms＝3フレーム**。半数以上のフレームで 3 倍の開きがある
- **fps の差は小さい**（中央値 42.5〜48.3 対 49.8〜51.8）。fps だけを見ると僅差に見えるが、
  **p95 と longtask では明確に分かれる**
- **2スイート目の向きが逆**。MapLibre は悪化（fps 中央 48.3 → 42.5）、
  **Leaflet は改善（49.8 → 51.8）**。前報で疑った「熱の影響」は MapLibre 側にのみ現れている

---

## 2. なぜ結論にできないか — 物差しが揃っていない疑い

### 疑いの根拠

検証項目2 で確認済みの Leaflet の性質:

> Leaflet は「**動作中は静かで、離した瞬間に 1 回払う**」、MapLibre は毎フレーム描く
> （`webgl-poc-review-82d4d39.md`・計画書 §6 検証項目2）

**飛行中のフレームが軽いのは、Leaflet がその間サボっているからである可能性が高い。**
Leaflet は CSS transform で地図を引き伸ばし、実際の再描画を `moveend` まで遅延させる。

### `measureOneFlyLeaflet` は着地コストを捉えていない

現在の計測は `map.on('moveend', handler)` でハンドラが呼ばれた時点で
`cancelAnimationFrame(rafId)` する。**rAF が止まった後に走る処理はフレーム間隔として記録されない。**
`measureOneFlyLeaflet` の結果に `moveendMs` 相当のフィールドは**存在しない**
（`leaflet-measure.ts` に `moveendMs` は4箇所あるが、いずれも既存の `measureOnce`＝pan/zoom 計測用）。

**これは検証項目2 のレビューで HIGH1 として指摘し、`measureOnce` 側には対応済みの穴が、
新設のカメラ計測パスで再発している形である**（同型の再発は `estimatedVsyncMs` に続き2度目）。

### ただし全量が漏れているわけではない

- `elapsedMs` は `await moveEndPromise` の後に算出されるため、
  Leaflet の再描画がハンドラより先に走るなら**その時間は `elapsedMs` に含まれる**（fps を下げる方向）
- `PerformanceObserver` の `disconnect()` もハンドラ内なので、
  **50ms を超えるブロックがあれば longtask として捕捉されるはず**。実測は 0 件

したがって**着地コストは「存在するとしても 50ms 未満」**と推定できる。
それでも **`frame.p95` / `frame.max` には現れない**ため、
「フレーム時間の分布」で両者を比較する限り**Leaflet が構造的に有利に出る**。

### もう1つのバイアス（既知・同じ向き）

`webgl-poc-review-61fdcaa.md` の MEDIUM 2 で事前に予告したとおり、
**Leaflet PoC は本番より軽い**——本番の `ActiveFaultsLayer.tsx` は可視線（SVG）に加えて
当たり判定用の透明 Canvas 線を重ねて持つが、PoC はこれを省略している。
飛行中は両方が再クリップ・再描画の対象になるため、**本番の Leaflet はさらに重い**。

**2つのバイアスはいずれも Leaflet を実際より良く見せる向きに働いている。**

---

## 3. 必要な追加作業

**`measureOneFlyLeaflet` に `moveendMs` を追加し、Leaflet 側のみ再計測する。**

- 実装は検証項目2 で作った処方箋がそのまま使える
  （`moveend` ハンドラ内で `performance.now()` の差分を取り、結果に名指しで記録する）
- **MapLibre 側の再計測は不要。** MapLibre は毎フレーム描画するため着地に偏るコストを持たず、
  既存の `frame` 統計で全量を捉えている

**判定の分岐**

| `moveendMs` の実測 | 解釈 |
|---|---|
| 小さい（数ms〜十数ms） | **Leaflet 優位は本物**。項目3 は「Leaflet が優る」で決着 |
| 大きい（数十ms） | **物差しの違いが数字を作っていた**。体感（飛行中は滑らかだが着地で一瞬固まる）の評価に切り替える必要がある |

いずれの場合も、**Leaflet PoC が本番より軽いバイアス**は残る。
Leaflet 優位が確定した場合は、当たり判定線を足した条件での再計測を検討されたい。

---

## 4. 移行判断への影響

**GO は動かない。** 本項目は「MapLibre が Leaflet より速いか」を問うものだが、
一本化の根拠は検証項目2（毎フレーム全画面再描画で **9倍以上**）であり、そこは覆っていない。

**項目2 と項目3 で逆転が起きるのは、両者が測っている局面が違うためと考えられる（機序は未測定）。**

- **項目2**（毎フレーム強制再描画）: Leaflet は再描画を避けられず、真の描画コストが露出する → MapLibre 圧勝
- **項目3**（カメラ飛行）: Leaflet は再描画を着地まで遅延できる → Leaflet が有利に見える

**つまり Leaflet が速いのではなく、「飛行中は描かない」という戦略が効いている可能性がある。**
これが正しければ、`moveendMs` の計測で着地時のコストとして姿を現すはずである。**未検証。**

項目3 は引き続き **保留**。

---

## 5. レビュー側での独立検証

| 確認項目 | 手段 | 結果 |
|---|---|---|
| 証跡の到着完了 | 監視 `bkc6l2o5y`（3分間 新規なし・計247件） | **34件すべて到着・取りこぼしなし** |
| vsync の一致 | 両エンジンの `estimatedVsyncMs` | **両方 16.7ms** |
| 計測軸の一致 | MapLibre 証跡の `meta` と Leaflet PoC の既定値 | **faults=full(31,646頂点)・points=1725・lw=1.2・DPR 1.5 で一致** |
| `moveendMs` の有無 | `leaflet-measure.ts` の該当箇所を確認 | **カメラ計測パスには無し**（既存 `measureOnce` 用が4箇所） |
