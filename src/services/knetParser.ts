import type { KnetChannel, KnetRecord } from '../types/replay'

// "2011/03/11 14:46:18" → Date（ローカル時刻として解釈）
function parseLocalDate(s: string): Date {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!m) throw new Error(`日付フォーマット不正: "${s}"`)
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  )
}

// "6519(gal)/32768" → gal/unit 変換係数
function parseScaleFactor(sf: string): number {
  const m = sf.match(/([\d.]+)\([^)]+\)\/([\d.]+)/)
  if (!m) throw new Error(`Scale Factor フォーマット不正: "${sf}"`)
  return parseFloat(m[1]) / parseFloat(m[2])
}

export interface KnetFileData {
  channel: KnetChannel
  originTime: Date
  lat: number
  lng: number
  depthKm: number
  magnitude: number
  stationCode: string
  stationLat: number
  stationLng: number
  stationHeightM: number
}

export function parseKnetAscii(text: string): KnetFileData {
  const lines = text.split(/\r?\n/)
  const headers: Record<string, string> = {}
  let dataStart = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('Memo.')) {
      dataStart = i + 1
      break
    }
    // "Key   Value" 形式（2文字以上の空白で区切り）
    const idx = line.search(/\s{2,}/)
    if (idx > 0) {
      headers[line.slice(0, idx).trim()] = line.slice(idx).trim()
    }
  }

  if (dataStart < 0) throw new Error('K-NET ASCII 形式エラー: "Memo." が見つかりません')

  // 波形データ（空白区切り整数）
  const rawValues: number[] = []
  for (let i = dataStart; i < lines.length; i++) {
    for (const token of lines[i].trim().split(/\s+/)) {
      const n = parseInt(token, 10)
      if (!isNaN(n)) rawValues.push(n)
    }
  }

  if (rawValues.length === 0) throw new Error('K-NET ASCII 形式エラー: 波形データが空です')

  const scaleGalPerUnit = parseScaleFactor(headers['Scale Factor'] ?? '')
  const samplingHz = parseFloat(headers['Sampling Freq(Hz)'] ?? '100')
  const durationSec = parseFloat(headers['Duration Time(s)'] ?? '0')
  const direction = headers['Dir.'] ?? '?'
  const maxAccGal = parseFloat(headers['Max. Acc. (gal)'] ?? '0')
  const recordTimeStr = headers['Record Time'] ?? ''
  const recordTime = parseLocalDate(recordTimeStr)

  const channel: KnetChannel = {
    direction,
    samplingHz,
    recordTime,
    durationSec,
    maxAccGal,
    scaleGalPerUnit,
    data: rawValues.map(v => v * scaleGalPerUnit),
  }

  const originTimeStr = headers['Originated time'] ?? headers['Origin Time'] ?? ''
  if (!originTimeStr) throw new Error('K-NET ASCII 形式エラー: "Originated time" が見つかりません')

  return {
    channel,
    originTime: parseLocalDate(originTimeStr),
    lat: parseFloat(headers['Lat.'] ?? '0'),
    lng: parseFloat(headers['Long.'] ?? '0'),
    depthKm: parseFloat(headers['Depth. (km)'] ?? '0'),
    magnitude: parseFloat(headers['Mag.'] ?? '0'),
    stationCode: headers['Station Code'] ?? '',
    stationLat: parseFloat(headers['Station Lat.'] ?? '0'),
    stationLng: parseFloat(headers['Station Long.'] ?? '0'),
    stationHeightM: parseFloat(headers['Station Height(m)'] ?? '0'),
  }
}

// 複数ファイル（NS/EW/UD）→ KnetRecord
export function buildKnetRecord(files: KnetFileData[]): KnetRecord {
  if (files.length === 0) throw new Error('K-NET ファイルが選択されていません')
  const first = files[0]
  return {
    originTime: first.originTime,
    lat: first.lat,
    lng: first.lng,
    depthKm: first.depthKm,
    magnitude: first.magnitude,
    stationCode: first.stationCode,
    stationLat: first.stationLat,
    stationLng: first.stationLng,
    stationHeightM: first.stationHeightM,
    channels: files.map(f => f.channel),
  }
}
