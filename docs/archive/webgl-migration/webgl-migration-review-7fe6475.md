# `worktree/feat/webgl-migration` 現時点レビュー（`7fe6475` まで・2026-07-27）

> 対象: `da119cc`（main・v3.23.2）からの差分。20コミット・F0〜F7・141ファイル・+6451/-3023行。
> `7fe6475`（F7・Leaflet完全撤去）まで到達。
> 前提: `worktree/feat/webgl-poc` でのPoC検証がGO判定済み（カメラ操作・毎秒更新・非加算合成・
> EEW複合負荷はいずれもMapLibre優位/クリア、テキスト描画はグリフPBF自前生成＋起動時ウォームで対処）。
>
> **総評: 技術的な骨格は健全。そのまま伸ばして進めて差し支えない水準。**
> **ただし、PoC段階で指摘した「フォントスタック名の単一情報源化」がここでも未解決のまま
> 本番実装に持ち越されている（HIGH）。次の小さな修正コミットで先に潰しておくことを推奨。**

---

## 1. [HIGH] フォントスタック名が生成側とアプリ側で独立ハードコードのまま

- `scripts/build-glyphs.mjs:58` — `let FONT_FAMILY = process.env.GLYPH_FAMILY ?? 'Noto Sans JP'`
  （`STACK` はここから決まり `public/fonts/<STACK>/` の出力ディレクトリ名になる）
- `src/components/Map/LabelsGL.tsx:28` — `const JP_TEXT_FONT = ['Noto Sans JP']`
  （symbolレイヤーの`text-font`に使われ、MapLibreがこの値を glyphs URL の `{fontstack}` に展開する）

両者を結ぶ共有定数・importは無く、コメントでの「完全一致させること」という手動運用に頼っているだけ。
将来どちらか一方だけ変更されると（例: `GLYPH_FAMILY` 環境変数でビルドし直す、`LabelsGL.tsx` 側だけ
別フォントに差し替える等）、`glyphs` フェッチURLのディレクトリ名と実際の `public/fonts/` 配下の
ディレクトリ名がずれ、**MapLibreはエラーを出さず該当テキストが消えるだけ**になる
（背景・レイヤー自体は正常に見えるためデバッグしにくいサイレント障害）。

PoC文書（`webgl-glyph-pipeline-b-2026-07-28.md` §5「本番実装で必ず潰すサイレント障害」）で
既に指摘されていた懸念が、そのまま本番実装に持ち越された形。

**Fix案**: `src/components/Map/gl/` あたりに `JP_FONT_STACK = 'Noto Sans JP'` を定義するTS定数を置き、
`LabelsGL.tsx` はそこから import、`build-glyphs.mjs` は同じ値をJSON等で共有するか、最低限
`npm run build:glyphs` 実行時にアプリ側の定数値と突き合わせて不一致ならエラー終了するチェックを入れる。

## 2. [MEDIUM] 地方名9件が二重管理

`scripts/build-glyphs.mjs` の `collectCodepoints()` は都道府県名・区域名を `public/data/prefectures.json`・
`subregions.json` から直接読み込んでおり、実行時ロード元（`LabelsGL.tsx`が使う`loadPrefectures`/
`loadSubRegions`）と同一データソースのため確実に同期する。一方、**地方名9件（'北海道','東北',…）は
`build-glyphs.mjs` 内にリテラル配列として再定義**されており、`src/utils/regions.ts` の `REGIONS` 配列とは
import関係が無い独立コピー（内容は一致しているが非連動）。地方区分が変わることは考えにくく実害の確率は
低いが、1.のフォントスタック名と同種の「コメントで一致を約束する」パターンであり、ついでに直しておくと安心。

## 3. [情報] `npm run build` は `build:glyphs` を含まないが、生成物コミット済みのため実害なし

`package.json`の`build`は`tsc -b && vite build`のみで`build-glyphs.mjs`を呼ばない。ただし
`public/fonts/Noto Sans JP/*.pbf`は生成物として本diffにバイナリごとコミット済みで、
`station-coords.json`等の既存の「生成スクリプトは手動実行・出力はgit管理下」という
プロジェクト規約と同じ運用。CLAUDE.mdの補助コマンド表にも`build-glyphs.mjs`が追記済み。

**残る注意点（プロセス上・コードのバグではない）**: 将来`prefectures.json`/`subregions.json`を
再生成したのに`build-glyphs.mjs`の再実行を忘れると、新規区域名の文字だけ404で空白表示になるリスクは残る。

## 4. F7（Leaflet完全撤去）— 問題なし

- `git grep`で`from 'leaflet'` / `react-leaflet`の実importがブランチ全体で0件（残る"leaflet"ヒットは
  全て日本語コメント中の「Leaflet版」という説明語）
- `package.json`のdependencies/devDependenciesに`leaflet`/`react-leaflet`/`leaflet.heat`/
  `@types/leaflet*`は無し
- `mapEngine`/`VITE_MAP_ENGINE`/`MapEngine`の分岐残存も0件（`MapView`は`JapanMapGL`への薄いラッパーのみ）
- `src/index.css`のLeaflet専用クラスも撤去済み
- 15の旧実装ファイルが`7fe6475`で完全削除、参照元はすべて新実装（各`*GL.tsx`）に切り替わっている

デッドコード・未使用importの残存は確認できなかった。

## 5. カメラ追従（`CameraFollowsGL.tsx`・`gl/camera.ts`）— 概ね妥当

- `isAutoFlyingRef`を各自動`flyTo`/`fitBounds`呼び出し直前に同期的に立て、`zoomstart`/`dragstart`
  ハンドラでガードして「自動アニメ由来のイベント」と「ユーザー操作」を区別する設計は、PoCの知見
  （EEW複合負荷時のflyToと予報円100ms更新の共存）を踏襲できている
- EEW新規発報→震源/波円フィット、EEW解除→検知点/日本全体復帰、波円成長時の再フィット等の各ケースが
  個別に管理され、`FitToDetectionGL`・`FitToCandidateGL`・`FitToEEWGL`間の優先順位も実装されている
- **[LOW・確証度低いため未格上げ]** `onInteraction`は`isAutoFlyingRef.current`が真の間は完全に無視するため、
  自動flyToアニメーション中にユーザーがドラッグで割り込んだ場合、`userInteractedRef`が立たない可能性。
  発生条件が狭いウィンドウのため具体的な再現手順は未確認

## 6. カスタムWebGLレイヤー（`gl/subThresholdLayer.ts`）— 問題なし

`onRemove`で`program`/`framebuffer`/`texture`/`buffer`を全て`delete*`しておりGLリソースリークは無い。
PoC MEDIUM1指摘（フィードバックループ回避）もコメント付きで反映されている。

## 7. 一般的なコード品質

- 新規GLコンポーネント群はいずれも350行以下（最大`CameraFollowsGL.tsx`350行）で800行上限から外れていない
- `JapanMapGL.tsx`のuseEffect（map初期化）は`m.off`/`mapRef.current = null`/`m.remove()`を
  全てcleanupで行っており、イベントリスナー解除漏れは見当たらない
- `useQuakeLayerData.ts`はLeaflet版と共有していた導出ロジックを一箇所に集約、DRYに沿っている
- テストファイルは本diffに0件追加。ただしmain（`da119cc`）時点でも`src/components/Map/`以下に
  単体テストが無かったのと同じ状態で、本PR固有の後退ではない

---

## 8. レビュー側での確認手段

| 確認項目 | 手段 | 結果 |
|---|---|---|
| Leaflet依存の完全撤去 | `git grep` でimport・package.json・環境分岐フラグを横断検索 | 0件 |
| フォントスタック名の単一情報源化 | `LabelsGL.tsx`と`build-glyphs.mjs`の該当定数を突合 | 独立ハードコード（HIGH） |
| 地方名の同期 | `regions.ts`と`build-glyphs.mjs`のリテラル配列を突合 | 内容一致だが非連動（MEDIUM） |
| GLリソース解放 | `subThresholdLayer.ts`の`onRemove`実装を確認 | 全リソース解放済み |
| カメラ制御の競合回避 | `CameraFollowsGL.tsx`のref管理・イベントガードを確認 | 概ね妥当、LOW指摘1件（未格上げ） |
