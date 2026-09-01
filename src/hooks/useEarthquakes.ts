import { useState, useEffect, useRef, useCallback } from 'react'
import { useLazyRef } from './useLazyRef'
import type { JMAQuake, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu, EEWAlert, IntensityScale, EarthquakePoint, AppEvent, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { fetchHistory, fetchJmaQuake, P2PQuakeWebSocket } from '../services/p2pquake'
import { DmdataWebSocket, fetchDmdataEarthquakes, fetchDmdataTsunamis, fetchDmdataLpgms, fetchDmdataNankai, fetchDmdataNankaiCommentary, fetchDmdataKohatsu } from '../services/dmdata'
import { mergeQuakeInto, mergeQuakeHistory, sameQuakeEntry, sortQuakes, extractQuakeEventId, quakeEventKey, coalesceByEventId, findExistingQuakeCard, isRetractedQuakeReport, quakeRetractionOf } from '../utils/quakeMerge'
import type { QuakeRetraction } from '../utils/quakeMerge'
import { loadStationCoords, onStationCoordsLoaded, buildAreaPrefIndex } from '../utils/stationCoords'
import { calcEEWCancelTime, eewSerial, eewEventKey } from '../utils/eew'
import { mergeTsunamiObservations, isCancelForCurrentTsunami, isTsunamiContinuation, withInheritedValidDateTime, latestValidDateTime } from '../utils/tsunami'
import { log } from '../utils/logger'
import { serverNow, serverDate } from '../utils/clock'

import { isDmdss } from '../utils/env'
import { isValidDmdataApiKey, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
import {
  createTestEarthquake,
  createTestForeignQuake,
  createTestLpgm,
  createTestEEW,
  createTestEEWWarning,
  createTestEEWForecast,
  createTestEEWAssumed,
  createTestEEWDeep,
  createTestTsunami,
  createTestTsunamiWarning,
  createTestTsunamiWatch,
  createTestTsunamiForecast,
  createTestTsunamiRetraction,
  createTestNankai,
  createTestNankaiCommentary,
  createTestKohatsu,
  TEST_AUTO_DISMISS_MS,
} from '../utils/testData'

// 初回取得件数（設定の最大選択値に合わせる）。リプレイ開始時の履歴復元（useReplayController の
// QUAKE_HISTORY_EVENTS）もこの値をそのまま目標にするため export している。片方だけ動かすと、
// ライブと再生でカードの厚みが黙って食い違う。
export const MAX_HISTORY_RETAINED = 50
const LOAD_MORE_BATCH = 50        // 「もっと見る」1回あたりの取得件数
const MAX_TELEGRAM_LOG = 200      // 電文ログの最大保持件数
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
function isQuakeCancelTarget(card: JMAQuake, cancel: JMAQuake): boolean {
  return !card.cancelledAt && sameQuakeEntry(card, cancel) && card.issue.type === cancel.issue.type
}

/** 取消電文が効くカードを探す。判定は `isQuakeCancelTarget`。 */
function findQuakeCancelTarget(cards: readonly JMAQuake[], cancel: JMAQuake): JMAQuake | undefined {
  return cards.find(card => isQuakeCancelTarget(card, cancel))
}
const EEW_FINAL_SILENCE_MS = 10000 // EEW発報テスト（特別警報・警報・予報）: この間隔クリックが無ければ最終報として確定する
const EEW_RETRACTION_CANCEL_MS = 10000 // EEW誤報取消テスト: 発報からこの秒数後に取消電文を送る

type QueuePayload =
  | { kind: 'event'; event: AppEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }
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
      areas: [],
      forecastMaxScale: undefined,
      forecastMaxLpgmClass: undefined,
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
  connectionStatus: ConnectionStatus
  lastUpdate: Date | null
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  error: string | null
  telegramLog: TelegramLogEntry[]
}

export function useEarthquakes(
  onLiveEvent?: (event: AppEvent) => void,
  dmdataApiKey = '',
  dmdataTestDelivery = false,
  replayTimeOffset: number | null = null,
) {
  const [state, setState] = useState<EarthquakeState>({
    earthquakes: [],
    tsunamis: [],
    activeEEWs: new Map(),
    lpgmByEventId: new Map(),
    nankai: null,
    nankaiCommentary: null,
    kohatsu: null,
    connectionStatus: (isDmdss && !isValidDmdataApiKey(dmdataApiKey)) ? 'disconnected' : 'connecting',
    lastUpdate: null,
    isLoading: !(isDmdss && !isValidDmdataApiKey(dmdataApiKey)),
    isLoadingMore: false,
    hasMore: false,
    error: null,
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
  // キューディスパッチャーがサイレントエントリを処理中は true にして通知音を抑制する
  const isSilentRef = useRef(false)
  // テスト EEW の発報状態を種別ごとに独立管理（複数EEW同時テスト対応）
  const testEEWTimersRef = useRef<Map<TestEEWKind, TestEEWEntry>>(new Map())
  // EEW 誤報取消テストの発報状態
  const testEEWRetractionRef = useRef<TestEEWRetractionEntry | null>(null)
  // テスト津波の発報状態を種別ごとに独立管理
  const testTsunamiRef = useRef<{ cancelTimer: number; tsunami: JMATsunami } | null>(null)
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
  // 後発地震注意情報（VYSE60）の7日間有効期限タイマー
  const kohatsuExpireTimerRef = useRef<number | undefined>(undefined)
  // 南海トラフ地震関連解説情報（VYSE51/52）の7日間有効期限タイマー。
  // 解説情報には解除電文が無く、定例解説は平常時にも毎月届く。期限で畳まないと帯が常駐する。
  const nankaiCommentaryExpireTimerRef = useRef<number | undefined>(undefined)
  // イベントキュー: ディスパッチャーが 10ms ごとに、発火時刻の来たものを先頭から処理する。
  // リプレイ時は eventTime と再生時刻を比較して発火制御する（並びと取り出しの規約は `EventQueue`）。
  const eventQueueRef = useLazyRef<EventQueue>(createEventQueue)
  // DMDSS 版「もっと見る」用カーソルと API キー（useCallback 内の stale closure 回避）
  const dmdataCursorRef = useRef<string | undefined>(undefined)
  const dmdataApiKeyRef = useRef(dmdataApiKey)
  dmdataApiKeyRef.current = dmdataApiKey
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
  const applyNankaiCommentary = useCallback((commentary: JMANankaiCommentary): boolean => {
    // 取消電文は帯を消す。false を返すので音・読み上げも起こさない（取消を告げる必要のある
    // 重さの情報ではないため。臨時情報の取消とは扱いが違う）
    if (commentary.cancelled) {
      if (nankaiCommentaryExpireTimerRef.current !== undefined) {
        window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
        nankaiCommentaryExpireTimerRef.current = undefined
      }
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
    setState(prev => ({ ...prev, nankaiCommentary: commentary }))
    nankaiCommentaryExpireTimerRef.current = window.setTimeout(() => {
      nankaiCommentaryExpireTimerRef.current = undefined
      setState(prev => (
        prev.nankaiCommentary?.id === commentary.id ? { ...prev, nankaiCommentary: null } : prev
      ))
    }, remainMs)
    return true
  }, [])

  /**
   * 取消を見た事実を台帳へ積む。件数に上限を置き、古いものから落とす。
   *
   * 上限を置くのは、長時間つないだままの端末で無制限に伸びるのを避けるため。**判定は毎回全件を
   * 走査する**ので、伸びると受信ごとの処理も重くなる。取り下げ済みの報が届くのは順序の
   * 入れ替わりか誤認識なので、直近の取消だけ覚えていれば足りる。
   */
  const rememberQuakeRetraction = useCallback((retraction: QuakeRetraction) => {
    const list = quakeRetractionsRef.current
    list.push(retraction)
    if (list.length > MAX_QUAKE_RETRACTIONS) list.splice(0, list.length - MAX_QUAKE_RETRACTIONS)
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
        eventQueueRef.current.push({
          eventTime: cancelTime,
          payload: { kind: 'event', event: { ...eew, cancelled: true, expired: true } as AppEvent },
        })
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
          quakeRetractionOf(quake, findQuakeCancelTarget(stateRef.current.earthquakes, quake)),
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
              if (isQuakeCancelTarget(e, quake)) {
                found = true
                eventQueueRef.current.push({
                  eventTime: new Date(now.getTime() + 10_000),
                  payload: { kind: 'purge-cancelled-quake', id: e.id },
                  silent: true,
                })
                return { ...e, cancelledAt: now }
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
          if (isRetractedQuakeReport(quakeRetractionsRef.current, quake)) {
            log.warn('[quake] 取消以前に発表された報を捨てた', {
              id: quake.id, issueType: quake.issue.type, time: quake.time,
            })
            return prev
          }
          const existing = findExistingQuakeCard(prev.earthquakes, quake)
          const merged = mergeQuakeInto(existing, quake)
          if (merged === existing) return prev
          // 統合の結果、暫定 ID で作られたカードが確定 ID を持つカードと重複することがある。
          // 履歴経路（mergeQuakeHistory）と同じ畳み込みをここでも通す（理由は coalesceByEventId）。
          //
          // **取消表示中のカードは差し替えの対象から外す（残す）。** ここで落とすと 10 秒表示を
          // 待たずに消え、しかも purge 予約（`id` で対象を引く）が空振りする。
          const next = coalesceByEventId([
            merged,
            ...prev.earthquakes.filter(e => e.cancelledAt || !sameQuakeEntry(e, quake)),
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
              return { ...prev, tsunamis: [{ ...prev.tsunamis[0], cancelledAt: now, cancelReason: tsunami.cancelReason }], lastUpdate: now }
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
          // 引き継ぎの条件は `isTsunamiContinuation` に集約する（読み上げ・通知・スクロールが
          // 使うカード順の基準と同じ述語を使うため。宣言箇所に理由）。
          const sameEvent = isTsunamiContinuation(current, tsunami)
          if (sameEvent) {
            const areas = tsunami.areas.length > 0 ? tsunami.areas : current.areas
            const observations = mergeTsunamiObservations(current.observations, tsunami.observations)
            // 有効期限は報ではなく津波に付く事実なので、期限を持たない続報では前報の値を残す
            // （気象庁は期限が決まった報で一度だけ伝える。詳細は utils/tsunami の
            // `latestValidDateTime`）。期限を持つ報が来たらそちらへ従う（延長・短縮）。
            //
            // `??` で書かずにその関数へ通すのは、**日時として読めない値を弾く箇所を 1 つに保つため**。
            // 読めない期限をカードへ入れると、以後の続報でも引き継がれ続け、比較はすべて偽に倒れる。
            const validDateTime = latestValidDateTime([current, tsunami])
            return { ...prev, tsunamis: [{ ...tsunami, areas, observations, validDateTime }], lastUpdate: now }
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
            next.set(key, { ...existing, cancelledAt: now })
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
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm } as unknown as AppEvent)
          }
        } else if (payload.kind === 'nankai') {
          const nankai = payload.data
          setState(prev => ({ ...prev, nankai: nankai.cancelled ? null : nankai }))
          if (!silent) onLiveEventRef.current?.({ kind: 'nankai', data: nankai } as unknown as AppEvent)
        } else if (payload.kind === 'nankaiCommentary') {
          const commentary = payload.data
          // 期限切れなら反映も通知もしない（画面に出ないものを読み上げても意味がない）
          if (applyNankaiCommentary(commentary) && !silent) {
            onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary } as unknown as AppEvent)
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
          if (kohatsuExpireTimerRef.current !== undefined) {
            window.clearTimeout(kohatsuExpireTimerRef.current)
            kohatsuExpireTimerRef.current = undefined
          }
          if (!kohatsu.cancelled) {
            const expireMs = new Date(kohatsu.expireAt).getTime() - getTimeRef.current().getTime()
            if (expireMs > 0) {
              kohatsuExpireTimerRef.current = window.setTimeout(() => {
                kohatsuExpireTimerRef.current = undefined
                setState(prev => ({ ...prev, kohatsu: null }))
              }, expireMs)
            }
            setState(prev => ({ ...prev, kohatsu }))
          } else {
            setState(prev => ({ ...prev, kohatsu: null }))
          }
          if (!silent) onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu } as unknown as AppEvent)
        }
        isSilentRef.current = false
      }
    }, 10)
    return () => clearInterval(id)
  }, [handleEvent])

  // アンマウント時にタイマーとキューをクリア。
  // 7日タイマーは 2 つある（後発地震・南海トラフ関連解説情報）。片方だけをクリアすると、
  // 残った側が最大7日後にアンマウント済みのクロージャの setState を呼ぶ。
  useEffect(() => {
    return () => {
      if (kohatsuExpireTimerRef.current !== undefined) {
        window.clearTimeout(kohatsuExpireTimerRef.current)
      }
      if (nankaiCommentaryExpireTimerRef.current !== undefined) {
        window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
      }
      eventQueueRef.current.clear()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

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

      // DMDATA REST API で履歴取得
      Promise.all([
        fetchDmdataEarthquakes(dmdataApiKey, MAX_HISTORY_RETAINED),
        fetchDmdataTsunamis(dmdataApiKey, 10),
        // 取得側で失敗はすべて捕まえて null を返すため、ここへは届かない想定。
        // 万一漏れた場合に地震・津波の履歴取得まで巻き込まないための保険なので、
        // 素通しにせず記録を残す（この 2 つは補助情報のため、失敗しても続行してよい）。
        fetchDmdataNankai(dmdataApiKey).catch(err => {
          log.error('[data] 南海トラフ地震臨時情報の取得で想定外の失敗', err)
          return null
        }),
        fetchDmdataKohatsu(dmdataApiKey).catch(err => {
          log.error('[data] 後発地震注意情報の取得で想定外の失敗', err)
          return null
        }),
        fetchDmdataNankaiCommentary(dmdataApiKey).catch(err => {
          log.error('[data] 南海トラフ地震関連解説情報の取得で想定外の失敗', err)
          return null
        }),
      ])
        .then(async ([quakeResult, tsunamiEvents, nankaiData, kohatsuData, commentaryData]) => {
          if (cancelled) return
          const { quakes: quakeEvents, nextToken } = quakeResult
          dmdataCursorRef.current = nextToken
          // 種別横断の生電文を eventId ごとに統合（リアルタイムと同一ロジック）。
          rememberQuakeRetractionsFromBatch(quakeEvents)
          const earthquakes = mergeQuakeHistory(quakeEvents, [], quakeRetractionsRef.current)
          const allTsunami = tsunamiEvents
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
          // 画面へ載せるのは最新報 1 通だけ。その報が有効期限を持たなくても、同じ津波の過去報が
          // 伝えていれば引き継ぐ（引き継がないと下の失効予約が積まれず、期限切れの津波が消えない）。
          const latestTsunami = allTsunami[0] && withInheritedValidDateTime(allTsunami[0], allTsunami)
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

          // 表示中の最古の地震時刻まで VXSE62 をページネーションで取得
          const oldest = earthquakes.reduce<string | null>((acc, q) => {
            const t = q.earthquake.time
            return acc === null || t < acc ? t : acc
          }, null)
          const lpgmEvents = oldest
            ? await fetchDmdataLpgms(dmdataApiKey, oldest).catch(() => [])
            : []
          const lpgmByEventId = new Map<string, JMALpgm>()
          for (const lpgm of lpgmEvents) {
            if (lpgm.cancelled) continue
            const existing = lpgmByEventId.get(lpgm.eventId)
            if (!existing || lpgm.time > existing.time) {
              lpgmByEventId.set(lpgm.eventId, lpgm)
            }
          }

          // 後発地震注意情報の有効期限タイマー（初回ロード時）
          if (kohatsuData && !kohatsuData.cancelled) {
            const expireMs = new Date(kohatsuData.expireAt).getTime() - serverNow()
            if (expireMs > 0) {
              if (kohatsuExpireTimerRef.current !== undefined) window.clearTimeout(kohatsuExpireTimerRef.current)
              kohatsuExpireTimerRef.current = window.setTimeout(() => {
                kohatsuExpireTimerRef.current = undefined
                setState(prev => ({ ...prev, kohatsu: null }))
              }, expireMs)
            }
          }

          if (cancelled) return
          setState(prev => ({
            ...prev,
            earthquakes,
            tsunamis,
            lpgmByEventId,
            nankai: nankaiData ?? null,
            kohatsu: kohatsuData ?? null,
            lastUpdate: serverDate(),
            isLoading: false,
            hasMore: !!nextToken,
            error: null,
          }))
          // 解説情報は期限タイマーの張り替えを伴うためヘルパ経由で入れる（期限切れは入らない）
          if (commentaryData) applyNankaiCommentary(commentaryData)
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
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm } as unknown as AppEvent)
          }
        } else if (ev.kind === 'nankai') {
          const nankai = ev.data
          setState(prev => ({ ...prev, nankai: nankai.cancelled ? null : nankai }))
          onLiveEventRef.current?.({ kind: 'nankai', data: nankai } as unknown as AppEvent)
        } else if (ev.kind === 'nankaiCommentary') {
          const commentary = ev.data
          if (applyNankaiCommentary(commentary)) {
            onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary } as unknown as AppEvent)
          }
        } else if (ev.kind === 'kohatsu') {
          const kohatsu = ev.data
          if (kohatsuExpireTimerRef.current !== undefined) {
            window.clearTimeout(kohatsuExpireTimerRef.current)
            kohatsuExpireTimerRef.current = undefined
          }
          if (!kohatsu.cancelled) {
            const expireMs = new Date(kohatsu.expireAt).getTime() - serverNow()
            if (expireMs > 0) {
              kohatsuExpireTimerRef.current = window.setTimeout(() => {
                kohatsuExpireTimerRef.current = undefined
                setState(prev => ({ ...prev, kohatsu: null }))
              }, expireMs)
            }
            setState(prev => ({ ...prev, kohatsu }))
          } else {
            setState(prev => ({ ...prev, kohatsu: null }))
          }
          onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu } as unknown as AppEvent)
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
        // P2PQuake の発生時刻は分単位のため、同じ分に起きた別の地震が 1 枚に潰れていた。
        rememberQuakeRetractionsFromBatch(quakeEvents)
        const earthquakes = mergeQuakeHistory(quakeEvents, [], quakeRetractionsRef.current)
        const allTsunami = (tsunamiEvents as JMATsunami[])
          .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        // DMDSS 側と同じ引き継ぎ。P2PQuake の 552 は有効期限を持たないため実際には何も変わらないが、
        // 経路ごとに扱いを違えない（片方だけ直すと、次に触る人がどちらが正なのか判断できない）。
        const latestTsunami = allTsunami[0] && withInheritedValidDateTime(allTsunami[0], allTsunami)
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
    setState(prev => ({ ...prev, isLoadingMore: true }))
    try {
      if (isDmdss) {
        const apiKey = dmdataApiKeyRef.current
        const cursor = dmdataCursorRef.current
        const existingQuakes = stateRef.current.earthquakes
        const { quakes: events, nextToken } = await fetchDmdataEarthquakes(apiKey, LOAD_MORE_BATCH, cursor)
        dmdataCursorRef.current = nextToken
        // 既存カード群を base に、新バッチの生電文を eventId ごとに統合する。
        // これによりバッチ跨ぎ（先に届いた VXSE61 単独カードへ後続の VXSE53 の震度を合流など）も
        // リアルタイムと同一結果になる。
        // 台帳への記録は setState の外で行う（更新関数は再実行されうるため副作用を持たせない）。
        rememberQuakeRetractionsFromBatch(events)
        setState(prev => ({
          ...prev,
          earthquakes: mergeQuakeHistory(events, prev.earthquakes, quakeRetractionsRef.current),
          isLoadingMore: false,
          hasMore: !!nextToken,
        }))
        // 新しく読み込んだ地震に対応する LPGM を追加取得（失敗は無視）
        const newOldest = [...existingQuakes, ...events].reduce<string | null>((acc, q) => {
          const t = q.earthquake.time
          return acc === null || t < acc ? t : acc
        }, null)
        if (newOldest) {
          const lpgmEvents = await fetchDmdataLpgms(apiKey, newOldest).catch(() => [])
          if (lpgmEvents.length > 0) {
            setState(prev => {
              const lpgmByEventId = new Map(prev.lpgmByEventId)
              for (const lpgm of lpgmEvents) {
                if (lpgm.cancelled) continue
                const existing = lpgmByEventId.get(lpgm.eventId)
                if (!existing || lpgm.time > existing.time) {
                  lpgmByEventId.set(lpgm.eventId, lpgm)
                }
              }
              return { ...prev, lpgmByEventId }
            })
          }
        }
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
          earthquakes: mergeQuakeHistory(events, prev.earthquakes, quakeRetractionsRef.current),
          isLoadingMore: false,
          hasMore: events.length === LOAD_MORE_BATCH,
        }))
      }
    } catch (err) {
      // 追加読み込みの失敗は画面では「増えなかった」だけに見える（初回ロード用の error state は
      // 触らない）。ユーザーが再度押せる状態に戻すだけなので、理由はログに残す。
      log.error('[data] 地震履歴の追加読み込みに失敗', err)
      setState(prev => ({ ...prev, isLoadingMore: false }))
    }
  }, [])

  const simulateEarthquake = useCallback(() => {
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
      onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm } as unknown as AppEvent)
    }
  }, [handleEvent])

  const simulateForeignQuake = useCallback(() => {
    // 付加文（気象庁の固定付加文・自由付加文の原文）は DMDATA 経由でのみ配信される。standard 版では
    // 実データで届かないため含めない（LPGM を isDmdss 限定にしているのと同じ理由）。
    handleEvent(createTestForeignQuake(isDmdss))
  }, [handleEvent])

  const simulateEEW = useCallback(
    () => runSimulateEEW('special', createTestEEW, EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWWarning = useCallback(
    () => runSimulateEEW('warning', createTestEEWWarning, EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWForecast = useCallback(
    () => runSimulateEEW('forecast', createTestEEWForecast, EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWAssumed = useCallback(
    () => runSimulateEEW('assumed', createTestEEWAssumed, EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWDeep = useCallback(
    () => runSimulateEEW('deep', createTestEEWDeep, EEW_FINAL_SILENCE_MS, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWRetraction = useCallback(
    () => runSimulateEEWRetraction(createTestEEWWarning, EEW_RETRACTION_CANCEL_MS, testEEWRetractionRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunami = useCallback(
    () => runSimulateTsunami(() => createTestTsunami(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunamiWarning = useCallback(
    () => runSimulateTsunami(() => createTestTsunamiWarning(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunamiWatch = useCallback(
    () => runSimulateTsunami(() => createTestTsunamiWatch(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  // 予報のみは DMDSS の実運用では ValidDateTime の期限切れで静かに消える（明示的な解除電文を
  // 伴わない）ため、DMDSS では runSimulateTsunami（明示的キャンセル）を使わず期限切れ経路に任せる。
  // standard 版（P2PQuake）は validDateTime を持たないため、実運用と同じく解除電文で消す。
  const simulateTsunamiForecast = useCallback(() => {
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

  const simulateTsunamiRetraction = useCallback(
    () => runSimulateTsunami(() => createTestTsunamiRetraction(isDmdss), TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent, 'retracted'),
    [handleEvent],
  )

  const simulateNankai = useCallback((kindName: '調査中' | '巨大地震注意' | '巨大地震警戒') => {
    const nankai = createTestNankai(kindName)
    setState(prev => ({ ...prev, nankai }))
    onLiveEventRef.current?.({ kind: 'nankai', data: nankai } as unknown as AppEvent)
  }, [])

  const simulateNankaiCommentary = useCallback((serialName: '臨時解説' | '定例解説') => {
    const commentary = createTestNankaiCommentary(serialName)
    if (applyNankaiCommentary(commentary)) {
      onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary } as unknown as AppEvent)
    }
  }, [applyNankaiCommentary])

  const simulateKohatsu = useCallback(() => {
    const kohatsu = createTestKohatsu()
    if (kohatsuExpireTimerRef.current !== undefined) window.clearTimeout(kohatsuExpireTimerRef.current)
    const expireMs = new Date(kohatsu.expireAt).getTime() - serverNow()
    if (expireMs > 0) {
      kohatsuExpireTimerRef.current = window.setTimeout(() => {
        kohatsuExpireTimerRef.current = undefined
        setState(prev => ({ ...prev, kohatsu: null }))
      }, expireMs)
    }
    setState(prev => ({ ...prev, kohatsu }))
    onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu } as unknown as AppEvent)
  }, [])

  const resetState = useCallback(() => {
    // 台帳もここで空にする。掃除の `useEffect` に任せると、リセットから次のコミットまでの間に
    // 同じ eventId の報が届いたとき、消えたはずの報番号と比べて誤って捨てうる。
    acceptedEewSerialRef.current.clear()
    // 取消の台帳も空にする。リプレイの開始・リセットで時間軸が変わるため、前の軸で見た取消の
    // 発表時刻と新しい軸の報を比べると、正常な報を取り下げ済みと誤判定する。
    quakeRetractionsRef.current = []
    setState(prev => ({
      ...prev,
      earthquakes: [],
      tsunamis: [],
      activeEEWs: new Map(),
      lpgmByEventId: new Map(),
      nankai: null,
      nankaiCommentary: null,
      kohatsu: null,
      // 「もっと見る」を畳む。カードを空にしても hasMore を残すと、リプレイ中にボタンが出たまま
      // になり、押すと `loadMoreEarthquakes` が**ライブの最新履歴**を取りに行って、再生時刻より
      // 未来の地震がカードに並ぶ。ライブへ戻る側は履歴の取得完了時に立て直すので落としてよい。
      hasMore: false,
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
  }, [])

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
    setState(prev => ({ ...prev, earthquakes: mergeQuakeHistory(quakes, prev.earthquakes, quakeRetractionsRef.current) }))
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
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWAssumed, simulateEEWDeep, simulateEEWRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateNankaiCommentary, simulateKohatsu,
    resetState,
    loadReplayEvents,
    restoreQuakeHistory,
  }
}
