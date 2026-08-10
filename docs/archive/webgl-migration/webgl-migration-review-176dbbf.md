# レビュー: `176dbbf`（時系列相関フック・実地震混入判別フック）

> 前提: [webgl-migration-hires-perf-diagnosis-3-2026-07-28.md](webgl-migration-hires-perf-diagnosis-3-2026-07-28.md)
> （flyTo進行中への時系列相関の提案）・
> [webgl-migration-hires-perf-caveat-real-quake-2026-07-28.md](webgl-migration-hires-perf-caveat-real-quake-2026-07-28.md)
> （実地震検知混入の判別手段が無いという注記）の両方への回答コミット。
>
> **ステータス: 指摘なし。両方の懸念に的確に応えている。**

---

## 1. 実装の正しさ

- **`buildMoveWindows`**（`movestart`/`moveend`のイベント列からカメラ移動区間を復元）は、
  深さカウンタによる入れ子の折り畳み・窓外開始/未クローズの保守的な丸め・重なり/隣接区間の
  マージという、標準的な区間統合アルゴリズムとして正しく実装されている。
  コミットメッセージによれば10ケースの単体テスト（単純flyTo・jumpTo 0幅・入れ子・
  開始取りこぼし・未クローズ・混入区間・重なりマージ・按分境界）を通しており、
  エッジケースへの配慮が丁寧。
- **`blockDuringMoveMs`/`blockWhileStillMs`**への按分は、`blockTimeline`の各時刻が
  `moveWindows`のいずれかの区間に入るかで単純に振り分けており、実装はシンプルで理解しやすい。
- **`blockTimeline`を先頭300件で頭打ち**にしているのは、`/__perf-report`の`MAX_BODY_BYTES`
  （1MB）を踏まえた妥当な安全策。
- `mm.on('movestart', ...)`は MapLibre GL JS の標準イベントであり、`jumpTo()`のような
  瞬間的なカメラ変更でも`movestart`/`moveend`のライフサイクルが発火するという前提
  （前回のレビューで`static-quake`の`moveendCount=1`を検証した際に確認済み）とも整合する。
- クリーンアップ（`mm.off('movestart'/'moveend'/'render', ...)`）も漏れなく行われている。

## 2. 両方の懸念への対応

- **diagnosis-3の申し送り**（重いブロックがflyTo進行中に集中するかの時系列確認）に対し、
  `move.blockDuringMoveMs`と`move.blockWhileStillMs`を直接比較できる形で回答している。
- **caveat-real-quakeの懸念**（静止シナリオへの実データ検知混入を判別する手段が無い）に対し、
  `moveTimeline`（各シナリオでの`movestart`実際の発生時刻列）を証跡に含めることで、
  静止シナリオのはずの区間に想定外の`movestart`が記録されていれば、実地震検知の混入を
  事後的に検出できるようにしている。

型チェック・構文チェック（`node --check`）ともにエラー0を確認。計測ハーネスのみの変更で
アプリ本体には影響しない。

---

## 3. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| 区間復元アルゴリズムの正しさ | `buildMoveWindows`の実装を読解 | 標準的な区間統合として正確 |
| イベント購読の解除漏れ | `measureWindow`終了時の`.off()`呼び出しを確認 | 漏れなし |
| 実地震混入判別の仕組み | `moveTimeline`が証跡に含まれることを確認 | 静止シナリオでの想定外movestartを事後検出可能 |
| 構文・型チェック | `node --check`・`npx tsc -b` | エラー0 |
