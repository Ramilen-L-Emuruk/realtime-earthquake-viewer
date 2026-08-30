import { describe, it, expect } from 'vitest'
import { filterSubThresholdIndices } from './kyoshinSubThresholdFilter'
import { siteKey } from './kyoshinDetector'

const OSAKA: [number, number] = [34.7, 135.5]
const TOKYO: [number, number] = [35.7, 139.7]
const UNKNOWN: [number, number] = [43.0, 141.3]

describe('filterSubThresholdIndices', () => {
  it('floors が空（未学習）のときは生データをそのまま返す', () => {
    const sites: [number, number][] = [OSAKA, TOKYO]
    const indices = [5, 3]
    expect(filterSubThresholdIndices(sites, indices, {})).toEqual(indices)
  })

  it('慢性床＋マージンを超えない点は 0（非表示）にする（大阪のような常時ノイジーな点）', () => {
    const sites: [number, number][] = [OSAKA]
    // 大阪の慢性床が value 1.0（index 8 相当）まで学習済み。平常の index5(value -0.5) は床未満。
    const floors = { [siteKey(...OSAKA)]: 1.0 }
    expect(filterSubThresholdIndices(sites, [5], floors)).toEqual([0])
  })

  it('慢性床＋マージンを超えた点はそのまま表示する（実際に揺れが強まったとき）', () => {
    const sites: [number, number][] = [OSAKA]
    const floors = { [siteKey(...OSAKA)]: 1.0 }
    // value(index10)=2.0 >= floor(1.0)+SUSTAIN_MARGIN(0.4)=1.4 なので表示
    expect(filterSubThresholdIndices(sites, [10], floors)).toEqual([10])
  })

  it('床が低い静かな点はそのまま低いレベルでも表示され続ける（東京のような点）', () => {
    const sites: [number, number][] = [TOKYO]
    const floors = { [siteKey(...TOKYO)]: -2.0 }
    // value(index3)=-1.5 >= floor(-2.0)+0.4=-1.6 なので表示
    expect(filterSubThresholdIndices(sites, [3], floors)).toEqual([3])
  })

  it('floors に無い座標（未知の観測点）は floor=0 として扱う', () => {
    const sites: [number, number][] = [UNKNOWN]
    // value(index6)=0.0 < floor(0)+0.4=0.4 なので非表示
    expect(filterSubThresholdIndices(sites, [6], {})).toEqual([6]) // floors全体が空なら早期returnでそのまま
  })

  it('floors が非空で一部座標だけ未登録の場合、その点は floor=0 扱いでフィルタされる', () => {
    const sites: [number, number][] = [OSAKA, UNKNOWN]
    const floors = { [siteKey(...OSAKA)]: 1.0 }
    // 大阪(index5)は床未満で非表示。未知点(index6=value0.0)は floor=0+0.4=0.4 未満で非表示。
    expect(filterSubThresholdIndices(sites, [5, 6], floors)).toEqual([0, 0])
  })

  // 座標キーのキャッシュ（観測点リストの配列そのものを鍵にする WeakMap）。
  // 効かなければ毎秒 1725 点ぶんの文字列を組み直す元の負荷に戻り、内容が変わったのに
  // 使い回せば別の観測点の学習値でフィルタしてしまう。どちらも例外を出さない。
  it('同じ配列を繰り返し渡しても結果が変わらない（キャッシュが効いても正しい）', () => {
    const sites: [number, number][] = [OSAKA, TOKYO]
    const floors = { [siteKey(...OSAKA)]: 1.0 }
    // 同じ index8(value 1.0) でも、大阪は床1.0+0.4に届かず非表示・東京は床0+0.4を超えて表示。
    // キーの引き当てが崩れると、この差が消える。
    const first = filterSubThresholdIndices(sites, [8, 8], floors)
    const second = filterSubThresholdIndices(sites, [8, 8], floors)
    expect(second).toEqual(first)
    expect(second).toEqual([0, 8])
  })

  it('観測点リストが差し替わったら新しい座標で引き直す', () => {
    // 前のリストのキーを使い回すと、別の観測点の慢性床でフィルタしてしまう。
    const floors = { [siteKey(...OSAKA)]: 1.0 }
    const before: [number, number][] = [OSAKA]
    const after: [number, number][] = [TOKYO]
    expect(filterSubThresholdIndices(before, [8], floors)).toEqual([0])
    expect(filterSubThresholdIndices(after, [8], floors)).toEqual([8])
  })
})
