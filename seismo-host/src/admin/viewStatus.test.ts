import { describe, expect, it } from 'vitest'

import { memberCell, worstPairDiff } from './viewStatus'

/** センサー対 1 組ぶんの差分の強さ（`/status` から読む形）。 */
function pair(rmsGal: readonly (number | null)[], id = 'a') {
  return {
    a: { boardKey: `mac:${id}`, sensorId: 's0' },
    b: { boardKey: 'mac:zz', sensorId: 's0' },
    rmsGal,
    sampleCount: rmsGal.map(() => 30),
  }
}

describe('memberCell', () => {
  it('正: 揃っていれば本数、揺れていれば幅で出す（#315）', () => {
    expect(memberCell(9, 9)).toBe('9 本')
    expect(memberCell(1, 7)).toContain('1〜7 本')
  })

  it('安全弁: 幅が出ていても警めの色にしない', () => {
    // **実機は正常運転でも幅が出る**（まとまりの末尾で 1〜3 本欠ける。
    // REQUIREMENTS.md §7）。色を付けると常に警告が出ている状態になり、
    // #362 の本物の乱れと区別が付かないまま印そのものが信用されなくなる。
    // **どこからが異常かの物差しは未設計**（#374）。
    expect(memberCell(1, 7)).not.toContain('badge')
    expect(memberCell(8, 9)).not.toContain('badge')
  })

  it('対照: まだ合成していなければ「—」', () => {
    expect(memberCell(null, null)).toBe('—')
  })

  it('安全弁: 欄が無い（undefined）ときも「—」へ倒す', () => {
    // **`/status` は無検証のキャストで読んでいる。** 版がずれて欄が落ちると
    // `undefined` が来るが、`undefined === undefined` は真なので `null` だけを
    // 見る形だと**「undefined 本」というそれらしい文字列が画面へ出る**。
    expect(memberCell(undefined, undefined)).toBe('—')
    expect(memberCell(undefined, 9)).toBe('—')
    // 数として読めない値も同じ扱い（`readFinite` が倒す）。
    expect(memberCell('9', '9')).toBe('—')
    expect(memberCell(Number.NaN, Number.NaN)).toBe('—')
  })
})

describe('worstPairDiff', () => {
  it('正: いちばん離れている対と、その軸の値を返す（#315）', () => {
    const worst = worstPairDiff([pair([1, 2, 3], 'a'), pair([0.5, 9, 0.5], 'b'), pair([4, 4, 4], 'c')])

    expect(worst?.rmsGal).toBe(9)
    expect(worst?.pair.a.boardKey).toBe('mac:b')
  })

  it('正: 軸ごとの最大を採る（3 軸を平均しない）', () => {
    // **感度のずれは軸ごとに現れる**（#367）。平均すると 1 軸だけおかしい対が薄まる。
    const worst = worstPairDiff([pair([5, 5, 5], 'flat'), pair([0, 0, 9], 'oneAxis')])

    expect(worst?.pair.a.boardKey).toBe('mac:oneAxis')
  })

  it('対照: 測れなかった軸（null）は候補にしない', () => {
    // 0 で埋めると「差が無かった」対として最大の争いに混ざる。
    const worst = worstPairDiff([pair([null, null, 2])])

    expect(worst?.rmsGal).toBe(2)
  })

  it('安全弁: 1 組も無い・全軸が測れなかったなら null', () => {
    expect(worstPairDiff([])).toBeNull()
    expect(worstPairDiff([pair([null, null, null])])).toBeNull()
  })
})
