import { describe, it, expect } from 'vitest'
import { AUTO_EXPAND_MAX_VISIBLE_ROWS, intensityRowsToExpand, lpgmRowsToExpand, mergeAutoExpanded } from './autoExpandMarkedRows'
import { rowMarkKey } from './quakeUpdateMark'
import type { UpdateStatus } from './updateMark'
import type { IntensityPrefRow } from './quakePoints'
import type { LpgmPrefRow } from './lpgm'

const station = (name: string) => ({ name, scale: 40, unreceived: false, nonJma: false })
const city = (name: string, stations: string[] = []) =>
  ({ name, scale: 40, unreceived: false, hasUnreceived: false, stations: stations.map(station) })
const region = (name: string, cities: ReturnType<typeof city>[] = [], stations: string[] = []) =>
  ({ name, scale: 40, unreceived: false, hasUnreceived: false, cities, stations: stations.map(station) })
const pref = (name: string, regions: ReturnType<typeof region>[]): IntensityPrefRow =>
  ({ pref: name, scale: 40, unreceived: false, hasUnreceived: false, regions }) as IntensityPrefRow

const marksOf = (...keys: string[]): ReadonlyMap<string, UpdateStatus> =>
  new Map(keys.map(k => [k, 'changed' as const]))

describe('印の付いた行を見せるために開く行', () => {
  const rows = [pref('石川県', [region('能登', [city('輪島市', ['輪島', '門前'])], ['珠洲'])])]

  // 正: 観測点の印なら、県 → 区域 → 市町村 の 3 つを開く。
  it('観測点の印は祖先を 3 段ぶん開く', () => {
    const open = intensityRowsToExpand(rows, marksOf(rowMarkKey.station('輪島')))
    expect([...(open ?? [])].sort()).toEqual(['area:能登', 'city:能登/輪島市', 'pref:石川県'])
  })

  // 正: 市町村に紐付かない観測点（P2PQuake 経路）は 2 段でよい。
  it('市町村に紐付かない観測点は県と区域だけ開く', () => {
    const open = intensityRowsToExpand(rows, marksOf(rowMarkKey.station('珠洲')))
    expect([...(open ?? [])].sort()).toEqual(['area:能登', 'pref:石川県'])
  })

  // 正: 区域の印なら県だけ開く。**その区域自身は開かない** —— 配下は印と関係がない。
  it('区域の印は県だけ開く', () => {
    expect([...(intensityRowsToExpand(rows, marksOf(rowMarkKey.area('能登'))) ?? [])])
      .toEqual(['pref:石川県'])
  })

  // 対照: 印が無ければ何も開かない。
  it('印が無ければ開かない', () => {
    expect(intensityRowsToExpand(rows, new Map())).toBeNull()
    expect(intensityRowsToExpand(rows, undefined)).toBeNull()
  })

  // 対照: 木に無い行の印は開く先が決まらないので無視する（座標表を引けない観測点など）。
  it('木に無い行の印では開かない', () => {
    expect(intensityRowsToExpand(rows, marksOf(rowMarkKey.station('どこか')))).toBeNull()
  })

  // 安全弁: **開いた結果現れる行が多すぎる報では何も開かない。** 一部だけ開くと、
  // どれが開いたかに意味が無くなる。実測で 1 割の報は 500 行超が現れることになる。
  //
  // **数えるのは現れる行数で、開く鍵の数ではない。** 県を 1 つ開けばその県の区域が全部出る。
  it('開いた結果現れる行が上限を超えたら何も開かない', () => {
    // 区域を 1 つだけ持つ県を並べる。1 件につき「県を開く → 区域 1 行」「区域を開く → 観測点 1 行」
    // で 2 行現れるので、上限の半分の件数までが収まる。
    const many = Array.from({ length: AUTO_EXPAND_MAX_VISIBLE_ROWS, }, (_, i) =>
      pref(`県${i}`, [region(`区域${i}`, [], [`点${i}`])]))
    const keys = many.map((_, i) => rowMarkKey.station(`点${i}`))
    const fit = AUTO_EXPAND_MAX_VISIBLE_ROWS / 2
    expect(intensityRowsToExpand(many.slice(0, fit), marksOf(...keys))?.size).toBe(fit * 2)
    // 1 件増えると上限を超えるので、何も開かない。
    expect(intensityRowsToExpand(many.slice(0, fit + 1), marksOf(...keys))).toBeNull()
  })

  // 安全弁: **鍵の数ではなく現れる行数で切る。** 区域を多く持つ県は、鍵 1 つでも大きく開く。
  it('鍵が 1 つでも、現れる行が上限を超えれば開かない', () => {
    const regions = Array.from({ length: AUTO_EXPAND_MAX_VISIBLE_ROWS + 1 }, (_, i) => region(`区域${i}`))
    const wide = [pref('東京都', regions)]
    expect(intensityRowsToExpand(wide, marksOf(rowMarkKey.area('区域0')))).toBeNull()
  })
})

describe('長周期地震動の一覧で開く行', () => {
  const rows: LpgmPrefRow[] = [{
    kind: 'pref', name: '石川県', maxLgInt: 4,
    areas: [{ name: '能登', maxLgInt: 4, stations: [{ name: '輪島', lgInt: 4, nonJma: false }] }],
    stations: [{ name: '珠洲', lgInt: 3, nonJma: false }],
  } as LpgmPrefRow]

  // 正: 観測点の印は最上段と区域を開く（段が 1 つ浅い）。
  it('観測点の印は最上段と区域を開く', () => {
    expect([...(lpgmRowsToExpand(rows, marksOf(rowMarkKey.station('輪島'))) ?? [])].sort())
      .toEqual(['lpgm:area:能登', 'lpgm:pref:石川県'])
  })

  // 安全弁: **最上段の鍵には段の種別が入る** —— 区域名と県名は一致しうる（実データの「奈良県」）。
  it('最上段の鍵に段の種別が入る', () => {
    const asArea = [{ ...rows[0], kind: 'area' as const }]
    expect([...(lpgmRowsToExpand(asArea, marksOf(rowMarkKey.station('珠洲'))) ?? [])])
      .toEqual(['lpgm:area:石川県'])
  })
})

describe('開閉の状態を進める', () => {
  const S = (...k: string[]) => new Set(k)

  // 正: 印が新しくなった報で、まだ閉じている行を開く。
  it('印が新しくなったら開く', () => {
    const r = mergeAutoExpanded({ prev: S(), want: S('pref:石川県'), autoOpened: S(), marksChanged: true })
    expect([...r.next]).toEqual(['pref:石川県'])
    expect([...r.autoOpened]).toEqual(['pref:石川県'])
  })

  // 正: 印が指さなくなった行は、自分が開いた分だけ畳む。
  it('印が消えたら自分が開いた分だけ畳む', () => {
    const r = mergeAutoExpanded({
      prev: S('pref:石川県', 'pref:富山県'), want: S(),
      autoOpened: S('pref:石川県'), marksChanged: true,
    })
    // 手で開いていた富山県は残る。
    expect([...r.next]).toEqual(['pref:富山県'])
    expect(r.autoOpened.size).toBe(0)
  })

  // 安全弁: **手で閉じた行は、印が生きているあいだの続報で開き直さない。**
  // 印は最大 1 分残るので、ここを見ないと無関係な続報のたびに開き直る。
  it('手で閉じた行は、印が新しくならない報では開き直さない', () => {
    const want = S('pref:石川県')
    // 自動で開いた直後にユーザーが閉じた状態。
    const r = mergeAutoExpanded({ prev: S(), want, autoOpened: S('pref:石川県'), marksChanged: false })
    expect(r.next.size).toBe(0)
    // 記録からも落ちるので、次に印が消えても `delete` を撃たない。
    expect(r.autoOpened.size).toBe(0)
  })

  // 対照: **印が新しくなったなら開き直してよい。** その報があらためて「ここを見て」と言っている。
  it('手で閉じた行でも、印が新しくなれば開き直す', () => {
    const r = mergeAutoExpanded({
      prev: S(), want: S('pref:石川県'), autoOpened: S('pref:石川県'), marksChanged: true,
    })
    expect([...r.next]).toEqual(['pref:石川県'])
  })

  // 安全弁: **震度一覧と長周期は別々に進める。**
  //
  // 開閉の入れ物は 1 つだが、印の出どころは 2 つ（地震の報と長周期の報）で別々に変わる。
  // 1 つの真偽値へ畳むと、**長周期の報が届いただけで震度一覧の「手で閉じた行」が開き直す**。
  // カード側（`EarthquakeCard`）は 2 回に分けて当てるので、その形をここで固定する。
  it('長周期の印だけが新しくなっても、震度一覧で手で閉じた行は開き直さない', () => {
    const ROW = 'pref:石川県'
    const LPGM = 'lpgm:pref:富山県'
    // 震度側は自動で開いたあとユーザーが閉じた（`prev` に無いが `autoOpened` には残る）。
    const byRows = mergeAutoExpanded({
      prev: S(), want: S(ROW), autoOpened: S(ROW), marksChanged: false,
    })
    // 長周期側だけ印が新しくなった。
    const byLpgm = mergeAutoExpanded({
      prev: byRows.next, want: S(LPGM), autoOpened: S(), marksChanged: true,
    })
    expect([...byLpgm.next]).toEqual([LPGM])
    expect(byLpgm.next.has(ROW)).toBe(false)
  })

  // 対照: 震度側の印が新しくなったなら、そちらは開き直してよい。
  it('震度側の印が新しくなれば、震度側は開き直す', () => {
    const ROW = 'pref:石川県'
    const byRows = mergeAutoExpanded({
      prev: S(), want: S(ROW), autoOpened: S(ROW), marksChanged: true,
    })
    expect(byRows.next.has(ROW)).toBe(true)
  })

  // 安全弁: 中身が変わらないなら同じ参照を返す（無駄な再描画を避ける）。
  it('変わらなければ同じ参照を返す', () => {
    const prev = S('pref:石川県')
    const r = mergeAutoExpanded({ prev, want: S('pref:石川県'), autoOpened: S('pref:石川県'), marksChanged: true })
    expect(r.next).toBe(prev)
  })
})
