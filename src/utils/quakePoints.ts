import type { EarthquakePoint, IntensityScale, JMAQuakeCity } from '../types/earthquake'

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
 * **実運用で真になる。** 判定は `MaxInt` の値そのものではなく「最大震度と同じ階級の観測点に
 * 未入電があるか」なので、**観測できた最大が5弱の地震**では階級が一致して真を返す
 * （実例: 2024-11-26 22:47 石川県西方沖 M6.4。最大震度5弱で未入電が 1 地点。実機で出す入口は
 * 設定タブ「5弱以上テスト」）。
 *
 * `MaxInt` 自身が未入電になる電文は仕様上存在しない（解説資料が値域を "1"〜"7" と定めている）が、
 * **この述語は `MaxInt` を見ていない**ので、その事実はここの真偽を左右しない。
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

/** 観測点の行（いちばん下の段）。 */
export interface IntensityStationRow {
  name: string
  scale: IntensityScale
  /** その観測点の震度が未入電 */
  unreceived: boolean
  /** 気象庁以外が運用する観測点（→ {@link EarthquakePoint.nonJma}） */
  nonJma: boolean
}

/** 市町村の行（区域の行の下に並ぶ）。 */
export interface IntensityCityRow {
  name: string
  scale: IntensityScale
  /** この市町村そのものの震度が未入電（値が届いていない） */
  unreceived: boolean
  /** この範囲に未入電の地点がある（市町村の最大は観測できていることもある） */
  hasUnreceived: boolean
  stations: IntensityStationRow[]
}

/** 一次細分区域の行（都道府県の行の下に並ぶ）。 */
export interface IntensityRegionRow {
  name: string
  scale: IntensityScale
  unreceived: boolean
  hasUnreceived: boolean
  cities: IntensityCityRow[]
  /**
   * 市町村に紐付かない観測点。
   *
   * **P2PQuake 経路ではこちらに全部入る** —— 観測点を市町村でまとめずに配信するため
   * （→ {@link EarthquakePoint.city}）。市町村が読めなかった観測点もここへ落ちる。
   */
  stations: IntensityStationRow[]
}

/** 都道府県の行と、その下に畳んである一次細分区域。 */
export interface IntensityPrefRow {
  pref: string
  scale: IntensityScale
  unreceived: boolean
  hasUnreceived: boolean
  regions: IntensityRegionRow[]
}

/**
 * 名前の解決と並べ替えを外から渡す。**座標テーブルへ直接依存させない** ——
 * このファイルは電文の点だけを扱う純粋なユーティリティで、資材の読み込み事情
 * （起動直後は索引が無い）を持ち込むと呼び出し側ごとに分岐が増える。
 */
/**
 * 市町村を指す鍵の区切り文字。
 *
 * 地名に現れない文字にする（'/' や空白は市町村名・区域名のどちらにも入りうるので、別の
 * 組み合わせが同じ鍵になりうる）。**エスケープで書くこと** —— 生の制御文字を置くと目に見えず、
 * grep がこのファイルをバイナリとして扱う。
 */
export const CITY_KEY_SEP = '\u0000'

/**
 * 市町村を指す鍵（区域名と市町村名の組）。
 *
 * **市町村名だけでは一意にならない**（府中市＝東京都・広島県、伊達市＝北海道・福島県）。
 * 名前だけで束ねると、両方が載った電文で観測点が混ざり、**どちらの行にも他県の観測点が並ぶ**。
 * 区域は 1 つの県にしか属さないので、組にすれば足りる。
 *
 * **外から「未入電あり」の集合を渡すときも、この関数で鍵を作ること。** 別々に組み立てると、
 * 区切り文字を変えたときに片方だけがずれ、印が黙って消える。
 */
export function cityKey(area: string, city: string): string {
  return `${area}${CITY_KEY_SEP}${city}`
}

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
  /**
   * 未入電の地点を含む市町村（鍵は {@link cityKey}）。
   *
   * **電文の `City/Condition` だけに頼れない。** あれは市町村の最大が震度4以下（又は入電なし）
   * のときしか出ない（→ [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「市町村の震度」）ので、
   * **強く揺れた市町村ほど付かない** —— 通信が途絶えて未入電を抱えやすいのはまさにそちら。
   * 県・区域と同じく、配下の観測点から集めたものを渡す。
   */
  unreceivedCities: ReadonlySet<string>
  /** 気象庁の標準順の順位（小さいほど先）。同じ震度どうしの並びに使う */
  rank: (name: string) => number
}

/**
 * 一次細分区域 → 都道府県 を引く関数を作る。**まず電文自身に訊く。**
 *
 * `City` は所属する区域と都道府県の両方を名乗るので、区域がどの県のものかは電文だけで分かる
 * （能登本震では 119 区域すべてをこれで引けた）。座標表からの逆引きは、読み込みが済むまでと
 * 取得に失敗したときは何も返さない —— そちらだけに頼ると、その間は区域から下が画面に出ない。
 *
 * **行の組み立てと「未入電あり」の印で必ず同じものを使うこと。** 片方だけが電文を見る形にすると、
 * 座標表を引けない状況で**区域の行は出るのに親の県に印が付かない**という食い違いになる。
 * 手で優先順位を揃えるのではなく、この関数を共有して揃える。
 *
 * @param fallback 電文から引けなかったときの落とし先（座標表からの逆引き）
 */
export function makeAreaPrefResolver(
  cities: readonly JMAQuakeCity[],
  fallback: (areaName: string) => string | null,
): (areaName: string) => string | null {
  const fromTelegram = new Map<string, string>()
  for (const c of cities) {
    if (c.area && c.pref && !fromTelegram.has(c.area)) fromTelegram.set(c.area, c.pref)
  }
  return areaName => fromTelegram.get(areaName) ?? fallback(areaName)
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
  cities: readonly JMAQuakeCity[],
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

  const prefOfArea = makeAreaPrefResolver(cities, deps.prefOfArea)

  const areaByPref = new Map<string, Map<string, Entry>>()
  const addArea = (pref: string, name: string, entry: Entry) => {
    const set = areaByPref.get(pref) ?? new Map<string, Entry>()
    set.set(name, higher(set.get(name), entry))
    areaByPref.set(pref, set)
  }
  for (const p of points) {
    if (p.pref || !p.isArea) continue
    const pref = prefOfArea(p.addr)
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

  // 観測点を市町村ごと・区域ごとに振り分ける。**市町村を持つのは DMDATA の経路だけ**
  // （→ `EarthquakePoint.city`）。持たない観測点は区域へ直接ぶら下げる。
  // 市町村の束ね方は {@link cityKey}（区域＋市町村名）。
  const stationsByCity = new Map<string, IntensityStationRow[]>()
  const stationsByRegion = new Map<string, IntensityStationRow[]>()
  const pushInto = (map: Map<string, IntensityStationRow[]>, key: string, row: IntensityStationRow) => {
    const list = map.get(key)
    if (list) list.push(row); else map.set(key, [row])
  }
  for (const p of points) {
    if (p.isArea) continue
    const row: IntensityStationRow = {
      name: p.addr,
      scale: p.scale,
      unreceived: !!p.unreceived,
      nonJma: !!p.nonJma,
    }
    // 区域は電文が置いたものをそのまま使う（DMDATA）。持たない経路（P2PQuake）は座標表から
    // 逆引きする。**市町村へ入れるのは区域が分かったときだけ** —— 区域が無いと同名の市町村を
    // 見分けられないうえ、市町村の行を作れなかったときの落とし先も無くなる。
    const fromIndex = () => {
      const pref = p.pref || deps.prefOfStation(p.addr) || ''
      return (pref ? deps.regionOfStation(pref, p.addr) : null) ?? undefined
    }
    const region = p.area ?? fromIndex()
    if (p.city && region) {
      pushInto(stationsByCity, cityKey(region, p.city), row)
      continue
    }
    if (!region) continue
    pushInto(stationsByRegion, region, row)
  }

  // 市町村を区域ごとに振り分ける。電文が `City/Area` の所属を持っている（`JMAQuakeCity.area`）。
  const citiesByRegion = new Map<string, IntensityCityRow[]>()
  const claimedCityKeys = new Set<string>()
  for (const c of cities) {
    const key = cityKey(c.area, c.name)
    claimedCityKeys.add(key)
    const row: IntensityCityRow = {
      name: c.name,
      scale: c.scale,
      unreceived: !!c.unreceived,
      // 電文が言っている分と、配下の観測点から集めた分の**両方**を見る。前者は配下から復元
      // できないことがあり（その市町村の観測点を 1 つも読めていない形）、後者は電文が黙って
      // いる場合を埋める。
      hasUnreceived: !!c.hasUnreceived || deps.unreceivedCities.has(key),
      stations: (stationsByCity.get(key) ?? []).sort(byScale(x => x.scale, x => x.name)),
    }
    const list = citiesByRegion.get(c.area)
    if (list) list.push(row); else citiesByRegion.set(c.area, [row])
  }

  // **市町村の行を作れなかった観測点を捨てない。** 市町村の震度が読めなかった電文では
  // `cities` にその市町村が入らない（パーサーは名前だけ覚えて観測点に付ける）。行き先が
  // 無いままにすると、**読めていた観測点まで道連れで画面から消える**。区域は分かって
  // いるので、その直下へ移す。
  for (const [key, rows] of stationsByCity) {
    if (claimedCityKeys.has(key)) continue
    const region = key.slice(0, key.indexOf(CITY_KEY_SEP))
    if (!region) continue
    for (const row of rows) pushInto(stationsByRegion, region, row)
  }

  // **区域自身の震度が読めなくても、配下は出す。** 区域の行は電文の `Area/MaxInt` から
  // 作るが、そこだけが読めない電文では配下の市町村・観測点が正常に読めていても行き先を
  // 失う。**この形の脱落は記録にも残らない** —— 区域の読み取り失敗は「その電文の区域が
  // 全滅したとき」しか記録しないため（部分脱落では黙る規約）。中身から震度を積み上げて
  // 行を立てる。
  const regionNames = new Map<string, Set<string>>()
  const addRegionName = (pref: string, name: string) => {
    const set = regionNames.get(pref) ?? new Set<string>()
    set.add(name)
    regionNames.set(pref, set)
  }
  for (const [pref, set] of areaByPref) for (const name of set.keys()) addRegionName(pref, name)
  for (const name of [...citiesByRegion.keys(), ...stationsByRegion.keys()]) {
    const pref = prefOfArea(name)
    if (pref) addRegionName(pref, name)
  }

  // **区域しか無い県も出す。** 電文が県の `MaxInt` を必ず持つのは実測での話で、資料が
  // 保証しているわけではない。区域だけが届いた県を落とすと、その県が画面から消える。
  const prefNames = new Set<string>([...prefMax.keys(), ...regionNames.keys()])
  return Array.from(prefNames)
    .map(pref => {
      const regions = Array.from(regionNames.get(pref) ?? [])
        .map(name => {
          const cityRows = (citiesByRegion.get(name) ?? []).sort(byScale(c => c.scale, c => c.name))
          const stationRows = (stationsByRegion.get(name) ?? []).sort(byScale(x => x.scale, x => x.name))
          // 電文が区域の値を持っていればそれが正。無ければ配下の最大で代用する。
          const own = areaByPref.get(pref)?.get(name)
            ?? [...cityRows, ...stationRows].reduce<Entry | undefined>(
              (a, r) => higher(a, { scale: r.scale, unreceived: r.unreceived }), undefined)
          return {
            name,
            scale: (own?.scale ?? -1) as IntensityScale,
            unreceived: !!own?.unreceived,
            hasUnreceived: deps.unreceivedAreas.has(name),
            cities: cityRows,
            stations: stationRows,
          }
        })
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
