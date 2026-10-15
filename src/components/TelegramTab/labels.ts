import type { TelegramLogEntry, TelegramLogKind } from '../../types/earthquake'
import { log } from '../../utils/logger'
import {
  QUAKE_TYPES, TSUNAMI_TYPES, EEW_HEAD_TYPES, LPGM_TYPES, NANKAI_TYPES, COMMENTARY_TYPES,
  KOHATSU_TYPES, NOTICE_TYPES, QUAKE_COUNT_TYPES, ESTIMATED_INTENSITY_TYPES,
} from '../../services/dmdataTelegramPayload'
import { DISPATCHED_WITHOUT_PARSER } from '../../services/dmdata'

/**
 * 電文種別コードから引く種別名。名前は気象庁の情報名に揃える。
 *
 * **扱うコードはすべてここに載せる。** 鍵がコードの文字列なので、書き漏らしても型検査には
 * 掛からず、行にはコードだけが出る。漏れは `labels.test.ts` が、アプリが扱う種別の集合
 * （`dmdataTelegramPayload.ts`・`dmdata.ts`・`p2pquake.ts`）と突き合わせて落とす。
 *
 * **扱わないコードの行にコードだけが出るのは正しい。** P2PQuake は扱わないコードも `filtered`
 * で記録し、DMDATA も試験報を捨てるとき（`includeTest` が無効）は種別を問わず記録する。
 * これらに名前を付ける必要はない。引くときは `headTypeLabel` を通す。
 *
 * VYSE51・VYSE52 の括弧書きは、気象庁の情報番号コード（`InfoSerial` の 210・219 が「臨時解説」、
 * 200 が「定例解説」）の名前から取っている。データ種類コードの表ではどちらも括弧の無い
 * 「南海トラフ地震関連解説情報」（2026-10-15 ユーザー承認）。
 *
 * VXSE43 は、予報が無く警報だけを受けている人には緊急地震速報そのもの。予報を受けている人には
 * 購読外だが、配信分類が変わって届いた場合に `filtered` として記録する（services/dmdata.ts）。
 */
export const HEAD_TYPE_LABEL: Readonly<Record<string, string>> = {
  VXSE42: 'EEW配信テスト',
  VXSE43: 'EEW警報',
  VXSE44: 'EEW予報（旧形式）',
  VXSE45: 'EEW地震動予報',
  VXSE51: '震度速報',
  VXSE52: '震源情報',
  VXSE53: '震源・震度',
  VXSE60: '地震回数に関する情報',
  VXSE61: '顕著な地震の震源要素更新のお知らせ',
  VXSE62: '長周期',
  VTSE41: '津波警報・注意報',
  VTSE51: '津波観測に関する情報',
  VTSE52: '沖合の津波観測に関する情報',
  VYSE50: '南海トラフ地震臨時情報',
  VYSE51: '南海トラフ地震関連解説情報（臨時解説）',
  VYSE52: '南海トラフ地震関連解説情報（定例解説）',
  VYSE60: '北海道・三陸沖後発地震注意情報',
  VZSE40: '地震・津波に関するお知らせ',
  IXAC41: '推計震度分布図作図用データ',
  IXAC40: '推計震度分布図作図用データ（旧形式）',
  '551': '地震情報',
  '552': '津波情報',
  '556': 'EEW',
}

/** 種別名。載っていないコードはコードそのものを返す（継承したキーは引かない）。 */
export function headTypeLabel(headType: string): string {
  return Object.prototype.hasOwnProperty.call(HEAD_TYPE_LABEL, headType) ? HEAD_TYPE_LABEL[headType] : headType
}

/**
 * 行の前段に出す短い名前。**書いた順が、種別の絞り込みの選択肢の並びになる**
 * （`KIND_OPTIONS`）。`Record<TelegramLogKind, string>` なので、種別を足して書き忘れると
 * 型エラーになり、選択肢にも自動で並ぶ。
 */
export const KIND_LABEL: Readonly<Record<TelegramLogKind, string>> = {
  eew: 'EEW',
  quake: '地震',
  tsunami: '津波',
  lpgm: '長周期',
  nankai: '南海トラフ臨時情報',
  nankaiCommentary: '南海トラフ解説情報',
  kohatsu: '後発地震注意情報',
  quakeNotice: 'お知らせ',
  earthquakeCount: '地震回数',
  estimatedIntensity: '推計震度分布図',
}

/**
 * 電文種別コードが属する種別。DMDATA の種別の集合と P2PQuake のコードから引く。
 * パーサーを通らない VXSE42（配信テスト）・VXSE43・VXSE44 も緊急地震速報の一族として数える。
 *
 * **読めた行の `kind` とは別の表。** 読めた行の `kind` は `dmdata.ts` の `handleMessage` の分岐と
 * `p2pquake.ts` の `codeToLogKind` が付けるので、そちらで種別を付け替えたらここも揃えること
 * （食い違うと、同じ種別の電文が読めたかどうかで別の絞り込みに入る）。
 */
const KIND_OF_HEAD_TYPE: ReadonlyMap<string, TelegramLogKind> = new Map<string, TelegramLogKind>([
  ...[...EEW_HEAD_TYPES, ...DISPATCHED_WITHOUT_PARSER].map(code => [code, 'eew'] as const),
  ...[...QUAKE_TYPES].map(code => [code, 'quake'] as const),
  ...[...TSUNAMI_TYPES].map(code => [code, 'tsunami'] as const),
  ...[...LPGM_TYPES].map(code => [code, 'lpgm'] as const),
  ...[...NANKAI_TYPES].map(code => [code, 'nankai'] as const),
  ...[...COMMENTARY_TYPES].map(code => [code, 'nankaiCommentary'] as const),
  ...[...KOHATSU_TYPES].map(code => [code, 'kohatsu'] as const),
  ...[...NOTICE_TYPES].map(code => [code, 'quakeNotice'] as const),
  ...[...QUAKE_COUNT_TYPES].map(code => [code, 'earthquakeCount'] as const),
  ...[...ESTIMATED_INTENSITY_TYPES].map(code => [code, 'estimatedIntensity'] as const),
  ['551', 'quake'], ['552', 'tsunami'], ['556', 'eew'],
])

/**
 * 行の種別。読めた行は読んだ結果の `kind` を使い、持たない行（結合待ちの断片・読み取りに
 * 失敗した行・捨てた試験報）は電文種別コードから引く。どちらも無ければ `undefined`
 * （扱わないコード）。種別での絞り込みに断片や失敗した行も含めるため（2026-10-15 ユーザー承認）。
 */
export function telegramLogKindOf(entry: Pick<TelegramLogEntry, 'kind' | 'headType'>): TelegramLogKind | undefined {
  return entry.kind ?? KIND_OF_HEAD_TYPE.get(entry.headType)
}

/** 種別の絞り込みに並べる種別。`KIND_LABEL` から作るので、漏れが起きない。 */
export const KIND_OPTIONS = Object.keys(KIND_LABEL) as readonly TelegramLogKind[]

export type SourceFilter = 'all' | TelegramLogEntry['source']
/** 種別の絞り込み。種別のほかに、読み取りの結果（スキップ・エラー）でも絞れる。 */
export type KindFilter = 'all' | TelegramLogKind | 'filtered' | 'error'

/**
 * `<select>` の値を絞り込みとして読む。知らない値は「全種別」へ倒し、記録を残す
 * （選択肢の値と読む側がずれたとき、絞り込みが黙って効かなくなるのを見分けるため）。
 */
export function readKindFilter(value: string): KindFilter {
  if (value === 'all' || value === 'filtered' || value === 'error') return value
  if ((KIND_OPTIONS as readonly string[]).includes(value)) return value as TelegramLogKind
  log.warn(`[TelegramTab] 種別の絞り込みに知らない値が来たので全種別にした: ${value}`)
  return 'all'
}

/** その行が絞り込みに当たるか。 */
export function matchesTelegramFilter(
  entry: Pick<TelegramLogEntry, 'source' | 'status' | 'kind' | 'headType'>,
  source: SourceFilter,
  kind: KindFilter,
): boolean {
  if (source !== 'all' && entry.source !== source) return false
  if (kind === 'all') return true
  if (kind === 'filtered') return entry.status === 'filtered'
  if (kind === 'error') return entry.status === 'error'
  return telegramLogKindOf(entry) === kind
}
