// @vitest-environment jsdom
//
// EEW カードの「対象地域」欄（警報の府県予報区／予報の府県予報区）。
//
// **警報と予報は同じ県に同居する。** 種別コードは府県予報区より細かい一次細分区域ごとに
// 付くため、「石川県能登＝警報・石川県加賀＝予報」のような報が普通に来る（能登本震の実電文で
// 石川・新潟・長野が該当）。両方の列へ出すと、警報が出ている県が予報の列にも現れて
// 一段軽く見えるため、警報の側だけに残す。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert, EEWRegion } from '../../types/earthquake'

afterEach(cleanup)

function makeArea(pref: string, name: string, kindCode: string): EEWRegion {
  return { pref, name, scaleFrom: 40, scaleTo: 40, kindCode, arrivalTime: null }
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
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
    },
    severity: 'Warning',
    cancelled: false,
    areas,
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )

/** 「警報:」「予報:」のラベルに続く府県予報区の並び。 */
function prefListAfter(label: string): string[] {
  const labelEl = screen.getByText(label)
  const text = labelEl.parentElement?.textContent?.replace(label, '').trim() ?? ''
  return text.split(' / ').map(s => s.trim()).filter(Boolean)
}

describe('EEW カードの対象地域', () => {
  // 正: 警報と予報の両方に区域を持つ県は、予報の列から外れる。
  it('警報に出した府県予報区を予報の列へ重ねて出さない', () => {
    renderTab(
      makeEEW([
        makeArea('石川', '石川県能登', '10'),
        makeArea('石川', '石川県加賀', '00'),
        makeArea('富山', '富山県東部', '10'),
      ]),
    )
    expect(prefListAfter('警報:')).toEqual(['石川', '富山'])
    expect(screen.queryByText('予報:')).toBeNull()
  })

  // 対照: 警報に 1 つも区域を持たない県は、予報の列に残る。
  it('予報だけの府県予報区は予報の列に残す', () => {
    renderTab(
      makeEEW([
        makeArea('石川', '石川県能登', '10'),
        makeArea('新潟', '新潟県上越', '00'),
      ]),
    )
    expect(prefListAfter('警報:')).toEqual(['石川'])
    expect(prefListAfter('予報:')).toEqual(['新潟'])
  })

  // 正: 件数で打ち切らない。対象が広い報ほど「...」の中へ落ちていた。
  it('府県予報区が多くても省略せず全部出す', () => {
    const warning = ['石川', '富山', '新潟', '長野', '福井', '岐阜', '群馬', '山形']
    const forecast = ['東京', '神奈川', '京都', '秋田', '大阪', '島根', '愛知', '三重']
    renderTab(
      makeEEW([
        ...warning.map(pref => makeArea(pref, `${pref}A`, '10')),
        ...forecast.map(pref => makeArea(pref, `${pref}B`, '00')),
      ]),
    )
    expect(prefListAfter('警報:')).toEqual(warning)
    expect(prefListAfter('予報:')).toEqual(forecast)
    expect(screen.queryByText(/\.\.\./)).toBeNull()
  })

  // 安全弁: 除外が働くのは予報の側だけで、警報の列は減らない。
  it('警報の列は予報にも出ている県を落とさない', () => {
    renderTab(
      makeEEW([
        makeArea('石川', '石川県能登', '10'),
        makeArea('石川', '石川県加賀', '00'),
        makeArea('新潟', '新潟県中越', '11'),
        makeArea('新潟', '新潟県下越', '00'),
        makeArea('長野', '長野県北部', '00'),
      ]),
    )
    expect(prefListAfter('警報:')).toEqual(['石川', '新潟'])
    expect(prefListAfter('予報:')).toEqual(['長野'])
  })
})
