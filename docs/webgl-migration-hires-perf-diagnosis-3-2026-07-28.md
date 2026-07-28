# eew-nofills内訳切り分け結果 — 区域塗り仮説は裏付けられず、新たな交絡変数を発見

> 前提: [webgl-migration-review-ddb761a-d33ef0d.md](webgl-migration-review-ddb761a-d33ef0d.md)
> （`eew-nofills`による区域塗りコストの単離を狙った実験）
> 証跡: `perf-2026-07-28T08-42-27`／`08-45-01`／`08-46-39-surface-go2-sanriku.json`（計3回。
> ラベルは`surface-go2-nofills`の指示だったが実際は前回の`surface-go2-sanriku`ラベルのまま実行された。
> `eew-nofills`シナリオ自体は含まれておりデータとしては有効）
>
> **結論: 「区域塗りがEEW発報中の支配的コスト」という仮説（`ddb761a`）は、この内訳切り分けでは
> 裏付けられなかった。塗りを消した`eew-nofills`の方がむしろ`renderPerSec`が高く、3回中2回は
> `blockMax`も同等かむしろ悪化した。加えて`maxload-eew`は`renderPerSec`が最も低いにも関わらず
> 最も重いという逆転が見られ、【カメラの最終停止位置（ズーム・可視範囲）が実験間で統一されていない】
> という新たな交絡変数が浮上した。**

---

## 1. 結果

| run | maxload-eew(fps/blockMax/ltTotal/renderPerSec/moveendCount) | eew-static | eew-nofills |
|---|---|---|---|
| 1 | 23.89/122.6ms/509ms/**23.97**/1 | 32.61/63.2ms/50ms/**32.48**/0 | 46.39/51.6ms/0ms/**41.65**/0 |
| 2 | 22.71/263.8ms/352ms/**22.71**/1 | 32.32/62.8ms/0ms/**32.07**/0 | 54.47/41.2ms/0ms/**50.1**/0 |
| 3 | 19.07/121.4ms/453ms/**19.07**/1 | 26.92/69ms/0ms/**26.8**/0 | 51.98/182.2ms/131ms/**47.49**/0 |

## 2. 【意外】区域塗りを消すとrenderPerSecが下がるどころか上がった

3回とも一貫して**`eew-nofills`（塗り非表示）の方が`eew-static`（塗り表示）よりrenderPerSecが高い**
（41.65〜50.1 対 26.8〜32.48）。`blockMax`も3回中2回は`eew-nofills`の方が軽いが、3回目は逆に
`eew-nofills`の方が大きく悪化（182.2ms・longtask131ms）している。

**「区域塗りのper-renderコストが支配的」という`ddb761a`の仮説は、この対照実験では裏付けられなかった。**
塗りの有無は`renderPerSec`にも`blockMax`にも一貫した向きの影響を与えていない。

## 3. 【新たな手がかり】maxload-eewはrenderPerSecが最低・可視ジオメトリも最少なのに最も重い

`maxload-eew`の`renderPerSec`（19.07〜23.97）は`eew-static`・`eew-nofills`のどちらよりも低いにも
関わらず、`blockMax`・longtask合計は3シナリオ中で最も悪い。「再描画の頻度」では説明がつかない。

**さらに`detect`を突き合わせると、「可視ジオメトリ量」でも説明がつかないことが分かった。**
`maxload-eew`の`detect`は`land-fill:0`・`sub-borders:0`・`active-faults:0`・`kyoshin-points:0`
（震源直近の沖合＝画面に陸地がほぼ映らない視点で着地）に対し、`eew-static`/`eew-nofills`
（固定視点z7）は`land-fill:40`・`sub-borders:59`・`active-faults:87`・`kyoshin-points:239`と
**むしろ`maxload-eew`より多くのジオメトリを画面に映しながら軽い。**

「可視範囲が広い/狭い」という交絡変数の懸念（当初の想定）はこれで否定された。
**むしろ可視ジオメトリが少ないはずの`maxload-eew`の方が重い、という逆転が起きている。**

## 4. 再構築した仮説 — flyTo進行中の短い窓に、カメラ変換とデータ更新の同時発生が集中する

`moveendCount:1`から、`maxload-eew`ではカメラのflyTo（アプリ側の初回自動フィット、約0.8秒）が
計測窓12秒のうちごく短い一部でのみ発生していることが分かっている。単独のflyTo
（`flyto-sanriku-quake`・同じ着地点でEEW無し）はlongtask合計0msで健全、単独の複合負荷
（`eew-static`・カメラ静止）もlongtask合計0〜50msと軽度——**両方が単独では軽いのに、
両方が同時に（＝flyToが進行している短い窓の中でEEWのデータ更新も同時に走っている）発生する
`maxload-eew`だけが、render頻度が低く可視ジオメトリも少ないのに突出して重い。**

これは「1回あたりの再描画コスト」がflyTo中に特別に高くなることを示唆する:
**カメラが移動している最中は、複合負荷（区域塗りのデータ更新・毎秒更新等）による再描画のたびに
カメラ変換の再計算とデータ側の再タイル化/再レイアウトが同一フレームで重なり、静止時の
単純な再描画より1回あたりのコストが跳ね上がっている**、という機序が最も数字と整合する。

## 5. 次の一手（開発機への申し送り）

- **`blockGaps`（ブロック検出の各タイムスタンプ）を`moveend`イベントの発生時刻と突き合わせて記録**
  すれば、重いブロックが実際にflyTo進行中の短い窓に集中しているかを直接確認できる
  （現状の計測フックは合計・最大値のみで時系列情報を持たないため、この検証には追加のログが要る）。
- 確認できれば、対処の方向性は「flyTo中（`isAutoFlyingRef`が真の間）はEEWの複合更新
  （区域塗りの`setFeatureState`・毎秒更新）を一時的に抑制し、着地後にまとめて反映する」
  （既存の「flyTo中は予報円を止める」緩和策と同種の考え方）が有力候補になる。
- **区域塗り仮説（`ddb761a`）は当面保留**とし、「flyTo×同時データ更新」の重なりを主軸に調査を進める。

---

## 6. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| ラベル不一致の確認 | ファイル名と`eew-nofills`キーの有無を確認 | ラベルは旧`surface-go2-sanriku`だが有効なデータと確認 |
| 区域塗り仮説の検証 | `eew-static`と`eew-nofills`の`renderPerSec`/`blockMax`を3回分突合 | 一貫した支持が得られず、仮説を保留 |
| renderPerSecと重さの逆相関 | `maxload-eew`の`renderPerSec`を他2シナリオと比較 | 最低なのに最重、という逆転を確認 |
| 可視ジオメトリ量の交絡確認 | 3シナリオの`detect`（land-fill等の件数）を突合 | `maxload-eew`の方が可視ジオメトリが少ないのに重い、という逆転を確認・交絡ではないと判明 |
| flyTo中の重なり仮説の整合性 | `moveendCount`・単独flyTo（`flyto-sanriku-quake`）・単独複合負荷（`eew-static`）の結果と突合 | 両方単独では軽く同時発生時のみ重い、という数字と整合 |
