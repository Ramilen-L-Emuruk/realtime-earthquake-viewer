// @vitest-environment jsdom
//
// 「いま声が語っている緊急地震速報」の印。
//
// 同時に複数が発表されると読み上げは eventId をまたいで交錯し、震源名を声にするのは
// 第 1 段だけなので、予想値の発話を聞いてもどの地震のものか判らない（理由は
// `hooks/useEewSpeakingCard.ts`）。**「どちらか」を画面が担う**ので、鍵の引き当てと
// 縁の強調はここで固定する —— 外れても症状は「カードが光らない」だけで例外もログも出ない。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert } from '../../types/earthquake'

afterEach(cleanup)

/**
 * jsdom は `scrollIntoView` を持たない（ブラウザには必ずある）。**全テストで生やす** ——
 * 印が付いた時点で実装が呼ぶので、寄せることに関心の無いテストでも要る。
 */
let scrollSpy = vi.fn()
beforeEach(() => {
  scrollSpy = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrollSpy, writable: true, configurable: true })
})

function makeEEW(eventId: string, name: string): EEWAlert {
  return {
    kind: 'eew',
    id: `id-${eventId}`,
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name, latitude: 36.2, longitude: 141.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId, serial: '1', time: '2026-01-01T12:00:00Z' },
  } as EEWAlert
}

/** カードのルート要素（`box-shadow` を持つ入れ物）を震央地名から引く。 */
function cardOf(container: HTMLElement, name: string): HTMLElement {
  const cards = [...container.querySelectorAll<HTMLElement>('div.bg-card')]
    .filter(c => (c.textContent ?? '').includes(name))
  expect(cards.length).toBeGreaterThan(0)
  return cards[0]
}

/** 語っている印が付いているか（外側へ添える白のリングで判定する）。 */
const isLit = (el: HTMLElement) => el.style.boxShadow.includes('255,255,255') || el.style.boxShadow.includes('255, 255, 255')

const renderTab = (eews: EEWAlert[], speakingEewKey?: string | null) =>
  render(
    <RealtimeTab
      eews={eews}
      swaveArrival={null}
      kyoshinV2Detections={[]}
      kyoshinDetectedPoints={[]}
      visible
      speakingEewKey={speakingEewKey}
    />,
  )

describe('いま声が語っているカードの印', () => {
  // 正: 鍵が一致したカードにだけ印が付く。
  it('鍵が一致したカードにだけ印が付く', () => {
    const { container } = renderTab([makeEEW('evt-A', '宮城県沖'), makeEEW('evt-B', '日向灘')], 'evt-B')
    expect(isLit(cardOf(container, '日向灘'))).toBe(true)
    expect(isLit(cardOf(container, '宮城県沖'))).toBe(false)
  })

  // 対照: 語っていなければどのカードにも付かない。**null と undefined の両方**を通す ——
  // 受け取る側は任意 props なので、渡していない端末（undefined）でも同じでなければならない。
  it('語っていなければどこにも付かない', () => {
    for (const key of [null, undefined]) {
      const { container, unmount } = renderTab([makeEEW('evt-A', '宮城県沖')], key)
      expect(isLit(cardOf(container, '宮城県沖'))).toBe(false)
      unmount()
    }
  })

  // 安全弁: **区分の色（枠線）は印で塗り替えない。** あれは予報／警報／特別警報を表しており、
  // 強調のために触ると区分が読めなくなる。
  it('印が付いても枠線の色は変わらない', () => {
    const eews = [makeEEW('evt-A', '宮城県沖')]
    const off = renderTab(eews, null)
    const borderOff = cardOf(off.container, '宮城県沖').style.border
    off.unmount()
    const on = renderTab(eews, 'evt-A')
    const card = cardOf(on.container, '宮城県沖')
    expect(card.style.border).toBe(borderOff)
    expect(isLit(card)).toBe(true)
  })

  // 正: 印が付いたら視野へ入れる。**`block: 'nearest'` を渡すこと** —— 既定（`'start'`）だと
  // 視野内にあるカードまで先頭へ引き寄せ、見ている位置を奪う。
  it('印が付いたカードを視野へ入れる（視野内なら動かさない指定で）', () => {
    renderTab([makeEEW('evt-A', '宮城県沖')], 'evt-A')
    expect(scrollSpy).toHaveBeenCalled()
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ block: 'nearest' })
  })

  // 安全弁: **別のタブを見ている・パネルを畳んでいる間は寄せない。** 戻ってきたときに
  // 勝手に位置が動いていることになる。
  it('見えていないときは寄せない', () => {
    render(
      <RealtimeTab
        eews={[makeEEW('evt-A', '宮城県沖')]}
        swaveArrival={null}
        kyoshinV2Detections={[]}
        kyoshinDetectedPoints={[]}
        visible={false}
        speakingEewKey="evt-A"
      />,
    )
    expect(scrollSpy).not.toHaveBeenCalled()
  })
})
