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
import type { TimeTick } from './timeTicks'

/**
 * 3 成分の色。**3 本を互いに見分けられることを最優先に、色相を 120 度ずつ離す**
 * （緑・赤紫・黄）。
 *
 * **淡いパステルで揃えない。** 以前は空・藤・桃（`#7dd3fc` / `#a5b4fc` / `#f0abfc`）
 * だったが、3 本重ねると**どれがどれか分からない**（2026-09-30 のユーザー指摘）。
 *
 * **震度階級の色は避けきれないので、避ける相手を絞る。** 階級色は緑・青・黄・橙・赤・紫を
 * 一通り使っている（`utils/intensity.ts`）ので完全な回避はできない。**同じ枠の中で
 * 隣り合うのは到達の線だけ**なので、そちら（P の水色 `#38bdf8`・S の朱 `#ff3c00`。
 * → `gl/psWaveStyle.ts`）から離れていれば足りる。
 */
export const AXIS_COLORS = ['#4ade80', '#e879f9', '#facc15'] as const

/**
 * 3 成分の名前。**並びはホストが送ってくる `gal` の並び（東・北・上）に合わせる。**
 * ホストは補正の後の波形を共通座標 ENU（X＝東・Y＝北・Z＝上）で出す
 * （`seismo-host/README.md`「共通座標は ENU」）。**こちらで並べ替えない** —— 受け取る口で
 * 入れ替えると、口が増えるたびに入れ替え忘れの経路ができる。
 */
export const AXIS_LABELS = ['東西', '南北', '上下'] as const

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
  /**
   * 縦の表示。**渡さなければ `scaleGal` から作る**（`±N gal`）。強調して描いたときは
   * 縦が 0 からではないので、作った側が文字列まで決める（→ `emphasizeColumns.ts`）。
   */
  readonly scaleLabel?: string
}

/**
 * 絵へ重ねる縦の目盛り（P 波・S 波の到達）。
 *
 * **横位置は時刻ではなく比で渡す。** ここは列しか知らない ——時刻を持ち込むと、
 * 押し出し（直近 60 秒の窓）と読み返し（過去の区間）で別々の時間軸の話が混ざる。
 * 比へ落とすのは呼び出し側の仕事。
 */
export interface WaveMark {
  /** 絵の左端を 0・右端を 1 とした横位置。**範囲の外は描かない。** */
  readonly ratio: number
  readonly label: string
  readonly color: string
  /** 破線にするか（P と S を線の形でも見分けられるように）。 */
  readonly dashed: boolean
}

/** 目盛りの文字の大きさ（CSS ピクセル）。 */
const MARK_FONT_PX = 9

/** 1 枚を描くときの任意の指定。 */
export interface PaintOptions {
  /**
   * 重ねる縦の目盛り。**渡さなければ何も重ねない**（地図の下端の絵は渡さない ——
   * あちらは特定の地震の区間ではなく「いまの 60 秒」なので、引く相手がいない）。
   */
  readonly marks?: readonly WaveMark[]
  /**
   * 描く向き（東西・南北・上下の順）。**渡さなければ 3 本とも描く。**
   *
   * **縦の目盛りは呼び出し側が同じ指定で決める** —— ここで線を間引くだけだと、
   * 大きい成分を消しても振れ幅の分母がそのままで、残りが潰れたままになる。
   */
  readonly visibleAxes?: readonly boolean[]
  /**
   * 時間軸の目盛り（→ `timeTicks.ts`）。**渡せば絵の下に {@link AXIS_BAND_PX} の帯を取って描く**
   * —— 波形に重ねると、いちばん振れる箇所で数字が読めなくなる。
   *
   * **絵の幅（CSS ピクセル）を受け取って目盛りを返す関数で渡す。** 刻みは幅で決まり、
   * 幅を知っているのはここだけ（列数と同じ理由）。
   */
  readonly ticks?: (widthCssPx: number) => readonly TimeTick[]
}

/**
 * 目盛りの帯の高さ（CSS ピクセル）。**描く側は canvas をこの分だけ高くしておく。**
 *
 * 内訳は目盛りの線 {@link TICK_LINE_PX} ＋ 隙間 1px ＋ 文字 {@link TICK_FONT_PX}。**線と文字を縦に離す**
 * —— 文字の高さまで線が伸びていると、左寄せ・右寄せの端の目盛りで線が文字の隣に並び、「′」（分）に
 * 見える（2026-10-05 のユーザー指摘）。
 */
export const AXIS_BAND_PX = 15

/** 目盛りの文字の大きさ（CSS ピクセル）。P/S などの線のラベル（9px）より大きく、読める大きさにする。 */
const TICK_FONT_PX = 11

/** 目盛りの線の長さ（CSS ピクセル）。 */
const TICK_LINE_PX = 3

/** 目盛りの文字の色。**波形の 3 色と P/S の色から離した控えめな白。** */
const TICK_COLOR = 'rgba(255,255,255,0.55)'

/**
 * 1 枚ぶんを描き、縦の振れ幅の表示を返す。**描けなければ `null`。**
 *
 * @param build 列数（実ピクセル）を受け取って列を返す。**canvas の寸法を合わせた後で呼ぶ**
 *   ので、呼び出し側は幅を気にしなくてよい。
 * @param stale 届かなくなっているか。**濃さを落とす** —— 抱えた中身は時間で薄れないので、
 *   このままの濃さで描くと止まった絵が「いま静かに揺れている」ように見え続ける。
 * @param options 重ねる目盛りと、描く向き。省略時は「目盛り無し・3 成分すべて」。
 */
export function paintWaveColumns(
  canvas: HTMLCanvasElement,
  build: (columnCount: number) => PaintableColumns | null,
  stale: boolean,
  options: PaintOptions = {},
): string | null {
  const { marks = [], visibleAxes, ticks: buildTicks } = options
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
  const ticks = buildTicks?.(canvas.clientWidth) ?? []
  // **波形を描く高さ。** 目盛りがあれば下の帯を除く。
  // **目盛りを頼まれたら、本数に関わらず帯を取る。** 幅が一瞬 0 と測られた描画で目盛りが
  // 0 本になったとき帯を消すと、そのフレームだけ波形の縦位置が動く（canvas の高さは帯込みで固定）。
  const axisH = buildTicks !== undefined ? Math.round(AXIS_BAND_PX * dpr) : 0
  const plotH = Math.max(1, h - axisH)
  paintTicks(ctx, ticks, w, plotH, h, dpr)
  const mid = plotH / 2
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

  // **裏付けが 1 本しか無い区間を薄く敷く。** 合成を名乗れない区間（1 台だけの
  // 値）。**警め色は使わない** —— 正常運転でもまとまりの末尾で 1〜3 本欠ける
  // （#374）ので、色で異常を主張すると嘘になる。
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  for (let c = 0; c < columns.length; c += 1) {
    const col = columns[c]
    if (col.hasValue && col.minMembers <= 1) ctx.fillRect(c, 0, 1, plotH)
  }

  // 上下に線の太さぶんの余白を残す（振り切れた線が枠の外へ出ないように）。
  const half = Math.max(1, mid - dpr)
  // **3 本を重ねるので、下の線が透けるだけの薄さにする。** 実機で 0.85 を試したとき、
  // いちばん振幅の大きい上下動（実測で RMS が他の 1.5 倍）が後から描かれて前の 2 本を
  // 塗り潰し、桃色 1 色の絵になった。
  ctx.globalAlpha = stale ? 0.25 : 0.7
  ctx.lineWidth = dpr
  for (let a = 0; a < 3; a += 1) {
    // **消された向きは線も引かない。** 振れ幅の分母は呼び出し側が同じ指定で外している。
    if (visibleAxes !== undefined && visibleAxes[a] === false) continue
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

  paintMarks(ctx, marks, w, plotH, dpr)

  return built.scaleLabel ?? formatScaleGal(scaleGal)
}

/**
 * 時間軸の目盛りを下の帯へ描く。
 *
 * **波形より先に描いてよい**（帯は波形と重ならない）。**値が無くても描く** —— 絵が空でも
 * 時間の長さは読めるほうがよい（呼び出し元は値が無ければ早々に戻るので、その前に置く）。
 */
export function paintTicks(
  ctx: CanvasRenderingContext2D,
  ticks: readonly TimeTick[],
  w: number,
  plotH: number,
  h: number,
  dpr: number,
): void {
  if (ticks.length === 0) return
  const fontPx = Math.round(TICK_FONT_PX * dpr)
  ctx.font = `${fontPx}px ui-monospace, monospace`
  ctx.textBaseline = 'bottom'
  ctx.strokeStyle = TICK_COLOR
  ctx.fillStyle = TICK_COLOR
  ctx.lineWidth = dpr
  for (const tick of ticks) {
    if (!(tick.ratio >= 0 && tick.ratio <= 1)) continue
    // **端の線は内側へ寄せる。** 0 や w ちょうどに引くと半分が切れて見えない。
    const x = Math.min(w - dpr / 2, Math.max(dpr / 2, Math.round(tick.ratio * w) + 0.5))
    ctx.beginPath()
    ctx.moveTo(x, plotH)
    ctx.lineTo(x, plotH + TICK_LINE_PX * dpr)
    ctx.stroke()
    ctx.textAlign = tick.align
    const tx = tick.align === 'left' ? x + dpr : tick.align === 'right' ? x - dpr : x
    ctx.fillText(tick.label, tx, h)
  }
  // **寄せ方を残さない。** 後で描く P/S のラベルは左寄せの前提で位置を計算している。
  ctx.textAlign = 'left'
}

/**
 * 縦の目盛りを波形の上へ重ねる。
 *
 * **波形より後に描く。** 先に描くと 3 本の線に埋もれて、いちばん見たい初動のところで
 * 見えなくなる。
 */
export function paintMarks(
  ctx: CanvasRenderingContext2D,
  marks: readonly WaveMark[],
  w: number,
  h: number,
  dpr: number,
): void {
  if (marks.length === 0) return
  const fontPx = Math.round(MARK_FONT_PX * dpr)
  ctx.font = `${fontPx}px ui-monospace, monospace`
  ctx.textBaseline = 'top'
  for (const mark of marks) {
    // **範囲の外は描かない。** 端へ張り付けると、まだ届いていない時刻の線が右端に
    // 出て「そこで何かが起きた」ように見える。
    if (!(mark.ratio >= 0 && mark.ratio <= 1)) continue
    const x = Math.round(mark.ratio * w) + 0.5
    ctx.strokeStyle = mark.color
    ctx.lineWidth = dpr
    ctx.setLineDash(mark.dashed ? [3 * dpr, 3 * dpr] : [])
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
    // **破線の指定を残さない。** 次に描く相手（同じ文脈で呼ばれる別の目盛り・別の枠）が
    // 意図せず破線になる。
    ctx.setLineDash([])
    // **ラベルは線の左右どちらかへ寄せる。** 右端に近い線で外へはみ出すと読めない。
    const textW = ctx.measureText(mark.label).width
    const left = x + 2 * dpr + textW > w ? x - 2 * dpr - textW : x + 2 * dpr
    ctx.fillStyle = mark.color
    ctx.fillText(mark.label, left, dpr)
  }
}
