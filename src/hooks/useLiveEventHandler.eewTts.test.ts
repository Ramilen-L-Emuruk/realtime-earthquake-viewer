// @vitest-environment jsdom
//
// EEW 読み上げ（震源・予想値）の文言と発話順序のテスト。
//
// ここで守りたいことは 3 つ。
//   1. 予想値は初報・続報とも同じ形で読む（引き上げ専用の短句を持たない）。かつては
//      「震度5強に引き上げ。」という差分の短句で追っていたが、基準にした値を実際に
//      発話したかどうかに依存するため、割り込みで消えた発話を基準にすると「一度も
//      声に出していない値からの引き上げ」を語ることになる。
//   2. 区分は**切り出しの語**で伝える（予報＝「地震動予報、〇〇で地震。」／警報＝「緊急地震速報、
//      〇〇で地震。」）。実際の電文が別物（VXSE45／VXSE43）なので名前も分ける。予報から警報へ
//      上がったときだけ「緊急地震速報に切り替わりました。」と遷移を述べる。初報から警報なら
//      切り出しで伝わっているので重ねて言わない。「特別警報」は音声で使わない（気象庁が発表時に
//      この名称を用いないため）。
//   3. 発話は 1 本のチェーンで直列化する。speakWithVoicevox は待ち行列ではなく割り込み
//      （既存の再生を stop し進行中の合成を abort する）なので、繋がずに投げると前の
//      発話が途中で消える。とくに EEW が同時多発すると互いを消し合う（2024/1/1 能登）。
//
// かつては第 2 フェーズを時間でデバウンスしており、続報が立て続けに届く大地震ほど読み上げが
// 遅れていた（2024/08/08 日向灘 M7.1 で実際に発生）。待つ対象は時間ではなく値の確定・
// 前の発話の完了であることを、以下のテストで固定する。
//
// タイマー制御はブラウザでの目視確認が難しいため、fake timers で検証する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { splitIntoChunks } from '../utils/voicevox'
import type { AppSettings } from './useSettings'
import type { EEWAlert, EEWRegion, IntensityScale, LpgmClass, JMAQuake, JMATsunami } from '../types/earthquake'

const speakMock = vi.fn(() => Promise.resolve())
vi.mock('../utils/voicevox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/voicevox')>()),
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [])),
}))
vi.mock('../utils/alertSound', () => ({ playAlertSound: vi.fn() }))
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

/** 発話されたテキストだけを配列で取り出す（speakWithVoicevox の第 2 引数） */
function spokenTexts(): string[] {
  return speakMock.mock.calls.map(c => (c as unknown as unknown[])[1] as string)
}

/**
 * 発話は Promise チェーン（`Promise.race` → `finally` → `then` → `catch` → `finally`）で
 * 繋がっているため、fake timers を進めるだけでは発話まで到達しない。保留中のマイクロタスクを
 * 流し切る。
 *
 * **回数には余裕を持たせること。** 1 発話あたり 10 ティック弱を要し、複数 EEW が連なると
 * 積み上がる。足りないと「まだ発話が届いていないだけ」の状態で assert してしまい、
 * 落ちたり通ったりするフレーキーなテストになる（実際に一度そうなった）。
 */
async function flushMicrotasks() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

function makeEEW(over: {
  eventId?: string
  serial?: number
  scaleTo?: IntensityScale
  lgIntTo?: LpgmClass
  condition?: string
  noAreas?: boolean
  severity?: 'Forecast' | 'Warning'
  cancelled?: boolean
  depth?: number
  hypocenter?: { name: string; latitude: number; longitude: number }
} = {}): EEWAlert {
  const hypo = over.hypocenter ?? { name: '日向灘', latitude: 32.0, longitude: 132.0 }
  const areas: EEWRegion[] = over.noAreas ? [] : [{
    pref: '宮崎県',
    name: '宮崎県北部平野部',
    scaleFrom: 30,
    scaleTo: over.scaleTo ?? 45,
    kindCode: '10',
    arrivalTime: null,
    lgIntTo: over.lgIntTo,
  }]
  return {
    kind: 'eew',
    id: `eew-${over.serial ?? 1}`,
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: over.condition ?? '',
      hypocenter: { ...hypo, depth: over.depth ?? 30, magnitude: 6.5 },
    },
    severity: over.severity ?? 'Warning',
    cancelled: over.cancelled ?? false,
    issue: { eventId: over.eventId ?? 'evt-1', serial: String(over.serial ?? 1), time: '2026-01-01T12:00:00Z' },
    areas,
  } as EEWAlert
}

function setup() {
  const settings = {
    voicevoxEnabled: true,
    voicevoxUrl: 'http://localhost:50021',
    voicevoxSpeakerId: 1,
    soundEnabled: false,
    soundVolume: 1,
    notifyMinScale: -1,
    notifyEEW: false,
  } as unknown as AppSettings

  const title = {
    alertTitle: null,
    setTitle: vi.fn(),
    applyPriority: vi.fn(),
    scheduleTitleRevert: vi.fn(),
    clearTitleTimer: vi.fn(),
  }

  const { result } = renderHook(() => useLiveEventHandler({
    settings,
    title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(),
    setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(),
    revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(),
    setActiveLpgmEventId: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('EEW 読み上げの文言と発話順序', () => {
  it('初報に予想震度があれば、待たずに第1フェーズの直後に読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()

    // 時間を一切進めずに、震源名（第1フェーズ）と予想値（第2フェーズ）の両方が出ている
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度5強。'])
  })

  // 待つのは「予想震度が遅れて付くかもしれない」ときだけ。付かない理由が判っている
  // （仮定震源要素・深発地震）なら待たない。下の 2 件がその対比。
  it('付かない理由が判らなければ待ち、値が付いた続報の時点で読む（上限を待たない）', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

    // 2 秒後に予想震度が付いた続報が届く
    await vi.advanceTimersByTimeAsync(2000)
    handle(makeEEW({ serial: 2, scaleTo: 45 }))
    await flushMicrotasks()
    expect(spokenTexts()).toContain('予想最大震度5弱。')

    // 上限（3秒）を過ぎても二重に読まない
    await vi.advanceTimersByTimeAsync(10000)
    await flushMicrotasks()
    expect(spokenTexts().filter(t => t.includes('予想最大震度'))).toHaveLength(1)
  })

  it('理由が判らないまま予想震度が付かない場合は上限で打ち切って読む', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true }))
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(2999)
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(1)   // まだ第1フェーズだけ

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(spokenTexts()).toContain('予想震度なし。')
  })

  // 単独点処理・深発地震はその報に予想震度が載らない。待っても結論は理由付きの
  // 「予想震度なし」で変わらないため、上限を待たずに読む（待つと無言の数秒が挟まるだけ）。
  it('仮定震源要素なら待たずに理由付きで読む', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true, condition: '仮定震源要素' }))
    await flushMicrotasks()

    // 時間を一切進めずに第 2 フェーズまで出ている
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '単独点処理のため、予想震度なし。'])
  })

  it('深発地震なら待たずに理由付きで読む', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true, depth: 400 }))
    await flushMicrotasks()

    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '深発地震のため、予想震度なし。'])
  })

  // 待たずに「なし」を読んだ後で震源が確定し、値が付くことはある。引き上げ扱いで言い直す。
  it('待たずに「予想震度なし」を読んだ後、続報に値が付いたら言い直す', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true, condition: '仮定震源要素' }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 45 }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大震度5弱。'])
  })
  // 待っている最中に理由が判明することもある（続報で深さが改められる等）。初報で判っていた
  // 場合と揃えて、そこで待ちを打ち切る。
  it('待機中の続報で理由が判明したら、上限を待たずに読む', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

    await vi.advanceTimersByTimeAsync(1000)
    handle(makeEEW({ serial: 2, noAreas: true, depth: 400 }))
    await flushMicrotasks()
    expect(spokenTexts()).toContain('深発地震のため、予想震度なし。')

    // 打ち切った上限が後から発火して二重に読むことはない
    await vi.advanceTimersByTimeAsync(10000)
    await flushMicrotasks()
    expect(spokenTexts().filter(t => t.includes('予想震度なし'))).toHaveLength(1)
  })

  // 差分の短句（「震度5強に引き上げ。」）は廃止した。初報と同じ形で言い直す。
  it('続報で震度が上がったら、同じ形で言い直す', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 45 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50 }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大震度5強。'])
  })

  // かつてはここで 2 秒のトレーリングデバウンスを張っており、続報が 2 秒以内に連投される
  // 大地震では最終報まで沈黙していた。前の発話の完了を待つ方式なら、待っている間に届いた
  // 続報は最新値へ畳まれ、発話の切れ目で 1 回だけ読まれる。
  it('引き上げが連投されても、待たずに最新値だけを 1 回読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 30 }))
    await flushMicrotasks()
    speakMock.mockClear()

    // 発話の合間に 3 報が立て続けに届く
    for (const [i, s] of [40, 45, 50].entries()) {
      handle(makeEEW({ serial: i + 2, scaleTo: s as IntensityScale }))
    }
    await flushMicrotasks()
    // 途中の 4・5弱 は読まず、最新の 5強 を 1 回だけ読む（時間は進めていない）
    expect(spokenTexts()).toEqual(['予想最大震度5強。'])
  })

  // 階級だけが上がる続報は、震度にもレベル（特別警報の条件は階級 4 以上）にも現れないため、
  // 専用の追跡を持たないと検出できず、従来は無言のまま取りこぼしていた。
  it('震度据え置きで長周期階級だけ上がった続報も読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 2 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 3 }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大震度5強。予想最大階級3。'])
  })

  it('変化のない続報では発話しない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50 }))
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(0)
  })

  it('引き下げの続報では発話しない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 55 }))
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 40 }))
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(0)
  })

  // 発話は Promise で繋がっており途中で止められないため、発話の直前に対象がまだ発表中かを見る。
  it('第1フェーズの再生中に誤報取消が届いたら、取り消された予想震度を読み上げない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    // マイクロタスクを流す前＝第1フェーズの再生中に相当する時点で取消が届く
    handle(makeEEW({ serial: 2, cancelled: true }))
    await flushMicrotasks()

    expect(spokenTexts().some(t => t.includes('予想最大震度'))).toBe(false)
  })

  describe('区分（警報）の読み上げ', () => {
    // 実際の電文が別物（VXSE45 緊急地震速報（地震動予報）／VXSE43 緊急地震速報（警報））なので、
    // 切り出しの語で区別する。予報級まで「緊急地震速報」と読むと実際より重く伝わる。
    it('予報は「地震動予報」と切り出す', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 30, severity: 'Forecast' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。', '予想最大震度3。'])
    })

    // 予報→警報のように severity だけが変わる続報では震度・階級に差が無い。
    // 値だけを見ていると、最も重い区分の変化が無言になる。
    it('震度据え置きでレベルだけ上がった続報は、格上げを述べて読み直す', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報に切り替わりました。予想最大震度5強。'])
    })

    // 初報から警報なら、区分は切り出しの「緊急地震速報、〇〇で地震。」で伝わっている。
    // 以降の引き上げは値だけを読む。前置きを重ねると、値を読み直すだけの報でも毎回
    // 区分が挟まって耳に障る（初期の実装では本震の 5 発話すべてに付いていた）。
    it('初報から警報なら、格上げの言い方は一度も使わない', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50 }))
      await flushMicrotasks()

      handle(makeEEW({ serial: 2, scaleTo: 55 }))
      await flushMicrotasks()
      handle(makeEEW({ serial: 3, scaleTo: 70 }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual([
        '緊急地震速報、日向灘で地震。',
        '予想最大震度5強。',
        '予想最大震度6弱。',
        '予想最大震度7。',
      ])
      expect(spokenTexts().some(t => t.includes('切り替わりました'))).toBe(false)
    })

    // 取消（誤報取消・自動解除）で追跡を消すため、同じ eventId が再利用されれば新規発報として
    // 扱われる。区分は切り出しで伝え直される（伝え直さないと、再発報が警報でも区分が声に出ない）。
    it('取消後に同じ eventId で再発報したら、区分を切り出しで伝え直す', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50 }))
      await flushMicrotasks()
      expect(spokenTexts().filter(t => t === '緊急地震速報、日向灘で地震。')).toHaveLength(1)

      handle(makeEEW({ serial: 2, cancelled: true }))
      await vi.advanceTimersByTimeAsync(1500)
      await flushMicrotasks()

      handle(makeEEW({ serial: 3, scaleTo: 50 }))
      await flushMicrotasks()
      expect(spokenTexts().filter(t => t === '緊急地震速報、日向灘で地震。')).toHaveLength(2)
      // 同じ地震の格上げではないので、遷移の言い方は使わない
      expect(spokenTexts().some(t => t.includes('切り替わりました'))).toBe(false)
    })

    // 気象庁は震度6弱以上（または長周期地震動階級4以上）を予想した緊急地震速報（警報）を
    // 特別警報に位置づけているが、発表時に「特別警報」の名称は用いない。表示・通知・通知音は
    // 2 段階を保つが、音声では区分を「警報」に統一する。
    it('特別警報の条件を満たしても「特別警報」とは読まない', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 70, lgIntTo: 4 }))
      await flushMicrotasks()

      const texts = spokenTexts()
      expect(texts).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度7。予想最大階級4。'])
      expect(texts.some(t => t.includes('特別警報'))).toBe(false)
    })

    it('警報から特別警報の条件へ跨ぐ格上げは、値だけで伝える（「警報」を言い直さない）', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50 }))          // 5強 → 警報
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 55 }))   // 6弱 → 特別警報の条件
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['予想最大震度6弱。'])
    })

    // 予想値を一度も読んでいない段階の格上げでも、第 1 フェーズで「地震動予報、〇〇で地震。」と
    // 伝えてあるので遷移の言い方が通じる。上限（3 秒）を待たずに知らせる。
    it('予想震度待ちの最中にレベルが上がったら、上限を待たず格上げを告げる', async () => {
      const handle = setup()
      handle(makeEEW({ noAreas: true, severity: 'Forecast' }))
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, noAreas: true, severity: 'Warning' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報に切り替わりました。予想震度なし。'])
    })

    // 区分は引き下げない。一度「警報」と伝えた EEW は、以後 severity が落ちても「伝え済み」と
    // して扱う（activeEEWLevelsRef が Math.max で保持するのと同じ方針）。落とすと、severity が
    // 揺れ戻すたびに「警報」を言い直すことになる。
    it('一度「警報」と伝えた後に severity が落ちても、前置きを言い直さない', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50, severity: 'Warning' }))
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 55, severity: 'Forecast' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['予想最大震度6弱。'])
    })
  })

  describe('震源の大幅更新', () => {
    // 震源が大きく動いた続報（地名が変わり 50km 超移動）は第1フェーズから読み直す。
    const FAR_HYPO = { name: '安芸灘', latitude: 34.0, longitude: 132.5 }   // 日向灘から約 230km

    it('新しい震源で読み直す', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 45 }))
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 45, hypocenter: FAR_HYPO }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['震源を更新、安芸灘で地震。', '予想最大震度5弱。'])
    })

    // 旧震源での値を既読として残すと、新震源で確定した値が旧値を超えたときだけ報じられ、
    // 震源が変わったことに触れないまま終わる。
    it('旧震源より低い値でも読み直す', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 55 }))
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 40, hypocenter: FAR_HYPO }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['震源を更新、安芸灘で地震。', '予想最大震度4。'])
    })
  })

  // 2024/1/1 能登半島地震のように EEW が同時多発する状況。状態を eventId 別に持つだけでは
  // 足りず、発話そのものを 1 本に直列化しないと互いを途中で消し合う（speakWithVoicevox は
  // 待ち行列ではなく割り込み）。
  describe('複数 EEW の同時進行', () => {
    const NOTO = { name: '石川県能登地方', latitude: 37.5, longitude: 137.2 }

    it('別の EEW が割り込んでも、双方の震源と予想値が順に読まれる', async () => {
      const handle = setup()
      handle(makeEEW({ eventId: 'A', scaleTo: 30, severity: 'Forecast' }))
      // A の第1フェーズが再生中に相当する時点で、別の地震が発報する
      handle(makeEEW({ eventId: 'B', scaleTo: 50, hypocenter: NOTO }))
      await flushMicrotasks()

      expect(spokenTexts()).toEqual([
        '地震動予報、日向灘で地震。',
        '予想最大震度3。',
        '緊急地震速報、石川県能登地方で地震。',
        '予想最大震度5強。',
      ])
    })

    it('片方の続報が他方の既読値を横取りしない', async () => {
      const handle = setup()
      handle(makeEEW({ eventId: 'A', scaleTo: 45 }))
      handle(makeEEW({ eventId: 'B', scaleTo: 30, severity: 'Forecast', hypocenter: NOTO }))
      await flushMicrotasks()
      speakMock.mockClear()

      // A は 5弱→6弱、B は 3 のまま据え置き
      handle(makeEEW({ eventId: 'A', serial: 2, scaleTo: 55 }))
      handle(makeEEW({ eventId: 'B', serial: 2, scaleTo: 30, severity: 'Forecast', hypocenter: NOTO }))
      await flushMicrotasks()

      // A だけが読み直され、B は据え置きなので黙る
      expect(spokenTexts()).toEqual(['予想最大震度6弱。'])
    })

    // チェーンに reject を残すと、次の発話が待つ対象が rejected promise になり、以降の EEW が
    // 連鎖的に落ちる。その端末では二度と緊急地震速報が読まれなくなるため、必ず捕まえる。
    it('読み上げが失敗しても、後続の EEW は読み上げられる', async () => {
      const handle = setup()
      speakMock.mockImplementationOnce(() => Promise.reject(new Error('VOICEVOX が起動していない')))
      handle(makeEEW({ eventId: 'A', scaleTo: 45 }))
      await flushMicrotasks()

      handle(makeEEW({ eventId: 'B', scaleTo: 50, hypocenter: NOTO }))
      await flushMicrotasks()
      expect(spokenTexts()).toContain('緊急地震速報、石川県能登地方で地震。')
      expect(spokenTexts()).toContain('予想最大震度5強。')
    })

    it('片方が取り消されても、他方の読み上げは続く', async () => {
      const handle = setup()
      handle(makeEEW({ eventId: 'A', scaleTo: 45 }))
      handle(makeEEW({ eventId: 'B', scaleTo: 50, hypocenter: NOTO }))
      handle(makeEEW({ eventId: 'A', serial: 2, cancelled: true }))
      await flushMicrotasks()

      const texts = spokenTexts()
      expect(texts).toContain('緊急地震速報、石川県能登地方で地震。')
      expect(texts).toContain('予想最大震度5強。')
      // A の予想値（5弱）は取消後なので読まれない
      expect(texts).not.toContain('予想最大震度5弱。')
    })
  })

  // 文面を作った瞬間と、音が出る瞬間はずれる（合成の往復＋発話そのもの）。予想震度は
  // 2024/1/1 能登の本震で 5弱 → 7 まで 7.5 秒しかかからなかったため、1 回の発話が終わる前に
  // 古くなる。鳴らす直前に見直して、古い値を鳴らし続けないことを固定する。
  describe('鳴らす直前の見直し', () => {
    // VOICEVOX の合成待ち（最初の音が出るまで）と、1 チャンクの再生時間。
    const SYNTH_MS = 400
    const CHUNK_MS = 1200

    /**
     * `speakWithVoicevox` の代役。合成待ちのあと、チャンクごとに「鳴らす直前の判定」を通し、
     * 通ったものだけを `heard` に積む（voicevox.ts と同じ順序: 判定 → 再生 → 次のチャンク）。
     * チャンクの割り方は本体の `splitIntoChunks` をそのまま使う（手書きで真似ると、本体の
     * 分割条件を変えたときにこのテストだけが古い境界を前提に通り続ける）。
     */
    function installChunkedSpeak(heard: string[]) {
      speakMock.mockImplementation(((...args: unknown[]) => {
        const text = args[1] as string
        const shouldStillPlay = args[4] as (() => boolean) | undefined
        const chunks = splitIntoChunks(text)
        return (async () => {
          await new Promise<void>(r => { setTimeout(r, SYNTH_MS) })
          for (const chunk of chunks) {
            if (shouldStillPlay && !shouldStillPlay()) return
            heard.push(chunk)
            await new Promise<void>(r => { setTimeout(r, CHUNK_MS) })
          }
        })()
      }))
    }

    /** 時間を進めつつ、進めるたびに保留中のマイクロタスクを流し切る。 */
    async function advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms)
      await flushMicrotasks()
    }

    it('合成を待つ間に予想が上がったら、古い値は 1 音も鳴らさない', async () => {
      const heard: string[] = []
      installChunkedSpeak(heard)
      const handle = setup()

      handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
      await flushMicrotasks()
      // 第1フェーズ（合成待ち + 2 チャンク）を鳴らし切る
      await advance(SYNTH_MS + CHUNK_MS * 2)
      expect(heard).toEqual(['緊急地震速報、', '日向灘で地震。'])

      // 第2フェーズは 5弱 で文面が作られ、いまは合成待ち。その間に 6弱 の続報が届く
      await advance(SYNTH_MS / 2)
      handle(makeEEW({ serial: 2, scaleTo: 55, lgIntTo: 2 }))
      await advance(SYNTH_MS / 2)

      // 5弱 は鳴らずに取り下げられ、6弱 だけが鳴る
      await advance(SYNTH_MS + CHUNK_MS * 2)
      expect(heard.filter(c => c.includes('5弱'))).toEqual([])
      expect(heard).toContain('予想最大震度6弱。')
      expect(heard).toContain('予想最大階級2。')
    })

    it('鳴っている途中に予想が上がったら、そこから先のチャンクを鳴らさない', async () => {
      const heard: string[] = []
      installChunkedSpeak(heard)
      const handle = setup()

      handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
      await flushMicrotasks()
      await advance(SYNTH_MS + CHUNK_MS * 2)   // 第1フェーズ
      await advance(SYNTH_MS)                  // 第2フェーズの合成待ち
      expect(heard[heard.length - 1]).toBe('予想最大震度5弱。')

      // 「予想最大震度5弱。」を鳴らしている途中で 6弱 が届く
      await advance(CHUNK_MS / 2)
      handle(makeEEW({ serial: 2, scaleTo: 55, lgIntTo: 2 }))
      await advance(CHUNK_MS)

      // 続きの「予想最大階級1。」は鳴らさず、6弱 の読み直しへ移る
      expect(heard).not.toContain('予想最大階級1。')
      await advance(SYNTH_MS + CHUNK_MS * 2)
      expect(heard).toEqual([
        '緊急地震速報、', '日向灘で地震。',
        '予想最大震度5弱。',
        '予想最大震度6弱。', '予想最大階級2。',
      ])
    })

    it('値が変わらない続報では取り下げず、最後まで鳴らす', async () => {
      const heard: string[] = []
      installChunkedSpeak(heard)
      const handle = setup()

      handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
      await flushMicrotasks()
      await advance(SYNTH_MS + CHUNK_MS * 2)
      await advance(SYNTH_MS)

      // 同じ値の続報（据え置き）が発話中に届く
      await advance(CHUNK_MS / 2)
      handle(makeEEW({ serial: 2, scaleTo: 45, lgIntTo: 1 }))
      await advance(CHUNK_MS * 2)

      expect(heard).toEqual([
        '緊急地震速報、', '日向灘で地震。',
        '予想最大震度5弱。', '予想最大階級1。',
      ])
    })

    it('鳴っている途中に誤報取消が届いたら、そこから先のチャンクを鳴らさない', async () => {
      const heard: string[] = []
      installChunkedSpeak(heard)
      const handle = setup()

      handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
      await flushMicrotasks()
      await advance(SYNTH_MS + CHUNK_MS * 2)
      await advance(SYNTH_MS)
      expect(heard[heard.length - 1]).toBe('予想最大震度5弱。')

      await advance(CHUNK_MS / 2)
      handle(makeEEW({ serial: 2, cancelled: true }))
      await advance(CHUNK_MS * 3)

      expect(heard).not.toContain('予想最大階級1。')
    })
    // 自動解除（最終報から時間が経ってアプリが自ら消すもの）は、誤報取消とは扱いを分ける。
    // 発表が終わっただけで読んでいる内容が誤りだったわけではなく、途中で切ると代わりに読むものも
    // 無い（取消の読み上げは誤報取消のときだけ）。尻切れで終わらせない。
    it('鳴っている途中に自動解除が届いても、最後まで鳴らす', async () => {
      const heard: string[] = []
      installChunkedSpeak(heard)
      const handle = setup()

      handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
      await flushMicrotasks()
      await advance(SYNTH_MS + CHUNK_MS * 2)
      await advance(SYNTH_MS)
      expect(heard[heard.length - 1]).toBe('予想最大震度5弱。')

      await advance(CHUNK_MS / 2)
      handle({ ...makeEEW({ serial: 2, cancelled: true }), expired: true })
      await advance(CHUNK_MS * 2)

      expect(heard).toContain('予想最大階級1。')
    })

  })
})
