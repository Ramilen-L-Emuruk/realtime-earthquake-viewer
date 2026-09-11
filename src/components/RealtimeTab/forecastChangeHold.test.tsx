// @vitest-environment jsdom
//
// 「予想が大きくなりました」の帯が**次の報で消えないこと**を固定する。
//
// 電文はこの変化を 1 通しか言わない。**次の報は値を 0（変化なし）に戻してくる** ――
// 第 1 報を除くほぼ全通が `Appendix` を持つため、要素が消えるのではなく値だけが戻る。
// 実電文（2026-06-01〜09-06・334 イベント）で変化を立てた 55 通の次報までの間隔は
// 中央 1 秒で、うち 35 通が次報で消えていた。報の状態をそのまま描くと帯は 1 秒しか出ず、
// 実質誰も読めない。寿命はカード側が持つ（→ `useHeldForecastChange`）。
//
// 経過時間で分岐するため、描いて時間を進める以外に確かめる方法が無い。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { RealtimeTab, EEW_FORECAST_CHANGE_HOLD_MS } from './index'
import type { EEWAlert, EEWForecastChange } from '../../types/earthquake'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

/** 実電文に出る形（→ 集計は eew-spec.md §3「最大予測値の変化」）。 */
const INCREASED: EEWForecastChange = { maxInt: 1, maxLgInt: 0, reason: 1 }
const NO_CHANGE: EEWForecastChange = { maxInt: 0, maxLgInt: 0, reason: 0 }
const DECREASED: EEWForecastChange = { maxInt: 2, maxLgInt: 0, reason: 0 }

const TEXT_INCREASED = '予想が大きくなりました（マグニチュードが変わったため）'
const TEXT_DECREASED = '予想が小さくなりました'

function makeEEW(serial: string, forecastChange?: EEWForecastChange, overrides: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: `test-eew-${serial}`,
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
    },
    severity: 'Forecast',
    cancelled: false,
    // カードの key はこの `eventId`（→ `eewEventKey`）。**報ごとに変えてはいけない** ――
    // 変えるとカードごと作り直され、保持している状態も一緒に消えるため、
    // 「消えないこと」を確かめられないテストになる。
    issue: { eventId: 'TEST-EVENT-1', serial },
    ...(forecastChange && { forecastChange }),
    ...overrides,
  }
}

const tab = (eews: EEWAlert[]) => (
  <RealtimeTab eews={eews} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />
)

/** 時間を進める（保持タイマーの発火に伴う再描画を取りこぼさないよう act で包む）。 */
const advance = (ms: number) => { act(() => { vi.advanceTimersByTime(ms) }) }

describe('「予想が変わった」の帯の寿命', () => {
  // 正: 変化なしの続報が来ても帯は残る。**この 1 件が不具合そのもの** ――
  // 修正前は実運用で 1 秒しか出ていなかった。
  it('変化なしの続報が来ても帯が残る', () => {
    const { rerender } = render(tab([makeEEW('2', INCREASED)]))
    expect(screen.getByText(TEXT_INCREASED)).toBeTruthy()
    advance(1000) // 実電文での典型的な次報までの間隔
    rerender(tab([makeEEW('3', NO_CHANGE)]))
    expect(screen.getByText(TEXT_INCREASED)).toBeTruthy()
  })

  // 対照: 保持時間を過ぎたら消える。変化が止まったあとも居座らせない。
  it('保持時間を過ぎたら消える', () => {
    const { rerender } = render(tab([makeEEW('2', INCREASED)]))
    rerender(tab([makeEEW('3', NO_CHANGE)]))
    advance(EEW_FORECAST_CHANGE_HOLD_MS - 100)
    expect(screen.getByText(TEXT_INCREASED)).toBeTruthy()
    advance(200)
    expect(screen.queryByText(TEXT_INCREASED)).toBeNull()
  })

  // 安全弁: 気象庁が言い直したら差し替える。保持は「変化なしの報で消さない」ためのもので、
  // 新しい変化を抑えるためではない（実測では 55 通のうち 33 通が 10 秒以内に別の文言へ移る）。
  it('別の変化が来たら文言を差し替える', () => {
    const { rerender } = render(tab([makeEEW('2', INCREASED)]))
    advance(2000)
    rerender(tab([makeEEW('5', DECREASED)]))
    expect(screen.getByText(TEXT_DECREASED)).toBeTruthy()
    expect(screen.queryByText(TEXT_INCREASED)).toBeNull()
  })

  // 安全弁: **同じ文言が離れた報で再び立つ形が実在する**（実測 55 通中 5 通・最大 4 秒後）。
  // 文字列の変化だけを計時の契機にすると、2 度目の変化で計時が伸びず帯が出ない。
  it('同じ文言が次の報で再び立ったら計時をやり直す', () => {
    const { rerender } = render(tab([makeEEW('2', INCREASED)]))
    advance(8000)
    rerender(tab([makeEEW('10', INCREASED)]))
    // 1 度目の計時のままなら、ここ（通算 16 秒）で消えている。
    advance(8000)
    expect(screen.getByText(TEXT_INCREASED)).toBeTruthy()
    advance(2100)
    expect(screen.queryByText(TEXT_INCREASED)).toBeNull()
  })

  // 安全弁: **計時を伸ばすのは新しい報のときだけ。** `useEarthquakes` は報の到着以外でも
  // EEW を作り直す（standard 版の区域・震源要素の注ぎ足し、取消の適用）ので、オブジェクトの
  // 参照変化を契機にすると帯が意図せず延命される。報番号で見分けていることを固定する。
  it('同じ報が描き直されただけでは計時を伸ばさない', () => {
    const { rerender } = render(tab([makeEEW('2', INCREASED)]))
    advance(8000)
    // 報番号・中身は同じで、オブジェクトの参照だけが変わる形。
    rerender(tab([makeEEW('2', INCREASED)]))
    advance(2100) // 1 度目の計時からは 10.1 秒
    expect(screen.queryByText(TEXT_INCREASED)).toBeNull()
  })

  // 安全弁: 取消の報では出さない。取り下げた予想について「大きくなりました」と並べても意味がない。
  //
  // **フィクスチャは `forecastChange` を持たせたまま渡す。** 本番の取消は
  // `{ ...表示中の EEW, cancelledAt }` の形で当たるため、取消電文自身が `Appendix` を
  // 持たなくても**直前の報の値が残る**。持たせない形で書くと、この経路を一度も通らない。
  it('取消の報では出さない', () => {
    const { rerender } = render(tab([makeEEW('2', INCREASED)]))
    advance(1000)
    rerender(tab([makeEEW('3', INCREASED, {
      cancelled: true,
      cancelledAt: new Date('2026-01-01T12:00:30Z'),
    })]))
    expect(screen.queryByText(TEXT_INCREASED)).toBeNull()
  })
})
