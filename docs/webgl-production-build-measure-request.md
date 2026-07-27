# 依頼: 本番ビルドでの実機再計測（残作業 D）— 証跡受け口と PWA の2つの壁

> 起案: レビュー側（2026-07-27）／ 実装担当: 開発機
> 背景: [webgl-production-baseline-2026-07-27.md](webgl-production-baseline-2026-07-27.md) §4⓪ ／
> 計画書 §6「残る作業 (c) 本番ビルドでの実機再計測（層 A 残差の実寸）」
>
> **本日取得した本番アプリの全数値は `vite dev` で測ったものであり、本番ビルドではない。**
> 実ユーザーが触るのは `vite build` の成果物であり、**移行後の比較も本番ビルド同士で行う**。
> したがって**基準となるべきはそちら**である。

---

## 1. なぜ必要か

### ① 今日の数値は dev のオーバーヘッドを含む

| 要因 | 向き |
|---|---|
| **React が development モード** | dev が**重い**（再レンダリングのコストが production より明確に大きい） |
| 非 minify・source map あり | dev が重い |
| HMR クライアント常駐 | dev が重い |

**いずれも dev 側を重く見せる向き。** 本番ビルドでは改善しうるが、**その程度は未測定**。

### ② 「改善した」の読み方が2通りあり、区別できない

本番ビルドで数値が良くなったとして、それは

- **(a)** 層 A 残差が小さかった（＝アプリの実力）
- **(b)** dev のオーバーヘッドが乗っていただけ（＝今日の数字が過大だった）

**どちらなのかは、測らなければ決められない。**
今日の数字を移行の判定基準に使う以上、ここを曖昧にしたままでは
**移行後に「良くなった」と言っても根拠にならない。**

### ③ 影響を受けない結論もある（優先度の判断材料）

| 結論 | 本番ビルドでの影響 |
|---|---|
| **段階0 の差分更新は移動中に効かない**（`domWrites` 31→12,563/秒） | **影響なし**と考えられる。`domWrites` は**アプリのコードが発行する DOM 書き込み回数**でありビルドモードで変わる量ではない（**未検証**） |
| 主犯は2つ（静的パス＋観測点） | 影響小（両者の**比**が根拠） |
| 移動中 fps 13〜25・停止時間 | **要検証**（絶対値） |

**核心は揺らがない。** 本依頼は**絶対値の較正**が目的である。

---

## 2. 技術的な壁（2件）— ここが本依頼の実質

### 壁1: `perfReportPlugin` が本番ビルドに含まれない

`scripts/perf/vite-plugin-perf-report.ts:34` が **`apply: 'serve'`** であり、
ソース冒頭にも「**dev サーバー専用プラグイン。本番ビルドには一切含まれない**」と明記されている。
`vite.config.ts` のコメントも同様（「build には含まれない」）。

**したがって `vite preview` では `/__perf-script` も `/__perf-report` も応答しない。**
今日使った「スクリプトを注入 → 証跡が自動で開発機に届く」経路が**そのまま使えない。**

**対処案（いずれか）**

| 案 | 内容 | 評価 |
|---|---|---|
| **(a)** | `apply` を `'serve'` から外す／`configurePreviewServer` を追加し、preview でも `/__perf-script`・`/__perf-report` を提供する | **推奨**。計測経路が今日と完全に同一になり、比較の条件が揃う。**本番ビルドの成果物自体は変わらない**（プラグインは配信サーバー側の機能で、バンドルには入らない） |
| (b) | 計測スクリプトをコンソールに貼り、返り値を手でコピーして回収 | 改修不要だが手間。区間ごとに複数回やるため現実的でない |
| (c) | 証跡受け口だけ別プロセスで立て、`reportUrl` を絶対 URL で指定 | CORS は既に許可済み（`access-control-allow-origin: *`）。ただし新規に受け口を作る手間 |

**(a) を推奨する。** ただし **`apply` を外す変更が本番バンドルに影響しないことを確認**したうえで行うこと
（`configurePreviewServer` を使えば `build` フックに触れないため安全側）。

### 壁2: PWA の Service Worker がキャッシュに介入する

`vite.config.ts` に `VitePWA({ registerType: 'autoUpdate', ... })` があり、
**本番ビルドには Service Worker が含まれる**（dev には無い）。

これは計測に2つの影響を与えうる:

- **タイル・アセットが SW キャッシュから返る**ため、ネットワーク待ちが消えて**dev より速く見える**
  （これは実ユーザーの体験でもあるので、**そのまま測るのが正しい**とも言える）
- 初回訪問と2回目以降で条件が変わる。**同一条件で複数回測るには、SW の状態を揃える必要がある**

**対処**: 計測前に SW の状態を明示的に決めること。推奨は**「SW 有効・タイルキャッシュ温め済み」で統一**
（実ユーザーの定常状態に最も近い）。手順として

1. 本番ビルドを開き、地図を一通り触ってタイルをキャッシュさせる
2. リロードして SW が有効な状態を確認（DevTools → Application → Service Workers）
3. その状態から計測を開始

**測定結果に SW の状態を記録すること**（`meta` に `swControlled: !!navigator.serviceWorker.controller` 等）。

---

## 3. 依頼内容

**本番ビルド（DMDSS 版）を実機に配信し、本日と同一の区間・同一の指標で再計測できる状態を作る。**

### ビルドと配信

```
npm run build:dmdss        # → dist-dmdss/ （base は /realtime-earthquake-viewer/dmdss/）
npm run preview -- --host  # サブパス配信
```

**`base` が `/realtime-earthquake-viewer/dmdss/` である点に注意**（`vite.config.ts:16,21`）。
実機からの URL はこのサブパスを含む。

### 測る区間（本日と同一）

| # | 区間 | 起動 |
|---|---|---|
| A | 手動パン | 人がドラッグ |
| B | 手動ズーム | 人がホイール操作 |
| C | 自動ズーム | 設定タブの地震テストボタン |
| D | **静止** | 触らない（層 A 残差の実寸＝本依頼の本来の目的） |

**条件はリアルタイム震度タブ・観測点1,725点ロード済み**で統一する
（本日、地震情報タブで測ってしまい取り違えた経緯がある）。

### 指標（本日と同一・比較できなければ意味がない）

- `frame`: `fps`（**実測 `elapsedMs` 割り**）/ `p50` / `p95` / `max`
- `longTask`: `count` / `totalMs` / `maxMs`
- **`estimatedVsyncMs`**（先頭の静止2秒・必須）
- **`blockMaxMs` / `blockTop3Ms`**
- **`domWrites`**（`mapPane` / `kyoshin` 分計）
- meta: `viewport` / `devicePixelRatio` / `pathCount` / `circleCount` / `kyoshinActive` / `segment`
  ＋ **`swControlled`（新規・上記 壁2）** ＋ **`buildMode: 'production'`（新規・dev 証跡と区別するため）**

### ラベル

**dev の証跡と混ざらないよう新ラベルを使うこと**（例: `surface-go2-prod-pan` / `-zoom` / `-autozoom` / `-static`）。
本日、`-v2` ラベルで新旧を分離した前例がある。

---

## 4. 期待する成果

1. **本日の数値がどれだけ dev のオーバーヘッドを含んでいたかが分かる**
2. **移行の合否を判定する正しい基準ができる**（移行後は本番ビルド同士で比較する）
3. **層 A 残差の実寸**（静止時・本来の目的）

## 5. 注意

- **`domWrites` が本番ビルドでも 1万回/秒台なら、「段階0 は移動中に効かない」が確定する。**
  逆に大きく下がるなら、**その理由の説明が要る**（`domWrites` はアプリのコードが発行する量であり、
  ビルドモードで変わるとは考えにくい。もし変わるなら計測器側を疑うべき）
- 人の操作に依存する区間は**同じ操作を複数回**行うこと（本日 n=3 で運用した）
- **本番ビルドの成果物自体を計測のために変更しないこと。** 壁1 の対処は配信サーバー側に留める

---

## 6. 実装状況（開発機・2026-07-28・実機計測待ち）

**壁1・壁2 とも対応し、開発機で本番ビルドのエンドツーエンド検証済み。**

- **壁1（推奨案 a を採用）**: `scripts/perf/vite-plugin-perf-report.ts` の `apply:'serve'` を外し、
  `configurePreviewServer` を追加（`configureServer` と同じミドルウェアを共有関数 `registerPerfMiddlewares` で
  両サーバーに登録）。build/transform 系フックを持たないため**本番バンドルには非影響**。
  → **`npm run build:dmdss` 成功（生成物変わらず・`dist-dmdss/sw.js` も生成）**、
  **preview で `/__perf-script?file=moving-baseline` が HTTP 200・`/__perf-report` も保存**を確認（従来は応答しなかった）。
- **壁2（運用）**: 計測は SW 有効・タイル温め済みで統一。`measure-moving-baseline.js` の meta に
  **`swControlled`（`navigator.serviceWorker.controller` の有無）**と **`buildMode`** を追加。
  本番ビルド検証時 `swControlled: true`・`buildMode: 'production'` が正しく記録された。
- **配信コマンドの訂正**: DMDSS の preview は standard 変種の `npm run preview` ではなく
  **`npm run preview:dmdss`**（新設・`cross-env VITE_VARIANT=dmdss vite preview`。base /realtime-earthquake-viewer/dmdss/）。
- **区間D（静止）**: `segment:'static'` を追加（操作合図を出さない）。層A残差の実寸＝本依頼の本来の目的。
- **手順**: `scripts/perf/measure-moving-baseline.js` 冒頭コメントの「本番ビルド計測」節を参照。新ラベル
  `surface-go2-prod-{static,pan,zoom,autozoom}`・各 `buildMode:'production'` で実行。
- **開発機での参考観測**（実機ではない）: 本番ビルドの静止で `kyoshinAttrPerSec ≈ 11.6`。同じ開発機の
  dev サーバー計測（≈1041）より桁違いに小さく、**dev モード/HMR が dev の DOM 書き込みを膨らませていた**
  ことを示唆（＝本依頼＝本番ビルド較正の必要性を裏付け）。移動中の実測は実機で複数回（実機セッション担当）。
