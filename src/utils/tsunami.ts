import type { JMATsunami, TsunamiArea, TsunamiGrade, TsunamiObservation } from '../types/earthquake'

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

// ============================================================
// カード表示順（区域の並べ替え）
//
// 読み上げ（`ttsText.ts`）とカード（`TsunamiTab`）は**同じ並び順を使う**。
// 食い違うと、読み上げに合わせたカードの追従スクロールが上下交互に往復する
// （詳細は docs/spec/audio-tts-spec.md §4）。そのためカード専用ではなく
// ここに置き、双方から参照する。
// ============================================================

/**
 * 観測情報が属する津波予報区（districtCode/districtName）を発表区域（area.code/area.name）に紐づける。
 * code が双方にあれば code を優先。無ければ name で照合する。
 */
export function matchesArea(obs: TsunamiObservation, area: TsunamiArea): boolean {
  if (obs.districtCode && area.code) return obs.districtCode === area.code
  return !!obs.districtName && obs.districtName === area.name
}

/** 予想波高ごとの区域グループ（カードの波高見出しの単位）。 */
export interface TsunamiHeightGroup {
  heightLabel: string | null
  areas: TsunamiArea[]
}

/**
 * 読み上げ・表示に使える予想波高を持つか。
 *
 * **`maxHeight` の有無では判定しない。** 電文の解析（`dmdataParser`）は数値が取れれば
 * `maxHeight` を作るが、値が 0 で条件（「巨大」等）も無いときは `description` が空文字になる。
 * オブジェクトの有無で見ると、カードは波高なしとして扱うのに読み上げは波高ありとして扱い、
 * **その区域がどちらの文にも現れない**（黙って落ちる）。判定はここに一本化する。
 */
export function hasForecastHeight(area: TsunamiArea): boolean {
  return !!area.maxHeight?.description
}

/**
 * 同一階級内で、予想波高（maxHeight.description）が連続して一致する区域を1グループにまとめる。
 * 電文内の区域順序は維持し、離れた位置にある同じ波高の区域まではまとめない。
 */
function groupAreasByHeight(areas: TsunamiArea[]): TsunamiHeightGroup[] {
  const groups: { heightLabel: string | null; areas: TsunamiArea[] }[] = []
  for (const area of areas) {
    const label = hasForecastHeight(area) ? area.maxHeight!.description : null
    const last = groups[groups.length - 1]
    if (label && last && last.heightLabel === label) {
      last.areas.push(area)
    } else {
      groups.push({ heightLabel: label, areas: [area] })
    }
  }
  return groups
}

// 区域に紐づく観測点のうち、実測値（height）が最も高いものを返す。
// value が同点の場合は over（「以上」）を優先する。実測値を持つ観測点が無ければ null。
function maxObservedHeight(area: TsunamiArea, observations: TsunamiObservation[]): { value: number; over: boolean } | null {
  let max: { value: number; over: boolean } | null = null
  for (const obs of observations) {
    if (!obs.height || !matchesArea(obs, area)) continue
    const candidate = { value: obs.height.value, over: !!obs.height.over }
    if (!max || candidate.value > max.value || (candidate.value === max.value && candidate.over && !max.over)) {
      max = candidate
    }
  }
  return max
}

// 波高グループ内で、観測データ（実測値）がある区域を上に、無い区域を下にまとめる。
// 観測データがある区域同士は実測波高（最大値・同点なら「以上」優先）の降順で並べ、
// 実測値未確定（到達時刻のみ等）の区域は観測データありの中で最下位に置く。
// いずれも同点の場合・観測データが無い区域同士は電文順（安定ソート）を維持する。
function sortAreasByObservation(areas: TsunamiArea[], observations: TsunamiObservation[]): TsunamiArea[] {
  const withObservation: TsunamiArea[] = []
  const withoutObservation: TsunamiArea[] = []
  for (const area of areas) {
    if (observations.some(o => matchesArea(o, area))) withObservation.push(area)
    else withoutObservation.push(area)
  }

  const sortedWithObservation = withObservation
    .map((area, index) => ({ area, index, height: maxObservedHeight(area, observations) }))
    .sort((a, b) => {
      if (a.height && b.height) {
        if (a.height.value !== b.height.value) return b.height.value - a.height.value
        if (a.height.over !== b.height.over) return a.height.over ? -1 : 1
        return a.index - b.index
      }
      if (a.height && !b.height) return -1
      if (!a.height && b.height) return 1
      return a.index - b.index
    })
    .map(({ area }) => area)

  return [...sortedWithObservation, ...withoutObservation]
}

/**
 * カードが描画する区域の並び順を、波高グループの構造を保ったまま返す。
 * カードは波高ごとに見出しを挟むため、平坦化していない形が必要。
 */
export function groupAreasForCardDisplay(
  areas: TsunamiArea[],
  observations: TsunamiObservation[],
): TsunamiHeightGroup[] {
  return groupAreasByHeight(areas).map(group => ({
    ...group,
    areas: sortAreasByObservation(group.areas, observations),
  }))
}

/**
 * カードが実際に描画する区域の並び順（波高グループ化＋グループ内の観測順）を平坦に返す。
 *
 * **読み上げの区域列挙もこの順に揃える**（`ttsText.ts`）。観測が入り始めた続報では
 * 電文順（気象庁の地理順）とこの順が乖離するため、読み上げが電文順のままだと
 * 追従スクロールが 1 チャンクごとに上下へ往復する。
 */
export function sortAreasForCardDisplay(areas: TsunamiArea[], observations: TsunamiObservation[]): TsunamiArea[] {
  return groupAreasForCardDisplay(areas, observations).flatMap(group => group.areas)
}
