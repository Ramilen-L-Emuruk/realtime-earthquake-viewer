// 気象庁「緊急地震速報（警報）発表状況」の個別ページ（content_out.html）を機械的にパースし、
// アプリの ReplayPayload EEW 形式（EEWAlert）へ変換する。
//
// 対象ページの例:
//   https://www.data.jma.go.jp/eew/data/nc/pub_hist/2011/03/20110311144640/content/content_out.html
// 一覧（年月をまたいで辿れる）:
//   https://www.data.jma.go.jp/eew/data/nc/pub_hist/index.html
//
// ページ構造は固定（#hypocentral_element_list / #information_list / .eew_estimate_intensity_list
// の3テーブル）。過去の手作業書き起こしでは報番号のラベルがぶれる事故が起きたため、
// 生HTMLを直接パースしてこの手作業を排除する。
import { JSDOM } from 'jsdom'

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export interface ParsedEewHypocenter {
  originTimeIso: string
  name: string
  latitude: number | null
  longitude: number | null
  depthKm: number | null
  magnitude: number | null
  maxIntensityText: string
}

export interface ParsedEewReport {
  /** 0 = 地震波検知時刻（震源要素のみ、震度予想なし） */
  reportNum: number
  timeIso: string
  latitude: number | null
  longitude: number | null
  depthKm: number | null
  magnitude: number | null
  /** 「最大震度４程度以上」等の見出しテキスト、または「※N」参照、あるいは "—" */
  forecastCell: string
  /**
   * 気象庁が公式に「緊急地震速報（警報）」として発表した回であることを示す行
   * （`&lt;tr class="eew_public_warning_row"&gt;`）かどうか。地域別の予想震度から
   * 警報級かどうかを逆算すると、公式の警報化タイミングより早く「警報」と誤判定する
   * ことがある（実データで確認済み）ため、severityの判定は必ずこのフラグを使う。
   */
  isPublicWarningRow: boolean
}

export interface ParsedEewAreaTier {
  scaleFrom: number
  scaleTo: number
  regionNames: string[]
}

export interface ParsedEewPage {
  /** #hypocentral_element_list の1行目（最初の震源候補）。originTime・eventIdの元。 */
  hypocenter: ParsedEewHypocenter
  /**
   * #hypocentral_element_list の全データ行。ほぼ同時刻に発生した別々の地震が
   * 1ページに束ねて記載されることがあり（実データで20件中8件確認）、その場合は
   * 複数行になる。各reportの震央地名は、reportの座標に最も近い候補から選ぶ
   * （1行目を無条件採用すると、reportの座標と無関係な地震名が付くことがある）。
   */
  hypocenterCandidates: ParsedEewHypocenter[]
  reports: ParsedEewReport[]
  /** キーは "※1" 等 */
  footnotes: Map<string, ParsedEewAreaTier[]>
}

/**
 * reportの座標に最も近い震源候補の震央地名を返す（複数の地震が1ページに
 * 束ねられている場合、reportごとに追跡している地震が違うことがあるため）。
 * 候補が1件しかない場合はそれをそのまま返す。
 */
export function resolveHypocenterName(
  report: Pick<ParsedEewReport, 'latitude' | 'longitude'>,
  candidates: ParsedEewHypocenter[],
): string {
  if (candidates.length === 1) return candidates[0].name
  if (report.latitude === null || report.longitude === null) return candidates[0].name
  let best = candidates[0]
  let bestDist = Infinity
  for (const c of candidates) {
    if (c.latitude === null || c.longitude === null) continue
    const d = (c.latitude - report.latitude) ** 2 + (c.longitude - report.longitude) ** 2
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best.name
}

/** 「平成23年03月11日14時46分18.1秒」形式（和暦・JST）を UTC ISO へ変換する。 */
export function parseWarekiDateTime(text: string): string {
  const m = text.match(/平成(\d+)年(\d+)月(\d+)日(\d+)時(\d+)分([\d.]+)秒/)
  if (!m) throw new Error(`和暦日時を解析できません: ${text}`)
  const [, heiseiYear, month, day, hour, minute, second] = m
  const year = 1988 + Number(heiseiYear)
  const wholeSec = Math.floor(Number(second))
  const ms = Math.round((Number(second) - wholeSec) * 1000)
  const jstMs = Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute), wholeSec, ms)
  return new Date(jstMs - JST_OFFSET_MS).toISOString()
}

/** 「14時46分45.6秒」形式（時刻のみ・JST）を、同じ日付を仮定して UTC ISO へ変換する。 */
export function parseTimeOnly(text: string, referenceIsoDate: string): string {
  const m = text.match(/(\d+)時(\d+)分([\d.]+)秒/)
  if (!m) throw new Error(`時刻を解析できません: ${text}`)
  const [, hour, minute, second] = m
  const ref = new Date(referenceIsoDate)
  const wholeSec = Math.floor(Number(second))
  const ms = Math.round((Number(second) - wholeSec) * 1000)
  // referenceIsoDate は UTC ISO（JST-9h済み）なので、JST の年月日を復元してから組み直す。
  const jstRef = new Date(ref.getTime() + JST_OFFSET_MS)
  const jstMs = Date.UTC(jstRef.getUTCFullYear(), jstRef.getUTCMonth(), jstRef.getUTCDate(), Number(hour), Number(minute), wholeSec, ms)
  // 日付をまたぐ報（例: 23:59台の検知から日付が変わる場合）に対応する。
  // 注: 2011年東北地方太平洋沖地震の本震・誘発地震19件はいずれも日付をまたがず、
  // この分岐は実データでは一度も通っていない（ユニットテストのみで担保）。
  let resultMs = jstMs - JST_OFFSET_MS
  const refOriginMs = ref.getTime()
  if (resultMs < refOriginMs - 12 * 3600_000) resultMs += 24 * 3600_000
  return new Date(resultMs).toISOString()
}

// 未確定・未入力を表す表記が発表状況ページによって揺れる（em dash「—」の他に、
// 2018年大阪府北部地震のページでは半角ハイフン2つ「--」が使われていた。実データで
// 確認済み）。既知の表記だけを「値なし」として許容し、それ以外は例外にする（黙って
// null にすると、後段が "分からない" と "壊れている" を区別できなくなる）。
// このSetは緯度・経度・深さ・マグニチュードといった数値セル共通の表記だけを持つ。
// 予測震度セル（historicalEewArchiveBuilder.ts）は「予測震度なし」という別の文言も
// 「値なし」として扱うが、これを混ぜると数値セル側がこの文言を誤って受理してしまう
// ため、意図的にこのSetには含めず消費側で別途チェックしている（一度「ここに集約する」
// と書いていたが実態と異なっていたため訂正）。
export const NO_VALUE_MARKERS = new Set(['—', '--', ''])

/**
 * 「38°06.2′」形式を10進度へ変換する。
 */
export function parseDegMin(text: string): number | null {
  const t = text.trim()
  if (NO_VALUE_MARKERS.has(t)) return null
  const m = t.match(/(\d+)°([\d.]+)′/)
  if (!m) throw new Error(`度分表記を解析できません: "${text}"`)
  return Number(m[1]) + Number(m[2]) / 60
}

function parseKm(text: string): number | null {
  const t = text.trim()
  if (NO_VALUE_MARKERS.has(t)) return null
  const m = t.match(/^([\d.]+)\s*km$/)
  if (!m) throw new Error(`深さを解析できません: "${text}"`)
  return Number(m[1])
}

function parseNumericCell(text: string): number | null {
  const t = text.trim()
  if (NO_VALUE_MARKERS.has(t)) return null
  const n = Number(t)
  if (!Number.isFinite(n)) throw new Error(`数値を解析できません: "${text}"`)
  return n
}

/** 全角数字（０-９）を半角へ変換する。震度ラベルは全角数字で書かれている。 */
export function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

/**
 * 震度ラベル中の数字(+弱/強)トークンを IntensityScale 値へ変換する。
 * 5弱=45 5強=50 6弱=55 6強=60、それ以外(1〜4,7)は10倍。
 */
export function intensityTokenToScale(digit: string, suffix: string | undefined): number {
  const d = Number(digit)
  if (d === 5) return suffix === '強' ? 50 : 45
  if (d === 6) return suffix === '強' ? 60 : 55
  return d * 10
}

/**
 * 「震度４程度」「震度４から５弱程度」等のラベルから [scaleFrom, scaleTo] を抽出する。
 * トークンが1つなら scaleFrom=scaleTo。
 */
export function parseTierLabel(label: string): [number, number] {
  const tokens = [...toHalfWidthDigits(label).matchAll(/(\d)(弱|強)?/g)].map((m) => intensityTokenToScale(m[1], m[2]))
  if (tokens.length === 0) throw new Error(`震度ラベルを解析できません: ${label}`)
  if (tokens.length === 1) return [tokens[0], tokens[0]]
  return [tokens[0], tokens[1]]
}

/** 「最大震度４程度以上」等の見出しテキストから単一の震度値を抽出する。 */
export function parseHeadlineScale(text: string): number {
  const m = toHalfWidthDigits(text).match(/(\d)(弱|強)?/)
  if (!m) throw new Error(`見出し震度を解析できません: ${text}`)
  return intensityTokenToScale(m[1], m[2])
}

export function parseEewContentHtml(html: string): ParsedEewPage {
  const dom = new JSDOM(html)
  const doc = dom.window.document

  const hypoTable = doc.getElementById('hypocentral_element_list')
  if (!hypoTable) throw new Error('#hypocentral_element_list が見つかりません')
  const hypoDataRows = [...hypoTable.querySelectorAll('tr')].slice(1) // 先頭行はヘッダ
  if (hypoDataRows.length === 0) throw new Error('#hypocentral_element_list にデータ行がありません')
  const hypocenterCandidates: ParsedEewHypocenter[] = hypoDataRows.map((row) => {
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '')
    if (cells.length !== 7) throw new Error(`震源要素テーブルの行の列数が想定外です（7列のはずが${cells.length}列）: ${cells.join('|')}`)
    return {
      originTimeIso: parseWarekiDateTime(cells[0]),
      name: cells[1],
      latitude: parseDegMin(cells[2]),
      longitude: parseDegMin(cells[3]),
      depthKm: parseKm(cells[4]),
      magnitude: parseNumericCell(cells[5]),
      maxIntensityText: cells[6],
    }
  })
  const hypocenter = hypocenterCandidates[0]

  const infoTable = doc.getElementById('information_list')
  if (!infoTable) throw new Error('#information_list が見つかりません')
  const infoRows = [...infoTable.querySelectorAll('tr')].slice(3) // 先頭3行はヘッダ
  const reports: ParsedEewReport[] = []
  for (const row of infoRows) {
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '')
    // 本文行は常に8列（検知時刻行・報番号行とも）。列数が違う行が来たら、
    // ページ構成が想定と変わっている証拠なので黙って読み飛ばさず例外にする。
    if (cells.length !== 8) throw new Error(`情報テーブルの行の列数が想定外です（8列のはずが${cells.length}列）: ${cells.join('|')}`)
    const isDetectionRow = cells[0].includes('検知')
    let reportNum: number
    if (isDetectionRow) {
      reportNum = 0
    } else {
      const n = Number(cells[0].trim())
      // Number('') は 0 になり、検知時刻行の番号(0)と区別が付かなくなるため、
      // 整数かどうかを明示的に検証する（"" や不正な文字列を 0 として通さない）。
      if (!Number.isInteger(n) || n <= 0) throw new Error(`報番号を解析できません: "${cells[0]}"`)
      reportNum = n
    }
    const timeIso = parseTimeOnly(cells[1], hypocenter.originTimeIso)
    reports.push({
      reportNum,
      timeIso,
      latitude: parseNumericCell(cells[3]),
      longitude: parseNumericCell(cells[4]),
      depthKm: parseKm(cells[5]),
      magnitude: parseNumericCell(cells[6]),
      forecastCell: cells[7],
      isPublicWarningRow: row.classList.contains('eew_public_warning_row'),
    })
  }

  const footnotes = new Map<string, ParsedEewAreaTier[]>()
  const tierTable = doc.querySelector('.eew_estimate_intensity_list')
  if (tierTable) {
    let currentKey: string | null = null
    for (const row of tierTable.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '')
      let tierLabel: string
      let regionText: string
      if (cells.length === 3) {
        currentKey = cells[0]
        tierLabel = cells[1]
        regionText = cells[2]
      } else if (cells.length === 2 && currentKey) {
        tierLabel = cells[0]
        regionText = cells[1]
      } else {
        throw new Error(`震度別対象地域テーブルの行が想定外の形です: ${cells.join('|')}`)
      }
      const [scaleFrom, scaleTo] = parseTierLabel(tierLabel)
      const regionNames = regionText.split('、').map((s) => s.trim()).filter(Boolean)
      if (regionNames.length === 0) throw new Error(`${currentKey} の対象地域が0件です: "${regionText}"`)
      const list = footnotes.get(currentKey) ?? []
      list.push({ scaleFrom, scaleTo, regionNames })
      footnotes.set(currentKey, list)
    }
  }

  return { hypocenter, hypocenterCandidates, reports, footnotes }
}

/** EEW地域名（例: "岩手県沿岸南部" "東京都２３区" "北海道太平洋沿岸東部"）から都道府県名を取り出す。 */
export function prefFromRegionName(name: string): string {
  const m = name.match(/^(.+?[都道府県])/)
  return m ? m[1] : name
}
