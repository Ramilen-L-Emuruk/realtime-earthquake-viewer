import { useState, useEffect, useRef, useCallback } from 'react'
import type { JMAQuake, JMATsunami, JMALpgm, JMANankai, JMAKohatsu, EEWAlert, IntensityScale, EarthquakePoint, AppEvent, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { fetchHistory, fetchJmaQuake, P2PQuakeWebSocket } from '../services/p2pquake'
import { DmdataWebSocket, fetchDmdataEarthquakes, fetchDmdataTsunamis, fetchDmdataLpgms, fetchDmdataNankai, fetchDmdataKohatsu } from '../services/dmdata'
import { mergeQuakeInto, mergeQuakeHistory, sameQuakeEntry, sortQuakes, extractQuakeEventId, quakeEventKey } from '../utils/quakeMerge'
import { loadStationCoords, onStationCoordsLoaded, buildAreaPrefIndex } from '../utils/stationCoords'
import { calcEEWCancelTime } from '../utils/eew'
import { mergeTsunamiObservations } from '../utils/tsunami'
import { log } from '../utils/logger'
import { serverNow, serverDate, isReplayClock } from '../utils/clock'

import { isDmdss } from '../utils/env'
import {
  createTestEarthquake,
  createTestForeignQuake,
  createTestLpgm,
  createTestEEW,
  createTestEEWWarning,
  createTestEEWForecast,
  createTestTsunami,
  createTestTsunamiWarning,
  createTestTsunamiWatch,
  createTestTsunamiForecast,
  createTestTsunamiRetraction,
  createTestNankai,
  createTestKohatsu,
  TEST_AUTO_DISMISS_MS,
} from '../utils/testData'

const MAX_HISTORY_RETAINED = 50   // 初回取得件数（設定の最大選択値に合わせる）
const LOAD_MORE_BATCH = 50        // 「もっと見る」1回あたりの取得件数
const MAX_TELEGRAM_LOG = 200      // 電文ログの最大保持件数
const EEW_FINAL_SILENCE_MS = 10000 // EEW発報テスト（特別警報・警報・予報）: この間隔クリックが無ければ最終報として確定する
const EEW_RETRACTION_CANCEL_MS = 10000 // EEW誤報取消テスト: 発報からこの秒数後に取消電文を送る

type QueuePayload =
  | { kind: 'event'; event: AppEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'kohatsu'; data: JMAKohatsu }
  | { kind: 'purge-cancelled-quake'; id: string }
  | { kind: 'purge-cancelled-eew'; key: string }
  | { kind: 'purge-cancelled-tsunami'; id: string }

interface QueueEntry {
  eventTime: Date
  payload: QueuePayload
  silent?: boolean
}

function insertSorted(queue: QueueEntry[], entry: QueueEntry): void {
  let i = queue.length
  while (i > 0 && queue[i - 1].eventTime > entry.eventTime) i--
  queue.splice(i, 0, entry)
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

type TestEEWKind = 'special' | 'warning' | 'forecast'
type TestEEWEntry = { eventId: string; serial: number; finalizeTimer: number }
type TestEEWRetractionEntry = { eventId: string; serial: number; cancelTimer: number }

type TestTsunamiRef = React.MutableRefObject<{ cancelTimer: number; tsunami: JMATsunami } | null>

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
    handleEvent({ ...tsunami, cancelled: true, cancelReason })
    ref.current = null
  }, cancelMs)
  ref.current = { cancelTimer, tsunami }
}

// EEW発報テスト（特別警報・警報・予報）: クリックのたびに続報（isFinal未設定）を送る。
// silenceMs 経過しても再クリックが無ければ、その時点のイベントを isFinal:true で確定送信する。
// 確定後は本番と全く同じ calcEEWCancelTime ベースの自動解除（無音・即消去）がそのままかかる
// （DMDSS版の実運用と同一経路。Standard版は実データに isFinal が来ないため、この検知経路
// 自体は実運用で通らないが、解除後の共有ロジックはバリアント共通のため検証できる）。
function runSimulateEEW(
  kind: TestEEWKind,
  createFn: (eventId: string, serial: number) => EEWAlert,
  silenceMs: number,
  timers: Map<TestEEWKind, TestEEWEntry>,
  handleEvent: (event: AppEvent) => void,
) {
  const prev = timers.get(kind)
  const isContinuation = prev !== undefined
  const eventId = isContinuation ? prev.eventId : `test-${kind}-${Date.now()}`
  const serial = isContinuation ? prev.serial + 1 : 1
  if (prev) window.clearTimeout(prev.finalizeTimer)
  const eew = createFn(eventId, serial)
  handleEvent(eew)
  const finalizeTimer = window.setTimeout(() => {
    handleEvent({ ...eew, isFinal: true })
    timers.delete(kind)
  }, silenceMs)
  timers.set(kind, { eventId, serial, finalizeTimer })
}

// EEW誤報取消テスト: 通常発報のまま cancelMs 後に明示的な取消電文（cancelled:true、isFinal無し）
// を送る。誤報取消は音・ブラウザ通知・読み上げを伴う（自動解除との対比用）。
function runSimulateEEWRetraction(
  createFn: (eventId: string, serial: number) => EEWAlert,
  cancelMs: number,
  ref: React.MutableRefObject<TestEEWRetractionEntry | null>,
  handleEvent: (event: AppEvent) => void,
) {
  const prev = ref.current
  const eventId = prev ? prev.eventId : `test-eew-retraction-${Date.now()}`
  const serial = prev ? prev.serial + 1 : 1
  if (prev) window.clearTimeout(prev.cancelTimer)
  const eew = createFn(eventId, serial)
  handleEvent(eew)
  const cancelTimer = window.setTimeout(() => {
    handleEvent({ ...eew, cancelled: true })
    ref.current = null
  }, cancelMs)
  ref.current = { eventId, serial, cancelTimer }
}

export interface EarthquakeState {
  earthquakes: JMAQuake[]
  tsunamis: JMATsunami[]
  activeEEWs: ReadonlyMap<string, EEWAlert>
  lpgmByEventId: ReadonlyMap<string, JMALpgm>
  nankai: JMANankai | null
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
    kohatsu: null,
    connectionStatus: (isDmdss && !dmdataApiKey) ? 'disconnected' : 'connecting',
    lastUpdate: null,
    isLoading: !(isDmdss && !dmdataApiKey),
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
  // VXSE51 受信時に震度データをキャッシュし、後続の VXSE52（震源情報）に補完する。
  // VXSE52 は震源のみで震度を持たないため、VXSE51 の maxScale・points を引き継ぐ。
  const quakeIntensityCacheRef = useRef<Map<string, { maxScale: IntensityScale; points: EarthquakePoint[] }>>(new Map())
  // 後発地震注意情報（VYSE60）の7日間有効期限タイマー
  const kohatsuExpireTimerRef = useRef<number | undefined>(undefined)
  // イベントキュー: eventTime 昇順でソート済み。ディスパッチャーが 100ms ごとに先頭から処理する。
  // リプレイ時は eventTime と再生時刻を比較して発火制御する。
  const eventQueueRef = useRef<QueueEntry[]>([])
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
  const enrichEEW = useCallback((eventId: string, source: EEWAlert) => {
    // 現在の state から既存 EEW を取り出して severity の格上げを判定する。
    // setState の関数内で判定して外側から onLiveEvent を呼ぶ二重評価を避けるため、
    // stateRef.current 経由で参照する。
    const existing = stateRef.current.activeEEWs.get(eventId)
    if (!existing) return
    const existingSerial = Number(existing.issue?.serial ?? 0)
    const sourceSerial = Number(source.issue?.serial ?? 0)
    if (sourceSerial < existingSerial) return
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
      areas: source.areas ?? source.regions ?? existing.areas,
      earthquake: {
        ...existing.earthquake,
        condition: source.earthquake.condition,
        hypocenter: source.earthquake.hypocenter,
      },
    }
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

  // VAR-1: standard 版で kyoshin テスト時刻設定中はキューの time base（getTimeRef=擬似過去時刻）が
  // 実時刻から乖離するため、実時刻ベースの絶対時刻を持つ予約が「発火時刻 > 現在」で永久滞留し、
  // リプレイ解除時に一斉発火する。**リプレイ中のみ**、実時刻ベースの eventTime を now 以下にクランプ
  // して即発火させる。
  //
  // TSU-5A のレビューで判明した既存バグ修正: 以前は live 中も一律クランプしていたため、
  // 意図的な未来時刻（validDateTime=数分〜数時間後・EEW cancel time・TSU-5A の 24h フェイルセーフ）
  // まで now に潰されて受信直後に発火していた（TSU-1 の validDateTime 経路・EEW 最終報自動解除・
  // 初回ロード津波期限切れ・TSU-5A が全て影響）。live 中は素通しにする。
  const clampToNow = useCallback((raw: Date): Date => {
    if (!isReplayClock()) return raw
    const now = getTimeRef.current()
    return raw > now ? now : raw
  }, [])

  // WebSocket 受信時のエントリポイント: event.time を基準にキューへ挿入する
  // live モードでは event.time ≈ now なので次のティック（最大 100ms 後）に即時発火する
  const enqueueEvent = useCallback((event: AppEvent, overrideTime?: Date) => {
    const parsed = overrideTime ?? new Date((event as { time?: string }).time ?? serverNow())
    // Invalid Date を 1 件でも積むとキューが恒久停止する。ディスパッチャは先頭ブロッキング
    // （`q[0].eventTime <= now` が偽なら以降を処理しない）で、NaN 比較は常に偽になるため
    // その後ろに積まれたイベントが二度と発火しない。パーサ側でも弾いているが、
    // 単一の壊れた時刻でライブ更新が全停止する事故は入口でも防いでおく。
    const raw = Number.isFinite(parsed.getTime()) ? parsed : serverDate()
    const eventTime = clampToNow(raw)
    insertSorted(eventQueueRef.current, { eventTime, payload: { kind: 'event', event } })
  }, [clampToNow])

  // 時刻ソースはアプリ時計(serverDate)に一元化。ライブ時はサーバー同期、
  // リプレイ時は clock.setReplayOffset により再生時刻を返すため差し替え不要。
  const getTimeRef = useRef<() => Date>(serverDate)

  const handleEvent = useCallback((event: AppEvent) => {
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
        insertSorted(eventQueueRef.current, {
          // VAR-1: kyoshin リプレイ中の real-time 予約が永久滞留するのを防ぐため clampToNow を適用。
          eventTime: clampToNow(cancelTime),
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
          expireTime = new Date(tsunami.validDateTime)
        } else if (!isDmdss) {
          const FAILSAFE_MS = 24 * 60 * 60 * 1000
          expireTime = new Date(now.getTime() + FAILSAFE_MS)
        }
      }
      const shouldModifyQueue = tsunami.cancelled || expireTime !== null
      if (shouldModifyQueue) {
        // 津波は「常に 1 件スロット」（tsunami-spec §5・TSU-3）で管理されるため、
        // expired 予約は最新 1 件だけ残せば充分。P2PQuake 経路は eventId が無く id も続報ごとに
        // 変わるため、id/eventId 一致条件を課すと古い予約が消えず積み上がる問題があった。
        // 明示解除電文でも purge するのは、TSU-5A の 24h 予約を解決済み津波に対して発火させないため。
        eventQueueRef.current = eventQueueRef.current.filter(entry => {
          if (entry.payload.kind !== 'event') return true
          const ev = entry.payload.event
          if (ev.kind !== 'tsunami') return true
          const evAny = ev as JMATsunami
          return evAny.cancelReason !== 'expired'
        })
        if (expireTime && expireTime > now) {
          // clampToNow は「電文由来の絶対時刻」（TSU-1 の validDateTime）にのみ適用する。
          // TSU-5A の 24h フェイルセーフは `now + 24h` の相対時刻で既に getTimeRef 時間軸に
          // 揃っているため、clampToNow に通すとリプレイ中は必ず now に潰されて即発火する。
          const eventTime = tsunami.validDateTime ? clampToNow(expireTime) : expireTime
          insertSorted(eventQueueRef.current, {
            eventTime,
            payload: { kind: 'event', event: { ...tsunami, cancelled: true, cancelReason: 'expired' } as AppEvent },
          })
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
              const matches = sameQuakeEntry(e, quake) && e.issue.type === quake.issue.type
              if (matches && !e.cancelledAt) {
                found = true
                insertSorted(eventQueueRef.current, {
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
          const existing = prev.earthquakes.find(e => sameQuakeEntry(e, quake))
          const merged = mergeQuakeInto(existing, quake)
          if (merged === existing) return prev
          return {
            ...prev,
            earthquakes: sortQuakes([merged, ...prev.earthquakes.filter(e => !sameQuakeEntry(e, quake))]),
            lastUpdate: now,
          }
        }
        case 'tsunami': {
          const tsunami = event as JMATsunami
          if (tsunami.cancelled) {
            // eventId が一致するものだけ解除する（serialNo が異なっても同一イベントを解除できるよう id 全体ではなく eventId で照合）
            if (prev.tsunamis.length > 0) {
              const current = prev.tsunamis[0]
              const cancelEventId = tsunami.eventId
              const currentEventId = current.eventId
              if (cancelEventId && currentEventId && cancelEventId !== currentEventId) return prev
              // eventId がない場合は従来通り id 全体で照合（フォールバック）
              if ((!cancelEventId || !currentEventId) && current.id !== tsunami.id) return prev
            }
            // 解除・取消・期限切れのいずれも同じ10秒表示を経る。表示内容は cancelReason で出し分ける（TsunamiTab側）。
            if (prev.tsunamis.length > 0 && !prev.tsunamis[0].cancelledAt) {
              // TSU-4: purge 予約に対象 id を持たせ、他イベントが後で置換した場合に誤って
              // 新しいカードを 10 秒前に消してしまうレースを防ぐ。
              insertSorted(eventQueueRef.current, {
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
          const sameEvent = current && current.eventId && tsunami.eventId
            && current.eventId === tsunami.eventId && !current.cancelledAt
          if (sameEvent) {
            const areas = tsunami.areas.length > 0 ? tsunami.areas : current.areas
            const observations = mergeTsunamiObservations(current.observations, tsunami.observations)
            return { ...prev, tsunamis: [{ ...tsunami, areas, observations }], lastUpdate: now }
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
          const key = eew.issue?.eventId ?? eew.id
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
            insertSorted(eventQueueRef.current, {
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

  // キューディスパッチャー: 10ms ごとに eventTime <= 現在時刻のエントリを処理する
  useEffect(() => {
    const id = setInterval(() => {
      const now = getTimeRef.current()
      const q = eventQueueRef.current
      while (q.length > 0 && q[0].eventTime <= now) {
        const { payload, silent } = q.shift()!
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

  // アンマウント時にタイマーとキューをクリア
  useEffect(() => {
    return () => {
      if (kohatsuExpireTimerRef.current !== undefined) {
        window.clearTimeout(kohatsuExpireTimerRef.current)
      }
      eventQueueRef.current = []
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    // VAR-1: リプレイ中は DMDSS の DMDATA WS のみ止め、standard 版の P2PQuake WS は稼働継続する。
    // replayTimeOffset は現状 kyoshin のテスト時刻設定でのみ使う。DMDSS 版はアーカイブ再生と混じる
    // ため live 停止が必要だが、standard 版では kyoshin リプレイ中も地震・津波のライブ更新は継続すべき。
    if (isDmdss && replayTimeOffset !== null) return

    if (isDmdss) {
      // --- DMDSS版: APIキー未設定なら接続しない ---
      if (!dmdataApiKey) {
        setState(prev => ({ ...prev, connectionStatus: 'disconnected', isLoading: false }))
        return
      }

      setState(prev => ({ ...prev, isLoading: true, connectionStatus: 'connecting', error: null }))

      // DMDATA REST API で履歴取得
      Promise.all([
        fetchDmdataEarthquakes(dmdataApiKey, MAX_HISTORY_RETAINED),
        fetchDmdataTsunamis(dmdataApiKey, 10),
        fetchDmdataNankai(dmdataApiKey).catch(() => null),
        fetchDmdataKohatsu(dmdataApiKey).catch(() => null),
      ])
        .then(async ([quakeResult, tsunamiEvents, nankaiData, kohatsuData]) => {
          if (cancelled) return
          const { quakes: quakeEvents, nextToken } = quakeResult
          dmdataCursorRef.current = nextToken
          // 種別横断の生電文を eventId ごとに統合（リアルタイムと同一ロジック）。
          const earthquakes = mergeQuakeHistory(quakeEvents)
          const allTsunami = tsunamiEvents
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
          const latestTsunami = allTsunami[0]
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
          // 初回ロードで津波が有効（validDateTime未来）の場合、キューへ解除イベントを挿入する。
          // DMDSS 版はリプレイ中この effect 自体が return されるため clampToNow は不要だが、
          // 将来リプレイ許可時への安全弁として適用しておく。
          if (tsunamis.length > 0 && latestTsunami?.validDateTime) {
            const expireTime = new Date(latestTsunami.validDateTime)
            if (expireTime > serverDate()) {
              insertSorted(eventQueueRef.current, {
                eventTime: clampToNow(expireTime),
                payload: { kind: 'event', event: { ...latestTsunami, cancelled: true, cancelReason: 'expired' } as AppEvent },
              })
            }
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
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
          log.warn('[data] station-coords 取得失敗（EEW 予想震度の都道府県名が補完されない）', err)
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
    Promise.all([
      fetchJmaQuake(MAX_HISTORY_RETAINED),
      fetchHistory([552], 10),
    ])
      .then(([quakeEvents, tsunamiEvents]) => {
        if (cancelled) return
        // 種別横断の生電文をイベントごとに統合する（DMDSS 版・リアルタイムと同一ロジック）。
        // 以前は earthquake.time をキーにした Map で「優先度が最も高い 1 報」を選んでいたが、
        // P2PQuake の発生時刻は分単位のため、同じ分に起きた別の地震が 1 枚に潰れていた。
        const earthquakes = mergeQuakeHistory(quakeEvents)
        const allTsunami = (tsunamiEvents as JMATsunami[])
          .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        const latestTsunami = allTsunami[0]
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
          eventQueueRef.current = eventQueueRef.current.filter(entry => {
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
            insertSorted(eventQueueRef.current, {
              // VAR-1: kyoshin リプレイ中の real-time 予約が永久滞留するのを防ぐため clampToNow を適用。
              eventTime: clampToNow(expireTime),
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
        const key = eew.issue?.eventId ?? eew.id
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
        setState(prev => ({
          ...prev,
          earthquakes: mergeQuakeHistory(events, prev.earthquakes),
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
        const events = await fetchJmaQuake(LOAD_MORE_BATCH, offset)
        p2pRawOffsetRef.current += events.length
        // 既存カード群を base に新バッチを統合する（DMDSS 版と同じ扱い）。
        // バッチ跨ぎで同一イベントの続報が届いた場合もリアルタイムと同一結果になる。
        setState(prev => ({
          ...prev,
          earthquakes: mergeQuakeHistory(events, prev.earthquakes),
          isLoadingMore: false,
          hasMore: events.length === LOAD_MORE_BATCH,
        }))
      }
    } catch {
      setState(prev => ({ ...prev, isLoadingMore: false }))
    }
  }, [])

  const simulateEarthquake = useCallback(() => {
    const quake = createTestEarthquake()
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
    // 付加文（気象庁の固定付加文の原文）は DMDATA 経由でのみ配信される。standard 版では
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

  const simulateEEWRetraction = useCallback(
    () => runSimulateEEWRetraction(createTestEEWWarning, EEW_RETRACTION_CANCEL_MS, testEEWRetractionRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunami = useCallback(
    () => runSimulateTsunami(createTestTsunami, TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunamiWarning = useCallback(
    () => runSimulateTsunami(createTestTsunamiWarning, TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunamiWatch = useCallback(
    () => runSimulateTsunami(createTestTsunamiWatch, TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  // 予報のみは実運用でも ValidDateTime の期限切れで静かに消えるため（明示的な解除電文を伴わない）、
  // 他の津波テストと違い runSimulateTsunami（明示的キャンセル）は使わず、通常の期限切れ経路に任せる。
  const simulateTsunamiForecast = useCallback(() => {
    if (testTsunamiRef.current) {
      window.clearTimeout(testTsunamiRef.current.cancelTimer)
      testTsunamiRef.current = null
    }
    handleEvent(createTestTsunamiForecast())
  }, [handleEvent])

  const simulateTsunamiRetraction = useCallback(
    () => runSimulateTsunami(createTestTsunamiRetraction, TEST_AUTO_DISMISS_MS, testTsunamiRef, handleEvent, 'retracted'),
    [handleEvent],
  )

  const simulateNankai = useCallback((kindName: '調査中' | '巨大地震注意' | '巨大地震警戒') => {
    const nankai = createTestNankai(kindName)
    setState(prev => ({ ...prev, nankai }))
    onLiveEventRef.current?.({ kind: 'nankai', data: nankai } as unknown as AppEvent)
  }, [])

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
    setState(prev => ({
      ...prev,
      earthquakes: [],
      tsunamis: [],
      activeEEWs: new Map(),
      lpgmByEventId: new Map(),
      nankai: null,
      kohatsu: null,
    }))
    eventQueueRef.current = []
    quakeIntensityCacheRef.current.clear()
    // 後発地震注意情報の7日タイマーもリセット対象。resetState 後に古いタイマーが残ると、
    // リプレイモード切替→ライブ復帰後に発火して新しく設定された kohatsu を null に上書きしうる。
    if (kohatsuExpireTimerRef.current !== undefined) {
      window.clearTimeout(kohatsuExpireTimerRef.current)
      kohatsuExpireTimerRef.current = undefined
    }
  }, [])

  const loadReplayEvents = useCallback((entries: import('../services/dmdataReplay').ReplayEntry[]) => {
    for (const { payload, replayTime, silent } of entries) {
      insertSorted(eventQueueRef.current, { eventTime: replayTime, payload, silent })
    }
  }, [])

  return {
    ...state,
    injectEvent: handleEvent,
    loadMoreEarthquakes,
    clearTelegramLog,
    simulateEarthquake,
    simulateForeignQuake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateKohatsu,
    resetState,
    loadReplayEvents,
  }
}
