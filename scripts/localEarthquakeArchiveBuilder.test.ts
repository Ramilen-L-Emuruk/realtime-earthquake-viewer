import { describe, it, expect } from 'vitest'
import { parseNiiTime, resolveQuakeHeadType, isRelated, isUnverifiableCancellation, mergeIndexEntry } from './localEarthquakeArchiveBuilder'

function indexEntry(id: string, from: string) {
  return { id, label: id, description: id, from, to: from, firstEventTime: from }
}

describe('mergeIndexEntry', () => {
  it('正: 新規エントリを収録範囲の開始時刻(from)順に挿入する', () => {
    const index = [indexEntry('2018-osaka', '2018-06-17T15:00:00.000Z'), indexEntry('2018-iburi', '2018-09-05T15:00:00.000Z')]
    const result = mergeIndexEntry(index, indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z'))
    expect(result.map((e) => e.id)).toEqual(['2016-kumamoto', '2018-osaka', '2018-iburi'])
  })

  it('対照（バグ回帰）: 単純追記だと実行順のままになってしまう', () => {
    // mergeIndexEntryを使わず配列末尾へ追記するだけの旧実装だと、地震の発生順ではなく
    // ビルドスクリプトを実行した順に並んでしまっていた（実際に発生していた不具合）。
    const index = [indexEntry('2018-osaka', '2018-06-17T15:00:00.000Z')]
    const naiveAppend = [...index, indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')]
    expect(naiveAppend.map((e) => e.id)).toEqual(['2018-osaka', '2016-kumamoto']) // 発生順ではない
    expect(mergeIndexEntry(index, indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')).map((e) => e.id))
      .toEqual(['2016-kumamoto', '2018-osaka']) // 発生順に直る
  })

  it('安全弁: 同じidが既にある場合は置き換える（重複させない）', () => {
    const index = [indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')]
    const updated = indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')
    updated.description = '更新後の説明'
    const result = mergeIndexEntry(index, updated)
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('更新後の説明')
  })
})

describe('parseNiiTime', () => {
  it('正: NII表示形式（オフセットが分無しの2桁）をDateへ変換する', () => {
    const d = parseNiiTime('2016-04-14 21:28:06+09')
    expect(d.toISOString()).toBe('2016-04-14T12:28:06.000Z')
  })

  it('対照（バグ回帰）: 素の new Date() では Invalid Date になる形式であることを確認する', () => {
    // parseNiiTime が無かった旧実装は `new Date(item.time.replace(' ', 'T'))` を使っており、
    // この形式では常に Invalid Date を返していた（時刻ウィンドウが無警告で無効化された事故）。
    expect(Number.isNaN(new Date('2016-04-14T21:28:06+09').getTime())).toBe(true)
  })

  it('安全弁: 解釈できない形式は例外にする（Invalid Dateを黙って返さない）', () => {
    expect(() => parseNiiTime('not-a-time')).toThrow()
    expect(() => parseNiiTime('2016/04/14 21:28:06+09')).toThrow()
  })
})

describe('resolveQuakeHeadType', () => {
  it('正: 具体的なラベルから順に判定する', () => {
    expect(resolveQuakeHeadType('震度速報')).toBe('VXSE51')
    expect(resolveQuakeHeadType('顕著な地震の震源要素更新のお知らせ')).toBe('VXSE61')
    expect(resolveQuakeHeadType('震源・震度に関する情報')).toBe('VXSE53')
    expect(resolveQuakeHeadType('震源に関する情報')).toBe('VXSE52')
  })

  it('対照: 「震源・震度」を含むラベルが「震源」だけの判定に丸め込まれない', () => {
    // 判定順を誤ると「震源・震度」も includes('震源') に一致してVXSE52になる。
    expect(resolveQuakeHeadType('震源・震度情報')).toBe('VXSE53')
  })

  it('安全弁: 未知のラベルは黙ってスキップせず例外にする', () => {
    expect(() => resolveQuakeHeadType('謎の電文種別')).toThrow()
  })
})

describe('isRelated', () => {
  const hypocenterNames = new Set(['熊本県熊本地方', '熊本県阿蘇地方'])
  const areaPrefixes = ['熊本', '阿蘇']

  it('正: 震央地名が完全一致すれば関連ありと判定する', () => {
    const quake = { earthquake: { hypocenter: { name: '熊本県熊本地方' } }, points: [] }
    expect(isRelated(quake, hypocenterNames, areaPrefixes)).toBe(true)
  })

  it('対照: 震央地名が一致しなければ関連なしと判定する', () => {
    const quake = { earthquake: { hypocenter: { name: '茨城県北部' } }, points: [] }
    expect(isRelated(quake, hypocenterNames, areaPrefixes)).toBe(false)
  })

  it('正: 震央地名が空（震度速報）なら観測地域名の前方一致で判定する', () => {
    const quake = { earthquake: { hypocenter: { name: '' } }, points: [{ addr: '熊本県熊本' }] }
    expect(isRelated(quake, hypocenterNames, areaPrefixes)).toBe(true)
  })

  it('安全弁: 震央地名が空で観測地域名も一致しなければ関連なし', () => {
    const quake = { earthquake: { hypocenter: { name: '' } }, points: [{ addr: '茨城県北部' }] }
    expect(isRelated(quake, hypocenterNames, areaPrefixes)).toBe(false)
  })
})

describe('isUnverifiableCancellation', () => {
  it('正: 取消電文（震央地名・観測地域ともに空）を判定不能として検出する', () => {
    const quake = { cancelled: true, earthquake: { hypocenter: { name: '' } }, points: [] }
    expect(isUnverifiableCancellation(quake)).toBe(true)
  })

  it('対照: 取消電文でなければ false', () => {
    const quake = { cancelled: false, earthquake: { hypocenter: { name: '' } }, points: [] }
    expect(isUnverifiableCancellation(quake)).toBe(false)
  })

  it('安全弁: 取消電文でも震央地名を持つ場合は判定不能扱いにしない（構造上ありえないが念のため）', () => {
    const quake = { cancelled: true, earthquake: { hypocenter: { name: '熊本県熊本地方' } }, points: [] }
    expect(isUnverifiableCancellation(quake)).toBe(false)
  })
})
