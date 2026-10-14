// 購読区分の取り決め（dmdataClassifications.ts）を固定する。
// 応えの文はすべて 2026-10-14 の実測に合わせてある（docs/spec/data-sources-spec.md §2）。
import { describe, expect, it } from 'vitest'
import {
  readSocketRejection, nextClassifications, negotiateClassifications, eewHeadTypeFor,
  hasQuakeTelegrams, classificationLabel, acceptedClassifications, PREFERRED_CLASSIFICATIONS,
  MAX_SOCKET_START_ATTEMPTS,
  type DmdataClassification, type SocketStartAttempt,
} from './dmdataClassifications'

const err = (status: number, message: string): SocketStartAttempt => ({ status, body: { status: 'error', error: { message, code: status } } })
const ok = (classifications: string[]): SocketStartAttempt => ({ status: 200, body: { status: 'ok', classifications } })

describe('readSocketRejection', () => {
  it('402 の角括弧に載った区分を外す（実測の文）', () => {
    expect(readSocketRejection(402, 'No contract. [eew.forecast]', ['eew.forecast', 'telegram.earthquake']))
      .toEqual({ kind: 'drop', drop: ['eew.forecast'] })
  })

  it('402 に複数の区分が載っていればすべて外す', () => {
    expect(readSocketRejection(402, 'No contract. [eew.forecast, telegram.earthquake]', ['eew.forecast', 'telegram.earthquake']))
      .toEqual({ kind: 'drop', drop: ['eew.forecast', 'telegram.earthquake'] })
  })

  it('403 の権限名を区分へ引き直して外す（実測の文）', () => {
    expect(readSocketRejection(403, 'Insufficient scope for eew.get.forecast.', ['eew.forecast', 'telegram.earthquake']))
      .toEqual({ kind: 'drop', drop: ['eew.forecast'] })
    expect(readSocketRejection(403, 'Insufficient scope for telegram.get.earthquake.', ['eew.forecast', 'telegram.earthquake']))
      .toEqual({ kind: 'drop', drop: ['telegram.earthquake'] })
  })

  it('安全弁: socket.start が足りないなら区分を外しても繋がらないので fatal（実測の文）', () => {
    expect(readSocketRejection(403, 'Insufficient scope for socket.start, eew.get.forecast.', ['eew.forecast', 'telegram.earthquake']).kind)
      .toBe('fatal')
  })

  it('対照: 申し込んでいない区分が載っていても外さない（文の形が変わった疑い）', () => {
    expect(readSocketRejection(402, 'No contract. [telegram.volcano]', ['eew.forecast', 'telegram.earthquake']))
      .toEqual({ kind: 'unknown' })
  })

  it('対照: 申し込んでいない区分の権限が足りないと言われたら fatal（外す先が無い）', () => {
    expect(readSocketRejection(403, 'Insufficient scope for eew.get.warning.', ['eew.forecast', 'telegram.earthquake']).kind)
      .toBe('fatal')
  })

  it('対照: 読めない文・別の状態コードは unknown（区分を外す根拠にしない）', () => {
    expect(readSocketRejection(402, 'Payment required', ['eew.forecast'])).toEqual({ kind: 'unknown' })
    expect(readSocketRejection(403, undefined, ['eew.forecast'])).toEqual({ kind: 'unknown' })
    expect(readSocketRejection(409, 'No contract. [eew.forecast]', ['eew.forecast'])).toEqual({ kind: 'unknown' })
  })
})

describe('nextClassifications', () => {
  it('予報を外したら警報を代わりに足す', () => {
    expect(nextClassifications(['eew.forecast', 'telegram.earthquake'], new Set(['eew.forecast'])))
      .toEqual(['eew.warning', 'telegram.earthquake'])
  })

  it('対照: 警報も外していれば足さない', () => {
    expect(nextClassifications(['eew.warning', 'telegram.earthquake'], new Set<DmdataClassification>(['eew.forecast', 'eew.warning'])))
      .toEqual(['telegram.earthquake'])
  })

  it('安全弁: 何も残らなければ null', () => {
    expect(nextClassifications(['telegram.earthquake'], new Set(['telegram.earthquake']))).toBeNull()
  })
})

describe('negotiateClassifications', () => {
  /** 契約と権限を持つ区分だけを通す、配信元の偽物。投げた区分を記録する。 */
  function fakeServer(contract: DmdataClassification[], scope: DmdataClassification[]) {
    const calls: DmdataClassification[][] = []
    const scopeName: Record<DmdataClassification, string> = {
      'eew.forecast': 'eew.get.forecast', 'eew.warning': 'eew.get.warning', 'telegram.earthquake': 'telegram.get.earthquake',
    }
    const start = async (req: readonly DmdataClassification[]): Promise<SocketStartAttempt> => {
      calls.push([...req])
      // 実測では権限の判定が契約より先に来る
      const noScope = req.filter((c) => !scope.includes(c))
      if (noScope.length > 0) return err(403, `Insufficient scope for ${noScope.map((c) => scopeName[c]).join(', ')}.`)
      const noContract = req.filter((c) => !contract.includes(c))
      if (noContract.length > 0) return err(402, `No contract. [${noContract[0]}]`)
      return ok([...req])
    }
    return { calls, start }
  }

  const all: DmdataClassification[] = ['eew.forecast', 'eew.warning', 'telegram.earthquake']

  it('全部ある人は 1 回で予報＋地震・津波', async () => {
    const s = fakeServer(all, all)
    const r = await negotiateClassifications(s.start, PREFERRED_CLASSIFICATIONS, () => false)
    expect(r.kind === 'ok' && r.classifications).toEqual(['eew.forecast', 'telegram.earthquake'])
    expect(s.calls).toHaveLength(1)
  })

  it('警報＋地震・津波の人（予報の契約なし）は警報へ切り替えて繋がる', async () => {
    const s = fakeServer(['eew.warning', 'telegram.earthquake'], all)
    const r = await negotiateClassifications(s.start, PREFERRED_CLASSIFICATIONS, () => false)
    expect(r.kind === 'ok' && r.classifications).toEqual(['eew.warning', 'telegram.earthquake'])
    expect(s.calls).toEqual([['eew.forecast', 'telegram.earthquake'], ['eew.warning', 'telegram.earthquake']])
  })

  it('地震・津波だけの人は予報も警報も外して繋がる', async () => {
    const s = fakeServer(['telegram.earthquake'], all)
    const r = await negotiateClassifications(s.start, PREFERRED_CLASSIFICATIONS, () => false)
    expect(r.kind === 'ok' && r.classifications).toEqual(['telegram.earthquake'])
    expect(r.kind === 'ok' && r.excluded).toEqual(['eew.forecast', 'eew.warning'])
  })

  it('予報の権限を外した鍵（鍵1 の形）は警報で繋がる', async () => {
    const s = fakeServer(all, ['eew.warning', 'telegram.earthquake'])
    const r = await negotiateClassifications(s.start, PREFERRED_CLASSIFICATIONS, () => false)
    expect(r.kind === 'ok' && r.classifications).toEqual(['eew.warning', 'telegram.earthquake'])
  })

  it('地震・津波の権限を外した鍵（鍵2 の形）は予報だけで繋がる', async () => {
    const s = fakeServer(all, ['eew.forecast'])
    const r = await negotiateClassifications(s.start, PREFERRED_CLASSIFICATIONS, () => false)
    expect(r.kind === 'ok' && r.classifications).toEqual(['eew.forecast'])
  })

  it('安全弁: 受けられる区分が 1 つも無ければ fatal で、上限を超えて投げない', async () => {
    const s = fakeServer([], all)
    const r = await negotiateClassifications(s.start, PREFERRED_CLASSIFICATIONS, () => false)
    expect(r.kind).toBe('fatal')
    expect(s.calls.length).toBeLessThanOrEqual(MAX_SOCKET_START_ATTEMPTS)
  })

  it('安全弁: 止められたら、次の申し込みを投げずに打ち切る', async () => {
    const s = fakeServer(['telegram.earthquake'], all)
    let stopped = false
    const start = async (req: readonly DmdataClassification[]) => { const r = await s.start(req); stopped = true; return r }
    const r = await negotiateClassifications(start, PREFERRED_CLASSIFICATIONS, () => stopped)
    expect(r.kind).toBe('stopped')
    expect(s.calls).toHaveLength(1)
  })

  it('対照: 区分と関係の無い失敗（409）はそのまま返し、投げ直さない', async () => {
    const calls: number[] = []
    const r = await negotiateClassifications(async () => { calls.push(1); return err(409, 'Too many connections.') }, PREFERRED_CLASSIFICATIONS, () => false)
    expect(r.kind).toBe('other')
    expect(calls).toHaveLength(1)
  })
})

describe('区分から決まるもの', () => {
  it('予報があれば VXSE45、予報が無く警報があれば VXSE43、どちらも無ければ null', () => {
    expect(eewHeadTypeFor(['eew.forecast', 'telegram.earthquake'])).toBe('VXSE45')
    expect(eewHeadTypeFor(['eew.forecast', 'eew.warning'])).toBe('VXSE45')
    expect(eewHeadTypeFor(['eew.warning', 'telegram.earthquake'])).toBe('VXSE43')
    expect(eewHeadTypeFor(['telegram.earthquake'])).toBeNull()
  })

  it('地震・津波を受けているか', () => {
    expect(hasQuakeTelegrams(['eew.forecast', 'telegram.earthquake'])).toBe(true)
    expect(hasQuakeTelegrams(['eew.forecast'])).toBe(false)
  })

  it('購入区分名を定義順に「・」で繋ぐ', () => {
    expect(classificationLabel(['telegram.earthquake', 'eew.warning'])).toBe('緊急地震（警報）・地震・津波関連')
    expect(classificationLabel(['eew.forecast', 'telegram.earthquake'])).toBe('緊急地震（予報）・地震・津波関連')
  })

  it('応えの classifications を読み、読めなければ申し込んだ区分を返す', () => {
    expect(acceptedClassifications({ classifications: ['eew.warning', 'telegram.earthquake'] }, ['eew.forecast'])).toEqual(['eew.warning', 'telegram.earthquake'])
    expect(acceptedClassifications({}, ['eew.forecast'])).toEqual(['eew.forecast'])
    expect(acceptedClassifications({ classifications: ['telegram.volcano'] }, ['eew.forecast'])).toEqual(['eew.forecast'])
  })
})
