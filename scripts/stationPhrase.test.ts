import { describe, it, expect } from 'vitest'
import {
  buildCityIndex, splitStationName, toStationAccentEntry,
  MIN_MORAS_TO_SPLIT, MIN_MORAS_PER_PHRASE,
} from './stationPhrase'
import type { SplitOutcome, StationSplit } from './stationPhrase'

/** 割れた結果を取り出す。割れていなければテストを落とす。 */
function splitOf(outcome: SplitOutcome): StationSplit {
  if (outcome.kind !== 'split') throw new Error(`割れていない（${outcome.reason}）`)
  return outcome.split
}

// 観測点名の句割りの検証。
// 「読み上げで長すぎる 1 句を市町村の境界で 2 つに割る」ための処理で、割る位置・割らない条件・
// アクセント核の置き方を固定する。名前とふりがなは気象庁 個別コード表のシート 24 の実データ。

const cities = buildCityIndex([
  ['石狩市', 'いしかりし'],
  ['江別市', 'えべつし'],
  ['札幌豊平区', 'さっぽろとよひらく'],
  ['当別町', 'とうべつちょう'],
  ['むつ市', 'むつし'],
  ['新温泉町', 'しんおんせんちょう'],
  ['菊川市', 'きくがわし'],
  ['日光市', 'にっこうし'],
  ['山鹿市', 'やまがし'],
  // 一方が他方の前方一致になっている組（実データに 3 組ある）
  ['東村', 'ひがしそん'],
  ['東村山市', 'ひがしむらやまし'],
  ['佐世保市', 'させぼし'],
  ['佐世保市宇久島', 'させぼしうくじま'],
])

describe('splitStationName', () => {
  it('市町村の境界で割る（正）', () => {
    expect(splitStationName('石狩市花川', 'いしかりしはなかわ', cities)).toEqual({
      kind: 'split',
      split: { city: '石狩市', cityKana: 'イシカリシ', localityKana: 'ハナカワ' },
    })
  })

  it('区も市町村として扱う', () => {
    expect(splitOf(splitStationName('札幌豊平区月寒東', 'さっぽろとよひらくつきさむひがし', cities)))
      .toEqual({ city: '札幌豊平区', cityKana: 'サッポロトヨヒラク', localityKana: 'ツキサムヒガシ' })
  })

  it('割るのは 1 回だけ（後半は長くてもそれ以上刻まない）', () => {
    // 後半の割れ目を決める読みの出どころが無い（→ この関数の JSDoc）。
    const split = splitOf(splitStationName('江別市高砂町', 'えべつしたかさごちょう', cities))
    expect(split.localityKana).toBe('タカサゴチョウ')
  })

  it('長音記号は母音の重ねへ開く（AquesTalk 風カナが受け付けないため）', () => {
    // 実データに半角ハイフンで書かれた点がある（`せんた-`）。
    const split = splitOf(splitStationName('山鹿市老人福祉センター', 'やまがしろうじんふくしせんた-', cities))
    expect(split.localityKana).toBe('ロウジンフクシセンタア')
  })

  // 対照 —— 割ってはいけない形。
  it(`全体が ${MIN_MORAS_TO_SPLIT} モーラ未満なら割らない`, () => {
    // むつしかなや = 6 モーラ。市町村も読みも一致するが、1 句でも語の輪郭が保たれる長さ。
    expect(splitStationName('むつ市金谷', 'むつしかなや', cities))
      .toEqual({ kind: 'skipped', reason: 'モーラ数が足りない' })
  })

  it(`片方の句が ${MIN_MORAS_PER_PHRASE} モーラ未満なら割らない`, () => {
    // シンオンセンチョウ / ユ。1 モーラの句は自ら核を持って浮く。
    expect(splitStationName('新温泉町湯', 'しんおんせんちょうゆ', cities))
      .toEqual({ kind: 'skipped', reason: '句が短すぎる' })
  })

  it('観測点名の側にだけ都道府県の冠が付く形は割らない', () => {
    // 上流の命名の揺れ。市町村は `菊川市` だが観測点名は `静岡菊川市赤土`。
    expect(splitStationName('静岡菊川市赤土', 'しずおかきくがわしあかつち', cities))
      .toEqual({ kind: 'skipped', reason: '市町村が当たらない' })
  })

  it('ふりがなの促音が小書きでない形は割らない', () => {
    // 観測点のふりがなが `につこうし〜` で、市町村 `日光市` の `にっこうし` と食い違う。
    expect(splitStationName('日光市御幸町', 'につこうしごこうまち', cities))
      .toEqual({ kind: 'skipped', reason: '市町村が当たらない' })
  })

  it('市町村が 1 件も当たらなければ割らない', () => {
    expect(splitStationName('宮古島平良', 'みやこじまひらら', cities))
      .toEqual({ kind: 'skipped', reason: '市町村が当たらない' })
  })

  // 安全弁 —— 読みの照合と並べ替えを緩めていないこと。
  it('漢字が一致しても読みが合わなければ割らない', () => {
    // 読みを見ずに漢字だけで割ると、市町村名の途中で割れる（`ヒガシソン` ぶんを削った残りが
    // 後半になる）。**この形は並べ替えでは防げない** —— 長い側（`東村山市`）を持たない表で
    // 確かめる。実データでは `東村山市` が先に当たるため、そちらは並べ替えの担当（次のテスト）。
    const onlyShort = buildCityIndex([['東村', 'ひがしそん']])
    expect(splitStationName('東村山市本町', 'ひがしむらやましほんちょう', onlyShort))
      .toEqual({ kind: 'skipped', reason: '市町村が当たらない' })
    // 長い側があればそちらで割れる。
    expect(splitOf(splitStationName('東村山市本町', 'ひがしむらやましほんちょう', cities))).toEqual({
      city: '東村山市', cityKana: 'ヒガシムラヤマシ', localityKana: 'ホンチョウ',
    })
  })

  it('入れ子の市町村は長い側から当てる', () => {
    // 実データの `佐世保市宇久町` は長い側（`佐世保市宇久島`）では漢字が一致しないので短い側が当たる。
    expect(splitOf(splitStationName('佐世保市宇久町', 'させぼしうくまち', cities)).city).toBe('佐世保市')
    // 長い側で漢字も読みも一致する形が来れば、そちらを採る（並べ替えが効く形）。
    expect(splitOf(splitStationName('佐世保市宇久島平', 'させぼしうくじまたいら', cities)).city)
      .toBe('佐世保市宇久島')
  })

  it('モーラ数が足りないとき、短い市町村へ落とさない', () => {
    // 最長一致がその名前の境界。落とすと市町村名の途中で割れる。
    // `佐世保市宇久島` が当たったうえで後半が 1 モーラなら、`佐世保市` で割り直さずに諦める。
    expect(splitStationName('佐世保市宇久島津', 'させぼしうくじまつ', cities))
      .toEqual({ kind: 'skipped', reason: '句が短すぎる' })
  })
})

describe('toStationAccentEntry', () => {
  const split = splitOf(splitStationName('石狩市花川', 'いしかりしはなかわ', cities))

  it('市町村の核はエンジンの実測位置へ置く（正）', () => {
    // 実測（話者 6）は `イシカリシ` が 5 モーラで核 4 ＝「市」の直前。
    expect(toStationAccentEntry(split, 4)).toBe("イシカリ'シ/ハナカワ'")
  })

  it('核を採れなければ末尾へ置く（ふりがなだけから組める唯一の形）', () => {
    expect(toStationAccentEntry(split, null)).toBe("イシカリシ'/ハナカワ'")
  })

  it('小書きのかなは直前のモーラへ吸収して数える', () => {
    const ward = splitOf(splitStationName('札幌豊平区月寒東', 'さっぽろとよひらくつきさむひがし', cities))
    // サ・ッ・ポ・ロ・ト・ヨ・ヒ・ラ・ク = 9 モーラ。核 8 は `ラ` の後ろ。
    expect(toStationAccentEntry(ward, 8)).toBe("サッポロトヨヒラ'ク/ツキサムヒガシ'")
  })

  // 安全弁 —— 壊れた記法を書かないこと。
  it('値域を外れた核は末尾へ倒す', () => {
    // AquesTalk 風カナは 1 句にちょうど 1 つの核を要求し、0 個なら ACCENT_NOTFOUND で拒否される。
    expect(toStationAccentEntry(split, 0)).toBe("イシカリシ'/ハナカワ'")
    expect(toStationAccentEntry(split, -1)).toBe("イシカリシ'/ハナカワ'")
    expect(toStationAccentEntry(split, 99)).toBe("イシカリシ'/ハナカワ'")
  })

  it('核は必ず 1 句に 1 つだけ入る', () => {
    for (const accent of [null, 0, 1, 3, 4, 5, 99]) {
      const entry = toStationAccentEntry(split, accent)
      const [head, tail] = entry.split('/')
      expect(head.match(/'/g)).toHaveLength(1)
      expect(tail.match(/'/g)).toHaveLength(1)
    }
  })
})
