# レビュー: `d9f504e`・`c70a464`（根本原因の修正・EEW発報中の連続再描画解消）

> 前提: [webgl-migration-hires-perf-diagnosis-4-2026-07-28.md](webgl-migration-hires-perf-diagnosis-4-2026-07-28.md)
> （静止期間がほぼ全ブロック・render頻度非計上の同期処理を容疑先として提案）への回答コミット。
>
> **ステータス: 指摘なし。根本原因の特定・修正とも正確。ブラウザ実機能検証も実施し視覚回帰なし。**

---

## 1. 根本原因の特定は正確

`App.tsx`で`eews={Array.from(activeEEWsNoCancelled.values())}`をJSX内で直接呼んでいたため、
`useDmdssWaves`のpsWave更新（100ms周期）でAppが再レンダーするたびに配列参照が変わり、
`useEewLayerData`の`eewAreaFills`（`useMemo([mode, eews, subregionByName])`——`src/hooks/useEewLayerData.ts:67`
で実装依存関係を確認済み）が中身同一のまま再計算され、`EewRegionFillGL`/`EewLpgmRegionFillGL`が
同一の高精細ジオメトリを冗長に`setData`し続けていた、という因果関係は筋が通っている。

`_sourcesDirty`・tile reloadの呼び出し元特定という直接プローブによる原因確定（推測ではなく
実測ベース）は、このプロジェクトが繰り返し実践してきた「仮説は検証してから確定する」方針に
沿っている。

## 2. 修正の正しさ

- **`App.tsx`**: `eewsForMap = useMemo(() => Array.from(activeEEWsNoCancelled.values()), [activeEEWsNoCancelled])`。
  `activeEEWsNoCancelled`自体が既に`useMemo([activeEEWs])`で安定した参照であるため、
  この`useMemo`は「EEWデータが実際に変わったときだけ配列を作り直す」という意図通りに機能する。
  `eewsForPanel`も同様の構造で正しい。
- **`KyoshinDetectedPointsGL.tsx`**: `JSON.stringify`による署名比較で冗長`setData`をスキップする
  sinkガード。初期化時（`EMPTY_FC`基準）・アンマウント時（署名リセット）の扱いも正しい。
  署名比較にJSON.stringifyを使う手法はfeatureの順序が変わると偽陰性（見逃し）になりうるが、
  安全側（余分な再描画が起きるだけ）の失敗モードであり実害は無い。

## 3. `diagnosis-3`の謎の解消が筋が通っている

「`eew-nofills`（塗りを`visibility:none`で隠す）でも重かった」ことの説明——`visibility:none`は
描画をスキップするだけでソースの`setData`自体（＝再タイル化・連続再描画の駆動源）は止めない、
という指摘は技術的に正確。可視性とデータ更新は独立した概念であり、この混同が診断を長引かせていた
ことを正しく言語化している。

## 4. 検証内容の確認

- dev機での計測（EEW区域塗りsetData 12/s×2本→0/s、render 56〜58/s→6/s、塗り29 feature維持）は
  コミットメッセージ・診断文書に具体的に記載されている。
- 型チェック（`npx tsc -b`）を独立に再実行しエラー0を確認。
- **レビュー側でもブラウザ実機能検証を実施**: dev サーバー（このワークツリー・ポート5199）で
  DMDSS版を開き、特別警報テストを発火。区域塗り（宮城県赤）・P波/S波円・震源マーカー・EEWカードが
  すべて正常に表示され、視覚回帰は無いことを確認。コンソールエラーはYahoo強震モニタのクロック同期
  403（既知の良性）のみ。
  - 補足: 検証中に簡易的な`render`頻度サンプル（2秒間）を取ったところ27/秒という値が出たが、
    サンプル中にページタイトルが揺れ検知の表示に変化しており、何らかの検知イベント（実データ
    または通常のkyoshin検知処理）と重なった可能性が高い。単発の非統制サンプルであり、
    開発機側の統制された計測（EEW静止・6/秒）と矛盾するものではないため、これ自体を
    修正への疑義とはしない。

---

## 5. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| useMemo依存関係の正しさ | `useEewLayerData.ts`の`eewAreaFills`の依存配列を確認 | `eews`が直接依存に含まれ修正が効く経路と確認 |
| activeEEWsNoCancelledの安定性 | `App.tsx`内の該当useMemoを確認 | `[activeEEWs]`依存で安定、fix の前提が正しいと確認 |
| sinkガードの初期化/クリーンアップ | `KyoshinDetectedPointsGL.tsx`のeffect実装を確認 | 初期化・アンマウント時の扱いとも正しい |
| 型チェック | `npx tsc -b` | エラー0 |
| ブラウザでの視覚回帰確認 | Playwright MCPで特別警報テストを発火しスクリーンショット確認 | 区域塗り・P波円・震源・カードとも正常表示 |
| コンソールエラー | Playwright MCPで確認 | 既知の良性403のみ |
