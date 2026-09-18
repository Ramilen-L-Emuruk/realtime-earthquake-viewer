import { memo } from 'react'
import { readableTextColor } from '../../utils/contrast'
import { representativeBlock, type LegendBlock, type LegendChip, type LegendSwatch, type LegendTick } from './legendBlocks'

// 地図へ重ねる凡例。中身を決めるのは legendBlocks.ts で、ここは描くだけ。
//
// **器を中身より大きくしない。** 地図の上に乗るものなので、余白・行間・見出しの行高はどれも
// 詰める。専用の見出し行（「凡例」＋開閉の印）は持たず、**1 つ目のブロックの見出しが開閉を兼ねる**
// ——開いている間その行は情報を持たないのに、高さは中身 1 ブロック分を取っていた。
//
// **畳んでも色見本を残す。** 見出しだけにすると、畳んだ状態が既定になる狭い画面では
// 凡例が一度も役に立たない。残すのは並びの先頭（`representativeBlock`）。
//
// 文字は rem で書く（地図の描画物に掛ける `iconScale` は UI には掛けない決まり）。

/**
 * 寸法の組。**狭い画面ではひと段小さくする**（`compact`）。
 *
 * 幅は変えず（色見本の折り返しが変わると読み方が変わる）、文字と余白だけを詰める。判定は
 * 地図領域の実寸で、畳みの既定と同じ物差しを使う（`autoCollapse.ts`）——狭いから畳む画面では、
 * 開いたときも小さいほうが釣り合う。
 */
interface Metrics {
  /** 見出しの文字。 */
  title: string
  /** 色見本に添える文字。 */
  label: string
  /** 升目 1 つの最小幅と上下の詰め。 */
  cell: string
  /** ブロックのあいだ。 */
  gap: string
  /** 枠の内側。 */
  pad: string
  /** 色見本の図形（線・丸・縦棒）。**文字だけ詰めると図形との釣り合いが崩れる。** */
  mark: { line: string; dot: string; bar: string }
  /**
   * 押せる範囲の張り出し。**見た目の高さは増やさず、当たり判定だけ枠の外へ広げる。**
   *
   * 畳んだ凡例は「開くための入口」で、狭い画面ほど小さくなる——タッチで操作する画面でこそ
   * 的が小さくなる、という逆向きの結果を避ける。ただし**高さで稼ぐと畳んだ意味が薄れる**ので
   * （実測で 19px が 46px まで太った）、透明な疑似要素を上下へ伸ばして指の的だけを確保する。
   * 広げるのは上下 8px 程度で、そのぶん地図のドラッグを奪うが、凡例の縁のごく近くに限る。
   */
  hit: { collapsed: string; heading: string }
}

const REGULAR: Metrics = {
  title: 'text-[0.5625rem] leading-[1.1]',
  label: 'text-[0.625rem] leading-none',
  cell: 'min-w-[0.6rem] px-[0.25rem] py-[0.15rem] text-[0.625rem]',
  gap: 'mt-[0.25rem]',
  pad: 'px-[0.4rem] py-[0.3rem]',
  mark: { line: 'h-[3px] w-[0.75rem]', dot: 'h-[0.6rem] w-[0.6rem]', bar: 'h-[0.7rem] w-[0.25rem]' },
  hit: {
    collapsed: "relative after:absolute after:inset-x-0 after:-inset-y-[0.4rem] after:content-['']",
    heading: "relative after:absolute after:inset-x-0 after:-inset-y-[0.25rem] after:content-['']",
  },
}

const COMPACT: Metrics = {
  title: 'text-[0.5rem] leading-[1.1]',
  label: 'text-[0.5625rem] leading-none',
  cell: 'min-w-[0.55rem] px-[0.2rem] py-[0.1rem] text-[0.5625rem]',
  gap: 'mt-[0.2rem]',
  pad: 'px-[0.35rem] py-[0.25rem]',
  mark: { line: 'h-[2px] w-[0.65rem]', dot: 'h-[0.5rem] w-[0.5rem]', bar: 'h-[0.6rem] w-[0.2rem]' },
  // 畳んだ状態は指で開くもの。狭い画面ほど的を広げる（見た目の詰めは保ったまま）。
  hit: {
    collapsed: "relative after:absolute after:inset-x-0 after:-inset-y-[0.55rem] after:content-['']",
    heading: "relative after:absolute after:inset-x-0 after:-inset-y-[0.3rem] after:content-['']",
  },
}

/** 色の升目（震度階級のように段が決まっているもの）。文字色は背景から選ぶ。 */
function ScaleCells({ cells, m }: { cells: { label: string; color: string }[]; m: Metrics }) {
  return (
    <div className="inline-flex overflow-hidden rounded-[3px]">
      {cells.map((cell) => (
        <span
          key={cell.label}
          className={`${m.cell} text-center font-bold leading-none`}
          style={{ backgroundColor: cell.color, color: readableTextColor(cell.color) }}
        >
          {cell.label}
        </span>
      ))}
    </div>
  )
}

/** 色見本の形。地図での描き方に合わせる（線・丸・縦棒）。寸法は `Metrics` から採る。 */
function ChipMark({ chip, m }: { chip: LegendChip; m: Metrics }) {
  if (chip.shape === 'line') {
    return <i className={`inline-block rounded-sm ${m.mark.line}`} style={{ backgroundColor: chip.color }} />
  }
  if (chip.shape === 'bar') {
    // 観測棒は縦に立てるので、凡例でも縦長にする（丸印と混ざらないため）。
    return <i className={`inline-block rounded-[1px] ${m.mark.bar}`} style={{ backgroundColor: chip.color }} />
  }
  return (
    <i
      className={`inline-block rounded-full border border-white/90 ${m.mark.dot}`}
      style={{ backgroundColor: chip.color }}
    />
  )
}

/**
 * 色見本と名前を並べる。
 *
 * **畳んだときは名前を省く**（`labels: false`）。等級のように見本が 4 つ以上あると、名前つきでは
 * 折り返して 2 行になり、畳んだ意味が消える。色の並びだけでも「どの色が使われているか」は伝わり、
 * 意味は開けば読める。
 */
function Chips({ chips, m, labels = true }: { chips: LegendChip[]; m: Metrics; labels?: boolean }) {
  return (
    <div
      className={`flex items-center text-white ${m.label} ${
        labels ? 'flex-wrap gap-x-[0.4rem] gap-y-[0.15rem]' : 'gap-x-[0.25rem]'
      }`}
    >
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="inline-flex items-center gap-[0.2rem] whitespace-nowrap"
          // 名前を省いた分は読み上げと吹き出しへ残す（色だけでは何の色か分からない）。
          title={labels ? undefined : chip.label}
          aria-label={labels ? undefined : chip.label}
        >
          <ChipMark chip={chip} m={m} />
          {labels && <span>{chip.label}</span>}
        </span>
      ))}
    </div>
  )
}

/** 連続した色帯。目盛りは位置（0〜1）で置く。 */
function Ramp({
  stops,
  ticks,
  width,
  m,
}: {
  stops: { at: number; color: string }[]
  ticks: LegendTick[]
  width: string
  m: Metrics
}) {
  const gradient = `linear-gradient(to right, ${stops.map((s) => `${s.color} ${(s.at * 100).toFixed(1)}%`).join(', ')})`
  return (
    <div style={{ width }}>
      <div className="h-[0.4rem] rounded-sm" style={{ background: gradient }} />
      {ticks.length > 0 && (
        <div className={`relative mt-[0.1rem] h-[0.6rem] text-white/70 ${m.title}`}>
          {ticks.map((tick) => (
            <span
              key={tick.label}
              className="absolute whitespace-nowrap"
              // 両端は枠の内側へ寄せる（中央揃えのままでは外へはみ出す）。
              style={
                tick.at <= 0
                  ? { left: 0 }
                  : tick.at >= 1
                    ? { right: 0 }
                    : { left: `${tick.at * 100}%`, transform: 'translateX(-50%)' }
              }
            >
              {tick.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Swatch({
  swatch,
  rampWidth,
  m,
  labels = true,
}: {
  swatch: LegendSwatch
  rampWidth: string
  m: Metrics
  labels?: boolean
}) {
  if (swatch.kind === 'scale') return <ScaleCells cells={swatch.cells} m={m} />
  if (swatch.kind === 'chips') return <Chips chips={swatch.chips} m={m} labels={labels} />
  return <Ramp stops={swatch.stops} ticks={swatch.ticks} width={rampWidth} m={m} />
}

/** 開閉の向きを示す三角。**状態は `aria-expanded` が伝えるので読み上げからは外す。** */
function Caret({ open }: { open: boolean }) {
  return <span aria-hidden className="text-[0.5rem] leading-none opacity-70">{open ? '▾' : '▸'}</span>
}

interface Props {
  blocks: LegendBlock[]
  collapsed: boolean
  onToggle: () => void
  /** 地図が低い画面（`isMapAreaShort`）。文字と余白をひと段詰める。 */
  compact?: boolean
}

export const MapLegend = memo(function MapLegend({ blocks, collapsed, onToggle, compact = false }: Props) {
  // 描くものが無ければ枠ごと出さない（空の箱は地図を隠すだけ）。
  if (blocks.length === 0) return null

  const m = compact ? COMPACT : REGULAR
  const representative = collapsed ? representativeBlock(blocks) : null
  const rampWidth = compact ? '8.5rem' : '10rem'

  return (
    <div
      className={`pointer-events-auto max-w-[min(20rem,calc(100%-1rem))] rounded-md border border-white/15 bg-[rgba(10,12,16,0.84)] shadow-lg ${m.pad}`}
      style={{
        marginLeft: 'max(0.5rem, env(safe-area-inset-left, 0px))',
        marginBottom: '0.5rem',
      }}
    >
      {representative ? (
        // 畳んだとき。見出しは短い名前にして、色見本と 1 行へ収める。
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className={`flex w-full items-center gap-[0.35rem] text-left ${m.hit.collapsed}`}
        >
          <span className={`font-bold text-white/60 ${m.title}`}>{representative.shortTitle}</span>
          <Swatch swatch={representative.swatch} rampWidth={rampWidth} m={m} labels={false} />
          <Caret open={false} />
        </button>
      ) : (
        blocks.map((block, i) => (
          <div key={block.key} className={i > 0 ? m.gap : undefined}>
            {/* **1 つ目の見出しが開閉を兼ねる。** 専用の行を足すと、開いている間ずっと
                情報を持たない行が高さを取る。 */}
            {i === 0 ? (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded
                className={`flex w-full items-center justify-between gap-2 text-left font-bold tracking-wide text-white/55 ${m.title} ${m.hit.heading}`}
              >
                <span>{block.title}</span>
                <Caret open />
              </button>
            ) : (
              <div className={`font-bold tracking-wide text-white/55 ${m.title}`}>{block.title}</div>
            )}
            <div className="mt-[0.1rem]">
              <Swatch swatch={block.swatch} rampWidth={rampWidth} m={m} />
            </div>
          </div>
        ))
      )}
    </div>
  )
})
