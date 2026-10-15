import { describe, it, expect } from 'vitest'
import {
  tsunamiEventIds,
  isSameTsunamiEvent,
  isTsunamiContinuation,
  isTsunamiNewFire,
  isCancelForCurrentTsunami,
  isPartialTsunamiRetraction,
  mergeTsunamiReports,
  foldTsunamiReports,
  refoldTsunamiWithout,
  withInheritedTsunamiFacts,
  sameTsunamiEventReports,
} from './tsunami'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'

// 番号が足される切替え（電文解説資料 Ⅰ.別02-8 出現例６）と、種類ごとの取消（同 Ⅰ.別03-1 例１①）。
// 実電文の標本は手元に無いので、資料の例の形をそのまま組む。

const A = '20100714184000'
const B = '20100714185000'

function area(over: Partial<TsunamiArea> = {}): TsunamiArea {
  return { code: '100', name: '岩手県', grade: 'Watch', immediate: false, ...over }
}

function obs(name: string): TsunamiObservation {
  return { name, condition: undefined, maxHeight: undefined } as unknown as TsunamiObservation
}

function report(over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: `t-${over.time ?? 'x'}-${over.headType ?? ''}`,
    eventId: A,
    headType: 'VTSE41',
    time: '2010-07-14T18:44:00+09:00',
    cancelled: false,
    issue: { source: '気象庁', time: '2010-07-14T18:44:00+09:00', type: 'Focus' },
    areas: [area()],
    ...over,
  }
}

describe('tsunamiEventIds', () => {
  it('半角スペースで並んだ番号を割る', () => {
    expect(tsunamiEventIds({ eventId: `${A} ${B}` })).toEqual([A, B])
  })

  it('組み立てに使った報の番号も含める', () => {
    expect(tsunamiEventIds({ eventId: B, foldedReports: [report({ eventId: A }), report({ eventId: B })] }).sort()).toEqual([A, B])
  })

  it('番号が無ければ空', () => {
    expect(tsunamiEventIds({ eventId: undefined })).toEqual([])
    expect(tsunamiEventIds({ eventId: '' })).toEqual([])
  })
})

describe('isSameTsunamiEvent（番号の重なりと運用種別）', () => {
  // 正: 「A」→「A B」の切替えは同じ津波
  it('番号が 1 つでも重なれば同じ津波', () => {
    expect(isSameTsunamiEvent(report({ eventId: A }), report({ eventId: `${A} ${B}` }))).toBe(true)
  })

  // 対照: 重ならなければ別の津波（今と同じく置き換える。2026-10-14 ユーザー承認「置き換える（推奨）」）
  it('番号が重ならなければ別の津波', () => {
    expect(isSameTsunamiEvent(report({ eventId: A }), report({ eventId: B }))).toBe(false)
  })

  // 安全弁: 訓練の報を通常の津波へ混ぜない（独立した情報単位は運用種別を含む）
  it('運用種別が違えば同じ番号でも別の津波', () => {
    expect(isSameTsunamiEvent(report({ eventId: A }), report({ eventId: A, operationStatus: '訓練' }))).toBe(false)
  })

  it('どちらかが番号を持たなければ偽', () => {
    expect(isSameTsunamiEvent(report({ eventId: undefined }), report())).toBe(false)
  })
})

describe('切替えの報を同じ津波として扱う（続報・新しい発表・解除の照合）', () => {
  const current = report({ eventId: A })
  const switched = report({ eventId: `${A} ${B}`, time: '2010-07-14T18:50:00+09:00' })

  it('続報として引き継ぐ', () => {
    expect(isTsunamiContinuation(current, switched)).toBe(true)
  })

  it('新しい発表として鳴らさない', () => {
    expect(isTsunamiNewFire(switched, current)).toBe(false)
  })

  it('A B の解除で A の津波が消える', () => {
    const lift = report({ eventId: `${A} ${B}`, cancelled: true, cancelReason: 'lifted', areas: [] })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(true)
  })

  // 対照: 別の地震の津波の解除では消えない
  it('重ならない番号の解除では消えない', () => {
    const lift = report({ eventId: B, cancelled: true, cancelReason: 'lifted', areas: [] })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(false)
  })

  // 番号が入れ替わっていく形（A → A B → B）でも、組み立てた報の番号を見るので続く
  it('統合した津波は前の番号も覚えている', () => {
    const merged = mergeTsunamiReports(current, switched)
    const onlyA = report({ eventId: A, time: '2010-07-14T18:55:00+09:00', headType: 'VTSE51' })
    expect(isTsunamiContinuation(merged, onlyA)).toBe(true)
  })
})

describe('期限と本文は津波警報等（VTSE41）が決める（F7）', () => {
  const forecast = report({
    time: '2010-07-14T18:44:00+09:00',
    areas: [area({ grade: 'Forecast' })],
    validDateTime: '2010-07-15T00:00:00+09:00',
    bodyText: '予報の本文',
  })

  // 正: 予報 → 注意報へ引き上げた VTSE41 は期限を持たない。前の期限を残さない
  it('VTSE41 が期限なしで届いたら期限を消す', () => {
    const watch = report({ time: '2010-07-14T18:50:00+09:00', areas: [area({ grade: 'Watch' })] })
    const merged = mergeTsunamiReports(forecast, watch)
    expect(merged.validDateTime).toBeUndefined()
    expect(merged.bodyText).toBeUndefined()
  })

  // 対照: 津波情報（VTSE51）は期限を載せないので、届いても消さない（能登・日向灘の最後の VTSE51）
  it('VTSE51 が届いても期限と本文を残す', () => {
    const info = report({ headType: 'VTSE51', time: '2010-07-14T18:47:00+09:00', areas: [] })
    const merged = mergeTsunamiReports(forecast, info)
    expect(merged.validDateTime).toBe('2010-07-15T00:00:00+09:00')
    expect(merged.bodyText).toBe('予報の本文')
  })

  // 安全弁: 種類を持たない報（P2PQuake・古いテストデータ）は従来どおり引き継ぐ
  it('種類を持たない報は従来どおり期限を引き継ぐ', () => {
    const plain = report({ headType: undefined, time: '2010-07-14T18:50:00+09:00' })
    expect(mergeTsunamiReports(forecast, plain).validDateTime).toBe('2010-07-15T00:00:00+09:00')
  })

  it('履歴からの復元も同じ規則で決める', () => {
    const watch = report({ time: '2010-07-14T18:50:00+09:00', areas: [area({ grade: 'Watch' })] })
    const info = report({ headType: 'VTSE51', time: '2010-07-14T18:55:00+09:00', areas: [] })
    expect(withInheritedTsunamiFacts(info, [info, watch, forecast]).validDateTime).toBeUndefined()
  })
})

describe('津波情報・沖合の観測だけの取消（F5）', () => {
  const warning = report({ time: '2010-07-14T18:44:00+09:00' })
  const info = report({ headType: 'VTSE51', time: '2010-07-14T18:50:00+09:00', areas: [], observations: [obs('宮古')] })
  const offshore = report({ headType: 'VTSE52', time: '2010-07-14T18:52:00+09:00', areas: [], observations: [obs('岩手釜石沖')] })
  const merged = [info, offshore].reduce(mergeTsunamiReports, warning)

  it('VTSE51・VTSE52 の取消だけが部分の取消', () => {
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE51', cancelled: true, cancelReason: 'retracted' }))).toBe(true)
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE52', cancelled: true, cancelReason: 'retracted' }))).toBe(true)
    // 対照: 警報等の取消は津波全体
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE41', cancelled: true, cancelReason: 'retracted' }))).toBe(false)
    // 安全弁: 解除は取消ではない
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE51', cancelled: true, cancelReason: 'lifted' }))).toBe(false)
    expect(isPartialTsunamiRetraction(report({ headType: undefined, cancelled: true, cancelReason: 'retracted' }))).toBe(false)
  })

  // 正: 沖合の観測の取消で、沖合の観測点だけが落ち、警報と沿岸の観測は残る
  it('その種類の報が運んだ値だけを抜く', () => {
    const refolded = refoldTsunamiWithout(merged, report({ headType: 'VTSE52', cancelled: true, cancelReason: 'retracted' }))
    expect(refolded?.areas).toEqual(warning.areas)
    expect(refolded?.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  // 安全弁: 抜くと何も残らなければ null（呼び出し側が消す）
  it('組み立てた報がその種類だけなら null', () => {
    expect(refoldTsunamiWithout(info, report({ headType: 'VTSE51', cancelled: true, cancelReason: 'retracted' }))).toBeNull()
  })

  // 正: 番号が「A」→「A B」と伸びた津波で、「B」だけの津波情報の取消は「A」の津波情報を残す
  // （取消は情報の単位ごと。種類だけで抜くと、生きている単位の観測点まで消える）。
  it('取消と番号が重ならない同じ種類の報は残す', () => {
    const infoA = report({ eventId: A, headType: 'VTSE51', time: '2010-07-14T18:50:00+09:00', areas: [], observations: [obs('宮古')] })
    const infoB = report({ eventId: B, headType: 'VTSE51', time: '2010-07-14T18:51:00+09:00', areas: [], observations: [obs('八戸港')] })
    const folded = [infoA, infoB].reduce(mergeTsunamiReports, report({ eventId: `${A} ${B}`, time: '2010-07-14T18:44:00+09:00' }))
    const refolded = refoldTsunamiWithout(folded, report({ eventId: B, headType: 'VTSE51', cancelled: true, cancelReason: 'retracted' }))
    expect(refolded?.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  // 対照: 取消が番号を持たなければ、同じ種類の報をすべて抜く（番号で照合できない経路）。
  it('取消が番号を持たなければ種類だけで抜く', () => {
    const refolded = refoldTsunamiWithout(merged, report({ eventId: undefined, headType: 'VTSE52', cancelled: true, cancelReason: 'retracted' }))
    expect(refolded?.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  it('履歴の最新が部分の取消でも、津波は消さずに組み直す', () => {
    const retract = report({ headType: 'VTSE52', time: '2010-07-14T18:58:00+09:00', cancelled: true, cancelReason: 'retracted', areas: [] })
    const restored = withInheritedTsunamiFacts(retract, [retract, offshore, info, warning])
    expect(restored.cancelled).toBe(false)
    expect(restored.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  it('畳み込みでも取消より前の同じ種類の報だけを抜く', () => {
    const retract = report({ headType: 'VTSE51', time: '2010-07-14T18:53:00+09:00', cancelled: true, cancelReason: 'retracted', areas: [] })
    const reissued = report({ headType: 'VTSE51', time: '2010-07-14T18:59:00+09:00', areas: [], observations: [obs('久慈港')] })
    const folded = foldTsunamiReports([warning, info, offshore, retract, reissued])
    expect(folded?.observations?.map(o => o.name).sort()).toEqual(['久慈港', '岩手釜石沖'].sort())
  })
})

describe('sameTsunamiEventReports（番号の重なりを辿る）', () => {
  it('A → A B → B と入れ替わっても同じ津波の報として集める', () => {
    const r1 = report({ eventId: A, time: '2010-07-14T18:44:00+09:00' })
    const r2 = report({ eventId: `${A} ${B}`, time: '2010-07-14T18:50:00+09:00' })
    const r3 = report({ eventId: B, time: '2010-07-14T19:00:00+09:00' })
    const other = report({ eventId: '20100714190000', time: '2010-07-14T19:01:00+09:00' })
    expect(sameTsunamiEventReports(r3, [r1, r2, r3, other])).toEqual([r1, r2])
  })
})
