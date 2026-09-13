// @vitest-environment jsdom
//
// 緊急地震速報カードの時刻が、日時として読めない値のときに何を出すか。
//
// `formatDateTime` は読めない値で `null` を返す（→ `utils/formatters.ts` の `readDateTime`）。
// **JSX へ素で埋めると `null` は何も描画されず、接尾辞だけが残る** —— 発生時刻なら「ごろ」。
// 型検査は通ってしまうので、DOM で固定する。
//
// **落とし先を欄ごとに変えている。** 発生時刻は欄ごと落とし（「ごろ」だけ残さない）、
// 区域の到達予測は語（「不明」）を出す（区域名だけが並ぶと値を読み落としたように見える）。
// 後者を担うのは `arrivalEtaSec`（残り秒数を出す側）で、そちらは電文を経由しない経路
// （テストデータ・履歴アーカイブ）のために独自にガードを持つ。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert, EEWRegion } from '../../types/earthquake'

afterEach(cleanup)

/** 到達予測時刻を持つ区域（種別コードは PLUM 法でない予報級）。 */
const forecastArea = (name: string, arrivalTime: string | null): EEWRegion => ({
  pref: '宮崎県', name, scaleFrom: 40, scaleTo: 40, kindCode: '00', arrivalTime,
})

function makeEEW(originTime: string, areas: EEWRegion[]): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime,
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxScale: 50,
    areas,
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )

describe('緊急地震速報カードの時刻が読めないとき', () => {
  // 対照: 読める値では従来どおり「◯◯ごろ」が出て、到達予測も「不明」にならない。
  it('読める値では従来どおり出す', () => {
    const { container } = renderTab(makeEEW('2026-01-01T12:00:00Z', [forecastArea('宮崎県南部平野部', '2026-01-01T12:00:40Z')]))
    expect(container.textContent).toMatch(/2026\/01\/01 \d{2}:\d{2}:\d{2}ごろ/)
    // 到達予測は残り秒数で出る（→ docs/spec/eew-spec.md §4）。**実際の秒数は今の時刻に
    // 依存する**ので値では固定せず、「不明」へ落ちていないことだけを見る。
    expect(screen.queryByText('不明')).toBeNull()
  })

  // 正: 発生時刻が読めなければ欄ごと落とす。「ごろ」だけが残らないこと。
  it('発生時刻が読めなければ「ごろ」だけを残さない', () => {
    const { container } = renderTab(makeEEW('壊れた値', [forecastArea('宮崎県南部平野部', '2026-01-01T12:00:40Z')]))
    expect(container.textContent).not.toMatch(/(^|[^0-9])ごろ/)
    expect(container.textContent).not.toContain('NaN')
    // 対照: 震源名など他の情報は残る（時刻が読めないことで欄が道連れにならない）。
    expect(screen.getByText('日向灘')).toBeTruthy()
  })

  // 正: 区域の到達予測時刻が読めなければ語を出す。空欄にすると区域名だけが並び、
  // 値を読み落としたように見える。**「まもなく」に混ぜない** —— 差し迫っていることと、
  // 値が壊れていることは別の事実（`NaN > 0` は偽なので、素朴に書くと壊れた値が
  // 「もうすぐ来る」という確度の高い表示に化ける）。
  it('区域の到達予測時刻が読めなければ「不明」を出す', () => {
    renderTab(makeEEW('2026-01-01T12:00:00Z', [forecastArea('宮崎県南部平野部', '壊れた値')]))
    expect(screen.getByText('不明')).toBeTruthy()
    expect(screen.queryByText('まもなく')).toBeNull()
  })

  // 安全弁: `NaN` がそのまま画面へ出ない（これが元の症状）。
  it('NaN を画面に出さない', () => {
    const { container } = renderTab(makeEEW('壊れた値', [forecastArea('宮崎県南部平野部', '壊れた値')]))
    expect(container.textContent).not.toContain('NaN')
  })
})
