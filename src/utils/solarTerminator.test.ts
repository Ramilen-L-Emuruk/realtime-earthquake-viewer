import { describe, it, expect } from 'vitest'
import {
  subsolarPoint,
  solarAltitude,
  shadowPolygon,
  shadowAltitudes,
  NIGHT_ALTITUDE,
  SUNSET_ALTITUDE,
} from './solarTerminator'

// 至点・分点の時刻（UTC）。天文年鑑の値で、太陽赤緯の折り返し・ゼロ交差を確かめるために使う。
const SOLSTICE_JUNE_2024 = Date.UTC(2024, 5, 20, 20, 51)
const SOLSTICE_DEC_2024 = Date.UTC(2024, 11, 21, 9, 21)
const EQUINOX_MAR_2024 = Date.UTC(2024, 2, 20, 3, 6)

/** 1 年を等間隔で刻んだ時刻列。季節（太陽赤緯）に依存する分岐を全部通すために使う。 */
function yearSamples(count = 73): number[] {
  const start = Date.UTC(2024, 0, 1)
  const span = 366 * 86400000
  return Array.from({ length: count }, (_, i) => start + (span * i) / count)
}

describe('subsolarPoint', () => {
  it('夏至の太陽直下点は北回帰線上にある', () => {
    expect(subsolarPoint(SOLSTICE_JUNE_2024).lat).toBeCloseTo(23.44, 0)
  })

  it('冬至の太陽直下点は南回帰線上にある', () => {
    expect(subsolarPoint(SOLSTICE_DEC_2024).lat).toBeCloseTo(-23.44, 0)
  })

  it('春分の太陽直下点は赤道上にある', () => {
    expect(Math.abs(subsolarPoint(EQUINOX_MAR_2024).lat)).toBeLessThan(0.3)
  })

  it('UTC 正午の太陽直下点はグリニッジ子午線の近くにある', () => {
    // 均時差の分だけずれる（最大 ±4°弱）。ここで見たいのは経度の基準がずれていないこと。
    const lon = subsolarPoint(Date.UTC(2024, 5, 21, 12, 0)).lon
    expect(Math.abs(lon)).toBeLessThan(5)
  })

  it('太陽直下点は 1 年を通じて経度 ±180・緯度 ±23.5 の範囲に収まる', () => {
    for (const t of yearSamples()) {
      const { lat, lon } = subsolarPoint(t)
      expect(lon).toBeGreaterThanOrEqual(-180)
      expect(lon).toBeLessThanOrEqual(180)
      expect(Math.abs(lat)).toBeLessThanOrEqual(23.5)
    }
  })
})

describe('solarAltitude', () => {
  it('太陽直下点では太陽高度が 90 度になる', () => {
    const t = SOLSTICE_JUNE_2024
    const { lat, lon } = subsolarPoint(t)
    expect(solarAltitude(t, lat, lon)).toBeCloseTo(90, 1)
  })

  it('対蹠点では太陽高度が -90 度になる', () => {
    const t = EQUINOX_MAR_2024
    const { lat, lon } = subsolarPoint(t)
    expect(solarAltitude(t, -lat, lon + 180)).toBeCloseTo(-90, 1)
  })

  it('夏至の北極は白夜（太陽高度が正）', () => {
    expect(solarAltitude(SOLSTICE_JUNE_2024, 90, 0)).toBeGreaterThan(0)
  })

  it('夏至の南極は極夜（太陽高度が負）', () => {
    expect(solarAltitude(SOLSTICE_JUNE_2024, -90, 0)).toBeLessThan(0)
  })
})

describe('shadowPolygon', () => {
  // 季節（太陽赤緯）と段の深さの組み合わせを一通り通す。実際の段数まで回す必要はないが、極を含む
  // 段と含まない段の両方を跨ぐ必要があるので、日の入りから夜までを 8 段に間引いて掛け合わせる。
  const allSamples: Array<[number, number]> = []
  for (const t of yearSamples(25)) {
    for (const h of shadowAltitudes(8)) allSamples.push([t, h])
  }

  it('座標は経度 ±180・緯度 ±90 の範囲に収まる', { timeout: 15_000 }, () => {
    for (const [t, h] of allSamples) {
      for (const ring of shadowPolygon(t, h)) {
        for (const [lon, lat] of ring) {
          expect(lon).toBeGreaterThanOrEqual(-180)
          expect(lon).toBeLessThanOrEqual(180)
          expect(lat).toBeGreaterThanOrEqual(-90)
          expect(lat).toBeLessThanOrEqual(90)
        }
      }
    }
  })

  it('各リングは閉じている', () => {
    for (const [t, h] of allSamples) {
      for (const ring of shadowPolygon(t, h)) {
        expect(ring.length).toBeGreaterThanOrEqual(4)
        expect(ring[0]).toEqual(ring[ring.length - 1])
      }
    }
  })

  it('リングの頂点は指定した太陽高度の等高度線上にある', { timeout: 15_000 }, () => {
    // 極を通る辺と経度 ±180 で切った縦辺は等高度線ではないので、緯度 ±90 の点と
    // 経度がちょうど ±180 の点は除く。残りは全て境界そのものでなければならない。
    for (const [t, h] of allSamples) {
      for (const ring of shadowPolygon(t, h)) {
        for (const [lon, lat] of ring) {
          if (Math.abs(lat) >= 89.999 || Math.abs(Math.abs(lon) - 180) < 1e-6) continue
          expect(solarAltitude(t, lat, lon)).toBeCloseTo(h, 1)
        }
      }
    }
  })

  it('太陽高度が低い段ほど面積が小さい（全段が入れ子になる）', { timeout: 15_000 }, () => {
    for (const t of yearSamples(25)) {
      const areas = shadowAltitudes().map((h: number) => totalAbsArea(shadowPolygon(t, h)))
      for (let i = 1; i < areas.length; i++) {
        expect(areas[i]).toBeLessThan(areas[i - 1])
      }
    }
  })

  it('地平線（高度 0）の夜側は全球のおよそ半分を覆う', () => {
    // 経度方向は常に全周（180×360 の矩形の半分＝32400）。極を含む側に寄るため厳密な半分では
    // ないが、平面座標での面積が大きく外れていれば形が壊れている。
    const area = totalAbsArea(shadowPolygon(EQUINOX_MAR_2024, 0))
    expect(area).toBeGreaterThan(32400 * 0.9)
    expect(area).toBeLessThan(32400 * 1.1)
  })

  it('夏至の地平線の夜側は南極を含み、北極を含まない', () => {
    const rings = shadowPolygon(SOLSTICE_JUNE_2024, 0)
    const lats = rings.flat().map(([, lat]) => lat)
    expect(Math.min(...lats)).toBeCloseTo(-90, 3)
    expect(Math.max(...lats)).toBeLessThan(89)
  })

  it('春分の天文薄明の外側は極を含まない閉じた円になる', () => {
    // 太陽赤緯が 18 度を下回る時期は、半径 72 度のキャップが極に届かない。経度で
    // パラメータ化する実装が破綻するのはこの形。
    const rings = shadowPolygon(EQUINOX_MAR_2024, NIGHT_ALTITUDE)
    const lats = rings.flat().map(([, lat]) => lat)
    expect(Math.max(...lats)).toBeLessThan(89)
    expect(Math.min(...lats)).toBeGreaterThan(-89)
  })

  it('日付変更線を跨ぐ時刻では複数のリングに分かれる', () => {
    // 太陽直下点が経度 0 付近＝夜の中心が ±180 付近になる時刻を探す。
    const t = yearSamples(400).find(x => Math.abs(subsolarPoint(x).lon) < 5)
    expect(t).toBeDefined()
    expect(shadowPolygon(t!, NIGHT_ALTITUDE).length).toBeGreaterThan(1)
  })
})

/** 平面座標での多角形の面積の合計（符号は無視）。形の妥当性の目安にだけ使う。 */
function totalAbsArea(rings: Array<Array<[number, number]>>): number {
  return rings.reduce((sum, ring) => {
    let doubled = 0
    for (let i = 0; i < ring.length - 1; i++) {
      doubled += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    }
    return sum + Math.abs(doubled) / 2
  }, 0)
}

describe('shadowAltitudes', () => {
  it('日の入りから始まり、夜が深まりきる高度で終わる', () => {
    const altitudes = shadowAltitudes()
    expect(altitudes[0]).toBe(SUNSET_ALTITUDE)
    expect(altitudes[altitudes.length - 1]).toBe(NIGHT_ALTITUDE)
  })

  it('日の入りは地平線より下にある（大気差と太陽の視半径のぶん）', () => {
    // 太陽の中心が地平線と同じ高さ（0 度）では、まだ太陽は見えている。
    expect(SUNSET_ALTITUDE).toBeLessThan(0)
    expect(SUNSET_ALTITUDE).toBeGreaterThan(-1)
  })

  it('段数の指定どおりの数を返す', () => {
    expect(shadowAltitudes(4)).toHaveLength(4)
    expect(shadowAltitudes(16)).toHaveLength(16)
  })

  it('外側から内側へ単調に下がる', () => {
    const altitudes = shadowAltitudes()
    for (let i = 1; i < altitudes.length; i++) {
      expect(altitudes[i]).toBeLessThan(altitudes[i - 1])
    }
  })

  it('高度ではなく明るさで等間隔に刻む（夜側ほど段が粗くなる）', () => {
    // 空の明るさは日の入り直後に大きく落ち、夜が深まるにつれ緩やかになる。段をその曲線に沿って
    // 置いているため、高度で見た刻み幅は夜側ほど広がる。等間隔に戻すとこの関係が壊れる。
    //
    // 明るさの表（TWILIGHT_LUMINANCE）が降順である前提もここが守っている。並びが崩れると
    // 高度を逆に引く区間を取り違え、この関係が成り立たなくなる（実際に 2 要素を入れ替えると落ちる）。
    const altitudes = shadowAltitudes()
    const firstGap = altitudes[0] - altitudes[1]
    const lastGap = altitudes[altitudes.length - 2] - altitudes[altitudes.length - 1]
    expect(lastGap).toBeGreaterThan(firstGap * 1.5)
  })
})

describe('極の近くを通る円', () => {
  // 円が極にほぼ接する配置。方位角を等分しただけでは、球面上 1 度足らずの隣り合う 2 頂点の間で
  // 経度が 90 度近く飛ぶ（極では経度が定まらないため）。放置すると極の周りに長い直線の辺が残り、
  // 飛びが 180 度を超えれば経度の連続化そのものが壊れる。
  //
  // 太陽赤緯は年間で連続的に動くので、どの段でもこの配置を必ず通過する。時刻を粗く刻んだだけの
  // テストでは踏めないため、臨界の赤緯を狙って直接作る。
  const CRITICAL_SAMPLES = shadowAltitudes().map(altitude => {
    // 中心（対蹠点）の緯度が段の高度と一致するとき、円はちょうど極に接する。
    const criticalDeclination = -altitude
    return { altitude, criticalDeclination }
  })

  /** 指定の太陽赤緯にごく近い時刻を、1 年から二分探索で見つける。 */
  function findTimeWithDeclination(target: number): number {
    let low = Date.UTC(2024, 0, 1)
    let high = Date.UTC(2024, 5, 20)
    for (let i = 0; i < 60; i++) {
      const mid = (low + high) / 2
      if (subsolarPoint(mid).lat < target) low = mid
      else high = mid
    }
    return (low + high) / 2
  }

  /** 2 点間の球面上の角距離（度）。辺が画に出たときの長さは、経度差ではなくこれで決まる。 */
  function angularDistance(a: [number, number], b: [number, number]): number {
    const toRad = Math.PI / 180
    const [lon1, lat1] = a
    const [lon2, lat2] = b
    const cos =
      Math.sin(lat1 * toRad) * Math.sin(lat2 * toRad) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad)
    return Math.acos(Math.max(-1, Math.min(1, cos))) / toRad
  }

  /**
   * 極へ回り込む辺と、経度 ±180 で切った縦辺。どちらも面を閉じるために意図して引いた長い辺なので
   * 判定から外す。極側は「片端が極なら」で見る（円周の端点から極へ上がる辺もここに入る）。
   */
  function isIntentionalEdge(a: [number, number], b: [number, number]): boolean {
    // 閾値ではなく厳密な ±90 で見る。極を回り込む辺はその値で作っているのに対し、検出したい
    // 「極のすぐ隣での飛び」は 89.9999 のような値を持つ。緩く取ると、狙った辺ごと除外してしまう。
    const touchesPole = Math.abs(a[1]) === 90 || Math.abs(b[1]) === 90
    const bothAtSeam = Math.abs(Math.abs(a[0]) - 180) < 1e-6 && Math.abs(Math.abs(b[0]) - 180) < 1e-6
    return touchesPole || bothAtSeam
  }

  it('方位角の刻みが粗くても、経度の連続化が壊れない', () => {
    // 方位角を等分しただけだと、刻みを粗くするほど極付近の 1 ステップの経度差が開き、やがて
    // 180 度に達して連続化がどちら向きに寄せるべきか決められなくなる。細分が働いていれば、
    // 刻みの粗さに関わらず差は抑えられる。既定の 360 分割ではクリップが飛びを分断してしまい
    // 差が表に出ないため、ここでは意図的に粗い刻みで呼ぶ。
    for (const { altitude, criticalDeclination } of CRITICAL_SAMPLES) {
      if (Math.abs(criticalDeclination) > 23.4) continue
      for (const offset of [0, 1e-3, -1e-3]) {
        const t = findTimeWithDeclination(criticalDeclination + offset)
        for (const steps of [45, 24, 12]) {
          for (const ring of shadowPolygon(t, altitude, steps)) {
            for (let i = 1; i < ring.length; i++) {
              if (isIntentionalEdge(ring[i - 1], ring[i])) continue
              expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThan(135)
            }
          }
        }
      }
    }
  })

  it('刻みが粗くても、極を含むかどうかの判断が形と食い違わない', () => {
    // 極を含むかは「リングが経度を一周したか」で決めている。細分が無いと、粗い刻みでは
    // 一周を数え損ねて、極を含む円なのに極へ回り込む辺が足されない形が出来る。
    for (const { altitude, criticalDeclination } of CRITICAL_SAMPLES) {
      if (Math.abs(criticalDeclination) > 23.4) continue
      for (const offset of [5e-2, -5e-2]) {
        const t = findTimeWithDeclination(criticalDeclination + offset)
        const sun = subsolarPoint(t)
        const analytic = 90 - Math.abs(-sun.lat) < 90 + altitude
        for (const steps of [45, 24, 12]) {
          const rings = shadowPolygon(t, altitude, steps)
          const reachesPole = rings.some(r => r.some(([, lat]) => Math.abs(lat) === 90))
          expect(reachesPole).toBe(analytic)
        }
      }
    }
  })

  it('既定の刻みでは、経度差が連続化を壊す大きさまで開かない', () => {
    // 隣接頂点の真の経度差が 180 度に達すると、連続化がどちら向きに寄せるべきか決められなくなる。
    // 極のすぐ隣では経度が原理的に発散するため 0 には落とせない（ここでは臨界から 1e-6 度という
    // 極限まで寄せている）。細分が働いていれば 180 度に対する余裕は保たれる。
    for (const { altitude, criticalDeclination } of CRITICAL_SAMPLES) {
      if (Math.abs(criticalDeclination) > 23.4) continue
      for (const offset of [0, 1e-4, -1e-4, 1e-6, -1e-6]) {
        const t = findTimeWithDeclination(criticalDeclination + offset)
        for (const ring of shadowPolygon(t, altitude)) {
          for (let i = 1; i < ring.length; i++) {
            if (isIntentionalEdge(ring[i - 1], ring[i])) continue
            expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThan(135)
          }
        }
      }
    }
  })

  it('極の近くでも、辺が球面上で長く伸びない（棘にならない）', () => {
    // 見た目の棘になるのは球面上で長い辺だけ。極の直近で経度が飛んでも、球面距離が短ければ
    // 画の上では点に潰れる。方位角 1 度刻みの円周では、辺の長さは 1 度前後に収まるはず。
    for (const { altitude, criticalDeclination } of CRITICAL_SAMPLES) {
      if (Math.abs(criticalDeclination) > 23.4) continue
      for (const offset of [0, 1e-4, -1e-4, 1e-6, -1e-6]) {
        const t = findTimeWithDeclination(criticalDeclination + offset)
        for (const ring of shadowPolygon(t, altitude)) {
          for (let i = 1; i < ring.length; i++) {
            if (isIntentionalEdge(ring[i - 1], ring[i])) continue
            expect(angularDistance(ring[i - 1], ring[i])).toBeLessThan(3)
          }
        }
      }
    }
  })
})

describe('夜側の覆い方', () => {
  /** 平面座標での点の内外判定（レイキャスティング）。 */
  function inRing(ring: Array<[number, number]>, lon: number, lat: number): boolean {
    let inside = false
    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }

  // 面積に比例するよう、緯度は sin 一様で振る。乱数は使わず固定の格子にして結果を再現可能にする。
  const probes: Array<[number, number]> = []
  for (let a = 0; a < 40; a++) {
    for (let b = 0; b < 20; b++) {
      const lon = -180 + (360 * (a + 0.5)) / 40
      const lat = (Math.asin(2 * ((b + 0.5) / 20) - 1) * 180) / Math.PI
      probes.push([lon, lat])
    }
  }

  const times = [
    Date.UTC(2024, 2, 20, 3, 6),
    Date.UTC(2024, 5, 20, 20, 51),
    Date.UTC(2024, 11, 21, 9, 21),
  ]

  it('太陽高度から決まる夜側と、出力した面の内側が一致する', () => {
    for (const t of times) {
      for (const altitude of shadowAltitudes(4)) {
        const rings = shadowPolygon(t, altitude)
        for (const [lon, lat] of probes) {
          const altitudeHere = solarAltitude(t, lat, lon)
          // 境界のごく近くは折れ線近似の誤差が出るので判定から外す
          if (Math.abs(altitudeHere - altitude) < 0.5) continue
          const covered = rings.some(r => inRing(r, lon, lat))
          expect(covered).toBe(altitudeHere < altitude)
        }
      }
    }
  })

  it('同じ場所を 2 枚以上で覆わない（日付変更線で二重に塗らない）', () => {
    for (const t of times) {
      for (const altitude of shadowAltitudes(4)) {
        const rings = shadowPolygon(t, altitude)
        for (const [lon, lat] of probes) {
          const count = rings.reduce((n, r) => n + (inRing(r, lon, lat) ? 1 : 0), 0)
          expect(count).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})
