# アーキテクチャ仕様書

> 本書は**現在の実装が何をどう組み立てているか**をまとめた仕様書。設計判断の経緯は
> 各機能仕様書の改訂履歴節や `docs/archive/` を参照。実コードと食い違う場合は実コードを正とする。

## 1. 概要

React 18 + TypeScript + Vite 6 で作られた PWA（Progressive Web App）。日本の地震情報・緊急地震速報（EEW）・
津波情報・リアルタイム震度をブラウザで表示する。地図は MapLibre GL JS（WebGL 描画）に統一されている。

**主要な設計原則**:
- 地図は常時表示、情報パネルをタブで切り替える（画面サイズにより左右分割 / 上下分割）
- 全ての時刻は「サーバー同期時刻（`serverNow`）」を基準にする（壁時計は信用しない）
- データソースはバリアントごとに切り替える（standard vs DMDSS）

## 2. データフロー（俯瞰）

> **地図モードの内部名について**: 本アプリの地図は 3 つのモード（`quake` = 地震情報タブ / `tsunami` = 津波情報タブ / `kyoshin` = リアルタイム震度タブ）で表示を切り替える。`kyoshin` は「強震モニタ由来のデータを描画するモード」という意味の内部名で、UI 上のタブ名（「リアルタイム」）とは表記が異なる点に注意。

```
[外部データソース]
  ├─ DMDATA.JP  (WebSocket + REST)       ← DMDSS 版
  ├─ P2PQuake   (WebSocket + REST)       ← 標準版
  └─ Yahoo 強震モニタ (HTTPS JSON 1Hz)   ← 両バリアント共通

        ↓ services 層（`src/services/`）
        ↓ パーサー・接続管理・電文 → 内部型変換

[アプリ状態]
  ├─ useEarthquakes  … 地震・EEW・津波・LPGM の統合状態
  ├─ useKyoshinRealtime … リアルタイム震度データ
  ├─ useKyoshinAlerts   … 揺れ検知結果（震源非依存）
  └─ useSettings        … ユーザー設定（localStorage 永続化）

        ↓ hooks 層（派生データを計算・購読）
        ↓ useEewLayerData / useTsunamiLayerData / useQuakeLayerData / usePsWaveCalc

[UI]
  ├─ App.tsx          … 全体レイアウト・イベント連動
  ├─ MapView          … 地図（4 タブ共通で常時表示）
  ├─ IconNav          … タブナビ（右端 or 最下部）
  └─ 各タブパネル     … EarthquakeTab / RealtimeTab / TsunamiTab / CatalogTab /
                        TelegramTab / SettingsTab

[副作用]
  ├─ 通知音（alertSound）
  ├─ ブラウザ通知
  ├─ ウィンドウタイトル変更（useAlertTitle）
  ├─ VOICEVOX 読み上げ（任意）
  └─ 自動タブ切替・カメラ自動フィット
```

### 副作用への入口（`onLiveEvent`）

受け取った電文を**音・読み上げ・自動タブ切替**へ流す口は `onLiveEvent` の 1 本だけ
（`useEarthquakes` が呼び、`useLiveEventHandler` の `handleLiveEvent` が受ける）。

**運ぶ電文は判別可能ユニオンで表す**（`LiveEvent = AppEvent | ExtraLiveEvent`）。`AppEvent`
（地震・津波・緊急地震速報）はカードや地図に載る状態そのもので、残る 6 種別（長周期地震動・
南海トラフ臨時情報・同関連解説情報・後発地震注意情報・地震回数・推計震度分布図）は状態を
別のフィールドで持っていて、この経路にだけ流れてくる。

- **型を潰して渡さない。** かつては後者の 6 種別を `as unknown as AppEvent` で渡し、受け手も
  `kind` を文字列として読み直していた。**種別ごとにしか無い項目を付け忘れても型検査が通る**
  ——推計震度分布図が運ぶ「初報か続報か」の印がその形で、落とすと続報が初報の文で読まれる
- **追加種別の処理は `handleExtraLiveEvent` へ置き、`handleLiveEvent` の入口で振り分ける。**
  振り分けたあとの `event` は `AppEvent` に絞られるので、以降の分岐が `kind` ガードを
  書き落とせば型検査が止まる
- **`handleExtraLiveEvent` の末尾は `never` で受ける。** 種別を足して分岐を書き忘れたときに
  止まるのはここだけ（入口の振り分けが見ているのは絞り込みで、網羅性ではない）
- **「地震・津波に関するお知らせ」は流さない**（→ §4「受信時にパネルを一時的に開く」）
- **受信側で下した判断は、電文とは別の引数で渡す**（`LiveEventMeta`）。いまあるのは 1 つだけで、
  「その地震情報を地震カードが採らない（据え置く）」という印。真なら受け取る側が音・読み上げ・
  ウィンドウタイトル・自動タブ切替を起こさない（→ [quake-spec.md](quake-spec.md) §6.3
  「据え置いた電文は、音・読み上げ・タイトル・タブ移動も起こさない」）。**電文の型へ混ぜない** ——
  あちらは画面に載る状態そのもので、電文を組み立てる側・収録データ・リプレイの復元まで
  この印を埋める羽目になる

各層の詳細は個別仕様書へ:
- 電文パース・接続 → [`data-sources-spec.md`](data-sources-spec.md)
- 地図描画 → [`map-rendering-spec.md`](map-rendering-spec.md)
- 音・タブ切替 → [`audio-tts-spec.md`](audio-tts-spec.md)
- 各情報の処理 → [`eew-spec.md`](eew-spec.md) / [`tsunami-spec.md`](tsunami-spec.md) / [`quake-spec.md`](quake-spec.md)

## 3. ビルドバリアント（standard / DMDSS）

**2 種類のビルドが同一リポジトリから生成される**。切り替えは環境変数 `VITE_VARIANT`。

| バリアント | dev 起動 | ビルド出力 | 配信パス | 主データソース |
|---|---|---|---|---|
| standard | `npm run dev` | `dist/` | `/realtime-earthquake-viewer/` | P2PQuake + Yahoo |
| DMDSS | `npm run dev:dmdss` | `dist-dmdss/` | `/realtime-earthquake-viewer/dmdss/` | DMDATA + Yahoo |

`vite.config.ts` の `define`・`base`・`build.outDir`・`manifest.name` が `VITE_VARIANT` によって切り替わる。
コード側は `src/utils/env.ts` に定義された `isDmdss`（単一情報源）を各ファイルから import して参照する。

**バリアント別に有効な機能マトリクス**:

| 機能 | standard | DMDSS |
|---|---|---|
| 地震情報のリアルタイム受信 | ○（P2PQuake WS） | ○（DMDATA WS） |
| 緊急地震速報（EEW） | ○（P2PQuake + Yahoo） | ○（DMDATA のみ） |
| 津波情報 | ○（P2PQuake） | ○（DMDATA） |
| リアルタイム震度 | ○（Yahoo 共通） | ○（Yahoo 共通） |
| 揺れ検知エンジン | ○ | ○ |
| 長周期地震動階級（実データ） | × | ○ |
| 津波の cancelReason 出し分け | × | ○ |
| 詳細報での区域＋観測点同時表示 | ×（観測点のみ） | ○ |
| 南海トラフ・後発地震情報 | × | ○ |
| 電文ログ（TelegramTab） | ×（UI は表示・常に空） | ○ |
| 震源カタログ（CatalogTab） | ○ | ○ |
| 実地震テスト再生 | ○ | ○ |
| VOICEVOX 読み上げ | ○ | ○ |
| ヒートマップ | ○ | ○ |

上の表で Yahoo が現れる 2 行は用途が違う。リアルタイム震度は両バリアントとも Yahoo を使うが、
EEW に Yahoo を使うのは standard 版だけで、DMDSS 版の EEW は DMDATA だけを見る
（詳細は [`eew-spec.md`](eew-spec.md) §3）。本節冒頭のバリアント表で DMDSS の主データソースを
「DMDATA + Yahoo」と書いているのは、この強震モニタぶんを含めた総体を指す。

**GitHub Pages デプロイ**: `.github/workflows/deploy.yml` が `main` へ push されるたびに、まずユニットテスト
（`npm test`）を実行し、通ってから両バリアントをビルドして `dist-dmdss/` の内容を `dist/dmdss/` にマージし、
公開する。テストが失敗した時点でジョブが止まるので、公開中の内容は差し替わらない。Service Worker の
スコープは配信パスで自然に分離されるため、独立した PWA として動作する。

## 4. 主要コンポーネント

### App.tsx（レイアウトの中枢）

- 地図（`MapView` 経由で `JapanMapGL`）を常時表示し、情報パネルをタブで切り替える
- `IconNav` から `mapTab` を切り替え。`mapTab === 'realtime'` は kyoshin モード
- 各種フック（`useEarthquakes` / `useKyoshinRealtime` / `useKyoshinAlerts` / `useKyoshinDetectorV2` /
  `usePsWaveCalc` / `useLiveEventHandler` / `useAlertTitle`）を配線する
- 通知音・ブラウザ通知・自動タブ切替・カメラ自動フィット・VOICEVOX 読み上げ・EEW 状態管理などの制御をここで行う

App が直接持つのは「1 秒毎更新」（強震モニタ・`kyoshinIndices`）系の state だけで、「100ms 更新」の psWave は
`usePsWaveCalc` フック内部で `setInterval` が回る。App はこれらの state を子コンポーネントに配る。
過剰な再レンダーが伝播しないよう、下位で `useMemo`・`React.memo` を活用する
（詳細は [`map-rendering-spec.md`](map-rendering-spec.md) 参照）。

### 画面サイズ別のレイアウト

地図と情報パネルの並べ方は、画面の幅だけでなく**向きと高さ**で決まる。幅だけで判定すると、
スマートフォンの横画面（例 844×390）が「幅は足りないが高さが極端に低い」状態になり、
上下に積んだパネルが画面高を占有して地図が見えなくなるため。

判定に使うブレークポイントは `tailwind.config.js` の `theme.extend.screens` が単一情報源:

| 名前 | 条件 | 効果 |
|---|---|---|
| `side` | 幅 1024px 以上、または 横向きかつ高さ 600px 以下 | 地図とパネルを**左右分割**（PC・タブレット横・スマホ横） |
| `sideNarrow` | 横向き・高さ 600px 以下・幅 1023px 以下 | 左右分割のうち狭い画面。パネル幅を絞る（`w-panel-narrow`＝22rem。PC は `w-panel`＝26rem） |
| `roomy` | 幅 640px 以上 **かつ** 高さ 601px 以上 | カードの文字・余白をゆったり表示。**未満は圧縮表示**になる |

パネル幅の実体は `tailwind.config.js` の `theme.extend.width`（`panel` / `panel-narrow`）で、
いずれも `min(22rem または 26rem, calc(100dvw - 4rem))` の形をとる
（単位が `vw` ではなく `dvw` である理由は本節の「画面いっぱいへの広がりとセーフエリア」規則 3 を参照）。

基準幅を rem で書いているのは、UI 倍率設定（`uiScale`）がルートの `font-size` を変えるため。
既定の倍率 100% では 22rem＝352px / 26rem＝416px になり、倍率を上げれば同じ比率で広くなる。
`min()` で画面幅からの上限を掛けているのは、左右分割の下限幅（1024px）が CSS ピクセルで固定
されているのに対し、パネルもアイコンナビも rem で伸びるため。上限が無いと高倍率でパネルが
画面幅を食い尽くし、右端のアイコンナビが画面外へ押し出される。差し引く 4rem は、アイコンナビの
実測幅（約 3.5rem）に余白を見込んだ値。

パネル内の各タブは**縦スクロールのみ**行う。`overflow-y` だけを `auto` にすると CSS 仕様で
`overflow-x` も `auto` に格上げされ、中身が数 px はみ出しただけで指で左右に動いてしまうため、
`App.tsx` の `TAB_SCROLLER_CLASS` で横方向を明示的に塞いでいる。パネルが最も狭くなる
`sideNarrow`（既定 22rem）で顕在化するので、`EarthquakeTab/EarthquakeCard.tsx` の一覧カードでは
幅を押し広げないよう、長い震源地名を 1 行に固定し、収まらない分は末尾を省略している。これは
本文カラム側の `min-w-0` と地名側の `truncate` の組み合わせで成立する。flex アイテムの既定
`min-width: auto` を解除しないと、地名は縮まずカードを押し広げてしまう。
なお `overflow` は要素ごとに独立して決まり、祖先の指定は子に効かない。タブや地図上のバナーが
**自前の `overflow-y-auto`** を持つ場合は、それが今スクロール領域として働いているかに関わらず、
その要素にも同じ指定を置く（高さの制約は後の変更で付くことがあり、付いた瞬間に穴になるため）。

`side` 未満（スマホ縦・タブレット縦）は**縦積み**（地図が上・パネルが下）になり、次の 2 つが加わる:

- **パネル高さの可変**: 地図とパネルの境界に `PanelResizeHandle` を置き、ドラッグで比率を
  20〜80% の範囲で変更できる。比率は設定 `panelRatio` として保存され、CSS 変数 `--panel-ratio`
  経由でパネルの高さ（`calc(var(--panel-ratio) * 100%)`）に反映される。
- **折りたたみ**: つまみのタップ、または表示中タブのアイコン再押下でパネルを畳み、地図を全画面にする
  （左右分割時は幅が 0 になる）。折りたたみ状態は**保存しない**。起動直後に情報が見えない状態を
  作らないため、リロードすると必ず展開に戻る。加えて、タブが切り替わったとき、および
  EEW 発報・津波発表・揺れ検知が立ち上がったときは自動的に展開する。

`roomy` 未満での圧縮は各カード側で `roomy:` プレフィックス付きのクラスとして表現する
（モバイルファースト。既定＝圧縮値、`roomy:` で従来の寸法に戻す）。適用先:

| ファイル | 圧縮する箇所 |
|---|---|
| `EarthquakeTab/EarthquakeCard.tsx` | 選択カードの最大震度・長周期・日時・震源名・M/深さ・各地の震度行 |
| `EarthquakeTab/index.tsx` | カード一覧の外枠（余白のみ） |
| `RealtimeTab/index.tsx` | EEW カード各部・揺れ検知カード・S 波カウントダウンの余白・タブ外枠 |
| `TsunamiTab/index.tsx` | 予報区ヘッダー・区域行・観測点行・サマリーバナー・タブ外枠 |
| `MapUpdateTime.tsx` | 地図左上の更新時刻 |
| `MapDataStatus.tsx` | 地図左上の生成データ取得状況 |

圧縮の対象は**各カードの主要な見出し・数値と余白**で、次のものは意図的に対象外にしている:

- 注記・補足のようにもともと小さい文字（11〜14px 前後）。狭い画面ほど読めなくなるため
- 「キャンセル」など全画面オーバーレイの強調表示（`EarthquakeCard` / EEW カード / 津波カード）。
  目立たせること自体が目的のため
- 津波の観測高さや S 波カウントダウンの秒数のように、小さくすると読み取りを誤りうる数値

そのため各カードにインラインの `fontSize` 指定が残っているが、上記に当てはまるものは変換漏れではない。

### 画面いっぱいへの広がりとセーフエリア

iPhone・iPad で画面端の見え方が崩れたときは、まずこの節を読む。
この領域は過去に何度も継ぎ足しで直されているため、
**個別に対処せず、下記 4 つの規則に沿っているかを先に確かめること。**

**規則 1: 高さを決めるのはルート要素だけ**

ルート要素（`App.tsx`）が `h-dvh`（`100dvh`）を持ち、その内側は flex で分配する。
`dvh` はブラウザ UI の出入りに追従するため、iOS Safari でツールバーが出ている間も
アイコンナビが画面外へ押し出されない。

**規則 2: セーフエリアは端に接する要素が各自で避ける**

`body` にまとめて余白を入れてはならない。`box-sizing: border-box` の下では `#root` の高さが
そのぶん縮み、アイコンナビが下端で切れる（初期実装でこれを踏んでいる）。

画面端に置くものが、その端のセーフエリア（ノッチ・ホームインジケータ・ステータスバー）を
自分で避ける。地図は背景なので端まで広げてよいが、操作する要素と読ませる文字は重ねない。
端に接するのは次の 3 つだけで、残りはすべてパネルの内側にあるため対応は要らない。

| 要素 | 避ける端 |
|---|---|
| `IconNav` | 下・右（上は避けない。理由は規則 4） |
| 地図左上のラッパー（`App.tsx`。`MapUpdateTime` と `MapDataStatus` を包む） | 上・左 |
| `SpecialInfoBanner`（南海トラフ臨時情報・同 関連解説情報・後発地震のバナー。並び順は本節後半） | 下。**左右分割時のみ**（縦積み時は地図の下につまみ・パネル・ナビが続き、画面下端には届かない） |

`env(safe-area-inset-*)` は要素が画面のどこにあるかに関わらず値を返すため、「左右分割のときだけ」と
いう条件はブレークポイント（`side:`）側で表現する。無条件に入れると、その端に接していない
レイアウトで不要な余白が生まれる。

避けるべきなのは**押せる領域と読ませる文字**であって、背景色ではない。余白は色の付いた要素の
**内側**に入れること。外側のラッパーに入れると色ごと持ち上がり、その下に地図が覗いて隙間に見える。
`SpecialInfoBanner` は 5 枚が同時に出うるため、余白を持つのは**下端に接する最後の 1 枚だけ**
（上に来る帯にも入れると帯と帯の間に隙間ができる）。判定は `:last-child`（`side:last:` ユーティリティ）
に任せており、枚数が増えても JS 側で並び順を数える必要はない。

5 枚は**同じ事象の情報が隣り合う順**に並べる。上から次のとおり。

| 帯 | 色 | 消え方 |
|---|---|---|
| 南海トラフ臨時情報（段階） | 黄／橙／赤（段階の重さ） | 調査終了・取消の電文で消える |
| 南海トラフ関連解説情報 | teal（段階を示さない色。本アプリ独自の配色で、気象庁の警戒レベル配色ではない） | 発表から 7 日で失効。取消電文でも消える。**閉じるボタンでも消せる** |
| 北海道・三陸沖後発地震注意情報 | 青 | 発表から 7 日で失効 |
| 地震回数に関する情報 | cyan（青緑） | 発表から 7 日で失効。取消電文でも消える。**閉じるボタンでも消せる** |
| 地震・津波に関するお知らせ | slate（無彩色） | 発表から 7 日で失効。取消電文でも消える。**閉じるボタンでも消せる** |

**重さの順ではなく、事象ごとにまとめる順を採っている。** 情報の重さで並べれば後発地震注意情報が
解説情報より上に来るが、臨時情報の発表期間中は解説情報が毎日届いて南海トラフの 2 枚が同時に
出るため、間に別の事象（北海道・三陸沖）が挟まると同じ事象の話が分断されて読みにくい。

**お知らせが最後なのは、上の 4 枚と話が違うから。** 上の 4 枚は「いま起きている・起こりうる地震」の
話で、お知らせは観測点の入電停止・配信試験といった**運用連絡**（中身は
[data-sources-spec.md](data-sources-spec.md) §2「扱う電文種別」）。同時に出たときに事象の話を
先に読ませる。色を無彩色にしているのも同じ理由で、他の 4 枚のどれとも警戒度を取り違えられない
ようにしている。

**地震回数だけは畳んだ見出しを自分で組む。** 他の 4 枚は電文の `Head/Headline/Text` をそのまま
出せばよいが、この電文の見出しは「地震回数に関する情報をお知らせします。」という定型文で、
畳んだままでは何も伝わらない。累積の区間から「9/9 04時から 1,704回（うち有感 1回）」を組む
（`earthquakeCountHeadline`）。**開いたときの中身も表**なので、本文が自由文ひとつきりの
`EarthquakeInfoDetail` は通らず、専用の `EarthquakeCountDetail` を持つ。

解説情報・地震回数・お知らせが閉じるボタンを持つのは、いずれも平常時や長い期間にわたって届く
電文だから（読み終えた帯を手で片付けられるようにしている。発表頻度は
[data-sources-spec.md](data-sources-spec.md) §2）。閉じた電文の id は `localStorage` に残すので
リロードでも復活しない。新しい電文が届けば id が変わるため、そちらは表示される。
**取消電文があっても閉じるボタンは要る** —— お知らせの「入電停止は明日の 8 時から」のような
予告は取り消されないまま期間が過ぎるし、地震回数は群発が収まれば発表が止まるだけで、
終わりの宣言が来ない。

**突き合わせる前に id の書式を揃える**（`normalizeDmdataTelegramId`）。電文 id はアプリが
組み立てる文字列で、書式を変えると**更新前に保存された値と一致しなくなる**——揃えずに素で
比べると、更新をまたいだ利用者に閉じたはずの帯がもう一度出る。id の書式を変えるときは
この関数も併せて見ること。

**規則 3: ビューポート単位は `dvh` / `dvw` を使う**

`vh` は iOS のホーム画面から起動した PWA だと**ビューポートではなく画面全体**の高さを返す
（実測: `100vh`＝874px に対しビューポートは 812px）。レイアウトの寸法計算に使うと数 % ずれるため
`dvh` を使う。`dvw` については**幅方向で同じずれは観測されていない**（実測でも画面幅とビューポート幅は
一致した）が、規則を「ビューポート単位は d 付きを使う」の一本にするため揃えている。
適用箇所は `App.tsx` のルート、`SpecialInfoBanner` の最大高、`tailwind.config.js` のパネル幅の 3 つ。

**規則 4: ステータスバーは `black`（不透明）にする**

`index.html` の `apple-mobile-web-app-status-bar-style` は `black` を使い、
**`black-translucent` にしてはならない。**

`black-translucent` にすると、iOS のホーム画面から起動した PWA で
**ビューポートの高さだけが上端セーフエリア分（iPhone 17 Pro 実測 62pt）縮むのに、
原点は画面最上端に置かれたまま**になる。ページの中身は画面下端に届かず、そこには
`body` の背景色だけが露出した帯が残る。この帯にはページから何も描けない
（`100vh` や `100lvh` で要素を伸ばしてもレイアウトが伸びるだけで描画は打ち切られる）。

`black` にすると縮んだビューポートが正しい位置に置かれ、帯は消える。
代償として画面上端にステータスバー分の不透明な帯が入り、地図がノッチの下まで回り込まなくなる。
**この見た目は意図的なもので、透過に戻すと下端の帯が再発する。**

発生するのは**ステータスバーが出ている**ときだけで、向きそのものは条件ではない。
iPhone は横向きだとステータスバーが隠れるため起きないが、iPad は縦横どちらでも出るため起きる。

帯が見える位置は、そのとき画面下端に接している要素の下。
どの要素が接するかはレイアウト（`side` ブレークポイント。上記「画面サイズ別のレイアウト」参照）で決まり、
向きとは一致しない点に注意する（iPad Pro 11 の縦は縦積み、13 インチの縦は左右分割になる）。

- 縦積み … `IconNav` の下に帯が出る
- 左右分割 … 地図と `SpecialInfoBanner` の下に帯が出る（バナーが浮いて見える）

**既にホーム画面へ追加済みの PWA には、この meta の変更が届かない。**
iOS はステータスバーの見た目を追加時に固定しており、ページを再読み込みしても切り替わらない
（同一ページで meta だけを差し替えて実測・確認済み）。修正版を配信しても症状が続く場合は、
**アイコンを一度削除して追加し直す**必要がある。

**判定手順（iOS の PWA で端の見え方が怪しいとき）**

ブラウザの開発者ツールでは再現しない。**ホーム画面に追加した状態**で次の 4 つを確認する。
シミュレータでも再現するため実機は必須ではない（iOS 26.2 / iPhone 17 Pro・iPad Pro で確認）。

1. `screen.height` … 画面の高さ
2. `document.documentElement.clientHeight` … ビューポートの高さ
3. `env(safe-area-inset-top)` … 高さ 0 の要素に流し込んで `getBoundingClientRect().height` で読む
4. 画面最下端のピクセル色 … スクリーンショットから採る

1 と 2 が食い違い、その差が 3 と一致し、4 が `bg-app`（`#0a0c10`）なら本節の不具合。
2 と 4 が想定どおりなら別の原因を探すこと。

#### 受信時にパネルを一時的に開く

5 枚はいずれも**タブを持たない**（帯で伝える情報なので、切り替える先が無い）。そのため受信時に
自動タブ切替は起きないが、代わりに**パネルを一時的に開く**。パネルを畳んで地図を全画面で見て
いると、視線が地図に向いていない限り帯に気づけないため。

**ただし「地震・津波に関するお知らせ」（いちばん下の 1 枚）だけは開かない。** 観測点の入電停止・配信試験と
いった運用連絡で、いま起きている地震の話ではない。音も読み上げも起こさないと決めたのと同じ
理由で、画面を組み替えてまで割り込ませるものではない（帯は 7 日残るので、次にパネルを触った
ときに読める）。実装上も**この種別だけ `onLiveEvent` へ流していない** ——
`expandPanelForSpecialInfo` を呼ぶ経路がそこにしか無いため、流さないことがそのまま
「開かない」を意味する（→ [data-sources-spec.md](data-sources-spec.md) §2「扱う電文種別」）。

元の状態は覚えておき、次のどちらかで戻す。

- **ユーザーが何か操作したとき**（クリック・キー入力・ホイール・タッチ移動）。気づいた合図が
  あれば一時的な展開の役目は終わり。帯の閉じるボタンを押した場合もクリックとして拾える
- **アイドル復帰したとき**。既定の状態へ戻す操作なので、パネルの畳みも元へ戻すのが筋

自動タブ切替が起きた場合は**畳まない**（移動先を見せるための展開を打ち消してしまう）。ただし
**元の状態の記録は捨てない**。捨てると畳んだ状態へ戻す機会が二度と来ないため（実際に
「畳んで地図を見ている最中に特別情報 → 揺れ検知で自動移動」の順で踏むと、以後どうやっても
畳めなくなっていた）。

自動タブ切替そのものの規則は [audio-tts-spec.md](audio-tts-spec.md) §6 が単一情報源。

### タブコンポーネントの再レンダー抑制

`EarthquakeTab` / `RealtimeTab` / `TsunamiTab` / `CatalogTab` / `TelegramTab` / `SettingsTab` と `IconNav` は
すべて `React.memo` でラップされている。App が psWave の 100ms 更新や kyoshin の 1Hz 更新で
再レンダーするたびに、非表示中のタブ（`invisible` で DOM ツリーは維持）まで reconciliation を
受けないようにするため。

memo を効かせるには props が参照安定である必要があるため、以下を実施している:
- App の inline 関数 props（`toggleLpgmFromEarthquake` / `linkTsunamiToEarthquake` / `handleTabChange` 等）は
  `useCallback` で参照を安定化
- `setActiveTabNonRealtime` / `setActiveTabRealtimeOnUpdate` も `useCallback` 化
- `filteredEarthquakes = earthquakes.filter(...)` は `useMemo` で包む（`Array.filter` は毎回新規配列を
  返すため、包まないと `EarthquakeTab` / `TsunamiTab` の memo が破られる）
- `SettingsTab.onTest` は多数のテスト関数をまとめたオブジェクトなので `useMemo` で安定化
- `useSettings.updateSetting` は `useCallback`、`useTestScenarios` の戻り値オブジェクトは `useMemo` で参照安定化

実測（Playwright + 一時的な render counter）: EEW 特別警報テストで発報中 5 秒間、非表示の
`EarthquakeTab` / `TsunamiTab` / `SettingsTab` はいずれも 0 回レンダー（memo 適用前は SettingsTab で
120 回、`filteredEarthquakes` メモ化前は EarthquakeTab / TsunamiTab も同等以上）。usePsWaveCalc の
100ms 更新と kyoshin 1Hz 更新による親再レンダーの連鎖は非表示タブに届かず、実質的な CPU 負荷を大幅に
削減する。

### MapView / JapanMapGL

`MapView` は App と地図実装（`JapanMapGL`）の間の薄いラッパー。`JapanMapGL` が MapLibre GL の中枢で、
地図の初期化・スタイル・全レイヤー配線・モード（`quake` / `tsunami` / `kyoshin`）別の表示制御を行う。

各レイヤーは独立したコンポーネント（`*GL.tsx`）として実装され、`mapGLContext` から map インスタンスを取得する。
描画順は `src/components/Map/gl/layerOrder.ts` の `MAP_LAYER_ORDER` が単一情報源。

### IconNav（タブナビ）

`ITEMS` 配列で 5 タブを定義（実装順: `earthquake` / `realtime` / `tsunami` / `settings` / `telegrams`）。
どのタブも標準版・DMDSS 版で常時表示される（`telegrams` は standard 版では常に空だが、UI は表示）。
配置は左右分割時が右端の縦並び、縦積み時が最下部の横並び。

**表示中のタブをもう一度押すとパネルの折りたたみをトグルする**（タブ切替は起きない）。畳んでいる間は
そのタブのボタンの塗りが弱くなり、`aria-expanded` が `false` になる。

### 各タブパネル

| タブ | ファイル | 内容 |
|---|---|---|
| EarthquakeTab | `src/components/EarthquakeTab/` | 地震情報カード一覧・選択 |
| RealtimeTab | `src/components/RealtimeTab/` | EEW カード・S 波カウントダウン・揺れ検知カード |
| TsunamiTab | `src/components/TsunamiTab/` | 津波警報・注意報・予報・観測情報 |
| TelegramTab | `src/components/TelegramTab/` | 受信電文ログ（DMDSS 版のみ実データ、standard は空表示） |
| SettingsTab | `src/components/SettingsTab/` | 各種設定・テストボタン・実地震テスト再生・API キー入力 |

## 4.5 トップレベルのディレクトリ構成

各ディレクトリ配下の詳細は個別仕様書と実装コードに委ねる。ここでは初見開発者向けに「何がどこにあるか」を俯瞰する:

```
realtime-earthquake-viewer/
├── src/
│   ├── App.tsx                # レイアウトの中枢
│   ├── main.tsx               # Vite エントリポイント（React root）
│   ├── index.css              # グローバル CSS
│   ├── components/            # UI コンポーネント
│   │   ├── Map/               # 地図（MapLibre GL・全 GL レイヤー） → map-rendering-spec.md
│   │   ├── EarthquakeTab/     # 地震情報タブ → quake-spec.md
│   │   ├── RealtimeTab/       # リアルタイム震度タブ（kyoshin モード）
│   │   ├── TsunamiTab/        # 津波情報タブ → tsunami-spec.md
│   │   ├── TelegramTab/       # 電文ログタブ（DMDSS 版のみ実データ）
│   │   ├── SettingsTab/       # 設定タブ → settings-pwa-spec.md
│   │   ├── SpecialInfoBanner/ # 南海トラフ臨時情報・同 関連解説情報・後発地震のバナー
│   │   ├── IconNav.tsx        # タブナビ（右端 or 最下部）
│   │   └── PanelResizeHandle.tsx # 縦積み時の地図／パネル境界（高さ調整・折りたたみ）
│   ├── hooks/                 # データ取得・状態管理・派生データ計算
│   ├── services/              # 外部データソースクライアント → data-sources-spec.md
│   │   ├── dmdata.ts          # DMDATA.JP WebSocket + REST
│   │   ├── dmdataParser.ts    # DMDATA の電文（XML）のパース
│   │   ├── dmdataReplay.ts    # 実地震シナリオリプレイ（archive 取得）
│   │   ├── p2pquake.ts        # P2PQuake（標準版）＋レスポンス検証
│   │   ├── parseHelpers.ts    # 外部レスポンスの値取り出しヘルパ（DMDATA・P2PQuake 共用）
│   │   └── kyoshin.ts         # Yahoo リアルタイム震度・クロック同期
│   ├── utils/                 # 純粋関数群
│   │   ├── eew.ts             # EEW レベル判定・自動解除 → eew-spec.md
│   │   ├── alertSound.ts      # 通知音生成 → audio-tts-spec.md
│   │   ├── voicevox.ts        # VOICEVOX 連携
│   │   ├── kyoshinDetector.ts # 揺れ検知エンジン → kyoshin-detection-spec.md
│   │   ├── clock.ts           # サーバー同期時刻（serverNow）
│   │   ├── testData.ts        # 合成テストデータ生成
│   │   └── testScenarioReplay.ts # 実地震シナリオの時刻シフト・ID 再採番
│   ├── data/                  # 合成テストデータ用の実データサンプル（noto-honshin-2024-*）
│   └── types/                 # 型定義
├── public/
│   ├── data/                  # 事前生成データ（座標・境界・辞書）→ data-sources-spec.md §6
│   ├── fonts/                 # SDF グリフ（地名ラベル用）
│   └── icons/                 # PWA アイコン
├── scripts/                   # 生成データ・グリフ生成スクリプト、実地震シナリオキャプチャ
├── docs/
│   ├── spec/                  # 現在参照される仕様書（この文書を含む）
│   └── archive/               # 完了済み PoC・移行記録
├── README.md                  # プロジェクトの概要と導線
├── CLAUDE.md                  # Claude Code 向けの開発ワークフロー
├── vite.config.ts             # Vite + PWA 設定・バリアント切替
├── tsconfig.json              # TypeScript 設定
├── package.json
└── LICENSE
```

## 4.6 例外の受け止め方

どこかで例外が起きても、**残せるものは残す**。地図が描けなくなっただけで地震情報や通知まで
一緒に消えるのは、この用途では重すぎる。

### 受け止める場所は 3 層

| 層 | 置き場所 | 落ちたときに残るもの |
|---|---|---|
| 根 | `main.tsx` で `<App>` を包む | 何も残らない。状態は失われ、副作用の後始末で WebSocket も切れる |
| 地図 | `App.tsx` の `<MapView>` だけ | カード・ブラウザ通知・読み上げ・行動チェックリスト・特別情報バナー・共有カードボタン |
| タブ | 6 タブそれぞれ | 地図と、落ちていない他のタブ |

- **`App` 自身のレンダー例外は根でしか拾えない。** `App` は単一の大きなコンポーネントで、
  メモ化していない裸の計算式を本体に持つ。そこで投げられた例外は React が子の照合へ入る前に
  `App()` の呼び出しの中で起きるため、内側へ境界を置いても届かない。
- **地図で包むのは `MapView` だけ。** 同じ親にいる左上の情報ブロック（更新時刻・取得状況・
  描画状況）・行動チェックリスト・特別情報バナー・共有カードボタンは境界の外に残す。
  中へ入れると地図と一緒に消える。
- **タブは常時マウント**で `invisible` を付け外ししているだけなので、境界が無いと 1 つのタブが
  投げた例外が `App` ごと巻き込む。
- タブの表示名は `IconNav` の `TAB_LABELS` から引く（ナビのボタン名と同じもの）。

### 伝え方

- 地図・タブは、その領域に短い文と「再表示」を出す。押すと境界の状態を戻して作り直す。
  **短い間に繰り返し落ちたらボタンを引っ込める**——押しても直らないボタンは、直る望みが
  あるように見せるぶん無いより悪い。
- 根は全画面で「画面を表示できなくなりました」と、**情報の受信も止まっていること**を出す。
  押せるのは再読み込みだけ。
- **自動でリロードはしない。** 進行中の緊急地震速報は起動時の履歴取得に含まれないためリロードで
  消える。原因が永続データの側にあれば「落ちる → リロード → また落ちる」も繰り返す。
- **読み上げは止めない。** 落ちる直前までに届いた情報を最後まで伝える。

### 守備範囲 —— 上の 3 層とは別の分け方

React の ErrorBoundary が捕まえるのは**レンダー・ライフサイクル中の例外だけ**。イベントハンドラ・
`setTimeout`・Promise・`requestAnimationFrame` の中は範囲外で、これは React の仕様。

| 仕組み | 拾うもの | 画面 |
|---|---|---|
| `components/ErrorBoundary.tsx` | レンダー・`useMemo`・`useEffect` の同期本体の例外 | その範囲をフォールバック表示へ差し替える |
| `components/Map/gl/guardRender.ts` | カスタムレイヤーの `render()` の例外（MapLibre の描画ループ） | 「〇〇を描けず」（`utils/renderHealth.ts`） |
| `utils/globalErrorLog.ts` | 上のどちらにも入らない例外・未処理の Promise 拒否 | **出さない**（記録のみ） |

- **描画ループの中は境界が原理的に届かない。** `render()` を呼ぶのは MapLibre 自身で、React の
  呼び出しスタックを一度も通らない。包まないと被害がそのレイヤーで終わらないこと、MapLibre を
  上げたときに確かめることは [map-rendering-spec.md](map-rendering-spec.md) §12.5 にある。
- **`globalErrorLog` は画面に出さない。** ブラウザ拡張・外部スクリプト・握り漏らした取得失敗でも
  発火するので、UI へ出すと平常時から警告が居座る。記録に残す値打ちは、アプリ時計のタイムスタンプが
  付いて直前に届いた電文と突き合わせられるところにある。
- `renderHealth` が拾うのは**あらかじめ決めておいた失敗の形**（レイヤー追加の失敗・シェーダーの
  リンク失敗・ポップアップ登録の失敗）で、例外とは別の話。`guardRender` はその枠へ相乗りする。

### 入力を確かめるガードは、境界ができても外さない

`utils/geo.ts` の `hasKnownEpicenter` のように**例外になる前に安全側へ倒す**ガードは残す。

- 描画ループの中で投げられるものは境界が届かない（上表）。`guardRender` が被害を 1 枚へ抑えても、
  その描画物が出ないこと自体は防げない
- 境界が受け止めるのは「その範囲を表示できない」という結果でしかない。壊れた値を画面まで
  通さないほうが安い
- **原因が判っている失敗は、自分で握るほうが伝えられることが多い。** 境界は何が起きたかを知らないので、
  案内できることに限りがある。地図を作れなかったときの扱いは
  [map-rendering-spec.md](map-rendering-spec.md) §12 にある。

## 5. 状態管理

Redux 等のグローバルストアは使わず、React のフック（`useState` / `useReducer` / `useRef`）で構成する。
主要な状態は `useEarthquakes`（`useReducer` の一種）で `earthquakes` / `activeEEWs` / `tsunamis` /
`lpgmByEventId` / `nankai` / `kohatsu` / `telegramLog` を管理する。

`activeEEWs` は `Map<eventId, EEWAlert>` で保持。eventId は `eew.issue?.eventId ?? eew.id` を統一キーとして
使う（続報が来ても同じキーで上書きされる）。

## 6. 時刻の扱い

**壁時計（`Date.now()`）は絶対値としては信用しない**。以下の時刻は必ずサーバー同期時刻を使う:

- EEW の P/S 波円計算
- EEW 自動解除タイミング
- 津波 `validDateTime` の期限判定
- Yahoo 強震モニタの取得ラグ計算
- 実地震テストシナリオの時刻シフト

実装は `src/utils/clock.ts` の `serverNow()` に統一されている。較正は 30 秒ごとに外部の時刻サービスへ
問い合わせて行う（取れなかった周期のみ Yahoo 強震モニタの応答から推定する）。手段と優先順位の詳細は
[`data-sources-spec.md`](data-sources-spec.md) の「クロック同期」節を単一情報源とする。

## 7. 生成データ（`public/data/`）

`public/data/` 配下には事前生成された座標テーブル・境界データを配置する。地図初回表示時または該当タブ表示時に fetch される。

**単一情報源**: 全ファイル一覧・生成スクリプト・出典は [`data-sources-spec.md §6`](data-sources-spec.md) を参照。ここで重複記載していた表は削除した（`architecture-spec.md` と `data-sources-spec.md` の 2 箇所に置いていたところ内容がドリフトしていた反省）。

`public/data/test-scenarios/*.json` は実地震テストのシナリオデータで、`.gitignore` されている
（DMDATA.JP 利用規約第 15 条により EEW 二次配信が個人契約で制限されるため）。詳細は
[`settings-pwa-spec.md`](settings-pwa-spec.md) の「実地震テスト」節。

## 8. PWA・Service Worker

`vite-plugin-pwa` + Workbox。バリアントごとに独立した Service Worker がキャッシュを管理する。
オフラインでも地図・UI は表示できるが、リアルタイム受信はネットワーク接続時のみ動作。

詳細は [`settings-pwa-spec.md`](settings-pwa-spec.md) の PWA 節。

## 9. 関連する既知の設計判断

- 地図の Leaflet 版は v4.0.0 で完全撤去、MapLibre GL に一本化された（`docs/archive/webgl-migration/` 参照）
- 予報円は震源要素（lat/lng/depth/magnitude）と `originTime` を入力とする自前計算（`usePsWaveCalc`）に統一（両バリアント共通）。**以前は Yahoo `psWave.items` を使っていたが、現在は入力として一切参照しない**（詳細は [`eew-spec.md`](eew-spec.md) §6 参照）
- 「テスト時刻設定」の再生中はライブ接続を止める（両バリアント。理由は [`settings-pwa-spec.md`](settings-pwa-spec.md) §6）

## 10. 改訂履歴

- 2026-08-10: 仕様書構造を再編（`docs/spec/` 配下に集約）。本ファイル新規作成
- 2026-08-16: iOS の PWA で報告された表示崩れに対応し、「画面いっぱいへの広がりとセーフエリア」を
  追記した（§4）。ルート要素を高さ指定からビューポート全体を覆う方式に変え、アイコンナビと
  南海トラフ・後発地震バナーが左右分割時に画面端のセーフエリアを避けるようにした
- 2026-08-18: 上記の原因説が誤りだったため「画面いっぱいへの広がりとセーフエリア」を全面的に
  書き直した（§4）。画面下端の帯の正体は `apple-mobile-web-app-status-bar-style: black-translucent`
  によるビューポートの位置ずれで、`fixed inset-0` でも `100dvh` と同じ高さにしかならず解消しない。
  ステータスバーを `black` に変え、ルート要素は `h-dvh` へ戻した。あわせて空振りになっていた
  アイコンナビの上端セーフエリア指定を削除し、ビューポート単位を `dvh` / `dvw` に統一。
  規則 4 つと判定手順を本節に集約し、iPad 横画面で南海トラフ・後発地震バナーが最下端に
  来ない不具合（同一原因）も解消した
- 2026-09-04: 解説情報バナーの既読判定で、電文 id の書式を揃えてから突き合わせるようにした（§4）。
  電文 id の接頭辞から `xml-` を落とした版へ更新すると、それ以前に保存された既読の記録と
  一致せず、閉じたはずの帯が復活しうる状態だった。
- 2026-09-10: 特別情報バナーに「地震・津波に関するお知らせ」（VZSE40）の帯を足した（§4）。
  観測点の入電停止・配信試験といった運用連絡で、上の 3 枚とは話の種類が違うため最後に置き、
  色は警戒度を取り違えられない無彩色（slate）にした。解説情報と同じく閉じるボタンを持つ
- 2026-09-10: 地震回数に関する情報（VXSE60）の帯を足し、特別情報バナーは 5 枚になった（§4）。
  当初は地震情報タブのカードにしていたが、既定タブがリアルタイムの端末ではアイドル復帰で
  引き離され、群発の最中は揺れ検知が繰り返しリアルタイムタブへ画面を持っていくため、
  **いちばん見たいときに見えない**形だった。畳んだ見出しは電文の定型文ではなく累積の区間から組む
- 2026-09-12: React の ErrorBoundary を 3 層（根・地図・各タブ）に置いた（§4.6）。それまで 1 つも
  無く、受け止められないレンダー例外が出るとツリー全体がアンマウントされて白画面になっていた。
  あわせて、境界が原理的に届かない 2 つの経路も塞いだ——カスタムレイヤーの描画ループは
  `gl/guardRender.ts` が包んで `utils/renderHealth.ts` の表示へ、それ以外の非同期例外は
  `utils/globalErrorLog.ts` が記録へ回す。**個別の入力ガードは残した**（境界は「その範囲を
  表示できない」結果しか受け止められず、描画ループの中へは届かないため）
- 2026-09-13: `onLiveEvent` が運ぶ電文を判別可能ユニオン（`LiveEvent`）へ移した（§2）。
  それまで `AppEvent` に含まれない 6 種別は 17 箇所すべて `as unknown as AppEvent` で渡り、
  受け手も `kind` を文字列として読み直していた。**種別ごとにしか無い項目を付け忘れても
  型検査が通る**状態で、推計震度分布図の「初報か続報か」の印が実際にその形だった
  （欠落は実行時の記録で受け止めていた）。型で必須にしたうえで記録は外し、
  `handleExtraLiveEvent` の末尾には網羅性の安全弁を置いた
