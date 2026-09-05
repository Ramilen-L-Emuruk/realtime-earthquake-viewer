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
