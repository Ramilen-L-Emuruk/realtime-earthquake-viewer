// @vitest-environment jsdom
//
// 行動チェックリストの「閉じたら畳む」挙動の回帰テスト。
//
// 能登のような群発では、余震も続報も次々届く。地震ごとに別物として出し直すと閉じても閉じても
// 現れるため、閉じたあとは小さなボタンへ畳む設計にした。ここで固定するのはその境界
// —— 何をもって畳んだままにし、何をもって開き直すか。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useActionChecklist, SUPPRESS_MS } from './useActionChecklist'
import type { EEWAlert, JMAQuake } from '../types/earthquake'

const MIN = 45 // 震度5弱

function quake(eventKey: string, maxScale: number): JMAQuake {
  return {
    id: eventKey,
    eventKey,
    time: '2026/01/01 16:10:00',
    issue: { source: '', time: '', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2026/01/01 16:10:00',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 16, magnitude: 7.6 },
      maxScale,
      domesticTsunami: 'None',
    },
    points: [],
  } as unknown as JMAQuake
}

const NO_EEWS: readonly EEWAlert[] = []

/** 予想震度を持つ EEW。`eewEventKey` は `issue.eventId` があればそれを見る。 */
function eewAlert(eventId: string, scale: number, cancelled = false): EEWAlert {
  return {
    id: `${eventId}-1`,
    issue: { eventId },
    cancelled,
    areas: [],
    forecastMaxScale: scale,
    earthquake: { condition: undefined },
  } as unknown as EEWAlert
}

const NO_INDICES: readonly number[] = []

interface Props {
  q?: JMAQuake
  e?: readonly EEWAlert[]
  k?: readonly number[]
  min?: number
}

function setup(initial: JMAQuake | undefined, eews: readonly EEWAlert[] = NO_EEWS) {
  return renderHook(
    ({ q, e, k, min }: Props) =>
      useActionChecklist({
        minScale: min ?? MIN,
        home: null,
        stationCoords: null,
        kyoshinSites: [],
        kyoshinIndices: k ?? NO_INDICES,
        eews: e ?? NO_EEWS,
        latestQuake: q,
      }),
    { initialProps: { q: initial, e: eews } as Props },
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('畳む・開く', () => {
  it('閾値に達したら開いた状態で出る', () => {
    const { result } = setup(quake('ev1', 70))
    expect(result.current.state?.scale).toBe(70)
    expect(result.current.collapsed).toBe(false)
  })

  it('閉じても中身は残り、ボタンへ畳まれる', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    // **null にしない。** 完全に消すと読み返せなくなる。
    expect(result.current.state).not.toBe(null)
    expect(result.current.collapsed).toBe(true)
  })

  it('畳んだボタンを押すと開く', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => result.current.restore())
    expect(result.current.collapsed).toBe(false)
    expect(result.current.state?.scale).toBe(70)
  })
})

describe('畳んでいる間に次の揺れが届いたら', () => {
  it('震度が同じか下なら畳んだまま（これが能登で直したかったこと）', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    // 別の地震（＝別のキー）が届く。旧実装ではここで帯が出直していた。
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 50) }))
    expect(result.current.collapsed).toBe(true)
    // 中身は最新の揺れへ更新する（ボタンに出す震度が古いままにならないように）。
    expect(result.current.state?.scale).toBe(50)
  })

  it('震度が上がったら開き直す', () => {
    const { result, rerender } = setup(quake('ev1', 50))
    act(() => result.current.dismiss())
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 60) }))
    expect(result.current.collapsed).toBe(false)
    expect(result.current.state?.scale).toBe(60)
  })

  it('一度開き直したら、その後の同程度の揺れでも開いたまま', () => {
    const { result, rerender } = setup(quake('ev1', 50))
    act(() => result.current.dismiss())
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 60) })) // 開き直る
    act(() => rerender({ e: NO_EEWS, q: quake('ev3', 50) }))
    expect(result.current.collapsed).toBe(false)
  })

  // 安全弁: 畳んでいる間の揺れで基準の震度を書き換えないこと。書き換えると余震で下がっていく
  // 値に追随し、そのうち小さな揺れでも「上がった」と見なして開いてしまう。
  it('畳んでいる間の弱い揺れで基準を下げない', () => {
    const { result, rerender } = setup(quake('ev1', 70)) // 震度7 で畳む
    act(() => result.current.dismiss())
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 40) }))
    act(() => rerender({ e: NO_EEWS, q: quake('ev3', 50) })) // 基準が 40 に下がっていれば開いてしまう
    expect(result.current.collapsed).toBe(true)
  })
})

describe('ボタンの寿命', () => {
  it('揺れが届かないまま期限が来たら消える', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  it('揺れが届くたびに延びる（余震が続く間はボタンが残る）', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS - 1000))
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 50) })) // 期限の直前に余震
    act(() => void vi.advanceTimersByTime(2000)) // 元の期限は過ぎたが延長済み
    expect(result.current.state).not.toBe(null)
    expect(result.current.collapsed).toBe(true)
  })

  it('開いている間は期限で消さない（読んでいる最中に消えないこと）', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => result.current.restore())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    expect(result.current.state).not.toBe(null)
  })
})

describe('リロードをまたぐ', () => {
  it('畳んだ記録は保存され、期限内なら次の揺れでも畳んだまま', () => {
    const first = setup(quake('ev1', 70))
    act(() => first.result.current.dismiss())
    first.unmount()

    // 別インスタンス（＝リロード相当）。記録が効いていなければ開いた状態で出る。
    const second = setup(quake('ev2', 50))
    expect(second.result.current.collapsed).toBe(true)
  })

  it('期限切れの記録は無視して開いた状態で出る', () => {
    localStorage.setItem(
      'action-checklist-suppress',
      JSON.stringify({ until: Date.now() - 1, scale: 70 }),
    )
    const { result } = setup(quake('ev1', 50))
    expect(result.current.collapsed).toBe(false)
  })

  it('壊れた記録は無かったことにする', () => {
    localStorage.setItem('action-checklist-suppress', '{ this is not json')
    const { result } = setup(quake('ev1', 50))
    expect(result.current.collapsed).toBe(false)
    expect(result.current.state?.scale).toBe(50)
  })
})

describe('3 経路の優先順', () => {
  // 3 つは同時に成立しうる（発報中の EEW・揺れている観測値・直前の地震の確定情報）。
  // 順序を決めずに書くと最後に評価したものが勝ち、EEW が出ている最中に「強い揺れがありました」
  // （過去形）へ落ちる。
  it('EEW が出ている間は、直前の地震の確定情報より EEW を見せる', () => {
    const { result } = setup(quake('ev1', 70), [eewAlert('e1', 50)])
    expect(result.current.state?.reason).toBe('eew')
    expect(result.current.state?.scale).toBe(50)
  })

  it('EEW が無ければ地震情報を見せる', () => {
    const { result } = setup(quake('ev1', 70))
    expect(result.current.state?.reason).toBe('quake')
  })

  it('誤報取消の EEW は見ない', () => {
    const { result } = setup(quake('ev1', 70), [eewAlert('e1', 50, true)])
    expect(result.current.state?.reason).toBe('quake')
  })

  it('閾値に届かない EEW は飛ばして次の経路を見る', () => {
    const { result } = setup(quake('ev1', 70), [eewAlert('e1', 30)])
    expect(result.current.state?.reason).toBe('quake')
  })
})

describe('レビューで見つかった穴の回帰', () => {
  // 表示の更新を「中身が変わらないなら触らない」で打ち切ると、寿命の延長も道連れになる。
  // 強震モニタは毎秒判定するため、同じ震度が続く揺れでは延長が一度も走らない。
  it('中身が変わらない再通知でも寿命は延びる', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS - 1000))
    // 同じ地震・同じ震度がもう一度届く（表示は変わらない）
    act(() => rerender({ e: NO_EEWS, q: quake('ev1', 70) }))
    act(() => void vi.advanceTimersByTime(2000))
    expect(result.current.state).not.toBe(null)
    expect(result.current.collapsed).toBe(true)
  })

  // 地震情報は最新の 1 件が長く居座る（1 時間後も同じ地震が最新のままなのは普通）。
  // 「消し終えた」ことを覚えていないと、消した次の再描画でそのまま出し直してしまう。
  it('寿命が尽きて消したものは、同じ地震が居座っていても出し直さない', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    expect(result.current.state).toBe(null)
    act(() => rerender({ e: NO_EEWS, q: quake('ev1', 70) }))
    expect(result.current.state).toBe(null)
  })

  it('別の地震なら消したあとでも出す', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 50) }))
    expect(result.current.state?.scale).toBe(50)
    expect(result.current.collapsed).toBe(false)
  })

  // 階級表に無い震度（例: 99）が記録に入ると「これを超えたら開き直す」が永久に成立せず、
  // 以後どんな揺れでもボタンが自動で開かなくなる。記録は永続化されるためリロードでも直らない。
  it('階級表に無い震度の記録は無視する', () => {
    localStorage.setItem(
      'action-checklist-suppress',
      JSON.stringify({ until: Date.now() + SUPPRESS_MS, scale: 99 }),
    )
    const { result } = setup(quake('ev1', 50))
    expect(result.current.collapsed).toBe(false)
  })
})

describe('レビュー 2 巡目で見つかった穴の回帰', () => {
  // `eews` の並びは発報を受けた順で、深刻さとは無関係。最初に閾値を超えたところで打ち切ると、
  // 後から発生したより強い地震の予想を見落とす。
  it('EEW が複数あるときは最も深刻なものを見せる', () => {
    const { result } = setup(undefined, [eewAlert('e-old', 50), eewAlert('e-new', 60)])
    expect(result.current.state?.scale).toBe(60)
    expect(result.current.state?.key).toBe('eew:e-new')
  })

  it('並び順が逆でも結果は変わらない', () => {
    const { result } = setup(undefined, [eewAlert('e-new', 60), eewAlert('e-old', 50)])
    expect(result.current.state?.scale).toBe(60)
  })

  // 判定側で早期に抜けるだけでは、開いたままの帯が手動で閉じるまで残る（開いている間は
  // 寿命でも消さない設計のため）。
  it('設定で「出さない」に切り替えたら、開いている帯も引っ込める', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    expect(result.current.state).not.toBe(null)
    act(() => rerender({ q: quake('ev1', 70), min: -1 }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  it('畳んだボタンも引っ込める', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => rerender({ q: quake('ev1', 70), min: -1 }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  // EEW も地震情報もまだ無い数十秒の窓に、別々の地震が 2 つ入ることがある（群発・離れた
  // 2 地域の同時発生）。識別子を時単位に丸めていると両者が同じものになり、1 件目を閉じたあと
  // 2 件目が「同じ揺れの続き」として扱われて開き直さない。
  it('強震モニタだけで検知した揺れは、途切れたら別の識別子になる', () => {
    const STRONG = 19 // 震度7
    const CALM = 6 // 震度0
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: [STRONG] }))
    const first = result.current.state?.key
    expect(first).toMatch(/^kyoshin:/)

    act(() => rerender({ k: [CALM] })) // 揺れが収まる（識別子を捨てる）
    act(() => void vi.advanceTimersByTime(1000))
    act(() => rerender({ k: [STRONG] })) // 別の地震
    expect(result.current.state?.key).not.toBe(first)
  })

  // 対照: 揺れが続いている間は識別子を変えない（変えると畳んだものが開き直る）
  it('揺れが続いている間は識別子を変えない', () => {
    const STRONG = 19
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: [STRONG] }))
    const first = result.current.state?.key
    act(() => void vi.advanceTimersByTime(1000))
    act(() => rerender({ k: [STRONG, STRONG] }))
    expect(result.current.state?.key).toBe(first)
  })
})
