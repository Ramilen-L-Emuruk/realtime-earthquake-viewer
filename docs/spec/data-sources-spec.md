# データソース仕様書

> 本書は**アプリが使用する外部データソースと接続の仕組み**をまとめた仕様書。
> 実コードと食い違う場合は実コードを正とする。

## 1. 概要

3 系統のデータソースを扱う:

- **DMDATA.JP**（DMDSS 版・要 API キー） — 地震情報・EEW・津波情報の主系
- **P2PQuake API v2**（標準版・認証不要） — 地震情報・EEW・津波情報の主系
- **Yahoo!天気・災害 リアルタイム震度**（両バリアント共通） — 強震モニタデータ。EEW 補完は標準版のみ

さらに以下も外部・準外部データとして扱う:

- 気象庁 予報区等 GIS データ（座標テーブル・境界・海岸線・生成物）
- GEBCO 海底地形タイル（背景・オプショナル）
- 産総研 活断層データベース（オプショナル）
- PB2002 プレート境界（オプショナル）

## 2. DMDATA.JP（DMDSS 版）

### エンドポイント

- WebSocket: `wss://ws.api.dmdata.jp/v2/socket`
- REST: `https://api.dmdata.jp/v2/*`

### 認証

Basic 認証（`Authorization: Basic base64(apiKey:)`）。API キーはユーザーが設定タブで入力し、
`localStorage` に平文保存する（BYOK / Bring Your Own Key 方式）。ビルド時にキーが埋め込まれることはない。

設定欄は 1 文字ごとに保存するが、**通信を起こす側へ渡す値は 800ms のデバウンスを挟む**
（`App.tsx` の `API_KEY_DEBOUNCE_MS`）。手入力・修正のたびに未完成のキーで接続と履歴取得を
やり直すと、そのすべてが 401/403 で失敗して無駄なリクエストとログを生むため。リプレイ機能だけは
ユーザーがボタンを押した時点でしか通信しないので、生の値をそのまま使う。

### 受信する電文種別

| 種別コード | 内容 | 用途 |
|---|---|---|
| VXSE43 | 緊急地震速報（警報） | EEW 警報表示 |
| VXSE44 | 緊急地震速報（予報） | **受信対象外**（廃止予定・VXSE45 で代替。`EEW_TYPES` から除外済み） |
| VXSE45 | 緊急地震速報（地震動予報） | EEW 詳細（長周期地震動階級を含む）。表示・読み上げでの呼び方は [`eew-spec.md`](eew-spec.md) §3 |
| VXSE51 | 震度速報 | 地震カード（速報） |
| VXSE52 | 震源に関する情報 | 地震カード（震源） |
| VXSE53 | 震源・震度に関する情報／遠地地震に関する情報 | 地震カード（詳細報／遠地地震）。両者は同じ種別コードで届き `Head/Title` で識別する（[quake-spec.md](quake-spec.md) §3） |
| VXSE61 | 顕著な地震の震源要素更新 | 続報統合 |
| VXSE62 | 長周期地震動観測情報 | 長周期区域塗り |
| VTSE41 | 津波警報・注意報 | 津波タブ |
| VTSE51 | 津波観測情報 | 津波観測バー |
| VTSE52 | 沖合の津波観測情報 | 津波観測バー |
| VYSE50 | 南海トラフ地震臨時情報 | 南海トラフバナー（段階を表示） |
| VYSE51 | 南海トラフ地震関連解説情報（臨時解説） | 解説情報バナー |
| VYSE52 | 南海トラフ地震関連解説情報（定例解説） | 解説情報バナー |
| VYSE60 | 北海道・三陸沖後発地震注意情報 | 後発地震バナー |

**電文本体の展開**: WebSocket の `body` は base64 + gzip で配信される。ブラウザネイティブの
`DecompressionStream('gzip')` で復号してから `dmdataParser.ts` で内部型に変換する。

#### 南海トラフ関連の 3 種別（VYSE50 / VYSE51 / VYSE52）

種別ごとに役割が違い、**臨時情報と解説情報は別物として扱う**。

| | VYSE50 | VYSE51 | VYSE52 |
|---|---|---|---|
| 情報名 | 南海トラフ地震臨時情報 | 南海トラフ地震関連解説情報 | 同左 |
| 内部型 | `JMANankai` | `JMANankaiCommentary` | `JMANankaiCommentary` |
| 段階を持つか | 持つ（調査中／巨大地震注意／巨大地震警戒／調査終了） | 持たない | 持たない |
| 発表の頻度 | 異常な現象が観測されたときのみ | 臨時情報の発表期間中、毎日 | 平常時に毎月 1 回 |
| `InfoSerial`（地震関連情報番号コード） | 調査中 `111` / 巨大地震注意 `130`（**実装では使わない**） | 臨時解説 `210` | 定例解説 `200` |

段階の判定には **`Head/Title`（情報名）の括弧内キーワード**を使う。例:
`南海トラフ地震臨時情報（巨大地震注意）`。

> **`Head/InfoKind` は判定に使えない。** 実電文では段階に関わらず「南海トラフ地震に関連する情報」で
> 固定されており、括弧内キーワードを含まない。かつてここを見ていたため、「巨大地震注意」が
> 「調査中」と表示され、さらに翌日以降の解説情報が臨時情報の段階を上書きしていた。
>
> `InfoSerial` のコードでも判定できそうに見えるが、**臨時情報側では使っていない**。コード表が
> 公開されておらず、実電文で確認できたのは上表の 4 値だけで、巨大地震警戒・調査終了は過去に一度も
> 発表されていないためコードが不明（表の `111` / `130` は実電文から読み取った値だが、参考情報として
> 載せているだけで実装は参照しない）。情報名は気象庁の資料で定義されているため `Head/Title` の方が
> 確実。解説情報側の `210` / `200` は臨時解説と定例解説の区別に**実際に使っている**（表示するバッジと
> 読み上げの文面がこれで変わる）。

解説情報は解除電文を持たない。帯は**発表から 7 日**で自動的に畳み、閉じるボタンでも消せる
（帯の仕様は [architecture-spec.md](architecture-spec.md) §4、音と読み上げの設定は
[settings-pwa-spec.md](settings-pwa-spec.md) §2）。

取消電文（`InfoType=取消`）は `cancelled` を立てて返し、**表示中の帯を消す**（音と読み上げは
起こさない）。実電文では一度も発表されていないが、他種別のパーサと扱いを揃えている。

> **取消を `null` で表さないこと。** パースできなかった場合と区別できなくなり、「解析失敗」の
> 警告が正常な取消のたびに出るうえ、帯を消す経路にも乗せられない。

電文の同一性は `EventID` と `Serial` の組で決まる。実電文で確認した挙動:

| | `EventID` | `Serial` |
|---|---|---|
| 臨時情報（VYSE50） | 電文ごとに変わる（発表日時） | 空 |
| 臨時解説（VYSE51） | **一連の期間で固定**（2024 年 8 月に取得できた 6 通すべて同一） | 号数（取得できた 6 通は 1〜5 と 7。第 6 号はアーカイブに欠落） |
| 定例解説（VYSE52） | 電文ごとに変わる（発表日時） | 空 |

臨時解説は `EventID` だけでは号を区別できない。閉じるボタンは電文 id（`EventID` と `Serial` から
組み立てる）で判定するため、`Serial` を落とすと第 1 号を閉じただけで以降の号すべてが出なくなる。

### WebSocket 接続（`src/services/dmdata.ts`）

- 自動再接続（指数バックオフ、`RECONNECT_BASE_MS=3000`、`RECONNECT_MAX_MS=30000`）
- `type: 'ping'` を受けたら `pong` を返す
- `stopped` / `authError` 以外は close 時に自動再接続
- 認証失敗（401/403）時は `authError` で停止
- ping ウォッチドッグ: 最終受信から `PING_WATCHDOG_MS=90000` 経過で自発 close → 再接続（半開通信対策）
- 非回復系 close code: 保守的に `1008`（Policy Violation）のみ `authError` 相当に停止。`4xxx` は DMDATA v2 の公式仕様の裏取りが取れておらず、通常の再接続対象に含める（実運用ログで意味が判明したら個別に列挙する）
- `reconnectAttempt` のリセットは `start` 受信後 `STABLE_CONNECTION_MS=15000` 継続で行う（フラッピングでバックオフが効かなくなるのを防ぐため）

### REST 履歴取得（`fetchDmdataEarthquakes` 等）

起動時に過去 24 時間の主要電文を取得してカードに反映する。ページング（`nextToken`）に対応。

### 震源カタログ（`fetchDmdataGdEarthquakes`）

地震活動ヒートマップのデータ源。`GET /v2/gd/earthquake`（`gd.earthquake` スコープが必要）から
直近 30 日分の震源を取得する。標準版の `fetchJmaQuakeHistory`（P2PQuake）に相当するが、
**震度が観測されなかった地震も含む震源カタログ**である点が異なる。新しい順に返るため、
期間外に達した時点でページングを打ち切る。スコープが契約に含まれない場合は 403 で例外になり、
ヒートマップは非表示のままになる（画面上のエラー表示は無い）。コンソールには認証エラーとして
`console.error` が 1 行、続けて取得失敗として `console.warn` が 1 行出る。

**座標の粒度**: このカタログが返す緯度経度は **0.1 度（約 11km）刻み**。これは気象庁の震源決定が
その程度しか当たらないという意味ではなく、**公表時の丸め**である。実際、顕著な地震の震源要素更新
（VXSE61）の電文には度単位の座標に加えて**度分単位（0.1 分 ≈ 185m 刻み）の座標**も入っている
（実電文で確認: `+40.2+142.4-40000/` と `+4012.4+14222.0-41000/` が併記される）。一方、通常の
震源・震度情報（VXSE53）は 0.1 度の座標のみを持つ。

ヒートマップがこの精密な値を使えない理由は 2 つ。VXSE61 は顕著な地震にしか発表されないことと、
震源カタログ API が 0.1 度の値しか返さないこと（1 ヶ月分を電文から個別に集めるのはリクエスト数が
現実的でない）。したがって**カタログから得られる粒度は 0.1 度が上限**で、地図側もそれに合わせて
ぼかす（[map-rendering-spec.md](map-rendering-spec.md) §14）。これより細かく描くと格子状の点描になり、
配信された座標より細かい位置が分かっているように見えてしまう。

粒度は**両バリアント共通**（どちらも気象庁の発表値が出所）。2026-08-18 の実データで、DMDSS 版
（震源カタログ）は 696 点中 695 点・ユニークな座標 139 個、標準版（P2PQuake）は 697 点すべて・
ユニークな座標 138 個が 0.1 度グリッド上だった。

**欠測項目の扱い**: このカタログには**震源が決まっていない地震**が混ざる（震度速報だけが発表され、
震源・震度情報がまだ出ていない段階のもの）。該当項目は `hypocenter` も `originTime` も持たず、
`eventId`・`arrivalTime`・`maxInt` だけを返す。地図に置く座標も時刻も無いため、該当する項目を
1 件ずつ個別に除いて取得を続ける。座標の値だけが読めない項目も同じく除く（API 仕様変更への防御。
実データでは未観測）。捨てた件数は理由の内訳付きで警告ログに 1 行出す（標準版の `warnField` /
`warnMissing` と同じ「既定の扱いに落とすことは許すが黙っては通さない」方針）。

ただし**捨てた項目があるのに 1 件も残らなかった場合は例外**にする。空の結果を正常とみなすと、
呼び出し側がそれをキャッシュして、直前まで表示していたヒートマップを消したまま TTL の間
そのままにしてしまうため。期間内に地震が本当に無くて 0 件だった場合とは区別する（捨てた項目が
0 件なら例外にしない）。判定を「全滅」に限っているのは、大地震の直後は震源未確定の項目が
一時的に増えるからで、割合で切ると最も見たいときにヒートマップが消えることになる。

### 試験報（VXSE42）

設定タブの「試験報を受信（検証用）」を有効にすると、毎正時に配信される配信テスト電文も受信できる。
実地震を待たずにリアルタイム受信経路を検証できる（受信した試験 EEW は通常の発報と同様に表示される）。

## 3. P2PQuake API v2（標準版）

### エンドポイント

| 用途 | エンドポイント |
|---|---|
| リアルタイム受信 | `wss://api.p2pquake.net/v2/ws` |
| 直近の履歴 | `https://api.p2pquake.net/v2/history` |
| 地震情報の履歴（2015-01-10 〜） | `https://api.p2pquake.net/v2/jma/quake` |
| 津波予報の履歴（2016-11-22 〜） | `https://api.p2pquake.net/v2/jma/tsunami` |

`/jma/*` だけが日付（`since_date`・`until_date`、yyyyMMdd 単位）で絞れる。地震活動ヒートマップの
遡り取得と、リプレイの過去取得はこちらを使う。

以下は公式 OpenAPI 仕様（[json-api-v2.yaml](https://github.com/p2pquake/epsp-specifications/blob/master/json-api-v2.yaml)）
の記載で、実測での裏付けは取っていない。

- レート制限は `/history` が 60 リクエスト/分、`/jma` が 10 リクエスト/分（いずれも IP 毎）
- `/history` は `offset` で遡れるが、1 週間以上古い情報は取得できない場合がある

### 認証

**不要**（公開 API）。

### 受信するコード

| code | 内容 | 用途 |
|---|---|---|
| 551 | JMA 地震情報 | 地震タブ |
| 552 | JMA 津波情報 | 津波タブ |
| 556 | 緊急地震速報 | EEW |

### convertEvent の検証と日本語化

`src/services/p2pquake.ts` の `convertEvent` が、受信した生 JSON を検証しながら内部型へ組み立てる。
**内部型に宣言されたフィールドだけを明示的に詰め直す**ため、API 固有のフィールド
（`comments` / `earthquake.foreignTsunami` / `hypocenter.reduceName` / `timestamp` 等）は落ちる。
生データは電文ログ（`TelegramLogEntry.rawBody`）に残るので調査には困らない。

英語の enum で来るフィールドは日本語化する:

- `issue.type`: `ScalePrompt` → `震度速報` 等
- `issue.correct`: `None` → `なし`、`Unknown` → `訂正`、`ScaleOnly` → `震度のみ訂正`、`DestinationOnly` → `震源を訂正`、`ScaleAndDestination` → `震度・震源を訂正`（`Correction` というキーは存在しない）
- `earthquake.domesticTsunami`: `None` → `なし`、`Watch` → `注意報`、`Warning` → `警報等` 等（`DOMESTIC_TSUNAMI_MAP` が扱う値ドメインは `None` / `Unknown` / `Checking` / `SeaFloor`（`海面変動の可能性`） / `NonEffective`（`若干の海面変動`） / `Watch`（`注意報`） / `Warning`（`警報等`） / `MajorWarning`（`警報等`） の 8 種。津波電文 code=552 側の等級（`areas[].grade`）はこのマップを通さず別扱い）

いずれのマップも、未知の値は既定値に格下げしたうえで警告を残す（`issue.type` → `その他`、
`issue.correct` → `なし`、`domesticTsunami` → `不明`）。

**不正値の扱い**: 基本はフィールド単位で既定値・センチネルに落として通し、電文ごと捨てるのは
同一性が壊れる場合だけに限る。

| 対象 | 挙動 |
|---|---|
| `code` が 551/552/556 以外・ペイロードが非オブジェクト | 電文を破棄（設計どおりの読み飛ばし） |
| `id` の欠落、`time` / `earthquake.time`（551）の欠落 | 電文を破棄。イベントの同一性キー・キューの並び順キーになるため |
| `points[]` / `areas[]` の壊れた要素 | その要素だけ落とし、電文は残す |
| 震度が階級外の値 | `-1`（不明）へ格下げ |
| 座標・深さ・規模が数値でない | P2PQuake が「不明」に使うセンチネル（座標 `-200` / 深さ `-1` / 規模 `-1`）へ。座標と深さは DMDATA 経路とも同じ値だが、規模だけは異なる（DMDATA 経路は `NaN`）。いずれも `hasMagnitude()` が「不明」として弾く |
| 津波の `areas[].grade` が未知 | `Unknown` へ格下げ |

**震度値の正規化**: API 仕様の値域は内部型 `IntensityScale` より広いため、以下を寄せる。
いずれも API 上は正規値なので警告は出さない。

| API の値 | 意味 | 内部での扱い |
|---|---|---|
| `46` | 震度 5 弱以上と推定されるが震度情報を入手していない | `45`（5 弱） |
| `0` | 震度 0 | `-1`（不明）。EEW のレベル判定はどちらでも結果が変わらない |
| `99` | 〜程度以上 | 同じ地域の `scaleFrom` |

`46` と `0` の読み替えは震度を持つ全フィールド（`points[].scale` / `earthquake.maxScale` /
`areas[].scaleFrom` / `areas[].scaleTo`）に共通で適用する。仕様上 `46` は `points[].scale` に、
`0` は EEW の `scaleFrom` / `scaleTo` にしか現れないが、どのフィールドに来ても同じ意味に読める値なので
区別していない。`99` は `areas[].scaleTo` 専用（`scaleFrom` とセットで初めて意味を成すため）。

`scaleTo = 99` をそのまま通すと階級外の値になり、`eewMaxScale()` の実行時ガードがその地域を
丸ごと無視する。最も強い「震度 7 程度以上」が特別警報に上がらなくなるため、下限の `scaleFrom` を
上限として採用する。

**severity の付与**: code=556（EEW）は P2PQuake API v2 のペイロードに severity フィールドを持たないが、
JMA 仕様上ここで配信される 556 は全て警報級であるため `convertEvent` が `severity: 'Warning'` を
明示付与する（付与しないと後段の `computeSingleEEWLevel` が予報扱いに落とし警報音・特別警報表示が
発火しない）。

**既知の情報粒度制約（QUAKE-6・TSU-5A）**: 実データ検証で確認済み。DMDSS の DMDATA と比較して以下が API 仕様
上の制約として存在する（詳細は [`quake-spec.md`](quake-spec.md) §4・[`tsunami-spec.md`](tsunami-spec.md) §3）:
- **地震情報**: `DetailScale`（観測点のみ）と `ScalePrompt`（区域のみ）が別電文で送られる。1 電文に
  両方を含めないため、標準版では県内の区域粒度内訳（一次細分区域ごとの震度差）を出せない
- **津波情報**: `validDateTime` フィールドが**そもそも存在しない**。標準版では
  `useEarthquakes` の TSU-1 経路（validDateTime による自動失効予約）が発火せず、
  解除電文 (`cancelled=true`) が届くまで表示され続ける。異例の障害で解除電文が届かない場合の
  フェイルセーフとして、`useEarthquakes` は 24h タイマーで自動非表示にする（TSU-5A）

### WebSocket 再接続

- 指数バックオフ（`3000ms → ×1.5`、上限 `30000ms`）
- 成功時にカウンタリセット
- エラー・不正メッセージのログ出力なし（既知の課題）

## 4. Yahoo リアルタイム震度（両バリアント共通）

### エンドポイント

- 観測点リスト: `https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList/sitelist_<siteConfigId>.json`（**west 固定**・`src/services/kyoshin.ts:21-22` の `SITELIST_BASE`）
- リアルタイム震度: `https://weather-kyoshin.<region>.edge.storage-yahoo.jp/RealTimeData/yyyyMMdd/yyyyMMddHHmmss.json`
- リアルタイム震度の `<region>` は west / east（west を優先、失敗時 east にフォールバック。SiteList は west のみ）

### 認証

不要。

### データ

- **観測点リスト**: 約 1725 点の緯度経度＋観測点情報（年に数回更新される・`siteConfigId` で判別）
- **リアルタイム震度**: 1 秒毎の JSON。`realTimeData.intensity` 文字列（1 文字＝1 観測点、`charCodeAt(0)-100` が index 0〜20）
- **震源情報（hypoInfo）**: EEW 相当の情報（震源・M・calcintensity 等）を含む場合がある

`fetchRealtimeIntensity` は `res.ok` に加えて `realTimeData` の存在、`realTimeData.intensity` が
非空の文字列であることを検証する（フィールド欠落・型不一致・空文字は次エッジ／リトライへフォールバック）。
`calcintensityToScale` は「空文字・null/undefined」（震度未確定の想定内）以外の未知コードで `log.warn` を出す
（silent に severity=Forecast 格下げを防ぐ）。
`useKyoshinRealtime` の `applyFrame` は try/catch で例外を隔離し、ローカルバグと fetch 失敗を分けて扱う。

### 取得と再生の分離

1 時点ぶんの観測データ（1 秒ぶんの全観測点の震度＋データ時刻＋hypoInfo）を **フレーム** と呼ぶ。
フレームは「供給元 → 時刻順キュー → 画面反映」の 3 段で流れる。

| 段 | 実装 | 役割 |
|---|---|---|
| 供給元 | [`src/services/kyoshinSource.ts`](../../src/services/kyoshinSource.ts) | どこからデータを持ってくるか。Yahoo のライブ／過去リプレイの 2 実装。リトライ・スケジューリングと、クロック同期の起動／停止（ライブ限定）もここ |
| キュー | [`src/utils/kyoshinFrameQueue.ts`](../../src/utils/kyoshinFrameQueue.ts) | フレームをデータ時刻順に並べ、アプリ時計が追いついた時点で放出する |
| 反映 | [`src/hooks/useKyoshinRealtime.ts`](../../src/hooks/useKyoshinRealtime.ts) | 放出されたフレームを画面の状態へ入れる。観測点リストの追随取得と hypoInfo 差分もここ |

分離の目的は取得ペースと表示ペースを切り離すこと。Yahoo は 1 秒 1 リクエストなので両者が一致するが、
「フレーム列が一度にまとまって手に入る」供給元（防災科研 K-NET のアーカイブ等）を足す場合は、
まとめて投入して時刻に沿って流す必要がある。`KyoshinSource` を実装すれば下流は変更なしで載る。

放出は**到来した最新 1 件のみ**を採り、間は捨てて `log.warn` に残す（1Hz の観測フレームは最新の状態だけが
意味を持つため。到来分を全件処理する電文側のキューとは意味論が逆）。反映は**データ時刻の順に限る**
（`applyFrame` の単調性ガード）。供給元が時計の後退をまたぐと古いデータ時刻のフレームを積みうるため、
そのまま入れると表示が巻き戻り、検知エンジンにも後退したデータ時刻が渡る。順序の判定に使うのは
取得を要求した時刻であり、表示に使う `dataTime` 文字列とは独立（応答のパースに依存させないため）。

`siteConfigId` 切替時（年数回）: `fetchSiteList` は Promise キャッシュを持つが、失敗した Promise は
キャッシュから削除して再試行可能にする。`useKyoshinRealtime` は `currentSitesKeyRef` の更新を
取得成功後に行い、失敗時は ref を据え置いて次のフレームで再試行させる（失敗は `log.warn` で通知。
毎フレーム再試行するため、記録は観測点集合ごとに一度に絞る）。
`sites`／`indices` の状態にはそれぞれの `siteConfigId` を紐付けて公開し、`useKyoshinDetectorV2` は
`sitesSiteConfigId !== indicesSiteConfigId` のフレームを step() 呼び出しからスキップする（切替直後の
「新 indices・旧 sites」で `frame.sites[i]` アクセスが `TypeError` になる恒久停止と、点数が偶然一致
した年切替で座標と震度が位置ベースで誤ペアリングされる検知エンジン内部の不整合を防ぐ）。
検知エンジン外の下流経路（地図描画・RealtimeTab・派生ビュー `deriveKyoshinView` ／
`filterSubThresholdIndices`）も同じ `sites[i]`／`indices[i]` の位置対応で消費するため、`src/App.tsx` で
`sitesSiteConfigId === indicesSiteConfigId` の条件を満たさない期間は空配列にゲートして通す。
sitelist の非同期取得が完了した次フレームで元の実データに戻る（非表示時間はネットワーク往復 1 回分）。
step 内例外も try/catch でログ出力の上、次フレームへ復帰する。

**残る既知の課題**（発生頻度・切替頻度から今回のスコープ外）:
- 並行 `fetchSiteList` 呼び出しの順序保証がない（1 回目の応答が 2 回目より遅れると `sites`／`sitesSiteConfigId`
  を古い内容へ巻き戻す可能性）
- sitelist 取得失敗時のリトライに上限・バックオフがない（Yahoo 側で `siteConfigId` の URL が恒久的に
  無効になった場合、毎フレーム無制限に再試行する）。恒久的に失敗しても「更新停止」の表示は出ない
  （震度と時刻は更新され続けるため、エラー無しのまま観測点が地図に出ない状態になりうる）

### index → 震度の変換

`indexToValue(index) = -3.0 + index * 0.5`（0.5 刻み量子化、index 6 = 震度 0 = value 0.0）。
`index = -1` は欠測センチネル（公式 CSS が裏付け）。

**欠測は 1〜2 秒で復帰する瞬断が多く、強く揺れている観測点でも起きる。** 表示側は欠測を描かないため、
そのままでは強い揺れのバッジが 1 秒だけ消える。このため**表示に使うインデックスだけ**、欠測点を直前値で
短時間保持する（保持の範囲・時間・見せ方は
[`kyoshin-detection-spec.md`](kyoshin-detection-spec.md) §8。検知エンジンには生値を渡す）。

### クロック同期（`startClockSync`）

Yahoo は未登録秒には 403 を返す（登録遅延約 1.5 秒）。この 403 → 200 遷移を捉えて時刻を較正する
（`src/services/kyoshin.ts` の `syncClockOnce`）。起動と停止はライブの供給元の開始・終了に紐づく
（リプレイ中は起動しない。アーカイブの時刻とサーバーの現在時刻は無関係なため）。

- 30 秒毎に実行
- guessSec の前後 `[-4, +2]` の探索窓で 200 になる境界を検出
- 検出した境界を `feedServerSample` に渡して EMA 較正（`clock.ts`）

`isRegistered` は `200` → `true`（登録済み）、`403/404` → `false`（未登録）、
`5xx`/`429`/その他 → `null`（判定不能）の三値を返し、`syncClockOnce` は `null` の
サンプルを較正基準として採用しない（CDN の一時的な障害を「未登録→登録」遷移と誤認して
`feedServerSample` を汚染し、時計がじわじわ狂うのを防ぐ）。

**既知の課題**:
- 探索窓が固定で、壁時計が数秒以上ずれると恒久的に較正不能になる
- 較正失敗時の無警告 `Date.now()` フォールバック（診断 API `getServerClockOffsetMs` は全体で未使用）

### EEW 補完（`hypoInfoItemToEEW`）

Yahoo の `hypoInfo.items` を EEW 型に変換して P2PQuake と統合する。**この経路は標準版のみ**
（DMDSS 版は DMDATA の EEW 電文を主系とし、Yahoo 由来の EEW は使わない。詳細は
[`eew-spec.md`](eew-spec.md) §3）。
`condition` に相当するフィールドが無いため常に `'以上'` を返す（single-point PLUM 検知の判別不能・
既知の限界。**PLUM 法** の詳細は [`eew-spec.md`](eew-spec.md) §5 参照）。severity は震度からの
ヒューリスティック推定（`scaleNum >= 45 ? 'Warning' : 'Forecast'`）。

## 5. クロック同期（`src/utils/clock.ts`）

**壁時計は絶対値として信用しない**。以下の時刻は `serverNow()` で取得する:

- EEW P/S 波円計算
- EEW 自動解除タイミング
- 津波 `validDateTime` の期限判定
- Yahoo 取得ラグ計算
- 実地震テストシナリオの時刻シフト

### 実装

- `serverNow(): number` — サーバー基準の epoch ms を返す
- 内部で `K = trueServerEpoch - performance.now()` を保持
- Yahoo クロック較正から `feedServerSample(trueServerEpoch)` で K を EMA 更新（α = 0.2）
- 未較正時（K = null）は `Date.now()` にフォールバック

### 既知の課題

- `feedServerSample` に外れ値検知なし（初回サンプルは無条件採用）
- 未較正時のフォールバックが無警告
- Page Visibility API 未考慮（バックグラウンドタブでの較正遅延）

## 6. 生成データ（`public/data/`）

事前生成された座標・境界データ。地図は常時表示されるため、地図が使うものは表示モード（地震／津波／
リアルタイム震度）に関わらず地図の初回表示時にまとめて要求する。読み上げ辞書とテストシナリオ一覧は
アプリ起動時、シナリオ本体は再生時に取得する。いずれも一度取得したらキャッシュする。

| ファイル | 生成スクリプト | 用途 |
|---|---|---|
| `station-coords.json` | `scripts/build-station-coords.mjs` | 震度観測点の座標＋所属区域 |
| `tsunami-zones.json` | `scripts/build-tsunami-zones.mjs` | 津波予報区の海岸線 |
| `tsunami-obs-coords.json` | 手動整備 | 津波観測点座標 |
| `prefectures.json` | `scripts/build-prefectures.mjs` | 都道府県境界 |
| `subregions.json` | `scripts/build-subregions.mjs` | 一次細分区域境界（**一次細分区域** の定義は [`quake-spec.md`](quake-spec.md) §1 参照） |
| `active-faults.json` | `scripts/build-active-faults.mjs` | 全国活断層線 |
| `plate-boundaries.json` | `scripts/build-plate-boundaries.mjs` | プレート境界線（全球・52 プレート） |
| `tts-phrase-break-dict.json` | 手動整備 | 読み上げ用の句区切り辞書 |
| `test-scenarios/index.json` | 手動 or `capture-test-scenario.ts` | 実地震テストシナリオ一覧（本体は .gitignore） |

**取得に失敗したとき**: そのデータを使う表示だけを諦めて動作を続ける（何が欠けるかは各仕様書を参照）。
失敗は `console` に残し、次に要求されたときに取得し直す（自動リトライは持たない）。

**取得状況の表示**: 地図左上（更新時刻の下）に `MapDataStatus` を出す。取得が 3 秒以上続いたら
「データを取得中…」、失敗したまま取り直せていないデータがあれば
「データの一部を取得できませんでした（N 件）／再読み込みで取得し直します」を表示する。
失敗があるときは取得中より優先し、両方は出さない。正常時は何も出さない（通常は 1 秒ほどで
揃うため、その間の表示はちらつきにしかならない）。何が取れなかったかの詳細は `console` 側に
あり、画面には件数だけを出す。取り直しに成功すれば表示は消える。

対象は**地図の見た目に関わるデータだけ**。読み上げの句区切り辞書と実地震テストシナリオは
地図に影響せず、それぞれ音声と設定タブ側に固有の表示があるため数えない
（`fetchJsonWithTimeout` の `trackStatus: false`）。

**タイムアウト**: 応答もエラーも返らない回線で待ち続けないよう、取得は 60 秒で打ち切って上記の
失敗として扱う（`src/utils/fetchJson.ts`）。これらは初回表示時にまとめて要求されるため、1 本ずつ
ではなく合計サイズ（gzip 後 約 1.7MB）を基準にした値で、低速回線での正常な取得を切らないことを
優先している。読み上げの句区切り辞書だけは読み上げ本体が取得を待つため、これより大幅に短い専用の値を使う
（[`audio-tts-spec.md`](audio-tts-spec.md) の「辞書（読み仮名の補正）」節）。

出典:
- 気象庁 予報区等 GIS データ: [Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)
- 観測点座標: [iku55 氏による JSON 化](https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1)
- GEBCO 海底地形: [GEBCO Basemap (NCEI)](https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer)
- 活断層: 産業技術総合研究所 [活断層データベース](https://gbank.gsj.jp/activefault/)（政府標準利用規約 2.0）
- プレート境界: [PB2002](http://peterbird.name/publications/2003_pb2002/2003_pb2002.htm)（Peter Bird）／データ整備: Hugo Ahlenius・Nordpil [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates)（[Open Data Commons Attribution License 1.0](http://opendatacommons.org/licenses/by/1.0/)）

## 7. リプレイ機能

### 「テスト時刻設定」

設定タブで日時を指定して過去を再生する機能。再生の仕組みは共通で、**当時の電文をどこから
取ってくるかがバリアントで変わる**。

バリアント別に何が再生されるか、取得の詳細（日付単位の取得・キャッシュ・取りこぼしの扱い）、
再生中にライブ接続を止める理由は [`settings-pwa-spec.md`](settings-pwa-spec.md) §6
「テスト時刻設定」に集約している。

本書が受け持つのはデータ源としての制約だけ。**standard 版のリプレイで EEW を取得できないのは、
P2PQuake に緊急地震速報（code 556）を過去日付で引く口が無いため**（`/jma` 配下に無く、
`/history` は日付指定できないうえ 1 週間以上前を辿れない）。強震モニタの震源情報から EEW を
検出する経路はリプレイ中も働くため、当時発表された EEW 自体は画面に出る。

### 実地震テストシナリオ

`useTestScenarios.ts` が管理。両バリアント共通で動作する。詳細は
[`settings-pwa-spec.md`](settings-pwa-spec.md) の「実地震テスト」節。

## 8. 震度スケール

| 値 | 震度 |
|---|---|
| 10 | 1 |
| 20 | 2 |
| 30 | 3 |
| 40 | 4 |
| 45 | 5弱 |
| 50 | 5強 |
| 55 | 6弱 |
| 60 | 6強 |
| 70 | 7 |

センチネル値:
- `-1` — 震度算出不能・不明
- `-200` — 位置不明（震度速報の震源座標フォールバック）

内部型 `IntensityScale` は上表と `-1` だけを取る。P2PQuake API はこれより広い値域（`0` / `46` / `99`）を
返すため、`convertEvent` が受け口で上表の値に寄せる。読み替えの一覧は §3「震度値の正規化」を参照。

## 9. 環境による制約

- 一部の外部ホストに到達できない環境がある（例: 防災科研 kmoni の HTTPS）。Yahoo 強震モニタ・DMDATA.JP は到達可能
- P2PQuake API は非公式サービスのためサービス継続性は保証されない
- DMDATA.JP は個人契約では EEW の二次配信が制限される（利用規約第 15 条）ため、GitHub Pages 公開版に
  実 EEW シナリオをコミットしない運用が必要

## 10. 関連実装ファイル

- `src/services/dmdata.ts` — DMDATA WebSocket + 認証
- `src/services/dmdataParser.ts` — DMDATA JSON/XML パース
- `src/services/dmdataReplay.ts` — DMDATA archive リプレイ
- `src/services/p2pquake.ts` — P2PQuake クライアント + レスポンス検証
- `src/services/parseHelpers.ts` — 外部レスポンスの値取り出しヘルパ（DMDATA・P2PQuake 共用）
- `src/services/kyoshin.ts` — Yahoo リアルタイム震度の取得 + クロック同期
- `src/services/kyoshinSource.ts` — 強震モニタのフレーム供給元（Yahoo のライブ／過去リプレイ）
- `src/utils/kyoshinFrameQueue.ts` — フレームのデータ時刻順キュー
- `src/utils/clock.ts` — サーバー同期時刻 `serverNow`
- `src/utils/tarParser.ts` — DMDATA archive の tar 展開
- `src/hooks/useKyoshinRealtime.ts` — 強震モニタのフレームを画面状態へ反映
- `src/utils/fetchJson.ts` — 生成データ取得の共通処理（タイムアウト・取得状況の集約）
- `src/components/MapDataStatus.tsx` — 取得状況の表示

## 11. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
- 2026-08-16: 標準版（P2PQuake）のレスポンスを無検証で内部型として扱っていたのをやめ、
  `convertEvent` に検証を入れた（§3）。あわせて公式仕様と突き合わせて §8 のセンチネル表を訂正。
  `46` が未対応だった件（旧「既知の欠落」）と、`99` を「デッドコード」と書いていた誤りを解消した
- 2026-08-18: 震源カタログの節を新設（§2）。震源が決まっていない項目の座標を無条件に読んでいたため、
  直近 30 日 699 件のうち 3 件の欠測項目で取得全体が例外になり、DMDSS 版のヒートマップが丸ごと
  表示されなくなっていた。欠測項目を個別に除く扱い・件数の警告・全滅時の例外を追加した。
  あわせて座標が 0.1 度刻みに丸められている事実を記載（地図側の描画方針に影響する）
- 2026-08-18: 南海トラフ・後発地震情報の取得失敗が完全な空 catch で痕跡を残していなかったのを改め、
  失敗を記録するようにした（§2）。401/403（契約スコープ不足＝再試行で直らない）と一時的な失敗を
  ログレベルで切り分ける共通ヘルパーを入れ、震源カタログ（`gd/earthquake`）にも適用した。
  あわせて APIキーの入力をデバウンスしてから通信側へ渡すようにした（§2 認証）。従来は 1 文字ごとに
  接続と履歴取得をやり直しており、上記のログ追加でそれが 401/403 のログとして表面化したため
- 2026-08-19: 強震モニタの取得を「供給元 → データ時刻順キュー → 反映」の 3 段へ分離した（§4
  「取得と再生の分離」）。従来は取得したその場で画面へ入れており、取得ペースと表示ペースが結合して
  いたため、フレーム列がまとめて手に入る供給元（K-NET のアーカイブ等）を載せる余地が無かった。
  あわせて、キューを挟んだことで順序が入れ替わる余地が生まれたため、反映をデータ時刻順に限る
  ガードを追加した
