import { describe, it, expect } from 'vitest'
import { replayTelegramFacts, type ReplayTelegramSource } from './replayTelegramRef'

// 識別子・情報名・報番号の置き場所は種別ごとに違う（`eventId` 直下 / `issue.eventId` /
// `data.eventId`）。**種別を足したときの埋め忘れは「その種別の読み上げだけ持ち主が空」という
// 静かな形でしか出ない**ので、全種別をここで固定する。
//
// フィクスチャは型の必須項目だけを埋めた最小の形にしてある（取り出しに関係しない項目は
// 埋めても検証の助けにならない）。

const q = (over: Record<string, unknown> = {}): ReplayTelegramSource => ({
  kind: 'quake', id: 'q1', time: '', issue: { source: 'JMA', time: '', type: '震度速報' },
  earthquake: {}, points: [], ...over,
} as unknown as ReplayTelegramSource)

describe('電文から「どの電文か」を取り出す', () => {
  it('地震情報: 情報種別・識別子・報番号', () => {
    expect(replayTelegramFacts(q({ eventId: '20240101160000', reportSerial: 3 }))).toEqual({
      kind: 'quake', infoType: '震度速報', eventId: '20240101160000', serial: '3', cancelled: false,
    })
  })

  it('地震情報: 報番号が振られない報では空（0 と混ぜない）', () => {
    // 震度速報・震源情報は `Head/Serial` が空要素で届く
    expect(replayTelegramFacts(q()).serial).toBeNull()
    // 対照: 0 は「振られている」ので残す
    expect(replayTelegramFacts(q({ reportSerial: 0 })).serial).toBe('0')
  })

  it('地震情報: 取消', () => {
    expect(replayTelegramFacts(q({ cancelled: true })).cancelled).toBe(true)
  })

  it('津波: 情報名を採り、報番号は持たない', () => {
    const facts = replayTelegramFacts({
      kind: 'tsunami', id: 't1', time: '', cancelled: false, eventId: 'tsu-1',
      infoName: '津波観測に関する情報', issue: { source: 'JMA', time: '', type: 'Focus' }, areas: [],
    } as unknown as ReplayTelegramSource)
    expect(facts).toEqual({
      kind: 'tsunami', infoType: '津波観測に関する情報', eventId: 'tsu-1', serial: null, cancelled: false,
    })
  })

  it('緊急地震速報: 識別子と報番号は issue の下', () => {
    const facts = replayTelegramFacts({
      kind: 'eew', id: 'e1', time: '', test: false, cancelled: false, severity: 'Warning',
      earthquake: {}, areas: [], issue: { eventId: 'eew-evt', serial: '5', time: '' },
    } as unknown as ReplayTelegramSource)
    expect(facts.eventId).toBe('eew-evt')
    expect(facts.serial).toBe('5')
  })

  it('緊急地震速報: issue が無くても落ちない', () => {
    const facts = replayTelegramFacts({
      kind: 'eew', id: 'e1', time: '', test: false, cancelled: false, severity: 'Forecast',
      earthquake: {}, areas: [],
    } as unknown as ReplayTelegramSource)
    expect(facts.eventId).toBeNull()
    expect(facts.serial).toBeNull()
  })

  it('長周期地震動: data の下から採る', () => {
    const facts = replayTelegramFacts({
      kind: 'lpgm',
      data: { eventId: 'lpgm-1', infoName: '長周期地震動に関する観測情報', cancelled: false },
    } as unknown as ReplayTelegramSource)
    expect(facts).toEqual({
      kind: 'lpgm', infoType: '長周期地震動に関する観測情報', eventId: 'lpgm-1', serial: null, cancelled: false,
    })
  })

  it('南海トラフ臨時情報: 段階の名前を情報名にする', () => {
    const facts = replayTelegramFacts({
      kind: 'nankai', data: { eventId: 'nk-1', kindName: '巨大地震注意', cancelled: false },
    } as unknown as ReplayTelegramSource)
    expect(facts.infoType).toBe('巨大地震注意')
    expect(facts.eventId).toBe('nk-1')
  })

  it('南海トラフ解説情報: 臨時／定例の別を情報名にする', () => {
    const facts = replayTelegramFacts({
      kind: 'nankaiCommentary', data: { eventId: 'nkc-1', serialName: '臨時解説', cancelled: false },
    } as unknown as ReplayTelegramSource)
    expect(facts.infoType).toBe('臨時解説')
  })

  it('後発地震注意情報: 情報名を持たない', () => {
    const facts = replayTelegramFacts({
      kind: 'kohatsu', data: { eventId: 'kh-1', cancelled: true },
    } as unknown as ReplayTelegramSource)
    expect(facts).toEqual({
      kind: 'kohatsu', infoType: null, eventId: 'kh-1', serial: null, cancelled: true,
    })
  })

  it('地震回数: 群発を指す識別子を採る', () => {
    const facts = replayTelegramFacts({
      kind: 'earthquakeCount', data: { eventId: 'cnt-1', cancelled: false },
    } as unknown as ReplayTelegramSource)
    expect(facts.eventId).toBe('cnt-1')
  })

  it('推計震度分布図: 識別子を持たない電文（取消の概念も無い）', () => {
    const facts = replayTelegramFacts({
      kind: 'estimatedIntensity', data: {}, isNew: true,
    } as unknown as ReplayTelegramSource)
    expect(facts).toEqual({
      kind: 'estimatedIntensity', infoType: null, eventId: null, serial: null, cancelled: false,
    })
  })

  it('地震・津波に関するお知らせ: onLiveEvent へ流さない種別も扱える', () => {
    const facts = replayTelegramFacts({
      kind: 'quakeNotice', data: { eventId: 'notice-1', cancelled: false },
    } as unknown as ReplayTelegramSource)
    expect(facts.kind).toBe('quakeNotice')
    expect(facts.eventId).toBe('notice-1')
  })
})
