// @vitest-environment jsdom
//
// 津波のウィンドウタイトルのテスト。
//
// 2 つを固定する（どちらも 2026-10-12 ユーザー承認）。
//
// 1. **終わったことをタイトルでも伝える。** 解除・取消・失効の報で、津波タブの見出しと同じ語
//    （`CANCEL_REASON_LABEL`）を他の報と同じ長さだけ出してから戻す。「一定時間に制限」が
//    オンの端末では、発表中のタイトルが 30 秒で既定へ戻った後に失効が来るため、以前は
//    失効してもタイトルが 1 文字も変わらなかった。
// 2. **予報だけのときは「津波予報 発表中」と名乗る。** 警報・注意報が 1 区域でもあれば従来どおり。
//    名乗りは描く時点の津波から決める（`resolveAlertTitle`）—— 報を受けた瞬間の記憶で決めると、
//    警報から予報へ下がった報でも 1 度「津波警報・注意報 発表中」と名乗ってしまう。
//
// 終わりの語は優先度ロジックのいちばん下の層に置く（緊急地震速報 > 発表中の津波 > 揺れ検知 >
// 終わりの語 > 平常）。**他の種別の待ちが切れて再評価が走っても消えない**ことも固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  useAlertTitle, resolveAlertTitle, TSUNAMI_ACTIVE_TITLE,
} from './useAlertTitle'
import { isTsunamiForecastOnly, findEndedTsunami } from '../utils/tsunami'
import type { EEWAlert, JMATsunami, TsunamiGrade } from '../types/earthquake'

function makeEEW(): EEWAlert {
  return {
    kind: 'eew',
    id: 'e1',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '日向灘', latitude: 32, longitude: 132, depth: 10, magnitude: 6 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: 'e1', serial: '1', time: '2026-01-01T12:00:00Z' },
    areas: [{ pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 50, scaleTo: 50, kindCode: '10', arrivalTime: null }],
  } as unknown as EEWAlert
}

const EEW_TITLE = '緊急地震速報 日向灘 最大震度5強予想'

function setup(opts: { temporary: boolean; idleRevertSec?: number; eew?: boolean }) {
  const activeEEWsRef = { current: new Map<string, EEWAlert>(opts.eew ? [['e1', makeEEW()]] : []) }
  const kyoshinDetectedRef = { current: false }
  const h = renderHook(() => useAlertTitle({ activeEEWsRef, kyoshinDetectedRef }))
  const sync = (tsunamiActive: boolean) => h.result.current.syncInputs({
    tsunamiActive,
    tsunamiPriority: false,
    tsunamiTitleTemporary: opts.temporary,
    idleRevertSec: opts.idleRevertSec ?? 30,
  })
  return { h, sync, activeEEWsRef, kyoshinDetectedRef }
}

describe('津波が終わったときのタイトル', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 本題。制限オンで発表中のタイトルが既定へ戻った後に失効が来ても、タイトルが変わる
  it('「一定時間に制限」がオンでも、失効すると「津波予報 失効」を 30 秒出してから戻す', () => {
    const { h, sync } = setup({ temporary: true })
    sync(true)
    act(() => { h.result.current.showTsunamiTitle() })
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.result.current.alertTitle).toBeNull()

    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('expired') })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
    act(() => { vi.advanceTimersByTime(29_999) })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
    act(() => { vi.advanceTimersByTime(1) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  // 正: 制限オフ（発表中は出し続ける側）でも同じ語を出す
  it('「一定時間に制限」がオフでも、解除で「津波情報 解除」を出してから戻す', () => {
    const { h, sync } = setup({ temporary: false })
    sync(true)
    act(() => { h.result.current.showTsunamiTitle() })
    expect(h.result.current.alertTitle).toBe(TSUNAMI_ACTIVE_TITLE)

    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('lifted') })
    expect(h.result.current.alertTitle).toBe('津波情報 解除')
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  it('取消は「津波情報 取消」と名乗る', () => {
    const { h, sync } = setup({ temporary: true })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('retracted') })
    expect(h.result.current.alertTitle).toBe('津波情報 取消')
  })

  // 安全弁: 理由が無い・表に無い値でも例外を投げず「解除」の語へ倒す（受信処理の残りを飛ばさない）
  it('理由が無い・表に無い値なら「津波情報 解除」へ倒し、例外を投げない', () => {
    const { h, sync } = setup({ temporary: true })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle(undefined) })
    expect(h.result.current.alertTitle).toBe('津波情報 解除')
    expect(() => act(() => {
      h.result.current.showTsunamiEndTitle('unknown-reason' as never)
    })).not.toThrow()
    expect(h.result.current.alertTitle).toBe('津波情報 解除')
    // 待ちも張られている（30 秒で戻る）
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  // 対照: 長さは他の報と同じ規則に従う（自動復帰が 15 秒の設定なら 15 秒）
  it('自動復帰が 15 秒の設定なら、終わりのタイトルも 15 秒で戻す', () => {
    const { h, sync } = setup({ temporary: true, idleRevertSec: 15 })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('expired') })
    act(() => { vi.advanceTimersByTime(14_999) })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
    act(() => { vi.advanceTimersByTime(1) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  // 安全弁: 緊急地震速報の発表中はそちらを出す。速報が終われば残り時間だけ終わりの語が戻る
  it('緊急地震速報が発表中ならそちらを出し、速報が終われば残り時間だけ終わりの語に戻る', () => {
    const { h, sync, activeEEWsRef } = setup({ temporary: true, eew: true })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('expired') })
    expect(h.result.current.alertTitle).toBe(EEW_TITLE)
    act(() => { vi.advanceTimersByTime(10_000) })
    activeEEWsRef.current = new Map()
    act(() => { h.result.current.applyPriority() })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  // 安全弁: 揺れ検知（進行中の揺れ）は終わった津波より上に出す
  it('揺れ検知中はそちらを出し、揺れ検知が終われば終わりの語に戻る', () => {
    const { h, sync, kyoshinDetectedRef } = setup({ temporary: true })
    sync(false)
    kyoshinDetectedRef.current = true
    act(() => { h.result.current.showTsunamiEndTitle('expired') })
    expect(h.result.current.alertTitle).toBe('揺れ検知')
    kyoshinDetectedRef.current = false
    act(() => { h.result.current.applyPriority() })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
  })

  // 正: 他の種別の待ちが終わりの語の途中で切れても消えない（「他の報と同じ長さ」を守る）
  it('地震情報の待ちが途中で切れても、終わりの語は自分の待ちまで残る', () => {
    const { h, sync } = setup({ temporary: true })
    sync(false)
    act(() => {
      h.result.current.setTitle('地震情報 能登半島沖 最大震度3')
      h.result.current.scheduleTitleRevert('earthquake')
    })
    act(() => { vi.advanceTimersByTime(20_000) })
    act(() => { h.result.current.showTsunamiEndTitle('expired') })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
    // 地震情報の待ち（残り 10 秒）が切れて再評価が走る
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  // 対照: 新しい情報が直接タイトルを取ったら、終わりの語は下ろす（後から出し直さない）
  it('地震情報が届いてタイトルを取ったら、終わりの語は戻ってこない', () => {
    const { h, sync } = setup({ temporary: true })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('expired') })
    act(() => { h.result.current.setTitle('地震情報 能登半島沖 最大震度3') })
    act(() => { h.result.current.applyPriority() })
    expect(h.result.current.alertTitle).toBeNull()
  })

  // 正: 進行中のもの（緊急地震速報・揺れ検知）が**後から**始まっても層は崩さない。順番によらず、
  // それが下りれば残り時間だけ終わりの語が戻る（先に出ていた場合は上の 2 件が見ている）
  it('終わりの語の後に緊急地震速報が始まっても、速報が終われば残り時間だけ終わりの語に戻る', () => {
    const { h, sync, activeEEWsRef } = setup({ temporary: true })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('expired') })
    act(() => { vi.advanceTimersByTime(5_000) })
    activeEEWsRef.current = new Map([['e1', makeEEW()]])
    act(() => { h.result.current.setOngoingTitle(EEW_TITLE) })
    expect(h.result.current.alertTitle).toBe(EEW_TITLE)
    act(() => { vi.advanceTimersByTime(10_000) })
    activeEEWsRef.current = new Map()
    act(() => { h.result.current.applyPriority() })
    expect(h.result.current.alertTitle).toBe('津波予報 失効')
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  it('終わりの語の後に揺れの可能性が出ても、それが下りれば終わりの語に戻る', () => {
    const { h, sync } = setup({ temporary: true })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('lifted') })
    act(() => { h.result.current.setOngoingTitle('揺れの可能性') })
    expect(h.result.current.alertTitle).toBe('揺れの可能性')
    // 揺れの可能性のタイトルの待ちが切れて再評価が走る形
    act(() => { h.result.current.applyPriority() })
    expect(h.result.current.alertTitle).toBe('津波情報 解除')
  })

  // 安全弁: 終わりの語の間に新しい津波が来たら発表中へ。**終わりの待ちが残っていれば、津波が
  // 終わった後（sync(false)）に 30 秒目で終わりの語が出直すか平常へ落ちるので、それを見る**
  it('終わりの語の間に新しい津波の報が来たら、終わりの待ちは取り下げられる', () => {
    const { h, sync } = setup({ temporary: false })
    sync(false)
    act(() => { h.result.current.showTsunamiEndTitle('lifted') })
    act(() => { vi.advanceTimersByTime(10_000) })
    sync(true)
    act(() => { h.result.current.showTsunamiTitle() })
    expect(h.result.current.alertTitle).toBe(TSUNAMI_ACTIVE_TITLE)
    // 新しい津波が（解除電文なしに）消えた形。発表中の待ちは 40 秒目まで張られている
    sync(false)
    act(() => { vi.advanceTimersByTime(25_000) })
    // 取り下げ忘れの終わりの待ち（30 秒目）が発火していれば、ここで平常へ落ちている
    expect(h.result.current.alertTitle).toBe(TSUNAMI_ACTIVE_TITLE)
    act(() => { vi.advanceTimersByTime(5_000) })
    // 発表中の待ちが切れて再評価。終わりの語は既に取り下げられているので平常へ
    expect(h.result.current.alertTitle).toBeNull()
  })
})

describe('resolveAlertTitle（発表中の名乗り）', () => {
  it('予報だけなら「津波予報 発表中」', () => {
    expect(resolveAlertTitle(TSUNAMI_ACTIVE_TITLE, true)).toBe('津波予報 発表中')
  })
  it('警報・注意報があれば「津波警報・注意報 発表中」', () => {
    expect(resolveAlertTitle(TSUNAMI_ACTIVE_TITLE, false)).toBe('津波警報・注意報 発表中')
  })
  // App が描くときの組み合わせ（`resolveAlertTitle(title.alertTitle, isTsunamiForecastOnly(tsunamis))`）
  it('描く時点の津波から名乗りを決める（予報だけ → 予報、注意報が混じる → 警報・注意報）', () => {
    expect(resolveAlertTitle(TSUNAMI_ACTIVE_TITLE, isTsunamiForecastOnly([makeTsunami(['Forecast'])])))
      .toBe('津波予報 発表中')
    expect(resolveAlertTitle(TSUNAMI_ACTIVE_TITLE, isTsunamiForecastOnly([makeTsunami(['Forecast', 'Watch'])])))
      .toBe('津波警報・注意報 発表中')
  })
  it('文字列と null はそのまま返す', () => {
    expect(resolveAlertTitle('津波予報 失効', true)).toBe('津波予報 失効')
    expect(resolveAlertTitle(null, true)).toBeNull()
  })
})

function makeTsunami(grades: TsunamiGrade[], over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: 't1',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    areas: grades.map((grade, i) => ({ grade, immediate: false, name: `区域${i}`, code: String(100 + i) })),
    ...over,
  } as unknown as JMATsunami
}

describe('isTsunamiForecastOnly', () => {
  it('発表中の区域が津波予報だけなら真', () => {
    expect(isTsunamiForecastOnly([makeTsunami(['Forecast', 'Forecast'])])).toBe(true)
  })
  it('注意報が 1 区域でもあれば偽', () => {
    expect(isTsunamiForecastOnly([makeTsunami(['Forecast', 'Watch'])])).toBe(false)
  })
  it('別の津波に警報があれば偽', () => {
    expect(isTsunamiForecastOnly([makeTsunami(['Forecast']), makeTsunami(['Warning'], { id: 't2' })])).toBe(false)
  })
  // 対照: 等級の読めない区域が混じれば予報と言い切らない（従来の名乗りに倒す）
  it('等級の読めない区域だけ・予報と混在なら偽', () => {
    expect(isTsunamiForecastOnly([makeTsunami(['Unknown'])])).toBe(false)
    expect(isTsunamiForecastOnly([makeTsunami(['Forecast', 'Unknown'])])).toBe(false)
  })
  // 安全弁: 区域を持たない報（観測情報だけの続報）は判定の材料にしない
  it('区域を持たない報は数えない', () => {
    expect(isTsunamiForecastOnly([makeTsunami(['Forecast']), makeTsunami([], { id: 't2' })])).toBe(true)
  })
  // 安全弁: 解除済み（解除表示中を含む）の津波は数えない
  it('解除済み・解除表示中の津波は数えない', () => {
    expect(isTsunamiForecastOnly([makeTsunami(['Warning'], { cancelled: true }), makeTsunami(['Forecast'], { id: 't2' })])).toBe(true)
    expect(isTsunamiForecastOnly([makeTsunami(['Forecast'], { cancelledAt: new Date() })])).toBe(false)
  })
  it('何も無ければ偽', () => {
    expect(isTsunamiForecastOnly([])).toBe(false)
  })
})

// 終わりの語を出すかは、画面の状態だけで決める（App の解除の検出が使う）。受信した解除がどの津波に
// 向いていたかは画面の更新（`useEarthquakes` の津波の分岐）が既に決めているので、ここで推し量り直さない。
describe('findEndedTsunami（画面に出ていた津波が終わったか）', () => {
  const ended = (reason: JMATsunami['cancelReason']) =>
    makeTsunami(['Forecast'], { cancelledAt: new Date(), cancelReason: reason })

  // 正: 発表中として出ていた津波が、画面の上で解除・失効へ変わった
  it('直前まで発表中だった津波が解除の表示へ変わったら、その津波を返す', () => {
    expect(findEndedTsunami([ended('expired')])?.cancelReason).toBe('expired')
  })

  // 正: 続報と解除が同じ描画に畳まれた形。続報の取り込み（`mergeTsunamiReports`）は津波の `id` を
  // 続報のものへ書き換えるので、`id` で照合すると直前の描画の `id` と食い違って出し損ねる
  it('直前の描画と id が違っても（続報で書き換わった直後の解除）返す', () => {
    const afterContinuation = makeTsunami(['Forecast'], { id: 't1-report-3', cancelledAt: new Date(), cancelReason: 'lifted' })
    expect(findEndedTsunami([afterContinuation])?.cancelReason).toBe('lifted')
  })

  // （直前に発表中のものが無かった形 —— 起動時の取り直しで初めから解除の表示で入った津波 —— は、
  // App が tsunamiActive の true→false のときしか呼ばないことで除く。この関数の受け持ちではない）

  // 安全弁: いまも発表中の津波がある（終わっていない）なら返さない
  it('発表中の津波が残っていれば返さない', () => {
    expect(findEndedTsunami([makeTsunami(['Forecast'])])).toBeUndefined()
  })

  // 対照: 解除の表示を経ずに消えた（画面に何も無い）なら返さない
  it('画面から津波が消えただけなら返さない', () => {
    expect(findEndedTsunami([])).toBeUndefined()
  })
})
