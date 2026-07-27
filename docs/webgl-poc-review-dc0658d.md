# 着地コスト計測の対称化（`dc0658d`）レビュー — 指摘なし。項目3 は全て測り直しになる

> 対象コミット: `dc0658d` fix: MapLibre側カメラ計測にも着地コスト計測を対称化（レビューb46f058 MEDIUM2）
> 対象ファイル: `poc/measure.ts`（+30行）/ `poc/README.md` / 計画書
> 前レビュー: [webgl-poc-review-6e71035.md](webgl-poc-review-6e71035.md)
> レビュー日: 2026-07-27（型チェック `npx tsc -b` **エラー 0**）
>
> **ステータス: 指摘なし。対称化は完全。ただし再計測の範囲に注意が要る。**
> - **【対応確認】両エンジンが完全に同条件になった。** `LANDING_SETTLE_MS`・検出器の実装・
>   フィールド名・`cancelAnimationFrame` と `po.disconnect()` の位置まで一致
> - **【副次的な収穫】longtask が両エンジンで比較可能になった**（前回は Leaflet 側だけ観測窓が広かった）
> - **【注意】項目3 の既存証跡 68件はすべて旧実装。** 新実装で両エンジンとも測り直しになる

---

## 【対応確認】対称化は完全

`measureOneFly`（MapLibre）と `measureOneFlyLeaflet`（Leaflet）を照合した:

| 観点 | MapLibre | Leaflet | |
|---|---|---|---|
| `LANDING_SETTLE_MS` | 300 | 300 | **一致** |
| ブロック検出器 | `MessageChannel`・閾値 3ms | 同一 | **一致** |
| 検出開始 | `fly()` の直前 | 同一 | **一致** |
| `cancelAnimationFrame` | `moveend` 時点 | 同一 | **一致**（frame 統計＝飛行中のみ） |
| `po.disconnect()` | settle 後 | 同一 | **一致**（longtask 窓が揃った） |
| 出力フィールド | `landingBlockMaxMs` / `landingBlockTop3Ms` | 同一名 | **一致** |
| 限界の注記 | 「区間内最長ブロックで着地由来は非保証」 | 同一趣旨 | **一致** |

**前回 MEDIUM 2 で指摘した「MapLibre の着地コストが無いという仮定が未検証」は、
仮定を検証可能な形に変えることで解消された。** `landingBlockMaxMs` が ≈0 になれば
仮定が証跡で裏付けられ、そうでなければ仮定自体が誤りだったと分かる。**どちらに転んでも結果が得られる。**

## 【副次的な収穫】longtask が比較可能になった

前レビュー MEDIUM 1 で「Leaflet 側だけ `po.disconnect()` が settle 後に移り、
実機第1回の `longtask 0/32件` と単純比較できない」と指摘した。

**MapLibre 側も同じ位置に揃ったため、新実装同士なら longtask は正しく比較できる。**
（旧実装の証跡とは比較できない点は変わらない。）

---

## 【注意】項目3 の既存証跡はすべて旧実装

| 証跡 | 件数 | 実装 |
|---|---|---|
| `surface-go2-camera*` | 34 | **旧**（着地検出なし・longtask 窓は飛行中のみ） |
| `surface-go2-leaflet-camera*` | 34 | **旧**（同上） |

**両方とも新実装で測り直す必要がある。** 混同を避けるため、
**新しいラベルを使う**こと（例: `surface-go2-camera-v2` / `surface-go2-leaflet-camera-v2`）。

**推奨する計測の形**:

- 両エンジンとも **2スイート連続**（第1回と同じ形）。
  MapLibre 側は第1回で 2スイート目が悪化（fps 中央 48.3 → 42.5）しており、
  **熱の影響が疑われる（未検証）**ため、1スイートだけでは片側の条件が揃わない
- 計 4スイート＝68計測。1スイート約1分＋間の冷却
- **エンジンの実行順を第1回と揃える**か、逆順も取るのが望ましい。
  第1回は MapLibre → （他の計測）→ Leaflet の順で、Leaflet のほうが後（機体は冷えていた）

**読むべき点**（結果が出たら）:

1. **`landingBlockMaxMs` の左右差** — Leaflet に着地コストが偏っているか。
   これが項目3 の判定の核心になる
2. **longtask の左右差**（新実装同士で初めて公平に比較できる）
3. `frame.p95` / `fps` は第1回と定義が変わっていないため、**第1回とも比較できる**
   （`elapsedMs` に settle を含めていないため）

---

## レビュー側での独立検証

| 確認項目 | 手段 | 結果 |
|---|---|---|
| 両実装の対称性 | `LANDING_SETTLE_MS` / `landingBlock*` / `MessageChannel` を両ファイルで照合 | **完全一致** |
| `frame` 統計の定義 | `cancelAnimationFrame` の位置 | **両者とも `moveend` 時点＝飛行中のみ** |
| longtask 観測窓 | `po.disconnect()` の位置 | **両者とも settle 後** |
| `elapsedMs` の可比性 | settle を含むか | **含まない＝第1回と比較可能** |
| 型チェック | `npx tsc -b` | **エラー 0** |
