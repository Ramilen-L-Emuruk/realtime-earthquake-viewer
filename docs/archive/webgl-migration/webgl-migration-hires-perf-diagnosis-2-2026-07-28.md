# maxload-eew劣化の原因再診断（訂正）— 「三陸沖」仮説は否定、支配要因は複合負荷×継続的なカメラ再フィット

> 前回: [webgl-migration-hires-perf-diagnosis-2026-07-28.md](webgl-migration-hires-perf-diagnosis-2026-07-28.md)
> （「震源＝最密ジオメトリ域への飛行が支配要因」という仮説）
> 検証: `fa7069b`の`flyto-sanriku-quake`（[レビュー](webgl-migration-review-fa7069b.md)）
> 証跡: `perf-2026-07-28T07-12-11-surface-go2-sanriku.json`／`07-14-08-surface-go2-sanriku.json`（各2回）
>
> **結論: 【訂正】前回の「震源＝最密ジオメトリ域（三陸リアス海岸）への飛行が支配要因」という仮説は、
> ピンポイント検証で否定された。`flyto-sanriku-quake`（震源と同座標へのカメラ移動・EEW/kyoshin無し）は
> 2回とも軽い（longtask合計0ms）。真の支配要因は、EEWの複合再描画（毎秒更新・予報円塗り）自体の重さに、
> ソースコード上に存在する「予報円成長への継続的な再フィット（`flyToBounds`の反復発火）」が
> 計測窓全体を通じて重なり続けることだと考えられる。**

---

## 1. ピンポイント検証の結果 — 仮説を明確に否定

| シナリオ | 1回目 | 2回目 |
|---|---|---|
| flyto-widezoom-quake（低密度ルート・カメラ移動のみ） | blockMax71.7ms・longtask合計50ms | blockMax77.2ms・longtask合計121ms |
| **flyto-sanriku-quake（震源＝最密域・カメラ移動のみ）** | **blockMax79ms・longtask合計0ms** | **blockMax53.4ms・longtask合計0ms** |
| eew-static（複合負荷のみ・カメラ静止） | longtask合計639ms（8秒中8%） | longtask合計1,307ms（8秒中16%） |
| **maxload-eew（両方同時）** | **longtask合計3,819ms（12秒中32%）** | **longtask合計2,586ms（12秒中21%）** |

**`flyto-sanriku-quake`は`flyto-widezoom-quake`と同等かむしろ軽く、両方とも健全域。**
「最密ジオメトリ域への移動が特別に重い」という前回の仮説は、この対照実験で明確に否定された。

## 2. より筋の通った機序 — `psWave`成長への継続的な再フィット

`src/components/Map/CameraFollowsGL.tsx`を確認したところ、以下の実装がある:

```
// 予報円の成長に追従（表示に収まらなくなった時のみズームアウト）。
useEffect(() => {
  if (!map) return
  if (eews.length === 0 || psWave.length === 0) return
  if (userInteractedRef.current || isAutoFlyingRef.current) return
  const bounds = boundsFromCircles(psWave)
  if (bounds && !mapContainsBounds(map, bounds)) {
    isAutoFlyingRef.current = true
    flyToBounds(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
  }
}, [eews.length, psWave, map])
```

`psWave`（予報円）はテストデータ上100ms周期で成長する（PoC・計画書で既出）。この効果は
**「現在のビューポートに予報円が収まらなくなるたびに」`flyToBounds`（0.8秒のflyTo）を再発火**する。
`isAutoFlyingRef`のガードにより同時多重発火はしないが、**各flyToが`moveend`で完了するたびに
ガードが外れ、予報円がさらに成長していれば次のflyToがまた発火する**——つまり
**12秒の計測窓の中で複数回のflyToが断続的に発生しうる**構造になっている。

`maxload-eew`の劣化が計測窓全体（12秒）に分布している（`eew-static`単独の8秒窓より長い時間、
より高い比率でブロックされている）ことは、**単発の初期flyTo（0.8秒）だけでは説明がつかず**、
この「予報円成長への反復的な再フィット」が計測窓を通じて繰り返し発生し、そのたびに
（カメラ移動の全画面再描画コスト）×（EEW複合負荷の毎フレーム更新コスト）が重なっている、
という機序の方が数字と整合する。

## 3. 次の一手（開発機への申し送り）

- **仮説（未確定）**: `maxload-eew`計測窓中に`flyToBounds`が何回発火しているかを直接数える。
  `isAutoFlyingRef`の`true`への遷移回数をログ出力・計測結果に含めれば、反復発火の有無・頻度が
  数字で確認できる。1回だけなら別の機序を疑う必要があるが、複数回（3〜5回程度)発火していれば
  この仮説はほぼ確定する。
- 確定した場合の対処の方向性: 予報円成長への再フィットを**間引く**（例: 一定間隔以下では
  再フィットしない・成長が一定割合を超えたときだけ発火する等）ことで、flyTo回数自体を減らす。
  ただし「予報円が画面からはみ出したまま見えなくなる」というUX上の懸念とのトレードオフになるため、
  対処方針はユーザー判断が必要になる可能性がある。

**前回の仮説（三陸沖ジオメトリ密度）は誤りだったと明記する。** 検証せずに「もっともらしい説明」で
確定させず、ピンポイント検証を経て否定できたこと自体は、このプロジェクトが繰り返し実践してきた
「仮説は検証してから確定する」という方針が正しく機能した結果でもある。

---

## 4. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| 三陸仮説の検証 | `flyto-sanriku-quake`（2回）の`blockMax`/`longtask`を`flyto-widezoom-quake`と比較 | 同等〜軽い・仮説を否定 |
| 継続的な再フィット機序の裏付け | `CameraFollowsGL.tsx`の予報円成長フォロー効果の実装を確認 | ガード付きだが反復発火しうる構造を確認 |
| maxload-eewの劣化が窓全体に分布 | 12秒窓でのlongtask合計比率とeew-static(8秒窓)の比率を比較 | maxload-eewの方が長い時間・高い比率でブロック |
