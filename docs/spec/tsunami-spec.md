# 津波情報仕様書

> 本書は**現在の実装が津波情報をどう処理するか**をまとめた仕様書。実コードと食い違う場合は実コードを正とする。
> 関連: [`data-sources-spec.md`](data-sources-spec.md) の津波電文受信、[`audio-tts-spec.md`](audio-tts-spec.md) の津波音・読み上げ。
> 読み上げには優先順位があり、津波は緊急地震速報より後・地震情報より先に読まれる（[`audio-tts-spec.md`](audio-tts-spec.md) §6）。

## 1. 概要

大津波警報・津波警報・津波注意報・津波予報を受信・表示するモジュール群。以下を扱う:

- 電文パース（DMDATA JSON / XML、P2PQuake JSON）
- 区域別の警報等級の統合
- 観測情報（津波観測点の波高・到達時刻）のマージ
- 解除・取消・期限切れの 3 経路の出し分け（DMDSS 版のみ完全対応）
- 海岸線描画（対象海域を色分け）
- カード表示（区域グループ・観測情報）

## 2. データフロー

```
[電文]
  DMDATA WS / REST (VTSE41/51/52) ──┐
  P2PQuake WS (code=552)  ───────────┴── parseTsunami / parseTsunamiFromXml
                                                   ↓
                                            JMATsunami 型
                                                   ↓
                                    useEarthquakes.ts の handleEvent（tsunami ケース）
                                                   ↓
                                          state.tsunamis: JMATsunami[]（実質 1 件スロット）
                                                   ↓
                        ┌────────────┴────────────┐
                        ↓                          ↓
              useTsunamiLayerData          TsunamiTab
              （海岸線・観測バー）        （カード表示）
                        ↓
              TsunamiLinesGL / TsunamiObsBarsGL
```

## 3. 3 経路の解除フロー

津波が消える経路は 3 種類ある。`JMATsunami.cancelReason` で区別する（型: `'lifted' | 'retracted' | 'expired'`）。
**3 経路とも同じ流れを通る**: `cancelledAt` セット → 10 秒間の解除表示 → `purge-cancelled-tsunami` で消去。

| cancelReason | 電文条件 | 検出箇所 | 表示文言 |
|---|---|---|---|
| `lifted`（解除） | `InfoType === '発表'` かつ区域が消える | `dmdataParser.ts` の `areas.length === 0` フォールバック | 「解除されました」 |
| `retracted`（取消） | `InfoType === '取消'` | `dmdataParser.ts` の InfoType 判定 | 「取り消されました」 |
| `expired`（期限切れ） | `validDateTime` の満了 | `useEarthquakes.ts` がタイマー予約 | 「有効期間終了」 |

**表示文言の単一情報源**: `src/components/TsunamiTab/index.tsx` の `CANCEL_REASON_LABEL`（3 経路 + undefined フォールバック）。
新しい cancelReason を追加する場合はここと型定義（`src/types/earthquake.ts`）を同時に更新する。

### バリアント差

- **DMDSS 版**: 3 経路すべて出し分け可能（DMDATA 電文が `InfoType` と `ValidDateTime` を持つため）
- **standard 版**: P2PQuake API v2 スキーマに `InfoType`・`ValidDateTime` に相当するフィールドが**無い**ため、
  `cancelReason` は常に `undefined`。`CANCEL_REASON_LABEL` のフォールバックで常に「解除」表示になる

**`validDateTime` が付く条件**（気象庁仕様）: 「津波予報（若干の海面変動）のみ発表の場合」または
「警報・注意報解除後に予報のみが残る場合」の 2 パターンのみ。警報・注意報が 1 区域でも残っている間は付与されない。

### TSU-5A: standard 版の 24h フェイルセーフ（2026-08-14）

P2PQuake API 仕様上 `validDateTime` が届かないため、通常の TSU-1 経路（validDateTime 満了の
`expired` 予約）は standard 版では発火しない。津波は明示的な解除電文（`cancelled=true`）で消えるのが
正常経路だが、解除電文が届かない例外ケース（P2PQuake API 障害等）に備えて、`useEarthquakes.ts` は
**standard 版で validDateTime を持たない tsunami に対して 24h 後の `expired` 予約を積む**フェイルセーフを備える。

- 実行条件: `!isDmdss && !tsunami.cancelled && !tsunami.validDateTime`
- 予約時刻: 現在時刻から 24 時間後（リプレイの初期状態を再現する場合だけは基準が変わる。後述）
  （気象庁の実運用で警報・注意報が 24h を超えて継続することは稀。
  ただし 2011 年東日本大震災級の広域災害では大津波警報が半日以上継続した実例がある。24h を超える
  例外的な長時間継続警報の途中で表示が消える場合は、次の続報受信で予約が積み直されるため実害は
  限定的だが、意図されたフェイルセーフの限界として認識する）

**purge/insert の分岐**:
- purge（`cancelReason='expired'` 既存予約の全除去）は「これから insert する場合」または
  「明示解除電文（`cancelled=true`）を受信した場合」のみ実行する
- DMDSS で `validDateTime` を持たない非キャンセル電文（VTSE51②/VTSE52 の**観測のみ続報**）は
  正規パターン。この経路では purge も insert もスキップして既存の TSU-1 予約を温存する
  （消すと期限切れによる自動失効が二度と起きなくなる）
- 明示解除電文でも purge を実行するのは、TSU-5A の 24h 予約を「解決済み津波」に対して
  発火させないため（レビュー2巡目で発覚した CRITICAL への対応）
- P2PQuake は eventId が無く id も続報ごとに変わるため、`cancelReason='expired'` な予約は
  id/eventId 一致条件を課さず全除去する（TSU-3「常に 1 件スロット」で管理されるため 1 件残せば充分）

**時刻軸の扱い**: TSU-1（`validDateTime` 由来）は電文の**絶対時刻**、TSU-5A の 24h フェイルセーフは
`getTimeRef` 起点の**相対時刻**（`now + 24h`）。どちらの予約も、再生中でも発火時刻をそのまま待つ
（再生中の時刻軸の扱いと、かつて発火時刻を潰していた `clampToNow` の経緯は
[`settings-pwa-spec.md`](settings-pwa-spec.md) §6「再生中も予約は発火時刻を待つ」が単一情報源）。

**リプレイの初期状態を再現するときだけ基準が変わる**: リプレイは開始時刻より前に発表された電文を
まとめて「いま」流し直す（初期状態の再現。`silent` 付きで注入される）。ここで受信時刻を基準にすると、
20 時間前に出ていた津波が再生開始からさらに 24 時間残り、実際の失効タイミングとずれる。この経路
だけは**電文の発表時刻**を基準に 24h を数える。

遡り幅（24 時間）の境目では、発表から 24 時間を過ぎた電文が紛れることがある。その場合は予約を
未来に置けないため、**その場で失効させる**（`silent` 注入なので音は鳴らない）。未来の予約しか
積まない作りだと、こうした津波は失効予約を持たないまま画面に残り、再生中はライブ更新も
止まっているので消す手段が無くなる。

**既知の適用漏れ**: TSU-5A は `handleEvent` 経由でのみ発火する。初回ロード時の履歴取得
（`fetchHistory([552], 10)`）は `handleEvent` を経由せず直接 `setState` するため、フェイルセーフが
仕掛けられない。「ページを開いた瞬間に standard 版で有効な津波警報が既に存在し、以後一切続報が
来ない」というレアケースで、次のライブ tsunami 受信までフェイルセーフが働かない。実運用では
リロードするか続報を受信すれば救済される。
- DMDSS 版で `validDateTime` を持たない電文は仕様外扱い（正常経路の解除電文を期待）

## 4. 電文パース

### DMDATA JSON（`parseTsunami`）
- `src/services/dmdataParser.ts` の `parseTsunami` 関数
- `tsunami.forecasts` から区域別の等級・波高・到達時刻を抽出
- `tsunami.observations` から観測情報を抽出
- 未知の Kind/Code は `Unknown` → 除外される（現状は既知コードが固定のため実害は限定的）

### DMDATA XML 履歴（`parseTsunamiFromXml`）
- 同上ファイルの XML パーサ側
- REST 履歴取得時に使用

### P2PQuake（`convertEvent`）
- `src/services/p2pquake.ts` の code=552 分岐
- `JMATsunami` 型に変換（`InfoType` / `ValidDateTime` は付与されない）
- 津波の等級（`areas[].grade`）は英語のまま（`MajorWarning` / `Warning` / `Watch` / `Forecast`）で内部型に流れ、`useLiveEventHandler.ts` 等の分岐で直接 `grade === 'MajorWarning'` として判定される（`DOMESTIC_TSUNAMI_MAP` は地震情報 code=551 の `earthquake.domesticTsunami` 用で、津波の等級には使われない）。`TsunamiGrade` にない値は `Unknown` に格下げして警告を残す
- 予想波高（`areas[].maxHeight`）は「巨大」「高い」のとき数値表現が付かない。`value` を持たなくても
  `description` だけで区域行を描けるよう、`maxHeight` ごと落とすことはしない
- 区域名（`areas[].name`）が無い要素はその区域だけ落とす（海岸線データとの突き合わせキーのため）。
  解除電文は `cancelled: true` かつ `areas` が空配列で届くので、空自体は正常として通す

## 5. 状態管理（`useEarthquakes.ts` の tsunami ケース）

- `state.tsunamis: JMATsunami[]` は**実質 1 件スロット**（別 eventId の津波が来ると無警告で置換）
- 新規・非キャンセル: `sameEvent` なら更新、そうでなければ配列を丸ごと置換
- キャンセル（3 経路のいずれか）: `cancelledAt: now` と `cancelReason` をセット、10 秒後に purge をキューイング
- 期限切れ検出: 電文受信時に `validDateTime` を見て、未来なら expired キャンセルを予約

**既知の課題**:
- expired 予約が同一 eventId の後続更新で取り消されず、10 秒表示が早期打ち切りされる可能性
- `purge-cancelled-tsunami` アクションが識別子を持たないため、連続キャンセルのレースで前の解除表示が
  早期消去される可能性

## 6. 観測情報のマージ（`mergeTsunamiObservations`）

`src/utils/tsunami.ts` の関数。津波観測点の連続電文で、同一観測点の観測値を最新に更新する。

- キーは `${o.districtCode ?? o.districtName ?? ''}|${o.name}`（区域コード or 区域名 と観測点名を `|` で連結。同じ区域内の複数観測点を区別するため）
- 同一キーで既存があれば更新、なければ追加
- `over` フラグ（既定波高を超えたかどうか）は JSON 経路のみ設定される（XML 経路では常に undefined）

## 7. 区域と海岸線

- 電文の区域コード（`areas[].code`）に対応する海岸線ライン座標を `public/data/tsunami-zones.json` から引く
- ソースは気象庁 予報区等 GIS データ（`Ichihai1415/JMA-GIS-GeoJSON`）
- 生成スクリプト: `scripts/build-tsunami-zones.mjs`

**取得に失敗したとき**: 海岸線は描かれない。このデータでしか描けないため代替表示は無く、
警報・注意報の範囲が地図から消える（観測点の波高バーは別データなので残り、カード・一覧にも
影響しない）。海岸線の座標はカメラの自動フィット対象でもあるため、対象海域への自動フィットも
効かなくなり、観測点の位置または日本全体の表示に落ちる（[`map-rendering-spec.md`](map-rendering-spec.md) §6）。

本データを要求するのは海岸線描画の 1 箇所だけなので、区域データ（[`quake-spec.md`](quake-spec.md) §7.2）
のような再取得による復帰も起きず、ページを再読み込みするまで戻らない。失敗は `console.error` に
「海岸線が出ない」旨で出力される。

### 描画（`TsunamiLinesGL`）

- 等級ごとの色・線幅は `src/utils/tsunamiStyle.ts` で定義
- 大津波警報（紫）・警報（赤）・注意報（橙）・予報（シアン）で色分け
- 点滅アニメーション: `requestAnimationFrame` で `line-opacity` を周期変化
- MapLibre の paint プロパティは既定で 300ms トランジションが付くため、`line-opacity-transition:
  { duration: 0 }` を明示的に設定して点滅の途切れを防ぐ

## 8. 観測点バー（`TsunamiObsBarsGL`）

- 各津波観測点に「実測波高を高さで表した棒」を地図上に立てる
- 高さは波高に比例（5m で上限に達する線形。下限 8px・上限 400px でクランプ）。
  地図アイコン倍率を掛ける範囲は [`settings-pwa-spec.md`](settings-pwa-spec.md) §2
- 座標は `public/data/tsunami-obs-coords.json` から引く。ここに無い観測点は棒が立たない
  （カード側には実測値が出るため、地図と一覧で見え方が食い違う）
- 更新は観測点名をキーにした差分更新（HTML マーカーを使い回して中身だけ書き換える）。
  受信のたびに全マーカーを作り直すと、発報中の高頻度な更新で棒が一瞬消えてちらつく
- カメラがこのバーへ寄る条件と俯瞰への帰り方は [`map-rendering-spec.md`](map-rendering-spec.md) §6

## 9. カード表示（`TsunamiTab`）

以下の順序で表示:
1. 見出し（大津波警報・警報・注意報・予報のいずれか）
2. 区域リスト（同一階級内で予想波高が同じ区域はグルーピング）
3. 観測情報（区域コードが一致する観測点は該当区域の直下に、それ以外は別カードにフォールバック）
4. キャンセル時は `cancelReason` に応じた見出しに切り替え（10 秒間）

## 10. 音・通知・読み上げの連動

`useLiveEventHandler.ts` の tsunami 分岐で発火する。

| 状態 | 音種別 | 通知 | 読み上げ |
|---|---|---|---|
| 大津波警報の新規発表 | `tsunamiMajor` | あり | あり |
| 津波警報の新規発表 | `tsunami` | あり | あり |
| 津波注意報の新規発表 | `tsunamiWatch` | あり | あり |
| 津波予報の新規発表 | `tsunamiForecast` | あり | あり |
| 続報（レベル変化なし） | 抑制（読み上げのみ） | 抑制 | あり |
| 解除・取消・期限切れ | `tsunamiCancel`（cancelReason の 3 種を単一音で区別せず伝える） | 抑制 | あり |

音・TTS は `spokenTsunamiCancelEventIdsRef`（`useLiveEventHandler.ts`）で **eventId 単位** に
重複発火を抑止する。P2PQuake WS と DMDATA WS から同一 eventId で cancel が届いた 2 回目、
または合成 expired タイマーが同一 eventId に複数積み上がった 2 回目以降は握り潰す。
ページリロード直後の初回解除は Set が空のため正常に発火する。

## 11. 自動タブ切替

tsunami タブへの強制切替は「**新規発報／grade 格上げ**」のときのみ発火する
（`useLiveEventHandler.ts` の tsunami 分岐）。判定は `src/utils/tsunami.ts` の
純関数 2 つに分離してテスト可能にしている:

| 判定 | 定義 | true の条件 |
|---|---|---|
| `isTsunamiNewFire(next, current)` | 新規発報か | `current` 無し／取消済み／`eventId` 相違、または `eventId` 欠落時に `sourceEarthquake.originTime` 相違（DMDATA XML の Earthquake 要素経由のフォールバック） |
| `isTsunamiGradeUpgrade(next, current)` | grade 格上げか | `MajorWarning > Warning > Watch > Forecast > Unknown` の順で `next > current` |

EEW の発表状況は判定に入れない（下記「優先度ルール」参照）。

**バリアント差**: DMDSS 版（DMDATA）は電文に 14 桁 `eventId` が常に付与されるため厳密判定が可能。
標準版（P2PQuake）の `code=552` は生 JSON に `eventId` を持たず、`earthquake` 相当のフィールド自体が
無いため `sourceEarthquake` も常に `undefined` になる。よって上表の `originTime` フォールバックは
**標準版では事実上常に不成立**し、保守的な続報扱い（別地震の新規津波でもタブが奪われない）が
デフォルト挙動になる。ユーザーは grade 格上げ検知か手動タブ切替で対応する必要がある。

タブ強制切替（`setActiveTabNonRealtime('tsunami')`）は `isNew || upgraded` のときのみ呼ぶ。
呼ばれた瞬間に `realtimeTabSuppressedUntilRef = Date.now() + 15000` がセットされ、
以後 15 秒は EEW 続報での realtime タブへの自動切替を抑制する。
ただし EEW の新規発報・レベルアップはこの抑制を無視して realtime を取り戻す
（`eew-spec.md` §9）。

続報（同一 eventId の観測点更新等）は `setActiveTabNonRealtime` を呼ばず抑制タイマーを触らない。
`title.showTsunamiTitle()` は続報でも呼ぶのでタイトルバッジは維持される。

**優先度ルール**（tsunami × EEW の同時発報時）:

- tsunami 新規発報・grade 格上げは、EEW のレベル（予報／警報／特別警報）を問わず realtime を
  奪って tsunami タブを表示する
- 解除・取消・失効も同様にタブを奪う。**タブ切替・解除音・読み上げ**は `alreadySpoken`
  （eventId 単位の重複抑止）を条件とし、**タイトルの `endTsunamiTitleWindow()` と状態リセット**
  （観測バッジ・保持していた最大波高・スクロール位置）は無条件に実行する
- ただし無操作が続くと、自動復帰（設定の「自動復帰までの時間」= `idleRevertSec`。
  [`settings-pwa-spec.md`](settings-pwa-spec.md) §2）が働く。これはタブの種類を問わない共通の
  仕組みで、EEW 発報中・揺れ検知中であれば realtime タブを維持する（tsunami タブも例外ではなく、
  津波発表中でも realtime へ移る）。**津波受信の瞬間に tsunami を見せることと、その後どのタブに
  落ち着くかは別の仕組みが決めている**

## 12. 関連実装ファイル

- `src/services/dmdataParser.ts` — DMDATA JSON/XML パース（tsunami 分岐）
- `src/services/p2pquake.ts` — P2PQuake 経路の convertEvent
- `src/utils/tsunami.ts` — 等級算出・観測情報マージ
- `src/utils/tsunamiStyle.ts` — 等級ごとの色・線幅定義
- `src/hooks/useEarthquakes.ts` — 状態管理（tsunami ケース）
- `src/hooks/useTsunamiLayerData.ts` — 描画データ生成
- `src/components/TsunamiTab/index.tsx` — カード表示・`CANCEL_REASON_LABEL`
- `src/components/Map/TsunamiLinesGL.tsx` — 海岸線描画
- `src/components/Map/TsunamiObsBarsGL.tsx` — 観測バー描画

## 13. テスト

- `dmdataParser.test.ts` は現状 VXSE51/53（地震 XML）のみカバー
- `parseTsunami` / `parseTsunamiFromXml` / `mergeTsunamiObservations` の単体テストは無し（HIGH 課題）

## 14. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成。既存の CLAUDE.md から津波関連の記述を集約
- 2026-08-18: 「特別警報級 EEW（level=2）発表中は津波がタブを奪わない」優先度ルールを撤去（§11）。
  津波は EEW のレベルを問わず tsunami タブを奪う。このルールは 2026-08-11 の CRIT-4 修正
  （続報がタブを奪い続けて EEW 続報が realtime へ戻れない問題）に付随して入ったもので、
  「特別警報だけを別扱いする」根拠は当時も記録されていなかった。撤去にあわせて判定用の
  `hasActiveSpecialEEW()` も削除した。**「新規発報／grade 格上げのみがタブを奪う」ルールと
  15 秒の realtime 抑制は CRIT-4 の本体なので維持している**（これを外すと元の不具合が再発する）。
  なお解除・取消の経路では、旧実装は「タブ切替だけを止め、重複抑止セットへの記録と解除音は
  素通りさせる」非対称があり、同一 eventId の解除が複数経路から再到達してもタブが切り替わらない
  状態になり得た。ゲートが `alreadySpoken` 一本に統合されたことでこれも解消している
- 2026-08-18: §8 の記述 2 件を実装に合わせて訂正（波高バーの高さは「対数変換」ではなく線形／更新は
  「setData で全置換」ではなくマーカーの差分更新）。あわせて座標未収録の観測点は棒が立たないこと、
  カメラの寄り方は [`map-rendering-spec.md`](map-rendering-spec.md) §6 に集約したことを追記した
- 2026-08-20: §3「時刻軸の扱い」から `clampToNow` の説明を外し、
  [`settings-pwa-spec.md`](settings-pwa-spec.md) §6 への参照に置き換えた（EEW の自動解除にも共通する
  話で、津波側だけに書くと経緯が追えないため）。撤去前の再生では、`validDateTime` 由来の予約が必ず
  「いま」へ潰れて `alreadyExpired` が常に真になり、本編再生分（非サイレント）は失効予約が積まれず
  解除電文が来ない限り残り続け、初期状態の再現分（サイレント）は注入直後に失効していた
