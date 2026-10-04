// K-NET/KiK-netのZIP（NIEDからダウンロードした生データ、1地震ぶん）から、観測点ごとの震度時系列を
// 算出する。ネットワーク・ファイルI/Oを含まない純粋な変換部分だけをここに切り出し、Node CLI
// （capture-kyoshin-waveform.ts）とブラウザ内インポート（useKyoshinImport.ts）の両方から呼ぶ。

import { groupIntoStations } from './knetAscii'
import { parseAllStationFiles } from './parseAllStationFiles'
import { computeRealtimeIntensityTimeSeries } from './realtimeIntensity'
import type { EventResult, StationSeries } from './kyoshinEventMerge'

/** 3成分が揃わない観測点の割合がこれを超えたら失敗として止める。 */
const INCOMPLETE_STATION_RATIO_LIMIT = 0.5

/** UTCのDateを、K-NETヘッダーの原時刻表記と同じ "YYYYMMDDHHMMSS"（JST）へ変換する。 */
function toJstTimestamp(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}`
    + `${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
  )
}

/** "YYYYMMDDHHMMSS"（JST）をUTCのDateへ変換する。`toJstTimestamp`の逆変換。 */
export function parseJstTimestamp(ts: string): Date {
  const y = Number(ts.slice(0, 4))
  const mo = Number(ts.slice(4, 6))
  const d = Number(ts.slice(6, 8))
  const h = Number(ts.slice(8, 10))
  const mi = Number(ts.slice(10, 12))
  const s = Number(ts.slice(12, 14))
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3600_000)
}

/**
 * K-NET/KiK-netのZIP（1地震ぶん）を解析し、観測点ごとの震度時系列を算出する。
 *
 * **震度は強震モニタと同じリアルタイム震度**（`realtimeIntensity.ts`）。自作地震計のホストと
 * 同じ方式なので、同じ画面に並べても物差しが揃う。
 *
 * 地震の識別（`EventResult.originTimeJst`）は、呼び出し側から渡された値ではなく、ZIP内の
 * ファイル自身が持つヘッダーの `Origin Time` から求める。ブラウザ内インポートでは呼び出し側が
 * 対応する地震を事前に知らない（ファイルの中身から判定する）ため、これが唯一の情報源になる。
 */
export function buildEventResultFromZip(zip: Uint8Array, stepSec: number): EventResult {
  // stepSecが非整数だと、下のepochSec算出（Math.round(p.tSec)）で異なるtSecが同じ整数秒に
  // 丸められて衝突し、mergeEvents側のMap.set()で後着が先着を無警告で上書き・消失させる
  // （実データが欠落した状態で「成功」してしまう）。CLI（parseCliArgs）は既に検証しているが、
  // ブラウザ内インポートはCLI引数解析を経由しないため、共有関数自身でも検証する。
  if (!Number.isInteger(stepSec) || stepSec <= 0) throw new Error('stepSec は正の整数（秒）で指定してください')

  const { files, failures } = parseAllStationFiles(zip)
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}件のファイルでパースに失敗しました: `
      + failures.slice(0, 20).map((f) => `${f.fileName}: ${f.message}`).join(' / ')
      + (failures.length > 20 ? ' ...' : ''),
    )
  }
  if (files.length === 0) throw new Error('ZIP内にNS/EW/UD波形ファイルが1件も見つかりませんでした')

  // 全ファイルが同一の地震を指している前提。異なるOrigin Timeが混在していれば、複数の地震の
  // ファイルを誤って1つのZIPにまとめてしまったユーザー操作ミスの可能性が高く、無警告で
  // どちらか一方のOrigin Timeを採用して混合データを作ってしまうより、ここで止める方が安全。
  const originTimes = new Set(files.map((f) => f.originTime.getTime()))
  if (originTimes.size > 1) {
    throw new Error(
      `ZIP内に異なる地震のOrigin Timeが混在しています（${originTimes.size}種類）。`
      + '複数の地震のファイルを1つのZIPにまとめていないか確認してください',
    )
  }
  const originTimeJst = toJstTimestamp(files[0].originTime)

  const { stations, skippedIncomplete } = groupIntoStations(files)
  if (stations.length === 0) throw new Error(`origin=${originTimeJst}: 3成分が揃った観測点が0件です`)
  // 除外が大半を占める場合、component/depthKindの判定ロジック（resolveComponentFromFileName）に
  // 系統的な誤りがある可能性が高い。無警告で続けると、実質ほぼ空のデータが「成功」として
  // 扱われるのに気付けない。
  const incompleteRatio = skippedIncomplete / (skippedIncomplete + stations.length)
  if (incompleteRatio > INCOMPLETE_STATION_RATIO_LIMIT) {
    throw new Error(
      `origin=${originTimeJst}: 3成分が揃わない観測点が${Math.round(incompleteRatio * 100)}%に達しました`
      + '（成分・深度の判定ロジックに誤りがある可能性があります）',
    )
  }

  const stationSeries: StationSeries[] = stations.map((station) => {
    const startEpochSec = Math.round(station.recordStartTime.getTime() / 1000)
    let series: ReturnType<typeof computeRealtimeIntensityTimeSeries>
    try {
      series = computeRealtimeIntensityTimeSeries(
        station.components.NS,
        station.components.EW,
        station.components.UD,
        station.samplingHz,
        stepSec,
      )
    } catch (error) {
      // **どの観測点で止まったかを添える。** 近似フィルタはサンプリング周波数が低いと
      // 発散するので作る時点で止まる（`RealtimeIntensityCalculator`）。理由だけでは、
      // ZIP のどのファイルが原因か辿れない。
      throw new Error(`観測点 ${station.stationCode}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const points = series.map((p) => ({
      epochSec: startEpochSec + Math.round(p.tSec),
      intensity: p.intensity,
    }))
    return { stationCode: station.stationCode, latitude: station.latitude, longitude: station.longitude, points }
  })

  let peakIntensity = -Infinity
  for (const s of stationSeries) {
    for (const p of s.points) {
      if (p.intensity !== null && p.intensity > peakIntensity) peakIntensity = p.intensity
    }
  }
  // 全ウィンドウがデータ不足でnullだった場合、-1（欠測）だけのフレームが無警告で書き出されて
  // しまうため、他のイベントを巻き込む前にここで止める。
  if (!Number.isFinite(peakIntensity)) {
    throw new Error(
      `origin=${originTimeJst}: 有効な計測震度を1件も算出できませんでした（全ウィンドウがデータ不足でnullでした）。`
      + 'サンプリング周波数・スケールファクタ等、算出パイプラインの誤りを疑ってください',
    )
  }

  return { originTimeJst, stationSeries, peakIntensity }
}
