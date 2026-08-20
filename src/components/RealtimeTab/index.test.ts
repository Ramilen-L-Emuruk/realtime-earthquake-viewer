// @vitest-environment jsdom
//
// 検知カードの「数える集合」のテスト。
//
// 地図の検知点マーカーとこのカードは同じ点集合・同じ下限で数えなければならない
// （docs/spec/kyoshin-detection-spec.md §8）。地図側の描画判定は
// gl/kyoshinDetectedFeatures.test.ts が見ているので、こちらは**カードが渡された点列を
// そのまま集計するか**だけを見る。
//
// ここを固定するのは、以前カード側が同じ入力から同じ計算を自分で組み立てていたため。
// 「同じ結果になること」に頼る形だと、片方の実装を変えた時点で黙って食い違う。点列を
// props で受け取る形に変えた今、その受け取り方が壊れていないことを守るのがこのテスト。
//
// JSX を使わず createElement で書くのは、このプロジェクトのテストが `src/**/*.test.ts` のみを
// 対象にしているため（拡張子を .tsx にすると拾われない）。
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { DetectionEvent } from '../../utils/kyoshinDetector'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'

afterEach(cleanup)

/** テスト用の最小 DetectionEvent。カードはティアの判定と地域数にしかこれを使わない。 */
function fakeEvent(
  overrides: Partial<DetectionEvent> & Pick<DetectionEvent, 'id' | 'confidence'>,
): DetectionEvent {
  return {
    memberKeys: [],
    maxIntensity: 1.0,
    cells: [],
    originTimeMs: Date.UTC(2026, 0, 1, 0, 0, 0),
    lastOnsetAtMs: 0,
    lastSize: 0,
    epicenter: null,
    confirmStreak: 0,
    everConfirmed: overrides.confidence === 'confirmed',
    lastSpreadAtMs: 0,
    ...overrides,
  }
}

const P = (key: string, index: number): DetectedPoint => ({ key, lat: 35, lng: 139, index })

function renderTab(detections: DetectionEvent[], points: DetectedPoint[]) {
  render(
    createElement(RealtimeTab, {
      eews: [],
      swaveArrival: null,
      kyoshinV2Detections: detections,
      kyoshinDetectedPoints: points,
    }),
  )
}

describe('検知カードは渡された点列をそのまま集計する', () => {
  const confirmed = [fakeEvent({ id: 'evt-1', confidence: 'confirmed' })]

  it('反応点数は点列の件数（震度0以上）に一致する', () => {
    // index 6 = 震度0、index 7 = 震度1、index 11 = 震度3
    renderTab(confirmed, [P('a', 6), P('b', 7), P('c', 11)])
    expect(screen.getByText(/3観測点で反応/)).toBeTruthy()
  })

  it('震度0未満・欠測は数えない（地図の描画判定と同じ下限）', () => {
    // index 5 = value -0.5（震度0未満）・index -1 = 欠測。どちらも階級が取れない
    renderTab(confirmed, [P('a', 7), P('sub', 5), P('missing', -1)])
    expect(screen.getByText(/1観測点で反応/)).toBeTruthy()
  })

  it('点列が空なら「反応は収まりました」に切り替わる（イベントは生きている）', () => {
    renderTab(confirmed, [])
    expect(screen.getByText(/観測点の反応は収まりました/)).toBeTruthy()
  })

  it('震度別の内訳を点列から作る', () => {
    renderTab(confirmed, [P('a', 6), P('b', 6), P('c', 7)])
    // 震度0 が 2点・震度1 が 1点。件数だけを見ると「どの震度の件数か」が固定されないため、
    // 件数から行（バー1本）を辿って震度ラベルとの対応まで確かめる。
    // 震度ラベル側から引くと震度スケール凡例の「0」「1」と衝突するので、件数側を起点にする。
    const rowOfCount = (count: string) => screen.getByText(count).parentElement?.textContent ?? ''
    expect(rowOfCount('2点')).toMatch(/^0/)
    expect(rowOfCount('1点')).toMatch(/^1/)
  })

  it('ティアの判定は点列ではなくイベントの確信度で決まる', () => {
    // faint だけのときは見出しが「微弱な揺れの兆候」になる。点列に震度1以上があっても変わらない
    renderTab([fakeEvent({ id: 'evt-2', confidence: 'faint', maxIntensity: 0.0 })], [P('a', 7)])
    expect(screen.getByText('微弱な揺れの兆候')).toBeTruthy()
  })

  it('weak だけのときはカードを出さない', () => {
    renderTab([fakeEvent({ id: 'evt-3', confidence: 'weak' })], [P('a', 7)])
    expect(screen.queryByText(/観測点で反応/)).toBeNull()
    expect(screen.queryByText('強震モニタ検知')).toBeNull()
  })

  it('複数イベントのときは地域数を添える', () => {
    renderTab(
      [
        fakeEvent({ id: 'evt-1', confidence: 'confirmed' }),
        fakeEvent({ id: 'evt-2', confidence: 'confirmed' }),
      ],
      [P('a', 7)],
    )
    // 「2地域」は見出し側にも出るため、反応点数と同じ行であることまで確かめる
    expect(screen.getByText(/1観測点で反応 ・ 2地域/)).toBeTruthy()
  })
})

// ============================================================
// カードの枠色は最大震度で決まる（確信度ではない）
//
// 枠＝震度・チップ＝確信度の 2 軸分離。期待値はソースの色定数を参照せず 16 進数で直接書く
// （色が変わったら気づけるように）。震度1 以上は気象庁の震度配色そのもので変更の余地が無い。
// 震度0 の灰色（SHINDO0_COLOR）は気象庁配色に震度0 が無いためのプロジェクト独自の選択で、
// 気象庁配色だから固定というわけではない。
//
// 枠色を決めるのは **points（地図の検知点と同じ点列）の最大インデックス**で、イベント側の
// maxIntensity ではない。そのためイベントは id と確信度だけを与える。
// ============================================================

/** '#rrggbb' と 'rgb(r, g, b)' を同じ表記に揃える（jsdom が正規化する場合があるため）。 */
function toRgb(color: string): string {
  const hex = color.trim().match(/^#([0-9a-fA-F]{6})$/)
  if (!hex) return color.trim()
  const n = parseInt(hex[1]!, 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

/** 検知カードのルート要素（枠線を持つ要素）。本文から親へ辿る。 */
function cardRoot(): HTMLElement {
  const anchor = screen.getByText(/観測点で反応|観測点の反応は収まりました/)
  let el: HTMLElement | null = anchor as HTMLElement
  while (el && !(el.classList.contains('rounded-lg') && el.classList.contains('overflow-hidden'))) {
    el = el.parentElement
  }
  if (!el) throw new Error('検知カードのルート要素が見つからない')
  return el
}

/** カードの枠色を rgb 表記で取り出す。 */
function cardBorderColor(): string {
  const el = cardRoot()
  const decl =
    el.style.borderColor ||
    el.style.border ||
    (el.getAttribute('style') ?? '').match(/border(?:-color)?\s*:\s*([^;]+)/)?.[1] ||
    ''
  const m = decl.match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/)
  if (!m) throw new Error(`枠色が読めない: ${el.getAttribute('style')}`)
  return toRgb(m[0])
}

describe('検知カードの枠色は最大震度で決まる（確信度ではない）', () => {
  it('震度7 の点があれば枠は震度7 の色', () => {
    // index 20 = 計測震度 7.0 = 震度7
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'confirmed' })], [P('a', 20)])
    expect(cardBorderColor()).toBe(toRgb('#9d0099'))
  })

  it('震度1 なら枠は震度1 の色', () => {
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'confirmed' })], [P('a', 7)])
    expect(cardBorderColor()).toBe(toRgb('#7bb4c8'))
  })

  it('震度1未満（震度0級）は震度0の灰色へフォールバックする', () => {
    // 震度色が定まらないので震度0の灰色を使う。ティアの色は使わない（confirmed でも同じ色）。
    // ティア色を混ぜると、確信度のラッチで震度が下がった後も赤枠が残る不整合が起きる。
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'faint' })], [P('a', 6)])
    const faintBorder = cardBorderColor()
    expect(faintBorder).toBe(toRgb('#9ca3af'))
    cleanup()

    renderTab([fakeEvent({ id: 'evt-2', confidence: 'confirmed' })], [P('a', 6)])
    expect(cardBorderColor()).toBe(faintBorder)
  })

  it('同じ点列なら確信度が変わっても枠色は同じ（枠=震度・チップ=確信度）', () => {
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'confirmed' })], [P('a', 7)])
    const confirmedBorder = cardBorderColor()
    expect(screen.getByText('検知')).toBeTruthy()
    cleanup()

    renderTab([fakeEvent({ id: 'evt-2', confidence: 'likely' })], [P('a', 7)])
    expect(cardBorderColor()).toBe(confirmedBorder) // 枠は震度1 の色のまま
    expect(screen.getByText('可能性')).toBeTruthy() // 確信度はチップ側だけが変わる
  })
})
