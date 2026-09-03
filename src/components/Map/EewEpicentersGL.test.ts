import { describe, it, expect } from 'vitest'
import { crossOpacity, EEW_BLINK, buildEpicenterPoints, buildPopupHtml } from './EewEpicentersGL'
import { alphaPair, blinkPhaseAt, BLINK_PERIOD_MS } from './gl/depthPointLayer'
import type { EewEpicenter } from '../../hooks/useEewLayerData'

// 仮定震源要素（震源未確定）の×印の見え方は、2 つの値の積で決まる。
//   1. 点ごとの不透明度 … crossOpacity
//   2. 点滅の明側・暗側 … EEW_BLINK
// この 2 つは乗算されるため、片方だけを動かすと「点滅の谷で×印が事実上消える」状態へ静かに
// 戻る（実効 0.02 まで落ちていたのを直した）。型チェックでは捕まらないので、積の下限と
// 確定震源との濃さの関係をここで固定する。

/**
 * 「見える」とみなす不透明度の下限。
 *
 * 実測で決めた値ではない。直した不具合の実効値（0.02〜0.035）より十分上で、かつ現行の設計が
 * 満たす値（最小 0.158）より下、という条件で置いた歯止め。0.1〜0.158 の帯は「見えるかどうか
 * 未検証」のまま通ることに注意。
 */
const VISIBLE_FLOOR = 0.1

const trough = (isAssumed: boolean, fullOpacity: boolean) =>
  Math.min(...alphaPair({ alpha: crossOpacity(isAssumed, fullOpacity), blink: blinkFor(isAssumed) }))
const peak = (isAssumed: boolean, fullOpacity: boolean) =>
  Math.max(...alphaPair({ alpha: crossOpacity(isAssumed, fullOpacity), blink: blinkFor(isAssumed) }))
const blinkFor = (isAssumed: boolean) => (isAssumed ? EEW_BLINK.assumed : EEW_BLINK.confirmed)

describe('EEW 震源×印の不透明度と点滅の組み合わせ', () => {
  // 正: 直した不具合そのもの。仮定震源の×印は点滅の谷でも見える濃さを保つ。
  it('仮定震源の×印は点滅の谷でも消えない（kyoshin・その他モードの両方）', () => {
    expect(trough(true, true)).toBeGreaterThanOrEqual(VISIBLE_FLOOR)
    expect(trough(true, false)).toBeGreaterThanOrEqual(VISIBLE_FLOOR)
  })

  // 対照: 濃い側では必ず確定震源の方が濃い（仮定を「控えめに見せる」意図の本体）。
  // 谷ではどのモードでも逆転する（確定の方が谷が深いため）。それは意図した引き換えなので、
  // ここで固定するのは濃い側だけ。理由は crossOpacity の説明を参照。
  it('濃い側では仮定が確定より薄い（kyoshin・その他モードの両方）', () => {
    expect(peak(true, true)).toBeLessThan(peak(false, true))
    expect(peak(true, false)).toBeLessThan(peak(false, false))
  })

  // 安全弁: 仮定を見えるようにするために確定側の点滅（1 ↔ 0.1）を緩めていないこと。
  // ここを触ると「確定は強く明滅する」という区別そのものが失われる。
  it('確定震源の点滅は 1 と 0.1 のまま', () => {
    expect(EEW_BLINK.confirmed).toEqual({ high: 1, low: 0.1 })
  })

  // 安全弁: 確定震源のマーカー不透明度は倍率・下限の対象外。
  it('確定震源の不透明度は kyoshin で 1・その他モードで 0.4', () => {
    expect(crossOpacity(false, true)).toBe(1)
    expect(crossOpacity(false, false)).toBe(0.4)
  })

  // 安全弁: 仮定と確定で点滅の振幅そのものが違うこと（区別の 2 本目の軸）。
  it('仮定の点滅は確定より振幅が浅い', () => {
    const amplitude = (b: { high: number; low: number }) => b.high - b.low
    expect(amplitude(EEW_BLINK.assumed)).toBeLessThan(amplitude(EEW_BLINK.confirmed))
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
    expect(points[0].alpha).toBe(crossOpacity(true, false))
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
