import { describe, expect, it } from 'vitest'

import { AssignmentClock, STALE_AFTER_MS, assignedReception, assignmentKey } from './assignedReception'
import type { AssignedBoardsConfig, AssignedReceptionInput } from './assignedReception'

const STARTED = 1_700_000_000_000
/** 起動から物差しを十分過ぎた時刻。 */
const LATER = STARTED + 10 * STALE_AFTER_MS

const ONE_BOARD: AssignedBoardsConfig = [{ boardKey: 'mac:aa', stationId: 'garage', sensors: [] }]

function input(overrides: Partial<AssignedReceptionInput> = {}): AssignedReceptionInput {
  const boards = overrides.boards ?? ONE_BOARD
  return {
    nowMs: LATER,
    assignedSinceMs: new AssignmentClock(boards, STARTED).snapshot(),
    boards,
    heard: [],
    ...overrides,
  }
}

describe('assignedReception', () => {
  it('割り当ててから一度も届かない基板は、物差しを過ぎたら黙ったと見なす', () => {
    const [board] = assignedReception(input())

    expect(board).toMatchObject({ boardKey: 'mac:aa', stationId: 'garage', lastPacketMs: null, state: 'silent' })
  })

  it('対照: 割り当ててから物差しを過ぎるまでは、未受信でも判断を保留する（再起動のたびに全部並べない）', () => {
    expect(assignedReception(input({ nowMs: STARTED + STALE_AFTER_MS }))[0].state).toBe('waiting')
    expect(assignedReception(input({ nowMs: STARTED + STALE_AFTER_MS + 1 }))[0].state).toBe('silent')
  })

  it('安全弁: 割り当てた時刻を知らない基板には猶予を与えない（黙って保留に留めない）', () => {
    expect(assignedReception(input({ nowMs: STARTED, assignedSinceMs: new Map() }))[0].state).toBe('silent')
  })

  it('どれか 1 個のセンサーが届いていれば基板は生きている（いちばん新しい時刻を採る）', () => {
    const [board] = assignedReception(
      input({
        heard: [
          { boardKey: 'mac:aa', sensorId: 's0', lastPacketMs: LATER - 5 * STALE_AFTER_MS },
          { boardKey: 'mac:aa', sensorId: 's1', lastPacketMs: LATER - 1_000 },
        ],
      }),
    )

    expect(board.state).toBe('live')
    expect(board.lastPacketMs).toBe(LATER - 1_000)
  })

  it('境界は管理コンソールの「途絶」と同じ（超えたら黙った）', () => {
    const at = (lastPacketMs: number) =>
      assignedReception(input({ heard: [{ boardKey: 'mac:aa', sensorId: 's0', lastPacketMs }] }))[0].state

    expect(at(LATER - STALE_AFTER_MS)).toBe('live')
    expect(at(LATER - STALE_AFTER_MS - 1)).toBe('silent')
  })

  it('別の基板の声では生きていることにしない', () => {
    const [board] = assignedReception(
      input({ heard: [{ boardKey: 'mac:bb', sensorId: 's0', lastPacketMs: LATER }] }),
    )

    expect(board.state).toBe('silent')
  })

  it('区切り文字を含む名前どうしでも、別の基板・センサーの声と混ざらない', () => {
    const boards: AssignedBoardsConfig = [
      { boardKey: 'name:a', stationId: 'garage', sensors: [{ sensorId: 'b|c', enabled: true }] },
    ]
    const [board] = assignedReception(
      input({ boards, heard: [{ boardKey: 'name:a|b', sensorId: 'c', lastPacketMs: LATER }] }),
    )

    expect(board.state).toBe('silent')
    expect(board.sensors[0].state).toBe('silent')
  })

  it('読めない時刻は「届いていない」へ倒す（NaN の比較で永久に受信中にならない）', () => {
    const [board] = assignedReception(
      input({ heard: [{ boardKey: 'mac:aa', sensorId: 's0', lastPacketMs: Number.NaN }] }),
    )

    expect(board.lastPacketMs).toBeNull()
    expect(board.state).toBe('silent')
  })

  it('sensors[] に書いた有効なセンサーを個別に見る（基板は生きていても 1 個だけ黙りうる）', () => {
    const [board] = assignedReception(
      input({
        boards: [
          {
            boardKey: 'mac:aa',
            stationId: 'garage',
            sensors: [
              { sensorId: 's0', enabled: true },
              { sensorId: 's1', enabled: true },
            ],
          },
        ],
        heard: [{ boardKey: 'mac:aa', sensorId: 's0', lastPacketMs: LATER - 1_000 }],
      }),
    )

    expect(board.state).toBe('live')
    expect(board.sensors).toEqual([
      { sensorId: 's0', lastPacketMs: LATER - 1_000, state: 'live' },
      { sensorId: 's1', lastPacketMs: null, state: 'silent' },
    ])
  })

  it('安全弁: 無効にしたセンサーは見ないが、基板そのものの判定には無効化を効かせない', () => {
    const [board] = assignedReception(
      input({
        boards: [{ boardKey: 'mac:aa', stationId: 'garage', sensors: [{ sensorId: 's0', enabled: false }] }],
      }),
    )

    expect(board.sensors).toEqual([])
    expect(board.state).toBe('silent')
  })

  it('設定の並びのまま返す', () => {
    const boards = assignedReception(
      input({
        boards: [
          { boardKey: 'mac:cc', stationId: 'garage', sensors: [] },
          { boardKey: 'mac:aa', stationId: 'garage', sensors: [] },
        ],
      }),
    )

    expect(boards.map((b) => b.boardKey)).toEqual(['mac:cc', 'mac:aa'])
  })
})

describe('AssignmentClock', () => {
  it('稼働中に足した基板は、足した時刻から猶予を数える（足した瞬間に「届いていない」と言わない）', () => {
    const clock = new AssignmentClock(ONE_BOARD, STARTED)
    const added: AssignedBoardsConfig = [...ONE_BOARD, { boardKey: 'mac:bb', stationId: 'garage', sensors: [] }]
    clock.update(added, LATER)

    const states = (nowMs: number) =>
      assignedReception({ nowMs, assignedSinceMs: clock.snapshot(), boards: added, heard: [] }).map((b) => b.state)

    expect(states(LATER)).toEqual(['silent', 'waiting'])
    expect(states(LATER + STALE_AFTER_MS + 1)).toEqual(['silent', 'silent'])
  })

  it('対照: 続いている割り当ての起点は動かさない（観測点を付け替えても猶予をやり直さない）', () => {
    const clock = new AssignmentClock(ONE_BOARD, STARTED)
    clock.update([{ boardKey: 'mac:aa', stationId: 'study', sensors: [] }], LATER)

    expect(clock.snapshot().get(assignmentKey('mac:aa'))).toBe(STARTED)
  })

  it('外した割り当ては忘れる（付け直したら、そこから数え直す）', () => {
    const clock = new AssignmentClock(ONE_BOARD, STARTED)
    clock.update([], LATER)
    expect(clock.snapshot().has(assignmentKey('mac:aa'))).toBe(false)

    clock.update(ONE_BOARD, LATER + 5)
    expect(clock.snapshot().get(assignmentKey('mac:aa'))).toBe(LATER + 5)
  })

  it('sensors[] に書いたセンサーも、足した時刻から数える', () => {
    const clock = new AssignmentClock(ONE_BOARD, STARTED)
    clock.update([{ boardKey: 'mac:aa', stationId: 'garage', sensors: [{ sensorId: 's9', enabled: true }] }], LATER)

    expect(clock.snapshot().get(assignmentKey('mac:aa', 's9'))).toBe(LATER)
  })
})
