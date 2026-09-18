import { describe, it, expect, vi } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import {
  barMetrics, drawTsunamiObsBars, isDrawableBar, popupOffset,
  BAR_WIDTH, BAR_FOOT, BAR_RING, POPUP_OFFSET_X,
} from './tsunamiObsBar'
import { BADGE_RING } from './tsunamiArrivalMarker'
import { log } from '../../../utils/logger'
import type { TsunamiObsBar } from '../../../hooks/useTsunamiLayerData'

function makeBar(barPx: number): TsunamiObsBar {
  return {
    name: 'テスト観測点',
    lat: 38.3,
    lng: 141.5,
    barPx,
    color: '#ff2222',
    height: { value: 1.2, description: '1.2m' },
    blinking: false,
  }
}

describe('barMetrics', () => {
  it('等倍では基準値と波高由来の高さをそのまま返す', () => {
    expect(barMetrics(makeBar(80), 1)).toMatchObject({ w: BAR_WIDTH, foot: BAR_FOOT, barPx: 80 })
  })

  it('倍率を上げると幅・脚・高さがすべて同じ比で伸びる', () => {
    expect(barMetrics(makeBar(80), 2.5)).toMatchObject({ w: 15, foot: 7.5, barPx: 200 })
  })

  it('倍率を下げても同じ比で縮む（設定の下限 0.5）', () => {
    expect(barMetrics(makeBar(80), 0.5)).toMatchObject({ w: 3, foot: 1.5, barPx: 40 })
  })

  it('設定の上限 3 でも各値が比例する', () => {
    expect(barMetrics(makeBar(10), 3)).toMatchObject({ w: 18, foot: 9, barPx: 30 })
  })

  it('実運用の下限（useTsunamiLayerData が OBS_MIN_PX=8 でクランプした値）でも比例する', () => {
    expect(barMetrics(makeBar(8), 2.5).barPx).toBe(20)
  })

  // barPx=0 は実運用では起きない（生成側が 8px を下限にクランプする）。
  // 純粋関数としての防御的な契約確認として置く。
  it('波高 0 のバーは高さ 0 になる（負値にならない）', () => {
    expect(barMetrics(makeBar(0), 2.5).barPx).toBe(0)
  })

  it('幅と脚は波高に依存しない', () => {
    const low = barMetrics(makeBar(8), 2)
    const high = barMetrics(makeBar(400), 2)
    expect(low.w).toBe(high.w)
    expect(low.foot).toBe(high.foot)
  })
})

// 白フチは「同色の海岸線の上で棒が溶ける」ことへの手当て（理由は tsunamiObsBar.ts の BAR_RING）。
// 芯の面積を減らさないために外側へ引くので、外形と芯の関係をここで固定する。
describe('barMetrics の白フチ', () => {
  it('等倍ではフチが基準値で、外形は芯＋左右のフチになる', () => {
    const m = barMetrics(makeBar(80), 1)
    expect(m.ring).toBe(BAR_RING)
    expect(m.outerW).toBe(BAR_WIDTH + BAR_RING * 2)
    // 高さは上端だけにフチを引く（下端は脚に接するため）。
    expect(m.outerH).toBe(80 + BAR_RING)
  })

  // 設計の要点。ここが一致するので、フチを足しても足元の専有幅が変わらない
  // （到達確認マーカーの直径も同じ 9px で、地図に並ぶ印の足元がそろう）。
  it('等倍では外形の幅が脚の幅と一致する', () => {
    const m = barMetrics(makeBar(80), 1)
    expect(m.outerW).toBe(m.w + m.foot)
  })

  it('倍率を上げてもフチは太らない（枠線は装飾のヘアライン）', () => {
    for (const scale of [1, 1.5, 2, 2.5, 3]) {
      expect(barMetrics(makeBar(80), scale).ring).toBe(BAR_RING)
    }
  })

  it('倍率を下げるとフチは細る（芯の取り分を保つため）', () => {
    expect(barMetrics(makeBar(80), 0.5).ring).toBe(BAR_RING * 0.5)
    expect(barMetrics(makeBar(80), 0.75).ring).toBe(BAR_RING * 0.75)
  })

  // 細らせる目的そのもの。等倍以下では芯が外形の 2/3 を占める
  // （到達確認マーカーが MIN_CORE_RATIO で保っている比と同じ値）。
  it('等倍以下では芯の取り分が外形の 2/3 で一定になる', () => {
    for (const scale of [0.5, 0.75, 1]) {
      const m = barMetrics(makeBar(80), scale)
      expect(m.w / m.outerW).toBeCloseTo(2 / 3)
    }
  })

  // フチを内側へ引くと波高の色の面積が減る（等倍で 6px → 3px）。外側へ引く設計の安全弁。
  it('フチを足しても芯の幅・高さは変わらない', () => {
    for (const scale of [0.5, 1, 2.5]) {
      const m = barMetrics(makeBar(80), scale)
      expect(m.w).toBe(BAR_WIDTH * scale)
      expect(m.barPx).toBe(80 * scale)
    }
  })

  it('到達確認マーカーのフチと同じ太さを使う（地図に並ぶ印の輪郭をそろえる）', () => {
    expect(BADGE_RING).toBe(BAR_RING)
  })
})

// 共有カードの描き直しは外形と芯のパスを自分で組むので、寸法が壊れると「白一色の棒」や
// 「輪郭の無い棒」という**正常な描画に見える別の絵**になる。そこを 1 本まるごと弾く判定。
describe('isDrawableBar', () => {
  it('実運用の寸法（倍率の下限〜上限）では描ける', () => {
    for (const scale of [0.5, 1, 1.75, 3]) {
      // 8px は useTsunamiLayerData が OBS_MIN_PX でクランプした下限、400px が上限。
      for (const barPx of [8, 96, 400]) {
        expect(isDrawableBar(barMetrics(makeBar(barPx), scale))).toBe(true)
      }
    }
  })

  it('芯の高さが残らない寸法では描かない（波高 0 の棒）', () => {
    // barPx 0 だと outerH === ring で、芯を抜くと高さ 0。フチだけの白い破片になる。
    expect(isDrawableBar(barMetrics(makeBar(0), 1))).toBe(false)
  })

  it('芯の幅が残らない寸法では描かない', () => {
    const m = barMetrics(makeBar(80), 1)
    expect(isDrawableBar({ ...m, ring: m.outerW / 2 })).toBe(false)
  })

  it('フチが無い寸法では描かない（輪郭が消えると同色の海岸線に溶ける）', () => {
    const m = barMetrics(makeBar(80), 1)
    expect(isDrawableBar({ ...m, ring: 0 })).toBe(false)
  })

  // 安全弁。`NaN <= 0` は偽なので大小の比較では素通りし、Canvas は非有限値を黙って無視する。
  it('どのフィールドが非有限でも描かない', () => {
    const m = barMetrics(makeBar(80), 1)
    for (const key of ['w', 'foot', 'barPx', 'ring', 'outerW', 'outerH'] as const) {
      expect(isDrawableBar({ ...m, [key]: NaN })).toBe(false)
      expect(isDrawableBar({ ...m, [key]: Infinity })).toBe(false)
    }
  })
})

// `isDrawableBar` を単体で固めるだけでは、**呼び忘れ**を止められない（判定が正しくても
// `drawTsunamiObsBars` が通さなければ意味がない）。共有カードの描き直しが実際に弾くところまで見る。
describe('drawTsunamiObsBars が寸法で弾くこと', () => {
  /**
   * 呼ばれたメソッド名を記録するだけの `ctx`。
   *
   * `hasRoundRect` を false にすると `ctx.roundRect` が `undefined` になり、`addRoundRectPath` の
   * **角丸を持たない環境向けのフォールバック**（`rect` で描く経路）を踏める。既定の true 側だけを
   * 使っていると、`typeof ctx.roundRect === 'function'` が常に真になってそちらは一度も通らない。
   */
  function fakeCtx(hasRoundRect = true): { ctx: CanvasRenderingContext2D; calls: string[] } {
    const calls: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (prop === 'roundRect' && !hasRoundRect) return undefined
        return (...args: unknown[]) => {
          calls.push(String(prop))
          void args
        }
      },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D
    return { ctx, calls }
  }

  // `isOnVisibleSide` は投影して戻す往復で判定するので、渡した座標をそのまま返す地図を置く。
  function fakeMap(): maplibregl.Map {
    return {
      project: () => ({ x: 100, y: 100 }),
      unproject: () => ({ lng: 141.5, lat: 38.3 }),
    } as unknown as maplibregl.Map
  }

  it('実運用の寸法なら塗りが走る', () => {
    const { ctx, calls } = fakeCtx()
    drawTsunamiObsBars(ctx, fakeMap(), 1, [makeBar(96)], 1)
    expect(calls.filter((c) => c === 'fill').length).toBeGreaterThan(0)
    expect(calls).toContain('roundRect')
  })

  // 角丸を持たない環境（`roundRect` が無い）でも、帯と芯は矩形で塗る。角丸は装飾なので諦めてよいが、
  // **棒そのものが消えてはいけない**——この経路は既定の `ctx` では踏めない。
  it('roundRect を持たない環境では矩形で塗る', () => {
    const { ctx, calls } = fakeCtx(false)
    drawTsunamiObsBars(ctx, fakeMap(), 1, [makeBar(96)], 1)
    expect(calls.filter((c) => c === 'fill').length).toBeGreaterThan(0)
    expect(calls).toContain('rect')
    expect(calls).not.toContain('roundRect')
  })

  it('寸法が壊れた棒は 1 つも塗らずに記録を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { ctx, calls } = fakeCtx()
    // 波高 0（芯の高さが残らない）。実運用では起きないが、ここが通ると白い破片が画像に残る。
    drawTsunamiObsBars(ctx, fakeMap(), 1, [makeBar(0)], 1)
    expect(calls.filter((c) => c === 'fill')).toEqual([])
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('寸法が壊れている観測棒'))).toBe(true)
    warn.mockRestore()
  })

  // 安全弁。弾くのは壊れた分だけで、健全な棒を巻き込まない。
  it('壊れた棒が混ざっても健全な棒は描く', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { ctx, calls } = fakeCtx()
    drawTsunamiObsBars(ctx, fakeMap(), 1, [makeBar(0), makeBar(96)], 1)
    expect(calls.filter((c) => c === 'fill').length).toBeGreaterThan(0)
    expect(warn.mock.calls.some(([, detail]) => (detail as { count: number }).count === 1)).toBe(true)
    warn.mockRestore()
  })
})

describe('popupOffset', () => {
  it('縦オフセットはバー高さの半分を上方向（負値）に取る', () => {
    expect(popupOffset(makeBar(80), 1)).toEqual([POPUP_OFFSET_X, -40])
  })

  it('倍率を上げると縦オフセットも同じ比で伸びる', () => {
    expect(popupOffset(makeBar(80), 2.5)).toEqual([POPUP_OFFSET_X, -100])
  })

  it('横オフセットは倍率によらず一定（装飾側の値のため）', () => {
    const scales = [0.5, 1, 2.5, 3]
    expect(scales.map((s) => popupOffset(makeBar(80), s)[0])).toEqual(scales.map(() => POPUP_OFFSET_X))
  })

  it('縦オフセットは barMetrics の高さと整合する', () => {
    const bar = makeBar(123)
    expect(popupOffset(bar, 1.75)[1]).toBe(-barMetrics(bar, 1.75).barPx / 2)
  })

  // 符号（-0 か 0 か）は表示位置に影響しないため問わない。厳密一致で固定すると、
  // 挙動の変わらない式の書き換えでテストだけが落ちる。
  it('波高 0 のバーでは縦オフセットも 0 になる', () => {
    expect(popupOffset(makeBar(0), 2.5)[1]).toBeCloseTo(0)
  })
})
