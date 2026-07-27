# §8 テキスト描画 B案（グリフ PBF 自前生成）PoC 裏取り（開発機・2026-07-28）

> 対象: 移行計画 `docs/webgl-rendering-migration-plan.md` §8 テキスト描画。
> 決定: 2026-07-27 にユーザー判断で B案（グリフ PBF を自前生成・ホスト）を採用。本文書はその PoC 裏取り。
> 実装: `scripts/build-glyphs.mjs`（生成）・`poc/label.ts`（`?glyphs=1` で A/B 切替）。
>
> **結論: B案は機構として成立。事前生成グリフをフェッチする構成で、日本語ラベル初回描画の
> メインスレッドブロックが開発機で 区域 45.8ms → 7.4ms（6分の1）・県 38.2ms → 6.6ms に低下。
> 生成スパイクが消えることを実測で確認した。**
>
> **【実機で訂正（2026-07-27）】** 上記「生成スパイクが消える（全段≤7.4ms）」は**開発機限定の
> 結果**だった。実機 Surface Go 2 では B案でも 県47 に blockMaxMs 122.1ms・longtask 2件（最大73ms）が
> 残る（区域192 は 43.8ms・longtask 0 まで改善）。B案は実機でも一貫して有効（区域 4.7倍・県 1.8倍）
> だが、生成スパイクは**部分的にしか消えない**。地震検知の自動ズームと重なる最悪局面は県47段階で
> 完全排除されないため、本番はプリフェッチ/ウォームか表示遅延の緩和策が要る。実機の詳細は
> [webgl-glyph-pipeline-b-surface-go2-2026-07-27.md](webgl-glyph-pipeline-b-surface-go2-2026-07-27.md)。

---

## 1. 背景（何が問題だったか）

MapLibre は `glyphs` 未設定だと `text-font` の文字を実行時に TinySDF でクライアントラスタライズする。
日本語（漢字数百字）の初回生成が実機 Surface Go 2 で blockMaxMs 75〜260ms のメインスレッドブロックを
生み、区域名初出＝地震検知の自動ズームと重なる最悪局面で 100〜260ms 停止しうる（計画書 §8）。
B案は SDF グリフをビルド時に PBF へ焼き、実行時はフェッチするだけにして生成スパイクを恒久的に消す。

## 2. 生成パイプライン（`scripts/build-glyphs.mjs`）

- **生成器**: `@mapbox/tiny-sdf`（MapLibre 本体が使うのと同一の SDF 生成器。fontSize24/buffer3/
  radius8/cutoff0.25 の既定でグリフ PBF フォーマットにそのまま対応）。Node に DOM canvas が無いため
  `document.createElement('canvas')` を `@napi-rs/canvas`（プリビルド配布・native コンパイル不要）でシム。
- **標準ツール node-fontnik を不採用にした理由**: native rebuild が Node 24 で失敗（プリビルドバイナリが
  Node 24 に無く nan 経由のソースビルドも通らない）。上記の純JS/プリビルド構成なら Windows 開発機でも
  Linux CI でも同一スクリプトが動く。
- **出力**: `public/fonts/<stack>/<start>-<end>.pbf`（MapLibre の glyphs URL 規約）。ラベルは
  地方9＋県47＋区域192＋震度の既知有限集合のため、使用 codepoint を含む 256 ブロックだけ生成する。
  開発機実測: codepoints 306・blocks 69・glyphs 306・計 400KB。
- **構造検証**: 生成 PBF を読み戻し、全ブロックで `bitmap長 == (width+2*buffer)*(height+2*buffer)` が
  成立・名前/範囲/codepoint（い・子・津 等）が正しいことを確認済み。
- **フォント**: 開発機 PoC はシステムの Yu Gothic（再配布不可のため生成物は `.gitignore`）。
  本番は Noto Sans JP(OFL) 等を同梱し `GLYPH_FONT=... GLYPH_STACK=... npm run build:glyphs` で生成する
  （見た目は微変・perf 特性は不変）。

## 3. 【要】MapLibre の localIdeographFontFamily

**B案で最も重要な落とし穴**: MapLibre は `localIdeographFontFamily` の既定が `'sans-serif'` のため、
CJK 統合漢字・ひらがな・カタカナ・ハングルは **`glyphs` URL を設定していても既定でクライアント
TinySDF 生成に回される**（＝生成スパイクの元凶。A案で glyphs 無しでも日本語が描けていたのはこのため）。
サーバー事前生成 PBF から CJK を取得させるには Map オプションに **`localIdeographFontFamily: false`** を
明示して既定を無効化する必要がある。

実測で裏取り: false 未設定だと z11 表示で `/fonts/*.pbf` フェッチが **0 件**（CJK はローカル生成のまま）。
`false` 設定後は z11 で **16 件**の漢字ブロック PBF（19968-20223 等）がフェッチされ、「東京都２３区」が
サーバーグリフで描画される（豆腐でなく漢字＋全角数字とも正常）。**描画されるだけでは A/B を区別できず、
ネットワーク実測で初めて機構の成否が分かる。**

## 4. 計測結果（開発機 Intel Iris Xe・60Hz・フレッシュロード・`__runLabelZoomSuite`）

主指標 blockMaxMs（メインスレッド最長連続ブロック・MessageChannel 計測・vsync 非依存）。

| 段階 | A案（ローカル TinySDF） | B案（サーバーグリフ） | 低減 |
|---|---|---|---|
| 地方9 | 0 | 3.6 | — |
| 県47 | **38.2** | 6.6 | 5.8× |
| 区域192（最多ユニーク漢字） | **45.8** | 7.4 | 6.2× |
| 震度ラベル | 6.8 | 5.6 | — |

- A案は県・区域で明確な生成スパイク（38〜46ms）。B案は全段 ≤7.4ms でスパイクが消えた。
- longtask は両案とも開発機では 0（生成ブロックが 50ms 閾値未満）。実機 Surface Go 2 では A案が
  66〜259ms の longtask を出していた（計画書 §8）ため、B案の実機効果はさらに大きいと見込む。
- B案の blockMaxMs 7.4ms は PBF の**パースコスト**であり生成ではない。フェッチ自体は非同期で
  メインスレッドを止めない。
- `glyphsGenerated`（glyphManager に載ったグリフ数）は B案でも増える（55→306）。これは
  「ロード済みグリフ数」でありソース（ローカル生成/サーバー取得）を区別しないため、A/B の判別には
  使えない。判別は blockMaxMs と `serverGlyphs` フラグ・ネットワーク実測で行う。

## 5. 残る論点（本番実装で詰める）

- **フェッチ遅延と PWA**: B案は初回表示時にネットワークフェッチが入る（本 PoC で 16 リクエスト）。
  地震検知の瞬間に未取得だとラベルが数百 ms 遅れて出る可能性。**PWA の Service Worker で
  グリフ PBF を事前キャッシュ**すれば起動後は即時・オフラインでも即座（B案採用理由の核心）。
  本番実装で SW プリキャッシュ対象に `public/fonts/**` を含める。
- **本番フォント**: Yu Gothic（再配布不可）→ Noto Sans JP(OFL) 等へ差し替え。ライセンス表記と
  見た目の最終確認が要る。
- **実機再計測**: 開発機での機構確認は完了。実機 Surface Go 2 での blockMaxMs 実測（A案 75〜260ms が
  B案でどこまで下がるか）は実機セッションで裏取りする。
- **本番アプリへの統合**: 本 PoC は素 maplibre-gl ページ。本番の JapanMap 移行時に glyphs URL＋
  `localIdeographFontFamily: false` を組み込む。

### 本番実装で必ず潰すサイレント障害（セルフレビュー code-reviewer 指摘・PoC の結論には非影響）

- **[HIGH] スタック名の単一情報源**: 現状 `build-glyphs.mjs` の `GLYPH_STACK` と `poc/label.ts` の
  `GLYPH_STACK` が別々にハードコードされ、コメントの申し合わせでしか結合していない。本番フォントへ
  切り替える際に片方だけ変えると glyphs URL が 404 になり、**MapLibre はエラーを出さず文字が消えるだけ**。
  対策: 生成側が `public/fonts/manifest.json` にスタック名を書き出し、本番コードがそれを読む（単一情報源化）。
  最低限、起動時に glyphs URL を1回プローブし 404 なら明示的にエラー表示する。
- **[HIGH] 閉じた codepoint 集合のドリフト検知**: `localIdeographFontFamily:false` により CJK は
  必ずサーバー PBF を要求する一方、PBF は既知有限集合しか焼いていない。ラベル文字列が1字でも増えて
  `collectCodepoints()` の再同期を忘れると、その字だけ 404＝空白になる。対策: 表示しうる文字列を
  単一の抽出関数に集約して生成側と本番側で共有する／dev アサーションで「収集 codepoint」と「実使用
  codepoint」を突合する。
- **[MEDIUM] ビルドパイプライン統合**: `public/fonts/` は gitignore・`npm run build` は `build:glyphs` を
  呼ばない。本採用時は `build` に前置するか CI の独立ステップにする（未生成マシンでは B案が 404 で無音に壊れる）。
- **[MEDIUM] スタック名のスラッグ化**: スペースを含む名前（`Yu Gothic`・`Noto Sans JP Regular`）が
  そのままディレクトリ名・URL セグメントになる。URL/FS 安全なスラッグと表示用ファミリー名を分離すると堅い
  （複数フォント併記時の `,` 混入対策にもなる）。

## 6. 依存（devDependencies・ビルド時のみ・実行時バンドル非影響）

`@mapbox/tiny-sdf` / `@napi-rs/canvas` / `pbf`。いずれも `scripts/build-glyphs.mjs`（Node ビルドスクリプト）
専用で、アプリの実行時バンドルには載らない。
