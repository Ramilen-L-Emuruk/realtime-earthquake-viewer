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
import { splitIntoChunks, type SpeechOutcome } from '../utils/voicevox'
// 安定待ちの猶予は定数から取る（数値を写すと、値を変えたときにテストだけが古い前提で通り続ける）
import { EEW_PHASE2_STABILITY_SMALL_MS, EEW_PHASE2_STABILITY_LARGE_MS } from '../utils/eew'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { EEWAlert, EEWRegion, IntensityScale, LpgmClass, JMAQuake, JMATsunami } from '../types/earthquake'

// 「鳴っている最中」を再現するための保留。`holdNextSpeech()` で次の 1 回だけ保留にする。
let holdNextCall = false
let releaseHeld: (() => void) | null = null

// モックの発話が鳴っているあいだ真を返すための数。**実物の `isAudioPlaying` は再生中の
// 音源を数えるが、その本体を差し替えているので、ここで同じ役を持たせないと「誰も鳴って
// いない」世界でテストすることになる** —— 待ちの上限が「音が出ている間は計時しない」形に
// なっているため、それでは上限まわりを何も守れない。
//
// **数えるのは音が出ている間だけで、合成待ちは含めない**（`installChunkedSpeak` を見ること）。
// ここを「発話を呼んでから終わるまで」にすると実物の `isSpeaking` と同じ粒度になり、
// **合成が無応答でハングしたときに待ちが延びる**という、この修正が避けたかった形を
// テストでは再現できなくなる。
let mockSpeakingCount = 0
/** 鳴っている数を増やし、減らす手を返す（二重に減らさない）。 */
function beginMockSpeech(): () => void {
  mockSpeakingCount++
  let done = false
  return () => { if (!done) { done = true; mockSpeakingCount-- } }
}
/** 鳴っているものを止める（実物の `activeSources.stop()` / `stopSpeech()` に相当）。 */
function releaseCurrentSpeech() {
  releaseHeld?.()
  releaseHeld = null
}

// **実物の割り込みの仕組みまで模す。** `speakWithVoicevox` は待ち行列ではなく割り込みで、
// 呼ばれた瞬間に鳴っている音を止め、止められた側の再生 Promise はセッション不一致の検知で
// すぐ解決する。モックを単純な即時解決にするとこの相互作用が消え、「割り込みが後ろに並んで
// いた別 EEW の予約を巻き込む」形の回帰を見逃す（実際に一度その穴を作り、レビューで
// 見つかった）。`stopSpeech` も同じ役を持たせないと、言い直しの待ちが明けない。
const speakMock = vi.fn((..._args: unknown[]) => {
  releaseCurrentSpeech()
  if (!holdNextCall) return Promise.resolve({ spoke: true })
  holdNextCall = false
  const endSpeech = beginMockSpeech()
  return new Promise<SpeechOutcome>(resolve => {
    releaseHeld = () => { endSpeech(); resolve({ spoke: true }) }
  })
})
vi.mock('../utils/voicevox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/voicevox')>()),
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [])),
  // 先行合成は「使えなかった」扱いにして、本再生側で合成し直す経路を通す
  prewarmVoicevox: () => null,
  // 鳴ったチャンクの判定に使う（このモックはチャンクの通知を出さないので常に null で足りる）
  getSpeechClock: () => null,
  stopSpeech: () => releaseCurrentSpeech(),
  // 本体を差し替えた以上、「鳴っているか」もこちらで数える（`beginMockSpeech`）。
  isAudioPlaying: () => mockSpeakingCount > 0,
}))
// 音の実体だけ差し替える。**通知音との間（`ttsDelayFor`）は本物を使う** ―― 読み上げの順番と
// 待ち合わせはこの間の長さで決まるため、模擬すると検証の前提が変わる。
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
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

/**
 * 次の 1 発話を「鳴っている最中」の状態で止める。返り値を呼ぶまで解決しない。
 *
 * 予報から警報への言い直しは**鳴っている相手がいるときだけ**起きるため、既定の
 * 「即座に解決するモック」では再現できない（発話が一瞬で終わり、格上げが届く前に
 * 読み終えてしまう）。逆に「切らないこと」を確かめる側でも、止めておかないと
 * 切る余地そのものが無く、テストが何も守らない。
 */
function holdNextSpeech(): () => void {
  holdNextCall = true
  return () => releaseCurrentSpeech()
}

function makeEEW(over: {
  eventId?: string
  serial?: number
  scaleTo?: IntensityScale
  scaleToOrAbove?: boolean
  lgIntTo?: LpgmClass
  lgIntToOver?: boolean
  condition?: string
  noAreas?: boolean
  severity?: 'Forecast' | 'Warning'
  cancelled?: boolean
  depth?: number
  hypocenter?: { name: string; latitude: number; longitude: number }
  /** 警報の対象地方（`Head/Headline/Information` の地方予報区）。警報級の報にだけ入る。 */
  warningRegions?: string[]
} = {}): EEWAlert {
  const hypo = over.hypocenter ?? { name: '日向灘', latitude: 32.0, longitude: 132.0 }
  const areas: EEWRegion[] = over.noAreas ? [] : [{
    pref: '宮崎県',
    name: '宮崎県北部平野部',
    scaleFrom: 30,
    scaleTo: over.scaleTo ?? 45,
    scaleToOrAbove: over.scaleToOrAbove,
    kindCode: '10',
    arrivalTime: null,
    lgIntTo: over.lgIntTo,
    ...(over.lgIntToOver && { lgIntToOver: true }),
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
    ...(over.warningRegions && { warningRegions: over.warningRegions }),
    areas,
  } as EEWAlert
}

/** 直近の `setup` が作ったフックの戻り値。`setupFull` が復元の入口を取り出すために控える。 */
let capturedResult: ReturnType<typeof useLiveEventHandler> | null = null

/**
 * @param over 設定の上書き。読み上げの詳しさの設定を切り替えるテストで使う。
 *   **既定は「設定を入れる前の挙動」**（`DEFAULTS`）なので、渡さなければ従来どおり。
 */
function setup(over: Partial<AppSettings> = {}) {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: true,
    voicevoxUrl: 'http://localhost:50021',
    voicevoxSpeakerId: 1,
    soundEnabled: false,
    soundVolume: 1,
    notifyMinScale: -1,
    notifyEEW: false,
    ...over,
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
    followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true), expandPanelForSpecialInfo: vi.fn(),
    revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(),
    openLpgmFromQuake: vi.fn(),
    openEstimatedIntensity: vi.fn(),
    closeDistributionOnQuakeReport: vi.fn(),
  }))
  capturedResult = result.current
  return result.current.handleLiveEvent
}

/**
 * `setup` と同じだが、リプレイ復元（`restorePreWindowTracking`）も触れる形で返す。
 * 途中から再生を始めたときの既読の復元を確かめるテストで使う。
 */
function setupFull(over: Partial<AppSettings> = {}) {
  const handleLiveEvent = setup(over)
  return { handleLiveEvent, restore: capturedResult!.restorePreWindowTracking }
}

const SPEAK_SYNTH_MS = 400
const SPEAK_CHUNK_MS = 1200

/**
 * 実際にチャンクへ割って鳴らすモック。**`shouldStillPlay` を呼ぶのはこれだけ**で、
 * 既定のモック（即座に解決する）では鳴らす直前の見直し・途中降りの経路を一度も通らない。
 *
 * @param heard 鳴ったチャンクがこの配列へ積まれる
 */
function installChunkedSpeak(heard: string[], opts?: { synthMs?: number; chunkMs?: number }) {
  const synthMs = opts?.synthMs ?? SPEAK_SYNTH_MS
  const chunkMs = opts?.chunkMs ?? SPEAK_CHUNK_MS
  speakMock.mockImplementation(((...args: unknown[]) => {
    const text = args[1] as string
    const shouldStillPlay = args[4] as (() => boolean) | undefined
    const chunks = splitIntoChunks(text)
    return (async (): Promise<SpeechOutcome> => {
      // 合成待ちのあいだは「鳴っていない」。声が出るのは最初のチャンクからで、
      // 待ちの上限が「声が出ている間は計時しない」形なのでここを混ぜてはいけない。
      await new Promise<void>(r => { setTimeout(r, synthMs) })
      let spoke = false
      const endSpeech = beginMockSpeech()
      try {
        for (const chunk of chunks) {
          // 1 チャンクも鳴らずに降りたら `spoke: false`（実物の `speakWithVoicevox` と同じ）
          if (shouldStillPlay && !shouldStillPlay()) return { spoke }
          heard.push(chunk)
          spoke = true
          await new Promise<void>(r => { setTimeout(r, chunkMs) })
        }
        return { spoke }
      } finally {
        endSpeech()
      }
    })()
  }))
}

/** 時間を進めつつ、進めるたびに保留中のマイクロタスクを流し切る。 */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushMicrotasks()
}

/**
 * 条件が満たされるまで小刻みに進める。**「鳴り始めてから」を作るために要る** ——
 * 固定の待ち時間で書くと、チェーンの前段の長さが変わっただけで「鳴る前」に化け、
 * 確かめたい経路を通らないままテストが通ってしまう。
 */
async function advanceUntil(cond: () => boolean, stepMs = 100, maxSteps = 120) {
  for (let i = 0; i < maxSteps && !cond(); i++) await advance(stepMs)
}

beforeEach(() => {
  vi.useFakeTimers()
  speakMock.mockClear()
  // 保留を持ち越すと、次のテストの 1 発話目が解決しないまま止まる
  holdNextCall = false
  releaseHeld = null
  // **鳴っている数も持ち越さない。** 解決しない発話を残したままテストが終わると減算に
  // 到達せず、次のテストが「ずっと誰かが鳴っている」世界で走る —— 待ちの上限が
  // 効かなくなり、そのテストだけが単独実行では通るのに全体では落ちる形になる。
  mockSpeakingCount = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('EEW 読み上げの文言と発話順序', () => {
  // 緊急地震速報の予想最大長周期地震動階級を読むかの設定（`ttsReadEewLpgmClass`）。
  // **純関数（`eewIntensityText`）のテストとは別に要る** —— 設定が効くかどうかは
  // `useLiveEventHandler` が渡すオプションと、既読（`spokenEEWLpgmClassesRef`）の更新条件で決まる。
  describe('長周期地震動階級を読むかの設定（配線）', () => {
    // 対照: 既定は従来どおり階級も読む。
    it('既定では震度に続けて階級も読む', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50, lgIntTo: 3 }))
      await vi.advanceTimersByTimeAsync(2000)
      await flushMicrotasks()
      expect(spokenTexts()).toContain('予想最大震度5強。予想最大階級3。')
    })

    // 正: 切ると階級の句だけが落ちる。
    it('切ると階級の句を落とす', async () => {
      const handle = setup({ ttsReadEewLpgmClass: false })
      handle(makeEEW({ scaleTo: 50, lgIntTo: 3 }))
      await vi.advanceTimersByTimeAsync(2000)
      await flushMicrotasks()
      expect(spokenTexts()).toContain('予想最大震度5強。')
      expect(spokenTexts().some(t => t.includes('階級'))).toBe(false)
    })
  })

  it('初報に予想震度があれば、安定待ち（300ms）の後に読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()
    // 安定待ちの間はまだ第2フェーズが声にならない
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度5強。'])
  })

  // 待つのは「予想震度が遅れて付くかもしれない」ときだけ。付かない理由が判っている
  // （仮定震源要素・深発地震）なら待たない。下の 2 件がその対比。
  it('付かない理由が判らなければ待ち、値が付いた続報の時点で読む（上限を待たない）', async () => {
    const handle = setup()
    handle(makeEEW({ noAreas: true }))
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

    // 2 秒後に予想震度が付いた続報が届く。理由不明タイマーは打ち切られ安定待ちへ切り替わる
    await vi.advanceTimersByTimeAsync(2000)
    handle(makeEEW({ serial: 2, scaleTo: 45 }))
    // 安定待ち（初出値・跳躍0段階なので 300ms）を経て確定する
    await vi.advanceTimersByTimeAsync(300)
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
    // 「震度なし(0)」から値が付く変化は跳躍幅が大きく判定される（scaleIndex差4段階）ため、
    // 急な変化として長め（2000ms）の安定待ちを経る
    await vi.advanceTimersByTimeAsync(2000)
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
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50 }))
    // 5弱(45)→5強(50) は跳躍幅 1 段階（large=2000ms）
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大震度5強。'])
  })

  // かつてはここで 2 秒のトレーリングデバウンスを張っており、続報が 2 秒以内に連投される
  // 大地震では最終報まで沈黙していた。安定待ち方式でも、待っている間に届いた続報は
  // 最新値へ畳まれ、確定の瞬間に 1 回だけ読まれる。
  it('引き上げが連投されても、待たずに最新値だけを 1 回読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 30 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    // 発話の合間に 3 報が立て続けに届く（30→50 は跳躍幅 3 段階＝large=2000ms）
    for (const [i, s] of [40, 45, 50].entries()) {
      handle(makeEEW({ serial: i + 2, scaleTo: s as IntensityScale }))
    }
    await flushMicrotasks()
    // まだ安定待ち中で何も読まれていない
    expect(spokenTexts()).toEqual([])

    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    // 途中の 4・5弱 は読まず、最新の 5強 を 1 回だけ読む
    expect(spokenTexts()).toEqual(['予想最大震度5強。'])
  })

  // 2024/01/01 能登本震の第13報を再現する回帰テスト。直前の確定値（6強）からの跳躍幅が
  // 1段階しかない震度7が届き、608ms後に6強へ訂正された。旧仕様（1段階の変化は small=300ms）
  // では、300ms後にタイマーが先に発火して訂正前の震度7を確定・読み上げてしまっていた
  // （EEW_PHASE2_SCALE_JUMP_STEP_THRESHOLD を 2→1 に下げる前）。閾値変更後は1段階の変化も
  // large（2000ms）を待つため、608ms後の訂正を待てるようになる。
  it('直前の確定値から1段階だけ跳んだ瞬間的な震度7（能登本震13報）は誤読しない', async () => {
    const handle = setup()
    // 6強で確定・読み上げまで進める
    handle(makeEEW({ scaleTo: 60 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度6強。'])
    speakMock.mockClear()

    // 第13報相当: 6強→7（跳躍幅1段階）
    handle(makeEEW({ serial: 2, scaleTo: 70 }))
    await vi.advanceTimersByTimeAsync(608)
    // 第14報相当: 7→6強への訂正（608ms後、まだ large=2000ms の安定待ち中）
    handle(makeEEW({ serial: 3, scaleTo: 60 }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()

    // 震度7は一度も読み上げられない。6強は既読（spoken=6強）のため再読もしない
    expect(spokenTexts()).toEqual([])
  })

  // 2024/08/08 日向灘 M7.1 の回帰テスト。第15報で震度7が0.8秒だけ存在して6強→6弱へ訂正された
  // 事象（安定待ち導入の直接の契機）とは別に、この地震では**6弱を確定・読み上げ済みの後**、
  // 震度7→6強と瞬間的に跳ね上がってから再び6弱へ戻る変動もあった（実データ: 6弱確定→震度7出現
  // →740ms後に6強へ訂正→1570ms後に6弱へ戻る）。6強のサイクルが安定（large=2000ms）する前に
  // 6弱へ戻るため、震度7・6強のどちらも確定・読み上げられず、最終的な6弱（既読と同値）で黙る。
  it('確定・読み上げ済みの値へ戻る前の瞬間的な震度7→6強（日向灘の実データ）は誤読しない', async () => {
    const handle = setup()
    // 6弱で確定・読み上げまで進める
    handle(makeEEW({ scaleTo: 55 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度6弱。'])
    speakMock.mockClear()

    // 6弱→7（跳躍幅2段階）
    handle(makeEEW({ serial: 2, scaleTo: 70 }))
    await vi.advanceTimersByTimeAsync(700)
    // 740ms相当: 7→6強への訂正（跳躍幅1段階、6弱基準）。まだ large=2000ms の安定待ち中
    handle(makeEEW({ serial: 3, scaleTo: 60 }))
    await vi.advanceTimersByTimeAsync(1500)
    // 6強のサイクル開始（訂正時点）から 1500ms しか経っておらず、まだ確定していない
    // 6強→6弱への復帰（跳躍幅0段階、6弱基準）
    handle(makeEEW({ serial: 4, scaleTo: 55 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()

    // 震度7・6強のどちらも一度も読み上げられない。6弱は既読のため再読もしない
    expect(spokenTexts()).toEqual([])
  })

  // 確定値は「安定待ちを通った値」なので、待っている間に上がったぶんはまだ入っていない。
  // 発話の順番が来るまでに次の値が届いていると、画面が上位の予想を出しているのに声だけ一段低い
  // 値を言うことになる（2024/01/01 能登の前震: 第 4 報 +2.1 秒で 5 強・第 7 報 +4.1 秒で 6 弱。
  // 震源を読み終える頃には 6 弱が届いているのに「予想最大震度5強。」を読み、読み終えてから
  // 6 弱を言い直していた）。より高い値が安定待ち中なら、その確定を待ってから読む。
  //
  // 以下 3 件は対で意味を持つ——待つこと（正）／引き下げでは待たないこと（対照）／階級の
  // 安定待ちでは震度を止めないこと（安全弁。「震度は階級の確定を待たない」非対称ルール）。
  it('より高い予想震度が安定待ち中なら、その確定を待って古い値は読まない', async () => {
    const handle = setup()
    const release = holdNextSpeech()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(300)   // 5強で確定（第2フェーズを予約）
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

    // 震源を読んでいる最中に 6弱 が届く（跳躍幅1段階 → large=2000ms の安定待ち）
    handle(makeEEW({ serial: 2, scaleTo: 55 }))
    await flushMicrotasks()
    release()
    await flushMicrotasks()
    // 順番が来ても 5強 は読まない（画面は既に 6弱）
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    // 6弱 の確定で改めて予約され、正しい値だけが 1 回読まれる
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度6弱。'])
  })

  // 対照・安全弁の 2 件は、ガードの `if` を丸ごと外しても通る（外した状態が「待たない」なので
  // 当然そうなる）。守っているのは**待ちすぎる方向の誤実装**——引き下げでも待つ、階級の
  // 安定待ちでも待つ、といった条件の広げ方を入れた瞬間に落ちる。ガードの分岐そのものは
  // 上の「正」が固定している。
  it('引き下げの安定待ち中は待たず、確定済みの値をそのまま読む（対照）', async () => {
    const handle = setup()
    const release = holdNextSpeech()
    handle(makeEEW({ scaleTo: 55 }))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(300)   // 6弱で確定
    await flushMicrotasks()

    // 震源を読んでいる最中に 5強 へ下がる続報（引き下げは追わない方針）
    handle(makeEEW({ serial: 2, scaleTo: 50 }))
    await flushMicrotasks()
    release()
    await flushMicrotasks()
    // 引き下げの確定を待って黙ると、確定済みの 6弱 がいつまでも声にならない
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度6弱。'])
  })

  it('長周期階級の安定待ち中でも、震度の発話は止めない（安全弁）', async () => {
    const handle = setup()
    const release = holdNextSpeech()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 1 }))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(300)   // 震度・階級とも確定
    await flushMicrotasks()

    // 震源を読んでいる最中に階級だけが上がる（震度は据え置き）
    handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 3 }))
    await flushMicrotasks()
    release()
    await flushMicrotasks()
    // 階級の安定待ちを理由に震度を止めてはならない
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度5強。予想最大階級1。'])
  })

  // ガードは「確定を経ずに捨てられたサイクル」の後始末に依存する。捨てた側が同じイベント処理の
  // 中で確定経路を張り直せていなければ、その EEW の予想震度は無言のまま終わる（`enqueuePhase2`
  // のガードの「担保の 3 通り」の 2 番目）。**この 1 件はその張り直しを固定するもので、ガード自体
  // は通らない**——旧値は確定前（安定待ち中）なので第 2 フェーズの予約すら存在せず、`enqueuePhase2`
  // に到達しないまま `clearScaleStability` でサイクルごと捨てられる。ガードとの噛み合わせは次の 1 件。
  it('安定待ち中に震源が大幅更新されても、新震源の値で 1 回だけ読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()
    // 5強 の安定待ち（300ms）が明ける前に、震源が 50km 超動いた続報が届く
    await vi.advanceTimersByTimeAsync(100)
    handle(makeEEW({ serial: 2, scaleTo: 55, hypocenter: { name: '種子島近海', latitude: 30.5, longitude: 131.0 } }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()

    expect(spokenTexts()).toEqual([
      '緊急地震速報、日向灘で地震。',
      '震源を更新、種子島近海で地震。',
      '予想最大震度6弱。',
    ])
  })

  // 対照: 位置不明のセンチネル（-200）へ落ちた続報では「震源を更新」と言わない。
  //
  // **`Number.isFinite(-200)` は真なので、有限性だけを見ていると距離が無意味に大きく出て
  // 「50km 超動いた」と誤判定する。** 位置が判らなくなっただけで震源が動いた保証は無いのに、
  // 読み上げを頭から言い直すことになる。この状態は「震源要素不明」の電文を捨てずに通す
  // ようにして初めて届くようになった（→ quake-spec.md §5）。
  it('位置不明のセンチネルへ落ちた続報では「震源を更新」と言わない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    // 震源名は変わるが、座標は「位置不明」。動いたかどうかは判定できない
    handle(makeEEW({ serial: 2, scaleTo: 50, hypocenter: { name: '種子島近海', latitude: -200, longitude: -200 } }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()

    expect(spokenTexts().some(t => t.includes('震源を更新'))).toBe(false)
  })

  // 震源の大幅更新でサイクルを捨てた**後**に、張り直したサイクルの確定を追い越して値が上がる。
  // ここが「捨てる経路」とガードが実際に噛み合う場面——新震源で確定した値の予約が発話の順番を
  // 待っている間に、さらに高い値が届く。
  it('震源の大幅更新を挟んだ後でも、確定を追い越した引き上げを待つ', async () => {
    const handle = setup()
    const release = holdNextSpeech()
    handle(makeEEW({ scaleTo: 50 }))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    // 震源が 50km 超動く（旧サイクルと確定値を捨てて第 1 フェーズを積み直す）
    handle(makeEEW({ serial: 2, scaleTo: 50, hypocenter: { name: '種子島近海', latitude: 30.5, longitude: 131.0 } }))
    await vi.advanceTimersByTimeAsync(300)   // 新震源の 5強 が確定（第 2 フェーズを予約）
    await flushMicrotasks()
    // 予約が順番を待っている間に 6弱 へ上がる（跳躍幅1段階 → large=2000ms）
    handle(makeEEW({ serial: 3, scaleTo: 55, hypocenter: { name: '種子島近海', latitude: 30.5, longitude: 131.0 } }))
    await flushMicrotasks()
    release()
    await flushMicrotasks()
    // 順番が来ても 5強 は読まない
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '震源を更新、種子島近海で地震。'])

    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual([
      '緊急地震速報、日向灘で地震。',
      '震源を更新、種子島近海で地震。',
      '予想最大震度6弱。',
    ])
  })

  // 安定待ちの上限（EEW_PHASE2_STABILITY_MAX_WAIT_MS=5000ms）は「値が最初に変わった時刻」から
  // 固定でカウントし、値が変わるたびにリセットしない。ここでは常に大きい跳躍幅（large=2000ms）を
  // 保つ値を安定待ちより短い間隔で送り続け、2000ms では一度も確定できないまま上限に達することを
  // 固定する。上限に達したら、そのときの最新値で強制的に確定する。
  it('値が変わり続けても、上限（5秒）で強制的に最新値へ確定する', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 30 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    // baseScale=30 のまま、常に跳躍幅 5〜6 段階（large=2000ms）を保つ値を 1900ms 間隔で送り続ける
    handle(makeEEW({ serial: 2, scaleTo: 70 }))
    await vi.advanceTimersByTimeAsync(1900)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual([])   // まだ安定していない（サイクル開始から1900ms）

    handle(makeEEW({ serial: 3, scaleTo: 60 }))
    await vi.advanceTimersByTimeAsync(1900)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual([])   // サイクル開始から3800ms、まだ上限未満

    handle(makeEEW({ serial: 4, scaleTo: 70 }))
    await vi.advanceTimersByTimeAsync(1300)   // サイクル開始から5100ms、上限（5000ms）を超える
    await flushMicrotasks()
    // 安定を待たず、上限到達時点の最新値（震度7）で強制確定する
    expect(spokenTexts()).toEqual(['予想最大震度7。'])
  })

  // 階級だけが上がる続報は、震度にもレベル（特別警報の条件は階級 4 以上）にも現れないため、
  // 専用の追跡を持たないと検出できず、従来は無言のまま取りこぼしていた。
  it('震度据え置きで長周期階級だけ上がった続報も読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 2 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 3 }))
    // 震度は変化なし。階級だけ新しいサイクルに入り、階級の安定待ち（300ms）を経て確定する。
    // 震度は実際に声に出た値（5強）とちょうど一致しているため繰り返さず、階級部分だけを読む
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大階級3。'])
  })

  // 安全弁: 震度の scale 値が同じでも orAbove（「〜以上」）が変わっていれば「据え置き」とは
  // 見なさず、震度も含めて読み直す。scale だけを見て判定すると、上限が定まらなくなった
  // 変化（「震度4」→「震度4程度以上」）を据え置きと誤認し、階級部分だけの短句に落としてしまう。
  it('震度の scale は同じでも orAbove が変わっていれば、震度も含めて読み直す', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 40, lgIntTo: 2 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度4。予想最大階級2。'])
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 40, scaleToOrAbove: true, lgIntTo: 3 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大震度4程度以上。予想最大階級3。'])
  })

  // 安全弁: **階級側も同じ守りを持つ。** 階級の数値が同じでも「程度以上」が変わっていれば
  // 「据え置き」と見なさず読み直す。数値だけを見て判定すると、上限が定まらなくなった変化
  // （「階級2」→「階級2程度以上」）を据え置きと誤認し、**その変化が無音で消える**。
  //
  // 「程度以上」になる向きは「もっと強いかもしれない」＝安全側の変化なので落とせない。
  // 震度側（1 つ上のテスト）と対称であることを、両方のテストで固定する。
  it('階級の数値は同じでも「程度以上」が変わっていれば読み直す', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 40, lgIntTo: 2 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度4。予想最大階級2。'])
    speakMock.mockClear()

    // 震度は据え置き。階級も数値は 2 のままで「程度以上」だけが付く
    handle(makeEEW({ serial: 2, scaleTo: 40, lgIntTo: 2, lgIntToOver: true }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大階級2程度以上。'])
  })

  // 対照: 数値も「程度以上」も据え置きなら黙る（上の緩和が広がっていないこと）
  it('階級が数値も「程度以上」も据え置きなら読み直さない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 40, lgIntTo: 2, lgIntToOver: true }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度4。予想最大階級2程度以上。'])
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 40, lgIntTo: 2, lgIntToOver: true }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual([])
  })

  // 震度・階級が同一続報で同時に新しい値へ変化すると、階級の安定待ち（300ms固定）の方が
  // 震度側（跳躍幅次第で300〜2000ms）より先に完了することがある。ここで階級の確定だけで
  // 読み上げをトリガーすると、震度がまだ「変化中」なのに「据え置き」と誤判定し、階級だけの
  // 短句を読んだ直後に震度の確定でもう一度全文を読む二重発話になる（`confirmLpgm` へ
  // `!eewScaleStabilityRef.current.has(key)` を追加する前は実際にこれが起きていた）。
  it('震度・階級が同一続報で同時に変化し、階級の安定待ちが先に終わっても二重発話にならない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 1 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度5強。予想最大階級1。'])
    speakMock.mockClear()

    // 震度5強→6弱（跳躍1段階=large2000ms）と階級1→2（300ms固定）が同一続報で同時に変化
    handle(makeEEW({ serial: 2, scaleTo: 55, lgIntTo: 2 }))
    // 階級の安定待ち（300ms）が先に完了する。震度はまだ安定待ち中（2000ms未満）なので
    // 階級だけの短句をトリガーせず、震度の確定を待つ
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual([])

    // 震度の安定待ち（2000ms）が完了すると、震度・階級を一緒に1回だけ読む
    await vi.advanceTimersByTimeAsync(1700)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大震度6弱。予想最大階級2。'])
  })

  // 安全弁: 震度が据え置きへ復帰する一方、階級がまだ未確定のまま `level`（安定待ちを経ない
  // 生イベントから即座に計算される）だけが特別警報相当に上がることがある。この状態で
  // `confirmedLpgm=0` のまま `scaleUnchanged` 経由の短句化に入ると、空文字の発話が生成され
  // 「想定外」警告が誤って出たうえ既読も更新されない、という穴があった（`enqueuePhase2` に
  // `if (scaleUnchanged && confirmedLpgm === 0) return null` を追加する前）。
  it('震度が据え置きに復帰する一方、階級が未確定のまま level だけ上がっても空発話にならない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, severity: 'Warning' }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度5強。'])
    speakMock.mockClear()

    // 震度が瞬間的に6強へ跳躍（3段階=large2000ms）
    handle(makeEEW({ serial: 2, scaleTo: 60 }))
    await vi.advanceTimersByTimeAsync(1900)
    // 震度が5強に戻る（baseScale=50なので跳躍0段階=small300msに切り替わる）
    handle(makeEEW({ serial: 3, scaleTo: 50 }))
    await vi.advanceTimersByTimeAsync(50)
    // 階級が新たに4で届く（震度より50ms遅れて届いたため、震度の安定待ち300msの方が先に完了する）
    handle(makeEEW({ serial: 4, scaleTo: 50, lgIntTo: 4 }))
    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()
    // 震度の安定待ちが先に完了する時点では、latest の生値で level が特別警報相当まで
    // 上がっているが、階級はまだ確定していない（confirmedLpgm=0）。空発話や「想定外」警告を
    // 出さず、黙って階級の確定を待つ
    expect(spokenTexts()).toEqual([])

    // 階級の安定待ちが完了すると、正しく「予想最大階級4。」が読まれる
    await vi.advanceTimersByTimeAsync(50)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大階級4。'])
  })

  // 長周期階級の安定待ちにも震度と同じ上限（5秒）がある。無いと、階級が固定待ち時間（300ms）
  // より短い間隔で変化し続けた場合に、その EEW で階級が一度も読み上げられないまま終わる。
  it('長周期階級が変わり続けても、上限（5秒）で強制的に最新値へ確定する', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 1 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    // 震度は据え置き（50）のまま、階級だけ 200ms 間隔（固定安定待ち 300ms 未満）で変え続ける
    let serial = 2
    for (const v of [2, 3, 4, 3] as const) {
      handle(makeEEW({ serial: serial++, scaleTo: 50, lgIntTo: v }))
      await vi.advanceTimersByTimeAsync(200)
      await flushMicrotasks()
    }
    expect(spokenTexts()).toEqual([])   // まだ確定していない（800ms経過、上限未満）

    handle(makeEEW({ serial: serial++, scaleTo: 50, lgIntTo: 4 }))
    await vi.advanceTimersByTimeAsync(4300)   // サイクル開始（最初の階級変化）から合計5000msを超える
    await flushMicrotasks()
    // 安定を待たず、上限到達時点の最新の階級（4）で強制確定する。震度は据え置き（既に声に
    // 出た値と一致）のため繰り返さず、階級部分だけを読む
    expect(spokenTexts()).toEqual(['予想最大階級4。'])
  })

  // 「程度以上」は階級値に現れない。既読を階級だけで覚えていると、上限が定まらなくなった変化を
  // 「据え置き」と見て黙ってしまう（判定は isForecastScaleHigher）。
  it('震度据え置きで上限が定まらなくなった続報も読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 40 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 40, scaleToOrAbove: true }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大震度4程度以上。'])
  })

  it('逆に上限が確定しただけの続報では発話しない（引き下げと同じ扱い）', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 40, scaleToOrAbove: true }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 40 }))
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(0)
  })

  it('「程度以上」が据え置きの続報でも発話しない（安全弁）', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 40, scaleToOrAbove: true }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 40, scaleToOrAbove: true }))
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(0)
  })

  it('変化のない続報では発話しない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50 }))
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()
    expect(spokenTexts()).toHaveLength(0)
  })

  it('引き下げの続報では発話しない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 55 }))
    await vi.advanceTimersByTimeAsync(300)
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
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。', '予想最大震度3。'])
    })

    // 予報→警報のように severity だけが変わる続報では震度・階級に差が無い。
    // 値だけを見ていると、最も重い区分の変化が無言になる。
    it('震度据え置きでレベルだけ上がった続報は、格上げを述べて読み直す', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
      // 震度は変化なし（既読値と同じなので安定待ちに入らない）。区分の格上げは
      // enqueuePhase2 の中で判定されるため、この続報の受信直後にすぐ読まれる
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報に切り替わりました。予想最大震度5強。'])
    })

    // 上のテストは第 1 フェーズを**読み終えてから**格上げが届いた場合。読み上げている最中なら
    // 話が変わる。読み切るのを待つと区分の告知が第 1 フェーズの長さ（実測 5.5 秒）だけ遅れる
    // ため、割り込んで頭から言い直す。語の途中で切れても文の頭からやり直すので、地名を
    // 聞き違えたまま残ることはない。
    it('予報を読み上げている最中に警報へ上がったら、待たずに警報として言い直す', async () => {
      const handle = setup()
      const release = holdNextSpeech()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await flushMicrotasks()
      // 第 1 フェーズが鳴り続けている間、第 2 フェーズはその完了を待っている
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。'])

      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
      await flushMicrotasks()

      expect(spokenTexts()).toEqual([
        '地震動予報、日向灘で地震。',
        '緊急地震速報、日向灘で地震。',
        '予想最大震度5強。',
      ])
      // 切り出しの語で区分を伝え直しているので、遷移の言い方は重ねない
      expect(spokenTexts().some(t => t.includes('切り替わりました'))).toBe(false)
      release()
      await flushMicrotasks()
    })

    // まだ声になっていない予約は差し替えるだけで足りる。言い直しより早く、切れ目も生まれない。
    // 「地震動予報、」を一度も口にしない点が要点（実際より軽い区分を伝えずに済む）。
    it('声になる前に警報へ上がったら、言い直さず最初から警報として読む', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      // マイクロタスクを流す前＝予約はしたが合成に入っていない時点で格上げが届く
      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
      await flushMicrotasks()

      expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度5強。'])
    })

    // 打ち切ってよいのは区分の格上げだけ。予想震度は数秒ごとに書き換わる（2024/1/1 能登の
    // 本震では 5弱 → 7 まで 7.5 秒）ため、値が動くたびに切っていると読み終わらない。
    it('予想震度の引き上げでは、鳴っている第1フェーズを切らない', async () => {
      const handle = setup()
      const release = holdNextSpeech()
      handle(makeEEW({ scaleTo: 40, severity: 'Warning' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

      handle(makeEEW({ serial: 2, scaleTo: 70, severity: 'Warning' }))
      // 4(40)→7(70) は跳躍幅5段階（large=2000ms）。安定待ちが先に進んでも第1フェーズは切らない
      await vi.advanceTimersByTimeAsync(2000)
      await flushMicrotasks()
      // 言い直しは起きない（鳴り終わるのを待つ）
      expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

      release()
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度7。'])
    })

    // 警報 → 特別警報（震度6弱以上の予想）は受信レベルとしては上がるが、区分は既に
    // 「緊急地震速報」と伝えてあり、「特別警報」は音声で使わない方針（docs/spec/eew-spec.md §4）。
    // 言い直す中身が無いので切らない。判定に受信レベルの上昇を使うとここで誤って切る。
    it('警報から特別警報への格上げでは、鳴っている第1フェーズを切らない', async () => {
      const handle = setup()
      const release = holdNextSpeech()
      handle(makeEEW({ scaleTo: 50, severity: 'Warning' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

      handle(makeEEW({ serial: 2, scaleTo: 55, severity: 'Warning' }))
      // 5強(50)→6弱(55) は跳躍幅1段階（large=2000ms、値の変化は常にlarge判定）
      await vi.advanceTimersByTimeAsync(2000)
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。'])

      release()
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度6弱。'])
    })

    // 割り込みは**順番を崩さない**。鳴っている音だけを止め、自分はチェーンの順序どおりに並ぶ。
    // 前の発話を待たずに投入する形にすると、待ち行列にいた別 EEW の予約が「止めた」ことで
    // 解放され、始まったばかりの言い直しを後ろから消す（仕組みは voicevox.ts の `stopSpeech`）。
    // 症状は「警報の言い直しが聞こえない」だけでログに何も残らないため、ここで固定する。
    it('言い直しの割り込みが、後ろに並んでいた別 EEW の読み上げを巻き込まない', async () => {
      const handle = setup()
      const release = holdNextSpeech()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。'])

      // A が鳴っている間に別地震 B が発報され、A の完了待ちでチェーンに積まれる
      handle(makeEEW({
        eventId: 'B', scaleTo: 40, severity: 'Warning',
        hypocenter: { name: '能登半島沖', latitude: 37.5, longitude: 137.2 },
      }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。'])
      // B の震度（初出値・跳躍0段階）が安定待ち（300ms）を経て確定し、B の phase2 が
      // A の言い直しより先にチェーンへ積まれる（A の続報はまだ届いていないため）
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()

      // ここで A が警報へ格上げ（値は据え置きなので安定待ちを経ずに即確定）
      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
      await flushMicrotasks()
      release()
      await flushMicrotasks()

      // 5 発話すべてが残る。**A の言い直しは B の後ろ**——順番を守る代償として区分の告知は
      // B の読み上げの分だけ遅れるが、待ち行列の到来順は保たれる。消し合って両方が尻切れに
      // なるより良い（順番を飛ばすと、まさにその尻切れが起きる）。
      expect(spokenTexts()).toEqual([
        '地震動予報、日向灘で地震。',
        '緊急地震速報、能登半島沖で地震。',
        '予想最大震度4。',
        '緊急地震速報、日向灘で地震。',
        '予想最大震度5強。',
      ])
    })

    // 続報は密集する（能登の本震では 0.3〜2 秒間隔）。最初の言い直しが声になる前に次の格上げが
    // 届くが、区分の既読は発話の直前まで更新されないため、印を持たないと**完全に同一の文言を
    // 重ねて積む**。警報を早く伝えたい場面でこそ連投されるので、そこで二重読みになる。
    it('格上げの続報が連投されても、言い直しは 1 回だけ', async () => {
      const handle = setup()
      const release = holdNextSpeech()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。'])

      // 3 通を立て続けに受ける（間でマイクロタスクを流さない＝どれも実行前）
      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
      handle(makeEEW({ serial: 3, scaleTo: 55, severity: 'Warning' }))
      handle(makeEEW({ serial: 4, scaleTo: 60, severity: 'Warning' }))
      await flushMicrotasks()
      // 50→60 は跳躍幅2段階（large=2000ms）の安定待ちを経て確定する
      await vi.advanceTimersByTimeAsync(2000)
      await flushMicrotasks()
      release()
      await flushMicrotasks()

      expect(spokenTexts().filter(t => t === '緊急地震速報、日向灘で地震。')).toHaveLength(1)
      // 区分の格上げ（Forecast→Warning）はその時点の震度(5強)を安定待ちを経ずに確定するが、
      // 発話の順番が来た時点では既に 6強 が届いて安定待ち中なので、5強 は**声にならない**
      // （確定を待って降りる。→「より高い予想震度が安定待ち中なら…」のテスト群）。
      // 続く 55→60 の連投は通常どおり安定待ちを経て 1 回にまとまり、最新値(6強)だけが読まれる。
      // 区分の格上げ自体は言い直し（「緊急地震速報、日向灘で地震。」）が伝えている
      expect(spokenTexts()).toEqual([
        '地震動予報、日向灘で地震。',
        '緊急地震速報、日向灘で地震。',
        '予想最大震度6強。',
      ])
    })

    // 震源の大幅更新は古い音を止めずに予約を積み直す（文面が「震源を更新、」で区分に触れない
    // ため、止める価値がない）。そのとき「鳴っている」という記録まで落としてしまうと、直後の
    // 格上げで言い直しが発火せず、区分の告知が第 2 フェーズの前置きまで遅れる。
    it('震源の大幅更新を挟んでも、鳴っている最中の格上げは言い直しになる', async () => {
      const moved = { name: '種子島近海', latitude: 30.5, longitude: 131.0 }
      const handle = setup()
      const release = holdNextSpeech()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。'])

      // 震源が 50km 超動いた続報。まだ予報級のまま
      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Forecast', hypocenter: moved }))
      await flushMicrotasks()

      // 続いて警報へ格上げ（震源はもう動かない）
      handle(makeEEW({ serial: 3, scaleTo: 50, severity: 'Warning', hypocenter: moved }))
      await flushMicrotasks()
      release()
      await flushMicrotasks()

      // 震源更新を伝えたうえで、格上げは言い直しで伝わる（前置きへ落ちない）
      expect(spokenTexts()).toEqual([
        '地震動予報、日向灘で地震。',
        '震源を更新、種子島近海で地震。',
        '緊急地震速報、種子島近海で地震。',
        '予想最大震度5強。',
      ])
      expect(spokenTexts().some(t => t.includes('切り替わりました'))).toBe(false)
    })

    // 同じ EEW でも予約は積み直される（震源の大幅更新は古い音を止めずに積む）ので、同一 eventId に
    // 複数の予約が並ぶ。**記録を消すときに「自分が置いた分か」を見ないと、震源更新の予約が
    // 言い直しの予約の印まで落とし**、二重読みが復活する。
    it('震源更新の予約が先に順番を迎えても、言い直しの予約は消されない', async () => {
      const moved = { name: '種子島近海', latitude: 30.5, longitude: 131.0 }
      const handle = setup()
      const release1 = holdNextSpeech()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。'])

      // 震源が動いた続報（まだ予報）。古い音は止めずにチェーンへ積む
      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Forecast', hypocenter: moved }))
      // 次に鳴るもの（震源更新）を保留にして、その実行後に続報を差し込めるようにする
      const release2 = holdNextSpeech()
      // 警報へ格上げ。ここで言い直しが予約され、鳴っていた予報が止まる
      handle(makeEEW({ serial: 3, scaleTo: 50, severity: 'Warning', hypocenter: moved }))
      await flushMicrotasks()

      // 震源更新が鳴っている最中に、さらに警報の続報。印が残っていれば重ねない
      handle(makeEEW({ serial: 4, scaleTo: 55, severity: 'Warning', hypocenter: moved }))
      await flushMicrotasks()
      release1()
      release2()
      await flushMicrotasks()

      expect(spokenTexts().filter(t => t === '緊急地震速報、種子島近海で地震。')).toHaveLength(1)
    })

    // **鳴っている間は完了待ちの上限に達しない**（`capSpeechWait` は声が出ているあいだ計時
    // しない）。以前はここで 8 秒を越えると「鳴っている」記録が先に降り、言い直しが発火せず
    // 第 2 フェーズの前置きに委ねていた。その限界を解いたので、格上げは言い直しで伝わる。
    it('鳴っている間は完了待ちの上限に達せず、格上げは言い直しで伝わる', async () => {
      const handle = setup()
      const release = holdNextSpeech()
      handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['地震動予報、日向灘で地震。'])

      // 上限（8 秒）を越えても、声が出ているので打ち切られない
      await vi.advanceTimersByTimeAsync(8000)
      await flushMicrotasks()

      handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning' }))
      await flushMicrotasks()
      release()
      await vi.advanceTimersByTimeAsync(20000)
      await flushMicrotasks()

      // 鳴っている最中の格上げなので、第 1 フェーズが警報として言い直す
      expect(spokenTexts().filter(t => t === '緊急地震速報、日向灘で地震。')).toHaveLength(1)
    })

    // 初報から警報なら、区分は切り出しの「緊急地震速報、〇〇で地震。」で伝わっている。
    // 以降の引き上げは値だけを読む。前置きを重ねると、値を読み直すだけの報でも毎回
    // 区分が挟まって耳に障る（初期の実装では本震の 5 発話すべてに付いていた）。
    it('初報から警報なら、格上げの言い方は一度も使わない', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50 }))
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()

      handle(makeEEW({ serial: 2, scaleTo: 55 }))
      // 5強(50)→6弱(55) は跳躍幅1段階（large=2000ms、値の変化は常にlarge判定）
      await vi.advanceTimersByTimeAsync(2000)
      await flushMicrotasks()
      handle(makeEEW({ serial: 3, scaleTo: 70 }))
      // 6弱(55)→7(70) は跳躍幅2段階（large=2000ms）
      await vi.advanceTimersByTimeAsync(2000)
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
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()

      const texts = spokenTexts()
      expect(texts).toEqual(['緊急地震速報、日向灘で地震。', '予想最大震度7。予想最大階級4。'])
      expect(texts.some(t => t.includes('特別警報'))).toBe(false)
    })

    it('警報から特別警報の条件へ跨ぐ格上げは、値だけで伝える（「警報」を言い直さない）', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 50 }))          // 5強 → 警報
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 55 }))   // 6弱 → 特別警報の条件（跳躍幅1段階=large=2000ms）
      await vi.advanceTimersByTimeAsync(2000)
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
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 55, severity: 'Forecast' }))
      // 5強(50)→6弱(55) は跳躍幅1段階（large=2000ms）
      await vi.advanceTimersByTimeAsync(2000)
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
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 45, hypocenter: FAR_HYPO }))
      // 震源の大幅更新で安定待ちの確定値もクリアされ、新しいサイクル（跳躍0段階=300ms）を経る
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      expect(spokenTexts()).toEqual(['震源を更新、安芸灘で地震。', '予想最大震度5弱。'])
    })

    // 旧震源での値を既読として残すと、新震源で確定した値が旧値を超えたときだけ報じられ、
    // 震源が変わったことに触れないまま終わる。
    it('旧震源より低い値でも読み直す', async () => {
      const handle = setup()
      handle(makeEEW({ scaleTo: 55 }))
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      speakMock.mockClear()

      handle(makeEEW({ serial: 2, scaleTo: 40, hypocenter: FAR_HYPO }))
      await vi.advanceTimersByTimeAsync(300)
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
      // 両方とも初出値・跳躍0段階なので 300ms の安定待ちを経て確定する。第1フェーズは
      // どちらもホールドしていないため即座に鳴り、続いて両方の phase2 が確定順に鳴る
      // ——安定待ちが挟まる分、フルセンテンス単位ではなく「第1フェーズ×2 → phase2×2」の
      // 順になる
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()

      expect(spokenTexts()).toEqual([
        '地震動予報、日向灘で地震。',
        '緊急地震速報、石川県能登地方で地震。',
        '予想最大震度3。',
        '予想最大震度5強。',
      ])
    })

    it('片方の続報が他方の既読値を横取りしない', async () => {
      const handle = setup()
      handle(makeEEW({ eventId: 'A', scaleTo: 45 }))
      handle(makeEEW({ eventId: 'B', scaleTo: 30, severity: 'Forecast', hypocenter: NOTO }))
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      speakMock.mockClear()

      // A は 5弱→6弱、B は 3 のまま据え置き
      handle(makeEEW({ eventId: 'A', serial: 2, scaleTo: 55 }))
      handle(makeEEW({ eventId: 'B', serial: 2, scaleTo: 30, severity: 'Forecast', hypocenter: NOTO }))
      // A の 5弱(45)→6弱(55) は跳躍幅2段階（large=2000ms）
      await vi.advanceTimersByTimeAsync(2000)
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
      // 両方とも初出値・跳躍0段階なので 300ms の安定待ちを経て確定する
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      expect(spokenTexts()).toContain('緊急地震速報、石川県能登地方で地震。')
      expect(spokenTexts()).toContain('予想最大震度5強。')
    })

    it('片方が取り消されても、他方の読み上げは続く', async () => {
      const handle = setup()
      handle(makeEEW({ eventId: 'A', scaleTo: 45 }))
      handle(makeEEW({ eventId: 'B', scaleTo: 50, hypocenter: NOTO }))
      handle(makeEEW({ eventId: 'A', serial: 2, cancelled: true }))
      await vi.advanceTimersByTimeAsync(300)
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
    const SYNTH_MS = SPEAK_SYNTH_MS
    const CHUNK_MS = SPEAK_CHUNK_MS

    /**
     * `speakWithVoicevox` の代役。合成待ちのあと、チャンクごとに「鳴らす直前の判定」を通し、
     * 通ったものだけを `heard` に積む（voicevox.ts と同じ順序: 判定 → 再生 → 次のチャンク）。
     * チャンクの割り方は本体の `splitIntoChunks` をそのまま使う（手書きで真似ると、本体の
     * 分割条件を変えたときにこのテストだけが古い境界を前提に通り続ける）。
     *
     * `synthMs`/`chunkMs` は既定で `SYNTH_MS`/`CHUNK_MS` を使うが、震度 1 段階の変化でも
     * 安定待ちが 2000ms（large）かかる現行仕様では、既定値のままだと「合成・再生の途中で
     * 安定待ちが先に終わる」シナリオを作れないテストがある。そのテストだけ個別に長い値を渡す。
     */

    // 安定待ちが挟まるため、旧実装（続報を受けた瞬間に取り下げる）とは異なり、
    // **続報の安定待ちが完了して確定するまでは古い発話がそのまま続く**。震度1段階の変化でも
    // 安定待ちは 2000ms（large）かかるため、実際の合成待ち（SYNTH_MS=400ms）の中では確実に
    // 確定させられない。このテストだけ合成待ちを長め（LONG_SYNTH_MS=2500ms）に設定し、
    // 「合成中に安定待ちが先に終わる」状況を作る。
    it('合成を待つ間に予想が上がったら、古い値は 1 音も鳴らさない', async () => {
      const heard: string[] = []
      const LONG_SYNTH_MS = 2500
      installChunkedSpeak(heard, { synthMs: LONG_SYNTH_MS })
      const handle = setup()

      handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
      await flushMicrotasks()
      // 第1フェーズ（合成待ち + 2 チャンク）を鳴らし切る。この間に震度・階級の安定待ち
      // （どちらも初出値・跳躍0段階=300ms）も経て確定し、第2フェーズがチェーンに積まれる
      await advance(LONG_SYNTH_MS + CHUNK_MS * 2)
      expect(heard).toEqual(['緊急地震速報、', '日向灘で地震。'])

      // 第2フェーズは 5弱 で文面が作られ、いまは合成待ち（2500ms）。その間に 5強 の続報が届き、
      // 安定待ち（跳躍1段階=large=2000ms、合成待ちより短い）を経て確定する
      await advance(50)
      handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 2 }))
      await advance(2000)

      // 5弱 は鳴らずに取り下げられ、5強 だけが鳴る
      await advance(LONG_SYNTH_MS + CHUNK_MS * 2)
      expect(heard.filter(c => c.includes('5弱'))).toEqual([])
      expect(heard).toContain('予想最大震度5強。')
      expect(heard).toContain('予想最大階級2。')
    })

    it('鳴っている途中に予想が上がったら、そこから先のチャンクを鳴らさない', async () => {
      const heard: string[] = []
      // 震度1段階の変化でも安定待ちは2000ms（large）かかるため、CHUNK_MS（1200ms）のままでは
      // 「1チャンク再生中に安定待ちが先に終わる」状況を作れない。このテストだけチャンクの
      // 再生時間を長め（LONG_CHUNK_MS=3000ms）に設定する。
      const LONG_CHUNK_MS = 3000
      installChunkedSpeak(heard, { chunkMs: LONG_CHUNK_MS })
      const handle = setup()

      handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
      await flushMicrotasks()
      await advance(SYNTH_MS + LONG_CHUNK_MS * 2)   // 第1フェーズ
      await advance(SYNTH_MS)                       // 第2フェーズの合成待ち
      expect(heard[heard.length - 1]).toBe('予想最大震度5弱。')

      // 「予想最大震度5弱。」チャンクの再生開始直後に 5強 が届き、安定待ち
      // （跳躍1段階=large=2000ms、チャンク再生時間より短い）を経て確定する
      await advance(100)
      handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 2 }))
      await advance(2000)

      // 続きの「予想最大階級1。」は鳴らさず、5強 の読み直しへ移る
      expect(heard).not.toContain('予想最大階級1。')
      await advance(SYNTH_MS + LONG_CHUNK_MS * 2)
      expect(heard).toEqual([
        '緊急地震速報、', '日向灘で地震。',
        '予想最大震度5弱。',
        '予想最大震度5強。', '予想最大階級2。',
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

    // **安定待ちに入った時点で降りる**（上の「鳴っている途中に予想が上がったら」は確定してから
    // 降りる話で、こちらはその手前）。安定待ちは震度 1 段階でも 2000ms あり、チャンク 1 つの
    // 再生（1200ms）より長いため、確定を待つ作りだと**古い震度の文脈で階級の句が鳴り切る**。
    //
    // 実配信の例: 2024/11/26 22:47 石川県西方沖（EventID 20241126224709・VXSE45）。
    // 22:47:16 の第 5 報で震度4・階級1 に下がり、22:47:19 の第 7 報で 5弱 へ戻っている。
    // 震度4 で確定して読み始めた 1 秒後に 5弱 が届くため、この穴に落ちていた。
    describe('より高い予想が安定待ちに入ったとき', () => {
      /** 実配信と同じ並び（震度4・階級1 → 5弱）を作る。文面は 2 チャンクに割れる。 */
      const startPhase2WithScale4 = async (heard: string[]) => {
        const handle = setup()
        handle(makeEEW({ scaleTo: 40, lgIntTo: 1 }))
        await flushMicrotasks()
        await advance(SYNTH_MS + CHUNK_MS * 2)   // 第1フェーズ
        await advance(SYNTH_MS)                  // 第2フェーズの合成待ち
        expect(heard[heard.length - 1]).toBe('予想最大震度4。')
        return handle
      }

      // 正: 確定を待たずに降りる。**震度の句は鳴り終える**（鳴り始めたチャンクは切らない）。
      it('確定を待たずに、そこから先のチャンクを鳴らさない', async () => {
        const heard: string[] = []
        installChunkedSpeak(heard)
        const handle = await startPhase2WithScale4(heard)

        // 5弱 の報。安定待ち（跳躍1段階=large=2000ms）はチャンク 1 つの再生より長いので、
        // 次のチャンクの判定はまだ「確定は震度4・安定待ちは 5弱」の状態で走る
        await advance(100)
        handle(makeEEW({ serial: 2, scaleTo: 45, lgIntTo: 1 }))
        await advance(CHUNK_MS)
        expect(heard).not.toContain('予想最大階級1。')

        // 5弱 が確定したら全文を読み直す（降りた分は取りこぼしにならない）
        await advance(2000)
        await advance(SYNTH_MS + CHUNK_MS * 2)
        expect(heard).toEqual([
          '緊急地震速報、', '日向灘で地震。',
          '予想最大震度4。',
          '予想最大震度5弱。', '予想最大階級1。',
        ])
      })

      // 対照: 引き下げでは降りない（下がった値は読まない方針なので、降りると代わりに読むものが無い）。
      it('予想が下がった報では取り下げない', async () => {
        const heard: string[] = []
        installChunkedSpeak(heard)
        const handle = setup()
        handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
        await flushMicrotasks()
        await advance(SYNTH_MS + CHUNK_MS * 2)
        await advance(SYNTH_MS)
        expect(heard[heard.length - 1]).toBe('予想最大震度5弱。')

        await advance(100)
        handle(makeEEW({ serial: 2, scaleTo: 40, lgIntTo: 1 }))
        await advance(CHUNK_MS)

        expect(heard).toContain('予想最大階級1。')
      })

      // 安全弁: **見るのは震度だけ。** 階級の安定待ちで震度の発話を止めない
      // （「震度は階級の確定を待たない」非対称ルール）。階級の安定待ちは 300ms 固定なので、
      // チャンクの再生を 200ms にして「階級が確定する前に次のチャンクを鳴らす」状況を作る。
      it('階級だけが上がった報では、震度の発話を止めない', async () => {
        const heard: string[] = []
        const SHORT_CHUNK_MS = 200
        installChunkedSpeak(heard, { chunkMs: SHORT_CHUNK_MS })
        const handle = setup()
        handle(makeEEW({ scaleTo: 45, lgIntTo: 1 }))
        await flushMicrotasks()
        await advance(SYNTH_MS + SHORT_CHUNK_MS * 2)
        await advance(SYNTH_MS)
        expect(heard[heard.length - 1]).toBe('予想最大震度5弱。')

        handle(makeEEW({ serial: 2, scaleTo: 45, lgIntTo: 2 }))
        await advance(SHORT_CHUNK_MS)

        expect(heard).toContain('予想最大階級1。')
      })

      // 既読の巻き戻し: 降りた発話は 1 音鳴っているので `spoke` は真だが、**文の残りは
      // 声になっていない**。戻さないと、待っていた高い震度が確定せず元へ戻った続報で
      // 震度も階級も据え置き判定になり、その EEW で階級が一度も声にならない。
      it('待っていた予想が確定せず元へ戻ったら、読めなかった分を読み直す', async () => {
        const heard: string[] = []
        installChunkedSpeak(heard)
        const handle = await startPhase2WithScale4(heard)

        await advance(100)
        handle(makeEEW({ serial: 2, scaleTo: 45, lgIntTo: 1 }))
        await advance(CHUNK_MS)
        expect(heard).not.toContain('予想最大階級1。')

        // 震度4 へ戻る。サイクル開始時点の確定値と一致するので短い猶予（300ms）で確定し、
        // 5弱 の安定待ちタイマー（2000ms）を追い越す
        handle(makeEEW({ serial: 3, scaleTo: 40, lgIntTo: 1 }))
        await advance(EEW_PHASE2_STABILITY_SMALL_MS + SYNTH_MS + CHUNK_MS * 2)

        // **全文で突き合わせる。** 末尾 2 件だけを見ると、降りずに階級を鳴らし切って以後黙る
        // 挙動（この修正の前）でも同じ並びになり、テストが何も守らない
        expect(heard).toEqual([
          '緊急地震速報、', '日向灘で地震。',
          '予想最大震度4。',
          '予想最大震度4。', '予想最大階級1。',
        ])
      })

      // 安全弁: **区分の告知は戻さない。** 前置き「緊急地震速報に切り替わりました。」は文の先頭
      // チャンクなので、1 音でも鳴っていれば声になっている。値と一緒に戻すと `levelUpgraded` が
      // 再び真になり、続く読み直しで前置きをもう一度言う。
      //
      // **警報の対象地方を読まない設定で露出する。** 既定（読む）では第 1.5 フェーズが前置きを
      // 引き受けて `spokenEEWUpgradePhraseRef` を立てるため、そちらの歯止めに隠れる。
      it('予報から警報へ上がった報の発話中に降りても、区分の告知は繰り返さない', async () => {
        const heard: string[] = []
        installChunkedSpeak(heard)
        const handle = setup({ ttsReadEewWarningRegions: false })

        // 予報として発報し、第 1・第 2 フェーズを鳴らし切る
        handle(makeEEW({ severity: 'Forecast', scaleTo: 30, lgIntTo: 1 }))
        await flushMicrotasks()
        await advance(SYNTH_MS + CHUNK_MS * 2)
        await advance(SYNTH_MS + CHUNK_MS * 2)
        expect(heard).toContain('地震動予報、')

        // 警報へ格上げ。安定待ちを経ず即座に確定し、前置き付きで読み始める
        handle(makeEEW({ serial: 2, severity: 'Warning', scaleTo: 40, lgIntTo: 1 }))
        await advance(SYNTH_MS)
        expect(heard).toContain('緊急地震速報に切り替わりました。')

        // 前置きを鳴らしている最中に 5弱 が届き、次のチャンクの直前で降りる
        handle(makeEEW({ serial: 3, severity: 'Warning', scaleTo: 45, lgIntTo: 1 }))
        await advance(CHUNK_MS)
        await advance(EEW_PHASE2_STABILITY_LARGE_MS + SYNTH_MS + CHUNK_MS * 3)

        expect(heard).toContain('予想最大震度5弱。')
        expect(heard.filter(c => c === '緊急地震速報に切り替わりました。')).toHaveLength(1)
      })

      // 安全弁: 待っていた値が**確定に至らず、さらに低い値へ置き換わる**形。
      // 安定待ちのサイクルは値が変わるたび張り替わるので、譲った先の値が確定するとは限らない。
      // 既読を戻していないと、下がった値は読まない方針と噛み合って**その EEW で予想値が
      // 一度も声にならない**（震度の句は途中まで鳴っても、階級の句は落ちたまま終わる）。
      it('待っていた予想が確定せず、より低い値へ置き換わっても読み直す', async () => {
        const heard: string[] = []
        installChunkedSpeak(heard)
        const handle = await startPhase2WithScale4(heard)

        // 6強 の報で降りる（この値は確定しない）
        await advance(100)
        handle(makeEEW({ serial: 2, scaleTo: 60, lgIntTo: 1 }))
        await advance(CHUNK_MS)
        expect(heard).not.toContain('予想最大階級1。')

        // 確定する前に震度3 へ。サイクルは張り替わり、6強 は一度も確定しない
        handle(makeEEW({ serial: 3, scaleTo: 30, lgIntTo: 1 }))
        await advance(EEW_PHASE2_STABILITY_LARGE_MS + SYNTH_MS + CHUNK_MS * 2)

        expect(heard).toEqual([
          '緊急地震速報、', '日向灘で地震。',
          '予想最大震度4。',
          '予想最大震度3。', '予想最大階級1。',
        ])
      })
    })

  })
})

// 第 1.5 フェーズ（警報の対象地方）。震源を伝えたあと・予想値を伝える前に挟む。
// **予想値の読み上げを遅らせることが目的**でもあるので、順序そのものがこの機能の中身になる。
//
// **この describe だけ待ちを 20 秒取る**（他は 2 秒）。第 1.5 フェーズが挟まるぶん発話チェーンが
// 1 段長くなり、`chainEEWSpeech` の `finally`（＝既読を記録する `onSettled`）へ届くまでに
// 必要なタイマーの進行が増えるため。**単独実行（`-t`）では 2 秒でも通り、ファイル全体で
// 走らせたときだけ落ちる** —— 前のテストで作った hook がアンマウントされず、その発話チェーンが
// 同じフェイククロックに乗って残っているせい。既読が記録されないと次の続報が「新たに」ではなく
// 初回の形で読まれるので、**症状は「時間切れ」ではなく「文言が違う」形で出る**。
describe('警報の対象地方（第 1.5 フェーズ）', () => {
  // 正: 第 1 フェーズと第 2 フェーズのあいだに入る
  it('震源のあと・予想値の前に読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸', '甲信'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual([
      '緊急地震速報、日向灘で地震。',
      '北陸、甲信では強い揺れに警戒してください。',
      '予想最大震度5強。',
    ])
  })

  // 対照: 設定を切ると句ごと落ちる（他の 2 フェーズは変わらない）
  it('切ると読まない', async () => {
    const handle = setup({ ttsReadEewWarningRegions: false })
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('警戒してください'))).toBe(false)
    expect(spokenTexts()).toContain('予想最大震度5強。')
  })

  // 対照: 予報級の報は地方を持たない（実電文で警報級にしか入らない）
  it('対象地方を持たない報では読まない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50 }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('警戒してください'))).toBe(false)
  })

  // 安全弁: 同じ地方を続報で読み直さない
  it('既に声にした地方は続報で読み直さない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    handle(makeEEW({ serial: 2, scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().filter(t => t.includes('警戒してください'))).toEqual([
      '北陸では強い揺れに警戒してください。',
    ])
  })

  // 正: 続報で増えた地方は「新たに」を冠して差分だけ読む
  it('続報で増えた地方だけを「新たに」で読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    handle(makeEEW({ serial: 2, scaleTo: 50, warningRegions: ['北陸', '甲信', '東海'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().filter(t => t.includes('警戒してください'))).toEqual([
      '北陸では強い揺れに警戒してください。',
      '新たに、甲信、東海でも強い揺れに警戒してください。',
    ])
  })

  // 正: 予報から警報へ上がった報では、地方の文が「警報になった」告知を兼ねる。
  //
  // 地方のブロックは警報級の報にしか入らないので、この発話は必ずその EEW で最初の格上げの
  // 告知になる。区分を第 2 フェーズの前置きだけに任せると、そちらは予想値の安定待ちを経るため
  // 「〇〇では強い揺れに警戒してください。」が先に出て順序が入れ替わる。
  it('予報から警報へ上がった続報では、地方の文に格上げを前置きする', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning', warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts()[0]).toBe('緊急地震速報に切り替わりました。北陸では強い揺れに警戒してください。')
  })

  // 安全弁: 前置きの語は譲っても、**予想値の読み直しは譲らない**。
  //
  // 第 2 フェーズは「区分が格上げされた報では震度を含めて全文を読み直す」（何の震度で警報に
  // なったかの再確認）。前置きを付けるかどうかだけで読む中身を決めると、地方の文が語を
  // 引き受けた瞬間にこの読み直しごと消える —— 実際に一度そうなった。
  it('地方の文で格上げを伝えても、予想値は読み直す（前置きだけ重ねない）', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning', warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual([
      '緊急地震速報に切り替わりました。北陸では強い揺れに警戒してください。',
      '予想最大震度5強。',
    ])
  })

  // 対照: 初報から警報だった EEW では前置きしない。第 1 フェーズが「緊急地震速報、」と
  // 名乗っており、重ねて言う意味がない。
  it('初報から警報なら地方の文に前置きしない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('切り替わりました'))).toBe(false)
  })

  // 正: 鳴っている最中に地方が増えたら降りて読み直すが、**前置きは繰り返さない**。
  //
  // 地方名は文の後半にあり、降りた時点ではまだ声になっていないので読み直す。前置きは先頭
  // チャンクなので既に声になっており、記録しないと第 2 フェーズが「まだ区分を言っていない」と
  // 判定して重ねる —— 実配信では 2024-06-03 06:31 の石川県能登で、格上げの 0.45 秒後に地方が
  // 増えて「緊急地震速報に切り替わりました。」が実際に 2 回鳴った。
  it('鳴っている最中に地方が増えたら、地方名だけ読み直す（前置きは繰り返さない）', async () => {
    const heard: string[] = []
    installChunkedSpeak(heard)
    const handle = setup()

    handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
    await advance(SPEAK_SYNTH_MS + SPEAK_CHUNK_MS * 3)

    // 格上げ＋地方の初出。**前置きのチャンクが鳴り始めるまで待ってから**地方を増やす
    handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning', warningRegions: ['北陸'] }))
    await advanceUntil(() => heard.some(h => h.includes('切り替わりました')))
    expect(heard.some(h => h.includes('切り替わりました'))).toBe(true)

    handle(makeEEW({ serial: 3, scaleTo: 50, severity: 'Warning', warningRegions: ['北陸', '甲信'] }))
    await advance(SPEAK_SYNTH_MS * 4 + SPEAK_CHUNK_MS * 8)

    // 安全弁: 降りた回の**地方名**は既読にしない。既読にすると「新たに、甲信でも〜」だけに
    // なり、**一度も読み切っていない北陸が読まれないまま終わる**。
    expect(spokenTexts()).toContain('北陸、甲信では強い揺れに警戒してください。')
    // 正: 前置きは 1 回だけ。発話の組み立てでも、実際に鳴ったチャンクでも重ならない。
    expect(spokenTexts().filter(t => t.includes('切り替わりました'))).toHaveLength(1)
    expect(heard.filter(h => h.includes('切り替わりました'))).toHaveLength(1)
  })

  // 安全弁: **誤報取消を受けたら、前置きも地方名も既読にしない。** 取消はその発話ごと
  // 無かったことにする側で、受信した時点で同期に既読を消している。降りた発話が後から
  // 記録し直すと、同じ eventId で再発報したときに何も声にならない。
  //
  // **取消を送るのは「最後のチャンクを鳴らしている最中」。** `shouldStillPlay` は
  // チャンクの切れ目でしか呼ばれないので、ここでは判定の機会が無いまま `onSettled` へ
  // 来る —— 発話中に立てたフラグだけを見る実装では捉えられず、**書き込む直前に
  // `eewRetractedKeysRef` を見て初めて弾ける**。前置きのチャンクで取消を送ると既存の
  // 早期 return に弾かれてしまい、この経路を通らない（落ちないテストになる）。
  it('最後のチャンクを鳴らしている最中の誤報取消でも、再発報で前置きと地方名を読み直す', async () => {
    const heard: string[] = []
    installChunkedSpeak(heard)
    const handle = setup()

    handle(makeEEW({ scaleTo: 50, severity: 'Forecast' }))
    await advance(SPEAK_SYNTH_MS + SPEAK_CHUNK_MS * 3)
    handle(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning', warningRegions: ['北陸'] }))
    // 地方名のチャンク（最後のチャンク）が鳴り始めるまで待つ
    await advanceUntil(() => heard.some(h => h.includes('警戒してください')))

    handle(makeEEW({ serial: 3, cancelled: true }))
    await advance(SPEAK_SYNTH_MS * 4 + SPEAK_CHUNK_MS * 8)

    // 同じ eventId で再発報し、あらためて予報から警報へ上がる
    speakMock.mockClear()
    heard.length = 0
    handle(makeEEW({ serial: 4, scaleTo: 50, severity: 'Forecast' }))
    await advance(SPEAK_SYNTH_MS * 2 + SPEAK_CHUNK_MS * 4)
    handle(makeEEW({ serial: 5, scaleTo: 50, severity: 'Warning', warningRegions: ['北陸'] }))
    await advance(SPEAK_SYNTH_MS * 6 + SPEAK_CHUNK_MS * 12)

    // 前置きだけでなく**地方名そのもの**も読み直す。地方名の既読が残っていると
    // `enqueueWarningRegions` の起動条件（未読の地方があるか）で弾かれ、警報の中身が
    // 丸ごと声にならない。
    expect(spokenTexts()).toContain('緊急地震速報に切り替わりました。北陸では強い揺れに警戒してください。')
  })

  // 安全弁: 声になる前に誤報取消が届いたら読まない（第 1・第 2 フェーズと同じ）。
  // **鳴り始めてからの取消は別の話** —— そのときチャンク単位で残りを落とすのが
  // `shouldStillPlay` の役目で、既に声になった分は戻せない。
  it('声になる前に誤報取消が届けば読まない', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸', '甲信'] }))
    // ここで flush しない —— 予約はチェーンに積まれただけで、まだ 1 文字も声になっていない
    handle(makeEEW({ serial: 2, cancelled: true }))
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('警戒してください'))).toBe(false)
  })
})

// 合成が 1 音も鳴らなかったとき（VOICEVOX 未起動・ネットワーク断・話者 ID 不正）。
//
// **`speakWithVoicevox` は例外を投げずに正常終了する。** 戻り値の `spoke` を見ないと
// 「読み上げが完了した」と区別が付かず、**1 音も出ていないのに既読が進む** —— その EEW では
// 以後、同じ値を二度と読まない（格上げの告知も同じように失われる）。
describe('合成が 1 音も鳴らなかったとき', () => {
  /** 合成が全滅する状態。実物と同じく例外は投げず、`spoke: false` で正常終了する。 */
  function installSilentSpeak() {
    speakMock.mockImplementation((() => Promise.resolve({ spoke: false })) as never)
  }

  // 正: 地方も区分も既読にならない。合成が回復した続報で、**初出の形のまま・前置き付きで**
  // 読み直す（「新たに」も付かない ―― 一度も声にしていないため）。
  it('地方も区分も既読にせず、鳴るようになった続報で読み直す', async () => {
    installSilentSpeak()
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()

    // ここから先は鳴る
    speakMock.mockImplementation((() => Promise.resolve({ spoke: true })) as never)
    speakMock.mockClear()
    handle(makeEEW({ serial: 2, scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts()).toContain('緊急地震速報に切り替わりました。北陸では強い揺れに警戒してください。')
  })

  // 対照: **音が出ていなければ、上限（8 秒）で打ち切る。**
  //
  // ここがこの上限の本来の役目 —— VOICEVOX への合成要求が返ってこないまま止まったとき、
  // 後続の緊急地震速報を道連れにしない。**音が出ている間の延長と混ぜないこと**（そちらは
  // 「読み切ってから次が始まる」で検査する）。このモックは解決しない Promise を返すだけで
  // 1 音も鳴らさないので、`isAudioPlaying` は偽のまま＝延長は掛からない。
  //
  // 打ち切った発話は既読へ倒す。「鳴らなかった」へ倒すと、長い読み上げのたびに既読を
  // 巻き戻して**同じ内容を最初から読み直す**（1 音も鳴らなかった場合の取りこぼしより重い）。
  it('合成が返らないまま上限に達したら打ち切り、既読にする', async () => {
    speakMock.mockImplementation((() => new Promise(() => { /* 解決しない＝鳴り続けている */ })) as never)
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(30000)
    await flushMicrotasks()

    speakMock.mockImplementation((() => Promise.resolve({ spoke: true })) as never)
    speakMock.mockClear()
    handle(makeEEW({ serial: 2, scaleTo: 50, warningRegions: ['北陸', '甲信'] }))
    await vi.advanceTimersByTimeAsync(30000)
    await flushMicrotasks()
    // 北陸は伝えた扱い ―― 増えた甲信だけを「新たに」で読む
    expect(spokenTexts()).toContain('新たに、甲信でも強い揺れに警戒してください。')
  })

  // 対照: 鳴ったなら既読になる（巻き戻しが常時効いているわけではないこと）
  it('鳴った回は既読になる', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    speakMock.mockClear()
    handle(makeEEW({ serial: 2, scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('警戒してください'))).toBe(false)
  })

  // 正: **第 2 フェーズの既読も戻る。** 戻さないと、声になっていない予想震度が「伝え済み」に
  // なり、次に階級だけが上がった続報が「予想最大階級3。」という短句へ落ちる —— その EEW では
  // 予想震度が一度も声にならない。
  //
  // **震度が据え置きのまま階級だけ確定する続報を使うのは、そこだけが発話の差になるため。**
  // 震度そのものが動いた続報では、既読が戻っていてもいなくても全文を読み直す（差が出ない）。
  it('第 2 フェーズの既読も戻し、階級だけの短句に落ちない', async () => {
    installSilentSpeak()
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 2 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()

    // ここから先は鳴る。震度は据え置きで、階級だけが上がる
    speakMock.mockImplementation((() => Promise.resolve({ spoke: true })) as never)
    speakMock.mockClear()
    handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 3 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    // 前置きが付くのは区分の既読（`spokenEEWLevelsRef`）も戻っているため —— 警報への格上げも
    // まだ 1 音も声になっていない
    expect(spokenTexts()).toEqual(['緊急地震速報に切り替わりました。予想最大震度5強。予想最大階級3。'])
  })

  // 対照: 鳴った回なら既読は残り、同じ続報は階級だけの短句になる（巻き戻しが常時効いて
  // いるわけではないこと）。
  it('鳴った回は第 2 フェーズの既読が残り、階級だけを読む', async () => {
    const handle = setup()
    handle(makeEEW({ scaleTo: 50, lgIntTo: 2 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    speakMock.mockClear()

    handle(makeEEW({ serial: 2, scaleTo: 50, lgIntTo: 3 }))
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(spokenTexts()).toEqual(['予想最大階級3。'])
  })
})

// リプレイを EEW の発表中から始めたときの既読の復元。
//
// 復元は EEW について区分・予想値・第 2 フェーズ済み・確定値をすべて既読にしている
// （途中から始めた地震が初報のように聞こえるのを避けるため）。**地方だけがその列から漏れて
// いると、この EEW について他は何も声にしないのに地方だけが鳴る** —— 第 1 フェーズは
// `activeEEWLevelsRef` で、第 2 フェーズは `eewPhase2DoneRef` で止まるのに、地方は「まだ
// 声にしていない地方があるか」だけで発火するため。
describe('警報の対象地方: リプレイを途中から始めたとき', () => {
  const entry = (event: EEWAlert) => ({
    payload: { kind: 'event' as const, event },
    replayTime: new Date('2026-01-01T12:00:00Z'),
  })

  // 正: 窓の手前で発表済みの地方は既読になる
  it('窓の手前で発表済みの地方は読み直さない', async () => {
    const d = setupFull()
    d.restore([entry(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))] as never)
    d.handleLiveEvent(makeEEW({ serial: 2, scaleTo: 50, warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('警戒してください'))).toBe(false)
  })

  // 正: 窓の手前が予報級だった EEW が、窓の中で警報へ上がったら前置きは付く。
  // **復元は「伝え済み」を積むだけで、これから起きる格上げまで黙らせない。**
  it('窓の手前が予報級なら、窓の中の格上げは前置きして伝える', async () => {
    const d = setupFull()
    d.restore([entry(makeEEW({ scaleTo: 50, severity: 'Forecast' }))] as never)
    d.handleLiveEvent(makeEEW({ serial: 2, scaleTo: 50, severity: 'Warning', warningRegions: ['北陸'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts()[0]).toBe('緊急地震速報に切り替わりました。北陸では強い揺れに警戒してください。')
  })

  // 対照: 窓の中で増えた分は読む（復元が読み上げごと止めていないこと）
  it('窓の中で増えた地方は読む', async () => {
    const d = setupFull()
    d.restore([entry(makeEEW({ scaleTo: 50, warningRegions: ['北陸'] }))] as never)
    d.handleLiveEvent(makeEEW({ serial: 2, scaleTo: 50, warningRegions: ['北陸', '甲信'] }))
    await vi.advanceTimersByTimeAsync(20000)
    await flushMicrotasks()
    expect(spokenTexts().filter(t => t.includes('警戒してください'))).toEqual([
      '新たに、甲信でも強い揺れに警戒してください。',
    ])
  })
})

/**
 * 録画モードでは、窓の手前（`restorePreWindowTracking`）で告知した震源も復元する。
 *
 * **これは既読の復元と向きが逆で、読み上げを増やす側。** 復元しないと「震源名が変わったか」の
 * 比較対象が無く、区間の境目で震源が 50km 超動いても言い直さない —— 前の区間で旧震源を聞いた
 * 視聴者には、震源が黙って入れ替わったように見える。
 *
 * **誤報取消の識別（`eewRetractedKeysRef`）はここで固定していない。** 効くのは「取消のあとに
 * その EEW の報が届く」異常系だけで、正常な運用では起きない（→ eew-spec.md §10）。
 */
describe('録画モードの既読復元（緊急地震速報の震源）', () => {
  /** 窓の手前の EEW を `silent` で流したことにする。 */
  function preWindow(eew: EEWAlert) {
    return [{ payload: { kind: 'event', event: eew }, replayTime: new Date(0), silent: true }] as never
  }

  // 正: 窓の手前で告知した震源から 50km 超動いたら言い直す。
  it('窓の手前の震源からの大幅更新を言い直す', async () => {
    const { handleLiveEvent, restore } = setupFull({ recordingMode: true })
    restore(preWindow(makeEEW({ scaleTo: 50 })))
    handleLiveEvent(makeEEW({ serial: 2, scaleTo: 50, hypocenter: { name: '種子島近海', latitude: 30.5, longitude: 131.0 } }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('震源を更新'))).toBe(true)
  })

  // 対照: 録画モードでなければ比較対象を持たないので言い直さない
  //（窓から聞き始めた視聴者は旧震源を一度も聞いていない）。
  it('録画モードでなければ、窓の手前の震源とは比べない', async () => {
    const { handleLiveEvent, restore } = setupFull()
    restore(preWindow(makeEEW({ scaleTo: 50 })))
    handleLiveEvent(makeEEW({ serial: 2, scaleTo: 50, hypocenter: { name: '種子島近海', latitude: 30.5, longitude: 131.0 } }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('震源を更新'))).toBe(false)
  })

  // 安全弁: 復元しても、震源が動いていなければ言い直さない。
  it('震源が同じなら言い直さない', async () => {
    const { handleLiveEvent, restore } = setupFull({ recordingMode: true })
    restore(preWindow(makeEEW({ scaleTo: 50 })))
    handleLiveEvent(makeEEW({ serial: 2, scaleTo: 50 }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(spokenTexts().some(t => t.includes('震源を更新'))).toBe(false)
  })
})

// 第 1.5 フェーズの発話が、チェーンの待ち上限（`EEW_SPEECH_CHAIN_MAX_WAIT_MS`・8 秒）より
// 長くなる場合。**地方を多く列挙する報ほど起きやすい。**
//
// 守ることが 2 つある。
//   ① 読み切ってから次が始まる（声が出ている間は待ちを計時しない）
//   ② 前置き（「緊急地震速報に切り替わりました。」）を重ねない。既読の記録は発話の直前に
//      行うので、仮に追い越されても第 2 フェーズは「もう区分を言った」と判定できる
describe('上限より長い発話（第 1.5 フェーズ）', () => {
  /** 実機と同じ並びを作る。2024-06-03 06:31 の石川県能登（予報 → 警報・6 地方）。 */
  async function playRealSequence(heard: string[], handle: ReturnType<typeof setup>) {
    // 1 報: 予報・仮定震源要素（予想震度が付かない）
    handle(makeEEW({ severity: 'Forecast', condition: '仮定震源要素', noAreas: true }))
    // 第 1 フェーズを読み終え、「予想震度なし」を鳴らしている最中に格上げが届く
    await advanceUntil(() => heard.some(h => h.includes('予想震度なし')))
    // 4 報: 警報へ格上げ・地方 4 つ。5 報: 0.45 秒後に 6 つへ（どちらも第 1.5 が鳴る前）
    handle(makeEEW({ serial: 4, severity: 'Warning', scaleTo: 60, lgIntTo: 2, warningRegions: ['北陸', '甲信', '東海', '関東'] }))
    await advance(450)
    handle(makeEEW({ serial: 5, severity: 'Warning', scaleTo: 60, lgIntTo: 2, warningRegions: ['北陸', '甲信', '東海', '関東', '東北', '近畿'] }))
    await advance(SPEAK_SYNTH_MS * 12 + SPEAK_CHUNK_MS * 24)
  }

  // 正: 上限（8 秒）より長くても、読み切ってから次が始まる。
  //
  // 待ちが声の出ている時間まで計時していた頃は、地方を列挙する文が読み終わる前に予想値の
  // 読み上げが始まり、前の音を止めていた（2024-06-03 06:31 の石川県能登・対象地方 6 つ）。
  it('読み切ってから次が始まる', async () => {
    const heard: string[] = []
    // 1 チャンク 3.5 秒 × 3 チャンク＝上限を大きく超える長さ
    installChunkedSpeak(heard, { chunkMs: 3500 })
    await playRealSequence(heard, setup())

    const lastRegion = heard.findIndex(h => h.includes('警戒してください'))
    const firstValue = heard.findIndex(h => h.includes('予想最大震度'))
    // 地方の文の最後のチャンクが鳴っている（切られていない）
    expect(lastRegion).toBeGreaterThanOrEqual(0)
    // そのうえで予想値が後に来る
    expect(firstValue).toBeGreaterThan(lastRegion)
  })

  // 正: 前置きは 1 回だけ。
  it('前置きを繰り返さない', async () => {
    const heard: string[] = []
    // 6 地方を列挙する文は長い。1 チャンク 3.5 秒＝チェーンの待ち上限を超える
    installChunkedSpeak(heard, { chunkMs: 3500 })
    await playRealSequence(heard, setup())

    expect(spokenTexts().filter(t => t.includes('切り替わりました'))).toHaveLength(1)
    // 前置きを担うのは第 1.5 フェーズの側（地方の文）。第 2 フェーズは値だけを読む
    expect(spokenTexts()).toContain('緊急地震速報に切り替わりました。東北、関東、北陸、甲信、東海、近畿では強い揺れに警戒してください。')
    expect(spokenTexts()).toContain('予想最大震度6強。予想最大階級2。')
  })

  // 対照: 追い越されない長さなら、従来どおり 1 回だけ（この経路が上限に依存していないこと）。
  it('追い越されない長さでも 1 回だけ', async () => {
    const heard: string[] = []
    installChunkedSpeak(heard)
    await playRealSequence(heard, setup())

    expect(spokenTexts().filter(t => t.includes('切り替わりました'))).toHaveLength(1)
  })

  // 安全弁: 1 音も鳴らなければ記録しない。合成が回復した続報で前置きから読み直す。
  it('1 音も鳴らなければ既読にせず、鳴るようになった続報で読み直す', async () => {
    speakMock.mockImplementation((() => Promise.resolve({ spoke: false })) as never)
    const handle = setup()
    handle(makeEEW({ severity: 'Forecast', condition: '仮定震源要素', noAreas: true }))
    await advance(20000)
    handle(makeEEW({ serial: 4, severity: 'Warning', scaleTo: 55, lgIntTo: 2, warningRegions: ['北陸'] }))
    await advance(20000)

    speakMock.mockImplementation((() => Promise.resolve({ spoke: true })) as never)
    speakMock.mockClear()
    handle(makeEEW({ serial: 5, severity: 'Warning', scaleTo: 55, lgIntTo: 2, warningRegions: ['北陸'] }))
    await advance(20000)

    expect(spokenTexts().some(t => t.includes('切り替わりました'))).toBe(true)
  })
})
