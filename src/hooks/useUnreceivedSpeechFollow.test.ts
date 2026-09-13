// @vitest-environment jsdom
//
// 未入電を声にしているあいだだけ未入電モードを開く追従のテスト。
//
// チャンクの分割は手書きせず `splitIntoChunks` を通し、範囲も `unreceivedChunkRange` で
// 実データから求める（分割の条件や文の並びを変えたときに、テストだけが古い境界を前提に
// 通り続けるのを防ぐため）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUnreceivedSpeechFollow } from './useUnreceivedSpeechFollow'
import type { UnreceivedOpenResult } from '../utils/quakeOverlay'
import { log } from '../utils/logger'
import {
  joinSegments,
  mapChunksToRefs,
  plain,
  unreceivedChunkRange,
  type SpeechFollowSession,
  type SpeechRef,
  type SpeechSegment,
} from '../utils/ttsFollow'
import { splitIntoChunks } from '../utils/voicevox'

/** 再生時計（AudioContext の時間軸）。テストごとに動かす。 */
let clock: number | null = null

vi.mock('../utils/voicevox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/voicevox')>()
  return { ...actual, getSpeechClock: () => clock }
})

const seg = (text: string, ...refs: SpeechRef[]): SpeechSegment => ({ text, refs })
const observed = (name: string, scale: number): SpeechRef => ({ kind: 'quakeRegion', name, scale })
const unreceived = (name: string): SpeechRef => ({ kind: 'quakeRegion', name, scale: 45, unreceived: true })

/** 観測値の文 → 未入電の文 → その後の文、という実運用と同じ並び。 */
const SEGMENTS: SpeechSegment[] = [
  plain('地震情報。最大震度5強を'),
  seg('大分県中部', observed('大分県中部', 55)),
  plain('、'),
  seg('宮崎県北部平野部', observed('宮崎県北部平野部', 50)),
  plain('で観測しました。'),
  seg('西条市丹原町鞍瀬', unreceived('西条市丹原町鞍瀬')),
  plain('、'),
  seg('伊予市双海町', unreceived('伊予市双海町')),
  plain('では、震度5弱以上と推定されますが、未入電です。'),
  plain('この地震による津波の心配はありません。'),
]

const CHUNKS = splitIntoChunks(joinSegments(SEGMENTS))
const RANGE = unreceivedChunkRange(mapChunksToRefs(SEGMENTS, CHUNKS))!
/** 1 チャンク 1 秒で並べた予約（`startAt` は再生時計の値）。 */
const SCHEDULE = CHUNKS.map((_, index) => ({ index, startAt: 10 + index }))

/** 読み上げの主題（どの地震について語っているか）。 */
const SUBJECT = 'quake-A'

function makeSession(subject: string | undefined = SUBJECT): SpeechFollowSession {
  return { token: 1, segments: SEGMENTS, subject, chunks: CHUNKS, schedule: SCHEDULE }
}

/** そのチャンクを鳴らしている時刻へ再生時計を進め、rAF を 1 周させる。 */
function playChunk(index: number): void {
  clock = SCHEDULE[index].startAt + 0.5
  act(() => { vi.advanceTimersByTime(40) })
}

describe('useUnreceivedSpeechFollow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clock = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('前提: 未入電の範囲は読み上げの途中にあり、最後のチャンクではない', () => {
    // 以下のテストが「範囲を抜けたら閉じる」を「読み上げが終わったら閉じる」と
    // 取り違えないための足場。範囲の後ろにチャンクが残っていなければ両者を区別できない。
    expect(RANGE.first).toBeGreaterThan(0)
    expect(RANGE.last).toBeLessThan(CHUNKS.length - 1)
  })

  function setup(open: () => UnreceivedOpenResult = () => 'opened') {
    const openFn = vi.fn((_subject: string | undefined) => open())
    const closeFn = vi.fn()
    const view = renderHook(
      ({ session, isOpen }: { session: SpeechFollowSession | null; isOpen: boolean }) =>
        useUnreceivedSpeechFollow({ session, isOpen, open: openFn, close: closeFn }),
      { initialProps: { session: makeSession() as SpeechFollowSession | null, isOpen: false } },
    )
    return { openFn, closeFn, ...view }
  }

  it('正: 未入電のチャンクを鳴らし始めたら開く', () => {
    const { openFn } = setup()
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalledTimes(1)
  })

  it('対照: 未入電の手前（観測値を読んでいる間）では開かない', () => {
    const { openFn } = setup()
    playChunk(RANGE.first - 1)
    expect(openFn).not.toHaveBeenCalled()
  })

  it('正: 未入電の範囲を抜けたら閉じる（読み上げの終わりを待たない）', () => {
    const { openFn, closeFn, rerender } = setup()
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalledTimes(1)
    rerender({ session: makeSession(), isOpen: true })
    playChunk(RANGE.last)
    expect(closeFn).not.toHaveBeenCalled()
    playChunk(RANGE.last + 1)
    expect(closeFn).toHaveBeenCalledTimes(1)
  })

  it('安全弁: 手で開かれているものには触らない（開いたことにせず、閉じもしない）', () => {
    const openFn = vi.fn((_subject: string | undefined): UnreceivedOpenResult => 'opened')
    const closeFn = vi.fn()
    const { rerender } = renderHook(
      ({ session, isOpen }: { session: SpeechFollowSession | null; isOpen: boolean }) =>
        useUnreceivedSpeechFollow({ session, isOpen, open: openFn, close: closeFn }),
      { initialProps: { session: makeSession() as SpeechFollowSession | null, isOpen: true } },
    )
    playChunk(RANGE.first)
    expect(openFn).not.toHaveBeenCalled()
    playChunk(RANGE.last + 1)
    expect(closeFn).not.toHaveBeenCalled()
    // 読み上げが終わっても閉じない（利用者が開いた一覧を奪わない）。
    rerender({ session: null, isOpen: true })
    expect(closeFn).not.toHaveBeenCalled()
  })

  it('安全弁: 開けなかったとき（対象の地震が画面に無い等）は、抜けても閉じない', () => {
    const { openFn, closeFn } = setup(() => 'mismatch')
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalled()
    playChunk(RANGE.last + 1)
    expect(closeFn).not.toHaveBeenCalled()
  })

  it('読み上げが割り込まれて終わったら、自分が開いた分を閉じる', () => {
    const { openFn, closeFn, rerender } = setup()
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalledTimes(1)
    rerender({ session: null, isOpen: true })
    expect(closeFn).toHaveBeenCalledTimes(1)
  })

  it('画面から消えるときに開けっ放しにしない', () => {
    const { openFn, closeFn, unmount } = setup()
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalledTimes(1)
    unmount()
    expect(closeFn).toHaveBeenCalledTimes(1)
  })

  it('再生時計が無い（VOICEVOX 未起動・合成が全滅）ときは何もしない', () => {
    const { openFn, closeFn } = setup()
    clock = null
    act(() => { vi.advanceTimersByTime(40) })
    expect(openFn).not.toHaveBeenCalled()
    expect(closeFn).not.toHaveBeenCalled()
  })

  it('正: 開くときも閉じるときも、読み上げの主題（どの地震か）を渡す', () => {
    const { openFn, closeFn, rerender } = setup()
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalledWith(SUBJECT)
    rerender({ session: makeSession(), isOpen: true })
    playChunk(RANGE.last + 1)
    expect(closeFn).toHaveBeenCalledWith(SUBJECT)
  })

  it('安全弁: 開いたあと主題が変わっても、閉じるのは開いたときの主題', () => {
    // 読み上げの順番待ちのあいだに別の地震が届いて選択が移ると、いま画面にあるのは
    // 利用者が開き直した別の表示になりうる。閉じる相手を取り違えない。
    const { openFn, closeFn, rerender } = setup()
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalledWith(SUBJECT)
    rerender({ session: makeSession('quake-B'), isOpen: true })
    playChunk(RANGE.last + 1)
    expect(closeFn).toHaveBeenCalledWith(SUBJECT)
  })

  it('正: 開くべきなのに開けなかったら、読み上げの終わりに 1 回だけ記録する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { rerender } = setup(() => 'mismatch')
    playChunk(RANGE.first)
    playChunk(RANGE.first + 1)
    // 毎フレーム出さない（rAF は 1 秒に数十回回る）。
    expect(warn).not.toHaveBeenCalled()
    rerender({ session: null, isOpen: false })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('未入電を読み上げているのに')
    warn.mockRestore()
  })

  it('対照: 開かないことを選んだだけなら記録しない（別のタブを見ている等）', () => {
    // 正常な見送りまで記録すると、警告が埋まって診断が役に立たなくなる。
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { rerender } = setup(() => 'declined')
    playChunk(RANGE.first)
    rerender({ session: null, isOpen: false })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('正: 未入電の読み上げなのに地点名のチャンクを引けなかったら記録する', () => {
    // 読み仮名辞書の分割や文の組み立てを変えたとき、参照との対応が崩れると開閉が黙って止まる。
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const observedOnly: SpeechSegment[] = [
      plain('地震情報。最大震度5強を'),
      seg('大分県中部', observed('大分県中部', 55)),
      plain('で観測しました。'),
    ]
    const chunks = splitIntoChunks(joinSegments(observedOnly))
    const session: SpeechFollowSession = {
      token: 2,
      segments: observedOnly,
      subject: SUBJECT,
      chunks,
      schedule: chunks.map((_, index) => ({ index, startAt: 10 + index })),
    }
    const { rerender } = renderHook(
      ({ session, isOpen }: { session: SpeechFollowSession | null; isOpen: boolean }) =>
        useUnreceivedSpeechFollow({ session, isOpen, open: () => 'opened', close: () => {} }),
      { initialProps: { session: session as SpeechFollowSession | null, isOpen: false } },
    )
    clock = 11.5
    act(() => { vi.advanceTimersByTime(40) })
    rerender({ session: null, isOpen: false })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('地点名を含むチャンクを 1 つも引けませんでした')
    warn.mockRestore()
  })

  it('安全弁: 開閉のコールバックが例外を投げても、記録して先へ進む', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const openFn = vi.fn((_subject: string | undefined): UnreceivedOpenResult => { throw new Error('boom') })
    renderHook(() => useUnreceivedSpeechFollow({ session: makeSession(), isOpen: false, open: openFn, close: () => {} }))
    playChunk(RANGE.first)
    expect(openFn).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('未入電モードの開閉に失敗')
    warn.mockRestore()
  })
})
