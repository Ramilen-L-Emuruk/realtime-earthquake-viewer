import { describe, it, expect } from 'vitest'
import {
  buildLegendBlocks,
  representativeBlock,
  EMPTY_LEGEND_SOURCES,
  type MapLegendSources,
} from './legendBlocks'
import { INTENSITY_COLORS } from '../../utils/intensity'
import { TSUNAMI_OBS_HEIGHT_STEPS, tsunamiObsBarColor } from '../Map/gl/tsunamiObsBarStyle'
import { SHINDO0_COLOR } from '../../utils/kyoshinIntensity'
import { TSUNAMI_STYLE } from '../../utils/tsunamiStyle'
import { depthRampT, jstYearStartMs } from '../../utils/hypocenterCatalogView'

function sources(patch: Partial<MapLegendSources>): MapLegendSources {
  return { ...EMPTY_LEGEND_SOURCES, ...patch }
}

describe('buildLegendBlocks', () => {
  it('何も描いていなければ 1 ブロックも作らない', () => {
    expect(buildLegendBlocks(EMPTY_LEGEND_SOURCES)).toEqual([])
  })

  describe('震度のスケール', () => {
    it('発表値の震度だけを描いているときは震度0 を並べない', () => {
      const [block] = buildLegendBlocks(sources({ quakeIntensity: true }))
      expect(block.title).toBe('震度')
      expect(block.swatch.kind).toBe('scale')
      if (block.swatch.kind !== 'scale') throw new Error('scale ではない')
      expect(block.swatch.cells.map((c) => c.label)).toEqual(['1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'])
    })

    it('リアルタイム震度では震度0 を先頭に足す', () => {
      const [block] = buildLegendBlocks(sources({ realtimeIntensity: true }))
      if (block.swatch.kind !== 'scale') throw new Error('scale ではない')
      expect(block.swatch.cells[0]).toEqual({ label: '0', color: SHINDO0_COLOR })
    })

    it('色は気象庁配色の定数から採る（凡例へ書き写さない）', () => {
      const [block] = buildLegendBlocks(sources({ quakeIntensity: true }))
      if (block.swatch.kind !== 'scale') throw new Error('scale ではない')
      const seven = block.swatch.cells.find((c) => c.label === '7')
      expect(seven?.color).toBe(INTENSITY_COLORS[70])
    })

    it('同じ配色を使う描画物が複数あってもブロックは 1 つで、見出しに用途を並べる', () => {
      const blocks = buildLegendBlocks(sources({ realtimeIntensity: true, eewIntensity: true }))
      const intensity = blocks.filter((b) => b.key === 'intensity')
      expect(intensity).toHaveLength(1)
      expect(intensity[0].title).toBe('リアルタイム震度・緊急地震速報の予想')
    })

    it('緊急地震速報の予想だけでも震度のスケールを出す', () => {
      const [block] = buildLegendBlocks(sources({ eewIntensity: true }))
      expect(block.key).toBe('intensity')
      expect(block.title).toBe('緊急地震速報の予想')
    })
  })

  describe('いま描いているものだけを並べる', () => {
    it('津波の海岸線は地図モードに関わらず、線が出ていれば並ぶ', () => {
      // 震源カタログを見ている最中でも、津波が発表されていれば海岸線は描かれる。
      const blocks = buildLegendBlocks(sources({ catalogColorBy: 'depth', tsunamiGrade: true }))
      expect(blocks.map((b) => b.key)).toEqual(['tsunamiGrade', 'catalog'])
    })

    it('活断層とプレート境界は描いているものだけを出す', () => {
      const [block] = buildLegendBlocks(sources({ activeFaults: true }))
      if (block.swatch.kind !== 'chips') throw new Error('chips ではない')
      expect(block.swatch.chips.map((c) => c.label)).toEqual(['活断層'])
    })

    it('プレート境界は沈み込み帯とその他を別の色として出す', () => {
      const [block] = buildLegendBlocks(sources({ plateBoundaries: true }))
      if (block.swatch.kind !== 'chips') throw new Error('chips ではない')
      expect(block.swatch.chips).toHaveLength(2)
      expect(block.swatch.chips[0].color).not.toBe(block.swatch.chips[1].color)
    })

    it('潮位観測点は到達確認と欠測をそれぞれ出ているぶんだけ並べる', () => {
      const [block] = buildLegendBlocks(sources({ tsunamiMissing: true }))
      if (block.swatch.kind !== 'chips') throw new Error('chips ではない')
      expect(block.swatch.chips.map((c) => c.label)).toEqual(['欠測'])
    })
  })

  describe('震源カタログ', () => {
    it('深さの目盛りは色と同じ平方根の位置に置く', () => {
      const [block] = buildLegendBlocks(sources({ catalogColorBy: 'depth' }))
      if (block.swatch.kind !== 'ramp') throw new Error('ramp ではない')
      const tick30 = block.swatch.ticks.find((t) => t.label === '30')
      // 等間隔（30/750 = 0.04）ではなく平方根の位置（0.2）に乗る。
      expect(tick30?.at).toBeCloseTo(depthRampT(30), 6)
      expect(tick30?.at).toBeCloseTo(0.2, 6)
    })

    it('発生年の両端が同じ年なら目盛りを 1 つだけ出す', () => {
      const lo = jstYearStartMs(2024) + 1000
      const hi = jstYearStartMs(2024) + 86_400_000
      const [block] = buildLegendBlocks(sources({ catalogColorBy: 'time', catalogYearRange: { lo, hi } }))
      if (block.swatch.kind !== 'ramp') throw new Error('ramp ではない')
      expect(block.swatch.ticks).toEqual([{ at: 0, label: '2024' }])
    })

    it('発生年の両端が判らなければ色帯だけを出す', () => {
      const [block] = buildLegendBlocks(sources({ catalogColorBy: 'time', catalogYearRange: null }))
      if (block.swatch.kind !== 'ramp') throw new Error('ramp ではない')
      expect(block.swatch.ticks).toEqual([])
      expect(block.swatch.stops.length).toBeGreaterThan(0)
    })

    it('色分けを切り替えると中身が入れ替わる', () => {
      const [depth] = buildLegendBlocks(sources({ catalogColorBy: 'depth' }))
      const [magnitude] = buildLegendBlocks(sources({ catalogColorBy: 'magnitude' }))
      expect(depth.title).toBe('震源の深さ')
      expect(magnitude.title).toBe('マグニチュード')
      expect(depth.swatch).not.toEqual(magnitude.swatch)
    })
  })

  describe('観測した津波の高さ', () => {
    it('観測棒を描いているときだけ出し、段と色は描画側と同じ表から採る', () => {
      const [block] = buildLegendBlocks(sources({ tsunamiObsHeight: true }))
      expect(block.key).toBe('tsunamiObsHeight')
      if (block.swatch.kind !== 'chips') throw new Error('chips ではない')
      expect(block.swatch.chips).toEqual(
        TSUNAMI_OBS_HEIGHT_STEPS.map((s) => ({ label: s.label, color: s.color, shape: 'bar' })),
      )
      // 実際に棒へ塗る色と一致すること（表を読み替えていない）。
      expect(tsunamiObsBarColor(5)).toBe(block.swatch.chips[0].color)
      expect(tsunamiObsBarColor(0.1)).toBe(block.swatch.chips[3].color)
    })

    it('等級とは別のブロックにする（同じ色が別の意味で並ぶため）', () => {
      const blocks = buildLegendBlocks(sources({ tsunamiGrade: true, tsunamiObsHeight: true }))
      expect(blocks.map((b) => b.key)).toEqual(['tsunamiGrade', 'tsunamiObsHeight'])
      // 1m 以上の観測波高は津波警報の海岸線と同じ色。形で見分ける。
      const grade = blocks[0].swatch
      const obs = blocks[1].swatch
      if (grade.kind !== 'chips' || obs.kind !== 'chips') throw new Error('chips ではない')
      const shared = obs.chips.find((c) => grade.chips.some((g) => g.color === c.color))
      expect(shared).toBeDefined()
      expect(shared?.shape).toBe('bar')
    })
  })

  it('津波の等級は電文の配色をそのまま使う', () => {
    const [block] = buildLegendBlocks(sources({ tsunamiGrade: true }))
    if (block.swatch.kind !== 'chips') throw new Error('chips ではない')
    expect(block.swatch.chips[0]).toEqual({
      label: TSUNAMI_STYLE.MajorWarning.label,
      color: TSUNAMI_STYLE.MajorWarning.color,
      shape: 'line',
    })
    // 等級を語れない電文のための `Unknown` は海岸線の等級ではないので並べない。
    expect(block.swatch.chips.map((c) => c.label)).not.toContain(TSUNAMI_STYLE.Unknown.label + '（不明）')
    expect(block.swatch.chips).toHaveLength(4)
  })
})

/**
 * 各フィールドを単独で立てたときの値。**`MapLegendSources` の全キーを並べる**（Mapped type なので
 * キーを足したらここが型検査で落ちる）。
 *
 * 地図に描く層を足したのに凡例へ出し忘れる、という抜けを止めるための表。値が `null` のキーは
 * 「単独ではブロックを生まないのが正しい」もので、理由を添える。
 */
const SOLO_SOURCES: { [K in keyof MapLegendSources]: Partial<MapLegendSources> | null } = {
  quakeIntensity: { quakeIntensity: true },
  realtimeIntensity: { realtimeIntensity: true },
  eewIntensity: { eewIntensity: true },
  unreceived: { unreceived: true },
  lpgm: { lpgm: true },
  eewLpgm: { eewLpgm: true },
  psWave: { psWave: true },
  tsunamiGrade: { tsunamiGrade: true },
  tsunamiObsHeight: { tsunamiObsHeight: true },
  tsunamiArrival: { tsunamiArrival: true },
  tsunamiMissing: { tsunamiMissing: true },
  heatmap: { heatmap: true },
  activeFaults: { activeFaults: true },
  plateBoundaries: { plateBoundaries: true },
  catalogColorBy: { catalogColorBy: 'depth' },
  // 並べ替えの指定で、それ自体はブロックを生まない。
  primary: null,
  // 色を付ける軸（`catalogColorBy`）が無ければ点群を描いていない。目盛りだけでは何も出ない。
  catalogYearRange: null,
}

describe('描いているものを凡例に出し忘れていないか', () => {
  it.each(Object.entries(SOLO_SOURCES).filter(([, patch]) => patch !== null))(
    '%s を単独で立てるとブロックが 1 つ以上できる',
    (_key, patch) => {
      expect(buildLegendBlocks(sources(patch as Partial<MapLegendSources>)).length).toBeGreaterThan(0)
    },
  )

  it('色帯は必ず折れ点を持つ（空だと共有カードの帯が無言で透明になる）', () => {
    const all = buildLegendBlocks(
      sources({ catalogColorBy: 'depth', heatmap: true }),
    ).concat(buildLegendBlocks(sources({ catalogColorBy: 'magnitude' })), buildLegendBlocks(sources({ catalogColorBy: 'time' })))
    const ramps = all.filter((b) => b.swatch.kind === 'ramp')
    expect(ramps.length).toBeGreaterThan(0)
    for (const block of ramps) {
      if (block.swatch.kind !== 'ramp') throw new Error('ramp ではない')
      expect(block.swatch.stops.length).toBeGreaterThan(0)
    }
  })
})

describe('いま見ている画面の主役を先に出す', () => {
  it('主役に挙げた鍵が先頭へ来る（挙げた順に）', () => {
    const blocks = buildLegendBlocks(sources({
      quakeIntensity: true,
      tsunamiGrade: true,
      activeFaults: true,
      catalogColorBy: 'depth',
      primary: ['catalog'],
    }))
    expect(blocks[0].key).toBe('catalog')
  })

  it('主役に挙げていないものも落とさない（後ろへ回るだけ）', () => {
    const blocks = buildLegendBlocks(sources({
      quakeIntensity: true,
      tsunamiGrade: true,
      catalogColorBy: 'depth',
      primary: ['catalog'],
    }))
    expect(blocks.map((b) => b.key)).toEqual(['catalog', 'intensity', 'tsunamiGrade'])
  })

  it('主役どうしの相対順は渡した順を守る', () => {
    const blocks = buildLegendBlocks(sources({
      quakeIntensity: true,
      psWave: true,
      primary: ['psWave', 'intensity'],
    }))
    expect(blocks.map((b) => b.key)).toEqual(['psWave', 'intensity'])
  })

  it('主役以外どうしの相対順は既定の並びを崩さない', () => {
    const blocks = buildLegendBlocks(sources({
      quakeIntensity: true,
      tsunamiGrade: true,
      heatmap: true,
      activeFaults: true,
      catalogColorBy: 'depth',
      primary: ['catalog'],
    }))
    // 既定の並びは「いま起きていること → 背景」。主役を抜いた残りはその順のまま。
    expect(blocks.slice(1).map((b) => b.key)).toEqual(['intensity', 'tsunamiGrade', 'heatmap', 'lines'])
  })

  it('主役を渡さなければ既定の並びのまま', () => {
    const blocks = buildLegendBlocks(sources({ quakeIntensity: true, tsunamiGrade: true, activeFaults: true }))
    expect(blocks.map((b) => b.key)).toEqual(['intensity', 'tsunamiGrade', 'lines'])
  })
})

describe('representativeBlock', () => {
  // **並びの先頭をそのまま採る。** 津波が出ていても、震源カタログを見ているなら深さの帯が残る
  // （見ている画面と、畳んだ凡例が残すものを揃える）。
  it('主役として先頭に来たものを残す', () => {
    const blocks = buildLegendBlocks(sources({
      tsunamiGrade: true,
      catalogColorBy: 'depth',
      primary: ['catalog'],
    }))
    expect(representativeBlock(blocks)?.key).toBe('catalog')
  })

  it('主役の指定が無ければ既定の並びの先頭を採る', () => {
    const blocks = buildLegendBlocks(sources({ quakeIntensity: true, activeFaults: true, heatmap: true }))
    expect(representativeBlock(blocks)?.key).toBe('intensity')
  })

  it('1 つも無ければ null', () => {
    expect(representativeBlock([])).toBeNull()
  })
})
