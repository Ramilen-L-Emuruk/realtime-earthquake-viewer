// 震源レコードのパーサの回帰テスト。
//
// **カラム位置を 1 バイト間違えるだけで全件が静かに壊れる。** 型でも実行時エラーでも捕まらず、
// 出来上がった JSON をよほど疑って見ないと気づけない。ここで実レコードを固定しておく。
//
// テストデータは気象庁「地震月報（カタログ編）」震源データから抜いた実レコード
// （出典: https://www.data.jma.go.jp/eqev/data/bulletin/hypo.html ・公共データ利用規約 第1.0版）。

import { describe, it, expect } from 'vitest'
import { parseHypocenterRecord, RECORD_LENGTH } from './hypocenterRecord'

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
