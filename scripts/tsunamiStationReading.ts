// 潮位観測点名（津波の観測情報で声になる名前）の読みを突き合わせる処理。
//
// 震度観測点（`stationReading.ts`）と分けているのは、**気象庁のふりがなの形が違う**ため。
// 沿岸の観測点は純粋なかな（`浜中町霧多布港` → `はまなかちょうきりたっぷこう`）だが、
// 沖合の観測点は距離と単位と識別英字がそのまま残る（`宮城沖５０ｋｍＢ` → `みやぎおき５０ｋｍＢ`）。
// **ふりがなだけでは正解の読みを作れない**ので、そこは別に当てる（→ {@link offshoreExpectedReading}）。
//
// 生成スクリプト（`build-station-readings.ts`）から使う。HTTP を持たない純粋な変換だけを置き、
// エンジンへの問い合わせは呼び出し側に任せる。

import { hasUnreadableFurigana, normalizeReading } from './stationReading'

/**
 * 沖合の観測点名の形。地名 ＋ 距離（全角数字）＋ `ｋｍ` ＋ 識別英字（全角 1 文字。付かないものもある）。
 *
 * 気象庁の個別コード表（PointTsunami）に載る 609 点のうち、この形を取るのが 396 点
 * （内容部 246 点と、ヘッダ部でのみ使う簡略名 150 点）。残り 213 点は沿岸の潮位観測点で地名だけ。
 * 全角以外の書き方は 1 件も無い（2026-09 時点の実測）。
 *
 * **609 は名前で数えた値。** コード表の行は 611 あるが、うち 2 件（`神奈川沖４０ｋｍ`・
 * `静岡沖５０ｋｍ`）は内容部とヘッダ部の両方に同じ名前で載っている。辞書のキーは名前なので、
 * 数えるのは名前の側。
 */
const OFFSHORE_NAME_RE = /^(.+?)([０-９]+ｋｍ[Ａ-Ｚ]?)$/

/** 距離部分（`５０ｋｍＢ`）の形。識別英字は付かないこともある。 */
const DISTANCE_RE = /^([０-９]+)ｋｍ([Ａ-Ｚ]?)$/

/** 沖合の観測点名の形をしているかを返す（識別英字の有無を問わない）。 */
export function isOffshoreStationName(name: string): boolean {
  return OFFSHORE_NAME_RE.test(name)
}

/**
 * 識別英字が付かない沖合の名前（`宮城沖５０ｋｍ`）かを返す。
 *
 * 生成物の検査（`stationReadings.test.ts`）が、辞書のキーが実在する観測点名かを見るのに使う。
 * **この形はヘッダ部でのみ使う簡略名が大半で、座標表（`tsunami-obs-coords.json`）に載らない**
 * ため、名前の一覧との突き合わせでは実在すると言えない（形で見分けるしかない）。
 * 識別英字が付く形（246 点）は座標表にあるので、そちらは突き合わせで確かめられる。
 */
export function isHeaderOnlyStationName(name: string): boolean {
  return DISTANCE_RE.exec(OFFSHORE_NAME_RE.exec(name)?.[2] ?? '')?.[2] === ''
}

/**
 * 距離部分を数字と識別英字へ分ける。形が違えば null。
 *
 * 生成側が「固定した正解が実在する値をすべて覆えているか」を確かめるのに使う
 * （→ `build-station-readings.ts` の `DISTANCE_READING_FIXTURES`）。
 */
export function splitDistance(distance: string): { number: string; letter: string } | null {
  const match = DISTANCE_RE.exec(distance)
  return match ? { number: match[1], letter: match[2] } : null
}

/** 観測点名とふりがなの噛み合わせ。`unreadable` は生成を止める側で理由ごと記録する。 */
export type TsunamiStationShape =
  | { readonly kind: 'coastal' }
  | { readonly kind: 'offshore'; readonly placeFurigana: string; readonly distance: string }
  | { readonly kind: 'unreadable'; readonly reason: string }

/**
 * 観測点名とふりがなの形を見分ける。
 *
 * 沖合と判定するのは**名前とふりがなの両方が同じ距離部分で終わるとき**だけ。片方だけが
 * その形なら `unreadable` を返す —— 上流の書き方が変わった印なので、生成側で止めるため。
 * 距離部分を名前から推測して埋めると、ふりがなと食い違ったまま辞書を作ることになる。
 */
export function classifyTsunamiStation(name: string, furigana: string): TsunamiStationShape {
  const nameMatch = OFFSHORE_NAME_RE.exec(name)
  const furiganaMatch = OFFSHORE_NAME_RE.exec(furigana)
  if (!nameMatch && !furiganaMatch) {
    if (hasUnreadableFurigana(furigana)) {
      return { kind: 'unreadable', reason: `ふりがなとして読めない（${furigana || '空'}）` }
    }
    return { kind: 'coastal' }
  }
  if (!nameMatch || !furiganaMatch) {
    return {
      kind: 'unreadable',
      reason: `名前とふりがなで距離の書き方が食い違う（${name} / ${furigana}）`,
    }
  }
  const [, place, distance] = nameMatch
  const [, placeFurigana, furiganaDistance] = furiganaMatch
  if (distance !== furiganaDistance) {
    return {
      kind: 'unreadable',
      reason: `距離部分がふりがなと一致しない（${distance} / ${furiganaDistance}）`,
    }
  }
  if (hasUnreadableFurigana(placeFurigana)) {
    return {
      kind: 'unreadable',
      reason: `地名部分のふりがなが読めない（${place} → ${placeFurigana}）`,
    }
  }
  return { kind: 'offshore', placeFurigana, distance }
}

/**
 * 沖合の観測点名の期待する読み（正規化済み）。地名のふりがなに、距離部分の読みを繋ぐ。
 *
 * **距離部分の読みは気象庁から得られないので、呼び出し側がエンジンへ訊く。** ふりがなが
 * カナ化していない範囲（`５０ｋｍＢ`）の正解がどこにも公表されていないため、
 * 「その部分だけを単独で読ませた読み」を正解として使う。単独の形では全 91 通りが正しく
 * 読まれることを実測で確かめており、代表値は生成側の照合（`DISTANCE_READING_FIXTURES`）で
 * 固定してある —— エンジンの版が変わってそこが崩れたら生成が止まる。
 */
export function offshoreExpectedReading(placeFurigana: string, distanceReading: string): string {
  return normalizeReading(placeFurigana) + normalizeReading(distanceReading)
}
