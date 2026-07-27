# 依頼: 本番アプリ（現行 Leaflet 版）の移動中ベースライン計測

> 起案: レビュー側（2026-07-27）／ 実装担当: 開発機
> 背景: [webgl-poc-surface-go2-2026-07-27.md](webgl-poc-surface-go2-2026-07-27.md) ／
> [webgl-poc-surface-go2-camera-leaflet-2026-07-27.md](webgl-poc-surface-go2-camera-leaflet-2026-07-27.md)
>
> **これまでの計測は全て PoC 対 PoC であり、本番アプリの「移動中」は一度も測られていない。**
> ユーザーから **現行 v3.23.1 でも移動中（手動パン/ズーム・地震検知時の自動ズームの両方）に
> 明らかなコマ落ちが見える**との報告があり、その実測が存在しない。

---

## 1. なぜ必要か

### ① 移行の成否を判定する基準が無い

本計画の出発点は「非力な PC で地図描画が重い」である。しかし**その重さは静止時しか数字になっていない。**

段階0（`KyoshinPoints` 差分更新化・v3.23.1）の実測は以下のとおりで、
**静止時については大幅に改善している**:

| | 改修前 | 改修後（現行 v3.23.1） |
|---|---|---|
| fps | 48.2 / 50.5 | **56.8** |
| `frame.p95` | 33.2〜33.3ms（2F） | **17.1ms（1F）** |
| `frame.max` | 216.5〜349.9ms | 149.9ms |
| longtask | 16〜24件・合計 1593〜1691ms | 11件・合計 608ms |
| DOM 属性書き込み | **10,368〜10,730 回/秒** | **21.8 回/秒** |

（証跡: `surface-go2-before` 2件 / `surface-go2-after` 1件・2026-07-24）

**移動中はこの表に相当するものが無い。**

### ② 今しか取れない

移行後は現行の数字を測れない。**移行前の今だけ**である。

### ③ 重さの正体を特定できれば、移行せずに直せる部分があるかもしれない

段階0 がまさにその例だった（DOM 書き込みを約 490 分の1 にして静止時を解決）。

### ④ 段階0 の改善は移動中には効かない可能性がある

差分更新は「値が変わった点だけ書き換える」方式だが、**地図が動けば全点の座標が変わる**ため
全点書き換えに戻る。**これがユーザーの体感の正体である可能性がある（未検証）。**

### ⑤ PoC の数字は本番に持ち込めない

Leaflet PoC の飛行は fps 43.4〜57.1 で、**コマ落ちとして見えるほど悪くない**。
それでも本番でコマ落ちが見えるなら、**PoC に無い要素**が効いている。

**本番にあって Leaflet PoC に無いもの**:

- **強震モニタの毎秒更新**（観測点 1,725点）— 移動中も停止しない
- **当たり判定用の透明 Canvas 線**（活断層・プレート境界・津波海岸線。`L.canvas({tolerance:8})`）
- **DOM ラベル**（地方9/県47/区域192 = `L.marker`+`divIcon`）— 移動のたびに位置更新
- **EEW の予報円**（100ms 更新）
- **React の再レンダリング**

---

## 2. 依頼内容

**本番アプリ（DMDSS 版・現行コード）で「移動中」のフレーム統計を取得する計測スクリプトを作る。**

### 方式

`scripts/perf/measure-kyoshin-static.js` と同じ**注入型**（DevTools に貼るか `/__perf-script` 経由）。
**本番コードは改変しない**（`JapanMap.tsx` は map を window に露出しておらず、
外から `flyTo` を起動できないが、**人が操作すればよい**）。

証跡の受け口は既にある（本番 `vite.config.ts` に `perfReportPlugin` 導入済み）。

### 計測すべき区間（3種）

| # | 区間 | 起動方法 | 目的 |
|---|---|---|---|
| **A** | **手動パン**（ドラッグ） | 人が地図をドラッグ | 体感①に対応 |
| **B** | **手動ズーム**（ホイール/ボタン） | 人が操作 | 体感①に対応 |
| **C** | **自動ズーム**（地震検知時の flyTo/fitBounds） | 設定タブの**地震テストボタン**を押す | 体感②に対応・項目3 の本番版 |

**C は既存のテスト機能で再現できる**（`CLAUDE.md`「テスト機能の活用」参照）。

### 取得すべき指標

**PoC 側と揃えること**（比較できなければ意味がない）:

- `frame`: `fps` / `p50` / `p95` / `max`（**`fps` は名目時間ではなく実測 `elapsedMs` 割り**）
- `longTask`: `count` / `totalMs` / `maxMs`
- **`estimatedVsyncMs`**（静止 2 秒の `p50` を計測の先頭で取る。**必須**——これが無いと
  「何フレーム落ち」を後から読めない。項目2・3 で繰り返し問題になった）
- **`blockMaxMs` / `blockTop3Ms`**（`MessageChannel` ブロック検出器。`poc/label.ts` の実装を流用。
  **Leaflet は再描画を遅延させるため、フレーム統計だけでは取りこぼす**——`6e71035` で
  Leaflet PoC 側に入れたのと同じ理由）
- `domWrites`（`measure-kyoshin-static.js` の既存実装を流用。**移動中に全点書き換えへ戻るか**を
  直接確認できる。**上記④の仮説を検証する主指標**）
- meta: `viewport` / `devicePixelRatio` / 観測点数 / パス数 / **地図モード**（quake/tsunami/kyoshin）

### 揃えるべき条件

- 実機 **Surface Go 2**・DPR 1.5・viewport 1272x768（既存証跡と同条件）
- **強震モニタ表示状態**（`kyoshin` モード・観測点ロード済み）で計測する
  ——これが本番固有の負荷の中心と見られるため
- ラベルが出るズーム帯（区域名は z9 以上）を含める

---

## 3. 期待する成果

1. **ユーザーの体感が数字になる**（移動中の fps・p95・longtask）
2. **段階0 の改善が移動中に効いているかが分かる**（`domWrites` が移動中に跳ね上がるか）
3. **重さの主犯が絞れる**（毎秒更新か・当たり判定線か・DOM ラベルか）
4. **移行後に「良くなった」と言える基準ができる**

---

## 4. 注意

- **本番コードを改変しない**こと。計測のためにアプリ側へフックを足すと、
  それ自体が計測対象を変えてしまう
- **`estimatedVsyncMs` を必ず含める**こと。本計画で 2 度（項目2 HIGH4・項目3 HIGH2）
  同じ穴を踏んでいる
- 計測は**人の操作**に依存するため再現性が落ちる。**同じ操作を複数回**行い、
  1 回の値で断定しないこと（本日 n=1 での断定を複数回訂正している）

---

## 5. 実装状況（開発機・2026-07-27・実機計測待ち）

**依頼どおり実装した。** 本番コードは非改変・注入型。

- **スクリプト**: `scripts/perf/measure-moving-baseline.js`（`measure-kyoshin-static.js` を下敷きに、
  estimatedVsyncMs・blockMaxMs・区間 segment を追加）。`window.__measureMovingBaseline({ label, segment, durationMs })`
  で、①静止2秒の vsync 計測 → ②移動窓（合図後に人が操作）を計測し `/__perf-report` へ送信する。
- **配信**: `scripts/perf/vite-plugin-perf-report.ts` の `/__perf-script` に `?file=` を追加（allowlist・
  既定は従来の kyoshin-static で後方互換）。`/__perf-script?file=moving-baseline` で読み込む。
- **取得指標**: frame(p50/p95/max・fps は実測割り)・longTask・**estimatedVsyncMs（先頭静止2秒 p50・必須）**・
  **blockMaxMs/blockTop3Ms（MessageChannel）**・**domWrites（mapPane/kyoshin 分計・移動で全点書き換えへ戻るかの主指標）**・
  meta(viewport/DPR/pathCount/circleCount/kyoshinActive/segment/mode)。
- **区間**: `segment:'pan'`（手動パン）/ `'zoom'`（手動ズーム）/ `'autozoom'`（地震テストボタンで自動ズーム）。
- **開発機検証済み**: ワークツリーの dmdss サーバー（kyoshin・観測点1725）で `/__perf-script?file=moving-baseline`
  配信 → 計測実行を確認。estimatedVsyncMs 16.7・全指標 populate・domWrites の kyoshin 観測が機能・
  コンソールエラー0（kyoshin 403 較正のみ）。**実機（Surface Go 2・DPR1.5）での各区間複数回計測は実機セッション担当。**
- **使い方**: 本ファイル冒頭の使い方ではなく `scripts/perf/measure-moving-baseline.js` 冒頭コメントの手順に従う
  （実機で `npm run dev:dmdss -- --host` → `document.head.appendChild(...src:'/__perf-script?file=moving-baseline')` →
  区間ごとに `__measureMovingBaseline` を実行し②の合図で操作）。
- **【2026-07-27 追記・静止ベースラインとの物差し統一（レビュー8cf28d6）】** §1 の段階0 表（fps 48.2/50.5→56.8・
  DOM 21.8回/秒 等）は **名目 durationMs 割り**で記録されていたため、実測 elapsedMs 割りの移動中計測と直接
  並べられなかった。`measure-kyoshin-static.js` を実測割りに更新済み。**`after`（現行 v3.23.1）を
  `/__perf-script?file=kyoshin-static`（既定）で静止1回測り直せば、移動中計測と同一物差しの静止基準になる。**
  `before`（改修前）は改修前コードが要り測り直せないので「before/旧after＝名目・新規＝実測」を明示すること。
  なお開発機での動作確認時、静止（無操作）でも `kyoshinAttrPerSec≈1041` と段階0 表の 21.8 と大きく食い違った
  （開発機のライブデータ差か差分更新の挙動か未確認・計測器起因ではない＝attr カウントは不変）。**実機で
  静止時 kyoshinAttrPerSec が本当に低いのか、この機会に確認されたい**（移動中の全点書き換え仮説の対照になる）。
  **→ 実機結果で解決（[webgl-production-baseline-2026-07-27.md](webgl-production-baseline-2026-07-27.md)）**: 実機の**静止は 31〜36/秒（段階0どおり健全）**で、開発機の 1041 はライブデータ差等（開発機固有）。**移動中は 8,919〜12,563/秒（405倍）**で、段階0 の差分更新が移動中に効かず全点書き換えへ戻る仮説が実機で確認された。
