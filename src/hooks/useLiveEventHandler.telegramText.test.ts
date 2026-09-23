// @vitest-environment jsdom
//
// 「気象庁が書いた文」（本文・付加文）の読み上げの**配線**のテスト。
//
// 文そのものの組み立ては `src/utils/ttsText.test.ts` が押さえている。ここで固定するのは
// `useLiveEventHandler` 側でしか壊れない 3 つ ——
//
// 1. **読み上げのマスタートグルを切ったら鳴らないこと。** 設定タブの「読み上げ設定」は
//    VOICEVOX 読み上げが有効なときしか出ないが、`ttsReadTelegramText` はそれとは独立に
//    永続化される。ガードを省くと、読み上げを切った端末で古い値が残っているだけで声が出る。
// 2. **同じ本文を続報のたびに読み直さないこと。** 固定付加文は区分が変わらない限り同じ値が
//    載る（→ quake-spec.md §3）ので、電文ごとに読むと「＊印は…」を毎報聞かされる。
// 3. **リプレイのリセットで既読が落ちること。** 落とさないと、同じシナリオを再生し直したときに
//    本文が前回と一致して「読んだこと」になり、新しいセッションで一度も声にならない。
import type { SpeechOutcome } from '../utils/voicevox'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import { telegramTextSubject } from '../utils/ttsFollow'
import type { JMAQuake, JMATsunami, LiveEvent } from '../types/earthquake'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }
  }
  let finish!: () => void
  const p = new Promise<SpeechOutcome>(r => { finish = () => r({ spoke: true }) })
  speeches.push({ text, finish, done: false })
  return p
})
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}


/**
 * 鳴っている発話を細かく完了させながら時間を進める。
 *
 * **本文は電文本体より後に発火する**（`TELEGRAM_TEXT_SPEECH_DELAY_MS`）。その時刻に本体が
 * まだ鳴っていると、本文は最下位の層なので取り下げられる（実運用でもそうなる）。
 * まとめて時間を飛ばすと本体が鳴りっぱなしのまま本文の発火時刻を過ぎてしまうので、
 * **短い刻みで進めて、鳴ったものをその都度完了させる**。
 */
async function drain() {
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(300)
    for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
    await flush()
  }
}

/** 本文の読み上げだけを拾う（電文本体の読み上げと混ざらないように） */
function telegramSpeeches(): string[] {
  return speeches.map(s => s.text).filter(t => t.includes('気象庁の発表文をお伝えします'))
}

// **題材に「＊印は…」を使わない** —— あれは読み上げから落とす定型文
// （`TELEGRAM_BOILERPLATE_SPECS` の `starMark`）なので、使うと本文が鳴らずテストが成り立たない。
const COMMENT = '震源要素を訂正します。'

function makeQuake(over: { id?: string; eventId?: string; varCommentText?: string; freeText?: string } = {}): JMAQuake {
  return {
    kind: 'quake',
    id: over.id ?? 'quake-1',
    // **既定では持たせない。** DMDATA の電文は必ず `EventID` を持つが、既読の鍵が
    // 事象の識別子を持たない電文でも従来どおり効くことを、既定の側で確かめておく。
    ...(over.eventId !== undefined && { eventId: over.eventId }),
    time: '2026-01-01T12:00:00Z',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 5.2 },
      maxScale: 40,
      domesticTsunami: 'なし',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 40 }],
    varCommentText: over.varCommentText ?? COMMENT,
    ...(over.freeText !== undefined && { freeText: over.freeText }),
  } as JMAQuake
}

/** 長周期地震動観測情報。**補足が畳んであるので開く先がある**側の題材。 */
function makeLpgm(): LiveEvent {
  return {
    kind: 'lpgm',
    data: {
      id: 'lpgm-1', time: '2026-01-01T12:00:00Z', eventId: 'lpgm-event-1',
      originTime: '2026-01-01T12:00:00Z', maxClass: 3, cancelled: false,
      freeFormText: '各長周期地震動階級に対する簡易な現象表現です。',
    },
  } as unknown as LiveEvent
}

/** 南海トラフ地震臨時情報。**開く先があるので追従セッションが立つ側**の題材。 */
function makeNankai(): LiveEvent {
  return {
    kind: 'nankai',
    data: {
      id: 'nankai-1', time: '', eventId: 'n1', cancelled: false,
      kindName: '調査中', headline: '南海トラフ地震臨時情報（調査中）',
      summary: '調査を開始しました。', body: '現在調査を行っています。',
      reportDateTime: '2026-01-01T12:00:00+09:00',
    },
  } as unknown as LiveEvent
}

function setup(overSettings: Partial<AppSettings> = {}) {
  const settings: AppSettings = {
    ...DEFAULTS,
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    minDisplayScale: -1,
    ttsReadTelegramText: true,
    ...overSettings,
  }
  const title = new Proxy({ alertTitle: null, setTitle: vi.fn() } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    telegramTextFollow: follow,
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  return result.current
}

/** 気象庁の文の追従セッション。begin/end の呼ばれ方と `subject` を記録する。 */
const followCalls: { kind: 'begin' | 'end' | 'reset'; subject?: string }[] = []
const follow = {
  begin: (_segments: unknown, subject?: string) => {
    followCalls.push({ kind: 'begin', subject })
    return followCalls.length
  },
  schedule: () => {},
  end: (_token: number) => { followCalls.push({ kind: 'end' }) },
  reset: () => { followCalls.push({ kind: 'reset' }) },
} as never

beforeEach(() => {
  followCalls.length = 0
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('気象庁が書いた文の読み上げ（配線）', () => {
  // 正: 設定を有効にすると、電文本体とは別の発話として読まれる。
  it('有効にすると本文が読まれる', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake())
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
    expect(telegramSpeeches()[0]).toContain(COMMENT)
  })

  // 対照: 既定（設定を入れる前の挙動）では読まれない。
  it('既定では読まれない', async () => {
    const { handleLiveEvent } = setup({ ttsReadTelegramText: false })
    handleLiveEvent(makeQuake())
    await drain()
    expect(telegramSpeeches()).toHaveLength(0)
  })

  // 正: **ブロックごとの指定が読み上げまで届く。** 設定（`ttsTelegramTextBlocks`）から
  // `telegramTextToSpeak` までは `ttsRegionOptions` の 1 行を通るだけなので、
  // そこを落としても型検査は通り、**設定を触っても何も変わらない**形で壊れる。
  it('ブロックの指定が読み上げまで届く', async () => {
    const { handleLiveEvent } = setup({
      ttsTelegramTextBlocks: { ...DEFAULTS.ttsTelegramTextBlocks, quakeVarComment: false },
    })
    handleLiveEvent(makeQuake())
    await drain()
    expect(telegramSpeeches()).toHaveLength(0)
  })

  // 正: **読み上げているあいだ、画面の表示を開くための追従セッションが立つ。**
  // 主題（`telegramText:<kind>`）で、どの電文の文かが分かる（→ `useAutoOpenWhileSpeaking`）。
  it('読み上げのあいだ、表示を開くための追従セッションが立つ', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeNankai())
    await drain()
    expect(followCalls.map(c => c.kind)).toEqual(['begin', 'end'])
    expect(followCalls[0].subject).toBe('telegramText:nankai')
  })

  // 対照: **開く先が無い種別では立てない。** 地震情報の付加文は元から畳んでいないので
  // 開く相手がいない（→ `TELEGRAM_TEXT_OPEN_TARGET_KINDS`）。誰も反応しないセッションを
  // 立ち上げては終わる状態にしない —— 症状が出ないぶん、後から意図を確かめられなくなる
  it('開く先が無い種別（地震情報）では追従セッションを立てない', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake())
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)   // 読み上げ自体は起きる
    expect(followCalls).toEqual([])              // 追従だけ立たない
  })

  // 正: **長周期は主題に地震の識別子まで載せる。** 地震カードは複数並ぶので、種別だけでは
  // どのカードの補足を開くか決まらない（バナーと津波の面は画面に 1 つしか無い）。
  it('長周期では、主題に地震の識別子まで載せる', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeLpgm())
    await drain()
    expect(followCalls.map(c => c.kind)).toEqual(['begin', 'end'])
    expect(followCalls[0].subject).toBe(telegramTextSubject('lpgm', 'lpgm-event-1'))
  })

  // 対照: 読まない電文では立てない（開く相手が無いのにセッションだけ始めない）
  // 安全弁: **リセットで追従も打ち切る。** 鳴っている読み上げはリセットでは止まらないので、
  // 追従だけを残すと、切り替え前の読み上げが自然に終わるまで（南海トラフ臨時情報なら約 3 分）
  // 無関係なバナーが開いたままになる。既存の 2 本（津波カード・未入電）と並べて打ち切ること。
  it('リセットで追従セッションを打ち切る', async () => {
    const { handleLiveEvent, resetTracking } = setup()
    handleLiveEvent(makeNankai())
    await drain()
    followCalls.length = 0

    act(() => { resetTracking() })
    expect(followCalls.map(c => c.kind)).toContain('reset')
  })

  it('読まない設定では追従セッションを立てない', async () => {
    const { handleLiveEvent } = setup({ ttsReadTelegramText: false })
    handleLiveEvent(makeNankai())
    await drain()
    expect(followCalls).toEqual([])
  })

  // 安全弁: 読み上げのマスタートグルを切ったら鳴らない。**この設定だけ有効な値が残っていても、
  // 声を出してはいけない**（設定タブでは読み上げが無効だとこの項目自体が見えないため、
  // 利用者は切ったつもりでいる）。
  it('VOICEVOX 読み上げが無効なら、設定が有効でも鳴らない', async () => {
    const { handleLiveEvent } = setup({ voicevoxEnabled: false })
    handleLiveEvent(makeQuake())
    await drain()
    expect(speakMock).not.toHaveBeenCalled()
  })

  // 安全弁: 同じ本文の続報では読み直さない（固定付加文は続報でも同じ値が載る）。
  // **事象の識別子を持たない電文**（P2PQuake 経路）でも効くことを、ここで押さえる。
  it('同じ本文の続報では読み直さない', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
  })

  // 正: **別の地震に付いた同じ文は読み直す。** 気象庁の付加文は同じ文面が続くことが多く、
  // 2024-01-01 の実電文では「この地震の付近で地震が連続して発生したため…」が別々の 32 の
  // 地震に同じ文面で入っていた。文字列だけを鍵にしていた頃は、この但し書きが最初の 1 回しか
  // 声にならなかった（→ `telegramTextSpokenSubject`）。
  it('別の地震に付いた同じ文は読み直す', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1', eventId: 'event-1' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', eventId: 'event-2' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(2)
  })

  // 対照: **同じ地震の続報では読み直さない。** 上を「電文ごとに読み直す」で実装すると、
  // 続報のたびに同じ付加文を聞かされる（既読を入れた元の理由）。境界は事象で、報ではない。
  it('同じ地震の続報では読み直さない', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1', eventId: 'event-1' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', eventId: 'event-1' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
  })

  // 安全弁: **同じ地震でも `eventId` が採り直されたら読み直す。** 気象庁は震源決定の前と後で
  // 別々に採番することがある（`isHypocenterPending` の実例）。境目にいる震源決定前の電文
  // （震度速報）は付加文を運ばないので実運用では起きないが、**前提が崩れたときにどう転ぶかを
  // ここで明示しておく** —— 転ぶ先は「同じ注記を二度読む」（安全側）であって、黙り込む側ではない。
  it('同じ地震でも識別子が採り直されたら読み直す（安全側へ倒れることの確認）', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1', eventId: '20260824040519' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', eventId: '20260824040526' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(2)
  })

  // 安全弁: **文単位の既読は主題を足しても保たれる。** 同じ地震で 1 文増えた続報では、
  // 増えた分だけを読む（既に読んだ文は繰り返さない）。鍵を「主題 × 本文まるごと」にすると
  // ここが崩れ、津波の避難行動の付加文のように節が増減する本文を毎回読み直す。
  it('同じ地震で文が増えたら、増えた文だけを読む', async () => {
    const extra = 'なお、有明・八代海に津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中です。'
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1', eventId: 'event-1' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', eventId: 'event-1', freeText: extra }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(2)
    expect(telegramSpeeches()[1]).toContain(extra)
    expect(telegramSpeeches()[1]).not.toContain(COMMENT)
  })

  // 正: 本文が変わったら読み直す（鍵はイベント単位だが、値は本文そのもの）。
  it('本文が変わったら読み直す', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1' }))
    await drain()
    // **題材に定型文を使わない** —— 「この地震について、緊急地震速報を発表しています。」は
    // 読み上げから落とす対象（→ `utils/ttsText.ts` の `TELEGRAM_BOILERPLATE_KEYS`）なので、
    // 足しても本文が増えない。実電文で自由付加文に入る形を使う。
    handleLiveEvent(makeQuake({
      id: 'quake-2',
      freeText: 'なお、有明・八代海に津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中です。',
    }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(2)
  })

  // 安全弁（**実機で起きた「二回読み上げ」の再発防止**）: 本文は**電文本体より後に鳴る**こと。
  //
  // 待ち合わせは「いま鳴っているものがあるか」で判定するので、本体が通知音の余韻を待っている
  // あいだは空席に見える。本文を間 0 で予約すると**本文が先に鳴り出し、あとから本体に
  // 割り込まれて両方が途中で切れる** —— 聞くと同じ地震の情報が 2 回流れる形になる。
  // **予約の順序では決まらない。発火の時刻（`delay`）で決まる。**
  it('本文は電文本体より後に鳴る', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake())
    await drain()
    const order = speeches.map(s => s.text)
    // **本体の判定を前置きの語で書かない** —— 本文も「地震情報について、…」で始まるので
    // `startsWith('地震情報')` では本文自身を拾ってしまう。本文以外の最初の発話を本体とみなす。
    const bodyIdx = order.findIndex(t => t.includes('気象庁の発表文をお伝えします'))
    const mainIdx = order.findIndex(t => !t.includes('気象庁の発表文をお伝えします'))
    expect(mainIdx, '電文本体が鳴っていない').toBeGreaterThanOrEqual(0)
    expect(bodyIdx, '本文が鳴っていない').toBeGreaterThanOrEqual(0)
    expect(mainIdx).toBeLessThan(bodyIdx)
  })

  // 安全弁（**実機で「本文が読まれない」原因になった穴**）: 本体が鳴り続けている間に別の電文が
  // 届いても、本文が取り下げられないこと。
  //
  // 到来順の裁き（`overtakenByLaterArrival`）は「自分より**後に予約された**優先度が上の
  // 読み上げ」に追い越されたら、待たずに取り下げる。本文を本体と同じ瞬間に予約すると、
  // 続けて届いた別の電文の予約に追い越されて消える（地震情報と長周期地震動観測情報は続けて
  // 届くので、実運用でそのまま起きる）。予約自体を遅らせて、本文が最後の予約になるようにしてある。
  //
  // **本体を鳴らしたまま時間を進めること。** `drain()` のように本体を即完了させると、本文の
  // 発火時には席が空いていて追い越しも待ちも起きず、**穴があっても通ってしまう**。
  it('本体が鳴り続けている間に別の電文が届いても、本文は取り下げられない', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1' }))
    // 同じ瞬間に別の電文（長周期地震動観測情報）が続けて届く＝本文より後の予約になる
    handleLiveEvent({
      kind: 'lpgm',
      data: {
        id: 'l1', time: '2026-01-01T12:00:00Z', eventId: 'e1', originTime: '2026-01-01T12:00:00Z',
        maxClass: 3, cancelled: false, freeFormText: '長周期の補足です。',
      },
    } as never)
    // 本体を完了させずに、本文の予約・発火の時刻を過ぎるまで進める
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()
    // ここで本体が鳴り終わる
    for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()
    expect(telegramSpeeches().some(t => t.includes(COMMENT)), '地震情報の本文が取り下げられている').toBe(true)
  })

  // 安全弁: 通知を切っている種別では本文も読まない。
  //
  // `nankaiCommentaryAlerts` は南海トラフ関連解説情報の音・帯・読み上げをまとめて止めるトグル。
  // 本文の予約は本体の外（ラッパー）で行うので、**本体が抑制した電文でも本文だけが声になる**
  // 形になりやすい。実電文の本文は最大 1055 字・読み上げ約 3 分あり、切ったはずの種別が
  // いちばん長い形で復活する。
  it('解説情報の通知を切っていれば本文も読まない', async () => {
    const { handleLiveEvent } = setup({ nankaiCommentaryAlerts: false })
    handleLiveEvent({
      kind: 'nankaiCommentary',
      data: {
        id: 'nc-1', time: '2026-01-01T12:00:00Z', eventId: 'e1',
        headline: '南海トラフ地震関連解説情報（第１号）', body: '本文です。',
        cancelled: false, reportDateTime: '2026-01-01T12:00:00Z',
      },
    } as never)
    await drain()
    expect(telegramSpeeches()).toHaveLength(0)
  })

  // 対照: 通知が有効なら読まれる（上の抑制が広すぎないこと）。
  it('解説情報の通知が有効なら本文を読む', async () => {
    const { handleLiveEvent } = setup({ nankaiCommentaryAlerts: true })
    handleLiveEvent({
      kind: 'nankaiCommentary',
      data: {
        id: 'nc-1', time: '2026-01-01T12:00:00Z', eventId: 'e1',
        headline: '南海トラフ地震関連解説情報（第１号）', body: '本文です。',
        cancelled: false, reportDateTime: '2026-01-01T12:00:00Z',
      },
    } as never)
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
    expect(telegramSpeeches()[0]).toContain('本文です。')
  })

  // 安全弁: リプレイのリセットで既読が落ちる。落とさないと、同じシナリオを再生し直したときに
  // 一度も声にならない（他の既読系と同じ扱いに揃える）。
  it('リセット後は同じ本文でも読み直す', async () => {
    const { handleLiveEvent, resetTracking } = setup()
    handleLiveEvent(makeQuake())
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
    resetTracking()
    handleLiveEvent(makeQuake())
    await drain()
    expect(telegramSpeeches()).toHaveLength(2)
  })
  // 正: 本文の一部だけが新しい続報では、**新しい文だけ**を読む。
  //
  // 津波の避難行動の固定付加文は等級が動くたびに節が増減する。本文まるごとを鍵にしていた頃は
  // 1 文増えただけで既に読んだ 800 字を読み直しており、能登半島地震（2024-01-01）の実電文では
  // 同じ長文が 3 回読まれていた。
  it('本文に文が足された続報では、新しい文だけ読む', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1', varCommentText: '一つ目の文です。' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', varCommentText: '一つ目の文です。二つ目の文です。' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(2)
    expect(telegramSpeeches()[1]).toContain('二つ目の文です。')
    expect(telegramSpeeches()[1]).not.toContain('一つ目の文です。')
    // 前置きは残す（本文だけを裸で鳴らすと、何についての文か分からない）。
    expect(telegramSpeeches()[1]).toContain('気象庁の発表文をお伝えします')
  })

  // 対照: 文が減っただけの続報（すべて既読）では読まない。**ここが「変更がないなら読まない」の本体。**
  it('文が減っただけの続報では読まない', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1', varCommentText: '一つ目の文です。二つ目の文です。' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', varCommentText: '一つ目の文です。' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
  })

  // 安全弁: 並び替わっただけの本文も読み直さない（鍵は文なので順序に依らない）。
  it('文の並びが変わっただけの続報では読まない', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1', varCommentText: '一つ目の文です。二つ目の文です。' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', varCommentText: '二つ目の文です。一つ目の文です。' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
  })
})

/**
 * 録画モードでは、窓の手前で伝えた本文も既読として復元する
 * （→ `restorePreWindowTracking`・settings-pwa-spec.md §2「主な項目の補足」）。
 *
 * 通常の再生で復元しないのは「窓から聞き始めた人は一度も聞いていない」ため。録画は区間を繋いで
 * 1 本の動画にするので、区間の境目で同じ長文を読み直すと通しで見たときに繰り返しになる。
 */
describe('録画モードの既読復元（気象庁が書いた文）', () => {
  /** 窓の手前の電文 1 通を `silent` で流したことにする（リプレイの初期状態の再現と同じ形）。 */
  function preWindow(event: LiveEvent) {
    return [{ payload: { kind: 'event', event }, replayTime: new Date(0), silent: true }] as never
  }

  // 正: 録画モードなら、窓の手前で発表済みの本文は窓内で読み直さない。
  it('録画モードでは、窓の手前の本文を読み直さない', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    restorePreWindowTracking(preWindow(makeQuake({ id: 'pre' })))
    handleLiveEvent(makeQuake({ id: 'quake-1' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(0)
  })

  // 対照: 録画モードが無効なら従来どおり読む（聞き手はその本文を一度も聞いていない）。
  it('録画モードでなければ、窓の手前の本文でも読む', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup()
    restorePreWindowTracking(preWindow(makeQuake({ id: 'pre' })))
    handleLiveEvent(makeQuake({ id: 'quake-1' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
  })

  // 安全弁: 復元しても、窓に入ってから新しく現れた文は読む（黙らせすぎていないこと）。
  it('窓の手前に無かった文は読む', async () => {
    const { handleLiveEvent, restorePreWindowTracking } = setup({ recordingMode: true })
    restorePreWindowTracking(preWindow(makeQuake({ id: 'pre', varCommentText: '一つ目の文です。' })))
    handleLiveEvent(makeQuake({ id: 'quake-1', varCommentText: '一つ目の文です。二つ目の文です。' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
    expect(telegramSpeeches()[0]).toContain('二つ目の文です。')
    expect(telegramSpeeches()[0]).not.toContain('一つ目の文です。')
  })
})

// 据え置き（カードが内容を採らない電文）では、気象庁が書いた本文も声にしない。**本体の震度・
// 地域を伝えていないのに補足だけ読むことになる**ため。抑止は本体の処理が立てる印
// （`skipTelegramTextRef`）に相乗りしていて、その印は「本体が処理を打ち切った電文では本文を
// 読まない」という既存の仕組みのもの。
// → docs/spec/quake-spec.md §6.3「据え置いた電文は、音・読み上げ・タイトル・タブ移動も起こさない」
describe('据え置きの印が立った地震情報の本文', () => {
  it('印が立っていれば本文も読まない（正）', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake(), { quakeHeldBack: true })
    await drain()
    expect(telegramSpeeches()).toHaveLength(0)
  })

  // 対照: 印が無ければ従来どおり読む（止める範囲が「据え置かれた電文」より広がっていない）
  it('印が無ければ従来どおり読む', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake())
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
  })
})
