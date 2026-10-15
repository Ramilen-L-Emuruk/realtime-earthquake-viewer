import { useEffect, useMemo, useRef, useState } from 'react'
import { publicStationHeading } from '../components/SeismoWaveChart'
import { PUBLIC_WAVE_UNIT } from '../components/SeismoWaveChart/waveUnit'
import type { JMAQuake } from '../types/earthquake'
import { fetchPublicWaveArchive } from '../services/publicWaveArchive'
import { serverNow } from '../utils/clock'
import { hasDepth, hasMagnitude } from '../utils/formatters'
import { hasKnownEpicenter } from '../utils/geo'
import { log } from '../utils/logger'
import { groupMseed2ByStation } from '../utils/miniseed2Stream'
import { decodePublicQuakeWave, hasSamplesFrom, publicQuakeColumns } from '../utils/publicQuakeColumns'
import { isPublicWaveRangeSettled, publicWaveRange, type PublicWaveRange } from '../utils/publicQuakeRange'
import { publicWaveKey, readPublicWave, writePublicWave } from '../utils/publicQuakeWaveDb'
import { quakeEventKey } from '../utils/quakeMerge'
import { parseJstTimeMs, type OriginSeconds } from '../utils/quakeOriginSeconds'
import { activeEpochsAt, checkPublicStations, subscribePublicStations, loadPublicStations, type PublicStationEpoch, type PublicStationsFile } from '../utils/publicStations'
import { candidateCodes, selectPublicStations, type PublicSelectionSource } from '../utils/publicStationSelection'
import { publicWaveCacheVerdict, PUBLIC_WAVE_MAX_RETRIES, type PublicWaveEntryState } from '../utils/publicWaveStoreLogic'
import type { SeismoWaveWindow } from '../utils/seismoWaveBuffer'
import { appendWaveWindow, type TimedColumns } from '../utils/seismoWaveColumns'
import { computeHypocentralDistanceKm, computeWaveArrival, type WaveArrival } from '../utils/seismoWaveArrival'
import { computeReachBand, MINUTE_MS, type WaveAxisZero } from '../utils/seismoQuakeWindow'
import type { SeismoQuakeWave } from './useSeismoQuakeWaves'

/**
 * 地震カードに出す公開観測点の波形（`docs/public-waveform-design.md` §6）。取得・控え・継ぎ足しは**この App 層のフック**が持ち、
 * カードは描くだけ（自作地震計の `useSeismoQuakeWaves` と同じ理由 —— 描画側に置くと、カードを畳んだ間・タブが隠れた間は止まる）。
 *
 * - **新しい地震から順に {@link PREFETCH_QUAKES} 件まで先に取り、端末に控える。それより古いカードは開いたときに取る**（§0）
 * - 範囲はカードの分の頭の 60 秒前〜4 分後。遠い観測点は S 波の到達まで伸ばす。次の地震の発生で切る（`utils/publicQuakeRange.ts`）
 * - 保存庫へ入りきる前に取った分は仮の控えにし、入りきってから 1 回だけ取り直す（§0・§6.2）
 * - **揺れている最中の地震は、下部の波形が SeedLink で受けている分から継ぎ足す**（§0）。番号も下部の波形と揃える（2026-10-15 ユーザー決定）
 * - **再生中も取る**（地震の時刻を指定して保存庫から取るので、いまの値が過去の画面へ混ざらない）。
 *   **出すのは再生時刻まで**（取った範囲は発生の数分後まであるので、出す直前に切る。控えと `Slot` は時刻によらない形のまま）
 */

/** 先に取る地震の数（§0）。 */
export const PREFETCH_QUAKES = 100
/**
 * 下部の波形の番号を引き継ぐ地震の見分け方: いちばん新しい地震で、発生から {@link LIVE_QUAKE_MS} 以内。
 * **下部の波形は地震ではなく揺れの材料（速報・揺れ検知）で選ぶ**ので、どの地震カードのことかを直接は持たない。
 */
const LIVE_QUAKE_MS = 10 * 60_000
/** 仮の控えを見直す間隔（ms）。範囲が入りきったら取り直す。 */
const RECHECK_MS = 30_000
/** 同じ分の別地震で範囲が潰れないための下限（自作地震計の `MIN_WINDOW_MS` と同じ）。 */
const MIN_WINDOW_MS = 30_000
/** 取れなかった（通信の失敗・時間切れ・状態番号の誤り）ときに、次に試すまで空ける長さ（ms）。仮の値（設計書 §12）。 */
const FAILURE_RETRY_MS = 5 * 60_000
/** 取れなかったときに取りに行く回数の上限（初回を含む。この起動の間）。仮の値（設計書 §12）。 */
const FAILURE_MAX_TRIES = 2

export interface PublicQuakeWave {
  readonly code: string
  readonly number: number
  readonly nameJa: string
  readonly lat: number
  readonly lon: number
  readonly range: PublicWaveRange
  /** 生のサンプル（保存庫の分。詳細の窓に描く）。 */
  readonly window: SeismoWaveWindow | null
  /**
   * カードに描く形（自作地震計と同じ型。描き方を共有する）。**参照は変わったときだけ作り直す** ——
   * 描く側は列・到達・時間軸の 0 の参照で描き直すので、出すたびに作ると関わりのないカードまで描き直す。
   */
  readonly card: SeismoQuakeWave
}

interface QuakeTarget {
  readonly eventKey: string
  readonly originMs: number
  /** P/S 線の起点（秒まで取れた発生時刻）。取れなければ `null`。 */
  readonly arrivalOriginMs: number | null
  readonly arrivalOriginSource: OriginSeconds['source'] | null
  readonly source: PublicSelectionSource
  readonly hypocenter: JMAQuake['earthquake']['hypocenter']
  readonly cutoffMs: number | null
}

/** 対象の地震（最大震度を持つ＝有感、震央の位置が分かる）を新しい順に。次の地震の発生で切る位置も付ける。 */
export function pickPublicQuakeTargets(quakes: readonly JMAQuake[], originSeconds: ReadonlyMap<string, OriginSeconds>): QuakeTarget[] {
  const seen = new Set<string>()
  const found: Omit<QuakeTarget, 'cutoffMs'>[] = []
  for (const q of quakes) {
    if (!q.earthquake.maxScale || q.earthquake.maxScale <= 0) continue
    const h = q.earthquake.hypocenter
    if (!hasKnownEpicenter(h.latitude, h.longitude)) continue
    const originMs = parseJstTimeMs(q.earthquake.time)
    if (!Number.isFinite(originMs)) continue
    const eventKey = quakeEventKey(q)
    if (seen.has(eventKey)) continue
    seen.add(eventKey)
    found.push({
      eventKey,
      originMs,
      arrivalOriginMs: originSeconds.get(eventKey)?.originMs ?? null,
      arrivalOriginSource: originSeconds.get(eventKey)?.source ?? null,
      hypocenter: h,
      source: {
        kind: 'hypocenter',
        lat: h.latitude,
        lon: h.longitude,
        depthKm: hasDepth(h.depth) ? h.depth : null,
        magnitude: hasMagnitude(h.magnitude) ? h.magnitude : null,
        assumed: false,
      },
    })
  }
  found.sort((a, b) => b.originMs - a.originMs)
  return found.map((t, i) => ({ ...t, cutoffMs: i === 0 ? null : Math.max(found[i - 1].originMs, t.originMs + MIN_WINDOW_MS) }))
}

/** 現在の地震・観測点から取る範囲を決める（取得と、取得後の切り戻しで共用）。 */
function rangeForStation(target: QuakeTarget, epoch: PublicStationEpoch): PublicWaveRange | null {
  const arrival = computeWaveArrival({ originMs: target.arrivalOriginMs ?? target.originMs, hypocenter: target.hypocenter, stationLat: epoch.lat, stationLon: epoch.lon })
  return publicWaveRange({ originMs: target.originMs, cutoffMs: target.cutoffMs, sArrivalMs: arrival?.sMs ?? null })
}

/** 観測点 × 地震の 1 件ぶん。 */
interface Slot {
  wave: PublicQuakeWave | null
  epoch: PublicStationEpoch
  rawBytes: Uint8Array | null
  /** 取りに行っている・控えを読んでいる最中。 */
  busy: boolean
  /** もう取り直さない（入りきってから取った・確かな不在・取り直しの上限に達した）。 */
  done: boolean
  /** 取った範囲の終わり（次の地震で切る位置が緩んで範囲が伸びたら、もう一度見る）。 */
  toMs: number
  /** 取れなかった回数と、次に試してよい時刻。 */
  failures: number
  retryAtMs: number
}

export function usePublicQuakeWaves(params: {
  readonly enabled: boolean
  readonly quakes: readonly JMAQuake[]
  readonly originSeconds: ReadonlyMap<string, OriginSeconds>
  /** 開いているカードの地震の鍵。先に取る範囲より古くても、開いたら取る。 */
  readonly openedEventKey: string | null
  /** 下部の波形に公開観測点を出している間、その番号（観測点のコード → 番号）。出していなければ `null`。 */
  readonly liveNumbers: ReadonlyMap<string, number> | null
  /** 下部の波形が受けている分（平均を引かない）。揺れている最中の地震へ継ぎ足す。 */
  readonly readLiveRaw: (code: string, fromMs: number | null) => SeismoWaveWindow | null
  /** 再生中の時刻のずれ（ms）。ライブなら `null`。再生中は再生時刻より先を出さない。 */
  readonly replayOffsetMs: number | null
}): ReadonlyMap<string, readonly PublicQuakeWave[]> {
  const { enabled, quakes, originSeconds, openedEventKey, liveNumbers, readLiveRaw, replayOffsetMs } = params
  const replaying = replayOffsetMs !== null

  const [file, setFile] = useState<PublicStationsFile | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const unsubscribe = subscribePublicStations(next => { if (!cancelled) setFile(next) })
    loadPublicStations()
      .then((f) => {
        if (!cancelled) setFile(f)
      })
      .catch((e) => log.warn('[public-wave] 公開観測点の表を読めなかった（地震カード）', e))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [enabled])

  const targets = useMemo(() => (enabled ? pickPublicQuakeTargets(quakes, originSeconds) : []), [enabled, quakes, originSeconds])
  useEffect(() => {
    if (enabled && file !== null && targets.length > 0) void checkPublicStations()
  }, [enabled, file, targets.length])


  // 地震ごとの観測点と番号。**下部の波形に出ている地震は、その番号を引き継ぐ**（地図の印と揃えるため）。
  const liveKey = targets.length > 0 && serverNow() - targets[0].originMs <= LIVE_QUAKE_MS && liveNumbers !== null ? targets[0].eventKey : null
  const picks = useMemo(() => {
    const out = new Map<string, { target: QuakeTarget; stations: { epoch: PublicStationEpoch; number: number }[] }>()
    if (file === null) return out
    for (const t of targets) {
      const epochs = activeEpochsAt(file, t.originMs)
      // **引き継ぐのはこの地震の候補に入る観測点の番号だけ**（下部の波形は揺れの材料で選ぶので、別の揺れの観測点を持っていることがある）。
      // 番号は元のまま（欠番は許す）—— 地図の印と同じ番号を名乗るため
      const numbers = new Map<string, number>()
      if (t.eventKey === liveKey && liveNumbers !== null) {
        const candidates = new Set(candidateCodes(epochs, t.source, null))
        for (const [code, n] of liveNumbers) if (candidates.has(code)) numbers.set(code, n)
      }
      const prev = { numbers }
      const { selected } = selectPublicStations({ prev, epochs, source: t.source, detection: null })
      if (selected.length > 0) out.set(t.eventKey, { target: t, stations: selected })
    }
    return out
  }, [file, targets, liveKey, liveNumbers])

  // --- 取る・控える ---
  const slotsRef = useRef(new Map<string, Slot>())
  const [version, setVersion] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!enabled) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    return () => {
      ctrl.abort()
      abortRef.current = null
      slotsRef.current.clear()
    }
  }, [enabled])

  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setTick((n) => n + 1), RECHECK_MS)
    return () => clearInterval(timer)
  }, [enabled])

  useEffect(() => {
    const ctrl = abortRef.current
    if (!enabled || ctrl === null) return
    const order = targets.filter((t) => picks.has(t.eventKey))
    order.forEach((t, index) => {
      const eligible = index < PREFETCH_QUAKES || t.eventKey === openedEventKey
      if (!eligible) return
      const urgent = t.eventKey === openedEventKey
      const jobs: StationJob[] = []
      for (const s of picks.get(t.eventKey)!.stations) {
        const range = rangeForStation(t, s.epoch)
        if (range === null) continue
        const slotKey = `${t.eventKey}|${s.epoch.code}`
        const prev = slotsRef.current.get(slotKey)
        if (prev?.busy) continue
        const extended = prev !== undefined && range.toMs > prev.toMs
        if (prev?.done && !extended) continue
        // 失敗の上限と待ちは、範囲が伸びたときも守る（伸びるたびに取り直すと上限が効かない）
        if (prev !== undefined && prev.failures >= FAILURE_MAX_TRIES) continue
        if (prev !== undefined && Date.now() < prev.retryAtMs) continue
        const slot: Slot = prev ?? { wave: null, epoch: s.epoch, rawBytes: null, busy: false, done: false, toMs: range.toMs, failures: 0, retryAtMs: 0 }
        slot.busy = true
        slotsRef.current.set(slotKey, slot)
        jobs.push({ slot, epoch: s.epoch, number: s.number, range })
      }
      if (jobs.length === 0) return
      void loadQuake({ target: t, jobs, urgent, signal: ctrl.signal })
        .catch((e) => log.warn(`[public-wave] ${t.eventKey} の公開観測点の波形を組み立てられなかった`, e))
        .finally(() => {
          for (const j of jobs) j.slot.busy = false
          if (!ctrl.signal.aborted) setVersion((v) => v + 1)
        })
    })
    // `tick` は仮の控えの見直し（範囲が入りきったら取り直す）
  }, [enabled, targets, picks, openedEventKey, tick])

  // --- 揺れている最中の地震へ、下部の波形の分を継ぎ足す ---
  const [liveTick, setLiveTick] = useState(0)
  /** 再生時刻でまだ切っている（範囲の終わりが再生時刻より先の）地震があるか。出すたびに数え直す。 */
  const revealingRef = useRef(false)
  useEffect(() => {
    if (liveKey === null && !replaying) return
    const timer = setInterval(() => {
      if (liveKey !== null || revealingRef.current) setLiveTick((n) => n + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [liveKey, replaying])

  // 直前に出した内容。**変わっていない地震は同じ配列を使い回す**（継ぎ足しの巡回は 1 秒ごとに出し直すので、
  // 毎回作り直すと関わりのない地震のカードまで描き直される）。
  const publishedRef = useRef<ReadonlyMap<string, readonly PublicQuakeWave[]>>(new Map())
  // 取得の完了とは別に、後から判明した発生秒・震源・番号を現在の材料で組む。
  // 同じ波形と材料の組では参照を保ち、1秒の再生巡回で関係のないカードを描き直さない。
  const rebasedRef = useRef(new WeakMap<PublicQuakeWave, { target: QuakeTarget; epoch: PublicStationEpoch; number: number; wave: PublicQuakeWave }>())
  return useMemo(() => {
    const out = new Map<string, readonly PublicQuakeWave[]>()
    // Appの共有時計はeffectで更新されるため、レンダーでは引数の時間軸を直接使う。
    const revealUntilMs = replayOffsetMs === null ? null : Date.now() + replayOffsetMs
    let revealing = false
    for (const [eventKey, pick] of picks) {
      const waves: PublicQuakeWave[] = []
      for (const s of pick.stations) {
        const slot = slotsRef.current.get(`${eventKey}|${s.epoch.code}`)
        const stored = slot?.wave ?? null
        if (stored === null) continue
        let rebased = rebasedRef.current.get(stored)
        if (rebased === undefined || rebased.target !== pick.target || rebased.epoch !== s.epoch || rebased.number !== s.number) {
          const range = rangeForStation(pick.target, s.epoch)
          if (range === null) continue
          const shortened = range.toMs < stored.range.toMs
          const metadataChanged = slot!.epoch !== s.epoch
          const decoded = metadataChanged && slot!.rawBytes !== null ? decodePublicQuakeWave({ bytes: slot!.rawBytes, epoch: s.epoch, range }) : null
          const sourceWindow = metadataChanged ? decoded?.window ?? null : stored.window
          const window = shortened && sourceWindow !== null ? clipWindow(sourceWindow, range.toMs) : sourceWindow
          if (window === null || !hasSamplesFrom(window, pick.target.originMs)) continue
          const columns = shortened || metadataChanged ? publicQuakeColumns(window, range) : stored.card.columns
          rebased = {
            target: pick.target,
            epoch: s.epoch,
            number: s.number,
            wave: {
              ...stored,
              nameJa: s.epoch.nameJa,
              lat: s.epoch.lat,
              lon: s.epoch.lon,
              number: s.number,
              range: shortened ? range : stored.range,
              window,
              card: buildCardWave({
                code: stored.code,
                heading: publicStationHeading(s.number, s.epoch.nameJa),
                lat: s.epoch.lat,
                lon: s.epoch.lon,
                target: pick.target,
                columns,
                window,
              }),
            },
          }
          rebasedRef.current.set(stored, rebased)
        }
        let wave = eventKey === liveKey ? spliceLive(rebased.wave, readLiveRaw) : rebased.wave
        if (revealUntilMs !== null && wave.range.toMs > revealUntilMs) {
          revealing = true
          const cut = revealUpTo(wave, revealUntilMs, pick.target.originMs)
          if (cut === null) continue
          wave = cut
        }
        waves.push(wave)
      }
      if (waves.length === 0) continue
      waves.sort((a, b) => a.number - b.number)
      const before = publishedRef.current.get(eventKey)
      const same = before !== undefined && before.length === waves.length && before.every((w, i) => w === waves[i])
      out.set(eventKey, same ? before : waves)
    }
    publishedRef.current = out
    revealingRef.current = revealing
    return out
    // `version` は取れた知らせ、`liveTick` は継ぎ足し・再生時刻で切る分の巡回
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, liveKey, version, liveTick, readLiveRaw, replaying, replayOffsetMs])
}

/** 地震 1 件のうち、取る（控えを読む）観測点 1 つぶん。 */
interface StationJob {
  readonly slot: Slot
  readonly epoch: PublicStationEpoch
  readonly number: number
  readonly range: PublicWaveRange
}

/**
 * 地震 1 件ぶんの観測点を控えから読み、取り直すものは **1 回の問い合わせにまとめて**取る（`sta=` に並べる。
 * 2026-10-15 に 20 点まで並べて返ることを測った。`docs/public-waveform-design.md` §3.5）。観測点ごとに問い合わせると、
 * 問い合わせの数が観測点の数だけ増える。
 *
 * 範囲は観測点ごとに違う（遠い観測点は S 波まで伸ばす）ので、**問い合わせは観測点の範囲を合わせた区間**で投げ、
 * 控えと絵は観測点ごとの範囲で作る。応答に載らなかった観測点は「データが無い」と同じ扱い（入りきってからなら確かな不在）。
 */
async function loadQuake(job: {
  readonly target: QuakeTarget
  readonly jobs: readonly StationJob[]
  readonly urgent: boolean
  readonly signal: AbortSignal
}): Promise<void> {
  const { target, jobs, signal } = job
  // **「入りきったか」は本当のいまで測る**（再生中の時刻ではない。保存庫に入ったかどうかは本当の時刻で決まる）
  const now = Date.now()
  const prepared = await Promise.all(
    jobs.map(async (j) => {
      const key = publicWaveKey(j.epoch.code, target.originMs)
      const settled = isPublicWaveRangeSettled(j.range, now)
      const cached = await readPublicWave(key)
      const verdict = cached === null ? 'refetch' : publicWaveCacheVerdict(cached.meta, j.range.toMs, settled)
      return { j, key, settled, cached, verdict, bytes: cached?.bytes ?? null, failed: false }
    }),
  )
  if (signal.aborted) return
  const failedAttempt = (p: (typeof prepared)[number]) => {
    p.failed = true
    p.j.slot.failures += 1
    p.j.slot.retryAtMs = Date.now() + FAILURE_RETRY_MS
  }
  const refetch = prepared.filter((p) => p.verdict === 'refetch')
  if (refetch.length > 0) {
    const range: PublicWaveRange = {
      fromMs: Math.min(...refetch.map((p) => p.j.range.fromMs)),
      toMs: Math.max(...refetch.map((p) => p.j.range.toMs)),
    }
    const res = await fetchPublicWaveArchive({ stations: refetch.map((p) => p.j.epoch.code), range, signal, urgent: job.urgent })
    if (res.kind === 'aborted') return
    let byStation: ReadonlyMap<string, Uint8Array> | null = null
    if (res.kind === 'ok') {
      const grouped = groupMseed2ByStation(res.bytes)
      if (grouped.unreadable.length > 0 || grouped.trailingBytes > 0) {
        log.warn(
          `[public-wave] 保存庫の応答（${target.eventKey}）で読めないレコード ${grouped.unreadable.length} 本・端数 ${grouped.trailingBytes} バイト`,
        )
      }
      if (grouped.unreadable.length > 0 || grouped.trailingBytes > 0) {
        // どの観測点のレコードが欠けたか確定できない。読めた分は使うが、正常・不在とも確定保存しない。
        for (const p of refetch) {
          failedAttempt(p)
          p.bytes = grouped.byStation.get(p.j.epoch.code) ?? p.bytes
        }
      } else {
        byStation = grouped.byStation
      }
    } else {
      // **問い合わせ全体が「データが無い」（404）も失敗に数える。** 2026-10-15 に、保存庫が数分のあいだ
      // 何を頼んでも 404 を返した（同じ範囲が約 10 分後には 200 で返った）。全部が 404 を確かな不在として
      // 控えると、その地震は二度と取りに行かない。応答があって一部の観測点だけ載っていないときは、その観測点を不在にする（下）
      for (const p of refetch) failedAttempt(p)
      log.warn(
        `[public-wave] 保存庫から ${refetch.map((p) => p.j.epoch.code).join(',')} の波形を取れなかった（${res.kind === 'no-data' ? '全観測点が 404' : res.kind}${res.kind === 'http-error' ? ` ${res.status}` : ''}・${refetch[0].j.slot.failures} 回目）`,
      )
    }
    if (byStation !== null) {
      for (const p of refetch) {
        const bytes = byStation.get(p.j.epoch.code) ?? null
        // 「データが無い」が確かなのは範囲が入りきってからだけ
        const state: PublicWaveEntryState =
          bytes !== null ? (p.settled ? 'settled' : 'provisional') : p.settled ? 'absent' : 'provisional'
        let retries = p.cached?.meta.retries ?? 0
        if (p.cached !== null && p.cached.meta.state === 'provisional') retries = Math.min(PUBLIC_WAVE_MAX_RETRIES, retries + 1)
        const ok = await writePublicWave(
          { key: p.key, originMs: target.originMs, state, toMs: p.j.range.toMs, fetchedAtMs: Date.now(), retries },
          bytes,
        )
        if (!ok) log.debug(`[public-wave] ${p.j.epoch.code} の波形を控えに書けなかった（そのまま出す）`)
        p.j.slot.toMs = p.j.range.toMs
        p.j.slot.done = state !== 'provisional' || retries >= PUBLIC_WAVE_MAX_RETRIES
        p.bytes = bytes
      }
    }
  }
  if (signal.aborted) return
  for (const p of prepared) {
    if (p.verdict !== 'refetch') {
      p.j.slot.toMs = p.cached!.meta.toMs
      p.j.slot.done = p.verdict === 'use'
    }
    // 取れなかった回は、前に出していた絵を残す。まだ何も出していなければ、控えにある分（仮の控え）を出す
    if (p.failed) {
      if (p.j.slot.wave !== null) continue
      p.bytes = p.bytes ?? p.cached?.bytes ?? null
      if (p.bytes === null) continue
    }
    const { epoch, range } = p.j
    p.j.slot.epoch = epoch
    p.j.slot.rawBytes = p.bytes
    const decoded = p.bytes === null ? null : decodePublicQuakeWave({ bytes: p.bytes, epoch, range })
    if (decoded !== null && (decoded.unreadable > 0 || decoded.rejected > 0)) {
      log.debug(`[public-wave] ${epoch.code} の控えで読めない ${decoded.unreadable} 本・置かない ${decoded.rejected} 本`)
    }
    const window = decoded?.window ?? null
    // 発生より後のサンプルが無い（保存庫に後ろがまだ入っていない）間は出さない。範囲が入りきったら取り直す
    p.j.slot.wave =
      window === null || !hasSamplesFrom(window, target.originMs)
        ? null
        : {
            code: epoch.code,
            number: p.j.number,
            nameJa: epoch.nameJa,
            lat: epoch.lat,
            lon: epoch.lon,
            range,
            window,
            card: buildCardWave({
              code: epoch.code,
              heading: publicStationHeading(p.j.number, epoch.nameJa),
              lat: epoch.lat,
              lon: epoch.lon,
              target,
              columns: publicQuakeColumns(window, range),
              window,
            }),
          }
  }
}

/**
 * 保存庫の分の後ろへ、下部の波形が受けている分を継ぐ。**平均は継いだ後に 1 回だけ引く**（別々に引くと継ぎ目で段差が出る）——
 * 保存庫の分の平均を、受けている分にも同じだけ当てる。
 */
function spliceLive(wave: PublicQuakeWave, readLiveRaw: (code: string, fromMs: number | null) => SeismoWaveWindow | null): PublicQuakeWave {
  const live = readLiveRaw(wave.code, wave.range.fromMs)
  if (live === null || wave.window === null) return wave
  // 保存庫の分は窓の平均を引いてある。受けている分の生の値からも、重なる区間で揃う平均を引く
  const offsets: [number, number, number] = [0, 0, 0]
  for (let a = 0; a < 3; a += 1) {
    const archived = wave.window.gal[a]
    const raw = live.gal[a]
    let sum = 0
    let n = 0
    for (let i = 0; i < raw.length; i += 1) {
      const t = live.firstSampleMs + i * live.msPerSample
      const j = Math.round((t - wave.window.firstSampleMs) / wave.window.msPerSample)
      if (j < 0 || j >= archived.length) continue
      const d = raw[i] - archived[j]
      if (Number.isFinite(d)) {
        sum += d
        n += 1
      }
    }
    // 重なりが無ければ受けている分の平均を引く（継ぎ目の段差は残りうる）
    if (n > 0) offsets[a] = sum / n
    else {
      let s2 = 0
      let n2 = 0
      for (const v of raw) if (Number.isFinite(v)) (s2 += v), (n2 += 1)
      offsets[a] = n2 > 0 ? s2 / n2 : 0
    }
  }
  const shifted: SeismoWaveWindow = {
    ...live,
    gal: [0, 1, 2].map((a) => live.gal[a].map((v) => v - offsets[a])) as unknown as SeismoWaveWindow['gal'],
  }
  const columns = appendWaveWindow({ base: wave.card.columns, window: shifted, limitMs: wave.range.toMs })
  return columns === wave.card.columns ? wave : { ...wave, card: { ...wave.card, columns } }
}

/** 窓を `untilMs` 以前のサンプルだけに切る。1 つも残らなければ `null`。 */
function clipWindow(window: SeismoWaveWindow, untilMs: number): SeismoWaveWindow | null {
  const n = Math.floor((untilMs - window.firstSampleMs) / window.msPerSample) + 1
  if (!(n > 0)) return null
  if (n >= window.gal[0].length) return window
  return {
    ...window,
    gal: [window.gal[0].subarray(0, n), window.gal[1].subarray(0, n), window.gal[2].subarray(0, n)],
    memberCount: window.memberCount.subarray(0, n),
  }
}

/**
 * 再生中、再生時刻より先を出さない形にする（列も詳細の窓の生のサンプルも）。発生より後が 1 つも無ければ出さない
 * （取得中と同じ扱い）。**平均は切る前の窓で引いたまま**にする —— 切るたびに引き直すと、再生が進むにつれて線が上下に動く。
 */
function revealUpTo(wave: PublicQuakeWave, untilMs: number, originMs: number): PublicQuakeWave | null {
  const window = wave.window === null ? null : clipWindow(wave.window, untilMs)
  if (window === null || !hasSamplesFrom(window, originMs)) return null
  const base: TimedColumns = { fromMs: wave.range.fromMs, columnSpanMs: wave.card.columns.columnSpanMs, columns: [] }
  const columns = appendWaveWindow({ base, window, limitMs: Math.min(untilMs, wave.range.toMs) })
  return { ...wave, window, card: { ...wave.card, columns, samples: { kind: 'held', window } } }
}

/**
 * カードに描く形へ組む。時間軸の 0・届きうる時間帯・P/S 線は自作地震計のカードと同じ決め方
 * （`useSeismoQuakeWaves` の `axisZeroOf`）—— **秒が取れていない地震は線を引かない**。
 *
 * 自作地震計にしか無い項目は固定の値にする: 震度は訊かない（`null`）・伸ばさない（`complete`）・途切れは見ない。
 */
function buildCardWave(p: {
  readonly code: string
  readonly heading: string
  readonly lat: number
  readonly lon: number
  readonly target: QuakeTarget
  readonly columns: TimedColumns
  readonly window: SeismoWaveWindow | null
}): SeismoQuakeWave {
  const { target } = p
  const axisZero: WaveAxisZero =
    target.arrivalOriginMs !== null && target.arrivalOriginSource !== null
      ? { kind: 'origin', ms: target.arrivalOriginMs, source: target.arrivalOriginSource }
      : { kind: 'minute', ms: Math.floor(target.originMs / MINUTE_MS) * MINUTE_MS }
  const fromZero: WaveArrival | null = computeWaveArrival({
    originMs: axisZero.ms,
    hypocenter: target.hypocenter,
    stationLat: p.lat,
    stationLon: p.lon,
  })
  return {
    // 自作地震計の観測点 ID と混ざらないよう、出どころを前に付ける（カードの並びの鍵にもなる）
    stationId: `public:${p.code}`,
    displayName: p.heading,
    columns: p.columns,
    arrival: axisZero.kind === 'origin' ? fromZero : null,
    axisZero,
    reach: computeReachBand(axisZero, fromZero),
    interrupted: false,
    complete: true,
    intensity: null,
    distanceKm: computeHypocentralDistanceKm({ hypocenter: target.hypocenter, stationLat: p.lat, stationLon: p.lon }),
    samples: { kind: 'held', window: p.window },
    unit: PUBLIC_WAVE_UNIT,
  }
}
