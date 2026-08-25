// 日別「震源リスト」パーサの回帰テスト。
//
// **空白区切りに見えて空白では割れない表**を読む。座標の分が 1 桁のとき中に空白が入るため、
// 素朴に割ると深さと M を取り違える。ここで実レコードを固定しておく。
//
// テストデータは気象庁「震源リスト」から抜いた実レコード
// （出典: https://www.data.jma.go.jp/eqev/data/daily_map/ ・公共データ利用規約 第1.0版）。

import { describe, it, expect } from 'vitest'
import { extractDailyHypocenterRows, parseDailyHypocenterLine } from './hypocenterDailyRecord'

// 2024年1月1日 令和6年能登半島地震の本震。気象庁の発表値は
// 37°29.7′N / 137°16.2′E / 深さ 16km / M7.6。**日別経路の代表。**
const NOTO = "2024  1  1 16:10 22.5  37°29.7'N 137°16.2'E   16     7.6  石川県能登地方                 "

// 経度の分が 1 桁（`137° 7.1'E`）。**座標の中に空白が入る。**
const SINGLE_DIGIT_MIN = "2024  1  1 00:32  6.1  35°43.4'N 137° 7.1'E   10     0.9  岐阜県飛騨地方                 "

// M が未決定（`-`）。1 日あたり 5〜165 件ある。
const NO_MAGNITUDE = "2024  1  1 00:33 56.0  44°20.5'N 149° 4.0'E   30     -    択捉島南東沖                  "

describe('parseDailyHypocenterLine', () => {
  it('能登半島地震の本震を気象庁の発表値どおりに読む', () => {
    const r = parseDailyHypocenterLine(NOTO)!
    expect(r).not.toBe(null)
    // 16:10:22.5 JST = 07:10:22.5 UTC
    expect(new Date(r.timeMs).toISOString()).toBe('2024-01-01T07:10:22.500Z')
    expect(r.lat).toBeCloseTo(37 + 29.7 / 60, 5)
    expect(r.lng).toBeCloseTo(137 + 16.2 / 60, 5)
    expect(r.depth).toBe(16)
    expect(r.magnitude).toBe(7.6)
    expect(r.region).toBe('石川県能登地方')
  })

  // 実行環境のタイムゾーンで結果が変わってはいけない（CI は UTC で回る）
  it('時刻は実行環境のタイムゾーンに依存しない', () => {
    const r = parseDailyHypocenterLine(NOTO)!
    expect(new Date(r.timeMs).getUTCHours()).toBe(7)
    expect(new Date(r.timeMs).getUTCMinutes()).toBe(10)
  })

  // 安全弁: 空白で割ると列がずれる行。深さと M を取り違えていないこと
  it('座標の分が 1 桁でも深さと M を取り違えない', () => {
    const r = parseDailyHypocenterLine(SINGLE_DIGIT_MIN)!
    expect(r.lng).toBeCloseTo(137 + 7.1 / 60, 5)
    expect(r.depth).toBe(10)
    expect(r.magnitude).toBe(0.9)
    // 空白で割った場合、経度が '137°' で切れて深さの位置に "7.1'E" が来る。
    // そのとき深さは NaN か 7.1 になる —— どちらにもなっていないこと
    expect(r.depth).not.toBeCloseTo(7.1, 1)
  })

  // 対照: 分が 2 桁の行も同じ規則で読める（片方を直してもう片方を壊していないこと）
  it('分が 2 桁の座標も読める', () => {
    const r = parseDailyHypocenterLine(NOTO)!
    expect(r.lng).toBeCloseTo(137.27, 4)
  })

  it('M が未決定なら null（レコードごと捨てない）', () => {
    const r = parseDailyHypocenterLine(NO_MAGNITUDE)!
    expect(r.magnitude).toBe(null)
    // 位置と時刻は読めている
    expect(r.lat).toBeCloseTo(44 + 20.5 / 60, 5)
    expect(r.depth).toBe(30)
  })

  it('形が違う行は null', () => {
    expect(parseDailyHypocenterLine('')).toBe(null)
    expect(parseDailyHypocenterLine('見出し行のようなもの')).toBe(null)
    // 列幅が変わって緯度の書き方が崩れた場合。**黙って誤読せず落ちること**
    expect(parseDailyHypocenterLine(NOTO.replace("37°29.7'N", '37.495N'))).toBe(null)
  })

  it('全行が 82 文字（上流の列幅が変わったら気づけるよう固定する）', () => {
    for (const line of [NOTO, SINGLE_DIGIT_MIN, NO_MAGNITUDE]) {
      expect(line.length).toBe(82)
    }
  })
})

describe('extractDailyHypocenterRows', () => {
  it('pre の中の震源リストだけを取り出す', () => {
    const html = `<html><body><p>前置き</p><pre>\n見出しのような行\n${NOTO}\n${SINGLE_DIGIT_MIN}\n</pre><p>後書き</p></body></html>`
    const rows = extractDailyHypocenterRows(html)
    expect(rows).toEqual([NOTO, SINGLE_DIGIT_MIN])
  })

  // **0 件で返さず例外にする。** ページ構成が変わったのに「その日は地震が無かった」として
  // 通ってしまうと、静かに穴が空いたまま生成が成功する
  it('pre が無ければ例外', () => {
    expect(() => extractDailyHypocenterRows('<html><body>お探しのページはありません</body></html>')).toThrow(/pre/)
  })

  it('pre が空なら 0 件（例外にはしない）', () => {
    expect(extractDailyHypocenterRows('<pre>\n\n</pre>')).toEqual([])
  })
})
