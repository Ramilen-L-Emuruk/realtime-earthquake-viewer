// 自作地震計の合成波形を、地図の下端へ横長で描く。
//
// **出すのは観測点の合成。** センサーごとの 9 本ではない —— 左上に出している
// 震度が合成の値なので、波形を単独センサーにすると「グラフと震度が別のものを
// 表している」形になる。
//
// **畳むと 1 枚、展開すると段に分ける**（2026-10-13 ユーザー承認）。
//
// - 畳んだとき: 設定（`seismoWaveCollapsedView`）で「合成」か「3 成分を重ねる」。既定は合成
// - 展開したとき: 合成の段＋東西・南北・上下の段
//
// **線が 1 本だけの絵には平均の線を重ねる**（詳細の窓と同じ見せ方）。合成には前後 1 秒で均した線、成分には
// 正側・負側の平均の線。展開した段のほか、畳んだ合成と、向きを 1 つだけ残した「3 成分を重ねる」も
// 1 本なので重ねる（2026-10-13 ユーザー承認）。2 本以上を重ねた絵には足さない（線の数が倍になって読めない）。
//
// **P 波・S 波の到達線は、渡された緊急地震速報から引く**（`arrivalEew`。どの速報を相手にするかは
// カウントダウンと同じ選び方。到達予想キーの門は掛けない —— `docs/forecast-computation-audit.md` の 11）。
// 右端は時計の「いま」で、**いまより先の時刻の線は描かない**（`liveLanes.ts` の `liveArrivalMarks`）。
//
// **右端を時計で進め、少しずつずらして描く**（`docs/public-waveform-design.md` §5.4）。組み立て（列・平均の線）は
// 0.3 秒ごとに画面に置かない裏の絵へ行い、画面へは毎フレーム、組み立ててから時計が進んだ分だけずらして写す。
// 届くまとまりごとに 0.3 秒ぶん跳ぶ見え方にしないため。目盛りは写すたびに描き、波形と一緒に流さない。
//
// **このファイルが持つのは描画の輪・静かさの測定・段の構成・見出し。** 段の描き分けは `liveLanes.ts` の `drawLanes`、
// 描画の部品は `paintWave.ts`。
//
// **Canvas で描く**（管理コンソールの波形タブと同じ方針）。最長 180 秒 × 100 Hz の
// 18000 点を DOM で持つ形は取らない。
//
// **読む頻度はここが決める。** `readWave()` は state に載らない代わり、呼ぶたびに
// 見えている幅ぶん（60 秒で 96 KB）を確保する（`useSeismoStation` の `SeismoStations.readWave`）。毎フレーム
// 呼ぶと 60 秒の幅でも毎秒 5.7 MB の割り当てになるので、`requestAnimationFrame` の中で最小間隔を
// 置いて間引く。**`setInterval` ではなく rAF を使うのは、タブが隠れている間は
// 止まってほしいから。**

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SeismoStationState, SeismoStations } from '../../hooks/useSeismoStation'
import { PUBLIC_WAVE_STALE_MS, type PublicWaves } from '../../hooks/usePublicWaves'
import type { SeismoWaveCollapsedView } from '../../hooks/useSettings'
import type { EEWAlert } from '../../types/earthquake'
import type { LatLng } from '../../utils/stationCoords'
import { getServerClockOffsetMs, serverNow } from '../../utils/clock'
import { log } from '../../utils/logger'
import { computeWaveArrival, type WaveArrival } from '../../utils/seismoWaveArrival'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { measureWindowQuietLevel, QuietLevelMemory } from '../../utils/seismoQuietScale'
import { formatWaveTally } from './waveLabels'
import { useWaveAxes } from '../../hooks/useSeismoWaveAxes'
import { AXIS_BAND_PX, AXIS_COLORS, AXIS_LABELS, COMPOSITE_COLOR, paintTicks } from './paintWave'
import {
  drawLanes,
  laneKey,
  liveSpanMs,
  liveTicks,
  presentShiftMs,
  presentSourceX,
  type Lane,
  type LaneTarget,
  type LiveTimeline,
} from './liveLanes'
import { WaveAxisToggles } from './WaveAxisToggles'
import { PUBLIC_WAVE_UNIT, SEISMO_WAVE_UNIT, type WaveUnit } from './waveUnit'

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
 * 公開観測点の SeedLink が続けて断られているとき（接続数の上限とみなす）に、見出しへ出す印
 * （`docs/public-waveform-design.md` §0。2026-10-15 ユーザー承認）。
 */
const PUBLIC_REFUSED_LABEL = '公開観測点 接続数の上限'

/**
 * 公開観測点の見出し（番号＋観測点名）。**番号の書き方は地図の印と一緒に決める**（§12。いまは選ばれた「#1 宮城丸森」の形）。
 * 書き方を変えるときはここだけ直す。
 */
export function publicStationHeading(number: number, nameJa: string): string {
  return `#${number} ${nameJa}`
}

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
 * 組み立て（窓を読んで裏の絵を描く）の間隔（ms）。
 *
 * **押し出しの周期に合わせる。** まとまりは 0.3 秒ごとに届く（実機の実測で 12 秒に
 * 40 件）ので、それより細かく組んでも**同じ絵を組み直すだけ** —— 読むたびに 96 KB を
 * 確保するので、3 倍の頻度で回すと毎秒 1 MB 近い割り当てが無駄に増える。
 */
const COMPOSE_INTERVAL_MS = 300

/**
 * 裏の絵の「いま」より先に取る余白（ms）。**組み直す間隔の 2 倍。** 次に組み直すまでの間、画面の右端から
 * 見えてくるのはこの余白で、1 フレーム遅れて組み直しても足りるように倍を取る。
 */
const LEAD_MS = COMPOSE_INTERVAL_MS * 2

/**
 * 画面へ写す間隔（ms）。毎秒 60 回（`docs/public-waveform-design.md` §0「描き直しの頻度」）。写すのは
 * 裏の絵をずらして貼るだけなので、組み立てより桁違いに軽い。
 */
const FRAME_INTERVAL_MS = 1000 / 60

/**
 * フレームの間隔を比べるときの遊び（ms）。rAF の刻みは画面の更新に合わせて少し揺れるので、きっちり
 * {@link FRAME_INTERVAL_MS} で比べると 60 Hz の画面で 1 枚おきに飛ばし、毎秒 30 回に落ちる。
 */
const FRAME_SLACK_MS = 2

/** 組み直しが止まったとみなす長さ（ms）。写す側が余白（{@link LEAD_MS}）を超えてこれだけ待ったら記録する。 */
const COMPOSE_STALLED_MS = 3000

/**
 * 自作地震計の波形の最後のサンプルが「いま」からこれより後ろへずれていたら記録する（ms）。**右端は時計の「いま」なので、
 * ホストの時計が先の余白（{@link LEAD_MS}）より進んでいると最新の分は描かれず、遅れていると右端が空く。**
 * 遅れの側は届くまでの遅れも含むので、余白より広く取る。
 */
const SEISMO_SAMPLE_BEHIND_WARN_MS = 5000

/** 描画の失敗・時計のずれを記録する間隔（ms）。同じ種類は 1 分に 1 回まで。 */
const DRAW_WARN_INTERVAL_MS = 60_000

interface Props {
  /** 自作地震計の観測点。**出さないなら空**（出すかどうかは呼び出し側が決める）。 */
  stations: readonly SeismoStationState[]
  readWave: SeismoStations['readWave']
  /** 公開観測点の波形。**出さないなら `null`**（`usePublicWaves` の `visible`）。自作地震計の段の下に番号順に積む。 */
  publicWaves: Pick<PublicWaves, 'stations' | 'status' | 'readWave'> | null
  /** 畳んでいるときに出すもの（設定）。 */
  collapsedView: SeismoWaveCollapsedView
  /** 展開しているか（設定に残す）。 */
  expanded: boolean
  onToggleExpanded: () => void
  /**
   * P/S の到達線を引く相手の緊急地震速報。**引かないなら `null`**（発表中のものが無い）。
   * 選び方はカウントダウンと同じ（`utils/countdownEew.ts`）。
   */
  arrivalEew: EEWAlert | null
  /** 横の幅（秒。設定の時間幅）。抱えている長さ（`WAVE_RETAIN_SEC`）以下。 */
  spanSec: number
  /**
   * 公開観測点の段を押したとき、地図をその観測点へ寄せる（`App.tsx` の `focusMapTarget`。`docs/public-waveform-design.md` §7）。
   * **自作地震計の段は寄せない** —— 自宅の位置を地図に出さないため（同 §7）。
   */
  onFocusStation: (positions: LatLng[]) => void
}

/**
 * 1 段ぶんの波形の出どころ。**自作地震計と公開観測点の違いはここに閉じ込める**（単位・見出し・途絶・数え上げ）。
 * 描画の輪・段の構成・P/S 線は共通。
 */
interface LiveWaveSource {
  /** 観測点を見分ける鍵（静かさの記憶・記録の鍵）。種類をまたいで重ならない。 */
  readonly id: string
  readonly title: string
  readonly lat: number | null
  readonly lon: number | null
  /** 届かなくなっているか（線を薄くし、見出しに「波形 途絶」を出す）。 */
  readonly stale: boolean
  /** 見出しに添える数え上げ（自作地震計の欠測など）。無ければ `null`。 */
  readonly tallyText: string | null
  /** 見出しに添える印（公開観測点の接続数の上限）。無ければ `null`。 */
  readonly notice: string | null
  readonly unit: WaveUnit
  /**
   * 最後のサンプルが「いま」からこれより後ろへずれていたら記録する（ms）。**届き方で違う** —— 公開観測点は約 21 秒ぶんの
   * まとまりで届くので、定常で 5〜27 秒遅れる（2026-10-15 の実測・`docs/public-waveform-design.md` §3.2）。
   */
  readonly sampleBehindWarnMs: number
  /** 窓を読む。`fromMs` より前は写さない。 */
  readonly read: (fromMs: number) => SeismoWaveWindow | null
  /** 押したら地図をここへ寄せる。**寄せない段は `null`**（自作地震計）。 */
  readonly focus: (() => void) | null
}

/** 段を積む枠の高さの上限（画面の 3 分の 1。`docs/public-waveform-design.md` §0）。超えた分は枠の中で上下にずらして見る。 */
const STACK_MAX_HEIGHT_CLASS = 'max-h-[33vh]'

export function SeismoWaveChart({ stations, readWave, publicWaves, collapsedView, expanded, onToggleExpanded, arrivalEew, spanSec, onFocusStation }: Props) {
  const sources: LiveWaveSource[] = []
  for (const station of stations) {
    sources.push({
      id: `seismo:${station.stationId}`,
      title: station.displayName,
      lat: station.lat,
      lon: station.lon,
      stale: station.waveStale,
      tallyText: formatWaveTally(station.waveTally),
      notice: null,
      unit: SEISMO_WAVE_UNIT,
      sampleBehindWarnMs: SEISMO_SAMPLE_BEHIND_WARN_MS,
      read: (fromMs) => readWave(station.stationId, fromMs),
      focus: null,
    })
  }
  if (publicWaves !== null) {
    const refused = publicWaves.status.kind === 'refused'
    publicWaves.stations.forEach((ps, i) => {
      sources.push({
        id: `public:${ps.code}`,
        title: publicStationHeading(ps.number, ps.nameJa),
        lat: ps.lat,
        lon: ps.lon,
        stale: ps.stale,
        tallyText: null,
        // **印は公開観測点の先頭の段にだけ出す**（接続は 1 本なので、段ごとに並べても同じことしか言わない）。
        notice: refused && i === 0 ? PUBLIC_REFUSED_LABEL : null,
        unit: PUBLIC_WAVE_UNIT,
        // 途絶とみなす長さまでは遅れて当たり前（届く単位が粗い）。
        sampleBehindWarnMs: PUBLIC_WAVE_STALE_MS,
        read: (fromMs) => publicWaves.readWave(ps.code, fromMs),
        focus: () => onFocusStation([[ps.lat, ps.lon]]),
      })
    })
  }
  if (sources.length === 0) return null
  return (
    <div className={`w-full ${STACK_MAX_HEIGHT_CLASS} overflow-y-auto overscroll-contain`}>
      {sources.map((source, i) => (
        <StationWave
          key={source.id}
          source={source}
          // **向きの切り替えと畳む・展開は先頭の段にだけ置く**（どちらも全段に効く。段ごとに並べると同じボタンが積み上がる）。
          showControls={i === 0}
          collapsedView={collapsedView}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
          arrivalEew={arrivalEew}
          spanSec={spanSec}
        />
      ))}
    </div>
  )
}

function StationWave({
  source,
  showControls,
  collapsedView,
  expanded,
  onToggleExpanded,
  arrivalEew,
  spanSec,
}: Omit<Props, 'stations' | 'readWave' | 'publicWaves' | 'onFocusStation'> & { source: LiveWaveSource; showControls: boolean }) {
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
      stationLat: source.lat,
      stationLon: source.lon,
    })
  }, [arrivalEew, source.lat, source.lon])

  // **線を引けなかった理由を残す**（地震ごとに 1 回）。発表中の速報が無いときは `arrivalEew` が `null` で
  // ここへ来ない（正常系なので記録しない）。画面からは「線が出ない」としか見えない。鍵は報ではなく地震
  // （`issue.eventId`）—— 報の id で数えると、座標の無い観測点では続報のたびに同じ行が出る。
  const loggedNoArrivalRef = useRef<string | null>(null)
  useEffect(() => {
    if (arrivalEew === null || arrival !== null) return
    const key = `${source.id}:${arrivalEew.issue?.eventId ?? arrivalEew.id}`
    if (loggedNoArrivalRef.current === key) return
    loggedNoArrivalRef.current = key
    const reason = source.lat === null || source.lon === null ? '観測点の座標が無い' : '速報の発生時刻・震源・深さから解けない'
    log.debug(`[seismo] 下端の波形に P/S の線を引けない（${source.id}・${arrivalEew.id}）: ${reason}`)
  }, [arrivalEew, arrival, source.id, source.lat, source.lon])

  const canvasRefs = useRef(new Map<string, HTMLCanvasElement>())
  const [scaleTexts, setScaleTexts] = useState<Readonly<Record<string, string | null>>>({})

  // **描画の輪は張り直さない。** 観測点が変わるたびに rAF を組み直すと、
  // 毎秒の再描画でそのつど輪が切れる。最新の値は ref から読む。
  const readRef = useRef(source.read)
  readRef.current = source.read
  const stationIdRef = useRef(source.id)
  stationIdRef.current = source.id
  // 単位は観測点の種類で決まる（鍵に種類が入っているので、同じ段のまま種類が変わることは無い）。
  const unitRef = useRef(source.unit)
  unitRef.current = source.unit
  const behindWarnMsRef = useRef(source.sampleBehindWarnMs)
  behindWarnMsRef.current = source.sampleBehindWarnMs
  const lanesRef = useRef(lanes)
  lanesRef.current = lanes
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const spanMsRef = useRef(spanSec * 1000)
  spanMsRef.current = spanSec * 1000
  // **段が変わったらすぐ組み直す**（間隔を待つと、作り直した canvas が最大 0.3 秒空白で見える）。
  const redrawNowRef = useRef(false)
  useEffect(() => {
    redrawNowRef.current = true
  }, [lanes, spanSec])
  const arrivalRef = useRef(arrival)
  arrivalRef.current = arrival
  const scaleTextsRef = useRef(scaleTexts)
  // **途絶を描画へも渡す。** 文言だけだと、絵そのものは「いま揺れている」ように
  // 見えたまま —— 線を薄くして、生きていない絵だと分かるようにする。
  const staleRef = useRef(source.stale)
  staleRef.current = source.stale

  useEffect(() => {
    let raf = 0
    let lastFrameAt = -Infinity
    let lastComposeAt = -Infinity
    /** 裏の絵（段ごと）。画面に置かない。 */
    const backs = new Map<string, HTMLCanvasElement>()
    /** いまの裏の絵を組んだときの時間の取り方。まだ組んでいなければ `null`。 */
    let timeline: LiveTimeline | null = null
    // **静かさは観測点ごとに覚える**（`QuietLevelMemory`）。観測点が替わったら覚え直す。
    let quietStationId: string | null = null
    let quiet = new QuietLevelMemory(unitRef.current.quietMinLevel)
    let lastMeasuredMs = -Infinity
    /** 合成で描けず 3 成分へ戻したことを、観測点ごとに 1 回だけ残す。 */
    let loggedFallbackFor: string | null = null
    /** 種類ごとの最後に記録した時刻（`performance.now()`）。**描画の失敗は記録しないと、絵が凍るだけで何も残らない。** */
    const warnedAt = new Map<string, number>()
    const warnThrottled = (kind: string, message: string, error?: unknown): void => {
      const at = performance.now()
      if (at - (warnedAt.get(kind) ?? -Infinity) < DRAW_WARN_INTERVAL_MS) return
      warnedAt.set(kind, at)
      if (error === undefined) log.warn(message)
      else log.error(message, error)
    }
    /** 裏の絵を組み直す（窓を読み、段ごとに描く）。 */
    const compose = (): void => {
      const stationId = stationIdRef.current
      // **見えている幅より前は写さない**（抱える長さは時間幅のいちばん長いもの）。静かさは末尾 30 秒で測るので足りる。
      const win = readRef.current(serverNow() - spanMsRef.current - LEAD_MS)
      if (stationId !== quietStationId) {
        quietStationId = stationId
        quiet = new QuietLevelMemory(unitRef.current.quietMinLevel)
        lastMeasuredMs = -Infinity
      }
      const nowMs = serverNow()
      // **時計の値が壊れていれば組まない**（右端が非有限だと全サンプルが黙って捨てられ、空の絵になる）。
      // 直前の裏の絵をそのまま写し続け、記録だけ残す。
      if (!Number.isFinite(nowMs)) {
        warnThrottled('clock', `[seismo] 下端の波形を組めない: 時計の値が数でない（${nowMs}）`)
        return
      }
      if (win !== null && win.gal[0].length > 0) {
        const endMs = win.firstSampleMs + win.gal[0].length * win.msPerSample
        // **ホストの時計と「いま」のずれを残す。** 右端を時計の「いま」に置くので、先へずれた分は描かれず、
        // 後ろへずれた分は右端が空く。どちらも絵からは「静か」と見分けが付かない。
        const aheadMs = endMs - nowMs
        if (aheadMs > LEAD_MS || aheadMs < -behindWarnMsRef.current) {
          warnThrottled(
            'skew',
            `[seismo] 下端の波形の最後のサンプルが「いま」から ${Math.round(aheadMs)} ms ずれている（${stationId}）: ` +
              (aheadMs > 0 ? '右端より先の分は描かない' : '右端が空く'),
          )
        }
        // 時刻が戻った（再接続で窓が作り直された等）ときも測り直す。
        if (endMs - lastMeasuredMs >= QUIET_MEASURE_INTERVAL_MS || endMs < lastMeasuredMs) {
          lastMeasuredMs = endMs
          quiet.observe(endMs, measureWindowQuietLevel(win))
        }
      }
      // **描き終えてから確定する。** 途中で投げたとき、裏の絵が古いまま時間の取り方だけ新しくなると、
      // 写す側が段ごとに違う位置へずらす。
      const nextTimeline: LiveTimeline = { nowMs, spanMs: spanMsRef.current, leadMs: LEAD_MS, clockCalibrated: getServerClockOffsetMs() !== null }
      const targets = new Map<string, LaneTarget>()
      for (const [key, shown] of canvasRefs.current) {
        let back = backs.get(key)
        if (back === undefined) {
          back = document.createElement('canvas')
          backs.set(key, back)
        }
        // 裏の絵は見える幅に、先の余白の分を足した幅。高さは見える段と同じ。
        targets.set(key, {
          canvas: back,
          size: { width: (shown.clientWidth * liveSpanMs(nextTimeline)) / nextTimeline.spanMs, height: shown.clientHeight },
        })
      }
      for (const key of [...backs.keys()]) if (!canvasRefs.current.has(key)) backs.delete(key)
      const { texts: next, compositeFellBack } = drawLanes({
        targets,
        lanes: lanesRef.current,
        expanded: expandedRef.current,
        win,
        stale: staleRef.current,
        quietLevel: quiet.current(),
        arrival: arrivalRef.current,
        timeline: nextTimeline,
        unit: unitRef.current,
      })
      timeline = nextTimeline
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

    /** 裏の絵を、組んでから時計が進んだ分だけずらして画面の段へ写し、目盛りを描く。 */
    const present = (): void => {
      if (timeline === null) return
      const dpr = window.devicePixelRatio || 1
      const lanesNow = lanesRef.current
      const lastKey = lanesNow.length === 0 ? null : laneKey(lanesNow[lanesNow.length - 1])
      // 組んでからの時計の進み。**余白を超えたら端で止める**（組み直しが遅れても、余白の外の空白を写さない）。
      const nowMs = serverNow()
      const shiftMs = presentShiftMs(timeline, nowMs)
      // **端で止まったまま待ち続けたら記録する。** 目盛りは写すたびに描くので、組み直しが止まっても絵は生きて見える。
      if (nowMs - timeline.nowMs > timeline.leadMs + COMPOSE_STALLED_MS) {
        warnThrottled('stalled', `[seismo] 下端の波形の組み直しが ${Math.round(nowMs - timeline.nowMs)} ms 止まっている`)
      }
      for (const [key, shown] of canvasRefs.current) {
        const back = backs.get(key)
        if (back === undefined) continue
        const ctx = shown.getContext('2d')
        if (ctx === null) {
          warnThrottled('context', `[seismo] 下端の波形を写せない: 画面の段（${key}）の描画面を取れない`)
          continue
        }
        const w = Math.max(1, Math.round(shown.clientWidth * dpr))
        const h = Math.max(1, Math.round(shown.clientHeight * dpr))
        if (shown.width !== w || shown.height !== h) {
          shown.width = w
          shown.height = h
        }
        ctx.clearRect(0, 0, w, h)
        const sx = presentSourceX(shiftMs, timeline.spanMs, shown.clientWidth, dpr)
        ctx.drawImage(back, sx, 0, w, back.height, 0, 0, w, h)
        if (key === lastKey) {
          const axisH = Math.round(AXIS_BAND_PX * dpr)
          paintTicks(ctx, liveTicks(shown.clientWidth, timeline.spanMs), w, Math.max(1, h - axisH), h, dpr)
        }
      }
    }

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      const composeDue = now - lastComposeAt >= COMPOSE_INTERVAL_MS || redrawNowRef.current
      if (!composeDue && now - lastFrameAt < FRAME_INTERVAL_MS - FRAME_SLACK_MS) return
      lastFrameAt = now
      // **組み立てと写しは別々に受け止める。** 組み立てが投げても、写しは直前の裏の絵で続ける
      // （まとめて受けると、写しも止まって絵が凍る）。輪は先頭で張り直してあるので止まらない。
      if (composeDue) {
        lastComposeAt = now
        redrawNowRef.current = false
        try {
          compose()
        } catch (e) {
          warnThrottled('compose', '[seismo] 下端の波形を組めなかった', e)
        }
      }
      try {
        present()
      } catch (e) {
        warnThrottled('present', '[seismo] 下端の波形を写せなかった', e)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const { tallyText, notice, stale, focus } = source
  const lastLane = lanes[lanes.length - 1]
  const headScale = lanes.length === 1 ? (scaleTexts[laneKey(lanes[0])] ?? null) : null

  return (
    <div className="w-full bg-black/70 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        {/* 寄せられる段は見出しをボタンにする（キーボードからも押せるように。名前は見出しの文字そのもの）。 */}
        {focus !== null ? (
          <button type="button" onClick={focus} className="text-white truncate max-w-32 roomy:max-w-56 hover:underline text-left leading-none">
            {source.title}
          </button>
        ) : (
          <span className="text-white truncate max-w-32 roomy:max-w-56">{source.title}</span>
        )}
        {showControls && <WaveAxisToggles />}
        {/* 右へ寄せる群。**途絶はいちばん右へ寄せず、数え上げと同じ列に並べる。** 起きていることの
            種類が違うだけで、どちらも「この絵をそのまま信じてよいか」の手掛かり。 */}
        <div className="ml-auto flex items-center gap-2 min-w-0">
          {stale && <span className="text-secondary">{STALE_LABEL}</span>}
          {notice !== null && <span className="text-secondary truncate">{notice}</span>}
          {tallyText !== null && <span className="text-secondary truncate">{tallyText}</span>}
          {/* 畳んでいるときだけ縦の範囲をここへ出す（展開したら段ごとに出す）。 */}
          {lanes.length === 1 && <span className="font-mono tabular-nums text-secondary">{headScale ?? '—'}</span>}
          {/* **記号だけ・ホバーの説明も付けない**（2026-10-13 ユーザー判断「押せば分かる」）。
              読み上げソフト向けの名前だけ持たせる（画面には出ない。2026-10-13 ユーザー承認）。 */}
          {showControls && (
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              aria-label={expanded ? '波形を畳む' : '波形を展開'}
              className="text-secondary hover:text-white leading-none"
            >
              {expanded ? '▲' : '▼'}
            </button>
          )}
        </div>
      </div>
      {/* 波形そのものを押しても寄せる（§0「波形を押すと地図がその観測点へ寄る」）。キーボードの入口は見出しのボタン。 */}
      <div className={`flex flex-col gap-0.5${focus !== null ? ' cursor-pointer' : ''}`} onClick={focus ?? undefined}>
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
