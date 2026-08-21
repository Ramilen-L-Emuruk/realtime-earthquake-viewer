import type { JMATsunami, TsunamiGrade, TsunamiObservation } from '../types/earthquake'

const GRADE_PRIORITY: Record<TsunamiGrade, number> = {
  MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0,
}

/** 発表中エリアの最高グレードを返す。エリアが無ければ 'Unknown'。 */
export function tsunamiMaxGrade(tsunami: JMATsunami): TsunamiGrade {
  let max: TsunamiGrade = 'Unknown'
  for (const area of tsunami.areas) {
    if (GRADE_PRIORITY[area.grade] > GRADE_PRIORITY[max]) max = area.grade
  }
  return max
}

/**
 * 等級を伝えていない電文か（区域が空 = 観測情報のみの続報。DMDATA の VTSE51②・VTSE52）。
 *
 * **この形の電文を等級の比較に混ぜないこと。** 区域が無いので `tsunamiMaxGrade` は
 * `Unknown`（最下位）を返し、発表中の警報と比べると必ず「降格」と判定される。降格の
 * 読み上げ（`tsunamiDowngradeToText`）は区域が空だと全解除の文言へフォールバックするため、
 * 警報の発表中に「津波警報等は全て解除されました」と読み上げる事故になる。
 *
 * 等級を伝えていないだけで、観測値は載っている。**観測点更新として扱うのが正しい。**
 */
export function isTsunamiObservationOnly(tsunami: JMATsunami): boolean {
  return tsunami.areas.length === 0
}

/** 複数の津波イベントを横断して最大グレードを返す。解除済み（10秒表示中のcancelledAtも含む）・Unknown は除外。なければ null。 */
export function tsunamiOverallGrade(tsunamis: JMATsunami[]): 'MajorWarning' | 'Warning' | 'Watch' | null {
  let max: TsunamiGrade | null = null
  for (const t of tsunamis) {
    if (t.cancelled || t.cancelledAt) continue
    const g = tsunamiMaxGrade(t)
    if (g !== 'Unknown' && g !== 'Forecast' && (max === null || GRADE_PRIORITY[g] > GRADE_PRIORITY[max])) max = g
  }
  return max as 'MajorWarning' | 'Warning' | 'Watch' | null
}

/**
 * 新報がタブ強制切替を発火すべき「新規発報」に当たるかを判定する。
 * `current` は現在アクティブな津波（`tsunamis[0]`、無ければ undefined）。
 * 続報（同一 eventId の観測点更新等）でタブが毎回奪われるのを防ぐため、
 * useLiveEventHandler がタブ切替判定に使う。
 *
 * true になるのは以下のいずれか:
 *   - `current` 無し
 *   - `current` が取消済み（`cancelled` or 10秒表示中の `cancelledAt`）
 *   - `current.eventId` と `next.eventId` が異なる（別地震の津波）
 *   - `eventId` が両者で欠落する場合は `sourceEarthquake.originTime` で代替判定
 *     （DMDATA XML の Earthquake 要素経由でのみ機能する。P2PQuake API v2 の
 *     生 552 電文には `earthquake` 相当のフィールドが無く `sourceEarthquake` は
 *     常に undefined になるため、標準版ではこのフォールバックは実質発火しない）
 *   - 上記いずれの識別子も取れない場合は false（保守的に続報扱い）。
 *     標準版はこの経路がデフォルトで、別地震の新規津波でもタブが奪われない
 *     （grade 格上げか手動タブ切替に依存する）
 */
export function isTsunamiNewFire(next: JMATsunami, current: JMATsunami | undefined): boolean {
  if (!current) return true
  if (current.cancelled || current.cancelledAt) return true
  if (current.eventId && next.eventId) return current.eventId !== next.eventId
  const currentOrigin = current.sourceEarthquake?.originTime
  const nextOrigin = next.sourceEarthquake?.originTime
  if (currentOrigin && nextOrigin) return currentOrigin !== nextOrigin
  return false
}

/**
 * 新報が `current` から grade 格上げに当たるかを判定する。
 * `MajorWarning > Warning > Watch > Forecast > Unknown` の順で比較。
 * `current` 無し／取消済みの場合は false（新規発報として扱うので isTsunamiNewFire 側で拾う）。
 */
export function isTsunamiGradeUpgrade(next: JMATsunami, current: JMATsunami | undefined): boolean {
  if (!current) return false
  if (current.cancelled || current.cancelledAt) return false
  const nextGrade = tsunamiMaxGrade(next)
  const currentGrade = tsunamiMaxGrade(current)
  return GRADE_PRIORITY[nextGrade] > GRADE_PRIORITY[currentGrade]
}

/**
 * 前回・今回の観測情報をマージする。VTSE51②/VTSE52（観測のみ電文）が届くたびに
 * 全観測点が再送されるとは限らないため、区域コード+観測点名をキーに upsert し、
 * 今回の電文に含まれない観測点は前回の値を保持する。
 */
export function mergeTsunamiObservations(
  prev: TsunamiObservation[] | undefined,
  next: TsunamiObservation[] | undefined,
): TsunamiObservation[] | undefined {
  if (!next || next.length === 0) return prev
  if (!prev || prev.length === 0) return next

  const key = (o: TsunamiObservation) => `${o.districtCode ?? o.districtName ?? ''}|${o.name}`
  const merged = new Map<string, TsunamiObservation>()
  for (const o of prev) merged.set(key(o), o)
  for (const o of next) merged.set(key(o), o)
  return Array.from(merged.values())
}
