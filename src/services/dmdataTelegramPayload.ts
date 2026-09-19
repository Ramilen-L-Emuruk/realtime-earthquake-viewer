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
import { decodeEstimatedIntensity, TELEGRAM_KIND_NORMAL } from '../utils/bufrEstimatedIntensity'
import { log } from '../utils/logger'
import type { ReplayPayload } from '../types/replay'

// 電文本体を取りに行く URL の基底。一覧・目録が返す電文 id をこの後ろへ繋ぐ。
// **取得元をまたいで共有する**——リプレイの当日経路とライブ起動時の復元が同じ形で組み立てるので、
// 別々に持つと片方だけ直したときに一方の経路から電文本体が引けなくなる。
export const TELEGRAM_DATA_BASE = 'https://data.api.dmdata.jp/v1/'

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
// （WEPA60・VXSE56）の理由は docs/spec/data-sources-spec.md §2「扱う電文種別」。**
export const NOTICE_TYPES = new Set(['VZSE40'])
export const QUAKE_COUNT_TYPES = new Set(['VXSE60'])
// 推計震度分布図作図用データ。**このアプリで唯一の二進電文（BUFR）**で、XML でも JSON でも
// 届かない。大きい電文は分割配信されるため、読む前に結合が要る（→ `bufrTelegramAssembly.ts`）。
// 経路ごとに本文の取り方が違うので、**`buildXmlPayload` ではなく `buildBinaryPayload` を通す。**
//
// **2 種別ある。** IXAC41 が 250m メッシュ、**IXAC40 はその前身で 1km メッシュ**。気象庁は
// 2026-02-02 に IXAC40 の配信を終了したので、**ライブで届くのは IXAC41 だけ** —— IXAC40 は
// IXAC41 提供開始前の地震を再生したときにだけ現れる。**分割の符号の体系も違う**ので、
// 種別を足すだけでは結合できない（→ `bufrTelegramAssembly.ts` の `fragmentIndex`）。
export const ESTIMATED_INTENSITY_TYPES = new Set(['IXAC41', 'IXAC40'])

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
 * **推計震度分布図（IXAC41・IXAC40）も入れない。** 最新 1 通しか持たない設計で、遡っても
 * 過去のカードには紐づかない（引き当ては地震発現時刻）。理由は settings-pwa-spec.md §6。
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
/**
 * 二進電文から作れるペイロード。
 *
 * **ここへ種別を足すと `BINARY_TEST_PREDICATES` が型エラーになる。** 非 XML 電文は `test`
 * フラグで見分けられないので（`isFilteredBinaryTelegram` の説明）、抑制の判定を書き足し
 * 忘れると**試験・訓練の配信がそのまま画面へ出る** —— しかも例外もログも出ないので、
 * 気づく手がかりが無い。
 */
export type BinaryReplayPayload = Extract<ReplayPayload, { kind: 'estimatedIntensity' }>

/**
 * 種別ごとの「試験・訓練の配信か」の判定。**網羅の見張りを兼ねる。**
 *
 * `satisfies` が `BinaryReplayPayload` の全種別を要求するので、**種別を足すとここが
 * 型エラーになる**。
 *
 * **持たせるのは述語そのもの。** 種別の名前だけを並べた表にすると、型エラーを消すために
 * キーを 1 行足すだけで通ってしまい、**判定を書き忘れたまま新しい種別が素通しする**
 * （非 XML 電文は `test` フラグで見分けられないので、素通しは試験報が画面へ出ることを意味する）。
 * 述語を要求すれば、書かずに型検査を通す道が無い。
 *
 * **判別可能ユニオンの `switch` では見張れない。** いまは種別が 1 つだけで、絞り込みは
 * ユニオンにしか効かないため `default` 節の `never` チェックが成立しない
 * （2 つ目が入るまで型検査が止まらないので、いちばん必要なときに効かない）。
 */
const BINARY_TEST_PREDICATES = {
  // 推計震度分布図（IXAC41・IXAC40）。本文の電文の種類（BUFR の `0-01-242`）で見分ける
  estimatedIntensity: p => p.data.telegramKind !== TELEGRAM_KIND_NORMAL,
} satisfies {
  [K in BinaryReplayPayload['kind']]: (payload: Extract<BinaryReplayPayload, { kind: K }>) => boolean
}

export function buildBinaryPayload(
  headType: string,
  bytes: Uint8Array,
  id: string,
  time: string,
): BinaryReplayPayload | null {
  if (ESTIMATED_INTENSITY_TYPES.has(headType)) {
    const data = decodeEstimatedIntensity(bytes, id, time, headType)
    return data ? { kind: 'estimatedIntensity', data } : null
  }
  return null
}

/**
 * 二進電文が試験・訓練の配信で、いま流すべきでないかを判定する。
 *
 * **非 XML 電文では、一覧・WebSocket の `test` フラグで判定できない。** 配信元の
 * リファレンスが 2 つのことを別々に明記している。
 *
 * - `socket.start` の `test` パラメータ:
 *   「XML電文以外のテスト配信は no 時も配信されます。本文中を参照するようにしてください。」
 *   —— つまり `test: "no"`（このアプリの既定）でも**届く**
 * - `telegram.list` / `websocket` の `test` フィールド:
 *   「XML電文以外のテスト配信は常に false になります。本文中を参照するようにしてください。」
 *   —— つまり届いたものを**見分けられない**
 *
 * **2 つが揃うと、XML 側の抑制（`head.test` を見るもの）は原理的に発火しない。**
 * だから本文から読んだ電文の種類（BUFR の `0-01-242`）で判定する。
 *
 * **判定をここへ集約するのは、取得元が 3 つあるため**（ライブ・アーカイブ経路・当日経路）。
 * 呼び出し側ごとに書くと、経路によって試験報が出たり出なかったりする。
 *
 * **戻り値を `buildBinaryPayload` の `null` に混ぜないこと。** あちらの `null` は
 * 「読み取りに失敗した」で、呼び出し元 3 箇所がそれを異常として記録する。試験報は正常な
 * 配信なので、同じ値で返すと**記録が「読み取りに失敗」と嘘をつく**。
 *
 * **引数は `BinaryReplayPayload` に絞ってある。** `ReplayPayload` で受けると、下の `switch` が
 * 二進以外の種別まで抱えることになり「網羅していない」を型検査に見せられない。
 *
 * @param payload `buildBinaryPayload` が返したペイロード
 * @param includeTest 設定「試験報を受信（検証用）」が有効か
 * @returns 流さないなら true
 */
export function isFilteredBinaryTelegram(payload: BinaryReplayPayload, includeTest: boolean): boolean {
  if (includeTest) return false
  // 種別ごとの述語を引く。**表に無い種別は型検査が先に止めるので、ここへは来ない**
  const predicate = BINARY_TEST_PREDICATES[payload.kind] as (p: BinaryReplayPayload) => boolean
  return predicate(payload)
}
