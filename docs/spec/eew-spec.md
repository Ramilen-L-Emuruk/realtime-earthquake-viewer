# EEW（緊急地震速報）仕様書

> 本書は**現在の実装が EEW をどう処理するか**をまとめた仕様書。実コードと食い違う場合は実コードを正とする。
> 関連: [`data-sources-spec.md`](data-sources-spec.md) の EEW 電文受信、[`audio-tts-spec.md`](audio-tts-spec.md) の EEW 音・読み上げ、
> [`map-rendering-spec.md`](map-rendering-spec.md) の EEW 地図レイヤー。

## 1. 概要

緊急地震速報を受信・統合・表示するモジュール群。以下の役割を持つ:

- 電文の統合（同一 eventId の続報を最新報でまとめる）
- レベル判定（予報 / 警報 / 特別警報）
- 予報円の描画（P 波・S 波の地表到達円）
- 自動解除（一定時刻経過で無音・即消去）
- 誤報取消の処理（明示的な取消電文＝音・通知・読み上げを伴う）
- 単独観測点処理（仮定震源要素）の非表示化

## 2. データフロー

```
[電文経路]
  DMDATA WebSocket / REST 履歴 (VXSE43/44/45) ──┐
  P2PQuake WebSocket (code=556)  ────────────────┼── enqueueEvent
  Yahoo hypoInfo（1Hz ポーリング）───────────────┘         │
                                                            ↓
        [useEarthquakes] handleEvent (eventQueue で時刻順ディスパッチ)
                                                            ↓
                                          activeEEWs: Map<eventId, EEWAlert>
                                                            ↓
                                            ├─→ useLiveEventHandler
                                            │      音・通知・タブ切替・読み上げ・カメラフィット
                                            │
                                            ├─→ useEewLayerData
                                            │      地図の予想震度塗り・LPGM 区域塗り・震源マーカー
                                            │
                                            ├─→ usePsWaveCalc
                                            │      P 波・S 波地表到達円（100ms 更新）
                                            │
                                            ├─→ useSWaveCountdown
                                            │      S 波到達カウントダウン
                                            │
                                            └─→ RealtimeTab EEWCard
                                                   カード表示（見出し・震度・M・深さ等）
```

## 3. 電文経路とバリアント差

3 系統の電文源がある:

| 経路 | バリアント | severity | condition | 長周期 lgIntTo | 使い方 |
|---|---|---|---|---|---|
| DMDATA WS/REST | DMDSS | 電文値（Warning/Forecast） | 電文値（`'仮定震源要素'` あり） | あり | 主系 |
| P2PQuake WS | standard | 電文に無いが `convertEvent` で一律 `'Warning'` 付与 | 数値/文字列 | なし | 主系（DMDSS 版は不使用） |
| Yahoo hypoInfo | 両バリアント | 震度からの推定（`>= 5弱 ? 'Warning' : 'Forecast'`） | 常に `'以上'` 固定 | なし | standard 版で補完的に検知 |

P2PQuake の 556 で severity が付与される仕組みは [`data-sources-spec.md`](data-sources-spec.md) §3
を参照（電文仕様と付与ロジックはそちらに一本化）。

**enrichEEW（`useEarthquakes.ts`）**: Yahoo hypoInfo で先に検知した EEW に、後着の P2PQuake / DMDATA で
より正確な `areas` / `condition` / `hypocenter` を上書きする。severity は upgrade only（既存 `'Warning'` は
維持、`Forecast/Unknown` から `'Warning'` への格上げのみ許可）。Warning への格上げ時は `onLiveEvent` に
enriched オブジェクトを渡して `useLiveEventHandler` 側の音・通知・タブ切替のレベル再評価をトリガーする
（Yahoo 弱推定＋P2PQuake 後着で無音になる事象の解消）。ただし現状は次の課題が残る:
- Yahoo 続報が「新しい報」として `activeEEWs` を丸ごと上書きすると、enrichEEW で入れた `areas` /
  `earthquake.condition` / `earthquake.hypocenter` が揮発する（`case 'eew'` のマージ側では severity だけを
  upgrade only で保持）

## 4. レベル判定（`computeSingleEEWLevel`）

`src/utils/eew.ts` の `computeSingleEEWLevel(eew)` が単一情報源。判定は 3 段階の直列条件で行う:

1. `severity !== 'Warning'` → `0`（予報）で早期 return（P2PQuake の予報電文・Yahoo severity が Forecast のケース）
2. 特別警報判定（下記 OR 条件のいずれか）→ `2`
3. 上記に該当しない（severity === 'Warning' かつ特別警報の条件を満たさない）→ `1`（警報）

**特別警報の判定条件**（OR）:
- `eewMaxScale(eew) >= 55`（震度 6 弱以上。震度が取れないときは `0` になるため自然に対象外になる。
  値の決まり方は下記のフォールバック規則を参照）
- `eewMaxLpgmClass(eew) >= 4`（長周期地震動階級 4 以上）

気象庁の実基準に合わせた OR 条件。長周期地震動階級は DMDATA 電文（VXSE43/44/45）にのみ載るため、
standard 版では `eewMaxLpgmClass` が常に 0 になり震度のみでレベルが決まる。

> **「特別警報」は表示に使い、読み上げには使わない。** 位置づけ自体は公式で、気象庁は震度 6 弱以上
> または長周期地震動階級 4 以上を予想した緊急地震速報（警報）を特別警報としている。ただし
> 「これらの特別警報は名称に『特別警報』は用いず、従来どおりの名称で発表します」とも明示している
> （[津波・火山・地震（地震動）に関する特別警報の発表基準](https://www.jma.go.jp/jma/kishou/know/tokubetsu-keiho/kizyun-jikazan.html)）。
> そのためレベル 2 は色分け・ブラウザ通知のタイトル・通知音の選択には使うが、**音声では「警報」と読む**
> （[audio-tts-spec.md](audio-tts-spec.md) §6）。重さは値そのもの（「予想最大震度6弱。」）で伝える。

`eewMaxScale`・`eewMaxLpgmClass` は**地域別 `areas[].scaleTo` / `areas[].lgIntTo` の最大を優先**し、
**`areas` が空または最大が 0 のときのみ**電文全体の `forecastMaxScale` / `forecastMaxLpgmClass` に
フォールバックする（大きい方を取るのではない）。震度未確定の `-1`（`IntensityScale` のセンチネル）は
`Math.max` の初期値 0 に丸められるため、全地域が未確定の場合もこのフォールバック経路に入る。
さらに `condition === '仮定震源要素'` かつ `areas` の最大が 0（実質空）のときは 0 を返す
（単独観測点処理では地域別の詳細予想が発表されないため `forecastMaxScale` を使わない・
`eewMaxScale()` / `eewMaxLpgmClass()` の `condition === '仮定震源要素'` 分岐を参照）。

`eewMaxScale` は `scaleTo` が震度階級（`IntensityScale`）の値でない地域を最大値の計算から除外する。
そのため P2PQuake の `scaleTo = 99`（「〜程度以上」）は、この判定に届く前に
`convertEvent` が同じ地域の `scaleFrom` へ置き換えている（[`data-sources-spec.md`](data-sources-spec.md) §3）。
置き換えないと「震度 7 程度以上」という最も強い予想が丸ごと無視され、警報止まりになる。

### 想定外の値に対する実行時ガード

`eewMaxScale` は震度スケール外の値を、`eewMaxLpgmClass` は 1〜4 以外の階級を採用しない
（`isValidIntensityScale()` / `isValidLpgmClass()`）。型（`IntensityScale` / `LpgmClass`）で
宣言してはいるが、実地震シナリオ JSON のように型検査が及ばない経路があるため実行時にも弾く。
これが無いと、壊れた入力の値がそのまま `>= 55` / `>= 4` の比較を通って特別警報へ誤昇格する。
**特別警報は震度と長周期地震動階級の OR 判定なので、片方だけ守っても誤昇格は防げない。**

両関数を経由しない参照経路にも同じガードを通している:

- **地図の区域塗り**（`useEewLayerData`）は `areas[]` を直接集計する（震度区域・長周期区域の両方）。
  とくに長周期側は `getLpgmClassLabel()` がフォールバックを持たなかったため、弾かないと
  「階級99」のような値がそのまま地図ラベルに出ていた（現在は同関数も「階級不明」へ落とす）。

一方、**読み上げ**（`ttsText.ts`）は震度・長周期階級のどちらも両関数を経由する。音声には色の
フォールバックのような逃げ場が無く、不正値がそのまま声に出てしまうため。

> かつては階級だけが `forecastMaxLpgmClass` を直接参照しており、両関数が持つ「地域別予想を優先」
> 「仮定震源要素で 0 扱い」の 2 つのガードが読み上げにだけ効いていなかった。その結果、単独点処理の
> 初期報で震度を否定した直後に階級だけを断言する矛盾した発話が出ていた。
> **同種の値を扱う経路は、片方だけ生フィールドを読まないこと。**

**既知の限界**: これで解消したのは仮定震源要素の経路だけ。`eewIntensityToText` は深発地震
（深さ 150km 超）でも「予想震度なし」と読む分岐を持つが、`eewMaxLpgmClass` は深さを見ないため、
階級だけ値を持てば同じ形の矛盾が残る。震度予想の出ない深発地震で長周期階級だけが載る電文が
実在するかは未確認のため手を付けていない（実発報時の確認をユーザーに委ねる）。

## 5. 仮定震源要素（単独観測点処理）の扱い

電文の `condition === '仮定震源要素'` は「単独観測点による PLUM 検知・震源未確定の初期報」を意味する。
（**PLUM 法** = 周辺観測点の実測震度から予想震度を算出する手法。震源要素を使わないため、単一観測点が強く揺れた瞬間から数秒で予報を出せる。詳細は [`kyoshin-detection-spec.md`](kyoshin-detection-spec.md) 参照）

以下の**複数箇所で連動して非表示化する**（片方だけ直すと非対称になる）。数を書くと列挙漏れがドリフトしやすいため、
新たに `condition` を参照する箇所を追加したときは必ずこのリストに追記する:

- **予報円を出さない** — `src/hooks/usePsWaveCalc.ts` の `computeEewCircle`（`condition === '仮定震源要素'` で早期 return）
- **カードで M・深さを隠す** — `src/components/RealtimeTab/index.tsx` の EEW カード内表示条件
- **震度・長周期階級を 0 扱い** — `src/utils/eew.ts` の `eewMaxScale` / `eewMaxLpgmClass`
- **地図の震源×印を薄く描く** — `src/hooks/useEewLayerData.ts` で `EewEpicenter.isAssumed` フラグ生成 →
  `src/components/Map/EewEpicentersGL.tsx` の `ASSUMED_OPACITY_RATIO` で不透明度を下げる
- **検知エンジンの EEW 連動緩和判定** — `src/App.tsx` の `hasActiveNonAssumedEEW`
- **揺れ検知の基準震源選定** — `src/hooks/useKyoshinAlerts.ts` の `extractEewInfo`
- **読み上げテキスト生成** — `src/utils/ttsText.ts`（EEW 読み上げ関数群で `condition` を参照）
- **`condition`/`hypocenter` の明示マージ** — `src/hooks/useEarthquakes.ts` の `enrichEEW`（§3 参照。後着の P2PQuake / DMDATA で明示的に上書きし、Yahoo 由来の誤った `condition` が残り続けないようにする。ここが崩れると下流の全判定が破綻する）

**バリアント差の非対称**: Yahoo hypoInfo は `condition` に相当するフィールドを持たず常に `'以上'` を返すため、
standard 版で Yahoo hypoInfo が先に単独観測点処理の EEW を検知した場合、後続の P2PQuake / DMDATA で
上書きされるまでの間は「確定震源として表示」される。既知の限界（実運用時の確認をユーザーに委ねる）。

## 6. 予報円（P 波・S 波）

**`src/hooks/usePsWaveCalc.ts`** が単一情報源。2 層速度モデル（地殻＋マントル・Pn/Sn 屈折波）で
自前計算する。**標準版・DMDSS 版で共通**。

- 入力: `EEWAlert.earthquake.hypocenter`（lat/lng/depth/magnitude）と `originTime`
- 更新頻度: 100ms（`UPDATE_INTERVAL_MS`）で `setInterval`
- 停止条件: `activeEEWs.length === 0` または `isFinal:true` かつ計算不能
- 出力: `PsWaveCircle[]`（各 EEW に対する現時点の P 波・S 波半径）

震源深さは `Math.max(0, depth ?? 0)` でクランプする。深さ不明（`-1` センチネル）が来ると 0 に落ちて
「ごく浅い」として計算される点は既知の課題（`depth < 0` で「深さ不明・円を出さない」分岐が望ましい）。

**既知の限界（EEW-5）**: `depth > MOHO_KM`（33km）の分岐は「マントル速度で直達波」のみを
計算しており、地殻区間を経由する屈折波（本来は Snell 則で扱うべき）を考慮しない。結果として:

- 走時を **相対誤差 約 19%（一定）** で過小評価する（例: 震源直上 R=0 で約 2 秒、R=100km で約 5.6 秒、
  R=300km で約 15.9 秒。絶対値は距離に比例して拡大するが相対誤差は距離非依存）
- `depth=MOHO_KM` 前後で分岐境界の不連続ジャンプが生じる

正しい修正には Snell 則ベースの traveltime 再設計が必要で、`computeSWaveTravelTimeSec` と対にリファクタする
大きな作業になるためスコープ外とした（単純な max 比較で 2 区間走時を代替する案は代数的に無効と判明済み）。

## 7. 自動解除（`calcEEWCancelTime`）

**明示的な取消電文が来ない限り**、EEW は一定時間経過後に**無音・即消去**される（キャンセルオーバーレイなし）。
計算式は**司・翠川式**（震源からの距離に応じて震度がどれだけ減衰するかを近似する経験式・地震工学で広く使われる）
から**有感半径**（震度 1 以上が届くと推定される距離）を二分探索で逆算し、そこまで S 波が届く時間 + 30 秒を
自動解除時刻とする。最終報から最低
60 秒（`MIN_CANCEL_SEC`）は表示を保つ。詳細は `src/utils/eew.ts` の `calcEEWCancelTime` /
`calcEEWAutoCancelSec` / `calcFeltRadiusKm`（二分探索）参照。

再生（テスト時刻設定 →
[`settings-pwa-spec.md`](settings-pwa-spec.md) §6）中も同じ猶予が効く。解除の予約は再生時計の
時間軸で評価するため、最終報を受けた直後に消えることはない（→ 同 §6「再生中も予約は発火時刻を待つ」）。

## 8. 誤報取消（明示的な取消電文）

DMDATA・P2PQuake で明示的な取消電文（`cancelled: true`・`isFinal` 無し）が来た場合、自動解除と異なり
以下を伴う:

- `eewCancel` 音の再生（`hadKey=true` のみ。二重鳴り防止）
- ブラウザ通知（`hadKey` 有無を問わず発火。tag=`eew-cancel-${key}` で自動上書きされるため二重にならない）
- VOICEVOX 読み上げ（`hadKey=true` のみ。二重鳴り防止）
- カードに「誤報として取り消されました」表示（10 秒間）

`useLiveEventHandler.ts` の EEW 分岐で「`event.expired` フラグの有無」で自動解除と誤報取消を区別する。
`hadKey` は「このセッションで `activeEEWLevelsRef` に既に登録されていた eventId か」を表す:

- **hadKey=true**: 画面に表示中の EEW を取り消す通常経路 → 音・通知・読み上げの全てを発火
- **hadKey=false**: 既に自動解除済みの後に本物の誤報取消が遅延到達したケース、または P2PQuake WS と Yahoo の両方から cancel が来た場合の 2 回目 → 通知のみ発火（音・読み上げは二重鳴り防止のためスキップ）

## 9. 音・タブ切替・通知の連動

`useLiveEventHandler.ts` の EEW 分岐が主。以下を発火する:

- **音**: `selectEEWSoundType(isNew, levelUpgraded, currentLevel, isFinal)` で種別決定 →
  `playAlertSound(type)`。種別: `eewSpecial` / `eew` / `eewForecast` / `eewUpdate` / `eewFinal` / `eewCancel`
- **通知**: `showBrowserNotification(...)` で OS 通知
- **読み上げ**: `speakWithVoicevox(eewAlertToText(...))`
- **自動タブ切替**: 新規・レベルアップ・誤報取消は最上位の優先度で realtime を確保し、続報は
  それより 1 段低い優先度で要求する。**確保している 15 秒間は、地震情報・長周期地震動情報・津波が
  タブを奪えない**（優先順位の全体像は [`audio-tts-spec.md`](audio-tts-spec.md) §6「自動タブ切替の
  優先順位」）。続報は手動選択より弱いため、ユーザーが自分で別タブを選んだ直後は realtime へ
  戻らない。ただし新規・レベルアップは手動選択より強く、必ず realtime を取り戻す。
  EEW のレベル（特別警報級か否か）はタブの奪い合いに関与しない
- **カメラフィット**: `FitToEEWGL` が発火。第一報は S 波円（円が無ければ震源）へ寄り、以降は
  予想の区域塗りまで含めた範囲を追う。追従の主な起点は EEW 電文と予報円の更新で、区域塗りの範囲
  （`useEewLayerData` の `eewFitPositions`）は発報中の追従にのみ加わる。kyoshin モード限定。
  詳細・モード限定の理由は [`map-rendering-spec.md`](map-rendering-spec.md) §6（後段「既知の限界（MAP-5）」）参照

**音種別の優先順位**（`selectEEWSoundType` の判定順）:
1. **新規発報またはレベル格上げ**（`isNew || levelUpgraded`）→ `currentLevel` に応じて
   `eewSpecial`（特別警報）／`eew`（警報）／`eewForecast`（予報）。**`isFinal` より優先**するため、
   最終報で震度・長周期階級が上がって levelUpgraded=true になる最重要ケースでも警戒音を鳴らす。
2. **続報の最終報**（`!isNew && !levelUpgraded && isFinal`）→ `eewFinal`（穏やかな終了音）
3. **通常続報**（上記のいずれでもない）→ `eewUpdate`

ただし現状は続報時の音・読み上げの多重発火防止に弱い箇所がある（`useLiveEventHandler.ts` 内の
5 箇所の setTimeout が未追跡）。

## 10. `activeEEWs` の状態遷移

```
[受信]              [enrichEEW / handleEvent]         [状態]
  ├─ 新規 EEW      →  activeEEWs.set(key, eew)      →  active
  ├─ 続報          →  activeEEWs.set(key, newEew)   →  active（上書き）
  ├─ enrich        →  既存に areas/condition/hypocenter マージ
  ├─ 誤報取消      →  cancelledAt セット・10 秒後 purge
  └─ 自動解除      →  時刻到達で activeEEWs.delete(key)（無音）
```

キーは `eew.issue?.eventId ?? eew.id` を統一パターンで使う。ただし `EewEpicentersGL` の `id` 生成は
`eew.id` を直接使っており（serial 込みで続報のたびに変わる）、Marker がリマウントしてポップアップが
強制で閉じる問題がある（既知の HIGH 課題）。

## 11. パラメータ一覧

| 定数 | 値 | 用途 |
|---|---|---|
| `MIN_CANCEL_SEC` | 60 | 最終報からの最低表示時間（自動解除まで） |
| `FELT_RADIUS_BUFFER` | 1.5 | 司・翠川式の有感半径マージン倍率 |
| `MAX_FELT_RADIUS_KM` | 2500 | 有感半径の上限（巨大地震での飽和防止） |
| `UPDATE_INTERVAL_MS` | 100 | P/S 波半径の更新周期（`usePsWaveCalc`） |
| `MOHO_KM` | 33 | モホ面深さ。地殻/マントル分岐の閾値（`usePsWaveCalc.computeRadius`） |
| `ASSUMED_OPACITY_RATIO` | 0.35 | 仮定震源の×印の相対不透明度（kyoshin モード） |
| `ASSUMED_OPACITY_MIN` | 0.2 | 仮定震源の×印の絶対下限（他モード） |
| `EEW_FINAL_SILENCE_MS` | 10000 | 最終報後の再クリック続報テスト受付時間 |
| `EEW_RETRACTION_CANCEL_MS` | 10000 | 誤報取消テストの遅延 |

## 12. 関連実装ファイル

- `src/utils/eew.ts` — レベル判定・自動解除・音種別選択・仮定震源判定
- `src/utils/eew.test.ts` — テスト（現在 `diffHypoInfoEvents` / `calcArrivalSafetyMarginSec` /
  `computeSingleEEWLevel` / `eewMaxLpgmClass` のみカバー。他 7 関数は未カバー）
- `src/hooks/useEarthquakes.ts` — 状態管理・enrichEEW・キュー
- `src/hooks/useLiveEventHandler.ts` — 音・通知・タブ切替の連動
- `src/hooks/usePsWaveCalc.ts` — P/S 波予報円計算
- `src/hooks/useEewLayerData.ts` — 地図レイヤーデータ生成（区域塗りは `subregions.json` 依存。取得失敗時は代替表示なし・再取得成功で復帰。[`quake-spec.md`](quake-spec.md) §7.2）
- `src/components/RealtimeTab/index.tsx` — EEW カード表示
- `src/components/Map/EewEpicentersGL.tsx` — 震源×印
- `src/components/Map/EewRegionFillGL.tsx` — 予想震度区域塗り
- `src/components/Map/EewLpgmRegionFillGL.tsx` — 予想長周期区域塗り
- `src/components/Map/PsWaveGL.tsx` — 予報円描画

## 13. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成。既存の CLAUDE.md・README.md から EEW 関連の記述を集約
- 2026-08-16: 特別警報の判定条件から `scale < 99` の但し書きを削除（§4）。`99` は「震度算出不能コード」と
  説明されていたが、DMDATA 経路（`parseIntensityStr()`）も Yahoo 経路（`calcintensityToScale()`）も
  不明時は `-1` を返しており、99 を生成する実装は存在しなかった。あわせて
  `EEWRegion.scaleFrom` / `scaleTo` を `IntensityScale` 型にし、`eewMaxScale()` が震度スケール外の
  値を採らないようにした。旧ガードは「99 以上を特別警報から除外する上限キャップ」としても
  働いていたため、型検査が及ばない経路（実地震シナリオ JSON）から不正値が来たときの防御は
  実行時にも残している。長周期地震動階級（`lgIntTo` / `forecastMaxLpgmClass`）にも同じ穴が
  あったため、`LpgmClass` 型と `isValidLpgmClass()` を追加して両方を塞いだ（理由は §4 参照）。
  あわせて、両関数を経由しない参照経路（地図の区域塗り・読み上げ）にも同じガードを通し、
  フォールバックの無かった `getLpgmClassLabel()` を「階級不明」へ落とすようにした
- 2026-08-18: 「特別警報級 EEW（level=2）発表中は津波側からタブが奪われない」という優先度ルールを
  撤去（§9）。EEW のレベルはタブの奪い合いに関与しなくなり、逆方向（EEW の新規発報・レベルアップが
  15 秒抑制を無視して realtime を取り戻す）だけが残る。特別警報級の区別は音（`eewSpecial`）・
  表示（ラベル・配色・バッジ）・通知文言には引き続き残している。詳細は
  [`tsunami-spec.md`](tsunami-spec.md) §14 の同日エントリを参照
- 2026-08-20: §7 に「再生（テスト時刻設定）中も同じ猶予が効く」を追記した。再生中だけ予約の発火時刻が
  「いま」へ潰されており、最終報の 9 ミリ秒後に自動解除が走って猶予（`MIN_CANCEL_SEC`=60 秒）が
  消えていた。潰していた処理の撤去と経緯は
  [`settings-pwa-spec.md`](settings-pwa-spec.md) §6「再生中も予約は発火時刻を待つ」を参照
- 2026-08-20: 自動タブ切替に優先度を入れた（§9）。従来は EEW が realtime を確保した直後に地震情報・
  津波が無条件にタブを奪えたため、読み上げが EEW を守るようになった後も画面から EEW が消えていた。
  優先順位の全体像は [`audio-tts-spec.md`](audio-tts-spec.md) §6
