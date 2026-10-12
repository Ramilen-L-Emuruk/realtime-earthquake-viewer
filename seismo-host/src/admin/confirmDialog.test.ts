// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { confirmDialog, dismissConfirmDialog } from './confirmDialog'

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="alertdialog"]')
}

function button(cls: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`.${cls}`)
  if (el === null) throw new Error(`${cls} が無い`)
  return el
}

const OPTIONS = { title: '観測点「北の壁」を削除しますか？', body: null, confirmLabel: '削除する' } as const

afterEach(() => {
  document.body.innerHTML = ''
})

describe('confirmDialog', () => {
  it('見出し・本文・ボタンを出す。本文が null なら本文の段を置かない', () => {
    void confirmDialog(document, { title: '編集中の内容を破棄しますか？', body: '保存していない変更は失われます。', confirmLabel: '破棄する' })
    expect(dialog()?.textContent).toContain('編集中の内容を破棄しますか？')
    expect(dialog()?.textContent).toContain('保存していない変更は失われます。')
    expect(button('confirm-ok').textContent).toBe('破棄する')
    expect(button('confirm-cancel').textContent).toBe('キャンセル')
    button('confirm-cancel').click()

    void confirmDialog(document, OPTIONS)
    expect(document.querySelector('.confirm-body')).toBeNull()
    expect(dialog()?.getAttribute('aria-describedby')).toBeNull()
  })

  it('文字列はエスケープして入れる（観測点の名前は自由入力）', () => {
    void confirmDialog(document, { title: '<img src=x>', body: '<b>', confirmLabel: '<i>' })
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.confirm-dialog b')).toBeNull()
    expect(dialog()?.textContent).toContain('<img src=x>')
  })

  it('正: 押した結果のボタンで true、窓は消える', async () => {
    const result = confirmDialog(document, OPTIONS)
    button('confirm-ok').click()
    await expect(result).resolves.toBe(true)
    expect(dialog()).toBeNull()
  })

  it('対照: キャンセル・Escape・外側のクリックで false', async () => {
    let result = confirmDialog(document, OPTIONS)
    button('confirm-cancel').click()
    await expect(result).resolves.toBe(false)

    result = confirmDialog(document, OPTIONS)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(result).resolves.toBe(false)

    result = confirmDialog(document, OPTIONS)
    ;(document.querySelector('.confirm-backdrop') as HTMLElement).click()
    await expect(result).resolves.toBe(false)
    expect(dialog()).toBeNull()
  })

  it('安全弁: 窓の中のクリックでは閉じない（外側の判定に巻き込まない）', () => {
    void confirmDialog(document, OPTIONS)
    ;(document.querySelector('.confirm-title') as HTMLElement).click()
    expect(dialog()).not.toBeNull()
  })

  it('安全弁: 最初のフォーカスはキャンセル（Enter の押しっぱなしで消さない）', () => {
    void confirmDialog(document, OPTIONS)
    expect(document.activeElement).toBe(button('confirm-cancel'))
  })

  it('閉じたら、開く前にフォーカスがあった所へ戻す', async () => {
    document.body.innerHTML = '<button class="origin">元</button>'
    const origin = document.querySelector<HTMLButtonElement>('.origin')!
    origin.focus()
    const result = confirmDialog(document, OPTIONS)
    button('confirm-cancel').click()
    await result
    expect(document.activeElement).toBe(origin)
  })

  it('Tab は窓の 2 つのボタンの間を行き来する（後ろの画面へ出ない。ボタンが 2 つなので Shift の有無は問わない）', () => {
    void confirmDialog(document, OPTIONS)
    const cancel = button('confirm-cancel')
    const ok = button('confirm-ok')
    ok.focus()
    ok.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(cancel)
    cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(ok)
  })

  it('安全弁: Escape は窓の外の聞き手へ届けない（説明の吹き出しなど、後ろの画面を閉じさせない）', async () => {
    let outer = 0
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') outer++
    }
    window.addEventListener('keydown', onKey)
    const result = confirmDialog(document, OPTIONS)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(result).resolves.toBe(false)
    window.removeEventListener('keydown', onKey)
    expect(outer).toBe(0)
  })

  it('正: タブを替えるとき（dismissConfirmDialog）、開いている窓は false で閉じる', async () => {
    const result = confirmDialog(document, OPTIONS)
    dismissConfirmDialog()
    await expect(result).resolves.toBe(false)
    expect(dialog()).toBeNull()
  })

  it('対照: 開いている窓が無いときの dismissConfirmDialog は何もしない', () => {
    expect(() => dismissConfirmDialog()).not.toThrow()
    expect(dialog()).toBeNull()
  })

  it('安全弁: 開いている間に次を開いたら、前の問いは false で閉じ、窓は 1 つだけ', async () => {
    const first = confirmDialog(document, OPTIONS)
    const second = confirmDialog(document, { title: '次', body: null, confirmLabel: '削除する' })
    await expect(first).resolves.toBe(false)
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1)
    button('confirm-ok').click()
    await expect(second).resolves.toBe(true)
  })

  it('安全弁: 閉じた後の Escape は何もしない（聞き手を残さない）', async () => {
    const result = confirmDialog(document, OPTIONS)
    button('confirm-ok').click()
    await result
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(dialog()).toBeNull()
  })
})
