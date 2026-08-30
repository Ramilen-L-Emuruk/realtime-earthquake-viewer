// 太陽の位置から「夜の側」を面として描くための幾何。
//
// 太陽高度 h の等高度線は、太陽直下点から角距離 (90° - h) の小円。裏返すと「太陽高度が h 以下の
// 領域」は太陽の対蹠点を中心とする半径 (90° + h) のキャップになる（h は 0 以下なので半径は 90°
// 以下）。この持ち方なら、地平線も薄明の各段も同じ 1 本の式で扱える。
//
// **経度でループを回してはいけない。** 日の入り（h ≒ 0）のキャップは半径がほぼ 90° あり、必ず
// どちらかの極を含むため各経度に緯度が 1 つ決まる。しかし天文薄明の外側（h = -18°）は半径 72°
// しかなく、太陽赤緯の絶対値が 18° を下回る時期（年の約 56%）には極に届かない閉じた円になる。
// この形では 1 つの経度に緯度が 2 つあったり 1 つも無かったりするため、経度をパラメータにした
// 実装は破綻する。
// ここでは方位角でパラメータ化し、極の包含と日付変更線の跨ぎを後段で処理する。

const DEG = Math.PI / 180

/** J2000.0 元期（2000-01-01 12:00 UTC）。太陽位置の計算はここからの経過日数で行う。 */
const J2000_EPOCH_MS = Date.UTC(2000, 0, 1, 12, 0, 0)
const MS_PER_DAY = 86400000

/**
 * 日の入り・日の出の太陽高度（度）。
 *
 * 太陽の中心が地平線と同じ高さになる 0° ではなく、大気差（約 0.57°）と太陽の視半径（約 0.27°）の
 * ぶん沈んだところが、実際に太陽が見えなくなる高さ。暦の日の入り時刻もこの定義で決まる。
 */
export const SUNSET_ALTITUDE = -0.833

/**
 * 夜が深まりきる太陽高度（度）。天文薄明の下限で、これより下では太陽光が空の明るさに寄与しない。
 * 面はこの高度まで刻み、内側は一様な濃さになる。
 */
export const NIGHT_ALTITUDE = -18

/**
 * 薄明の明るさ。太陽高度（度）と、そのときの屋外の明るさ（常用対数を取った照度・lux）の対応。
 *
 * 空は日の入りから一様に暗くなるのではなく、**最初の数度で大半が暗くなる**。日の入りから
 * 天文薄明の終わりまでで照度は 100 万分の 1 ほどまで落ち、その落ち方は高度に対して直線ではない。
 * 段をこの曲線に沿って置くことで、濃さの変わり方が実際の暗くなり方に近づく。
 *
 * 値は薄明の各段階で一般に挙げられる概数（日の入り 約 400 lux／市民薄明の終わり 約 3.4 lux／
 * 航海薄明の終わり 約 0.008 lux／天文薄明の終わり 約 0.0006 lux）。
 */
const TWILIGHT_LUMINANCE: ReadonlyArray<{ altitude: number; logLux: number }> = [
  { altitude: SUNSET_ALTITUDE, logLux: Math.log10(400) },
  { altitude: -6, logLux: Math.log10(3.4) },
  { altitude: -12, logLux: Math.log10(0.008) },
  { altitude: NIGHT_ALTITUDE, logLux: Math.log10(0.0006) },
]

/**
 * 日の入りから `NIGHT_ALTITUDE` までを刻む段数。
 *
 * 段は外側ほど広い面になり、重ねた枚数がそのまま濃さになる。段数を増やすと 1 段あたりの
 * 濃さの差が縮んで境目が目立たなくなる代わりに、半透明を重ねる回数（描画コスト）が比例して増える。
 *
 * **夜の濃さを上げるなら、ここも併せて見直すこと。** 1 段あたりの濃さは全体の濃さから逆算する
 * ため、濃くすれば段差もそのまま大きくなり、縞として見え始める。
 */
export const SHADOW_STEPS = 32

/** 指定した明るさになる太陽高度（度）。`TWILIGHT_LUMINANCE` の間を直線で結んで逆に引く。 */
function altitudeForLogLux(logLux: number): number {
  for (let i = 1; i < TWILIGHT_LUMINANCE.length; i++) {
    const upper = TWILIGHT_LUMINANCE[i - 1]
    const lower = TWILIGHT_LUMINANCE[i]
    if (logLux >= lower.logLux) {
      const ratio = (upper.logLux - logLux) / (upper.logLux - lower.logLux)
      return upper.altitude + (lower.altitude - upper.altitude) * ratio
    }
  }
  return NIGHT_ALTITUDE
}

/**
 * 濃い順に並べる各段の太陽高度（度）。日の入りから夜が深まりきるまでを、**明るさが等間隔に
 * なるよう**刻む（高度の等間隔ではない）。重ねて描くことを前提にしており、1 段だけでは薄い面に
 * しかならない。
 */
export function shadowAltitudes(steps: number = SHADOW_STEPS): number[] {
  const brightest = TWILIGHT_LUMINANCE[0].logLux
  const darkest = TWILIGHT_LUMINANCE[TWILIGHT_LUMINANCE.length - 1].logLux
  return Array.from({ length: steps }, (_, i) => {
    if (i === 0) return SUNSET_ALTITUDE
    if (i === steps - 1) return NIGHT_ALTITUDE
    return altitudeForLogLux(brightest + ((darkest - brightest) * i) / (steps - 1))
  })
}

/** 経度を -180 以上 180 以下へ畳む。 */
function normalizeLongitude(lon: number): number {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180
  // -180 と 180 は同じ経度。剰余の都合で -180 に寄るが、境界の扱いを揃えるためこのまま返す。
  return wrapped
}

/**
 * 太陽直下点（太陽が天頂に来る地点）の緯度経度（度）。
 *
 * 精度は 0.01° 程度（中心差を 2 項で打ち切る低精度式）。地図上で夜の面を描く用途には十分で、
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

/** 指定時刻・指定地点での太陽高度（度）。負なら地平線より下。 */
export function solarAltitude(epochMs: number, lat: number, lon: number): number {
  const sun = subsolarPoint(epochMs)
  const cosZenith =
    Math.sin(lat * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((lon - sun.lon) * DEG)
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / DEG
}

type Point = [number, number]

/**
 * 隣接する頂点どうしの経度差の上限（度）。これを超える区間は方位角を二分して細かくする。
 *
 * 方位角を等分すると、円が極の近くを通る区間で経度方向の刻みだけが極端に粗くなる。太陽赤緯は
 * 年間を通じて連続的に動くので、どの段でも「円が極にほぼ接する」時期が必ず訪れ、そこでは球面上
 * 1° 足らずの隣り合う 2 頂点の間で経度が 90° 近く飛ぶ。放置すると 2 つの形で害になる。
 *
 * - 極の周りに、経度方向へ長く伸びた直線の辺が残る（描画すると棘のような形に見える）
 * - 経度差が 180° を超えると、下の巻き数の判定が飛びを不連続と読み違える
 *
 * 細分すれば真の経度差は必ず小さくなるので、どちらも同時に消える。
 */
const MAX_LON_STEP_DEG = 20

/**
 * 細分の深さの上限。
 *
 * 円が極のごく近くを通るときは、いくら刻んでも経度差は 0 に収束しない（極では経度が定義され
 * ないため）。ただし細分するたびに差は半減するので、この深さまで刻めば連続化が壊れる 180° に
 * 対して十分な余裕が残る。
 */
const MAX_SUBDIVISION_DEPTH = 8

/**
 * 球面上の円（キャップの縁）を方位角で刻んで点列にする。
 *
 * 経度は畳まずに連続させたまま返す（±180 を超える値を含みうる）。畳んでしまうと、極を含む円で
 * 経度が一周する事実が失われ、リングを閉じられなくなる。
 */
function capRing(centerLat: number, centerLon: number, radiusDeg: number, steps: number): Point[] {
  const lat0 = centerLat * DEG
  const radius = radiusDeg * DEG

  /** 方位角（ラジアン）に対応する円周上の点。経度は中心からの差（±180）で返す。 */
  const pointAt = (bearing: number): { lat: number; deltaLon: number } => {
    const lat = Math.asin(
      Math.sin(lat0) * Math.cos(radius) + Math.cos(lat0) * Math.sin(radius) * Math.cos(bearing),
    )
    const deltaLon = Math.atan2(
      Math.sin(bearing) * Math.sin(radius) * Math.cos(lat0),
      Math.cos(radius) - Math.sin(lat0) * Math.sin(lat),
    )
    return { lat: lat / DEG, deltaLon: deltaLon / DEG }
  }

  const points: Point[] = []
  let previousLon: number | null = null

  /**
   * 直前の頂点から測って経度が連続するよう 360° の倍数を足す。
   * 隣接頂点の真の経度差が 180° 未満であるかぎり、この寄せ方は常に正しい向きを選ぶ。
   */
  const continuousLon = (deltaLon: number): number => {
    const raw = centerLon + deltaLon
    if (previousLon === null) return raw
    return raw + Math.round((previousLon - raw) / 360) * 360
  }

  const push = (lon: number, lat: number) => {
    previousLon = lon
    points.push([lon, lat])
  }

  /** 方位角 `to` の点を出力する。直前の点から経度が飛びすぎるなら、区間を二分して間を埋める。 */
  const emitTo = (from: number, to: number, depth: number) => {
    const target = pointAt(to)
    const lon = continuousLon(target.deltaLon)
    if (previousLon === null || depth >= MAX_SUBDIVISION_DEPTH || Math.abs(lon - previousLon) <= MAX_LON_STEP_DEG) {
      push(lon, target.lat)
      return
    }
    const middle = (from + to) / 2
    emitTo(from, middle, depth + 1)
    emitTo(middle, to, depth + 1)
  }

  const first = pointAt(0)
  push(continuousLon(first.deltaLon), first.lat)
  for (let i = 1; i <= steps; i++) {
    emitTo(((i - 1) / steps) * 2 * Math.PI, (i / steps) * 2 * Math.PI, 0)
  }
  return points
}

/**
 * 半平面 `keep` でポリゴンを切る（Sutherland-Hodgman）。切り口は境界線に沿った辺になる。
 * クリップ領域が凸であれば結果も 1 本のリングに収まる。
 */
function clipHalfPlane(ring: Point[], keep: (p: Point) => boolean, cross: (a: Point, b: Point) => Point): Point[] {
  const out: Point[] = []
  for (let i = 0; i < ring.length - 1; i++) {
    const current = ring[i]
    const next = ring[i + 1]
    const currentIn = keep(current)
    const nextIn = keep(next)
    if (currentIn) out.push(current)
    if (currentIn !== nextIn) out.push(cross(current, next))
  }
  if (out.length > 0) out.push(out[0])
  return out
}

/** 線分 a→b が経度 `lon` を横切る点。刻みが細かいので緯度は線形で補間して差し支えない。 */
function crossAtLongitude(a: Point, b: Point, lon: number): Point {
  const t = (lon - a[0]) / (b[0] - a[0])
  return [lon, a[1] + t * (b[1] - a[1])]
}

/** リングが囲む面積（度平方）。符号は向きで変わるため、大きさの判定にだけ使う。 */
function ringArea(ring: Point[]): number {
  let doubled = 0
  for (let i = 0; i < ring.length - 1; i++) {
    doubled += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return Math.abs(doubled) / 2
}

/**
 * 面積を持つとみなす下限（度平方）。円が経度 ±180 にほぼ接するとき、クリップは「入って出る」
 * 2 交点をほぼ同じ座標で返し、頂点数だけは 4 以上ある細片を作りうる。
 *
 * **正当なリングを巻き込まない値にすること。** 1 年を 15 分刻みで走査した実測では、この形は
 * 1 件も現れず、最小のリングでも 2.7e-6 度平方あった。閾値をその近くに置くと、見えないほど
 * 小さいだけの正しい面を黙って捨てる側に倒れる。ここは丸め誤差の桁だけを弾く。
 */
const MIN_RING_AREA_DEG2 = 1e-12

/**
 * 経度 ±180 の帯へリングを収める。帯からはみ出す分は 360° ずらした複製として切り出すため、
 * 日付変更線を跨ぐ形は複数のリングに分かれる。
 */
function clipToLongitudeBand(ring: Point[]): Point[][] {
  const result: Point[][] = []
  for (const shift of [-360, 0, 360]) {
    const shifted: Point[] = ring.map(([lon, lat]) => [lon + shift, lat])
    const west = clipHalfPlane(shifted, p => p[0] >= -180, (a, b) => crossAtLongitude(a, b, -180))
    if (west.length === 0) continue
    const clipped = clipHalfPlane(west, p => p[0] <= 180, (a, b) => crossAtLongitude(a, b, 180))
    if (clipped.length >= 4 && ringArea(clipped) >= MIN_RING_AREA_DEG2) result.push(clipped)
  }
  return result
}

/**
 * 太陽高度が `altitudeDeg` 以下になる領域を、経度 ±180 に収まるリングの配列で返す。
 * リング 1 本が 1 枚のポリゴンに対応する（日付変更線を跨ぐ形では 2 本以上になる）。
 *
 * @param steps 円周を方位角で刻む数。既定の 360 は方位角 1° 刻み。経度方向の粗さは極の近くで
 *   これより荒れるため、`MAX_LON_STEP_DEG` を超える区間は自動で細分される。
 */
export function shadowPolygon(epochMs: number, altitudeDeg: number, steps = 360): Point[][] {
  const sun = subsolarPoint(epochMs)
  // 夜側は太陽の対蹠点を中心とするキャップ。
  const centerLat = -sun.lat
  const centerLon = normalizeLongitude(sun.lon + 180)
  const radiusDeg = 90 + altitudeDeg

  const ring = capRing(centerLat, centerLon, radiusDeg, steps)

  // 極を含むキャップは、円周だけでは閉じた面にならない。経度の端から極へ回り込む辺を足す。
  //
  // 含むかどうかは「リングが実際に経度を一周したか」だけで決める。解析的にも
  // `90 - |centerLat| < radiusDeg` で判定できるが、2 つの言い方を並べると、円が極をかすめる
  // 配置で両者が食い違い、リングの形と閉じ方だけがずれる。
  // 半径は 90° 以下なので両極を同時に含むことはなく、含む側は中心緯度の符号で決まる。
  const lonSpan = ring[ring.length - 1][0] - ring[0][0]
  if (Math.abs(lonSpan) > 180) {
    const poleLat = centerLat >= 0 ? 90 : -90
    ring.push([ring[ring.length - 1][0], poleLat], [ring[0][0], poleLat], ring[0])
  }

  return clipToLongitudeBand(ring)
}
