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
  parseQuakeNoticeFromXml, parseEarthquakeCountFromXml,
} from './dmdataParser'
import { decodeEstimatedIntensity } from '../utils/bufrEstimatedIntensity'
import { log } from '../utils/logger'
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
// VZSE40=地震・津波に関するお知らせ（観測点の入電停止・配信試験・訓練の予告などの運用連絡）。
// VXSE60=地震回数に関する情報（群発時の回数経過）。どちらも `telegram.earthquake` に含まれ、
// 追加の契約は要らない。**扱っていない種別を洗い出した経緯と、扱わないと決めたもの
// （IXAC41・WEPA60・VXSE56）の理由は docs/spec/data-sources-spec.md §2「扱う電文種別」。**
export const NOTICE_TYPES = new Set(['VZSE40'])
export const QUAKE_COUNT_TYPES = new Set(['VXSE60'])
// IXAC41=推計震度分布図作図用データ。**このアプリで唯一の二進電文（BUFR）**で、
// XML でも JSON でも届かない。512KiB を超えると分割配信されるため、読む前に結合が要る
// （→ `bufrTelegramAssembly.ts`）。経路ごとに本文の取り方が違うので、
// **`buildXmlPayload` ではなく `buildBinaryPayload` を通す。**
export const ESTIMATED_INTENSITY_TYPES = new Set(['IXAC41'])

/** その種別が二進で届くか。取得元ごとに本文の取り方（テキストか bytes か）を分けるのに使う。 */
export function isBinaryTelegramType(headType: string): boolean {
  return ESTIMATED_INTENSITY_TYPES.has(headType)
}

// リプレイが取り込む電文種別の全体。取得元の目録には対象外の種別も多数含まれるため、
// まずこれで絞ってから欠落を警告する（絞る前に警告すると、正常動作でログが埋まって
// 本当の異常が見えなくなる）。
export const HANDLED_TYPES = new Set([
  ...QUAKE_TYPES, ...TSUNAMI_TYPES, ...EEW_TYPES, ...LPGM_TYPES,
  ...NANKAI_TYPES, ...COMMENTARY_TYPES, ...KOHATSU_TYPES,
  ...NOTICE_TYPES, ...QUAKE_COUNT_TYPES, ...ESTIMATED_INTENSITY_TYPES,
])

/**
 * 地震カードの履歴（最大 7 日）と一緒に復元する種別。
 *
 * **初期状態（24 時間）では足りないものだけを挙げる。** 長周期地震動は地震ごとに紐づくので
 * カードの一覧と同じ厚みが要り、残りは 24 時間より長く画面に出続ける帯（地震回数・お知らせ・
 * 解説情報・後発地震は発表から 7 日で失効し、南海トラフ臨時情報は調査終了か取消で消える）。
 * どれも取得済みのアーカイブに入っているので、拾うだけで追加の通信は要らない。
 *
 * **津波・緊急地震速報は入れない。** 「その時刻に発表中だったか」の判定は初期状態の担当で、
 * 遡り幅も目的も違う（イベント単位の生存判定が要る）。
 *
 * **推計震度分布図（IXAC41）も入れない。** 最新 1 通しか持たない設計で、遡っても過去の
 * カードには紐づかない（引き当ては地震発現時刻）。理由は settings-pwa-spec.md §6。
 */
export const HISTORY_EXTRA_TYPES = new Set([
  ...LPGM_TYPES, ...NANKAI_TYPES, ...COMMENTARY_TYPES, ...KOHATSU_TYPES,
  ...NOTICE_TYPES, ...QUAKE_COUNT_TYPES,
])

/**
 * 履歴で復元する電文の「同じものとみなす鍵」。同じ鍵のうち最新 1 通だけを残す。
 *
 * 長周期地震動だけ地震ごとに持つ（`lpgmByEventId`）ので鍵に識別子を含める。残りは
 * 画面に 1 つだけ出る帯なので種別だけでよい。
 *
 * @returns 履歴で復元しない種別なら null
 */
export function historyExtraKey(payload: ReplayPayload): string | null {
  switch (payload.kind) {
    case 'lpgm': return `lpgm:${payload.data.eventId}`
    case 'nankai':
    case 'nankaiCommentary':
    case 'kohatsu':
    case 'quakeNotice':
    case 'earthquakeCount':
      return payload.kind
    default:
      return null
  }
}

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
    const event = parseTsunamiFromXml(headType, xml)
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
  if (NOTICE_TYPES.has(headType)) {
    const notice = parseQuakeNoticeFromXml(xml)
    return notice ? { kind: 'quakeNotice', data: notice } : null
  }
  if (QUAKE_COUNT_TYPES.has(headType)) {
    const count = parseEarthquakeCountFromXml(xml)
    return count ? { kind: 'earthquakeCount', data: count } : null
  }
  if (isBinaryTelegramType(headType)) {
    // **二進電文がここへ来たら、その経路がバイナリの受け口を持っていない。** `HANDLED_TYPES`
    // には入っているので手前の絞り込みは通り抜け、`xml` には壊れた文字列が入っている。
    // 黙って null を返すと「対象外だった」のと見分けが付かないので記録する。
    log.warn(`[dmdata] ${headType} は二進電文です。XML の経路へ流れています（buildBinaryPayload を通すこと）`)
    return null
  }
  return null
}

/**
 * 二進電文（BUFR）の本文からペイロードを組み立てる。
 *
 * **結合済みのバイト列を渡すこと。** 分割の結合は取得元ごとに事情が違う（ライブは到来順、
 * アーカイブは tar の中、当日経路は一覧の並び）ため、この関数の外——`BufrFragmentStore`——が
 * 受け持つ。
 *
 * @param headType 電文種別
 * @param bytes 結合済みの本文
 * @param id 電文 id
 * @param time 発表時刻
 */
export function buildBinaryPayload(
  headType: string,
  bytes: Uint8Array,
  id: string,
  time: string,
): ReplayPayload | null {
  if (ESTIMATED_INTENSITY_TYPES.has(headType)) {
    const data = decodeEstimatedIntensity(bytes, id, time)
    return data ? { kind: 'estimatedIntensity', data } : null
  }
  return null
}
