// @vitest-environment jsdom
//
// EEW の区域塗り（eewAreaFills）の導出のテスト。
//
// ここで見るのは 2 点だけ。
//   1. 「〜以上」の予想（上限が定まらない報）が区域まで伝わること
//   2. S波到達の推定に使う震源が、確定震源に限られていること
//
// どちらも 2024/1/1 16:18 の余震で問題になった経路。仮定震源要素の初報が
// 「石川県能登 震度4以上（M・深さは仮定値）」を持って届き、区域塗りが震度7で出ていた。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { EEWAlert, EEWRegion } from '../types/earthquake'
import type { SubRegion } from '../utils/subregions'

const NOTO: SubRegion = {
  name: '石川県能登',
  label: [37.0, 136.9],
  room: [0.2, 0.2],
  rings: [[[37.2, 136.7], [37.2, 137.1], [36.8, 137.1], [36.8, 136.7]]],
}

// 区域データの取得はこのテストの対象外なので、読み込み済みの状態に固定する。
vi.mock('./useSubRegions', () => ({
  useSubRegions: () => ({ data: [NOTO], failed: false }),
}))

const { useEewLayerData } = await import('./useEewLayerData')

function area(overrides: Partial<EEWRegion> = {}): EEWRegion {
  return { pref: '石川県', name: '石川県能登', scaleFrom: 40, scaleTo: 40, kindCode: '11', arrivalTime: null, ...overrides }
}

function makeEEW(over: {
  id: string
  /** 省略時は id と同じ。続報（id は変わるが同じ地震）を作るときに分ける。 */
  eventId?: string
  serial?: string
  condition?: string
  areas: EEWRegion[]
  magnitude?: number
  depth?: number
}): EEWAlert {
  return {
    kind: 'eew',
    id: over.id,
    time: '2024-01-01T16:18:51+09:00',
    test: false,
    earthquake: {
      originTime: '2024-01-01T16:18:45+09:00',
      arrivalTime: '2024-01-01T16:18:45+09:00',
      condition: over.condition ?? '',
      hypocenter: {
        name: '能登半島沖',
        latitude: 37.5,
        longitude: 137.2,
        depth: over.depth ?? 20,
        magnitude: over.magnitude ?? 5.8,
      },
    },
    severity: 'Warning',
    cancelled: false,
    issue: {
      eventId: over.eventId ?? over.id,
      serial: over.serial ?? '1',
      time: '2024-01-01T16:18:51+09:00',
    },
    areas: over.areas,
  }
}

function fillsOf(eews: EEWAlert[]) {
  return renderHook(() => useEewLayerData(eews)).result.current.eewAreaFills
}

function epicentersOf(eews: EEWAlert[]) {
  return renderHook(() => useEewLayerData(eews)).result.current.eewEpicenters
}

describe('useEewLayerData: eewAreaFills', () => {
  it('「〜以上」の予想は区域まで伝わる（色は下限の階級のまま）', () => {
    const [fill] = fillsOf([makeEEW({ id: 'a', areas: [area({ scaleToOrAbove: true })] })])
    expect(fill.scale).toBe(40)
    expect(fill.scaleOrAbove).toBe(true)
  })

  it('上限が定まっている予想では立てない（境界の手前）', () => {
    const [fill] = fillsOf([makeEEW({ id: 'a', areas: [area({ scaleTo: 45 })] })])
    expect(fill.scale).toBe(45)
    expect(fill.scaleOrAbove).toBe(false)
  })

  it('同じ区域に複数の EEW が予想を出したら高い方を採る（既存の規則）', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ scaleTo: 40 })] }),
      makeEEW({ id: 'b', areas: [area({ scaleTo: 55 })] }),
    ])
    expect(fill.scale).toBe(55)
  })

  it('同じ階級で片方だけ「以上」なら「以上」を採る', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ scaleTo: 45 })] }),
      makeEEW({ id: 'b', areas: [area({ scaleTo: 45, scaleToOrAbove: true })] }),
    ])
    expect(fill.scaleOrAbove).toBe(true)
  })

  // 区域の塗りは**震源を持たない**。区域への到達は気象庁の発表値だけを使うと決めたので
  // （→ `docs/forecast-computation-audit.md` の 2）、震源を渡す形へ戻すとその判断ごと崩れる。
  // 型だけでは守れない（フィールドを足しても既存の消費側は壊れない）ため、ここで固定する。
  it('区域の塗りに震源を持たせない（自前計算へ戻さない歯止め）', () => {
    const [fill] = fillsOf([makeEEW({ id: 'a', depth: 20, areas: [area()] })])
    expect(Object.keys(fill).sort()).toEqual(
      ['arrival', 'isWarning', 'name', 'rings', 'scale', 'scaleOrAbove'],
    )
  })

  // 震源×印のポップアップも「以上」を出す。ここの配線を取り違えても型では捕まらない
  // （どちらも同じ useMemo の中で `eewMaxScaleInfo` を分配しているだけ）。
  it('震源の予想最大震度にも「以上」が伝わる', () => {
    const [ep] = epicentersOf([makeEEW({ id: 'a', areas: [area({ scaleToOrAbove: true })] })])
    expect(ep.maxScale).toBe(40)
    expect(ep.maxScaleOrAbove).toBe(true)
  })

  it('上限が定まっている報の震源には立てない（対照）', () => {
    const [ep] = epicentersOf([makeEEW({ id: 'a', areas: [area({ scaleTo: 45 })] })])
    expect(ep.maxScale).toBe(45)
    expect(ep.maxScaleOrAbove).toBe(false)
  })

  // 安全弁: 震源の扱いを変えても、塗る階級の選び方は据え置き（仮定震源要素の予想も塗る）。
  it('仮定震源要素でも区域の塗り自体は出す', () => {
    const fills = fillsOf([
      makeEEW({ id: 'a', condition: '仮定震源要素', areas: [area({ scaleTo: 40, scaleToOrAbove: true })] }),
    ])
    expect(fills).toHaveLength(1)
    expect(fills[0].name).toBe('石川県能登')
  })
})

// 震源×印の差分更新キー。`eew.id` は `dmdata-eew-<eventId>-<serial>` で続報ごとに変わるため、
// そのまま使うと描画側（EewEpicentersGL）がマーカーを作り直し、点滅アニメーションが 0% から
// 始まり直す。実際の続報間隔（1 秒前後）は点滅周期（1.2 秒）より短いので、濃い側に留まった
// まま＝点滅が止まって見える。ポップアップが続報で閉じるのも同じ原因だった。
describe('useEewLayerData: eewEpicenters の差分更新キー', () => {
  // 正: 続報でキーが変わらない。
  it('同じ地震の続報では id が変わらない（報番号を含めない）', () => {
    const [first] = epicentersOf([
      makeEEW({ id: 'dmdata-eew-ev1-1', eventId: 'ev1', serial: '1', areas: [area()] }),
    ])
    const [second] = epicentersOf([
      makeEEW({ id: 'dmdata-eew-ev1-2', eventId: 'ev1', serial: '2', areas: [area()] }),
    ])
    expect(first.id).toBe('ev1')
    expect(second.id).toBe('ev1')
    // 報番号そのものは別フィールドで運ぶ（ポップアップの「第N報」表示に使う）。
    expect(first.serial).toBe('1')
    expect(second.serial).toBe('2')
  })

  // 対照: 別の地震は別のキー。ここが同じになると 2 本の EEW が 1 つのマーカーを奪い合う。
  it('別の地震は別の id になる', () => {
    const list = epicentersOf([
      makeEEW({ id: 'dmdata-eew-ev1-1', eventId: 'ev1', areas: [area()] }),
      makeEEW({ id: 'dmdata-eew-ev2-1', eventId: 'ev2', areas: [area()] }),
    ])
    expect(list).toHaveLength(2)
    expect(new Set(list.map((e) => e.id)).size).toBe(2)
  })

  // 安全弁: eventId が欠けたときのフォールバック。**実データでは通らない**
  // （DMDATA・P2PQuake・Yahoo のいずれの経路も eventId を持つ）。欠けても一意性を失わないことだけ固定する。
  it('eventId が無ければ eew.id を使う', () => {
    const base = makeEEW({ id: 'no-issue', areas: [area()] })
    const [ep] = epicentersOf([{ ...base, issue: undefined }])
    expect(ep.id).toBe('no-issue')
  })
})

// 区域ごとの到達（`EewAreaFill.arrival`）の畳み込み。
//
// **優先順位を持っているのは `utils/eew.ts` の `mergeEewAreaArrival`** で、ここで見るのは
// 「区域塗りがそれを通っているか」。同じ優先順位を登録地点のカウントダウン
// （`useHomeAreaArrival`）とも共有しているので、片方だけ変わると声と画面が食い違う。
describe('useEewLayerData: eewAreaFills の到達', () => {
  const FORECAST = '2024-01-01T16:19:30+09:00'
  const EARLIER = '2024-01-01T16:19:10+09:00'

  it('気象庁が出した到達予測時刻が区域まで伝わる（正）', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ kindCode: '10', arrivalTime: FORECAST })] }),
    ])
    expect(fill.arrival).toEqual({ kind: 'forecast', arrivalMs: Date.parse(FORECAST) })
  })

  it('PLUM 法の区域の時刻は採らない（対照）', () => {
    // あの時刻は到達の予測ではなく「その震度を初めて予測した時刻」＝過去の時刻。
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ kindCode: '19', arrivalTime: FORECAST })] }),
    ])
    expect(fill.arrival).toEqual({ kind: 'none', arrivalMs: null })
  })

  it('PLUM 法の報が先に来ても、後から来た予測時刻を弾かない（安全弁）', () => {
    // PLUM の区域は**時刻を持っている**ので、「時刻がある方を採る」と書くと先着が勝ち、
    // 正当な予測が画面から消える。
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ kindCode: '19', arrivalTime: EARLIER })] }),
      makeEEW({ id: 'b', areas: [area({ kindCode: '10', arrivalTime: FORECAST })] }),
    ])
    expect(fill.arrival).toEqual({ kind: 'forecast', arrivalMs: Date.parse(FORECAST) })
  })

  it('別の地震が未到達の予測を出していれば、到達済みより優先する（安全弁）', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ kindCode: '11', arrived: true })] }),
      makeEEW({ id: 'b', areas: [area({ kindCode: '10', arrivalTime: FORECAST })] }),
    ])
    expect(fill.arrival).toEqual({ kind: 'forecast', arrivalMs: Date.parse(FORECAST) })
  })

  it('どの報も到達済みしか伝えていなければ到達済みを返す（対照）', () => {
    const [fill] = fillsOf([makeEEW({ id: 'a', areas: [area({ kindCode: '11', arrived: true })] })])
    expect(fill.arrival).toEqual({ kind: 'arrived', arrivalMs: null })
  })

  it('日時として読めない時刻は捨てる（安全弁）', () => {
    // 引き算して NaN を通すと `NaN > 0` が偽なので「まもなく」側へ落ちる。
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ kindCode: '10', arrivalTime: 'こわれた値' })] }),
    ])
    expect(fill.arrival).toEqual({ kind: 'none', arrivalMs: null })
  })

  it('予想震度がより低い報の到達予測も採る（階級とは別に畳む）', () => {
    // 「この区域へいつ届くか」は、どの報が最大震度を与えたかとは別の問い。
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ scaleTo: 55, kindCode: '11', arrived: true })] }),
      makeEEW({ id: 'b', areas: [area({ scaleTo: 40, kindCode: '10', arrivalTime: FORECAST })] }),
    ])
    expect(fill.scale).toBe(55)
    expect(fill.arrival).toEqual({ kind: 'forecast', arrivalMs: Date.parse(FORECAST) })
  })
})
