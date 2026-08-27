// ParsedEewPage（historicalEewParser.ts の出力）を、アプリの HistoricalArchiveEntry 形式へ変換する。
//
// kindCode・severity の判定規則は src/utils/testData.ts の実地震テストシナリオ生成と同じ規約
// （docs/spec/settings-pwa-spec.md §7「実電文の形に合わせる」参照）:
//   - 地域別の予想震度 scaleTo が 45 以上 → kindCode '10'（警報級）、それ未満 → '00'
//   - severity（電文全体が「警報」か「予報」か）は、地域別の予想震度から逆算しない。
//     気象庁のページが公式に警報化した回だけに付ける `isPublicWarningRow` フラグを使う。
//     予想震度だけで逆算すると、後に誤りと判明する過大な初期推定のせいで、気象庁が
//     実際にはまだ「予報」として扱っていた回を「警報」と誤判定することがある
//     （実データで確認済み: 2011/3/12 04:31 長野県北部の地震で、第1報は震度5強程度以上の
//     区域を含むが、気象庁が公式に警報化したのは第3報から）。
//     一度警報化したら、以後の全報の severity は 'Warning' のまま
//     （実際のEEW運用でも、続報が予報級へ「降格」表示されることはない）
import type { HistoricalArchiveEntry } from '../src/types/historicalArchive'
import type { EEWAlert, EEWRegion, IntensityScale } from '../src/types/earthquake'
import { isValidIntensityScale } from '../src/utils/intensity'
import { parseHeadlineScale, prefFromRegionName, resolveHypocenterName, type ParsedEewPage } from './historicalEewParser'

export interface BuildEewEntriesOptions {
  /** entry.id / issue.eventId の元になる接頭辞（例: "2011tohoku-mainshock"） */
  idPrefix: string
}

/** JST の Date から気象庁 EventID 形式（YYYYMMDDHHMMSS）を作る。 */
function toEventId(originTimeIso: string): string {
  const jst = new Date(new Date(originTimeIso).getTime() + 9 * 3600_000)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
}

/** null/undefined のまま書き出すと「0(0,0)」のような偽データになる必須値を検証する。 */
function required<T>(value: T | null | undefined, label: string, context: string): T {
  if (value === null || value === undefined) throw new Error(`${context}: ${label} が取得できませんでした`)
  return value
}

function toIntensityScale(n: number, label: string, context: string): IntensityScale {
  if (!isValidIntensityScale(n)) throw new Error(`${context}: ${label} が不正な震度値です (${n})`)
  return n
}

export function buildEewEntries(parsed: ParsedEewPage, opts: BuildEewEntriesOptions): HistoricalArchiveEntry[] {
  const eventId = toEventId(parsed.hypocenter.originTimeIso)
  let hasReachedWarningOnce = false
  const entries: HistoricalArchiveEntry[] = []
  // 気象庁の発表状況ページは、そのEEWで実際に発表された全報を列挙し終えた結果を載せている
  // （後から報が追加されることはない）ため、一覧中で最大の報番号を持つ報が、その地震の
  // 最終報そのものである。isFinalが未設定のまま（常にfalsy）だと、最終報のはずの報が
  // 通常続報の音・扱いのまま再生されてしまう（selectEEWSoundTypeがisFinalを見て
  // eewFinal/eewUpdateを切り替えるため。src/utils/eew.ts参照）。
  const maxReportNum = Math.max(...parsed.reports.map((r) => r.reportNum))

  for (const report of parsed.reports) {
    if (report.reportNum === 0) continue // 検知時刻の行（震源要素のみ）は電文ではない
    const cell = report.forecastCell
    const ctx = `${opts.idPrefix} report${report.reportNum}`

    let areas: EEWRegion[] | undefined
    let forecastMaxScale: IntensityScale | undefined
    let forecastMaxScaleOrAbove: boolean | undefined

    if (cell.startsWith('※')) {
      const tiers = parsed.footnotes.get(cell)
      if (!tiers || tiers.length === 0) throw new Error(`${ctx}: footnote ${cell} が見つかりません`)
      areas = tiers.flatMap((tier) =>
        tier.regionNames.map((name) => ({
          pref: prefFromRegionName(name),
          name,
          scaleFrom: toIntensityScale(tier.scaleFrom, `${name} の scaleFrom`, ctx),
          scaleTo: toIntensityScale(tier.scaleTo, `${name} の scaleTo`, ctx),
          kindCode: tier.scaleTo >= 45 ? '10' : '00',
          arrivalTime: null,
        })),
      )
      if (areas.length === 0) throw new Error(`${ctx}: ${cell} の対象地域が0件です`)
    } else if (cell.includes('最大震度')) {
      const scale = parseHeadlineScale(cell)
      forecastMaxScale = toIntensityScale(scale, '見出し震度', ctx)
      forecastMaxScaleOrAbove = true
    } else if (cell === '—' || cell === '') {
      continue // 震度予想がまだ無い行（検知直後の最初の1〜2報に限られる）
    } else {
      throw new Error(`${ctx}: 未知の予測震度セルです "${cell}"`)
    }

    if (report.isPublicWarningRow) hasReachedWarningOnce = true

    const hypocenterMagnitude = report.magnitude ?? parsed.hypocenter.magnitude
    const event: EEWAlert = {
      kind: 'eew',
      id: `${opts.idPrefix}-eew-${report.reportNum}`,
      time: report.timeIso,
      test: false,
      earthquake: {
        originTime: parsed.hypocenter.originTimeIso,
        // 気象庁の公表資料には報ごとのS波到達予測時刻が無いため、報の発表時刻+5秒を仮の値とする
        // （per-area の arrivalTime は常に null で、アプリ側の描画はそちらを使わない）。
        arrivalTime: new Date(new Date(report.timeIso).getTime() + 5000).toISOString(),
        condition: '以上',
        hypocenter: {
          // 1ページに複数の地震が束ねて記載されることがあるため、報ごとの座標に
          // 最も近い震源候補の名前を使う（1行目を無条件採用しない）。
          name: resolveHypocenterName(report, parsed.hypocenterCandidates),
          latitude: required(report.latitude ?? parsed.hypocenter.latitude, '緯度', ctx),
          longitude: required(report.longitude ?? parsed.hypocenter.longitude, '経度', ctx),
          depth: required(report.depthKm ?? parsed.hypocenter.depthKm, '深さ', ctx),
          magnitude: required(hypocenterMagnitude, 'マグニチュード', ctx),
        },
      },
      severity: hasReachedWarningOnce ? 'Warning' : 'Forecast',
      cancelled: false,
      isFinal: report.reportNum === maxReportNum,
      issue: { eventId, serial: String(report.reportNum), time: report.timeIso },
      ...(areas ? { areas } : {}),
      ...(forecastMaxScale !== undefined ? { forecastMaxScale, forecastMaxScaleOrAbove } : {}),
    }

    entries.push({ time: report.timeIso, payload: { kind: 'event', event } })
  }

  if (entries.length > 0 && !entries.some((e) => (e.payload as { event: EEWAlert }).event.isFinal)) {
    throw new Error(`${opts.idPrefix}: 最終報（報番号${maxReportNum}）が震度予想なしの行としてスキップされ、isFinalを持つ報が1件もありません`)
  }

  return entries
}
