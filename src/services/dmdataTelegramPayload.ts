// アプリが扱う電文種別と、電文本体から再生用ペイロードを組み立てる処理。
//
// 種別の集合はライブ（services/dmdata.ts）とリプレイ（アーカイブ経路 services/dmdataReplay.ts・
// 当日経路 services/dmdataReplayLive.ts）が**共有する**。取得元は違っても「どの種別を扱うか」は
// 同じで、片方だけ種別を足すと、その電文が経路によって出たり出なかったりする。
// 実際に二重定義だった頃、ライブだけが VXSE43 を取り込み、予想震度の区域塗りがライブでのみ
// 削られる不具合が起きた（下記 EEW_TYPES）。
import {
  parseEEW, parseEarthquake, parseTsunami, parseLpgm,
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

/**
 * XML 形式でしか読めない種別（南海トラフ関連・後発地震注意情報）。
 *
 * これらは XML パーサ（`parseNankaiFromXml` 等）しか無いため、JSON 版の電文が存在しても
 * そちらは使えない。取得元ごとに「どちらの版を拾うか」の判定が要る。
 */
export const XML_ONLY_TYPES = new Set([...NANKAI_TYPES, ...COMMENTARY_TYPES, ...KOHATSU_TYPES])

// リプレイが取り込む電文種別の全体。取得元の目録には対象外の種別も多数含まれるため、
// まずこれで絞ってから欠落を警告する（絞る前に警告すると、正常動作でログが埋まって
// 本当の異常が見えなくなる）。
export const HANDLED_TYPES = new Set([
  ...QUAKE_TYPES, ...TSUNAMI_TYPES, ...EEW_TYPES, ...LPGM_TYPES, ...XML_ONLY_TYPES,
])

/**
 * JSON 形式の電文本体から再生用ペイロードを組み立てる。
 *
 * @param headType 電文種別（VXSE53 等）
 * @param data 電文本体の JSON
 * @returns 組み立てたペイロード。対象外の種別・パース失敗なら null
 */
export function buildJsonPayload(headType: string, data: Record<string, unknown>): ReplayPayload | null {
  if (EEW_TYPES.has(headType)) {
    const event = parseEEW(headType, data)
    return event ? { kind: 'event', event } : null
  }
  if (QUAKE_TYPES.has(headType)) {
    const event = parseEarthquake(headType, data)
    return event ? { kind: 'event', event } : null
  }
  if (TSUNAMI_TYPES.has(headType)) {
    const event = parseTsunami(headType, data)
    return event ? { kind: 'event', event } : null
  }
  if (LPGM_TYPES.has(headType)) {
    const lpgm = parseLpgm(data)
    return lpgm ? { kind: 'lpgm', data: lpgm } : null
  }
  return null
}

/**
 * XML 形式の電文本体から再生用ペイロードを組み立てる。
 *
 * @param headType 電文種別（VYSE50/51/52/60）
 * @param xml 電文本体の XML
 * @returns 組み立てたペイロード。対象外の種別・パース失敗なら null
 */
export function buildXmlPayload(headType: string, xml: string): ReplayPayload | null {
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
