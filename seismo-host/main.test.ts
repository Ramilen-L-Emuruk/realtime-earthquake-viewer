import { describe, expect, it } from 'vitest'

// **読み込むだけで待ち受けが開かないことも、この import が確かめている。**
// `main()` は「直接実行のときだけ走らせる」門の中にあるので、ここでは走らない
// （門が無ければ、このテストを走らせるたびに UDP の口が開く）。
import {
  buildClosingLines,
  buildRawWarnings,
  buildWindowSummary,
  formatAt,
  readPort,
  windowSeconds,
} from './main'
import { PacketTally } from './src/receiver/packetTally'

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


describe('buildClosingLines', () => {
  const quiet = {
    evictions: 0,
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
  } as const

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
