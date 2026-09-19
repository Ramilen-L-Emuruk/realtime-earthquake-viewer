import type { IntensityPrefRow } from './quakePoints'
import type { LpgmPrefRow } from './lpgm'
import { rowMarkKey } from './quakeUpdateMark'
import type { UpdateStatus } from './updateMark'

/**
 * 自動で開いた結果、画面に現れてよい行数の上限。
 *
 * **数えるのは「開く鍵の数」ではなく「現れる行数」。** 鍵を 1 つ開くとその直下の子が
 * まとめて現れるので、鍵の数では実際の増え方を表せない（県を 1 つ開けば、その県の区域が
 * 全部出る）。
 *
 * **分布が二つに割れているので、そのあいだに置く。** 控え 60 日の実測（各地の震度どうしの
 * 続報 14 組）で、開いた結果現れる行は**中央値 19 行**だが、1 割の報では **500 行**を超える
 * （観測点がまとめて増える続報）。後者を開くと一覧が丸ごと展開され、畳んである意味が消える。
 *
 * **超えたら何も開かない。** 一部だけ開くと「どれが開いたか」に意味が無くなる（どの行を選ぶかの
 * 基準が無い）。そういう報では行の左端の縦線に任せる。
 */
export const AUTO_EXPAND_MAX_VISIBLE_ROWS = 60

/**
 * 印の付いた行の**祖先**の開閉キーを集める。開く必要が無ければ `null`。
 *
 * **開くのは祖先だけ。** 印の付いた行そのものは開かない —— 観測点には配下が無く、
 * 市町村や区域を開くと印と関係のない行まで現れる。
 *
 * **上限を超えたら `null`**（→ {@link AUTO_EXPAND_MAX_VISIBLE_ROWS}）。
 *
 * @param rows 行の木（`buildIntensityRows` の結果）
 * @param marks 行ごとの印（`QuakeCardMarks.rows`）
 */
export function intensityRowsToExpand(
  rows: readonly IntensityPrefRow[],
  marks: ReadonlyMap<string, UpdateStatus> | undefined,
): Set<string> | null {
  if (!marks || marks.size === 0) return null
  const open = new Set<string>()
  // 鍵 → その鍵を開いたときに現れる行数（直下の子の数）。上限の判定に使う。
  const childCount = new Map<string, number>()
  for (const pref of rows) {
    const prefKey = `pref:${pref.pref}`
    childCount.set(prefKey, pref.regions.length)
    for (const region of pref.regions) {
      const areaKey = `area:${region.name}`
      childCount.set(areaKey, region.cities.length + region.stations.length)
      if (marks.has(rowMarkKey.area(region.name))) open.add(prefKey)
      for (const city of region.cities) {
        const cityKeyStr = `city:${region.name}/${city.name}`
        childCount.set(cityKeyStr, city.stations.length)
        if (marks.has(rowMarkKey.city(region.name, city.name))) { open.add(prefKey); open.add(areaKey) }
        for (const st of city.stations) {
          if (!marks.has(rowMarkKey.station(st.name))) continue
          open.add(prefKey); open.add(areaKey); open.add(cityKeyStr)
        }
      }
      // 市町村に紐付かない観測点（P2PQuake 経路はすべてこちら）。
      for (const st of region.stations) {
        if (!marks.has(rowMarkKey.station(st.name))) continue
        open.add(prefKey); open.add(areaKey)
      }
    }
  }
  return withinVisibleLimit(open, childCount)
}

/** 開いた結果現れる行数が上限に収まるか。収まらなければ `null`（→ {@link AUTO_EXPAND_MAX_VISIBLE_ROWS}）。 */
function withinVisibleLimit(open: Set<string>, childCount: ReadonlyMap<string, number>): Set<string> | null {
  if (open.size === 0) return null
  let visible = 0
  for (const key of open) visible += childCount.get(key) ?? 0
  return visible > AUTO_EXPAND_MAX_VISIBLE_ROWS ? null : open
}

/** 長周期地震動の一覧について同じことをする（段が 1 つ浅いだけで考え方は同じ）。 */
export function lpgmRowsToExpand(
  rows: readonly LpgmPrefRow[],
  marks: ReadonlyMap<string, UpdateStatus> | undefined,
): Set<string> | null {
  if (!marks || marks.size === 0) return null
  const open = new Set<string>()
  const childCount = new Map<string, number>()
  for (const pref of rows) {
    // 最上段は都道府県か、都道府県を引けなかった区域。**鍵に段の種別が入る**ので、
    // カードの `expandKey` と同じ組み立て方にする。
    const topKey = `lpgm:${pref.kind}:${pref.name}`
    childCount.set(topKey, pref.areas.length + pref.stations.length)
    for (const area of pref.areas) {
      childCount.set(`lpgm:area:${area.name}`, area.stations.length)
      if (marks.has(rowMarkKey.area(area.name))) open.add(topKey)
      for (const st of area.stations) {
        if (!marks.has(rowMarkKey.station(st.name))) continue
        open.add(topKey); open.add(`lpgm:area:${area.name}`)
      }
    }
    for (const st of pref.stations) {
      if (marks.has(rowMarkKey.station(st.name))) open.add(topKey)
    }
  }
  return withinVisibleLimit(open, childCount)
}

/**
 * 開閉の状態を進める。**純関数** —— 呼び出し側の `useEffect` に書くと、
 * 「自分が開いた分だけ畳む」「手で閉じた行は追いかけない」がテストで押さえられない。
 *
 * - **閉じる**: 自分が前に開いた行のうち、もう印が指していないもの
 * - **開く**: **印が新しくなった報でだけ**、印が指していてまだ閉じている行
 *
 * **開くのを「印が新しくなったとき」に限るのが肝。** この関数が呼ばれる契機は報の到着だけ
 * ではなく、**利用者が手で開閉したときにも呼ばれる**。そこで毎回開き直すと、畳んだ行が
 * 自分で開き直って操作を無かったことにする。印が新しくなったなら、その報があらためて
 * 「ここを見て」と言っているので開いてよい。
 *
 * **手で閉じた行は記録から落とす。** 次に印が消えたときに `delete` を撃たずに済み、
 * 「自分が開いた分だけ畳む」の約束も保てる。
 */
export function mergeAutoExpanded(args: {
  /** いまの開閉の状態。 */
  prev: ReadonlySet<string>
  /** 印が指す祖先（上限を超えた報では空を渡すこと）。 */
  want: ReadonlySet<string>
  /** 自分が前に開いた行。 */
  autoOpened: ReadonlySet<string>
  /** 前回からこのカードの印が新しくなったか。 */
  marksChanged: boolean
}): { next: ReadonlySet<string>; autoOpened: ReadonlySet<string> } {
  const { prev, want, autoOpened, marksChanged } = args
  const next = new Set(prev)
  const opened = new Set<string>()
  for (const key of autoOpened) {
    if (!want.has(key)) { next.delete(key); continue }
    // まだ印が指している。**手で閉じられていたら追いかけない**（記録からも落とす）。
    if (next.has(key)) opened.add(key)
  }
  if (marksChanged) {
    for (const key of want) {
      if (next.has(key)) continue
      next.add(key)
      opened.add(key)
    }
  }
  // 中身が変わらないなら同じ参照を返す（無駄な再描画を避ける）。
  const unchanged = next.size === prev.size && [...next].every(k => prev.has(k))
  return { next: unchanged ? prev : next, autoOpened: opened }
}
