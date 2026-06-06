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

// ── 二分探索ベースの時刻検索 ────────────────────────────────────────────────

async function fetchAtOffset(code: number, offset: number, limit: number): Promise<unknown[]> {
  const params = new URLSearchParams()
  params.append('codes', String(code))
  params.set('limit', String(Math.min(limit, 100)))
  params.set('offset', String(Math.max(0, offset)))
  const res = await fetch(`${API_BASE}/history?${params}`)
  if (!res.ok) return []
  return res.json() as Promise<unknown[]>
}

// P2PQuake の history は新しい順（offset 0 = 最新）。
// 二分探索で targetTime より新しい最後のオフセットを返す。
async function findOffsetForTime(code: number, targetTime: Date): Promise<number> {
  const targetMs = targetTime.getTime()
  let lo = 0
  let hi = 300_000  // 最大保持件数の上限見積もり

  let iterations = 0
  while (hi - lo > 100 && iterations < 15) {
    iterations++
    const mid = Math.floor((lo + hi) / 2)
    const events = await fetchAtOffset(code, mid, 1) as Array<{ time: string }>

    if (events.length === 0) {
      // データが存在しないオフセット → hi を縮める
      hi = mid
      continue
    }

    if (new Date(events[0].time).getTime() > targetMs) {
      lo = mid  // mid のイベントはまだ新しい → さらに古い方向へ
    } else {
      hi = mid  // mid のイベントは古い → 新しい方向へ
    }
  }

  return lo
}

// targetTime 前後30分の範囲でイベントを取得（二分探索で offset を推定）
async function fetchEventsNearTime<T extends { time: string }>(
  code: number,
  since: Date,
  until: Date,
): Promise<T[]> {
  try {
    const offset = await findOffsetForTime(code, until)
    const raw = await fetchAtOffset(code, offset, 100) as T[]
    return raw.filter(e => {
      const t = new Date(e.time).getTime()
      return t >= since.getTime() && t <= until.getTime()
    })
  } catch {
    return []
  }
}

// targetTime に最も近い地震イベントを返す（30分以内に見つからなければ null）
export async function fetchEarthquakeNearTime(targetTime: Date): Promise<JMAQuake | null> {
  const offset = await findOffsetForTime(551, targetTime)
  const raw = await fetchAtOffset(551, offset, 100) as JMAQuake[]
  const deduped = deduplicateQuakes(raw)

  let closest: JMAQuake | null = null
  let closestDiff = Infinity
  const windowMs = 30 * 60 * 1000

  for (const q of deduped) {
    const diff = Math.abs(new Date(q.earthquake.time).getTime() - targetTime.getTime())
    if (diff < windowMs && diff < closestDiff) {
      closestDiff = diff
      closest = q
    }
  }

  return closest
}

// K-NET ファイルの震源時刻を起点に P2PQuake からデータを取得してセッションを構築する
export async function buildReplaySessionFromKnet(knet: KnetRecord): Promise<ReplaySession> {
  const originTime = knet.originTime
  const since = new Date(originTime.getTime() - 5 * 60 * 1000)
  const until = new Date(originTime.getTime() + 30 * 60 * 1000)

  // P2PQuake 地震イベントを先に特定してから EEW・津波を並列取得
  const p2pQuake = await fetchEarthquakeNearTime(originTime)

  const [eews, tsunamis] = await Promise.all([
    fetchEventsNearTime<EEWAlert>(556, since, until),
    fetchEventsNearTime<JMATsunami>(552, since, until),
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
