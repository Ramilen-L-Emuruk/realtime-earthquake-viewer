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
// **同じ役割の代役が、これとは別に 2 つある。** 用途が違うので統合していない。
//   - `CameraFollowsGL.test.ts` の `createFakeMap()` —— カメラ操作（`flyTo`・`fitBounds`）を
//     spy にして呼び出しを観測するためのもの。視野やズームの状態を持ち、レイヤーの出し入れは見ない
//   - `LabelsGL.test.ts` のインラインのスタブ —— レイヤーとソースの出し入れを見る点はこちらと同じで、
//     加えて `getContainer` でペイン寸法を与える（ラベルの閾値が視野の実距離で決まるため）
//
// **`LabelsGL.test.ts` の側とは役割が重なる。** 寄せるなら向こうをこちらへ移す形になるが、
// ペイン寸法を持つ必要があり、このファイルにその口はまだ無い。
import type {
  CustomLayerInterface,
  LayerSpecification,
  Map as MapLibreMap,
  SourceSpecification,
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
  getSource: (id: string) => SourceSpecification | undefined
  removeSource: (id: string) => void
  addLayer: (layer: AnyLayer, beforeId?: string) => void
  getLayer: (id: string) => AnyLayer | undefined
  removeLayer: (id: string) => void
  setLayoutProperty: (id: string, name: string, value: unknown) => void
  on: (type: string, handler: MapEventHandler) => void
  off: (type: string, handler: MapEventHandler) => void
}

export interface FakeMapGL {
  /** `MapGLContext.Provider` の `value` へ渡すもの。 */
  map: MapLibreMap
  /** いま載っているレイヤーの id（`addLayer` の呼び出し順）。 */
  layerIds: () => string[]
  /** いま載っているソースの id（`addSource` の呼び出し順）。 */
  sourceIds: () => string[]
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

  const methods: FakeMapMethods = {
    addSource: (id, spec) => {
      sources.set(id, spec)
    },
    getSource: id => sources.get(id),
    removeSource: id => {
      sources.delete(id)
    },
    // **`beforeId` は受け取るだけで並び順に反映しない。** 並びは `gl/layerOrder.ts` の担当で、
    // その検証には挿入位置を持つ器が要る。いま必要にしていないので素直に末尾へ積む。
    // 並び順を検証するテストをこの器で書こうとすると、失敗せずに違う結果を返す点に注意。
    addLayer: layer => {
      layers.set(layer.id, layer)
    },
    getLayer: id => layers.get(id),
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
  }

  return {
    map: methods as unknown as MapLibreMap,
    layerIds: () => [...layers.keys()],
    sourceIds: () => [...sources.keys()],
  }
}
