# 設定・PWA 仕様書

> 本書は**設定タブ・localStorage・PWA・実地震テストの仕様**をまとめた文書。
> 実コードと食い違う場合は実コードを正とする。

## 1. 概要

以下 4 領域をカバー:

- 設定タブの構成と各項目の意味
- localStorage キー・データ形式
- PWA（Progressive Web App）と Service Worker
- 実地震テスト（合成データによるテストボタン群 + 実電文シナリオ再生）
- DMDSS 版の API キー管理

## 2. 設定タブの構成（`src/components/SettingsTab/index.tsx`）

上から順に以下のセクションを表示する。全体の並びは「設定 → テスト → 情報」の順。

| セクション | 主な項目 |
|---|---|
| DM-D.S.S 接続設定（DMDSS 版のみ） | 接続状態・API キー（BYOK 方式）・試験報の受信 |
| 表示設定 | 最低表示震度・UI 倍率・地図アイコン倍率・地図レイヤーの表示切替 |
| ホーム地点 | 現在地の緯度経度（→ §9） |
| タブ自動切替設定 | デフォルトタブ・津波発表中の優先・津波タイトル表示の一定時間制限・自動復帰までの時間 |
| 動作設定 | 定期自動リロード（→ §8） |
| 通知設定 | 通知音・音量・VOICEVOX 読み上げ・ブラウザ通知・通知許可 |
| 通知音テスト | 各通知音の試聴 |
| テスト機能 | 合成データによるテスト発報（→ §7） |
| 実地震テスト | 実電文シナリオの再生（→ §6） |
| テスト時刻設定（強震モニタ） | 過去日時からの再生（→ §6「テスト時刻設定（強震モニタ）」） |
| このアプリについて | バージョン（→ §10）・データ出典・サーバー時刻オフセット |
| 震度スケール | 震度の色凡例 |

### 並び順の方針

重大度を持つ項目（EEW・津波の各テスト）は、どのセクションでも**軽い順**に並べる。
発報段階を表す項目（続報・最終報）は対応する確定報の直後に置き、
重大度の軸に乗らない誤報取消・キャンセルはそのカテゴリの末尾に置く。
カテゴリの順序は「通知音テスト」「テスト機能」および「通知設定」の種別トグルで共通とし、
速報性の高いものから **揺れ検知 → EEW → 地震情報 → 津波情報 → 臨時情報 → その他**。
「テスト機能」には揺れ検知の発報テストがないため EEW から始まり、「その他」はブラウザ通知テストが該当する。
「通知設定」の種別トグルは該当する 3 種（揺れ検知 → EEW → 津波）のみ。

> アプリ全体が昇順基調（震度セレクタ・震度スケール凡例・震度別の試聴ボタン）のため、
> テスト系もそれに揃えている。

### 行のレイアウト

各行は「ラベル左・コントロール右」に置く。ただしパネルが最も狭くなる `sideNarrow`（スマホ横・
小型タブレット横。条件は [`architecture-spec.md`](architecture-spec.md) §4「画面サイズ別のレイアウト」）では
コントロールが幅を譲らないぶんラベルが数文字幅まで潰れてしまうため、ラベルに最低幅を与え、
収まらない行だけをラベル上・コントロール下の 2 段に折り返す。トグルのように細いコントロールの行は
1 段のまま保たれる（スマホ横は画面高が狭く、一律に縦積みすると縦スクロールが増えるだけになる）。
2 段になった行でもコントロールは右端に揃える。コントロール自体が行幅を超える場合、
データ出典の表記のような**折り返せるテキストなら**中身を折り返して収める。select や入力欄は
折り返せないため、超えた分はそのまま切り取られる。選択肢が外部から来るもの（VOICEVOX の話者など）は
極端に長い文字列を持ちうる点に注意する。

### 主な項目の補足

- **最低表示震度**: これ未満の地震をリストに出さない。遠地地震は国内震度を持たないため対象外（常に表示）
- **UI 倍率**: 画面全体の UI 拡大縮小（文字・余白・ナビのアイコンが追従する。枠線・影・アウトラインの太さは変わらない）
- **地図アイコン倍率**: 地図に描かれるもの全般の大きさ（UI 倍率とは独立）。震度バッジ・観測点ドット・地名ラベル・震源の×印・長周期地震動の階級表示・強震モニタの各表示（観測点・検知点・波紋）・津波の海岸線と観測バー・地震活動ヒートマップなどが対象
- **地図レイヤー**: 地形（海底地形）→ 地質構造（プレート境界線・活断層線）→ 観測データ（地震活動ヒートマップ）の順。「活断層線の濃さ」は活断層線トグルに従属し、OFF のときは無効化される
- **ブラウザ通知**: 種別ごとに独立トグル 3 種（`notifyDetection` / `notifyEEW` / `notifyTsunami`）＋ 通知しきい値（`notifyMinScale`。`震度1以上`〜`震度7`から選択）
- **音量**: 通知音と VOICEVOX 読み上げに共通適用（0〜1）
- **自動復帰までの時間**: `idleRevertSec` = **ユーザー操作が止まってから**デフォルトタブへ戻る秒数（`0` で無効）。
  この値は地図カメラの自動追従にも共通で使う（手動でズーム・パンしたあと自動追従を再開するまでの時間、
  および津波モードで俯瞰へ戻るまでの時間。[`map-rendering-spec.md`](map-rendering-spec.md) §6）。
  タブが戻るのは画面のどこを操作しても数え直すが、カメラ側は地図を操作したときだけ数え直す
- **ダークモード**: 常時 ON（切替なし）

## 2.5 設定タブ以外で保存される設定

設定タブに入力欄はないが、画面操作の結果が同じ localStorage に保存される項目:

- **`panelRatio`**（既定 0.45・範囲 0.2〜0.8）: 上下分割レイアウト（スマホ縦など）での
  地図と情報パネルの高さ比率。**地図とパネルの境界にあるつまみをドラッグして離した時点**で
  保存される。詳細は [`architecture-spec.md`](architecture-spec.md) の「画面サイズ別のレイアウト」。
  なおパネルの折りたたみ状態は一時的なものとして保存しない（起動時は必ず展開）。

## 3. localStorage キー

| キー | 内容 | 保存先 |
|---|---|---|
| `quake-viewer-settings` | 標準版のユーザー設定 | ブラウザ |
| `quake-viewer-settings-dmdss` | DMDSS 版のユーザー設定 | ブラウザ |
| `kyoshin-v3-learned` | 揺れ検知エンジンの学習資産（chronicNoiseFloor 等） | ブラウザ |
| `quake-heatmap-cache-v2` / `quake-heatmap-cache-dmdss-v2` | 地震活動ヒートマップのキャッシュ | ブラウザ |

`useSettings.ts` が読み書きを担う。バリアントごとにキーが分離されているため、両バリアントを
同一ブラウザで並用しても設定は混ざらない。

**API キーの保存**: DMDSS 版で `dmdataApiKey` フィールドを平文で localStorage に保存する（BYOK 方式）。
XSS が発生した場合に盗まれるリスクは残るが、静的 PWA（サーバーレス）ではこれ以上の防御は難しい。
README・CLAUDE.md にも明記されている運用。

## 4. デフォルト値と読み込み時の防御

`useSettings.ts` の `load()`:

- `localStorage.getItem` → `JSON.parse` → `sanitize()` を通して読む
- 失敗（パース例外・object でない値）時はデフォルト値にフォールバック
- `sanitize()` が全項目の型と範囲を検証し、不正な値・欠けている項目は既定値に落とす
  （数値は範囲でクランプ、真偽値・文字列は型チェック）。これにより、古いバージョンで保存された
  設定や項目が増えた後の設定でも、欠損項目が既定値で補われる

## 5. PWA と Service Worker

`vite-plugin-pwa` + Workbox で構築。バリアントごとに独立した Service Worker を生成する。

### バリアント別の設定（`vite.config.ts`）

- **base path**: `/realtime-earthquake-viewer/`（標準）または `/realtime-earthquake-viewer/dmdss/`
- **outDir**: `dist/` または `dist-dmdss/`
- **manifest.name / short_name / description**: バリアントで切り替え
- **manifest.icons**: `public/icons/` には `icon.svg` のみ実在する。SEC-5 で manifest エントリを SVG 単一（`sizes: 'any', purpose: 'any maskable'`）に統合済み。以前は `icon-192.png` / `icon-512.png` を参照していたが実 PNG が無く 404 になっていた。iOS の `apple-touch-icon` は仕様上 PNG 前提で SVG 対応は未確定のため、ホーム画面追加時のアイコン表示は実機検証が必要（未実施・残課題）

### Service Worker のスコープ

配信パスの違い（`/realtime-earthquake-viewer/` vs `/dmdss/`）で SW スコープが自然に分離される。

**SEC-3 対応（2026-08-14）**: standard 版を先に開いた端末で DMDSS 版へ初回アクセスした際に
standard の NavigationRoute が横取りする問題への対策として、standard 版の workbox に
`navigateFallbackDenylist: [/^\/realtime-earthquake-viewer\/dmdss(\/|$)/]` を追加済み。
末尾スラッシュ有り無しの両方を許容する正規表現で `/dmdss` と `/dmdss/` の両方をカバーする。
DMDSS 版はこの denylist を空配列にする（自分自身のパスなので影響なし）。

### キャッシュポリシー

- 静的リソース（JS/CSS/HTML/フォント SDF PBF/画像）は precache
- DMDATA / P2PQuake / Yahoo エンドポイントはランタイムキャッシュ対象外（キー付きレスポンスを残さない）
- `cleanupOutdatedCaches()` で古いバージョンのキャッシュを削除
- 1 ファイルあたりの上限は 2MiB を明示（超過するとビルドが失敗する。黙って precache から外れることはない）

### 更新の検知（`src/main.tsx`）

新しい SW が有効になると `controllerchange` を受けて `sw-updated` を発火し、App 側が 10 秒カウントダウン
してリロードする。ただし**ウィンドウタイトルに情報を出している間はカウントダウンを進めない**（EEW・津波だけでなく、地震情報・揺れ検知・南海トラフ臨時情報なども含む。判定は `title.alertTitle` が非 null かどうかで、種別が増えても自動的に対象になる）。

このカウントダウンは定期自動リロード（§8）と同一の仕組みで、**延期条件も共通で効く**。

インストールが中断された場合はこの経路に乗らない（`activate` が起きないため何も通知されない）ので、
`updatefound` から新 SW の状態を追い、`redundant` になったらエラーログを残す。ただし検知できる範囲は
限られる:

- `redundant` は「失敗」だけでなく「更に新しい版に置き換えられた」ときにも起きるため、ログは断定しない
- 初回インストールの失敗は検知できない（監視は稼働中の SW を前提に張るため）。この場合オフライン機能が
  使えないだけで、アプリの通常動作には影響しない

### オフライン動作

ネットワーク接続時のみリアルタイム受信が動作。オフラインでも地図・UI は表示できる（キャッシュされた
JS + 事前生成 GeoJSON のみで動く）。

## 6. 実地震テスト（シナリオ再生）

### 目的

合成テストデータ（`testData.ts`）では再現できない実データ由来の挙動（区域集約・震度分布・続報の推移）を
検証するための機能。**標準版・DMDSS 版共通**で動作する。

### データ形式

`public/data/test-scenarios/*.json` にシナリオ本体を置く。

```ts
// docs/spec/settings-pwa-spec.md の参考記述
// 正の型は src/types/testScenario.ts と src/services/dmdataReplay.ts の ReplayPayload を参照
type TestScenarioFile = {
  id: string
  label: string
  description: string
  category: 'eew-special' | 'eew-warning' | 'eew-forecast' | 'quake' | 'tsunami' | 'lpgm' | 'foreign'
  durationMs: number
  baseTime: string   // ISO
  entries: Array<{
    offsetMs: number
    // ReplayPayload は 4 バリアント（実装: dmdataReplay.ts）
    payload:
      | { kind: 'event'; event: AppEvent }         // quake / eew / tsunami
      | { kind: 'lpgm'; data: JMALpgm }            // 長周期地震動観測情報（VXSE62）
      | { kind: 'nankai'; data: JMANankai }        // 南海トラフ地震関連情報（VYSE50/51）
      | { kind: 'kohatsu'; data: JMAKohatsu }      // 後発地震注意情報（VYSE60）
    silent?: boolean                                // true のとき音・通知・読み上げを抑制（続報の連投で多重発火を避けたい場合等）
  }>
}
```

`public/data/test-scenarios/index.json` にメタ情報の一覧（`baseTime`・`entries` を除いたもの）を置く。

### シナリオ本体の扱い

- **`public/data/test-scenarios/*.json`（`index.json` を除く）は `.gitignore` 済み・コミット禁止**
- 理由: DMDATA.JP 利用規約第 15 条により、EEW の二次配信は個人契約では制限される
- GitHub Pages で公開されるため、EEW を含むシナリオをコミットすると規約違反のおそれ
- `index.json` は空配列 `[]` のテンプレートとしてのみ管理し、実データは各自のローカルに留める

### 再生ロジック（`src/utils/testScenarioReplay.ts`）

`instantiateScenario(scenario, now)` が「今」基準に時刻をシフトして返す:

1. **時刻シフト**: `now - baseTime` の差分を全時刻フィールド（`originTime`・`arrivalTime`・`validDateTime` 等）に一律加算
2. **ID 再採番**: `makeIdRemapper` で元 eventId → 新 ID の対応を作り、同じシナリオ内の続報は同じ新 ID にマップする（`\d{14}` 正規表現互換の 14 桁数字）
3. **再生**: 各エントリを `offsetMs` に応じて `eventQueue` に積む → `useEarthquakes.ts` が時刻順にディスパッチ

**時刻シフトの理由**: EEW P/S 波円計算・自動解除・津波 `validDateTime` は絶対時刻を見て動くため、
シフトしないと「もう過去のイベント」として即座にキャンセルされる。

**ID 再採番の理由**: 同じシナリオを連打すると `activeEEWs`（Map<eventId, EEWAlert>）等のキーが衝突するのを防ぐ。

### クロック全体をずらす方式は使わない

DMDATA リプレイ機能の `setReplayOffset` は使わない（ライブ接続を維持したまま追加投入する既存の合成テストボタンと同じ思想）。
時刻シフトはシナリオ内のイベントに対してのみ適用する。

### シナリオのキャプチャ（`scripts/capture-test-scenario.ts`）

- DMDATA archive API から実電文を取得
- パース済みの内部型として JSON に保存（生電文は保存しない）
- 南海トラフ・後発地震（VYSE50/51/60）の XML パースは `jsdom` でグローバル `DOMParser` を代替
- 要 DMDATA.JP API キー

**API キーの置き場所**: リポジトリ直下の `.env.local` に `DMDATA_API_KEY` を書けば、`npm run capture-scenario`
が起動時に読み込む（雛形は `.env.example`）。シェルの種類（PowerShell / Git Bash）を問わない。
優先順位は `--api-key` 引数 ＞ 実行時の環境変数 ＞ `.env.local` で、`--api-key` はコマンド履歴・プロセス一覧に
残るため常用しない。アプリ画面で使うキー（設定タブ入力・localStorage 保存）とは別物で、互いに影響しない。

`.env.local` は **BOM なし UTF-8** で保存する。BOM 付きだと変数名の先頭に BOM が混ざって別名の変数として
読まれ、キーが未設定として扱われる（BOM はエディタで不可視のため、その場合はキー未設定エラーに続けて
BOM の可能性を警告する）。PowerShell のリダイレクトや `Out-File` は BOM 付き（UTF-16 になることもある）で
書き出すため、`.env.example` をコピーして編集するのが確実。読み込みに `process.loadEnvFile()` を使うため
Node.js 20.12 以上が必要（満たさない場合はその旨を表示して停止する）。

### P2PQuake からシナリオを作る手順（DMDATA 契約なし）

1. P2PQuake API v2 `history` から対象電文を取得（認証不要）
2. `kind` と 14 桁 eventId を付与
3. `issue.type`・`issue.correct`・`earthquake.domesticTsunami` を日本語化（`convertEvent` と同じ変換）
4. `TestScenarioFile` に包む
5. `public/data/test-scenarios/<id>.json` に配置、`index.json` にメタを追加
6. 検証後: `index.json` を空配列に戻す（`git checkout -- public/data/test-scenarios/index.json`）＋ シナリオ本体を削除

### テスト時刻設定（強震モニタ）— バリアントで動きが変わる

> ここから先は §6 のシナリオ再生とは**別の機能**。設定タブの「テスト時刻設定（強震モニタ）」に
> 日時を入れて「確定」を押したときの話。同じボタンがバリアントによって別の動きをする。

| バリアント | 動き | 実装 |
|---|---|---|
| standard | アプリの時計をずらすだけ。Yahoo リアルタイム震度が過去の時刻から再生される | `setReplayTimeOffset` を直接呼ぶ |
| DMDSS | 上記に加えて、DMDATA アーカイブから当時の電文（地震・津波・EEW 等）を取得して流す | [`useReplayController`](../../src/hooks/useReplayController.ts) |

standard 版の詳細と既知の課題は [`data-sources-spec.md`](data-sources-spec.md) §7 を参照。
以下は **DMDSS 版のアーカイブ取得**についてのみ記す。

DMDSS 版は確定時に 2 つの範囲を同時に取りに行く。本書ではこう呼び分ける。

- **本編**: 指定時刻から 1 時間ぶん。これが再生される電文
- **初期状態**: 指定時刻から遡る 24 時間ぶん。「その時刻の時点で何が発表中だったか」を
  再現するために使う（すでに発表されていた津波警報など）。再生開始と同時にまとめて流し込む

#### アーカイブの構造

> 電文種別コード（VXSE53 等）の意味は [`data-sources-spec.md`](data-sources-spec.md) §2 の一覧を参照。

archive の目録（各アーカイブ内の `telegrams.json`）は、**同じ電文を XML 版と JSON 版の 2 エントリ**で
持つ。`originalId` を持つ方が JSON 版で、その値は元の XML エントリの `id` を指す。

読み取り側（`src/services/dmdataReplay.ts`）はこの性質を使って重複を除いている:

| 電文の種類 | 採用するエントリ | 理由 |
|---|---|---|
| 地震・津波・EEW・長周期（VXSE 系・VTSE 系） | JSON 版（`originalId` あり） | JSON パーサで読むため |
| 南海トラフ・後発地震（VYSE50/51/60） | XML 版（`originalId` なし） | XML パーサでしか読めないため |

採用しなかった側は正常な重複排除としてログ無しで捨てる。ここに警告を出すと、通常のリプレイ
1 回で数十件のログが出て本当の異常が埋もれる。

**確認できている範囲**:

- XML 版と JSON 版が半々で並ぶことを確認できたのは VXSE42/44/45/51/52/53。うち本実装が取り込むのは
  VXSE45/51/52/53 で、VXSE42（配信テスト）・VXSE44（廃止予定）は対象外の種別
- **VYSE 系（南海トラフ・後発地震）は未確認**。実測した期間のアーカイブに 1 件も無かった。表の
  2 行目は「他の全種別が同じ構造だったこと」からの推定で、実データでの裏付けはまだ無い

#### 取りこぼしの扱い

一部が壊れていても残りは再生できることを優先し、失敗の範囲を最小単位に閉じ込める:

- **電文 1 通の異常**（本体が目録に載っているのに見つからない・本体 JSON/XML の破損・パース失敗、目録エントリ自体の欠損や時刻不正）→ その 1 通だけ捨ててログに残す
- **アーカイブ 1 つが読めない**（目録の欠損・破損、tar/gzip の異常、取得エラー）→ そのアーカイブだけ諦め、他のアーカイブからの取り込みは続ける
- **全アーカイブが読めない** → 例外にする（認証エラー等、共通原因のことがほとんどで、握り潰すと「成功したが電文 0 件」にしか見えないため）

捨てた件数は設定タブに赤字で出す。黙って減った電文は「そういう時間帯だった」と区別が付かず、
テスト結果の誤読につながるため、1 件でも取りこぼせば知らせる。1 通ごとの詳細（どの電文が
なぜ読めなかったか）はコンソールに残す。

数え方には 2 つ約束がある。

- **アーカイブ単位と電文単位は分けて数える**。アーカイブが丸ごと読めなかった場合、その中に
  電文が何通あったかは分からないため、電文数に合算できない
- **アーカイブは URL で数える**。本編と初期状態は日付範囲が重なり同じアーカイブを読むため、
  件数で合算すると 1 件の障害が 2 件に見える

取りこぼしの表示は、再生を止めるまで消えない。一度失われた電文は後続の取得が成功しても
戻らないため、成功で上書きして消してはいけない。

行のラベルは状況で変える。再生が始まっていれば「再生中の警告」、始まっていなければ
「取得失敗」。再生が続いているのに「取得失敗」と出ると、本文の「再生は継続中」と矛盾して
見えるため。

**既知の課題**:
- 電文本体の特定に `id` の先頭 7 文字の部分一致を使っており、誤マッチの可能性がある。目録の各
  エントリは `filename` フィールドを持つように見えるため（2026-08-15 に実アーカイブを直接開いて
  確認したが、`ManifestEntry` 型には未宣言でコードからは一切参照していない）、そちらを使えば
  部分一致検索そのものが不要になる。**採用前に改めて実データで裏を取ること**（未対応）

## 7. 合成テストデータ（`src/utils/testData.ts`）

各テストボタンで生成する合成イベントの実装。本節が単一情報源（CLAUDE.md「コード整合性チェック
ポイント」表からこの節がリンクされる側）。

> **震度値の制約**: 震度値（`scaleFrom` / `scaleTo` / `maxScale` 等）には `src/utils/intensity.ts` の
> `INTENSITY_LABELS` が持つ値（`-1`/`10`/`20`/`30`/`40`/`45`/`50`/`55`/`60`/`70`）だけを使う。
> 中間値（`25` 等）を書くと `getIntensityLabel()` が「不明」・`getIntensityColor()` が灰色を返し、
> 震度表示と地図の区域塗りが同時に壊れる。
> これらのフィールドは `IntensityScale` 型（`src/types/earthquake.ts`）で宣言してあるため、
> **手書きの中間値は `tsc` が弾く**。震度未確定は `-1` で表す
> （EEW のレベル判定での扱いは [`eew-spec.md`](eew-spec.md) §4）。
> 3 つのデータ経路はいずれも上記の値しか生成しない — DMDATA は `dmdataParser.ts` の
> `parseIntensityStr()`、Yahoo は `kyoshin.ts` の `calcintensityToScale()`、
> P2PQuake は `p2pquake.ts` の `convertEvent()`（詳細は
> [`data-sources-spec.md`](data-sources-spec.md) §3）。
> それでも型検査が届かない経路（実地震シナリオ JSON など）は残るため、EEW では
> 実行時にも不正値を弾いている（詳細は [`eew-spec.md`](eew-spec.md) §4）。

| ボタン | 実装関数 | 最大 scaleTo | 生成イベント |
|---|---|---|---|
| EEW 特別警報テスト | `createTestEEW()` | 60 | 震度 6 強・特別警報（三陸沖 M7.2）※長周期地震動階級 4 |
| EEW 警報テスト | `createTestEEWWarning()` | 50 | 震度 5 強相当・警報（日向灘 M6.5） |
| EEW 予報テスト | `createTestEEWForecast()` | 20 | 震度 2 程度・予報（宮城県沖 M4.5） |
| EEW 誤報取消テスト | `createTestEEWWarning()` + `EEW_RETRACTION_CANCEL_MS`(10s) 後に取消 | 50→取消 | 10 秒後に `cancelled:true` 電文で `eewCancel` 音・通知・読み上げを検証 |
| 地震テスト | `createTestEarthquake()` | - | 令和 6 年能登半島地震の実データベース（`src/data/noto-honshin-2024-*.json`）を採用 |
| 遠地地震テスト | `createTestForeignQuake(includeForecastText)` | - | メキシコ・チアパス州沿岸 M7.4（2026-07-17）の実電文ベース。深さ不明・付加文 `0226`＋`0230` の報を採り、「深さ句の省略」「付加文原文の読み上げ」「`0230` 由来の津波区分（`domesticTsunami: 'なし'`）」を一度に確認できる。付加文は DMDATA 経由でのみ配信されるため、呼び出し側は `isDmdss` を渡して DMDSS 版でのみ `forecastText` を注入する |
| 大津波警報テスト | `createTestTsunami()` | - | 大津波警報（無引数で MajorWarning） |
| 津波警報テスト | `createTestTsunamiWarning()` | - | 津波警報 |
| 津波注意報テスト | `createTestTsunamiWatch()` | - | 津波注意報 |
| 津波予報テスト | `createTestTsunamiForecast()` | - | 津波予報（`TEST_AUTO_DISMISS_MS`=90 秒後に `expired` 経路で解除） |
| 津波誤報取消テスト | `createTestTsunamiRetraction()` + 90 秒後に取消電文 | - | 警報・注意報混在の発表 → 90 秒後に電文全体が取り消される（`retracted` 経路） |
| 南海トラフ臨時情報テスト 3 種（DMDSS 版のみ） | `createTestNankai('調査中'／'巨大地震注意'／'巨大地震警戒')` | - | バナー表示 + `specialInfo` 音。バナー消去ボタンは無く、再テストで上書きされる |
| 後発地震テスト（DMDSS 版のみ） | `createTestKohatsu()` | - | 北海道・三陸沖後発地震注意情報のバナー表示 + `specialInfo` 音 |
| 通知テスト | `App.tsx` の `onTest.notification`（インライン。`testData.ts` には無い） | - | 通知許可が必要（未許可なら案内ダイアログを出して送信しない）。許可状況は「通知設定」の「通知許可」行で確認できる |

> 強震モニタの揺れ検知には**テスト発報ボタンが無い**（`TestFunctions` に該当関数を持たない）。
> 揺れ検知の通知音だけは「通知音テスト」で試聴でき、検知そのものの動作確認は
> 「テスト時刻設定（強震モニタ）」で過去の地震を再生して行う（→ §6「テスト時刻設定（強震モニタ）」）。

「10 秒以内に再クリックで続報」「押さなければ自動確定」（`EEW_FINAL_SILENCE_MS`=10 秒）等の
ロジックは `useEarthquakes.ts` の `runSimulateEEW` 系で実装。

### 通知音の対応

- `eewSpecial` — EEW 特別警報テスト
- `eew` — EEW 警報テスト
- `eewForecast` — EEW 予報テスト
- `eewCancel` — EEW 誤報取消テスト（10 秒後の取消電文で発火）
- `eewUpdate` — 続報時（`isNew:false`）
- `eewFinal` — 最終報（無音の自動消去ではなく明示的な最終報用）
- `tsunamiMajor` — 大津波警報テスト
- `tsunami` — 津波警報テスト
- `tsunamiWatch` — 津波注意報テスト
- `tsunamiForecast` — 津波予報テスト
- `tsunamiCancel` — 津波系テストボタン全て（大津波警報／警報／注意報／予報／誤報取消）で共通発火。`TEST_AUTO_DISMISS_MS`（90 秒）後の `expired`／`lifted`／`retracted` いずれの cancelReason でも同じ音を鳴らす
- `earthquake` / `earthquakePrompt` / `earthquakeInfo` — 地震テスト（各地の震度／震度速報／震源情報・遠地地震）
- `kyoshin` / `kyoshinCandidate` — テストボタンからは発火しない。実運用の揺れ検知（確定時・別地点での検知時／候補検知時。`useKyoshinAlerts.ts`）で鳴る音で、「通知音テスト」の「揺れ検知（初回）」「揺れ検知（候補）」から試聴のみできる

### 自動解除・自動確定のタイミング

- **EEW 誤報取消**: `EEW_RETRACTION_CANCEL_MS`（10 秒）後に明示取消電文が届き、カードに「誤報として取り消されました」を 10 秒表示 → 消去
- **EEW 続報の受付**: `EEW_FINAL_SILENCE_MS`（10 秒）以内に再度テストボタンを押すと続報として発報。押さなければ `isFinal:true` として自動確定 → 無音消去
- **津波予報の期限切れ**: `TEST_AUTO_DISMISS_MS`（90 秒）で `validDateTime` に到達し `expired` 経路で解除
- **津波誤報取消**: `TEST_AUTO_DISMISS_MS`（90 秒）後に取消電文が届き `retracted` 経路で 10 秒間「取消」表示

### DOM 検証テクニック（動作確認用）

Playwright / Chrome DevTools でボタン発火後の DOM 状態を確認したいときの主要な取り出し方
（`window.__mapGL` の基本操作と v6 での注意点は [`map-rendering-spec.md`](map-rendering-spec.md) §11 も参照）:

- **地図の震度バッジ集計**: 震度バッジ（区域ラベル・地震観測点・長周期区域・強震モニタ揺れ検知点）は 2026-08-10 の統一で全て symbol レイヤー（`icon-image`）に移行済み。これらは `.maplibregl-marker` に現れないため、集計は GeoJSON ソースから行う:
  - 例: `await window.__mapGL.getSource('quake-region-label').getData()` で震度区域ラベルの `features[].properties.scale` を集計できる
  - ソース ID・レイヤー ID は各 `src/components/Map/*GL.tsx` の冒頭で定数（例: `SRC`／`FILL_SRC`／`LABEL_SRC`／`LABEL_LYR` など）として定義されているので、そこから逆引きする（実装変更で名前が変わる可能性があるため、ここに全リストは掲載しない）
  - 可視レイヤーに絞って集計したい場合は `window.__mapGL.queryRenderedFeatures({ layers: ['<レイヤーID>'] })` を使う
- **HTML Marker 経由の要素**: 震源×印（`EpicenterGL`）・EEW 震源（`EewEpicentersGL`）・津波の観測バー（`TsunamiObsBarsGL`）は現在も `maplibregl.Marker` のまま。これらだけは `document.querySelectorAll('.maplibregl-marker')` で拾える（震度バッジは含まれない）
- **地図ソースの内容**: `await window.__mapGL.getSource('<sourceId>').getData()` で GeoJSON を取り出せる（本番ビルドでも `window.__mapGL` は露出。`src/components/Map/JapanMapGL.tsx`）
- **レイヤーの表示状態**: `window.__mapGL.getLayoutProperty('<layerId>', 'visibility')`
- **時間経過を伴う挙動の再現**: 自動解除・アイドル復帰・続報自動確定は `localStorage` の書き換え＋リロード、または `setTimeout` の時間送りで確認する

## 8. 定期自動リロード

キオスク運用（ディスプレイに常設）向けに、N 時間ごとに **毎日午前 5 時基準**でページ全体をリロードする機能。
`useSettings.ts` の `periodicReloadHours` で設定。**デフォルトは `1`（毎日午前 5 時にリロード）**。`0` で無効化。

## 9. ホーム地点

ユーザーの現在地の緯度経度を設定できる。設定すると:
- 震度観測点をクリックしたときのポップアップにホーム地点からの距離を表示
- ヒートマップの中心表示に使用

## 10. バージョン表示

`__APP_VERSION__` はビルド時に `vite.config.ts` の `define` が `package.json` の `version` から注入する定数。
`SettingsTab` の下部に表示される。

**注意**: dev サーバーは `package.json` の `version` を変更したあと**再起動しないと反映されない**（HMR では拾えない）。

## 11. 関連実装ファイル

- `src/components/SettingsTab/index.tsx` — 設定 UI
- `src/hooks/useSettings.ts` — localStorage 読み書き
- `src/hooks/useTestScenarios.ts` — シナリオ一覧・再生管理
- `src/utils/testData.ts` — 合成テストデータ生成
- `src/utils/testScenarioReplay.ts` — 時刻シフト・ID 再採番
- `src/types/testScenario.ts` — シナリオデータ型
- `scripts/capture-test-scenario.ts` — シナリオキャプチャ CLI
- `vite.config.ts` — PWA・バリアント切替設定

## 12. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
- 2026-08-15: 地名ラベル用グリフ（`.pbf`）を precache 対象に追加し、1 ファイルの上限を明示（§5）。
  オフライン時にグリフだけ取得できず実行時フォント生成に落ちていた状態を解消。あわせて SW 更新の
  インストール中断を検知してログに残すようにし、その検知範囲の限界と、カウントダウンの延期条件を追記
- 2026-08-15: §6 に「テスト時刻設定（強震モニタ）」を追加。同名の UI が standard 版（時計をずらす
  だけ）と DMDSS 版（DMDATA アーカイブも取得）で別の動きをすることが、どの仕様書にも書かれて
  いなかったため明記した。あわせて DMDSS 版のアーカイブ取得について、目録が XML 版と JSON 版の
  2 エントリを持つ構造と、取りこぼしの扱い（封じ込めの範囲・数え方・UI 表示）を追記。
  解消済みだった「`EEW_TYPES` から `VXSE43` が抜けている」の記述を削除（実装は 68819f8 で修正済み）。
  なお XML/JSON の 2 エントリ構造は 3 日分のアーカイブを実測して確認したもので、VYSE 系のみ
  該当データが無く未確認
- 2026-08-15: 設定タブの並び順を統一（§2）。「通知音テスト」は EEW・津波を軽い順に並べる一方、
  「テスト機能」は重い順という逆基準になっており、さらに「テスト機能」内でも南海トラフだけ軽い順
  という二重基準だった。アプリ全体が昇順基調（震度セレクタ・震度スケール凡例・震度別の試聴ボタン）
  のため、テスト系も軽い順へ統一し、カテゴリの順序を「通知音テスト」「テスト機能」「通知設定」の
  種別トグルの 3 箇所で揃えた。あわせて表示と無関係な「定期自動リロード」を表示設定から新設の
  「動作設定」へ移し、地図レイヤーのトグルを 地形 → 地質構造 → 観測データ の順に並べ替えた
- 2026-08-15: 上記にあわせて §2・§7 の実装乖離を是正。§2 は実装に無い「全般設定」セクションと
  「表示件数」項目を載せ、「タブ自動切替設定」「ホーム地点」「震度スケール」の各セクションが
  未記載だったため書き直した。§7 はテストボタン表から実装に存在しない「揺れの候補テスト」
  「揺れ検知テスト」の 2 行を削除し（参照先の `runSimulateKyoshin*` は `src/` に存在しない）、
  記載が漏れていた南海トラフ臨時情報 3 種・後発地震・通知テストを追加した
- 2026-08-15: EEW テストデータが震度スケールに無い中間値を持っていたのを修正（§7）。予報テストの
  `scaleTo` が `25` だったため予想最大震度が「不明」と表示され、地図の区域塗りも灰色に落ちていた
  （`25 → 20`）。あわせて表示に現れていなかった `scaleFrom` の中間値 2 件も直した
  （予報テスト `15 → 10`・警報テスト `35 → 30`）。同じミスを繰り返さないよう、震度値に使える値の
  制約を §7 冒頭に明記した
- 2026-08-16: 上記の中間値混入を型で防げるようにした（§7 の注記を更新）。`EEWRegion.scaleFrom` /
  `scaleTo` が素の `number` 型だったため `tsc` をすり抜けていたので、`IntensityScale` 型に変更した。
  型検査が及ばない経路（standard 版の `as` キャスト・実地震シナリオ JSON）向けに、EEW では
  実行時にも不正値を弾くようにした（詳細は [`eew-spec.md`](eew-spec.md) §4）
- 2026-08-16: UI 倍率・地図アイコン倍率が効いていなかった箇所を塞いだ（§2）。UI 側は px 直書きのままだった
  文字・ナビのアイコンを rem に寄せ、地図側は地名ラベル・津波の観測バー・地震活動ヒートマップにも倍率を
  渡すようにした。あわせて §2 の説明を実際の適用範囲に合わせて書き直した（枠線・影・アウトラインは
  装飾のため従来どおり倍率に連動しない）。観測バーの角丸も同じ理由で据え置いており、その判断は
  `src/components/Map/gl/tsunamiObsBar.ts` のコメントに残した
- 2026-08-16: スマホ横・小型タブレット横でラベルが数文字幅まで潰れていたため、設定行を折り返せるようにして
  「行のレイアウト」を追記した（§2）。あわせて、行幅を超えていた地図データ出典の表記が
  末尾で切れていたのを折り返して収まるようにした
