import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  lngLatToTile,
  buildPrefetchTiles,
  buildGlobalPrefetchTiles,
  buildPrefetchQueue,
  desiredTileZoom,
  shouldSkipPrefetch,
  startBathymetryPrefetch,
  MAX_TILE_ZOOM,
  GLOBAL_MAX_TILE_ZOOM,
  GEBCO_OVERVIEW_MAX_ZOOM,
  PREFETCH_REFRESH_MS,
} from './gebcoPrefetch'
import { JAPAN_WIDE_BOUNDS } from '../components/Map/gl/bounds'
import { REFERENCE_SHORT_SIDE_PX } from '../components/Map/gl/viewSpan'
import { log } from './logger'

const tileKey = (t: { x: number; y: number; z: number }) => `${t.z}/${t.x}/${t.y}`

describe('lngLatToTile', () => {
  it('zoom0では常に(0,0)を返す（世界全体が1タイル）', () => {
    expect(lngLatToTile(139.767, 35.681, 0)).toEqual([0, 0])
    expect(lngLatToTile(-122.4, 37.8, 0)).toEqual([0, 0])
  })

  it('経度が大きいほどxが大きくなる（単調性）', () => {
    const [xWest] = lngLatToTile(122, 35, 6)
    const [xEast] = lngLatToTile(149, 35, 6)
    expect(xEast).toBeGreaterThan(xWest)
  })

  it('緯度が大きい（北側）ほどyが小さくなる（単調性）', () => {
    const [, yNorth] = lngLatToTile(135, 46, 6)
    const [, ySouth] = lngLatToTile(135, 24, 6)
    expect(yNorth).toBeLessThan(ySouth)
  })

  it('タイル座標は0〜(2^z-1)の範囲にクランプされる', () => {
    const z = 4
    const max = 2 ** z - 1
    const [x, y] = lngLatToTile(-180, 89, z)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(max)
    expect(y).toBeLessThanOrEqual(max)
  })
})

describe('buildPrefetchTiles', () => {
  it('zoom0からmaxZoomまで全ズームぶんのタイルを含む', () => {
    const tiles = buildPrefetchTiles(3)
    const zooms = new Set(tiles.map((t) => t.z))
    expect(zooms).toEqual(new Set([0, 1, 2, 3]))
  })

  it('低ズーム優先（z昇順）で並んでいる', () => {
    const tiles = buildPrefetchTiles(4)
    const zSequence = tiles.map((t) => t.z)
    const sorted = [...zSequence].sort((a, b) => a - b)
    expect(zSequence).toEqual(sorted)
  })

  it('同一タイルの重複がない', () => {
    const tiles = buildPrefetchTiles(4)
    const keys = tiles.map((t) => `${t.z}/${t.x}/${t.y}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('引数なしのとき MAX_TILE_ZOOM までの全ズームを含む（自動フィット上限で使うタイルを漏らさない）', () => {
    const zooms = new Set(buildPrefetchTiles().map((t) => t.z))
    const expected = new Set(Array.from({ length: MAX_TILE_ZOOM + 1 }, (_, z) => z))
    expect(zooms).toEqual(expected)
  })

  it('常時下地のオーバービュー層が使う z のタイルがキューの先頭に固まっている（下地が最速で温まる前提）', () => {
    // 下地層は「遠距離フィットの直後でも必ず描かれている」ことが役割なので、先読みの完走を待たずに
    // 揃う必要がある。低ズーム優先で並ぶ実装ゆえ、下地に要る z のタイルはキュー先頭に連続して収まる。
    const tiles = buildPrefetchTiles()
    const overviewCount = tiles.filter((t) => t.z <= GEBCO_OVERVIEW_MAX_ZOOM).length
    expect(overviewCount).toBeGreaterThan(0)
    expect(tiles.slice(0, overviewCount).every((t) => t.z <= GEBCO_OVERVIEW_MAX_ZOOM)).toBe(true)
    // 先読み全体のごく一部（1 割未満）で下地が揃う。ここが膨らむと下地の温まりが遅れる。
    expect(overviewCount).toBeLessThan(tiles.length * 0.1)
  })
})

describe('GLOBAL_MAX_TILE_ZOOM', () => {
  /** Mercator の y（0〜1）。lngLatToTile と同じ式。 */
  const mercatorY = (lat: number): number => {
    const latRad = (lat * Math.PI) / 180
    return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  }

  it('基準ペインで日本全体へ寄せたときに要るタイル z を下回らない', () => {
    // 遠地地震の寄り先は「震源 ∪ 日本全体」（useQuakeLayerData の quakeFitPositions）。日本全体が
    // 必ず画に入る以上、震源がどれだけ離れていても日本全体 fit より引いた画にしかならず、その z が
    // 自動フィットで要求されうるタイル z の上限になる。**この前提が崩れたら全球の先読みが 1 段
    // 足りなくなり、遠地地震で暗転が戻る**（症状は画面にしか出ないためここで固定する）。
    // 余白（padding）を無視して計算するので、実際の着地より深い側＝安全側に出る。
    const [[west, south], [east, north]] = JAPAN_WIDE_BOUNDS
    const spanY = Math.abs(mercatorY(north) - mercatorY(south))
    const spanX = (east - west) / 360
    // MapLibre の worldSize は 512 * 2^zoom。両方向が短辺に収まる最大のズーム。
    const mapZoom = Math.min(
      Math.log2(REFERENCE_SHORT_SIDE_PX / (spanY * 512)),
      Math.log2(REFERENCE_SHORT_SIDE_PX / (spanX * 512)),
    )
    expect(desiredTileZoom(mapZoom)).toBeLessThanOrEqual(GLOBAL_MAX_TILE_ZOOM)
  })

  it('日本枠の上限より浅い（全球を高解像度まで取りにいかない）', () => {
    // 全球は z が 1 段深くなるごとに枚数が 4 倍になる。日本枠と同じ深さまで広げると桁が変わるため、
    // 自動フィットで使われない深さへは踏み込まない。
    expect(GLOBAL_MAX_TILE_ZOOM).toBeLessThan(MAX_TILE_ZOOM)
  })
})

describe('buildGlobalPrefetchTiles', () => {
  it('各 z で全球ぶん（4^z 枚）を返す', () => {
    const tiles = buildGlobalPrefetchTiles(3)
    for (const z of [0, 1, 2, 3]) {
      expect(tiles.filter((t) => t.z === z)).toHaveLength(4 ** z)
    }
  })

  it('低ズーム優先（z昇順）で並んでいる', () => {
    const zSequence = buildGlobalPrefetchTiles(3).map((t) => t.z)
    expect(zSequence).toEqual([...zSequence].sort((a, b) => a - b))
  })

  it('同一タイルの重複がない', () => {
    const keys = buildGlobalPrefetchTiles(3).map(tileKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('buildPrefetchQueue', () => {
  it('同一タイルの重複がない（日本枠と全球の重なりを除いている）', () => {
    const keys = buildPrefetchQueue().tiles.map(tileKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('日本枠を出し切ってから全球へ移る（起動直後に映る側を先に温める）', () => {
    const japan = buildPrefetchTiles()
    expect(buildPrefetchQueue().tiles.slice(0, japan.length)).toEqual(japan)
  })

  it('日本枠の下地はキューの先頭で揃う（全球ぶんを足しても後回しにならない）', () => {
    // 起動直後の暗転を防いでいるのはオーバービュー層の下地。全球を後ろへ積んだせいでここが
    // 遅れると、足した先読みが元の目的を損なう。
    const japanOverview = buildPrefetchTiles().filter((t) => t.z <= GEBCO_OVERVIEW_MAX_ZOOM)
    expect(buildPrefetchQueue().tiles.slice(0, japanOverview.length)).toEqual(japanOverview)
  })

  it('全球の低ズームを 1 枚残らず含む', () => {
    const queued = new Set(buildPrefetchQueue().tiles.map(tileKey))
    expect(buildGlobalPrefetchTiles().filter((t) => !queued.has(tileKey(t)))).toEqual([])
  })
})

describe('startBathymetryPrefetch', () => {
  /** requestIdleCallback の代替（setTimeout 200ms）と fetch を消化しきるのに十分な時間。 */
  const DRAIN_MS = 300_000

  const fetchMock = () => vi.mocked(globalThis.fetch)
  /** 応答も失敗も返さない fetch（回線が吊られた状態の再現）。 */
  const hangingFetch = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true } as Response)),
    )
    vi.spyOn(log, 'info').mockImplementation(() => {})
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('1 巡でキュー全部を投げる', async () => {
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(fetchMock()).toHaveBeenCalledTimes(buildPrefetchQueue().tiles.length)
    ac.abort()
  })

  it('有効期限が過ぎたら取り直す', async () => {
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    const afterFirst = fetchMock().mock.calls.length
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(fetchMock().mock.calls.length).toBeGreaterThan(afterFirst)
    ac.abort()
  })

  it('有効期限の内は取り直さない（1 巡を終えていても）', async () => {
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    const afterFirst = fetchMock().mock.calls.length
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS - DRAIN_MS - 1)
    expect(fetchMock().mock.calls.length).toBe(afterFirst)
    ac.abort()
  })

  it('詰まった巡は次の周期で打ち切って始め直す（恒久停止しない）', async () => {
    // fetch には時間切れが無いので、応答も失敗も返らないまま吊られると 1 巡は永久に終わらない。
    // 「前の巡が終わるまで次を始めない」形にすると、そこで先読みが**恒久的に**止まる ——
    // 画面にもログにも出ず、地図が常時表示のこのアプリでは再マウントによる回復も起きない。
    hangingFetch()
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(1000)
    const stuck = fetchMock().mock.calls.length
    expect(stuck).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock().mock.calls.length).toBeGreaterThan(stuck)
    ac.abort()
  })

  it('新しい巡を始めるとき、前の巡の進行中のリクエストを打ち切る', async () => {
    // 打ち切らないと、吊られたリクエストが巡をまたいで積み上がる。
    const signals: AbortSignal[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal)
        return new Promise<Response>(() => {})
      }),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => !s.aborted)).toBe(true)
    const firstPass = [...signals]
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS)
    expect(firstPass.every((s) => s.aborted)).toBe(true)
    ac.abort()
  })

  it('途中で通信節約に切り替わったら、走りかけの巡も打ち切る', async () => {
    // 判定を巡の入口だけに置くと、外出先へ移った端末が走りかけの巡を最後まで投げ切ってしまう。
    const signals: AbortSignal[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal)
        return new Promise<Response>(() => {})
      }),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(signals.length).toBeGreaterThan(0)
    const inflight = [...signals]
    vi.stubGlobal('navigator', { connection: { saveData: true } })
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS)
    expect(inflight.every((s) => s.aborted)).toBe(true)
    // 新しい巡も始まっていない
    expect(signals.length).toBe(inflight.length)
    ac.abort()
  })

  it('打ち切られた巡の続きから次の巡を始める（前半だけを取り直さない）', async () => {
    // 1 巡が 1 周期で終わらない回線では、毎回キューの先頭から作り直すと後半（全球ぶん）へ
    // 永久に到達しない。しかも前半は成功しているので全滅の記録にも掛からず、黙って無進捗になる。
    // **1 枚あたりに時間がかかる回線を模す。** 即座に解決する fetch では 1 時間ぶん時計を進める
    // 間に 1 巡が完走してしまい、「続きから始まったか」を確かめられない（偽陰性になる）。
    const SLOW_FETCH_MS = 60_000
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(String(url))
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true } as Response), SLOW_FETCH_MS)
        })
      }),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    // 1 巡を配り切る前に止める
    await vi.advanceTimersByTimeAsync(1000)
    const firstPass = [...urls]
    expect(firstPass.length).toBeGreaterThan(0)
    expect(firstPass.length).toBeLessThan(buildPrefetchQueue().tiles.length)

    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS)
    await vi.advanceTimersByTimeAsync(1000)
    const secondPass = urls.slice(firstPass.length)
    expect(secondPass.length).toBeGreaterThan(0)
    // 先頭から作り直していたら必ず重なる
    const firstSet = new Set(firstPass)
    expect(secondPass.filter((u) => firstSet.has(u))).toEqual([])
    ac.abort()
  })

  it('日本の外だけ取得できなかったことを記録する', async () => {
    // 合算した判定だと、先に走る日本の枠が 1 枚でも成功した時点で素通りしてしまう。
    // 全球ぶんは遠地地震のときだけ効く範囲なので、黙ると気づく手段がない。
    const japanKeys = new Set(buildPrefetchTiles().map((t) => `${t.z}/${t.y}/${t.x}`))
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const m = String(url).match(/tile\/(\d+)\/(\d+)\/(\d+)/)
        return Promise.resolve({ ok: m ? japanKeys.has(`${m[1]}/${m[2]}/${m[3]}`) : false } as Response)
      }),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('日本の外の海底地形タイルだけ')
    ac.abort()
  })

  it('日本周辺だけ取得できなかったことを記録する', async () => {
    // 全球ぶんだけを別に見るなら、その裏返しも同じように見えなければ非対称になる。
    const japanKeys = new Set(buildPrefetchTiles().map((t) => `${t.z}/${t.y}/${t.x}`))
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const m = String(url).match(/tile\/(\d+)\/(\d+)\/(\d+)/)
        return Promise.resolve({ ok: m ? !japanKeys.has(`${m[1]}/${m[2]}/${m[3]}`) : false } as Response)
      }),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('日本周辺の海底地形タイルだけ')
    ac.abort()
  })

  it('全球ぶんだけを触った巡で、全体の障害として記録しない', async () => {
    // 進行位置を引き継ぐため、遅い回線では「日本の枠を 1 件も触らない巡」が起こる。その巡で
    // 全球が全滅したときに合算の成否で判定すると、取れている日本周辺まで巻き込んで
    // 「配信元の停止」と書いてしまう（過大な診断）。
    const japanKeys = new Set(buildPrefetchTiles().map((t) => `${t.z}/${t.y}/${t.x}`))
    const SLOW_FETCH_MS = 10_000
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const m = String(url).match(/tile\/(\d+)\/(\d+)\/(\d+)/)
        const ok = m ? japanKeys.has(`${m[1]}/${m[2]}/${m[3]}`) : false
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok } as Response), SLOW_FETCH_MS)
        })
      }),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    // 1 巡目で日本の枠を越え、全球の途中まで進める
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS)
    warnSpy.mockClear()
    // 2 巡目は全球の途中から始まるので、日本の枠を 1 件も触らない
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS)
    const messages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((m: string) => m.includes('日本の外の海底地形タイルだけ'))).toBe(true)
    ac.abort()
  })

  it('1 枚も取得できなかった巡を記録する', async () => {
    // 先読みは成功しても失敗しても画面に何も出さない。数えて記録しないと、配信元が止まっても
    // 1 時間ごとに無言で空振りし続けるだけになる。
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false } as Response)),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('1 枚も取得できなかった')
    ac.abort()
  })

  it('1 枚でも取得できれば記録しない', async () => {
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(warnSpy).not.toHaveBeenCalled()
    ac.abort()
  })

  it('中断で終わった巡は記録しない（次の巡へ譲っただけ）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false } as Response)),
    )
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    await vi.advanceTimersByTimeAsync(1000)
    ac.abort()
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('abort すると取り直しの周期ごと止まる（アンマウント後に走り続けない）', async () => {
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    ac.abort()
    await vi.advanceTimersByTimeAsync(PREFETCH_REFRESH_MS * 2)
    expect(fetchMock()).not.toHaveBeenCalled()
    // 周期タイマーそのものが消えていること。`signal.aborted` を見て早期 return するだけでは
    // fetch は飛ばないが、地図を作り直すたびにタイマーが積み上がる。
    expect(vi.getTimerCount()).toBe(0)
  })

  it('データセーバーが有効なら 1 件も投げない', () => {
    vi.stubGlobal('navigator', { connection: { saveData: true } })
    const ac = new AbortController()
    startBathymetryPrefetch(ac.signal)
    vi.advanceTimersByTime(DRAIN_MS)
    expect(fetchMock()).not.toHaveBeenCalled()
    ac.abort()
  })
})

describe('shouldSkipPrefetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('navigator.connection が無い場合はスキップしない', () => {
    vi.stubGlobal('navigator', {})
    expect(shouldSkipPrefetch()).toBe(false)
  })

  it('saveData が true の場合はスキップする', () => {
    vi.stubGlobal('navigator', { connection: { saveData: true } })
    expect(shouldSkipPrefetch()).toBe(true)
  })

  it('effectiveType が 2g の場合はスキップする', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '2g' } })
    expect(shouldSkipPrefetch()).toBe(true)
  })

  it('effectiveType が 4g の場合はスキップしない', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g' } })
    expect(shouldSkipPrefetch()).toBe(false)
  })
})
