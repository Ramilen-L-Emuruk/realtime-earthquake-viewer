// 地名ラベルの配置判定（そのまま置く／退避する／薄くする）の回帰テスト。
//
// 実地図なしで検証できるよう、MapLibre の map から使う 3 つ（getLayer / project / queryRenderedFeatures）
// だけを差し替える。project は「経度 1 度 = 1000px・北が上」の線形投影に単純化する（メルカトルの
// 緯度依存は判定ロジックの分岐に関与しない——実装は必ず project 経由で px を測るため）。
import { describe, it, expect } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  DIMMED_TEXT_OPACITY,
  LABEL_TEXT_OPACITY_EXPR,
  computeLabelPlacements,
  labelTextOffsetExpr,
  type LabelOverlapTarget,
} from './labelOverlap'

const PX_PER_DEG = 1000

/** 画面上の障害物（震度バッジ・観測点ドット等に相当する点）。 */
interface Obstacle {
  x: number
  y: number
  /** 既定は quake-points（可視判定を素通りする層）。 */
  layerId?: string
  /** 区域名（excludeName の照合に使う）。 */
  name?: string
  /** kyoshin-points のときだけ意味を持つ feature-state。 */
  opacity?: number
}

function fakeMap(
  obstacles: Obstacle[],
  existingLayers = ['quake-points', 'kyoshin-points'],
  /** 地図の回転（度）。0 なら北が画面上。 */
  bearingDeg = 0,
): MapLibreMap {
  return {
    getLayer: (id: string) => (existingLayers.includes(id) ? { id } : undefined),
    // 実物（maplibre-gl の LngLat）は NaN を渡すと同期的に例外を投げる。壊れたデータを素通しした
    // ときの巻き添え（targets.map ごと落ちる）を再現できるよう、モックも同じ振る舞いにする。
    project: ([lng, lat]: [number, number]) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat))
        throw new Error(`Invalid LngLat object: (${lng}, ${lat})`)
      const x0 = lng * PX_PER_DEG
      const y0 = -lat * PX_PER_DEG
      if (!bearingDeg) return { x: x0, y: y0 }
      const r = (bearingDeg * Math.PI) / 180
      return { x: x0 * Math.cos(r) + y0 * Math.sin(r), y: -x0 * Math.sin(r) + y0 * Math.cos(r) }
    },
    queryRenderedFeatures: (box: [[number, number], [number, number]]) => {
      const [[x1, y1], [x2, y2]] = box
      return obstacles
        .filter((o) => o.x >= x1 && o.x <= x2 && o.y >= y1 && o.y <= y2)
        .map((o) => ({
          layer: { id: o.layerId ?? 'quake-points' },
          properties: { name: o.name },
          state: { opacity: o.opacity ?? 1 },
        }))
    },
  } as unknown as MapLibreMap
}

// 代表点は原点（0, 0）に投影される。text 2 文字 × 10px なので halfW=10 / halfH=6.5、
// 退避量は 2em = 20px。退避に必要な余地は 20 + 6.5 = 26.5px（中心の移動量だけでは足りない）。
function target(over: Partial<LabelOverlapTarget> = {}): LabelOverlapTarget {
  return {
    source: 'labels',
    id: 0,
    lngLat: [0, 0],
    text: 'ああ',
    textSize: 10,
    shiftEm: 2,
    room: [0.1, 0.1], // 上下とも 100px ぶんの余地
    ...over,
  }
}

const only = (map: MapLibreMap, t: LabelOverlapTarget, iconScale = 1) =>
  computeLabelPlacements(map, [t], iconScale)[0]

describe('computeLabelPlacements', () => {
  it('重なっていなければ退避しない', () => {
    expect(only(fakeMap([{ x: 500, y: 500 }]), target())).toEqual({ shift: 'none', dimmed: false })
  })

  it('代表点で重なり、余地があれば退避する', () => {
    expect(only(fakeMap([{ x: 0, y: 0 }]), target())).toEqual({ shift: 'up', dimmed: false })
  })

  it('退避先も塞がっていれば反対側へ回す', () => {
    // 上（y=-20）にも障害物を置く。下（y=+20）は空いている。
    const map = fakeMap([
      { x: 0, y: 0 },
      { x: 0, y: -20 },
    ])
    expect(only(map, target())).toEqual({ shift: 'down', dimmed: false })
  })

  it('上下とも塞がっていれば薄くする', () => {
    const map = fakeMap([
      { x: 0, y: 0 },
      { x: 0, y: -20 },
      { x: 0, y: 20 },
    ])
    expect(only(map, target())).toEqual({ shift: 'none', dimmed: true })
  })

  it('余地が広い側を先に試す', () => {
    // 北 50px / 南 200px。どちらへ逃げても避けられるので、広い南が選ばれる。
    expect(only(fakeMap([{ x: 0, y: 0 }]), target({ room: [0.05, 0.2] }))).toEqual({
      shift: 'down',
      dimmed: false,
    })
  })

  it('余地が退避量に足りなければ退避せず薄くする', () => {
    // 20px の余地では、退避量 20px ＋ 文字の半分 6.5px に届かない（文字が領域の外へはみ出す）。
    expect(only(fakeMap([{ x: 0, y: 0 }]), target({ room: [0.02, 0.02] }))).toEqual({
      shift: 'none',
      dimmed: true,
    })
  })

  it('代表点が領域の外にある区域（room が [0,0]）は退避しない', () => {
    expect(only(fakeMap([{ x: 0, y: 0 }]), target({ room: [0, 0] }))).toEqual({
      shift: 'none',
      dimmed: true,
    })
  })

  // 余地は「外に出るまでの距離」なので負にはならない。負値が来ると shiftCandidates の Math.abs が
  // 符号を吸収し、余地が無いはずの方向を「余地がある」と読んでしまう（型としては正しいので
  // isFinitePair では捕まらない）。
  it.each([
    ['北が負', [-0.05, 0.005]],
    ['南が負', [0.005, -0.05]],
    ['両方が負', [-0.1, -0.1]],
  ])('負の room（%s）は余地として使わない', (_label, room) => {
    const map = fakeMap([{ x: 0, y: 0 }])
    expect(only(map, target({ room: room as [number, number] }))).toEqual({
      shift: 'none',
      dimmed: true,
    })
  })

  it('0 の余地は「使えない値」ではなく「退避できない」として扱う（境界）', () => {
    // 上は 0（退避不可）だが下には十分あるので、下へ回れる。負値のように全体を捨てない。
    const map = fakeMap([{ x: 0, y: 0 }])
    expect(only(map, target({ room: [0, 0.1] }))).toEqual({ shift: 'down', dimmed: false })
  })

  // 地図の回転（bearing）を入れると、地理的な北は画面の上とは限らなくなる。`room` は経度線に
  // 沿って真北・真南へ測った値（scripts/lib/labelAnchor.mjs の shiftRoom）なので、投影してから
  // **符号で**どちらが画面上方向に伸びるかを決める必要がある。絶対値で測ると北が画面下へ来た
  // ときに「上に余地がある」と読み違え、退避先が区域の外へ出る。
  describe('回転しているとき', () => {
    it('北が画面下へ来たら、北の余地は「下」の候補になる', () => {
      // Arrange: 北にだけ余地がある区域を、真南向き（bearing 180）で見る。
      const map = fakeMap([{ x: 0, y: 0 }], undefined, 180)
      // Act & Assert: 画面上ではなく下へ逃げる。
      expect(only(map, target({ room: [0.1, 0] }))).toEqual({ shift: 'down', dimmed: false })
    })

    it('回転していなければ同じ room で「上」へ退避する（対照）', () => {
      const map = fakeMap([{ x: 0, y: 0 }])
      expect(only(map, target({ room: [0.1, 0] }))).toEqual({ shift: 'up', dimmed: false })
    })

    it('南北が画面の横を向くと余地が消え、退避せず薄くする（安全弁）', () => {
      // Arrange: bearing 90 では南北の変位がほぼ画面 x 成分になり、y 成分が残らない。
      // Act & Assert: 上下どちらの候補も立たないので、無理に動かさず薄くする側へ倒れる。
      const map = fakeMap([{ x: 0, y: 0 }], undefined, 90)
      expect(only(map, target({ room: [0.1, 0.1] }))).toEqual({ shift: 'none', dimmed: true })
    })
  })

  it('退避させないラベル（地方名＝ shiftEm なし）は重なったら薄くなる', () => {
    const t = target({ shiftEm: undefined, room: undefined })
    expect(only(fakeMap([{ x: 0, y: 0 }]), t)).toEqual({ shift: 'none', dimmed: true })
  })

  it('判定対象のレイヤーが 1 つも無ければ、重なりを見ずにそのまま表示する', () => {
    const map = fakeMap([{ x: 0, y: 0 }], [])
    expect(only(map, target())).toEqual({ shift: 'none', dimmed: false })
  })

  // 区域名ラベルは自区域の震度バッジと同じ代表点に置かれる。「自区域だから無視する」を代表点の
  // 判定にも効かせると、避けたい当の相手が判定から消えて退避が発火しない（実装当初この穴があった）。
  it('自区域のバッジでも、代表点で重なっていれば退避のきっかけになる', () => {
    const map = fakeMap([{ x: 0, y: 0, name: '甲区域' }])
    expect(only(map, target({ excludeName: '甲区域' }))).toEqual({ shift: 'up', dimmed: false })
  })

  // 退避「後」は自区域のバッジを重なりに数えない。狙いは「逃がした先で縁がかすめる分の許容」だが、
  // 判定は名前の一致だけを見ていて**重なりの大小は区別しない**（下のケースは完全に重なっていても
  // 退避を成立させる）。この割り切りを明示的に固定しておく。
  it('退避したあとは、自区域のバッジとどれだけ重なっていても退避を成立させる', () => {
    const map = fakeMap([
      { x: 0, y: 0, name: '甲区域' },
      { x: 0, y: -20, name: '甲区域' },
    ])
    expect(only(map, target({ excludeName: '甲区域' }))).toEqual({ shift: 'up', dimmed: false })
  })

  it('退避先に別区域のバッジがあれば、そちらは避ける', () => {
    // 上（y=-20）は別区域なので避けられない。下（y=+20）へ回る。
    const map = fakeMap([
      { x: 0, y: 0, name: '甲区域' },
      { x: 0, y: -20, name: '乙区域' },
    ])
    expect(only(map, target({ excludeName: '甲区域' }))).toEqual({ shift: 'down', dimmed: false })
  })

  it('隣接する別区域のバッジは重なりに数える', () => {
    const map = fakeMap([{ x: 0, y: 0, name: '乙区域' }])
    expect(only(map, target({ excludeName: '甲区域' }))).toEqual({ shift: 'up', dimmed: false })
  })

  // 生成データ（public/data/*.json）は実行時に検証されない。壊れた room を素通しすると
  // map.project が NaN 座標で例外を投げ、targets.map ごと巻き添えで判定全体が止まる。
  it.each([
    ['要素が足りない', [0.1]],
    ['数値でない', ['a', 'b']],
    ['NaN を含む', [Number.NaN, 0.1]],
    ['配列でない', 0.1],
    ['null', null],
  ])('壊れた room（%s）でも例外を投げず、退避なしに倒す', (_label, room) => {
    const map = fakeMap([{ x: 0, y: 0 }])
    const t = target({ room: room as unknown as [number, number] })
    expect(() => only(map, t)).not.toThrow()
    expect(only(map, t)).toEqual({ shift: 'none', dimmed: true })
  })

  // 座標（生成データの label）も room と同じ無検証の入口。こちらは投影そのものが落ちる。
  it.each([
    ['要素が足りない', [139]],
    ['NaN を含む', [139, Number.NaN]],
    ['配列でない', 139],
  ])('壊れた lngLat（%s）でも例外を投げず、既定値に倒す', (_label, lngLat) => {
    const map = fakeMap([{ x: 0, y: 0 }])
    const t = target({ lngLat: lngLat as unknown as [number, number] })
    expect(() => only(map, t)).not.toThrow()
    expect(only(map, t)).toEqual({ shift: 'none', dimmed: false })
  })

  it('壊れた room が 1 件あっても、他のラベルの判定は続く', () => {
    const map = fakeMap([{ x: 0, y: 0 }])
    const targets = [
      target({ id: 0, room: [Number.NaN, 0.1] as unknown as [number, number] }),
      target({ id: 1 }),
    ]
    expect(computeLabelPlacements(map, targets, 1)).toEqual([
      { shift: 'none', dimmed: true },
      { shift: 'up', dimmed: false },
    ])
  })

  it('未検出（透明）の観測点ドットは重なりに数えない', () => {
    const map = fakeMap([{ x: 0, y: 0, layerId: 'kyoshin-points', opacity: 0 }])
    expect(only(map, target())).toEqual({ shift: 'none', dimmed: false })
  })

  it('倍率を上げると判定矩形も広がる', () => {
    // 中心から 12px 離れた障害物。倍率 1 では halfW=10 で届かず、倍率 2 では halfW=20 で当たる。
    const map = fakeMap([{ x: 12, y: 0 }])
    expect(only(map, target(), 1)).toEqual({ shift: 'none', dimmed: false })
    expect(only(map, target(), 2).shift).toBe('up')
  })

  it('倍率を上げると退避量も広がる', () => {
    // 倍率 2 では退避量 40px。上に 45px の余地しかない room では、必要量 40+13=53px に届かず消える。
    const map = fakeMap([{ x: 0, y: 0 }])
    expect(only(map, target({ room: [0.045, 0.045] }), 1).shift).toBe('up')
    expect(only(map, target({ room: [0.045, 0.045] }), 2)).toEqual({ shift: 'none', dimmed: true })
  })

  it('渡した順・同じ長さで返す', () => {
    const map = fakeMap([{ x: 0, y: 0 }])
    const targets = [target({ id: 0 }), target({ id: 1, lngLat: [0.5, 0.5] }), target({ id: 2 })]
    const placements = computeLabelPlacements(map, targets, 1)
    expect(placements).toHaveLength(3)
    expect(placements.map((p) => p.shift)).toEqual(['up', 'none', 'up'])
  })
})

describe('スタイル式', () => {
  it('text-offset は shift の 3 値に対応する（値が増えたら式も直す）', () => {
    expect(labelTextOffsetExpr(2.2)).toEqual([
      'case',
      ['==', ['get', 'shift'], 'up'],
      ['literal', [0, -2.2]],
      ['==', ['get', 'shift'], 'down'],
      ['literal', [0, 2.2]],
      ['literal', [0, 0]],
    ])
  })

  it('text-opacity は dimmed を見て薄くする（消さない）', () => {
    expect(LABEL_TEXT_OPACITY_EXPR).toEqual([
      'case',
      ['boolean', ['get', 'dimmed'], false],
      DIMMED_TEXT_OPACITY,
      1,
    ])
    expect(DIMMED_TEXT_OPACITY).toBeGreaterThan(0)
  })
})
