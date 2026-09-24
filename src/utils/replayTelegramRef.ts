/**
 * 受信した電文から「どの電文か」を取り出す（録画ツール向けイベントログ用）。
 *
 * **種別ごとに置き場所が違う。** 識別子は `eventId` 直下・`issue.eventId`・`data.eventId` に
 * 分かれ、報番号は気象庁が振る種別にしか無く（震度速報・震源情報は空要素で届く）、情報名も
 * 名乗る種別と名乗らない種別がある。取り出しを呼び出し側へ散らすと、種別を足したときに
 * 片方だけ埋め忘れ、症状は「その種別の読み上げだけ持ち主が空」という静かな形で出る。
 *
 * 純粋関数。副作用は持たない（記録は {@link import('./replayEventLog')} の担当）。
 */
import type { JMAQuakeNotice, LiveEvent } from '../types/earthquake'
import type { ReplayTelegramKind } from './replayEventLog'

/**
 * 取り出しの対象。
 *
 * **`LiveEvent` だけでは足りない。** 地震・津波に関するお知らせ（`quakeNotice`）は音も読み上げも
 * 起こさないと決めた種別で、`onLiveEvent` へ流していない。それでも「届いた」ことは録画の側から
 * 見えるべきなので、ここでは受け取れるようにしておく。
 */
export type ReplayTelegramSource = LiveEvent | { kind: 'quakeNotice'; data: JMAQuakeNotice }

/** 電文が名乗っている事実（`ReplayTelegramRef` から `seq` を除いたもの＋取消）。 */
export interface ReplayTelegramFacts {
  kind: ReplayTelegramKind
  infoType: string | null
  eventId: string | null
  serial: string | null
  cancelled: boolean
}

export function replayTelegramFacts(source: ReplayTelegramSource): ReplayTelegramFacts {
  switch (source.kind) {
    case 'quake':
      return {
        kind: 'quake',
        infoType: source.issue?.type ?? null,
        eventId: source.eventId ?? null,
        // 報番号は数値で持っている。振られない報では未設定（0 と混ざらないよう null で落とす）
        serial: source.reportSerial == null ? null : String(source.reportSerial),
        cancelled: source.cancelled === true,
      }
    case 'tsunami':
      return {
        kind: 'tsunami',
        infoType: source.infoName ?? null,
        eventId: source.eventId ?? null,
        // 津波の電文は報番号を持たない
        serial: null,
        cancelled: source.cancelled,
      }
    case 'eew':
      return {
        kind: 'eew',
        infoType: source.infoName ?? null,
        eventId: source.issue?.eventId ?? null,
        serial: source.issue?.serial ?? null,
        cancelled: source.cancelled,
      }
    case 'lpgm':
      return {
        kind: 'lpgm',
        infoType: source.data.infoName ?? null,
        eventId: source.data.eventId,
        serial: null,
        cancelled: source.data.cancelled,
      }
    case 'nankai':
      return {
        kind: 'nankai',
        infoType: source.data.kindName ?? null,
        eventId: source.data.eventId,
        serial: null,
        cancelled: source.data.cancelled,
      }
    case 'nankaiCommentary':
      return {
        kind: 'nankaiCommentary',
        infoType: source.data.serialName ?? null,
        eventId: source.data.eventId,
        serial: null,
        cancelled: source.data.cancelled,
      }
    case 'kohatsu':
      return {
        kind: 'kohatsu',
        // この種別は情報名を持たない（見出しの文しか無い）
        infoType: null,
        eventId: source.data.eventId,
        serial: null,
        cancelled: source.data.cancelled,
      }
    case 'earthquakeCount':
      return {
        kind: 'earthquakeCount',
        infoType: null,
        eventId: source.data.eventId,
        serial: null,
        cancelled: source.data.cancelled,
      }
    case 'estimatedIntensity':
      return {
        kind: 'estimatedIntensity',
        infoType: null,
        // **この電文は識別子を持たない。** 地震カードとの結び付けは地震発現時刻で行う
        eventId: null,
        serial: null,
        // 取消の概念が無い種別
        cancelled: false,
      }
    case 'quakeNotice':
      return {
        kind: 'quakeNotice',
        infoType: null,
        eventId: source.data.eventId,
        serial: null,
        cancelled: source.data.cancelled,
      }
  }
}
