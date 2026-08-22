// @vitest-environment jsdom
//
// 非 EEW の読み上げの優先度のテスト。
//
// `speakWithVoicevox` は待ち行列ではなく割り込み（既存の再生を stop し、進行中の合成を abort
// する）。優先度を持たせないと緊急度の低い情報が重い情報を途中で消す。2024/1/1 能登の実電文を
// 再生したとき、大津波警報の読み上げがその 30 秒後に始まった地震情報に消されていた。
//
// ここで固定するのは 2 つの規則。**割り込みを許すのは「自分の優先度が読み上げ中のものと
// 同じか高いとき」だけ**。同格どうしは新しい方が勝つ（震度速報の更新が古い震度速報を置き換える
// のは正しい挙動で、ここを待ち行列にすると最新の震度がいつまでも出てこない）。
//
// もう 1 つは**到来順**。「新しい方が勝つ」は割り込みだけでは足りない。通知音との間は種別ごとに
// 0.5〜4.2 秒と幅があるため、先に届いた電文の方が遅く喋り始めることがあり、そのとき古い側が
// 新しい側の声を切っていた（原則が逆向きに破れる）。後から同格以上が予約されたら取り下げる。
//
// 読み上げの完了を任意の時点で起こせるよう、モックは解決関数を外に出して保持する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, IssueType, EEWAlert } from '../types/earthquake'

/**
 * 発話ごとに「まだ再生中」の Promise を返し、解決関数を控えておく。
 *
 * **新しい発話が来たら、前の発話の Promise を解決する。** 実装（`voicevox.ts`）は単一の
 * グローバルセッションを持ち、新しい `speakWithVoicevox` が古いセッションを無効化すると
 * 古い呼び出し自身が完了扱いで resolve する。ここを再現しないと「割り込みで待ちが明ける」
 * という実際の連鎖がテストで一度も踏まれない。
 */
const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }   // 割り込みで打ち切られた側は完了扱いになる
  }
  let finish!: () => void
  const p = new Promise<void>(r => { finish = r })
  speeches.push({ text, finish, done: false })
  return p
})

/** 明示的に読み上げを終わらせる（割り込みではなく自然終了を模擬する） */
function finishSpeech(index: number) {
  const s = speeches[index]
  if (s && !s.done) { s.done = true; s.finish() }
}
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
  // 先行合成は「使えなかった」扱いにして、本再生側で合成し直す経路を通す
  prewarmVoicevox: () => null,
  // 鳴ったチャンクの判定に使う（このモックはチャンクの通知を出さないので常に null で足りる）
  getSpeechClock: () => null,
}))
vi.mock('../utils/alertSound', () => ({ playAlertSound: vi.fn() }))
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

function spokenTexts(): string[] {
  return speeches.map(s => s.text)
}

/** 読み上げは Promise チェーンで繋がっているため、保留中のマイクロタスクを流し切る */
async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** 通知音の遅延（最大 4200ms）を消化してから発話に到達させる */
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
}

function makeQuake(over: { id?: string; type?: IssueType; addr?: string } = {}): JMAQuake {
  return {
    kind: 'quake',
    id: over.id ?? 'quake-1',
    time: '2026-01-01T12:00:00Z',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: over.type ?? '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 6.1 },
      maxScale: 50,
      domesticTsunami: '警報等',
    },
    points: [{ pref: '石川県', addr: over.addr ?? '石川県能登', isArea: true, scale: 50 }],
  } as JMAQuake
}

function makeTsunami(over: { id?: string } = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: over.id ?? 'tsunami-1',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登', maxHeight: { description: '5m', value: 5 } }],
  } as unknown as JMATsunami
}

function makeEEW(over: { noAreas?: boolean; condition?: string } = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'eew-1',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      // 予想震度が付かない理由はここが持つ（`eewNoForecastReason`）。**earthquake の外に置くと
      // 実装が見る場所と食い違い、意図した経路を通らない**。以前ここを外に置いていたため、
      // 仮定震源要素のつもりのケースが実際には「理由不明」として扱われていた。
      condition: over.condition ?? '',
      hypocenter: { name: '能登半島沖', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: 'eew-evt', serial: '1', time: '2026-01-01T12:00:00Z' },
    areas: over.noAreas
      ? []
      : [{ pref: '石川県', name: '石川県能登', scaleFrom: 45, scaleTo: 55, kindCode: '10', arrivalTime: null }],
  } as unknown as EEWAlert
}

function setup() {
  const settings = {
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
    // 解説情報の読み上げはこの設定で切れるため、優先度を見るテストでは明示的に有効にする
    nankaiCommentaryAlerts: true,
  } as unknown as AppSettings
  // title API は多数のメソッドを持つため、未知のプロパティも関数として返す Proxy で代替する
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(), expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('非 EEW の読み上げの優先度', () => {
  // 能登で実際に起きた誤りがこれ。大津波警報の読み上げが後続の地震情報に消えていた。
  it('地震情報は、津波の読み上げが終わるまで待つ', async () => {
    const handle = setup()
    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('大津波警報')

    // 津波の読み上げが続いている間に地震情報が届く
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // まだ割り込んでいない

    // 津波の読み上げが終われば地震情報が読まれる
    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('震度速報')
  })

  it('津波は、地震情報の読み上げを待たずに割り込む', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeTsunami())
    await settle()
    // 緊急度が上なので待たない（読み上げ中の地震情報は割り込みで消える）
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('大津波警報')
  })

  // 長周期地震動は地震情報と同格（2026-08-20 に変更）。同格どうしは新しい方が勝つ規則なので、
  // 地震情報の読み上げ中に届けば割り込んで読む。軽い段に分けていた頃は、各地の震度
  // （数千文字・読み切りに 2 分近く）の後ろへ回されて大幅に遅れていた。
  it('長周期地震動情報は、地震情報の読み上げに割り込んで読まれる', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle({
      kind: 'lpgm',
      data: {
        eventId: 'lpgm-1', cancelled: false, time: '2026-01-01T12:00:00Z',
        areas: [{ pref: '石川県', name: '石川県能登', lpgmClass: 4 }],
      },
    } as never)
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('長周期')
  })

  // 南海トラフ関連解説情報は最下位。臨時情報の発表期間中は毎日届くため、既存のどの層と同格に
  // しても何かを切ってしまう（同格は待たずに割り込む規則のため）。「解説情報は何も切らない」を
  // 両方向から固定する。
  function handleCommentary(handle: ReturnType<typeof setup>) {
    handle({
      kind: 'nankaiCommentary',
      data: {
        id: 'commentary-1', time: '2026-01-01T12:00:00Z', eventId: 'commentary-evt',
        serialCode: '210', serialName: '臨時解説',
        headline: '南海トラフ地震関連解説情報（第１号）', summary: '要約', body: '本文',
        cancelled: false, reportDateTime: '2026-01-01T12:00:00Z',
        expireAt: '2026-01-08T12:00:00Z',
      },
    } as never)
  }

  it('解説情報は、地震情報の読み上げが終わるまで待つ', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handleCommentary(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 地震情報を切らない

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('解説情報')
  })

  it('解説情報は、長周期地震動の読み上げが終わるまで待つ（最下位なので何も切らない）', async () => {
    const handle = setup()
    handle({
      kind: 'lpgm',
      data: {
        eventId: 'lpgm-1', cancelled: false, time: '2026-01-01T12:00:00Z',
        areas: [{ pref: '石川県', name: '石川県能登', lpgmClass: 4 }],
      },
    } as never)
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('長周期')

    handleCommentary(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 長周期を切らない

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('解説情報')
  })

  it('長周期地震動は、解説情報の読み上げを待たずに割り込む', async () => {
    const handle = setup()
    handleCommentary(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('解説情報')

    handle({
      kind: 'lpgm',
      data: {
        eventId: 'lpgm-1', cancelled: false, time: '2026-01-01T12:00:00Z',
        areas: [{ pref: '石川県', name: '石川県能登', lpgmClass: 4 }],
      },
    } as never)
    await settle()
    // 解説情報より上なので待たない
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('長周期')
  })

  // 待ちきれなかったときは割り込むことを選ぶ。ここが無いと、VOICEVOX が無応答になった端末で
  // 優先度の低い読み上げが永久に出てこなくなる。
  it('優先度の高い読み上げが終わらなくても、上限を過ぎれば割り込んで読む', async () => {
    const handle = setup()
    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 待っている

    // 津波の読み上げは終わらせない（VOICEVOX の無応答を模擬）
    await vi.advanceTimersByTimeAsync(90000)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('震度速報')
  })

  // 待ちの条件は毎周回で作り直す必要がある。一度きりの判定にすると、待っている間に始まった
  // EEW を待ち明けの非 EEW が後ろから切り、「EEW は常に最優先」の前提が崩れる。
  it('優先度待ちの最中に EEW が始まったら、待ち明けでも EEW を切らない', async () => {
    const handle = setup()
    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 津波を待っている

    // 待っている最中に EEW が発報する（EEW は待たずに割り込む）
    handle(makeEEW())
    await settle()
    const afterEew = spokenTexts().length
    expect(spokenTexts().some(t => t.startsWith('緊急地震速報'))).toBe(true)

    // 津波の読み上げが終わっても、EEW が読み上げ中なので地震情報はまだ読まない
    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(afterEew)
    expect(spokenTexts().some(t => t.includes('震度速報'))).toBe(false)
  })

  // 初報に予想震度が無く**付かない理由も判らない**EEW は、値が付くのを最大 3 秒待つ
  // （`EEW_PHASE2_MAX_WAIT_MS`）。その待機中は EEW の発話が途切れて見えるため、進行中かどうか
  // だけを見ていると地震情報が滑り込み、待ち明けの第 2 フェーズに**必ず**切られる
  // （2024/1/1 能登 16:08 の震源情報が残り 5.7 秒で消えていた）。
  it('EEW が予想震度の確定を待っている間も、地震情報は待つ', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true }))
    await flush()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('緊急地震速報')

    // 震源の読み上げが終わる。第 2 フェーズは値を待っている状態
    finishSpeech(0)
    await flush()

    handle(makeQuake())
    await vi.advanceTimersByTimeAsync(1000)   // 地震情報の通知音の遅延
    await flush()
    expect(spokenTexts()).toHaveLength(1)     // 滑り込まない

    // 上限で第 2 フェーズが読まれ、そのあとに地震情報が続く
    await vi.advanceTimersByTimeAsync(3000)
    await flush()
    expect(spokenTexts()[1]).toContain('予想震度なし')
    finishSpeech(1)
    await flush()
    expect(spokenTexts()[2]).toContain('震度速報')
  })

  // 仮定震源要素（単独点処理）は予想震度が載らないと判っているため待たずに読む。ここで固定するのは
  // **第 1 フェーズが終わった瞬間の隙間を、予約済みの第 2 フェーズが取る**こと（3 番目の assert）。
  // 予約が第 1 フェーズの完了後まで遅れると、待たされていた地震情報がこの隙間に入り、震源と予想値の
  // 間に別の情報が挟まる。
  it('待たずに読む第 2 フェーズも、地震情報に追い越されない', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true, condition: '仮定震源要素' }))
    await flush()
    expect(spokenTexts()).toHaveLength(1)     // 第 1 フェーズが再生中
    expect(spokenTexts()[0]).toContain('緊急地震速報')

    handle(makeQuake())
    await vi.advanceTimersByTimeAsync(5000)   // 地震情報の通知音の遅延を消化しても
    await flush()
    expect(spokenTexts()).toHaveLength(1)     // 予約済みの第 2 フェーズを追い越さない

    finishSpeech(0)
    await flush()
    expect(spokenTexts()[1]).toContain('単独点処理のため、予想震度なし。')

    finishSpeech(1)
    await flush()
    expect(spokenTexts()[2]).toContain('震度速報')
  })

  // 待ち行列にしてはいけない側。新しい震度速報が古い震度速報を置き換えるのは正しい挙動で、
  // 待たせると最新の震度がいつまでも読まれない。
  it('同格どうしは待たず、新しい方が読み上げを置き換える', async () => {
    const handle = setup()
    handle(makeQuake({ id: 'quake-1' }))
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeQuake({ id: 'quake-2', type: '各地の震度情報', addr: '富山県東部' }))
    await settle()
    // 1 件目は解決させていない。それでも 2 件目が読まれるので待っていない
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('富山県東部')
  })

  // 到来順の規則。震源情報は声までの間が 1.7 秒、震度速報は 0.5 秒。震源情報の直後に震度速報が
  // 届くと震度速報の方が先に喋り始めるため、優先度だけで裁いていた頃は**古い震源情報が新しい
  // 震度速報を途中で切っていた**。「同格どうしは新しい方が勝つ」の逆で、聞こえ方も順序が
  // 入れ替わる。後から同格以上が予約されていたら、先に届いた側を取り下げる。
  it('先に届いた同格の読み上げは、後から届いた方に追い越されたら取り下げる', async () => {
    const handle = setup()
    handle(makeQuake({ type: '震源情報' }))
    await vi.advanceTimersByTimeAsync(600)      // 震源情報の間（1.7 秒）が明ける前に
    await flush()
    handle(makeQuake({ type: '震度速報' }))
    await settle()
    // 震源情報は読まれない（取り下げ）。新しい震度速報だけが最後まで読まれる
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('震度速報')
  })

  // 対照。取り下げるのは「間が明ける前に追い越された」ときだけで、順に読み切れる間隔なら
  // どちらも読まれる（実運用の震度速報 → 震源情報は数十秒あく）。
  it('間隔が十分あれば、震源情報と震度速報は両方読まれる', async () => {
    const handle = setup()
    handle(makeQuake({ type: '震源情報' }))
    await settle()
    finishSpeech(0)
    await flush()
    handle(makeQuake({ type: '震度速報' }))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[0]).toContain('震源情報')
    expect(spokenTexts()[1]).toContain('震度速報')
  })

  // 安全弁。追い越しの判定は到来順と優先度の**両方**を見る。到来順だけで判断すると、後から
  // 届いた軽い読み上げのために重い側を取り下げてしまう（津波が読まれなくなる）。
  it('後から届いたのが軽い読み上げなら、先に届いた重い方を取り下げない', async () => {
    const handle = setup()
    handle(makeTsunami())                       // 声までの間 4.2 秒
    await vi.advanceTimersByTimeAsync(600)
    await flush()
    handle(makeQuake())                         // 声までの間 0.5 秒
    await settle()
    expect(spokenTexts().some(t => t.includes('大津波警報'))).toBe(true)
  })

  // 取り下げるのは**同じ主題**の後発に追い越されたときだけ。`high` には津波・南海トラフ臨時情報・
  // 後発地震注意情報が同居しているが、これは「聞き逃したときの損失が大きいから」同格に置いている
  // のであって互いの言い換えではない。主題を見ずに取り下げると、聞き逃し防止のための層で
  // まるごと聞き逃す（後発地震注意情報が一言も鳴らずに消える）。
  it('主題が違えば、同格の後発が届いても取り下げない', async () => {
    const handle = setup()
    handle({
      kind: 'kohatsu',
      data: {
        id: 'kohatsu-1', time: '2026-01-01T12:00:00Z', eventId: 'kohatsu-evt',
        headline: '北海道・三陸沖後発地震注意情報', cancelled: false,
      },
    } as never)
    await vi.advanceTimersByTimeAsync(200)     // 後発地震の間（1.5 秒）が明ける前に
    await flush()
    handle(makeTsunami())                      // 同格（high）だが別の主題
    await settle()

    // どちらも鳴る（後発地震が先に読まれ、津波が割り込んで読む）
    expect(spokenTexts().some(t => t.includes('後発地震注意情報'))).toBe(true)
    expect(spokenTexts().some(t => t.includes('大津波警報'))).toBe(true)
  })

  // 取り下げが決まった予約は「最後に予約されたもの」から降りる。降りないと、自分より前に
  // 予約されていた読み上げが「後発に追い越された」と誤認して連鎖的に取り下がり、**追い越した側も
  // 追い越された側も鳴らない**。
  it('後発が取り下げられたら、先に届いていた読み上げは読まれる', async () => {
    const handle = setup()
    handle(makeQuake({ type: '震源情報' }))    // 声までの間 1.7 秒
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    handle(makeQuake({ type: '震度速報' }))    // 声までの間 0.5 秒
    await vi.advanceTimersByTimeAsync(100)
    await flush()

    // 震度速報の間が明ける前に EEW が発報する（EEW は間を置かず即座に読む）
    handle(makeEEW())
    await flush()
    expect(spokenTexts()[0]).toContain('緊急地震速報')

    // 震度速報は EEW に追い越されて取り下げられる
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(spokenTexts()).toHaveLength(1)

    // EEW の読み上げ（震源 → 予想震度の 2 フェーズ）を読み切らせる。残っていると EEW が最優先の
    // ままなので、震源情報が読まれない理由が「連鎖」か「EEW 待ち」か切り分けられない。
    for (let i = 0; i < 5; i++) {
      speeches.forEach((_, idx) => finishSpeech(idx))
      await flush()
    }

    // 震源情報の間（1.7 秒）が明ける。取り下げが連鎖していなければ読まれる
    await vi.advanceTimersByTimeAsync(2000)
    await flush()
    expect(spokenTexts().some(t => t.includes('震源情報'))).toBe(true)
  })

  // 主題はイベントごとに分ける。別の地震は別のイベントで内容が重ならないため、種別だけでまとめると
  // 後から処理された地震だけが読まれ、その前に届いた別の地震が一言も鳴らずに消える
  // （同分に 2 つの地震が起きることは実際にある）。
  it('別の地震の読み上げは、同じ種別でも取り下げない', async () => {
    const handle = setup()
    handle(makeQuake({ id: 'quake-1', type: '震源情報' }))    // 声までの間 1.7 秒
    await vi.advanceTimersByTimeAsync(200)
    await flush()
    handle(makeQuake({ id: 'quake-2', type: '震度速報', addr: '富山県東部' }))   // 間 0.5 秒
    await settle()

    // 別の地震なので、先に届いた震源情報は取り下げられない（読み始めてから切られる）
    expect(spokenTexts().some(t => t.includes('震度速報'))).toBe(true)
    expect(spokenTexts().some(t => t.includes('震源情報'))).toBe(true)
  })
})
