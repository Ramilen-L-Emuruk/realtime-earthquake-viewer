import { describe, expect, it } from 'vitest'
import {
  PUBLIC_REPLAY_ARCHIVE_LAG_MS,
  PUBLIC_REPLAY_CHUNK_MS,
  PUBLIC_REPLAY_LEAD_MS,
  PUBLIC_REPLAY_MIN_STEP_MS,
  planPublicReplayFetch,
} from './publicReplayPlan'

const REAL = Date.parse('2026-10-15T12:00:00Z')
const REPLAY = Date.parse('2024-01-01T07:10:00Z')
const SPAN = 120

describe('planPublicReplayFetch', () => {
  // 正: 何も取っていなければ、表示の幅ぶん遡って 1 回ぶん先まで取る（入れ物は空にしてから）。
  it('出し始めは幅ぶん遡って先まで取る', () => {
    const p = planPublicReplayFetch({ replayNowMs: REPLAY, realNowMs: REAL, spanSec: SPAN, fetched: null })
    expect(p.kind).toBe('fetch')
    if (p.kind !== 'fetch') return
    expect(p.reset).toBe(true)
    expect(p.range.fromMs).toBeLessThanOrEqual(REPLAY - SPAN * 1000)
    expect(p.range.toMs).toBe(REPLAY + PUBLIC_REPLAY_CHUNK_MS)
  })

  // 対照: 取った分の終わりまで余裕があるうちは取らない。
  it('終わりまで余裕があれば取らない', () => {
    const fetched = { fromMs: REPLAY - 130_000, toMs: REPLAY + PUBLIC_REPLAY_CHUNK_MS }
    expect(planPublicReplayFetch({ replayNowMs: REPLAY + 60_000, realNowMs: REAL, spanSec: SPAN, fetched }).kind).toBe('idle')
  })

  // 正: 終わりに近づいたら、続きを 1 回ぶん取る（取った分は残す）。
  it('終わりが近づいたら続きを取る', () => {
    const fetched = { fromMs: REPLAY - 130_000, toMs: REPLAY + PUBLIC_REPLAY_CHUNK_MS }
    const now = fetched.toMs - PUBLIC_REPLAY_LEAD_MS + 1
    const p = planPublicReplayFetch({ replayNowMs: now, realNowMs: REAL, spanSec: SPAN, fetched })
    expect(p).toEqual({ kind: 'fetch', range: { fromMs: fetched.toMs, toMs: fetched.toMs + PUBLIC_REPLAY_CHUNK_MS }, reset: false })
  })

  // 正: 再生時刻が取った分の外へ飛んだら（始め直し・時刻の変更）、捨てて取り直す。
  it('取った分の外へ飛んだら取り直す', () => {
    const fetched = { fromMs: REPLAY - 130_000, toMs: REPLAY + PUBLIC_REPLAY_CHUNK_MS }
    expect(planPublicReplayFetch({ replayNowMs: REPLAY - 3_600_000, realNowMs: REAL, spanSec: SPAN, fetched })).toMatchObject({ kind: 'fetch', reset: true })
    expect(planPublicReplayFetch({ replayNowMs: REPLAY + 3_600_000, realNowMs: REAL, spanSec: SPAN, fetched })).toMatchObject({ kind: 'fetch', reset: true })
  })

  // 安全弁: いまから 2 分より新しい範囲は頼まない（保存庫にまだ入っていない分を繰り返し問い合わせない）。
  it('いまから 2 分より新しい範囲は頼まない', () => {
    const near = REAL - 60_000
    const p = planPublicReplayFetch({ replayNowMs: near, realNowMs: REAL, spanSec: SPAN, fetched: null })
    expect(p.kind).toBe('fetch')
    if (p.kind === 'fetch') expect(p.range.toMs).toBe(REAL - PUBLIC_REPLAY_ARCHIVE_LAG_MS)
    // 取った分がもう上限まで来ていれば、近づいても取らない
    const fetched = { fromMs: near - 600_000, toMs: REAL - PUBLIC_REPLAY_ARCHIVE_LAG_MS }
    expect(planPublicReplayFetch({ replayNowMs: fetched.toMs, realNowMs: REAL, spanSec: SPAN, fetched }).kind).toBe('idle')
  })

  // 安全弁: 上限は本当の時刻とともに進む。見直しのたびに数秒ぶんずつ取りに行かない（2 秒ごとに 2 分ぶん回して数える）。
  // 対照: 上限から十分に離れた分が溜まれば、続きを取る。
  it('上限に張り付いている間は短い続きを取りに行き続けない', () => {
    let fetched = { fromMs: REAL - 600_000, toMs: REAL - PUBLIC_REPLAY_ARCHIVE_LAG_MS }
    let fetches = 0
    for (let t = 0; t <= 120_000; t += 2_000) {
      const p = planPublicReplayFetch({ replayNowMs: REAL - 150_000 + t, realNowMs: REAL + t, spanSec: SPAN, fetched })
      if (p.kind === 'fetch') {
        fetches += 1
        expect(p.reset).toBe(false)
        expect(p.range.toMs - p.range.fromMs).toBeGreaterThanOrEqual(PUBLIC_REPLAY_MIN_STEP_MS)
        fetched = { fromMs: fetched.fromMs, toMs: p.range.toMs }
      }
    }
    expect(fetches).toBeGreaterThan(0)
    expect(fetches).toBeLessThanOrEqual(120_000 / PUBLIC_REPLAY_MIN_STEP_MS)
  })
})
