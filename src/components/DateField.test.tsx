// @vitest-environment jsdom
//
// 日付の入力欄を固定する。**ここが「キーボードで打てる」ことの唯一の砦**——
// `<input type="date">` は打鍵の途中で `value` を空文字にする。それを捨てて親の状態を
// 更新せずにいると、React が制御された `value` を書き戻し、打ちかけが元の日付へ巻き戻る。
// この巻き戻しは型検査にも他のテストにも掛からず、人が実際に打つまで出てこない。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DateField } from './DateField'

// 描いたものは自分で片付ける（`globals` を立てていないため。`RangeSlider.test.tsx` と同じ）。
afterEach(cleanup)

const setup = (props: Partial<React.ComponentProps<typeof DateField>> = {}) => {
  const onCommit = vi.fn()
  render(
    <DateField
      label="開始日"
      value="2020-06-15"
      min="1919-01-01"
      max="2026-12-31"
      onCommit={onCommit}
      {...props}
    />,
  )
  return { input: screen.getByLabelText('開始日') as HTMLInputElement, onCommit }
}

describe('DateField', () => {
  // 正: 範囲に収まる日付になったら親へ渡す。
  it('範囲の中の日付は親へ渡す', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '2021-03-04' } })
    expect(onCommit).toHaveBeenCalledWith('2021-03-04')
  })

  // **安全弁: 打鍵の途中で空文字が来ても、打ちかけが巻き戻らない。**
  // これが「キーボードで入力できない」の正体。親の値を書き戻すと、次の打鍵は
  // 別のセグメントへ流れる。
  it('打鍵の途中で空になっても元の日付へ戻さない', () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
  })

  // 対照: そのとき親へは渡さない（読めない値なので）。
  it('空文字では親へ渡さない', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '' } })
    expect(onCommit).not.toHaveBeenCalled()
  })

  // **安全弁: 打鍵の途中の範囲外は親へ渡さない。**
  // 年を打っている間は `0002-…` のような値が来る。そのつど渡すと、通り過ぎるだけの
  // 期間で点群の作り直しと年ファイルの取得が走る。
  it.each(['0002-06-15', '2099-06-15'])('打鍵の途中の %s は親へ渡さない', (value) => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value } })
    expect(onCommit).not.toHaveBeenCalled()
    // ただし表示は打った値のまま（巻き戻さない）。
    expect(input.value).toBe(value)
  })

  // **安全弁: 範囲外のまま離れても確定させない。**
  // 「打ち切った範囲外の日」と「年を打ちかけた途中」は見分けが付かない。確定させると、
  // 年を 3 桁まで打って離れただけで期間が収録の端へ飛ぶ。
  it.each(['2099-06-15', '0202-06-15'])('範囲外の %s のまま離れても確定しない', (value) => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  // 対照: 範囲外のまま離れたら表示も元へ戻る（入らなかったことが分かる）。
  it('範囲外のまま離れたら表示も元へ戻る', () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: '2099-06-15' } })
    fireEvent.blur(input)
    expect(input.value).toBe('2020-06-15')
  })

  // 対照: 離れたら下書きを捨てて親の値へ戻る。
  it('離れたら親の値へ戻る', () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input.value).toBe('2020-06-15')
  })

  // 安全弁: 打ちかけが空のまま離れても親へ渡さない（勝手な日付にしない）。
  it('空のまま離れても親へ渡さない', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  // 安全弁: 何も打たずに離れたときは何も起きない。
  it('触らずに離れても何も起きない', () => {
    const { input, onCommit } = setup()
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  // 対照: 範囲の端はそのまま通す（端で弾かない）。
  it.each(['1919-01-01', '2026-12-31'])('範囲の端 %s は親へ渡す', (value) => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value } })
    expect(onCommit).toHaveBeenCalledWith(value)
  })

  // 安全弁: 無効にしてあるときは打てない。
  it('無効なら操作を受け付けない', () => {
    const { input } = setup({ disabled: true })
    expect(input.disabled).toBe(true)
  })

  // **打鍵の途中は、外から値が変わっても打った内容を優先する。**
  // これは意図した設計——外の値を割り込ませると、まさに直したはずの巻き戻りが復活する。
  // 打ちかけを捨てるのは離れたときだけで、そこで外の値が出る。
  it('打鍵の途中に外から値が変わっても打った内容を出し続ける', () => {
    const onCommit = vi.fn()
    const { rerender } = render(
      <DateField label="開始日" value="2020-06-15" min="1919-01-01" max="2026-12-31" onCommit={onCommit} />,
    )
    const input = screen.getByLabelText('開始日') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    rerender(
      <DateField label="開始日" value="2022-09-09" min="1919-01-01" max="2026-12-31" onCommit={onCommit} />,
    )
    expect(input.value).toBe('')
    // 離れたら外の値が出る。
    fireEvent.blur(input)
    expect(input.value).toBe('2022-09-09')
  })
})
