# データソース仕様書

> 本書は**アプリが使用する外部データソースと接続の仕組み**をまとめた仕様書。
> 実コードと食い違う場合は実コードを正とする。

## 1. 概要

3 系統のデータソースを扱う:

- **DMDATA.JP**（DMDSS 版・要 API キー） — 地震情報・EEW・津波情報の主系
- **P2PQuake API v2**（標準版・認証不要） — 地震情報・EEW・津波情報の主系
- **Yahoo!天気・災害 リアルタイム震度**（両バリアント共通） — 強震モニタデータ、EEW 補完

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

### 受信する電文種別

| 種別コード | 内容 | 用途 |
|---|---|---|
| VXSE43 | 緊急地震速報（警報） | EEW 警報表示 |
| VXSE44 | 緊急地震速報（予報） | **受信対象外**（廃止予定・VXSE45 で代替。`EEW_TYPES` から除外済み） |
| VXSE45 | 地震動予報 | EEW 詳細（長周期地震動階級を含む） |
| VXSE51 | 震度速報 | 地震カード（速報） |
| VXSE52 | 震源に関する情報 | 地震カード（震源） |
| VXSE53 | 震源・震度に関する情報／遠地地震に関する情報 | 地震カード（詳細報／遠地地震）。両者は同じ種別コードで届き `Head/Title` で識別する（[quake-spec.md](quake-spec.md) §3） |
| VXSE61 | 顕著な地震の震源要素更新 | 続報統合 |
| VXSE62 | 長周期地震動観測情報 | 長周期区域塗り |
| VTSE41 | 津波警報・注意報 | 津波タブ |
| VTSE51 | 津波観測情報 | 津波観測バー |
| VTSE52 | 沖合の津波観測情報 | 津波観測バー |
| VYSE50 | 南海トラフ地震臨時情報（発表段階の情報） | 南海トラフバナー |
| VYSE51 | 南海トラフ地震臨時情報（追加情報） | 南海トラフバナー |
| VYSE52 | 南海トラフ地震関連解説情報 | **受信対象外**（補足解説電文でステータス判定に使えないため） |
| VYSE60 | 北海道・三陸沖後発地震注意情報 | 後発地震バナー |

**電文本体の展開**: WebSocket の `body` は base64 + gzip で配信される。ブラウザネイティブの
`DecompressionStream('gzip')` で復号してから `dmdataParser.ts` で内部型に変換する。

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

### 試験報（VXSE42）

設定タブの「試験報を受信（検証用）」を有効にすると、毎正時に配信される配信テスト電文も受信できる。
実地震を待たずにリアルタイム受信経路を検証できる（受信した試験 EEW は通常の発報と同様に表示される）。

## 3. P2PQuake API v2（標準版）

### エンドポイント

- WebSocket: `wss://api.p2pquake.net/v2/ws`
- REST: `https://api.p2pquake.net/v2/history`

### 認証

**不要**（公開 API）。

### 受信するコード

| code | 内容 | 用途 |
|---|---|---|
| 551 | JMA 地震情報 | 地震タブ |
| 552 | JMA 津波情報 | 津波タブ |
| 556 | 緊急地震速報 | EEW |

### convertEvent の日本語化

P2PQuake の生 JSON は英語の enum で来るフィールドがあるため、`src/services/p2pquake.ts` の
`convertEvent` で日本語化する:

- `issue.type`: `ScalePrompt` → `震度速報` 等
- `issue.correct`: `None` → `なし`、`Unknown` → `訂正`、`ScaleOnly` → `震度のみ訂正`、`DestinationOnly` → `震源を訂正`、`ScaleAndDestination` → `震度・震源を訂正`（`Correction` というキーは存在しない）
- `earthquake.domesticTsunami`: `None` → `なし`、`Watch` → `注意報`、`Warning` → `警報等` 等（`src/services/p2pquake.ts:22-26` の `DOMESTIC_TSUNAMI_MAP` が扱う値ドメインは `None` / `Unknown` / `Checking` / `SeaFloor`（`海面変動の可能性`） / `NonEffective`（`若干の海面変動`） / `Watch`（`注意報`） / `Warning`（`警報等`） の 7 種。**`MajorWarning` は含まれない**。津波の大津波警報は code=552（`JMATsunami`）の `areas[].grade` 側で扱われ、こちらは英語のまま内部型に流れる）

**severity の付与**: code=556（EEW）は P2PQuake API v2 のペイロードに severity フィールドを持たないが、
JMA 仕様上ここで配信される 556 は全て警報級であるため `convertEvent` が `severity: 'Warning'` を
明示付与する（付与しないと後段の `computeSingleEEWLevel` が予報扱いに落とし警報音・特別警報表示が
発火しない）。

**既知の欠落**:
- `points[].scale=46`（震度 5 弱以上推定）が既知震度マップにない

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
`useKyoshinRealtime.processResult` は try/catch で例外を隔離し、ローカルバグと fetch 失敗を分けて扱う。

`siteConfigId` 切替時（年数回）: `fetchSiteList` は Promise キャッシュを持つが、失敗した Promise は
キャッシュから削除して再試行可能にする。`useKyoshinRealtime` は `currentSiteConfigIdRef` の更新を
fetch 成功後に行い、失敗時は ref を据え置いて次 tick で再試行させる（失敗は `log.warn` で通知）。
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
  無効になった場合、毎 tick 無制限に再試行する）

### index → 震度の変換

`indexToValue(index) = -3.0 + index * 0.5`（0.5 刻み量子化、index 6 = 震度 0 = value 0.0）。
`index = -1` は欠測センチネル（公式 CSS が裏付け）。

### クロック同期（`startClockSync`）

Yahoo は未登録秒には 403 を返す（登録遅延約 1.5 秒）。この 403 → 200 遷移を捉えて時刻を較正する
（`src/services/kyoshin.ts` の `syncClockOnce`）。

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

Yahoo の `hypoInfo.items` を EEW 型に変換して P2PQuake（標準版）や DMDATA（DMDSS 版）と統合する。
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

事前生成された座標・境界データ。地図初回表示時または該当タブ表示時に fetch する。

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

出典:
- 気象庁 予報区等 GIS データ: [Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)
- 観測点座標: [iku55 氏による JSON 化](https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1)
- GEBCO 海底地形: [GEBCO Basemap (NCEI)](https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer)
- 活断層: 産業技術総合研究所 [活断層データベース](https://gbank.gsj.jp/activefault/)（政府標準利用規約 2.0）
- プレート境界: [PB2002](http://peterbird.name/publications/2003_pb2002/2003_pb2002.htm)（Peter Bird）／データ整備: Hugo Ahlenius・Nordpil [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates)（[Open Data Commons Attribution License 1.0](http://opendatacommons.org/licenses/by/1.0/)）

## 7. リプレイ機能

### 「テスト時刻設定（強震モニタ）」

設定タブで日時を指定して過去を再生する機能。**同じボタンがバリアントによって別の動きをする**。

| バリアント | 動き |
|---|---|
| standard | アプリの時計をずらすだけ。Yahoo リアルタイム震度が過去の時刻から再生される |
| DMDSS | 上記に加えて、DMDATA アーカイブから当時の電文（地震・津波・EEW 等）も取得して流す |

DMDSS 版のアーカイブ取得（目録の構造・取りこぼしの扱い）は
[`settings-pwa-spec.md`](settings-pwa-spec.md) §6「テスト時刻設定（強震モニタ）」を参照。

**既知の課題**: 実装が useEarthquakes.ts の接続 useEffect の先頭で `replayTimeOffset !== null` の
早期 return を行うため、standard 版の P2PQuake WS 接続まで停止する副作用がある（HIGH 課題）。

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
- `99` — （実装上は使われない・`eew.ts:170` にコメントとガードが残るがデッドコード）

## 9. 環境による制約

- 一部の外部ホストに到達できない環境がある（例: 防災科研 kmoni の HTTPS）。Yahoo 強震モニタ・DMDATA.JP は到達可能
- P2PQuake API は非公式サービスのためサービス継続性は保証されない
- DMDATA.JP は個人契約では EEW の二次配信が制限される（利用規約第 15 条）ため、GitHub Pages 公開版に
  実 EEW シナリオをコミットしない運用が必要

## 10. 関連実装ファイル

- `src/services/dmdata.ts` — DMDATA WebSocket + 認証
- `src/services/dmdataParser.ts` — DMDATA JSON/XML パース
- `src/services/dmdataReplay.ts` — DMDATA archive リプレイ
- `src/services/p2pquake.ts` — P2PQuake クライアント
- `src/services/kyoshin.ts` — Yahoo リアルタイム震度 + クロック同期
- `src/utils/clock.ts` — サーバー同期時刻 `serverNow`
- `src/utils/tarParser.ts` — DMDATA archive の tar 展開
- `src/hooks/useKyoshinRealtime.ts` — Yahoo ポーリング

## 11. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
