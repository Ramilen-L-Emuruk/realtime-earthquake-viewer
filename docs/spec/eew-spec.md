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

P2PQuake API v2 の `code=556` は気象庁 EEW 警報（VXSE43/45 相当）の二次配信のみで、ペイロードに
severity フィールドは存在しない。JMA 仕様上ここで配信されるものは全て警報級のため、`convertEvent`
（`src/services/p2pquake.ts`）で `severity: 'Warning'` を明示付与する。

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
- `eewMaxScale(eew) >= 55`（震度 6 弱以上・ただし `scale < 99` の範囲で判定）
- `eewMaxLpgmClass(eew) >= 4`（長周期地震動階級 4 以上）

気象庁の実基準に合わせた OR 条件。長周期地震動階級は DMDATA 電文（VXSE43/44/45）にのみ載るため、
standard 版では `eewMaxLpgmClass` が常に 0 になり震度のみでレベルが決まる。

`eewMaxScale`・`eewMaxLpgmClass` は**地域別 `areas[].scaleTo` / `areas[].lgIntTo` の最大を優先**し、
**`areas` が空または最大が 0 のときのみ**電文全体の `forecastMaxScale` / `forecastMaxLpgmClass` に
フォールバックする（大きい方を取るのではない）。さらに `condition === '仮定震源要素'` かつ
`areas` の最大が 0（実質空）のときは 0 を返す（単独観測点処理では地域別の詳細予想が発表されないため
`forecastMaxScale` を使わない・`src/utils/eew.ts:140-159` 参照）。

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

## 7. 自動解除（`calcEEWCancelTime`）

**明示的な取消電文が来ない限り**、EEW は一定時間経過後に**無音・即消去**される（キャンセルオーバーレイなし）。
計算式は**司・翠川式**（震源からの距離に応じて震度がどれだけ減衰するかを近似する経験式・地震工学で広く使われる）
から**有感半径**を二分探索で逆算し、そこまで S 波が届く時間 + 30 秒を自動解除時刻とする。最終報から最低
60 秒（`MIN_CANCEL_SEC`）は表示を保つ。詳細は `src/utils/eew.ts` の `calcEEWCancelTime` /
`calcEEWAutoCancelSec` / `calcFeltRadiusKm`（二分探索）参照。

## 8. 誤報取消（明示的な取消電文）

DMDATA・P2PQuake で明示的な取消電文（`cancelled: true`・`isFinal` 無し）が来た場合、自動解除と異なり
以下を伴う:

- `eewCancel` 音の再生
- ブラウザ通知
- VOICEVOX 読み上げ
- カードに「誤報として取り消されました」表示（10 秒間）

`useLiveEventHandler.ts` の EEW 分岐で「`event.expired` フラグの有無」で自動解除と誤報取消を区別する。

## 9. 音・タブ切替・通知の連動

`useLiveEventHandler.ts` の EEW 分岐が主。以下を発火する:

- **音**: `selectEEWSoundType(isNew, levelUpgraded, currentLevel, isFinal)` で種別決定 →
  `playAlertSound(type)`。種別: `eewSpecial` / `eew` / `eewForecast` / `eewUpdate` / `eewFinal` / `eewCancel`
- **通知**: `showBrowserNotification(...)` で OS 通知
- **読み上げ**: `speakWithVoicevox(eewAlertToText(...))`
- **自動タブ切替**: 新規・レベルアップ時に `setActiveTab('realtime')` 強制。続報は
  `setActiveTabRealtimeOnUpdate()` で抑制タイマー（tsunami 側で 15 秒セット）を尊重する。
  **特別警報級 EEW（level=2）発表中は tsunami 側からタブが奪われない**優先度ルールと対称
  （詳細は [`tsunami-spec.md`](tsunami-spec.md) §11 参照）
- **カメラフィット**: `useEewLayerData` 経由で `FitToEEWGL` が発火

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
- `src/hooks/useEewLayerData.ts` — 地図レイヤーデータ生成
- `src/components/RealtimeTab/index.tsx` — EEW カード表示
- `src/components/Map/EewEpicentersGL.tsx` — 震源×印
- `src/components/Map/EewRegionFillGL.tsx` — 予想震度区域塗り
- `src/components/Map/EewLpgmRegionFillGL.tsx` — 予想長周期区域塗り
- `src/components/Map/PsWaveGL.tsx` — 予報円描画

## 13. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成。既存の CLAUDE.md・README.md から EEW 関連の記述を集約
