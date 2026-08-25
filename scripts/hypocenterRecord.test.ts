// 震源レコードのパーサの回帰テスト。
//
// **カラム位置を 1 バイト間違えるだけで全件が静かに壊れる。** 型でも実行時エラーでも捕まらず、
// 出来上がった JSON をよほど疑って見ないと気づけない。ここで実レコードを固定しておく。
//
// テストデータは気象庁「地震月報（カタログ編）」震源データから抜いた実レコード
// （出典: https://www.data.jma.go.jp/eqev/data/bulletin/hypo.html ・公共データ利用規約 第1.0版）。

import { describe, it, expect } from 'vitest'
import { parseHypocenterRecord, parseTrailingBlankDecimal, RECORD_LENGTH } from './hypocenterRecord'

// 2011年3月11日 東北地方太平洋沖地震の本震。気象庁の発表値は
// 38.1035°N / 142.8610°E / 深さ 23.7km / M9.0（2011 年カタログより）。
const TOHOKU =
  'J2011031114461812 026 380621 056 1425166 087 237429590W84D5117662 64FAR E OFF MIYAGI PREF    39K'

// 2023年1月1日 銚子付近。**深さを固定して決めた震源**で、深さ欄が整数 3 桁＋空白 2 桁になる。
const FIXED_DEPTH =
  'J2023010100080150 012 354059 100 1403927 136 50     03v   721   3110NEAR CHOSHI CITY          9A'

// 2023年1月1日 岩手県南部。通常の 1/100 km 単位の深さ（6.68km）。
const SHALLOW =
  'J2023010100172118 007 385794 024 1405323 028  66808800v   711   2 49SOUTHERN IWATE PREF      15A'

// 海外の震源（`U` レコード）。**南緯・西経は符号と数字の間が空く**書き方をする（`- 7`）。
// そのまま Number に渡すと NaN になり、読めない行として黙って捨てられる。
const OVERSEAS =
  'U2023011002473504    - 70352     1300054    105     71B       219   TANIMBAR IS., INDONESIA     '

describe('parseHypocenterRecord', () => {
  it('東北地方太平洋沖地震の本震を気象庁の発表値どおりに読む', () => {
    const r = parseHypocenterRecord(TOHOKU)
    expect(r).not.toBe(null)
    // 14:46:18.12 JST = 05:46:18.12 UTC
    expect(new Date(r!.timeMs).toISOString()).toBe('2011-03-11T05:46:18.120Z')
    expect(r!.lat).toBeCloseTo(38.1035, 4)
    expect(r!.lng).toBeCloseTo(142.861, 4)
    expect(r!.depth).toBeCloseTo(23.74, 2)
    expect(r!.magnitude).toBe(9.0)
    expect(r!.kind).toBe('J')
    expect(r!.quality).toBe('K') // 手動検測
  })

  // 実行環境のタイムゾーンで結果が変わってはいけない（CI は UTC で回る）。
  // ローカル時刻で組み立てていれば、この期待値は JST の端末でだけ通る。
  it('時刻は実行環境のタイムゾーンに依存しない', () => {
    const r = parseHypocenterRecord(TOHOKU)!
    // JST の壁時計 14:46 が UTC の 05:46 になっていること
    expect(new Date(r.timeMs).getUTCHours()).toBe(5)
    expect(new Date(r.timeMs).getUTCMinutes()).toBe(46)
  })

  describe('深さの 2 つの書き方', () => {
    it('固定深さ（整数 3 桁＋空白 2 桁）を読む', () => {
      const r = parseHypocenterRecord(FIXED_DEPTH)!
      expect(r.depth).toBe(50)
    })

    // 対照: 後ろ 2 桁が数字なら 1/100 km 単位。固定深さと同じ規則で読むと 668km になる。
    it('通常の 1/100 km 単位を読む', () => {
      const r = parseHypocenterRecord(SHALLOW)!
      expect(r.depth).toBeCloseTo(6.68, 2)
    })
  })

  it('度分形式を度へ直す', () => {
    const r = parseHypocenterRecord(FIXED_DEPTH)!
    // 35°40.59′ = 35 + 40.59/60
    expect(r.lat).toBeCloseTo(35 + 40.59 / 60, 5)
    // 140°39.27′
    expect(r.lng).toBeCloseTo(140 + 39.27 / 60, 5)
  })

  it('符号と数字の間が空く緯度経度を読む（海外の震源）', () => {
    const r = parseHypocenterRecord(OVERSEAS)
    expect(r).not.toBe(null)
    // -7°03.52′ / 130°00.54′。**分は度の符号に従う**（南緯なので分も引く）
    expect(r!.lat).toBeCloseTo(-7 - 3.52 / 60, 4)
    expect(r!.lng).toBeCloseTo(130 + 0.54 / 60, 4)
    expect(r!.depth).toBe(105)
    expect(r!.magnitude).toBe(7.1)
    expect(r!.kind).toBe('U')
  })

  it('M は暗黙の小数点を持つ', () => {
    expect(parseHypocenterRecord(TOHOKU)!.magnitude).toBe(9.0) // '90'
    expect(parseHypocenterRecord(FIXED_DEPTH)!.magnitude).toBe(0.3) // '03'
    expect(parseHypocenterRecord(SHALLOW)!.magnitude).toBe(0.0) // '00'
  })
})

// 深さ欄に仕様外の書き方が稀に現れる。仕様は「深さフリーなら 1/100km の 5 桁、固定・刻みなら
// 整数 3 桁＋空白 2 つ」だが、これはどちらでもない（2016 年の熊本の余震に 18 件）。
const ODD_DEPTH =
  'J2016041811492482 024 323107 024 1303660 024  0 420707V   511   7271SOUTHERN KUMAMOTO PREF   24A'

describe('読めない行', () => {
  // 値を推測して混ぜるより捨てる方が安全。**「読めない」ことをここで固定しておく** ——
  // 将来この形を読めるようにするなら、意図的な変更としてこのテストを反転させること。
  it('仕様外の深さ欄は読まない', () => {
    expect(parseHypocenterRecord(ODD_DEPTH)).toBe(null)
  })

  it('長さが足りない行は null', () => {
    expect(parseHypocenterRecord('J2011031114461812')).toBe(null)
    expect(parseHypocenterRecord('')).toBe(null)
  })

  it('レコード長は 96（改行を含まない）', () => {
    expect(TOHOKU.length).toBe(RECORD_LENGTH)
    expect(FIXED_DEPTH.length).toBe(RECORD_LENGTH)
    expect(SHALLOW.length).toBe(RECORD_LENGTH)
  })

  // 安全弁: M が読めなくても他の項目は読める。M の欠測でレコードごと捨てると、
  // 「M は無いが位置は分かっている」地震が消える。
  it('M が読めない行でも位置と時刻は読める', () => {
    const noMag = TOHOKU.slice(0, 52) + '  ' + TOHOKU.slice(54)
    const r = parseHypocenterRecord(noMag)!
    expect(r.magnitude).toBe(null)
    expect(r.lat).toBeCloseTo(38.1035, 4)
    expect(new Date(r.timeMs).toISOString()).toBe('2011-03-11T05:46:18.120Z')
  })

  // 負の M（-0.1〜-3.0）は `A0` のような符号化で書かれる。読まずに null へ倒す
  // （この生成が採るのは M2.0 以上なので、符号化される範囲は最初から対象外）。
  // `Number('-0')` は `-0` になり、`-0 < 0` は false。素朴に比較すると「南緯 0 度 30 分」が
  // 北緯へ反転する。現行の収録範囲（気象庁が決定した震源のみ）では起きないが、`J` 以外へ
  // 広げたときに踏む。
  it('度が -0 でも分を負の側へ足す', () => {
    // 緯度欄を「- 0」「3000」（南緯 0 度 30.00 分）に差し替える
    const southOfEquator = OVERSEAS.slice(0, 21) + '- 0' + '3000' + OVERSEAS.slice(28)
    const r = parseHypocenterRecord(southOfEquator)!
    expect(r.lat).toBeCloseTo(-0.5, 6)
  })

  it('符号化された負の M は読まない', () => {
    const negative = TOHOKU.slice(0, 52) + 'A0' + TOHOKU.slice(54)
    expect(parseHypocenterRecord(negative)!.magnitude).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 年代を跨いだ書式（収録範囲を 1919 年まで広げたときに足したもの）
// ---------------------------------------------------------------------------

// 1923年9月1日 関東大震災の本震。気象庁の発表値は 35°19.87′N / 139°08.14′E /
// 深さ 23km / M7.9。**まとめ ZIP（1919〜1950 年）経路の代表。**
const KANTO =
  'J1923090111583168 026 351987 133 1390814 116 23     79J   12167T3 97KANAGAWA PREF            20K'

// 同日の相模湾の地震。**秒欄が空白**（時刻が分までしか判らない記録）。
// 1919〜1950 年に 18 件ある書き方で、2009 年以降には 1 件も無い。
const KANTO_SECOND_UNKNOWN =
  'J192309011203         3506       13930        0     73J    325Y     SAGAMI BAY ?               K'

// 1983年1月1日 三宅島近海。**小数部が 1 桁しかない書式**（1961〜1993 年）。
// 緯度分 '467 ' は 46.7 分。空白を無視して 467/100 と読むと 4.67 分になり、緯度が 42km ずれる。
// 震度欄は `F`（この年の三宅島近海に 984 件。数字の震度はこの年に無い）。
const MIYAKE_1983 =
  'J198301010036584  02  33467  09  139212  11  21  39 39V   111F  3104NEAR MIYAKEJIMA ISLAND     K'

// 1990年1月1日 茨城県北部。**深さの小数部も 1 桁**（' 553 ' = 55.3km）。
// 5 桁固定と決め打つと 5.53km になり、プレート境界の地震が地表付近に化ける。
const IBARAKI_1990 =
  'J199001011803133  02  36281  05  140352  08  553 20 45J45V1113  3 86NORTHERN IBARAKI PREF      K'

describe('小数部が空白で埋まる書式（1961〜1993 年）', () => {
  // 正: 小数部 1 桁を 1 桁として読む
  it('緯度分の小数部 1 桁を 10 分の 1 として読む', () => {
    const r = parseHypocenterRecord(MIYAKE_1983)!
    // 33°46.7′ / 139°21.2′。三宅島（34.08°N 139.53°E）の南西 約35km
    expect(r.lat).toBeCloseTo(33 + 46.7 / 60, 5)
    expect(r.lng).toBeCloseTo(139 + 21.2 / 60, 5)
    // 空白を無視して 467/100 と読んだ場合の値には**ならない**こと
    expect(r.lat).not.toBeCloseTo(33 + 4.67 / 60, 3)
  })

  it('秒の小数部 1 桁を 10 分の 1 として読む', () => {
    // '584 ' = 58.4 秒。00:36:58.4 JST = 前日 15:36:58.400 UTC
    const r = parseHypocenterRecord(MIYAKE_1983)!
    expect(new Date(r.timeMs).toISOString()).toBe('1982-12-31T15:36:58.400Z')
  })

  // 安全弁: 深さも同じ規則で読む。ここを 5 桁固定のままにすると 10 倍ずれる
  it('深さの小数部 1 桁も 10 分の 1 として読む', () => {
    const r = parseHypocenterRecord(IBARAKI_1990)!
    expect(r.depth).toBeCloseTo(55.3, 5)
    // 5 桁固定と決め打った場合の値には**ならない**こと
    expect(r.depth).not.toBeCloseTo(5.53, 2)
  })

  // 対照: 小数部が 2 桁ある現代の書式は従来どおり。**片方を直してもう片方を壊していない**こと
  it('小数部 2 桁の現代の書式は変わらない', () => {
    const r = parseHypocenterRecord(TOHOKU)!
    expect(r.lat).toBeCloseTo(38 + 6.21 / 60, 5)
    expect(r.depth).toBeCloseTo(23.74, 2)
    expect(parseHypocenterRecord(SHALLOW)!.depth).toBeCloseTo(6.68, 2)
    expect(parseHypocenterRecord(FIXED_DEPTH)!.depth).toBe(50)
  })
})

describe('まとめ ZIP（1919〜1950 年）の書式', () => {
  it('関東大震災の本震を気象庁の発表値どおりに読む', () => {
    const r = parseHypocenterRecord(KANTO)!
    // 11:58:31.68 JST = 02:58:31.68 UTC
    expect(new Date(r.timeMs).toISOString()).toBe('1923-09-01T02:58:31.680Z')
    expect(r.lat).toBeCloseTo(35 + 19.87 / 60, 5)
    expect(r.lng).toBeCloseTo(139 + 8.14 / 60, 5)
    expect(r.depth).toBe(23)
    expect(r.magnitude).toBe(7.9)
    expect(r.intensity).toBe('6')
    expect(r.secondUnknown).toBe(false)
  })

  it('秒欄が空白の行は秒を 0 にして印を立てる', () => {
    const r = parseHypocenterRecord(KANTO_SECOND_UNKNOWN)!
    // **捨てない。** 分までは判っているので統計には使える
    expect(r.secondUnknown).toBe(true)
    expect(new Date(r.timeMs).toISOString()).toBe('1923-09-01T03:03:00.000Z')
    expect(r.lat).toBeCloseTo(35.1, 5)
    expect(r.magnitude).toBe(7.3)
  })

  // 対照: 秒が入っている行に印は立たない（立ったら件数の報告が無意味になる）
  it('秒が入っている行には印を立てない', () => {
    expect(parseHypocenterRecord(TOHOKU)!.secondUnknown).toBe(false)
    expect(parseHypocenterRecord(MIYAKE_1983)!.secondUnknown).toBe(false)
  })
})

describe('最大震度', () => {
  it('数字の震度を生のまま読む', () => {
    expect(parseHypocenterRecord(TOHOKU)!.intensity).toBe('7')
    expect(parseHypocenterRecord(IBARAKI_1990)!.intensity).toBe('3')
  })

  // 知らない記号を数値へ潰さない。潰すと後から見分けられなくなる
  it('数字でない記号も生のまま読む', () => {
    expect(parseHypocenterRecord(MIYAKE_1983)!.intensity).toBe('F')
  })

  it('無感（空白）は null', () => {
    expect(parseHypocenterRecord(SHALLOW)!.intensity).toBe(null)
  })
})

describe('parseTrailingBlankDecimal', () => {
  // 整数部 2 桁（秒・緯度分・経度分）
  it('小数部の桁数で割る量が決まる', () => {
    expect(parseTrailingBlankDecimal('1251', 2)).toBeCloseTo(12.51, 6)
    expect(parseTrailingBlankDecimal('474 ', 2)).toBeCloseTo(47.4, 6)
    expect(parseTrailingBlankDecimal('47  ', 2)).toBe(47)
  })

  // 整数部 3 桁（深さ）
  it('整数部の桁数を指定できる', () => {
    expect(parseTrailingBlankDecimal(' 2374', 3)).toBeCloseTo(23.74, 6)
    expect(parseTrailingBlankDecimal(' 553 ', 3)).toBeCloseTo(55.3, 6)
    expect(parseTrailingBlankDecimal(' 50  ', 3)).toBe(50)
    expect(parseTrailingBlankDecimal('  0  ', 3)).toBe(0)
  })

  it('整数部が空白なら null', () => {
    expect(parseTrailingBlankDecimal('    ', 2)).toBe(null)
    expect(parseTrailingBlankDecimal('     ', 3)).toBe(null)
  })

  // 小数部の途中に空白が挟まる形は仕様外。値を推測せず捨てる
  it('小数部に空白が挟まる形は null', () => {
    expect(parseTrailingBlankDecimal('  0 4', 3)).toBe(null)
    expect(parseTrailingBlankDecimal('12 4', 2)).toBe(null)
  })

  it('レコード長は 96（改行を含まない）', () => {
    for (const line of [KANTO, KANTO_SECOND_UNKNOWN, MIYAKE_1983, IBARAKI_1990]) {
      expect(line.length).toBe(RECORD_LENGTH)
    }
  })
})
