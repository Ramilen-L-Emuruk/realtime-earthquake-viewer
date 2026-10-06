// 揺れの記録の帳面（REQUIREMENTS.md §6・§9）。検出した揺れを記録し、気象庁の地震情報と
// 照らし合わせて判定を書き足す。
//
//   揺れが閉じる ──→ 版 1（照合待ち `pending`）を書く
//   地震情報が届く ─→ 時刻が合う揺れに `quake` の版を足す（期限を過ぎた揺れも、2 時間以内なら上書きする）
//                     同じ地震の続報で規模・深さ・最大震度・震源が変われば、その値で版を足す
//   期限が来る ────→ 合わなかった揺れに、揺れ方で決めた版を足す（受信が途切れていたら `unchecked`）
//
// **期限はホストの時計で測る。** 揺れの時刻は基板の時計（SNTP で合わせてある）だが、
// 「地震情報がいつまでに届くか」はホストが受け取る時刻の話なので。
//
// **投げない。** 書けなかった版は `ShakeEventStore` が数える。

import type { P2pReferenceQuake } from './p2pQuake'
import type { DetectedShake } from './quakeDetector'
import { arrivalWindow, matchesQuake } from './quakeMatch'
import type { ArrivalWindow, ObserverPoint } from './quakeMatch'
import { initialRecord, withDeadline, withMatch } from './shakeEvent'
import type { MatchedQuake, ShakeEventRecord, ShakeSensorRef } from './shakeEvent'

/** 揺れが閉じてから、照合を待つ長さ。気象庁の震源・震度の情報は数分で出るので、余裕を見て 15 分。 */
export const MATCH_DEADLINE_MS = 15 * 60_000
/** 揺れと地震情報を覚えておく長さ。期限を過ぎた揺れも、この間に届いた地震情報なら照合し直す。 */
export const MEMORY_MS = 2 * 3_600_000
/** 計測震度相当を覚えておく長さ（区間の最長 180 秒 ＋ 余裕）。 */
const READING_MEMORY_MS = 10 * 60_000

export interface ShakeEventBookOptions {
  /** 版を残す（`ShakeEventStore.save`）。 */
  readonly save: (rec: ShakeEventRecord) => void
  /** 版を押し出す（`ReadingHub`）。 */
  readonly publish: (rec: ShakeEventRecord) => void
  /** 観測点の位置。設定に無ければ null（照合できない）。 */
  readonly observerOf: (stationId: string) => ObserverPoint | null
  /** 地震情報の受信が `[fromMs, toMs]` の間ずっと繋がっていたか（`quakeFeed.ts`）。 */
  readonly feedCovered: (fromMs: number, toMs: number) => boolean
  readonly now: () => number
  readonly detectorVersion: number
}

interface Tracked {
  rec: ShakeEventRecord
  /** 版 1 を書いた時刻（ホストの時計）。期限の起点。 */
  readonly openedAtMs: number
}

export class ShakeEventBook {
  private readonly opts: ShakeEventBookOptions
  private readonly events: Tracked[] = []
  private quakes: P2pReferenceQuake[] = []
  private readonly readings = new Map<string, { atMs: number; intensity: number }[]>()

  constructor(options: ShakeEventBookOptions) {
    this.opts = options
  }

  /** 観測点ぶんの計測震度相当（最大計測震度相当を出すために覚えておく）。 */
  noteStationReading(stationId: string, atMs: number, intensity: number | null): void {
    if (intensity === null || !Number.isFinite(intensity)) return
    let list = this.readings.get(stationId)
    if (list === undefined) this.readings.set(stationId, (list = []))
    list.push({ atMs, intensity })
    const cutoff = atMs - READING_MEMORY_MS
    while (list.length > 0 && list[0].atMs < cutoff) list.shift()
  }

  /** 検出した揺れを記録する（版 1）。覚えている地震情報と、その場で照らし合わせる。 */
  addShake(stationId: string, shake: DetectedShake, sensors: readonly ShakeSensorRef[]): ShakeEventRecord {
    const nowMs = this.opts.now()
    const t = shake.trigger
    const rec = initialRecord({
      shake,
      stationId,
      detectorVersion: this.opts.detectorVersion,
      maxIntensity: this.maxIntensity(stationId, t.onMs, t.offMs),
      sensors,
      nowMs,
    })
    this.emit(rec)
    const tracked: Tracked = { rec, openedAtMs: nowMs }
    this.events.push(tracked)
    const match = this.bestMatch(rec, this.quakes)
    if (match !== null) this.update(tracked, withMatch(rec, match.quake, match.window, nowMs))
    return tracked.rec
  }

  /** 地震情報を受け取る。時刻が合う揺れ（照合待ち・期限切れのどちらも）へ `quake` を書き足す。 */
  addQuake(quake: P2pReferenceQuake): void {
    // 同じ地震の報（続報）は置き換える（後の報ほど震源が確か）。
    this.quakes = this.quakes.filter((q) => q.key !== quake.key)
    this.quakes.push(quake)
    const nowMs = this.opts.now()
    for (const tracked of this.events) {
      const match = this.bestMatch(tracked.rec, [quake])
      if (match === null) continue
      const current = tracked.rec.matchedQuake
      if (current !== null && sameQuake(current, quake)) {
        // 同じ地震の続報。中身が変わっていなければ版を足さない（同じ報を何度受けても記録が伸びない）。
        if (!quakeChanged(current, quake, match.window)) continue
      } else if (current !== null) {
        // 既に別の地震と合っているなら、より近い到達予想のほうを残す。
        const currentQuake = this.quakes.find((q) => sameQuake(current, q))
        const currentWindow = currentQuake === undefined ? null : this.windowOf(tracked.rec.stationId, currentQuake)
        if (currentWindow !== null && closeness(tracked.rec, currentWindow) <= closeness(tracked.rec, match.window)) continue
      }
      this.update(tracked, withMatch(tracked.rec, quake, match.window, nowMs))
    }
  }

  /** 期限を見て、照合が合わなかった揺れを決める。古いものを忘れる。定期的に呼ぶ。 */
  tick(): void {
    const nowMs = this.opts.now()
    for (const tracked of this.events) {
      if (tracked.rec.verdict !== 'pending') continue
      if (nowMs - tracked.openedAtMs < MATCH_DEADLINE_MS) continue
      const covered = this.opts.feedCovered(tracked.rec.startMs, nowMs)
      this.update(tracked, withDeadline(tracked.rec, covered, nowMs))
    }
    const cutoff = nowMs - MEMORY_MS
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].openedAtMs < cutoff && this.events[i].rec.verdict !== 'pending') this.events.splice(i, 1)
    }
    this.quakes = this.quakes.filter((q) => q.originMs >= cutoff)
  }

  /** 照合待ちの件数（状態の口へ出す）。 */
  get pendingCount(): number {
    return this.events.filter((t) => t.rec.verdict === 'pending').length
  }

  private maxIntensity(stationId: string, fromMs: number, toMs: number): number | null {
    const list = this.readings.get(stationId)
    if (list === undefined) return null
    let max: number | null = null
    for (const r of list) {
      if (r.atMs < fromMs || r.atMs > toMs) continue
      if (max === null || r.intensity > max) max = r.intensity
    }
    return max
  }

  private windowOf(stationId: string, quake: P2pReferenceQuake): ArrivalWindow | null {
    const at = this.opts.observerOf(stationId)
    return at === null ? null : arrivalWindow(quake, at)
  }

  private bestMatch(
    rec: ShakeEventRecord,
    quakes: readonly P2pReferenceQuake[],
  ): { quake: P2pReferenceQuake; window: ArrivalWindow } | null {
    let best: { quake: P2pReferenceQuake; window: ArrivalWindow } | null = null
    for (const quake of quakes) {
      const window = this.windowOf(rec.stationId, quake)
      if (window === null || !matchesQuake(rec.startMs, window)) continue
      if (best === null || closeness(rec, window) < closeness(rec, best.window)) best = { quake, window }
    }
    return best
  }

  private update(tracked: Tracked, next: ShakeEventRecord): void {
    tracked.rec = next
    this.emit(next)
  }

  private emit(rec: ShakeEventRecord): void {
    this.opts.save(rec)
    this.opts.publish(rec)
  }
}

/** 照合した地震と同じ地震の報か（`P2pReferenceQuake.key` と同じく、発生時刻と震央地名で見る）。 */
function sameQuake(m: MatchedQuake, q: P2pReferenceQuake): boolean {
  return m.name === q.name && m.originMs === q.originMs
}

/** 続報で記録に残している値が変わったか。 */
function quakeChanged(m: MatchedQuake, q: P2pReferenceQuake, w: ArrivalWindow): boolean {
  return (
    m.magnitude !== q.magnitude ||
    m.depthKm !== q.depthKm ||
    m.maxScale !== q.maxScale ||
    m.lat !== q.lat ||
    m.lon !== q.lon ||
    m.distanceKm !== w.distanceKm ||
    m.originPrecisionMs !== q.originPrecisionMs
  )
}

/** 揺れの始まり（S を拾えていればその時刻）が、S の到達予想の幅からどれだけ外れているか。 */
function closeness(rec: ShakeEventRecord, w: ArrivalWindow): number {
  const t = rec.sMs ?? rec.startMs
  if (t < w.earliestSMs) return w.earliestSMs - t
  if (t > w.latestSMs) return t - w.latestSMs
  return 0
}
