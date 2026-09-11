// 長周期地震動階級のラベル・配色ユーティリティ（JMA公式色）と、カードの行の組み立て
import type { IntensityScale, LpgmClass, LpgmPoint, LpgmPref, LpgmRegion } from '../types/earthquake'
const LPGM_COLORS: Record<number, string> = {
  1: '#c8c800',
  2: '#ff9600',
  3: '#ff2800',
  4: '#c83200',
}

const LPGM_BG_COLORS: Record<number, string> = {
  1: 'rgba(200,200,0,0.15)',
  2: 'rgba(255,150,0,0.15)',
  3: 'rgba(255,40,0,0.15)',
  4: 'rgba(200,50,0,0.15)',
}

/**
 * 長周期地震動階級として妥当な値か（1〜4）。
 *
 * `isValidIntensityScale()`（`intensity.ts`）と同じく、型検査が及ばない経路
 * （実地震シナリオ JSON・`as` キャストで通す外部レスポンス）から来た値を実行時に弾くためのもの。
 * EEW の特別警報は震度と長周期地震動階級の OR 判定なので、片方だけ守っても誤昇格は防げない。
 * 型が効かない経路を守る関数なので、自分自身は引数の型を当てにしない。
 */
export function isValidLpgmClass(v: number): v is LpgmClass {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4
}

export function getLpgmClassLabel(cls: number): string {
  return isValidLpgmClass(cls) ? `階級${cls}` : '階級不明'
}

/**
 * 階級ラベルに「程度以上」を補う（`over` のとき）。**EEW の予測階級専用。**
 *
 * **語は気象庁の表現に合わせる。** 電文解説資料（Ⅱ.21 2-1-3-2）は `To` の値域を
 * 「4 ：長周期地震動階級 4　over:～程度以上　不明：不明時」と定め、事例も
 * 「最大予測長周期地震動階級が階級 3 **程度以上**の場合」と書いている。
 * 震度側の予想も同じ言い方（→ `getIntensityLabelWithApproxAbove`）。
 *
 * 「階級不明」に語を足しても意味を成さないので、その場合は付けない。
 */
export function getLpgmClassLabelWithApproxAbove(cls: number, over: boolean): string {
  const label = getLpgmClassLabel(cls)
  return over && isValidLpgmClass(cls) ? `${label}程度以上` : label
}

export function getLpgmClassColor(cls: number): string {
  return LPGM_COLORS[cls] ?? '#9ca3af'
}

/**
 * 地図バッジの半径（正方形バッジの一辺の半分・px）。震度の `getScaleRadius()` と同じ役割で、
 * 階級が上がるほど大きくする。
 *
 * 以前は階級によらず固定サイズだった（旧 HTML Marker 版からの移植の名残）ため、
 * 最も重い階級4 が階級1 と同じ大きさで描かれ、重大さが大きさに出ていなかった。
 * 階級不明は最小に倒す。
 */
export function getLpgmClassRadius(cls: number): number {
  const radiusMap: Record<number, number> = { 1: 8, 2: 10, 3: 12, 4: 14 }
  return radiusMap[cls] ?? 8
}

export function getLpgmClassBgColor(cls: number): string {
  return LPGM_BG_COLORS[cls] ?? 'transparent'
}

/**
 * 長周期地震動に関する観測情報の種類（`LgCategory`）から、利用者へ伝える一文を作る。
 *
 * **分類番号そのものは出さない。**「種類2」と書いても何も伝わらない。値 2・4 が意味するのは
 * 「長周期地震動階級を観測した地域のうち、最大震度が4以下の地域がある」＝**揺れそのものは
 * 強くないのに、高層階が大きく揺れた地域がある**という状況で、高い建物にいる人にはこれが効く。
 * 1・3 は階級を観測した地域がどこも震度5弱以上なので、震度の表示だけで状況が伝わる。
 *
 * **文は「地域があります」で受ける。** 電文が主張しているのは「そういう地域が存在する」ことで、
 * 震度が小さかった地域すべてがそうだったとは言っていない。
 *
 * 値ごとの定義表と、この受け方にした理由の全文は
 * `docs/spec/quake-spec.md` §8「長周期地震動の「観測情報の種類」は意味を出す」。
 *
 * @returns 伝えることがなければ空文字
 */
export function lpgmCategoryNote(category: number | undefined): string {
  if (category !== 2 && category !== 4) return ''
  return '震度が小さくても高層階が大きく揺れた地域があります'
}


/**
 * 周期帯の番号（電文の `PeriodicBand`。1〜7）を中心周期の表示に直す。
 *
 * 気象庁は 1.5〜2.5 秒台を第 1 帯とし、以降 1 秒刻みで 7.5〜8.5 秒台の第 7 帯まで置く
 * （電文解説資料 Ⅱ.37）。**番号をそのまま出しても意味が伝わらない**ので中心周期で書く。
 * 周期が長い帯ほど高い建物が大きく揺れる。
 */
export function lpgmPeriodLabel(band: number): string {
  if (!Number.isInteger(band) || band < 1 || band > 7) return '周期不明'
  return `${band + 1}秒`
}

/** 長周期地震動の観測点の行（`buildLpgmRows` の 3 段目）。 */
export interface LpgmStationRow {
  name: string
  lgInt: number
  int?: IntensityScale
  nonJma?: boolean
}

/** 長周期地震動の一次細分区域の行（`buildLpgmRows` の 2 段目）。 */
export interface LpgmAreaRow {
  name: string
  maxLgInt: number
  maxInt?: IntensityScale
  stations: LpgmStationRow[]
}

/**
 * 長周期地震動の都道府県の行（`buildLpgmRows` の 1 段目）。
 *
 * 都道府県を引けなかった一次細分区域もこの形で返る（`areas` が空・`stations` にその区域の
 * 観測点が入る）。行を立てる場所が県しか無いため、区域名のまま最上段へ置いている。
 */
export interface LpgmPrefRow {
  /**
   * 最上段が都道府県か、都道府県を引けなかった一次細分区域か。
   *
   * **名前だけで区別しない。** 区域名と都道府県名が一致すると、画面の側で開閉の鍵と
   * React の key が衝突する（実データでは「奈良県」が県名と区域名の両方にある）。
   */
  kind: 'pref' | 'area'
  name: string
  maxLgInt: number
  maxInt?: IntensityScale
  areas: LpgmAreaRow[]
  /**
   * この行の直下に置く観測点。**`kind` で意味が変わる** —— 県の行（`'pref'`）では
   * 「区域が分からない観測点」、区域の行（`'area'`）ではその区域自身の観測点。
   */
  stations: LpgmStationRow[]
}

export interface LpgmRowDeps {
  /** 一次細分区域名 → 都道府県名（座標表からの逆引き）。電文が県を書いていれば使われない */
  prefOfArea: (name: string) => string | null
  /** 気象庁の標準順（北から南）の順位。索引が無いときは 0 を返してよい */
  rank: (name: string) => number
}

const maxIntensityOf = (values: readonly (IntensityScale | undefined)[]): IntensityScale | undefined => {
  let max: IntensityScale | undefined
  for (const v of values) if (v !== undefined && (max === undefined || v > max)) max = v
  return max
}

/**
 * 長周期地震動の観測結果を「都道府県 → 一次細分区域 → 観測点」の 3 段に組む。
 *
 * 電文（VXSE62）が持つ入れ子と同じ段数で、震度一覧の 4 段（`buildIntensityRows`）から
 * 市町村を除いた形にあたる。**座標表へ直接依存させない** —— 名前の解決と並べ替えを注入し、
 * 電文の値だけを扱う純関数として試せるようにする。
 *
 * - **県・区域の値は電文が書いているものを優先する。** 配下から積み上げると、区域や観測点を
 *   1 つ読み落としたときに静かに低く出る（気象庁は `Pref/MaxLgInt`・`Area/MaxLgInt` を必ず書く）。
 *   電文に無いときだけ積み上げへ落とす —— **区域自身の値が読めなくても配下は出す**ため
 * - **区域が分からない観測点は県の直下へ置く。** 区域名は電文の入れ子からしか拾えないので、
 *   古い形のデータでは空になりうる（→ `LpgmPoint.area`）。県も分からなければ置き場が無い
 * - 並びは階級の降順、同じ階級どうしは気象庁の標準順（震度一覧と同じ規則）
 *
 * **一次細分区域名が全国で一意であることに依存する**（区域を名前だけで束ねる）。市町村名は
 * 一意でないため震度側は「区域＋市町村名」で名前空間を切っているが、区域名の重複は現行の
 * 区域データ 192 件で 0 件。読み上げも同じ前提を採っている（audio-tts-spec.md「地域名の粒度」）。
 */
export function buildLpgmRows(
  regions: readonly LpgmRegion[],
  points: readonly LpgmPoint[],
  prefs: readonly LpgmPref[],
  deps: LpgmRowDeps,
): LpgmPrefRow[] {
  type AreaEntry = {
    name: string
    /** 電文の `Area/MaxLgInt`。読めなかった区域では undefined のまま配下から積み上げる */
    telegramLgInt?: number
    telegramInt?: IntensityScale
    pref: string | null
    stations: LpgmStationRow[]
  }
  const areas = new Map<string, AreaEntry>()
  const areaOf = (name: string, pref: string | null): AreaEntry => {
    const cur = areas.get(name)
    if (cur) {
      if (!cur.pref && pref) cur.pref = pref
      return cur
    }
    const created: AreaEntry = { name, pref, stations: [] }
    areas.set(name, created)
    return created
  }

  for (const r of regions) {
    if (!(r.maxLgInt >= 1)) continue
    // **電文が都道府県名を書いているならそれを使う。** 座標表からの逆引きは電文に無かった
    // 頃の代理で、表に載っていない区域では引けずにまとめが崩れる。
    const entry = areaOf(r.name, r.pref || deps.prefOfArea(r.name))
    // 同じ区域が 2 度現れる電文は無いが、現れたら深刻な側を採る（並び順で結果を変えない）。
    if (entry.telegramLgInt === undefined || r.maxLgInt > entry.telegramLgInt) entry.telegramLgInt = r.maxLgInt
    if (r.maxInt !== undefined && (entry.telegramInt === undefined || r.maxInt > entry.telegramInt)) entry.telegramInt = r.maxInt
  }

  const looseStations = new Map<string, LpgmStationRow[]>()
  for (const p of points) {
    if (!(p.lgInt >= 1)) continue
    const row: LpgmStationRow = {
      name: p.name,
      lgInt: p.lgInt,
      ...(p.int !== undefined && { int: p.int }),
      ...(p.nonJma && { nonJma: true }),
    }
    if (p.area) {
      areaOf(p.area, p.pref || deps.prefOfArea(p.area)).stations.push(row)
      continue
    }
    if (!p.pref) continue
    const list = looseStations.get(p.pref)
    if (list) list.push(row); else looseStations.set(p.pref, [row])
  }

  const byValueDesc = <T,>(value: (x: T) => number, name: (x: T) => string) =>
    (a: T, b: T) => value(b) - value(a) || deps.rank(name(a)) - deps.rank(name(b))
  const sortStations = (rows: LpgmStationRow[]) => rows.sort(byValueDesc(s => s.lgInt, s => s.name))

  const areaRowsByPref = new Map<string, LpgmAreaRow[]>()
  const orphanAreaRows: LpgmPrefRow[] = []
  for (const entry of areas.values()) {
    const stations = sortStations(entry.stations)
    const maxLgInt = entry.telegramLgInt ?? Math.max(0, ...stations.map(s => s.lgInt))
    if (maxLgInt < 1) continue
    const maxInt = entry.telegramInt ?? maxIntensityOf(stations.map(s => s.int))
    const row: LpgmAreaRow = { name: entry.name, maxLgInt, ...(maxInt !== undefined && { maxInt }), stations }
    if (!entry.pref) {
      orphanAreaRows.push({ kind: 'area', ...row, areas: [] })
      continue
    }
    const list = areaRowsByPref.get(entry.pref)
    if (list) list.push(row); else areaRowsByPref.set(entry.pref, [row])
  }

  const prefLgInt = new Map(prefs.filter(p => p.maxLgInt >= 1).map(p => [p.name, p.maxLgInt]))
  const prefInt = new Map(prefs.flatMap(p => (p.maxInt === undefined ? [] : [[p.name, p.maxInt] as const])))

  const rows: LpgmPrefRow[] = [...orphanAreaRows]
  // **電文が県の階級を書いていれば、配下が 1 つも立たなくても行にする。** 区域の階級が
  // どれも読めず観測点も無い電文では、県の値だけが残る。落とすと、気象庁が階級を報告して
  // いる県がカードから消える（震度側の `buildIntensityRows` も、都道府県ロールアップ点の
  // キーをループの対象へ入れている）。
  for (const pref of new Set([...areaRowsByPref.keys(), ...looseStations.keys(), ...prefLgInt.keys()])) {
    const areaList = (areaRowsByPref.get(pref) ?? []).sort(byValueDesc(a => a.maxLgInt, a => a.name))
    const loose = sortStations(looseStations.get(pref) ?? [])
    const maxLgInt = prefLgInt.get(pref)
      ?? Math.max(0, ...areaList.map(a => a.maxLgInt), ...loose.map(s => s.lgInt))
    if (maxLgInt < 1) continue
    const maxInt = prefInt.get(pref)
      ?? maxIntensityOf([...areaList.map(a => a.maxInt), ...loose.map(s => s.int)])
    rows.push({ kind: 'pref', name: pref, maxLgInt, ...(maxInt !== undefined && { maxInt }), areas: areaList, stations: loose })
  }
  return rows.sort(byValueDesc(r => r.maxLgInt, r => r.name))
}
