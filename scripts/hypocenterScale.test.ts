// 長期震源カタログの格納単位が、元データの刻みを丸めずに表せることの検査。
//
// 単位が噛み合わなくても生成は成功する（例外も NaN も出ず、丸めた値が書かれる）。壊れ方が
// 「静かに精度が落ちる」形なので、単位を動かしたときにここで落ちるようにしておく。

import { describe, it, expect } from 'vitest'
import {
  COORD_SCALE,
  DEPTH_SCALE,
  MAG_SCALE,
  TIME_SCALE,
  countUnrepresentable,
  findScaleMismatch,
  fitsScale,
  type ScaleCheckTarget,
} from './hypocenterScale'

/** 今の定数で書かれた年ファイルの格納単位。 */
const CURRENT_SCALES = {
  coordScale: COORD_SCALE,
  depthScale: DEPTH_SCALE,
  magScale: MAG_SCALE,
  timeScale: TIME_SCALE,
}

/** 元データと同じ経路で緯度経度を作る（度 ＋ 分 / 60）。分の刻みは 0.01 分。 */
function degMin(deg: number, min: number): number {
  return deg + min / 60
}

/** 秒の小数部を持つ時刻。元データの秒欄は 0.01 秒まで持つ。 */
function timeAt(sec: number): number {
  return Date.UTC(2023, 0, 1, 0, 0, 0) + Math.round(sec * 1000)
}

/** 関東大震災の本震（まとめ ZIP 1919-1950 の実値）。 */
const KANTO_1923: ScaleCheckTarget = {
  timeMs: timeAt(31.68),
  lat: degMin(35, 19.87),
  lng: degMin(139, 8.14),
  depth: 23,
  magnitude: 7.9,
}

describe('fitsScale', () => {
  // 正: 元データが取りうる刻みは、いずれも丸めずに整数へ写せる。
  it('元データの刻みは格納単位の格子に乗る', () => {
    // 0.01 分（1/6000 度）。割り算を経て下位桁に誤差が残るが、格子には乗っている。
    expect(fitsScale(degMin(35, 19.87), COORD_SCALE)).toBe(true)
    expect(fitsScale(degMin(139, 8.14), COORD_SCALE)).toBe(true)
    // 0.1 分（分の小数部が 1 桁しかない書式）。
    expect(fitsScale(degMin(37, 29.7), COORD_SCALE)).toBe(true)
    // 負の座標（南緯・西経）。
    expect(fitsScale(-degMin(7, 30.25), COORD_SCALE)).toBe(true)
    expect(fitsScale(23.74, DEPTH_SCALE)).toBe(true)
    expect(fitsScale(7.9, MAG_SCALE)).toBe(true)
  })

  // 対照: 1 桁細かい刻みは乗らない。上流が精度を上げたらここで気づける。
  it('元データより 1 桁細かい刻みは乗らない', () => {
    expect(fitsScale(degMin(35, 19.871), COORD_SCALE)).toBe(false)
    expect(fitsScale(23.745, DEPTH_SCALE)).toBe(false)
    expect(fitsScale(7.95, MAG_SCALE)).toBe(false)
  })

  // 安全弁: 10 進で切った単位（かつての 1/10000 度）で作った値は、元の格子に乗らない。
  // 「決定精度より細かいから十分」という基準では精度が落ちることの裏返し。
  it('10 進で切った単位の値は元の格子に乗らない', () => {
    // 35.33116666… を 1/10000 度へ丸めた値。
    expect(fitsScale(35.3312, COORD_SCALE)).toBe(false)
  })
})

describe('countUnrepresentable', () => {
  it('元データの刻みだけなら 1 件も数えない', () => {
    expect(countUnrepresentable([KANTO_1923])).toEqual({ count: 0, example: null })
  })

  it('表せない値は件数を数え、最初の 1 件を理由付きで返す', () => {
    const records: ScaleCheckTarget[] = [
      KANTO_1923,
      { ...KANTO_1923, depth: 23.745 },
      { ...KANTO_1923, lat: degMin(35, 19.871) },
    ]
    const result = countUnrepresentable(records)
    expect(result.count).toBe(2)
    // example は最初に見つかった 1 件だけ（後続で上書きしない）。
    expect(result.example).toMatch(/深さ 23\.745/)
  })

  it('秒が格納単位より細かい時刻を数える', () => {
    // 0.001 秒。ミリ秒の整数としては表せるが、1/100 秒の格子には乗らない。
    const result = countUnrepresentable([{ ...KANTO_1923, timeMs: timeAt(31.681) }])
    expect(result.count).toBe(1)
    expect(result.example).toMatch(/時刻/)
  })

  // 安全弁: M は欠測しうる（読めない行は null）。null を理由に数えると、M 欄が未決定の
  // 行（日別経路で 1 日 5〜165 件）が毎回異常として上がり、本物の信号が埋もれる。
  it('M が欠測している行は M を理由に数えない', () => {
    expect(countUnrepresentable([{ ...KANTO_1923, magnitude: null }])).toEqual({ count: 0, example: null })
  })

  // 格納単位を動かしたときにこのテスト群が意味を保つための土台。TIME_SCALE を 1（秒）へ
  // 戻せば 0.01 秒の時刻が表せなくなる、という関係を明示しておく。
  it('時刻の格納単位は 0.01 秒を表せる値である', () => {
    expect(1000 % TIME_SCALE).toBe(0)
    expect((timeAt(31.68) * TIME_SCALE) % 1000).toBe(0)
  })
})

// 単位を変えた後に範囲を絞って生成すると（週次更新は `--from 2024`）、作り直さなかった年が
// 古い単位で残る。読み取り側は年ファイル自身の単位を信じて読むため、混在していても何も言わずに
// 粗い精度で読む —— 捕まえられるのは生成のここだけなので、判定をテストで固定する。
describe('findScaleMismatch', () => {
  // 正: 今の定数で書かれた年ファイルは通る。
  it('今の単位で書かれていれば食い違いなし', () => {
    expect(findScaleMismatch(CURRENT_SCALES)).toBeNull()
  })

  // 対照: どの項目が古くても弾く。1 つだけ単位を変えたときに漏れないことを 4 項目で固定する。
  it.each([
    ['coordScale', { coordScale: 10000 }],
    ['depthScale', { depthScale: 10 }],
    ['magScale', { magScale: 100 }],
    ['timeScale', { timeScale: 1 }],
  ])('%s が古い値なら食い違いを返す', (key, override) => {
    const result = findScaleMismatch({ ...CURRENT_SCALES, ...override })
    expect(result).toContain(key)
  })

  // 安全弁: 項目そのものが無い年ファイル（単位を持たなかった頃の形）も弾く。
  it('項目が欠けていても食い違いとして扱う', () => {
    const { timeScale: _drop, ...noTimeScale } = CURRENT_SCALES
    expect(findScaleMismatch(noTimeScale)).toContain('timeScale')
  })

  // 安全弁: 数値以外が入っていても通さない（JSON は何でも入りうる）。
  it('数値以外の値も食い違いとして扱う', () => {
    expect(findScaleMismatch({ ...CURRENT_SCALES, coordScale: '6000' })).toContain('coordScale')
  })
})
