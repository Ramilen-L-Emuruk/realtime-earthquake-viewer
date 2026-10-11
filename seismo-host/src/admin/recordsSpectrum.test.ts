import { describe, expect, it } from 'vitest'

import type { SampleRunView } from './recordsPlot'
import {
  NHNM,
  NLNM,
  NOISE_MODEL_LEGEND,
  NOISE_TITLE,
  SPECTRUM_EMPTY_TEXT,
  SPECTRUM_TITLE,
  binAt,
  colorOfDb,
  colorScaleCss,
  dbExtent,
  dbRange,
  dbScaleText,
  formatNoise,
  hzOfY,
  noiseHeader,
  noiseModelCurve,
  noiseModelDb,
  noiseOfEnvelopeColumns,
  noiseRange,
  psdToDb,
  readSpectrogramData,
  readSpectrumData,
  secondRms,
  spectrogramHeader,
  spectrogramDbAt,
  spectrogramPixels,
  spectrogramReadout,
  spectrogramTitle,
  type SpectrogramData,
  spectrumHeader,
  spectrumReadout,
  yOfHz,
} from './recordsSpectrum'

const EDGES = [0.1, 1, 10, 50]

describe('psdToDb', () => {
  it('gal²/Hz は (m/s²)²/Hz へ直してから dB にする（1 gal = 0.01 m/s²）', () => {
    expect(psdToDb(1, 'gal')).toBeCloseTo(-40, 9)
    expect(psdToDb(1e-4, 'gal')).toBeCloseTo(-80, 9)
  })

  it('カウントはそのまま（0 dB = 1 カウント²/Hz）', () => {
    expect(psdToDb(100, 'count')).toBeCloseTo(20, 9)
  })

  it('0 以下・有限でない値は NaN（対数が取れない）', () => {
    expect(psdToDb(0, 'gal')).toBeNaN()
    expect(psdToDb(-1, 'gal')).toBeNaN()
    expect(psdToDb(Number.NaN, 'gal')).toBeNaN()
  })
})

describe('Peterson（1993）のノイズのモデル', () => {
  it('表は原典の Table 3・4 の行の数と端の値を持つ', () => {
    expect(NLNM).toHaveLength(21)
    expect(NHNM).toHaveLength(11)
    expect(NLNM[0]).toEqual([0.1, -162.36, 5.64])
    expect(NLNM[20]).toEqual([10000, -346.88, 48.75])
    expect(NHNM[0]).toEqual([0.1, -108.73, -17.23])
    expect(NHNM[10]).toEqual([354.8, -206.66, 31.63])
  })

  it('周期の帯ごとに A + B log10(P) を返す', () => {
    // 周期 1 秒は NLNM の 0.80〜1.24 の行、NHNM の 0.80〜3.80 の行
    expect(noiseModelDb(NLNM, 1)).toBeCloseTo(-166.4, 9)
    expect(noiseModelDb(NHNM, 1)).toBeCloseTo(-116.85, 9)
    // 0.1 秒ちょうどは最初の行
    expect(noiseModelDb(NLNM, 0.1)).toBeCloseTo(-162.36 - 5.64, 9)
    // 周期 5 秒は NLNM の 5.00 の行（4.30 の行ではない）
    expect(noiseModelDb(NLNM, 5)).toBeCloseTo(-71.36 - 99.77 * Math.log10(5), 9)
  })

  it('表の外（0.1 秒より短い・100000 秒以上）は NaN', () => {
    expect(noiseModelDb(NLNM, 0.05)).toBeNaN()
    expect(noiseModelDb(NHNM, 100_000)).toBeNaN()
  })

  it('周波数の範囲で線を作り、表の外の周波数（10 Hz より上）は含めない', () => {
    const curve = noiseModelCurve(NLNM, 0.1, 50, 200)
    expect(curve.length).toBeGreaterThan(10)
    expect(curve.every((p) => p.hz <= 10 + 1e-9 && Number.isFinite(p.db))).toBe(true)
    expect(curve[0]!.hz).toBeCloseTo(0.1, 9)
    expect(curve[curve.length - 1]!.hz).toBeCloseTo(10, 6)
  })
})

describe('readSpectrumData', () => {
  const body = { channel: 'x', source: 'samples', unit: 'gal', binEdgesHz: EDGES, power: [1, null, 0.5], segments: 58, problems: { skippedBytes: 0, badRecords: 0, unscaledHours: 0 } }

  it('区画の値を読み、null は NaN にする', () => {
    const got = readSpectrumData(body)!
    expect(got.source).toBe('samples')
    expect(got.segments).toBe(58)
    expect(got.power[0]).toBe(1)
    expect(got.power[1]).toBeNaN()
  })

  it('区画の数が境目と合わなければ読まない', () => {
    expect(readSpectrumData({ ...body, power: [1, 2] })).toBeNull()
    expect(readSpectrumData({ ...body, source: 'other' })).toBeNull()
  })
})

describe('readSpectrogramData', () => {
  const body = {
    channel: 'x',
    source: 'minutes',
    unit: 'gal',
    binEdgesHz: EDGES,
    columnMs: 60_000,
    firstColumnMs: 1_000_000,
    segments: [11, 0],
    power: [
      [1, 2, 3],
      [null, null, null],
    ],
    hours: { ok: 1, stale: 0, pending: 1, failed: 0, absent: 0 },
    irregularHours: [{ hourStartMs: 3_600_000, state: 'pending' }],
    files: null,
    problems: { skippedBytes: 0, badRecords: 0, unscaledHours: 0 },
  }

  it('列と区画を読み、要約がまだ無い時も読む', () => {
    const got = readSpectrogramData(body)!
    expect(got.columnMs).toBe(60_000)
    expect(got.power[1]![0]).toBeNaN()
    expect(got.irregularHours).toEqual([{ hourStartMs: 3_600_000, state: 'pending' }])
  })

  it('列の行の長さが区画の数と合わなければ読まない', () => {
    expect(readSpectrogramData({ ...body, power: [[1, 2], [3]] })).toBeNull()
    expect(readSpectrogramData({ ...body, segments: [1] })).toBeNull()
  })

  it('周波数の境目が 0 以下なら読まない（対数で描くので、通すと絵が黙って全部透明になる）', () => {
    expect(readSpectrogramData({ ...body, binEdgesHz: [0, ...EDGES.slice(1)] })).toBeNull()
    expect(readSpectrogramData({ ...body, binEdgesHz: [-1, ...EDGES.slice(1)] })).toBeNull()
    // 対照: 正の境目は読む
    expect(readSpectrogramData(body)).not.toBeNull()
  })

  it('1 分ごとの PSD から作ったときは、時の数えをそのまま読む', () => {
    expect(readSpectrogramData(body)!.hours).toEqual({ ok: 1, stale: 0, pending: 1, failed: 0, absent: 0 })
  })

  it('生のサンプルから作ったときは、読んだ元のファイルの数えを時の数えへ直して読む（状態の行の「読めない時」に足すため）', () => {
    const got = readSpectrogramData({ ...body, source: 'samples', hours: null, irregularHours: [], files: { read: 10, missing: 1, failed: 2 } })!
    expect(got.hours).toEqual({ ok: 10, stale: 0, pending: 0, failed: 2, absent: 1 })
  })

  it('作り方に合う数えが無ければ読まない（黙って「読めない時は無い」にしない）', () => {
    expect(readSpectrogramData({ ...body, hours: null })).toBeNull()
    expect(readSpectrogramData({ ...body, source: 'samples', hours: null, files: null })).toBeNull()
    expect(readSpectrogramData({ ...body, source: 'samples', hours: null, files: { read: 1, missing: 0 } })).toBeNull()
  })
})

describe('binAt', () => {
  it('周波数の入る区画を返し、範囲の外は -1', () => {
    expect(binAt(EDGES, 0.5)).toBe(0)
    expect(binAt(EDGES, 1)).toBe(1)
    expect(binAt(EDGES, 49.9)).toBe(2)
    expect(binAt(EDGES, 0.05)).toBe(-1)
    expect(binAt(EDGES, 50.01)).toBe(-1)
  })

  it('最後の区画だけ上端ちょうどを含む（枠の端を指しても読み取りが消えない）。途中の境目は上の区画へ', () => {
    expect(binAt(EDGES, 50)).toBe(2)
    expect(binAt(EDGES, 1)).toBe(1)
  })
})

describe('yOfHz・hzOfY', () => {
  it('対数で 0.1 Hz を下端、50 Hz を上端に置き、互いに逆になる', () => {
    expect(yOfHz(0.1, 100)).toBeCloseTo(100, 9)
    expect(yOfHz(50, 100)).toBeCloseTo(0, 9)
    expect(hzOfY(yOfHz(2.4, 100), 100)).toBeCloseTo(2.4, 9)
  })
})

describe('dbRange', () => {
  it('外れ値を外し（下から 2%・上から 2%）、5 dB に丸めて外へ広げる', () => {
    const values = [...Array.from({ length: 98 }, (_, i) => -130 + (i / 97) * 30), -300, 0]
    const r = dbRange(values)!
    expect(r.lo).toBe(-130)
    expect(r.hi).toBe(-100)
  })

  it('幅が 10 dB に満たなければ 10 dB へ広げ、有限でない値は数えない', () => {
    const r = dbRange([-120, -119, Number.NaN])!
    expect(r.hi - r.lo).toBeGreaterThanOrEqual(10)
    expect(r.lo).toBeLessThanOrEqual(-120)
    expect(r.hi).toBeGreaterThanOrEqual(-119)
  })

  it('値が 1 つも無ければ null', () => {
    expect(dbRange([Number.NaN])).toBeNull()
  })
})

describe('dbExtent', () => {
  it('外れ値を外さず、10 dB に丸めて外へ広げる（範囲のスペクトルの縦。モデルの線も入るように）', () => {
    expect(dbExtent([-171.2, -95.4, Number.NaN])).toEqual({ lo: -180, hi: -90 })
    expect(dbExtent([-100, -100])).toEqual({ lo: -110, hi: -90 })
    expect(dbExtent([])).toBeNull()
  })
})

describe('colorScaleCss', () => {
  it('色の並びをそのまま左から右へ並べる', () => {
    const css = colorScaleCss()
    expect(css.startsWith('linear-gradient(to right, rgb(68, 1, 84)')).toBe(true)
    expect(css.endsWith('rgb(253, 231, 37))')).toBe(true)
  })
})

describe('colorOfDb', () => {
  it('下端は濃い紫、上端は黄色で、範囲の外は端の色に留める', () => {
    const r = { lo: -150, hi: -90 }
    expect(colorOfDb(-150, r)).toEqual([68, 1, 84])
    expect(colorOfDb(-90, r)).toEqual([253, 231, 37])
    expect(colorOfDb(-200, r)).toEqual([68, 1, 84])
    expect(colorOfDb(0, r)).toEqual([253, 231, 37])
  })

  it('値が無ければ null（その升は描かない）', () => {
    expect(colorOfDb(Number.NaN, { lo: -150, hi: -90 })).toBeNull()
  })
})

describe('spectrogramPixels', () => {
  // 区画 2 つ（0.1〜50 Hz を対数で半分ずつ）・列 2 本（1 秒ずつ）。カウントの単位なので dB = 10 log10(値)
  const EDGES2 = [0.1, 0.1 * Math.sqrt(500), 50]
  const gram = (power: number[][]): SpectrogramData => ({
    source: 'samples',
    unit: 'count',
    binEdgesHz: EDGES2,
    columnMs: 1000,
    firstColumnMs: 0,
    segments: power.map(() => 1),
    power,
    irregularHours: [],
    problems: { skippedBytes: 0, badRecords: 0, unscaledHours: 0 },
    hours: { ok: 1, stale: 0, pending: 0, failed: 0, absent: 0 },
  })
  const DBR = { lo: 0, hi: 20 }
  // 画素 x の中心の時刻は −25 + 50x ミリ秒 → x = 10 が列 0 の中心（500 ms）、x = 30 が列 1 の中心、x = 20 がその間
  const R = { fromMs: -25, toMs: 1975 }
  const W = 40
  // 高さ 42 → 画素 y の中心は y + 0.5。区画 1（上）の中心は y = 10、区画 0（下）の中心は y = 31
  const H = 42
  const at = (data: Uint8ClampedArray, x: number, y: number): number[] => Array.from(data.slice((y * W + x) * 4, (y * W + x) * 4 + 4))
  const rgba = (db: number): number[] => [...colorOfDb(db, DBR)!, 255]

  it('列と区画の中心の画素は、その升の値の色のまま', () => {
    const px = spectrogramPixels(gram([[1, 10], [100, 100]]), DBR, R, W, H)
    expect(at(px, 10, 10)).toEqual(rgba(10))
    expect(at(px, 10, 31)).toEqual(rgba(0))
    expect(at(px, 30, 10)).toEqual(rgba(20))
  })

  it('列の中心の間は dB で補ってから色を引く（色どうしを混ぜると凡例に無い色になる）', () => {
    const px = spectrogramPixels(gram([[1, 1], [100, 100]]), DBR, R, W, H)
    // 0 dB と 20 dB のちょうど間 → 10 dB の色。両端の色を RGB で平均した色（[161, 116, 61]）ではない
    expect(at(px, 20, 10)).toEqual(rgba(10))
    expect(at(px, 20, 10).slice(0, 3)).not.toEqual([161, 116, 61])
  })

  it('区画の中心の間も、周波数の対数で補う', () => {
    const px = spectrogramPixels(gram([[1, 100], [1, 100]]), DBR, R, W, H)
    // y = 20 の中心（20.5）は、縦の位置で区画 0 の中心から 0.5238… の所
    const frac = (1 - 20.5 / H - 0.25) / 0.5
    expect(at(px, 10, 20)).toEqual(rgba(20 * frac))
  })

  it('測れない升は混ぜない: その升の画素は透明、隣の画素は測れた升だけで補う', () => {
    const px = spectrogramPixels(gram([[1, 1], [Number.NaN, Number.NaN]]), DBR, R, W, H)
    // 列 1 に入る画素（x ≥ 20）は透明
    expect(at(px, 25, 10)[3]).toBe(0)
    expect(at(px, 20, 10)[3]).toBe(0)
    // 列 0 の中心より右（列 1 の方へ寄った所）も、列 0 の値だけで塗る
    expect(at(px, 15, 10)).toEqual(rgba(0))
  })

  it('列の無い時刻は透明で、端の列の外側半分は端の列の値のまま', () => {
    const px = spectrogramPixels(gram([[1, 1], [100, 100]]), DBR, { fromMs: -1025, toMs: 2975 }, W, H)
    // 画素 x の中心の時刻は −1025 + 100(x + 0.5) → x = 9 は −75 ms（列の前）、x = 10 は 25 ms（列 0 の中心より前）
    expect(at(px, 9, 10)[3]).toBe(0)
    expect(at(px, 10, 10)).toEqual(rgba(0))
    // x = 29 は 1925 ms（列 1 の中心より後）、x = 30 は 2025 ms（列の後）
    expect(at(px, 29, 10)).toEqual(rgba(20))
    expect(at(px, 30, 10)[3]).toBe(0)
  })

  describe('spectrogramDbAt（指した所の値）', () => {
    it('どの画素でも、絵の色はその位置の値の色と一致し、値が無い所だけ透明', () => {
      const g = gram([[1, 10], [Number.NaN, 100]])
      const px = spectrogramPixels(g, DBR, R, W, H)
      for (let x = 0; x < W; x += 1) {
        for (let y = 0; y < H; y += 1) {
          const db = spectrogramDbAt(g, R.fromMs + ((x + 0.5) / W) * (R.toMs - R.fromMs), hzOfY(y + 0.5, H))
          if (Number.isNaN(db)) expect(at(px, x, y)[3]).toBe(0)
          else expect(at(px, x, y)).toEqual(rgba(db))
        }
      }
    })

    it('列の境目では、真下の升の値ではなく補った値を返す', () => {
      // 1000 ms は列 1 の頭。升のままなら 20 dB、補えば列 0 と列 1 の中心のちょうど間で 10 dB
      expect(spectrogramDbAt(gram([[1, 1], [100, 100]]), 1000, 0.1 * Math.sqrt(500) * 2)).toBeCloseTo(10, 9)
    })

    it('升の中心では升の値のまま、列・区画の外は値なし', () => {
      const g = gram([[1, 10], [100, 100]])
      const upperCenter = Math.sqrt(0.1 * Math.sqrt(500) * 50)
      expect(spectrogramDbAt(g, 500, upperCenter)).toBeCloseTo(10, 9)
      expect(spectrogramDbAt(g, -1, upperCenter)).toBeNaN()
      expect(spectrogramDbAt(g, 2000, upperCenter)).toBeNaN()
      expect(spectrogramDbAt(g, 500, 60)).toBeNaN()
    })
  })
})

describe('secondRms', () => {
  function run(firstSampleMs: number, values: number[]): SampleRunView {
    return { firstSampleMs, msPerSample: 10, values, origin: 'live', timeQuestionable: false }
  }

  it('1 秒ごとのばらつき（平均を引いた RMS）を出す。直流（重力）は効かない', () => {
    const T = 1_000_000
    // 1 秒目は 980 を中心に ±1 で振れる。2 秒目はサンプルが無い。3 秒目は 0.5 の振れ
    const a = Array.from({ length: 100 }, (_, i) => 980 + (i % 2 === 0 ? 1 : -1))
    const c = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))
    const got = secondRms([run(T, a), run(T + 2000, c)], { fromMs: T, toMs: T + 3000 })
    expect(got.columnMs).toBe(1000)
    expect(got.firstColumnMs).toBe(T)
    expect(got.values[0]).toBeCloseTo(1, 9)
    expect(got.values[1]).toBeNaN()
    expect(got.values[2]).toBeCloseTo(0.5, 9)
  })

  it('範囲の外のサンプルと有限でない値は数えない', () => {
    const T = 1_000_000
    const a = Array.from({ length: 200 }, (_, i) => (i === 150 ? Number.NaN : i % 2 === 0 ? 2 : -2))
    const got = secondRms([run(T - 1000, a)], { fromMs: T, toMs: T + 1000 })
    expect(got.values).toHaveLength(1)
    // NaN を外した 99 本なので平均がわずかに 0 からずれる
    expect(got.values[0]).toBeCloseTo(2, 3)
  })
})

describe('noiseOfEnvelopeColumns', () => {
  it('列の幅と頭を保ったまま、1 秒より速い揺れの強さを取り出す', () => {
    const got = noiseOfEnvelopeColumns({ columnMs: 60_000, firstColumnMs: 120_000, noiseStd: [0.1, Number.NaN] })
    expect(got).toEqual({ columnMs: 60_000, firstColumnMs: 120_000, values: [0.1, Number.NaN] })
  })
})

describe('noiseRange', () => {
  it('正の値の最小・最大（0 以下と NaN は対数の縦に置けないので数えない）', () => {
    const r = noiseRange([{ columnMs: 1000, firstColumnMs: 0, values: [0.5, 0, Number.NaN, 0.012] }, { columnMs: 1000, firstColumnMs: 0, values: [0.85] }])
    expect(r).toEqual({ min: 0.012, max: 0.85 })
    expect(noiseRange([{ columnMs: 1000, firstColumnMs: 0, values: [0] }])).toBeNull()
  })
})

describe('文言', () => {
  it('ノイズの段（2026-10-08 ユーザー承認）', () => {
    expect(NOISE_TITLE).toBe('ノイズ水準の推移')
    expect(noiseHeader({ min: 0.012, max: 0.85 }, 'gal')).toBe('1 秒より速い揺れの RMS（縦は対数）　0.012〜0.85 gal')
    expect(noiseHeader({ min: 3, max: 120 }, 'count')).toBe('1 秒より速い揺れの RMS（縦は対数）　3.0〜120 カウント')
  })

  it('ノイズの値は有効数字 2 桁（静かなときの 0.012 を 0.01 へ潰さない）', () => {
    expect(formatNoise(0.012)).toBe('0.012')
    expect(formatNoise(0.85)).toBe('0.85')
    expect(formatNoise(1.61)).toBe('1.6')
    expect(formatNoise(12.3)).toBe('12')
    expect(formatNoise(120)).toBe('120')
  })

  it('スペクトログラムの段（2026-10-08 ユーザー承認）', () => {
    expect(spectrogramTitle('X')).toBe('スペクトログラム X')
    expect(spectrogramHeader(60_000)).toBe('0.1〜50 Hz（縦は対数）・列の幅 1 分')
    expect(spectrogramHeader(6000)).toBe('0.1〜50 Hz（縦は対数）・列の幅 6 秒')
    expect(dbScaleText({ lo: -150, hi: -90 }, 'gal')).toBe('色: −150〜−90 dB（0 dB = 1 (m/s²)²/Hz）')
    expect(dbScaleText({ lo: 10, hi: 40 }, 'count')).toBe('色: 10〜40 dB（0 dB = 1 カウント²/Hz）')
  })

  it('範囲のスペクトルの枠（2026-10-08 ユーザー承認）', () => {
    expect(SPECTRUM_TITLE).toBe('いま映している範囲のスペクトル')
    expect(spectrumHeader(58, 'samples')).toBe('約 10 秒の区間 58 本の平均（生のサンプルから）')
    expect(spectrumHeader(1200, 'minutes')).toBe('約 10 秒の区間 1200 本の平均（1 分ごとの PSD から）')
    expect(SPECTRUM_EMPTY_TEXT).toBe('この範囲には約 10 秒続いた記録が無く、スペクトルを出せない')
    expect(NOISE_MODEL_LEGEND).toBe('破線: Peterson の低ノイズ・高ノイズのモデル（NLNM・NHNM）')
  })

  it('指した所の値。値の無い軸は並べない', () => {
    const items = [
      { short: 'X', db: -112.3 },
      { short: 'Y', db: -115 },
      { short: 'Z', db: Number.NaN },
    ]
    expect(spectrumReadout(2.4, items)).toBe('2.4 Hz（周期 0.42 秒）　X −112 dB・Y −115 dB')
    expect(spectrogramReadout(2.4, items)).toBe('2.4 Hz　X −112 dB・Y −115 dB')
    expect(spectrumReadout(0.25, items)).toBe('0.25 Hz（周期 4.0 秒）　X −112 dB・Y −115 dB')
    expect(spectrumReadout(12.4, items)).toBe('12 Hz（周期 0.081 秒）　X −112 dB・Y −115 dB')
    expect(spectrogramReadout(2.4, [{ short: 'X', db: Number.NaN }])).toBeNull()
  })
})
