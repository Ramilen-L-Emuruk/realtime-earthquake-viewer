// @vitest-environment jsdom
//
// useKyoshinDetectorV2 の「結線」のテスト。検知そのものは kyoshinDetector.test.ts で見ているため、
// ここで見るのは React ラッパーが持つ 2 つの守り:
//   1. 観測点集合が変わったことを取りこぼさないか（近傍メタのキャッシュ判定）
//   2. step() が壊れ続けたときに、凍結した結果を表示に流し続けないか
// どちらも「静かに劣化する」タイプの問題で、検知コアの単体テストでは捉えられない。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { siteSignature, RESULT_STALL_RESET_FRAMES, useKyoshinDetectorV2 } from './useKyoshinDetectorV2'
import * as detector from '../utils/kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'

describe('siteSignature: 観測点集合の変化を取りこぼさない', () => {
  it('点数・先頭・末尾が同じでも、中間が差し替わればシグネチャが変わる', () => {
    // 以前は「点数＋先頭・末尾座標」だけで判定していたため、この差し替えを検知できなかった。
    // 検知できないと古い近傍メタ（＝観測点キーの割り当て）を使い続け、表示側が毎回作り直す
    // キーとずれる（座標が重複する観測点で `#2` の割り当て順が変わりうる）。
    const before: SiteCoords = [[35.0, 139.0], [36.0, 140.0], [37.0, 141.0]]
    const after: SiteCoords = [[35.0, 139.0], [36.5, 140.5], [37.0, 141.0]]
    expect(siteSignature(before)).not.toBe(siteSignature(after))
  })

  it('同じ内容なら別配列でも同じシグネチャ（無駄な近傍メタ再構築を避ける）', () => {
    const a: SiteCoords = [[35.0, 139.0], [36.0, 140.0]]
    const b: SiteCoords = [[35.0, 139.0], [36.0, 140.0]]
    expect(siteSignature(a)).toBe(siteSignature(b))
  })

  it('空配列は空文字', () => {
    expect(siteSignature([])).toBe('')
  })

  it('座標の丸め単位（約100m）より細かい違いは同一とみなす', () => {
    // siteKey は小数第3位で丸める。sitelist 更新時の丸め誤差で別集合と誤判定しないため。
    const a: SiteCoords = [[35.00001, 139.00001]]
    const b: SiteCoords = [[35.00002, 139.00002]]
    expect(siteSignature(a)).toBe(siteSignature(b))
  })

  it('座標が重複する点の位置が動けばシグネチャが変わる（#2 の割り当てが変わるため）', () => {
    // 同じ 3 点でも、重複する 2 点が隣り合うか離れるかで `computeSiteKeys` の割り当てが変わる。
    // 座標を並べるだけの署名でもこの差は現れる（並びが違えば文字列が違う）。
    const adjacent: SiteCoords = [[35.0, 139.0], [35.0, 139.0], [36.0, 140.0]]
    const apart: SiteCoords = [[35.0, 139.0], [36.0, 140.0], [35.0, 139.0]]
    expect(siteSignature(adjacent)).not.toBe(siteSignature(apart))
  })

})

describe('useKyoshinDetectorV2: step() が壊れ続けたら検知結果を空にする', () => {
  const sites: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
  const indices = [12, 12, 12]

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  /** dataTime を進めながらフックを再レンダーする（step() は dataTime 更新でのみ走る）。 */
  function driveFrames(count: number, startMs = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    const { result, rerender } = renderHook(
      ({ t }: { t: string }) => useKyoshinDetectorV2(sites, indices, t, 'cfg', 'cfg', true, false),
      { initialProps: { t: new Date(startMs).toISOString() } },
    )
    for (let i = 1; i < count; i++) {
      rerender({ t: new Date(startMs + i * 1000).toISOString() })
    }
    return result
  }

  it('連続失敗が閾値に達したら detections と recentOnsetKeys を空にする', () => {
    const spy = vi.spyOn(detector, 'step').mockImplementation(() => {
      throw new Error('boom')
    })
    const result = driveFrames(RESULT_STALL_RESET_FRAMES + 1)
    expect(spy).toHaveBeenCalled()
    expect(result.current.detections).toEqual([])
    expect(result.current.recentOnsetKeys.size).toBe(0)
    // 例外側も「判らなくなった」ことを伝える（発報側が復帰で鳴らし直さないために要る）
    expect(result.current.stalled).toBe(true)
  })

  it('閾値に達する前の一過性の失敗では直前の結果を保持する（明滅させない）', () => {
    const real = detector.step
    let calls = 0
    vi.spyOn(detector, 'step').mockImplementation((state, frame, meta) => {
      calls++
      // 1フレーム目は成功させて結果を持たせ、以降は閾値未満だけ失敗させる
      if (calls === 1) return real(state, frame, meta)
      throw new Error('boom')
    })
    const result = driveFrames(RESULT_STALL_RESET_FRAMES)
    // 1回成功 → (閾値-1)回失敗。まだリセットされないため dataTime は保持されている
    expect(result.current.dataTime).not.toBe('')
  })
})

describe('useKyoshinDetectorV2: 近傍メタのキャッシュ判定', () => {
  const indices = [12, 12, 12]

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  /** sites も差し替えられるハーネス。dataTime を進めて step() を走らせる。 */
  function drive(frames: { sites: SiteCoords; t: string }[]) {
    const { rerender } = renderHook(
      ({ sites, t }: { sites: SiteCoords; t: string }) =>
        useKyoshinDetectorV2(sites, indices, t, 'cfg', 'cfg', true, false),
      { initialProps: frames[0] },
    )
    for (const f of frames.slice(1)) rerender(f)
  }

  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()

  it('同じ内容の別配列では近傍メタを組み直さない（O(点数²) を走らせない）', () => {
    const spy = vi.spyOn(detector, 'buildStationMeta')
    const a: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
    const b: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]] // 同内容・別参照
    drive([{ sites: a, t: at(0) }, { sites: b, t: at(1) }])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('点数・先頭・末尾が同じでも中間が差し替わったら組み直す', () => {
    // 以前の簡易シグネチャ（点数＋先頭・末尾）はこの差し替えを取りこぼしていた。
    const spy = vi.spyOn(detector, 'buildStationMeta')
    const a: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
    const b: SiteCoords = [[35.0, 139.0], [36.5, 140.5], [35.2, 139.2]]
    drive([{ sites: a, t: at(0) }, { sites: b, t: at(1) }])
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

// 床（floors）の組み立て。震度0ドット表示のフィルタが位置で対応づけて使うため、ここが崩れると
// 「別の観測点の床で判定する」形の誤りになる（エラーも警告も出ない）。以前は座標から作ったキーの
// 辞書で受け渡していて、同一座標の 2 点目以降がグループ先頭の床で判定されていた。
describe('useKyoshinDetectorV2: 床は観測点の並びで返す', () => {
  const DUP: [number, number] = [35.0, 139.0]
  // 先頭 2 点が同一座標。同じ座標に複数の実観測点が載る Yahoo の観測点リストを模す。
  const sites: SiteCoords = [DUP, DUP, [36.0, 140.0]]
  // 先頭だけ強く揺れている状態（index12 = value 3.0）。2 点目・3 点目は静穏（index2 = value -2.0）。
  const indices = [12, 2, 2]

  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function driveFloors(count: number, values: number[] = indices) {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const { result, rerender } = renderHook(
      ({ t }: { t: string }) => useKyoshinDetectorV2(sites, values, t, 'cfg', 'cfg', true, false),
      { initialProps: { t: new Date(startMs).toISOString() } },
    )
    for (let i = 1; i < count; i++) rerender({ t: new Date(startMs + i * 1000).toISOString() })
    return result
  }

  it('観測点と同じ長さの配列を返す', () => {
    expect(driveFloors(2).current.floors).toHaveLength(sites.length)
  })

  it('同一座標の 2 点がそれぞれの床を持つ（先頭の床で上書きされない）', () => {
    const floors = driveFloors(3).current.floors
    expect(floors[0]).not.toBe(floors[1])
  })

  it('床は自分の観測値から作られる（隣の実体の値を拾わない）', () => {
    const floors = driveFloors(3).current.floors
    // 静穏な 2 点目・3 点目は同じ入力なので同じ床になる。揺れている先頭だけが離れる。
    // 値そのものは初回の観測で決まる（EWMA での収束は kyoshinDetector.test.ts の担当）。
    expect(floors[1]).toBe(floors[2])
    expect(floors[0]).toBeGreaterThan(floors[1])
  })

  it('大きな時刻の飛びの直後に欠測している点は、学習済みでも床を失う', () => {
    // 不連続リセット（`MAX_DT_GAP_MS` 超えの飛び・スリープ復帰やリプレイの巻き戻し）は ingest() を
    // 通る。ingest() は欠測点のキーを「以前の学習値があるか」を見ずに落とすため、通常フレームの
    // 欠測（学習値を引き継ぐ）とは扱いが違う。床の説明が挙げる 2 つ目の原因がこれ。
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const { result, rerender } = renderHook(
      ({ t, v }: { t: string; v: number[] }) =>
        useKyoshinDetectorV2(sites, v, t, 'cfg', 'cfg', true, false),
      { initialProps: { t: new Date(startMs).toISOString(), v: indices } },
    )
    // 3 点目もいったん観測して床を持たせる
    expect(result.current.floors[2]).not.toBe(0)
    // 時刻を大きく飛ばし、その回で 3 点目だけ欠測させる
    const jumped = startMs + detector.PARAMS.MAX_DT_GAP_MS + 1000
    rerender({ t: new Date(jumped).toISOString(), v: [12, 2, -1] })
    expect(result.current.floors[2]).toBe(0)
    // 欠測していない点は学習値を保つ
    expect(result.current.floors[1]).not.toBe(0)
  })

  it('一度も観測できていない欠測点の床は 0（学習前は表示しない側へ倒れる）', () => {
    // 負の index は欠測。state.sites にキーが立たないため、床は 0 で埋める。震度0ドットの
    // 対象（index 1〜6 ＝ value -2.5〜0.0）はどれも 0 + SUSTAIN_MARGIN に届かないので消える側。
    const floors = driveFloors(3, [12, 2, -1]).current.floors
    expect(floors).toHaveLength(sites.length)
    expect(floors[2]).toBe(0)
    // 観測できている点は 0 埋めされない（欠測の扱いが全点へ波及していないこと）
    expect(floors[1]).not.toBe(0)
  })

  it('floorsSites は床を計算した観測点配列と同一参照（位置対応が有効かの判定に使う）', () => {
    expect(driveFloors(2).current.floorsSites).toBe(sites)
  })

  it('step() が壊れ続けたら床も空にする（古い床を新しい観測点へ当てない）', () => {
    vi.spyOn(detector, 'step').mockImplementation(() => {
      throw new Error('boom')
    })
    const result = driveFloors(RESULT_STALL_RESET_FRAMES + 1)
    expect(result.current.floors).toEqual([])
    expect(result.current.floorsSites).toEqual([])
  })
})

// 観測点リストが差し替わってから床が追いつくまでの窓。ここを取り違えると、新しい観測点へ古い床を
// 当ててしまう（点数が偶然一致すると長さの検査では捕まらない）。呼び出し側はこの窓を `floorsSites`
// の参照比較で見分ける。
describe('useKyoshinDetectorV2: 床が追いつくまでは古い観測点配列を指す', () => {
  const a: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
  const b: SiteCoords = [[36.0, 140.0], [36.1, 140.1], [36.2, 140.2]] // 同じ点数・別の観測点
  const indices = [12, 12, 12]

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('データ時刻が進むまで floorsSites は差し替え前の配列のまま', () => {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const { result, rerender } = renderHook(
      ({ sites, t }: { sites: SiteCoords; t: string }) =>
        useKyoshinDetectorV2(sites, indices, t, 'cfg', 'cfg', true, false),
      { initialProps: { sites: a, t: new Date(startMs).toISOString() } },
    )
    expect(result.current.floorsSites).toBe(a)

    // 観測点だけ差し替える（step() はデータ時刻の更新でしか走らないため床は据え置かれる）
    rerender({ sites: b, t: new Date(startMs).toISOString() })
    expect(result.current.floorsSites).toBe(a)
    expect(result.current.floorsSites).not.toBe(b)

    // 次のデータ時刻で追いつく
    rerender({ sites: b, t: new Date(startMs + 1000).toISOString() })
    expect(result.current.floorsSites).toBe(b)
  })
})

// 観測点数と震度の件数が食い違うと step() へ入れず、揺れ検知が丸ごと止まる。例外ではないので
// 既存の catch も通らない——記録しないと平常時と見分けがつかない。
describe('useKyoshinDetectorV2: 観測点数と震度の件数が食い違うとき', () => {
  const sites: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]

  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function drive(values: number[], sitesCfg = 'cfg', indicesCfg = 'cfg', frames = 1) {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useKyoshinDetectorV2(sites, values, t, sitesCfg, indicesCfg, true, false),
      { initialProps: { t: new Date(startMs).toISOString() } },
    )
    for (let i = 1; i < frames; i++) rerender({ t: new Date(startMs + i * 1000).toISOString() })
  }

  it('記録に残す（検知が止まったことに気づけるように）', () => {
    drive([12, 12]) // 観測点は 3 点
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('食い違う'),
    )
  })

  it('件数が揃っていれば記録しない', () => {
    drive([12, 12, 12])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('siteConfigId が揃っていない間は記録しない（切替中は件数が違って当たり前）', () => {
    drive([12, 12], 'old', 'new')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('食い違いが続いても間引く（毎フレーム出さない）', () => {
    // 閾値に達すると「結果を空にする」側の記録が別に 1 本出るため、そこへ届かない回数で見る。
    drive([12, 12], 'cfg', 'cfg', RESULT_STALL_RESET_FRAMES - 1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  /** 正常フレームで結果を持たせてから、件数の食い違いを指定回数続ける。 */
  function stallAfterNormalFrame(mismatchFrames: number) {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const { result, rerender } = renderHook(
      ({ t, v }: { t: string; v: number[] }) =>
        useKyoshinDetectorV2(sites, v, t, 'cfg', 'cfg', true, false),
      { initialProps: { t: new Date(startMs).toISOString(), v: [12, 12, 12] } },
    )
    for (let i = 1; i <= mismatchFrames; i++) {
      rerender({ t: new Date(startMs + i * 1000).toISOString(), v: [12, 12] })
    }
    return result
  }

  it('食い違いが続いたら検知結果を空にする（凍結したまま音や地図へ流さない）', () => {
    const result = stallAfterNormalFrame(RESULT_STALL_RESET_FRAMES)
    expect(result.current.dataTime).toBe('')
    expect(result.current.detections).toEqual([])
    expect(result.current.floors).toEqual([])
  })

  it('空にしたことを stalled で伝える（発報側が「揺れが収まった」と区別するために要る）', () => {
    expect(stallAfterNormalFrame(RESULT_STALL_RESET_FRAMES).current.stalled).toBe(true)
  })

  it('閾値に達する前は直前の結果を保持する（一過性で明滅させない）', () => {
    const result = stallAfterNormalFrame(RESULT_STALL_RESET_FRAMES - 1)
    expect(result.current.dataTime).not.toBe('')
    expect(result.current.stalled).toBe(false)
  })

  it('例外と食い違いが混ざっても合算で数える（片方だけでは閾値に届かない場合）', () => {
    // 理由ごとにカウンタを分けると、交互に起きたときいつまでも凍結が解けない。
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const real = detector.step
    let calls = 0
    vi.spyOn(detector, 'step').mockImplementation((state, frame, meta) => {
      calls++
      if (calls === 1) return real(state, frame, meta) // 初回だけ成功させて結果を持たせる
      throw new Error('boom')
    })
    const { result, rerender } = renderHook(
      ({ t, v }: { t: string; v: number[] }) =>
        useKyoshinDetectorV2(sites, v, t, 'cfg', 'cfg', true, false),
      { initialProps: { t: new Date(startMs).toISOString(), v: [12, 12, 12] } },
    )
    // 例外を 2 回（件数は揃えて step() まで通す）
    rerender({ t: new Date(startMs + 1000).toISOString(), v: [12, 12, 12] })
    rerender({ t: new Date(startMs + 2000).toISOString(), v: [12, 12, 12] })
    expect(result.current.dataTime).not.toBe('')
    // 続けて件数の食い違いを 3 回。合算で閾値に達する
    for (let i = 3; i <= 5; i++) {
      rerender({ t: new Date(startMs + i * 1000).toISOString(), v: [12, 12] })
    }
    expect(result.current.dataTime).toBe('')
  })
})
