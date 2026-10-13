// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installTips, tipHtml } from './tip'

let uninstall: () => void = () => {}

function tooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tooltip"]')
}

function isOpen(): boolean {
  const el = tooltip()
  return el !== null && !el.hidden
}

function anchor(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('button.tip')
  if (el === null) throw new Error('説明の付いたラベルが無い')
  return el
}

function pointer(type: string, target: Element, pointerType: string): void {
  // jsdom は PointerEvent を持たないので、pointerType だけ載せた MouseEvent で代える。
  const e = new MouseEvent(type, { bubbles: true })
  Object.defineProperty(e, 'pointerType', { value: pointerType })
  target.dispatchEvent(e)
}

beforeEach(() => {
  document.body.innerHTML = `<div class="host">${tipHtml('ゼロ点', '揺れていないときに読む値です。')}</div><button class="other">別</button>`
  uninstall = installTips(document)
})

afterEach(() => {
  uninstall()
  document.body.innerHTML = ''
})

describe('tipHtml', () => {
  it('ラベルと説明をエスケープする', () => {
    const html = tipHtml('<b>', '"x" & <y>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('data-tip="&quot;x&quot; &amp; &lt;y&gt;"')
    expect(html).not.toContain('<b>')
  })

  it('押せる要素（button type="button"）として出す。フォームの送信にならない', () => {
    document.body.innerHTML = tipHtml('a', 'b')
    const el = anchor()
    expect(el.type).toBe('button')
  })
})

describe('installTips', () => {
  it('正: マウスが乗ると説明を出し、離れると閉じる', () => {
    pointer('pointerover', anchor(), 'mouse')
    expect(isOpen()).toBe(true)
    expect(tooltip()?.textContent).toBe('揺れていないときに読む値です。')
    expect(anchor().getAttribute('aria-describedby')).toBe(tooltip()?.id)
    pointer('pointerout', anchor(), 'mouse')
    expect(isOpen()).toBe(false)
    expect(anchor().hasAttribute('aria-describedby')).toBe(false)
  })

  it('対照: タッチの pointerover では開かない（タップは click で開く）', () => {
    pointer('pointerover', anchor(), 'touch')
    expect(isOpen()).toBe(false)
  })

  it('正: フォーカスで開き、外れると閉じる', () => {
    anchor().focus()
    expect(isOpen()).toBe(true)
    anchor().blur()
    expect(isOpen()).toBe(false)
  })

  it('正: タップ（click）で固定し、もう一度押すと外す', () => {
    anchor().click()
    expect(isOpen()).toBe(true)
    anchor().click()
    expect(isOpen()).toBe(false)
  })

  it('安全弁: ホバー中に押しても閉じない（開いているものを押して消さない）', () => {
    pointer('pointerover', anchor(), 'mouse')
    anchor().click()
    expect(isOpen()).toBe(true)
    // マウスが離れても、押して固定したぶんは残る
    pointer('pointerout', anchor(), 'mouse')
    expect(isOpen()).toBe(true)
  })

  it('安全弁: フォーカスで開いている最中にマウスが通り過ぎても閉じない', () => {
    anchor().focus()
    pointer('pointerover', anchor(), 'mouse')
    pointer('pointerout', anchor(), 'mouse')
    expect(isOpen()).toBe(true)
  })

  it('正: Escape・ほかの所を押す・スクロールで閉じる', () => {
    anchor().click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(isOpen()).toBe(false)

    anchor().click()
    pointer('pointerdown', document.querySelector('.other') as Element, 'mouse')
    expect(isOpen()).toBe(false)

    anchor().click()
    document.querySelector('.host')?.dispatchEvent(new Event('scroll'))
    expect(isOpen()).toBe(false)
  })

  it('対照: ラベル自身を押した pointerdown では閉じない（続く click が固定を外す）', () => {
    anchor().click()
    pointer('pointerdown', anchor(), 'mouse')
    expect(isOpen()).toBe(true)
  })

  it('正: 開いている間に描き直されても、同じラベルが残っていれば付け替えて開いたまま', async () => {
    anchor().click()
    const host = document.querySelector('.host') as HTMLElement
    host.innerHTML = tipHtml('ゼロ点', '揺れていないときに読む値です。')
    await Promise.resolve()
    expect(isOpen()).toBe(true)
    expect(anchor().getAttribute('aria-describedby')).toBe(tooltip()?.id)
  })

  it('安全弁: 描き直しでラベルが消えたら閉じる（吹き出しだけ残さない）', async () => {
    anchor().click()
    const host = document.querySelector('.host') as HTMLElement
    host.innerHTML = ''
    await Promise.resolve()
    expect(isOpen()).toBe(false)
  })

  it('安全弁: 外したら吹き出しも聞き手も残さない', () => {
    uninstall()
    uninstall = () => {}
    expect(tooltip()).toBeNull()
    anchor().click()
    expect(tooltip()).toBeNull()
  })

  it('安全弁: 行（data-tip-row）があれば、ラベルではなく行の下端の下に出す（入力欄を覆わない）', () => {
    // 吹き出しの要素は body の中にあるので、body ごと差し替えずに中身だけ入れ替える
    const host = document.querySelector('.host') as HTMLElement
    host.innerHTML = `<div class="row" data-tip-row>${tipHtml('ゼロ点', '説明')}<input /></div>`
    const row = host.querySelector('.row') as HTMLElement
    row.getBoundingClientRect = () => ({ left: 10, top: 100, bottom: 160, right: 300, width: 290, height: 60, x: 10, y: 100, toJSON: () => ({}) })
    anchor().getBoundingClientRect = () => ({ left: 10, top: 100, bottom: 120, right: 60, width: 50, height: 20, x: 10, y: 100, toJSON: () => ({}) })
    anchor().click()
    // TIP_GAP_PX = 6
    expect(tooltip()?.style.top).toBe('166px')
  })

  it('別のラベルへ移ると、説明もそちらへ替わる', () => {
    document.querySelector('.host')?.insertAdjacentHTML('beforeend', tipHtml('向き', 'その軸が測る向きです。'))
    const [a, b] = Array.from(document.querySelectorAll<HTMLButtonElement>('button.tip'))
    pointer('pointerover', a, 'mouse')
    pointer('pointerout', a, 'mouse')
    pointer('pointerover', b, 'mouse')
    expect(tooltip()?.textContent).toBe('その軸が測る向きです。')
    expect(b.getAttribute('aria-describedby')).toBe(tooltip()?.id)
    expect(a.hasAttribute('aria-describedby')).toBe(false)
  })
})
