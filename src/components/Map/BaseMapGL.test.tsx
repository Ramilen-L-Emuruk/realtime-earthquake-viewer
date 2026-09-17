// @vitest-environment jsdom
//
// 海底地形の先読みが**録画モードのときだけ**走ることを固定する。
//
// 止めたいのは据え置きの端末が配信元へ毎時 1,911 リクエストを出し続ける状態で、ブラウザ実測では
// 効いていることを確かめてある（録画 OFF で視野内のタイルだけ、録画 ON で 15 秒時点 1,753 件）。
// **その実測は、依存配列や早期 return を書き換えたときに再現されない。** 実測で分かるのは
// 「そのときのコードがそうだった」ことだけなので、条件そのものをここで押さえる。
//
// 先読みの中身（巡回・打ち切り・節約設定の判定）は `utils/gebcoPrefetch.test.ts` の担当。
// ここで見るのは**呼ばれるか・呼ばれないか**と、やめたときに止まるかだけ。
//
// 偽 map は `./testing/fakeMapGL`（同じ役割の代役は他にもある。役割の違いと寄せていない理由は
// `fakeMapGL.ts` の冒頭）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'

// `vi.mock` の factory は巻き上げられるので、スパイもそこから見える形で作る。
const { prefetchSpy } = vi.hoisted(() => ({
  prefetchSpy: vi.fn<(signal: AbortSignal) => void>(),
}))

// **全置換にしない。** このモジュールは `BATHYMETRY_URL` と `GEBCO_*` の定数も export しており、
// `BaseMapGL` がラスタ層の定義に使う。原物を残して先読みの起動だけ差し替える。
vi.mock('../../utils/gebcoPrefetch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/gebcoPrefetch')>()),
  startBathymetryPrefetch: prefetchSpy,
}))

// 陸地塗り・境界線は生成データ（遅延読込）の到着後に追加される。解決しない Promise で止めて、
// その後段（共有ソースの追加・区域ポップアップの登録）を走らせない。**このテストの対象は
// `[map, recording]` 依存の別の effect** なので、止めてもそちらは通る。
//
// reject でも空データでもなく pending にする理由: reject は取得失敗の警告を 2 本出してテストの
// 出力を汚し、空データは後段が走るぶん偽 map へ要求するメソッドが増える。
vi.mock('../../utils/prefectures', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/prefectures')>()),
  loadPrefectures: () => new Promise<never>(() => {}),
}))
vi.mock('../../utils/subregions', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/subregions')>()),
  loadSubRegions: () => new Promise<never>(() => {}),
}))

import { BaseMapGL } from './BaseMapGL'
import { MapGLContext } from './mapGLContext'
import { createFakeMapGL } from './testing/fakeMapGL'

// BaseMapGL の高解像度ラスタ層の id（同ファイルの `LYR_GEBCO`）。コンポーネントが実際に
// レンダーを終えたかどうかの目印に使う。
const LYR_GEBCO = 'gebco-raster'

interface Props {
  showBathymetry: boolean
  recording: boolean
}

function renderMap(map: MapLibreMap | null, props: Props) {
  const view = (p: Props) => (
    <MapGLContext.Provider value={map}>
      <BaseMapGL {...p} />
    </MapGLContext.Provider>
  )
  const result = render(view(props))
  return { update: (p: Props) => result.rerender(view(p)) }
}

/** 直近の呼び出しで渡された signal。まだ呼ばれていなければ落とす。 */
function signalOf(callIndex: number): AbortSignal {
  const call = prefetchSpy.mock.calls[callIndex]
  expect(call, `${callIndex + 1} 回目の呼び出しが無い`).toBeDefined()
  return call[0]
}

describe('海底地形の先読みは録画モードのときだけ走る', () => {
  beforeEach(() => {
    prefetchSpy.mockClear()
  })
  afterEach(cleanup)

  // 正
  it('録画モードなら先読みが始まる', () => {
    const fake = createFakeMapGL()
    renderMap(fake.map, { showBathymetry: true, recording: true })

    expect(prefetchSpy).toHaveBeenCalledTimes(1)
    expect(signalOf(0).aborted).toBe(false)
  })

  // 対照
  it('録画モードでなければ先読みは始まらない', () => {
    const fake = createFakeMapGL()
    renderMap(fake.map, { showBathymetry: true, recording: false })

    // **ラスタ層が載ったことを併せて見る。** 見ないと、コンポーネントが例外で
    // 何もしなかった場合にもこのテストは通ってしまい、対照として意味を持たない。
    expect(fake.layerIds()).toContain(LYR_GEBCO)
    expect(prefetchSpy).not.toHaveBeenCalled()
  })

  // 対照（もう一方の早期 return）
  it('map がまだ無い間は先読みを始めない', () => {
    renderMap(null, { showBathymetry: true, recording: true })

    expect(prefetchSpy).not.toHaveBeenCalled()
  })

  // 安全弁: やめたときに止まる
  it('録画モードを解くと、渡した signal が abort される', () => {
    const fake = createFakeMapGL()
    const { update } = renderMap(fake.map, { showBathymetry: true, recording: true })
    const signal = signalOf(0)
    expect(signal.aborted).toBe(false)

    update({ showBathymetry: true, recording: false })

    expect(signal.aborted).toBe(true)
    // 解いたあとに新しい巡回を始めていないこと。
    expect(prefetchSpy).toHaveBeenCalledTimes(1)
  })

  // 安全弁: 依存配列に余計なものを入れていない
  it('録画モードのまま他の props が変わっても二重に走らない', () => {
    // `showBathymetry` を依存配列へ足すと、海底地形の表示を切り替えるたびに
    // 巡回が積み増される（前の巡回は abort されるが、リクエストは出てしまう）。
    const fake = createFakeMapGL()
    const { update } = renderMap(fake.map, { showBathymetry: true, recording: true })

    update({ showBathymetry: false, recording: true })
    update({ showBathymetry: true, recording: true })

    expect(prefetchSpy).toHaveBeenCalledTimes(1)
    expect(signalOf(0).aborted).toBe(false)
  })

  // 安全弁: 切り直しても重ならない
  it('録画モードを入れ直すと、新しい signal で 1 本だけ走る', () => {
    const fake = createFakeMapGL()
    const { update } = renderMap(fake.map, { showBathymetry: true, recording: true })
    const first = signalOf(0)

    update({ showBathymetry: true, recording: false })
    update({ showBathymetry: true, recording: true })

    expect(prefetchSpy).toHaveBeenCalledTimes(2)
    const second = signalOf(1)
    expect(second).not.toBe(first)
    // 前の巡回は止まっており、生きているのは新しい 1 本だけ。
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
  })

  // 安全弁: 画面を閉じたら止まる（録画モードのまま外れる経路）
  it('画面から外れると signal が abort される', () => {
    const fake = createFakeMapGL()
    renderMap(fake.map, { showBathymetry: true, recording: true })
    const signal = signalOf(0)

    cleanup()

    expect(signal.aborted).toBe(true)
  })
})
