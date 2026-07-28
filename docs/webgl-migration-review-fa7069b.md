# レビュー: `fa7069b`（ピンポイント検証シナリオ`flyto-sanriku-quake`）

> 前提: [webgl-migration-hires-perf-diagnosis-2026-07-28.md](webgl-migration-hires-perf-diagnosis-2026-07-28.md)
> で提案した検証シナリオへの対応。
>
> **ステータス: 指摘なし。**

`drivePan([140.5, 39.0], 8, 2.4, -0.9)`の着地点は`[140.5+2.4, 39.0-0.9] = [142.9, 38.1]`で、
EEW特別警報テストの震源座標と完全に一致している。低密度ルートの`flyto-widezoom-quake`と
対照する設計も診断文書の提案どおり。型チェックエラー0。

次の実機計測で`flyto-sanriku-quake`が`flyto-widezoom-quake`より突出して重ければ、
「最密ジオメトリ域へのカメラ移動」が`maxload-eew`の支配要因であることが確定する。
