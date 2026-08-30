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
// 0.5〜2.8 秒と幅があるため、先に届いた電文の方が遅く喋り始めることがあり、そのとき古い側が
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

/** 通知音の遅延（最大 2800ms）を消化してから発話に到達させる */
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

/**
 * 津波の**観測情報**（等級を伝えない続報）。`areas` を空にすると
 * `isTsunamiObservationOnly` が真になり、等級の発表とは別の格・別の主題で読まれる。
 */
function makeTsunamiObs(
  over: {
    id?: string
    name?: string
    value?: number
    /** 観測点を累積で並べる（実電文は既報の観測点も載せ続ける）。 */
    points?: { name: string; value: number }[]
  } = {},
): JMATsunami {
  const points = over.points ?? [{ name: over.name ?? '輪島港', value: over.value ?? 0.3 }]
  return {
    kind: 'tsunami',
    id: over.id ?? 'tsunami-obs-1',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [],
    observations: points.map(p => ({
      name: p.name,
      height: { value: p.value, description: `${p.value}m` },
      districtCode: '390', districtName: '石川県能登',
    })),
  } as unknown as JMATsunami
}

/**
 * 波高未確定（観測中）の観測点を持つ津波。到達だけが確認された状態を表す
 * （`height` を持たせないのが要点。持たせると波高更新の側になる）。
 */
function makeTsunamiArrival(over: { id?: string; name?: string } = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: over.id ?? 'tsunami-arr-1',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [],
    observations: [{
      name: over.name ?? '輪島港',
      districtCode: '390', districtName: '石川県能登',
    }],
  } as unknown as JMATsunami
}

/** 津波の解除。 */
function makeTsunamiCancel(over: { id?: string } = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: over.id ?? 'tsunami-cancel-1',
    eventId: over.id ?? 'tsunami-cancel-1',
    time: '2026-01-01T12:00:00Z',
    cancelled: true,
    cancelReason: 'lifted',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [],
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

/** 南海トラフ関連解説情報（最下位の層）。複数の describe から使うためトップレベルに置く。 */
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
  // 両方向から固定する（ヘルパーは `handleCommentary`）。
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

  // 値がある通常経路（`scale > 0`）でも、確定までは安定待ち（跳躍幅に応じて 300ms〜2000ms）が
  // 挟まる。この間も「EEW はこれから話す」状態のはず。安定待ち中のタイマー
  // （`eewScaleStabilityRef`/`eewLpgmStabilityRef`）を `speechBlocker` が見ていないと、
  // 上のテストと同じ症状（地震情報が滑り込んで確定後の第 2 フェーズに必ず切られる）が
  // 「値が無い理由不明のケース」だけでなく「ほとんどの実地震で通る主経路」で再発する。
  it('EEW の震度が安定待ちで確定するまでの間も、地震情報は待つ', async () => {
    const handle = setup()
    handle(makeEEW())   // 初報 scale=55（6弱）。初出値・跳躍0段階なので安定待ちは 300ms
    await flush()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('緊急地震速報')

    // 震源の読み上げが終わる。第 2 フェーズは安定待ち中（残り約 300ms）
    finishSpeech(0)
    await flush()

    handle(makeQuake())
    await vi.advanceTimersByTimeAsync(200)   // まだ安定待ちの途中
    await flush()
    expect(spokenTexts()).toHaveLength(1)    // 滑り込まない

    // 安定待ちが確定し、第 2 フェーズが読まれ、そのあとに地震情報が続く
    await vi.advanceTimersByTimeAsync(200)
    await flush()
    expect(spokenTexts()[1]).toContain('予想最大震度')
    finishSpeech(1)
    await vi.advanceTimersByTimeAsync(3000)   // 地震情報の通知音の遅延
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
    handle(makeTsunami())                       // 声までの間 2.3 秒
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
  //
  // **かつては後発が割り込んで読んでいた**（2 件目が 1 件目を途中で消す）。この 3 者は相互譲りの
  // 対象になったため、いまは待って読む（`MUTUAL_YIELD_TOPICS`）。取り下げないことが要点なのは
  // 変わらない——取り下げていたら、待っても二度と鳴らない。
  it('主題が違えば、同格の後発が届いても取り下げない（待って読む）', async () => {
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

    // 先に届いた後発地震が読まれ、津波は取り下げられていない
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('後発地震注意情報')

    // 待って読む（どちらも相互譲りの対象なので、割り込みで消し合わない）
    finishSpeech(0)
    await flush()
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

// 優先度は一次元の尺度なので「上が下を切る」一方向しか作れない。ところが同格の中には逆向きの
// 要求が同居している——同じ地震の続報は割り込むべき（言い換え）、長周期と地震情報も割り込むべき
// （新しい方が重い）、しかし津波の観測情報と地震情報はどちらも読みたい（内容が重ならない）。
// 主題で切り分けるのがこの層（実装は `MUTUAL_YIELD_TOPICS`）。
//
// 直した誤りはこれ。観測点の波高が 1 つ更新されるたびに、津波の観測情報が地震情報の読み上げを
// 途中で消していた（等級の発表と同じ `high` で読んでいたため）。
describe('内容が重ならない同格どうしは互いに待つ', () => {
  function handleNankai(handle: ReturnType<typeof setup>, kindName = '調査中') {
    handle({
      kind: 'nankai',
      data: {
        id: 'nankai-1', time: '2026-01-01T12:00:00Z', eventId: 'nankai-evt',
        kindName, cancelled: false,
      },
    } as never)
  }

  it('地震情報の読み上げ中に津波の観測情報が届いても、地震情報を切らない', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeTsunamiObs())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 観測情報は待つ

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('津波観測情報')
  })

  it('津波の観測情報の読み上げ中に地震情報が届いても、観測情報を切らない', async () => {
    const handle = setup()
    handle(makeTsunamiObs())
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('津波観測情報')

    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 地震情報も待つ（格を下げるだけでは切っていた）

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('震度速報')
  })

  // 安全弁。相互譲りは同格どうしの話で、上位には従来どおり切られる。ここを緩めると、
  // 警報の引き上げが観測値の読み上げの後ろに回る。
  it('津波の観測情報は、等級の発表には切られる', async () => {
    const handle = setup()
    handle(makeTsunamiObs())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(2)   // 待たずに割り込む
    expect(spokenTexts()[1]).toContain('大津波警報')
  })

  // 対照。同主題は相互譲りの対象外（言い換えなので、古い観測値を読み切るより最新に置き換える）。
  it('津波の観測情報どうしは、新しい方が割り込む', async () => {
    const handle = setup()
    handle(makeTsunamiObs({ name: '輪島港', value: 0.3 }))
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeTsunamiObs({ id: 'tsunami-obs-2', name: '富山', value: 0.8 }))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
  })

  // 主題を分けたことの安全弁。取り下げの判定は優先度を見ずに到来順だけで裁くため、等級の発表と
  // 観測情報を同じ主題にすると**警報の予約が観測情報に「追い越された」と判定されて取り下がる**。
  it('津波警報の予約は、後から届いた観測情報には取り下げられない', async () => {
    const handle = setup()
    handle(makeTsunami())              // 声までの間 2.3 秒
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    handle(makeTsunamiObs())           // 間 0.8 秒。先に喋り始める
    await settle()

    expect(spokenTexts().some(t => t.includes('大津波警報'))).toBe(true)
  })

  it('津波の読み上げ中に南海トラフ臨時情報が届いても、互いに切らない', async () => {
    const handle = setup()
    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handleNankai(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 同格・別主題なので待つ

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('南海トラフ')
  })

  it('南海トラフ臨時情報の読み上げ中に津波が届いても、臨時情報を切らない', async () => {
    const handle = setup()
    handleNankai(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('南海トラフ')

    handle(makeTsunami())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    finishSpeech(0)
    await flush()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('大津波警報')
  })

  // 待つ理由が変わったら計時をやり直す。相互譲りの上限（180 秒）まで待てる側が、上限の短い相手
  // （上位・EEW は 90 秒）へ切り替わった瞬間に「もう十分待った」と誤認すると、**始まったばかりの
  // EEW を切って読み始める**。「EEW は常に最優先」が破れる経路なので、時間を持ち越さない。
  it('相互譲りを 90 秒より長く待っていても、そのあと始まった EEW は切らない', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handle(makeTsunamiObs())
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 相互譲りで待つ

    // 上位を待つ上限（90 秒）は超え、相互譲りの上限（180 秒）には届かない時間だけ待たせる
    await vi.advanceTimersByTimeAsync(100000)
    await flush()
    expect(spokenTexts()).toHaveLength(1)

    // EEW が地震情報を切って読み始める（ここで観測情報の待ちが次の周回に入る）
    handle(makeEEW())
    await settle()
    expect(spokenTexts().some(t => t.includes('緊急地震速報'))).toBe(true)
    // 観測情報は EEW を切らない（EEW は終わっていないので鳴らない）
    expect(spokenTexts().some(t => t.includes('津波観測情報'))).toBe(false)
  })

  // 対照。相互譲りを持たない同格どうし（地震情報と長周期）は従来どおり割り込む。
  // ここが待ちに変わると、各地の震度（読み切りに 2 分近い）の後ろに長周期が回される。
  it('長周期は、津波の観測情報より後でも地震情報に割り込む', async () => {
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

  // 「何も切らない」を層で宣言している解説情報は、待ちの上限に達しても割り込まない。
  // 割り込みを許すと、各地の震度（2 分近く）の読み上げが 90 秒で切られてその宣言が破れる。
  //
  // **相互譲りの相手を待つときは上限が別**（`MUTUAL_YIELD_SPEECH_MAX_WAIT_MS` = 180 秒）なので、
  // 90 秒では割り込まない。ここは `commentary`（上限 90 秒）を使って上限側の挙動を見ている。
  it('解説情報は、待ちきれなくても割り込まずに黙る', async () => {
    const handle = setup()
    handle(makeQuake())
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    handleCommentary(handle)
    await settle()
    expect(spokenTexts()).toHaveLength(1)

    // 地震情報の読み上げは終わらせない（VOICEVOX の無応答を模擬）
    await vi.advanceTimersByTimeAsync(90000)
    await flush()
    expect(spokenTexts()).toHaveLength(1)   // 見送る
  })
})

// 津波観測点の「既読」は 2 つある。画面（バッジ・スクロール）用は受信時に進み、読み上げ用は
// **声に出す瞬間**に進む。分けているのは、待たされて鳴らなかった観測値まで既読になると、その
// 観測点が二度と読まれないため。相互譲りで待つようになったぶん、この取りこぼしは起きやすい。
describe('読み上げた観測点の既読', () => {
  it('鳴らなかった観測点は既読にならず、次の電文でもう一度読まれる', async () => {
    const handle = setup()
    // 観測情報 A（輪島港）を予約させ、間が明ける前に累積した B を届けて取り下げさせる
    handle(makeTsunamiObs({ points: [{ name: '輪島港', value: 0.3 }] }))
    await vi.advanceTimersByTimeAsync(200)
    await flush()
    handle(makeTsunamiObs({
      id: 'tsunami-obs-2',
      points: [{ name: '輪島港', value: 0.3 }, { name: '富山', value: 0.5 }],
    }))
    await settle()

    // A は取り下げられて一言も鳴っていない。よって輪島港は既読になっておらず、B で読まれる
    const spoken = spokenTexts().join('')
    expect(spoken).toContain('富山')
    expect(spoken).toContain('輪島港')
  })

  // 対照。鳴った観測点は既読になるので、累積した次の電文では読み直さない
  // （ここが効かないと、観測が続く間ずっと同じ観測点を読み続ける）。
  it('鳴った観測点は、累積した次の電文では読まれない', async () => {
    const handle = setup()
    handle(makeTsunamiObs({ points: [{ name: '輪島港', value: 0.3 }] }))
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('輪島港')

    finishSpeech(0)
    await flush()
    handle(makeTsunamiObs({
      id: 'tsunami-obs-2',
      points: [{ name: '輪島港', value: 0.3 }, { name: '富山', value: 0.5 }],
    }))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('富山')
    expect(spokenTexts()[1]).not.toContain('輪島港')
  })

  // 件数上限（`OBS_UPDATE_SPEAK_MAX_POINTS` = 5）で読まれなかった観測点は既読にしない。
  // 既読にすると、波高がさらに上がるまでその観測点は差分に出てこない。
  it('件数上限で読まれなかった観測点は既読にならない', async () => {
    const handle = setup()
    const many = [1, 2, 3, 4, 5, 6].map(i => ({ name: `観測点${i}`, value: i / 10 }))
    handle(makeTsunamiObs({ points: many }))
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('観測点6')      // 波高の大きい順に 5 件
    expect(spokenTexts()[0]).not.toContain('観測点1')  // 最小の 1 件は上限で落ちる

    finishSpeech(0)
    await flush()
    // 同じ内容の続報でも、まだ読んでいない観測点1は読み上げ対象に残っている
    handle(makeTsunamiObs({ id: 'tsunami-obs-2', points: many }))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('観測点1')
  })

  // 等級の発表で読むのは**区域の予想波高**で、観測点の実測値は読まない。読んでいないものを
  // 既読にすると、直後の観測情報でその実測値が読まれなくなる。
  it('等級の発表に同梱された観測点の実測値は、既読にならない', async () => {
    const handle = setup()
    const withObs = {
      ...makeTsunami(),
      observations: [{
        name: '輪島港',
        height: { value: 0.3, description: '0.3m' },
        districtCode: '390', districtName: '石川県能登',
      }],
    } as unknown as JMATsunami
    handle(withObs)
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('大津波警報')

    finishSpeech(0)
    await flush()
    handle(makeTsunamiObs({ id: 'tsunami-obs-2', points: [{ name: '輪島港', value: 0.3 }] }))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('輪島港')
  })

  // 解除では観測点の記憶（波高・名前）をすべて落とす。名前を残すと、前の津波で「観測中」の
  // まま終わった観測点は次の津波で「新規到達」と見なされず、到達を一度も伝えられない。
  it('解除を挟めば、同じ観測点の到達確認をもう一度読む', async () => {
    const handle = setup()
    handle(makeTsunamiArrival())
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('到達を確認しました')
    finishSpeech(0)
    await flush()

    handle(makeTsunamiCancel())
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('解除')
    finishSpeech(1)
    await flush()

    // 別の津波で同じ観測点に再び到達（記憶が落ちているので読み直す）
    handle(makeTsunamiArrival({ id: 'tsunami-arr-2' }))
    await settle()
    expect(spokenTexts()).toHaveLength(3)
    expect(spokenTexts()[2]).toContain('到達を確認しました')
  })

  // 対照。解除を挟まなければ既読が効いたままで、同じ到達を読み直さない
  // （読み直すと、観測が続く間ずっと「到達を確認しました」を繰り返す）。
  it('解除を挟まなければ、同じ観測点の到達確認は読み直さない', async () => {
    const handle = setup()
    handle(makeTsunamiArrival())
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    finishSpeech(0)
    await flush()

    handle(makeTsunamiArrival({ id: 'tsunami-arr-2' }))
    await settle()
    expect(spokenTexts()).toHaveLength(1)   // 読み上げ文が組まれない
  })

  // 安全弁。波高が上がった観測点は、一度読んでいても読み直す（既読は「読んだ値」を持つ）。
  it('一度読んだ観測点でも、波高が上がれば読み直す', async () => {
    const handle = setup()
    handle(makeTsunamiObs({ points: [{ name: '輪島港', value: 0.3 }] }))
    await settle()
    finishSpeech(0)
    await flush()

    handle(makeTsunamiObs({ id: 'tsunami-obs-2', points: [{ name: '輪島港', value: 1.2 }] }))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toContain('輪島港')
  })
})
