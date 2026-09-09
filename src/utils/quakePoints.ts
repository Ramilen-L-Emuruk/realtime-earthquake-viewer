import type { EarthquakePoint, IntensityScale } from '../types/earthquake'

/**
 * 一次細分区域名 → 都道府県名 の逆引き索引（`buildAreaPrefIndex`）。
 * `null` は「索引を引けない」——{@link isAreaPoint} は名前だけの判定へ落ちる。
 */
export type AreaPrefIndex = ReadonlyMap<string, string> | null

/**
 * その点を「一次細分区域の点」として扱ってよいか（→ docs/spec/quake-spec.md §4）。
 *
 * `isArea: true` の点には 2 種類ある。
 * - **一次細分区域の点** — 気象庁が区域単位で発表した震度
 * - **都道府県ロールアップ点** — DMDATA 経路が県別の最大震度を
 *   `{ pref: 県名, addr: 県名, isArea: true }` として足す集約値（電文の `Pref` 直下の `MaxInt`）
 *
 * 県は区域より粗いので、後者を区域として扱うと読み上げの粒度が崩れ、地震の同一性判定では
 * 「同じ県の別々の区域で起きた 2 つの地震」が重なって見える。
 *
 * **`addr !== pref` だけで見分けないこと。** ロールアップ点は確かに `addr === pref` だが、
 * **P2PQuake は区域の点にも `pref` を積む**（→ 同§4）。区域名が県名と同じ奈良県——県内の
 * 一次細分区域が 1 つだけで、その名前が県名と同じ唯一の県（`stationCoords.test.ts` が固定）
 * ——が巻き添えで落ち、標準版の震度速報から奈良県だけが静かに消える。名前が衝突したときは
 * 「その名前が一次細分区域として実在するか」を見て決める。
 *
 * 奈良県では DMDATA 経路の区域点とロールアップ点が両方とも真になるが、名前も震度も
 * 同じ（単一区域なので県の最大震度は配下区域の最大震度）なので、集合・Map で受ける
 * 呼び出し側では重複しない。
 *
 * @param areaPrefIndex 一次細分区域名 → 都道府県名（`buildAreaPrefIndex`）。
 *   **null を渡すと名前だけで判定し、奈良県を取りこぼす。** 座標テーブルはブラウザで
 *   読み込む資材なので、それを引けない呼び出し側は null を渡すほかない。
 */
export function isAreaPoint(
  p: EarthquakePoint,
  areaPrefIndex: AreaPrefIndex,
): boolean {
  if (!p.isArea) return false
  if (p.addr !== p.pref) return true
  return areaPrefIndex?.has(p.addr) ?? false
}

/**
 * 電文全体の最大震度が「5弱以上・未入電」か（→ docs/spec/quake-spec.md §4）。
 *
 * **実運用では真にならない。** 電文解説資料が `MaxInt` の値域を "1"〜"7" と定めているため、
 * 要約値が未入電になる電文は仕様上存在しない。仕様外の電文が来たときに「以上」を添えて
 * 断定を避けるための保険として残してある。
 *
 * **これはフィールドとして持たない。** 震度を持たない続報（震源情報など）に既存の震度と
 * `points` を引き継ぐ経路が 2 つあり（`mergeQuakeInto` の補完と、`useEarthquakes` の
 * 震度キャッシュ）、フィールドで持つと**そのたびにコピーを書き足す必要がある**。
 * 実際に 2 箇所とも書き漏らして、続報で「5弱以上」が黙って「5弱」へ降格していた。
 * **`points` は両経路とも必ず一緒に運ばれる**ので、そこから導けば漏れようがない。
 *
 * 判定は「最大震度と同じ階級の点に未入電があるか」。未入電は下限の 45（5弱）へ寄せてあるので、
 * 最大震度が 45 のときだけ真になりうる。
 */
export function isMaxScaleUnreceived(maxScale: IntensityScale, points: readonly EarthquakePoint[]): boolean {
  if (maxScale < 0) return false
  return points.some(p => p.unreceived && p.scale === maxScale)
}

/**
 * 未入電の点を「地点名で読むもの」と「区域名で補うもの」に分ける。
 *
 * 未入電は観測点 1 つ 1 つに付く事実なので、地点名が最も正確。ただし**地点で覆えない
 * 区域・県の未入電を落としてはいけない**。電文全体で 1 つのフラグにして地点側へ倒すと、
 * 別の県が区域単位だけで未入電を伝えてきたときにその県が読み上げからも画面からも消え、
 * しかも痕跡が残らない（「部分脱落では黙る」形になる）。
 *
 * 逆に地点と区域を無条件に並べると、同じ事実を二重に伝える —— 電文の区域・県の最大震度は
 * 配下の最大なので、地点が未入電ならその区域と県も同じ形で届く（→ docs/spec/quake-spec.md §4）。
 * そこで**地点が覆う名前を除いた区域・県だけ**を補う。
 *
 * @param coveredNames 地点が覆う名前（その観測点の所属区域名・都道府県名）を返す。
 *   呼び出し側が持っている索引で解決する。引けないものは返さなくてよい。
 */
export function partitionUnreceivedPoints(
  points: readonly EarthquakePoint[],
  coveredNames: (station: EarthquakePoint) => readonly string[],
): { stations: EarthquakePoint[]; areas: EarthquakePoint[] } {
  const unreceived = points.filter(p => p.unreceived && p.addr)
  const stations = unreceived.filter(p => !p.isArea)
  const covered = new Set<string>()
  for (const p of stations) {
    for (const name of coveredNames(p)) if (name) covered.add(name)
  }
  return { stations, areas: unreceived.filter(p => p.isArea && !covered.has(p.addr)) }
}

/** {@link partitionUnreceivedPoints} の結果に合わせた単位の語（「ほかN◯◯」と見出しに使う）。 */
export function unreceivedUnitLabel(hasStations: boolean, hasAreas: boolean): string {
  if (hasStations && hasAreas) return '件'
  return hasStations ? '地点' : '地域'
}

/** 一次細分区域の行（都道府県の行の下に並ぶ）。 */
export interface IntensityRegionRow {
  name: string
  scale: IntensityScale
  /** この区域そのものの震度が未入電（値が届いていない） */
  unreceived: boolean
  /** この範囲に未入電の地点がある（区域の最大は観測できていることもある） */
  hasUnreceived: boolean
}

/** 都道府県の行と、その下に畳んである一次細分区域。 */
export interface IntensityPrefRow extends Omit<IntensityRegionRow, 'name'> {
  pref: string
  regions: IntensityRegionRow[]
}

/**
 * 名前の解決と並べ替えを外から渡す。**座標テーブルへ直接依存させない** ——
 * このファイルは電文の点だけを扱う純粋なユーティリティで、資材の読み込み事情
 * （起動直後は索引が無い）を持ち込むと呼び出し側ごとに分岐が増える。
 */
export interface IntensityRowDeps {
  /** 一次細分区域名 → 都道府県名 */
  prefOfArea: (areaName: string) => string | null
  /** 観測点名 → 都道府県名。電文が `pref` を持たない経路（DMDATA の観測点）の補完 */
  prefOfStation: (stationName: string) => string | null
  /** 都道府県名と観測点名の組 → 所属する一次細分区域名 */
  regionOfStation: (pref: string, stationName: string) => string | null
  /** 未入電の地点を含む都道府県 */
  unreceivedPrefs: ReadonlySet<string>
  /** 未入電の地点を含む一次細分区域 */
  unreceivedAreas: ReadonlySet<string>
  /** 気象庁の標準順の順位（小さいほど先）。同じ震度どうしの並びに使う */
  rank: (name: string) => number
}

/**
 * 震度一覧の行を組み立てる。**都道府県の行に、一次細分区域を畳んで持たせる。**
 *
 * **県の点があっても区域を捨てないこと。** 実電文は県の `MaxInt` を必ず持つ（実測 66/66）ので、
 * 「県の点があれば区域を無視する」作りにすると区域の行が事実上どこにも出ない。読み上げは
 * 元から区域が主（`ttsText.ts` の `regionNamesForScale`）なので、画面＝県／音声＝区域という
 * ずれになる。
 *
 * **区域の出どころは読み上げと同じ優先順位。** 電文が区域の点を持つならそれを使い、持たない
 * 電文（P2PQuake の詳細報は観測点しか持たない）では観測点の所属区域を逆引きする。切り替えは
 * **電文全体で見る** —— 県ごとに切り替えると、区域を持つ県と持たない県で行の出どころが混ざり、
 * 同じ電文の中で粒度が揃わなくなる。
 *
 * **「未入電あり」の印は、その範囲に未入電の地点が 1 つでもあるか**で出す。行の最大が未入電か
 * どうかでは判定しない —— 区域・県の最大震度は配下の最大なので、1 点でも観測値が届けばそちらが
 * 勝つ。最大だけを見ると「最大は観測できたが別の地点は未入電」という最も起きやすい形で印が
 * 消える（→ docs/spec/quake-spec.md §4）。
 */
export function buildIntensityRows(
  points: readonly EarthquakePoint[],
  deps: IntensityRowDeps,
): IntensityPrefRow[] {
  type Entry = { scale: number; unreceived: boolean }
  // 同じ震度なら**観測値を採る**。並び順で結果が変わらないようにするため（電文は 1 つの
  // 区域につき 1 点しか持たないので現状は起きないが、順序依存を残す理由も無い）。
  const higher = (a: Entry | undefined, b: Entry): Entry => {
    if (!a) return b
    if (a.scale !== b.scale) return a.scale > b.scale ? a : b
    return a.unreceived ? b : a
  }

  // 都道府県ロールアップ点（電文の `Pref` 直下の `MaxInt`）→ 県別の最大震度
  const prefMax = new Map<string, Entry>()
  for (const p of points) {
    if (!p.pref) continue
    prefMax.set(p.pref, higher(prefMax.get(p.pref), { scale: p.scale, unreceived: !!p.unreceived }))
  }

  const areaByPref = new Map<string, Map<string, Entry>>()
  const addArea = (pref: string, name: string, entry: Entry) => {
    const set = areaByPref.get(pref) ?? new Map<string, Entry>()
    set.set(name, higher(set.get(name), entry))
    areaByPref.set(pref, set)
  }
  for (const p of points) {
    if (p.pref || !p.isArea) continue
    const pref = deps.prefOfArea(p.addr)
    if (!pref) continue
    addArea(pref, p.addr, { scale: p.scale, unreceived: !!p.unreceived })
  }
  if (areaByPref.size === 0) {
    for (const p of points) {
      if (p.isArea) continue
      const pref = p.pref || deps.prefOfStation(p.addr) || ''
      if (!pref) continue
      const region = deps.regionOfStation(pref, p.addr)
      if (region) addArea(pref, region, { scale: p.scale, unreceived: !!p.unreceived })
    }
  }

  const byScale = <T,>(scaleOf: (x: T) => number, nameOf: (x: T) => string) =>
    (a: T, b: T) => scaleOf(b) - scaleOf(a) || deps.rank(nameOf(a)) - deps.rank(nameOf(b))

  // **区域しか無い県も出す。** 電文が県の `MaxInt` を必ず持つのは実測での話で、資料が
  // 保証しているわけではない。区域だけが届いた県を落とすと、その県が画面から消える。
  const prefNames = new Set<string>([...prefMax.keys(), ...areaByPref.keys()])
  return Array.from(prefNames)
    .map(pref => {
      const regions = Array.from(areaByPref.get(pref) ?? [])
        .map(([name, { scale, unreceived }]) => ({
          name,
          scale: scale as IntensityScale,
          unreceived,
          hasUnreceived: deps.unreceivedAreas.has(name),
        }))
        .filter(r => r.scale >= 0)
        .sort(byScale(r => r.scale, r => r.name))
      // 県の点が無ければ配下の区域の最大を県の値にする。
      const own = prefMax.get(pref)
        ?? regions.reduce<Entry | undefined>((a, r) => higher(a, { scale: r.scale, unreceived: r.unreceived }), undefined)
      return {
        pref,
        scale: (own?.scale ?? -1) as IntensityScale,
        unreceived: !!own?.unreceived,
        hasUnreceived: deps.unreceivedPrefs.has(pref) || deps.unreceivedAreas.has(pref),
        regions,
      }
    })
    .filter(row => row.scale >= 0)
    .sort(byScale(g => g.scale, g => g.pref))
}
