import { useState, useEffect, useRef, useCallback } from 'react'
import { useLazyRef } from './useLazyRef'
import type { JMAQuake, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity, EEWAlert, IntensityScale, EarthquakePoint, AppEvent, LiveEvent, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { fetchHistory, fetchJmaQuake, P2PQuakeWebSocket } from '../services/p2pquake'
// 種別ごとの取得関数（`fetchDmdataEarthquakes` ほか 8 本）は撤去済み。履歴はアーカイブ経由の
// 1 本へ寄せてある（→ `data-sources-spec.md` §2「大量に取るならアーカイブを使う」）。
// **発表中の緊急地震速報だけは別**で、`/v2/telegram` にも当日のアーカイブにも無いため
// `/v2/gd/eew` を辿る専用の経路が要る。
import { DmdataWebSocket, fetchDmdataActiveEews } from '../services/dmdata'
// 履歴の取得はリプレイ開始時の復元と実装を共有する（→ `data-sources-spec.md` §2
// 「大量に取るならアーカイブを使う」）。同じ目的の実装を 2 本持たない。
import { fetchDmdataQuakeHistory, MAX_HISTORY_DAYS } from '../services/dmdataReplay'
import {
  type TelegramLoss, createEmptyTelegramLoss, telegramLossFrom, isTelegramLossEmpty,
} from '../utils/telegramLoss'
import { mergeQuakeInto, mergeQuakeHistory, sameQuakeEntry, sortQuakes, extractQuakeEventId, quakeEventKey, coalesceByEventId, findExistingQuakeCard, isRetractedQuakeReport, quakeRetractionOf, addQuakeRetraction } from '../utils/quakeMerge'
import type { QuakeRetraction } from '../utils/quakeMerge'
import { loadStationCoords, onStationCoordsLoaded, buildAreaPrefIndex, getAreaPrefIndexCache } from '../utils/stationCoords'
import type { AreaPrefIndex } from '../utils/quakePoints'
import { calcEEWCancelTime, eewSerial, eewEventKey } from '../utils/eew'
import { decideEstimatedIntensityUpdate, isNewEstimatedIntensity, rememberShownEstimatedIntensity } from '../utils/estimatedIntensity'
import { mergeTsunamiReports, isCancelForCurrentTsunami, isTsunamiContinuation, withInheritedTsunamiFacts } from '../utils/tsunami'
import { log } from '../utils/logger'
import { serverNow, serverDate } from '../utils/clock'

import { isDmdss } from '../utils/env'
import { isValidDmdataApiKey, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
// テストデータは押されてから読む（静的に取り込まない理由・失敗したときの扱い・先読みの
// 段取りは `utils/testDataLoader.ts` にまとめてある）。
import { loadTestData } from '../utils/testDataLoader'

// 初回取得件数（設定の最大選択値に合わせる）。リプレイ開始時の履歴復元（useReplayController の
// QUAKE_HISTORY_EVENTS）もこの値をそのまま目標にするため export している。片方だけ動かすと、
// ライブと再生でカードの厚みが黙って食い違う。
export const MAX_HISTORY_RETAINED = 50
const LOAD_MORE_BATCH = 50        // 「もっと見る」1回あたりの取得件数
const MAX_TELEGRAM_LOG = 200      // 電文ログの最大保持件数
/**
 * 起動時にアーカイブを遡る日数。
 *
 * リプレイ開始時の履歴復元と同じ値。**日数がそのままリクエスト数になる**（1 日 1 ファイル・
 * 実測 gzip 10KB）ので、起動時は短く取る。件数が早く揃えばここまで遡らない。
 */
const HISTORY_INITIAL_DAYS = 7

/**
 * 「もっと見る」1 回で伸ばす日数。
 *
 * **遡れるのは `MAX_HISTORY_DAYS` まで。** アーカイブの在庫はそれより遥かに古くまであるので
 * （実測: 目録は 135 日以上さかのぼれた）、「在庫が尽きて自然に止まる」ことは起きない。
 * 止まるのは当日経路の日付列挙の上限で、そこへ達したら `hasMore` を偽にして押せなくする。
 */
const HISTORY_MORE_DAYS = 7

const MAX_QUAKE_RETRACTIONS = 20  // 取消を見た事実の台帳の最大保持件数（`rememberQuakeRetraction`）

/**
 * 取消電文がこのカードに効くか。
 *
 * **種別（`issue.type`）まで見る。** 遠地地震の取消報が「震源・震度情報」のカードを巻き込まない
 * ようにするため（遠地地震は VXSE53 を共有し `Head/Title` だけが異なる。`dmdataParser` の
 * `resolveIssueType` 参照）。既に取消表示中のカードは対象外。
 *
 * 台帳への記録（入口）と実際の取消の適用（`setState` の中）で**同じ述語を使う**ために切り出して
 * いる。書き写すと片方だけが変わり、記録と適用の範囲が静かにずれる。
 */
function isQuakeCancelTarget(card: JMAQuake, cancel: JMAQuake, areaPrefIndex: AreaPrefIndex): boolean {
  return !card.cancelledAt && sameQuakeEntry(card, cancel, areaPrefIndex)
    && card.issue.type === cancel.issue.type
}

/** 取消電文が効くカードを探す。判定は `isQuakeCancelTarget`。 */
function findQuakeCancelTarget(
  cards: readonly JMAQuake[],
  cancel: JMAQuake,
  areaPrefIndex: AreaPrefIndex,
): JMAQuake | undefined {
  return cards.find(card => isQuakeCancelTarget(card, cancel, areaPrefIndex))
}
/**
 * 推計震度分布図テストで、地震情報を出してから分布を流すまでの間。
 *
 * 実運用の数分をそのまま待たせても意味が無いので詰めるが、**0 にはしない** ——
 * 地震カードが一覧に載る前に分布が届くと、自動で開く側が引き当てる相手を見つけられない。
 */
const TEST_ESTIMATED_INTENSITY_DELAY_MS = 3000
/**
 * 推計震度分布図テストで、初報から続報までを空ける間隔。
 *
 * **初報の読み上げが鳴り終わるまでの長さが要る。** 続報は初報と同じ主題なので、読み上げの
 * 到来順の裁きが初報を取り下げて割り込む（実運用では 6 分空くので起きない）。上の 3 秒のままだと
 * 初報が「〜について、」で切れ、**確かめたい「受信しました」が一度も鳴らない**。
 * 実測で通知音・間・2 チャンクの合成と再生に 8 秒前後かかるので、その倍を取る。
 */
const TEST_ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS = 16000
/**
 * 推計震度分布図テストで、分布の続報から地震情報の続報までを空ける間隔。
 *
 * **分布の続報の読み上げが鳴り終わるまでの長さが要る。** 短すぎると「更新されました」が
 * 途中で切れ、そちらを確かめられなくなる（上の 16 秒と同じ理由）。地震情報の続報は主題が
 * 別なので割り込みでは切られないが、聞き分けられる間は空ける。
 */
const TEST_ESTIMATED_INTENSITY_QUAKE_FOLLOW_UP_DELAY_MS = 16000
const EEW_FINAL_SILENCE_MS = 10000 // EEW発報テスト（特別警報・警報・予報）: この間隔クリックが無ければ最終報として確定する
const EEW_RETRACTION_CANCEL_MS = 10000 // EEW誤報取消テスト: 発報からこの秒数後に取消電文を送る

type QueuePayload =
  | { kind: 'event'; event: AppEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }
  | { kind: 'quakeNotice'; data: JMAQuakeNotice }
  | { kind: 'earthquakeCount'; data: JMAEarthquakeCount }
  | { kind: 'estimatedIntensity'; data: JMAEstimatedIntensity }
  | { kind: 'purge-cancelled-quake'; id: string }
  | { kind: 'purge-cancelled-eew'; key: string }
  | { kind: 'purge-cancelled-tsunami'; id: string }

interface QueueEntry {
  eventTime: Date
  payload: QueuePayload
  silent?: boolean
}

/**
 * 発火時刻の昇順に並んだイベントキュー。
 *
 * **配列を外へ出さない**のが唯一の設計目的。かつては素の `QueueEntry[]` を ref に持たせていて、
 * 中身を書き換える側（挿入・取り出し）と作り直す側（`filter` での絞り込み）が同居していた。
 * ディスパッチャは 1 回のティックで複数のエントリを続けて処理するため、その途中で配列が
 * 差し替わると、それ以降に取り出したエントリが差し替え前の配列からしか消えず、新しい配列に
 * 残ったままになる。次のティックがそれを先頭から読み、同じ電文を再処理した（実測で 1 通の地震情報が
 * 数千回取り出され、受信音が鳴り続けた。再現の条件は `useEarthquakes.wiring.test.ts` 側に書いてある）。
 *
 * 画面には「カードが更新され続ける」ようにしか映らず、型検査でも例外でも捕まらない。**同じ誤りを
 * 書けなくするために、配列そのものは閉じ込めてある。**
 *
 * **持ち主の ref ごと差し替えるのも同じこと**（`eventQueueRef.current = createEventQueue()`）。
 * 差し替え前のキューに残っていた予約は、誰にも取り出されないまま消える。捨てたいときは
 * `clear()` を呼ぶこと。
 */
interface EventQueue {
  /**
   * 発火時刻の昇順を保って 1 件積む。
   *
   * **日時として読めない発火時刻のエントリは積まず、記録に残す。** 取り出し側（`shiftReady`）では
   * 弾けない。NaN は `<=` と `>` のどちらとも偽になるため、判定の書き方で転ぶ先が変わる（実測）:
   *
   *   - `eventTime > now` なら止める形 … 止まらず**即座に発火する**（現在の `shiftReady`）
   *   - `!(eventTime <= now)` なら止める形 … **止まる**。以後すべての電文が発火しない
   *
   * どちらも望ましくないので、**入口で落とすのが唯一の確実な手**。積む経路はこの `push` だけ
   * （配列は閉じ込めてある）なので、ここを通せば以降は有限値しか並ばない。ここで弾くのは
   * 呼び出し規約の違反なので、既定で消える詳細ログではなく `error` で残す。
   */
  push(entry: QueueEntry): void
  /**
   * `keep` が false を返した要素を取り除く。
   *
   * **`keep` は例外を投げてはならない。** 途中で抜けると「前半だけ詰め直され、後半は未走査」の
   * まま長さも切り詰められない。読み元は壊さないので要素が消えることはないが、**残すと決めた
   * エントリが重複したまま残る**。述語はフィールドの参照だけに留めること。
   */
  retain(keep: (entry: QueueEntry) => boolean): void
  /**
   * 発火時刻が `now` 以前の先頭を 1 件取り出す。無ければ `undefined`。
   *
   * **先頭で止まる**（時刻の来ていない先頭より後ろは見ない）。並びが崩れると後ろが取り残される
   * ため、順序は `push` だけが決める。
   *
   * 発火時刻が有限であることは `push` が保証している。**この判定の向きを変えるなら、
   * 読めない時刻が来たときにどちらへ転ぶかを `push` の注記で確かめてから変えること。**
   */
  shiftReady(now: Date): QueueEntry | undefined
  /** すべて捨てる。 */
  clear(): void
}

function createEventQueue(): EventQueue {
  const entries: QueueEntry[] = []
  return {
    push(entry) {
      if (!Number.isFinite(entry.eventTime.getTime())) {
        // 何を捨てたかまで残す。`payload.kind` は大半の経路で 'event' 固定になり、
        // `String(new Date(NaN))` も常に 'Invalid Date' なので、それだけでは同じ読み込みで
        // 複数捨てたときに区別が付かない。
        const detail = entry.payload.kind === 'event'
          ? entry.payload.event.kind + ' id=' + String((entry.payload.event as { id?: unknown }).id ?? '(なし)')
          : entry.payload.kind
        log.error('[queue] 発火時刻が日時として読めないエントリを捨てた ' + detail
          + ' eventTime=' + String(entry.eventTime))
        return
      }
      let i = entries.length
      while (i > 0 && entries[i - 1].eventTime > entry.eventTime) i--
      entries.splice(i, 0, entry)
    },
    retain(keep) {
      // 配列を作り直さず、書き込みカーソルで前へ詰める（`write <= read` が常に成り立つので
      // 読む前に上書きすることはない）。
      let write = 0
      for (let read = 0; read < entries.length; read++) {
        if (keep(entries[read])) entries[write++] = entries[read]
      }
      entries.length = write
    },
    shiftReady(now) {
      if (entries.length === 0 || entries[0].eventTime > now) return undefined
      return entries.shift()
    },
    clear() { entries.length = 0 },
  }
}

/**
 * 表示中の EEW より古い報か（＝適用すると内容が退行するか）。
 *
 * **同じ地震の報は同じ秒に複数届く。** 能登本震の実配信では 46 報中 13 報が同一秒だった。
 * キューは電文の時刻（秒精度）でしか並べ替えられず（`enqueueEvent`）、WebSocket の受信は
 * body の展開（gunzip）を待たずに次へ進むため（`services/dmdata.ts`）、同じ秒に届いた報は
 * 展開の完了順で処理されうる。順序が入れ替わったまま丸ごと上書きすると、地図の区域塗りが
 * 古い内容へ戻る。報番号で弾いてそれを防ぐ。
 *
 * 報番号の数値化は `eewSerial`（`utils/eew.ts`）に任せる。`0`・負値・小数を弾く判定が既に
 * あり、そこだけ独自に実装すると同じ値の扱いが 2 通りに割れる。
 *
 * **報番号が取れない側があるときは判定しない。** 順序を決める根拠が無いため後着を採る。
 * 0 で埋めて比較すると、`issue.serial` を持たない報（P2PQuake で起こりうる）を常に
 * 「古い」と見なして捨ててしまう。同じ報番号の再送も古いとはみなさない（訂正報も同じ番号で
 * 届きうるため、内容の異同にかかわらず通す）。
 */
function isStaleEewReport(existing: EEWAlert, incoming: EEWAlert): boolean {
  const existingSerial = eewSerial(existing)
  const incomingSerial = eewSerial(incoming)
  if (existingSerial === null || incomingSerial === null) return false
  return incomingSerial < existingSerial
}

// DMDSS版 EEW の地域別予想震度には pref が含まれないため、細分区域名→都道府県の
// 逆引きインデックスで補完する（EEWカードの対象地域表示用。地図の色塗りは name のみで動く）。
function enrichEEWPref(eew: EEWAlert, index: Map<string, string> | null): EEWAlert {
  if (!index || !eew.areas || eew.areas.length === 0) return eew
  const areas = eew.areas.map(a =>
    a.pref ? a : { ...a, pref: index.get(a.name) ?? '' },
  )
  return { ...eew, areas }
}

type TestEEWKind = 'special' | 'warning' | 'forecast' | 'assumed' | 'deep'
// originTime は同一イベントで不変なので初報の基準時刻（baseTime）を続報・最終報まで持ち回る。
type TestEEWEntry = { eventId: string; serial: number; baseTime: Date; finalizeTimer: number }
type TestEEWRetractionEntry = { eventId: string; serial: number; baseTime: Date; cancelTimer: number }

type TestTsunamiRef = React.MutableRefObject<{ cancelTimer: number; tsunami: JMATsunami } | null>

// 津波テスト: 発表 → cancelMs 後に解除（または誤報取消）。
//
// 解除電文は実運用（dmdataParser / p2pquake の 552）に合わせる:
//   - 区域は空。実運用の解除・取消はどちらも areas を持たない（残っている区域が解除の意味）。
//   - 発表時刻・id は解除電文自身のもの（直前の発表を流用しない）。
//   - 解除理由は DMDSS 限定。standard 版（P2PQuake）は判別できないため付けない
//     （p2pquake.ts の 552 パースと同じ扱い）。
function runSimulateTsunami(
  createFn: () => JMATsunami,
  cancelMs: number,
  ref: TestTsunamiRef,
  handleEvent: (event: AppEvent) => void,
  cancelReason: 'lifted' | 'retracted' = 'lifted',
) {
  if (ref.current) window.clearTimeout(ref.current.cancelTimer)
  const tsunami = createFn()
  handleEvent(tsunami)
  const cancelTimer = window.setTimeout(() => {
    const now = serverDate().toISOString()
    handleEvent({
      ...tsunami,
      id: `${tsunami.id}-cancel`,
      time: now,
      issue: { ...tsunami.issue, time: now },
      cancelled: true,
      cancelReason: isDmdss ? cancelReason : undefined,
      // 取消しの概要（電文の `Body/Text`）。**誤報取消のときだけ気象庁が理由を書く**ので、
      // 解除では持たせない。実電文の形に合わせないと、画面と読み上げでこの経路を通れない
      ...(isDmdss && cancelReason === 'retracted'
        ? { cancelText: 'システムの障害により誤った津波警報等を配信しました。' }
        : {}),
      areas: [],
    })
    ref.current = null
  }, cancelMs)
  ref.current = { cancelTimer, tsunami }
}

// EEW発報テスト（特別警報・警報・予報）: クリックのたびに続報（isFinal未設定）を送る。
// silenceMs 経過しても再クリックが無ければ、最終報（isFinal:true）を確定送信する。
// 確定後は本番と全く同じ calcEEWCancelTime ベースの自動解除（無音・即消去）がそのままかかる
// （DMDSS版の実運用と同一経路。Standard版は実データに isFinal が来ないため、この検知経路
// 自体は実運用で通らないが、解除後の共有ロジックはバリアント共通のため検証できる）。
//
// 報の推移は実運用（dmdataParser.parseEEW）に合わせる:
//   - 報番号（issue.serial）・id・発表時刻（time / issue.time）は報ごとに進める。
//     最終報も独立した 1 報なので、直前の電文を流用せず serial を 1 つ進めて作り直す。
//   - 震源時刻（originTime）と到達予想時刻は同一イベントで不変。baseTime を持ち回って固定する
//     （作り直すと予報円が続報ごとに中心へ戻り、実運用では起きない挙動になる）。
function runSimulateEEW(
  kind: TestEEWKind,
  createFn: (eventId: string, serial: number, baseTime: Date) => EEWAlert,
  silenceMs: number,
  timers: Map<TestEEWKind, TestEEWEntry>,
  handleEvent: (event: AppEvent) => void,
) {
  const prev = timers.get(kind)
  const isContinuation = prev !== undefined
  const eventId = isContinuation ? prev.eventId : `test-${kind}-${Date.now()}`
  const serial = isContinuation ? prev.serial + 1 : 1
  const baseTime = isContinuation ? prev.baseTime : serverDate()
  if (prev) window.clearTimeout(prev.finalizeTimer)
  handleEvent(createFn(eventId, serial, baseTime))
  const finalizeTimer = window.setTimeout(() => {
    handleEvent({ ...createFn(eventId, serial + 1, baseTime), isFinal: true })
    timers.delete(kind)
  }, silenceMs)
  timers.set(kind, { eventId, serial, baseTime, finalizeTimer })
}

// EEW誤報取消テスト: 通常発報のまま cancelMs 後に明示的な取消電文（cancelled:true、isFinal無し）
// を送る。誤報取消は音・ブラウザ通知・読み上げを伴う（自動解除との対比用）。
//
// 取消電文も実運用（dmdataParser.parseEEW の isCanceled 分岐）に合わせる:
//   - 独立した 1 報なので報番号・id・発表時刻を進める。
//   - 対象地域は空、震源座標は 0、予想最大震度・予想最大長周期階級も持たない
//     （取消電文は予想を持たない）。震源名は残す（通知文・読み上げが hypocenter.name を使うため）。
function runSimulateEEWRetraction(
  createFn: (eventId: string, serial: number, baseTime: Date) => EEWAlert,
  cancelMs: number,
  ref: React.MutableRefObject<TestEEWRetractionEntry | null>,
  handleEvent: (event: AppEvent) => void,
) {
  const prev = ref.current
  const eventId = prev ? prev.eventId : `test-eew-retraction-${Date.now()}`
  const serial = prev ? prev.serial + 1 : 1
  const baseTime = prev ? prev.baseTime : serverDate()
  if (prev) window.clearTimeout(prev.cancelTimer)
  handleEvent(createFn(eventId, serial, baseTime))
  const cancelTimer = window.setTimeout(() => {
    const report = createFn(eventId, serial + 1, baseTime)
    handleEvent({
      ...report,
      cancelled: true,
      // 取消しの概要（電文の `Body/Text`）。**実電文の値をそのまま置く** —— アプリが受信する
      // VXSE45（地震動予報）の取消の本文は、観測できた 23 通すべてがこの 1 文で理由を含まない
      // （走査の範囲と通数は → quake-spec.md §8「取消しの理由は電文にしかない」）。この形で
      // ないと、読み上げが宣言だけの本文を落とす経路（→ audio-tts-spec.md §4「取消の宣言だけの
      // 本文は読まない」）を EEW で一度も実機で通れない。**理由が入っている本文を読む側は
      // `ttsText.test.ts` が両方向とも固定している** —— 文字列の判定だけで画面・音・タブ移動を
      // 伴わないので、実在しない形をテストボタンへ置いてまで実機で押す必要はない。
      // **このボタンは警報級を取り消すが、本文の名前は予報級のまま** —— VXSE45 の種別名は区分に
      // 関わらずこれ 1 つで（→ eew-spec.md §3）、警報かどうかは電文内の `isWarning` が示す。
      // 警報級を取り消した実電文の標本は無いので、名前が変わる形は置かない。
      // **DMDSS 版限定**: この項目を作れるのは XML を読む dmdataParser だけで、
      // P2PQuake 経路（standard 版）には対応するフィールドが無い。津波の解除テストと同じ扱い
      ...(isDmdss ? { cancelText: '先ほどの、緊急地震速報（地震動予報）を取り消します。' } : {}),
      areas: [],
      // **「程度以上」の印も値と一緒に落とす。** 印だけ残ると、値が無いのに上限が定まって
      // いないことになり、表示・読み上げが語を補う条件（→ eew-spec.md §4）と食い違う。
      forecastMaxScale: undefined,
      forecastMaxScaleOrAbove: undefined,
      forecastMaxLpgmClass: undefined,
      forecastMaxLpgmClassOver: undefined,
      earthquake: {
        ...report.earthquake,
        hypocenter: { ...report.earthquake.hypocenter, latitude: 0, longitude: 0 },
      },
    })
    ref.current = null
  }, cancelMs)
  ref.current = { eventId, serial, baseTime, cancelTimer }
}

export interface EarthquakeState {
  earthquakes: JMAQuake[]
  tsunamis: JMATsunami[]
  activeEEWs: ReadonlyMap<string, EEWAlert>
  lpgmByEventId: ReadonlyMap<string, JMALpgm>
  nankai: JMANankai | null
  nankaiCommentary: JMANankaiCommentary | null
  kohatsu: JMAKohatsu | null
  /** 地震・津波に関するお知らせ（VZSE40）。最新の 1 通だけ持つ */
  quakeNotice: JMAQuakeNotice | null
  /** 地震回数に関する情報（VXSE60）。最新の 1 通だけ持つ */
  earthquakeCount: JMAEarthquakeCount | null
  /**
   * 推計震度分布図（IXAC41）。最新の 1 通だけ持つ。
   *
   * 1 通で 36 万セル・3MB 規模になる（実電文で観測された最大。形式が定める上限ではない）ので
   * **複数は持たない**。震度5弱以上の地震にしか発表されないため、
   * 新しいものが来た＝より新しい大きな地震か、同じ地震の続報のどちらか。
   */
  estimatedIntensity: JMAEstimatedIntensity | null
  connectionStatus: ConnectionStatus
  lastUpdate: Date | null
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  error: string | null
  /**
   * 履歴取得で読めなかった取得元・取り込めなかった電文。**DMDSS 版限定。**
   *
   * 履歴取得は例外を投げずに一部の失敗を吸収するため、`error` は立たない。**画面には取れた分の
   * カードだけが出て、失敗は何も出ない**状態だった。取得元が「日」単位になったぶん、1 日落ちれば
   * 失う電文は多い（実測 2026-09-15: 起動時の電文本体 85 件のうち 81 件が 429 で失敗し、
   * 4 件しか出ていなかった）。
   *
   * **取得のたびに置き換える（積まない）。** あの取得は毎回「その時点の全範囲」を走査して
   * 数え直すので、積むと同じ損失を回数だけ数え、取得が回復しても消えない
   * （→ `utils/telegramLoss.ts` の表）。
   *
   * **標準版（P2PQuake）では常に空。** あちらの履歴取得は「全部取れたか全滅か」で、部分的な
   * 損失という概念を持たない（失敗は `error` へ落ちる）。**空であることは「欠けていない」ことの
   * 保証ではない。**
   *
   * 空へ戻すのは接続をやり直すときだけ。契機は下の接続 effect の依存が単一情報源で、
   * API キーの変更・試験報の受信設定の切り替え・リプレイの開始と終了が含まれる。
   */
  historyLoss: TelegramLoss
  /**
   * 直近の「もっと見る」がまるごと失敗したか。**両バリアント共通。**
   *
   * **`historyLoss` とは別に持つ。** こちらは押し直せば回復しうるもので、遡る日数も押す前の値へ
   * 戻してある。次に成功したら消す。
   */
  loadMoreFailed: boolean
  telegramLog: TelegramLogEntry[]
}

export function useEarthquakes(
  onLiveEvent?: (event: LiveEvent) => void,
  dmdataApiKey = '',
  dmdataTestDelivery = false,
  replayTimeOffset: number | null = null,
  /**
   * 復元した「発表中のもの」を画面へ見せてよいと伝える。
   *
   * **`onLiveEvent` とは別の口にする。** 復元は音も読み上げも起こさないので `onLiveEvent` を
   * 通らない（`silent` を立ててキューへ積むため）。それでも**画面だけは見せたい**——揺れてから
   * 開いた利用者にとって、発表中の警報は最初に目に入るべきものだから。
   *
   * **呼ばれるのは起動時だけではない。** この接続の effect は API キーの編集やリプレイの往復でも
   * 再実行され、そのたびに復元と通知が走る。**「初回だけ」に絞ろうとしないこと** —— React の
   * StrictMode は開発時に effect を 2 回実行し、1 回目は cleanup で破棄されるため、「初回か」を
   * ref で覚えると**開発モードでだけ通知が一度も出なくなる**（本番では出るので、食い違いに
   * 気づけない）。再接続で通知が出ても実害は小さい: 発表中の警報が無ければ何も起こらず、
   * あるなら見せるべきものだから。
   *
   * 優先度と駆動源は受け取る側（`App`）が決める。ここで決めると、タブ切替の規則が
   * `utils/tabPriority.ts` と 2 箇所へ分かれる。
   */
  onStartupRestore?: (tab: 'realtime' | 'tsunami') => void,
) {
  const [state, setState] = useState<EarthquakeState>({
    earthquakes: [],
    tsunamis: [],
    activeEEWs: new Map(),
    lpgmByEventId: new Map(),
    nankai: null,
    nankaiCommentary: null,
    kohatsu: null,
    quakeNotice: null,
    earthquakeCount: null,
    estimatedIntensity: null,
    connectionStatus: (isDmdss && !isValidDmdataApiKey(dmdataApiKey)) ? 'disconnected' : 'connecting',
    lastUpdate: null,
    isLoading: !(isDmdss && !isValidDmdataApiKey(dmdataApiKey)),
    isLoadingMore: false,
    hasMore: false,
    error: null,
    historyLoss: createEmptyTelegramLoss(),
    loadMoreFailed: false,
    telegramLog: [],
  })

  const appendTelegramLog = useCallback((entry: TelegramLogEntry) => {
    setState(prev => ({
      ...prev,
      telegramLog: prev.telegramLog.length >= MAX_TELEGRAM_LOG
        ? [entry, ...prev.telegramLog.slice(0, MAX_TELEGRAM_LOG - 1)]
        : [entry, ...prev.telegramLog],
    }))
  }, [])

  const clearTelegramLog = useCallback(() => {
    setState(prev => ({ ...prev, telegramLog: [] }))
  }, [])

  const wsRef = useRef<P2PQuakeWebSocket | null>(null)
  // 最新のコールバックを ref で保持し、handleEvent を安定させる
  const onLiveEventRef = useRef(onLiveEvent)
  onLiveEventRef.current = onLiveEvent
  const onStartupRestoreRef = useRef(onStartupRestore)
  onStartupRestoreRef.current = onStartupRestore
  // キューディスパッチャーがサイレントエントリを処理中は true にして通知音を抑制する
  const isSilentRef = useRef(false)
  // テスト EEW の発報状態を種別ごとに独立管理（複数EEW同時テスト対応）
  const testEEWTimersRef = useRef<Map<TestEEWKind, TestEEWEntry>>(new Map())
  // EEW 誤報取消テストの発報状態
  const testEEWRetractionRef = useRef<TestEEWRetractionEntry | null>(null)
  // テスト津波の発報状態を種別ごとに独立管理
  const testTsunamiRef = useRef<{ cancelTimer: number; tsunami: JMATsunami } | null>(null)
  // 南海トラフ臨時情報の取消テストで、発表から取消までを待つタイマー
  const testNankaiRetractionTimerRef = useRef<number | undefined>(undefined)
  const testEarthquakeCountRetractionTimerRef = useRef<number | undefined>(undefined)
  const testTsunamiGradeChangeTimerRef = useRef<number | undefined>(undefined)

  /**
   * テストボタンが張った「待ち」をすべて落とす。**アンマウントと `resetState` の両方から呼ぶ。**
   *
   * **1 箇所にまとめてあるのは、配線を落としやすいから。** 待ちには 2 系統あり、
   * 南海トラフ・地震回数の取消テストはイベントキューへ積むが、**津波と EEW のテストは
   * `handleEvent` を直接呼ぶ** —— `eventQueueRef.current.clear()` では止まらない。
   * 追い忘れると、画面を閉じた後やリプレイへ切り替えた後に、消えたはずの電文が 1 通だけ
   * 単独で届く。**例外もログも出ない。**
   *
   * 落とすのは「これから発火する待ち」だけで、画面に出ているものの扱いには触れない
   * （そちらは `resetState` の他の行が決めている）。
   *
   * **待ちを持つ ref を増やしたら、ここへ足すこと。**
   */
  const clearTestSimulationTimers = useCallback(() => {
    // 津波テスト 5 種が共有する自動解除（TEST_AUTO_DISMISS_MS）。
    if (testTsunamiRef.current) {
      window.clearTimeout(testTsunamiRef.current.cancelTimer)
      testTsunamiRef.current = null
    }
    // EEW 発報テスト 5 種の最終報（EEW_FINAL_SILENCE_MS）。**種別ごとに独立して張られる**ので
    // Map を走査する。1 つでも残ると、リセット後の画面へ EEW がまるごと 1 通生える。
    for (const entry of testEEWTimersRef.current.values()) {
      window.clearTimeout(entry.finalizeTimer)
    }
    testEEWTimersRef.current.clear()
    // EEW 誤報取消テストの取消（EEW_RETRACTION_CANCEL_MS）。
    if (testEEWRetractionRef.current) {
      window.clearTimeout(testEEWRetractionRef.current.cancelTimer)
      testEEWRetractionRef.current = null
    }
    if (testNankaiRetractionTimerRef.current !== undefined) {
      window.clearTimeout(testNankaiRetractionTimerRef.current)
      testNankaiRetractionTimerRef.current = undefined
    }
    if (testEarthquakeCountRetractionTimerRef.current !== undefined) {
      window.clearTimeout(testEarthquakeCountRetractionTimerRef.current)
      testEarthquakeCountRetractionTimerRef.current = undefined
    }
    if (testTsunamiGradeChangeTimerRef.current !== undefined) {
      window.clearTimeout(testTsunamiGradeChangeTimerRef.current)
      testTsunamiGradeChangeTimerRef.current = undefined
    }
  }, [])
  // 帯に出している南海トラフ臨時情報・後発地震注意情報の識別情報（無ければ null）。取消の照合に使う。
  //
  // **`stateRef` では判定できない。** あれはレンダー時にしか進まないが、キューのディスパッチャは
  // 1 ティックの中で複数のイベントを処理する（理由は `acceptedEewSerialRef` の宣言箇所に同じ）。
  // こちらは反映した時点で即座に進むため、同じティックの中でも正しく比べられる。
  const shownNankaiEventIdRef = useRef<string | null>(null)
  const shownKohatsuEventIdRef = useRef<string | null>(null)
  // 解説情報だけは `id`（識別情報と号数の組）で持つ。理由は `applyNankaiCommentary` の照合箇所。
  const shownCommentaryIdRef = useRef<string | null>(null)
  const shownQuakeNoticeIdRef = useRef<string | null>(null)
  // 表示中の地震回数の群発識別子。**取消が自分宛かを同期的に判定する**ために持つ
  // （`setState` の中で照合すると、読み上げを起こすかどうかをその場で返せない）。
  const shownEarthquakeCountEventIdRef = useRef<string | null>(null)
  // 現在の state を WS コールバック内から参照するための ref
  const stateRef = useRef(state)
  stateRef.current = state
  // 受理した EEW の報番号（キーは `eewEventKey`）。古い報の判定に使う。
  //
  // **`stateRef` では判定できない。** あれはレンダー時にしか進まないが、キューのディスパッチャは
  // 1 ティックの中で `handleEvent` を連続で呼ぶ（同じ秒の報がまとめてキューに載るため、まさに
  // 順序が入れ替わりうる場面で起きる）。その間 `stateRef` は前のレンダーの値のままなので、
  // 直前に受理した報より古い報を「新しい」と誤判定して通してしまう。こちらは受理した時点で
  // 即座に進むため、同じティックの中でも正しく比べられる。
  const acceptedEewSerialRef = useRef<Map<string, number>>(new Map())
  // VXSE51 受信時に震度データをキャッシュし、後続の VXSE52（震源情報）に補完する。
  // VXSE52 は震源のみで震度を持たないため、VXSE51 の maxScale・points を引き継ぐ。
  const quakeIntensityCacheRef = useRef<Map<string, { maxScale: IntensityScale; points: EarthquakePoint[] }>>(new Map())
  // 取消を見た事実の台帳。取消の後に届いた報のうち「取消より前に発表されたもの」を捨てるために使う
  // （判定は `isRetractedQuakeReport`。切り分けの理由は docs/spec/quake-spec.md §6.2）。
  //
  // **カードの `cancelledAt` を見るだけでは足りない。** 取消済みカードは 10 秒後に purge されるため、
  // それを過ぎて届いた古い報を弾けない。順序の入れ替わりを拾うのが目的なのに、10 秒で記憶が
  // 消えては用を成さない。履歴経路（`mergeQuakeHistory`）はカードごと消すので、そちらの取消も
  // ここに集めて両経路で共有する。
  const quakeRetractionsRef = useRef<QuakeRetraction[]>([])
  // いま出している推計震度分布図の見分け（IXAC41）。**巨大な本体は持たない** ——
  // 判定に要るのは地震発現時刻・発表時刻・セル数の 3 つだけで、本体は実電文で観測された
  // 最大の 364,993 セルで 3MB 規模になる（形式が定める上限ではない。確保長は電文が宣言する
  // 長さから決まるので、これより大きくなりうる）。
  const shownEstimatedIntensityRef = useRef<{ arrivalTime: string; time: string; count: number } | null>(null)
  // 分布を伝えた地震（発現時刻）の台帳。読み上げが「受信しました」と「更新されました」を
  // 言い分けるのに使う（→ `isNewEstimatedIntensity`）。**いま出している 1 通だけでは足りない**
  // —— 地震が立て続けに起きると分布が交互に届き、同じ地震の続報のあいだに別の地震の分布が挟まる。
  const shownEstimatedIntensityArrivalsRef = useRef<string[]>([])
  // 後発地震注意情報（VYSE60）の7日間有効期限タイマー
  const kohatsuExpireTimerRef = useRef<number | undefined>(undefined)
  // 南海トラフ地震関連解説情報（VYSE51/52）の7日間有効期限タイマー。
  // 解説情報には解除電文が無く、定例解説は平常時にも毎月届く。期限で畳まないと帯が常駐する。
  const nankaiCommentaryExpireTimerRef = useRef<number | undefined>(undefined)
  const quakeNoticeExpireTimerRef = useRef<number | undefined>(undefined)
  const earthquakeCountExpireTimerRef = useRef<number | undefined>(undefined)
  // イベントキュー: ディスパッチャーが 10ms ごとに、発火時刻の来たものを先頭から処理する。
  // リプレイ時は eventTime と再生時刻を比較して発火制御する（並びと取り出しの規約は `EventQueue`）。
  const eventQueueRef = useLazyRef<EventQueue>(createEventQueue)
  /**
   * ライブ接続を張り直すたびに進む番号。**時間軸が変わったことを、後から走る取得へ伝える。**
   *
   * 履歴の電文本体は最長で数分かけて届く（→ `services/telegramBody.ts` の取得間隔）。
   * その途中でリプレイが始まる・API キーが変わると、届いた電文は**別の時間軸の一覧**へ
   * 流し込まれることになる。接続 effect の中の `cancelled` はそのスコープに閉じていて
   * 「もっと見る」からは触れないため、共有できる形で持つ。
   */
  const liveGenerationRef = useRef(0)
  const dmdataApiKeyRef = useRef(dmdataApiKey)
  dmdataApiKeyRef.current = dmdataApiKey
  // 「もっと見る」は依存を持たない `useCallback` なので、設定は ref で見る
  const dmdataTestDeliveryRef = useRef(dmdataTestDelivery)
  dmdataTestDeliveryRef.current = dmdataTestDelivery
  /**
   * いまアーカイブを何日ぶん遡っているか。**「もっと見る」のたびに伸ばす。**
   *
   * 件数だけを増やしても、日数が足りなければ在庫を読み切ったところで止まる
   * （7 日分で 43 件しか無ければ、目標 50 件には永久に届かない）。
   */
  const historyDaysRef = useRef(HISTORY_INITIAL_DAYS)
  // 通常版「もっと見る」用の生 API 取得件数（重複除去後の earthquakes.length とは別管理）
  // offset = earthquakes.length だと重複除去ズレで古いデータが抜け落ちるため、API 呼び出し回数ベースで管理する
  const p2pRawOffsetRef = useRef(0)

  // P2PQuake WS の VXSE43/45 相当（556）受信時に既存の Yahoo EEW へ地域別予想震度・震源要素を注入する
  // （音・タブ切替なし）。P2PQuakeはcondition（仮定震源要素の判別）・hypocenter（数値型・パース不要）
  // ともYahoo hypoInfoより正確なため、両方を上書きする。ただし報番号が古い場合は上書きしない
  // （WS/ポーリングの到着順序が入れ替わり、新しい報を古い報の値で退行させないため）。
  //
  // 古い報を弾く考え方は主経路と同じだが、比べる相手が違う。主経路の `isStaleEewReport` は
  // 表示中の EEW と比べるのに対し、こちらは台帳（`acceptedEewSerialRef`）と比べる。理由は下記。
  // かつてここだけ欠けた報番号を 0 で埋めており、`issue.serial` を持たない報が来ると
  // 常に「古い」と見なされて注入が丸ごと飛んでいた。
  const enrichEEW = useCallback((eventId: string, source: EEWAlert) => {
    // 現在の state から既存 EEW を取り出して severity の格上げを判定する。
    // setState の関数内で判定して外側から onLiveEvent を呼ぶ二重評価を避けるため、
    // stateRef.current 経由で参照する。
    const existing = stateRef.current.activeEEWs.get(eventId)
    if (!existing) return
    // 古い報かどうかは `handleEvent` と同じ台帳で判定する。`existing` はレンダー待ちで古いことが
    // あり、そちらと比べると直前に受理した報を見落とす（この経路はキューを通らず WebSocket から
    // 直接呼ばれるため、`handleEvent` 側の受理と入れ違いになりうる）。
    const sourceSerial = eewSerial(source)
    const acceptedSerial = acceptedEewSerialRef.current.get(eventId)
    if (sourceSerial !== null && acceptedSerial !== undefined && sourceSerial < acceptedSerial) return
    // severity は upgrade only。既存が Warning のときはソースが弱くても維持し、
    // 既存が Forecast/Unknown で source が Warning のときは Warning に格上げする。
    // Yahoo hypoInfo 由来の推定 severity（scaleNum ヒューリスティック）に対して
    // P2PQuake code=556（仕様上 Warning 固定）が来たときにレベルダウンさせない。
    // 現状 enrichEEW の呼び出し元は P2PQuake code=556 のみで source.severity は常に
    // Warning。`source.severity ?? existing.severity` は将来別ソースから呼ばれる場合の
    // 防御分岐（severity は必須プロパティなので現状 undefined にはならない）。
    const enriched: EEWAlert = {
      ...existing,
      severity: existing.severity === 'Warning' ? 'Warning' : (source.severity ?? existing.severity),
      // 報番号も進める。中身だけ新しくして番号を据え置くと、格納した EEW の報番号が内容の
      // 新しさを表さなくなり、以降の判定が「まだ古い報までしか受理していない」と誤認する。
      // `eventId` は引数のキーと一致していなければならないので触らない。
      issue: sourceSerial !== null ? { ...existing.issue, serial: source.issue?.serial } : existing.issue,
      areas: source.areas ?? source.regions ?? existing.areas,
      earthquake: {
        ...existing.earthquake,
        condition: source.earthquake.condition,
        hypocenter: source.earthquake.hypocenter,
      },
    }
    if (sourceSerial !== null) acceptedEewSerialRef.current.set(eventId, sourceSerial)
    setState(prev => ({ ...prev, activeEEWs: new Map(prev.activeEEWs).set(eventId, enriched) }))
    // severity が Warning に格上げされた場合、useLiveEventHandler 側の
    // activeEEWLevelsRef（音・通知・タブ切替を駆動する独立トラッカー）が
    // Yahoo の弱い初回推定のままにならないよう、通知層へ再評価を明示的に発火する。
    // Yahoo hypoInfo 先着＋P2PQuake code=556 後着の順序で警報が無音・通知なしになる
    // CRIT-1 の完全解消に必要な連携（レポート修正方針②）。
    if (existing.severity !== 'Warning' && enriched.severity === 'Warning' && !isSilentRef.current) {
      onLiveEventRef.current?.(enriched)
    }
  }, [])

  // 予約の発火時刻は、リプレイ中でもそのまま使う。キューへ入るものはすべて再生時計の
  // 時間軸に乗っているため:
  //   - 過去の電文は loadReplayEvents が電文時刻で直接積む
  //   - 解除・失効の予約（EEW 最終報からの自動解除・津波の有効期限）は電文時刻か
  //     getTimeRef（=再生時刻）を起点に組み立てる
  //   - リプレイ中はライブ接続を張らないので、実時刻のイベントは入ってこない
  //     （下の接続 effect が replayTimeOffset !== null で早期 return する）
  //   - リプレイの開始・停止では resetState がキューを空にするため、ライブ中に積んだ
  //     予約が再生へ持ち越されることもない
  //
  // かつては「実時刻ベースの予約が擬似過去の now から見て未来になり永久滞留する」対策として、
  // リプレイ中だけ発火時刻を now へ潰していた（VAR-1）。ライブ接続を止める根治が入った後も
  // 潰しだけが残り、再生時間軸の予約まで受信直後に発火させていた（EEW は最終報の 9ms 後に
  // 自動解除され猶予が消える・津波は validDateTime を待たず即失効する）。リプレイ中もライブ
  // 接続を張る方針に戻すなら、一律で潰すのではなく予約ごとに時間軸を持たせること。

  // WebSocket 受信時のエントリポイント: event.time を基準にキューへ挿入する
  // live モードでは event.time ≈ now なので次のティック（最大 10ms 後）に即時発火する
  const enqueueEvent = useCallback((event: AppEvent, overrideTime?: Date) => {
    const parsed = overrideTime ?? new Date((event as { time?: string }).time ?? serverNow())
    // 日時として読めない時刻は `push` が捨てる（失敗モードは `EventQueue` の注記に集約）。
    // ここは捨てさせず、**現在時刻で代替して必ず流す**。ライブ受信の電文は画面に出ないと
    // 気づけないため、時刻が壊れていても「いま届いた」として扱うほうが害が小さい。
    const eventTime = Number.isFinite(parsed.getTime()) ? parsed : serverDate()
    eventQueueRef.current.push({ eventTime, payload: { kind: 'event', event } })
  }, [])

  // 時刻ソースはアプリ時計(serverDate)に一元化。ライブ時はサーバー同期、
  // リプレイ時は clock.setReplayOffset により再生時刻を返すため差し替え不要。
  const getTimeRef = useRef<() => Date>(serverDate)

  // 南海トラフ地震関連解説情報を反映し、期限（発表から7日）で自動的に畳むタイマーを張り替える。
  // 反映できたら true を返す。
  //
  // 期限の判定に使う「いま」は getTimeRef（= clock の serverDate）。clock 側で再生オフセットを
  // 織り込んでいるため、過去日のアーカイブ再生でも「発表から7日」が再生時計の上で評価される
  // （serverNow() も同じオフセットを見るので両者に機能差はない。この hook 内の他のタイマーと
  // 時刻源を揃える意図でこちらを使う）。
  // 期限切れの電文を弾くのは、アーカイブ再生で流れてきた古い解説が帯として残らないようにするため。
  // 畳むときに id を照合するのは、待っている間に新しい解説へ入れ替わっていた場合に
  // そちらを消してしまわないため。
  /**
   * 南海トラフ臨時情報を帯へ反映する。
   *
   * **ライブ受信（WebSocket）とキュー（リプレイ・テストボタン）の両方から呼ぶこと。**
   * 同じ規則を 2 箇所に書くと片方だけ更新が漏れる ―― 実際に、取消の照合をキュー側だけに入れて
   * ライブ受信が素通りする状態を作った。関連解説情報（`applyNankaiCommentary`）と同じ形に揃える。
   *
   * @returns 反映したか。取消を見送った場合は `false` で、**呼び出し側は音・読み上げも起こさない**
   *   （表示していないものの取消を告げても伝わらない）。
   */
  const applyNankai = useCallback((nankai: JMANankai): boolean => {
    if (!nankai.cancelled) {
      shownNankaiEventIdRef.current = nankai.eventId
      setState(prev => ({ ...prev, nankai }))
      return true
    }
    // **照合するのは取消（`retracted`）だけ。**
    //
    // 「調査終了」は気象庁が調査の結果として発表する別の報で、臨時情報は**発表ごとに別の識別情報**を
    // 割り振る（実測。→ docs/spec/data-sources-spec.md §2 の表）。つまり段階の報と調査終了の報で
    // `EventID` は一致しない。ここを照合すると、**正常な調査終了で帯が永久に消えなくなる**。
    //
    // 取消は「その電文が指す情報単位」を取り消すので、対象と同じ識別情報を持つ（電文解説資料
    // Ⅰ.別紙ウ）。遅れて届いた古い取消が新しい段階の帯を消さないよう、そちらだけ照合する。
    if (nankai.retracted && shownNankaiEventIdRef.current !== nankai.eventId) {
      // 表示していない場合（記憶が空）もここへ来る。**帯が無いまま「取り消されました」と
      // 告げないため**——利用者は取り消された情報自体を見ていない。
      log.info(shownNankaiEventIdRef.current === null
        ? `[nankai] 表示していない情報単位への取消のため何もしません received=${nankai.eventId}`
        : `[nankai] 別の情報単位への取消のため帯を残します received=${nankai.eventId} shown=${shownNankaiEventIdRef.current}`)
      return false
    }
    shownNankaiEventIdRef.current = null
    setState(prev => ({ ...prev, nankai: null }))
    return true
  }, [])

  /**
   * 後発地震注意情報を帯へ反映する。失効の予約もここで持つ。
   * 呼ぶ場所と戻り値の意味は `applyNankai` に同じ。
   */
  const applyKohatsu = useCallback((kohatsu: JMAKohatsu): boolean => {
    if (kohatsuExpireTimerRef.current !== undefined) {
      window.clearTimeout(kohatsuExpireTimerRef.current)
      kohatsuExpireTimerRef.current = undefined
    }
    if (!kohatsu.cancelled) {
      const expireMs = new Date(kohatsu.expireAt).getTime() - getTimeRef.current().getTime()
      // **期限切れは出さない。** かつては取得側（`fetchDmdataKohatsu`）が期限切れを除いて
      // 返していたので、ここへは届かなかった。履歴をアーカイブ経由の 1 本へ寄せたことで
      // **遡り幅の中の最新 1 通がそのまま渡る**ようになり、期限切れも届く。
      // タイマーを張らないだけでは足りない —— 表示は出たまま、消える契機が 1 つも無くなる。
      //
      // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない
      // （解説情報・地震回数・お知らせと同じ方針）。
      if (!Number.isFinite(expireMs)) {
        log.warn('[data] 後発地震注意情報の期限を計算できません', kohatsu.expireAt)
        return false
      }
      if (expireMs <= 0) return false

      kohatsuExpireTimerRef.current = window.setTimeout(() => {
        kohatsuExpireTimerRef.current = undefined
        shownKohatsuEventIdRef.current = null
        setState(prev => ({ ...prev, kohatsu: null }))
      }, expireMs)
      shownKohatsuEventIdRef.current = kohatsu.eventId
      setState(prev => ({ ...prev, kohatsu }))
      return true
    }
    // 照合は取消だけ（理由は `applyNankai`）。後発地震に「調査終了」相当の段階は無いが、
    // 判定の形を揃えておく ―― 片方だけ違う規則にすると、次に触る人がどちらが正しいか判らない。
    if (kohatsu.retracted && shownKohatsuEventIdRef.current !== kohatsu.eventId) {
      // 表示していない場合もここへ来る（理由は `applyNankai` の同じ箇所に同じ）
      log.info(shownKohatsuEventIdRef.current === null
        ? `[kohatsu] 表示していない情報単位への取消のため何もしません received=${kohatsu.eventId}`
        : `[kohatsu] 別の情報単位への取消のため帯を残します received=${kohatsu.eventId} shown=${shownKohatsuEventIdRef.current}`)
      return false
    }
    shownKohatsuEventIdRef.current = null
    setState(prev => ({ ...prev, kohatsu: null }))
    return true
  }, [])

  const applyNankaiCommentary = useCallback((commentary: JMANankaiCommentary): boolean => {
    // 取消電文は帯を消す。false を返すので音・読み上げも起こさない（取消を告げる必要のある
    // 重さの情報ではないため。臨時情報の取消とは扱いが違う）
    if (commentary.cancelled) {
      if (nankaiCommentaryExpireTimerRef.current !== undefined) {
        window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
        nankaiCommentaryExpireTimerRef.current = undefined
      }
      // 失効の予約と同じく、消す前に `id` を照合する（待っている間に新しい解説へ入れ替わって
      // いた場合にそちらを消さないため）。
      //
      // **`eventId` では足りない。** 臨時解説（VYSE51）は一連の期間で `eventId` が固定で、
      // 号数は `Serial` にしか出ない（→ docs/spec/data-sources-spec.md §2 の表）。`eventId` だけを
      // 比べると、連日届く別の号を同じものとして扱い、照合が素通りする。`id` は両方を含む。
      //
      // **`id` を要求しても正当な取消は弾かれない。** 取消電文の `Serial` は「直前の時点における
      // 最新の情報番号の値」と定められている（電文解説資料 Ⅰ.別紙ウ 2.）ので、帯に出している号
      // （＝最新号）と一致する。古い号を指す取消だけが弾かれる ―― それがここで防ぎたいもの。
      const shown = shownCommentaryIdRef.current
      if (shown !== commentary.id) {
        log.info(`[nankaiCommentary] 別の号への取消のため帯を残します received=${commentary.id} shown=${shown}`)
        return false
      }
      shownCommentaryIdRef.current = null
      setState(prev => ({ ...prev, nankaiCommentary: null }))
      return false
    }

    const remainMs = new Date(commentary.expireAt).getTime() - getTimeRef.current().getTime()
    // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない。前者はパーサや
    // 時刻シフト（testScenarioReplay）のバグを示すため記録を残す。
    if (!Number.isFinite(remainMs)) {
      log.warn('[data] 南海トラフ関連解説情報の期限を計算できません', commentary.expireAt)
      return false
    }
    if (remainMs <= 0) return false

    if (nankaiCommentaryExpireTimerRef.current !== undefined) {
      window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
    }
    shownCommentaryIdRef.current = commentary.id
    setState(prev => ({ ...prev, nankaiCommentary: commentary }))
    nankaiCommentaryExpireTimerRef.current = window.setTimeout(() => {
      nankaiCommentaryExpireTimerRef.current = undefined
      if (shownCommentaryIdRef.current === commentary.id) shownCommentaryIdRef.current = null
      setState(prev => (
        prev.nankaiCommentary?.id === commentary.id ? { ...prev, nankaiCommentary: null } : prev
      ))
    }, remainMs)
    return true
  }, [])

  /**
   * 地震・津波に関するお知らせ（VZSE40）を反映する。
   *
   * 帯の扱いは南海トラフ関連解説情報とほぼ同じ（最新の 1 通・7 日で畳む・取消で消す）。
   * **7 日は表示上の都合**で、気象庁が期限を定めているわけではない（後発地震注意情報の 7 日とは違う）。
   *
   * 戻り値は「帯を出したか」。**呼び出し側は現状これを見ていない**（このお知らせは音も読み上げも
   * 起こさないため、分岐する先が無い）。それでも bool を返すのは、隣の `applyNankaiCommentary`
   * ・`applyKohatsu` と形を揃えておくため —— 揃えておかないと、後から「反映できたか」で
   * 分岐したくなったときに、この関数だけ内部を書き換える必要が出る。
   */
  const applyQuakeNotice = useCallback((notice: JMAQuakeNotice): boolean => {
    if (notice.cancelled) {
      if (quakeNoticeExpireTimerRef.current !== undefined) {
        window.clearTimeout(quakeNoticeExpireTimerRef.current)
        quakeNoticeExpireTimerRef.current = undefined
      }
      // 消す前に id を照合する（待っている間に新しいお知らせへ入れ替わっていたら、そちらを消さない）。
      //
      // **取消は元のお知らせの `EventID` を引き継ぐ。** 気象庁公式のサンプル
      // （`42_03_01_220402_VZSE40.xml`）は発表時刻が 2022-04-02 06:58 なのに `EventID` は
      // `20220402050100`（＝05:01）で、自分の発表時刻ではなく**取り消す対象の発表時刻**を
      // 指している（発表側のサンプルでは `EventID` ＝自分の発表時刻）。`Serial` は両方とも空なので、
      // 発表と取消で `id` が一致する。**実配信の取消は未観測**なので、届いたら形を確かめること。
      const shown = shownQuakeNoticeIdRef.current
      if (shown !== notice.id) {
        log.info(`[quakeNotice] 別のお知らせへの取消のため帯を残します received=${notice.id} shown=${shown}`)
        return false
      }
      shownQuakeNoticeIdRef.current = null
      setState(prev => ({ ...prev, quakeNotice: null }))
      // **取消しの理由は出さない**（パーサーは `body` に読んでいる）。この帯は音も読み上げも
      // 持たず、取消では帯ごと消えるので、理由を届ける先が 1 つも無い。中身が運用連絡なので、
      // 消すためだけに帯を出し直すほどのものでもない。**「まだ決めていない」ではなく決めた結果**
      // （→ docs/spec/data-sources-spec.md §2「扱う電文種別」）。
      return false
    }

    const remainMs = new Date(notice.expireAt).getTime() - getTimeRef.current().getTime()
    // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない（解説情報と同じ）。
    if (!Number.isFinite(remainMs)) {
      log.warn('[data] 地震・津波に関するお知らせの期限を計算できません', notice.expireAt)
      return false
    }
    if (remainMs <= 0) return false

    if (quakeNoticeExpireTimerRef.current !== undefined) {
      window.clearTimeout(quakeNoticeExpireTimerRef.current)
    }
    shownQuakeNoticeIdRef.current = notice.id
    setState(prev => ({ ...prev, quakeNotice: notice }))
    quakeNoticeExpireTimerRef.current = window.setTimeout(() => {
      quakeNoticeExpireTimerRef.current = undefined
      if (shownQuakeNoticeIdRef.current === notice.id) shownQuakeNoticeIdRef.current = null
      setState(prev => (prev.quakeNotice?.id === notice.id ? { ...prev, quakeNotice: null } : prev))
    }, remainMs)
    return true
  }, [])

  /**
   * 地震回数に関する情報（VXSE60）を反映する。
   *
   * 帯の扱いは南海トラフ関連解説情報・お知らせと同じ（最新の 1 通・7 日で畳む・取消で消す）。
   * **7 日は表示上の都合**で、気象庁が期限を定めているわけではない —— この情報に終わりの宣言は
   * 無く、群発が収まれば発表が止まるだけ。畳む契機を次報と取消だけにすると、収まったあとも
   * 帯が居座る。
   *
   * **区間が 1 つも読めなかった報は反映しない。** 中身が空の帯を出しても伝わるものが無く、
   * 読み取りの失敗はパーサー側が記録している。
   */
  const applyEarthquakeCount = useCallback((count: JMAEarthquakeCount): boolean => {
    if (count.cancelled) {
      // 取消は id ではなく eventId で照合する。回数情報は同じ群発について報を重ねるので、
      // 取消が指すのは「その群発について直前に出した報」＝いま出している報になる。
      if (shownEarthquakeCountEventIdRef.current !== count.eventId) {
        log.info(`[earthquakeCount] 別の群発への取消のため帯を残します received=${count.eventId} shown=${shownEarthquakeCountEventIdRef.current}`)
        return false
      }
      if (earthquakeCountExpireTimerRef.current !== undefined) {
        window.clearTimeout(earthquakeCountExpireTimerRef.current)
        earthquakeCountExpireTimerRef.current = undefined
      }
      shownEarthquakeCountEventIdRef.current = null
      setState(prev => ({ ...prev, earthquakeCount: null }))
      // **true を返す。** 読み上げ側が「取り消された」ことを伝えるため。false にすると
      // 取消がどこへも流れず、直前に読み上げた回数が訂正されないまま残る。
      return true
    }
    if (count.items.length === 0) return false

    const remainMs = new Date(count.expireAt).getTime() - getTimeRef.current().getTime()
    // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない（解説情報と同じ）。
    if (!Number.isFinite(remainMs)) {
      log.warn('[data] 地震回数に関する情報の期限を計算できません', count.expireAt)
      return false
    }
    if (remainMs <= 0) return false

    if (earthquakeCountExpireTimerRef.current !== undefined) {
      window.clearTimeout(earthquakeCountExpireTimerRef.current)
    }
    shownEarthquakeCountEventIdRef.current = count.eventId
    setState(prev => ({ ...prev, earthquakeCount: count }))
    earthquakeCountExpireTimerRef.current = window.setTimeout(() => {
      earthquakeCountExpireTimerRef.current = undefined
      if (shownEarthquakeCountEventIdRef.current === count.eventId) shownEarthquakeCountEventIdRef.current = null
      setState(prev => (prev.earthquakeCount?.id === count.id ? { ...prev, earthquakeCount: null } : prev))
    }, remainMs)
    return true
  }, [])

  /**
   * 推計震度分布図（IXAC41）を反映する。
   *
   * **古い報で退行させない。** 同じ地震について続報が出る（実電文で M7.4 → M7.6 の 6 分後、
   * セル数も変わった）うえ、DMDATA は内容が同一の重複配信もする。到着順が入れ替わったときに
   * 古い分布へ戻ると、画面が理由もなく前の姿へ巻き戻る。判定は**発表時刻の比較**で行う
   * ——この電文は `eventId` を持たないので報番号の台帳が作れない。
   *
   * **別の地震の分布は無条件に置き換える。** 発表されるのは震度5弱以上の地震だけなので、
   * 新しい地震の分布が届いたということは、そちらを見せるべき状況になっている。
   *
   * **初報か続報かを併せて返す。** 読み上げが「受信しました」と「更新されました」を言い分ける
   * のに要る（→ `isNewEstimatedIntensity`）。判定に使う台帳はここが持っているので、受け取る側で
   * 数え直すことはできない。
   *
   * @param announce 音・読み上げを伴うか。偽（初期状態の注入）なら台帳へ積まない
   * @returns 反映したら初報かどうか。反映しなかったら null
   */
  const applyEstimatedIntensity = useCallback((
    data: JMAEstimatedIntensity, announce: boolean,
  ): { isNew: boolean } | null => {
    // **判定は ref で同期に行う。** `setState` の更新関数の中で判定すると、React が
    // 開発時に更新関数を二度呼ぶため副作用が二重になり、しかも呼び出し元へ結果を返せない
    // （更新が後回しになりうる）。地震回数の帯が同じ理由で ref を持っている。
    // 判定は純関数へ切り出してある（`decideEstimatedIntensityUpdate`）。理由の言い分けと
    // 「別の地震でも古い発表は採らない」規則をテストで固定したいため。
    const cur = shownEstimatedIntensityRef.current
    const verdict = decideEstimatedIntensityUpdate(cur, data)
    if (verdict.reason === 'stale') {
      log.info(`[ixac41] 発表が古い報なので反映しません received=${data.time}/${data.arrivalTime} shown=${cur?.time}/${cur?.arrivalTime}`)
      return null
    }
    if (!verdict.apply) return null
    if (verdict.reason === 'switched') {
      // 別の地震の分布へ入れ替えた。**画面だけ見てもどちらの地震のものかは判らない**ので残す。
      log.info(`[ixac41] 別の地震の分布へ入れ替えます received=${data.arrivalTime} shown=${cur?.arrivalTime}`)
    }
    shownEstimatedIntensityRef.current = { arrivalTime: data.arrivalTime, time: data.time, count: data.count }
    setState(prev => ({ ...prev, estimatedIntensity: data }))
    // 初報か続報かは**台帳**で決める。`verdict.reason` では決められない —— 理由が比べている
    // 相手はいま出している 1 通だけなので、別の地震の分布を挟むと同じ地震の続報が `switched`
    // になる（実電文の例は `isNewEstimatedIntensity`）。
    const isNew = isNewEstimatedIntensity(shownEstimatedIntensityArrivalsRef.current, data.arrivalTime)
    if (announce) rememberShownEstimatedIntensity(shownEstimatedIntensityArrivalsRef.current, data.arrivalTime)
    return { isNew }
  }, [])

  /**
   * 取消を見た事実を台帳へ積む。件数に上限を置き、古いものから落とす。
   *
   * 上限を置くのは、長時間つないだままの端末で無制限に伸びるのを避けるため。**判定は毎回全件を
   * 走査する**ので、伸びると受信ごとの処理も重くなる。取り下げ済みの報が届くのは順序の
   * 入れ替わりか誤認識なので、直近の取消だけ覚えていれば足りる。
   */
  // 重複の排除と上限の管理は `addQuakeRetraction` が持つ（そちらに理由とテストがある）
  const rememberQuakeRetraction = useCallback((retraction: QuakeRetraction) => {
    addQuakeRetraction(quakeRetractionsRef.current, retraction, MAX_QUAKE_RETRACTIONS)
  }, [])

  /** 履歴バッチに含まれる取消電文を台帳へ取り込む（ライブ経路と記憶を共有するため）。 */
  const rememberQuakeRetractionsFromBatch = useCallback((quakes: readonly JMAQuake[]) => {
    for (const q of quakes) {
      if (q.cancelled) rememberQuakeRetraction(quakeRetractionOf(q))
    }
  }, [rememberQuakeRetraction])

  const handleEvent = useCallback((event: AppEvent) => {
    // 古い報は**入口で**捨てる。この下の通知（読み上げ・ウィンドウタイトル）と自動解除の予約は
    // setState の外で走るため、状態更新の直前で弾いても間に合わない。地図・カードだけが新しい報を
    // 保ち、読み上げとタイトルが古い報で上書きされる——画面と音声が食い違う方が始末が悪い。
    // 取消・失効・テスト報は報番号に関わらず通す（弾くと誤報を消せなくなる）。
    if (event.kind === 'eew') {
      const incoming = event as EEWAlert
      if (!incoming.cancelled && !incoming.expired && !incoming.test) {
        const key = eewEventKey(incoming)
        const incomingSerial = eewSerial(incoming)
        const acceptedSerial = acceptedEewSerialRef.current.get(key)
        if (incomingSerial !== null && acceptedSerial !== undefined && incomingSerial < acceptedSerial) {
          // 順序の入れ替わり自体は想定内だが、判定が誤り続けるとその EEW は以降更新されない。
          // 捨てた事実が残らないと原因に辿り着けないため記録する（頻度は 1 地震あたり数件）。
          log.debug(`[eew] 古い報を破棄: key=${key} 受理済み=#${acceptedSerial} 受信=#${incomingSerial}`)
          return
        }
        if (incomingSerial !== null) acceptedEewSerialRef.current.set(key, incomingSerial)
      }
    }
    // ライブ受信／テスト送信のイベントを通知（サイレントモード中は抑制）
    if (!isSilentRef.current) onLiveEventRef.current?.(event)

    // 556（EEW）: 最終報受信時、解除時刻にキャンセルイベントをキューへ挿入する。
    // standard版の Yahoo hypoInfo 経由 EEW は useKyoshinRealtime 側の消滅検出（diffHypoInfoEvents）
    // でも独立に解除イベントが発生しうるため、同一 eventId に対しここでのタイマー式解除と
    // 二重に発火することがある。2発目は activeEEWs から既に消えているため
    // useEarthquakes/useLiveEventHandler の hadKey チェックで無視される（意図した重複）。
    if (event.kind === 'eew') {
      const eew = event as EEWAlert
      if (!eew.cancelled && !eew.test && eew.isFinal) {
        const cancelTime = calcEEWCancelTime(eew, new Date(eew.time))
        // **予約できなかったことを、この経路の言葉で残す。** キューは発火時刻が読めない
        // エントリを捨てて記録するが（`createEventQueue` の `push`）、その文言は
        // 「捨てた」までしか言わない。ここで書かないと、症状（**その EEW が自動では
        // 消えず画面に居座る**）と原因が結び付かない。
        //
        // 解除時刻は発表時刻と震源時刻のどちらか一方が読めれば決まる（`calcEEWCancelTime`）。
        // ここへ来るのは両方読めなかったときだけ。
        if (!Number.isFinite(cancelTime.getTime())) {
          log.error('[eew] 発表時刻も震源時刻も読めないため自動解除を予約できません（取消が来るまで表示が残ります）'
            + ` id=${eew.id} eventId=${eew.issue?.eventId ?? '(なし)'}`
            + ` time="${eew.time}" originTime="${eew.earthquake.originTime}"`)
        } else {
          eventQueueRef.current.push({
            eventTime: cancelTime,
            payload: { kind: 'event', event: { ...eew, cancelled: true, expired: true } as AppEvent },
          })
        }
      }
    }

    // 地震情報（551）の震度キャッシュ更新は setState の外で行う
    if (event.kind === 'quake') {
      const quake = event as JMAQuake
      // キャッシュのキーはイベントの安定キー。DMDATA は eventId なので全報で一致する。
      // P2PQuake は報ごとに別キーになるためこのキャッシュは実質効かず、通常経路では
      // mergeQuakeInto（既存カードの震度で埋める）が同じ補完を担う。ただし対象カードが
      // 既に消えている場合（取消の 10 秒後 purge など）はどちらも効かず震度は欠落する。
      // ここを earthquake.time に戻すと、同じ分に起きた別の地震の震度を引いてしまう。
      const cacheKey = quakeEventKey(quake)
      // VXSE51 の震度データをキャッシュ（後続 VXSE52 への補完用）
      if (quake.issue.type === '震度速報' && quake.earthquake.maxScale >= 0) {
        quakeIntensityCacheRef.current.set(cacheKey, {
          maxScale: quake.earthquake.maxScale,
          points: quake.points,
        })
      }
      // 取消を見た事実も**入口で**台帳へ積む（EEW 側の台帳と同じ置き方）。`setState` の更新関数は
      // 再実行されうるため、そこに副作用を置くと同じ記録が二重に積まれ、台帳の実効容量が縮む。
      if (quake.cancelled) {
        // 当たったカードを渡せると照合の材料が揃う（理由は `QuakeRetraction`）。判定は下の
        // 取消分岐と同じ述語（`findQuakeCancelTarget`）を使う。書き写すと片方だけ変わりうる。
        rememberQuakeRetraction(
          quakeRetractionOf(quake, findQuakeCancelTarget(stateRef.current.earthquakes, quake, getAreaPrefIndexCache())),
        )
      }
    }

    // 552（津波）: 期限切れ時刻にキャンセルイベントをキューへ挿入する。
    // TSU-1: validDateTime を持つ続報だけ「古い予約を消して新しい予約を積み直す」。
    // TSU-5A: standard 版（P2PQuake）は API 仕様上 validDateTime を持たないため、
    // 解除電文が届かない例外ケースに備えて 24h 後の自動非表示フェイルセーフを積む。
    // DMDSS 版で validDateTime が無い電文（VTSE51②/VTSE52 の観測のみ続報）は正規パターンで、
    // 既存の expired 予約を触らず据え置く（消してから積み直しをしないと、期限切れによる自動失効が
    // 二度と起きなくなる）。よって purge は「これから insert する場合」または「明示解除電文」の
    // 場合のみ実行する（DMDSS の観測のみ続報では purge も insert もしない）。
    if (event.kind === 'tsunami') {
      const tsunami = event as JMATsunami
      const now = getTimeRef.current()
      let expireTime: Date | null = null
      if (!tsunami.cancelled) {
        if (tsunami.validDateTime) {
          // 日時として読めない期限で予約を積まないこと（`push` も捨てるが、そちらは
          // 呼び出し規約の違反として `error` に残る。**電文が期限を持たないのは正常** なので、
          // ここで分けて `warn` に留める。失敗モードは `EventQueue` の注記）。
          const parsed = new Date(tsunami.validDateTime)
          if (Number.isFinite(parsed.getTime())) expireTime = parsed
          else log.warn(`[tsunami] 有効期限を日時として読めないため失効予約を積みません: id=${tsunami.id} validDateTime=${tsunami.validDateTime}`)
        }
        if (!expireTime && !isDmdss) {
          const FAILSAFE_MS = 24 * 60 * 60 * 1000
          // 初期状態の再現（silent 注入）では、過去に発表された電文をまとめて「いま」流し直す。
          // 受信時刻を基準にすると、20 時間前に出ていた津波が再生開始からさらに 24 時間残り、
          // 実際の失効タイミングとずれる。この経路だけは発表時刻を基準にする。
          const issuedAt = new Date(tsunami.time)
          const baseMs = isSilentRef.current && Number.isFinite(issuedAt.getTime())
            ? issuedAt.getTime()
            : now.getTime()
          expireTime = new Date(baseMs + FAILSAFE_MS)
        }
      }
      const shouldModifyQueue = tsunami.cancelled || expireTime !== null
      if (shouldModifyQueue) {
        // 津波は「常に 1 件スロット」（tsunami-spec §5・TSU-3）で管理されるため、
        // expired 予約は最新 1 件だけ残せば充分。P2PQuake 経路は eventId が無く id も続報ごとに
        // 変わるため、id/eventId 一致条件を課すと古い予約が消えず積み上がる問題があった。
        // 明示解除電文でも purge するのは、TSU-5A の 24h 予約を解決済み津波に対して発火させないため。
        eventQueueRef.current.retain(entry => {
          if (entry.payload.kind !== 'event') return true
          const ev = entry.payload.event
          if (ev.kind !== 'tsunami') return true
          const evAny = ev as JMATsunami
          return evAny.cancelReason !== 'expired'
        })
        if (expireTime) {
          // 初期状態の再現では、遡り幅（24 時間）の境目ぶんだけ「発表から 24 時間を過ぎた」
          // 電文が紛れうる。未来の予約しか積まないと、そういう津波は失効予約を持たないまま
          // 画面に残り、リプレイ中はライブ更新も止まっているので消す手段が無くなる。
          // その場で失効させる（silent 注入なので音は鳴らない）。
          const alreadyExpired = expireTime <= now
          if (!alreadyExpired || isSilentRef.current) {
            eventQueueRef.current.push({
              eventTime: alreadyExpired ? now : expireTime,
              silent: alreadyExpired ? true : undefined,
              payload: { kind: 'event', event: { ...tsunami, cancelled: true, cancelReason: 'expired' } as AppEvent },
            })
          }
        }
      }
    }

    setState(prev => {
      const now = getTimeRef.current()
      switch (event.kind) {
        case 'quake': {
          let quake = event as JMAQuake

          // 取消電文: 同一イベント・同一種別のカードに cancelledAt を付け、10秒後に purge する。
          // 種別まで見るのは、遠地地震の取消報が「震源・震度情報」のカードを巻き込まないようにするため
          // （遠地地震は VXSE53 を共有し Head/Title だけが異なる。dmdataParser の resolveIssueType 参照）。
          if (quake.cancelled) {
            let found = false
            const earthquakes = prev.earthquakes.map(e => {
              if (isQuakeCancelTarget(e, quake, getAreaPrefIndexCache())) {
                found = true
                eventQueueRef.current.push({
                  eventTime: new Date(now.getTime() + 10_000),
                  payload: { kind: 'purge-cancelled-quake', id: e.id },
                  silent: true,
                })
                // 津波側と同じく、取消電文だけが持つ項目は名指しで移す（土台は表示中のカード）。
                return { ...e, cancelledAt: now, ...(quake.cancelText && { cancelText: quake.cancelText }) }
              }
              return e
            })
            if (!found) {
              // 取消対象が見つからない＝取消がどのカードにも効いていない。無言で捨てると
              // 「取り消されたはずの地震が残り続ける」原因を後から追えないため記録する。
              log.warn('[quake] 取消電文に対応するカードが見つからず無視した', {
                id: quake.id, issueType: quake.issue.type, quakeTime: quake.earthquake.time,
              })
              return prev
            }
            return { ...prev, earthquakes, lastUpdate: now }
          }

          // キーの決め方と P2PQuake での扱いは上の同名変数（震度キャッシュ更新側）と同じ。
          const cacheKey = quakeEventKey(quake)

          // VXSE52/53: 震度がない場合に VXSE51 キャッシュから maxScale・points を補完する
          if (quake.earthquake.maxScale < 0 && quake.points.length === 0) {
            const cachedIntensity = quakeIntensityCacheRef.current.get(cacheKey)
            if (cachedIntensity) {
              quake = {
                ...quake,
                earthquake: { ...quake.earthquake, maxScale: cachedIntensity.maxScale },
                points: cachedIntensity.points,
              }
            }
          }

          // 同一イベントの既存カードを探し、リアルタイム統合コアで1枚に統合する。
          // 同一性の判定は sameQuakeEntry、VXSE61 の震源マージ・震度保持・優先度判定は
          // mergeQuakeInto に委譲する（いずれも履歴経路と同一ロジック）。
          // 一致するカードが 2 枚あることがある（暫定 ID と確定 ID）。どちらを既存として
          // 扱うかで統合後の eventKey が変わるため、選び方は findExistingQuakeCard に集約する。
          // 取消の後に届いた報のうち、取消より前に発表されたもの（＝取り下げ済みの内容）は
          // 採らない。判定の中身と 2 通りの異常の切り分けは `isRetractedQuakeReport`。
          if (isRetractedQuakeReport(quakeRetractionsRef.current, quake, getAreaPrefIndexCache())) {
            log.warn('[quake] 取消以前に発表された報を捨てた', {
              id: quake.id, issueType: quake.issue.type, time: quake.time,
            })
            return prev
          }
          const existing = findExistingQuakeCard(prev.earthquakes, quake, getAreaPrefIndexCache())
          const merged = mergeQuakeInto(existing, quake)
          if (merged === existing) return prev
          // 統合の結果、暫定 ID で作られたカードが確定 ID を持つカードと重複することがある。
          // 履歴経路（mergeQuakeHistory）と同じ畳み込みをここでも通す（理由は coalesceByEventId）。
          //
          // **取消表示中のカードは差し替えの対象から外す（残す）。** ここで落とすと 10 秒表示を
          // 待たずに消え、しかも purge 予約（`id` で対象を引く）が空振りする。
          const next = coalesceByEventId([
            merged,
            ...prev.earthquakes.filter(e => e.cancelledAt || !sameQuakeEntry(e, quake, getAreaPrefIndexCache())),
          ])
          return {
            ...prev,
            earthquakes: sortQuakes(next),
            lastUpdate: now,
          }
        }
        case 'tsunami': {
          const tsunami = event as JMATsunami
          if (tsunami.cancelled) {
            // 別イベントの遅延到達した解除で、表示中の津波を消さない。判定の中身と理由は
            // `isCancelForCurrentTsunami`（読み上げ・画面の記憶を落とす側と共有する）。
            if (prev.tsunamis.length > 0 && !isCancelForCurrentTsunami(tsunami, prev.tsunamis[0])) return prev
            // 解除・取消・期限切れのいずれも同じ10秒表示を経る。表示内容は cancelReason で出し分ける（TsunamiTab側）。
            if (prev.tsunamis.length > 0 && !prev.tsunamis[0].cancelledAt) {
              // TSU-4: purge 予約に対象 id を持たせ、他イベントが後で置換した場合に誤って
              // 新しいカードを 10 秒前に消してしまうレースを防ぐ。
              eventQueueRef.current.push({
                eventTime: new Date(now.getTime() + 10_000),
                payload: { kind: 'purge-cancelled-tsunami', id: prev.tsunamis[0].id },
                silent: true,
              })
              // **取消電文から引き継ぐのは 2 つ。** 表示中のカードを土台にするので、
              // 取消電文だけが持つ項目は名指しで移さないと落ちる（`cancelText` は
              // 気象庁が書いた取消しの理由で、他のどこにも無い）。
              return {
                ...prev,
                tsunamis: [{
                  ...prev.tsunamis[0],
                  cancelledAt: now,
                  cancelReason: tsunami.cancelReason,
                  ...(tsunami.cancelText && { cancelText: tsunami.cancelText }),
                }],
                lastUpdate: now,
              }
            }
            return { ...prev, tsunamis: [], lastUpdate: now }
          }
          // ValidDateTime が過去 = すでに有効期限切れ（ページリロード時など）
          if (tsunami.validDateTime && new Date(tsunami.validDateTime) <= now) {
            return { ...prev, tsunamis: [], lastUpdate: now }
          }
          // 同一イベントの続報: 観測のみ電文（areas=[]）で警報カードが消えないよう前回の areas を維持し、
          // observations は上書きではなくマージする（区域・観測点ごとに前回値を保持）。
          const current = prev.tsunamis[0]
          // 引き継ぎの条件は `isTsunamiContinuation` に集約する（カード順の基準を組み立てる
          // `tsunamiCardOrderBasis` と同じ述語を使うため。宣言箇所に理由）。
          const sameEvent = isTsunamiContinuation(current, tsunami)
          if (sameEvent) {
            // **引き継ぎの規則は `mergeTsunamiReports` の 1 箇所に置く。** ここへ書き写すと、
            // 履歴からの復元（`withInheritedTsunamiFacts`）との間で片方だけに項目が足され、
            // 「ライブ受信では出るのにリロードすると消える」形の欠落が生まれる（実際に
            // 繰り返し起きた）。何をどう引き継ぐかはあちらの表を見ること。
            return { ...prev, tsunamis: [mergeTsunamiReports(current, tsunami)], lastUpdate: now }
          }
          // TSU-3: 別 eventId の tsunami で既存を上書きするケースを検知したら警告する。
          // 実装は 1 件スロットのまま（複数同時発表は稀なため型変更はスコープ外）だが、
          // 上書きが発生した事実がログから追えるようにする。
          if (current && current.eventId && tsunami.eventId
              && current.eventId !== tsunami.eventId && !current.cancelledAt) {
            log.warn(`[tsunami] 別 eventId の tsunami で上書き（複数同時発表・実装は 1 件スロット）: prev=${current.eventId} next=${tsunami.eventId}`)
          }
          return { ...prev, tsunamis: [tsunami], lastUpdate: now }
        }
        case 'eew': {
          const eew = event as EEWAlert
          // 台帳（`acceptedEewSerialRef`）と同じキーで引く。式を書き写すと、導出が変わったときに
          // 片方だけ追従して台帳と状態のキーが割れ、同一ティックの判定が静かに壊れる。
          const key = eewEventKey(eew)
          if (eew.test) {
            const next = new Map(prev.activeEEWs)
            next.delete(key)
            return { ...prev, activeEEWs: next, lastUpdate: now }
          }
          if (eew.cancelled) {
            // 最終報タイマー満了（expired）は即削除、誤報取消電文は 10秒表示
            if (eew.expired) {
              const next = new Map(prev.activeEEWs)
              next.delete(key)
              return { ...prev, activeEEWs: next, lastUpdate: now }
            }
            const existing = prev.activeEEWs.get(key)
            if (!existing || existing.cancelledAt) return prev
            eventQueueRef.current.push({
              eventTime: new Date(now.getTime() + 10_000),
              payload: { kind: 'purge-cancelled-eew', key },
              silent: true,
            })
            const next = new Map(prev.activeEEWs)
            // 地震・津波と同じく、取消電文だけが持つ項目は名指しで移す（土台は表示中の EEW）。
            next.set(key, { ...existing, cancelledAt: now, ...(eew.cancelText && { cancelText: eew.cancelText }) })
            return { ...prev, activeEEWs: next, lastUpdate: now }
          }
          // 続報の上書きだが severity は upgrade only にする（Yahoo hypoInfo 続報が
          // 弱い推定値で来ても、既に P2PQuake WS 経由で Warning に上げていたら維持）。
          // areas/earthquake の enrichment 保持は別途扱う（本コミットの範囲外）。
          const existing = prev.activeEEWs.get(key)
          // 入口（`handleEvent` の先頭）でも同じ判定をしているが、ここにも置く。キューの
          // ディスパッチャは 1 ティックで複数のイベントを処理し、その間 `stateRef` は
          // レンダー待ちで進まないため、入口だけでは同じティックに積まれた報を取りこぼす。
          // 記録は入口に集約する（setState は再実行されうるので副作用を持たせない）。
          if (existing && isStaleEewReport(existing, eew)) return prev
          // **取消は終端。非取消の報で復活させない。** 取消電文は報番号の台帳を進めず
          // （入口のガードは `!incoming.cancelled` のときだけ記録する）、状態側も取消前の
          // 報番号を保ったまま `cancelledAt` を足すだけなので、**同じ報番号の非取消報が
          // 届くと `isStaleEewReport` をすり抜けて上書きする**。上書きされた側は
          // `cancelledAt` を失い、取消の表示が消えたうえに 10 秒後の purge も空振りする
          // （purge は `cancelledAt` の有無で判定するため）。
          //
          // これが現実に起きるのは、起動時の復元が取消の直前に発表された報を拾ったとき
          // （一覧 API が取消を反映するまでの遅れ）と、ライブで報の到着順が入れ替わったとき。
          if (existing?.cancelledAt && !eew.cancelled) {
            log.debug(`[eew] 取消済みのため非取消の報を無視: key=${key} 受信=#${eew.issue?.serial ?? '(なし)'}`)
            return prev
          }
          const merged: EEWAlert = existing
            ? { ...eew, severity: existing.severity === 'Warning' ? 'Warning' : eew.severity }
            : eew
          return {
            ...prev,
            activeEEWs: new Map(prev.activeEEWs).set(key, merged),
            lastUpdate: now,
          }
        }
        default:
          return { ...prev, lastUpdate: now }
      }
    })
  }, [])

  // 表示が終わった EEW の報番号は覚えておく必要がない。掃除しないと台帳が伸び続ける
  // （EEW は 1 日に数十件届き、画面は長く開かれたままになる）。`activeEEWs` から消えたものを
  // 落とすだけなので、判定に要る間は残る。
  useEffect(() => {
    const ledger = acceptedEewSerialRef.current
    if (ledger.size === 0) return
    for (const key of [...ledger.keys()]) {
      if (!state.activeEEWs.has(key)) ledger.delete(key)
    }
  }, [state.activeEEWs])

  // キューディスパッチャー: 10ms ごとに eventTime <= 現在時刻のエントリを処理する
  useEffect(() => {
    const id = setInterval(() => {
      const now = getTimeRef.current()
      // 1 件ずつキューへ問い合わせる。下の `handleEvent` は津波の失効予約を張り替える際に
      // キューの中身を変えるため、**取り出し済みの一覧をこちら側で保持してはいけない**
      // （理由と実測値は `EventQueue` の注記）。
      for (;;) {
        const entry = eventQueueRef.current.shiftReady(now)
        if (!entry) break
        const { payload, silent } = entry
        isSilentRef.current = !!silent
        if (payload.kind === 'event') {
          handleEvent(payload.event)
        } else if (payload.kind === 'lpgm') {
          const lpgm = payload.data
          setState(prev => {
            const next = new Map(prev.lpgmByEventId)
            if (lpgm.cancelled) next.delete(lpgm.eventId)
            else next.set(lpgm.eventId, lpgm)
            return { ...prev, lpgmByEventId: next }
          })
          if (!silent && !lpgm.cancelled && lpgm.maxClass >= 1) {
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm })
          }
        } else if (payload.kind === 'nankai') {
          const nankai = payload.data
          // 反映しなかった取消では音も読み上げも起こさない（判定は `applyNankai`）。
          const applied = applyNankai(nankai)
          if (applied && !silent) onLiveEventRef.current?.({ kind: 'nankai', data: nankai })
        } else if (payload.kind === 'nankaiCommentary') {
          const commentary = payload.data
          // 期限切れなら反映も通知もしない（画面に出ないものを読み上げても意味がない）
          if (applyNankaiCommentary(commentary) && !silent) {
            onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary })
          }
        } else if (payload.kind === 'purge-cancelled-quake') {
          const { id } = payload
          setState(prev => ({
            ...prev,
            earthquakes: prev.earthquakes.filter(e => e.id !== id || !e.cancelledAt),
          }))
        } else if (payload.kind === 'purge-cancelled-eew') {
          const { key } = payload
          setState(prev => {
            const existing = prev.activeEEWs.get(key)
            if (!existing?.cancelledAt) return prev
            const next = new Map(prev.activeEEWs)
            next.delete(key)
            return { ...prev, activeEEWs: next }
          })
        } else if (payload.kind === 'purge-cancelled-tsunami') {
          setState(prev => {
            // TSU-4: 現在の tsunami が purge 対象と id 一致し、かつ cancelledAt が付いていれば消去する。
            // 別 id の tsunami に置き換わっている場合は誤消去せず据え置く。
            if (prev.tsunamis.length === 0 || !prev.tsunamis[0].cancelledAt) return prev
            if (prev.tsunamis[0].id !== payload.id) return prev
            return { ...prev, tsunamis: [] }
          })
        } else if (payload.kind === 'kohatsu') {
          const kohatsu = payload.data
          const applied = applyKohatsu(kohatsu)
          if (applied && !silent) onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu })
        } else if (payload.kind === 'quakeNotice') {
          // **通知は出さない。** 運用連絡なので音も読み上げも起こさない（→ docs/spec/data-sources-spec.md
          // §2「扱う電文種別」）。帯に出すだけなので `onLiveEvent` へは流さない。
          applyQuakeNotice(payload.data)
        } else if (payload.kind === 'earthquakeCount') {
          const count = payload.data
          if (applyEarthquakeCount(count) && !silent) {
            onLiveEventRef.current?.({ kind: 'earthquakeCount', data: count })
          }
        } else if (payload.kind === 'estimatedIntensity') {
          const ei = payload.data
          // **`onLiveEvent` へ流す。** 音・読み上げ・地図の分布モードを開く処理がその先にある。
          // 反映できなかったとき（古い報・重複配信）は流さない —— 画面が変わっていないのに
          // 音だけ鳴る。
          const applied = applyEstimatedIntensity(ei, !silent)
          if (applied && !silent) {
            onLiveEventRef.current?.({ kind: 'estimatedIntensity', data: ei, isNew: applied.isNew })
          }
        }
        isSilentRef.current = false
      }
    }, 10)
    return () => clearInterval(id)
  }, [handleEvent])

  // アンマウント時にタイマーとキューをクリア。
  // 7日タイマーは 4 つある（後発地震・南海トラフ関連解説情報・地震津波に関するお知らせ・地震回数）。
  // **1 つでも落とし忘れると**、残った側が最大7日後にアンマウント済みのクロージャの setState を呼ぶ。
  useEffect(() => {
    return () => {
      if (kohatsuExpireTimerRef.current !== undefined) {
        window.clearTimeout(kohatsuExpireTimerRef.current)
      }
      if (nankaiCommentaryExpireTimerRef.current !== undefined) {
        window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
      }
      if (quakeNoticeExpireTimerRef.current !== undefined) {
        window.clearTimeout(quakeNoticeExpireTimerRef.current)
      }
      if (earthquakeCountExpireTimerRef.current !== undefined) {
        window.clearTimeout(earthquakeCountExpireTimerRef.current)
      }
      // テストボタンが張った待ちも全部落とす（→ `clearTestSimulationTimers`）。
      // **キューを空にするだけでは足りない** —— 津波と EEW のテストはキューを通らず
      // `handleEvent` を直接呼ぶ。
      clearTestSimulationTimers()
      eventQueueRef.current.clear()
    }
  }, [clearTestSimulationTimers])

  useEffect(() => {
    let cancelled = false
    // 時間軸が変わった印。ここより前に始まった取得は、以後の結果を捨てる
    liveGenerationRef.current++
    // 遡り幅も初期値へ戻す（戻さないと、接続を張り直すたびに余計に遡る）
    historyDaysRef.current = HISTORY_INITIAL_DAYS
    // 履歴の損失もここで空へ戻す。**これから読み直す範囲の話**なので、前の接続で欠けた分を
    // 持ち越すと直っても表示が消えない。遡り幅と同じ同期ブロックで戻す。
    setState(prev => (
      isTelegramLossEmpty(prev.historyLoss) && !prev.loadMoreFailed
        ? prev
        : { ...prev, historyLoss: createEmptyTelegramLoss(), loadMoreFailed: false }
    ))

    // VAR-1: リプレイ中はライブ接続を止める（両バリアント共通）。過去の電文を流している最中に
    // 現在時刻のライブ更新が混ざると、再生時刻より未来の地震がカードに並んで実際の経過を追えない。
    // かつては standard 版だけ P2PQuake WS を継続していた（リプレイが強震モニタの時計ずらしに
    // 過ぎず、地震・津波は何も流れなかったため）。現在は standard 版も当時の地震情報・津波を
    // 取得して流すので、DMDSS 版と同じ扱いにする。
    if (replayTimeOffset !== null) {
      // 状態表示を再生中のものへ畳む。
      //
      // ひとつは `connectionStatus`。ここで更新せずに抜けると直前の値（多くは 'connected'）が
      // 残り、実際にはライブ接続を切っているのに「接続中」と表示され続ける。再生は分〜時間の
      // 単位で続くため、その間ずっと実態と食い違う。'disconnected' ではなく専用の 'replay' に
      // するのは、地図の切断警告（App の overlayError）を出さないため——意図して止めているものを
      // 異常として見せない。
      //
      // もうひとつは `isLoading` と `error`。ページを開いた直後（初回履歴の取得中・取得失敗直後）に
      // リプレイを始めると、その取得は cleanup で破棄され、以後この effect は早期 return するため、
      // これらを戻す経路がどこにも無くなる。地震タブは isLoading → error の順に優先して表示するので、
      // 放置すると再生した電文が「データを取得中...」や「データの取得に失敗しました」の裏に
      // 隠れたままになる。
      //
      // 同じ参照を返す分岐を挟んで、無関係な再レンダーは起こさない。
      setState(prev => (
        prev.connectionStatus === 'replay' && !prev.isLoading && !prev.error
          ? prev
          : { ...prev, connectionStatus: 'replay', isLoading: false, error: null }
      ))
      return
    }

    if (isDmdss) {
      // --- DMDSS版: APIキー未設定なら接続しない ---
      if (!dmdataApiKey) {
        setState(prev => ({ ...prev, connectionStatus: 'disconnected', isLoading: false }))
        return
      }

      // 通信へ載せられない文字（全角・日本語入力の変換途中の値など）を含むキーでも接続しない。
      // 素通しにすると Basic 認証ヘッダを組む時点で例外になり、履歴取得は英語の DOMException を
      // そのまま画面に出し、WebSocket は理由を伏せたまま永久に再接続を繰り返す。
      // 未設定と違って「入れたのに繋がらない」状態なので、理由を error に載せて画面へ出す。
      if (!isValidDmdataApiKey(dmdataApiKey)) {
        log.warn(`[data] ${DMDATA_API_KEY_INVALID_MESSAGE}`)
        setState(prev => ({
          ...prev,
          connectionStatus: 'disconnected',
          isLoading: false,
          error: DMDATA_API_KEY_INVALID_MESSAGE,
        }))
        return
      }

      setState(prev => ({ ...prev, isLoading: true, connectionStatus: 'connecting', error: null }))

      // **取れた分から順に画面へ出す。** 電文本体の取得は配信元の上限に合わせて
      // 6 秒に 1 件へ直列化されるので（→ `services/telegramBody.ts`）、控えが空の初回は
      // 全件が揃うまで数分かかる。揃うまで待つ形だと、そのあいだ地震の履歴が空のままになる。
      // **控えが埋まっている 2 回目以降は待ちが無いので、実質いままでどおり一度に出る。**
      const applyPartialQuakes = (partial: JMAQuake[]): void => {
        if (cancelled) return
        // 記録する側が重複を弾くので、部分結果ごとに呼んでよい（`rememberQuakeRetraction`）
        rememberQuakeRetractionsFromBatch(partial)
        // **base は空ではなく現在値。** 取得のあいだにライブで届いた地震を消さないため
        // （`mergeQuakeHistory` は `Control/DateTime` で同じ電文を二度数えないので、
        // 同じ部分結果を重ねて当てても結果は変わらない）。
        setState(prev => ({
          ...prev,
          earthquakes: mergeQuakeHistory(partial, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache()),
          lastUpdate: serverDate(),
        }))
        // **触るのは地震だけ。** 津波・長周期・補助情報は別経路で、ここで混ぜると
        // まだ取得していないものを「無い」として画面へ出すことになる。
        // `isLoading` も倒さない —— まだ増える途中なので、読み込み中のままが正しい。
      }

      // **履歴はアーカイブ経由で 1 本にまとめて取る。**
      //
      // かつては地震・津波・補助情報 5 本を `Promise.all` で並行に取り、どれも
      // 一覧（`/v2/telegram`）＋本体（`/v1/:id`）を 1 件ずつ叩いていた（実測で起動あたり
      // 110 件超）。**大量に取るならアーカイブを使う** —— 1 日分が 1 ファイル（実測 gzip 10KB）で、
      // 中の目録から地震・津波・帯・長周期を全部取り出せる（→ `data-sources-spec.md` §2
      // 「大量に取るならアーカイブを使う」）。
      //
      // 実装はリプレイ開始時の履歴復元と共有する（`fetchDmdataQuakeHistory`）。同じ目的の
      // 実装を 2 本持つと、片方だけがアーカイブを使う今までの形に戻る。
      fetchDmdataQuakeHistory(
        dmdataApiKey, serverDate(), MAX_HISTORY_RETAINED, HISTORY_INITIAL_DAYS, dmdataTestDelivery,
        applyPartialQuakes, () => cancelled,
      )
        .then((history) => {
          if (cancelled) return
          const quakeEvents = history.quakes
          const tsunamiEvents = history.tsunamis
          // 種別横断の生電文を eventId ごとに統合（リアルタイムと同一ロジック）。
          rememberQuakeRetractionsFromBatch(quakeEvents)
          const allTsunami = tsunamiEvents
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
          // 画面へ載せるのは最新報 1 通だけ。その報が有効期限を持たなくても、同じ津波の過去報が
          // 伝えていれば引き継ぐ（引き継がないと下の失効予約が積まれず、期限切れの津波が消えない）。
          const latestTsunami = allTsunami[0] && withInheritedTsunamiFacts(allTsunami[0], allTsunami)
          // 気象庁は予報のみになった津波に必ず期限を付ける（tsunami-spec.md §3）。それが引き継げて
          // いないなら、期限を伝えた報が取得件数の上限から押し出された疑いがある。放っておくと
          // 「消えない津波」に化けるが、画面には何の痕跡も出ないので記録だけは残す。
          if (latestTsunami && !latestTsunami.validDateTime && latestTsunami.areas.length > 0
              && latestTsunami.areas.every(a => a.grade === 'Forecast')) {
            log.warn(`[data] 予報のみの津波に有効期限が付いていません（期限を伝えた報を取得できていない可能性）: id=${latestTsunami.id}`)
          }
          const now = serverDate()
          const tsunamis = latestTsunami
            && !latestTsunami.cancelled
            && !(latestTsunami.validDateTime && new Date(latestTsunami.validDateTime) <= now)
            ? [latestTsunami] : []

          // 長周期は同じアーカイブに入っているので、拾うだけで追加の通信は要らない
          const lpgmEvents = history.extras
            .map(e => e.payload)
            .filter((p): p is { kind: 'lpgm'; data: JMALpgm } => p.kind === 'lpgm')
            .map(p => p.data)
          const lpgmByEventId = new Map<string, JMALpgm>()
          for (const lpgm of lpgmEvents) {
            if (lpgm.cancelled) continue
            const existing = lpgmByEventId.get(lpgm.eventId)
            if (!existing || lpgm.time > existing.time) {
              lpgmByEventId.set(lpgm.eventId, lpgm)
            }
          }

          if (cancelled) return
          setState(prev => ({
            ...prev,
            // **ここも base は現在値。** 空から組み直すと、履歴を取っているあいだに
            // ライブで届いた地震が最後に消える。取得が 6 秒に 1 件へ直列化されたことで
            // その窓が数分に伸びたため、取りこぼしが実際に起きうる
            // （→ `services/telegramBody.ts` の取得間隔）。
            earthquakes: mergeQuakeHistory(quakeEvents, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache()),
            tsunamis,
            lpgmByEventId,
            lastUpdate: serverDate(),
            isLoading: false,
            hasMore: history.hasMore,
            error: null,
            // **一部が読めなかったことは画面へ出す。** ここへ来るのは「全滅しなかった」
            // ときだけで、`error` は立たない。出さないと「取れた分だけのカード」が
            // 「これが最新の地震情報のすべて」に見える。
            //
            // **積まずに置き換える。** この取得は毎回「その時点の全範囲」を走査して数え直す
            // （→ `utils/telegramLoss.ts` の表）。
            historyLoss: telegramLossFrom(history.skipped, history.failedArchiveUrls),
          }))
          // 発表中の津波は画面にも見せる。**設定を尊重するかどうかは受け取る側が決める**
          // （`tsunamiPriorityDefault`）——その設定は「津波発表中はどのタブを既定にするか」を
          // 定めており、判定材料は `App` が持っている。
          if (tsunamis.length > 0) onStartupRestoreRef.current?.('tsunami')
          // **臨時情報・後発地震・解説情報はヘルパ経由で入れる。** ここで state を直書きすると、
          // 表示中の識別情報を覚える記憶（`shownNankaiEventIdRef` 等）が進まず、以後に届いた
          // 取消の照合が「表示していない」と誤判定して無条件に帯を消す。後発地震の期限タイマーも
          // `applyKohatsu` が張るので、ここで重ねて張らない。
          // **`extras` は種別ごとに振り分けてヘルパへ渡す。** 再生キューへ流す形（リプレイ側）は
          // ここでは採れない —— あちらは `silent` で音を抑えるが、こちらは音・読み上げ・通知を
          // 起こす経路（`handleEvent`）を通ることになる。
          //
          // 期限切れ・取消の判定は apply 側が持つ（取得側へ写すと片方だけ直したときに食い違う）。
          for (const e of history.extras) {
            const p = e.payload
            switch (p.kind) {
              case 'lpgm': break            // 上で `lpgmByEventId` へ入れた
              case 'nankai': applyNankai(p.data); break
              case 'nankaiCommentary': applyNankaiCommentary(p.data); break
              case 'kohatsu': applyKohatsu(p.data); break
              case 'earthquakeCount': applyEarthquakeCount(p.data); break
              case 'quakeNotice': applyQuakeNotice(p.data); break
              case 'event':
              case 'estimatedIntensity':
                // `HISTORY_EXTRA_TYPES` に入らないので届かない。**種別を足したときに
                // ここで止まるよう、既定へ落とさず名指しで書く。**
                break
              default: {
                const exhaustive: never = p
                log.warn('[data] 履歴の補助情報に未知の種別', exhaustive)
              }
            }
          }
          // 初回ロードで津波が有効（validDateTime未来）の場合、キューへ解除イベントを挿入する。
          if (tsunamis.length > 0 && latestTsunami?.validDateTime) {
            const expireTime = new Date(latestTsunami.validDateTime)
            if (expireTime > serverDate()) {
              eventQueueRef.current.push({
                eventTime: expireTime,
                payload: { kind: 'event', event: { ...latestTsunami, cancelled: true, cancelReason: 'expired' } as AppEvent },
              })
            }
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          // 記録を残すのは state と別の話。standard 版側の同じ .catch と揃える。
          // ここへ来るのはキーの形が正しい場合の失敗（ネットワーク断・401・500 等）で、
          // 画面には理由の分からないメッセージしか出ないため、手がかりを残さないと追えない。
          log.error('[data] DMDATA 履歴取得失敗', err)
          const msg = err instanceof Error ? err.message : '取得失敗'
          setState(prev => ({ ...prev, isLoading: false, error: msg }))
        })

      // **発表中の緊急地震速報を復元する。** 地震・津波の履歴とは別に走らせる —— 緊急地震速報の
      // 取得は地震ごとに詳細を辿るぶん遅くなりうるのに、いちばん早く見せたいものだから。
      // `Promise.all` へ入れると、取得の遅いこちらが地震一覧の表示まで待たせることになる。
      //
      // **音も読み上げも鳴らさない。** 開いた本人は既に揺れを体験しているので、起動直後の
      // 警報音は情報を足さずに驚かせるだけ。`silent` を立ててキューへ積むと、状態の更新と
      // 自動解除の予約（`handleEvent` が `calcEEWCancelTime` で積む）は通り、`onLiveEvent`
      // だけが呼ばれない。画面を見せる側はタブ要求として別に出す。
      void fetchDmdataActiveEews(dmdataApiKey)
        .then(eews => {
          if (cancelled || eews.length === 0) return
          for (const eew of eews) {
            eventQueueRef.current.push({
              eventTime: serverDate(),
              silent: true,
              payload: { kind: 'event', event: eew as AppEvent },
            })
          }
          log.info(`[data] 発表中の緊急地震速報を復元しました: ${eews.length} 件`)
          onStartupRestoreRef.current?.('realtime')
        })
        .catch((err: unknown) => {
          // 取得側で失敗はすべて捕まえて空配列を返すため、ここへは届かない想定。
          // 万一漏れた場合に地震・津波の履歴を巻き込まないための保険なので、素通しにせず記録を残す。
          log.error('[data] 発表中の緊急地震速報の復元で想定外の失敗', err)
        })

      // EEW の pref 補完用に細分区域名→都道府県の逆引きインデックスを先読みする。
      // インデックスは取得成功の購読で受ける。この変数は接続中に届く「すべての」EEW に使い回される
      // ため、単に .then で一度だけ埋めると、初回取得が一時的に失敗しただけでこの接続の間ずっと
      // 補完が効かない状態に固定されてしまう。購読しておけば、他の呼び出し元（地図・地震カード）の
      // 再取得が成功した時点で以降の EEW から補完が復帰する。
      // 取得できなくても EEW 自体は流す（都道府県名が付かないだけ）が、無音にはしない。
      let areaPrefIndex: Map<string, string> | null = null
      const unsubscribeStationCoords = onStationCoordsLoaded(data => {
        areaPrefIndex = buildAreaPrefIndex(data)
      })
      loadStationCoords()
        .catch(err => {
          log.warn('[data] station-coords 取得失敗（EEW 予想震度の都道府県名が補完されない。読み上げの地域順も気象庁順に並ばない）', err)
        })

      // DMDSS WebSocket 接続（dmdataTestDelivery 有効時は試験報・訓練報も受信）
      const ws = new DmdataWebSocket(dmdataApiKey, dmdataTestDelivery)
      wsRef.current = null
      ws.onEvent = (ev) => {
        if (ev.kind === 'lpgm') {
          const lpgm = ev.data
          setState(prev => {
            const next = new Map(prev.lpgmByEventId)
            if (lpgm.cancelled) next.delete(lpgm.eventId)
            else next.set(lpgm.eventId, lpgm)
            return { ...prev, lpgmByEventId: next }
          })
          if (!lpgm.cancelled && lpgm.maxClass >= 1) {
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm })
          }
        } else if (ev.kind === 'nankai') {
          const nankai = ev.data
          // キュー経路と同じ関数を通す（規則を 2 箇所に書かない。理由は `applyNankai`）。
          if (applyNankai(nankai)) {
            onLiveEventRef.current?.({ kind: 'nankai', data: nankai })
          }
        } else if (ev.kind === 'nankaiCommentary') {
          const commentary = ev.data
          if (applyNankaiCommentary(commentary)) {
            onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary })
          }
        } else if (ev.kind === 'kohatsu') {
          const kohatsu = ev.data
          if (applyKohatsu(kohatsu)) {
            onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu })
          }
        } else if (ev.kind === 'quakeNotice') {
          // 運用連絡なので音も読み上げも起こさない（帯に出すだけ）。
          applyQuakeNotice(ev.data)
        } else if (ev.kind === 'earthquakeCount') {
          const count = ev.data
          if (applyEarthquakeCount(count)) {
            onLiveEventRef.current?.({ kind: 'earthquakeCount', data: count })
          }
        } else if (ev.kind === 'estimatedIntensity') {
          const ei = ev.data
          const applied = applyEstimatedIntensity(ei, true)
          if (applied) {
            onLiveEventRef.current?.({ kind: 'estimatedIntensity', data: ei, isNew: applied.isNew })
          }
        } else {
          const data = ev.data
          const enriched = data.kind === 'eew' ? enrichEEWPref(data as EEWAlert, areaPrefIndex) : data
          enqueueEvent(enriched)
        }
      }
      ws.onStatusChange = status =>
        setState(prev => ({ ...prev, connectionStatus: status }))
      ws.onRawMessage = appendTelegramLog
      ws.connect()

      return () => {
        cancelled = true
        unsubscribeStationCoords()
        ws.disconnect()
      }
    }

    // --- 通常版: P2PQuake ---
    // 取得に入る前に読み込み中へ戻す（DMDSS 分岐と対称）。これが無いと、リプレイを「リセット」で
    // 終えた直後に地震一覧が一瞬「地震情報はありません」と出る——再生中は上の早期 return で
    // isLoading を畳んでおり、stop() が state を空にした状態でこの分岐へ入るため、未取得なのに
    // 「0 件」として表示されてしまう（EarthquakeTab は isLoading → error → 0件 の順に見る）。
    setState(prev => (prev.isLoading && !prev.error ? prev : { ...prev, isLoading: true, error: null }))
    Promise.all([
      fetchJmaQuake({ limit: MAX_HISTORY_RETAINED }),
      fetchHistory([552], 10),
    ])
      .then(([quakeEvents, tsunamiEvents]) => {
        if (cancelled) return
        // 種別横断の生電文をイベントごとに統合する（DMDSS 版・リアルタイムと同一ロジック）。
        // 以前は earthquake.time をキーにした Map で「優先度が最も高い 1 報」を選んでいたが、
        // P2PQuake の earthquake.time は分単位のため、同じ分に起きた別の地震が 1 枚に潰れていた。
        rememberQuakeRetractionsFromBatch(quakeEvents)
        const earthquakes = mergeQuakeHistory(quakeEvents, [], quakeRetractionsRef.current, getAreaPrefIndexCache())
        const allTsunami = (tsunamiEvents as JMATsunami[])
          .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        // DMDSS 側と同じ引き継ぎ。P2PQuake の 552 は有効期限を持たないため実際には何も変わらないが、
        // 経路ごとに扱いを違えない（片方だけ直すと、次に触る人がどちらが正なのか判断できない）。
        const latestTsunami = allTsunami[0] && withInheritedTsunamiFacts(allTsunami[0], allTsunami)
        const nowP2p = serverDate()
        const tsunamis = latestTsunami
          && !latestTsunami.cancelled
          && !(latestTsunami.validDateTime && new Date(latestTsunami.validDateTime) <= nowP2p)
          ? [latestTsunami] : []
        p2pRawOffsetRef.current = quakeEvents.length
        setState(prev => ({
          ...prev,
          earthquakes,
          tsunamis,
          lastUpdate: serverDate(),
          isLoading: false,
          hasMore: quakeEvents.length === MAX_HISTORY_RETAINED,
          error: null,
        }))
        // 津波の復元は **standard 版でも効く**（DMDSS 版限定なのは緊急地震速報のほうだけで、
        // P2PQuake には発表中の緊急地震速報を取る経路が無い）。
        if (tsunamis.length > 0) onStartupRestoreRef.current?.('tsunami')
        // 初回ロードで津波が有効（validDateTime未来）の場合、キューへ解除イベントを挿入する。
        // VAR-1 の副作用対応: standard 版で kyoshin リプレイのトグル時にこの effect が cleanup→
        // 再実行されるため、同一 eventId の既存 expired 予約を除去してから積む（TSU-1 と同じ排除）。
        if (tsunamis.length > 0 && latestTsunami?.validDateTime) {
          const purgeKey = latestTsunami.eventId
          eventQueueRef.current.retain(entry => {
            if (entry.payload.kind !== 'event') return true
            const ev = entry.payload.event
            if (ev.kind !== 'tsunami') return true
            const evAny = ev as JMATsunami
            if (evAny.cancelReason !== 'expired') return true
            if (purgeKey && evAny.eventId) return evAny.eventId !== purgeKey
            return evAny.id !== latestTsunami.id
          })
          const expireTime = new Date(latestTsunami.validDateTime)
          if (expireTime > serverDate()) {
            eventQueueRef.current.push({
              eventTime: expireTime,
              payload: { kind: 'event', event: { ...latestTsunami, cancelled: true, cancelReason: 'expired' } as AppEvent },
            })
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        log.error('[fetch] 初回データ取得失敗', err)
        const msg = err instanceof Error ? err.message : '取得失敗'
        setState(prev => ({ ...prev, isLoading: false, error: msg }))
      })

    const ws = new P2PQuakeWebSocket()
    wsRef.current = ws
    // P2PQuake WS の EEW（VXSE43/45 相当・内部 code=556）は areas 補完のみに使用し、音・タブ切替は発火させない。
    // Yahoo hypoInfo で検出済みの eventId であれば areas を注入、未知なら全処理（フォールバック）。
    ws.onEvent = (event: AppEvent) => {
      if (event.kind === 'eew') {
        if (event.test) return
        const eew = event as EEWAlert
        // この key はそのまま台帳（`acceptedEewSerialRef`）のキーになる。式を書き写すと
        // 導出が変わったときに片方だけ追従し、台帳と状態のキーが割れる。
        const key = eewEventKey(eew)
        if (event.cancelled) {
          // Yahoo が検出する前に誤報取消された場合は hypoInfo 消滅イベントが来ない。
          // activeEEWs に残っていれば解除処理を通す。
          if (stateRef.current.activeEEWs.has(key)) {
            enqueueEvent(event)
          }
          return
        }
        if (stateRef.current.activeEEWs.has(key)) {
          enrichEEW(key, eew)
        } else {
          enqueueEvent(event)  // フォールバック: Yahoo が未検出のEEW
        }
        return
      }
      enqueueEvent(event)
    }
    ws.onStatusChange = status =>
      setState(prev => ({ ...prev, connectionStatus: status }))
    ws.onRawMessage = appendTelegramLog
    ws.connect()

    return () => {
      cancelled = true
      ws.disconnect()
    }
  }, [handleEvent, enqueueEvent, appendTelegramLog, dmdataApiKey, dmdataTestDelivery, replayTimeOffset])

  const loadMoreEarthquakes = useCallback(async () => {
    if (stateRef.current.isLoadingMore || !stateRef.current.hasMore) return
    // **この取得が「まだ有効か」を測る物差し。**
    // 電文本体の取得は最長で数分かかる（→ `services/telegramBody.ts` の取得間隔）。そのあいだに
    // リプレイが始まる・接続が張り直されると、届いた電文は**別の時間軸の一覧**へ流し込まれる。
    // 接続 effect の `cancelled` はそちらのスコープに閉じていて、ここからは触れないので、
    // 作り直しのたびに進む世代の番号で見分ける。
    const generation = liveGenerationRef.current
    const stale = () => liveGenerationRef.current !== generation
    // **失敗したら伸ばした日数を戻す。** 戻さないと、一過性の失敗で飛ばした 1 週間ぶんの
    // 履歴が二度と読まれない（次に押したときはさらに古い範囲を読むため）。
    //
    // **ただし戻すのは自分の世代のときだけ**（下の catch）。接続を張り直す effect は
    // `liveGenerationRef` を進めるのと同じ同期ブロックで `historyDaysRef` を初期値へ戻すので、
    // 世代が変わった後に無条件で書き戻すと**そのリセットを踏み潰す**。症状は
    // 「キーを差し替えた直後の 1 回目のクリックだけ、旧世代の広い範囲を読み直す」で、
    // 画面には何も出ない（このセッションで避けたいのは、まさに余計なリクエスト）。
    const daysBeforeThisClick = historyDaysRef.current
    setState(prev => ({ ...prev, isLoadingMore: true }))
    try {
      if (isDmdss) {
        const apiKey = dmdataApiKeyRef.current
        const existingQuakes = stateRef.current.earthquakes
        // 初回と同じ理由で逐次に反映する。**控えが空のうちは 1 件 6 秒**なので、
        // 揃うまで待つ形だと押してから数分ボタンが無反応に見える。
        const applyPartialMore = (partial: JMAQuake[]): void => {
          if (stale()) return
          rememberQuakeRetractionsFromBatch(partial)
          setState(prev => ({
            ...prev,
            earthquakes: mergeQuakeHistory(partial, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache()),
          }))
        }
        // **目標件数を増やして呼び直す。** カーソルは使わない —— アーカイブ経由は件数基準で
        // 遡る作りで、**読んだ日はキャッシュに残る**ので追加の通信は新しい日のぶんだけ。
        const target = existingQuakes.length + LOAD_MORE_BATCH
        // **日数も伸ばす。** 件数だけ増やしても、在庫を読み切った日より前へは進めない。
        //
        // **上限で頭を打つ。** 越えた日数を渡すと当日経路の日付列挙が投げる
        // （→ `MAX_HISTORY_DAYS`）。押すたびに同じ例外を投げるボタンを残さないため、
        // 越えないところで止め、下で `hasMore` を偽にする。
        historyDaysRef.current = Math.min(historyDaysRef.current + HISTORY_MORE_DAYS, MAX_HISTORY_DAYS)
        const history = await fetchDmdataQuakeHistory(
          apiKey, serverDate(), target, historyDaysRef.current, dmdataTestDeliveryRef.current,
          applyPartialMore, stale,
        )
        // 時間軸が変わっていたら、取れた分ごと捨てる（「取得中」の解除は finally が担う）
        if (stale()) return
        const events = history.quakes
        // 既存カード群を base に、新バッチの生電文を eventId ごとに統合する。
        // これによりバッチ跨ぎ（先に届いた VXSE61 単独カードへ後続の VXSE53 の震度を合流など）も
        // リアルタイムと同一結果になる。
        // 台帳への記録は setState の外で行う（更新関数は再実行されうるため副作用を持たせない）。
        rememberQuakeRetractionsFromBatch(events)
        // 長周期は同じアーカイブに入っているので、拾うだけで追加の通信は要らない
        const lpgmEvents = history.extras
          .map(e => e.payload)
          .filter((p): p is { kind: 'lpgm'; data: JMALpgm } => p.kind === 'lpgm')
          .map(p => p.data)
        setState(prev => {
          const lpgmByEventId = new Map(prev.lpgmByEventId)
          for (const lpgm of lpgmEvents) {
            if (lpgm.cancelled) continue
            const existing = lpgmByEventId.get(lpgm.eventId)
            if (!existing || lpgm.time > existing.time) lpgmByEventId.set(lpgm.eventId, lpgm)
          }
          const merged = mergeQuakeHistory(events, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache())
          return {
            ...prev,
            earthquakes: merged,
            lpgmByEventId,
            // 初回ロードと同じく置き換える。**ここが積む形だと 2 つの症状が出る** ——
            // ①恒久的に壊れた 1 通を押した回数だけ数える（解析の失敗は控えないので毎回数える）
            // ②アーカイブの取得が回復しても損失が消えない（失敗した取得は `archiveCache` から
            // 外れて再試行され、429 なら普通に回復する）。範囲は伸びるだけで縮まないので、
            // 今回の結果は前回の範囲を包含する。
            historyLoss: telegramLossFrom(history.skipped, history.failedArchiveUrls),
            // 押し直せば回復しうる側の表示は、成功したので消す
            loadMoreFailed: false,
            // **打ち切るのは「これ以上遡れない」ときだけ。** 増えたかどうかでは判定しない ——
            // 1 週間まるごと震度1以上の地震が無いことは普通に起きるが、それは
            // 「もっと古い在庫が無い」ことを何も意味しない（実測でアーカイブの目録は
            // 135 日以上さかのぼれた）。増えなかったら止める作りにしていた頃は、
            // 静かな 1 週間に当たった時点で以後の遡りが永久に塞がっていた。
            hasMore: history.hasMore && historyDaysRef.current < MAX_HISTORY_DAYS,
          }
        })
      } else {
        const offset = p2pRawOffsetRef.current
        const events = await fetchJmaQuake({ limit: LOAD_MORE_BATCH, offset })
        p2pRawOffsetRef.current += events.length
        // 既存カード群を base に新バッチを統合する（DMDSS 版と同じ扱い）。
        // バッチ跨ぎで同一イベントの続報が届いた場合もリアルタイムと同一結果になる。
        // 台帳への記録は setState の外で行う（理由は DMDSS 版側と同じ）。
        rememberQuakeRetractionsFromBatch(events)
        setState(prev => ({
          ...prev,
          earthquakes: mergeQuakeHistory(events, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache()),
          hasMore: events.length === LOAD_MORE_BATCH,
          // 成功したので、押し直せば回復しうる側の表示は消す（DMDSS 版と揃える）
          loadMoreFailed: false,
        }))
      }
    } catch (err) {
      // **時間軸が変わった後の失敗は「失敗」として記録しない。** 結果ごと捨てる取得なので、
      // 誰も困っていない。理由が本物なら新しい世代が同じ理由で失敗して、そちらが記録する。
      // 巻き戻しを見送るのと同じ基準で揃える（片方だけガードすると、記録だけが残って
      // 「失敗したのに遡り幅が戻っていない」と読める）。痕跡は詳細ログへ落とす。
      if (stale()) {
        log.debug('[data] 古い世代の追加読み込みが失敗（結果は破棄）', err)
        return
      }
      // 追加読み込みの失敗は画面では「増えなかった」だけに見える（初回ロード用の error state は
      // 触らない）。ユーザーが再度押せる状態に戻すだけなので、理由はログに残す。
      log.error('[data] 地震履歴の追加読み込みに失敗', err)
      historyDaysRef.current = daysBeforeThisClick
      // **画面にも出す。** 出さないと「押したのに何も起きない」だけに見え、もう一度押せば
      // 直るのか、これ以上遡れないのかが分からない。遡り幅は上で戻したので押し直せる。
      setState(prev => ({ ...prev, loadMoreFailed: true }))
    } finally {
      // **「取得中」の解除は抜け道を作らず、必ずここで行う。**
      // 成功パスの `setState` の中に混ぜていた頃は、`stale()` での早期 return だけが解除を
      // 通らなかった。冒頭のガード（`isLoadingMore` なら何もしない）と噛み合って、
      // **押してから API キーを変えた・リプレイを始めただけでボタンがリロードまで死ぬ**。
      // 画面には「取得中…」のまま押せないボタンが残るだけで、例外もログも出ない。
      setState(prev => (prev.isLoadingMore ? { ...prev, isLoadingMore: false } : prev))
    }
  }, [])

  const simulateEarthquake = useCallback(async () => {
    const { createTestEarthquake, createTestLpgm } = await loadTestData()
    // points の形状・情報種別は経路で異なる（DMDATA は観測点が pref 空＋都道府県ロールアップ、
    // P2PQuake は観測点に pref が入る）。バリアントに合わせて実電文の形を再現する。
    const quake = createTestEarthquake(isDmdss)
    handleEvent(quake)
    // VAR-2: 長周期地震動観測情報（VXSE62）は DMDATA 経由でのみ配信される。standard 版で
    // 「地震テスト」ボタンから LPGM を注入すると、実データでは絶対に届かないバッジ表示が
    // テストで出て混乱するため isDmdss のときだけ LPGM を注入する。
    const eventId = extractQuakeEventId(quake)
    if (eventId && isDmdss) {
      const lpgm = createTestLpgm(eventId)
      setState(prev => ({ ...prev, lpgmByEventId: new Map(prev.lpgmByEventId).set(eventId, lpgm) }))
      onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm })
    }
  }, [handleEvent])

  /**
   * 津波の続報で区域ごとに等級が動くテスト（一部解除・一部引き上げ）。
   *
   * 発表 → `TEST_AUTO_DISMISS_MS` の半分で続報 → 満了で解除、と 3 段で進む。**続報を挟むのが
   * 要点** —— 「〇〇から切り替え」の印は前報との比較（`areaGradeChangedKeys`）で立つので、
   * 1 通だけ流しても出ない。全体の最上位等級は大津波警報のまま動かないため、区域単位の
   * 変化を見る経路（→ docs/spec/tsunami-spec.md §10）はここでしか通らない。
   *
   * **DMDSS 版のみ。** 前回の等級（`LastKind`）は P2PQuake が配信しない。
   */
  const simulateTsunamiGradeChange = useCallback(async () => {
    const { createTestTsunami, createTestTsunamiGradeChange, TEST_AUTO_DISMISS_MS } = await loadTestData()
    const base = createTestTsunami(isDmdss)
    if (testTsunamiGradeChangeTimerRef.current !== undefined) {
      window.clearTimeout(testTsunamiGradeChangeTimerRef.current)
    }
    runSimulateTsunami(() => base, TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent)
    // 解除の待ちは `runSimulateTsunami` が張っている。続報はその手前へ差し込む。
    //
    // **待ちは ref で追う。** アンマウントとリセット（リプレイの開始・停止）で落とせるようにする
    // —— 追えないと、画面を消した後や再生へ切り替えた後に 45 秒前の続報だけが単独で届き、
    // 消えたはずの津波カードが復活する。しかもこの経路は `handleEvent` を直接呼ぶので、
    // キューを空にしても止まらない。
    testTsunamiGradeChangeTimerRef.current = window.setTimeout(() => {
      testTsunamiGradeChangeTimerRef.current = undefined
      // 解除が先に走った後は流さない（ボタンを押し直したときに古い続報が紛れ込む）
      if (testTsunamiRef.current?.tsunami.id !== base.id) return
      handleEvent(createTestTsunamiGradeChange(base))
    }, TEST_AUTO_DISMISS_MS / 2)
  }, [handleEvent])

  /**
   * 訓練報のテスト。
   *
   * 気象庁は訓練・試験の電文をヘッダ（`Control/Status`）でだけ区別し、中身は本物と同じ形で
   * 流す。アプリは**あえて画面へ通し**（`test: false`）、代わりに「訓練報」の印を出して
   * 見分けられるようにしている（→ docs/spec/quake-spec.md §5「電文の運用種別」）。
   *
   * **その印を出す手段がこれしかない。** 実配信の訓練報は事前に予告されて流れるもので、
   * こちらの都合では受け取れない。印が出るかどうかを実機で確かめられる唯一の入口になる。
   */
  const simulateTrainingQuake = useCallback(async () => {
    const { createTestEarthquake } = await loadTestData()
    handleEvent(createTestEarthquake(isDmdss, '訓練'))
  }, [handleEvent])

  /**
   * 訂正報のテスト。**初報を先に出し、少し置いてから訂正報を流す。**
   *
   * 訂正報は前の報を直すもので、単独では届かない。1 通だけ流すと「訂正」の印は出せても
   * **何が訂正されたのかが画面に出ない**ので、規模が変わる前後を続けて流す
   * （初報 M7.4 → 訂正報 M7.6。実電文の値は → `createTestQuakeAmendment`）。
   *
   * **受信と同じ経路（イベントキュー）へ積む**ので、同一性の判定も続報のマージも実運用と
   * 同じところを踏む。待ちをキューに持たせているため、リセット（リプレイの開始・停止）で
   * 一緒に落ちる —— `handleEvent` を直接呼ぶ津波・EEW のテストと違い、`clearTestSimulationTimers`
   * へ足す必要は無い（→ docs/spec/settings-pwa-spec.md §7「待ちはリセットとアンマウントで落とす」）。
   */
  const simulateQuakeAmendment = useCallback(async () => {
    const { createTestQuakeAmendment } = await loadTestData()
    const { initial, amended } = createTestQuakeAmendment(isDmdss)
    // 放出の時刻は電文の発表時刻そのものを使う（間隔の決め方はテストデータ側に閉じる）。
    eventQueueRef.current.push({ eventTime: new Date(initial.time), payload: { kind: 'event', event: initial } })
    eventQueueRef.current.push({ eventTime: new Date(amended.time), payload: { kind: 'event', event: amended } })
  }, [])

  /**
   * 種別が前後して届く報のテスト。**5 通を順に流す。**
   *
   * 気象庁は同じ地震について種別の違う電文を前後して発表する（震度速報 → 震源情報 →
   * 震度速報 → 震源・震度情報）。3 通目で見出しが「震度速報#2/震源情報」になり、4 通目で
   * 速報段階が畳まれる（→ docs/spec/quake-spec.md §8「見出しには受け取った種別を並べる」）。
   * **その見え方を実機で確かめられる入口がここしかない。**
   *
   * **5 通目は観測点・市町村だけが増える続報。** 区域の最大震度が据え置きのまま観測点が
   * 遅れて入電する形で、読み上げが「観測地点が追加されましたが、地域ごとの最大震度は
   * 変わっていません。」と読むところを確かめられる（→ `createTestQuakeReportSequence`）。
   *
   * **受信と同じ経路（イベントキュー）へ積む**ので、同一性の判定も続報のマージも実運用と
   * 同じところを踏む。待ちをキューに持たせているため、リセット（リプレイの開始・停止）で
   * 一緒に落ちる（理由は → `simulateQuakeAmendment`）。
   */
  const simulateQuakeReportSequence = useCallback(async () => {
    const { createTestQuakeReportSequence } = await loadTestData()
    for (const report of createTestQuakeReportSequence(isDmdss)) {
      eventQueueRef.current.push({ eventTime: new Date(report.time), payload: { kind: 'event', event: report } })
    }
  }, [])

  /**
   * 市町村の未入電を含む地震情報のテスト（日向灘 2022-01-22）。
   *
   * 「地震テスト」（能登本震）では**市町村の未入電が 1 件も出ない** —— 発表条件が
   * 「配下に未入電の観測点があり、かつ市町村の最大震度が震度4以下（又は入電なし）」で、
   * 能登本震の未入電 3 地点が属する市町村はいずれも震度6強・6弱のため当たらない
   * （→ docs/spec/quake-spec.md §5「市町村の震度」）。
   *
   * **DMDSS 版のみ。** 市町村の粒度は DMDATA 経路でしか配信されない。
   */
  const simulateUnreceivedQuake = useCallback(async () => {
    const { createTestUnreceivedQuake } = await loadTestData()
    handleEvent(createTestUnreceivedQuake())
  }, [handleEvent])

  /**
   * 最大震度に「以上」が付く地震情報のテスト（石川県西方沖 2024-11-26）。
   *
   * **他の地震テストでは出ない形。** 未入電の観測点は下限の 45（5弱）へ寄せてあるので、
   * 電文全体の最大震度が 45 の地震でだけ階級が一致し、カードの最大震度が「5弱以上」になる
   * （→ docs/spec/quake-spec.md §4「震度5弱以上未入電」）。地震テスト（能登本震・震度7）と
   * 未入電テスト（日向灘・震度5強）はどちらも階級が一致しないため、この形を持たない。
   *
   * **DMDSS 版のみ。** 未入電は DMDATA 経路でしか配信されない。
   */
  const simulateMaxScaleOrAboveQuake = useCallback(async () => {
    const { createTestMaxScaleOrAboveQuake } = await loadTestData()
    handleEvent(createTestMaxScaleOrAboveQuake())
  }, [handleEvent])

  /**
   * 推計震度分布図のテスト。**地震情報を先に出し、少し置いてから分布を流す。**
   *
   * 実運用では地震から数分後に届くもので、そのころ地震カードは既に画面にある。
   * 同時に流すと、分布モードを開く側がカードを見つけられない（引き当ては発現時刻だが、
   * 探す先の一覧にまだ載っていない）。**受信と同じ経路（イベントキュー）へ積む**ので、
   * 取り違え防止の分岐も自動オープンも実運用と同じところを踏む。
   */
  const simulateEstimatedIntensity = useCallback(async () => {
    const { createTestEstimatedIntensity } = await loadTestData()
    const { quake, estimated, followUp, quakeFollowUp } = createTestEstimatedIntensity()
    const now = serverDate()
    eventQueueRef.current.push({ eventTime: now, payload: { kind: 'event', event: quake } })
    eventQueueRef.current.push({
      eventTime: new Date(now.getTime() + TEST_ESTIMATED_INTENSITY_DELAY_MS),
      payload: { kind: 'estimatedIntensity', data: estimated },
    })
    // **続報も流す。** 読み上げの「受信しました」／「更新されました」の言い分けは、続報が
    // 届かないと実機で一度も聞けない。**新しいタイマーは足さない** —— キューへ積むだけなので、
    // リプレイ開始・リセットの `eventQueueRef.current.clear()` でそのまま落ちる。
    eventQueueRef.current.push({
      eventTime: new Date(now.getTime() + TEST_ESTIMATED_INTENSITY_DELAY_MS + TEST_ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS),
      payload: { kind: 'estimatedIntensity', data: followUp },
    })
    // **地震情報の続報も流す。** 分布が届いたあとに同じ地震の地震情報を受けると、地図は
    // 分布モードを閉じて発表値へ戻る（→ `utils/quakeOverlay.ts` の
    // `closeDistributionOverlayOnQuakeReport`）。流さないとその遷移を実機で確かめられない。
    eventQueueRef.current.push({
      eventTime: new Date(
        now.getTime() + TEST_ESTIMATED_INTENSITY_DELAY_MS + TEST_ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS
        + TEST_ESTIMATED_INTENSITY_QUAKE_FOLLOW_UP_DELAY_MS,
      ),
      payload: { kind: 'event', event: quakeFollowUp },
    })
  }, [])

  const simulateForeignQuake = useCallback(async () => {
    const { createTestForeignQuake } = await loadTestData()
    // 付加文（気象庁の固定付加文・自由付加文の原文）は DMDATA 経由でのみ配信される。standard 版では
    // 実データで届かないため含めない（LPGM を isDmdss 限定にしているのと同じ理由）。
    handleEvent(createTestForeignQuake(isDmdss))
  }, [handleEvent])

  const simulateForeignQuakeHuge = useCallback(async () => {
    const { createTestForeignQuakeHuge } = await loadTestData()
    handleEvent(createTestForeignQuakeHuge(isDmdss))
  }, [handleEvent])

  // EEW のテストデータもバリアントを渡す。**standard 版で押せるボタンが DMDATA 経路にしか
  // 無い項目を画面へ出さないため** —— 震源要素の精度・内陸/海域・短縮名・固定付加文・
  // 最大予測値の変化・長周期地震動階級は、P2PQuake も Yahoo hypoInfo も配信しない。
  const simulateEEW = useCallback(async () => {
    const { createTestEEW } = await loadTestData()
    runSimulateEEW('special', (e, s, b) => createTestEEW(isDmdss, e, s, b), EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent)
  }, [handleEvent])

  const simulateEEWWarning = useCallback(async () => {
    const { createTestEEWWarning } = await loadTestData()
    runSimulateEEW('warning', (e, s, b) => createTestEEWWarning(isDmdss, e, s, b), EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent)
  }, [handleEvent])

  const simulateEEWForecast = useCallback(async () => {
    const { createTestEEWForecast } = await loadTestData()
    runSimulateEEW('forecast', (e, s, b) => createTestEEWForecast(isDmdss, e, s, b), EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent)
  }, [handleEvent])

  const simulateEEWAssumed = useCallback(async () => {
    const { createTestEEWAssumed } = await loadTestData()
    runSimulateEEW('assumed', (e, s, b) => createTestEEWAssumed(isDmdss, e, s, b), EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent)
  }, [handleEvent])

  const simulateEEWDeep = useCallback(async () => {
    const { createTestEEWDeep } = await loadTestData()
    runSimulateEEW('deep', (e, s, b) => createTestEEWDeep(isDmdss, e, s, b), EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent)
  }, [handleEvent])

  const simulateEEWRetraction = useCallback(async () => {
    const { createTestEEWWarning } = await loadTestData()
    runSimulateEEWRetraction((e, s, b) => createTestEEWWarning(isDmdss, e, s, b), EEW_RETRACTION_CANCEL_MS, testEEWRetractionRef, handleEvent)
  }, [handleEvent])

  const simulateTsunami = useCallback(async () => {
    const { createTestTsunami, TEST_AUTO_DISMISS_MS } = await loadTestData()
    runSimulateTsunami(() => createTestTsunami(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent)
  }, [handleEvent])

  const simulateTsunamiWarning = useCallback(async () => {
    const { createTestTsunamiWarning, TEST_AUTO_DISMISS_MS } = await loadTestData()
    runSimulateTsunami(() => createTestTsunamiWarning(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent)
  }, [handleEvent])

  const simulateTsunamiWatch = useCallback(async () => {
    const { createTestTsunamiWatch, TEST_AUTO_DISMISS_MS } = await loadTestData()
    runSimulateTsunami(() => createTestTsunamiWatch(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent)
  }, [handleEvent])

  // 予報のみは DMDSS の実運用では ValidDateTime の期限切れで静かに消える（明示的な解除電文を
  // 伴わない）ため、DMDSS では runSimulateTsunami（明示的キャンセル）を使わず期限切れ経路に任せる。
  // standard 版（P2PQuake）は validDateTime を持たないため、実運用と同じく解除電文で消す。
  const simulateTsunamiForecast = useCallback(async () => {
    const { createTestTsunamiForecast, TEST_AUTO_DISMISS_MS } = await loadTestData()
    if (!isDmdss) {
      runSimulateTsunami(() => createTestTsunamiForecast(false), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent)
      return
    }
    if (testTsunamiRef.current) {
      window.clearTimeout(testTsunamiRef.current.cancelTimer)
      testTsunamiRef.current = null
    }
    handleEvent(createTestTsunamiForecast(true))
  }, [handleEvent])

  const simulateTsunamiRetraction = useCallback(async () => {
    const { createTestTsunamiRetraction, TEST_AUTO_DISMISS_MS } = await loadTestData()
    runSimulateTsunami(() => createTestTsunamiRetraction(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent, 'retracted')
  }, [handleEvent])

  const simulateNankai = useCallback(async (kindName: '調査中' | '巨大地震注意' | '巨大地震警戒') => {
    const { createTestNankai } = await loadTestData()
    // **受信と同じ関数を通す。** state を直書きすると、表示中の識別情報を覚える ref が進まず、
    // 直後に取消テストを走らせたときの照合が実運用と食い違う。
    const nankai = createTestNankai(kindName)
    if (applyNankai(nankai)) {
      onLiveEventRef.current?.({ kind: 'nankai', data: nankai })
    }
  }, [applyNankai])

  /**
   * 南海トラフ臨時情報の取消テスト。発表を出し、`TEST_AUTO_DISMISS_MS` 後に**同じ `eventId` の
   * 取消**を流す（取消は対象の情報単位を指すため。`createTestNankaiRetraction`）。
   *
   * **受信と同じ経路（イベントキュー）へ積む。** 上の `simulateNankai` のように state を直接
   * 書き換えると、取消の照合（`eventId` の一致確認）を一度も通らないテストになる ―― 実運用で
   * 効く分岐を踏まないテストボタンは、あってもこの穴を見つけられない。
   */
  const simulateNankaiRetraction = useCallback(async () => {
    const { createTestNankai, createTestNankaiRetraction, TEST_AUTO_DISMISS_MS } = await loadTestData()
    if (testNankaiRetractionTimerRef.current !== undefined) {
      window.clearTimeout(testNankaiRetractionTimerRef.current)
    }
    const nankai = createTestNankai('巨大地震注意')
    const retraction = createTestNankaiRetraction(nankai)
    eventQueueRef.current.push({ eventTime: serverDate(), payload: { kind: 'nankai', data: nankai } })
    testNankaiRetractionTimerRef.current = window.setTimeout(() => {
      testNankaiRetractionTimerRef.current = undefined
      eventQueueRef.current.push({ eventTime: serverDate(), payload: { kind: 'nankai', data: retraction } })
    }, TEST_AUTO_DISMISS_MS)
  }, [])

  const simulateNankaiCommentary = useCallback(async (serialName: '臨時解説' | '定例解説') => {
    const { createTestNankaiCommentary } = await loadTestData()
    const commentary = createTestNankaiCommentary(serialName)
    if (applyNankaiCommentary(commentary)) {
      onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary })
    }
  }, [applyNankaiCommentary])

  const simulateKohatsu = useCallback(async () => {
    const { createTestKohatsu } = await loadTestData()
    // 受信と同じ関数を通す（理由は `simulateNankai` に同じ）。期限タイマーもそちらが張る。
    const kohatsu = createTestKohatsu()
    if (applyKohatsu(kohatsu)) {
      onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu })
    }
  }, [applyKohatsu])

  const simulateQuakeNotice = useCallback(async () => {
    const { createTestQuakeNotice } = await loadTestData()
    // 受信と同じ関数を通す（理由は `simulateNankai` に同じ）。期限タイマーもそちらが張る。
    const notice = createTestQuakeNotice()
    applyQuakeNotice(notice)
  }, [applyQuakeNotice])

  /**
   * 地震回数に関する情報のテスト。
   *
   * **`onLiveEvent` へも流す。** 帯だけの VZSE40 と違い、こちらは通知音と読み上げを起こす
   * （群発の総数は他のどの経路でも伝わらない）。実運用の分岐と同じところを踏ませる。
   */
  const simulateEarthquakeCount = useCallback(async () => {
    const { createTestEarthquakeCount } = await loadTestData()
    const count = createTestEarthquakeCount()
    if (applyEarthquakeCount(count)) {
      onLiveEventRef.current?.({ kind: 'earthquakeCount', data: count })
    }
  }, [applyEarthquakeCount])

  /**
   * 地震回数に関する情報の取消テスト。発表を出し、`TEST_AUTO_DISMISS_MS` 後に**同じ `eventId` の
   * 取消**を流す（照合は `eventId`。`applyEarthquakeCount`）。
   *
   * **取消の理由が届く先はこの種別だけ読み上げしかない** —— 帯ごと消えるのでカードに残せない。
   * ボタンが無いと、その文が一度も声にならないまま気づけない。
   *
   * 受信と同じ経路（イベントキュー）へ積む理由は `simulateNankaiRetraction` に同じ。
   */
  const simulateEarthquakeCountRetraction = useCallback(async () => {
    const { createTestEarthquakeCount, createTestEarthquakeCountRetraction, TEST_AUTO_DISMISS_MS } = await loadTestData()
    if (testEarthquakeCountRetractionTimerRef.current !== undefined) {
      window.clearTimeout(testEarthquakeCountRetractionTimerRef.current)
    }
    const count = createTestEarthquakeCount()
    const retraction = createTestEarthquakeCountRetraction(count)
    eventQueueRef.current.push({ eventTime: serverDate(), payload: { kind: 'earthquakeCount', data: count } })
    testEarthquakeCountRetractionTimerRef.current = window.setTimeout(() => {
      testEarthquakeCountRetractionTimerRef.current = undefined
      eventQueueRef.current.push({ eventTime: serverDate(), payload: { kind: 'earthquakeCount', data: retraction } })
    }, TEST_AUTO_DISMISS_MS)
  }, [])

  const resetState = useCallback(() => {
    // 台帳もここで空にする。掃除の `useEffect` に任せると、リセットから次のコミットまでの間に
    // 同じ eventId の報が届いたとき、消えたはずの報番号と比べて誤って捨てうる。
    acceptedEewSerialRef.current.clear()
    // 取消の台帳も空にする。リプレイの開始・リセットで時間軸が変わるため、前の軸で見た取消の
    // 発表時刻と新しい軸の報を比べると、正常な報を取り下げ済みと誤判定する。
    quakeRetractionsRef.current = []
    // 帯を消すので、表示中の識別情報の記憶も落とす（残すと、次に届いた取消の照合が
    // 消えた帯の識別情報と比べられる）。取消テストの待ちも落とす ―― リプレイへ切り替えた後で
    // テスト用の取消がキューへ紛れ込むのを防ぐ。
    shownNankaiEventIdRef.current = null
    shownKohatsuEventIdRef.current = null
    shownCommentaryIdRef.current = null
    shownQuakeNoticeIdRef.current = null
    shownEarthquakeCountEventIdRef.current = null
    shownEstimatedIntensityRef.current = null
    // 分布を伝えた地震の台帳も空にする。リプレイの開始・リセットで時間軸が変わるため、前の軸で
    // 伝えた分布を「もう伝えた」と数えると、新しい軸の初報が「更新されました」と読まれる。
    shownEstimatedIntensityArrivalsRef.current = []
    clearTestSimulationTimers()
    setState(prev => ({
      ...prev,
      earthquakes: [],
      tsunamis: [],
      activeEEWs: new Map(),
      lpgmByEventId: new Map(),
      nankai: null,
      nankaiCommentary: null,
      kohatsu: null,
      quakeNotice: null,
      earthquakeCount: null,
      estimatedIntensity: null,
      // 「最終更新」も落とす。残すと、リプレイ開始直後（まだ 1 件も処理していない間）に
      // 地図の更新時刻へ**リプレイ前のライブ受信時刻**が出たままになる。
      lastUpdate: null,
      // 「もっと見る」を畳む。カードを空にしても hasMore を残すと、リプレイ中にボタンが出たまま
      // になり、押すと `loadMoreEarthquakes` が**ライブの最新履歴**を取りに行って、再生時刻より
      // 未来の地震がカードに並ぶ。ライブへ戻る側は履歴の取得完了時に立て直すので落としてよい。
      hasMore: false,
      // 履歴の損失も落とす。**再生中はリプレイ側が自分の損失を出す**ので、ライブで欠けた分を
      // 残すと同じ画面に 2 つの損失が並び、どちらの話か読めない。ライブへ戻る側は履歴の取得
      // 完了時に立て直すので落としてよい（`hasMore` と同じ理由）。
      historyLoss: createEmptyTelegramLoss(),
      loadMoreFailed: false,
    }))
    eventQueueRef.current.clear()
    quakeIntensityCacheRef.current.clear()
    // 後発地震注意情報の7日タイマーもリセット対象。resetState 後に古いタイマーが残ると、
    // リプレイモード切替→ライブ復帰後に発火して新しく設定された kohatsu を null に上書きしうる。
    if (kohatsuExpireTimerRef.current !== undefined) {
      window.clearTimeout(kohatsuExpireTimerRef.current)
      kohatsuExpireTimerRef.current = undefined
    }
    // 解説情報の7日タイマーも同じ理由でリセットする
    if (nankaiCommentaryExpireTimerRef.current !== undefined) {
      window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
      nankaiCommentaryExpireTimerRef.current = undefined
    }
    // 地震・津波に関するお知らせ（VZSE40）・地震回数（VXSE60）の7日タイマーも同じ
    if (quakeNoticeExpireTimerRef.current !== undefined) {
      window.clearTimeout(quakeNoticeExpireTimerRef.current)
      quakeNoticeExpireTimerRef.current = undefined
    }
    if (earthquakeCountExpireTimerRef.current !== undefined) {
      window.clearTimeout(earthquakeCountExpireTimerRef.current)
      earthquakeCountExpireTimerRef.current = undefined
    }
  }, [clearTestSimulationTimers])

  /**
   * リプレイ開始時に、指定時刻より前の地震カードを一覧へ流し込む（音・読み上げは経由しない）。
   *
   * 統合を `mergeQuakeHistory` に任せるのはライブの履歴取得・「もっと見る」と同じ理由で、
   * 経路ごとに畳み込み方が分かれると同じ電文から違うカードができる。既存のカードを base に
   * 置くのは、この復元が pre-window の注入や本編の再生より後に完了しうるため
   *（先に出来ていたカードを消さず、同じイベントなら統合する）。
   */
  const restoreQuakeHistory = useCallback((quakes: JMAQuake[]) => {
    if (quakes.length === 0) return
    rememberQuakeRetractionsFromBatch(quakes)
    setState(prev => ({ ...prev, earthquakes: mergeQuakeHistory(quakes, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache()) }))
  }, [])

  const loadReplayEvents = useCallback((entries: import('../types/replay').ReplayEntry[]) => {
    for (const { payload, replayTime, silent } of entries) {
      eventQueueRef.current.push({ eventTime: replayTime, payload, silent })
    }
  }, [])

  return {
    ...state,
    injectEvent: handleEvent,
    loadMoreEarthquakes,
    clearTelegramLog,
    simulateEarthquake,
    simulateForeignQuake,
    simulateForeignQuakeHuge,
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWAssumed, simulateEEWDeep, simulateEEWRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateNankaiRetraction, simulateNankaiCommentary, simulateKohatsu,
    simulateQuakeNotice, simulateEarthquakeCount, simulateEarthquakeCountRetraction, simulateEstimatedIntensity,
    simulateTrainingQuake, simulateUnreceivedQuake, simulateMaxScaleOrAboveQuake, simulateTsunamiGradeChange, simulateQuakeAmendment,
    simulateQuakeReportSequence,
    resetState,
    loadReplayEvents,
    restoreQuakeHistory,
  }
}
