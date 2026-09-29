// 列になった波形を Canvas へ描く。**何を描くかは呼び出し側が決める。**
//
// **描画だけをここへ集める。** 波形の出どころは 2 つある ——
// 押し出し（`useSeismoStation` が抱える直近 60 秒）と、
// 読み返し（`GET /waves` が返す過去の区間）。**絵の描き方は同じ**なので、
// 分けて持つと片方だけ直った形（線の切り方・裏付けの敷き方）が生まれる。
//
// **列の作り方だけを差し替える。** 列数は canvas の実ピクセル幅で決まるので、
// 呼び出し側には「列数を受け取って列を返す関数」を渡してもらう。

import { createLogThrottle, log } from '../../utils/logger'
import type { WaveColumn } from './waveColumns'
import { formatScaleGal } from './waveLabels'

/**
 * 3 成分の色。**震度階級の色（黄〜橙〜赤）と混ざらない色相から採る** ——
 * 地図の上に重ねるので、階級色に見える線を引くと別のものと読まれる。
 */
export const AXIS_COLORS = ['#7dd3fc', '#a5b4fc', '#f0abfc'] as const
export const AXIS_LABELS = ['南北', '東西', '上下'] as const

/**
 * 2D コンテキストを取れなかったことの記録を間引く枠。
 *
 * **観測点ごとに分けない。** これはブラウザ側の事情なので、どの観測点で起きても
 * 同じ 1 件。分けると観測点の数だけ同じ行が出る。
 */
const throttledNoContext = createLogThrottle(300_000)

/** 列の束（`buildWaveColumns` と同じ形）。 */
export interface PaintableColumns {
  readonly columns: readonly WaveColumn[]
  readonly scaleGal: number
  readonly hasAnyValue: boolean
}

/**
 * 1 枚ぶんを描き、縦の振れ幅の表示を返す。**描けなければ `null`。**
 *
 * @param build 列数（実ピクセル）を受け取って列を返す。**canvas の寸法を合わせた後で呼ぶ**
 *   ので、呼び出し側は幅を気にしなくてよい。
 * @param stale 届かなくなっているか。**濃さを落とす** —— 抱えた中身は時間で薄れないので、
 *   このままの濃さで描くと止まった絵が「いま静かに揺れている」ように見え続ける。
 */
export function paintWaveColumns(
  canvas: HTMLCanvasElement,
  build: (columnCount: number) => PaintableColumns | null,
  stale: boolean,
): string | null {
  const ctx = canvas.getContext('2d')
  // **取れなかったことは記録へ残す。** 黙って戻ると、画面からは「まだ何も届いて
  // いない」のと区別が付かない —— 描けなかったのか届いていないのかを切り分ける
  // 手掛かりがどこにも残らなくなる。**間引く**（毎フレーム通るため）。
  if (ctx === null) {
    throttledNoContext(() => log.error('[seismo] 波形を描く 2D コンテキストを取れなかった'))
    return null
  }

  // **実ピクセルへ合わせる。** CSS の寸法のまま描くと高 DPI の端末で線がぼける。
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }

  ctx.clearRect(0, 0, w, h)
  const mid = h / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, Math.round(mid) + 0.5)
  ctx.lineTo(w, Math.round(mid) + 0.5)
  ctx.stroke()

  // 1 デバイスピクセルを 1 列にする。
  const built = build(w)
  if (built === null) return null
  const { columns, scaleGal, hasAnyValue } = built
  // **振れ幅が 0 なら描かない。** 下の除算が `Infinity` になり、`lineTo` が
  // 何もしないまま「線が引けていない」だけの絵になる（下限を正の値にしてある
  // ので通常は起きないが、0 を渡された場合に黙って壊れるのを避ける）。
  if (!hasAnyValue || !(scaleGal > 0)) return null

  // **裏付けが 1 本しか無い区間を薄く敷く。** 合成を名乗れない区間（駆動役だけの
  // 値）。**警め色は使わない** —— 正常運転でもまとまりの末尾で 1〜3 本欠ける
  // （#374）ので、色で異常を主張すると嘘になる。
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  for (let c = 0; c < columns.length; c += 1) {
    const col = columns[c]
    if (col.hasValue && col.minMembers <= 1) ctx.fillRect(c, 0, 1, h)
  }

  // 上下に線の太さぶんの余白を残す（振り切れた線が枠の外へ出ないように）。
  const half = Math.max(1, mid - dpr)
  // **3 本を重ねるので、下の線が透けるだけの薄さにする。** 実機で 0.85 を試したとき、
  // いちばん振幅の大きい上下動（実測で RMS が他の 1.5 倍）が後から描かれて前の 2 本を
  // 塗り潰し、桃色 1 色の絵になった。
  ctx.globalAlpha = stale ? 0.25 : 0.7
  ctx.lineWidth = dpr
  for (let a = 0; a < 3; a += 1) {
    ctx.strokeStyle = AXIS_COLORS[a]
    ctx.beginPath()
    let started = false
    for (let c = 0; c < columns.length; c += 1) {
      const col = columns[c]
      // **値の無い列で線を切る。** `NaN` をそのまま渡しても Canvas 2D の `lineTo` は
      // 何もしない（no-op）ので、前後の有効な点が 1 本に結ばれてしまう ——
      // つまり欠測を分けて持った意味が描画で消える。
      if (!col.hasValue) {
        started = false
        continue
      }
      const x = c + 0.5
      const top = mid - (col.max[a] / scaleGal) * half
      const bottom = mid - (col.min[a] / scaleGal) * half
      if (started) {
        ctx.lineTo(x, top)
      } else {
        ctx.moveTo(x, top)
        started = true
      }
      ctx.lineTo(x, bottom)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  return formatScaleGal(scaleGal)
}
