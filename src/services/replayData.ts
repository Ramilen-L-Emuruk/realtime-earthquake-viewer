import type { JMAQuake, JMATsunami, EEWAlert } from '../types/earthquake'
import type { ReplayEvent, ReplaySession } from '../types/replay'

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
