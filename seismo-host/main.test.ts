import { describe, expect, it } from 'vitest'

// **読み込むだけで待ち受けが開かないことも、この import が確かめている。**
// `main()` は「直接実行のときだけ走らせる」門の中にあるので、ここでは走らない
// （門が無ければ、このテストを走らせるたびに UDP の口が開く）。
import {
  applyStationConfigCore,
  closeHostCore,
  makeShutdownRequester,
  deliverFusionClosing,
  buildAssignedSilenceReport,
  buildBacklogBookWarning,
  buildBacklogEventLine,
  buildBacklogUnsettledWarning,
  buildBoardClockWarnings,
  buildClosingLines,
  buildGravityWarnings,
  buildLoopStallWarning,
  buildRecvBufferLine,
  deliverReading,
  deliverStationFusion,
  buildRawWarnings,
  buildStationConfigWarning,
  buildStationGroupingWarning,
  buildTimebaseEpochWarning,
  buildWindowSummary,
  findUngroupedMultiBoardStations,
  formatAt,
  readAdminAllowedHosts,
  readAdminToken,
  readAllowList,
  readPort,
  readQuakeFeedEnabled,
  stationSegmentLogLevel,
  windowSeconds,
} from './main'

describe('readQuakeFeedEnabled（#312）', () => {
  it('既定（未設定）で受け取る。0 のときだけ止める', () => {
    expect(readQuakeFeedEnabled(undefined)).toBe(true)
    expect(readQuakeFeedEnabled('1')).toBe(true)
    expect(readQuakeFeedEnabled('')).toBe(true)
    expect(readQuakeFeedEnabled('0')).toBe(false)
  })
})
import type { ApplyStationConfigDeps, CloseHostDeps, FusionClosingSinks } from './main'
import type { AssignedBoardReception } from './src/receiver/assignedReception'
import { STALE_AFTER_MS } from './src/receiver/assignedReception'
import { CLOCK_OFFSET_WARN_MS } from './src/receiver/boardClockVerdict'
import type { GravityVerdict } from './src/receiver/gravityCheck'
import type { IntensityReading } from './src/receiver/intensityPipeline'
import { EMPTY_STATION_CONFIG } from './src/receiver/stationConfig'
import type { StationConfig } from './src/receiver/stationConfig'
import { PacketTally } from './src/receiver/packetTally'
import type {
  FusedWaveChunk,
  FusionOutcome,
  StationCloseFailure,
  StationIntensityReading,
} from './src/receiver/sensorFusion'

describe('formatAt', () => {
  it('普通の時刻はそのまま出す', () => {
    // `toISOString()` は協定世界時。テストの時間帯（JST 固定）には引きずられない。
    expect(formatAt(1790181865671)).toBe('2026-09-23T16:44:25.671Z')
  })

  it('時刻として表せない値でも投げず、印を付けて返す', () => {
    // **投げると 1 件の失敗が他を巻き添えにする。** 出す側は 1 パケットぶんの震度を
    // まとめて回しており、その中には他の基板の締めくくりが混ざる。途中で投げれば
    // 残りは数えも出しもされないまま消える。
    for (const bad of [1e20, -1e20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatAt(bad)).not.toThrow()
      expect(formatAt(bad)).toContain('時刻不正')
    }
  })
})

describe('readPort', () => {
  it('省略したら既定の口を使う', () => {
    expect(readPort(undefined)).toBe(50505)
    expect(readPort('')).toBe(50505)
  })

  it('10 進の値をそのまま使う', () => {
    expect(readPort('50505')).toBe(50505)
    expect(readPort('0')).toBe(0)
    expect(readPort('65535')).toBe(65535)
  })

  it('10 進でない表記は弾く', () => {
    // **`Number()` に任せると通ってしまう形。** `0x1F91` は 8081 として読めるので、
    // 打ち間違えに気づかないまま別の口で待ち受けることになる。
    expect(() => readPort('0x1F91')).toThrow(/読めない/)
    expect(() => readPort('1e3')).toThrow(/読めない/)
    expect(() => readPort('50505.0')).toThrow(/読めない/)
    expect(() => readPort(' 50505')).toThrow(/読めない/)
    expect(() => readPort('-1')).toThrow(/読めない/)
    expect(() => readPort('ポート')).toThrow(/読めない/)
  })

  it('範囲の外は別の文言で弾く', () => {
    // 書式は正しいので、打ち間違えの種類が違う。
    expect(() => readPort('70000')).toThrow(/範囲を超えている/)
  })
})

describe('readAdminToken', () => {
  it('未設定は null', () => {
    expect(readAdminToken(undefined)).toBeNull()
  })

  // **安全弁**: 空文字列を「設定済みの空トークン」として扱わない。
  it('空文字列・空白だけの値も null 扱いにする', () => {
    expect(readAdminToken('')).toBeNull()
    expect(readAdminToken('   ')).toBeNull()
  })

  it('前後の空白を落として使う', () => {
    expect(readAdminToken('  abc123  ')).toBe('abc123')
  })
})

describe('readAllowList', () => {
  it('未設定は空配列', () => {
    expect(readAllowList(undefined)).toEqual([])
  })

  it('カンマ区切りを配列にし、各要素の前後の空白を落とす', () => {
    expect(readAllowList('a, b ,c')).toEqual(['a', 'b', 'c'])
  })

  it('空要素は無視する', () => {
    expect(readAllowList('a,,b,')).toEqual(['a', 'b'])
  })
})

describe('readAdminAllowedHosts', () => {
  it('未設定なら既定値（127.0.0.1・localhost とポート）を使う', () => {
    expect(readAdminAllowedHosts(undefined, 50506)).toEqual(['127.0.0.1:50506', 'localhost:50506'])
  })

  // **安全弁**: `readAdminToken` と同じく、空文字列は「未設定」と同じに扱う——
  // ここだけ `readAllowList` をそのまま使うと空配列（＝誰も通さない）になってしまい、
  // 空値をそのままコピペする打ち間違いで `/api/*` が理由の分からないまま塞がる。
  it('空文字列・空白だけの値も既定値へ倒す', () => {
    expect(readAdminAllowedHosts('', 50506)).toEqual(['127.0.0.1:50506', 'localhost:50506'])
    expect(readAdminAllowedHosts('   ', 50506)).toEqual(['127.0.0.1:50506', 'localhost:50506'])
  })

  it('値があればそれを使う（既定値は使わない）', () => {
    expect(readAdminAllowedHosts('example.ts.net', 50506)).toEqual(['example.ts.net'])
  })
})

describe('buildWindowSummary', () => {
  const empty = new PacketTally().snapshotTotal()

  function withPacket(): ReturnType<PacketTally['snapshotTotal']> {
    const tally = new PacketTally()
    tally.record({ kind: 'received', source: '192.0.2.83' })
    return tally.snapshotTotal()
  }

  it('届かなかった窓は、続く間 1 度だけ伝える', () => {
    const first = buildWindowSummary({
      windowSec: 60,
      window: empty,
      counters: [],
      quietReported: false,
    })
    expect(first.lines).toEqual(['[集計] 直近 60 秒は 1 件も届いていない'])
    expect(first.quietReported).toBe(true)

    // 2 度目からは黙る。毎分同じ空の表を出すと記録が埋まる。
    const second = buildWindowSummary({
      windowSec: 60,
      window: empty,
      counters: [],
      quietReported: first.quietReported,
    })
    expect(second.lines).toEqual([])
    expect(second.quietReported).toBe(true)
  })

  it('届いたら印を降ろす（次に黙ったときまた伝わる）', () => {
    const summary = buildWindowSummary({
      windowSec: 60,
      window: withPacket(),
      counters: [],
      quietReported: true,
    })
    expect(summary.quietReported).toBe(false)
    expect(summary.lines).toEqual(['[集計] 直近 60 秒', '  送信元 192.0.2.83 届いた=1'])
  })

  it('送信元の枠を捨てた件数を添える', () => {
    const summary = buildWindowSummary({
      windowSec: 60,
      window: withPacket(),
      counters: [{ label: '送信元の枠を捨てた', value: 3 }],
      quietReported: false,
    })
    expect(summary.lines.at(-1)).toBe('  送信元の枠を捨てた=3')
  })

  it('0 の数え上げは出さない', () => {
    // **対照。** 出すと、平常時の要約が「圧縮した=0」の類で埋まって読めなくなる。
    const summary = buildWindowSummary({
      windowSec: 60,
      window: withPacket(),
      counters: [
        { label: '送信元の枠を捨てた', value: 0 },
        { label: '古い記録を圧縮した', value: 1 },
      ],
      quietReported: false,
    })
    expect(summary.lines).toEqual([
      '[集計] 直近 60 秒',
      '  送信元 192.0.2.83 届いた=1',
      '  古い記録を圧縮した=1',
    ])
  })

  it('数え上げが 0 だけなら、届いていないことを伝える', () => {
    // **安全弁。** 0 の数え上げが並んでいるだけで「届いた」と誤認しない。
    const summary = buildWindowSummary({
      windowSec: 60,
      window: empty,
      counters: [{ label: '送信元の枠を捨てた', value: 0 }],
      quietReported: false,
    })
    expect(summary.lines).toEqual(['[集計] 直近 60 秒は 1 件も届いていない'])
    expect(summary.quietReported).toBe(true)
  })

  it('枠を捨てた件数は、行が空でも落とさない', () => {
    // **アドレスを詐称されると上限には一度も掛からず、ここだけが動く。**
    // 「届いた件数が 0 なら捨てようも無い」という呼び出し順の前提を要約の側が
    // 握っていると、順序を変えたときに黙って消える。
    const summary = buildWindowSummary({
      windowSec: 60,
      window: empty,
      counters: [{ label: '送信元の枠を捨てた', value: 2 }],
      quietReported: false,
    })
    expect(summary.lines).toEqual(['[集計] 直近 60 秒', '  送信元の枠を捨てた=2'])
    expect(summary.quietReported).toBe(false)
  })
})

describe('windowSeconds', () => {
  it('実際に経った時間を秒で返す', () => {
    // **名目の間隔は約束であって実績ではない。** 詰まって伸びた窓を「直近 60 秒」と
    // 名乗ると、その窓の件数だけが実際より濃く見える。
    expect(windowSeconds(60_000, 60)).toBe(60)
    expect(windowSeconds(91_400, 60)).toBe(91)
  })

  it('測れなかったときは名目へ倒す', () => {
    // 「直近 0 秒」「直近 -3 秒」「直近 NaN 秒」と書くよりは名目のほうがまし。
    // どちらにせよ件数は正しい。
    expect(windowSeconds(0, 60)).toBe(1)
    expect(windowSeconds(-3_000, 60)).toBe(1)
    expect(windowSeconds(Number.NaN, 60)).toBe(60)
    expect(windowSeconds(Number.POSITIVE_INFINITY, 60)).toBe(60)
  })
})


describe('buildRawWarnings', () => {
  const quiet = {
    lost: 0,
    sinkBroken: 0,
    internal: 0,
    lastWriteError: null,
    lastInternalError: null,
  } as const

  it('何も起きていなければ 1 行も出さない', () => {
    expect(buildRawWarnings(quiet)).toEqual([])
  })

  it('書き損ねた本数があり、理由も判っていれば理由を出す', () => {
    const out = buildRawWarnings({ ...quiet, lost: 3, lastWriteError: 'EACCES: permission denied' })

    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('raw-write')
    expect(out[0]?.line).toContain('[mseed]')
    expect(out[0]?.line).toContain('EACCES')
  })

  it('流し口が壊れただけでも、書き出しの理由を出す', () => {
    // 壊れた瞬間に溜めていたレコードが 0 本なら lost は増えない。それでも理由は要る。
    const out = buildRawWarnings({ ...quiet, sinkBroken: 1, lastWriteError: 'ENOSPC' })

    expect(out.map((w) => w.kind)).toEqual(['raw-write'])
  })

  it('理由が判っていても、その窓で何も起きていなければ出さない', () => {
    // 対照。理由は最後に起きたものが残り続けるので、件数を見ないと毎分出る。
    expect(
      buildRawWarnings({ ...quiet, lastWriteError: 'EACCES', lastInternalError: 'TypeError' }),
    ).toEqual([])
  })

  it('組み立てで受け止めた例外は、書き出しの理由とは別の鍵で出す', () => {
    // 安全弁。鍵を共有すると、片方が出ている間もう片方が間引かれて出ない。
    const out = buildRawWarnings({
      ...quiet,
      lost: 1,
      lastWriteError: '書けない',
      internal: 1,
      lastInternalError: '想定外',
    })

    expect(out.map((w) => w.kind)).toEqual(['raw-write', 'raw-internal'])
    expect(out[1]?.line).toContain('想定外')
  })

  it('長すぎる理由は切り詰める', () => {
    const out = buildRawWarnings({ ...quiet, lost: 1, lastWriteError: 'あ'.repeat(500) })

    expect(out[0]?.line.length).toBeLessThan(300)
    expect(out[0]?.line).toContain('…')
  })
})

describe('buildStationConfigWarning', () => {
  it('対照: warning が null なら何も出さない', () => {
    expect(buildStationConfigWarning(null)).toEqual([])
  })

  it('正: warning があれば warn レベルで 1 件出す', () => {
    const out = buildStationConfigWarning('JSON として読めない: Unexpected token')
    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.kind).toBe('station-config')
    expect(out[0]?.line).toContain('JSON として読めない')
  })

  it('安全弁: 理由が変われば鍵（detail）も変わる——間引きで新しい理由が埋もれない', () => {
    const a = buildStationConfigWarning('読めない: ENOENT')
    const b = buildStationConfigWarning('JSON として読めない: 構文エラー')
    expect(a[0]?.detail).not.toBe(b[0]?.detail)
  })
})

describe('buildStationGroupingWarning', () => {
  it('対照: 乖離が無ければ何も出さない', () => {
    expect(buildStationGroupingWarning([])).toEqual([])
  })

  it('正: 乖離した観測点があれば warn レベルで 1 件出す', () => {
    const out = buildStationGroupingWarning(['study'])
    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.kind).toBe('station-grouping')
    expect(out[0]?.line).toContain('study')
    expect(out[0]?.line).toContain('sensors[]')
  })

  it('安全弁: 観測点の集合が変われば鍵（detail）も変わる', () => {
    const a = buildStationGroupingWarning(['study'])
    const b = buildStationGroupingWarning(['study', 'garage'])
    expect(a[0]?.detail).not.toBe(b[0]?.detail)
  })
})

describe('buildAssignedSilenceReport', () => {
  const NOW = 1_700_000_600_000
  const board = (overrides: Partial<AssignedBoardReception> = {}): AssignedBoardReception => ({
    boardKey: 'mac:aa',
    stationId: 'garage',
    lastPacketMs: NOW - 1_000,
    state: 'live',
    sensors: [],
    ...overrides,
  })

  it('対照: 全部届いていれば何も出さない', () => {
    const out = buildAssignedSilenceReport([board()], NOW, new Set())
    expect(out.warnings).toEqual([])
    expect(out.recoveredLines).toEqual([])
    expect(out.silentKeys.size).toBe(0)
  })

  it('対照: 起動直後の保留（waiting）は警告しない', () => {
    const out = buildAssignedSilenceReport([board({ state: 'waiting', lastPacketMs: null })], NOW, new Set())
    expect(out.warnings).toEqual([])
  })

  it('正: 黙った基板を warn で出す（一度も届かないものと、途絶えたものを言い分ける）', () => {
    const out = buildAssignedSilenceReport(
      [
        board({ boardKey: 'mac:aa', state: 'silent', lastPacketMs: null }),
        board({ boardKey: 'mac:bb', state: 'silent', lastPacketMs: NOW - 95_000 }),
      ],
      NOW,
      new Set(),
    )
    // 1 枚ずつ別の行（別の間引きの鍵）で出る。
    expect(out.warnings).toHaveLength(2)
    expect(out.warnings.map((w) => w.level)).toEqual(['warn', 'warn'])
    expect(out.warnings.map((w) => w.kind)).toEqual(['assigned-board-silent', 'assigned-board-silent'])
    expect(out.warnings[0]?.line).toContain('mac:aa（観測点 garage・一度も届いていない）')
    expect(out.warnings[1]?.line).toContain('mac:bb（観測点 garage・最後に届いてから 95 秒）')
  })

  it('正: 基板が届いているのに、名前を書いたセンサーが黙っていれば別の行で出す', () => {
    const out = buildAssignedSilenceReport(
      [board({ sensors: [{ sensorId: 's1', lastPacketMs: null, state: 'silent' }] })],
      NOW,
      new Set(),
    )
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]?.kind).toBe('assigned-sensor-silent')
    expect(out.warnings[0]?.line).toContain('mac:aa / s1（一度も届いていない。')
  })

  it('安全弁: 基板ごと黙っているなら、センサーを重ねて言わない', () => {
    const out = buildAssignedSilenceReport(
      [board({ state: 'silent', sensors: [{ sensorId: 's1', lastPacketMs: null, state: 'silent' }] })],
      NOW,
      new Set(),
    )
    expect(out.warnings.map((w) => w.kind)).toEqual(['assigned-board-silent'])
  })

  it('間引きの鍵は 1 枚ごとに決まり、経過秒にも、ほかに誰が黙っているかにも左右されない', () => {
    // 顔ぶれ全体を鍵にすると、揺れるたびに新しい鍵ができて間引きの枠を食い潰し、
    // 新しく黙った基板の初めての 1 行まで遅らされる（敵対的レビューの指摘）。
    const a = buildAssignedSilenceReport([board({ state: 'silent', lastPacketMs: NOW - 70_000 })], NOW, new Set())
    const b = buildAssignedSilenceReport([board({ state: 'silent', lastPacketMs: NOW - 130_000 })], NOW, new Set())
    const c = buildAssignedSilenceReport(
      [board({ state: 'silent' }), board({ boardKey: 'mac:bb', state: 'silent' })],
      NOW,
      new Set(),
    )
    expect(a.warnings[0]?.detail).toBe(b.warnings[0]?.detail)
    expect(c.warnings[0]?.detail).toBe(a.warnings[0]?.detail)
    expect(c.warnings[1]?.detail).not.toBe(a.warnings[0]?.detail)
  })

  it('黙っていたものが届くようになったら 1 行出す（基板もセンサーも）', () => {
    const before = buildAssignedSilenceReport(
      [
        board({ boardKey: 'mac:aa', state: 'silent' }),
        board({ boardKey: 'mac:bb', sensors: [{ sensorId: 's1', lastPacketMs: null, state: 'silent' }] }),
      ],
      NOW,
      new Set(),
    )
    const after = buildAssignedSilenceReport(
      [
        board({ boardKey: 'mac:aa' }),
        board({ boardKey: 'mac:bb', sensors: [{ sensorId: 's1', lastPacketMs: NOW, state: 'live' }] }),
      ],
      NOW,
      before.silentKeys,
    )
    expect(after.warnings).toEqual([])
    expect(after.recoveredLines).toEqual(['[station] 届くようになった: mac:aa、mac:bb / s1'])
    expect(after.silentKeys.size).toBe(0)
  })

  it('安全弁: 設定から外した基板を「届くようになった」とは言わない', () => {
    const before = buildAssignedSilenceReport([board({ state: 'silent' })], NOW, new Set())
    const after = buildAssignedSilenceReport([], NOW, before.silentKeys)
    expect(after.recoveredLines).toEqual([])
  })
})

// 2026-10-01 に足した。**一度も時計が合わない基板は `'timebase-jump'` を起こさない**
// ので、遷移を数える側では捉えられない（→ `buildTimebaseEpochWarning` のコメント）。
describe('buildTimebaseEpochWarning', () => {
  const seg = (streamKey: string, epochPlausible: boolean, firstSampleMs: number) => ({
    meta: { streamKey },
    timebase: { epochPlausible, firstSampleMs },
  })

  it('対照: 全部の足場が成り立っていれば何も出さない', () => {
    expect(buildTimebaseEpochWarning([seg('["a","i2c0-68","b1"]', true, 1790000000000)])).toEqual([])
  })

  it('正: 成り立たない区間があれば warn レベルで 1 件出す', () => {
    const out = buildTimebaseEpochWarning([
      seg('["a","i2c0-68","b1"]', false, 8433),
      seg('["a","i2c0-69","b1"]', true, 1790000000000),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.kind).toBe('timebase-epoch')
    // **本数と顔ぶれを出す。** どの流れが壊れているか分からないと手が打てない。
    expect(out[0]?.line).toContain('1 本')
    expect(out[0]?.line).toContain('i2c0-68')
    // 正常な側を巻き込まない。
    expect(out[0]?.line).not.toContain('i2c0-69')
  })

  it('安全弁: 顔ぶれが変われば鍵（detail）も変わる', () => {
    const a = buildTimebaseEpochWarning([seg('["a","i2c0-68","b1"]', false, 8433)])
    const b = buildTimebaseEpochWarning([
      seg('["a","i2c0-68","b1"]', false, 8433),
      seg('["a","i2c0-69","b1"]', false, 8434),
    ])
    expect(a[0]?.detail).not.toBe(b[0]?.detail)
  })
})

describe('buildBacklogBookWarning', () => {
  it('対照: 読めていれば何も出さない', () => {
    expect(buildBacklogBookWarning(null)).toEqual([])
  })

  it('読めなかった理由を添えて warn で出す（定期要約でも同じ文面で再掲する）', () => {
    const out = buildBacklogBookWarning('中身が帳面の形をしていない')
    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.line).toBe(
      '[backlog] 前回の欠けの帳面を読めなかった（中身が帳面の形をしていない）。止まっていた間の欠けは取り戻さない',
    )
  })
})

describe('buildBacklogUnsettledWarning', () => {
  it('対照: 書き終わりを待っていなければ何も出さない', () => {
    expect(buildBacklogUnsettledWarning(null, 100_000)).toEqual([])
  })

  it('正: 待っている間は、待ち始めてからの秒数を添えて warn で出す（毎分の要約で毎回出す）', () => {
    const out = buildBacklogUnsettledWarning(40_000, 100_400)
    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.line).toBe('[backlog] 取り戻したまとまりの書き終わりを待っていて、取り戻しを止めている（60 秒）')
  })

  it('安全弁: 時計が戻っても負の秒数にしない', () => {
    expect(buildBacklogUnsettledWarning(100_000, 90_000)[0]?.line).toContain('（0 秒）')
  })
})

describe('buildBacklogEventLine', () => {
  const KEY = 'mac:020000000001|34b6e78f|i2c0-68'

  it('取り戻せた分は log で、サンプル数とまとまりの数を添える', () => {
    const out = buildBacklogEventLine({ kind: 'recovered', key: KEY, address: '192.0.2.41', packets: 2, samples: 60 })
    expect(out.level).toBe('log')
    expect(out.line).toBe(`[backlog] ${KEY} 基板から 60 サンプル（2 まとまり）を取り戻した`)
  })

  it('取り戻せなかった分は warn で、理由を言葉で出す', () => {
    const out = buildBacklogEventLine({ kind: 'unrecoverable', key: KEY, address: '192.0.2.41', reason: 'rebooted', samples: 30 })
    expect(out.level).toBe('warn')
    expect(out.line).toBe(`[backlog] ${KEY} 30 サンプルを取り戻せなかった（基板が再起動していた）`)
  })

  it('取りに行けなかったときは warn で、あとで訊き直すと添える', () => {
    const out = buildBacklogEventLine({
      kind: 'failed', key: KEY, address: '192.0.2.41', reason: 'network', detail: 'connect ETIMEDOUT',
    })
    expect(out.level).toBe('warn')
    expect(out.line).toContain('基板 192.0.2.41 へ取りに行けず（network: connect ETIMEDOUT）')
  })

  it('間引きの鍵に数を混ぜない（数が変わるたびに枠が増えないように）', () => {
    const a = buildBacklogEventLine({ kind: 'recovered', key: KEY, address: '192.0.2.41', packets: 1, samples: 30 })
    const b = buildBacklogEventLine({ kind: 'recovered', key: KEY, address: '192.0.2.41', packets: 9, samples: 270 })
    expect(a.detail).toBe(b.detail)
    const c = buildBacklogEventLine({ kind: 'unrecoverable', key: KEY, address: '192.0.2.41', reason: 'not-held', samples: 30 })
    const d = buildBacklogEventLine({ kind: 'unrecoverable', key: KEY, address: '192.0.2.41', reason: 'not-held', samples: 900 })
    expect(c.detail).toBe(d.detail)
  })

  it('取りに行けなかったときの鍵には流れまで入れる（同じ基板の別のセンサーを吸わない）', () => {
    const a = buildBacklogEventLine({ kind: 'failed', key: KEY, address: '192.0.2.41', reason: 'network', detail: 'x' })
    const b = buildBacklogEventLine({
      kind: 'failed', key: 'mac:020000000001|34b6e78f|i2c0-69', address: '192.0.2.41', reason: 'network', detail: 'x',
    })
    expect(a.detail).not.toBe(b.detail)
  })

  it('答えに使えないまとまりが混ざったら warn で、内訳を添える', () => {
    const out = buildBacklogEventLine({
      kind: 'suspect', key: KEY, address: '192.0.2.41', badPackets: 1, foreignPackets: 0,
    })
    expect(out.level).toBe('warn')
    expect(out.line).toContain('読めない 1・別の流れ 0）')
    const again = buildBacklogEventLine({
      kind: 'suspect', key: KEY, address: '192.0.2.41', badPackets: 5, foreignPackets: 3,
    })
    expect(again.detail).toBe(out.detail)
  })

  it('取り戻した分を生データへ書けなかったら warn で、訊き直すと添える（流れごとに間引く）', () => {
    const out = buildBacklogEventLine({ kind: 'unsaved', key: KEY, address: '192.0.2.41', packets: 2 })
    expect(out.level).toBe('warn')
    expect(out.line).toContain('2 まとまりを生データへ書けなかった。あとで訊き直す')
    const again = buildBacklogEventLine({ kind: 'unsaved', key: KEY, address: '192.0.2.41', packets: 9 })
    expect(again.detail).toBe(out.detail)
  })
})

// 2026-10-02 に足した。ソフトウェアの再起動のあと SNTP を始めないファームで、
// 3 枚の時計が 22 時間で 0.5〜1.3 秒遅れたのに、どこにも出ていなかった。
describe('buildLoopStallWarning', () => {
  it('止まっていた秒数と再開した日本時間を 1 行に入れる', () => {
    // 2026-10-02 13:41:45 JST。
    const w = buildLoopStallWarning({ endedAtMs: Date.UTC(2026, 9, 2, 4, 41, 45), stalledMs: 45_250 })
    expect(w.level).toBe('warn')
    expect(w.line).toContain('45.3 秒')
    expect(w.line).toContain('2026-10-02 13:41:45')
  })

  it('間引きの鍵は区間ごとに変えない（詰まり続けたとき行が溢れない）', () => {
    const a = buildLoopStallWarning({ endedAtMs: 1, stalledMs: 1_000 })
    const b = buildLoopStallWarning({ endedAtMs: 2, stalledMs: 9_000 })
    expect([a.kind, a.detail]).toEqual([b.kind, b.detail])
  })
})

describe('buildRecvBufferLine', () => {
  it('頼んだ大きさに届いていれば記録の行にとどめる', () => {
    const r = buildRecvBufferLine({ requestedBytes: 8_388_608, actualBytes: 8_388_608, error: null })
    expect(r.level).toBe('log')
    expect(r.line).toContain('8388608')
  })

  it('OS が言われたより大きく割り当てても（Linux は 2 倍）記録の行にとどめる', () => {
    expect(buildRecvBufferLine({ requestedBytes: 1_000, actualBytes: 2_000, error: null }).level).toBe('log')
  })

  it('頼んだ大きさに届かなければ警告にする（OS が黙って小さく抑えたとき）', () => {
    const r = buildRecvBufferLine({ requestedBytes: 8_388_608, actualBytes: 212_992, error: null })
    expect(r.level).toBe('warn')
    expect(r.line).toContain('212992')
  })

  it('広げる段で投げたら、その理由を添えて警告にする', () => {
    const r = buildRecvBufferLine({ requestedBytes: 8_388_608, actualBytes: 65_536, error: 'EINVAL' })
    expect(r.level).toBe('warn')
    expect(r.line).toContain('EINVAL')
  })

  it('実際の大きさを読めなかったら警告にする（読めないことを「足りている」と取り違えない）', () => {
    const r = buildRecvBufferLine({ requestedBytes: 8_388_608, actualBytes: null, error: null })
    expect(r.level).toBe('warn')
    expect(r.line).toContain('不明')
  })
})

describe('buildBoardClockWarnings', () => {
  const NOW = Date.UTC(2026, 9, 2, 3, 0, 0)
  const row = (boardKey: `mac:${string}`, offsetMs: number | null, lastPacketMs: number | null = NOW - 100) => ({
    boardKey,
    offsetMs,
    lastPacketMs,
  })

  it('正: 許容を超えて遅れている基板を、基板ごとに 1 件ずつ出す', () => {
    const out = buildBoardClockWarnings([row('mac:a0b7', 1301), row('mac:1c8f', 688)], NOW)
    expect(out).toHaveLength(2)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.kind).toBe('board-clock')
    // **鍵は基板ごと。** 顔ぶれ全体を鍵にすると、1 枚増えるたびに全部が出し直しになり、
    // 新しくずれた基板の最初の 1 行が既存の枠に埋もれる（`buildAssignedSilenceReport` と同じ判断）。
    expect(out.map((w) => w.detail)).toEqual(['mac:a0b7', 'mac:1c8f'])
    expect(out[0]?.line).toContain('mac:a0b7')
    expect(out[0]?.line).toContain('1301 ms')
    expect(out[0]?.line).toContain('遅れ')
  })

  it('正: 進んでいる向きにずれても出す', () => {
    const out = buildBoardClockWarnings([row('mac:aa', -400)], NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.line).toContain('400 ms')
    expect(out[0]?.line).toContain('進ん')
  })

  it('対照: 許容の内なら出さない（届くまでの時間ぶんは常に乗っている）', () => {
    expect(buildBoardClockWarnings([row('mac:aa', 40), row('mac:bb', -20)], NOW)).toEqual([])
  })

  it('対照: 許容ちょうどは出さない・1 ms 超えたら出す', () => {
    expect(buildBoardClockWarnings([row('mac:aa', CLOCK_OFFSET_WARN_MS)], NOW)).toEqual([])
    expect(buildBoardClockWarnings([row('mac:aa', CLOCK_OFFSET_WARN_MS + 1)], NOW)).toHaveLength(1)
  })

  it('安全弁: まだ測れていない基板は出さない', () => {
    expect(buildBoardClockWarnings([row('mac:aa', null, null)], NOW)).toEqual([])
  })

  it('安全弁: 黙った基板は出さない —— 黙ったことは割り当ての警告が同じ物差しで持つ', () => {
    // **境目を割り当ての警告（`STALE_AFTER_MS`）と揃える。** 別の長さにすると、その間だけ
    // 「届いていない」と「時計がずれている」が同時に並ぶ。
    expect(buildBoardClockWarnings([row('mac:aa', 1301, NOW - STALE_AFTER_MS - 1)], NOW)).toEqual([])
    expect(buildBoardClockWarnings([row('mac:aa', 1301, NOW - STALE_AFTER_MS)], NOW)).toHaveLength(1)
    expect(buildBoardClockWarnings([row('mac:aa', 1301, null)], NOW)).toEqual([])
  })
})

describe('findUngroupedMultiBoardStations', () => {
  const twoBoardConfig: StationConfig = {
    stations: [
      { stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 },
      { stationId: 'garage', displayName: '車庫', lat: 35.7, lon: 139.8 },
    ],
    boards: [
      { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'study', sensors: [] },
      { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'study', sensors: [] },
      { boardKey: 'mac:cccccccccccc', stationId: 'garage', sensors: [] },
    ],
  }

  it('正: 複数基板を割り当てたのに合成グループが組めていない観測点だけを拾う', () => {
    // garage は 1 台しか割り当てていないので stationsWithMultipleBoards にも現れない。
    expect(findUngroupedMultiBoardStations(twoBoardConfig, [])).toEqual(['study'])
  })

  it('対照: 合成グループが組めていれば拾わない', () => {
    expect(findUngroupedMultiBoardStations(twoBoardConfig, ['study'])).toEqual([])
  })
})

describe('stationSegmentLogLevel', () => {
  it('対照: 正常な区間切り替え（reason が null）は log のまま', () => {
    expect(stationSegmentLogLevel(null)).toBe('log')
  })

  it('正: 震度が出せない間（reason が非 null）は warn へ上げる', () => {
    expect(stationSegmentLogLevel('stream-error')).toBe('warn')
  })
})


describe('buildClosingLines', () => {
  const quiet = {
    evictions: 0,
    unusableIntensities: 0,
    sensorEvictions: 0,
    stationEvictions: 0,
    gravity: { mismatches: 0, unjudged: 0, restlessWindows: 0, restarts: 0, evictions: 0 },
    // 締めくくりの後に読む値なので、開いたままの本は 0 が正常。
    mseed: {
      recordsWritten: 120,
      packetsLogged: 40,
      unreadableWritten: 0,
      lostRecords: 0,
      badTimes: 0,
      writeErrors: 0,
      lastWriteError: null,
      openBooks: 0,
      slowClose: false,
      pendingSamples: 0,
      bufferedPackets: 0,
      cuts: { full: 0, 'seq-gap': 0, 'rate-change': 0, 'clock-sync': 0, 'time-drift': 0, hour: 0, hold: 0, idle: 0, flush: 0, 'value-jump': 0, recovered: 0 },
      internalErrors: 0,
      lastInternalError: null,
    },
    waveWriteErrors: 0,
    waveLostRecords: 0,
    waveBadChunks: 0,
    waveSlowClose: false,
    waveLastWriteError: null,
    detection: {
      detectorVersion: 1,
      stations: ['station-1'],
      shakes: 3,
      pending: 1,
      resets: 0,
      droppedChunks: 0,
      phaseWindowsBroken: 0,
      phaseFailures: 0,
      failures: 0,
      lastFailure: null,
      store: { written: 5, writeErrors: 0, lastWriteError: null },
      feed: null,
      triggers: [],
    },
  } as const

  it('地震検出で揺れを記録できなかったら、件数と最後の理由を出す', () => {
    // **記録できなかった揺れは `/events` にも現れない**ので、最後に読むここで気づけるようにする。
    const detection = {
      ...quiet.detection,
      failures: 2,
      lastFailure: '[detect] station-1 の揺れを記録できず: boom',
      store: { written: 5, writeErrors: 1, lastWriteError: 'EACCES' },
    }
    expect(buildClosingLines({ ...quiet, detection })).toEqual([
      { level: 'log', line: '  地震検出・揺れの記録の途中で例外を受け止めた=2' },
      { level: 'log', line: '  揺れの記録を書けず=1' },
      { level: 'error', line: '  地震検出で最後に受け止めた例外: [detect] station-1 の揺れを記録できず: boom' },
      { level: 'error', line: '  揺れの記録を書き出せなかった理由: EACCES' },
    ])
  })

  it('地震情報の受信の失敗も累計に出す（受信を止めている構成では出さない）', () => {
    const feed = {
      connected: false,
      connectedSinceMs: null,
      reconnects: 4,
      quakesReceived: 0,
      historyFetches: 3,
      historyFailures: 3,
      unreadableMessages: 0,
      openGaps: [],
    }
    expect(buildClosingLines({ ...quiet, detection: { ...quiet.detection, feed } })).toEqual([
      { level: 'log', line: '  地震情報の受信を繋ぎ直した=4' },
      { level: 'log', line: '  地震情報の履歴を取れず=3' },
    ])
    expect(buildClosingLines(quiet)).toEqual([])
  })

  it('合成波形を書き損ねたら、生データとは別の行で出す', () => {
    // **混ぜない。** 残しているものが違う（センサー単独の生値 / 観測点の合成波形）ので、
    // 1 つの行にまとめると「読み返しの口が空を返すようになった」ことが読めない。
    expect(buildClosingLines({ ...quiet, waveLostRecords: 4 })).toEqual([
      { level: 'log', line: '  合成波形を書き損ねた=4' },
    ])
  })

  it('合成波形の締めくくりを待ちきれなければ 1 行出す（件数ではない）', () => {
    // 真偽なので 0 抑制には乗らない。**失ってはいない**ので `log`。
    expect(buildClosingLines({ ...quiet, waveSlowClose: true })).toEqual([
      { level: 'log', line: '  合成波形の締めくくりを待ちきれず' },
    ])
  })

  it('合成波形の書き込みの理由は、生データの理由とは別の行で出す', () => {
    expect(buildClosingLines({ ...quiet, waveLastWriteError: 'ディスクが一杯' })).toEqual([
      { level: 'error', line: '  合成波形を書き出せなかった理由: ディスクが一杯' },
    ])
  })

  it('数として出せなかった計測震度があれば件数を出す', () => {
    // **0 のままなのが正常な数。** 行そのものを固定しておかないと、並びやラベルを
    // 書き換えたときに「上流の境界が緩んだ合図」が静かに出なくなる。
    expect(buildClosingLines({ ...quiet, unusableIntensities: 2 })).toEqual([
      { level: 'log', line: '  数として出せなかった計測震度=2' },
    ])
  })

  it('センサーの生存の枠を捨てた分は、送信元の枠とは別の行で出す', () => {
    // 混ぜると、**黙ったセンサーを見つける仕組み自身の劣化**が
    // 「速すぎる送り手を捨てた」と同じ数に紛れる。
    expect(buildClosingLines({ ...quiet, evictions: 1, sensorEvictions: 3 })).toEqual([
      { level: 'log', line: '  送信元の枠を捨てた=1' },
      { level: 'log', line: '  センサーの生存の枠を捨てた=3' },
    ])
  })

  it('観測点ぶんの合成の生存の枠を捨てた分も、センサーの枠とは別の行で出す', () => {
    expect(buildClosingLines({ ...quiet, sensorEvictions: 1, stationEvictions: 2 })).toEqual([
      { level: 'log', line: '  センサーの生存の枠を捨てた=1' },
      { level: 'log', line: '  観測点ぶんの合成の生存の枠を捨てた=2' },
    ])
  })

  it('診断できなかった窓は、異常とは別の行で出す', () => {
    // **混ぜると地震のたびに「換算が狂っている」数が跳ねる。** 揺れている間は判定を
    // 見送る作りなので、見送った件数は正常な運用でも増える。
    expect(
      buildClosingLines({
        ...quiet,
        gravity: { ...quiet.gravity, mismatches: 2, restlessWindows: 1, unjudged: 9 },
      }),
    ).toEqual([
      { level: 'log', line: '  換算の倍率が合わない窓=2' },
      { level: 'log', line: '  静止しているのに震度が高い窓=1' },
      { level: 'log', line: '  静止しておらず倍率を診られなかった窓=9' },
    ])
  })

  it('自己診断の数え上げは、見出しの表の並びで全部出る', () => {
    // **欄を手で並べない形にした。** 表（`GRAVITY_LABELS`）が見出しも並びも持つので、
    // ここが崩れたら表の側が壊れている。**数を足して表へ書かなければ型検査が止める。**
    expect(
      buildClosingLines({
        ...quiet,
        gravity: { mismatches: 1, unjudged: 2, restlessWindows: 3, restarts: 4, evictions: 5 },
      }),
    ).toEqual([
      { level: 'log', line: '  換算の倍率が合わない窓=1' },
      { level: 'log', line: '  静止しているのに震度が高い窓=3' },
      { level: 'log', line: '  静止しておらず倍率を診られなかった窓=2' },
      { level: 'log', line: '  基板の起動が変わり、診断の窓を捨てた=4' },
      { level: 'log', line: '  自己診断の枠を捨てた=5' },
    ])
  })

  it('診断の窓を再起動で捨てた分は、判定できなかった窓とは別の行で出す', () => {
    // **窓を閉じていないので `unjudgedWindows` には入らない。** 混ぜると、
    // 「揺れていて見送った」と「そもそも診断が働いていない」が同じ数に紛れる。
    expect(buildClosingLines({ ...quiet, gravity: { ...quiet.gravity, restarts: 4 } })).toEqual([
      { level: 'log', line: '  基板の起動が変わり、診断の窓を捨てた=4' },
    ])
  })

  it('何も起きていない締めくくりでは 1 行も足さない', () => {
    // 起きなかったことを毎回並べると、起きたことが埋もれる。
    expect(buildClosingLines(quiet)).toEqual([])
  })

  it('閉じ切れなかった本が残っていれば数を出す', () => {
    // **締めくくりには待ち時間の上限があるので、ここへ来ても 0 とは限らない。**
    // 出ない行だと決めつけると、上限で切り上げた事実が画面のどこにも残らない。
    const out = buildClosingLines({ ...quiet, mseed: { ...quiet.mseed, openBooks: 2 } })

    expect(out).toEqual([{ level: 'log', line: '  閉じ切れなかった生データの本=2' }])
  })

  it('上限で打ち切ったことを、閉じ切れなかった本の数とは別に出す', () => {
    // 打ち切った直後に閉じ終われば `openBooks` は 0 へ戻る。件数だけを見ていると、
    // **打ち切った事実が痕跡も無く消える。**
    const out = buildClosingLines({ ...quiet, mseed: { ...quiet.mseed, slowClose: true } })

    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('error')
    expect(out[0]?.line).toContain('打ち切りました')
  })

  it('生データの数え上げは、記録の健全性の欄ごとに別の行で出す', () => {
    // 失った本数・振り分けられなかった件数・中身ごと残したパケットは意味が違う。
    // **混ぜると「読めないパケットが来た」が「書き損ねた」と同じ重さに読める。**
    const out = buildClosingLines({
      ...quiet,
      mseed: {
        ...quiet.mseed,
        writeErrors: 1,
        lostRecords: 2,
        badTimes: 3,
        unreadableWritten: 4,
        internalErrors: 5,
      },
    })

    expect(out).toEqual([
      { level: 'log', line: '  生データを残せず流し口が壊れた=1' },
      { level: 'log', line: '  生データのレコードを書き損ねた=2' },
      { level: 'log', line: '  生データの振り分け先を時刻から決められず=3' },
      { level: 'log', line: '  読めなかったパケットを中身ごと残した=4' },
      { level: 'log', line: '  生データの組み立てで想定外の例外を受け止めた=5' },
    ])
  })

  it('最後に起きた失敗の理由を、書き出しと組み立てで別々に出す', () => {
    // 毎分の要約は締めくくりでは止まっているので、最後の窓で起きた失敗は
    // ここでしか理由が出ない。
    const out = buildClosingLines({
      ...quiet,
      mseed: {
        ...quiet.mseed,
        lostRecords: 1,
        lastWriteError: 'EACCES',
        internalErrors: 1,
        lastInternalError: 'TypeError',
      },
    })

    expect(out.map((c) => c.level)).toEqual(['log', 'log', 'error', 'error'])
    expect(out[2]?.line).toContain('EACCES')
    expect(out[3]?.line).toContain('TypeError')
  })

  it('理由は件数を問わず出す', () => {
    // **毎分の要約とは判断が違う。** あちらは同じ理由を毎分繰り返さないために
    // 件数で絞るが、締めくくりは一度きりなので、判っている理由は残らず出す。
    const out = buildClosingLines({ ...quiet, mseed: { ...quiet.mseed, lastWriteError: 'EACCES' } })

    expect(out).toHaveLength(1)
    expect(out[0]?.line).toContain('EACCES')
  })

  it('長すぎる理由は切り詰める', () => {
    const out = buildClosingLines({ ...quiet, mseed: { ...quiet.mseed, lastWriteError: 'あ'.repeat(500) } })

    expect(out[0]?.line.length).toBeLessThan(300)
    expect(out[0]?.line).toContain('…')
  })
})

describe('buildGravityWarnings', () => {
  const base: GravityVerdict = {
    boardKey: 'mac:aa',
    sensorId: 'i2c0-68',
    streamKey: 'mac:aa|i2c0-68|boot1',
    atMs: 1_700_000_000_000,
    sampleCount: 2_984,
    meanGal: 980.7,
    sdGal: 1.5,
    // **ほぼ水平に据えた基板。** 重力は上下軸にだけ乗る。
    axisMeanGal: [0.4, -1.2, 980.7],
    axisSdGal: [1.1, 1.2, 0.9],
    maxIntensity: 1.1,
    scale: 'ok',
    restless: false,
  }

  it('正常な窓では 1 行も出さない', () => {
    expect(buildGravityWarnings(base)).toEqual([])
  })

  it('判定できなかった窓でも出さない', () => {
    // **地震のたびに記録が流れることになる。** 見送ったこと自体は異常ではないので、
    // 件数は要約に任せる。
    expect(buildGravityWarnings({ ...base, scale: 'not-at-rest', sdGal: 42 })).toEqual([])
    expect(buildGravityWarnings({ ...base, scale: 'too-few-samples', sampleCount: 12 })).toEqual([])
  })

  it('倍率が小さすぎるときは、名乗る分解能の桁を疑えと言う', () => {
    const out = buildGravityWarnings({ ...base, scale: 'too-small', meanGal: 0.98 })

    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('gravity-scale')
    expect(out[0].line).toContain('換算が小さすぎる')
    expect(out[0].line).toContain('0.98')
    expect(out[0].line).toContain('名乗る分解能の桁')
  })

  it('倍率が大きすぎるときは、フルスケールの申告も疑えと言う', () => {
    // **ここへ来た時点でフルスケールの検査は通っている**（`galFromCounts` の上限）。
    // つまり分解能とフルスケールがそろって大きく名乗られている。
    const out = buildGravityWarnings({ ...base, scale: 'too-large', meanGal: 3922.7 })

    expect(out[0].line).toContain('換算が大きすぎる')
    expect(out[0].line).toContain('フルスケール')
  })

  it('読めない値が混ざったことも伝える', () => {
    const out = buildGravityWarnings({
      ...base,
      scale: 'unreadable',
      meanGal: null,
      sdGal: null,
    })

    expect(out).toHaveLength(1)
    // **区分は 3 つに分ける。** 枠は区分ごとに 64 個で、1 つに相乗りさせると
    // センサーが増えたとき、あとから現れた異常が 1 行も出ないまま抑えられる。
    expect(out[0].kind).toBe('gravity-unreadable')
    expect(out[0].line).toContain('数値として読めない値')
  })

  it('静止しているのに震度が高いときは、震度を出す側の直流の扱いを疑えと言う', () => {
    const out = buildGravityWarnings({ ...base, restless: true, maxIntensity: 5.1 })

    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('gravity-restless')
    expect(out[0].line).toContain('静止している')
    expect(out[0].line).toContain('5.1')
    expect(out[0].line).toContain('直流の扱い')
  })

  it('倍率と直流の扱いの疑いが同じ窓で立ったら、2 行を別の鍵で出す', () => {
    // **1 行へ混ぜない。** 疑う先が違う（ヘッダの名乗りと、震度を出す側の配線）ので、
    // まとめるとどちらを見に行けばよいか読み取れない。鍵を分けるのは、間引きが
    // 片方を飲み込まないようにするため。
    const out = buildGravityWarnings({
      ...base,
      scale: 'too-small',
      meanGal: 0.98,
      restless: true,
      maxIntensity: 5.1,
    })

    expect(out).toHaveLength(2)
    // **区分も鍵も分ける。** 区分ごとに 64 個の枠しかないので、1 つに相乗りさせると
    // センサーが増えたとき、あとから現れた異常が 1 行も出ないまま抑えられる。
    expect(new Set(out.map((w) => w.kind)).size).toBe(2)
    expect(new Set(out.map((w) => w.detail)).size).toBe(2)
  })
})

describe('deliverReading', () => {
  const READING: IntensityReading = {
    streamKey: 'mac:aa|i2c0-68|boot1',
    segmentId: 1,
    boardKey: 'mac:aa',
    sensorId: 'i2c0-68',
    atMs: 1_700_000_000_000,
    intensity: 2.5,
    timebaseNominalReason: null,
    timebaseResidualRmsMs: 3.1,
  }

  it('数える → 覚える → 押し出す → 出す → 診る の順で配る', () => {
    // **自己診断がいちばん最後。** 本筋（押し出しと標準出力）より手前に置くと、
    // そこで投げたときにこの読みが画面にも購読者にも出ない。
    // **この並びは `main()` の中に書くと誰も見ていないことになる** —— あそこは
    // 「直接実行のときだけ走らせる」門の内側でテストが届かず、実際に 2 巡続けて
    // 同じ形の指摘を受けた。
    const order: string[] = []
    const mark = (name: string) => () => {
      order.push(name)
    }

    deliverReading(
      {
        count: mark('count'),
        remember: mark('remember'),
        publish: mark('publish'),
        print: mark('print'),
        diagnose: mark('diagnose'),
      },
      READING,
    )

    expect(order).toEqual(['count', 'remember', 'publish', 'print', 'diagnose'])
  })

  it('配る先へは同じ読みをそのまま渡す', () => {
    const got: IntensityReading[] = []
    const take = (r: IntensityReading) => {
      got.push(r)
    }

    deliverReading(
      { count: take, remember: take, publish: take, print: take, diagnose: take },
      READING,
    )

    expect(got).toEqual([READING, READING, READING, READING, READING])
  })
})

describe('deliverStationFusion', () => {
  const STATION_READING: StationIntensityReading = {
    stationId: 'garage',
    atMs: 1_000,
    intensity: 1.5,
  }

  const FUSED_WAVE: FusedWaveChunk = {
    stationId: 'garage',
    driver: { boardKey: 'mac:aa', sensorId: 'i2c0-68' },
    firstSampleIndex: 0,
    firstSampleMs: 1_000,
    msPerSample: 10,
    gal: [[1], [2], [3]],
    // 落とした直流（`gal` と足せば校正済み gal の重み付き平均になる値）。
    dcGal: [[0], [0], [980]],
    memberCount: [2],
  }

  function fusion(overrides: Partial<FusionOutcome> = {}): FusionOutcome {
    return {
      fusedWave: null,
      pairDiffs: [],
      readings: [],
      intensitySkipReason: null,
      closeFailure: null,
      intensityStateChanged: false,
      // 既定は「揃っていた」。**揃わなかった回だけを数える**側なので、こちらを
      // 既定にしておけば、数えるテストだけが明示的に偽を渡す（#374）。
      backupsCovered: true,
      ...overrides,
    }
  }

  it('読みを先に配り、いまの合成状態（noteSkip）は最後に確定させる', () => {
    // **区間の作り直しで、古い区間の残り読みと新しい異常が同じ呼び出しに同居する回。**
    // `noteReading` を先に呼んでも、最後の `noteSkip` が「いまの状態」として残るなら
    // 消されない（`stationHealth.ts` の `noteSkip` は「いまの状態」を最後に上書きする側）。
    const order: string[] = []
    deliverStationFusion(
      {
        noteReading: () => order.push('noteReading'),
        publish: () => order.push('publish'),
        noteWave: () => order.push('noteWave'),
        notePairDiffs: () => order.push('notePairDiffs'),
        publishPairDiffs: () => order.push('publishPairDiffs'),
        publishWave: () => order.push('publishWave'),
        reportCloseFailure: () => order.push('reportCloseFailure'),
        noteSkip: () => order.push('noteSkip'),
        logSegment: () => order.push('logSegment'),
      },
      fusion({
        fusedWave: FUSED_WAVE,
        readings: [STATION_READING],
        intensitySkipReason: 'stream-rejected',
        intensityStateChanged: true,
      }),
    )

    expect(order).toEqual([
      'noteReading',
      'publish',
      'noteWave',
      'notePairDiffs',
      'publishPairDiffs',
      'publishWave',
      'noteSkip',
      'logSegment',
    ])
  })

  it('駆動役以外の到着（fusedWave が null）では publishWave・noteSkip・reportCloseFailure・logSegment を呼ばない', () => {
    // `closeFailure`・`intensitySkipReason` は `fusedWave` が非 null の回にしか
    // 意味を持たない契約（`sensorFusion.ts` の `FusionOutcome`）。契約に反する
    // 入力（fusedWave が null なのに両方が非 null）を渡しても無視されることを確かめる。
    const calls: string[] = []
    deliverStationFusion(
      {
        noteReading: () => calls.push('noteReading'),
        publish: () => calls.push('publish'),
        noteWave: () => calls.push('noteWave'),
        notePairDiffs: () => calls.push('notePairDiffs'),
        publishPairDiffs: () => calls.push('publishPairDiffs'),
        publishWave: () => calls.push('publishWave'),
        reportCloseFailure: () => calls.push('reportCloseFailure'),
        noteSkip: () => calls.push('noteSkip'),
        logSegment: () => calls.push('logSegment'),
      },
      fusion({
        fusedWave: null,
        closeFailure: { stationId: 'garage', detail: 'x' },
        intensitySkipReason: 'stream-rejected',
        intensityStateChanged: true,
      }),
    )

    expect(calls).toEqual([])
  })

  it('締めくくり失敗（closeFailure）は読み・skip理由より前に配る', () => {
    const order: string[] = []
    deliverStationFusion(
      {
        noteReading: () => order.push('noteReading'),
        publish: () => order.push('publish'),
        noteWave: () => order.push('noteWave'),
        notePairDiffs: () => order.push('notePairDiffs'),
        publishPairDiffs: () => order.push('publishPairDiffs'),
        publishWave: () => order.push('publishWave'),
        reportCloseFailure: () => order.push('reportCloseFailure'),
        noteSkip: () => order.push('noteSkip'),
        logSegment: () => order.push('logSegment'),
      },
      fusion({
        fusedWave: FUSED_WAVE,
        closeFailure: { stationId: 'garage', detail: 'end が投げた' },
      }),
    )

    // readings が空でも、`fusedWave` が非 null の回は必ず `noteSkip` でいまの
    // 状態（この場合は intensitySkipReason: null ＝ 正常）を確定させる。
    // `intensityStateChanged` を渡していない（既定 false）ので `logSegment` は呼ばない。
    expect(order).toEqual(['reportCloseFailure', 'noteWave', 'notePairDiffs', 'publishPairDiffs', 'publishWave', 'noteSkip'])
  })

  it('正: 顔ぶれが揃ったかを帳面へそのまま渡す（#374）', () => {
    // **型では守れない配線。** `noteWave` の第 2 引数は真偽値なので、`true` を
    // 決め打ちで渡しても型検査は通る —— そうなると「揃わないまま切り上げた」
    // 回が永久に 0 のままになり、#374 と同じ穴（気づく手段が無い）が開く。
    const covered: boolean[] = []
    const sinks = {
      noteReading: () => {},
      publish: () => {},
      noteWave: (_w: FusedWaveChunk, c: boolean) => covered.push(c),
      notePairDiffs: () => {},
      publishPairDiffs: () => {},
      publishWave: () => {},
      reportCloseFailure: () => {},
      noteSkip: () => {},
      logSegment: () => {},
    }
    deliverStationFusion(sinks, fusion({ fusedWave: FUSED_WAVE, backupsCovered: false }))
    deliverStationFusion(sinks, fusion({ fusedWave: FUSED_WAVE, backupsCovered: true }))

    expect(covered).toEqual([false, true])
  })

  it('状態が変わっていない回（intensityStateChanged が false）では logSegment を呼ばない', () => {
    // **安全弁。** 正常な区間が続く間、`intensitySkipReason` は毎回 null を返し続けるが、
    // 変化していないので `logSegment` を毎パケット出し続けてはいけない
    // （単一センサーの `startedBecause` と同じ絞り込み）。
    const calls: string[] = []
    deliverStationFusion(
      {
        noteReading: () => calls.push('noteReading'),
        publish: () => calls.push('publish'),
        noteWave: () => calls.push('noteWave'),
        notePairDiffs: () => calls.push('notePairDiffs'),
        publishPairDiffs: () => calls.push('publishPairDiffs'),
        publishWave: () => calls.push('publishWave'),
        reportCloseFailure: () => calls.push('reportCloseFailure'),
        noteSkip: () => calls.push('noteSkip'),
        logSegment: () => calls.push('logSegment'),
      },
      fusion({ fusedWave: FUSED_WAVE, readings: [STATION_READING] }),
    )

    expect(calls).toEqual(['noteReading', 'publish', 'noteWave', 'notePairDiffs', 'publishPairDiffs', 'publishWave', 'noteSkip'])
  })

  it('異常が続く間（intensityStateChanged が false でも）は毎回 logSegment を呼ぶ', () => {
    // **push() の失敗は区間の作り直しを伴わず、`SensorFusion` に自己回復の仕組みが
    // 無いので、`intensityStateChanged` が二度と立たないまま同じ理由が続きうる**
    // （`sensorFusion.ts` の `ingest()` を見ること）。`intensityStateChanged` だけで
    // 絞ると、最初の 1 回しかログが出ず「合成が壊れたままだ」という事実が沈黙する。
    // 間引き（`logThrottle.shouldLog`）に再掲の判断を委ねるため、ここでは
    // 理由が非 null の間は毎回呼ぶ。
    const calls: string[] = []
    deliverStationFusion(
      {
        noteReading: () => calls.push('noteReading'),
        publish: () => calls.push('publish'),
        noteWave: () => calls.push('noteWave'),
        notePairDiffs: () => calls.push('notePairDiffs'),
        publishPairDiffs: () => calls.push('publishPairDiffs'),
        publishWave: () => calls.push('publishWave'),
        reportCloseFailure: () => calls.push('reportCloseFailure'),
        noteSkip: () => calls.push('noteSkip'),
        logSegment: () => calls.push('logSegment'),
      },
      fusion({
        fusedWave: FUSED_WAVE,
        intensitySkipReason: 'stream-rejected',
        intensityStateChanged: false,
      }),
    )

    expect(calls).toEqual(['noteWave', 'notePairDiffs', 'publishPairDiffs', 'publishWave', 'noteSkip', 'logSegment'])
  })

  it('正: 合成した波形をそのまま配る（#315）', () => {
    const got: FusedWaveChunk[] = []
    deliverStationFusion(
      {
        noteReading: () => {},
        publish: () => {},
        noteWave: () => {},
        notePairDiffs: () => {},
        publishPairDiffs: () => {},
        publishWave: (w) => got.push(w),
        reportCloseFailure: () => {},
        noteSkip: () => {},
        logSegment: () => {},
      },
      fusion({ fusedWave: FUSED_WAVE, readings: [STATION_READING] }),
    )

    // **写しを作らない。** 間引き・単位の変換はいずれも受け手（管理コンソール・PWA）の
    // 仕事で、ここで加工すると `dcGal` を足し戻して元の値へ戻せなくなる。
    expect(got).toEqual([FUSED_WAVE])
    expect(got[0]).toBe(FUSED_WAVE)
  })

  it('安全弁: 震度が 1 件も出ていない回でも、合成した波形は配る', () => {
    // **窓が埋まるまで震度は出ない**（`IntensityStream` は 20 秒窓）。波形を
    // 震度と同じ条件で絞ると、**起動してから最初の 20 秒は波形が 1 件も出ない**
    // ——画面からは「繋がっているのに何も来ない」としか見えない。
    const got: string[] = []
    deliverStationFusion(
      {
        noteReading: () => got.push('noteReading'),
        publish: () => got.push('publish'),
        noteWave: () => got.push('noteWave'),
        notePairDiffs: () => got.push('notePairDiffs'),
        publishPairDiffs: () => got.push('publishPairDiffs'),
        publishWave: () => got.push('publishWave'),
        reportCloseFailure: () => got.push('reportCloseFailure'),
        noteSkip: () => got.push('noteSkip'),
        logSegment: () => got.push('logSegment'),
      },
      fusion({ fusedWave: FUSED_WAVE, readings: [] }),
    )

    expect(got).toContain('publishWave')
  })
})

/**
 * 合成の締めくくりで流し切った 1 回（`SensorFusionClosing.drained` の 1 件）。
 * 中身は配り先へそのまま渡ることだけを見る。
 */
const DRAINED: FusionOutcome = {
  fusedWave: {
    stationId: 'study',
    driver: { boardKey: 'mac:aa', sensorId: 'i2c0-68' },
    firstSampleIndex: 0,
    firstSampleMs: 1_000,
    msPerSample: 10,
    gal: [[1], [2], [3]],
    dcGal: [[0], [0], [980]],
    memberCount: [1],
  },
  pairDiffs: [],
  readings: [],
  intensitySkipReason: null,
  closeFailure: null,
  intensityStateChanged: false,
  backupsCovered: false,
}

describe('applyStationConfigCore', () => {
  const NEW_CONFIG: StationConfig = {
    stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
    boards: [],
  }

  const STATION_READING: StationIntensityReading = { stationId: 'study', atMs: 1_000, intensity: 1.5 }
  const CLOSE_FAILURE: StationCloseFailure = { stationId: 'study', detail: 'x' }

  /** 呼び出し順を記録しつつ、既定では何もしない `ApplyStationConfigDeps`。 */
  function deps(
    calls: string[],
    overrides: Partial<ApplyStationConfigDeps> = {},
  ): ApplyStationConfigDeps {
    return {
      save: () => calls.push('save'),
      setCurrentConfig: () => calls.push('setCurrentConfig'),
      trackAssignments: () => calls.push('trackAssignments'),
      rebuildStations: () => calls.push('rebuildStations'),
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        return { drained: [], failures: [], readings: [] }
      },
      deliverFusion: () => calls.push('deliverFusion'),
      reportCloseFailures: () => calls.push('reportCloseFailures'),
      emitReading: () => calls.push('emitReading'),
      reportDeliveryFailure: () => calls.push('reportDeliveryFailure'),
      onCloseFailure: () => calls.push('onCloseFailure'),
      rebuildSensorFusion: () => {
        calls.push('rebuildSensorFusion')
        return []
      },
      forgetRemovedDetectors: () => calls.push('forgetRemovedDetectors'),
      setUngroupedMultiBoardStations: () => calls.push('setUngroupedMultiBoardStations'),
      setWarning: () => calls.push('setWarning'),
      ...overrides,
    }
  }

  it('正: 想定どおりの順序で呼ぶ（保存 → 反映 → 合成の作り直し → 警告のクリア）', () => {
    const calls: string[] = []
    applyStationConfigCore(deps(calls), NEW_CONFIG)

    // **`reportCloseFailures` は failures が空でも無条件に呼ぶ**（実装のとおり）——
    // 呼び出し先（`reportStationCloseFailures`）は空配列なら for ループが
    // 0 回回るだけで無害。ここを「failures があるときだけ」に書き換えるのは
    // テスト側の勝手な仮定で、2 巡目の敵対的レビューでこの食い違いが発覚した。
    expect(calls).toEqual([
      'save',
      'setCurrentConfig',
      'trackAssignments',
      'rebuildStations',
      'closeSensorFusion',
      'reportCloseFailures',
      'rebuildSensorFusion',
      'forgetRemovedDetectors',
      'setUngroupedMultiBoardStations',
      'setWarning',
    ])
  })

  it('正: 外した観測点の検出器は、合成の最後の波形を配った後で捨てる', () => {
    // 先に捨てると、締めくくりで配る最後の波形が検出器を作り直し、外した観測点のものが居座る。
    const calls: string[] = []
    applyStationConfigCore(
      deps(calls, {
        closeSensorFusion: () => {
          calls.push('closeSensorFusion')
          return { drained: [DRAINED], failures: [], readings: [] }
        },
      }),
      NEW_CONFIG,
    )
    expect(calls.indexOf('deliverFusion')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('deliverFusion')).toBeLessThan(calls.indexOf('forgetRemovedDetectors'))
  })

  it('正: 割り当てた時刻の帳面へ、差し替えた設定そのものを渡す（稼働中に足した基板に猶予を付ける）', () => {
    // 呼び忘れると、足した基板が足した瞬間に「届いていない」と警告される
    // （`main()` の中のクロージャはテストが届かないので、ここで固定する）。
    const seen: StationConfig[] = []
    applyStationConfigCore(deps([], { trackAssignments: (c) => seen.push(c) }), NEW_CONFIG)
    expect(seen).toEqual([NEW_CONFIG])
  })

  it('正: 保存へは差し替える設定そのものを渡す（設定ファイルが履歴でもあるので、そのまま記録になる）', () => {
    const seen: StationConfig[] = []
    applyStationConfigCore(deps([], { save: (c) => seen.push(c) }), NEW_CONFIG)
    expect(seen).toEqual([NEW_CONFIG])
  })

  it('対照: save が投げたら、以降のどの deps も呼ばない（例外はそのまま伝播する）', () => {
    const calls: string[] = []
    const d = deps(calls, {
      save: () => {
        throw new Error('disk full')
      },
    })

    expect(() => applyStationConfigCore(d, NEW_CONFIG)).toThrow('disk full')
    expect(calls).toEqual([])
  })

  it('正: closeSensorFusion が投げても、後続（rebuildSensorFusion 以降）は実行される', () => {
    const calls: string[] = []
    const d = deps(calls, {
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        throw new Error('end が投げた')
      },
    })
    applyStationConfigCore(d, NEW_CONFIG)

    expect(calls).toEqual([
      'save',
      'setCurrentConfig',
      'trackAssignments',
      'rebuildStations',
      'closeSensorFusion',
      'onCloseFailure',
      'rebuildSensorFusion',
      'forgetRemovedDetectors',
      'setUngroupedMultiBoardStations',
      'setWarning',
    ])
  })

  it('正: 古い合成の流し切った回を先に配り、残り読みは reportCloseFailures の後・emitReading で 1 件ずつ配る（#402）', () => {
    // **流し切った回を配らないと、設定を保存するたびに観測点ごとの末尾の合成波形が
    // 押し出しにも `data/wave/` にも出ずに消える**（震度は出続けるので気づけない）。
    const calls: string[] = []
    const delivered: FusionOutcome[] = []
    const d = deps(calls, {
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        return {
          drained: [DRAINED, DRAINED],
          failures: [CLOSE_FAILURE],
          readings: [STATION_READING, STATION_READING],
        }
      },
      deliverFusion: (o) => {
        calls.push('deliverFusion')
        delivered.push(o)
      },
    })
    applyStationConfigCore(d, NEW_CONFIG)

    expect(delivered).toEqual([DRAINED, DRAINED])
    expect(calls).toEqual([
      'save',
      'setCurrentConfig',
      'trackAssignments',
      'rebuildStations',
      'closeSensorFusion',
      'deliverFusion',
      'deliverFusion',
      'reportCloseFailures',
      'emitReading',
      'emitReading',
      'rebuildSensorFusion',
      'forgetRemovedDetectors',
      'setUngroupedMultiBoardStations',
      'setWarning',
    ])
  })

  it('安全弁: 配り先が投げても新しい合成は作られ、失敗は締めくくりの失敗とは別の口へ出る', () => {
    // **ここで止まると、締めた古い `SensorFusion` が残って以後の受信がすべて投げる。**
    // また 2 つの失敗を同じ口へ混ぜると、記録から見分けられない。
    const calls: string[] = []
    const d = deps(calls, {
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        return { drained: [DRAINED], failures: [], readings: [] }
      },
      deliverFusion: () => {
        throw new Error('配れなかった')
      },
    })
    applyStationConfigCore(d, NEW_CONFIG)

    expect(calls).toContain('reportDeliveryFailure')
    expect(calls).not.toContain('onCloseFailure')
    expect(calls.slice(-4)).toEqual(['rebuildSensorFusion', 'forgetRemovedDetectors', 'setUngroupedMultiBoardStations', 'setWarning'])
  })

  it('安全弁: 報せる口そのものが投げても新しい合成は作られ、その失敗は onCloseFailure へ出る', () => {
    // `closeHostCore` の「報せる口そのものが投げても」と対になる形。外側の囲いを外すと
    // ここで例外が抜けて `rebuildSensorFusion` に届かず、締めた古いインスタンスが残る。
    const calls: string[] = []
    const d = deps(calls, {
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        return { drained: [DRAINED], failures: [], readings: [] }
      },
      deliverFusion: () => {
        throw new Error('配れなかった')
      },
      reportDeliveryFailure: () => {
        throw new Error('報せられなかった')
      },
    })
    applyStationConfigCore(d, NEW_CONFIG)

    expect(calls).toContain('onCloseFailure')
    expect(calls.slice(-4)).toEqual(['rebuildSensorFusion', 'forgetRemovedDetectors', 'setUngroupedMultiBoardStations', 'setWarning'])
  })

  it('正: setUngroupedMultiBoardStations には findUngroupedMultiBoardStations の結果を渡す', () => {
    // 2 台の基板を割り当てているが、`rebuildSensorFusion` は合成グループが
    // 組めなかった（`groupedStationIds` が空）ことにする——`stationsWithMultipleBoards`
    // との乖離が起きる形。
    const config: StationConfig = {
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [
        { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'study', sensors: [] },
        { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'study', sensors: [] },
      ],
    }
    let received: readonly string[] | null = null
    const calls: string[] = []
    const d = deps(calls, {
      rebuildSensorFusion: () => [],
      setUngroupedMultiBoardStations: (ids) => {
        received = ids
      },
    })
    applyStationConfigCore(d, config)

    expect(received).toEqual(['study'])
  })

  it('対照: 空の設定では setWarning(null) 以外に副作用が波及しない', () => {
    const calls: string[] = []
    let warning: string | null = 'stale'
    const d = deps(calls, { setWarning: (w) => (warning = w) })
    applyStationConfigCore(d, EMPTY_STATION_CONFIG)

    expect(warning).toBeNull()
  })
})

describe('closeHostCore', () => {
  const PIPELINE_READING: IntensityReading = {
    streamKey: 'mac:aa|i2c0-68|boot1',
    segmentId: 1,
    boardKey: 'mac:aa',
    sensorId: 'i2c0-68',
    atMs: 1_000,
    intensity: 0.5,
    timebaseNominalReason: null,
    timebaseResidualRmsMs: null,
  }
  const STATION_READING: StationIntensityReading = { stationId: 'study', atMs: 2_000, intensity: 1.5 }

  /** 呼び出し順を記録しつつ、既定では何もしない `CloseHostDeps`。 */
  function deps(calls: string[], overrides: Partial<CloseHostDeps> = {}): CloseHostDeps {
    return {
      closeReceiver: async () => {
        calls.push('closeReceiver')
      },
      closeRecorder: async () => {
        calls.push('closeRecorder')
      },
      closePipeline: () => {
        calls.push('closePipeline')
        return { readings: [PIPELINE_READING], failures: [] }
      },
      reportPipelineCloseFailures: () => calls.push('reportPipelineCloseFailures'),
      emitPipelineReading: () => calls.push('emitPipelineReading'),
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        return { drained: [DRAINED], readings: [STATION_READING], failures: [] }
      },
      stationClosing: {
        deliverFusion: () => calls.push('deliverFusion'),
        reportCloseFailures: () => calls.push('reportStationCloseFailures'),
        emitReading: () => calls.push('emitStationReading'),
        reportDeliveryFailure: () => calls.push('reportDeliveryFailure'),
      },
      flushDetection: () => calls.push('flushDetection'),
      closeWaveArchive: async () => {
        calls.push('closeWaveArchive')
      },
      closeStatusServer: async () => {
        calls.push('closeStatusServer')
      },
      printTotals: () => calls.push('printTotals'),
      logError: () => calls.push('logError'),
      ...overrides,
    }
  }

  it('正: 受信口 → 生データ → 単独の震度 → 合成 → 合成波形の保存 → 状態の口 → 累計 の順で締める', async () => {
    const calls: string[] = []
    await closeHostCore(deps(calls))
    expect(calls).toEqual([
      'closeReceiver',
      'closeRecorder',
      'closePipeline',
      'reportPipelineCloseFailures',
      'emitPipelineReading',
      'closeSensorFusion',
      'deliverFusion',
      'reportStationCloseFailures',
      'emitStationReading',
      'flushDetection',
      'closeWaveArchive',
      'closeStatusServer',
      'printTotals',
    ])
  })

  it('安全弁: 開いている揺れを閉じられなくても、後ろの段へ進む', async () => {
    const calls: string[] = []
    await closeHostCore(
      deps(calls, {
        flushDetection: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(calls.slice(-4)).toEqual(['logError', 'closeWaveArchive', 'closeStatusServer', 'printTotals'])
  })

  it('正: 流し切った合成波形は、合成波形の保存を閉じる前に配る（#402）', async () => {
    // **逆だと、配った波形は保存側で `closed` として断られ、黙って消える。**
    // 上の順序のテストと同じことを見ているが、崩したときに理由が読めるよう分けて置く。
    const calls: string[] = []
    const delivered: FusionOutcome[] = []
    await closeHostCore(
      deps(calls, {
        stationClosing: {
          deliverFusion: (o) => {
            calls.push('deliverFusion')
            delivered.push(o)
          },
          reportCloseFailures: () => {},
          emitReading: () => {},
          reportDeliveryFailure: () => {},
        },
      }),
    )
    expect(delivered).toEqual([DRAINED])
    expect(calls.indexOf('deliverFusion')).toBeLessThan(calls.indexOf('closeWaveArchive'))
  })

  it('対照: 流し切ったものが無ければ、合成の配り口は呼ばない', async () => {
    const calls: string[] = []
    await closeHostCore(
      deps(calls, {
        closeSensorFusion: () => {
          calls.push('closeSensorFusion')
          return { drained: [], readings: [], failures: [] }
        },
      }),
    )
    expect(calls).not.toContain('deliverFusion')
    expect(calls).not.toContain('emitStationReading')
    // 失敗の報告は空でも呼ぶ（`deliverFusionClosing` の実装のとおり。空なら何も出ない）。
    expect(calls).toContain('reportStationCloseFailures')
  })

  const STEPS = [
    'closeReceiver',
    'closeRecorder',
    'closePipeline',
    'closeSensorFusion',
    'closeWaveArchive',
    'closeStatusServer',
  ] as const

  it.each(STEPS)('安全弁: %s が投げても、後ろの段と累計は走る', async (step) => {
    const calls: string[] = []
    const logged: string[] = []
    const fail = (): never => {
      calls.push(step)
      throw new Error(`${step} が投げた`)
    }
    const d = deps(calls, {
      [step]: step === 'closePipeline' || step === 'closeSensorFusion' ? fail : async () => fail(),
      logError: (line: string) => logged.push(line),
    })
    await closeHostCore(d)

    // 投げた段より後ろの段が全部呼ばれている。
    const after = STEPS.slice(STEPS.indexOf(step) + 1)
    for (const s of after) expect(calls).toContain(s)
    expect(calls[calls.length - 1]).toBe('printTotals')
    // 理由は 1 行だけ残る（黙って飲み込まない）。
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(`${step} が投げた`)
  })

  it('安全弁: 合成の配り口が投げても、合成波形の保存・状態の口・累計は走り、失敗は配り先の口へ出る', async () => {
    // 配り口は外から注入された関数（`stationHealth`・`hub`・`waveArchive`）なので、
    // `closeAll()` 自体が投げない契約でもここは投げうる。**締めくくりそのものの失敗
    // （`logError`）とは別の口へ出る** —— 混ぜると記録から見分けられない。
    const calls: string[] = []
    const logged: string[] = []
    const reported: string[][] = []
    await closeHostCore(
      deps(calls, {
        stationClosing: {
          deliverFusion: () => {
            throw new Error('配れなかった')
          },
          reportCloseFailures: () => {},
          emitReading: () => {},
          reportDeliveryFailure: (labels) => reported.push([...labels]),
        },
        logError: (line: string) => logged.push(line),
      }),
    )
    expect(calls.slice(-3)).toEqual(['closeWaveArchive', 'closeStatusServer', 'printTotals'])
    expect(reported).toEqual([['波形 study']])
    expect(logged).toEqual([])
  })

  it('安全弁: 報せる口そのものが投げても、後ろの段と累計は走る', async () => {
    const calls: string[] = []
    const logged: string[] = []
    await closeHostCore(
      deps(calls, {
        stationClosing: {
          deliverFusion: () => {
            throw new Error('配れなかった')
          },
          reportCloseFailures: () => {},
          emitReading: () => {},
          reportDeliveryFailure: () => {
            throw new Error('報せられなかった')
          },
        },
        logError: (line: string) => logged.push(line),
      }),
    )
    expect(calls.slice(-3)).toEqual(['closeWaveArchive', 'closeStatusServer', 'printTotals'])
    expect(logged).toEqual([expect.stringContaining('報せられなかった')])
  })
})

describe('deliverFusionClosing', () => {
  const READING_A: StationIntensityReading = { stationId: 'study', atMs: 3_000, intensity: 1.0 }
  const DRAINED_B: FusionOutcome = {
    ...DRAINED,
    fusedWave: DRAINED.fusedWave === null ? null : { ...DRAINED.fusedWave, stationId: 'garage' },
  }

  function sinks(calls: string[], overrides: Partial<FusionClosingSinks> = {}): FusionClosingSinks {
    return {
      deliverFusion: (o) => calls.push(`deliverFusion:${o.fusedWave?.stationId}`),
      reportCloseFailures: () => calls.push('reportCloseFailures'),
      emitReading: (r) => calls.push(`emitReading:${r.stationId}`),
      reportDeliveryFailure: (labels) => calls.push(`reportDeliveryFailure:${labels.join(',')}`),
      ...overrides,
    }
  }

  it('正: 流し切った回 → 締めくくりの失敗 → 締めて出た震度 の順で配る（失敗が無ければ報せない）', () => {
    const calls: string[] = []
    deliverFusionClosing(sinks(calls), { drained: [DRAINED, DRAINED_B], failures: [], readings: [READING_A] })
    expect(calls).toEqual([
      'deliverFusion:study',
      'deliverFusion:garage',
      'reportCloseFailures',
      'emitReading:study',
    ])
  })

  it('安全弁: 1 件目の観測点で配り先が投げても、他の観測点の波形・失敗の報告・震度は配る', () => {
    // **締めくくりは 1 回きり。** `drained` には全観測点ぶんが 1 本で並ぶので、
    // 1 件目で止まると無関係な観測点の末尾まで、失った量も分からないまま消える。
    const calls: string[] = []
    deliverFusionClosing(
      sinks(calls, {
        deliverFusion: (o) => {
          if (o.fusedWave?.stationId === 'study') throw new Error('study だけ配れない')
          calls.push(`deliverFusion:${o.fusedWave?.stationId}`)
        },
      }),
      { drained: [DRAINED, DRAINED_B], failures: [], readings: [READING_A] },
    )
    expect(calls).toEqual([
      'deliverFusion:garage',
      'reportCloseFailures',
      'emitReading:study',
      'reportDeliveryFailure:波形 study',
    ])
  })

  it('対照: 何も無ければ配り先も報せる口も呼ばない（失敗の報告だけは空でも呼ぶ）', () => {
    const calls: string[] = []
    deliverFusionClosing(sinks(calls), { drained: [], failures: [], readings: [] })
    expect(calls).toEqual(['reportCloseFailures'])
  })
})

describe('makeShutdownRequester（止める合図への答え）', () => {
  function setup(closing = false) {
    const deferred: (() => void)[] = []
    let started = 0
    const request = makeShutdownRequester({
      isClosing: () => closing,
      start: () => {
        started += 1
      },
      defer: (fn) => deferred.push(fn),
    })
    return { request, deferred, started: () => started }
  }

  it('正: 最初の合図は accepted で、締めくくりはその場で始めず後回しにする（答えを書いてから始めるため）', () => {
    const s = setup()
    expect(s.request()).toBe('accepted')
    expect(s.started()).toBe(0)
    expect(s.deferred).toHaveLength(1)
    s.deferred[0]!()
    expect(s.started()).toBe(1)
  })

  it('安全弁: 2 度目の合図は、締めくくりが実際に始まる前でも already-closing で、予約を積み増さない', () => {
    const s = setup()
    s.request()
    expect(s.request()).toBe('already-closing')
    expect(s.deferred).toHaveLength(1)
  })

  it('対照: SIGINT などで締めくくりが既に始まっていれば、最初の合図でも already-closing で何も予約しない', () => {
    const s = setup(true)
    expect(s.request()).toBe('already-closing')
    expect(s.deferred).toHaveLength(0)
  })
})
