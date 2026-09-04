import type { EarthquakePoint } from '../types/earthquake'

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
