// リプレイが扱う電文種別と、電文本体から再生用ペイロードを組み立てる処理。
//
// アーカイブ経路（services/dmdataReplay.ts）と当日経路（services/dmdataReplayLive.ts）の
// 両方から使う。取得元は違っても「どの種別を扱うか」「本体をどのパーサに渡すか」は同じで、
// 片方だけ種別を足すと、その電文が取得元によって出たり出なかったりする。
import {
  parseEEW, parseEarthquake, parseTsunami, parseLpgm,
  parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml,
} from './dmdataParser'
import type { ReplayPayload } from '../types/replay'

export const QUAKE_TYPES = new Set(['VXSE51', 'VXSE52', 'VXSE53', 'VXSE61'])
export const TSUNAMI_TYPES = new Set(['VTSE41', 'VTSE51', 'VTSE52'])
// DMD-8: VXSE43（EEW 警報）を追加。従来は archive リプレイ時に警報級 EEW が黙って
// 捨てられ、実地震シナリオ収録の警報経路が完全に欠落していた。
//
// ただし VXSE43 は分類 `eew.warning` にしか無く、アーカイブ経路が要求している分類
// （`telegram.earthquake,eew.forecast`）には含まれないため、実際には流れてこない。
// 当日経路も同様（EEW を引く /v2/gd/eew が返すのは VXSE45 だけ）。
// 実データで確認したところ VXSE43 は対応する VXSE45 の警報報と同一内容が数十ミリ秒後に
// 流れる複製で、報番号だけが独立している（VXSE45 の別の報と衝突する）。取り込まないことが
// 欠落ではない理由は docs/spec/settings-pwa-spec.md §6「当日ぶんの取得元」を参照。
export const EEW_TYPES = new Set(['VXSE43', 'VXSE45'])
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
