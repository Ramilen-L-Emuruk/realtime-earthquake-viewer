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
