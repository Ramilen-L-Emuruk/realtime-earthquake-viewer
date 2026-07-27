# 本番ビルド計測の実現（`546ee9f`）レビュー — 対応は正しい。ただしレビュー側の予想が揺らいだ

> 対象コミット: `546ee9f` feat: 本番ビルド(vite preview)での計測を可能に（残作業D・壁1/壁2対応）
> 対象ファイル: `scripts/perf/vite-plugin-perf-report.ts`（+140/-65）/ `scripts/perf/measure-moving-baseline.js`（+27）/
> `package.json`（+1）/ 依頼書
> 依頼: [webgl-production-build-measure-request.md](webgl-production-build-measure-request.md)
> レビュー日: 2026-07-28（型チェック `npx tsc -b` **エラー 0**）
>
> **ステータス: 指摘なし。ただし記録すべき事項が2件。**
> - **【対応確認】壁1・壁2 とも解決**。推奨案(a)採用・**build 系フック 0個**を確認し、生成物非影響を裏付けた
> - **【訂正】レビュー側の依頼書に誤りがあった**（配信コマンド `npm run preview` は standard 変種になる）
> - **【要注意・予想の揺らぎ】開発機の参考観測が、レビュー側の予想と矛盾する**。
>   `domWrites` はビルドモードで変わらないと書いたが、開発機で **1041 → 11.6** の差が出ている

---

## 1. 【対応確認】壁1 — `configurePreviewServer` による解決

依頼書で推奨した案(a)がそのまま採られた。実装も安全側に倒されている:

```ts
export function perfReportPlugin(): Plugin {
  // apply:'serve' は付けない。build/transform フックが無いので build 時は何もせず、生成物に影響しない
  return {
    name: 'perf-report',
    configureServer(server) { registerPerfMiddlewares(server.middlewares, ...) },
    configurePreviewServer(server) { registerPerfMiddlewares(server.middlewares, ...) },
  }
}
```

**レビュー側で検証した安全性**:

| 確認項目 | 手段 | 結果 |
|---|---|---|
| build 系フックの有無 | `transform` / `generateBundle` / `renderChunk` / `buildStart` / `buildEnd` / `closeBundle` を検索 | **0個** |
| 両サーバーの等価性 | `configureServer` / `configurePreviewServer` の中身 | **同一の `registerPerfMiddlewares` を共有** |
| 型チェック | `npx tsc -b` | **エラー 0** |

**`apply:'serve'` を外してもバンドルに影響しないことが構造的に保証されている**——
プラグインが持つのはサーバーのミドルウェア登録だけで、ビルドパイプラインに一切触れない。
対応側も `npm run build:dmdss` 成功・生成物不変・`dist-dmdss/sw.js` 生成を確認済みと報告している。

## 2. 【対応確認】壁2 — SW の扱いと新規 meta

`swControlled`（`navigator.serviceWorker.controller` の有無）と `buildMode` が meta に追加され、
本番ビルド検証時に `swControlled: true` / `buildMode: 'production'` が記録されることを確認したとの報告。
**dev 証跡と本番証跡を後から機械的に判別できる**形になっている。

運用（SW 有効・タイル温め済みで統一）も依頼どおり。

## 3. 【追加】依頼書に無かった改善2件

- **`segment: 'static'` の新設** — 依頼書の区間D（静止＝層A残差の実寸）に対応する実装。
  操作合図を出さない専用フローになっており、**本依頼の本来の目的**に直接応える
- **`preview:dmdss` スクリプトの新設** — 下記「訂正」を参照

---

## 4. 【訂正】レビュー側の依頼書に誤りがあった

依頼書 §3 にこう書いた:

```
npm run build:dmdss        # → dist-dmdss/
npm run preview -- --host  # サブパス配信
```

**`npm run preview` は誤り。** `vite preview` は `VITE_VARIANT` を見ないため **standard 変種**として起動し、
`base` が `/realtime-earthquake-viewer/`（`/dmdss/` なし）になる。**DMDSS 版の成果物を配信できない。**

対応側が **`preview:dmdss`**（`cross-env VITE_VARIANT=dmdss vite preview`）を新設して解決した。
**依頼書に `base` の注意を書いておきながら、コマンド自体がその注意に反していた**——
`build:dmdss` に対応する preview が無いことを確認せずに書いた。

---

## 5. 【要注意】レビュー側の予想が揺らいだ — 開発機の参考観測

依頼書 §1③ および §5 で、レビュー側はこう書いた:

> `domWrites` は**アプリのコードが発行する DOM 書き込み回数**でありビルドモードで変わる量ではない（**未検証**）
>
> 逆に大きく下がるなら、**その理由の説明が要る**（…もし変わるなら計測器側を疑うべき）

**対応側の報告はこれと矛盾する:**

> **開発機での参考観測**（実機ではない）: 本番ビルドの静止で `kyoshinAttrPerSec ≈ 11.6`。
> 同じ開発機の dev サーバー計測（≈1041）より桁違いに小さく、
> **dev モード/HMR が dev の DOM 書き込みを膨らませていた**ことを示唆

### この観測をどう読むべきか（レビュー側の整理）

**단純に「予想が外れた」と結論するのは早い。** 比較対象に注意が要る:

| 環境 | 静止時 `domWrites` |
|---|---|
| 開発機・dev | **≈1041 /秒** ← 元々**異常値として計画書に記録されていた** |
| 開発機・本番ビルド | **≈11.6 /秒** |
| **実機・dev** | **31〜36 /秒**（本日実測） |
| 実機・本番ビルド | **未測定** |

**開発機の 1041 は、実機の 31〜36 と比べて既に30倍以上ずれていた値**であり、
計画書でも「ライブデータ差等（開発機固有）」として扱われている（`d268900`）。
**その異常値が本番ビルドで消えたことと、実機で dev→prod がどう動くかは別の問題である。**

**したがって現時点で言えるのは:**

- **開発機では** dev モード/HMR が `domWrites` を膨らませていた**可能性が高い**
- **実機で同じことが起きるかは未検証**。実機 dev は既に 31〜36/秒と低く、
  ここからさらに桁で下がる余地があるかは不明
- **移動中の 8,919〜12,563/秒 が本番ビルドでどうなるかは、完全に未測定**

### 判定の指針（実機計測時）

依頼書 §5 の注意は**そのまま有効**だが、**表現を弱める必要がある**:

| 実機・本番ビルドの移動中 `domWrites` | 読み方 |
|---|---|
| 1万回/秒台のまま | **「段階0 は移動中に効かない」が確定**。dev のオーバーヘッドとは無関係 |
| 数百〜数千に下がる | **予想が外れた。** ただし計測器を疑う前に、
**dev モードの React 再レンダリングが `MutationObserver` で拾われる DOM 書き込みを増やしていた**可能性を先に検討すべき
（開発機の 1041→11.6 がその傍証になる） |

**「変わるなら計測器を疑え」と書いたのは強すぎた。** 開発機の観測が出た以上、
**ビルドモードで変わりうる経路が実在する**ことを前提に読むべきである。

---

## 6. レビュー側での独立検証

| 確認項目 | 手段 | 結果 |
|---|---|---|
| build 系フックの不在 | 6種のフック名を検索 | **0個＝生成物非影響が構造的に保証** |
| 両サーバーの等価性 | `configureServer` / `configurePreviewServer` の実装 | **同一関数を共有** |
| 新規 meta の存在 | `swControlled` / `buildMode` を検索 | **両方あり** |
| `preview:dmdss` の追加 | `package.json` の差分 | **`cross-env VITE_VARIANT=dmdss vite preview`** |
| 型チェック | `npx tsc -b` | **エラー 0** |

**実機計測は未実施**（本依頼の実行は実機セッション担当）。
