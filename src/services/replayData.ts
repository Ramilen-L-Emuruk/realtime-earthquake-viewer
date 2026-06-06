import type { JMAQuake, JMATsunami, EEWAlert } from '../types/earthquake'
import type { KnetRecord, ReplayEvent, ReplaySession } from '../types/replay'

const API_BASE = 'https://api.p2pquake.net/v2'

const ISSUE_PRIORITY: Record<string, number> = {
  DetailScale: 4,
  ScaleAndDestination: 3,
  Destination: 2,
  ScalePrompt: 1,
  Foreign: 0,
  Other: 0,
}

function deduplicateQuakes(quakes: JMAQuake[]): JMAQuake[] {
  const seen = new Map<string, JMAQuake>()
  for (const q of quakes) {
    const key = q.earthquake.time
    const existing = seen.get(key)
    if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
      seen.set(key, q)
    }
  }
  return Array.from(seen.values())
}

async function fetchRecent<T extends { time: string }>(
  codes: number[],
  since: Date,
  until: Date,
  limit = 100,
): Promise<T[]> {
  const params = new URLSearchParams()
  codes.forEach(c => params.append('codes', String(c)))
  params.set('limit', String(limit))
  const res = await fetch(`${API_BASE}/history?${params.toString()}`)
  if (!res.ok) throw new Error(`P2PQuake API error: ${res.status}`)
  const all = await res.json() as T[]
  return all.filter(e => {
    const t = new Date(e.time).getTime()
    return t >= since.getTime() && t <= until.getTime()
  })
}

export async function fetchEarthquakeList(limit = 100): Promise<JMAQuake[]> {
  const params = new URLSearchParams()
  params.append('codes', '551')
  params.set('limit', String(limit))
  const res = await fetch(`${API_BASE}/history?${params.toString()}`)
  if (!res.ok) throw new Error(`P2PQuake API error: ${res.status}`)
  const raw = await res.json() as JMAQuake[]
  return deduplicateQuakes(raw).slice(0, 50)
}

// ── K-NET 連携: P2PQuake 直近データと照合 ──────────────────────────────────
//
// P2PQuake の history API は直近約 100 件（2〜3週間分）しか保持しない。
// offset による深い検索はできないため、全件取得 → 時刻フィルタのみで対応する。

// targetTime に最も近い地震イベントを返す（30分以内に見つからなければ null）
export async function fetchEarthquakeNearTime(targetTime: Date): Promise<JMAQuake | null> {
  const since = new Date(targetTime.getTime() - 30 * 60 * 1000)
  const until = new Date(targetTime.getTime() + 30 * 60 * 1000)
  const candidates = await fetchRecent<JMAQuake>([551], since, until)
  const deduped = deduplicateQuakes(candidates)

  const targetMs = targetTime.getTime()
  let closest: JMAQuake | null = null
  let closestDiff = Infinity

  for (const q of deduped) {
    const diff = Math.abs(new Date(q.earthquake.time).getTime() - targetMs)
    if (diff < closestDiff) { closestDiff = diff; closest = q }
  }

  return closest
}

// K-NET ファイルの震源時刻を起点に P2PQuake からデータを取得してセッションを構築する。
// P2PQuake の保持期間（直近2〜3週間）外の場合は quake/EEW/津波は null/空になる。
export async function buildReplaySessionFromKnet(knet: KnetRecord): Promise<ReplaySession> {
  const originTime = knet.originTime
  const since = new Date(originTime.getTime() - 5 * 60 * 1000)
  const until = new Date(originTime.getTime() + 30 * 60 * 1000)

  // 3種類を並列取得（直近 100 件から時刻フィルタ）
  const [p2pQuake, eews, tsunamis] = await Promise.all([
    fetchEarthquakeNearTime(originTime),
    fetchRecent<EEWAlert>([556], since, until).catch(() => [] as EEWAlert[]),
    fetchRecent<JMATsunami>([552], since, until).catch(() => [] as JMATsunami[]),
  ])

  const events: ReplayEvent[] = []
  for (const eew of eews) {
    if (eew.test) continue
    events.push({ time: new Date(eew.time), type: 'eew', data: eew })
  }
  if (p2pQuake) {
    events.push({ time: new Date(p2pQuake.time), type: 'quake', data: p2pQuake })
  }
  for (const tsunami of tsunamis) {
    events.push({ time: new Date(tsunami.time), type: 'tsunami', data: tsunami })
  }

  events.sort((a, b) => a.time.getTime() - b.time.getTime())

  // K-NET チャンネルの記録開始・終了時刻でセッション範囲を決定
  const chStarts = knet.channels.map(ch => ch.recordTime.getTime())
  const chEnds = knet.channels.map(ch => ch.recordTime.getTime() + ch.durationSec * 1000)
  const knetStart = chStarts.length > 0 ? new Date(Math.min(...chStarts)) : originTime
  const knetEnd = chEnds.length > 0 ? new Date(Math.max(...chEnds)) : new Date(originTime.getTime() + 300_000)

  const allMs = [knetStart.getTime(), knetEnd.getTime(), ...events.map(e => e.time.getTime())]
  const startTime = new Date(Math.min(...allMs))
  const endTime = new Date(Math.max(...allMs) + 60_000)

  return { quake: p2pQuake, events, startTime, endTime, knet }
}

// ── 以下は既存の P2PQuake 専用セッション構築 ────────────────────────────────

export async function buildReplaySession(quake: JMAQuake): Promise<ReplaySession> {
  const originTime = new Date(quake.earthquake.time)
  const since = new Date(originTime.getTime() - 5 * 60 * 1000)  // 5分前
  const until = new Date(originTime.getTime() + 30 * 60 * 1000) // 30分後

  const [eews, tsunamis] = await Promise.all([
    fetchRecent<EEWAlert>([556], since, until),
    fetchRecent<JMATsunami>([552], since, until),
  ])

  const events: ReplayEvent[] = []

  for (const eew of eews) {
    if (eew.test) continue
    events.push({ time: new Date(eew.time), type: 'eew', data: eew })
  }

  events.push({ time: new Date(quake.time), type: 'quake', data: quake })

  for (const tsunami of tsunamis) {
    events.push({ time: new Date(tsunami.time), type: 'tsunami', data: tsunami })
  }

  events.sort((a, b) => a.time.getTime() - b.time.getTime())

  const startTime = events.length > 0 ? events[0].time : originTime
  const endTime = events.length > 0
    ? new Date(events[events.length - 1].time.getTime() + 60 * 1000)
    : new Date(originTime.getTime() + 60 * 1000)

  return { quake, events, startTime, endTime }
}
