// 太陽の位置。夜の側を描くための材料で、濃さの引き方は utils/solarShading.ts が持つ。

const DEG = Math.PI / 180

/** J2000.0 元期（2000-01-01 12:00 UTC）。太陽位置の計算はここからの経過日数で行う。 */
const J2000_EPOCH_MS = Date.UTC(2000, 0, 1, 12, 0, 0)
const MS_PER_DAY = 86400000

/** 経度を -180 以上 180 以下へ畳む。 */
function normalizeLongitude(lon: number): number {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180
  // -180 と 180 は同じ経度。剰余の都合で -180 に寄るが、境界の扱いを揃えるためこのまま返す。
  return wrapped
}

/**
 * 太陽直下点（太陽が天頂に来る地点）の緯度経度（度）。
 *
 * 精度は 0.01° 程度（中心差を 2 項で打ち切る低精度式）。地図上で夜の側を描く用途には十分で、
 * 1 分あたり 0.25° 動く太陽の位置に対して無視できる誤差にとどまる。
 */
export function subsolarPoint(epochMs: number): { lat: number; lon: number } {
  const days = (epochMs - J2000_EPOCH_MS) / MS_PER_DAY
  const meanAnomaly = (357.528 + 0.9856003 * days) * DEG
  const eclipticLongitude =
    (280.460 + 0.9856474 * days + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * DEG
  const obliquity = (23.439 - 0.0000004 * days) * DEG

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude))
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  )
  // グリニッジ平均恒星時。赤経との差が、そのまま太陽直下点の経度になる。
  const gmst = (280.46061837 + 360.98564736629 * days) * DEG

  return {
    lat: declination / DEG,
    lon: normalizeLongitude((rightAscension - gmst) / DEG),
  }
}

/**
 * 指定時刻・指定地点での太陽高度（度）。負なら地平線より下。
 *
 * **夜の側を描くのに使うのは GPU 側の同じ式**（gl/dayNightLayer.ts のフラグメントシェーダー）。
 * こちらは、画面に出た濃さが理論どおりかを確かめるときの照合用に置いてある
 * （{@link import('./solarShading').nightOpacityAt} と組で使う）。
 */
export function solarAltitude(epochMs: number, lat: number, lon: number): number {
  const sun = subsolarPoint(epochMs)
  const cosZenith =
    Math.sin(lat * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((lon - sun.lon) * DEG)
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / DEG
}
