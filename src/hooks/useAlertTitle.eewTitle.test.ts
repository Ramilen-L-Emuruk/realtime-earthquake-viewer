// EEW 発表中のウィンドウタイトルの組み立てのテスト。
//
// タイトルは AutoHotKey 等の外部監視向けの文字列でもあるため、区分の名前
// （緊急地震速報／地震動予報）を取り違えると外から見て危険度を誤る。
//
// とくに注意が要るのは**どの軸で区分を決めるか**。地名と震度は最大震度の EEW（primary）から
// 取るが、区分の名前は発表中の EEW すべての最大レベルから取る。`eewMaxScale` は**予想震度を
// 持たない報**で 0 を返すため、震度未確定の警報級が震度の付いた予報級に primary を奪われ、
// 警報級が「他N件」に埋もれる並びが実在する。
// （0 になる条件は `condition` ではなく「電文に値があるか」。仮定震源要素でも値が載っていれば
// 採る——下のテストが `forecastMaxScale` を持たせていないのは、その状態を作るため）
import { describe, it, expect } from 'vitest'
import { computeEEWTitle } from './useAlertTitle'
import type { EEWAlert, IntensityScale } from '../types/earthquake'

function makeEEW(over: {
  id: string
  name: string
  severity: 'Forecast' | 'Warning'
  scaleTo?: IntensityScale
  scaleToOrAbove?: boolean
  condition?: string
}): EEWAlert {
  return {
    kind: 'eew',
    id: over.id,
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: over.condition ?? '',
      hypocenter: { name: over.name, latitude: 35, longitude: 135, depth: 10, magnitude: 5 },
    },
    severity: over.severity,
    cancelled: false,
    issue: { eventId: over.id, serial: '1', time: '2026-01-01T12:00:00Z' },
    areas: over.scaleTo === undefined
      ? []
      : [{ pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: over.scaleTo, scaleTo: over.scaleTo, scaleToOrAbove: over.scaleToOrAbove, kindCode: '10', arrivalTime: null }],
  } as unknown as EEWAlert
}

describe('computeEEWTitle', () => {
  it('予報級だけなら「地震動予報」と名乗る', () => {
    const eews = new Map([['a', makeEEW({ id: 'a', name: '宮城県沖', severity: 'Forecast', scaleTo: 20 })]])
    expect(computeEEWTitle(eews)).toBe('地震動予報 宮城県沖 最大震度2予想')
  })

  it('警報級なら「緊急地震速報」と名乗る', () => {
    const eews = new Map([['a', makeEEW({ id: 'a', name: '日向灘', severity: 'Warning', scaleTo: 50 })]])
    expect(computeEEWTitle(eews)).toBe('緊急地震速報 日向灘 最大震度5強予想')
  })

  // これが本題。警報級が震度未確定（仮定震源要素 → eewMaxScale は 0）で、予報級に震度が付いていると
  // primary は予報級になる。区分の名前を primary から決めると「地震動予報」と名乗り、
  // 発表中の警報級が「他1件」に埋もれて外から見えなくなる。
  it('震度未確定の警報級と震度付きの予報級が同時なら、名前は「緊急地震速報」を選ぶ', () => {
    const eews = new Map([
      ['warn', makeEEW({ id: 'warn', name: '能登半島沖', severity: 'Warning', condition: '仮定震源要素' })],
      ['fcst', makeEEW({ id: 'fcst', name: '宮城県沖', severity: 'Forecast', scaleTo: 30 })],
    ])
    const title = computeEEWTitle(eews)
    expect(title.startsWith('緊急地震速報 ')).toBe(true)
    // 地名と震度は primary（最大震度）から取るので、予報級の方が出るのは正しい
    expect(title).toContain('宮城県沖')
    expect(title).toContain('他1件')
  })

  // 上限が定まらない報は「震度4以上予想」と出す。タイトルは外部監視も読む文字列なので、
  // 下限を断定した「最大震度4予想」にすると実際の危険度より低く見える。
  it('上限が定まらない予想は「以上」を添える', () => {
    const eews = new Map([['a', makeEEW({ id: 'a', name: '能登半島沖', severity: 'Forecast', scaleTo: 40, scaleToOrAbove: true })]])
    expect(computeEEWTitle(eews)).toBe('地震動予報 能登半島沖 最大震度4以上予想')
  })

  it('上限が定まっている予想には添えない（境界の手前）', () => {
    const eews = new Map([['a', makeEEW({ id: 'a', name: '能登半島沖', severity: 'Forecast', scaleTo: 40 })]])
    expect(computeEEWTitle(eews)).toBe('地震動予報 能登半島沖 最大震度4予想')
  })

  it('予想震度が無ければ震度句を省く', () => {
    const eews = new Map([['a', makeEEW({ id: 'a', name: '能登半島沖', severity: 'Warning', condition: '仮定震源要素' })]])
    expect(computeEEWTitle(eews)).toBe('緊急地震速報 能登半島沖')
  })
})
