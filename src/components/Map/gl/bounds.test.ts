import { describe, it, expect } from 'vitest'
import {
  boundsContains,
  boundsForLiveFollowTuple,
  boundsFromEewCircles,
  boundsFromPositionsTuple,
  clampBoundsToJapan,
  mergeBounds,
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

describe('clampBoundsToJapan', () => {
  it('日本の枠内ならそのまま返す', () => {
    const b: BoundsTuple = [139, 35, 141, 37]
    expect(clampBoundsToJapan(b)).toEqual(b)
  })

  it('枠を超える辺を内側へ詰める', () => {
    // Arrange: 四方すべて日本の枠外へはみ出した矩形
    const b: BoundsTuple = [120, 20, 160, 50]

    // Act
    const clamped = clampBoundsToJapan(b)

    // Assert
    expect(clamped).toEqual([JAPAN_W, JAPAN_S, JAPAN_E, JAPAN_N])
  })

  it('日本と交差しない矩形は詰めずに元のまま返す', () => {
    // Arrange: 完全に日本の西側（大陸方向）にある矩形
    const b: BoundsTuple = [110, 20, 120, 25]

    // Act / Assert: 詰めると west > east の不正な矩形になるため元を返す
    expect(clampBoundsToJapan(b)).toEqual(b)
  })
})

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
    expect((bounds[3] - bounds[1]) / 2).toBeCloseTo((30 * 1.2) / 111.32, 2)
  })

  it('magnitude 不明なら有感半径クランプを外し日本全体キャップのみ効かせる', () => {
    // Arrange: M 不明・S波円が日本を覆う大きさ
    const circles: EewFollowCircle[] = [
      { lat: 37, lng: 141, pRadius: 3000, sRadius: 3000, depth: 10 },
    ]

    // Act
    const bounds = boundsFromEewCircles(circles)!

    // Assert: 日本全体の枠まで（それ以上は広がらない）
    expect(bounds).toEqual([JAPAN_W, JAPAN_S, JAPAN_E, JAPAN_N])
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

  it('沖縄の検知点を日本全体クランプで切り捨てない', () => {
    // Arrange: JAPAN_BOUNDS は本州〜北海道の枠で沖縄(lat 26 付近)を含まない。
    // 円側にだけキャップを効かせ、検知点にはかけないことを担保する。
    const circles: EewFollowCircle[] = [
      { lat: 30, lng: 130, pRadius: 3000, sRadius: 3000, depth: 10 },
    ]
    const okinawa: [number, number][] = [[26.21, 127.68]]

    // Act
    const bounds = boundsForLiveFollowTuple(circles, [], okinawa)!

    // Assert: 沖縄が矩形の南西端として残っている
    expect(bounds[1]).toBeCloseTo(26.21, 5)
    expect(bounds[0]).toBeCloseTo(127.68, 5)
    expect(boundsContains(bounds, [127.68, 26.21, 127.68, 26.21])).toBe(true)
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
