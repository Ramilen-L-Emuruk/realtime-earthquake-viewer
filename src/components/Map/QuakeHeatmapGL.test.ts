// ヒートマップへ点を流し込み直すかの判定（`isSameHeatData`）を固定する。
// `setData` は中身が同じでも地図全体を描き直させるので、ここを外すと、ヒートマップを
// 出していなくても親が描き直されるたびにフル再描画が走る（理由は関数の説明）。
import { describe, it, expect } from 'vitest'
import { isSameHeatData } from './QuakeHeatmapGL'
import type { HeatPoint } from '../../utils/quakeHeatmap'

const point = (name: string): HeatPoint =>
  ({ lat: 35, lng: 139, weight: 0.5, name, time: '2026-10-10T00:00:00+09:00', depth: 10, magnitude: 3 }) as HeatPoint

describe('isSameHeatData', () => {
  // 正: 出す点が無いまま親が描き直されても、流し込み直さない。直す前は `heatPoints ?? []` が
  // 描き直しのたびに新しい空配列を作り、毎回ここを素通りしていた。
  it('どちらも空なら、別の配列でも null でも同じとみなす', () => {
    expect(isSameHeatData([], [])).toBe(true)
    expect(isSameHeatData(null, [])).toBe(true)
    expect(isSameHeatData([], null)).toBe(true)
    expect(isSameHeatData(null, null)).toBe(true)
  })

  it('同じ配列なら同じとみなす', () => {
    const pts = [point('a')]
    expect(isSameHeatData(pts, pts)).toBe(true)
  })

  // 対照: 点が新しく届いたら流し込む。
  it('空から点がある配列へ変わったら違うとみなす', () => {
    expect(isSameHeatData(null, [point('a')])).toBe(false)
    expect(isSameHeatData([], [point('a')])).toBe(false)
  })

  it('点がある別の配列なら、中身が同じでも違うとみなす（中身は比べない）', () => {
    expect(isSameHeatData([point('a')], [point('a')])).toBe(false)
  })

  // 安全弁: 表示を切った・点が無くなったときは、残っている点を消すために流し込む。
  it('点がある配列から空へ変わったら違うとみなす', () => {
    expect(isSameHeatData([point('a')], [])).toBe(false)
    expect(isSameHeatData([point('a')], null)).toBe(false)
  })

  // 安全弁: ソースを作り直した直後（まだ何も流し込んでいない）は、空でも必ず流し込む。
  it('まだ何も流し込んでいない（undefined）なら、空でも違うとみなす', () => {
    expect(isSameHeatData(undefined, [])).toBe(false)
    expect(isSameHeatData(undefined, null)).toBe(false)
  })
})
