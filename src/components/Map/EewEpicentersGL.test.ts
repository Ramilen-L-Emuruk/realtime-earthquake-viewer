import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { crossOpacity } from './EewEpicentersGL'

// 仮定震源要素（単独観測点処理）の×印の見え方は、2 ファイルに分かれた値の積で決まる。
//   1. マーカーの不透明度 … EewEpicentersGL.tsx の crossOpacity
//   2. 点滅アニメーションの opacity … src/index.css の @keyframes eew-blink / eew-blink-assumed
// maplibregl.Marker の不透明度と子要素の CSS アニメーションは乗算されるため、片方だけを動かすと
// 「点滅の谷で×印が事実上消える」状態へ静かに戻る（実効 0.02 まで落ちていたのを直した）。
// 型チェックでは捕まらないので、積の下限と確定震源との濃さの関係をここで固定する。

// maplibre-gl の実体は読み込まない（WebGL・Worker 依存。差し替えの前例は CameraFollowsGL.test.ts）。
// ここで呼ぶのは crossOpacity（純関数）だけなので、中身を持たない代替で足りる。
vi.mock('maplibre-gl', () => ({ Marker: class {}, Popup: class {} }))

// パスはプロジェクトルート基準（既存の stationCoords.test.ts と同じ作法）。
// コメントは先に落とす。中に `@keyframes eew-blink` のような文言が書かれると、
// そこを起点に後続の別ルールの `{` を拾ってしまう。
const css = readFileSync('src/index.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** @keyframes ブロックを丸ごと取り出す（入れ子の {} を数える）。 */
function keyframeBlock(source: string, name: string): string {
  const needle = `@keyframes ${name}`
  // 名前の直後が識別子の続きなら別のアニメーション。`eew-blink` の検索は
  // `eew-blink-assumed` にも当たるので、境界を見ないと記述順次第で取り違える。
  const isBoundary = (c: string | undefined) => c === undefined || c === ' ' || c === '{' || c === '\n'
  for (let from = 0; ; ) {
    const at = source.indexOf(needle, from)
    if (at < 0) return ''
    if (isBoundary(source[at + needle.length])) {
      let depth = 0
      for (let i = source.indexOf('{', at); i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1)
      }
      return ''
    }
    from = at + needle.length
  }
}

function opacitiesOf(source: string, name: string): number[] {
  return [...keyframeBlock(source, name).matchAll(/opacity:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
}

const ASSUMED = opacitiesOf(css, 'eew-blink-assumed')
const CONFIRMED = opacitiesOf(css, 'eew-blink')

/**
 * 実効不透明度（マーカー × 点滅）の下限。ブラウザで視認を確かめたのは 0.158（地震モードの谷）で、
 * 0.1 はそれより保守的に置いた歯止め。直した不具合（実効 0.02〜0.035）への回帰は止まるが、
 * 0.1〜0.158 の帯は「見えるかどうか未検証」のまま通ることに注意。
 */
const VISIBLE_FLOOR = 0.1

describe('EEW 震源×印の不透明度と点滅の組み合わせ', () => {
  // 安全弁: CSS のパースが効いていること。ここが空振りすると以下の検証が
  // 「何も検証していないテスト」に化ける。
  it('index.css から両方の点滅アニメーションの opacity を読める', () => {
    expect(ASSUMED.length).toBeGreaterThanOrEqual(2)
    expect(CONFIRMED.length).toBeGreaterThanOrEqual(2)
    for (const v of [...ASSUMED, ...CONFIRMED]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  // 安全弁: 名前の前方一致で別のブロックを読んでいないこと。`eew-blink` は
  // `eew-blink-assumed` の接頭辞なので、境界を見ない実装だと記述順次第で取り違える。
  // index.css の現在の並び（確定が先）では素朴な検索でも当たってしまうため、
  // **並びを逆にした人工の CSS** で検証する。ここが緩むと、CSS を並べ替えた誰かが
  // 「確定の点滅は 1 ↔ 0.1」を検証しているつもりで仮定側の値を見ることになる。
  it('接頭辞が共通でも別々のブロックを読む（記述順に依存しない）', () => {
    const flipped = [
      '@keyframes eew-blink-assumed {',
      '  0%, 100% { opacity: 0.9; }',
      '  50% { opacity: 0.45; }',
      '}',
      '@keyframes eew-blink {',
      '  0%, 100% { opacity: 1; }',
      '  50% { opacity: 0.1; }',
      '}',
    ].join('\n')
    expect(opacitiesOf(flipped, 'eew-blink')).toEqual([1, 0.1])
    expect(opacitiesOf(flipped, 'eew-blink-assumed')).toEqual([0.9, 0.45])
    // 実ファイル側でも取り違えていないこと。
    expect(keyframeBlock(css, 'eew-blink')).not.toContain('eew-blink-assumed')
    expect(ASSUMED).not.toEqual(CONFIRMED)
  })

  // 正: 直した不具合そのもの。仮定震源の×印は点滅の谷でも見える濃さを保つ。
  it('仮定震源の×印は点滅の谷でも消えない（kyoshin・その他モードの両方）', () => {
    const troughOf = (fullOpacity: boolean) => crossOpacity(true, fullOpacity) * Math.min(...ASSUMED)
    expect(troughOf(true)).toBeGreaterThanOrEqual(VISIBLE_FLOOR)
    expect(troughOf(false)).toBeGreaterThanOrEqual(VISIBLE_FLOOR)
  })

  // 対照: 濃い側では必ず確定震源の方が濃い（仮定を「控えめに見せる」意図の本体）。
  // 谷ではどのモードでも逆転する（確定の方が谷が深いため）。それは意図した引き換えなので、
  // ここで固定するのは濃い側だけ。理由は crossOpacity の説明を参照。
  it('濃い側では仮定が確定より薄い（kyoshin・その他モードの両方）', () => {
    const peak = (isAssumed: boolean, fullOpacity: boolean) =>
      crossOpacity(isAssumed, fullOpacity) * Math.max(...(isAssumed ? ASSUMED : CONFIRMED))
    expect(peak(true, true)).toBeLessThan(peak(false, true))
    expect(peak(true, false)).toBeLessThan(peak(false, false))
  })

  // 安全弁: 仮定を見えるようにするために確定側の点滅（1 ↔ 0.1）を緩めていないこと。
  // ここを触ると「確定は強く明滅する」という区別そのものが失われる。
  it('確定震源の点滅は 1 と 0.1 のまま', () => {
    expect(Math.max(...CONFIRMED)).toBe(1)
    expect(Math.min(...CONFIRMED)).toBe(0.1)
  })

  // 安全弁: 確定震源のマーカー不透明度は倍率・下限の対象外。
  it('確定震源のマーカー不透明度は kyoshin で 1・その他モードで 0.4', () => {
    expect(crossOpacity(false, true)).toBe(1)
    expect(crossOpacity(false, false)).toBe(0.4)
  })
})
