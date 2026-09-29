// 自作地震計の合成波形を、地図の下端へ横長で描く。
//
// **出すのは観測点の合成 1 本。** センサーごとの 9 本ではない —— 左上に出している
// 震度が合成の値なので、波形を単独センサーにすると「グラフと震度が別のものを
// 表している」形になる。
//
// **Canvas で描く**（管理コンソールの波形タブと同じ方針）。60 秒 × 100 Hz の
// 6000 点を DOM で持つ形は取らない。
//
// **読む頻度はここが決める。** `readWave()` は state に載らない代わり、呼ぶたびに
// 96 KB を確保する（`useSeismoStation` の `SeismoStations.readWave`）。毎フレーム
// 呼ぶと毎秒 5.7 MB の割り当てになるので、`requestAnimationFrame` の中で最小間隔を
// 置いて間引く。**`setInterval` ではなく rAF を使うのは、タブが隠れている間は
// 止まってほしいから。**

import { useEffect, useRef, useState } from 'react'
import { WAVE_RETAIN_SEC, type SeismoStationState, type SeismoStations } from '../../hooks/useSeismoStation'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { buildWaveColumns } from './waveColumns'
import { formatScaleGal, formatWaveTally } from './waveLabels'
import { createLogThrottle, log } from '../../utils/logger'

/**
 * 波形が届かなくなっているときに出す語。
 *
 * **「接続断」とは書かない。** 接続は生きていて（震度は届き続けている）、
 * 波形だけが来ていない状態 —— そう書くと事実とずれる。
 *
 * **復旧すれば自動で消える**（次の巡回で `waveStale` が下りる）。止まっていた事実は
 * 絵の欠測と数え上げに残るので、この語が消えても無かったことにはならない。
 */
const STALE_LABEL = '波形 途絶'

/**
 * 2D コンテキストを取れなかったことの記録を間引く枠。
 *
 * **観測点ごとに分けない。** これはブラウザ側の事情なので、どの観測点で起きても
 * 同じ 1 件。分けると観測点の数だけ同じ行が出る。
 */
const throttledNoContext = createLogThrottle(300_000)

/**
 * 3 成分の色。**震度階級の色（黄〜橙〜赤）と混ざらない色相から採る** ——
 * 地図の上に重ねるので、階級色に見える線を引くと別のものと読まれる。
 */
const AXIS_COLORS = ['#7dd3fc', '#a5b4fc', '#f0abfc'] as const
const AXIS_LABELS = ['南北', '東西', '上下'] as const

/**
 * 縦の振れ幅の下限（gal）。
 *
 * **実機の静穏時から決めた値**（2026-09-29・12 秒 1203 サンプルの実測）——
 *
 * | 成分 | 最大 | p99 | RMS |
 * |---|---|---|---|
 * | 南北 | 1.50 | 0.84 | 0.32 gal |
 * | 東西 | 1.22 | 0.84 | 0.34 gal |
 * | 上下 | **1.61** | **1.24** | **0.49 gal** |
 *
 * **素の自動にすると平常時のノイズが画面いっぱいに広がり、揺れているようにしか
 * 見えなくなる**（下限 2 gal で試したときは最大が画面の 8 割まで振れた）。この値なら
 * 静穏時の最大が中心から 16%（画面全体の 3 割）に収まり、静かなことが一目で分かる。
 *
 * **これ以上下げない。** 上下動のノイズが上がってきたら、下げるのではなく
 * 設置か校正（#367）を疑うところ。
 *
 * **震度1 の揺れは、この絵では静穏時と見分けられない** —— 震度1 の加速度は
 * 静穏時のノイズと同じ桁にいる。波形で見分けたいのは震度2 以上（2 gal 以上）で、
 * それなら中心から 2 割以上に振れる。震度1 かどうかは左上の計測震度が受け持つ。
 */
const MIN_SCALE_GAL = 10

/** 横軸の幅（ms）。**抱えている長さと揃える** —— ずれると絵の左端の意味が狂う。 */
const SPAN_MS = WAVE_RETAIN_SEC * 1000

/**
 * 描き直しの最小間隔（ms）。
 *
 * **押し出しの周期に合わせる。** まとまりは 0.3 秒ごとに届く（実機の実測で 12 秒に
 * 40 件）ので、それより細かく描いても**同じ絵を描き直すだけ** —— 読むたびに 96 KB を
 * 確保するので、3 倍の頻度で回すと毎秒 1 MB 近い割り当てが無駄に増える。
 */
const MIN_REDRAW_MS = 300

interface Props {
  stations: readonly SeismoStationState[]
  readWave: SeismoStations['readWave']
}

export function SeismoWaveChart({ stations, readWave }: Props) {
  if (stations.length === 0) return null
  // 観測点が増えたら縦に積む（親が `flex flex-col`）。いまは 1 つ。
  return (
    <>
      {stations.map((station) => (
        <StationWave key={station.stationId} station={station} readWave={readWave} />
      ))}
    </>
  )
}

function StationWave({ station, readWave }: { station: SeismoStationState; readWave: Props['readWave'] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [scaleText, setScaleText] = useState<string | null>(null)

  // **描画の輪は張り直さない。** 観測点が変わるたびに rAF を組み直すと、
  // 毎秒の再描画でそのつど輪が切れる。最新の値は ref から読む。
  const readWaveRef = useRef(readWave)
  readWaveRef.current = readWave
  const stationIdRef = useRef(station.stationId)
  stationIdRef.current = station.stationId
  const scaleTextRef = useRef<string | null>(null)
  // **途絶を描画へも渡す。** 文言だけだと、絵そのものは「いま揺れている」ように
  // 見えたまま —— 線を薄くして、生きていない絵だと分かるようにする。
  const staleRef = useRef(station.waveStale)
  staleRef.current = station.waveStale

  useEffect(() => {
    let raf = 0
    let lastAt = -Infinity
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < MIN_REDRAW_MS) return
      lastAt = now
      const canvas = canvasRef.current
      if (canvas === null) return
      const next = drawWave(canvas, readWaveRef.current(stationIdRef.current), staleRef.current)
      // **同じ文字列なら state を差し替えない。** 揺れている間は毎回変わりうるが、
      // 丸めた表示が動かない限り再描画する意味が無い。
      if (next !== scaleTextRef.current) {
        scaleTextRef.current = next
        setScaleText(next)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const tallyText = formatWaveTally(station.waveTally)

  return (
    <div className="w-full bg-black/70 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-[8rem] roomy:max-w-[14rem]">{station.displayName}</span>
        {AXIS_LABELS.map((label, i) => (
          <span key={label} style={{ color: AXIS_COLORS[i] }}>{label}</span>
        ))}
        {/* **途絶はいちばん右へ寄せず、数え上げと同じ列に並べる。** 起きていることの
            種類が違うだけで、どちらも「この絵をそのまま信じてよいか」の手掛かり。 */}
        {station.waveStale && <span className="ml-auto text-secondary">{STALE_LABEL}</span>}
        {tallyText !== null && (
          <span className={`text-secondary truncate${station.waveStale ? '' : ' ml-auto'}`}>{tallyText}</span>
        )}
        <span
          className={`font-mono tabular-nums text-secondary${
            tallyText === null && !station.waveStale ? ' ml-auto' : ''
          }`}
        >
          {scaleText ?? '—'}
        </span>
      </div>
      <canvas ref={canvasRef} className="block w-full h-[40px] roomy:h-[56px]" />
    </div>
  )
}

/**
 * 1 枚ぶんを描き、縦の振れ幅の表示を返す。**描けなければ `null`。**
 *
 * 純粋に描画だけを担う（何を描くかの計算は `waveColumns.ts`）。
 */
function drawWave(
  canvas: HTMLCanvasElement,
  win: SeismoWaveWindow | null,
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

  if (win === null) return null
  const { columns, scaleGal, hasAnyValue } = buildWaveColumns({
    window: win,
    // 1 デバイスピクセルを 1 列にする。
    columnCount: w,
    spanMs: SPAN_MS,
    minScaleGal: MIN_SCALE_GAL,
  })
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
  //
  // **届かなくなっていればさらに落とす。** 抱えた中身は時間で薄れないので、
  // このままの濃さで描くと**止まった絵が「いま静かに揺れている」ように見え続ける**。
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
