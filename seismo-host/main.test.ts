import { describe, expect, it } from 'vitest'

// **読み込むだけで待ち受けが開かないことも、この import が確かめている。**
// `main()` は「直接実行のときだけ走らせる」門の中にあるので、ここでは走らない
// （門が無ければ、このテストを走らせるたびに UDP の口が開く）。
import {
  applyStationConfigCore,
  buildClosingLines,
  buildGravityWarnings,
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
  stationSegmentLogLevel,
  windowSeconds,
} from './main'
import type { ApplyStationConfigDeps } from './main'
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
    compressFailed: 0,
    leftover: 0,
    listFailures: 0,
    escaped: 0,
    lastWriteError: null,
    lastSweepError: null,
    openFiles: 1,
    stuckBooks: 0,
  } as const

  it('何も起きていなければ 1 行も出さない', () => {
    expect(buildRawWarnings(quiet)).toEqual([])
  })

  it('閉じ終わらない本が増えるたびに、間引きの鍵が変わる', () => {
    // **鍵が定数だと、悪化しても最初の 1 行しか出ない。** 1 本で一度出たあと、
    // 3 本・10 本と増えていく様子が間引かれて見えなくなる。
    const one = buildRawWarnings({ ...quiet, openFiles: 2, stuckBooks: 1 })
    const three = buildRawWarnings({ ...quiet, openFiles: 4, stuckBooks: 3 })

    expect(one).toHaveLength(1)
    expect(one[0]?.kind).toBe('raw-open')
    expect(one[0]?.line).toContain('1 本')
    expect(three[0]?.detail).not.toBe(one[0]?.detail)
  })

  it('正常な 1 本では報せない', () => {
    // 対照。閉じ忘れていないときに毎分出ると、本物の閉じ忘れが埋もれる。
    expect(buildRawWarnings({ ...quiet, openFiles: 1 })).toEqual([])
  })

  it('冊数が増えただけでは報せない（日が変わる瞬間の 2 冊）', () => {
    // 日をまたぐと新旧 2 冊が数秒だけ共存する。**冊数で鳴らすと毎日その瞬間に誤報が出る。**
    expect(buildRawWarnings({ ...quiet, openFiles: 2, stuckBooks: 0 })).toEqual([])
  })

  it('閉じ終わらない本があれば、開いたままの総数も添えて報せる', () => {
    const out = buildRawWarnings({ ...quiet, openFiles: 2, stuckBooks: 1 })

    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('raw-open')
    expect(out[0]?.line).toContain('全部で 2 本')
  })

  it('置き場所そのものを読めなかったことを、圧縮の失敗と別の行で出す', () => {
    // 1 件と数えても、失った対象が 0 本か数百本かは判らない。混ぜると軽く読める。
    const out = buildRawWarnings({ ...quiet, listFailures: 1, lastSweepError: 'EACCES' })

    expect(out.map((w) => w.kind)).toEqual(['raw-list', 'raw-sweep'])
  })

  it('同じ日の記録が別の中身で残ったことを報せる', () => {
    // 逃がすこと自体は成功だが、日付でファイルを分ける前提が揺らいでいる合図。
    const out = buildRawWarnings({ ...quiet, escaped: 1 })

    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('raw-escaped')
    expect(out[0]?.line).toContain('時計が戻った疑い')
    // 開いたままの本と同じ理由で、件数が増えたら鍵も変わる（増加が間引かれない）。
    expect(buildRawWarnings({ ...quiet, escaped: 2 })[0]?.detail).not.toBe(out[0]?.detail)
  })

  it('書き損ねた件数があり、理由も判っていれば理由を出す', () => {
    const out = buildRawWarnings({ ...quiet, lost: 3, lastWriteError: 'EACCES: permission denied' })

    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('raw-write')
    expect(out[0]?.line).toContain('EACCES')
  })

  it('理由が判っていても、その窓で何も起きていなければ出さない', () => {
    // 対照。理由は最後に起きたものが残り続けるので、件数を見ないと毎分出る。
    expect(buildRawWarnings({ ...quiet, lastWriteError: 'EACCES: permission denied' })).toEqual([])
  })

  it('掃き取りの理由は、書き出しの理由とは別の鍵で出す', () => {
    // 安全弁。鍵を共有すると、片方が出ている間もう片方が間引かれて出ない。
    const out = buildRawWarnings({
      ...quiet,
      lost: 1,
      lastWriteError: '書けない',
      compressFailed: 1,
      lastSweepError: '掃けない',
    })

    expect(out.map((w) => w.kind)).toEqual(['raw-write', 'raw-sweep'])
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
    writeErrors: 0,
    lostRecords: 0,
    slowCloses: 0,
    compressed: 0,
    compressFailures: 0,
    leftovers: 0,
    listFailures: 0,
    escaped: 0,
    openFiles: 0,
    cutShort: false,
    stuckBooks: 0,
    recordsAtRisk: 0,
    lastWriteError: null,
    lastSweepError: null,
    waveWriteErrors: 0,
    waveLostRecords: 0,
    waveBadChunks: 0,
    waveSlowClose: false,
    waveLastWriteError: null,
  } as const

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
    const out = buildClosingLines({ ...quiet, openFiles: 2 })

    expect(out).toHaveLength(1)
    expect(out[0]?.line).toContain('閉じ切れなかった生データの本=2')
  })

  it('居座っていた本を、開いたままの総数とは別に出す', () => {
    // 終了の合図と日の境目が重なれば、正常な 2 冊の共存がそのまま最後の記録に残る。
    // **数字だけでは「ずっと居座っていた本」と見分けられない。**
    const out = buildClosingLines({ ...quiet, openFiles: 2, stuckBooks: 1 })

    expect(out.map((c) => c.line.trim())).toEqual([
      '閉じ切れなかった生データの本=2',
      'うち締めくくりから戻ってこない本=1',
    ])
  })

  it('上限で打ち切ったことを、閉じ切れなかった本の数とは別に出す', () => {
    // 打ち切った直後に閉じ終われば `openFiles` は 0 へ戻る。件数だけを見ていると、
    // **打ち切った事実が痕跡も無く消える。**
    const out = buildClosingLines({ ...quiet, cutShort: true, openFiles: 0 })

    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('error')
    expect(out[0]?.line).toContain('打ち切りました')
  })

  it('打ち切ったときは、書き切れなかった件数まで出す', () => {
    // **「打ち切った」だけでは被害の大きさが判らない。** 失った件数は締め終わって初めて
    // 確定するので、打ち切った場合はこの値だけが手掛かりになる。
    const out = buildClosingLines({ ...quiet, cutShort: true, recordsAtRisk: 42 })

    expect(out[0]?.line).toContain('42 件')
  })

  it('最後に起きた失敗の理由を、書き出しと掃き取りで別々に出す', () => {
    // 毎分の要約は締めくくりでは止まっているので、最後の窓で起きた失敗は
    // ここでしか理由が出ない。
    const out = buildClosingLines({
      ...quiet,
      lostRecords: 1,
      lastWriteError: 'EACCES',
      compressFailures: 1,
      lastSweepError: 'ENOSPC',
    })

    expect(out.map((c) => c.level)).toEqual(['log', 'log', 'error', 'error'])
    expect(out[2]?.line).toContain('EACCES')
    expect(out[3]?.line).toContain('ENOSPC')
  })

  it('理由は件数を問わず出す', () => {
    // **毎分の要約とは判断が違う。** あちらは同じ理由を毎分繰り返さないために
    // 件数で絞るが、締めくくりは一度きりなので、判っている理由は残らず出す。
    const out = buildClosingLines({ ...quiet, lastWriteError: 'EACCES' })

    expect(out).toHaveLength(1)
    expect(out[0]?.line).toContain('EACCES')
  })

  it('長すぎる理由は切り詰める', () => {
    const out = buildClosingLines({ ...quiet, lastSweepError: 'あ'.repeat(500) })

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

  it('静止しているのに震度が高いときは、平均引きを疑えと言う', () => {
    const out = buildGravityWarnings({ ...base, restless: true, maxIntensity: 5.1 })

    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('gravity-restless')
    expect(out[0].line).toContain('静止している')
    expect(out[0].line).toContain('5.1')
    expect(out[0].line).toContain('平均引き')
  })

  it('倍率と平均引きが同じ窓で立ったら、2 行を別の鍵で出す', () => {
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
      rebuildStations: () => calls.push('rebuildStations'),
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        return { failures: [], readings: [] }
      },
      reportCloseFailures: () => calls.push('reportCloseFailures'),
      emitReading: () => calls.push('emitReading'),
      onCloseFailure: () => calls.push('onCloseFailure'),
      rebuildSensorFusion: () => {
        calls.push('rebuildSensorFusion')
        return []
      },
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
      'rebuildStations',
      'closeSensorFusion',
      'reportCloseFailures',
      'rebuildSensorFusion',
      'setUngroupedMultiBoardStations',
      'setWarning',
    ])
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
      'rebuildStations',
      'closeSensorFusion',
      'onCloseFailure',
      'rebuildSensorFusion',
      'setUngroupedMultiBoardStations',
      'setWarning',
    ])
  })

  it('正: 古い合成の残り読みは reportCloseFailures の後・emitReading で 1 件ずつ配る', () => {
    const calls: string[] = []
    const d = deps(calls, {
      closeSensorFusion: () => {
        calls.push('closeSensorFusion')
        return { failures: [CLOSE_FAILURE], readings: [STATION_READING, STATION_READING] }
      },
    })
    applyStationConfigCore(d, NEW_CONFIG)

    expect(calls).toEqual([
      'save',
      'setCurrentConfig',
      'rebuildStations',
      'closeSensorFusion',
      'reportCloseFailures',
      'emitReading',
      'emitReading',
      'rebuildSensorFusion',
      'setUngroupedMultiBoardStations',
      'setWarning',
    ])
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
