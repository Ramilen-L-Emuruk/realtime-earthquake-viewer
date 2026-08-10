# §8 B案 県47残存への緩和策「起動時ウォーム」検証（開発機・2026-07-28）＋実機計測依頼

> 前提: [webgl-glyph-pipeline-b-surface-go2-2026-07-27.md](webgl-glyph-pipeline-b-surface-go2-2026-07-27.md)
> で、B案（事前生成グリフ）でも実機 Surface Go 2 の県47段階に blockMaxMs 122.1ms・longtask 2件が残ると判明。
> 実機文書が緩和策候補「起動時プリフェッチ/ウォームで先取り」を **未検証** とした。本文書はその検証。
> 実装: `poc/label.ts` の `__runLabelWarmSuite(stage)`（cold→warm 対照）。
>
> **結論（開発機）: ウォーム経路は機構として動作（cold→warm で blockMaxMs 低下方向）。ただし開発機は
> 元々 residual が出ない（B案 cold で既に県5.8ms・区域7.3ms）ため、122ms が warm でどこまで下がるかの
> 決定的判定は実機でしか出せない。実機計測を依頼する。**

---

## 1. 検証の考え方（cold vs warm）

同一段階（県 or 区域）を同一ページ内で 2 回測る:

- **cold**: グリフ未ロードでの初回表示 ＝ 地震検知の自動ズームで県名が初出する瞬間を、起動時ウォーム
  **無し**で踏んだときのコスト。実機ではここが 122ms。
- **warm**: 一旦レイヤーを隠して再表示 ＝ グリフがキャッシュ済みの状態で踏んだときのコスト。
  起動時にウォームしておけば地震瞬間はこの状態になる、という模擬。

warm が cold より大きく下がれば「グリフのパース/アップロードコストは起動時に先取りできる」＝ウォームが有効。
変わらなければ「グリフ以外の描画コスト（表示ごとの再レイアウト等）が残る」＝ウォームでは足りず別策が要る。

**共有漢字による汚染回避**: 県名と区域名は多くの漢字を共有するため、1 ページロードにつき 1 段階だけ測る
（リロード → `__runLabelWarmSuite('prefectures')` を 1 回。区域は別ロードで `'subregions'`）。

### スコープの限定（正直な但し書き）

この cold/warm は**同一カメラ**での hide→show で測るため、**グリフのパース/アップロードコスト成分を
分離**して見るもの。実際の自動ズームは**別カメラ**への移動を伴い、シンボルの再レイアウト/配置コストは
カメラ非依存のグリフアトラスとは別に常に発生する（Leaflet でも MapLibre でも同様）。本検証が答えるのは
「§8 の主犯であるグリフ生成/パースの spike が起動時ウォームで先取りできるか」であって、自動ズームの
全描画コストがゼロになるという主張ではない。

## 2. 開発機での結果（B案・?glyphs=1・Intel Iris Xe・60Hz）

| 段階 | cold `blockMaxMs` | warm `blockMaxMs` | longtask(cold/warm) |
|---|---|---|---|
| 県47 | 5.8ms | 4.0ms | 0 / 0 |
| 区域192 | 7.3ms | 5.8ms | 0 / 0 |

- ウォーム経路は機構として動作（warm < cold・`serverGlyphs:true`・`glyphsGenerated` は cold 時点で
  既に最終値＝cold が確かにグリフをロードしている）。
- ただし開発機は B案 cold の時点で既に一桁 ms のため、ウォームの効き幅は小さく**絶対値の判定には使えない**
  （実機の 122ms がどう動くかは開発機からは分からない）。

## 3. 実機計測依頼（実機セッション）

**手順（Surface Go 2・B案）**:
1. poc を開発機の dev サーバーで配信し、実機ブラウザで `.../poc/label.html?glyphs=1` を開く。
2. **リロードしてから** DevTools コンソールで `await __runLabelWarmSuite('prefectures')` を 1 回実行。
3. 別途**リロードしてから** `await __runLabelWarmSuite('subregions')` を 1 回実行（共有漢字汚染の回避）。
4. 各返り値の `cold.blockMaxMs`/`cold.longTaskMaxMs` と `warm.blockMaxMs`/`warm.longTaskMaxMs` を記録。

**読み方**:
- **warm が cold（県47 実機 122ms 相当）から大きく下がる**なら → 起動時ウォームが有効。本番は起動直後の
  アイドルで県・区域のグリフをウォームしておく実装にする（地震瞬間のグリフ spike を先取り）。
- **warm が下がらない**なら → コストはグリフ以外（表示ごとの再レイアウト/アップロード）。ウォームでは
  足りず、「自動ズーム時にラベル表示を一段階遅延させる」等の別策へ倒す。

## 4. 実装メモ

- `poc/label.ts`: `__runLabelWarmSuite('prefectures'|'subregions')` を追加（既定 'prefectures'）。既存の
  `measureLabelLayer`（主指標 blockMaxMs・MessageChannel ブロック検出器）を cold→hide→warm の順で
  2 回呼ぶ。計測後は本番相当のズーム連動表示に復元。
- 証跡は返り値をコンソールから回収する（`__runLabelZoomSuite` と異なり /__perf-report へは送らない・
  cold/warm の対で 1 セットのため）。
