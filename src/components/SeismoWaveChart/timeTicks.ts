// 波形の時間軸の目盛りを組み立てる。**描くのは `paintWave.ts`。**
//
// 目盛りの数字はどの絵でも「0 からの秒」（`+10s`・`-30s`）にそろえ、**0 にだけ名前を付ける**。
//
// - 地震カード（秒まで取れた）: 0 は「発生」
// - 地震カード（分までしか無い）: 0 は地震情報の時刻の分の頭（`13:26:00`）。発生を名乗らない
// - 地図の下の波形: 0 は右端の「いま」（`0s`）
//
// **時刻を目盛りごとに並べない**（2026-10-04 のユーザー判断「時刻だとごちゃごちゃしませんかね」）。
// 時刻は 0 に 1 回だけ書けば、どこから数えた秒かが分かる。

/** 絵の上での目盛り 1 本。 */
export interface TimeTick {
  /** 左端 0・右端 1 の横位置。 */
  readonly ratio: number
  readonly label: string
  /**
   * 文字の寄せ方。**端の目盛りは内側へ寄せる** —— 中央寄せのままだと半分が絵の外へ出て読めない。
   */
  readonly align: 'left' | 'center' | 'right'
}

/**
 * 目盛りの刻み（秒）の候補。**文字が重ならない最小のものを選ぶ。**
 *
 * **1 秒より短い刻みも持つ。** 詳細の窓は 2 秒まで寄せられるので、5 秒からだと目盛りが 1 本も入らない。
 * カードと地図の下の絵は幅に対して窓が長いので、短い候補は選ばれない（間隔が足りない）。
 */
const STEP_CANDIDATES_SEC = [0.5, 1, 2, 5, 10, 20, 30, 60, 120] as const

/**
 * 目盛りどうしの最小の間隔（CSS ピクセル）。いちばん長い `+28.5s` の幅（11px の等幅で約 40px）に
 * 余白を足したもの。
 */
const MIN_GAP_PX = 56

/**
 * 0 の名前と隣の目盛りの間に取る余白（CSS ピクセル）。隣の数字の半幅（`+10s` で約 15px）に隙間を足したもの。
 *
 * **落とす境は 0 の名前の幅から決める**（{@link zeroClearancePx}）。`発生` は短く `13:26:00` は長いので、
 * 1 つの値で決めると、短い名前のときに落とさなくてよい隣まで落とす。
 */
const EDGE_GAP_PX = 28

/** 目盛りの文字 1 字の幅の見積もり（CSS ピクセル。11px の等幅で半角 0.6em・全角 1em）。 */
function labelWidthPx(label: string): number {
  let w = 0
  for (const ch of label) w += ch.charCodeAt(0) > 0xff ? 11 : 6.6
  return w
}

/** 0 の名前の隣を落とす境（CSS ピクセル）。0 は端へ寄せて描くので、名前の幅＋余白。 */
function zeroClearancePx(zeroLabel: string): number {
  return labelWidthPx(zeroLabel) + EDGE_GAP_PX
}

/**
 * 端へ寄せる目盛りの範囲（CSS ピクセル）。**比ではなく距離で判定する。**
 *
 * 地震カードの左端は列の幅（実測 225 ms）に丸めて切るので、0 は左端からわずかに内側へずれる。
 * 比の閾値（例: 0.1%）で判定すると、窓が短いほどこのずれが閾値を超えて中央寄せになり、
 * **0 の名前の左半分が絵の外へ切れる**。中央寄せにして欠けるのは、端からラベルの半分の幅より
 * 近いときなので、それより広く取る。
 */
const EDGE_ALIGN_PX = 30

/**
 * 目盛りを組み立てる。
 *
 * @param fromMs 絵の左端の時刻
 * @param toMs 絵の右端の時刻
 * @param zeroMs 時間軸の 0（目盛りはここから数える。絵の端に無くてもよい）
 * @param zeroLabel 0 に書く名前
 * @param widthPx 絵の幅（CSS ピクセル）。**刻みを決めるのに要る**
 */
export function buildTimeTicks(params: {
  readonly fromMs: number
  readonly toMs: number
  readonly zeroMs: number
  readonly zeroLabel: string
  readonly widthPx: number
}): TimeTick[] {
  const { fromMs, toMs, zeroMs, zeroLabel, widthPx } = params
  const spanMs = toMs - fromMs
  if (!(spanMs > 0) || !(widthPx > 0) || !Number.isFinite(zeroMs)) return []
  const pxPerSec = (widthPx * 1000) / spanMs
  const stepSec = STEP_CANDIDATES_SEC.find((s) => s * pxPerSec >= MIN_GAP_PX)
  if (stepSec === undefined) return []

  const ticks: TimeTick[] = []
  const firstK = Math.ceil((fromMs - zeroMs) / (stepSec * 1000))
  const lastK = Math.floor((toMs - zeroMs) / (stepSec * 1000))
  for (let k = firstK; k <= lastK; k += 1) {
    // **小数の刻みは丸めてから使う**（0.5 の倍数は誤差なく表せるが、ラベルの桁を揃えるため）。
    const sec = Math.round(k * stepSec * 10) / 10
    const ratio = (zeroMs + sec * 1000 - fromMs) / spanMs
    const label = sec === 0 ? zeroLabel : sec > 0 ? `+${sec}s` : `${sec}s`
    const px = ratio * widthPx
    const align = px <= EDGE_ALIGN_PX ? 'left' : px >= widthPx - EDGE_ALIGN_PX ? 'right' : 'center'
    ticks.push({ ratio, label, align })
  }

  // **0 の隣は、0 の名前とぶつかるなら落とす。** 0 の名前だけは削らない（どこから数えた秒かが
  // 分からなくなる）。
  const zeroIndex = ticks.findIndex((t) => t.label === zeroLabel)
  if (zeroIndex < 0) return ticks
  const zeroPx = ticks[zeroIndex].ratio * widthPx
  const clearance = zeroClearancePx(zeroLabel)
  return ticks.filter((t, i) => i === zeroIndex || Math.abs(t.ratio * widthPx - zeroPx) >= clearance)
}
