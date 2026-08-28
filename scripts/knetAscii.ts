// K-NET/KiK-net ASCII形式（防災科研 強震観測網）の波形ファイルのパーサー。
// 仕様: https://www.kyoshin.bosai.go.jp/ja/knetascii/
//
// ヘッダーは17行の「キー・値」形式で、18行目以降に1行8列の符号付き整数（生カウント値）が
// 並ぶ。キーと値の区切りはタブではなく**固定幅の列位置**（実データで確認済み）: キーは短くても
// 長くても値の開始列が揃うよう空白でパディングされるため、短いキー（"Lat."等）の後には空白が
// 何個も並ぶ一方、長いキー（"Sampling Freq(Hz)"等）は列幅に迫るため空白1個だけのこともある。
// 「2文字以上の連続空白を区切りとみなす」という判定は後者で壊れるため使わず、既知のキー文字列を
// 行頭から直接照合し、それより後ろを値として切り出す（`matchField`）。
//
// 2018年北海道胆振東部地震の実ファイル（本震、観測点FKS007）で以下を確認済み:
//   "Sampling Freq(Hz) 100Hz"（"(Hz)"と"100Hz"の間は空白1個のみ）
//   "Origin Time       2018/09/06 03:08:00"（短いキーなので空白多数）

export type KnetComponent = 'NS' | 'EW' | 'UD'
/** KiK-netは地表(surface)・地中(borehole)の2深度を持つ。K-NETはsurfaceのみ。 */
export type KnetDepthKind = 'surface' | 'borehole'

export interface KnetAsciiFile {
  stationCode: string
  /** 観測点の緯度・経度（度）。 */
  latitude: number
  longitude: number
  samplingHz: number
  /** 生カウント値 → gal 換算の倍率（numerator/denominator）。 */
  scaleFactor: { numerator: number; denominator: number }
  /** 記録開始時刻（UTC）。ヘッダーの `Record Time` はJSTのため変換済み。 */
  recordStartTime: Date
  component: KnetComponent
  depthKind: KnetDepthKind
  /** 生のカウント値（gal換算前）。 */
  rawCounts: number[]
}

/** ヘッダーの行数（Memo.行を含む。実データで確認済み）。 */
const HEADER_LINE_COUNT = 17

/**
 * 行が既知のキー文字列（候補を複数指定可）で始まっていれば、それに続く部分を値として返す。
 * 表記ゆれ（"Long."か"Lon."か等）に備えて候補を複数持てるようにしている。
 */
function matchField(line: string, ...keys: string[]): string | null {
  for (const key of keys) {
    if (line.startsWith(key)) return line.slice(key.length).trim()
  }
  return null
}

/** ファイル名の拡張子から成分・深度を判定する（K-NET: .NS/.EW/.UD、KiK-net: .NS1/.EW1/.UD1=地中、.NS2/.EW2/.UD2=地表）。 */
export function resolveComponentFromFileName(fileName: string): { component: KnetComponent; depthKind: KnetDepthKind } {
  const m = /\.(NS|EW|UD)([12])?$/i.exec(fileName)
  if (!m) throw new Error(`ファイル名から成分(NS/EW/UD)を判定できません: "${fileName}"`)
  const component = m[1].toUpperCase() as KnetComponent
  const depthKind: KnetDepthKind = m[2] === '1' ? 'borehole' : 'surface'
  return { component, depthKind }
}

/** "3920(gal)/8388608" 形式のスケールファクタを分数に分解する。 */
function parseScaleFactor(value: string, ctx: string): { numerator: number; denominator: number } {
  const m = /^([\d.]+)\s*\([^)]*\)\s*\/\s*([\d.]+)$/.exec(value)
  if (!m) throw new Error(`${ctx}: Scale Factor の形式が不明です "${value}"`)
  const numerator = parseFloat(m[1])
  const denominator = parseFloat(m[2])
  if (!(denominator > 0)) throw new Error(`${ctx}: Scale Factor の分母が不正です "${value}"`)
  return { numerator, denominator }
}

/** "100Hz" のような値から数値だけを取り出す。 */
function parseSamplingHz(value: string, ctx: string): number {
  const n = parseFloat(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${ctx}: Sampling Freq を解釈できません "${value}"`)
  return n
}

/** "2018/09/06 03:08:04"（JST）をUTCのDateへ変換する。 */
function parseJstDateTime(value: string, ctx: string): Date {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (!m) throw new Error(`${ctx}: 日時の形式が不明です "${value}"`)
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[]
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3600_000)
}

/**
 * K-NET/KiK-net ASCII形式のファイル本文を解析する。
 * @param fileName グループ化（成分・深度判定）に使う。パス区切りは含まない拡張子付きファイル名。
 */
export function parseKnetAsciiFile(text: string, fileName: string): KnetAsciiFile {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length <= HEADER_LINE_COUNT) {
    throw new Error(`${fileName}: ヘッダー行数(${HEADER_LINE_COUNT}行)に満たないデータです`)
  }
  if (!lines[HEADER_LINE_COUNT - 1].startsWith('Memo.')) {
    throw new Error(
      `${fileName}: ${HEADER_LINE_COUNT}行目が"Memo."で始まっていません`
      + '（ヘッダー行数の前提が実ファイルと食い違っている可能性があります）',
    )
  }

  let stationCode: string | null = null
  let latitude: number | null = null
  let longitude: number | null = null
  let samplingHz: number | null = null
  let scaleFactor: { numerator: number; denominator: number } | null = null
  let recordStartTime: Date | null = null

  for (let i = 0; i < HEADER_LINE_COUNT; i++) {
    const line = lines[i]
    const ctx = `${fileName} ヘッダー`
    let v: string | null
    if ((v = matchField(line, 'Station Code')) !== null) stationCode = v
    else if ((v = matchField(line, 'Station Lat.', 'Station Lat')) !== null) latitude = parseFloat(v)
    else if ((v = matchField(line, 'Station Long.', 'Station Lon.')) !== null) longitude = parseFloat(v)
    else if ((v = matchField(line, 'Sampling Freq(Hz)', 'Sampling Freq (Hz)')) !== null) samplingHz = parseSamplingHz(v, ctx)
    else if ((v = matchField(line, 'Scale Factor')) !== null) scaleFactor = parseScaleFactor(v, ctx)
    else if ((v = matchField(line, 'Record Time')) !== null) recordStartTime = parseJstDateTime(v, ctx)
    // 他の行（Origin Time・Lat.・Long.・Depth.・Mag.・Station Height・Duration Time・Dir.・
    // Max. Acc.・Last Correction・Memo.）はこの用途では使わないため素通しする。
  }

  if (stationCode === null) throw new Error(`${fileName}: Station Code が見つかりません`)
  if (latitude === null || !Number.isFinite(latitude)) throw new Error(`${fileName}: Station Lat. が見つかりません`)
  if (longitude === null || !Number.isFinite(longitude)) throw new Error(`${fileName}: Station Long. が見つかりません`)
  if (samplingHz === null) throw new Error(`${fileName}: Sampling Freq(Hz) が見つかりません`)
  if (scaleFactor === null) throw new Error(`${fileName}: Scale Factor が見つかりません`)
  if (recordStartTime === null) throw new Error(`${fileName}: Record Time が見つかりません`)

  const rawCounts: number[] = []
  for (let i = HEADER_LINE_COUNT; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    for (const token of line.split(/\s+/)) {
      const n = Number(token)
      if (!Number.isFinite(n)) throw new Error(`${fileName}: データ行に数値でないトークンがあります ("${token}", 行${i + 1})`)
      rawCounts.push(n)
    }
  }
  if (rawCounts.length === 0) throw new Error(`${fileName}: データが0件です`)

  const { component, depthKind } = resolveComponentFromFileName(fileName)

  return {
    stationCode,
    latitude,
    longitude,
    samplingHz,
    scaleFactor,
    recordStartTime,
    component,
    depthKind,
    rawCounts,
  }
}

/** 生カウント値をgal（cm/s²）へ換算する。 */
export function countsToGal(file: KnetAsciiFile): number[] {
  const { numerator, denominator } = file.scaleFactor
  const factor = numerator / denominator
  return file.rawCounts.map((c) => c * factor)
}

export interface KnetStation {
  stationCode: string
  latitude: number
  longitude: number
  samplingHz: number
  recordStartTime: Date
  /** gal換算済みの3成分波形（地表）。 */
  components: { NS: number[]; EW: number[]; UD: number[] }
}

/**
 * 複数のK-NET/KiK-netファイルを観測点ごとにグループ化し、3成分（NS/EW/UD）を揃える。
 * KiK-netの地中(borehole)成分は無視し、地表(surface)のみを採用する
 * （体感・気象庁の震度観測に対応するのは地表のため）。
 * 3成分が揃わない観測点（記録の欠落・故障等でNIED側が非公開にしている等）は結果から除外し、
 * 除外件数を呼び出し側へ返す。
 */
export function groupIntoStations(files: KnetAsciiFile[]): { stations: KnetStation[]; skippedIncomplete: number } {
  const surface = files.filter((f) => f.depthKind === 'surface')
  const byStation = new Map<string, Partial<Record<KnetComponent, KnetAsciiFile>>>()
  for (const f of surface) {
    const entry = byStation.get(f.stationCode) ?? {}
    entry[f.component] = f
    byStation.set(f.stationCode, entry)
  }

  const stations: KnetStation[] = []
  let skippedIncomplete = 0
  for (const [stationCode, entry] of byStation) {
    if (!entry.NS || !entry.EW || !entry.UD) {
      skippedIncomplete += 1
      continue
    }
    stations.push({
      stationCode,
      latitude: entry.NS.latitude,
      longitude: entry.NS.longitude,
      samplingHz: entry.NS.samplingHz,
      recordStartTime: entry.NS.recordStartTime,
      components: {
        NS: countsToGal(entry.NS),
        EW: countsToGal(entry.EW),
        UD: countsToGal(entry.UD),
      },
    })
  }
  return { stations, skippedIncomplete }
}
