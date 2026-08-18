# 地図描画仕様書

> 本書は**現在の実装が地図をどう描画するか**をまとめた仕様書。実コードと食い違う場合は実コードを正とする。
> 関連: [`architecture-spec.md`](architecture-spec.md) の全体構成、各情報の描画詳細は
> [`eew-spec.md`](eew-spec.md) / [`tsunami-spec.md`](tsunami-spec.md) / [`quake-spec.md`](quake-spec.md)。

## 1. 概要

MapLibre GL JS v6（WebGL 描画）で地図を表示する。全レイヤーが WebGL / DOM Marker のいずれかで実装され、
ラスタタイル画像は最小限（背景の海底地形のみ、オプショナル）。地図モードは 3 種類:

- `quake` — 地震情報タブで表示（観測点ドット・区域塗り・震源）
- `tsunami` — 津波情報タブで表示（海岸線・観測バー）
- `kyoshin` — リアルタイム震度タブで表示（強震モニタドット・EEW 予想塗り・予報円）

## 2. モード決定

`App.tsx` で `mapTab` から派生:

```ts
const mapMode = mapTab === 'tsunami' ? 'tsunami'
              : mapTab === 'realtime' ? 'kyoshin'
              : 'quake'
```

`JapanMapGL` は `mode` prop を受け取り、各レイヤーコンポーネントに visible prop を配る。

**EEW 予想レイヤーの kyoshin モード限定**: `eew-region-fill` / `eew-lpgm-region-fill` は kyoshin モードでのみ
描画される。担保は `JapanMapGL` の JSX の `visible={mode === 'kyoshin' && ...}` で行う（フック側は
モード非依存で計算する設計）。地震情報タブでの実測と予想が同じ配色で見分けにくくなる問題を避けるため。

**EEW 震源×印は全モード表示**: 発報中の震源位置だけは常に地図に載る（kyoshin 以外では半透明 0.4 で薄く）。

## 3. レイヤー順（描画順の単一情報源）

`src/components/Map/gl/layerOrder.ts` の `MAP_LAYER_ORDER` 配列が単一情報源。背面 → 前面の順。

各レイヤーコンポーネントは `addOrderedLayer(map, layer)` で追加する。この関数は `MAP_LAYER_ORDER` で
自分より前面に来るべき id の直前に挿入するため、データ到着タイミングに依存せず順序が保証される。

配列に無い id は最上段に積まれる（警告なし）。新レイヤーを足すときは配列への登録を忘れないこと。

**カスタムレイヤーの注意**: MapLibre の `type: 'custom'` レイヤー（現状 `kyoshin-subthreshold`・`pswave`）は
`getStyle().layers` に現れない。順序確認は `map.style._order` を見る。

## 4. ベースマップ

`BaseMapGL` が担当。以下を描画:

- 陸地塗り
- 都道府県境界（`prefectures.json`）
- 一次細分区域境界（`subregions.json`）
- 海底地形（GEBCO ラスタタイル・任意・下記の 2 層構成）

陸地・境界はタイル取得が不要で、全て事前生成された GeoJSON から自前描画する。海底地形タイルは唯一の
外部ラスタで、設定で ON/OFF 切替可能（切替は 2 層に同時に効く）。

**海底地形の 2 層構成**: 遠距離の自動フィット（カメラが自動で視野を移す処理・§6）の直後は、飛行先の
タイルがまだ手元に無く海底地形が描けない。ラスタが 1 層だけだとその間は素の背景色が露出して暗転して
見えるため、低ズーム固定の下地を常時敷いて必ず何かが描かれている状態を作る。

| 層 | レイヤー id | ソースの最大タイル z | 描画開始ズーム（レイヤーの `minzoom`） | 役割 |
|---|---|---|---|---|
| 下（下地・オーバービュー層） | `gebco-overview-raster` | `GEBCO_OVERVIEW_MAX_ZOOM` | なし（全ズーム） | 粗いが必ず存在する下地 |
| 上（高解像度） | `gebco-raster` | `GEBCO_SOURCE_MAX_ZOOM` | `GEBCO_HIRES_MIN_ZOOM` | 現在ズーム相当の精細な地形 |

MapLibre はソースの最大タイル z を超えるズームではそのタイルを拡大して描き続けるため、下層はどのズーム・
どの位置でも下地として残る。上層のタイルが届くとその上に載って差し替わる（上層は既定の 300ms
クロスフェードを維持。下層は常在の下地なのでフェードは不要＝`raster-fade-duration: 0`）。下層が使う
タイルは先読みの低ズーム側に含まれるため、起動後まもなく揃う。

上層の `minzoom`（`GEBCO_HIRES_MIN_ZOOM`。**マップズーム基準**の値で、同じ表の「最大タイル z」とは別の
座標系）未満のズームでは、2 層が同じタイルを要求するだけで見た目は変わらない。そこでは上層を描画対象から
外して二重取得を避ける（非表示のレイヤーはソースの更新対象にならないため、タイル取得ごと止まる）。

**対処できる範囲**: 距離・タイミングに起因する一時的なタイル未到達まで。GEBCO の配信元自体へ到達できない
場合は両層とも新しいタイルを描けないが、低ズームのタイルを一度でも取得済みなら MapLibre がそれを拡大して
穴を埋める（タイル取得を全て失敗させても素の背景は露出しないことを実測で確認）。起動直後から到達不能な
場合はその下地も無いため暗転する。

**ズームアウト時の非表示化**: 都道府県境界・一次細分区域境界（`BaseMapGL`）と活断層（`ActiveFaultsGL`）は、
`gl/zoomLevels.ts` の `DETAIL_MIN_ZOOM`（3.5）を下回るズームでは描画しない（線を簡略化するのではなく
レイヤーごと消す）。遠地地震のフィットのように世界規模まで引くと、これらの線が潰れて列島が塗り潰された
塊になるため。陸地塗りとプレート境界は対象外で、引いた画でも列島の位置は分かる。
なお通常の日本全体表示は地図の幅で決まり、スマホ幅（375px）で約 3.8・デスクトップで約 5.0 のため、
どちらも従来どおり描画される。

**生成データの取得に失敗したとき**: 該当するレイヤーを作らずに描画を続ける（`prefectures.json` なら
陸地塗りと県境、`subregions.json` なら区域境界線と区域名ポップアップの当たり判定）。`console` には
何が出なくなるかを含む警告を出す。震度表示側は区域データが無いと別のフォールバックを行う
（[`quake-spec.md`](quake-spec.md) §7.2）。

応答もエラーも返らずハングした場合も、取得は時間切れで打ち切って上記と同じ失敗として扱う
（警告の文言に「timed out」が入る。タイムアウト値は [`data-sources-spec.md`](data-sources-spec.md) §6 参照）。
利用者に向けては、取得に失敗した件数を地図左上に出す（同 §6「取得状況の表示」）。

**地形先読み**: `src/utils/gebcoPrefetch.ts` が沖縄〜択捉相当の低ズームタイルをアイドル時に
バックグラウンド fetch する。GEBCO は 256px タイルのソースなので MapLibre が要求するタイル z は
マップズーム +1 になる（§6 のズーム基準とは別の座標系）。先読み範囲もタイル座標系で決めるため、
`MAX_ZOOM` をそのままタイル z として使わないこと。同ファイルは `GEBCO_HIRES_MIN_ZOOM`（マップズーム
基準）も持つため、定数を触るときはどちらの座標系の値かを必ず確認する。

## 5. ラベル描画（`LabelsGL`）

- 地方名・県名・区域名を symbol + icon-image で描画
- ズーム帯で表示粒度を切替（低ズームは地方名、高ズームは区域名）
- 文字サイズは「地図アイコン倍率」（[`settings-pwa-spec.md`](settings-pwa-spec.md) §2「主な項目の補足」）で震度バッジと揃えて拡縮する。
  バッジとの間隔は `text-offset` の em 指定（文字サイズに対する比）で決めているため、文字とバッジの双方に
  同じ倍率が掛かる限り、倍率を変えても間隔の比率は崩れない
  - この倍率が変えるのは見た目の大きさだけで、クリック・タップの当たり判定（`QuakeHeatmapGL` の
    `HIT_RADIUS_PX` など）には連動しない。押しやすさのための値であり、倍率に連れて広げると
    密集した地域で隣の対象を拾いやすくなるため
- 事前生成 **SDF グリフ**（M PLUS Rounded 1c ExtraBold・`public/fonts/`）を使用
  - **適用されるのは本節のラベルのみ**。震度バッジ等の数字は Canvas2D でラスタライズしたアイコン画像（`gl/intensityIcons.ts`・`gl/lpgmIcons.ts`・`gl/kyoshinDetectedIcons.ts`）で描いており、そちらは端末のシステムフォント（`sans-serif`）を使う
  - 暗い地図の上に小さく置く地名（倍率 100% で 13〜17px）を読ませるため、丸ゴシック（角を丸めた字形のゴシック体）の太いウェイトを採用している
  - **SDF**（Signed Distance Field / 符号付き距離場）: 文字の輪郭を「各ピクセルから輪郭までの符号付き距離」として保存する画像形式。拡大縮小してもエッジが滲まないため MapLibre GL の文字描画に採用されている
- グリフ生成スクリプト: `scripts/build-glyphs.mjs`（`@mapbox/tiny-sdf` で焼く）
  - 収録するのは地方名・県名・区域名・震度ラベル・ASCII に実際に現れる文字だけ。**地名を増減したら再生成が必要**
  - 再生成を忘れると、その文字が生成済みブロック（256 文字単位）内にあれば警告なしで空白になり、ブロックごと未生成なら警告付きで実行時生成にフォールバックして事前生成の目的（初回描画時のメインスレッド停止の回避）が失われる
  - この取りこぼしは目視でしか気づけないため、`npm run build` は前段で `node scripts/build-glyphs.mjs --check` を実行する。配信される `.pbf` を実際に読み、必要な文字が揃っていなければビルドを中断する
  - 検査するのは次の 3 点
    - **文字が収録されていること**
    - **その字形が空でないこと**（収録されていても中身が空なら画面上で空白になる。字形を持たない半角スペースだけは対象外）
    - **焼いたときの条件が今の設定と一致すること**（フォント実体のハッシュ・ファミリ・ウェイト・SDF パラメータを生成時に `build-info.json` へ記録して照合する。フォントを差し替えて焼き直しを忘れると、収録も字形も揃ったまま形だけ古くなるため）
  - `build-info.json` は生成物と一緒にコミットすること（`npm run build` は検証しか行わず、グリフを焼き直さない）。ビルド時の照合にのみ使うファイルで、PWA の precache 対象ではない
  - 生成した `.pbf` は PWA のオフラインキャッシュ対象（[`settings-pwa-spec.md`](settings-pwa-spec.md) §5）
- 震度バッジ・観測点ドット等のマーカーと画面上で実際に重なっている間は `text-opacity` を下げる
  （`src/components/Map/gl/labelOverlap.ts` の `queryRenderedFeatures` ベース判定）

県名・区域名は境界データ（`prefectures.json` / `subregions.json`）に依存する。取得に失敗した場合は
そのラベルだけが出ず、他のズーム帯のラベルは影響を受けない。`console` の警告には対象のズーム帯を
含めている（「取得に失敗して出ない」のか「そのズーム帯では元々出さない設計」なのかを区別するため）。

## 6. カメラ制御（`CameraFollowsGL`）

以下のシチュエーションでカメラを自動フィットする:

- 地震カード選択時 → 該当地震の震源＋主要観測点を含む範囲
  - **遠地地震**（[`quake-spec.md`](quake-spec.md) §3）は国内で震度を観測せず対象が震源 1 点だけになるため、
    離島を含む日本全体の枠（`gl/bounds.ts` の `JAPAN_WIDE_BOUNDS`）を合成してフィットする
- 揺れ検知時（confirmed） → 検知メンバー観測点のフットプリント
  - 検知が終わると日本全体へ戻すが、候補クラスタ（確定検知に育っていない検知点群。下記「解除時」参照）が
    残っている場合は戻さず、候補側が寄り直す。候補が失効したときに日本全体へ戻す判断は
    `FitToCandidateGL` 側が持つ
- EEW 発報中 → 予報円・震源・揺れ検知点・予想の区域塗りを含む範囲（**kyoshin モード時のみ**。
  下記「既知の限界」参照）。目標範囲の決め方は次項
- 津波情報表示時 → 観測点の更新があればその観測点、無ければ対象海域（海岸線）を含む範囲。
  目標範囲と俯瞰への帰り方は下記「津波追従の目標範囲」

**EEW 追従の目標範囲**（他より複雑なため独立して記す。実装は `FitToEEWGL`）:

- **第一報** → その EEW 自身の S 波円（円が無ければ震源 1 点）へ寄る。予想の区域塗りは含めない——
  警報級では予想区域が広く、含めると第一報から引きの画になって震源近傍が見えなくなる
- **発報中** → 「S 波円 ∪ 震源 ∪ 揺れ検知点 ∪ 予想の区域塗り」を 1 つに束ねた範囲。表示に収まらなく
  なったときだけ引く。EEW の件数が減ったときの再フィットも同じ範囲を使う（目標が食い違うと、再フィットの
  直後に引き直しが起きて二段のカメラ移動になる）
  - 追従の基準は揺れの前線＝S 波円で、速い P 波円は追わない。円の半径は有感半径
    （[`eew-spec.md`](eew-spec.md) §7）と日本全体（`JAPAN_BOUNDS`）でクランプするが、検知点と区域塗りには
    クランプをかけない（この枠は沖縄を含まないため、沖縄の観測点や区域を切り捨ててしまう）
  - 塗ってある区域が画面外にあると読めないため区域も含める。予想長周期地震動を表示中はそちらの区域へ
    切り替わる（どちらを塗るかの判定と同じ分岐を使う）
- **解除時** → 揺れ検知点、無ければ候補クラスタ（確定検知（`confirmed`）に育っていない `likely` 状態の
  検知点群。判定は [`kyoshin-detection-spec.md`](kyoshin-detection-spec.md) §4）、どちらも無ければ
  日本全体へ帰る
  - 発報中は他のカメラ追従（`FitToDetectionGL` / `FitToCandidateGL`）が停止して EEW 側へ追従を一任する
    ため、帰還先も `FitToEEWGL` が決める。委譲された側に帰還経路が無いと、EEW 中に立った候補クラスタが
    一度も画面に入らないまま終わる（`FitToCandidateGL` は候補 1 つにつき一度しか発火せず、自力では
    取り戻せない）
  - **限界**: 解除の瞬間にユーザーが地図を操作していた場合、この帰還は行われず、操作が終わっても
    再評価されない。確定検知は成長フォローが安全網になるが、候補クラスタにはそれが無い

**津波追従の目標範囲**（実装は `TsunamiFitGL`。優先順位の判定は `gl/tsunamiFit.ts` の `decideTsunamiFit`）:

下記は「どこへ寄るか」の選択で、実装の分岐と同じ順に評価し、最初に当たったものだけを実行する
（そもそも動かすかどうかは津波モードかとユーザー操作中かで決まる。下記「ユーザー操作の尊重」）。
ここでいう signature は「区域名:等級」を連結した文字列で、発表内容が変わらなければ同じ値になる。

- **観測点の波高が更新された** → 更新された観測点へ寄る。速報性のある変化を俯瞰より先に見せる
  - このとき対象海域の signature を消費する（同じ範囲を海岸線と観測点で二重に決めると、寄った直後に
    引き直しが起きて二段のカメラ移動になる）。区域・等級が変わらない限り海岸線フィットは再発火しない
  - 手動操作中や津波モード以外のときは寄らずに持ち越す。持ち越すのは**最後に届いた電文のぶんだけ**で、
    複数の電文を束ねはしない（離れた観測点の和では引きの画になり、どこで新しく観測されたのかが
    読めなくなる）
- **区域・等級が変わった**（新規発表・格上げ・区域追加） → 対象海域全体
- **発表が終わった**（解除表示の後の消去・有効期間の満了） → 日本全体へ帰る
  - **限界**: 帰るのは津波モードの間だけ。消えるより先に他のタブへ移っていた場合はその場では帰らない
    （モードを越えた調停に踏み込まないのは下記 MAP-5 と同じ理由）。ただし `TsunamiFitGL` は
    モード切替をまたいで常時マウントされているため、次に津波タブへ戻った時点で下記「入室時」または
    この分岐が評価され、カメラは補正される
- **津波モードへ入室した、またはアイドル復帰の期限が来た** → 対象海域全体へ帰る（海岸線が引けない
  ときは日本全体）
  - アイドル復帰の期限は、観測点へ寄ってから、または地図を手動操作してから「自動復帰までの時間」
    （`idleRevertSec`。[`settings-pwa-spec.md`](settings-pwa-spec.md) §2）だけ何も起きないこと
  - これが無いと観測点に寄ったまま残り、発表中の対象海域全体が二度と画面に入らない（上記の
    signature 消費のため）
  - 「自動復帰までの時間」が 0（自動復帰なし）のときは、アイドルでは帰らない。地図の操作を無期限に
    尊重する設定（下記「ユーザー操作の尊重」）と足並みをそろえている

**観測情報の行クリック**（実装は `FocusObsGL`）→ その観測点へ寄る。あわせて上記アイドル復帰の期限を
クリック時点から数え直す（パネルのクリックは地図の操作ガードを通らないため、数え直さないと
ユーザーが選んだ表示が猶予の残り時間だけで巻き戻される）。地図に観測棒が無い観測点（座標未収録・
[`tsunami-spec.md`](tsunami-spec.md) §8）はカメラを動かさないので、猶予にも触らない。

**寄り上限とズーム値の基準**: 自動フィットが寄る上限は `gl/camera.ts` の `MAX_ZOOM`（現在 7）。
MapLibre GL JS のズームは 512px タイル基準で数えるため、Leaflet（256px 基準）の同じ数値より 1 段深い
（MapLibre の z は Leaflet の z+1 相当）。コードに書くズーム値は常に MapLibre 基準に統一し、Leaflet 版
から値を移す場合は 1 段引く。`MAX_ZOOM` を変えるときは、同じ基準で揃えている以下も併せて見直すこと:

- ラベル粒度の切替帯（§5・値は `LabelsGL.tsx` の定数）
- 細線を消す下限ズーム（§4。`gl/zoomLevels.ts` の `DETAIL_MIN_ZOOM`）
- 震度の区域集約の閾値（[quake-spec.md](quake-spec.md) §7。`MAX_ZOOM` から導出しており独自の値を持たない）
- ヒートマップの収束ズーム（`QuakeHeatmapGL` の `HEAT_MAX_ZOOM`）。「px で見やすさを決める区間」と
  「地理的な距離を保つ区間」の境目であって**表示の上限ではない**（レイヤーに `maxzoom` は付けない。
  詳細は §14）
- 地形先読みの最大タイル z（§4。タイル座標系なので `MAX_ZOOM` そのものではない）
- 海底地形の高解像度層の下限ズーム（§4 の `GEBCO_HIRES_MIN_ZOOM`。マップズーム基準。自動フィットの
  寄り上限で必ず高解像度が出るよう `MAX_ZOOM` より小さく保つ）

これらの相互関係のうち、座標系の取り違え・海底地形 2 層の二重取得の再発・寄り上限との矛盾は
`src/components/Map/gl/zoomConstants.test.ts` が機械的に固定している（値そのものではなく定数どうしの
関係を検証しているため、片方だけ動かすと落ちる）。

**ユーザー操作の尊重**: `gl/camera.ts` の `ensureUserInteractionState` が `zoomstart`・`dragstart` を
購読し、ユーザーが地図を操作している間は自動フィットを抑制する。

**明示選択によるバイパス**: 上記の抑制は「電文更新起点の自動追従」を対象とした挙動であり、
ユーザー自身が明示的に選択した操作（地震カードのクリック・津波タブから地震情報へのリンク）は
抑制の対象外として扱う。App 側の `quakeSelectionTick` が明示クリック時のみ +1 され、
`QuakeFitGL` はこの tick が進んだフレームでは `isUserInteracting` を無視して強制フィットする。
EEW も同様に「新規 EEW 受信時は `resetUserInteraction()` してからフィットする」（`FitToEEWGL`）
という同種のバイパスを持つ。

**カメラの重複制御**: `beginProgrammaticFlight` / `isProgrammaticFlight` カウンタで自動アニメーション中の
判定を持ち、重複した flyTo/fitBounds が壊れないようにする。

**既知の限界（MAP-5）**: EEW 追従の `FitToEEWGL` は `mode === 'kyoshin'` のときのみマウントされる。
kyoshin モードから tsunami/quake モードへ切り替えるとアンマウントされ、以降その EEW を追従できない。
初回の敵対的レビューで「常時マウント化」を試みたが、`QuakeFitGL`/`TsunamiFitGL` との flyTo 争い・
EEW 解除後の他モード帰還が未実装等の副作用が広範に発生することが判明し revert した。正しい修正には
mode を全 Fit*GL に配って優先度で調停する大規模リファクタが必要で、スコープ外とした。

**地図の傾きと回転**: 傾き（pitch）と回転（bearing）はどちらも**ユーザー操作から無効化している**。
地図は常に真上から見た北が上の状態で、操作はパン・ズームのみ。実装は `JapanMapGL` の Map 生成オプション
（`maxPitch: 0` / `touchPitch: false` / `pitchWithRotate: false` / `dragRotate: false`）と、生成直後の
`touchZoomRotate.disableRotation()`・`keyboard.disableRotation()`。ピンチズームは残る
（`touchZoomRotate: false` にするとズームまで死ぬため、回転だけを落とす API を使っている）。

理由は 2 つ。**3D 地形を使っていないため傾けても起伏は出ず情報が増えない**こと（MapLibre の
`setTerrain()` による高さ付き地形のこと。§4 の海底地形は 2D のラスタ画像で別物）。そして
**主要な描画物が「傾き 0・北が上」を前提に実装されている**ことである。前提を破ると次のように崩れる:

- **予報円**（`PsWaveGL`）— 半径を「震央から東へ 1 点ずらして `project()` した画面座標の **x 座標差**」で
  求めている。回転すると東方向の変位が x・y に分散するため、半径が `cos(bearing)` 倍に縮む。ブラウザで
  同一条件を測ると 0 度 45.51px → 45 度 32.18px → 60 度 22.76px → **90 度 0px（円が消える）**。EEW の
  到達予想を実際より小さく見せる方向に狂う。傾けた場合も、地面側が透視で圧縮されて画面上の真円と
  地面の円が一致しなくなる
- **カメラ自動フィット**（`gl/camera.ts`）— `cameraForBounds` は pitch を計算に入れず（返り値は
  `CenterZoomBearing`）、bearing も呼び出し側が渡さない限り 0 として扱う。本アプリは一箇所も渡していない
  ため、`fitBounds` 経由（`fitJapan` / `fitToPositions` / `flyToBounds`）では戻り値の `bearing: 0` が
  適用されて**ユーザーの回転が無断でリセットされる**。逆に `flyToBoundsSnapped`（EEW 追従）は
  `cameraForBounds` の bearing を捨てるため、回転を保ったまま北が上の前提で計算した狭いズームを当てる
  ことになり、**対象が画面から見切れる**

一方、**円マーカー・ラベル・DOM マーカーは影響を受けない**。circle レイヤーの半径と symbol のラベルは
画面空間の固定値で、`maplibregl.Marker`（`EpicenterGL` / `EewEpicentersGL` / `TsunamiObsBarsGL`）も
`rotationAlignment` の既定（viewport）により画面に正対したままだからである。`gl/labelOverlap.ts` の
重なり判定も画面座標どうしの比較なので崩れない。

**傾き・回転を有効に戻す場合**は、上記 2 点（予報円の半径計算とカメラ自動フィットの bearing 前提）を
先に直す必要がある。なおこの無効化は Map インスタンスが持つ JS 側の状態なので、WebGL コンテキストロスト
からの復元（§12）でスタイルを作り直しても失われない。

## 7. mode 別レイヤー一覧

### quake モード
- `BaseMapGL`（ベース）
- `QuakeHeatmapGL`（ヒートマップ・任意）
- `QuakeRegionFillGL`（区域塗り＋区域中心震度バッジ）
- `QuakeIntensityPointsGL`（観測点ドット）
- `LpgmPointsGL` / `LpgmRegionFillGL`（長周期・DMDSS 版のみ）
- `EpicenterGL`（震源×印）
- `EewEpicentersGL`（EEW 震源×印・全モード表示だが kyoshin 以外は半透明）
- `LabelsGL`（地名ラベル）
- `ActiveFaultsGL` / `PlateBoundariesGL`（任意）

### tsunami モード
- `BaseMapGL`
- `TsunamiLinesGL`（海岸線・等級色・点滅）
- `TsunamiObsBarsGL`（観測点バー）
- `EewEpicentersGL`（EEW 震源×印）
- `LabelsGL`

### kyoshin モード
- `BaseMapGL`
- `KyoshinSubThresholdGL`（震度 0 以下ドット・カスタムレイヤー）
- `KyoshinPointsGL`（震度 1+ 観測点）
- `KyoshinDetectedPointsGL`（揺れ検知点ハイライト。描く点集合と下限はリアルタイムタブの検知カードと揃える。
  [`kyoshin-detection-spec.md`](kyoshin-detection-spec.md) §8）
- `KyoshinMaxEffectGL`（最大震度エフェクト・rAF アニメ）
- `EewRegionFillGL`（EEW 予想震度塗り・kyoshin 限定）
- `EewLpgmRegionFillGL`（EEW 予想長周期塗り・kyoshin 限定）
- `PsWaveGL`（P/S 波予報円・カスタムレイヤー・100ms 更新）
- `EewEpicentersGL`（EEW 震源×印）
- `ActiveFaultsGL` / `PlateBoundariesGL`（任意）
- `LabelsGL`

## 8. 毎秒更新レイヤー（強震モニタ 1Hz）

Yahoo リアルタイム震度は 1 秒毎に更新される。以下のレイヤーが毎秒 setData / setFeatureState する:

- `KyoshinPointsGL` — 各観測点の feature-state を更新
- `KyoshinSubThresholdGL` — カスタムレイヤーで indices バッファを更新して triggerRepaint
- `KyoshinMaxEffectGL` — 波紋 rAF アニメ
- `KyoshinDetectedPointsGL` — 検知点の GeoJSON を setData

**トランジション対策**: MapLibre GL v6 は全 paint プロパティに既定 300ms トランジションが付く。
毎秒更新するレイヤーで painter の値が動く場合、`-transition: { duration: 0 }` を明示的に設定して
アニメーション残像・点滅を防ぐ。過去に津波点滅（v4.1.1）と強震モニタ（v4.2.2）で 2 回踏んだ実績あり。

## 9. パフォーマンス上の要点

### setData churn 対策
- 同じデータでの setData は避ける（React で参照同一性を保つよう useMemo で囲む）
- 過去に `App.tsx` の `Array.from(activeEEWs.values())` を毎レンダー生成していて fps 17→55 の劣化を起こした事故あり

### rAF の停止
- `KyoshinMaxEffectGL`・`TsunamiLinesGL`（点滅）・`PsWaveGL` は `requestAnimationFrame` を使う
- 停止条件（`activeEEWs.length === 0` 等）で `cancelAnimationFrame` を呼ぶ
- コンポーネント unmount 時にも cleanup が必要

### カスタムレイヤーの GL リソース
- `KyoshinSubThresholdGL` は **FBO 二層合成**で「同レベルドットの重畳を非加算合成」を実現
  - **FBO**（Framebuffer Object）: 画面ではなくオフスクリーンのテクスチャに描画するための WebGL の仕組み。1 層目に「その点が塗られているかどうか」を書き込み、2 層目でその結果を通常の paint に合成することで、同じ震度階級のドットが何個重なっても濃くならないブレンドを実現している
- `PsWaveGL` は `type: 'custom'` のカスタムレイヤーで、内部でオフスクリーンの 2D canvas に円を描画してから `gl.texImage2D` で WebGL テクスチャに転送する構造（旧実装は `getCanvasContainer` 上の DOM Canvas オーバーレイだったが、カスタムレイヤー方式に置換済み）

### 大量マーカーの実装方針
- 座標に強く紐づく DOM 要素（震源×印・観測バー）は `maplibregl.Marker` を使う
- それ以外は GL レイヤー（circle / fill / line / symbol）で描画

## 10. maplibregl.Marker の注意点

`maplibregl.Marker` の不透明度は **`element.style.opacity` ではなく Marker のオプション**
（`opacity` / `opacityWhenCovered`）で渡す。Marker は「地形に隠れたとき薄くする」機能があり、
これが element の style.opacity を自前で上書きするため、cssText 経由の設定は無視される。

`opacityWhenCovered` を省くと地形有効時に既定 0.2 が効くため、隠蔽時も同じ濃さにしたいなら同値を渡す。

## 11. デバッグ用の公開

`window.__mapGL`（`JapanMapGL` が露出）から map インスタンスに直接アクセスできる。本番ビルドでも有効。

- ソース内容の集計: `await map.getSource(id).getData()`
- レイヤーの表示切替確認: `map.getLayoutProperty(id, 'visibility')`（未設定＝表示）
- レイヤー順の確認: `map.style._order`
- タイル取得失敗の切り分け: コンソールの `map error` ログに `sourceId` が入る。海底地形のように同一 URL の
  ソースを 2 つ持つ場合（§4）、どちらの層が落ちたかはこれで判別する（URL だけでは区別できない）

**注意**: `source._data` は MapLibre v6 に存在しない（undefined を空データと誤読しがち）。
`queryRenderedFeatures` / `querySourceFeatures` はビューポート内のタイルに限られるため全件集計には使えない。

## 12. WebGL コンテキストロスト

MapLibre v6 は WebGL コンテキストロスト時、内蔵レイヤーは `_contextRestored` の
`setStyle(style, {diff:false})` 経由で復元するが、custom レイヤーは復元しない
（公式コードが `console.warn("Custom layer ... cannot be restored")` で明示）。

本アプリでは `map.on('webglcontextrestored', ...)` を各 custom レイヤーコンポーネントで購読し、
restore 時に手動で `addOrderedLayer` 経由で再追加する:

- `pswave`（`PsWaveGL.tsx`）: 同一の `customLayer` オブジェクトを再追加。onAdd が新しい gl から
  program/buffer/texture 参照を作り直す。
- `kyoshin-subthreshold`（`KyoshinSubThresholdGL.tsx`）: `makeSubThresholdLayer` で
  レイヤーオブジェクトごと作り直し、成功後に `layerRef` を差し替えて setLevels/setIconScale/setVisible の
  窓口を維持する。restore 直後にマウント時点の値ではなく現在の props/直近 levels を再適用する
  （`iconScaleRef` / `visibleRef` / `levelsRef` で保持）。

### タイミング設計上の注意

MapLibre v6 の `_contextRestored` は `setStyle(..., {diff:false})` を呼んだ直後、**同じ同期実行内**で
`webglcontextrestored` を発火する。この時点で新しい `Style` は `_load()` が次フレームまで遅延され
`_loaded=false` のため、直接 `addLayer` を呼ぶと `_checkLoaded` が `Error: Style is not done loading.`
を投げる。さらに MapLibre の `Evented.fire` はリスナー単位で try/catch しないため、1 つの例外が
後続の custom layer のハンドラを止めうる。

対策:
- `map.isStyleLoaded()` を確認し、false のときは `map.once('style.load', ...)` で待ってから追加
- 各コンポーネントで try/catch し、失敗は `log.error` で記録（他 custom layer のハンドラは巻き添えにしない）

モバイル常駐 PWA で GPU リソース回収時（バックグラウンド長時間放置後の復帰・端末リソース逼迫）に
発生しうる。

## 13. 関連実装ファイル

- `src/components/Map/JapanMapGL.tsx` — 地図の中枢（初期化・スタイル・全レイヤー配線）
- `src/components/Map/MapView.tsx` — App との仲介
- `src/components/Map/mapGLContext.ts` — map インスタンス購読
- `src/components/Map/mapTypes.ts` — Props 型定義
- `src/components/Map/CameraFollowsGL.tsx` — カメラ自動追従
- `src/components/Map/gl/` — 補助ユーティリティ
  - `layerOrder.ts` — 描画順の単一情報源
  - `camera.ts` — カメラ操作・ユーザー操作検知
  - `bounds.ts` — 追従範囲の合成・包含判定
  - `tsunamiFit.ts` — 津波カメラ追従の優先順位判定（`decideTsunamiFit`）
  - `zoomLevels.ts` — 複数レイヤーで共有する表示ズーム閾値（`DETAIL_MIN_ZOOM`）
  - `labelOverlap.ts` — ラベルの重なり検知
  - `popupRegistry.ts` — ポップアップの当たり判定調停
  - `popupHtml.ts` — ポップアップ HTML 生成
  - `geojson.ts` — GeoJSON 生成ヘルパー
  - `subThresholdLayer.ts` — 震度 0 ドットのカスタムレイヤー
  - `tsunamiObsBar.ts` — 津波観測バーの寸法計算（地図アイコン倍率の適用範囲を含む）
  - `fontStack.ts` — グリフスタック設定
  - `intensityIcons.ts` / `lpgmIcons.ts` / `kyoshinDetectedIcons.ts` — 事前ラスタライズアイコン

## 14. 地震活動ヒートマップの見せ方

`QuakeHeatmapGL` が直近 1 ヶ月の震源を密度として描く。パラメータの決め方には前提が 2 つある。

**前提 1: 濃さは場所によって桁で違う。** 実データ（2026-08-18・696 点）では 0.1 度メッシュあたりの
重み合計が中央値 0.15 に対し最大 16.6 と 100 倍以上開く。色の折れ点を等間隔に置くと、濃い側は
上限に張り付いて一様な赤（境界のはっきりした塊）になり、薄い側は透明に潰れて、どちらの濃淡も
読めなくなる。**折れ点は対数的に配置し、密度強度も低く抑える。**

**前提 2: 取得できる震源の座標は 0.1 度（約 11km）刻み**（両バリアント共通。気象庁の決定精度では
なく公表時の丸めで、精密な値が別電文にあることを含め [data-sources-spec.md](data-sources-spec.md) §2）。
半径を px 固定のまま寄ると、格子の間隔が半径を超えて 11km 格子の点描になり、配信された座標より
細かい位置が分かっているように見えてしまう。そこで
**`HEAT_MAX_ZOOM` から `HEAT_GEO_ZOOM` までは半径を「ズーム 1 段で 2 倍」＝地理的な距離が一定に
なるよう伸ばす**（`interpolate` の `exponential` base 2。この基数だとストップ間が正確に 2 倍ずつに
なる）。引きの画では見やすさを優先して px で決め打つため、境目が `HEAT_MAX_ZOOM` になる。

半径を伸ばすと高ズームで画面全体が塗り潰されて地図が読めなくなるので、**不透明度を寄るほど下げて**
下地に沈ませる。引きの画は従来の濃さのまま、寄ったら「背景の情報」として残る。

`HEAT_GEO_ZOOM` より寄ると半径・不透明度とも値が固定される（`interpolate` はストップ範囲外を
クランプするため）。地図自体に寄り上限は無いのでそこまで寄ることはできるが、その領域では
「地理的な距離を保つ」性質は失われ、再び格子が見え始める。

値そのものは `QuakeHeatmapGL.tsx` の定数と paint 式を正とする。

## 15. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
- 2026-08-15: 海底地形を 2 層構成（常時下地 + 高解像度）に変更（§4）。遠距離の自動フィット直後に
  素の背景色が露出する問題への対処。あわせて §6 のズーム閾値一覧に高解像度層の下限ズームを、
  §11 にエラーログの `sourceId` による層の切り分けを追記
- 2026-08-15: 地名ラベルのフォントを M PLUS Rounded 1c ExtraBold に変更（§5）。暗い地図上の小さな地名を
  読ませるため。あわせてグリフ検証（`--check`）を追加し、収録文字・字形の非空・焼いた条件の一致を
  ビルド前段で確認するようにした。震度バッジ等の Canvas2D 描画は対象外である旨も明記
- 2026-08-16: 地名ラベルの文字サイズを地図アイコン倍率で拡縮するようにした（§5）。従来はラベルだけが
  倍率の外にあり、バッジを大きくするとラベルとの間隔の前提（震度7バッジ約20px に対する退避量）が
  崩れていた。退避量は `text-offset` の em 指定なので、文字とバッジの双方に同じ倍率が掛かることで
  比率が保たれる
- 2026-08-18: ヒートマップのレイヤーから `maxzoom`（表示上限）を撤去（§6）。移植元 `leaflet.heat` の
  `maxZoom` は補間の上端を指す設定であり表示を止めるものではないのに、MapLibre の `layer.maxzoom` に
  流用していたため、ズーム 8 以上でヒートマップとポップアップが揃って消えていた
- 2026-08-18: ヒートマップの色・半径・不透明度を作り直し、§14 として方針を明文化。等間隔の色ランプでは
  濃い側が上限に張り付いて一様な赤になっていた（対数配置に変更）。また震源座標が 0.1 度刻みのため
  寄ると格子状の点描になっていた（`HEAT_MAX_ZOOM` 以降は半径を地理的距離に追従させて解消。塗り潰しを
  避けるため不透明度を寄るほど下げる）。上の `maxzoom` 撤去でこの格子が見えるようになったのが発端
- 2026-08-18: 地図の傾き（pitch）と回転（bearing）をユーザー操作から無効化し、§6 に「地図の傾きと回転」
  として理由を明文化。モバイルで 2 本指の縦ドラッグで傾いてしまい、予報円・カメラ自動フィットが
  追従できていなかったのが発端。調査の過程で回転側にも既存の破綻（予報円の半径が `cos(bearing)` 倍に
  縮み 90 度で消える・自動フィットがユーザーの回転をリセットする・EEW 追従が回転時に狭すぎるズームを
  当てる）が見つかったため、傾きと合わせて回転も無効化した。3D 地形を使っていないため、いずれも
  無効化で失う情報は無い
- 2026-08-18: §6 に「津波追従の目標範囲」を追加し、俯瞰への帰還経路を実装した。従来は観測点へ寄ると
  対象海域の signature を消費するため、観測情報が流れ始めると対象海域全体が二度と画面に入らず、
  津波が解除・失効しても寄ったまま取り残されていた（実測で確認）。アイドル復帰で対象海域全体へ、
  発表終了で日本全体へ帰す。判定は `gl/tsunamiFit.ts` の純関数へ切り出して優先順位を
  `tsunamiFit.test.ts` で固定し、猶予タイマーの挙動は `CameraFollowsGL.test.ts` でフェイクタイマーを
  使って固定した。あわせて観測行クリックのフォーカスが観測棒の再生成ごとに再発火し、更新された
  観測点へのフィットを上書きしていた不具合も直した
