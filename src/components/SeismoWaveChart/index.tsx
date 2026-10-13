// 自作地震計の合成波形を、地図の下端へ横長で描く。
//
// **出すのは観測点の合成。** センサーごとの 9 本ではない —— 左上に出している
// 震度が合成の値なので、波形を単独センサーにすると「グラフと震度が別のものを
// 表している」形になる。
//
// **畳むと 1 枚、展開すると段に分ける**（2026-10-13 ユーザー承認）。
//
// - 畳んだとき: 設定（`seismoWaveCollapsedView`）で「合成」か「3 成分を重ねる」。既定は合成
// - 展開したとき: 合成の段＋東西・南北・上下の段。成分の段には正側・負側の平均の線、合成の段には
//   前後 1 秒で均した線を重ねる（詳細の窓と同じ見せ方）
//
// **P 波・S 波の到達線は、渡された緊急地震速報から引く**（`arrivalEew`。どの速報を相手にするかは
// カウントダウンと同じ選び方で、自前の走時計算を使ってよい端末でだけ渡ってくる —— App 側の判断）。
// 右端は「最後に届いたサンプル」なので、**まだ来ていない時刻の線は範囲の外に落ちて描かれない。**
//
// **このファイルが持つのは描画の輪・静かさの測定・段の構成・見出し。** 段の描き分けは `liveLanes.ts` の `drawLanes`、
// 描画の部品は `paintWave.ts`。
//
// **Canvas で描く**（管理コンソールの波形タブと同じ方針）。60 秒 × 100 Hz の
// 6000 点を DOM で持つ形は取らない。
//
// **読む頻度はここが決める。** `readWave()` は state に載らない代わり、呼ぶたびに
// 96 KB を確保する（`useSeismoStation` の `SeismoStations.readWave`）。毎フレーム
// 呼ぶと毎秒 5.7 MB の割り当てになるので、`requestAnimationFrame` の中で最小間隔を
// 置いて間引く。**`setInterval` ではなく rAF を使うのは、タブが隠れている間は
// 止まってほしいから。**

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SeismoStationState, SeismoStations } from '../../hooks/useSeismoStation'
import type { SeismoWaveCollapsedView } from '../../hooks/useSettings'
import type { EEWAlert } from '../../types/earthquake'
import { log } from '../../utils/logger'
import { computeWaveArrival, type WaveArrival } from '../../utils/seismoWaveArrival'
import { measureWindowQuietLevel, QuietLevelMemory } from '../../utils/seismoQuietScale'
import { formatWaveTally } from './waveLabels'
import { useWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { AXIS_COLORS, AXIS_LABELS, COMPOSITE_COLOR } from './paintWave'
import { drawLanes, laneKey, type Lane } from './liveLanes'
import { WaveAxisToggles } from './WaveAxisToggles'

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

/** 合成の段の名前。詳細の窓の段と同じ語。 */
const COMPOSITE_LABEL = '合成'

/**
 * 静かさを測り直す間隔（データの時刻で ms）。**1 秒。**
 *
 * 描き直しは 0.3 秒ごとだが、測るのは 30 秒ぶんの中央値なので、0.3 秒ごとに測っても値はほとんど
 * 動かない。3 成分 × 3000 サンプルを並べ替えるので、描くたびに測る理由が無い。
 */
const QUIET_MEASURE_INTERVAL_MS = 1000

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
  /** 畳んでいるときに出すもの（設定）。 */
  collapsedView: SeismoWaveCollapsedView
  /** 展開しているか（設定に残す）。 */
  expanded: boolean
  onToggleExpanded: () => void
  /**
   * P/S の到達線を引く相手の緊急地震速報。**引かないなら `null`**（発表中のものが無い・自前の走時計算を
   * 使えない端末）。選び方はカウントダウンと同じ（`utils/countdownEew.ts`）。
   */
  arrivalEew: EEWAlert | null
}

export function SeismoWaveChart({ stations, readWave, collapsedView, expanded, onToggleExpanded, arrivalEew }: Props) {
  if (stations.length === 0) return null
  // 観測点が増えたら縦に積む（親が `flex flex-col`）。いまは 1 つ。
  return (
    <>
      {stations.map((station) => (
        <StationWave
          key={station.stationId}
          station={station}
          readWave={readWave}
          collapsedView={collapsedView}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
          arrivalEew={arrivalEew}
        />
      ))}
    </>
  )
}

function StationWave({
  station,
  readWave,
  collapsedView,
  expanded,
  onToggleExpanded,
  arrivalEew,
}: Omit<Props, 'stations'> & { station: SeismoStationState }) {
  const axes = useWaveAxes()
  const lanes = useMemo<readonly Lane[]>(() => {
    if (!expanded) return [{ kind: collapsedView }]
    const out: Lane[] = [{ kind: 'composite' }]
    for (let a = 0; a < 3; a += 1) if (axes[a] !== false) out.push({ kind: 'axis', axis: a })
    return out
  }, [expanded, collapsedView, axes])

  // **到達は観測点と速報が変わったときだけ解く**（描き直しのたびに走時表を引かない）。
  const arrival = useMemo<WaveArrival | null>(() => {
    if (arrivalEew === null) return null
    return computeWaveArrival({
      originMs: new Date(arrivalEew.earthquake.originTime).getTime(),
      hypocenter: arrivalEew.earthquake.hypocenter,
      stationLat: station.lat,
      stationLon: station.lon,
    })
  }, [arrivalEew, station.lat, station.lon])

  // **線を引けなかった理由を残す**（速報ごとに 1 回）。トークンの無い端末では `arrivalEew` が `null` で
  // ここへ来ない（正常系なので記録しない）。画面からは「線が出ない」としか見えない。
  const loggedNoArrivalRef = useRef<string | null>(null)
  useEffect(() => {
    if (arrivalEew === null || arrival !== null) return
    const key = `${station.stationId}:${arrivalEew.id}`
    if (loggedNoArrivalRef.current === key) return
    loggedNoArrivalRef.current = key
    const reason = station.lat === null || station.lon === null ? '観測点の座標がホストの設定に無い' : '速報の発生時刻・震源・深さから解けない'
    log.debug(`[seismo] 下端の波形に P/S の線を引けない（${station.stationId}・${arrivalEew.id}）: ${reason}`)
  }, [arrivalEew, arrival, station.stationId, station.lat, station.lon])

  const canvasRefs = useRef(new Map<string, HTMLCanvasElement>())
  const [scaleTexts, setScaleTexts] = useState<Readonly<Record<string, string | null>>>({})

  // **描画の輪は張り直さない。** 観測点が変わるたびに rAF を組み直すと、
  // 毎秒の再描画でそのつど輪が切れる。最新の値は ref から読む。
  const readWaveRef = useRef(readWave)
  readWaveRef.current = readWave
  const stationIdRef = useRef(station.stationId)
  stationIdRef.current = station.stationId
  const lanesRef = useRef(lanes)
  lanesRef.current = lanes
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  // **段が変わったらすぐ描き直す**（最小間隔を待つと、作り直した canvas が最大 0.3 秒空白で見える）。
  const redrawNowRef = useRef(false)
  useEffect(() => {
    redrawNowRef.current = true
  }, [lanes])
  const arrivalRef = useRef(arrival)
  arrivalRef.current = arrival
  const scaleTextsRef = useRef(scaleTexts)
  // **途絶を描画へも渡す。** 文言だけだと、絵そのものは「いま揺れている」ように
  // 見えたまま —— 線を薄くして、生きていない絵だと分かるようにする。
  const staleRef = useRef(station.waveStale)
  staleRef.current = station.waveStale

  useEffect(() => {
    let raf = 0
    let lastAt = -Infinity
    // **静かさは観測点ごとに覚える**（`QuietLevelMemory`）。観測点が替わったら覚え直す。
    let quietStationId: string | null = null
    let quiet = new QuietLevelMemory()
    let lastMeasuredMs = -Infinity
    /** 合成で描けず 3 成分へ戻したことを、観測点ごとに 1 回だけ残す。 */
    let loggedFallbackFor: string | null = null
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < MIN_REDRAW_MS && !redrawNowRef.current) return
      lastAt = now
      redrawNowRef.current = false
      const stationId = stationIdRef.current
      const win = readWaveRef.current(stationId)
      if (stationId !== quietStationId) {
        quietStationId = stationId
        quiet = new QuietLevelMemory()
        lastMeasuredMs = -Infinity
      }
      if (win !== null && win.gal[0].length > 0) {
        const endMs = win.firstSampleMs + win.gal[0].length * win.msPerSample
        // 時刻が戻った（再接続で窓が作り直された等）ときも測り直す。
        if (endMs - lastMeasuredMs >= QUIET_MEASURE_INTERVAL_MS || endMs < lastMeasuredMs) {
          lastMeasuredMs = endMs
          quiet.observe(endMs, measureWindowQuietLevel(win))
        }
      }
      const { texts: next, compositeFellBack } = drawLanes({
        canvases: canvasRefs.current,
        lanes: lanesRef.current,
        expanded: expandedRef.current,
        win,
        stale: staleRef.current,
        quietLevel: quiet.current(),
        arrival: arrivalRef.current,
      })
      if (compositeFellBack && loggedFallbackFor !== stationId) {
        loggedFallbackFor = stationId
        log.debug(`[seismo] 下端の波形を合成で描けなかった（${stationId}）: 3 成分を重ねて描く`)
      }
      // **同じ文字列なら state を差し替えない。** 揺れている間は毎回変わりうるが、
      // 丸めた表示が動かない限り再描画する意味が無い。
      if (!sameTexts(next, scaleTextsRef.current)) {
        scaleTextsRef.current = next
        setScaleTexts(next)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const tallyText = formatWaveTally(station.waveTally)
  const lastLane = lanes[lanes.length - 1]
  const headScale = lanes.length === 1 ? (scaleTexts[laneKey(lanes[0])] ?? null) : null

  return (
    <div className="w-full bg-black/70 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-32 roomy:max-w-56">{station.displayName}</span>
        <WaveAxisToggles />
        {/* **途絶はいちばん右へ寄せず、数え上げと同じ列に並べる。** 起きていることの
            種類が違うだけで、どちらも「この絵をそのまま信じてよいか」の手掛かり。 */}
        {station.waveStale && <span className="ml-auto text-secondary">{STALE_LABEL}</span>}
        {tallyText !== null && (
          <span className={`text-secondary truncate${station.waveStale ? '' : ' ml-auto'}`}>{tallyText}</span>
        )}
        {/* 畳んでいるときだけ縦の範囲をここへ出す（展開したら段ごとに出す）。 */}
        {lanes.length === 1 && (
          <span
            className={`font-mono tabular-nums text-secondary${
              tallyText === null && !station.waveStale ? ' ml-auto' : ''
            }`}
          >
            {headScale ?? '—'}
          </span>
        )}
        {/* **記号だけ・ホバーの説明も付けない**（2026-10-13 ユーザー判断「押せば分かる」）。
            読み上げソフト向けの名前だけ持たせる（画面には出ない。2026-10-13 ユーザー承認）。 */}
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? '波形を畳む' : '波形を展開'}
          className={`text-secondary hover:text-white leading-none${
            lanes.length !== 1 && tallyText === null && !station.waveStale ? ' ml-auto' : ''
          }`}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {lanes.map((lane) => {
          const key = laneKey(lane)
          const isLast = lane === lastLane
          return (
            <div key={key} className="relative">
              {lanes.length > 1 && (
                <div className="pointer-events-none absolute left-0 right-0 top-0 flex justify-between text-[9px] roomy:text-[10px] leading-none">
                  <span style={{ color: lane.kind === 'axis' ? AXIS_COLORS[lane.axis] : COMPOSITE_COLOR }}>
                    {lane.kind === 'axis' ? AXIS_LABELS[lane.axis] : COMPOSITE_LABEL}
                  </span>
                  <span className="font-mono tabular-nums text-secondary">{scaleTexts[key] ?? '—'}</span>
                </div>
              )}
              <canvas
                ref={(el) => {
                  if (el === null) canvasRefs.current.delete(key)
                  else canvasRefs.current.set(key, el)
                }}
                // 畳んだ絵は目盛りの帯（`AXIS_BAND_PX` = 15px）込みで 55px。展開した段は 1 段あたりその 7 割ほどで、
                // 目盛りの帯は一番下の段だけに取る。
                className={`block w-full ${
                  lanes.length === 1
                    ? 'h-[55px] roomy:h-[71px]'
                    : isLast
                      ? 'h-[43px] roomy:h-[54px]'
                      : 'h-[28px] roomy:h-[39px]'
                }`}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function sameTexts(a: Readonly<Record<string, string | null>>, b: Readonly<Record<string, string | null>>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k])
}
