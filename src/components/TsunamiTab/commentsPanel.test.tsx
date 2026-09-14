// @vitest-environment jsdom
//
// バナーの行動指示の行から開く付加文の面（→ docs/spec/tsunami-spec.md §9
// 「気象庁が書いた文は、行動指示の行から開く」）を固定する。
//
// ここは**描いてみないと確かめられない**ことばかり集まっている —— 行が入口を兼ねるか、
// 開いた面がいつ閉じるか、取消しの表示中に押せてしまわないか。どれも型検査も
// `evacuationActionLine` のユニットテストも素通りする。
//
// **ここで捕まえられないもの。** 「閉じる」判定の前回値を ref で持つと、React が捨てた
// レンダーでも ref の書き換えだけが残り、描き直したときに閉じそこねる。その形は
// 実機（dev サーバー）では再現したが、このテストは通ってしまった。**レンダーの取り消しが
// 絡む欠陥はここでは出ない**ので、実機での確認を省かないこと。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TsunamiTab } from './index'
import type { JMATsunami, TsunamiArea } from '../../types/earthquake'

afterEach(cleanup)

// jsdom は ResizeObserver を持たない。バナーとパネルの実寸は callback ref で測っているので、
// 何もしない実装を置いて描画だけ通す（高さは 0 のままで、この面の開閉には影響しない）。
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

// 実電文の原文（2024-01-01 能登半島地震 16:12 の VTSE41）。1 行目が文として完結している側。
const WARN_SENTENCE = 'ただちに避難してください。\n　\n＜津波警報＞\n津波による被害が発生します。'
// 実電文の原文（同 20:30 の VTSE41）。1 行目が節の見出しで、行動指示には採れない側。
const WARN_HEADING = '＜津波警報＞\n津波による被害が発生します。'
// 面が開いているかは、行動指示の行に出ない 2 行目以降で見分ける。
const BODY_ONLY = '津波による被害が発生します。'

function makeTsunami(overrides: Partial<JMATsunami> = {}): JMATsunami {
  const areas: TsunamiArea[] = [
    { code: '100', name: '岩手県', grade: 'Warning', immediate: true, maxHeight: { description: '3m', value: 3.0 } },
  ]
  return {
    kind: 'tsunami',
    id: 'test-tsunami-1',
    eventId: '20260420165000',
    time: '2026-04-20T16:50:00Z',
    cancelled: false,
    issue: { source: 'テスト', time: '2026-04-20T16:50:00Z', type: 'Focus' },
    areas,
    warningComments: [{ key: 'VTSE41', text: WARN_SENTENCE }],
    ...overrides,
  }
}

const renderTab = (tsunamis: JMATsunami[]) => render(<TsunamiTab tsunamis={tsunamis} isVisible />)

describe('バナーから開く付加文の面', () => {
  // 正: 行動指示の行が入口を兼ね、押すと気象庁の文が出る。
  it('行動指示の行を押すと付加文が開く', () => {
    const { container } = renderTab([makeTsunami()])
    // 行には固定付加文の 1 行目が出ている（アプリの文ではない）
    expect(screen.getByText('ただちに避難してください。')).toBeTruthy()
    expect(container.textContent).not.toContain(BODY_ONLY)

    fireEvent.click(screen.getByRole('button'))
    expect(container.textContent).toContain(BODY_ONLY)
  })

  // 対照: 1 行目が節の見出しの報では、行はアプリの文へ戻る。それでも入口ではある。
  it('1 行目が見出しならアプリの文を出し、それでも開ける', () => {
    const { container } = renderTab([makeTsunami({ warningComments: [{ key: 'VTSE41', text: WARN_HEADING }] })])
    expect(screen.getByText('海岸・河川から直ちに離れてください')).toBeTruthy()
    expect(container.textContent).not.toContain(BODY_ONLY)

    fireEvent.click(screen.getByRole('button'))
    expect(container.textContent).toContain(BODY_ONLY)
  })

  // 正: 満潮時刻や観測の続報は数分おきに届く。そのたびに閉じると読んでいる途中で毎回消える。
  it('等級が動かない続報では開いたまま', () => {
    const { container, rerender } = renderTab([makeTsunami()])
    fireEvent.click(screen.getByRole('button'))
    expect(container.textContent).toContain(BODY_ONLY)

    // 報が進み、観測点だけが増えた続報（区域と等級は同じ）
    const next = makeTsunami({
      id: 'test-tsunami-2',
      time: '2026-04-20T16:56:00Z',
      observations: [{ name: '久慈港', height: { value: 0.3, description: '0.3m' } }],
    })
    rerender(<TsunamiTab tsunamis={[next]} isVisible />)
    expect(container.textContent).toContain(BODY_ONLY)
  })

  // 対照: 面は下の区域一覧を覆う。等級が動いた報まで覆い続けると、引き上げや一部解除が目に入らない。
  it('区域の等級が動いた続報では閉じる', () => {
    const { container, rerender } = renderTab([makeTsunami()])
    fireEvent.click(screen.getByRole('button'))
    expect(container.textContent).toContain(BODY_ONLY)

    const upgraded = makeTsunami({
      id: 'test-tsunami-2',
      time: '2026-04-20T16:56:00Z',
      areas: [{ code: '100', name: '岩手県', grade: 'MajorWarning', immediate: true, maxHeight: { description: '5m', value: 5.0 } }],
    })
    rerender(<TsunamiTab tsunamis={[upgraded]} isVisible />)
    expect(container.textContent).not.toContain(BODY_ONLY)
  })

  // 安全弁: 取消し・解除の表示中は中身を出さない。押せる見た目だけ与えると、
  // 何も起きない理由が利用者に分からない。
  it('取消しの表示中は入口にしない', () => {
    const { container } = renderTab([makeTsunami({ cancelled: true, cancelledAt: new Date('2026-04-20T18:00:00Z') })])
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).not.toContain(BODY_ONLY)
  })
})

// 読み上げに合わせた自動展開（→ docs/spec/audio-tts-spec.md §6「読み上げに合わせて気象庁の文を開く」）。
//
// **バナー 4 種と同じフック（`useAutoOpenWhileSpeaking`）に寄せてある。** 自前で組んでいた頃は
// 「手で開き直したら読み終わりで閉じない」が抜けており、利用者が開いた面を読み終わりで閉じていた。
// フックの単体テストとは別に、**この画面で実際に繋がっていること**をここで固定する。
describe('読み上げに合わせて気象庁の文を開く', () => {
  const renderWithSpeech = (speaking: boolean, tsunamis = [makeTsunami()]) =>
    render(<TsunamiTab tsunamis={tsunamis} isVisible speakingTelegramText={speaking} />)

  // 正: 読み始めで開き、読み終わりで閉じる
  it('読み始めで開き、読み終わりで閉じる', () => {
    const { container, rerender } = renderWithSpeech(false)
    expect(container.textContent).not.toContain(BODY_ONLY)

    rerender(<TsunamiTab tsunamis={[makeTsunami()]} isVisible speakingTelegramText />)
    expect(container.textContent).toContain(BODY_ONLY)

    rerender(<TsunamiTab tsunamis={[makeTsunami()]} isVisible speakingTelegramText={false} />)
    expect(container.textContent).not.toContain(BODY_ONLY)
  })

  // 安全弁: **手で開き直したものは、読み終わりで閉じない。**
  // 自前実装だったときに抜けていた分岐（自動で開く → 手で閉じる → 手で開き直す → 読み終わり）。
  it('読み上げ中に手で開き直したら、読み終わりで閉じない', () => {
    const { container, rerender } = renderWithSpeech(true)
    expect(container.textContent).toContain(BODY_ONLY)

    // 手で閉じる → 手で開き直す
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(container.textContent).not.toContain(BODY_ONLY)
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(container.textContent).toContain(BODY_ONLY)

    rerender(<TsunamiTab tsunamis={[makeTsunami()]} isVisible speakingTelegramText={false} />)
    expect(container.textContent).toContain(BODY_ONLY)
  })

  // 安全弁: 読み上げ中に手で閉じたら、その読み上げのあいだは開き直さない
  it('読み上げ中に手で閉じたら、そのまま閉じたままにする', () => {
    const { container, rerender } = renderWithSpeech(true)
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(container.textContent).not.toContain(BODY_ONLY)

    // 同じ読み上げが続いても開き直さない
    rerender(<TsunamiTab tsunamis={[makeTsunami()]} isVisible speakingTelegramText />)
    expect(container.textContent).not.toContain(BODY_ONLY)
  })

  // 対照: 利用者が手で開いていたものは、読み終わりで閉じない
  it('読み上げの前から手で開いていたものは、読み終わりで閉じない', () => {
    const { container, rerender } = renderWithSpeech(false)
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(container.textContent).toContain(BODY_ONLY)

    rerender(<TsunamiTab tsunamis={[makeTsunami()]} isVisible speakingTelegramText />)
    rerender(<TsunamiTab tsunamis={[makeTsunami()]} isVisible speakingTelegramText={false} />)
    expect(container.textContent).toContain(BODY_ONLY)
  })
})
