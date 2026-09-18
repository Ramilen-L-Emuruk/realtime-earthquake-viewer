import type { MapCaptureResult } from '../components/Map/gl/captureMap'
import { log } from './logger'
import { readableTextColor } from './contrast'
import type { LegendBlock, LegendChip } from '../components/MapLegend/legendBlocks'

// 共有カードの合成と書き出し。地図の撮影は components/Map/gl/captureMap.ts の担当で、
// ここは「撮れた地図に見出しと出典を足して 1 枚の画像にする」ところだけを持つ。
//
// 撮影と合成を分けているのは、撮影側に時間の制約があるため（WebGL のフレームバッファは
// `render` の同期実行を抜けると空になる）。合成はいくら時間をかけてもよい処理なので、
// その制約の外に置く。

/**
 * カードの寸法。**見出し・地図・出典を含めた全体**がこの大きさになる。
 *
 * SNS のタイムラインは決まった比率で画像を切り抜く。地図だけを比率に合わせても、上下に足した
 * 見出しと出典のぶん全体の比率がずれ、切り抜きで**その見出しと出典が落ちる**——出典は画像に
 * 焼き込む義務があるので、切られては困る。全体で比率を合わせ、地図を残りへ割り当てる。
 */
export interface ShareCardFormat {
  /** 設定で選ぶときの識別子。 */
  id: string
  /** 利用者に見せる名前。 */
  label: string
  width: number
  height: number
}

/** 選べる寸法。**追加するときは全体の比率で定義すること**（地図の比率ではない）。 */
export const SHARE_CARD_FORMATS: Record<string, ShareCardFormat> = {
  wide16x9: { id: 'wide16x9', label: 'X（16:9）', width: 1600, height: 900 },
}

/** 既定の寸法。X のタイムラインは 16:9 で切り抜く。 */
export const DEFAULT_SHARE_CARD_FORMAT: ShareCardFormat = SHARE_CARD_FORMATS.wide16x9

/** 見出し帯の高さ（論理 px）。 */
const HEADER_HEIGHT = 124
/** 左右の余白（論理 px）。 */
const PADDING_X = 36
/** 出典行の行送りと帯の上下余白（論理 px）。 */
const NOTICE_LINE_HEIGHT = 23
const NOTICE_PADDING_Y = 14

const BACKGROUND = '#0a0c10'
const HEADER_BACKGROUND = '#12161d'
const TEXT_PRIMARY = '#e8edf5'
const TEXT_SECONDARY = '#9aa7b8'
const TEXT_MUTED = '#7c8797'
const DIVIDER = '#232a35'

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif'

/**
 * 出典として挙げうるデータ。**画像に写っているものだけを並べる。**
 *
 * 画像は本文から切り離されて流通するため、帰属表示は画像そのものへ焼く。とくにプレート境界の
 * 出典（PB2002）は Open Data Commons Attribution License で、**成果物を公に利用する際の帰属表示
 * そのものが利用条件**になっている。活断層は政府標準利用規約 2.0、気象庁のデータは公共データ
 * 利用規約（第 1.0 版）で、いずれも出典表示と加工した旨の記載を求める。
 *
 * **地図へ新しいデータのレイヤーを足したら、ここへ出典を足し、載せる条件も見直すこと。**
 * 出典の実体は各ローダーの冒頭コメント（`utils/activeFaults.ts`・`utils/plateBoundaries.ts` など）。
 */
export const ATTRIBUTION_SOURCES = {
  jma: '気象庁',
  /**
   * 海底地形。**配信元のサービスが求める帰属表示をそのまま採る**——ArcGIS Online の
   * サービスメタデータ（`?f=json` の `copyrightText`）は
   * 「General Bathymetric Chart of the Oceans (GEBCO); NOAA National Centers for Environmental
   * Information (NCEI)」と定めており、GEBCO だけでは足りない。
   */
  bathymetry: 'GEBCO・NOAA NCEI（Esri のタイルサービス経由）',
  activeFaults: '産総研 活断層データベース',
  plateBoundaries: 'PB2002 (Bird, 2003)',
} as const

export interface AttributionParts {
  /** 自前のデータへ変換して使っているもの。「加工して作成」が掛かる。 */
  derived: readonly string[]
  /** 配信されるものをそのまま描いているもの。**加工していないので同じ句で括らない。** */
  asIs: readonly string[]
}

/**
 * 出典を 1 行にまとめる。
 *
 * 行を分けて並べると、そのぶん地図に割ける高さが減る（`shareCardMapHeight`）。出典は
 * 読み飛ばされる情報ではないが、地図を潰してまで行を増やす性質のものでもない。
 *
 * **「加工して作成」を全部に掛けない。** 境界線や活断層は元データを GeoJSON へ変換して使う
 * （加工にあたる）が、海底地形は配信されるタイルをそのまま描いている。まとめて括ると、
 * 加工していないものまで加工したと述べることになる。
 */
export function attributionLine({ derived, asIs }: AttributionParts): string {
  const segments: string[] = []
  if (asIs.length > 0) segments.push(asIs.join('、'))
  if (derived.length > 0) segments.push(`${derived.join('、')} を加工して作成`)
  return `出典: ${segments.join('／')}`
}

/**
 * 緊急地震速報を含むカードに足す注意文。
 *
 * 気象庁・DM-D.S.S が利用者へ示すべきとしている注意事項を、画像 1 枚に収まる長さでまとめたもの。
 * **「震源に近い場所では間に合わないことがある」を落とさないこと**——精度の話だけを残すと、
 * 速報が届く前に揺れが来る場合があるという、行動に直結する留保が伝わらない。
 */
export const EEW_NOTICE =
  '緊急地震速報は地震発生直後の推定情報です。誤報や震源・規模・予想震度の誤差を伴うことがあり、震源に近い場所では強い揺れに間に合わないことがあります。'
/**
 * 地図が揃いきる前に撮ったことを示す注記。
 *
 * **出典帯ではなく地図の隅へ重ねる。** 出典の行数は撮影前に確定していないと地図の高さを決め
 * られないが、撮り切れたかどうかは撮影して初めて判る。行を増やす形にすると寸法の計算が
 * 循環する。
 */
const INCOMPLETE_NOTICE = '一部の地図データは読み込み中に撮影されました'

export interface ShareCardHeader {
  /** 見出し（例: 「最大震度 4」）。 */
  title: string
  /** 見出しの色。省略時は既定の文字色。 */
  titleColor?: string
  /** 副見出し（例: 「日向灘 M5.2 深さ 30km」）。 */
  subtitle?: string
  /** 右端に出す時刻など。 */
  meta?: string
}

export interface ShareCardOptions {
  capture: MapCaptureResult
  header: ShareCardHeader
  /** 下端に焼く出典・注意文。行ごとに 1 要素。 */
  notices: string[]
  /** カード全体の寸法。撮影時に渡したものと同じものを渡すこと。 */
  format?: ShareCardFormat
  /**
   * 地図へ重ねる凡例。**画面に出しているものと同じ組を渡すこと**（`buildLegendBlocks` の結果）。
   *
   * DOM の凡例は WebGL のキャンバスに写らないので、ここで 2D で描き直す。空配列なら描かない。
   */
  legend?: LegendBlock[]
}

/** 出典帯の高さ（論理 px）。行が無ければ帯ごと出さない。 */
function noticeAreaHeight(noticeCount: number): number {
  return noticeCount > 0 ? noticeCount * NOTICE_LINE_HEIGHT + NOTICE_PADDING_Y * 2 : 0
}

/**
 * 地図に割り当てられる高さ（論理 px）。
 *
 * **撮影側と合成側の両方がこれを使うこと。** 撮影はこの高さで地図をレンダーし、合成は同じ高さへ
 * 貼る。片方だけ別の計算を持つと、貼るときに引き伸ばされて縮尺が狂う。
 */
export function shareCardMapHeight(format: ShareCardFormat, noticeCount: number): number {
  return format.height - HEADER_HEIGHT - noticeAreaHeight(noticeCount)
}

/**
 * 撮影した地図に見出し帯と出典帯を足して 1 枚の画像にする。
 *
 * 出力の画素数は `format` の寸法に固定する（端末の解像度では変わらない）。撮影がそれより
 * 高精細なら縮小して貼るため、解像度の高い端末では滑らかな画になる。
 */
export async function composeShareCard(opts: ShareCardOptions): Promise<Blob> {
  const { capture, header, notices, format = DEFAULT_SHARE_CARD_FORMAT } = opts
  const s = capture.scale
  const mapHeight = shareCardMapHeight(format, notices.length)
  const capturedWidth = capture.canvas.width / s
  const capturedHeight = capture.canvas.height / s
  // 撮影と合成が別々の寸法を見ていると、貼るときに引き伸ばされて縮尺が狂う。黙って歪ませない。
  //
  // **実際に効くのは高さの検査。** 幅は `capture.scale` が「実ピクセル ÷ 要求した幅」として
  // 定義されるため、割り戻すと常に要求値に一致する。高さだけが `shareCardMapHeight` の計算を
  // 経ており、撮影側と合成側で食い違いうる。
  if (Math.abs(capturedWidth - format.width) > 1 || Math.abs(capturedHeight - mapHeight) > 1) {
    log.warn('[shareCard] 撮影した地図の寸法がカードの割り当てと違います（引き伸ばして貼ります）', {
      captured: [capturedWidth, capturedHeight],
      expected: [format.width, mapHeight],
    })
  }

  // **出力の画素数は寸法に固定する。** 端末の解像度に任せると、同じ操作でもファイルサイズが
  // 数倍に振れ、SNS の上限（X はモバイルで 5MB）を静かに超える。実測では 1600×900 の PNG が
  // 1.4MB で、`devicePixelRatio` 2 の端末ならそのまま 4 倍の画素数になる。
  // 撮影は端末の解像度のまま高精細に行い、ここで縮小して貼る——縮小はスーパーサンプリングとして
  // 働くので、解像度の高い端末ほど滑らかな画になる（精細さは無駄にならない）。
  const out = document.createElement('canvas')
  out.width = format.width
  out.height = format.height
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('共有カードの合成用に 2D コンテキストを取得できませんでした')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, format.width, format.height)

  drawHeader(ctx, header, format.width)
  // 撮影の画素数が出力より大きければ、ここで縮小される（上記の注記）。
  ctx.drawImage(capture.canvas, 0, HEADER_HEIGHT, format.width, mapHeight)
  // 凡例は地図の左下へ重ねる（画面と同じ位置）。撮り切れなかった注記は右下なので衝突しない。
  if (opts.legend && opts.legend.length > 0) {
    drawLegend(ctx, opts.legend, HEADER_HEIGHT + mapHeight)
  }
  if (capture.timedOut) drawIncompleteNotice(ctx, format.width, HEADER_HEIGHT + mapHeight)
  if (notices.length > 0) drawNotices(ctx, notices, format.width, HEADER_HEIGHT + mapHeight)

  return await canvasToPngBlob(out)
}

function drawHeader(ctx: CanvasRenderingContext2D, header: ShareCardHeader, width: number): void {
  ctx.fillStyle = HEADER_BACKGROUND
  ctx.fillRect(0, 0, width, HEADER_HEIGHT)
  ctx.fillStyle = DIVIDER
  ctx.fillRect(0, HEADER_HEIGHT - 1, width, 1)

  // 右端の時刻を先に描いて占有幅を確定させ、見出しの折り返し幅をその手前までに絞る。
  let rightEdge = width - PADDING_X
  if (header.meta) {
    ctx.font = `500 20px ${FONT_STACK}`
    ctx.fillStyle = TEXT_SECONDARY
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(header.meta, width - PADDING_X, 48)
    rightEdge = width - PADDING_X - ctx.measureText(header.meta).width - 28
  }

  ctx.textAlign = 'left'
  ctx.font = `700 48px ${FONT_STACK}`
  ctx.fillStyle = header.titleColor ?? TEXT_PRIMARY
  ctx.fillText(clipText(ctx, header.title, rightEdge - PADDING_X), PADDING_X, 62)

  if (header.subtitle) {
    ctx.font = `400 24px ${FONT_STACK}`
    ctx.fillStyle = TEXT_SECONDARY
    ctx.fillText(clipText(ctx, header.subtitle, width - PADDING_X * 2), PADDING_X, 100)
  }
}

/**
 * 地図へ重ねる凡例（画像版）。
 *
 * **DOM 版（`components/MapLegend`）とは別実装だが、中身は同じ組を使う。** WebGL のキャンバスに
 * DOM は写らないため、同じ `LegendBlock[]` を 2D で描き直している。色と段の定義は
 * `legendBlocks.ts` が単一情報源で、ここへ写さない。
 *
 * **畳んだ状態は反映しない。** 画像は後から開けないので、常に開いた形で焼く。
 */
const LEGEND_PAD = 14
const LEGEND_TITLE_H = 22
const LEGEND_ROW_H = 28
const LEGEND_BLOCK_GAP = 8
const LEGEND_RAMP_W = 270
const LEGEND_RAMP_H = 14
const LEGEND_TICK_H = 20
const LEGEND_CHIP_GAP = 18
const LEGEND_MAX_W = 560
const LEGEND_BG = 'rgba(10,12,16,0.86)'
const LEGEND_BORDER = 'rgba(255,255,255,0.16)'
const LEGEND_TITLE_COLOR = 'rgba(255,255,255,0.55)'

/** 色の升目 1 つの幅。文字の幅に合わせて伸ばす。 */
function legendCellWidth(ctx: CanvasRenderingContext2D, label: string): number {
  ctx.font = `700 16px ${FONT_STACK}`
  return Math.max(22, ctx.measureText(label).width + 12)
}

/** 色見本と名前のあいだ。 */
const LEGEND_CHIP_MARK_GAP = 6

/**
 * 色見本 1 つの寸法。**幅の計測と描画が同じ値を読むために、文字の位置まで一緒に返す。**
 *
 * 形ごとに見本の幅が違う（縦棒は細い）ので、片方だけ直すと予約した幅と文字の位置がずれる。
 * 揃えている相手は画面の凡例（`MapLegend` は見本と文字を `gap` で並べる）で、一律に確保すると
 * 縦棒だけ見本と文字のあいだが広く空いて 1 行の中で不揃いになる。
 */
export function legendChipLayout(shape: LegendChip['shape']): { markWidth: number; labelOffset: number } {
  const markWidth = shape === 'bar' ? 6 : 18
  return { markWidth, labelOffset: markWidth + LEGEND_CHIP_MARK_GAP }
}

/** 色見本と名前の組 1 つの幅（見本＋間隔＋文字）。 */
function legendChipWidth(ctx: CanvasRenderingContext2D, chip: LegendChip): number {
  ctx.font = `500 16px ${FONT_STACK}`
  return legendChipLayout(chip.shape).labelOffset + ctx.measureText(chip.label).width
}

/**
 * 色見本の組を行へ割る。**計測と描画の両方がこれを使う**（別々に数えると背景の高さがずれる）。
 */
function legendChipRows(ctx: CanvasRenderingContext2D, chips: LegendChip[], maxWidth: number): LegendChip[][] {
  const rows: LegendChip[][] = []
  let row: LegendChip[] = []
  let width = 0
  for (const chip of chips) {
    const w = legendChipWidth(ctx, chip)
    if (row.length > 0 && width + LEGEND_CHIP_GAP + w > maxWidth) {
      rows.push(row)
      row = []
      width = 0
    }
    row.push(chip)
    width += (row.length > 1 ? LEGEND_CHIP_GAP : 0) + w
  }
  if (row.length > 0) rows.push(row)
  return rows
}

function legendBlockSize(ctx: CanvasRenderingContext2D, block: LegendBlock, maxWidth: number): { w: number; h: number } {
  ctx.font = `700 15px ${FONT_STACK}`
  const titleW = ctx.measureText(block.title).width
  if (block.swatch.kind === 'scale') {
    const w = block.swatch.cells.reduce((sum, cell) => sum + legendCellWidth(ctx, cell.label), 0)
    return { w: Math.max(titleW, w), h: LEGEND_TITLE_H + LEGEND_ROW_H }
  }
  if (block.swatch.kind === 'chips') {
    const rows = legendChipRows(ctx, block.swatch.chips, maxWidth)
    const w = Math.max(
      ...rows.map((row) => row.reduce((sum, chip, i) => sum + (i > 0 ? LEGEND_CHIP_GAP : 0) + legendChipWidth(ctx, chip), 0)),
    )
    return { w: Math.max(titleW, w), h: LEGEND_TITLE_H + LEGEND_ROW_H * rows.length }
  }
  const tickH = block.swatch.ticks.length > 0 ? LEGEND_TICK_H : 0
  return { w: Math.max(titleW, LEGEND_RAMP_W), h: LEGEND_TITLE_H + LEGEND_RAMP_H + tickH }
}

function drawLegend(ctx: CanvasRenderingContext2D, blocks: LegendBlock[], mapBottom: number): void {
  const inner = LEGEND_MAX_W - LEGEND_PAD * 2
  const sizes = blocks.map((block) => legendBlockSize(ctx, block, inner))
  const contentW = Math.max(...sizes.map((size) => size.w))
  const contentH = sizes.reduce((sum, size, i) => sum + size.h + (i > 0 ? LEGEND_BLOCK_GAP : 0), 0)
  const boxW = Math.min(LEGEND_MAX_W, contentW + LEGEND_PAD * 2)
  const boxH = contentH + LEGEND_PAD * 2
  const left = PADDING_X
  const top = mapBottom - 20 - boxH

  ctx.save()
  ctx.beginPath()
  // 角丸。`roundRect` は実装差があるので使わず、四隅を弧で結ぶ。
  const r = 10
  ctx.moveTo(left + r, top)
  ctx.arcTo(left + boxW, top, left + boxW, top + boxH, r)
  ctx.arcTo(left + boxW, top + boxH, left, top + boxH, r)
  ctx.arcTo(left, top + boxH, left, top, r)
  ctx.arcTo(left, top, left + boxW, top, r)
  ctx.closePath()
  ctx.fillStyle = LEGEND_BG
  ctx.fill()
  ctx.strokeStyle = LEGEND_BORDER
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.clip()

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  let y = top + LEGEND_PAD
  blocks.forEach((block, i) => {
    const size = sizes[i]
    ctx.font = `700 15px ${FONT_STACK}`
    ctx.fillStyle = LEGEND_TITLE_COLOR
    ctx.fillText(clipText(ctx, block.title, boxW - LEGEND_PAD * 2), left + LEGEND_PAD, y + 14)
    const bodyY = y + LEGEND_TITLE_H
    if (block.swatch.kind === 'scale') {
      let x = left + LEGEND_PAD
      for (const cell of block.swatch.cells) {
        const w = legendCellWidth(ctx, cell.label)
        ctx.fillStyle = cell.color
        ctx.fillRect(x, bodyY, w, 22)
        ctx.font = `700 16px ${FONT_STACK}`
        ctx.fillStyle = readableTextColor(cell.color)
        ctx.textAlign = 'center'
        ctx.fillText(cell.label, x + w / 2, bodyY + 17)
        ctx.textAlign = 'left'
        x += w
      }
    } else if (block.swatch.kind === 'chips') {
      const rows = legendChipRows(ctx, block.swatch.chips, boxW - LEGEND_PAD * 2)
      rows.forEach((row, rowIndex) => {
        let x = left + LEGEND_PAD
        const rowY = bodyY + LEGEND_ROW_H * rowIndex
        for (const chip of row) {
          const { markWidth, labelOffset } = legendChipLayout(chip.shape)
          ctx.fillStyle = chip.color
          if (chip.shape === 'line') {
            ctx.fillRect(x, rowY + 9, markWidth, 4)
          } else if (chip.shape === 'bar') {
            // 観測棒は縦長。占める幅も細いので左端から描く。
            ctx.fillRect(x, rowY + 4, markWidth, 16)
          } else {
            ctx.beginPath()
            ctx.arc(x + markWidth / 2, rowY + 11, 8, 0, Math.PI * 2)
            ctx.fill()
            ctx.strokeStyle = 'rgba(255,255,255,0.9)'
            ctx.lineWidth = 1.5
            ctx.stroke()
          }
          ctx.font = `500 16px ${FONT_STACK}`
          ctx.fillStyle = TEXT_PRIMARY
          ctx.fillText(chip.label, x + labelOffset, rowY + 17)
          x += legendChipWidth(ctx, chip) + LEGEND_CHIP_GAP
        }
      })
    } else {
      const gradient = ctx.createLinearGradient(left + LEGEND_PAD, 0, left + LEGEND_PAD + LEGEND_RAMP_W, 0)
      for (const stop of block.swatch.stops) gradient.addColorStop(Math.min(Math.max(stop.at, 0), 1), stop.color)
      ctx.fillStyle = gradient
      ctx.fillRect(left + LEGEND_PAD, bodyY, LEGEND_RAMP_W, LEGEND_RAMP_H)
      ctx.font = `400 13px ${FONT_STACK}`
      ctx.fillStyle = TEXT_MUTED
      for (const tick of block.swatch.ticks) {
        const tx = left + LEGEND_PAD + LEGEND_RAMP_W * Math.min(Math.max(tick.at, 0), 1)
        // 両端は枠の内側へ寄せる（中央揃えのままでは外へはみ出す）。
        ctx.textAlign = tick.at <= 0 ? 'left' : tick.at >= 1 ? 'right' : 'center'
        ctx.fillText(tick.label, tx, bodyY + LEGEND_RAMP_H + 14)
      }
      ctx.textAlign = 'left'
    }
    y += size.h + LEGEND_BLOCK_GAP
  })
  ctx.restore()
}

function drawNotices(ctx: CanvasRenderingContext2D, notices: string[], width: number, top: number): void {
  ctx.fillStyle = DIVIDER
  ctx.fillRect(0, top, width, 1)
  ctx.font = `400 15px ${FONT_STACK}`
  ctx.fillStyle = TEXT_SECONDARY
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  notices.forEach((line, i) => {
    ctx.fillText(
      clipText(ctx, line, width - PADDING_X * 2),
      PADDING_X,
      top + NOTICE_PADDING_Y + NOTICE_LINE_HEIGHT * (i + 1) - 6,
    )
  })
}

/**
 * 地図が揃いきる前に撮ったことを地図の右下へ重ねる。
 *
 * 欠けた画像が「正常に撮れたもの」として共有されるのを防ぐための注記。共有した先からは
 * 取り消せないため、画像そのものに残す。
 */
function drawIncompleteNotice(ctx: CanvasRenderingContext2D, width: number, mapBottom: number): void {
  ctx.font = `400 15px ${FONT_STACK}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  const textWidth = ctx.measureText(INCOMPLETE_NOTICE).width
  const boxRight = width - PADDING_X
  const boxBottom = mapBottom - 14
  ctx.fillStyle = 'rgba(10, 12, 16, 0.72)'
  ctx.fillRect(boxRight - textWidth - 14, boxBottom - 26, textWidth + 20, 30)
  ctx.fillStyle = TEXT_MUTED
  ctx.fillText(INCOMPLETE_NOTICE, boxRight - 4, boxBottom - 6)
}

/**
 * 収まらない文字列を末尾を落として「…」で締める。
 *
 * 出典や注意文が切れると意味が変わるため、**呼び出し側は行が収まる長さで渡すこと**。ここは
 * 想定外に長い震源名などでレイアウトが崩れるのを防ぐ最後の歯止めで、常用する仕組みではない。
 */
function clipText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}…`
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('共有カードの画像を書き出せませんでした'))
    }, 'image/png')
  })
}

/** 共有シートの応答を待つ上限。開いたまま放置されてもボタンが戻るようにする。 */
const SHARE_SHEET_TIMEOUT_MS = 120_000

export type ShareResult = 'shared' | 'downloaded' | 'canceled' | 'timedOut'

/** 共有の結果。本文を渡せたかどうかはボタンの見せ方を変えるため別に持つ。 */
export interface ShareOutcome {
  result: ShareResult
  /** 保存へ落ちたときに、本文をクリップボードへ置けたか。 */
  textCopied: boolean
}

/**
 * 本文へ載せるアプリの URL。
 *
 * **DMDSS 版から共有しても standard 版の URL を載せる。** DMDSS 版は DMDATA.JP の API キーが
 * 要るため、受け取った人がそのまま開くと設定画面に突き当たる。
 */
export function currentAppUrl(): string {
  return standardAppUrl(location.origin, import.meta.env.BASE_URL)
}

/**
 * `currentAppUrl` の中身を環境から切り離したもの（テストのため）。
 *
 * 末尾スラッシュの有無を問わず落とす。`base` の書き方を決めているのは `vite.config.ts` の一存なので、
 * そこが変わったときに本文の URL が黙って DMDSS 版へ戻らないようにしておく。
 */
export function standardAppUrl(origin: string, base: string): string {
  return new URL(base.replace(/dmdss\/?$/, ''), origin).href
}

/**
 * 画像を共有シートへ渡す。使えない環境では保存し、本文はクリップボードへ置く。
 *
 * `navigator.share` の有無だけでは判定できない——ファイルの共有に対応していない実装があるため、
 * `canShare` まで確かめる。共有シートを閉じただけの取り消し（AbortError）は失敗では
 * ないので、ダウンロードへ落とさずそのまま終える。
 *
 * **判定は渡すものをすべて含めて行う。** 画像だけで確かめて本文を後から足すと、本文を受け取れ
 * ない実装で `share()` が投げ、そこから保存へ落ちる遠回りになる。
 *
 * **応答を待つ上限を置く。** 共有シートを開いたまま放置されたり、シートが応答を返さない実装に
 * 当たると、待ち続けている間ボタンが押せないままになる（実際、自動操作の環境では返らない）。
 * 上限に達したらボタンだけ戻す——シートが開いている可能性があるので、保存へは落とさない。
 */
export async function shareOrDownloadImage(blob: Blob, filename: string, text: string): Promise<ShareOutcome> {
  const file = new File([blob], filename, { type: blob.type })
  const data: ShareData = { files: [file], text }
  if (navigator.canShare?.(data)) {
    try {
      const timedOut = Symbol('timedOut')
      const result = await Promise.race([
        navigator.share(data).then(() => 'shared' as const),
        new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), SHARE_SHEET_TIMEOUT_MS)),
      ])
      if (result === timedOut) {
        log.warn('[shareCard] 共有シートの応答が返らないため待つのをやめました')
        return { result: 'timedOut', textCopied: false }
      }
      return { result: 'shared', textCopied: false }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { result: 'canceled', textCopied: false }
      log.warn('[shareCard] 共有に失敗したため保存へ切り替えます', e)
    }
  }
  downloadBlob(blob, filename)
  // 共有シートが無い環境では本文の渡し先が無い。貼り付けられるようクリップボードへ置く。
  return { result: 'downloaded', textCopied: await copyToClipboard(text) }
}

/**
 * 本文をクリップボードへ置く。**置けたかどうかを返す**——置けていないのに「コピーしました」と
 * 見せると、利用者は貼り付け先で初めて気づくことになる。
 *
 * 失敗する理由は 2 つある。API が無い場合（安全な文脈でない配信）と、書き込みが拒否される場合
 * （クリックからの猶予が切れたときを含む。画像の生成に手間取るとここへ来る）。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  // `?.` で呼ぶと、API が無い環境では undefined を await して成功したように見える。先に確かめる。
  if (!navigator.clipboard?.writeText) {
    log.warn('[shareCard] この環境ではクリップボードへ書き込めないため本文を渡せません')
    return false
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    log.warn('[shareCard] 本文をクリップボードへ置けませんでした', e)
    return false
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 直後に解放するとダウンロードが始まらない実装があるため、1 フレーム置いてから解放する。
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}
