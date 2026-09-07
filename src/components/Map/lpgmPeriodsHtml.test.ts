// 長周期地震動の観測点をクリックしたときに出る、周期帯ごとの内訳の組み立て。
//
// **階級だけでは「どの高さの建物が揺れたか」が出せない**ので、電文が持っている
// 周期帯ごとの値をここで見せる。壊れた入力で吹き出しごと消えないことも固定する。
import { describe, it, expect } from 'vitest'
import { lpgmPeriodsHtml } from './LpgmPointsGL'

describe('lpgmPeriodsHtml', () => {
  it('正: 帯ごとの階級と絶対速度応答スペクトルを中心周期の見出しで並べる', () => {
    const html = lpgmPeriodsHtml(JSON.stringify([
      { band: 1, lgInt: 4, sva: 268.5 },
      { band: 2, lgInt: 3, sva: 250 },
    ]))
    expect(html).toContain('2秒')
    expect(html).toContain('3秒')
    expect(html).toContain('268.5')
    // 小数第 1 位まで揃える（桁が揺れると縦に読めない）
    expect(html).toContain('250.0')
  })

  it('安全弁: 階級 0 の帯も行として出す（「該当なし」であって「観測していない」ではない）', () => {
    const html = lpgmPeriodsHtml(JSON.stringify([{ band: 5, lgInt: 0, sva: 1.2 }]))
    expect(html).toContain('6秒')
    expect(html).toContain('1.2')
  })

  it('対照: 中身が無い・壊れているときは何も出さない（吹き出しごと消さない）', () => {
    expect(lpgmPeriodsHtml('')).toBe('')
    expect(lpgmPeriodsHtml('{')).toBe('')
    expect(lpgmPeriodsHtml('[]')).toBe('')
    expect(lpgmPeriodsHtml('{"band":1}')).toBe('')
  })
})
