// 塗りつぶしの上に載せる文字色を、背景色から決めるユーティリティ。
//
// 気象庁の震度配色・長周期地震動階級の配色は仕様として定まっているため色そのものは変えられない。
// しかしこのパレットは明度の幅が非常に広く（震度4 の #f5e600 = 黄 〜 震度7 の #9d0099 = 紫）、
// 白・黒どちらか一方に固定すると必ず片側が WCAG AA（通常サイズ 4.5:1）を割る。
//   白固定: 震度4 で 1.30:1・震度5弱 2.04:1・震度1 2.28:1（ほぼ判読不能）
//   黒固定: 震度6強 2.62:1・震度7 2.89:1
// 背景の輝度でコントラストの高い側を選べば、配色を一切変えずに全階級が AA を満たす
// （最小は震度6弱 #f00000 の 4.71:1）。

/** WCAG 2.x の相対輝度。 */
function relativeLuminance(r: number, g: number, b: number): number {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** `#rgb` / `#rrggbb` を 0〜255 の三値へ。解釈できなければ null。 */
function parseHex(hex: string): [number, number, number] | null {
  if (typeof hex !== 'string') return null
  const s = hex.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
  }
  return null
}

/** 2 色の WCAG コントラスト比（1〜21）。解釈できない色があれば null。 */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const a = parseHex(hexA)
  const b = parseHex(hexB)
  if (!a || !b) return null
  const la = relativeLuminance(...a)
  const lb = relativeLuminance(...b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 塗りに載せる文字色の候補。 */
export const TEXT_ON_FILL_LIGHT = '#ffffff'
export const TEXT_ON_FILL_DARK = '#000000'

/**
 * 背景色 `bgHex` の上で読みやすい文字色（白 or 黒）を返す。
 *
 * `rgba()` 等の解釈できない値では白を返す。震度・長周期の配色はすべて `#rrggbb` であり、
 * 解釈できない値が来るのは想定外の経路に限られるため、その場合は従来どおりの見た目に倒す。
 */
export function readableTextColor(bgHex: string): string {
  const rgb = parseHex(bgHex)
  if (!rgb) return TEXT_ON_FILL_LIGHT
  // 明度のしきい値を決め打ちせず、白・黒それぞれとのコントラスト比を実際に比べる。
  // 中間輝度の色（震度6弱 #f00000 は白 4.46 / 黒 4.71）で正しい方を選ぶために必要。
  const l = relativeLuminance(...rgb)
  const withWhite = 1.05 / (l + 0.05)
  const withBlack = (l + 0.05) / 0.05
  return withBlack > withWhite ? TEXT_ON_FILL_DARK : TEXT_ON_FILL_LIGHT
}
