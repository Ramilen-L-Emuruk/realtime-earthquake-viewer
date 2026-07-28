# レビュー: `ee1d5c9`（高精細化後の実機計測ハーネス）

> 前回レビュー: [webgl-migration-review-89188bd.md](webgl-migration-review-89188bd.md)
> のMEDIUM指摘（頂点数増加の実機裏取り推奨）への回答コミット。
>
> **ステータス: 指摘なし（LOW/情報1件）。**

---

## 1. `scripts/perf/measure-app-render.js` — 妥当な設計

PoC（`poc/measure.ts`）で実証済みのプリミティブを正しく再利用している:

- **`blockMaxMs`**（MessageChannel ping-pongによるvsync非依存のブロック検出）を主指標に採用。
  開発機はvsync天井に張り付きframeでは差が出ないという、PoCで繰り返し確認された教訓を踏襲
- **`fps`は実elapsed割り**（名目duration割りの罠は本プロジェクトで複数回踏まれた既知バグパターンだが、
  ここでは正しく実装されている）
- **`detect()`**で各シナリオの実描画feature数を結果自身に含め、「狙った負荷を実際に踏んだか」を
  事後検証可能にしている。§8で「ズーム帯切替で視野が狭まり実は生成していなかった」を3度踏んだ
  教訓が反映されている
- **`maxload-eew`シナリオ**（防災アプリ最悪ケース）は、PoC検証項目7（EEW複合負荷）と同種の考え方で、
  リアルタイム稼働中にEEW特別警報テストを発火し複数の同時負荷を意図的に重ねている

`vite-plugin-perf-report.ts`の`?file=`拡張は**ホワイトリスト方式**（`PERF_SCRIPTS` Set）で、
任意ファイル読み出し（パストラバーサル）を正しく防いでいる。dev-server専用（`apply:'serve'`）のため
本番バンドルには影響しない。

## 2. [LOW/情報] `window.__mapGL`の本番ビルドへの露出

`JapanMapGL.tsx:129`の`(window as unknown as Record<string, unknown>).__mapGL = m`は
`import.meta.env.DEV`等の条件分岐が無く、**本番ビルドにもそのまま含まれる**。

これ自体は秘匿情報の漏洩ではなく、既存のXSS攻撃面を大きく広げるものでもない
（XSSが成立している時点で任意のDOM操作は可能なため）。また、本番ビルドでの実機性能計測
（残作業Dで確立した「`preview:dmdss`で本番ビルドを実機計測する」運用）に、この露出が
今後も必要になる可能性が高い。**意図的な設計と考えられ、ブロッカーではない。**
気になる場合は`import.meta.env.DEV`でのガードを検討する余地はあるが、優先度は低い。

---

## 3. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| `?file=`のパストラバーサル対策 | `PERF_SCRIPTS`ホワイトリストの実装を確認 | Setによる許可リスト方式で安全 |
| blockMaxMs/fps実装の正しさ | PoCの`poc/measure.ts`と実装を突合 | 実証済みプリミティブを正しく再利用 |
| `window.__mapGL`の露出範囲 | `JapanMapGL.tsx`の条件分岐有無を確認 | 本番ビルドにも無条件で含まれる（LOW/情報） |
