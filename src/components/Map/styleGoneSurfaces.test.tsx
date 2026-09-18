// @vitest-environment jsdom
//
// canvas source で面を敷くコンポーネント（自前の推定＝`QuakeIntensitySurfaceGL`）が、
// **スタイルを失った地図に対して異常を記録しない**ことを固定する。
//
// これは `moveend` を購読して面を描き直す作りで、**購読と effect が地図を掴んだまま、その
// 地図がスタイルを失う**ことがある（HMR で起きる。詳細は `gl/mapStyleGone.ts`）。そのとき
// canvas・source・layer は揃って引けなくなるので、素通しにすると開発のたびに
// 「描けなかった」が出る。
//
// **気象庁の推計震度分布図（`QuakeEstimatedIntensityGL`）は対象ではない。** かつては同じ
// canvas source の作りで、対称に判定を置く必要があった（片方でしか観測されない形があるため）。
// WebGL のカスタムレイヤーへ移した後は `moveend` も canvas source も持たず、テクスチャを
// 地理座標へ固定して焼くので、この判定が守る経路そのものが無い。**新しく canvas source で
// 面を敷くものを足したら、ここへ並べること。**
//
// ここで見るのは記録を出すか出さないかだけで、面の中身（補間）は
// `utils/isoseismal.test.ts` の担当。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MapGLContext } from './mapGLContext'
import { createFakeMapGL, type FakeMapGL } from './testing/fakeMapGL'
import { QuakeIntensitySurfaceGL } from './QuakeIntensitySurfaceGL'

// 県境は遅延読込で、届くと陸クリップ用の外接矩形を組む。解決しない Promise で止めて
// 「読み込み待ち」のまま走らせる——このテストが見るガードはその手前にあるので通る
// （`BaseMapGL.test.tsx` が同じ理由で同じ止め方をしている）。
vi.mock('../../utils/prefectures', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/prefectures')>()),
  loadPrefectures: () => new Promise<never>(() => {}),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 面を敷くコンポーネントの共通の形（購読を張り、揃っていなければ記録する）。 */
interface Surface {
  name: string
  /** 出す条件を満たさない形で描く（正常な `hide()` の経路へ落ちる props）。 */
  view: () => ReactElement
  /** 記録の文言に含まれる語。 */
  logPhrase: string
}

const SURFACES: Surface[] = [
  {
    name: '震度の面',
    view: () => <QuakeIntensitySurfaceGL markers={[]} visible={false} />,
    logPhrase: '震度の面を描けなかった',
  },
]

function mount(f: FakeMapGL, surface: Surface) {
  render(<MapGLContext.Provider value={f.map}>{surface.view()}</MapGLContext.Provider>)
}

/**
 * 対象の記録だけを抜き出す。
 *
 * **素の呼び出し回数では数えられない。** 記録を組む時点で `logger.ts` が `serverDate()` を
 * 呼ぶため、時計が未較正だとその警告が先に 1 本挟まる。無関係な警告の有無で結果が変わる形に
 * すると、テストの並び順で落ちたり通ったりする。
 */
function surfaceWarnings(warn: { mock: { calls: unknown[][] } }, surface: Surface): string[] {
  return warn.mock.calls
    .map((c) => String(c[1]))
    .filter((m) => m.includes(surface.logPhrase))
}

describe.each(SURFACES)('$name', (surface) => {
  it('地図がスタイルを失った後の moveend では記録しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = createFakeMapGL()
    mount(f, surface)
    // `Map.remove()` の最中を模す。以後 source も layer も引けない。
    f.loseStyle()
    f.emit('moveend')
    expect(surfaceWarnings(warn, surface)).toEqual([])
  })

  it('スタイルが生きているのに揃っていなければ記録する', () => {
    // ソースだけが外から消された状態。こちらは本物の異常で、黙らせてはいけない。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = createFakeMapGL()
    mount(f, surface)
    for (const id of f.sourceIds()) f.map.removeSource(id)
    f.emit('moveend')
    const warnings = surfaceWarnings(warn, surface)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('canvas / source / layer が揃っていない')
  })

  it('揃っている間はスタイルを覗きに行かない', () => {
    // `getStyle()` はスタイル全体を直列化する。移動のたびに払う代価ではない。
    const f = createFakeMapGL()
    mount(f, surface)
    f.emit('moveend')
    expect(f.getStyleCalls()).toBe(0)
  })
})
