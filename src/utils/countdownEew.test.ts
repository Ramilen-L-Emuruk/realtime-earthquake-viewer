// カウントダウンと地図の下端の波形の P/S 線が、同じ緊急地震速報を相手にすることを固定する。

import { describe, expect, it } from 'vitest'

import type { PsWaveCircle } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { pickCountdownCircle, pickCountdownEew, pickPublicWaveEew } from './countdownEew'

function circle(eventId: string, sRadius: number): PsWaveCircle {
  return { eventId, lat: 37, lng: 137, pRadius: sRadius * 1.7, sRadius, depth: 10, magnitude: 6 }
}

/** 引き当てに使う欄だけを持つ速報。 */
function eew(id: string, eventId?: string): EEWAlert {
  return { id, issue: eventId === undefined ? undefined : { eventId } } as unknown as EEWAlert
}

describe('pickCountdownCircle', () => {
  // 正: S 波の波面がいちばん外側にある円を選ぶ（カウントダウンが元から採っていた選び方）。
  it('S 波の半径がいちばん大きい円を選ぶ', () => {
    expect(pickCountdownCircle([circle('a', 10), circle('b', 40), circle('c', 20)])?.eventId).toBe('b')
  })

  // 安全弁: 円が無ければ選ばない。
  it('円が無ければ null', () => {
    expect(pickCountdownCircle([])).toBeNull()
  })
})

describe('pickCountdownEew', () => {
  // 正: 円の eventId（`issue.eventId ?? id`）で速報を引き当てる。
  it('円を作った速報を eventId で引き当てる', () => {
    const eews = [eew('t1', '20260101000000'), eew('t2', '20260101000100')]
    expect(pickCountdownEew([circle('20260101000100', 30)], eews)?.id).toBe('t2')
  })

  // 対照: `issue` が無ければ id で引く（`computeEewCircle` と同じ式）。
  it('issue が無ければ id で引く', () => {
    expect(pickCountdownEew([circle('t9', 30)], [eew('t9')])?.id).toBe('t9')
  })

  // 安全弁: 引き当てられない（円を作った速報が一覧から消えた）なら null。別の速報を代わりに返さない。
  it('引き当てられなければ null', () => {
    expect(pickCountdownEew([circle('gone', 30)], [eew('t1', 'other')])).toBeNull()
  })
})

describe('pickPublicWaveEew', () => {
  const at = (id: string, originTime: string) => ({ id, earthquake: { originTime } }) as unknown as EEWAlert

  // 対照: 予報円が引けるなら、P/S 線と同じ速報を使う（新しい速報があっても）。
  it('予報円の速報があればそれを使う', () => {
    const countdown = at('a', '2026-10-15T10:00:00+09:00')
    expect(pickPublicWaveEew(countdown, [countdown, at('b', '2026-10-15T10:05:00+09:00')])?.id).toBe('a')
  })

  // 正: 予報円を描かない速報（仮定震源要素・深さ不明）だけのときも、発生のいちばん新しいものを材料にする。
  it('予報円が無ければ発生のいちばん新しい速報を使う', () => {
    expect(pickPublicWaveEew(null, [at('old', '2026-10-15T10:00:00+09:00'), at('new', '2026-10-15T10:05:00+09:00')])?.id).toBe('new')
  })

  it('発生時刻の無い強震検知報は発現時刻で新しさを比べる', () => {
    const old = at('old', '2026-10-15T10:00:00+09:00')
    const newest = { ...at('strong', ''), strongShakingOnly: true, earthquake: { originTime: '', arrivalTime: '2026-10-15T10:05:00+09:00' } } as unknown as EEWAlert
    expect(pickPublicWaveEew(null, [old, newest])?.id).toBe('strong')
    // 発生時刻があれば発現時刻より優先し、読めない報で有効な時刻を押し退けない。
    const earlier = { ...newest, earthquake: { originTime: '2026-10-15T09:59:00+09:00', arrivalTime: '2026-10-15T10:06:00+09:00' } } as unknown as EEWAlert
    expect(pickPublicWaveEew(null, [earlier, old, at('unknown', '')])?.id).toBe('old')
  })

  it('速報が無ければ null', () => {
    expect(pickPublicWaveEew(null, [])).toBeNull()
  })
})
