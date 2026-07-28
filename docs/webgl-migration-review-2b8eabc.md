# レビュー: `2b8eabc`（EEWシナリオ順の修正・MEDIUM対応確認）

> 前回: [webgl-migration-review-b9f5b95.md](webgl-migration-review-b9f5b95.md) のMEDIUM
> （`eew-static`→`maxload-eew`の順序だと`maxload-eew`が「続報」条件になる）への回答コミット。
>
> **ステータス: 対応確認。指摘なし。**

`maxload-eew`をEEWセクション先頭（計測窓内で最初のEEW発火）に移動し「新規発報」条件に戻した。
これで前回のn=3基準値（`maxload-eew`が唯一・最初の発火）と直接比較可能になった。

`eew-static`側は直前の`maxload-eew`発火の影響で「続報」になることを認めた上で、
「カメラ静止での複合再描画の持続コスト」というシナリオの狙い自体は続報でも損なわれない
（塗り・毎秒更新・波は同様に走る）ことをコメントで正直に説明しており、誠実な対応。

型チェックエラー0を確認。次の実機計測（8シナリオ：static-quake / pan-maxzoom-quake / zoom-quake /
flyto-widezoom-quake / static-kyoshin / pan-maxzoom-kyoshin / maxload-eew / eew-static）で、
`maxload-eew`の劣化が「カメラ移動由来」か「複合再描画の持続コスト由来」かを切り分ける。
