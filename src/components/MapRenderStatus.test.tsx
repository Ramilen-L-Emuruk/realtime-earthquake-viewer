// @vitest-environment jsdom
//
// 描画物の不調を知らせる帯の**文面**を固定する。
//
// **`renderHealth.test.ts` とは見ているものが違う。** あちらは「どの ID をどう集めるか」で、
// こちらは「集めた結果をどう言うか」。文面の規約は
// `docs/spec/settings-pwa-spec.md` §5.5「通知の文の形」が持ち、その表とここが一致する。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MapRenderStatus } from './MapRenderStatus'
import { reportRenderFailure, resetRenderHealthForTest } from '../utils/renderHealth'

afterEach(() => {
  cleanup()
  resetRenderHealthForTest()
})

describe('描けていないものを知らせる帯', () => {
  it('対照: 不調が無ければ何も描かない', () => {
    const { container } = render(<MapRenderStatus />)

    expect(container.firstChild).toBeNull()
  })

  // **主節は言い切りで止める**（→ §5.5）。丁寧な述語にすると、隣に並ぶ `MapDataStatus` と
  // 文体が食い違う。
  it('正: 描けないものは「〜を描けず」', () => {
    reportRenderFailure('catalog', '長期震源カタログ', 'draw')
    render(<MapRenderStatus />)

    expect(screen.getByText('長期震源カタログを描けず')).toBeTruthy()
  })

  it('正: 掴めないものは「〜はクリックに応じず」', () => {
    reportRenderFailure('stations', '震度観測点', 'interact')
    render(<MapRenderStatus />)

    expect(screen.getByText('震度観測点はクリックに応じず')).toBeTruthy()
  })

  // **この帯だけ括弧を使わない。** 2 つの主節が同じ手掛かりを共有するので、行動の案内は
  // 下の 1 行に置く（→ §5.5）。片方にだけ添えると、もう片方は打つ手が無いように読める。
  it('安全弁: 両方あっても手掛かりの行は 1 本だけ', () => {
    reportRenderFailure('catalog', '長期震源カタログ', 'draw')
    reportRenderFailure('stations', '震度観測点', 'interact')
    render(<MapRenderStatus />)

    expect(screen.getByText('長期震源カタログを描けず')).toBeTruthy()
    expect(screen.getByText('震度観測点はクリックに応じず')).toBeTruthy()
    expect(screen.getAllByText('再読み込みで直ることがあります')).toHaveLength(1)
  })

  // 名前を並べる上限。超えた分は件数へ丸める（全部並べると地図を覆う）。
  it('安全弁: 名前が多ければ「ほか N 件」へ丸める', () => {
    for (const name of ['あ', 'い', 'う', 'え']) reportRenderFailure(name, name, 'draw')
    render(<MapRenderStatus />)

    expect(screen.getByText('あ・い・う ほか 1 件を描けず')).toBeTruthy()
  })
})
