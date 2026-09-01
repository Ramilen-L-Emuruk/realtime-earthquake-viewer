// フレーム時間の記録（utils/frameProfiler.ts）のテスト。
//
// **モジュールはトップレベルで読む。** テスト本体の中で初めて読むと、そのファイルで初回の
// 解決・変換が 1 件目の所要時間に丸ごと乗る（CLAUDE.md「検証」節）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DEFAULT_JANK_DELTA_MS,
  EVENT_NEAR_MS,
  IGNORE_DELTA_MS,
  RECORD_CAPACITY,
  SLOW_SPAN_MS,
  arm,
  disarm,
  noteEvent,
  recordFrameDelta,
  beginSpan,
  buildReport,
  classifyDelta,
  profileSpan,
  recordSpan,
  report,
  reset,
  snapshot,
  startFrameWatch,
  stopFrameWatch,
  toLongFrame,
  type LongFrame,
  type ProfilerSnapshot,
} from './frameProfiler'

function frame(startMs: number, durationMs: number, blockingMs = durationMs - 16): LongFrame {
  return { startMs, durationMs, blockingMs, scriptMs: durationMs, scripts: [] }
}

function emptySnapshot(over: Partial<ProfilerSnapshot> = {}): ProfilerSnapshot {
  return {
    frames: [],
    spans: [],
    events: [],
    jank: [],
    full: { frames: false, spans: false, events: false, jank: false },
    longAnimationFrameSupported: true,
    framesObserved: 0,
    jankTotal: 0,
    observedDeltaSumMs: 0,
    armed: true,
    worstDeltaMs: 0,
    watchRunning: false,
    watchStartedAtMs: null,
    watchStoppedAtMs: null,
    nowMs: 10_000,
    ...over,
  }
}

describe('buildReport: 長いフレームと区間の突き合わせ', () => {
  it('正: 長いフレームに重なる区間が犯人として出る', () => {
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1000, 80)],
        spans: [{ name: 'labels:overlap', startMs: 1010, endMs: 1075 }],
      }),
    )
    expect(r.bySpan).toHaveLength(1)
    expect(r.bySpan[0]).toMatchObject({ name: 'labels:overlap', frames: 1, count: 1, spanMs: 65 })
    expect(r.worstFrames[0].spans).toEqual(['labels:overlap'])
  })

  it('対照: 重ならない区間は犯人にならない（記録自体は残る）', () => {
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1000, 80)],
        // フレームが終わった（1080）後に始まった区間。
        spans: [{ name: 'kyoshin:detector-step', startMs: 1100, endMs: 1130 }],
      }),
    )
    expect(r.bySpan[0]).toMatchObject({ name: 'kyoshin:detector-step', frames: 0, count: 1 })
    expect(r.worstFrames[0].spans).toEqual([])
  })

  it('境界: フレームの終わりに 1ms でも掛かっていれば重なりとみなす', () => {
    const overlapping = buildReport(
      emptySnapshot({ frames: [frame(1000, 80)], spans: [{ name: 'a', startMs: 1079, endMs: 1200 }] }),
    )
    const separate = buildReport(
      emptySnapshot({ frames: [frame(1000, 80)], spans: [{ name: 'a', startMs: 1080, endMs: 1200 }] }),
    )
    expect(overlapping.bySpan[0].frames).toBe(1)
    expect(separate.bySpan[0].frames).toBe(0)
  })

  it('detail は同じ名前の中で分けて集計する（投影の種別ごとにコンパイル費用を見る）', () => {
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1000, 40), frame(2000, 40)],
        spans: [
          { name: 'gl:program-compile', startMs: 1005, endMs: 1030, detail: 'depth-point:globe' },
          { name: 'gl:program-compile', startMs: 2005, endMs: 2030, detail: 'depth-point:mercator' },
        ],
      }),
    )
    expect(r.bySpan.map((b) => b.name)).toEqual([
      'gl:program-compile (depth-point:globe)',
      'gl:program-compile (depth-point:mercator)',
    ])
  })

  it('カメラ移動の区間は、その間に起きた長いフレームすべてに重なる', () => {
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1100, 40), frame(1300, 60)],
        spans: [{ name: 'camera:move', startMs: 1000, endMs: 1500 }],
      }),
    )
    expect(r.bySpan[0]).toMatchObject({ name: 'camera:move', frames: 2, count: 1 })
  })
})

describe('buildReport: 点（タイルの到着）の数え方', () => {
  it('正: フレームの前後に起きた点だけを数える', () => {
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1000, 80)],
        events: [
          { name: 'map:tile:gebco', atMs: 1000 - EVENT_NEAR_MS + 1 },
          { name: 'map:tile:gebco', atMs: 1050 },
          { name: 'map:tile:basemap-shapes', atMs: 1080 + EVENT_NEAR_MS - 1 },
        ],
      }),
    )
    expect(r.worstFrames[0].nearbyEvents).toEqual([
      { name: 'map:tile:gebco', count: 2 },
      { name: 'map:tile:basemap-shapes', count: 1 },
    ])
  })

  it('対照: 範囲の外の点は数えない（読み込みが原因でないフレームを読み込みのせいにしない）', () => {
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1000, 80)],
        events: [
          { name: 'map:tile:gebco', atMs: 1000 - EVENT_NEAR_MS - 1 },
          { name: 'map:tile:gebco', atMs: 1080 + EVENT_NEAR_MS + 1 },
        ],
      }),
    )
    expect(r.worstFrames[0].nearbyEvents).toEqual([])
  })
})

describe('buildReport: 遅かった区間の列挙', () => {
  it('長いフレームに重なっていなくても、1 フレーム分より長い区間は挙げる', () => {
    const r = buildReport(
      emptySnapshot({
        spans: [
          { name: 'slow', startMs: 100, endMs: 100 + SLOW_SPAN_MS },
          { name: 'fast', startMs: 200, endMs: 200 + SLOW_SPAN_MS - 1 },
        ],
      }),
    )
    expect(r.longFrames).toBe(0)
    expect(r.slowestSpans.map((s) => s.name)).toEqual(['slow'])
  })
})

describe('buildReport: フレーム間隔の要約', () => {
  it('最悪の間隔は「落ちた記録」からではなく実測の最大値から出す', () => {
    // 閾値ぎりぎり（29ms）が並んで 1 件も落ちていない状態。jank から求めると 0ms になる。
    const r = buildReport(
      emptySnapshot({
        framesObserved: 100,
        observedDeltaSumMs: 2000,
        worstDeltaMs: 29,
        watchRunning: true,
        watchStartedAtMs: 0,
      }),
    )
    expect(r.frameWatch).toMatchObject({ running: true, jankFrames: 0, jankRatio: 0, meanFrameMs: 20, worstDeltaMs: 29 })
  })

  it('安全弁: 落ちた割合は輪バッファの残量ではなく累計から出す（長時間の監視で過小評価しない）', () => {
    // 輪バッファには直近 4096 件しか残らないが、実際は 10000 件落ちている（総フレーム 100000）。
    const r = buildReport(
      emptySnapshot({
        jank: Array.from({ length: RECORD_CAPACITY.jank }, (_, i) => ({ atMs: i, deltaMs: 40 })),
        full: { frames: false, spans: false, events: false, jank: true },
        framesObserved: 100_000,
        jankTotal: 10_000,
        observedDeltaSumMs: 1_700_000,
        worstDeltaMs: 300,
        watchStartedAtMs: 0,
      }),
    )
    expect(r.frameWatch.jankFrames).toBe(10_000)
    expect(r.frameWatch.jankRatio).toBe(0.1)
  })

  it('監視していないときは停止中と分かる形にする', () => {
    const r = buildReport(emptySnapshot())
    expect(r.frameWatch.running).toBe(false)
    expect(r.text).toContain('監視は停止中')
  })

  it('止めた後も計測済みの値は見せるが、止まっていることを併記する', () => {
    const r = buildReport(
      emptySnapshot({
        framesObserved: 100,
        observedDeltaSumMs: 1700,
        worstDeltaMs: 40,
        watchStartedAtMs: 0,
        watchStoppedAtMs: 1_700,
      }),
    )
    expect(r.frameWatch.running).toBe(false)
    expect(r.text).toContain('監視は停止中・以下は計測済みの値')
    expect(r.text).toContain('100 フレーム中')
  })

  it('見ていた長さは記録の範囲と別に出す（0 秒の範囲と 600 フレームが並んで矛盾に見えるのを防ぐ）', () => {
    const r = buildReport(
      emptySnapshot({
        framesObserved: 600,
        observedDeltaSumMs: 10_000,
        watchStartedAtMs: 0,
        watchStoppedAtMs: 10_000,
        nowMs: 100_000,
      }),
    )
    expect(r.windowMs).toBe(0)
    expect(r.frameWatch.measuredMs).toBe(10_000)
    expect(r.text).toContain('10 秒で 600 フレーム中')
  })
})

describe('startFrameWatch / stopFrameWatch のライフサイクル', () => {
  beforeEach(() => {
    stopFrameWatch()
    reset()
  })

  afterEach(() => {
    stopFrameWatch()
    vi.unstubAllGlobals()
  })

  it('正: 開始すると監視中になる', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    startFrameWatch()
    expect(report().frameWatch.running).toBe(true)
  })

  it('対照: 止めたら監視中ではなくなる（記録の起点は残す）', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    startFrameWatch()
    stopFrameWatch()
    expect(report().frameWatch.running).toBe(false)
    // 起点を捨てると記録がどこから始まったか分からなくなる。止めても残すこと。
    expect(snapshot().watchStartedAtMs).not.toBeNull()
  })

  it('安全弁: requestAnimationFrame が無ければ監視中を装わない', () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    startFrameWatch()
    expect(report().frameWatch.running).toBe(false)
  })
})

describe('classifyDelta', () => {
  it('正: 閾値を超えた間隔は落ちたと見なす', () => {
    expect(classifyDelta(DEFAULT_JANK_DELTA_MS + 1)).toBe('jank')
  })

  it('対照: 閾値ちょうどは落ちていない', () => {
    expect(classifyDelta(DEFAULT_JANK_DELTA_MS)).toBe('smooth')
    expect(classifyDelta(16.7)).toBe('smooth')
  })

  it('安全弁: タブが背面にあった間の空白はコマ落ちに数えない', () => {
    expect(classifyDelta(IGNORE_DELTA_MS + 1)).toBe('ignored')
    // 上限ちょうどまでは数える（境界を両側から固定する）。
    expect(classifyDelta(IGNORE_DELTA_MS)).toBe('jank')
  })
})

describe('buildReport: 記録がどこまで遡れるか', () => {
  it('正: 溢れていなければ最も古い記録から今までを覆う', () => {
    const r = buildReport(emptySnapshot({ spans: [{ name: 'a', startMs: 4000, endMs: 4010 }], nowMs: 10_000 }))
    expect(r.windowMs).toBe(6000)
    expect(r.truncated).toEqual([])
  })

  it('溢れた種類があれば、その種類が遡れる範囲まで縮める', () => {
    // 長いフレームは 9 秒前まで残っているが、点は 2 秒前までしか残っていない。
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1000, 50)],
        events: [{ name: 'map:tile:gebco', atMs: 8000 }],
        full: { frames: false, spans: false, events: true, jank: false },
        nowMs: 10_000,
      }),
    )
    expect(r.windowMs).toBe(2000)
    expect(r.truncated).toEqual(['点（2 秒ぶんのみ）'])
    expect(r.text).toContain('記録が溢れて古い分を失っている')
  })

  it('安全弁: 監視を止めた後は、開始時刻も落ちたフレームの記録も起点にしない', () => {
    // 10 秒だけ監視して止め、その 90 秒後に報告を求めた状況。開始時刻を起点にすると「直近 100 秒を
    // 覆っていて 0 件」＝見ていない 90 秒まで無事だったと主張することになる。落ちたフレームの記録を
    // 起点にしても同じで、その系列は止めた時点で「今」に届かなくなっている。
    const r = buildReport(
      emptySnapshot({
        jank: [{ atMs: 5_000, deltaMs: 40 }],
        framesObserved: 600,
        jankTotal: 1,
        observedDeltaSumMs: 10_000,
        watchRunning: false,
        watchStartedAtMs: 0,
        watchStoppedAtMs: 10_000,
        nowMs: 100_000,
      }),
    )
    expect(r.windowMs).toBe(0)
    // 代わりに「実際に見ていた長さ」を別の数として出す。
    expect(r.frameWatch.measuredMs).toBe(10_000)
  })

  it('対照: 監視中なら開始時刻を起点に含める（まだ何も起きていなくても覆っている）', () => {
    const r = buildReport(emptySnapshot({ watchRunning: true, watchStartedAtMs: 1_000, nowMs: 10_000 }))
    expect(r.windowMs).toBe(9_000)
  })

  it('安全弁: 監視を止めた後は、落ちたフレームの記録が溢れていても範囲を狭めない', () => {
    // 止めた系列は「今」に届いていない。範囲（今から遡ってどこまで裏付けられるか）に混ぜると
    // 意味が壊れる。溢れた事実だけは伝える。
    const r = buildReport(
      emptySnapshot({
        jank: [{ atMs: 5_000, deltaMs: 40 }],
        events: [{ name: 'map:tile:gebco', atMs: 90_000 }],
        full: { frames: false, spans: false, events: false, jank: true },
        framesObserved: 600,
        jankTotal: 4096,
        watchRunning: false,
        watchStartedAtMs: 0,
        watchStoppedAtMs: 10_000,
        nowMs: 100_000,
      }),
    )
    // 範囲を決めるのは、今も記録が続いている点（10 秒前）だけ。
    expect(r.windowMs).toBe(10_000)
    expect(r.truncated).toEqual(['落ちたフレーム（5 秒ぶんのみ）'])
  })

  it('対照: 監視中に落ちたフレームの記録が溢れていれば範囲を狭める', () => {
    const r = buildReport(
      emptySnapshot({
        jank: [{ atMs: 95_000, deltaMs: 40 }],
        events: [{ name: 'map:tile:gebco', atMs: 10_000 }],
        full: { frames: false, spans: false, events: false, jank: true },
        watchRunning: true,
        watchStartedAtMs: 0,
        nowMs: 100_000,
      }),
    )
    expect(r.windowMs).toBe(5_000)
  })

  it('対照: 溢れていない種類は範囲を狭めない', () => {
    // 点は 2 秒前が最古だが溢れていない（それ以前に点が無かっただけ）。
    const r = buildReport(
      emptySnapshot({
        frames: [frame(1000, 50)],
        events: [{ name: 'map:tile:gebco', atMs: 8000 }],
        nowMs: 10_000,
      }),
    )
    expect(r.windowMs).toBe(9000)
    expect(r.truncated).toEqual([])
  })
})

describe('buildReport: Long Animation Frames が使えない環境', () => {
  it('0 件ではなく「取れない」と書く（起きなかったと読ませない）', () => {
    const r = buildReport(emptySnapshot({ longAnimationFrameSupported: false }))
    expect(r.longAnimationFrameSupported).toBe(false)
    expect(r.text).toContain('この環境では取れない')
    expect(r.text).not.toContain('長いフレーム: 0 件')
  })

  it('対照: 使える環境で 1 件も無ければ 0 件と書く', () => {
    const r = buildReport(emptySnapshot())
    expect(r.text).toContain('長いフレーム: 0 件')
  })
})

describe('toLongFrame: Long Animation Frames の写し取り', () => {
  // PerformanceEntry の実体は読み取り専用なので、必要な形だけ持つ素のオブジェクトを渡す。
  const entry = (over: Record<string, unknown>) =>
    ({ name: 'long-animation-frame', entryType: 'long-animation-frame', startTime: 1000, duration: 100, ...over }) as unknown as PerformanceEntry

  it('正: 帰属の情報をそのまま写す', () => {
    const f = toLongFrame(
      entry({
        blockingDuration: 60,
        renderStart: 1080,
        scripts: [
          { duration: 70, invoker: 'TimerHandler:setTimeout', sourceURL: 'a.tsx', sourceFunctionName: 'run', forcedStyleAndLayoutDuration: 5 },
        ],
      }),
    )
    expect(f).toMatchObject({ startMs: 1000, durationMs: 100, blockingMs: 60, scriptMs: 80 })
    expect(f.scripts[0]).toMatchObject({ functionName: 'run', sourceURL: 'a.tsx', durationMs: 70, forcedLayoutMs: 5 })
  })

  it('名前が空文字で来ても主語の抜けた行にしない', () => {
    const f = toLongFrame(entry({ scripts: [{ duration: 10, invoker: '', sourceURL: '', sourceFunctionName: '' }] }))
    expect(f.scripts[0]).toMatchObject({ functionName: '(無名)', sourceURL: '(不明)', invoker: '(不明)' })
  })

  it('対照: 描画に入らなかったフレーム（renderStart 0）はスクリプト時間を 0 にする', () => {
    // ここで差を取ると、フレーム全体と同じ長さが「スクリプトが使った時間」として出てしまう。
    expect(toLongFrame(entry({ renderStart: 0 })).scriptMs).toBe(0)
  })

  it('安全弁: 帰属を持たないエントリでも壊れない', () => {
    const f = toLongFrame(entry({}))
    expect(f.scripts).toEqual([])
    expect(f.blockingMs).toBe(0)
  })
})

describe('計測を始めるまで記録しない', () => {
  beforeEach(() => {
    disarm()
    reset()
  })

  afterEach(() => {
    disarm()
  })

  it('対照: 始めていなければ区間も点も残らない', () => {
    profileSpan('unit:before-arm', () => 1)
    beginSpan('unit:before-arm-paired')()
    noteEvent('unit:before-arm-event')
    recordSpan({ name: 'unit:before-arm-direct', startMs: 0, endMs: 1 })
    const s = snapshot()
    expect(s.spans).toEqual([])
    expect(s.events).toEqual([])
    expect(s.armed).toBe(false)
  })

  it('安全弁: 始めていない報告に件数を並べない（0 件を「起きなかった」と読ませない）', () => {
    const text = report().text
    expect(text).toBe('計測していない（__frameProfiler.start() で開始する）')
    expect(text).not.toContain('0 件')
  })

  it('安全弁: 止めた後も、集めた分があれば要約を出す（集め終えた結果を隠さない）', () => {
    arm()
    recordSpan({ name: 'unit:collected', startMs: 0, endMs: 50 })
    disarm()
    const r = report()
    expect(r.armed).toBe(false)
    expect(r.hasRecords).toBe(true)
    expect(r.text).toContain('計測は終了している')
    expect(r.text).toContain('unit:collected')
    expect(r.text).not.toBe('計測していない（__frameProfiler.start() で開始する）')
  })

  it('正: 始めれば記録する', () => {
    arm()
    profileSpan('unit:after-arm', () => 1)
    noteEvent('unit:after-arm-event')
    const s = snapshot()
    expect(s.armed).toBe(true)
    expect(s.spans.map((sp) => sp.name)).toEqual(['unit:after-arm'])
    expect(s.events.map((e) => e.name)).toEqual(['unit:after-arm-event'])
  })

  it('計測していなくても profileSpan は中身を実行して戻り値を返す', () => {
    let ran = false
    const v = profileSpan('unit:passthrough', () => {
      ran = true
      return 7
    })
    expect(ran).toBe(true)
    expect(v).toBe(7)
  })
})

describe('区間の記録', () => {
  beforeEach(() => {
    arm()
    reset()
  })

  it('正: profileSpan は戻り値をそのまま返し、区間を記録する', () => {
    const value = profileSpan('unit:ok', () => 42)
    expect(value).toBe(42)
    expect(snapshot().spans.map((s) => s.name)).toEqual(['unit:ok'])
  })

  it('安全弁: 例外が出ても区間は記録する（落ちた処理が何 ms 使ったかも知りたい）', () => {
    expect(() =>
      profileSpan('unit:throws', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(snapshot().spans.map((s) => s.name)).toEqual(['unit:throws'])
  })

  it('安全弁: beginSpan は終了関数を呼ばなければ何も記録しない', () => {
    beginSpan('unit:never-ends')
    expect(snapshot().spans).toEqual([])
  })

  it('beginSpan の終了時に detail を差し替えられる', () => {
    const end = beginSpan('unit:paired', '開始時')
    end('終了時')
    expect(snapshot().spans[0].detail).toBe('終了時')
  })

  it('reset は記録だけを捨てる', () => {
    recordSpan({ name: 'unit:before-reset', startMs: 0, endMs: 1 })
    reset()
    expect(snapshot().spans).toEqual([])
  })

  it('安全弁: 上限を超えたら古いものから落ち、溢れた事実が残る', () => {
    const over = 5
    for (let i = 0; i < RECORD_CAPACITY.spans + over; i++) {
      recordSpan({ name: String(i), startMs: i, endMs: i + 1 })
    }
    const s = snapshot()
    expect(s.spans).toHaveLength(RECORD_CAPACITY.spans)
    // 古い順に並び、落ちたのは先頭 5 件。
    expect(s.spans[0].name).toBe(String(over))
    expect(s.spans[s.spans.length - 1].name).toBe(String(RECORD_CAPACITY.spans + over - 1))
    expect(s.full.spans).toBe(true)
  })

  it('対照: 上限に達していなければ溢れたことにしない', () => {
    recordSpan({ name: 'unit:one', startMs: 0, endMs: 1 })
    expect(snapshot().full.spans).toBe(false)
  })
})

describe('recordFrameDelta: フレーム間隔の集計', () => {
  beforeEach(() => {
    arm()
    reset()
  })

  it('正: 落ちた間隔は件数と時刻の両方に入る', () => {
    recordFrameDelta(40, 1000)
    const s = snapshot()
    expect(s.jankTotal).toBe(1)
    expect(s.framesObserved).toBe(1)
    expect(s.jank).toEqual([{ atMs: 1000, deltaMs: 40 }])
  })

  it('対照: 落ちていない間隔は数えるが「落ちた」には入れない', () => {
    recordFrameDelta(16, 1000)
    const s = snapshot()
    expect(s.framesObserved).toBe(1)
    expect(s.jankTotal).toBe(0)
    expect(s.jank).toEqual([])
    expect(s.worstDeltaMs).toBe(16)
  })

  it('安全弁: 数えない間隔（タブが背面）は平均も最悪も汚さない', () => {
    recordFrameDelta(16, 1000)
    recordFrameDelta(IGNORE_DELTA_MS + 500, 3000)
    const s = snapshot()
    expect(s.framesObserved).toBe(1)
    expect(s.observedDeltaSumMs).toBe(16)
    expect(s.worstDeltaMs).toBe(16)
  })
})
