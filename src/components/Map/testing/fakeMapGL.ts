// MapLibre の map の代わり。`src/components/Map/` 配下のレイヤーコンポーネントを
// レンダーするテストで、`MapGLContext.Provider` へ流し込んで使う。
//
// **本物の MapLibre は jsdom では立たない。** WebGL2 の文脈を作れず `new maplibregl.Map()` が
// 同期的に投げる（→ `docs/spec/map-rendering-spec.md` §12）。レイヤーコンポーネントについて
// 見たいのは「map に対して何を呼んだか」だけなので、呼ばれるメソッドを持つだけの器を立てる。
//
// **持たせるのは、対象のコンポーネントが実際に通る経路で呼ぶメソッドだけ。**
// 足りないものは呼ばれた時点で `TypeError` になる——それが意図。何でも黙って受け止める器にすると、
// コンポーネントが別のメソッドへ移ったことに気づけず、テストだけが通る状態になる。
// 新しいコンポーネントのテストを足すときは、落ちたぶんをここへ追加していけばよい。
//
// **同じ役割の代役が他にもある。** 分かれる軸は 2 つ——**どこへ渡すか**（`MapGLContext` か、
// `gl/*.ts` の純関数へ直接か）と、**何を観測するか**。
//
//   `MapGLContext` へ渡すもの（jsdom）—— 統合の論点があるのはこの 3 つ
//     - これ —— レイヤーとソースの出し入れ
//     - `LabelsGL.test.ts` の `fakeMap()` —— 重なり判定が走った回数（`queryRenderedFeatures`）と、
//       その結果の書き戻し（`setData`）。ペイン寸法と投影も持つ（ラベルの閾値が視野の実距離で決まるため）
//     - `CameraFollowsGL.test.ts` の `createFakeMap()` —— カメラ操作の時系列。視野とズームの状態を
//       実際に動かす。レイヤーの出し入れは見ない
//
//   `gl/*.ts` の純関数へ直接渡すもの（node）—— `gl/*.test.ts` が、対象の関数ごとに別々の代役を
//   持つ。**ここへ一覧も総数も書かない**——形も粒度もまちまちで（ヘルパー関数のものもあれば
//   その場のオブジェクトリテラルのものもある）、テストが増えるたび腐るため。数え上げたいときは
//   `MapLibreMap` / `maplibregl.Map` へのキャストを grep すること
//
// **`LabelsGL.test.ts` とはレイヤー・ソースを扱う点だけが似ているが、寄せられない。** 理由は 3 つ。
//   - `getLayer` の意味が逆。こちらは台帳を引く（`addLayer` した id が返る）。向こうは `addLayer` を
//     台帳へ入れず、`getLayer` は「判定対象のレイヤーが 1 つ在る」ことだけを表す固定値を返す。
//     台帳式へ寄せると判定対象が 0 件になり、重なり判定が 1 回も走らなくなる
//   - `getSource` の返すものが違う（下記の `FakeMapMethods`）
//   - 寄せるには `queryRenderedFeatures` と `project` をここへ生やすことになり、上記の
//     「実際に通る経路で呼ぶメソッドだけ」が崩れる
import type {
  CustomLayerInterface,
  LayerSpecification,
  Map as MapLibreMap,
  SourceSpecification,
  StyleSpecification,
} from 'maplibre-gl'

type AnyLayer = LayerSpecification | CustomLayerInterface
type MapEventHandler = (...args: never[]) => void

/**
 * 偽 map が実装しているメソッド。
 *
 * `maplibregl.Map` の全メンバーは満たせないので、この型を通してから 1 度だけキャストする。
 * どこまで似せてあるかがこの型を読めば分かる形にしてある（呼び出し側で `as any` を撒かない）。
 */
interface FakeMapMethods {
  addSource: (id: string, spec: SourceSpecification) => void
  /**
   * **本物と返すものが違う。** MapLibre の `getSource` が返すのは `GeoJSONSource` 等のオブジェクトで、
   * `addSource` へ渡した spec ではない。いま使っている側が戻り値の中身を見ないので済んでいる。
   * `getSource(id).setData(...)` を呼ぶコンポーネントのテストを足すときは本物の形へ直すこと
   * （`LabelsGL.test.ts` の `fakeMap()` が既にその形になっている）。
   */
  getSource: (id: string) => SourceSpecification | undefined
  removeSource: (id: string) => void
  addLayer: (layer: AnyLayer, beforeId?: string) => void
  getLayer: (id: string) => AnyLayer | undefined
  removeLayer: (id: string) => void
  setLayoutProperty: (id: string, name: string, value: unknown) => void
  on: (type: string, handler: MapEventHandler) => void
  off: (type: string, handler: MapEventHandler) => void
  /**
   * **戻り値の型を本物より広く取っている。** MapLibre の宣言は `StyleSpecification` 固定だが、
   * 実装はスタイルが無ければ undefined を返す（`gl/mapStyleGone.ts`）。ここで固定の型に
   * 合わせると、模したい状態そのものを書けない。
   */
  getStyle: () => StyleSpecification | undefined
}

export interface FakeMapGL {
  /** `MapGLContext.Provider` の `value` へ渡すもの。 */
  map: MapLibreMap
  /** いま載っているレイヤーの id（`addLayer` の呼び出し順）。 */
  layerIds: () => string[]
  /** いま載っているソースの id（`addSource` の呼び出し順）。 */
  sourceIds: () => string[]
  /**
   * スタイルを失った状態にする（`Map.remove()` された後、または WebGL コンテキストロスト中）。
   * 以後 `getStyle` / `getSource` / `getLayer` はそろって undefined を返す——**本物が
   * `this.style?.…` を共有しているため**（`gl/mapStyleGone.ts`）。片方だけ落とすと、
   * コンポーネント側のガードが通る／通らないをテストの都合で作れてしまう。
   */
  loseStyle: () => void
  /** 登録された購読を呼ぶ（`moveend` 等）。 */
  emit: (type: string) => void
  /** `getStyle` が呼ばれた回数。**正常系で呼ばれていないこと**を見るために持つ。 */
  getStyleCalls: () => number
}

/**
 * 偽 map を 1 つ作る。
 *
 * レイヤーとソースは実際に出し入れされるので、`addLayer` した id は `getLayer` が返し、
 * `removeLayer` した id は返さなくなる。コンポーネント側の「あれば消す」形の後始末が
 * そのまま通る。
 */
export function createFakeMapGL(): FakeMapGL {
  const sources = new Map<string, SourceSpecification>()
  const layers = new Map<string, AnyLayer>()
  const listeners = new Map<string, MapEventHandler[]>()
  let styleGone = false
  let getStyleCalls = 0

  const methods: FakeMapMethods = {
    addSource: (id, spec) => {
      sources.set(id, spec)
    },
    getSource: id => (styleGone ? undefined : sources.get(id)),
    removeSource: id => {
      sources.delete(id)
    },
    // **`beforeId` は受け取るだけで並び順に反映しない。** 並びは `gl/layerOrder.ts` の担当で、
    // その検証には挿入位置を持つ器が要る。いま必要にしていないので素直に末尾へ積む。
    // 並び順を検証するテストをこの器で書こうとすると、失敗せずに違う結果を返す点に注意。
    addLayer: layer => {
      layers.set(layer.id, layer)
    },
    getLayer: id => (styleGone ? undefined : layers.get(id)),
    removeLayer: id => {
      layers.delete(id)
    },
    setLayoutProperty: () => {},
    on: (type, handler) => {
      const list = listeners.get(type)
      if (list) list.push(handler)
      else listeners.set(type, [handler])
    },
    off: (type, handler) => {
      const list = listeners.get(type)
      if (!list) return
      const at = list.indexOf(handler)
      if (at >= 0) list.splice(at, 1)
    },
    getStyle: () => {
      getStyleCalls++
      return styleGone ? undefined : ({} as StyleSpecification)
    },
  }

  return {
    map: methods as unknown as MapLibreMap,
    layerIds: () => [...layers.keys()],
    sourceIds: () => [...sources.keys()],
    loseStyle: () => {
      styleGone = true
    },
    // 呼び出し中に `off` されても走っている列を壊さないよう複製してから回す。
    emit: type => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler()
    },
    getStyleCalls: () => getStyleCalls,
  }
}
