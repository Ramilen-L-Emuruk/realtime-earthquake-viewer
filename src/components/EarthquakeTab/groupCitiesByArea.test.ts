// 市町村を区域ごとにまとめる処理。
//
// **DMDATA の電文は `Pref/MaxInt` を必ず持つため、カードの行は事実上いつも都道府県単位になる**
// （区域単位に割れるのは区域点しか持たない P2PQuake 経路）。区域の別を示さずに並べると、
// 石川県の行に能登と加賀の市町村が区別なく混ざる。
import { describe, it, expect } from 'vitest'
import { groupCitiesByArea } from './EarthquakeCard'
import type { JMAQuakeCity } from '../../types/earthquake'

const city = (name: string, area: string, scale: JMAQuakeCity['scale']): JMAQuakeCity =>
  ({ name, area, pref: '石川県', scale })

describe('groupCitiesByArea', () => {
  // 対照: 区域が 1 つだけなら見出しを出さない（行の見出し＝都道府県名と合わせて情報が増えない）。
  it('区域が 1 つなら見出しを付けない', () => {
    const list = [city('輪島市', '石川県能登', 70), city('穴水町', '石川県能登', 60)]
    expect(groupCitiesByArea(list)).toEqual([['', list]])
  })

  // 正: 区域が複数にまたがるときは区域ごとに分ける。これがこの関数を足した理由。
  it('区域が複数なら区域ごとに分ける', () => {
    const noto = city('輪島市', '石川県能登', 70)
    const kaga = city('金沢市', '石川県加賀', 50)
    const groups = groupCitiesByArea([noto, kaga])
    expect(groups).toEqual([['石川県能登', [noto]], ['石川県加賀', [kaga]]])
  })

  // 正: 区域の順は、その区域で最も高い震度の順（強く揺れた区域を上に出す）。
  it('区域は最大震度の高い順に並べる', () => {
    const kaga = city('金沢市', '石川県加賀', 60)
    const noto = city('輪島市', '石川県能登', 40)
    expect(groupCitiesByArea([noto, kaga]).map(([area]) => area)).toEqual(['石川県加賀', '石川県能登'])
  })

  // 安全弁: 市町村の並び（震度の降順）は区域の中で保つ。
  it('区域の中では渡された順を保つ', () => {
    const a = city('輪島市', '石川県能登', 70)
    const b = city('穴水町', '石川県能登', 60)
    const c = city('金沢市', '石川県加賀', 50)
    expect(groupCitiesByArea([a, b, c])[0][1]).toEqual([a, b])
  })

  it('空なら空の 1 群を返す', () => {
    expect(groupCitiesByArea([])).toEqual([['', []]])
  })
})
