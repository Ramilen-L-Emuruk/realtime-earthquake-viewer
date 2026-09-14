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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami } from '../types/earthquake'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }
  }
  let finish!: () => void
  const p = new Promise<void>(r => { finish = r })
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
  return speeches.map(s => s.text).filter(t => t.includes('気象庁の文をお伝えします'))
}

// **題材に「＊印は…」を使わない** —— あれは読み上げから落とす定型文
// （`TELEGRAM_TEXT_SKIPPED_PHRASES`）なので、使うと本文が鳴らずテストが成り立たない。
const COMMENT = '震源要素を訂正します。'

function makeQuake(over: { id?: string; varCommentText?: string } = {}): JMAQuake {
  return {
    kind: 'quake',
    id: over.id ?? 'quake-1',
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
  } as JMAQuake
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
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(),
  }))
  return result.current
}

beforeEach(() => {
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
  it('同じ本文の続報では読み直さない', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2' }))
    await drain()
    expect(telegramSpeeches()).toHaveLength(1)
  })

  // 正: 本文が変わったら読み直す（鍵はイベント単位だが、値は本文そのもの）。
  it('本文が変わったら読み直す', async () => {
    const { handleLiveEvent } = setup()
    handleLiveEvent(makeQuake({ id: 'quake-1' }))
    await drain()
    handleLiveEvent(makeQuake({ id: 'quake-2', varCommentText: 'この地震について、緊急地震速報を発表しています。' }))
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
    const bodyIdx = order.findIndex(t => t.includes('気象庁の文をお伝えします'))
    const mainIdx = order.findIndex(t => !t.includes('気象庁の文をお伝えします'))
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
})
