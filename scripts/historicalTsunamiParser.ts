// 気象庁「発表した津波警報・注意報の検証」ページ（tsunamihyoka）を機械的にパースする。
//
// 対象ページの例:
//   https://www.data.jma.go.jp/eqev/data/tsunamihyoka/20110311Tohokuchihoutaiheiyouoki/index.html
//
// 「発表した津波警報・注意報の概要」表と「津波の観測」表（予測高さ・観測高さ）を読む。
// ページ構造は固定（class="data mtx" の2テーブル、大津波/津波/注意報は
// span.ootsunamitxt / span.tsunamitxt / 無印テキストで区切られる）。
import { JSDOM } from 'jsdom'

export interface ParsedTsunamiStage {
  /** 「３月11日」等、和暦月日（年は呼び出し側が別途持つ） */
  monthDay: string
  /** 「14時49分」等 */
  timeText: string
  /** 概要欄（切替・解除等の説明文） */
  summary: string
  majorWarning: string[]
  warning: string[]
  watch: string[]
  /** 全予報区解除など、地域名を伴わない特殊行なら true */
  isFullCancel: boolean
}

export interface ParsedTsunamiObservationRow {
  regionName: string
  grade: 'ootsunami' | 'tsunami' | 'chuui'
  /** 予測欄の原文（例: "大津波(6m)"） */
  predictedText: string
  predictedHeightM: number | null
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

/**
 * @param isFullCancel 全予報区解除の行（「全ての予報区」とだけ書かれ、3区分のいずれの
 *   プレフィックスも付かない特殊行）なら true。この場合だけ、プレフィックスに一致しない
 *   行があっても例外にしない（正しく空扱いになる）。
 */
function parseAnnouncementCell(
  cellHtml: string,
  isFullCancel: boolean,
): { majorWarning: string[]; warning: string[]; watch: string[] } {
  const withoutComments = cellHtml.replace(/<!--[\s\S]*?-->/g, '')
  const lines = withoutComments
    .split(/<br\s*\/?>/i)
    .map((l) => stripTags(l).replace(/　/g, ' ').trim())
    .filter(Boolean)
  const result = { majorWarning: [] as string[], warning: [] as string[], watch: [] as string[] }
  for (const line of lines) {
    if (line.startsWith('→')) continue // 発表区域地図（png）へのリンク行。地域データではない
    const m = line.match(/^(津波警報（大津波）|津波警報（津波）|津波注意報)：\s*(.*)$/)
    if (!m) {
      // 未知の行を黙って捨てると、気象庁側の文言変更に気づけないまま地域が欠落する。
      if (isFullCancel) continue
      throw new Error(`発表内容の行を解析できません: "${line}"`)
    }
    const regions = m[2].split('、').map((s) => s.trim()).filter(Boolean)
    if (m[1] === '津波警報（大津波）') result.majorWarning.push(...regions)
    else if (m[1] === '津波警報（津波）') result.warning.push(...regions)
    else result.watch.push(...regions)
  }
  return result
}

export function parseTsunamiEvaluationHtml(html: string): {
  stages: ParsedTsunamiStage[]
  observations: ParsedTsunamiObservationRow[]
} {
  const dom = new JSDOM(html)
  const doc = dom.window.document

  const tables = [...doc.querySelectorAll('table.data.mtx')]
  const announcementTable = tables.find((t) => t.textContent?.includes('発表予報区'))
  if (!announcementTable) throw new Error('発表予報区の表が見つかりません')

  const stages: ParsedTsunamiStage[] = []
  let lastMonthDay = ''
  for (const row of announcementTable.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('td')]
    if (cells.length === 0) continue // ヘッダ行（th のみ）
    // データ行は常に4列。列が欠けている（表構成が変わった）のに空データとして
    // 通してしまうと、「その回は何も発表しなかった」と区別が付かなくなる。
    if (cells.length !== 4) throw new Error(`発表予報区テーブルの行の列数が想定外です（4列のはずが${cells.length}列）`)
    const monthDayText = cells[0].textContent?.trim() ?? ''
    if (monthDayText) lastMonthDay = monthDayText
    const timeText = cells[1].textContent?.trim() ?? ''
    const summary = cells[2].textContent?.replace(/\s+/g, '') ?? ''
    const announceHtml = cells[3].innerHTML
    const plainText = stripTags(announceHtml.replace(/<!--[\s\S]*?-->/g, '')).trim()
    const isFullCancel = plainText.includes('全ての予報区')
    const { majorWarning, warning, watch } = parseAnnouncementCell(announceHtml, isFullCancel)
    stages.push({ monthDay: lastMonthDay, timeText, summary, majorWarning, warning, watch, isFullCancel })
  }
  if (stages.length === 0) throw new Error('発表予報区テーブルから1件も読めませんでした')

  const observationTable = tables.find((t) => t.textContent?.includes('予報区内で観測した津波の高さの最大'))
  if (!observationTable) throw new Error('津波の観測表が見つかりません')
  const observations: ParsedTsunamiObservationRow[] = []
  for (const row of observationTable.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('td')]
    if (cells.length === 0) continue // ヘッダ行（th のみ）
    if (cells.length !== 3) throw new Error(`津波の観測テーブルの行の列数が想定外です（3列のはずが${cells.length}列）`)
    const regionName = cells[0].textContent?.trim() ?? ''
    const predictedText = cells[1].textContent?.trim() ?? ''
    const cls = cells[0].getAttribute('class')
    if (cls !== 'ootsunami' && cls !== 'tsunami' && cls !== 'chuui') {
      throw new Error(`津波の観測テーブルの等級classが想定外です: "${cls}"（地域: ${regionName}）`)
    }
    const heightMatch = predictedText.match(/([\d.]+)\s*m/)
    observations.push({
      regionName,
      grade: cls,
      predictedText,
      predictedHeightM: heightMatch ? Number(heightMatch[1]) : null,
    })
  }
  if (observations.length === 0) throw new Error('津波の観測テーブルから1件も読めませんでした')

  return { stages, observations }
}
