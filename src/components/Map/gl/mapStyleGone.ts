import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'

// その地図がもうスタイルを持っていないかを判定する小さな述語。**後始末の最中に出る記録を選り分ける
// ためのもの**で、描画の判断には使わない。
//
// MapLibre の `getSource()` / `getLayer()` / `getStyle()` はどれも `this.style?.…` を通しており、
// スタイルが無ければ**例外を投げずに揃って undefined を返す**。そのためスタイルを失った地図に対して
// 後始末が走ると「ソースが無い」「レイヤーが無い」が正常な経路で成立し、それを異常として記録すると
// 開発中のログが埋まる。
//
// **スタイルが無い地図では後始末そのものが要らない。** ソースもレイヤーも一緒に消えているので、
// 外すものが残っていない（`removeSource` / `setLayoutProperty` を呼んでも何も起こらない）。
//
// スタイルが無くなる経路は 2 つある。**どちらも「畳まれた」わけではない**ので、呼び出し側のコメントで
// 片方だけを理由として書かないこと。
//
//   1. `Map.remove()` — 内部で `setStyle(null)` を呼ぶ。開発時は HMR で起きる（`JapanMapGL` の
//      初期化 effect が Fast Refresh で再実行され、cleanup が `m.remove()` を走らせる）
//   2. **WebGL コンテキストロスト** — `Map._contextLost` が `style.destroy()` ののち `style` を
//      落とし、`_contextRestored` で `setStyle()` が呼ばれるまでその状態が続く。復旧までのあいだ
//      この述語は真を返す。描画そのものができない期間なので記録を控えて差し支えないが、
//      **`remove()` だけを想定した書き方をすると次に触る人がこの経路に気づけない**
//
// **そのあと誰がこの地図を触るのかは、経路ごとに違う。** HMR で観測できたのは 2 つ——
// 共有ソースを取り下げる cleanup と、面を描き直す effect の本体（後者はブラウザでスタックを
// 取って確かめた）。**`remove()` が同期的に `moveend` を発火するわけではない**（`remove()` は
// イージングを打ち切る `Camera._stop()` を呼ばないので、購読へ届く経路にはならない。同じ HMR で
// 観測した `moveend` は 1 回だけで、`_afterEase` からの正常な発火でスタイルも生きていた）。
// **どの順序でそうなるかまでは特定していない**ので、呼び出し側でも「この経路で来る」と
// 書き切らないこと ——判定はどこから来ても同じに効く。
//
// **MapLibre を上げたらこの前提を確かめること**（`this.style` の truthy 判定を 3 つの API が
// 共有していること・`remove()` がスタイルを落とすこと）。`skipNoopCameraUpdate.ts` と同じ性質の
// 依存で、崩れても型検査では捕まらない —— ガードが黙って効かなくなるだけ。点検の対象は
// `docs/spec/map-rendering-spec.md` §9「MapLibre を上げたときに確かめるもの」にまとめてある。

/**
 * その地図がスタイルを失っているか（`Map.remove()` された後、または WebGL コンテキストロスト中）。
 *
 * **呼ぶのは「ソースやレイヤーが引けない」と分かった後だけにすること。** `getStyle()` は
 * スタイル全体を直列化するため軽くない。正常な経路では通らない位置に置く。
 *
 * 判定に `isStyleLoaded()` は使えない。スタイルが無いと MapLibre 自身が `warnOnce` で警告を
 * 出すため、ノイズを消すために別のノイズを生むことになる。`loaded()` も使えない——あれは
 * 「読み込みが終わっているか」で、起動直後やタイル取得中にも false を返す。
 *
 * @param map 判定する地図
 * @returns スタイルを失っていれば true
 */
export function isMapStyleGone(map: MapLibreMap): boolean {
  // 型は `StyleSpecification` を返すと宣言しているが、実装は `if (this.style) return
  // this.style.serialize()` でスタイルが無ければ undefined を返す（MapLibre の型が実装より狭い）。
  // キャストはその食い違いを明示するためのもの。
  return (map.getStyle() as StyleSpecification | undefined) === undefined
}
