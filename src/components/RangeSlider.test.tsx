// @vitest-environment jsdom
//
// 二つまみのスライダーを固定する。**ここが押し合いの唯一の砦**——つまみは 2 本の独立した
// `<input type="range">` なので、押し合わせを外すと下端が上端を追い越し、絞り込みが
// 恒久的に 0 件になったまま原因も見えなくなる。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RangeSlider, percentOf } from './RangeSlider'

// **描いたものは自分で片付ける。** この構成は `globals` を立てていないので、
// Testing Library が自前で仕込む後始末が働かない。放っておくと前のテストの
// つまみが DOM に残り、名前で引いたときに「複数見つかった」で落ちる。
afterEach(cleanup)

describe('percentOf', () => {
  // 正: 両端と中央。
  it('両端と中央を割り当てる', () => {
    expect(percentOf(0, 0, 10)).toBe(0)
    expect(percentOf(5, 0, 10)).toBe(50)
    expect(percentOf(10, 0, 10)).toBe(100)
  })

  // 対照: 範囲の外は端で止める（帯が溝からはみ出さない）。
  it('範囲の外は端で止める', () => {
    expect(percentOf(-3, 0, 10)).toBe(0)
    expect(percentOf(13, 0, 10)).toBe(100)
  })

  // **安全弁: 幅が 0 でも数値を返す**（収録が 1 年だけの場合。0 除算で NaN を返すと
  // 帯の `left`/`right` が壊れる）。
  it('幅が 0 でも NaN にならない', () => {
    expect(percentOf(5, 5, 5)).toBe(0)
  })
})

describe('RangeSlider', () => {
  const setup = (props: Partial<React.ComponentProps<typeof RangeSlider>> = {}) => {
    const onChange = vi.fn()
    render(
      <RangeSlider label="深さ" min={0} max={100} step={10} from={30} to={70} onChange={onChange} {...props} />,
    )
    return { onChange }
  }

  // 正: それぞれのつまみが自分の側だけを動かす。
  it('つまみは自分の側を動かす', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('深さの下端'), { target: { value: '20' } })
    expect(onChange).toHaveBeenCalledWith(20, 70)
    fireEvent.change(screen.getByLabelText('深さの上端'), { target: { value: '80' } })
    expect(onChange).toHaveBeenCalledWith(30, 80)
  })

  // **安全弁: 下端を上端より先へ送っても追い越さない**（上端が一緒に動く）。
  it('下端は上端を追い越さない', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('深さの下端'), { target: { value: '90' } })
    expect(onChange).toHaveBeenCalledWith(90, 90)
  })

  // **安全弁: 上端を下端より手前へ送っても追い越さない。**
  it('上端は下端を追い越さない', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('深さの上端'), { target: { value: '10' } })
    expect(onChange).toHaveBeenCalledWith(10, 10)
  })

  // 正: 期間には「開始」「終了」を渡せる（「期間の下端」は聞いて何を指すか掴みにくい）。
  it('端の呼び名を差し替えられる', () => {
    setup({ label: '期間', ends: ['開始', '終了'] })
    expect(screen.getByLabelText('期間の開始')).toBeDefined()
    expect(screen.getByLabelText('期間の終了')).toBeDefined()
  })
})
