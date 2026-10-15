// 公開観測点（気象庁の広帯域地震計・EarthScope の JP 網）の下部の波形（`docs/public-waveform-design.md` §4・§5）。
//
// **出すのは揺れているとき**（揺れ検知か発表中の緊急地震速報があり、選んだ観測点が 1 点でもある。§0・§5.1）。
// 揺れが収まっても余韻のあいだは出したまま（自作地震計の下部の波形と同じ 60 秒）。余韻が明けたら選び方の記憶を捨てる
// （次の揺れでは番号を 1 から振る）。
//
// **繋ぐのは出すときだけ**。設定で繋ぎっぱなしにもできる（§0）。繋ぎ方は `services/publicWaveShare.ts`
// （タブどうしで 1 本）と `services/publicWaveLink.ts`（1 本の面倒を見る）。
//
// **再生（テスト時刻設定）中は、再生時刻の分を保存庫から取る**（§0）。SeedLink は使わない —— リングは約 15 分しか残っておらず、
// 遡って繋ぐと「いま」までを一気に流してきて、再生時刻の分が抱えきれずに押し出される。取る範囲は
// `utils/publicReplayPlan.ts`（5 分ずつ先取り・いまから 2 分より新しい範囲は頼まない）。取りに行くのはライブと同じく、
// 出しているときか「公開観測点に常時接続」がオンのとき。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import { hasDepth, hasMagnitude } from '../utils/formatters'
import { isProvisionalHypocenter } from '../utils/eew'
import type { DetectedPoint } from '../utils/kyoshinDetectionView'
import { kyoshinIndexToJma } from '../utils/kyoshinIntensity'
import { log } from '../utils/logger'
import type { Mseed2Record } from '../utils/miniseed2'
import { activeEpochsAt, checkPublicStations, subscribePublicStations, loadPublicStations, type PublicStationsFile, type PublicStationEpoch } from '../utils/publicStations'
import { splitMseed2Stream } from '../utils/miniseed2Stream'
import { pushPublicRecord } from '../utils/publicQuakeColumns'
import { planPublicReplayFetch, PUBLIC_REPLAY_CHUNK_MS, PUBLIC_REPLAY_LEAD_MS, type PublicReplayFetched } from '../utils/publicReplayPlan'
import { EMPTY_PUBLIC_SELECTION, selectPublicStations, type PublicSelectionSource, type PublicSelectionState, type SelectedPublicStation } from '../utils/publicStationSelection'
import { PublicWaveBuffer } from '../utils/publicWaveBuffer'
import type { SeismoWaveWindow } from '../utils/seismoWaveBuffer'
import { serverNow } from '../utils/clock'
import { MAX_WAVE_SPAN_SEC } from '../utils/waveSpan'
import { defaultPublicLinkDeps, PublicWaveLink, type PublicLinkStatus } from '../services/publicWaveLink'
import { PublicWaveShare, type ShareChannel } from '../services/publicWaveShare'
import { fetchPublicWaveArchive } from '../services/publicWaveArchive'

/** 揺れの条件が外れてから絵を引っ込めるまで（ms）。自作地震計の下部の波形と同じ。 */
const LINGER_MS = 60_000

/**
 * 最後に届いてからこれを超えたら途絶とみなす（ms）。届く単位が約 21 秒なので、自作地震計の 5 秒は使えない（§5.3）。
 * **長さは揺れている間の届き方を測ってから決める**（§12「途絶と黙りの長さ」）。仮に 60 秒。
 */
export const PUBLIC_WAVE_STALE_MS = 60_000

/** 途絶を見直す間隔（ms）。 */
const STALE_CHECK_MS = 5_000

/** 再生中に先取りの要否を見直す間隔（ms）。 */
const REPLAY_CHECK_MS = 2_000
/** 再生中に保存庫から取れなかったとき、次に試すまで空ける長さ（ms）。仮の値（設計書 §12）。 */
const REPLAY_RETRY_MS = 30_000
/**
 * 再生中に抱える長さ（秒）。**先取りした分（いちばん先は再生時刻の 1 回ぶん先）まで抱えたうえで、表示の幅ぶん遡れること。**
 * 入れ物は新しいサンプルから数えて古い端を落とすので、先取りの分だけ長くしないと表示の左側が先に消える。
 */
const REPLAY_RETAIN_SEC = MAX_WAVE_SPAN_SEC + (PUBLIC_REPLAY_CHUNK_MS + PUBLIC_REPLAY_LEAD_MS) / 1000 + 60

export interface PublicWaveStation {
  readonly code: string
  readonly number: number
  readonly nameJa: string
  readonly lat: number
  readonly lon: number
  /** 最後に届いてから {@link PUBLIC_WAVE_STALE_MS} を超えた。**一度も届いていない間も真**（出していない絵を生きて見せない）。 */
  readonly stale: boolean
}

export interface PublicWaves {
  /** 出すか（揺れていて、選んだ観測点が 1 点でもある）。 */
  readonly visible: boolean
  /** 出す観測点（番号順）。 */
  readonly stations: readonly PublicWaveStation[]
  readonly status: PublicLinkStatus
  /** その観測点の波形（速度 μm/s）。`fromMs` より前は写さない。 */
  readonly readWave: (code: string, fromMs: number | null) => SeismoWaveWindow | null
  /**
   * {@link readWave} と同じだが**平均を引かない**。地震カードが保存庫の分と継いでから 1 回だけ引くためのもの
   * （別々に引くと継ぎ目で段差が出る）。
   */
  readonly readRawWave: (code: string, fromMs: number | null) => SeismoWaveWindow | null
}

/**
 * いちばん強い検知点。**震度1 以上の点だけを見る**（2026-10-15 ユーザー承認「震度 1 以上の検知だけ（推奨）」）。
 * 震度0 だけの検知は材料にしない —— 強震モニタでは震度0 と震度1 の階級値が同じなので、震度0 まで通すと
 * 平常時のノイズで出っぱなしになる（自作地震計の自動表示の `WAVE_TRIGGER_MIN_SCALE` と同じ理由）。無ければ `null`。
 */
export function strongestDetection(points: readonly DetectedPoint[]): { lat: number; lon: number } | null {
  let best: DetectedPoint | null = null
  for (const p of points) {
    const jma = kyoshinIndexToJma(p.index)
    if (jma === null || jma.rank < 1) continue
    if (best === null || p.index > best.index) best = p
  }
  return best === null ? null : { lat: best.lat, lon: best.lng }
}

/** 選ぶ材料。速報が無く検知も無ければ `null`（揺れていない）。 */
function selectionSource(eew: EEWAlert | null, detection: { lat: number; lon: number } | null): PublicSelectionSource | null {
  if (eew !== null) {
    const h = eew.earthquake.hypocenter
    if (Number.isFinite(h.latitude) && Number.isFinite(h.longitude)) {
      // **仮定震源の判定に連動する箇所は eew-spec.md §5 に列挙する決まり。**
      return {
        kind: 'hypocenter',
        lat: h.latitude,
        lon: h.longitude,
        depthKm: hasDepth(h.depth) ? h.depth : null,
        magnitude: hasMagnitude(h.magnitude) ? h.magnitude : null,
        assumed: isProvisionalHypocenter(eew),
      }
    }
  }
  if (detection !== null) return { kind: 'detection', ...detection }
  return null
}

function browserShareDeps(makeLink: ConstructorParameters<typeof PublicWaveShare>[0]['makeLink']): ConstructorParameters<typeof PublicWaveShare>[0] {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: { request(name: string, cb: () => Promise<void>): Promise<unknown> } })
  return {
    locks: nav?.locks ?? null,
    openChannel: (name) => {
      if (typeof BroadcastChannel === 'undefined') return null
      try {
        return new BroadcastChannel(name) as unknown as ShareChannel
      } catch {
        return null
      }
    },
    makeLink,
    now: () => Date.now(),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
    tabId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  }
}

export function usePublicWaves(params: {
  /** 使えるか。 */
  enabled: boolean
  /** 再生中の時刻のずれ（ms）。ライブなら `null`。再生中は保存庫から取る。 */
  replayOffsetMs: number | null
  spanSec: number
  alwaysConnected: boolean
  /**
   * 観測点を選ぶ材料の緊急地震速報（`pickPublicWaveEew`）。予報円が引ければ P/S 線と同じもの、引けなければ
   * 発表中のいちばん新しいもの（仮定震源要素・深さ不明も含む）。無ければ `null`。
   */
  eew: EEWAlert | null
  detectedPoints: readonly DetectedPoint[]
}): PublicWaves {
  const { enabled, replayOffsetMs, spanSec, alwaysConnected, eew, detectedPoints } = params
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
      .catch((e) => log.warn('[public-wave] 公開観測点の表を読めなかった', e))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [enabled])

  // **いまの時刻で運用している観測点**（分の単位で見直せば足りる。運用の区切りは日の単位）。
  const minute = Math.floor((replayOffsetMs === null ? serverNow() : Date.now() + replayOffsetMs) / 60_000)
  const epochs = useMemo(() => (file === null ? [] : activeEpochsAt(file, minute * 60_000)), [file, minute])

  // --- 選び方（揺れの間の記憶） ---
  const detection = strongestDetection(detectedPoints)
  const source = enabled ? selectionSource(eew, detection) : null
  const selectionRef = useRef<PublicSelectionState>(EMPTY_PUBLIC_SELECTION)
  const [lingering, setLingering] = useState(false)
  const shaking = source !== null
  // **検知も鍵に入れる**（速報が仮定震源要素のときは検知で仮に選ぶので、検知が後から現れたら選び直す）
  const sourceKey = source === null ? '' : JSON.stringify([source, source.kind === 'hypocenter' ? detection : null])
  const [selected, setSelected] = useState<readonly SelectedPublicStation[]>([])
  // **再生を始めた・止めた・時刻を変えたら、選び方の記憶と余韻を落とす**（別の時間軸の観測点・番号を持ち越さない）
  const timelineRef = useRef(replayOffsetMs)
  useEffect(() => {
    if (timelineRef.current === replayOffsetMs) return
    timelineRef.current = replayOffsetMs
    selectionRef.current = EMPTY_PUBLIC_SELECTION
    setSelected([])
    setLingering(false)
  }, [replayOffsetMs])
  useEffect(() => {
    if (source === null || epochs.length === 0) return
    const next = selectPublicStations({ prev: selectionRef.current, epochs, source, detection: source.kind === 'hypocenter' ? detection : null })
    selectionRef.current = next.state
    setSelected(next.selected)
    // `source` は `sourceKey` で見る（毎レンダー新しいオブジェクトになるため）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, epochs, replayOffsetMs])
  useEffect(() => {
    if (shaking) {
      setLingering(true)
      return
    }
    if (!lingering) return
    const timer = setTimeout(() => {
      setLingering(false)
      selectionRef.current = EMPTY_PUBLIC_SELECTION
      setSelected([])
    }, LINGER_MS)
    return () => clearTimeout(timer)
  }, [shaking, lingering, replayOffsetMs])
  const visible = enabled && lingering && selected.length > 0

  // --- 受信（タブどうしで 1 本） ---
  const buffersRef = useRef(new Map<string, PublicWaveBuffer>())
  const receivedAtRef = useRef(new Map<string, number>())
  const bufferEpochsRef = useRef(new Map<string, PublicStationEpoch>())
  const epochsRef = useRef(epochs)
  epochsRef.current = epochs
  const [status, setStatus] = useState<PublicLinkStatus>({ kind: 'idle' })
  const shareRef = useRef<PublicWaveShare | null>(null)
  const retainSecRef = useRef<number>(MAX_WAVE_SPAN_SEC)
  retainSecRef.current = replaying ? REPLAY_RETAIN_SEC : MAX_WAVE_SPAN_SEC
  const onRecord = useCallback((rec: Mseed2Record) => {
    const epoch = epochsRef.current.find((e) => e.code === rec.station)
    if (epoch === undefined) return
    let buffer = buffersRef.current.get(rec.station)
    if (buffer === undefined || bufferEpochsRef.current.get(rec.station) !== epoch) {
      bufferEpochsRef.current.set(rec.station, epoch)
      buffer = new PublicWaveBuffer(retainSecRef.current)
      buffersRef.current.set(rec.station, buffer)
    }
    // 置き方は地震カード（保存庫）と同じ 1 か所（`pushPublicRecord`）
    if (pushPublicRecord(buffer, epoch, rec).kind === 'ok') receivedAtRef.current.set(rec.station, performance.now())
  }, [])
  useEffect(() => {
    // 換算済みの値へ新しい感度を混ぜない。次のレコードから現在のエポックで組み直す。
    for (const code of buffersRef.current.keys()) {
      if (bufferEpochsRef.current.get(code) !== epochs.find(e => e.code === code)) {
        buffersRef.current.delete(code)
        receivedAtRef.current.delete(code)
        bufferEpochsRef.current.delete(code)
      }
    }
  }, [epochs])
  useEffect(() => {
    // 再生中は SeedLink を使わない（下の保存庫の先取り）
    if (!enabled || replaying) return
    const share = new PublicWaveShare(
      browserShareDeps((rec, st) => new PublicWaveLink({ ...defaultPublicLinkDeps(), serverNow }, rec, st)),
      onRecord,
      setStatus,
    )
    shareRef.current = share
    return () => {
      share.dispose()
      shareRef.current = null
      buffersRef.current.clear()
      receivedAtRef.current.clear()
      setStatus({ kind: 'idle' })
    }
  }, [enabled, replaying, onRecord])
  const stationCodes = useMemo(() => epochs.map((e) => e.code), [epochs])
  const need = enabled && (visible || alwaysConnected)
  useEffect(() => {
    if (need && file !== null) void checkPublicStations()
  }, [need, file])

  useEffect(() => {
    if (replaying) return
    shareRef.current?.setNeed(need, spanSec, stationCodes)
  }, [replaying, need, spanSec, stationCodes])

  // --- 再生中の先取り（保存庫） ---
  // **再生の時刻のずれが変わったら（始め直し・時刻の変更）、抱えた分を捨てる**（別の時間軸の波形を混ぜない）。
  const stationCodesRef = useRef(stationCodes)
  stationCodesRef.current = stationCodes
  const spanSecRef = useRef(spanSec)
  spanSecRef.current = spanSec
  useEffect(() => {
    if (!enabled || !replaying || !need) return
    const ctrl = new AbortController()
    let fetched: PublicReplayFetched | null = null
    let busy = false
    let retryAtMs = 0
    const tick = (): void => {
      if (busy || ctrl.signal.aborted || Date.now() < retryAtMs) return
      const codes = stationCodesRef.current
      if (codes.length === 0) return
      const plan = planPublicReplayFetch({ replayNowMs: serverNow(), realNowMs: Date.now(), spanSec: spanSecRef.current, fetched })
      if (plan.kind !== 'fetch') return
      if (plan.reset) {
        buffersRef.current.clear()
        receivedAtRef.current.clear()
        fetched = null
      }
      busy = true
      void fetchPublicWaveArchive({ stations: codes, range: plan.range, signal: ctrl.signal, urgent: true })
        .then((res) => {
          if (res.kind === 'aborted' || ctrl.signal.aborted) return
          if (res.kind === 'ok') {
            const stream = splitMseed2Stream(res.bytes)
            if (stream.unreadable.length > 0) log.debug(`[public-wave] 再生中の保存庫の応答で読めないレコード ${stream.unreadable.length} 本`)
            for (const rec of stream.records) onRecord(rec)
          } else {
            // 問い合わせ全体の204/404も不在を確定せず、間を空けて取り直す。
            // 過去に404から200へ変わる応答が記録されているが、原因は未特定。先へ進むとその範囲を再取得しない。
            retryAtMs = Date.now() + REPLAY_RETRY_MS
            log.warn(`[public-wave] 再生中に保存庫から下部の波形を取れなかった（${res.kind === 'no-data' ? '全観測点が 404' : res.kind}${res.kind === 'http-error' ? ` ${res.status}` : ''}）`)
            return
          }
          fetched = { fromMs: fetched === null ? plan.range.fromMs : fetched.fromMs, toMs: plan.range.toMs }
          setStatus({ kind: 'streaming' })
        })
        .catch((e) => log.warn('[public-wave] 再生中の下部の波形を組み立てられなかった', e))
        .finally(() => {
          busy = false
        })
    }
    setStatus({ kind: 'connecting' })
    tick()
    const timer = setInterval(tick, REPLAY_CHECK_MS)
    return () => {
      clearInterval(timer)
      ctrl.abort()
      buffersRef.current.clear()
      receivedAtRef.current.clear()
      setStatus({ kind: 'idle' })
    }
  }, [enabled, replaying, replayOffsetMs, need, onRecord, file])

  // --- 途絶（受け取ってからの経過で測る。§5.3） ---
  const [staleCodes, setStaleCodes] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!visible) return
    const check = () => {
      const now = performance.now()
      const next = new Set<string>()
      for (const s of selected) {
        if (replaying) {
          // **再生中は受け取った時刻ではなく、再生時刻の手前にサンプルがあるかで見る**（先取りなので受け取りは数分おき）
          // 先取りした分は再生時刻より先まで入っているので、再生時刻までに切ってから最後の値を見る
          const last = buffersRef.current.get(s.epoch.code)?.lastFiniteSampleMs(serverNow()) ?? null
          if (last === null || serverNow() - last > PUBLIC_WAVE_STALE_MS) next.add(s.epoch.code)
          continue
        }
        const at = receivedAtRef.current.get(s.epoch.code)
        if (at === undefined || now - at > PUBLIC_WAVE_STALE_MS) next.add(s.epoch.code)
      }
      setStaleCodes((prev) => (prev.size === next.size && [...next].every((c) => prev.has(c)) ? prev : next))
    }
    check()
    const timer = setInterval(check, STALE_CHECK_MS)
    return () => clearInterval(timer)
  }, [visible, selected, replaying])

  const stations = useMemo<PublicWaveStation[]>(
    () =>
      selected.map((s) => ({
        code: s.epoch.code,
        number: s.number,
        nameJa: s.epoch.nameJa,
        lat: s.epoch.lat,
        lon: s.epoch.lon,
        stale: staleCodes.has(s.epoch.code),
      })),
    [selected, staleCodes],
  )
  // **再生中は再生時刻より後を写さない**（先取りした分が先まで入っている）
  const replayingRef = useRef(replaying)
  replayingRef.current = replaying
  const readWave = useCallback(
    (code: string, fromMs: number | null) =>
      buffersRef.current.get(code)?.snapshot(fromMs, { removeMean: true, untilMs: replayingRef.current ? serverNow() : undefined }) ?? null,
    [],
  )
  // 再生中は地震カードへ継ぎ足さない（カードは保存庫から地震の区間を取っている。先取りの分は再生時刻より先まである）
  const readRawWave = useCallback(
    (code: string, fromMs: number | null) =>
      replayingRef.current ? null : (buffersRef.current.get(code)?.snapshot(fromMs, { removeMean: false }) ?? null),
    [],
  )

  return { visible, stations, status, readWave, readRawWave }
}
