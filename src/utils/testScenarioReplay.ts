import type { AppEvent, EEWRegion } from '../types/earthquake'
import type { ReplayEntry, ReplayPayload } from '../types/replay'
import type { TestScenarioFile } from '../types/testScenario'

function shiftIso(iso: string, deltaMs: number): string {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? new Date(t + deltaMs).toISOString() : iso
}

function shiftIsoOpt(iso: string | undefined, deltaMs: number): string | undefined {
  return iso === undefined ? undefined : shiftIso(iso, deltaMs)
}

function shiftIsoNullable(iso: string | null, deltaMs: number): string | null {
  return iso === null ? null : shiftIso(iso, deltaMs)
}

type IdRemapper = (original: string | undefined) => string | undefined

// シナリオ1回分の再生を通して、元のeventId文字列 -> 新IDの対応を一貫させる。
// 新IDは既存コードの \d{14} 正規表現（quake関連）と互換な14桁数字にする。
// 下10桁を連番(seq)に割り当てることで、1シナリオ内に登場する distinct な元eventIdが
// 100億種類を超えない限り衝突しない（震源が多数混在する長時間キャプチャでも安全マージンを確保）。
function makeIdRemapper(seed: number): IdRemapper {
  const map = new Map<string, string>()
  let seq = 0
  const seedPrefix = String(seed).slice(-4).padStart(4, '0')
  return (original) => {
    if (!original) return original
    let mapped = map.get(original)
    if (!mapped) {
      mapped = `${seedPrefix}${String(seq).padStart(10, '0')}`
      seq++
      map.set(original, mapped)
    }
    return mapped
  }
}

// id文字列に埋め込まれた元eventIdをそのまま文字列置換する（桁数を仮定しない）。
function replaceEventIdInId(id: string, oldEventId: string | undefined, newEventId: string | undefined): string {
  if (!oldEventId || !newEventId) return id
  return id.split(oldEventId).join(newEventId)
}

function shiftEEWRegions(regions: EEWRegion[] | undefined, deltaMs: number): EEWRegion[] | undefined {
  return regions?.map(r => ({ ...r, arrivalTime: shiftIsoNullable(r.arrivalTime, deltaMs) }))
}

function remapAppEvent(event: AppEvent, deltaMs: number, remapId: IdRemapper): AppEvent {
  switch (event.kind) {
    case 'quake': {
      const newEventId = remapId(event.eventId)
      return {
        ...event,
        id: replaceEventIdInId(event.id, event.eventId, newEventId),
        eventId: newEventId,
        time: shiftIso(event.time, deltaMs),
        issue: { ...event.issue, time: shiftIso(event.issue.time, deltaMs) },
        earthquake: { ...event.earthquake, time: shiftIso(event.earthquake.time, deltaMs) },
      }
    }
    case 'tsunami': {
      const newEventId = remapId(event.eventId)
      return {
        ...event,
        id: replaceEventIdInId(event.id, event.eventId, newEventId),
        eventId: newEventId,
        time: shiftIso(event.time, deltaMs),
        validDateTime: shiftIsoOpt(event.validDateTime, deltaMs),
        sourceEarthquake: event.sourceEarthquake && {
          ...event.sourceEarthquake,
          originTime: shiftIsoOpt(event.sourceEarthquake.originTime, deltaMs),
        },
        issue: { ...event.issue, time: shiftIso(event.issue.time, deltaMs) },
        areas: event.areas.map(a => ({
          ...a,
          firstHeight: a.firstHeight && {
            ...a.firstHeight,
            arrivalTime: shiftIsoOpt(a.firstHeight.arrivalTime, deltaMs),
          },
          stations: a.stations?.map(s => ({
            ...s,
            highTideDateTime: shiftIsoOpt(s.highTideDateTime, deltaMs),
            arrivalTime: shiftIsoOpt(s.arrivalTime, deltaMs),
          })),
        })),
        observations: event.observations?.map(o => ({
          ...o,
          arrivalTime: shiftIsoOpt(o.arrivalTime, deltaMs),
        })),
      }
    }
    case 'eew': {
      const oldEventId = event.issue?.eventId
      const newEventId = remapId(oldEventId)
      return {
        ...event,
        id: replaceEventIdInId(event.id, oldEventId, newEventId),
        time: shiftIso(event.time, deltaMs),
        issue: event.issue && { ...event.issue, eventId: newEventId, time: shiftIsoOpt(event.issue.time, deltaMs) },
        earthquake: {
          ...event.earthquake,
          originTime: shiftIso(event.earthquake.originTime, deltaMs),
          arrivalTime: shiftIso(event.earthquake.arrivalTime, deltaMs),
        },
        areas: shiftEEWRegions(event.areas, deltaMs),
        regions: shiftEEWRegions(event.regions, deltaMs),
      }
    }
  }
}

function remapPayload(payload: ReplayPayload, deltaMs: number, remapId: IdRemapper): ReplayPayload {
  switch (payload.kind) {
    case 'event':
      return { kind: 'event', event: remapAppEvent(payload.event, deltaMs, remapId) }
    case 'lpgm': {
      const newEventId = remapId(payload.data.eventId) ?? payload.data.eventId
      return {
        kind: 'lpgm',
        data: {
          ...payload.data,
          eventId: newEventId,
          id: replaceEventIdInId(payload.data.id, payload.data.eventId, newEventId),
          time: shiftIso(payload.data.time, deltaMs),
          originTime: shiftIso(payload.data.originTime, deltaMs),
        },
      }
    }
    case 'nankai': {
      const newEventId = remapId(payload.data.eventId) ?? payload.data.eventId
      return {
        kind: 'nankai',
        data: {
          ...payload.data,
          eventId: newEventId,
          id: replaceEventIdInId(payload.data.id, payload.data.eventId, newEventId),
          time: shiftIso(payload.data.time, deltaMs),
          reportDateTime: shiftIso(payload.data.reportDateTime, deltaMs),
        },
      }
    }
    case 'kohatsu': {
      const newEventId = remapId(payload.data.eventId) ?? payload.data.eventId
      return {
        kind: 'kohatsu',
        data: {
          ...payload.data,
          eventId: newEventId,
          id: replaceEventIdInId(payload.data.id, payload.data.eventId, newEventId),
          time: shiftIso(payload.data.time, deltaMs),
          reportDateTime: shiftIso(payload.data.reportDateTime, deltaMs),
          expireAt: shiftIso(payload.data.expireAt, deltaMs),
        },
      }
    }
  }
}

// シナリオを「今」基準にインスタンス化し、useEarthquakes の loadReplayEvents にそのまま渡せる
// ReplayEntry[] を返す。EEW自動解除・津波期限切れなど時刻依存の既存ロジックが正しく動くよう、
// イベント内部の絶対時刻フィールドを一律 (now - scenario.baseTime) だけシフトする。
// 同一シナリオ内で同じ eventId を持つ複数報(続報)は同じ新IDに一貫してマッピングされる。
export function instantiateScenario(scenario: TestScenarioFile, now: Date): ReplayEntry[] {
  const deltaMs = now.getTime() - new Date(scenario.baseTime).getTime()
  const remapId = makeIdRemapper(now.getTime())
  return scenario.entries.map(entry => ({
    replayTime: new Date(now.getTime() + entry.offsetMs),
    silent: entry.silent,
    payload: remapPayload(entry.payload, deltaMs, remapId),
  }))
}
