// 複数のK-NETイベント（本震・離れた余震等）の観測点・震度時系列を、1つのローカル強震モニタ風
// アーカイブへ統合するロジック。capture-kyoshin-waveform.ts から呼ばれる（ネットワーク・ファイル
// I/Oを含まない純粋な変換部分だけをここに切り出し、単体テストできるようにしている）。

import { kyoshinValueToIndex } from '../kyoshinIntensity'
import type { LocalKyoshinFrame } from '../../types/localKyoshinArchive'

/** 観測点1件・絶対時刻付きの計測震度時系列。 */
export interface StationSeries {
  stationCode: string
  latitude: number
  longitude: number
  /** 絶対時刻(UNIX epoch秒、整数)と計測震度のペア。 */
  points: { epochSec: number; intensity: number | null }[]
}

export interface EventResult {
  originTimeJst: string
  stationSeries: StationSeries[]
  /** このイベント単独でのピーク計測震度（近似値）。 */
  peakIntensity: number
}

/**
 * 複数イベントの観測点を`stationCode`で名寄せし、1つの観測点座標配列へ統合する。
 * 同じ観測点が複数のイベントに登場しても1エントリにまとめる（初出の座標を採用）。
 */
export function buildGlobalStationRegistry(events: EventResult[]): { stationOrder: string[]; siteCoords: [number, number][] } {
  const stationOrder: string[] = []
  const seen = new Set<string>()
  const siteCoords: [number, number][] = []
  for (const ev of events) {
    for (const s of ev.stationSeries) {
      if (seen.has(s.stationCode)) continue
      seen.add(s.stationCode)
      stationOrder.push(s.stationCode)
      siteCoords.push([s.latitude, s.longitude])
    }
  }
  return { stationOrder, siteCoords }
}

/**
 * イベントごとに、実際の記録範囲だけのフレームを作る（スパース）。
 * 本震と数ヶ月後の余震のように離れたイベントの間を1秒刻みで埋めると、フレーム数・ファイル
 * サイズが無意味に膨れ上がるため、間の期間はそもそもフレームを作らない
 * （localArchiveReplay.tsのfindCoveringArchiveSyncと同じ「収録していない期間は収録していない
 * ままにする」考え方。再生時、フレームが無い時間帯は強震モニタタブが単に空になるだけで、
 * 「地震活動なし」の誤った空成功を返すわけではない）。
 */
export function buildEventFrames(
  event: EventResult,
  stationIndexOf: Map<string, number>,
  siteCount: number,
  stepSec: number,
): LocalKyoshinFrame[] {
  let minSec = Infinity
  let maxSec = -Infinity
  const lookups = new Map<number, Map<number, number>>()
  for (const s of event.stationSeries) {
    const siteIdx = stationIndexOf.get(s.stationCode)!
    const map = new Map<number, number>()
    for (const p of s.points) {
      if (p.epochSec < minSec) minSec = p.epochSec
      if (p.epochSec > maxSec) maxSec = p.epochSec
      if (p.intensity !== null) map.set(p.epochSec, kyoshinValueToIndex(p.intensity))
    }
    lookups.set(siteIdx, map)
  }

  const frames: LocalKyoshinFrame[] = []
  for (let sec = minSec; sec <= maxSec; sec += stepSec) {
    const indices = new Array<number>(siteCount)
    for (let i = 0; i < siteCount; i++) {
      indices[i] = lookups.get(i)?.get(sec) ?? -1
    }
    frames.push({ time: new Date(sec * 1000).toISOString(), indices })
  }
  return frames
}

/**
 * 複数イベントの結果を1つのアーカイブぶんの sites/stationCodes/frames へ統合する。
 * フレームは各イベントのスパースな範囲を連結し、時刻順に並べ替える
 * （--originの指定順が原時刻順と一致しない場合に備える）。
 */
export function mergeEvents(
  events: EventResult[],
  stepSec: number,
): { stationOrder: string[]; siteCoords: [number, number][]; frames: LocalKyoshinFrame[] } {
  const { stationOrder, siteCoords } = buildGlobalStationRegistry(events)
  const stationIndexOf = new Map(stationOrder.map((code, i) => [code, i]))

  const frames: LocalKyoshinFrame[] = []
  for (const ev of events) {
    frames.push(...buildEventFrames(ev, stationIndexOf, stationOrder.length, stepSec))
  }
  frames.sort((a, b) => a.time.localeCompare(b.time))

  return { stationOrder, siteCoords, frames }
}
