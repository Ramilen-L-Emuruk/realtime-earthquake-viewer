import { describe, it, expect } from 'vitest'
import { crossOpacity, crossShape, EEW_BLINK, buildEpicenterPoints, buildPopupHtml } from './EewEpicentersGL'
import { alphaPair, blinkPhaseAt, BLINK_PERIOD_MS } from './gl/depthPointLayer'
import type { EewEpicenter } from '../../hooks/useEewLayerData'

// 震源の×印の見分けは**形**で付ける（2026-10-15 ユーザー承認）。
//   - 仮定震源要素・「非常に強い揺れを検知」の報 … × ＋外周の輪（crossRing）
//   - 深さだけが判らない報（-1）               … 途切れた ×（crossBroken）
//   - それ以外（深さ 0 の「ごく浅い」を含む）    … 普通の ×
// かつては不透明度と点滅の振幅で区別していたが、点滅の谷で仮定の方が濃く見える逆転があったため
// 濃さは全震源で揃えた。**濃さで区別し直すと逆転が戻る**ので、揃っていることもここで固定する。
describe('EEW 震源×印の形（crossShape）', () => {
  // 正: 位置そのものが仮の震源は輪つき。
  it('仮定震源要素は × ＋外周の輪', () => {
    expect(crossShape(epicenter({ isAssumed: true }))).toBe('crossRing')
  })
  it('「非常に強い揺れを検知」の報も × ＋外周の輪', () => {
    expect(crossShape(epicenter({ isAssumed: true, strongShakingOnly: true, depth: 10 }))).toBe('crossRing')
  })
  // 正: 深さだけが判らない報は途切れた ×。
  it('深さが判らない報（-1）は途切れた ×', () => {
    expect(crossShape(epicenter({ depth: -1 }))).toBe('crossBroken')
  })

  // 対照: 深さ 0 は「ごく浅い」という有効値。不明と同じ形にしない。
  it('深さ 0（ごく浅い）は普通の ×', () => {
    expect(crossShape(epicenter({ depth: 0 }))).toBe('cross')
  })
  it('深さの読める確定震源は普通の ×', () => {
    expect(crossShape(epicenter({ depth: 30 }))).toBe('cross')
  })

  // 安全弁: 仮定震源要素の深さが読めなくても、輪を優先する（位置まで仮であることの方が重い）。
  it('仮定震源要素で深さも判らないときは輪を優先する', () => {
    expect(crossShape(epicenter({ isAssumed: true, depth: -1 }))).toBe('crossRing')
  })

  it('点の並びの×へ形が載る', () => {
    const { points } = buildEpicenterPoints(
      [epicenter({ id: 'a', isAssumed: true }), epicenter({ id: 'b', depth: -1 }), epicenter({ id: 'c' })],
      1,
      true,
    )
    expect(points.filter((p) => p.stem).map((p) => p.shape)).toEqual(['crossRing', 'crossBroken', 'cross'])
  })
})

describe('EEW 震源×印の濃さと点滅', () => {
  // 安全弁: 仮定と確定で濃さ・点滅が同じ（区別を濃さへ戻すと谷での逆転が戻る）。
  it('仮定震源と確定震源で不透明度と点滅が揃っている', () => {
    for (const fullOpacity of [true, false]) {
      const [assumed, confirmed] = [true, false].map((isAssumed) =>
        buildEpicenterPoints([epicenter({ isAssumed })], 1, fullOpacity).points[1],
      )
      expect(alphaPair(assumed)).toEqual(alphaPair(confirmed))
    }
  })

  // 安全弁: 確定震源の点滅（1 ↔ 0.1）と不透明度は変えていない。
  it('点滅は 1 と 0.1・不透明度は kyoshin で 1・その他モードで 0.4', () => {
    expect(EEW_BLINK).toEqual({ high: 1, low: 0.1 })
    expect(crossOpacity(true)).toBe(1)
    expect(crossOpacity(false)).toBe(0.4)
  })
})

// 続報は 1 秒前後で届き、点滅の周期（1.2 秒）より短い。**位相を電文の到着で作り直すと、
// 濃い側に留まったまま＝点滅が止まって見える。** 位相は全点で共通の時計だけから決まり、
// 点の入れ替え（setPoints）とは無関係であることを固定する。
describe('blinkPhaseAt: 位相は時計だけで決まる', () => {
  it('周期の前半が明、後半が暗', () => {
    expect(blinkPhaseAt(0)).toBe(1)
    expect(blinkPhaseAt(BLINK_PERIOD_MS / 2 - 1)).toBe(1)
    expect(blinkPhaseAt(BLINK_PERIOD_MS / 2)).toBe(0)
    expect(blinkPhaseAt(BLINK_PERIOD_MS - 1)).toBe(0)
  })

  it('周期をまたいでも同じ位相に戻る（続報のたびに頭から始まらない）', () => {
    for (const t of [0, 137, 599, 600, 1000]) {
      expect(blinkPhaseAt(t + BLINK_PERIOD_MS * 5)).toBe(blinkPhaseAt(t))
    }
  })
})

function epicenter(over: Partial<EewEpicenter> = {}): EewEpicenter {
  return {
    id: 'e1',
    name: '日向灘',
    position: [32.0, 132.0],
    depth: 30,
    magnitude: 6.5,
    maxScale: 50,
    maxScaleOrAbove: false,
    severity: 'Warning',
    serial: '2',
    isFinal: true,
    isAssumed: false,
    ...over,
  } as EewEpicenter
}

describe('buildEpicenterPoints', () => {
  it('震源 1 つにつき震央（地表）と震源（地下）の 2 点を出す', () => {
    const { points, owners } = buildEpicenterPoints([epicenter()], 1, true)
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({ depthKm: 0, shape: 'circle', auxiliary: true })
    expect(points[1]).toMatchObject({ depthKm: 30, shape: 'cross', stem: true })
    // クリックの引き当てに使うので、点と表の並びは一致していなければならない。
    expect(owners).toHaveLength(2)
    expect(owners[0]).toBe(owners[1])
  })

  // 正: 深さを持つ震源は地下へ置かれる（地震情報の震源と同じ扱い）。
  it('確定震源は電文の深さへ置く', () => {
    const { points } = buildEpicenterPoints([epicenter({ depth: 80 })], 1, true)
    expect(points[1].depthKm).toBe(80)
  })

  // 安全弁: 仮定震源要素は M・深さを画面から隠す。地図でも深さを採らない
  // （採ると、確定していない数値を立体で断定して見せることになる）。
  it('仮定震源要素は深さを採らず地表に置く', () => {
    const { points } = buildEpicenterPoints([epicenter({ isAssumed: true, depth: 80 })], 1, true)
    expect(points[1].depthKm).toBe(0)
  })

  it('深さが無い電文は地表に置く（対照）', () => {
    const { points } = buildEpicenterPoints([epicenter({ depth: null as unknown as number })], 1, true)
    expect(points[1].depthKm).toBe(0)
  })

  // 正: **深さが判らない報のセンチネルは `-1`**（`0` は「ごく浅い」という有効値）。
  // `?? 0` は null/undefined にしか効かないので素通りし、`elevationMetersFromDepthKm(-1)` が
  // 標高 **+1000m** を返して×印が地表より 1km 上へ浮いていた。
  //
  // **上の `depth: null` のテストでは守れない** —— あちらは旧実装（`ep.depth ?? 0`）でも
  // 通るので、実運用で届く値（`-1`）を別に固定する。
  it('深さが判らない報（-1）も地表に置く', () => {
    const { points } = buildEpicenterPoints([epicenter({ depth: -1 })], 1, true)
    expect(points[1].depthKm).toBe(0)
  })

  // 対照: 深さ 0 は「ごく浅い」という有効値で、判らない場合と同じ扱いでよい（どちらも地表）。
  // **深さが読める報は従来どおりその値へ置く**（安全弁）。
  it('深さが読める報は従来どおりその深さへ置く（安全弁）', () => {
    const { points } = buildEpicenterPoints([epicenter({ depth: 80 })], 1, true)
    expect(points[1].depthKm).toBe(80)
  })

  it('複数の震源をすべて出す', () => {
    const eps = [epicenter({ id: 'a' }), epicenter({ id: 'b' })]
    const { points, owners } = buildEpicenterPoints(eps, 1, true)
    expect(points).toHaveLength(4)
    expect(owners.map((o) => o.id)).toEqual(['a', 'a', 'b', 'b'])
  })

  // 震央の印と震源の×は同じ明滅・同じ不透明度で動く。別々だと繋がって見えない。
  it('震央と震源は同じ不透明度・同じ点滅', () => {
    const { points } = buildEpicenterPoints([epicenter({ isAssumed: true })], 1, false)
    expect(points[0].alpha).toBe(points[1].alpha)
    expect(points[0].blink).toEqual(points[1].blink)
    expect(points[0].alpha).toBe(crossOpacity(false))
  })

  it('アイコン倍率が大きさに掛かる', () => {
    const { points } = buildEpicenterPoints([epicenter()], 2, true)
    expect(points[1].sizePx).toBe(64)
    expect(points[0].sizePx).toBe(24)
  })
})

// 震源ポップアップの文言。**仮定震源要素では地名まで仮の値**で、電文の震央地名は「PLUM 法で
// 最初にトリガーした観測点の所在地」であって震源の推定位置ではない（docs/spec/eew-spec.md §5）。
// カード側の「（震源未確定）」だけでは「この地名がおおよその震源」と読めるため、行数に余裕のある
// ポップアップでは但し書きまで出す。
const makeEp = (over: Partial<EewEpicenter> = {}): EewEpicenter => ({
  id: 'e1',
  position: [32.0, 132.0],
  isAssumed: false,
  name: '日向灘',
  magnitude: 6.5,
  depth: 30,
  serial: '1',
  severity: 'Forecast',
  maxScale: 40,
  maxScaleOrAbove: false,
  isFinal: false,
  ...over,
})

describe('EEW 震源ポップアップの文言', () => {
  // 正: 仮定震源要素では、震源が未確定であることと、地名が観測点の位置であることの両方を書く。
  it('仮定震源要素では震源未確定と地名の但し書きを出し、M・深さを伏せる', () => {
    const html = buildPopupHtml(makeEp({ isAssumed: true }))
    expect(html).toContain('仮定震源要素（震源未確定）')
    expect(html).toContain('地名は最初に揺れを検知した観測点の位置です')
    expect(html).toContain('震源調査中')
    expect(html).not.toContain('6.5')
  })

  // 「非常に強い揺れを検知」の報は仮定震源要素ではないので語を分ける。地名が観測点の位置である
  // ことは同じなので但し書きは残す（2026-10-15 ユーザー承認の文面）。
  it('強い揺れ検知の報では、その語と地名の但し書きを出し、仮定震源要素とは名乗らない', () => {
    const html = buildPopupHtml(makeEp({ isAssumed: true, strongShakingOnly: true, magnitude: NaN, depth: 10 }))
    expect(html).toContain('非常に強い揺れを検知（震源未確定）')
    expect(html).toContain('地名は揺れを検知した観測点の位置です')
    expect(html).not.toContain('仮定震源要素')
    expect(html).toContain('震源調査中')
    expect(html).not.toContain('NaN')
  })

  // 対照: 確定震源では但し書きを出さない（出すと確定した震源まで疑わせる）。
  it('確定震源では但し書きを出さず M・深さを見せる', () => {
    const html = buildPopupHtml(makeEp())
    expect(html).not.toContain('震源未確定')
    expect(html).not.toContain('観測点の位置')
    expect(html).toContain('深さ')
  })

  // 安全弁: 震源名は電文由来の文字列なのでエスケープを通す（但し書きの追加で経路を変えていない）。
  it('震源名はエスケープされる', () => {
    const html = buildPopupHtml(makeEp({ name: '<script>x</script>' }))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
