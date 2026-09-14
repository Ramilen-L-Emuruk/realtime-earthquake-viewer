import { quakeReportLabels } from '../utils/formatters'
import type { IssueType, QuakeReportRecord } from '../types/earthquake'

/**
 * 記録された電文種別を 1 行で表す（テスト用）。
 *
 * **画面の見た目ではない** —— 画面は種別名と報番号を別の要素に分けて出す
 * （→ `components/SerialBadge.tsx`）。ここで見たいのは「どの種別が何通と記録されたか」
 * なので、読みやすい形へ畳んで比べる。
 *
 * **2 つのテストファイルで共有する**（`utils/quakeMerge.test.ts` と `utils/testData.test.ts`）。
 * 別々に持つと、畳み方を変えたときに片方だけ古くなる。
 */
export const reportsText = (reports: QuakeReportRecord[] | undefined, fallback: IssueType): string =>
  quakeReportLabels(reports, fallback)
    .map(l => (l.count != null ? `${l.type}#${l.count}` : l.type))
    .join('/')
