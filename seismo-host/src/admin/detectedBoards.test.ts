// `/status` の `sensors[]` を基板単位へ畳む変換のテスト。
//
// **ここが崩れると、入力候補に出る基板・センサーが実物とずれる。** ずれても
// 保存は通り、`sensorId` が食い違えば校正値が 1 つも効かないまま既定値で
// 動き続ける（`detectedBoards.ts` 冒頭）ので、画面からは気づけない。

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchDetectedBoards,
  groupDetectedBoards,
  readRestWindows,
  type DetectedSensorView,
} from './detectedBoards'

function sensor(
  boardKey: string,
  sensorId: string,
  lastPacketMs: number | null = 1000,
): DetectedSensorView {
  return { boardKey, sensorId, lastPacketMs }
}

describe('groupDetectedBoards', () => {
  it('同じ基板のセンサーを 1 行へ畳む', () => {
    const result = groupDetectedBoards([
      sensor('mac:aaa', 'accel-0'),
      sensor('mac:aaa', 'accel-1'),
      sensor('mac:bbb', 'accel-0'),
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ boardKey: 'mac:aaa', sensorIds: ['accel-0', 'accel-1'] })
    expect(result[1]).toMatchObject({ boardKey: 'mac:bbb', sensorIds: ['accel-0'] })
  })

  // **並びは `/status` のまま**（音沙汰の新しい順・`sensorHealth.ts` の `snapshot`）。
  // ここで並べ替えると、いま生きている基板が上へ来る順序が失われる。
  it('入力の並びを保つ（音沙汰の新しい順が候補の並びになる）', () => {
    const result = groupDetectedBoards([sensor('mac:zzz', 'a'), sensor('mac:aaa', 'a')])
    expect(result.map((d) => d.boardKey)).toEqual(['mac:zzz', 'mac:aaa'])
  })

  // **カードの軸の本数は届いた事実で決める**（`viewBoards.ts` の「登録」）。
  it('正: センサーごとに届いた軸の本数（2 か 3）を覚える', () => {
    const result = groupDetectedBoards([
      { ...sensor('mac:aaa', 'i2c0-6a'), axisCount: 2 },
      { ...sensor('mac:aaa', 'i2c0-68'), axisCount: 3 },
    ])
    expect(result[0].axisCounts).toEqual({ 'i2c0-6a': 2, 'i2c0-68': 3 })
  })

  it('安全弁: 欄の無い古いホスト・2 と 3 以外の本数は載せない（呼ぶ側が 3 軸で作る）', () => {
    const result = groupDetectedBoards([
      sensor('mac:aaa', 'old'),
      { ...sensor('mac:aaa', 'odd'), axisCount: 6 },
      { ...sensor('mac:aaa', 'text'), axisCount: '2' },
      { ...sensor('mac:aaa', 'none'), axisCount: null },
    ])
    expect(result[0].axisCounts).toEqual({})
    expect(result[0].sensorIds).toEqual(['old', 'odd', 'text', 'none'])
  })

  it('同じセンサー ID が二度現れても候補は 1 つ', () => {
    const result = groupDetectedBoards([sensor('mac:aaa', 'accel-0'), sensor('mac:aaa', 'accel-0')])
    expect(result[0].sensorIds).toEqual(['accel-0'])
  })

  it('最終受信はその基板でいちばん新しいものを採る', () => {
    const result = groupDetectedBoards([
      sensor('mac:aaa', 'accel-0', 500),
      sensor('mac:aaa', 'accel-1', 900),
    ])
    expect(result[0].lastPacketMs).toBe(900)
  })

  // **`null` を `0` で埋めない。** 1970 年として読めてしまい、「時刻が壊れている」と
  // 「まだ一度も届いていない」を受け手が区別できなくなる。
  it('読める時刻が 1 つも無ければ null のまま', () => {
    const result = groupDetectedBoards([
      sensor('mac:aaa', 'accel-0', null),
      sensor('mac:aaa', 'accel-1', null),
    ])
    expect(result[0].lastPacketMs).toBeNull()
  })

  it('一部だけ時刻が読めなければ、読める分から採る', () => {
    const result = groupDetectedBoards([
      sensor('mac:aaa', 'accel-0', null),
      sensor('mac:aaa', 'accel-1', 700),
    ])
    expect(result[0].lastPacketMs).toBe(700)
  })

  // **空は候補にしない。** 設定側が空文字を弾く（`stationConfig.ts` の
  // `nonEmptyString`）ので、選べても保存できない候補になる。
  it('空の基板 Key・センサー ID は候補から外す', () => {
    const result = groupDetectedBoards([
      sensor('', 'accel-0'),
      sensor('mac:aaa', ''),
      sensor('mac:aaa', 'accel-0'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ boardKey: 'mac:aaa', sensorIds: ['accel-0'] })
  })

  it('センサーが 1 件も無ければ空配列', () => {
    expect(groupDetectedBoards([])).toEqual([])
  })
})

describe('fetchDetectedBoards', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('/status の generatedAtMs をそのまま基準の時刻にする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ generatedAtMs: 12345, sensors: [sensor('mac:aaa', 'accel-0')] }),
      })),
    )
    const snapshot = await fetchDetectedBoards()
    expect(snapshot.generatedAtMs).toBe(12345)
    expect(snapshot.boards).toHaveLength(1)
  })

  // **受け手の時計へ黙って倒さない。** そうすると「N 秒前」の表示だけが別の時計を
  // 基準にすり替わり、画面は一見正常なまま経過だけが嘘になる。
  it('generatedAtMs が読めなければ null にし、警告を残す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sensors: [sensor('mac:aaa', 'accel-0')] }),
      })),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const snapshot = await fetchDetectedBoards()

    expect(snapshot.generatedAtMs).toBeNull()
    // 候補そのものは使える（時刻が読めないことと、基板が判らないことは別）。
    expect(snapshot.boards).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('sensors が無くても落ちない（空の候補として扱う）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ generatedAtMs: 1 }) })),
    )
    expect((await fetchDetectedBoards()).boards).toEqual([])
  })

  it('非 2xx は投げる（呼び出し側が「候補を出せない」と表示できるように）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    )
    await expect(fetchDetectedBoards()).rejects.toThrow('HTTP 503')
  })
})

describe('readRestWindows', () => {
  const window = {
    boardKey: 'mac:aa',
    sensorId: 'accel-0',
    atMs: 9_500,
    sampleCount: 2_984,
    meanGal: 980.7,
    sdGal: 1.4,
    axisMeanGal: [0.4, -1.2, 980.7],
    scale: 'ok',
    restless: false,
  }

  it('そのまま読める判定は全部の欄が残る', () => {
    expect(readRestWindows([window])).toEqual([window])
  })

  it('配列でなければ空（応答の形が変わっても投げない）', () => {
    expect(readRestWindows(undefined)).toEqual([])
    expect(readRestWindows({ verdicts: [] })).toEqual([])
  })

  // **どのセンサーの話か決まらない判定は捨てる。** 残すと、引き当ての鍵が空の
  // まま一覧に並び、センサー ID が空のカードに誤って結び付く。
  it('基板 Key かセンサー ID が空の判定は捨てる', () => {
    expect(readRestWindows([{ ...window, boardKey: '' }])).toEqual([])
    expect(readRestWindows([{ ...window, sensorId: '' }])).toEqual([])
  })

  // **知らない値を `ok` へ倒さない。** ホスト側が判定を増やした日に、解釈できない
  // 窓から提案を出してしまう。
  it('知らない判定は unknown にする', () => {
    expect(readRestWindows([{ ...window, scale: 'brand-new' }])[0].scale).toBe('unknown')
  })

  it('軸ごとの重力は 3 つそろって数として読めるときだけ通す', () => {
    expect(readRestWindows([{ ...window, axisMeanGal: [1, 2] }])[0].axisMeanGal).toBeNull()
    expect(readRestWindows([{ ...window, axisMeanGal: 'x' }])[0].axisMeanGal).toBeNull()
    expect(
      readRestWindows([{ ...window, axisMeanGal: [1, Number.NaN, 3] }])[0].axisMeanGal,
    ).toBeNull()
  })

  it('読めない時刻・数値は null へ倒す（0 で埋めない）', () => {
    const got = readRestWindows([{ ...window, atMs: null, meanGal: 'x', sdGal: undefined }])[0]
    expect(got.atMs).toBeNull()
    expect(got.meanGal).toBeNull()
    expect(got.sdGal).toBeNull()
  })

  it('`/status` に gravity が無くても空で返る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ generatedAtMs: 1, sensors: [] }),
      })),
    )
    expect((await fetchDetectedBoards()).restWindows).toEqual([])
  })
})
