// 「何も変えないカメラ更新を省く」差し替えの検証。
//
// **見たいのは、省くのをやめる側の判断**。省略が効くこと自体は 1 本で足りるが、前提が崩れたときに
// 黙って省き続けると、カメラの状態が更新されないまま画面だけが進むという最も追いにくい壊れ方をする。
// そのため「地形がある」「利用側の補正がある」「本体でない transform を渡された」「傾き・標高が
// 条件外」「実際に状態が変わった」「状態を読み切れない」の 6 通りを、それぞれ独立に確かめる。
//
// 併せて**見張りが恒久的であること**も固定する。起動直後に数回確かめて終わりにすると、MapLibre を
// 上げて条件が増えたとき、その数回でたまたま空振りなら気づかないまま省き続けることになる。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { installNoopCameraUpdateSkip } from './skipNoopCameraUpdate'

/**
 * GlobeTransform が実際に返す形（数値・Float64Array・中心）を最小限まねる。
 *
 * **回転行列は持たせない。** 実機でも地図を一度も回していない間は存在しないので、そちらが既定。
 * 検査がこの状態で成立することが要（成立しないと、回さない使い方で省略が永久に効かない）。
 */
function makeTransform(overrides: Record<string, unknown> = {}) {
  const mat = (seed: number) => new Float64Array(16).fill(seed)
  return {
    zoom: 5,
    bearing: 0,
    pitch: 45,
    roll: 0,
    elevation: 0,
    nearZ: 1,
    farZ: 1000,
    cameraToCenterDistance: 800,
    scale: 32,
    worldSize: 8192,
    modelViewProjectionMatrix: mat(1),
    projectionMatrix: mat(2),
    inverseProjectionMatrix: mat(3),
    pixelsToClipSpaceMatrix: mat(4),
    clipSpaceToPixelsMatrix: mat(5),
    pixelsToGLUnits: [0.1, -0.2],
    center: { lng: 139, lat: 35 },
    ...overrides,
  }
}

/**
 * MapLibre の Map と Camera のうち、この差し替えが触る部分だけ持つフェイク。
 *
 * `onCall` は本物の `applyUpdatedTransform` の代わり。省略が効いているかは呼ばれた回数で見る。
 */
function makeMap(opts: {
  transform?: ReturnType<typeof makeTransform>
  terrain?: unknown
  transformCameraUpdate?: unknown
  onCall?: (tr: unknown) => void
}) {
  const transform = opts.transform ?? makeTransform()
  const calls: unknown[] = []
  const camera = {
    transform,
    terrain: opts.terrain,
    transformCameraUpdate: opts.transformCameraUpdate,
    applyUpdatedTransform(tr: unknown) {
      calls.push(tr)
      opts.onCall?.(tr)
    },
  }
  const map = { _camera: camera } as unknown as MapLibreMap
  return { map, camera, transform, calls }
}

/**
 * この差し替えが出した警告だけを数える。
 *
 * `console.warn` の総数では数えない —— アプリ時計の未較正警告など、この差し替えと無関係な
 * 記録が同じ口から出るため（数えると、そちらが増減しただけでテストが落ちる）。
 */
function ownWarnings(): number {
  const spy = console.warn as unknown as { mock: { calls: unknown[][] } }
  return spy.mock.calls.filter((args) =>
    args.some((a) => typeof a === 'string' && a.includes('カメラ更新の空振り省略'))
  ).length
}

/** 差し替え後の呼び口。`camera.applyUpdatedTransform` は差し替えで置き換わる。 */
function fire(camera: { applyUpdatedTransform?: (tr: unknown) => void }, tr: unknown, times = 1) {
  for (let i = 0; i < times; i++) camera.applyUpdatedTransform?.call(camera, tr)
}

describe('installNoopCameraUpdateSkip', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('状態が変わらないと確かめたあとは本物を呼ばなくなる', () => {
    const { map, camera, transform, calls } = makeMap({})
    installNoopCameraUpdateSkip(map)
    // 検証のあいだ（8 回）は本物を走らせる。
    fire(camera, transform, 8)
    expect(calls).toHaveLength(8)
    // 以降は省く。
    fire(camera, transform, 20)
    expect(calls).toHaveLength(8)
  })

  it('回転行列を持つ地図（一度でも回した後）でも省略に入る', () => {
    const rotated = makeTransform({ bearing: 35, rotationMatrix: new Float64Array(4).fill(6) })
    const { map, camera, transform, calls } = makeMap({ transform: rotated })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 8)
    expect(calls).toHaveLength(8)
    fire(camera, transform, 20)
    expect(calls).toHaveLength(8)
    expect(ownWarnings()).toBe(0)
  })

  it('地形があるあいだは省かない', () => {
    const { map, camera, transform, calls } = makeMap({ terrain: {} })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 12)
    expect(calls).toHaveLength(12)
  })

  it('利用側のカメラ補正があるあいだは省かない', () => {
    const { map, camera, transform, calls } = makeMap({ transformCameraUpdate: () => ({}) })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 12)
    expect(calls).toHaveLength(12)
  })

  it('本体でない transform を渡されたら省かない', () => {
    // 地形や利用側の補正があるとき、MapLibre は本体ではなく複製を渡してくる。
    // その複製への書き戻しは本物の更新なので、取り違えるとカメラが動かなくなる。
    const { map, camera, calls } = makeMap({})
    installNoopCameraUpdateSkip(map)
    const other = makeTransform()
    fire(camera, other, 12)
    expect(calls).toHaveLength(12)
  })

  it('傾きが 90 度を超えていたら省かない', () => {
    const { map, camera, transform, calls } = makeMap({ transform: makeTransform({ pitch: 95 }) })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 12)
    expect(calls).toHaveLength(12)
  })

  it('標高が負なら省かない', () => {
    const { map, camera, transform, calls } = makeMap({ transform: makeTransform({ elevation: -10 }) })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 12)
    expect(calls).toHaveLength(12)
  })

  it('検証中に状態が変わったら、以後は二度と省かない', () => {
    // MapLibre の実装が変わって「空振りではなくなった」場合を模す。
    const transform = makeTransform()
    const { map, camera, calls } = makeMap({
      transform,
      onCall: () => {
        transform.zoom += 1
      },
    })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 30)
    // 1 回目で不一致を検出し、以降はすべて本物へ通す（検証の回数で打ち切らない）。
    expect(calls).toHaveLength(30)
    expect(ownWarnings()).toBe(1)
  })

  it('状態を読み切れないうちは検査に数えず、そのまま本物へ通す', () => {
    // 地図の組み立て中は行列がまだ埋まっていない呼び出しがある。**そこで見限らない**
    // （数フレーム後には揃うため、1 回の不足で永久に無効化すると省略が二度と効かない）。
    const bare = { zoom: 5, pitch: 45, elevation: 0, center: { lng: 139, lat: 35 } } as unknown as ReturnType<typeof makeTransform>
    const { map, camera, calls } = makeMap({ transform: bare })
    installNoopCameraUpdateSkip(map)
    fire(camera, bare, 12)
    expect(calls).toHaveLength(12)
    expect(ownWarnings()).toBe(0)
  })

  it('状態を読み切れない形が続いたら諦めて記録を残す', () => {
    const bare = { zoom: 5, pitch: 45, elevation: 0, center: { lng: 139, lat: 35 } } as unknown as ReturnType<typeof makeTransform>
    const { map, camera, calls } = makeMap({ transform: bare })
    installNoopCameraUpdateSkip(map)
    fire(camera, bare, 250)
    expect(calls).toHaveLength(250)
    // 記録は 1 度きり（毎フレーム出すとログが埋まる）。
    expect(ownWarnings()).toBe(1)
  })

  it('途中まで読み切れなくても、揃えばそこから検査して省略に入る', () => {
    // 実機で起きた形。最初の数回は項目が足りず、あとから揃う。
    const partial = { zoom: 5, pitch: 45, elevation: 0, center: { lng: 139, lat: 35 } } as unknown as ReturnType<typeof makeTransform>
    const full = makeTransform()
    const camState: { transform: ReturnType<typeof makeTransform> } = { transform: partial }
    const calls: unknown[] = []
    const camera = {
      get transform() { return camState.transform },
      terrain: undefined,
      transformCameraUpdate: undefined,
      applyUpdatedTransform(tr: unknown) { calls.push(tr) },
    }
    const map = { _camera: camera } as unknown as MapLibreMap
    installNoopCameraUpdateSkip(map)
    fire(camera, partial, 3)
    expect(calls).toHaveLength(3)
    camState.transform = full
    fire(camera, full, 8)
    expect(calls).toHaveLength(11)
    // ここから省く。
    fire(camera, full, 10)
    expect(calls).toHaveLength(11)
    expect(ownWarnings()).toBe(0)
  })

  it('省略に入った後も一定間隔で本物と突き合わせ続ける', () => {
    // ここが 1 度きりだと、MapLibre を上げて補正の条件が増えたとき、起動直後の数回で
    // たまたま空振りなら気づかないまま省き続けることになる。
    const { map, camera, transform, calls } = makeMap({})
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 8)
    expect(calls).toHaveLength(8)
    // 500 回省いた次の 1 回で本物が走る。
    fire(camera, transform, 501)
    expect(calls).toHaveLength(9)
    fire(camera, transform, 501)
    expect(calls).toHaveLength(10)
  })

  it('見張りの再開後に状態が変わっていたら、そこで省略をやめる', () => {
    // 省略に入った後で前提が崩れる場合。**起動直後だけ見ていると捕まらない**穴。
    const transform = makeTransform()
    let breaks = false
    const { map, camera, calls } = makeMap({
      transform,
      onCall: () => { if (breaks) transform.zoom += 1 },
    })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 8)
    expect(calls).toHaveLength(8)
    breaks = true
    fire(camera, transform, 501)
    // 500 回省いた次の見張りで気づく。以後はすべて本物へ通す。
    expect(calls).toHaveLength(9)
    fire(camera, transform, 20)
    expect(calls).toHaveLength(29)
    expect(ownWarnings()).toBe(1)
  })

  it('transform 自体が差し替わったら確認をやり直す', () => {
    // MapLibre は style の投影が決まる時点で transform を別の実装へ挿げ替える。
    // 前の実体で得た確認を持ち越すと、新しい実体を一度も確かめないまま省くことになる。
    const first = makeTransform()
    const second = makeTransform({ zoom: 8 })
    const camState = { transform: first as ReturnType<typeof makeTransform> }
    const calls: unknown[] = []
    const camera = {
      get transform() { return camState.transform },
      terrain: undefined,
      transformCameraUpdate: undefined,
      applyUpdatedTransform(tr: unknown) { calls.push(tr) },
    }
    const map = { _camera: camera } as unknown as MapLibreMap
    installNoopCameraUpdateSkip(map)
    fire(camera, first, 12)
    expect(calls).toHaveLength(8)
    camState.transform = second
    fire(camera, second, 12)
    // 新しい実体に対してもう一度 8 回確かめる。
    expect(calls).toHaveLength(16)
  })

  it('傾きが 90 度ちょうどなら省く（MapLibre 側の条件と同じ境界）', () => {
    const { map, camera, transform, calls } = makeMap({ transform: makeTransform({ pitch: 90 }) })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 8)
    expect(calls).toHaveLength(8)
    fire(camera, transform, 20)
    expect(calls).toHaveLength(8)
  })

  it('標高が 0 ちょうどなら省く', () => {
    const { map, camera, transform, calls } = makeMap({ transform: makeTransform({ elevation: 0 }) })
    installNoopCameraUpdateSkip(map)
    fire(camera, transform, 8)
    expect(calls).toHaveLength(8)
    fire(camera, transform, 20)
    expect(calls).toHaveLength(8)
  })

  it('効き具合を読み取れる', () => {
    const { map, camera, transform } = makeMap({})
    const { status } = installNoopCameraUpdateSkip(map)
    expect(status()).toMatchObject({ engaged: false, disabled: false, verified: 0, skipped: 0 })
    fire(camera, transform, 8)
    expect(status()).toMatchObject({ engaged: true, disabled: false, verified: 8, skipped: 0 })
    fire(camera, transform, 5)
    expect(status()).toMatchObject({ engaged: true, skipped: 5 })
  })

  it('戻す関数で元の実装に戻る', () => {
    const { map, camera, transform, calls } = makeMap({})
    const original = camera.applyUpdatedTransform
    const { restore } = installNoopCameraUpdateSkip(map)
    expect(camera.applyUpdatedTransform).not.toBe(original)
    restore()
    expect(camera.applyUpdatedTransform).toBe(original)
    fire(camera, transform, 20)
    expect(calls).toHaveLength(20)
  })

  it('別のものへ差し替えられていたら戻さない', () => {
    // 後から誰かが同じ場所を差し替えていた場合、こちらの控えで上書きするとその差し替えが消える。
    const { map, camera } = makeMap({})
    const { restore } = installNoopCameraUpdateSkip(map)
    const later = () => {}
    camera.applyUpdatedTransform = later
    restore()
    expect(camera.applyUpdatedTransform).toBe(later)
  })

  it('MapLibre の内部形が想定と違えば何もせず、そのことを記録する', () => {
    const map = {} as unknown as MapLibreMap
    const { restore, status } = installNoopCameraUpdateSkip(map)
    expect(ownWarnings()).toBe(1)
    expect(status()).toMatchObject({ engaged: false, disabled: true })
    expect(() => restore()).not.toThrow()
  })
})
