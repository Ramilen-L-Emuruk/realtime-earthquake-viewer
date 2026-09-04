// アプリが扱う電文種別と、電文本体から再生用ペイロードを組み立てる処理。
//
// 種別の集合はライブ（services/dmdata.ts）とリプレイ（アーカイブ経路 services/dmdataReplay.ts・
// 当日経路 services/dmdataReplayLive.ts）が**共有する**。取得元は違っても「どの種別を扱うか」は
// 同じで、片方だけ種別を足すと、その電文が経路によって出たり出なかったりする。
// 実際に二重定義だった頃、ライブだけが VXSE43 を取り込み、予想震度の区域塗りがライブでのみ
// 削られる不具合が起きた（下記 EEW_TYPES）。
import {
  parseEEWFromXml, parseEarthquakeFromXml, parseTsunamiFromXml, parseLpgmFromXml,
  parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml,
} from './dmdataParser'
import type { ReplayPayload } from '../types/replay'

// DMDATA の購読分類。ライブ（WebSocket）とリプレイ（アーカイブ要求）で共有する。
// telegram.earthquake は地震・津波の両方を配信する（telegram.tsunami という分類は無い）。
//
// VXSE43 だけを含む `eew.warning` は購読しない（理由は下記 EEW_TYPES）。ここを片方の経路でだけ
// 足すと、同じ電文がライブでは届きリプレイでは届かない——実際にそれが起きた。
export const CLASSIFICATIONS = ['eew.forecast', 'telegram.earthquake'] as const

export const QUAKE_TYPES = new Set(['VXSE51', 'VXSE52', 'VXSE53', 'VXSE61'])
export const TSUNAMI_TYPES = new Set(['VTSE41', 'VTSE51', 'VTSE52'])
// EEW 電文種別: VXSE45（地震動予報）だけ。警報級もこれ 1 つで賄う。
//
// VXSE43（警報）を取らないのは、VXSE45 の警報報と同内容の複製が遅れて届き、`eventId` で束ねた
// EEW を古い内容で上書きして区域塗りを削るため。VXSE44（予報）は廃止予定で VXSE45 の下位互換。
// 判断の根拠と実害は docs/spec/data-sources-spec.md §2「EEW は VXSE45 だけを受ける」。
// VXSE42（配信テスト）は震源データを持たず EEW として表示できないため、ライブ側で別途処理する。
export const EEW_TYPES = new Set(['VXSE45'])
export const LPGM_TYPES = new Set(['VXSE62'])
// VYSE50=臨時情報（段階あり）、VYSE51/52=関連解説情報（段階なし）。別の型に読むため分ける。
export const NANKAI_TYPES = new Set(['VYSE50'])
export const COMMENTARY_TYPES = new Set(['VYSE51', 'VYSE52'])
export const KOHATSU_TYPES = new Set(['VYSE60'])

// リプレイが取り込む電文種別の全体。取得元の目録には対象外の種別も多数含まれるため、
// まずこれで絞ってから欠落を警告する（絞る前に警告すると、正常動作でログが埋まって
// 本当の異常が見えなくなる）。
export const HANDLED_TYPES = new Set([
  ...QUAKE_TYPES, ...TSUNAMI_TYPES, ...EEW_TYPES, ...LPGM_TYPES,
  ...NANKAI_TYPES, ...COMMENTARY_TYPES, ...KOHATSU_TYPES,
])

/**
 * 電文本体（気象庁の XML）から再生用ペイロードを組み立てる。
 *
 * 取得元（ライブ・アーカイブ・当日経路）を問わず、電文の読み取りはこの 1 本に集約する。
 * DMDATA は JSON 変換版も配るが採らない ―― 変換は独自スキーマで無損失を謳っておらず、
 * 実際に津波の注意文と予想波高の「未満」が落ちていた。
 *
 * @param headType 電文種別
 * @param xml 電文本体の XML
 * @returns 組み立てたペイロード。対象外の種別・パース失敗なら null
 */
export function buildXmlPayload(headType: string, xml: string): ReplayPayload | null {
  if (EEW_TYPES.has(headType)) {
    const event = parseEEWFromXml(headType, xml)
    return event ? { kind: 'event', event } : null
  }
  if (QUAKE_TYPES.has(headType)) {
    const event = parseEarthquakeFromXml(headType, xml)
    return event ? { kind: 'event', event } : null
  }
  if (TSUNAMI_TYPES.has(headType)) {
    const event = parseTsunamiFromXml(xml)
    return event ? { kind: 'event', event } : null
  }
  if (LPGM_TYPES.has(headType)) {
    const lpgm = parseLpgmFromXml(xml)
    return lpgm ? { kind: 'lpgm', data: lpgm } : null
  }
  if (NANKAI_TYPES.has(headType)) {
    const nankai = parseNankaiFromXml(xml)
    return nankai ? { kind: 'nankai', data: nankai } : null
  }
  if (COMMENTARY_TYPES.has(headType)) {
    const commentary = parseNankaiCommentaryFromXml(xml)
    return commentary ? { kind: 'nankaiCommentary', data: commentary } : null
  }
  if (KOHATSU_TYPES.has(headType)) {
    const kohatsu = parseVyse60FromXml(xml)
    return kohatsu ? { kind: 'kohatsu', data: kohatsu } : null
  }
  return null
}
