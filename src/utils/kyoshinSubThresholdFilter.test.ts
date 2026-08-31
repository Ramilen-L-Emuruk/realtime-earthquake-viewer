import { describe, it, expect } from 'vitest'
import { filterSubThresholdIndices } from './kyoshinSubThresholdFilter'

const OSAKA: [number, number] = [34.7, 135.5]
const TOKYO: [number, number] = [35.7, 139.7]
const UNKNOWN: [number, number] = [43.0, 141.3]

describe('filterSubThresholdIndices', () => {
  it('floors が空（未学習）のときは生データをそのまま返す', () => {
    const sites: [number, number][] = [OSAKA, TOKYO]
    const indices = [5, 3]
    expect(filterSubThresholdIndices(sites, indices, [])).toEqual(indices)
  })

  it('慢性床＋マージンを超えない点は 0（非表示）にする（大阪のような常時ノイジーな点）', () => {
    // 大阪の慢性床が value 1.0（index 8 相当）まで学習済み。平常の index5(value -0.5) は床未満。
    expect(filterSubThresholdIndices([OSAKA], [5], [1.0])).toEqual([0])
  })

  it('慢性床＋マージンを超えた点はそのまま表示する（実際に揺れが強まったとき）', () => {
    // value(index10)=2.0 >= floor(1.0)+SUSTAIN_MARGIN(0.4)=1.4 なので表示
    expect(filterSubThresholdIndices([OSAKA], [10], [1.0])).toEqual([10])
  })

  it('床が低い静かな点はそのまま低いレベルでも表示され続ける（東京のような点）', () => {
    // value(index3)=-1.5 >= floor(-2.0)+0.4=-1.6 なので表示
    expect(filterSubThresholdIndices([TOKYO], [3], [-2.0])).toEqual([3])
  })

  it('床を学習していない点（0 が入る）は震度0ドットの範囲では非表示になる', () => {
    // index 1〜6 の value は最大 0.0 で、floor(0)+0.4=0.4 に届かない
    expect(filterSubThresholdIndices([OSAKA, UNKNOWN], [5, 6], [1.0, 0])).toEqual([0, 0])
  })

  // 座標が重複する観測点（Yahoo の公開座標は同一座標に複数の実体が載る。全1725点中207グループ・431点）。
  // 検知エンジンは computeSiteKeys で #2, #3 と別実体に分けて床を学習している。以前はこのフィルタが
  // 座標から作ったキーで引いていたため、2つ目以降が**グループ先頭の床**で判定されていた
  // （実測 15 分で 60 点の表示が食い違った）。
  describe('座標が重複する観測点', () => {
    const DUP_A: [number, number] = [35.7, 139.8]
    const DUP_B: [number, number] = [35.7, 139.8] // 同一座標の別実体

    it('同一座標でも並び順で別々の床が効く（先頭の床を流用しない）', () => {
      const sites: [number, number][] = [DUP_A, DUP_B]
      // 先頭は静かな点（床 -2.5）、2つ目は都市ノイズの点（床 -1.0）。同じ index3(value -1.5) でも
      // 先頭は表示（-1.5 >= -2.5+0.4=-2.1）、2つ目は非表示（-1.5 < -1.0+0.4=-0.6）。
      expect(filterSubThresholdIndices(sites, [3, 3], [-2.5, -1.0])).toEqual([3, 0])
    })

    it('先頭が静かでも 2 つ目のノイジーな点は素通りしない', () => {
      const sites: [number, number][] = [DUP_A, DUP_B]
      // 2つ目の床 1.0（ノイジー）。index6(value 0.0) は 1.4 に届かず非表示。
      // 座標キーで引いていた頃は先頭の床 -3.0 を引いて表示されていた。
      expect(filterSubThresholdIndices(sites, [6, 6], [-3.0, 1.0])).toEqual([6, 0])
    })

    it('3 つ以上が同一座標でもそれぞれの床で判定する', () => {
      const sites: [number, number][] = [DUP_A, DUP_B, [35.7, 139.8]]
      // それぞれ 表示 / 非表示 / 表示
      expect(filterSubThresholdIndices(sites, [4, 4, 4], [-2.0, 0.5, -1.5])).toEqual([4, 0, 4])
    })
  })

  // 安全弁: 位置で対応づける以上、長さのずれは「別地点の床で判定する」ことを意味する。
  // 消すより出す方へ倒す（フィルタ自体をかけない）。
  describe('長さが揃わないとき', () => {
    it('floors が sites より短ければフィルタしない', () => {
      const sites: [number, number][] = [OSAKA, TOKYO]
      expect(filterSubThresholdIndices(sites, [5, 5], [1.0])).toEqual([5, 5])
    })

    it('floors が indices と食い違えばフィルタしない', () => {
      const sites: [number, number][] = [OSAKA, TOKYO]
      expect(filterSubThresholdIndices(sites, [5], [1.0, -2.0])).toEqual([5])
    })
  })
})
