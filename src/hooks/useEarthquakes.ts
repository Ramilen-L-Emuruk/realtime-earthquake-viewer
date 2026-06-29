import { useState, useEffect, useRef, useCallback } from 'react'
import type { JMAQuake, JMATsunami, JMALpgm, JMANankai, JMAKohatsu, EEWAlert, EEWRegion, IntensityScale, EarthquakePoint, P2PQuakeEvent, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { fetchHistory, fetchJmaQuake, P2PQuakeWebSocket } from '../services/p2pquake'
import { DmdataWebSocket, fetchDmdataEarthquakes, fetchDmdataTsunamis, fetchDmdataLpgms, fetchDmdataNankai, fetchDmdataKohatsu } from '../services/dmdata'
import { loadStationCoords, buildAreaPrefIndex } from '../utils/stationCoords'

const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'
import {
  createTestEarthquake,
  createTestEEW,
  createTestEEWWarning,
  createTestEEWForecast,
  createTestTsunami,
  createTestTsunamiWarning,
  createTestTsunamiWatch,
  createTestTsunamiForecast,
  createTestNankai,
  createTestKohatsu,
} from '../utils/testData'

const MAX_HISTORY_RETAINED = 50   // 初回取得件数（設定の最大選択値に合わせる）
const LOAD_MORE_BATCH = 50        // 「もっと見る」1回あたりの取得件数
const MAX_TELEGRAM_LOG = 200      // 電文ログの最大保持件数

const ISSUE_PRIORITY: Record<string, number> = {
  DetailScale: 4,
  ScaleAndDestination: 3,
  Destination: 2,
  ScalePrompt: 1,
  DestinationAmended: 5,
  Foreign: 0,
  Other: 0,
}

const sortQuakes = (arr: JMAQuake[]): JMAQuake[] =>
  [...arr].sort((a, b) =>
    new Date(b.earthquake.time).getTime() - new Date(a.earthquake.time).getTime()
  )

type QueuePayload =
  | { kind: 'p2p'; event: P2PQuakeEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'kohatsu'; data: JMAKohatsu }

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
type TestEEWEntry = { eventId: string; serial: number; cancelTimer: number }

type TestTsunamiRef = React.MutableRefObject<{ cancelTimer: number; tsunami: JMATsunami } | null>

function runSimulateTsunami(
  createFn: () => JMATsunami,
  cancelMs: number,
  ref: TestTsunamiRef,
  handleEvent: (event: P2PQuakeEvent) => void,
) {
  if (ref.current) window.clearTimeout(ref.current.cancelTimer)
  const tsunami = createFn()
  handleEvent(tsunami)
  const cancelTimer = window.setTimeout(() => {
    handleEvent({ ...tsunami, cancelled: true })
    ref.current = null
  }, cancelMs)
  ref.current = { cancelTimer, tsunami }
}

function runSimulateEEW(
  kind: TestEEWKind,
  createFn: (eventId: string, serial: number) => EEWAlert,
  cancelMs: number,
  timers: Map<TestEEWKind, TestEEWEntry>,
  handleEvent: (event: P2PQuakeEvent) => void,
) {
  const prev = timers.get(kind)
  const isContinuation = prev !== undefined
  const eventId = isContinuation ? prev.eventId : `test-${kind}-${Date.now()}`
  const serial = isContinuation ? prev.serial + 1 : 1
  if (prev) window.clearTimeout(prev.cancelTimer)
  const eew = createFn(eventId, serial)
  handleEvent(eew)
  const cancelTimer = window.setTimeout(() => {
    handleEvent({ ...eew, cancelled: true })
    timers.delete(kind)
  }, cancelMs)
  timers.set(kind, { eventId, serial, cancelTimer })
}

export interface EarthquakeState {
  earthquakes: JMAQuake[]
  tsunamis: JMATsunami[]
  activeEEWs: ReadonlyMap<string, EEWAlert>
  lpgmByOriginTime: ReadonlyMap<string, JMALpgm>
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
  onLiveEvent?: (event: P2PQuakeEvent) => void,
  dmdataApiKey = '',
  dmdataTestDelivery = false,
  eewFinalClearSec = 180,
  replayTimeOffset: number | null = null,
) {
  const [state, setState] = useState<EarthquakeState>({
    earthquakes: [],
    tsunamis: [],
    activeEEWs: new Map(),
    lpgmByOriginTime: new Map(),
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
  // テスト津波の発報状態を種別ごとに独立管理
  const testTsunamiRef = useRef<{ cancelTimer: number; tsunami: JMATsunami } | null>(null)
  const eewFinalClearSecRef = useRef(eewFinalClearSec)
  eewFinalClearSecRef.current = eewFinalClearSec
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
  // P2PQuake 版「もっと見る」用の生 API 取得件数（重複除去後の earthquakes.length とは別管理）
  // offset = earthquakes.length だと重複除去ズレで古いデータが抜け落ちるため、API 呼び出し回数ベースで管理する
  const p2pRawOffsetRef = useRef(0)

  // P2PQuake の 556 受信時に既存の Yahoo EEW へ地域別予想震度を注入する（音・タブ切替なし）。
  const enrichEEW = useCallback((eventId: string, areas: EEWRegion[]) => {
    setState(prev => {
      const existing = prev.activeEEWs.get(eventId)
      if (!existing) return prev
      const enriched = { ...existing, areas }
      return { ...prev, activeEEWs: new Map(prev.activeEEWs).set(eventId, enriched) }
    })
  }, [])

  // WebSocket 受信時のエントリポイント: event.time を基準にキューへ挿入する
  // live モードでは event.time ≈ now なので次のティック（最大 100ms 後）に即時発火する
  const enqueueEvent = useCallback((event: P2PQuakeEvent, overrideTime?: Date) => {
    const t = overrideTime ?? new Date((event as { time?: string }).time ?? Date.now())
    insertSorted(eventQueueRef.current, { eventTime: t, payload: { kind: 'p2p', event } })
  }, [])

  // リプレイ時は差し替えることで再生時刻基準のディスパッチに切り替える
  const getTimeRef = useRef<() => Date>(() => new Date())

  const handleEvent = useCallback((event: P2PQuakeEvent) => {
    // ライブ受信／テスト送信のイベントを通知（サイレントモード中は抑制）
    if (!isSilentRef.current) onLiveEventRef.current?.(event)

    // 556（EEW）: 最終報受信時、解除時刻にキャンセルイベントをキューへ挿入する
    if (event.code === 556) {
      const eew = event as EEWAlert
      if (!eew.cancelled && !eew.test && eew.isFinal) {
        const cancelTime = new Date(new Date(eew.time).getTime() + eewFinalClearSecRef.current * 1000)
        insertSorted(eventQueueRef.current, {
          eventTime: cancelTime,
          payload: { kind: 'p2p', event: { ...eew, cancelled: true, expired: true } as P2PQuakeEvent },
        })
      }
    }

    // 地震情報（551）の震度キャッシュ更新は setState の外で行う
    if (event.code === 551) {
      const quake = event as JMAQuake
      const m = quake.id?.match(/^dmdata-quake-(\d{14})-/)
      // DMDATA は ID 埋め込みのタイムスタンプ、P2PQuake は earthquake.time をキーに使う
      const cacheKey = m ? m[1] : quake.earthquake.time
      // VXSE51 の震度データをキャッシュ（後続 VXSE52 への補完用）
      if (quake.issue.type === 'ScalePrompt' && quake.earthquake.maxScale >= 0) {
        quakeIntensityCacheRef.current.set(cacheKey, {
          maxScale: quake.earthquake.maxScale,
          points: quake.points,
        })
      }
    }

    // 552（津波）: ValidDateTime あり → 期限切れ時刻にキャンセルイベントをキューへ挿入する
    // 後続の新しい津波電文が来た場合、旧キャンセルが発火してもステート側でidチェックにより無視される
    if (event.code === 552) {
      const tsunami = event as JMATsunami
      if (!tsunami.cancelled && tsunami.validDateTime) {
        const expireTime = new Date(tsunami.validDateTime)
        if (expireTime > getTimeRef.current()) {
          insertSorted(eventQueueRef.current, {
            eventTime: expireTime,
            payload: { kind: 'p2p', event: { ...tsunami, cancelled: true } as P2PQuakeEvent },
          })
        }
      }
    }

    setState(prev => {
      const now = getTimeRef.current()
      switch (event.code) {
        case 551: {
          let quake = event as JMAQuake
          const m = quake.id?.match(/^dmdata-quake-(\d{14})-/)
          const eventId = m?.[1]
          // DMDATA は ID 埋め込みのタイムスタンプ、P2PQuake は earthquake.time をキーに使う
          const cacheKey = eventId ?? quake.earthquake.time

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

          // DMDATA は同一イベントで VXSE51（targetDateTime）→ VXSE52/53（originTime）の順に届くが、
          // earthquake.time が1分程度ずれるため別カード扱いになる。eventId で同一エントリを特定する。
          const dmdataEventId = quake.id?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1]
          const isSameEntry = (e: JMAQuake): boolean => {
            if (dmdataEventId) {
              const eId = e.id?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1]
              if (eId) return eId === dmdataEventId
            }
            return e.earthquake.time === quake.earthquake.time
          }
          const existing = prev.earthquakes.find(isSameEntry)

          // VXSE61（DestinationAmended）: points を失わないよう震源フィールドのみをマージ
          if (quake.issue.type === 'DestinationAmended') {
            if (existing) {
              const merged: JMAQuake = {
                ...existing,
                time: quake.time,
                issue: quake.issue,
                earthquake: {
                  ...existing.earthquake,
                  hypocenter: quake.earthquake.hypocenter,
                  domesticTsunami: quake.earthquake.domesticTsunami !== 'Unknown'
                    ? quake.earthquake.domesticTsunami
                    : existing.earthquake.domesticTsunami,
                },
              }
              return {
                ...prev,
                earthquakes: sortQuakes([merged, ...prev.earthquakes.filter(e => !isSameEntry(e))]),
                lastUpdate: now,
              }
            }
            // 既存カードなし: 通常追加処理へフォールスルー
          }

          if (existing && (ISSUE_PRIORITY[existing.issue.type] ?? 0) > (ISSUE_PRIORITY[quake.issue.type] ?? 0)) {
            return prev
          }
          const earthquakes = sortQuakes([
            quake,
            ...prev.earthquakes.filter(e => !isSameEntry(e)),
          ])
          return { ...prev, earthquakes, lastUpdate: now }
        }
        case 552: {
          const tsunami = event as JMATsunami
          if (tsunami.cancelled) {
            // id チェック: 古いキューエントリが後続の新しい津波情報をキャンセルしないよう防御する
            if (prev.tsunamis.length > 0 && prev.tsunamis[0].id !== tsunami.id) return prev
            return { ...prev, tsunamis: [], lastUpdate: now }
          }
          // ValidDateTime が過去 = すでに有効期限切れ（ページリロード時など）
          if (tsunami.validDateTime && new Date(tsunami.validDateTime) <= now) {
            return { ...prev, tsunamis: [], lastUpdate: now }
          }
          return { ...prev, tsunamis: [tsunami], lastUpdate: now }
        }
        case 556: {
          const eew = event as EEWAlert
          const key = eew.issue?.eventId ?? eew.id
          if (eew.cancelled || eew.test) {
            const next = new Map(prev.activeEEWs)
            next.delete(key)
            return { ...prev, activeEEWs: next, lastUpdate: now }
          }
          return {
            ...prev,
            activeEEWs: new Map(prev.activeEEWs).set(key, eew),
            lastUpdate: now,
          }
        }
        default:
          return { ...prev, lastUpdate: now }
      }
    })
  }, [])

  // リプレイ時刻オフセットに応じて時刻ソースを切り替える
  useEffect(() => {
    getTimeRef.current = replayTimeOffset !== null
      ? () => new Date(Date.now() + replayTimeOffset)
      : () => new Date()
  }, [replayTimeOffset])

  // キューディスパッチャー: 100ms ごとに eventTime <= 現在時刻のエントリを処理する
  useEffect(() => {
    const id = setInterval(() => {
      const now = getTimeRef.current()
      const q = eventQueueRef.current
      while (q.length > 0 && q[0].eventTime <= now) {
        const { payload, silent } = q.shift()!
        isSilentRef.current = !!silent
        if (payload.kind === 'p2p') {
          handleEvent(payload.event)
        } else if (payload.kind === 'lpgm') {
          const lpgm = payload.data
          setState(prev => {
            const next = new Map(prev.lpgmByOriginTime)
            if (lpgm.cancelled) next.delete(lpgm.originTime)
            else next.set(lpgm.originTime, lpgm)
            return { ...prev, lpgmByOriginTime: next }
          })
          if (!silent && !lpgm.cancelled && lpgm.maxClass >= 1) {
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm } as unknown as P2PQuakeEvent)
          }
        } else if (payload.kind === 'nankai') {
          const nankai = payload.data
          setState(prev => ({ ...prev, nankai: nankai.cancelled ? null : nankai }))
          if (!silent) onLiveEventRef.current?.({ kind: 'nankai', data: nankai } as unknown as P2PQuakeEvent)
        } else if (payload.kind === 'kohatsu') {
          const kohatsu = payload.data
          if (kohatsuExpireTimerRef.current !== undefined) {
            window.clearTimeout(kohatsuExpireTimerRef.current)
            kohatsuExpireTimerRef.current = undefined
          }
          if (!kohatsu.cancelled) {
            const expireMs = new Date(kohatsu.expireAt).getTime() - Date.now()
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
          if (!silent) onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu } as unknown as P2PQuakeEvent)
        }
        isSilentRef.current = false
      }
    }, 100)
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

    // リプレイ中は WebSocket 接続しない
    if (replayTimeOffset !== null) return

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
          const seenQuakes = new Map<string, JMAQuake>()
          for (const q of quakeEvents) {
            const key = q.earthquake.time
            const existing = seenQuakes.get(key)
            if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
              seenQuakes.set(key, q)
            }
          }
          const earthquakes = sortQuakes(Array.from(seenQuakes.values()))
          const allTsunami = tsunamiEvents
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
          const latestTsunami = allTsunami[0]
          const now = new Date()
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
          const lpgmByOriginTime = new Map<string, JMALpgm>()
          for (const lpgm of lpgmEvents) {
            if (lpgm.cancelled) continue
            const existing = lpgmByOriginTime.get(lpgm.originTime)
            if (!existing || lpgm.time > existing.time) {
              lpgmByOriginTime.set(lpgm.originTime, lpgm)
            }
          }

          // 後発地震注意情報の有効期限タイマー（初回ロード時）
          if (kohatsuData && !kohatsuData.cancelled) {
            const expireMs = new Date(kohatsuData.expireAt).getTime() - Date.now()
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
            lpgmByOriginTime,
            nankai: nankaiData ?? null,
            kohatsu: kohatsuData ?? null,
            lastUpdate: new Date(),
            isLoading: false,
            hasMore: !!nextToken,
            error: null,
          }))
          // 初回ロードで津波が有効（validDateTime未来）の場合、キューへ解除イベントを挿入する
          if (tsunamis.length > 0 && latestTsunami?.validDateTime) {
            const expireTime = new Date(latestTsunami.validDateTime)
            if (expireTime > new Date()) {
              insertSorted(eventQueueRef.current, {
                eventTime: expireTime,
                payload: { kind: 'p2p', event: { ...latestTsunami, cancelled: true } as P2PQuakeEvent },
              })
            }
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const msg = err instanceof Error ? err.message : '取得失敗'
          setState(prev => ({ ...prev, isLoading: false, error: msg }))
        })

      // EEW の pref 補完用に細分区域名→都道府県の逆引きインデックスを先読み（取得失敗は無視）
      let areaPrefIndex: Map<string, string> | null = null
      loadStationCoords()
        .then(data => { areaPrefIndex = buildAreaPrefIndex(data) })
        .catch(() => {})

      // DMDSS WebSocket 接続（dmdataTestDelivery 有効時は試験報・訓練報も受信）
      const ws = new DmdataWebSocket(dmdataApiKey, dmdataTestDelivery)
      wsRef.current = null
      ws.onEvent = (ev) => {
        if (ev.kind === 'lpgm') {
          const lpgm = ev.data
          setState(prev => {
            const next = new Map(prev.lpgmByOriginTime)
            if (lpgm.cancelled) next.delete(lpgm.originTime)
            else next.set(lpgm.originTime, lpgm)
            return { ...prev, lpgmByOriginTime: next }
          })
          if (!lpgm.cancelled && lpgm.maxClass >= 1) {
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm } as unknown as P2PQuakeEvent)
          }
        } else if (ev.kind === 'nankai') {
          const nankai = ev.data
          setState(prev => ({ ...prev, nankai: nankai.cancelled ? null : nankai }))
          onLiveEventRef.current?.({ kind: 'nankai', data: nankai } as unknown as P2PQuakeEvent)
        } else if (ev.kind === 'kohatsu') {
          const kohatsu = ev.data
          if (kohatsuExpireTimerRef.current !== undefined) {
            window.clearTimeout(kohatsuExpireTimerRef.current)
            kohatsuExpireTimerRef.current = undefined
          }
          if (!kohatsu.cancelled) {
            const expireMs = new Date(kohatsu.expireAt).getTime() - Date.now()
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
          onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu } as unknown as P2PQuakeEvent)
        } else {
          const data = ev.data
          const enriched = data.code === 556 ? enrichEEWPref(data as EEWAlert, areaPrefIndex) : data
          enqueueEvent(enriched)
        }
      }
      ws.onStatusChange = status =>
        setState(prev => ({ ...prev, connectionStatus: status }))
      ws.onRawMessage = appendTelegramLog
      ws.connect()

      return () => {
        cancelled = true
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
        const seenQuakes = new Map<string, JMAQuake>()
        for (const q of quakeEvents) {
          const key = q.earthquake.time
          const existing = seenQuakes.get(key)
          if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
            seenQuakes.set(key, q)
          }
        }
        const earthquakes = sortQuakes(Array.from(seenQuakes.values()))
        const allTsunami = (tsunamiEvents as JMATsunami[])
          .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        const latestTsunami = allTsunami[0]
        const nowP2p = new Date()
        const tsunamis = latestTsunami
          && !latestTsunami.cancelled
          && !(latestTsunami.validDateTime && new Date(latestTsunami.validDateTime) <= nowP2p)
          ? [latestTsunami] : []
        p2pRawOffsetRef.current = quakeEvents.length
        setState(prev => ({
          ...prev,
          earthquakes,
          tsunamis,
          lastUpdate: new Date(),
          isLoading: false,
          hasMore: quakeEvents.length === MAX_HISTORY_RETAINED,
          error: null,
        }))
        // 初回ロードで津波が有効（validDateTime未来）の場合、キューへ解除イベントを挿入する
        if (tsunamis.length > 0 && latestTsunami?.validDateTime) {
          const expireTime = new Date(latestTsunami.validDateTime)
          if (expireTime > new Date()) {
            insertSorted(eventQueueRef.current, {
              eventTime: expireTime,
              payload: { kind: 'p2p', event: { ...latestTsunami, cancelled: true } as P2PQuakeEvent },
            })
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : '取得失敗'
        setState(prev => ({ ...prev, isLoading: false, error: msg }))
      })

    const ws = new P2PQuakeWebSocket()
    wsRef.current = ws
    // P2PQuake WS の EEW (556) は areas 補完のみに使用し、音・タブ切替は発火させない。
    // Yahoo hypoInfo で検出済みの eventId であれば areas を注入、未知なら全処理（フォールバック）。
    ws.onEvent = (event: P2PQuakeEvent) => {
      if (event.code === 556) {
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
          enrichEEW(key, eew.areas ?? eew.regions ?? [])
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
        setState(prev => {
          const seenKeys = new Set(prev.earthquakes.map(e => e.earthquake.time))
          const seenForBatch = new Map<string, JMAQuake>()
          for (const q of events) {
            const key = q.earthquake.time
            if (seenKeys.has(key)) continue
            const existing = seenForBatch.get(key)
            if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
              seenForBatch.set(key, q)
            }
          }
          return {
            ...prev,
            earthquakes: sortQuakes([...prev.earthquakes, ...Array.from(seenForBatch.values())]),
            isLoadingMore: false,
            hasMore: !!nextToken,
          }
        })
        // 新しく読み込んだ地震に対応する LPGM を追加取得（失敗は無視）
        const newOldest = [...existingQuakes, ...events].reduce<string | null>((acc, q) => {
          const t = q.earthquake.time
          return acc === null || t < acc ? t : acc
        }, null)
        if (newOldest) {
          const lpgmEvents = await fetchDmdataLpgms(apiKey, newOldest).catch(() => [])
          if (lpgmEvents.length > 0) {
            setState(prev => {
              const lpgmByOriginTime = new Map(prev.lpgmByOriginTime)
              for (const lpgm of lpgmEvents) {
                if (lpgm.cancelled) continue
                const existing = lpgmByOriginTime.get(lpgm.originTime)
                if (!existing || lpgm.time > existing.time) {
                  lpgmByOriginTime.set(lpgm.originTime, lpgm)
                }
              }
              return { ...prev, lpgmByOriginTime }
            })
          }
        }
      } else {
        const offset = p2pRawOffsetRef.current
        const events = await fetchJmaQuake(LOAD_MORE_BATCH, offset)
        p2pRawOffsetRef.current += events.length
        setState(prev => {
          const seenKeys = new Set(prev.earthquakes.map(e => e.earthquake.time))
          const seenForBatch = new Map<string, JMAQuake>()
          for (const q of events) {
            const key = q.earthquake.time
            if (seenKeys.has(key)) continue
            const existing = seenForBatch.get(key)
            if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
              seenForBatch.set(key, q)
            }
          }
          return {
            ...prev,
            earthquakes: sortQuakes([...prev.earthquakes, ...Array.from(seenForBatch.values())]),
            isLoadingMore: false,
            hasMore: events.length === LOAD_MORE_BATCH,
          }
        })
      }
    } catch {
      setState(prev => ({ ...prev, isLoadingMore: false }))
    }
  }, [])

  const simulateEarthquake = useCallback(() => {
    handleEvent(createTestEarthquake())
  }, [handleEvent])

  const simulateEEW = useCallback(
    () => runSimulateEEW('special', createTestEEW, 30000, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWWarning = useCallback(
    () => runSimulateEEW('warning', createTestEEWWarning, 30000, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWForecast = useCallback(
    () => runSimulateEEW('forecast', createTestEEWForecast, 30000, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateTsunami = useCallback(
    () => runSimulateTsunami(createTestTsunami, 30000, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunamiWarning = useCallback(
    () => runSimulateTsunami(createTestTsunamiWarning, 30000, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunamiWatch = useCallback(
    () => runSimulateTsunami(createTestTsunamiWatch, 30000, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateTsunamiForecast = useCallback(
    () => runSimulateTsunami(createTestTsunamiForecast, 30000, testTsunamiRef, handleEvent),
    [handleEvent],
  )

  const simulateNankai = useCallback((kindName: '調査中' | '巨大地震注意' | '巨大地震警戒') => {
    const nankai = createTestNankai(kindName)
    setState(prev => ({ ...prev, nankai }))
    onLiveEventRef.current?.({ kind: 'nankai', data: nankai } as unknown as P2PQuakeEvent)
  }, [])

  const simulateKohatsu = useCallback(() => {
    const kohatsu = createTestKohatsu()
    if (kohatsuExpireTimerRef.current !== undefined) window.clearTimeout(kohatsuExpireTimerRef.current)
    const expireMs = new Date(kohatsu.expireAt).getTime() - Date.now()
    if (expireMs > 0) {
      kohatsuExpireTimerRef.current = window.setTimeout(() => {
        kohatsuExpireTimerRef.current = undefined
        setState(prev => ({ ...prev, kohatsu: null }))
      }, expireMs)
    }
    setState(prev => ({ ...prev, kohatsu }))
    onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu } as unknown as P2PQuakeEvent)
  }, [])

  const resetState = useCallback(() => {
    setState(prev => ({
      ...prev,
      earthquakes: [],
      tsunamis: [],
      activeEEWs: new Map(),
      lpgmByOriginTime: new Map(),
      nankai: null,
      kohatsu: null,
    }))
    eventQueueRef.current = []
    quakeIntensityCacheRef.current.clear()
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
    simulateEEW, simulateEEWWarning, simulateEEWForecast,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast,
    simulateNankai, simulateKohatsu,
    resetState,
    loadReplayEvents,
  }
}
