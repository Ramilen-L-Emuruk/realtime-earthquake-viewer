// @vitest-environment jsdom
//
// EEW カードの「主要動の到達（予測）」欄。
//
// **件数で切るのをやめ、並びを時間順にした変更を固定する。** 以前は種別順（到達済み →
// PLUM 法 → 到達予測時刻順）に並べて先頭 6 件だけを出し、残りを「他 N 地域」の数字へ
// 落としていた。実電文を走査すると（2025-01-02〜2026-09-11・VXSE45 9,871 通）、区域を持つ
// 報 1,461 通のうち 27.7% が 6 件を超え、最大 56 件。しかも並びのせいで、未到達の区域を持つ
// 報の 24.9% でそれが 1 件も見えていなかった（最大予想震度 6 弱以上に限れば 65%）。
//
// 残り秒数は `serverNow()` から引くので、テストでは固定値へ差し替える。壁時計（`Date.now`）を
// 使うとリプレイ中の再生時計とずれるため、実装側も `serverNow` を通している。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert, EEWRegion } from '../../types/earthquake'

/** テスト中の「いま」。区域の到達予測時刻はここからの相対で作る。 */
const FIXED_NOW = new Date('2026-01-01T12:00:30Z').getTime()

// **時刻は可変にしておく。** 固定値を返すだけだと「タイマーが動いているか」を見分けられない
// （止まっていても動いていても表示が変わらない）。進める側のテストが `clock.now` を書き換える。
const clock = vi.hoisted(() => ({ now: new Date('2026-01-01T12:00:30Z').getTime() }))

vi.mock('../../utils/clock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/clock')>()
  return { ...actual, serverNow: () => clock.now }
})

afterEach(() => {
  cleanup()
  clock.now = FIXED_NOW
})

/** `FIXED_NOW` から `sec` 秒後の時刻（電文の `ArrivalTime` と同じ ISO 文字列）。 */
const after = (sec: number) => new Date(FIXED_NOW + sec * 1000).toISOString()

function area(over: Partial<EEWRegion> & { name: string }): EEWRegion {
  return {
    pref: '',
    scaleFrom: 40,
    scaleTo: 40,
    kindCode: '10',
    arrivalTime: null,
    ...over,
  }
}

function makeEEW(areas: EEWRegion[]): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '三陸沖', latitude: 39.0, longitude: 143.0, depth: 30, magnitude: 7.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxScale: 50,
    areas,
  }
}

const renderTab = (eew: EEWAlert, visible = true) =>
  render(
    <RealtimeTab eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible={visible} />,
  )

/** `visible` を切り替えられる形。タイマーの開閉を見るテストで使う。 */
const tabElement = (eew: EEWAlert, visible: boolean) => (
  <RealtimeTab eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible={visible} />
)

/** a が b より前に出ているか。 */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** 区域名が DOM に出ている順のとおりか。 */
function expectOrder(names: string[]): void {
  const els = names.map(n => screen.getByText(n))
  for (let i = 1; i < els.length; i++) {
    expect(precedes(els[i - 1], els[i])).toBe(true)
  }
}

describe('EEW カードの到達予測一覧', () => {
  // 正: 6 件を超えても全部出る。ここが落ちるなら `slice(0, 6)` が戻っている。
  it('区域が 6 件を超えても全件を出す', () => {
    const names = ['区域1', '区域2', '区域3', '区域4', '区域5', '区域6', '区域7', '区域8']
    renderTab(makeEEW(names.map((name, i) => area({ name, arrivalTime: after(i + 1) }))))
    for (const n of names) expect(screen.getByText(n)).toBeTruthy()
    // 「他 N 地域」は廃止した。残っていれば件数で切る実装が生きている。
    expect(screen.queryByText(/^他\d+地域$/)).toBeNull()
  })

  // 正: 未到達の区域は残り秒数で出す（電文の絶対時刻をそのまま出さない）。
  it('未到達の区域は残り秒数で出す', () => {
    renderTab(makeEEW([area({ name: '宮城県北部', arrivalTime: after(42) })]))
    expect(screen.getByText('42秒')).toBeTruthy()
    // 電文の時刻（12:00:72 → 12:01:12 JST 表記）をそのまま出していないこと。
    expect(screen.queryByText(/^\d{1,2}:\d{2}:\d{2}$/)).toBeNull()
  })

  // 安全弁: 予測時刻を過ぎても、気象庁が到達済みと言うまでは秒数を負で出さない。
  it('予測時刻を過ぎた区域は「まもなく」と出す', () => {
    renderTab(makeEEW([area({ name: '岩手県沿岸北部', arrivalTime: after(-3) })]))
    expect(screen.getByText('まもなく')).toBeTruthy()
    expect(screen.queryByText('-3秒')).toBeNull()
  })

  // 安全弁: 日時として読めない到達予測時刻を「まもなく」へ混ぜない。
  //
  // `EEWRegion.arrivalTime` は電文の生テキストで、パーサーは日時として読めるかを確かめていない。
  // 素朴に引き算すると `NaN` になり、`NaN > 0` が偽なので**「まもなく」に化ける** ——
  // 壊れた値が「もうすぐ来る」という確度の高い表示になる。差し迫っていることと、値が読めない
  // ことは別の事実なので、別の語で出す。
  it('読めない到達予測時刻は「まもなく」ではなく「不明」と出す', () => {
    renderTab(makeEEW([area({ name: '壊れた区域', arrivalTime: 'これは日時ではない' })]))
    expect(screen.getByText('不明')).toBeTruthy()
    expect(screen.queryByText('まもなく')).toBeNull()
    expect(screen.queryByText('NaN秒')).toBeNull()
  })

  // 安全弁: 読めない時刻の記録を毎秒繰り返さない。
  //
  // 残り秒数は 1 秒ごとに数え直すので、**レンダーの中で記録すると壊れた区域 1 つで
  // 1 秒に 1 行ずつログが出続ける**（このリポジトリは「記録は電文ごとに 1 行へまとめる」と
  // 定めている）。記録は報の中身が変わったときだけ走ること。
  it('読めない到達予測時刻の記録を毎秒繰り返さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      renderTab(makeEEW([
        area({ name: '壊れた区域', arrivalTime: 'これは日時ではない' }),
        area({ name: '正常な区域', arrivalTime: after(40) }),
      ]))
      expect(warn).toHaveBeenCalledTimes(1)
      // 3 秒ぶん進める。秒数の表示は動くが、記録は増えない。
      act(() => {
        clock.now += 3000
        vi.advanceTimersByTime(3000)
      })
      expect(screen.getByText('37秒')).toBeTruthy()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  // 安全弁: 画面に出ていない間はタイマーを持たず、戻った瞬間に合わせ直す。
  //
  // タブは全部マウントしたままなので、これが無いと別のタブを見ている間も毎秒描き直す。
  // 一方で止めたままにすると、戻ったときに古い秒数が出る（ブラウザは非可視タブの
  // `setInterval` を数十秒まで間引くので、ずれは 1 秒では済まない）。
  it('画面に出ていない間は秒数を進めず、戻った瞬間に合わせ直す', () => {
    vi.useFakeTimers()
    try {
      const eew = makeEEW([area({ name: '宮城県北部', arrivalTime: after(40) })])
      const { rerender } = render(tabElement(eew, false))
      expect(screen.getByText('40秒')).toBeTruthy()
      act(() => {
        clock.now += 5000
        vi.advanceTimersByTime(5000)
      })
      // 止まっているので 40 秒のまま。
      expect(screen.getByText('40秒')).toBeTruthy()
      // 表示へ戻すと、止まっていた間に進んだぶんが即座に反映される。
      act(() => { rerender(tabElement(eew, true)) })
      expect(screen.getByText('35秒')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  // 対照: 到達済み（`Condition` 由来）と PLUM 法（種別コード 09/19）には秒数を出さない。
  // PLUM の時刻は「その震度を初めて予測した時刻」で、到達の予測ではない。
  it('到達済みと PLUM 法の区域には秒数を出さない', () => {
    renderTab(makeEEW([
      area({ name: '青森県三八上北', kindCode: '11', arrived: true }),
      area({ name: '秋田県沿岸北部', kindCode: '19', arrivalTime: after(-120) }),
    ]))
    expect(screen.getByText('到達済み')).toBeTruthy()
    expect(screen.getByText('時刻不明')).toBeTruthy()
    expect(screen.queryByText(/秒$/)).toBeNull()
    expect(screen.queryByText('まもなく')).toBeNull()
  })

  // 安全弁: 並びは時間の順 —— 到達済み → 未到達（早い順）→ 到達時刻が判らないもの。
  // 電文の並び順に依存していないこと、PLUM が途中へ挟まらないことの両方を見る。
  it('到達済み → 未到達（早い順）→ PLUM の順に並べる', () => {
    renderTab(makeEEW([
      area({ name: '遅い区域', arrivalTime: after(50) }),
      area({ name: 'PLUM区域', kindCode: '19', arrivalTime: after(-90) }),
      area({ name: '早い区域', arrivalTime: after(5) }),
      area({ name: '到達済み区域', kindCode: '11', arrived: true }),
    ]))
    expectOrder(['到達済み区域', '早い区域', '遅い区域', 'PLUM区域'])
  })

  // 安全弁: 見出しの内訳は PLUM 法の区域を「未到達」に数える。気象庁は到達したと推測した
  // 区域に `Condition` を出すので、それが無い区域を到達済みとして数えてはいけない。
  it('内訳は PLUM 法の区域を未到達に数える', () => {
    renderTab(makeEEW([
      area({ name: '到達済み区域', kindCode: '11', arrived: true }),
      area({ name: '未到達区域', arrivalTime: after(10) }),
      area({ name: 'PLUM区域', kindCode: '19', arrivalTime: after(-90) }),
    ]))
    expect(screen.getByText('到達済み 1 ／ 未到達 2')).toBeTruthy()
  })

  // 対照: 到達について何も言えない区域（時刻も到達済みの印も無い）は、この欄に出さない。
  // 欄そのものの出現条件で、ここを緩めると予想震度だけの区域が時刻なしで並ぶ。
  it('到達予測時刻も到達済みの印も無い区域は出さない', () => {
    renderTab(makeEEW([area({ name: '時刻なし区域', kindCode: '00' })]))
    expect(screen.queryByText('時刻なし区域')).toBeNull()
    expect(screen.queryByText('主要動の到達（予測）')).toBeNull()
  })
})
