import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setReplayOffset } from './clock'
import {
  REPLAY_EVENT_LOG_CAPACITY,
  REPLAY_EVENT_TEXT_LIMIT,
  REPLAY_TELEGRAM_MEMORY_CAPACITY,
  recordReplayEvent,
  nextSpeechId,
  truncateReplayText,
  drainReplayEvents,
  peekReplayEvents,
  withReplayTelegramContext,
  currentReplayTelegram,
  captureReplayTelegramContext,
  rememberReplayTelegram,
  latestReplayTelegram,
  __resetReplayEventLogForTest,
  type ReplayTelegramRef,
} from './replayEventLog'

const telegram = (over: Partial<ReplayTelegramRef> = {}): ReplayTelegramRef => ({
  seq: 1, kind: 'quake', infoType: '震度速報', eventId: '20240101160000', serial: null, ...over,
})

/** 最小の記録（種別は何でもよい場面で使う）。 */
const recordTab = (tab: string) => recordReplayEvent({ type: 'tab', tab, prevTab: null })

beforeEach(() => {
  __resetReplayEventLogForTest()
  setReplayOffset(null)
})
afterEach(() => {
  __resetReplayEventLogForTest()
  setReplayOffset(null)
})

describe('溜めて汲み出す', () => {
  it('記録したものが順に返り、汲んだ分は消える', () => {
    recordTab('earthquake')
    recordTab('tsunami')

    const first = drainReplayEvents()
    expect(first.events.map(e => e.type)).toEqual(['tab', 'tab'])
    expect(first.events.map(e => (e as { tab: string }).tab)).toEqual(['earthquake', 'tsunami'])
    expect(first.dropped).toBe(0)

    // 対照: 2 回目は空。同じものを二度渡さない
    expect(drainReplayEvents().events).toEqual([])
  })

  it('覗くだけでは消えない', () => {
    recordTab('earthquake')

    expect(peekReplayEvents().events).toHaveLength(1)
    // 対照: 覗いたあとも汲める
    expect(drainReplayEvents().events).toHaveLength(1)
  })

  it('seq は 1 始まりで単調増加する', () => {
    const a = recordTab('earthquake')
    const b = recordTab('tsunami')
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(drainReplayEvents().events.map(e => e.seq)).toEqual([1, 2])
  })

  it('汲んでも seq は続きから振られる', () => {
    recordTab('earthquake')
    drainReplayEvents()
    recordTab('tsunami')
    expect(drainReplayEvents().events.map(e => e.seq)).toEqual([2])
  })
})

describe('溢れたことが呼ぶ側から分かる', () => {
  it('上限を超えると古い方から捨て、捨てた件数を返す', () => {
    for (let i = 0; i < REPLAY_EVENT_LOG_CAPACITY + 3; i++) recordTab(`t${i}`)

    const batch = drainReplayEvents()
    expect(batch.events).toHaveLength(REPLAY_EVENT_LOG_CAPACITY)
    expect(batch.dropped).toBe(3)
    // 残っているのは新しい方。最初の 3 件が消えている
    expect((batch.events[0] as { tab: string }).tab).toBe('t3')
  })

  it('捨てられたことは seq の飛びからも読める（件数と二重の保険）', () => {
    for (let i = 0; i < REPLAY_EVENT_LOG_CAPACITY + 2; i++) recordTab(`t${i}`)
    const events = drainReplayEvents().events
    // 連番を振り続けるので、先頭は 1 ではなく 3 から始まる
    expect(events[0].seq).toBe(3)
  })

  it('汲むと捨てた件数は 0 へ戻る', () => {
    for (let i = 0; i < REPLAY_EVENT_LOG_CAPACITY + 1; i++) recordTab(`t${i}`)
    expect(drainReplayEvents().dropped).toBe(1)

    // 対照: 次に汲むまでの間に捨てていなければ 0
    recordTab('after')
    expect(drainReplayEvents().dropped).toBe(0)
  })

  it('覗いただけでは捨てた件数を持ち越したままにする', () => {
    for (let i = 0; i < REPLAY_EVENT_LOG_CAPACITY + 1; i++) recordTab(`t${i}`)
    expect(peekReplayEvents().dropped).toBe(1)
    // 安全弁: 覗いたことで数が消えると、次に汲んだ側が取りこぼしに気づけない
    expect(drainReplayEvents().dropped).toBe(1)
  })
})

describe('時刻', () => {
  it('at はシナリオ時刻・wallAt は実時刻', () => {
    const offset = 86_400_000 // 1 日ぶん過去へ飛ばす
    setReplayOffset(-offset)
    const before = Date.now()
    recordTab('earthquake')
    const ev = drainReplayEvents().events[0]

    expect(ev.wallAt).toBeGreaterThanOrEqual(before)
    // シナリオ時刻はオフセットの分だけずれている
    expect(ev.at).toBeLessThan(ev.wallAt - offset + 5_000)
    expect(ev.at).toBeGreaterThan(ev.wallAt - offset - 5_000)
  })

  it('ライブでは at と wallAt がほぼ一致する', () => {
    setReplayOffset(null)
    recordTab('earthquake')
    const ev = drainReplayEvents().events[0]
    // 対照: オフセットが無ければ両者は同じ時間軸
    expect(Math.abs(ev.at - ev.wallAt)).toBeLessThan(5_000)
  })
})

describe('テキストの切り詰め', () => {
  it('上限を超えたら切って、元の長さと印を残す', () => {
    const long = 'あ'.repeat(REPLAY_EVENT_TEXT_LIMIT + 10)
    const [text, length, truncated] = truncateReplayText(long)
    expect(text).toHaveLength(REPLAY_EVENT_TEXT_LIMIT)
    expect(length).toBe(REPLAY_EVENT_TEXT_LIMIT + 10)
    expect(truncated).toBe(true)
  })

  it('上限ちょうどでは切らない', () => {
    const exact = 'あ'.repeat(REPLAY_EVENT_TEXT_LIMIT)
    const [text, length, truncated] = truncateReplayText(exact)
    expect(text).toBe(exact)
    expect(length).toBe(REPLAY_EVENT_TEXT_LIMIT)
    // 対照: 切っていないなら印を付けない
    expect(truncated).toBe(false)
  })
})

describe('読み上げの識別子', () => {
  it('呼ぶたびに別の値を返す', () => {
    const a = nextSpeechId()
    const b = nextSpeechId()
    expect(a).not.toBe(b)
  })

  it('start と end が同じ識別子で結べる', () => {
    const speechId = nextSpeechId()
    recordReplayEvent({
      type: 'speechStart', speechId, channel: 'other', topic: 'tsunami', eewKey: null,
      subject: null, telegram: null, text: '津波警報', textLength: 4, textTruncated: false,
    })
    recordReplayEvent({ type: 'speechEnd', speechId, spoke: true, durationMs: 36_000 })

    const events = drainReplayEvents().events
    expect(events).toHaveLength(2)
    expect((events[0] as { speechId: number }).speechId).toBe(speechId)
    expect((events[1] as { speechId: number }).speechId).toBe(speechId)
  })

  it('連続して読み上げても 1 本ずつ別の識別子になる（融けない）', () => {
    // 2024-01-01 18:27 の形。津波（観測）の直後に震源・震度情報が続く
    const a = nextSpeechId()
    recordReplayEvent({
      type: 'speechStart', speechId: a, channel: 'other', topic: 'tsunamiObs', eewKey: null,
      subject: null, telegram: telegram({ seq: 10, kind: 'tsunami' }), text: '津波観測',
      textLength: 4, textTruncated: false,
    })
    recordReplayEvent({ type: 'speechEnd', speechId: a, spoke: true, durationMs: 36_000 })
    const b = nextSpeechId()
    recordReplayEvent({
      type: 'speechStart', speechId: b, channel: 'other', topic: 'quake:x', eewKey: null,
      subject: null, telegram: telegram({ seq: 11, kind: 'quake', infoType: '震源・震度情報' }),
      text: '地震情報', textLength: 4, textTruncated: false,
    })
    recordReplayEvent({ type: 'speechEnd', speechId: b, spoke: true, durationMs: 24_000 })

    const starts = drainReplayEvents().events.filter(e => e.type === 'speechStart')
    expect(starts).toHaveLength(2)
    // それぞれ別の電文を指している
    expect(starts.map(e => (e as { telegram: ReplayTelegramRef | null }).telegram?.kind))
      .toEqual(['tsunami', 'quake'])
  })
})

describe('電文の文脈', () => {
  it('文脈の中では処理中の電文を引ける', () => {
    const ref = telegram()
    const inside = withReplayTelegramContext(ref, () => currentReplayTelegram())
    expect(inside).toEqual(ref)
    // 対照: 抜けたら消える
    expect(currentReplayTelegram()).toBeNull()
  })

  it('入れ子にしても、抜けたら外側へ戻る', () => {
    const outer = telegram({ seq: 1 })
    const inner = telegram({ seq: 2 })
    withReplayTelegramContext(outer, () => {
      withReplayTelegramContext(inner, () => {
        expect(currentReplayTelegram()?.seq).toBe(2)
      })
      // 安全弁: 内側が戻し忘れると、以後の読み上げが別の電文の持ち物になる
      expect(currentReplayTelegram()?.seq).toBe(1)
    })
    expect(currentReplayTelegram()).toBeNull()
  })

  it('中で例外が出ても文脈を戻す', () => {
    expect(() => withReplayTelegramContext(telegram(), () => { throw new Error('boom') }))
      .toThrow('boom')
    // 安全弁: 戻さないと、以後すべての読み上げがこの電文の持ち物になる
    expect(currentReplayTelegram()).toBeNull()
  })

  it('捕まえた文脈は、あとから実行しても引ける', () => {
    const ref = telegram({ seq: 7 })
    const restore = withReplayTelegramContext(ref, () => captureReplayTelegramContext())
    // 受信処理を抜けたあと（タイマーの中を模す）
    expect(currentReplayTelegram()).toBeNull()
    expect(restore(() => currentReplayTelegram()?.seq)).toBe(7)
    // 対照: 実行が終われば元の（空の）文脈へ戻る
    expect(currentReplayTelegram()).toBeNull()
  })

  it('文脈の外で捕まえたものは、実行しても空のまま', () => {
    const restore = captureReplayTelegramContext()
    expect(restore(() => currentReplayTelegram())).toBeNull()
  })

  it('捕まえた文脈の中で例外が出ても戻す', () => {
    const restore = withReplayTelegramContext(telegram(), () => captureReplayTelegramContext())
    expect(() => restore(() => { throw new Error('boom') })).toThrow('boom')
    expect(currentReplayTelegram()).toBeNull()
  })
})

describe('鍵から引く控え', () => {
  it('覚えた電文を鍵で引ける', () => {
    const ref = telegram({ seq: 3, kind: 'eew' })
    rememberReplayTelegram('eew:1', ref)
    expect(latestReplayTelegram('eew:1')).toEqual(ref)
    // 対照: 覚えていない鍵では null
    expect(latestReplayTelegram('eew:2')).toBeNull()
  })

  it('同じ鍵は新しい方で上書きする', () => {
    rememberReplayTelegram('eew:1', telegram({ seq: 3 }))
    rememberReplayTelegram('eew:1', telegram({ seq: 4 }))
    expect(latestReplayTelegram('eew:1')?.seq).toBe(4)
  })

  it('上限を超えたら古い鍵から捨てる', () => {
    for (let i = 0; i < REPLAY_TELEGRAM_MEMORY_CAPACITY + 1; i++) {
      rememberReplayTelegram(`k${i}`, telegram({ seq: i }))
    }
    expect(latestReplayTelegram('k0')).toBeNull()
    // 安全弁: 上限が無いと群発で無制限に増える。新しい方は残っていること
    expect(latestReplayTelegram(`k${REPLAY_TELEGRAM_MEMORY_CAPACITY}`)?.seq)
      .toBe(REPLAY_TELEGRAM_MEMORY_CAPACITY)
  })

  it('上書きは古さの順を更新する（触った鍵は捨てられにくい）', () => {
    for (let i = 0; i < REPLAY_TELEGRAM_MEMORY_CAPACITY; i++) {
      rememberReplayTelegram(`k${i}`, telegram({ seq: i }))
    }
    rememberReplayTelegram('k0', telegram({ seq: 999 }))
    rememberReplayTelegram('new', telegram({ seq: 1000 }))
    // k0 は触り直したので残り、代わりに k1 が落ちる
    expect(latestReplayTelegram('k0')?.seq).toBe(999)
    expect(latestReplayTelegram('k1')).toBeNull()
  })
})

describe('リセット', () => {
  it('溜めたものも文脈も控えも捨てる', () => {
    recordTab('earthquake')
    rememberReplayTelegram('k', telegram())
    __resetReplayEventLogForTest()

    expect(drainReplayEvents().events).toEqual([])
    expect(latestReplayTelegram('k')).toBeNull()
    expect(currentReplayTelegram()).toBeNull()
  })

  it('seq も 1 へ戻す（テストどうしが混ざらない）', () => {
    recordTab('earthquake')
    __resetReplayEventLogForTest()
    expect(recordTab('tsunami')).toBe(1)
  })
})
