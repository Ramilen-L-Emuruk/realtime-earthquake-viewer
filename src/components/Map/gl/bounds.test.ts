import { describe, it, expect } from 'vitest'
import { ringVertex } from './psWaveRing'
import { haversineKm } from '../../../utils/geo'
import {
  boundsContains,
  boundsForLiveFollowTuple,
  boundsFromEewCircles,
  boundsFromPositionsTuple,
  mergeBounds,
  EEW_FOLLOW_LOOSE,
  EEW_FOLLOW_MAX_RADIUS_KM,
  JAPAN_BOUNDS,
  JAPAN_WIDE_BOUNDS,
  japanWideCornersLatLng,
  type BoundsTuple,
  type EewFollowCircle,
} from './bounds'

const [[JAPAN_W, JAPAN_S], [JAPAN_E, JAPAN_N]] = JAPAN_BOUNDS
const [[WIDE_W, WIDE_S], [WIDE_E, WIDE_N]] = JAPAN_WIDE_BOUNDS
const wideTuple: BoundsTuple = [WIDE_W, WIDE_S, WIDE_E, WIDE_N]

describe('mergeBounds', () => {
  it('両方 null なら null を返す', () => {
    expect(mergeBounds(null, null)).toBeNull()
  })

  it('片方が null ならもう片方をそのまま返す', () => {
    const b: BoundsTuple = [139, 35, 140, 36]
    expect(mergeBounds(b, null)).toEqual(b)
    expect(mergeBounds(null, b)).toEqual(b)
  })

  it('2つの矩形の外接矩形を返す', () => {
    // Arrange: 一部が重なる2矩形
    const a: BoundsTuple = [139, 35, 141, 37]
    const b: BoundsTuple = [140, 36, 142, 38]

    // Act
    const merged = mergeBounds(a, b)

    // Assert
    expect(merged).toEqual([139, 35, 142, 38])
  })

  it('一方が他方を完全に含む場合は外側を返す', () => {
    const outer: BoundsTuple = [130, 30, 145, 45]
    const inner: BoundsTuple = [139, 35, 140, 36]
    expect(mergeBounds(outer, inner)).toEqual(outer)
  })
})

describe('boundsContains', () => {
  const outer: BoundsTuple = [139, 35, 141, 37]

  it('完全に内側なら true', () => {
    expect(boundsContains(outer, [139.5, 35.5, 140.5, 36.5])).toBe(true)
  })

  it('辺が一致していても含むとみなす', () => {
    expect(boundsContains(outer, outer)).toBe(true)
  })

  it('一辺でもはみ出していれば false', () => {
    expect(boundsContains(outer, [138.9, 35.5, 140.5, 36.5])).toBe(false) // 西
    expect(boundsContains(outer, [139.5, 35.5, 141.1, 36.5])).toBe(false) // 東
    expect(boundsContains(outer, [139.5, 34.9, 140.5, 36.5])).toBe(false) // 南
    expect(boundsContains(outer, [139.5, 35.5, 140.5, 37.1])).toBe(false) // 北
  })
})

describe('boundsFromPositionsTuple', () => {
  it('空配列なら null', () => {
    expect(boundsFromPositionsTuple([])).toBeNull()
  })

  it('1点なら幅0の矩形', () => {
    expect(boundsFromPositionsTuple([[35, 139]])).toEqual([139, 35, 139, 35])
  })

  it('複数点の外接矩形を返す（入力は [lat,lng]・出力は [w,s,e,n]）', () => {
    // Arrange: 宮城〜茨城に散った検知点を模す
    const points: [number, number][] = [
      [38.6, 140.9],
      [36.4, 140.5],
      [37.5, 141.2],
    ]

    // Act
    const bounds = boundsFromPositionsTuple(points)

    // Assert
    expect(bounds).toEqual([140.5, 36.4, 141.2, 38.6])
  })
})

/**
 * 半径 km を南北の度へ。**実装と同じ測地の解き方で出す**（gl/psWaveRing.ts）。
 * 「緯度 1 度 = 111.32km」で書くと、それは R=6378km 相当で距離計算（R=6371）と 0.11% ずれる。
 */
const latDegForKm = (lat: number, lng: number, km: number) => {
  const [, north] = ringVertex(lng, lat, km, 0)
  const [, south] = ringVertex(lng, lat, km, Math.PI)
  return (north - south) / 2
}

describe('boundsFromEewCircles', () => {
  it('円が無ければ null', () => {
    expect(boundsFromEewCircles([])).toBeNull()
  })

  it('半径0の円（発生直後）は無視する', () => {
    const circles: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: 0, sRadius: 0, depth: 10, magnitude: 5 },
    ]
    expect(boundsFromEewCircles(circles)).toBeNull()
  })

  it('S波円が有感半径より大きく育っても有感半径でクランプする', () => {
    // Arrange: M4.0/深さ60km の有感半径は約103km。S波円はその倍以上に育った状態
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 400, sRadius: 300, depth: 60, magnitude: 4.0 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 半径300kmではなく有感半径103km×1.2≒124km 相当（緯度で約1.11度）に収まる
    const latHalfSpan = (bounds[3] - bounds[1]) / 2
    expect(latHalfSpan).toBeGreaterThan(1.0)
    expect(latHalfSpan).toBeLessThan(1.3)
  })

  it('S波円が有感半径より小さいうちは S波円の大きさで追う', () => {
    // Arrange: 同じ震源で S波円がまだ 30km しか育っていない
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 50, sRadius: 30, depth: 60, magnitude: 4.0 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 30km×1.2=36km 相当（緯度で約0.32度）
    const latHalfSpan = (bounds[3] - bounds[1]) / 2
    expect(latHalfSpan).toBeCloseTo(36 / 111.32, 2)
  })

  it('sRadius が無ければ pRadius へフォールバックする', () => {
    const circles: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: 30, sRadius: 0, depth: 10, magnitude: 4.0 },
    ]
    const bounds = boundsFromEewCircles(circles)!
    expect((bounds[3] - bounds[1]) / 2).toBeCloseTo(latDegForKm(37, 141, 30 * 1.2), 2)
  })

  it('magnitude 不明なら有感半径クランプを外し引き上限のみ効かせる', () => {
    // Arrange: M 不明・S波円が日本を覆う大きさ
    const circles: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: 3000, sRadius: 3000, depth: 10 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 引き上限の半径まで（それ以上は広がらない）・中心は震源のまま
    expect((bounds[3] - bounds[1]) / 2).toBeCloseTo(latDegForKm(37, 141, EEW_FOLLOW_MAX_RADIUS_KM), 5)
    expect((bounds[1] + bounds[3]) / 2).toBeCloseTo(37, 10)
    expect((bounds[0] + bounds[2]) / 2).toBeCloseTo(141, 10)
  })

  // 以下 4 件は引き上限（EEW_FOLLOW_MAX_RADIUS_KM）の検証。旧実装は日本の枠との交差で矩形の辺を
  // 別々に詰めていたため、枠の外に震源がある地震で震源が箱から外れていた（2026-08-19 奄美大島北西沖）。
  it('引き上限を超えて育った円は上限で頭打ちになり、中心は震源のまま', () => {
    // Arrange: M9 相当・有感半径 1968km がさらにルーズ余白で膨らむ状態
    const circles: EewFollowCircle[] = [
      { lat: 38.1, lng: 142.9, pRadius: 5000, sRadius: 5000, depth: 24, magnitude: 9.0 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 半径は上限ちょうど・箱は震源中心
    expect((bounds[3] - bounds[1]) / 2).toBeCloseTo(latDegForKm(38.1, 142.9, EEW_FOLLOW_MAX_RADIUS_KM), 5)
    expect((bounds[1] + bounds[3]) / 2).toBeCloseTo(38.1, 10)
    expect((bounds[0] + bounds[2]) / 2).toBeCloseTo(142.9, 10)
  })

  it('日本の枠の外に震源があっても中心は震源のまま（旧クランプの回帰）', () => {
    // Arrange: 2026-08-19 20:44 奄美大島北西沖 M5.2・深さ200km。S波が地表に届かず pRadius へ
    // フォールバックした状態。震源(28.9N/128.0E)は JAPAN_BOUNDS の南西外にある。
    // 旧実装ではこの円が枠に触れた瞬間、震源を含まない箱（W129.43 S30.99 E130.99 N31.43）に化けていた。
    const circles: EewFollowCircle[] = [
      { lat: 28.9, lng: 128.0, pRadius: 235, sRadius: 0, depth: 200, magnitude: 5.1 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 震源が箱の中心にあり、箱は震源を含む
    expect((bounds[1] + bounds[3]) / 2).toBeCloseTo(28.9, 10)
    expect((bounds[0] + bounds[2]) / 2).toBeCloseTo(128.0, 10)
    expect(boundsContains(bounds, [128.0, 28.9, 128.0, 28.9])).toBe(true)
  })

  it('引き上限を入れても有感半径クランプは免除しない', () => {
    // Arrange: M4.0/深さ60km の有感半径は約103km。上限 800km よりはるかに小さい
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 2000, sRadius: 2000, depth: 60, magnitude: 4.0 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 上限ではなく有感半径で止まっている
    const halfSpanKm = ((bounds[3] - bounds[1]) / 2) * 111.32
    expect(halfSpanKm).toBeLessThan(200)
  })

  it('ルーズ余白を掛けた後に上限をかける（上限が 1.2 倍に膨らまない）', () => {
    // Arrange: 有感半径が上限を超える大地震。先に上限をかけると 800×1.2=960km になってしまう
    const circles: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: 5000, sRadius: 5000, depth: 20, magnitude: 8.0 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 上限そのもの（ルーズ余白は乗らない）
    // 度 → km は haversineKm で戻す（実装と同じ球）。
    const halfSpanKm = haversineKm(bounds[1], 141, bounds[3], 141) / 2
    expect(halfSpanKm).toBeCloseTo(EEW_FOLLOW_MAX_RADIUS_KM, 5)
    expect(halfSpanKm).toBeLessThan(EEW_FOLLOW_MAX_RADIUS_KM * EEW_FOLLOW_LOOSE)
  })

  // 以下 3 件は壊れた入力の隔離。NaN は比較が常に false になるため `<= 0` では弾けず、素通りすると
  // Math.min / mergeBounds を通って合成後の矩形全体を NaN で汚染する（上限も NaN はクランプできない）。
  it('半径が NaN の円は無視する', () => {
    const circles: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: NaN, sRadius: NaN, depth: 10, magnitude: 5 },
    ]
    expect(boundsFromEewCircles(circles)).toBeNull()
  })

  it('座標が NaN の円は無視する', () => {
    const circles: EewFollowCircle[] = [
      { lat: NaN, lng: 141, pRadius: 100, sRadius: 80, depth: 10, magnitude: 5 },
    ]
    expect(boundsFromEewCircles(circles)).toBeNull()
  })

  it('壊れた円が混ざっても健全な円だけで矩形を作る（NaN で汚染しない）', () => {
    // Arrange: 1 件目が壊れている（複数 EEW 同時発報で片方の値が壊れた状態）
    const broken: EewFollowCircle[] = [
      { lat: NaN, lng: NaN, pRadius: NaN, sRadius: NaN, depth: NaN, magnitude: NaN },
      { lat: 37, lng: 141, pRadius: 50, sRadius: 30, depth: 10, magnitude: 4.0 },
    ]

    // Act
    const bounds = boundsFromEewCircles(broken)!

    // Assert: 健全な円だけの結果と一致し、どの辺も有限
    expect(bounds).toEqual(boundsFromEewCircles([broken[1]]))
    expect(bounds.every(Number.isFinite)).toBe(true)
  })

  it('深さが NaN でも有感半径クランプが働く（深さ 0 として扱う）', () => {
    const nanDepth: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: 2000, sRadius: 2000, depth: NaN, magnitude: 4.0 },
    ]
    const zeroDepth: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: 2000, sRadius: 2000, depth: 0, magnitude: 4.0 },
    ]
    expect(boundsFromEewCircles(nanDepth)).toEqual(boundsFromEewCircles(zeroDepth))
  })

  it('複数の円を1つの外接矩形にまとめる', () => {
    const circles: EewFollowCircle[] = [
      { lat: 35, lng: 139, pRadius: 30, sRadius: 20, depth: 10, magnitude: 4.0 },
      { lat: 38, lng: 142, pRadius: 30, sRadius: 20, depth: 10, magnitude: 4.0 },
    ]
    const bounds = boundsFromEewCircles(circles)!
    expect(bounds[1]).toBeLessThan(35)
    expect(bounds[3]).toBeGreaterThan(38)
    expect(bounds[0]).toBeLessThan(139)
    expect(bounds[2]).toBeGreaterThan(142)
  })
})

describe('boundsForLiveFollowTuple', () => {
  it('円も震源座標も検知点も無ければ null', () => {
    expect(boundsForLiveFollowTuple([], [], [])).toBeNull()
  })

  it('円が作れなくても検知点があれば検知点だけで追従する', () => {
    // Arrange: 仮定震源要素・M不明・自動解除直後などで psWave が空になったケース。
    // 以前はここで追従が止まり「EEW は生きているのに誰も追わない」穴になっていた。
    const points: [number, number][] = [
      [38.6, 140.9],
      [36.4, 140.5],
    ]

    // Act
    const bounds = boundsForLiveFollowTuple([], [], points)

    // Assert
    expect(bounds).toEqual([140.5, 36.4, 140.9, 38.6])
  })

  it('検知点が無ければ円だけの bounds と一致する', () => {
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 100, sRadius: 80, depth: 60, magnitude: 4.0 },
    ]
    expect(boundsForLiveFollowTuple(circles, [], [])).toEqual(boundsFromEewCircles(circles))
  })

  it('円が無い EEW の震源座標も含める（仮定震源要素等で psWave に円が無いケース）', () => {
    // Arrange: 円が作れない EEW の震源だけが取り残されないことを確認する。
    const hypocenters: [number, number][] = [[35.0, 139.0]]

    // Act
    const bounds = boundsForLiveFollowTuple([], hypocenters, [])

    // Assert
    expect(bounds).toEqual([139.0, 35.0, 139.0, 35.0])
  })

  it('円のある EEW の震源座標を合成しても円だけの bounds と変わらない（円に包含されるため無害）', () => {
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 100, sRadius: 80, depth: 60, magnitude: 4.0 },
    ]
    const bounds = boundsForLiveFollowTuple(circles, [[37.35, 141.75]], [])
    expect(bounds).toEqual(boundsFromEewCircles(circles))
  })

  it('検知点が円をはみ出す場合、両方が入る矩形になる（2026-08-07 福島県沖の実例）', () => {
    // Arrange: M4.0/深さ60km・震源は福島県沖。検知点は宮城県北部〜茨城県に散り、
    // 北は有感半径 bounds(≒lat 38.46) を超え、南は有感半径 bounds(≒lat 36.24) の内側にある。
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 400, sRadius: 300, depth: 60, magnitude: 4.0 },
    ]
    const points: [number, number][] = [
      [38.6, 140.9], // 宮城県北部（円の北端より外）
      [36.4, 140.5], // 茨城県北部（円の南端より内）
    ]
    const circleBounds = boundsFromEewCircles(circles)!

    // Act
    const bounds = boundsForLiveFollowTuple(circles, [], points)!

    // Assert: 北端は検知点が、南端は円が決める（互いにはみ出し合う関係を両取りする）
    expect(bounds[3]).toBeCloseTo(38.6, 5)
    expect(bounds[1]).toBeCloseTo(circleBounds[1], 5)
    expect(boundsContains(bounds, circleBounds)).toBe(true)
    expect(boundsContains(bounds, boundsFromPositionsTuple(points)!)).toBe(true)
  })

  it('引き上限の外にある検知点を切り捨てない', () => {
    // Arrange: 円は上限（半径 800km）で頭打ち。震源を東北沖に置くと沖縄(lat 26 付近)は
    // その箱の外に出る。円側にだけ上限を効かせ、検知点にはかけないことを担保する。
    const circles: EewFollowCircle[] = [
      { lat: 40, lng: 140, pRadius: 3000, sRadius: 3000, depth: 10 },
    ]
    const okinawa: [number, number][] = [[26.21, 127.68]]

    // Act
    const bounds = boundsForLiveFollowTuple(circles, [], okinawa)!

    // Assert: 沖縄が矩形の南西端として残っている
    expect(bounds[1]).toBeCloseTo(26.21, 5)
    expect(bounds[0]).toBeCloseTo(127.68, 5)
    expect(boundsContains(bounds, [127.68, 26.21, 127.68, 26.21])).toBe(true)
  })

  // 以下 4 件は「予想の区域塗り」（useEewLayerData の eewFitPositions・区域 bbox の南西/北東 2 点）を
  // 目標へ合成する引数の検証。予想震度は気象庁の発表値で、S波がまだ届いていない遠方の区域も含む。
  it('予想の区域塗りが円をはみ出す場合、両方が入る矩形になる', () => {
    // Arrange: 円（有感半径クランプ後 ≒ lng 140.4〜143.1）の西側へ区域がはみ出すケース。
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 100, sRadius: 80, depth: 60, magnitude: 4.0 },
    ]
    const areas: [number, number][] = [
      [35.2, 139.0],
      [36.5, 140.2],
    ]
    const circleBounds = boundsFromEewCircles(circles)!

    // Act
    const bounds = boundsForLiveFollowTuple(circles, [], [], areas)!

    // Assert: 西端は区域が、北端は円が決める
    expect(bounds[0]).toBeCloseTo(139.0, 5)
    expect(bounds[3]).toBeCloseTo(circleBounds[3], 5)
    expect(boundsContains(bounds, circleBounds)).toBe(true)
    expect(boundsContains(bounds, boundsFromPositionsTuple(areas)!)).toBe(true)
  })

  it('円も震源も検知点も無く区域塗りだけがあれば、区域だけで追従する', () => {
    const areas: [number, number][] = [
      [33.0, 130.0],
      [34.0, 131.5],
    ]
    expect(boundsForLiveFollowTuple([], [], [], areas)).toEqual([130.0, 33.0, 131.5, 34.0])
  })

  it('引き上限の外にある予想区域を切り捨てない', () => {
    // Arrange: 検知点と同じ理由（上限は円が際限なく育つのを止めるためのもの）で、区域側にもかけない。
    const circles: EewFollowCircle[] = [{ lat: 40, lng: 140, pRadius: 3000, sRadius: 3000, depth: 10 }]
    const okinawaArea: [number, number][] = [
      [26.05, 127.6],
      [26.9, 128.3],
    ]

    // Act
    const bounds = boundsForLiveFollowTuple(circles, [], [], okinawaArea)!

    // Assert
    expect(bounds[1]).toBeCloseTo(26.05, 5)
    expect(bounds[0]).toBeCloseTo(127.6, 5)
  })

  it('区域塗りを省略した場合は従来の目標（円 ∪ 震源 ∪ 検知点）と一致する', () => {
    const circles: EewFollowCircle[] = [
      { lat: 37.35, lng: 141.75, pRadius: 100, sRadius: 80, depth: 60, magnitude: 4.0 },
    ]
    const points: [number, number][] = [[38.6, 140.9]]
    expect(boundsForLiveFollowTuple(circles, [], points)).toEqual(
      boundsForLiveFollowTuple(circles, [], points, []),
    )
  })
})

// 遠地地震のカメラフィット（useQuakeLayerData の quakeFitPositions）は、この枠の南西・北東 2 隅を
// フィット対象へ加えることで日本全体を必ず画面へ収める。座標順（[lng,lat]）を取り違えると日本から
// 大きく外れた矩形になり、遠地地震でしか再現しない不具合になるためテストで固定する。
describe('JAPAN_WIDE_BOUNDS', () => {
  it('[lng,lat] 順の南西・北東で、南西 < 北東になっている', () => {
    expect(WIDE_W).toBeLessThan(WIDE_E)
    expect(WIDE_S).toBeLessThan(WIDE_N)
  })

  it('本州〜北海道の枠（JAPAN_BOUNDS）を完全に含む', () => {
    expect(boundsContains(wideTuple,[JAPAN_W, JAPAN_S, JAPAN_E, JAPAN_N])).toBe(true)
  })

  it.each([
    ['与那国島', 122.94, 24.45],
    ['沖縄本島', 127.68, 26.21],
    ['父島（小笠原）', 142.19, 27.09],
    ['択捉島', 148.75, 45.33],
    ['稚内', 141.68, 45.42],
  ])('%s を含む', (_name, lng, lat) => {
    expect(boundsContains(wideTuple,[lng, lat, lng, lat])).toBe(true)
  })
})

describe('japanWideCornersLatLng', () => {
  it('[lat,lng] 順の南西・北東 2 点を返す（[lng,lat] のまま渡さない）', () => {
    // Arrange & Act
    const [sw, ne] = japanWideCornersLatLng()

    // Assert: 日本の緯度は 20〜50 度台・経度は 120〜150 度台。並びを取り違えると
    // 緯度に 122 のような値が入り、フィット先が日本から大きく外れる。
    expect(sw).toEqual([24, 122])
    expect(ne).toEqual([46, 149])
  })

  it('返した 2 点の外接矩形が JAPAN_WIDE_BOUNDS と一致する', () => {
    // Arrange & Act: boundsFromPositionsTuple は [lat,lng] を受けて [w,s,e,n] を返す。
    const bounds = boundsFromPositionsTuple(japanWideCornersLatLng())

    // Assert
    expect(bounds).toEqual(wideTuple)
  })
})
