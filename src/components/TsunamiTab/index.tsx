import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import { formatDateTimeMin, formatTime } from '../../utils/formatters'
import { quakeEventKey } from '../../utils/quakeMerge'
import { groupAreasForCardDisplay, matchesArea } from '../../utils/tsunami'
import { mapChunksToRefs, planFollowScroll, type FollowRect, type SpeechFollowSession, type SpeechRef } from '../../utils/ttsFollow'
import { getSpeechClock } from '../../utils/voicevox'
import { INTERACTION_HOLD_SEC } from '../Map/gl/camera'
import { log } from '../../utils/logger'

export interface FocusedDistrict {
  // 今回の受信で変更（新規/更新）があった区域すべて。対象区域が特定できない受信では空配列
  districts: { code?: string; name?: string }[]
  // その中で波高が最大の区域（画面に収まらない場合はこれを一番上に配置する）。districts が空のときは null（一番上へ戻す）
  top: { code?: string; name?: string } | null
  ts: number
}

interface Props {
  tsunamis: JMATsunami[]
  earthquakes?: JMAQuake[]
  onEarthquakeLink?: (quakeKey: string) => void
  onObservationClick?: (name: string) => void
  focusedDistrict?: FocusedDistrict | null
  obsUpdateStatus?: Map<string, 'new' | 'updated'>
  /** 進行中の読み上げ。渡されるとカードが読み上げに追従する（`null` なら追従しない） */
  speechSession?: SpeechFollowSession | null
  /**
   * 津波タブが実際に見えているか。
   * タブは `invisible` で隠すだけなので、非表示でもスクロールは効いてしまう。
   */
  isVisible?: boolean
}

/** 追従用の行の登録キー。区域は code を優先し、無ければ名前で引く（`matchesArea` と同じ順序）。 */
function speechRowKeys(ref: SpeechRef): string[] {
  if (ref.kind === 'station') return [`station:${ref.name}`]
  return ref.code ? [`area:code:${ref.code}`, `area:name:${ref.name}`] : [`area:name:${ref.name}`]
}

type TsunamiGrade = TsunamiArea['grade']

interface GradeStyle {
  headerBg: string
  headerColor: string
  headerBorder: string
  cardBorder: string
  arrivalColor: string
  heightColor: string
}

function getGradeStyle(grade: TsunamiGrade): GradeStyle {
  switch (grade) {
    case 'MajorWarning':
      return { headerBg: '#2d0036', headerColor: '#e879f9', headerBorder: '#a855f7', cardBorder: '#a855f7', arrivalColor: '#a855f7', heightColor: '#e879f9' }
    case 'Warning':
      return { headerBg: '#450a0a', headerColor: '#fca5a5', headerBorder: '#ef4444', cardBorder: '#ef4444', arrivalColor: '#f87171', heightColor: '#fca5a5' }
    case 'Watch':
      return { headerBg: '#431407', headerColor: '#fdba74', headerBorder: '#f97316', cardBorder: '#f97316', arrivalColor: '#f97316', heightColor: '#fdba74' }
    case 'Forecast':
      return { headerBg: '#0c1a26', headerColor: '#67e8f9', headerBorder: '#0891b2', cardBorder: '#0891b2', arrivalColor: '#22d3ee', heightColor: '#67e8f9' }
    default:
      return { headerBg: '#1f2937', headerColor: '#9ca3af', headerBorder: '#4b5563', cardBorder: '#4b5563', arrivalColor: '#6b7280', heightColor: '#9ca3af' }
  }
}

const GRADE_LABEL: Record<TsunamiGrade, string> = {
  MajorWarning: '大津波警報',
  Warning:      '津波警報',
  Watch:        '津波注意報',
  Forecast:     '津波予報（若干の海面変動）',
  Unknown:      '不明',
}

const GRADE_ORDER: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch', 'Forecast', 'Unknown']

// 解除表示（cancelledAt セット中）の見出し・説明文・オーバーレイ短文を cancelReason ごとに出し分ける。
// 気象庁の運用上、警報・注意報は「解除」、誤発表は「取消」、予報は解除電文を伴わず「有効期間終了」で
// 静かに消えるため、それぞれ表現が異なる（Issue #2）。
const CANCEL_REASON_LABEL: Record<NonNullable<JMATsunami['cancelReason']>, { title: string; desc: string; badge: string }> = {
  lifted:    { title: '津波情報 解除',       badge: '解除', desc: 'この津波情報は解除されました' },
  retracted: { title: '津波情報 取消',       badge: '取消', desc: 'この津波情報は誤って発表されたため取り消されました' },
  expired:   { title: '津波予報 有効期間終了', badge: '終了', desc: 'この津波予報は有効期間が終了しました' },
}

// FocusedDistrict の区域識別子（code/name）を発表区域に紐づける。照合ルールは matchesArea と同じ。
function districtMatchesArea(district: { code?: string; name?: string }, area: TsunamiArea): boolean {
  if (district.code && area.code) return district.code === area.code
  return !!district.name && district.name === area.name
}

function TsunamiHeightHeader({ label, style }: { label: string; style: GradeStyle }) {
  return (
    <div className="px-3 py-1 font-black leading-none text-[1.125rem] roomy:px-4 roomy:text-[1.375rem]"
      style={{ color: style.heightColor, backgroundColor: `${style.cardBorder}14`, borderBottom: `1px solid ${style.cardBorder}33` }}>
      {label}
    </div>
  )
}

function TsunamiAreaRow({ area, observations, style, onObservationClick, isChanged, isTop, registerRow, registerSpeechRow, obsUpdateStatus }: { area: TsunamiArea; observations: TsunamiObservation[]; style: GradeStyle; onObservationClick?: (name: string) => void; isChanged: boolean; isTop: boolean; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: Map<string, 'new' | 'updated'> }) {
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    registerRow?.(area, isChanged, isTop, el)
    // 追従スクロールの引き当て用。focusedDistrict とは違い、変更の有無に関わらず全区域を登録する
    registerSpeechRow?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
  }, [registerRow, registerSpeechRow, area, isChanged, isTop])

  const arrivalText = area.firstHeight?.arrivalTime
    ? `到達予想 ${formatTime(area.firstHeight.arrivalTime).slice(0, 5)}`
    : (area.firstHeight?.condition ?? null)

  const stations = area.stations ?? []
  // 実測値がある観測点名のセット（到達済み判定・到達中バッジ抑制に使用）
  const observedNames = new Set(observations.map(o => o.name))
  // 区域内に1件でも実測値があれば到達中バッジは不要（実測行で代替できる）
  const showImmediateBadge = area.immediate && observations.length === 0

  return (
    <div ref={setRowRef} className="border-b border-white/5 last:border-0">
      <div className="flex items-center gap-2 px-3 py-2 roomy:gap-3 roomy:px-4 roomy:py-3">
        <div className="flex-1 min-w-0">
          <span className="text-white font-semibold block text-[1.0625rem] roomy:text-[1.25rem]" style={{ lineHeight: '1.2' }}>
            {area.name}
          </span>
          {arrivalText && (
            <span className="block mt-1" style={{ fontSize: '0.9375rem', color: style.arrivalColor }}>
              {arrivalText}
            </span>
          )}
        </div>
        {showImmediateBadge && (
          <span className="flex-shrink-0 text-xs font-bold px-2 py-1 rounded border"
            style={{ color: '#f87171', backgroundColor: 'rgba(239,68,68,0.15)', borderColor: '#ef4444' }}>
            到達中
          </span>
        )}
      </div>
      {/* 観測点ごとに実測・予測を統合して表示 */}
      {(observations.length > 0 || stations.length > 0) && (
        <div className="mx-4 mb-3 flex flex-col gap-1.5">
          {/* 実測値あり観測点 */}
          {observations.map((obs, i) => {
            const clickable = !!obs.height && !!onObservationClick
            const updateStatus = obsUpdateStatus?.get(obs.name)
            const borderLeftStyle = updateStatus === 'new'
              ? '3px solid #4ade80'
              : updateStatus === 'updated'
                ? '3px solid #fbbf24'
                : `1px solid ${style.cardBorder}38`
            return (
              <div
                key={i}
                /* 追従スクロールの引き当て用。読み上げが読むのは実測・到達確認の観測点だけなので、
                   下の「予測のみ」の行は登録しない（同名の行が 2 つあると引き当てが曖昧になる） */
                ref={el => registerSpeechRow?.([`station:${obs.name}`], el)}
                className={`px-3 py-2 rounded${clickable ? ' cursor-pointer hover:brightness-125 transition-[filter]' : ''}`}
                style={{ background: `${style.cardBorder}12`, border: `1px solid ${style.cardBorder}38`, borderLeft: borderLeftStyle }}
                onClick={clickable ? () => onObservationClick!(obs.name) : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onObservationClick!(obs.name) } : undefined}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold" style={{ fontSize: '0.8125rem', color: style.heightColor }}>{obs.name}</span>
                      <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: `${style.cardBorder}30`, color: style.heightColor }}>
                        {obs.height ? '実測' : '到達確認'}
                      </span>
                    </div>
                    <div className="mt-1" style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
                      {obs.arrivalTime && `${formatTime(obs.arrivalTime).slice(0, 5)}${obs.initial ? ` ${obs.initial}波` : ''}`}
                      {/* 同名 station があれば満潮時刻をここに表示 */}
                      {(() => {
                        const matched = stations.find(s => s.name === obs.name)
                        return matched?.highTideDateTime ? `　満潮 ${formatTime(matched.highTideDateTime).slice(0, 5)}` : null
                      })()}
                    </div>
                  </div>
                  {obs.height ? (
                    <span className="font-bold flex-shrink-0" style={{ fontSize: '1.25rem', color: style.heightColor }}>{obs.height.description}</span>
                  ) : (
                    <span className="flex-shrink-0" style={{ fontSize: '0.8125rem', color: '#9ca3af' }}>観測中</span>
                  )}
                </div>
              </div>
            )
          })}
          {/* 実測値なし観測点（station のみ） */}
          {stations.filter(s => !observedNames.has(s.name)).map((st, i) => (
            <div key={i} className="px-3 py-2 rounded" style={{ border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.03)' }}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-semibold" style={{ fontSize: '0.8125rem', color: '#d1d5db' }}>{st.name}</span>
                <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)', color: '#9ca3af' }}>予測</span>
              </div>
              <div className="mt-1" style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
                {st.arrivalTime && `到達 ${formatTime(st.arrivalTime).slice(0, 5)}`}
                {st.highTideDateTime && `　満潮 ${formatTime(st.highTideDateTime).slice(0, 5)}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TsunamiObservationRow({ obs, onObservationClick }: { obs: TsunamiObservation; onObservationClick?: (name: string) => void }) {
  const clickable = !!obs.height && !!onObservationClick
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-b border-white/5 last:border-0 roomy:gap-3 roomy:px-4 roomy:py-3${clickable ? ' cursor-pointer hover:brightness-125 transition-[filter]' : ''}`}
      onClick={clickable ? () => onObservationClick!(obs.name) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onObservationClick!(obs.name) } : undefined}
    >
      <div className="flex-1 min-w-0">
        <span className="text-white font-semibold block text-[1rem] roomy:text-[1.125rem]">
          {obs.name}
        </span>
        {obs.arrivalTime && (
          <span className="block mt-1 text-secondary" style={{ fontSize: '0.8125rem' }}>
            到達: {formatTime(obs.arrivalTime).slice(0, 5)}{obs.initial ? `（${obs.initial}）` : ''}
          </span>
        )}
      </div>
      {obs.height && (
        <span className="text-secondary flex-shrink-0" style={{ fontSize: '1rem' }}>
          {obs.height.description}
        </span>
      )}
    </div>
  )
}

function TsunamiGradeCard({ grade, areas, observations, onObservationClick, focusedDistrict, registerRow, registerSpeechRow, obsUpdateStatus }: { grade: TsunamiGrade; areas: TsunamiArea[]; observations: TsunamiObservation[]; onObservationClick?: (name: string) => void; focusedDistrict?: FocusedDistrict | null; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: Map<string, 'new' | 'updated'> }) {
  if (areas.length === 0) return null
  const style = getGradeStyle(grade)
  const groups = groupAreasForCardDisplay(areas, observations)
  return (
    <div className="bg-card rounded-lg overflow-hidden"
      style={{ border: `2px solid ${style.cardBorder}`, boxShadow: `0 0 0 1px ${style.cardBorder}40` }}>
      <div className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
        style={{ backgroundColor: style.headerBg, color: style.headerColor, borderBottom: `1px solid ${style.headerBorder}` }}>
        {GRADE_LABEL[grade]}
      </div>
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.heightLabel && <TsunamiHeightHeader label={group.heightLabel} style={style} />}
          {group.areas.map((area, i) => (
            <TsunamiAreaRow
              key={i}
              area={area}
              observations={observations.filter(o => matchesArea(o, area))}
              style={style}
              onObservationClick={onObservationClick}
              isChanged={focusedDistrict?.districts.some(d => districtMatchesArea(d, area)) ?? false}
              isTop={focusedDistrict?.top != null && districtMatchesArea(focusedDistrict.top, area)}
              registerRow={registerRow}
              registerSpeechRow={registerSpeechRow}
              obsUpdateStatus={obsUpdateStatus}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function getTopGrade(tsunamis: JMATsunami[]): TsunamiGrade {
  for (const grade of GRADE_ORDER) {
    if (tsunamis.some(t => t.areas.some(a => a.grade === grade))) return grade
  }
  return 'Unknown'
}

// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const TsunamiTab = memo(function TsunamiTab({ tsunamis, earthquakes, onEarthquakeLink, onObservationClick, focusedDistrict, obsUpdateStatus, speechSession, isVisible }: Props) {
  // cancelledAt がある = 10秒表示中なので active に含める
  const active = tsunamis.filter(t => !t.cancelled || t.cancelledAt)

  // sticky バナーの実高さを測り、自動スクロール先の scroll-margin-top に反映する
  // （バナーは発令中/解除・地震カードリンクの有無で行数が変わり高さが可変のため固定値では合わない）
  // 「津波情報なし」表示から実データ表示への切替でバナー要素自体が生成し直されるため、
  // useRef + 空配列 useEffect ではなく callback ref で mount のたびに監視し直す
  const bannerObserverRef = useRef<ResizeObserver | null>(null)
  const [bannerHeight, setBannerHeight] = useState(0)

  const bannerRef = useCallback((el: HTMLDivElement | null) => {
    bannerObserverRef.current?.disconnect()
    bannerObserverRef.current = null
    if (!el) return
    // contentRect は padding を含まない content-box。バナーには pt-3 の padding があるため
    // 実際の占有高さ（border-box）は getBoundingClientRect で測る
    const observer = new ResizeObserver(() => {
      setBannerHeight(el.getBoundingClientRect().height)
    })
    observer.observe(el)
    bannerObserverRef.current = observer
  }, [])

  // 今回変更された区域の行DOM（area.code ?? area.name をキーに登録・登録解除される）
  const changedRowElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const topRowElRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const registerRow = useCallback((area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => {
    const key = area.code ?? area.name ?? ''
    if (el && isChanged) changedRowElsRef.current.set(key, el)
    else changedRowElsRef.current.delete(key)
    if (isTop) topRowElRef.current = el
  }, [])

  // 読み上げ追従の引き当て表（キーの作り方は speechRowKeys）。区域は変更の有無に関わらず全件、
  // 観測点は実測・到達確認の行だけを持つ。
  const speechRowElsRef = useRef<Map<string, HTMLElement>>(new Map())
  const registerSpeechRow = useCallback((keys: string[], el: HTMLElement | null) => {
    for (const key of keys) {
      if (el) speechRowElsRef.current.set(key, el)
      else speechRowElsRef.current.delete(key)
    }
  }, [])

  // 手で動かしたあとは追従を止める。地図の自動フィットと同じ考え方で、同じ保持時間を使う。
  //
  // 拾うのは `wheel` と `touchstart` の 2 つだけ。`scroll` は自分の `scrollTo` が撒くので
  // 使えない（自動と手動を区別する仕組みが別に必要になる）。`pointerdown` も採らない
  // ―― 観測点行のクリックは地図を寄せるための正当な操作で、それで追従が 30 秒止まるのは筋が
  // 違う（地図側のガードも「実際に視点が動いた」`zoomstart`/`dragstart` だけを見ていて
  // クリックは拾わない）。スクロールバーのドラッグとブラウザ内検索は取りこぼす。
  //
  // ref ではなく state で持つのは、保持が明けた瞬間に追従側の effect を起こし直すため
  // （CameraFollowsGL の useUserInteractionGuard と同じ理由）。
  const [userScrollHold, setUserScrollHold] = useState(false)
  const userHoldTimerRef = useRef<number | undefined>(undefined)
  const hasCards = active.length > 0
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onInteract = () => {
      setUserScrollHold(true)
      window.clearTimeout(userHoldTimerRef.current)
      userHoldTimerRef.current = window.setTimeout(() => setUserScrollHold(false), INTERACTION_HOLD_SEC * 1000)
    }
    container.addEventListener('wheel', onInteract, { passive: true })
    container.addEventListener('touchstart', onInteract, { passive: true })
    return () => {
      container.removeEventListener('wheel', onInteract)
      container.removeEventListener('touchstart', onInteract)
    }
  }, [hasCards])
  useEffect(() => () => window.clearTimeout(userHoldTimerRef.current), [])

  // 読み上げ追従が動いている間は受信時スクロールを見送るための印（下の effect が読む）
  const followActiveRef = useRef(false)

  // 追従の進み具合。**読み上げ 1 本（`token`）に紐づけて持つ。** 追従の effect は
  // `isVisible` などの変化でも作り直されるため、ここに置かないと途中で記憶が失われる。
  const followProgressRef = useRef<{
    token: number
    /** 一度画面に出した箇所（読み直されても追わないための記録） */
    shownKeys: Set<string>
    lastIndex: number
    /** smooth スクロールの行き先。着くまでは判定の基準をこちらにする */
    targetScrollTop: number | null
    resolvedAny: boolean
    sawChunk: boolean
  } | null>(null)

  /**
   * 読み上げに合わせてカードを送る。
   *
   * 現在位置の解決を rAF で回しているのは、voicevox が渡すのが「予約」（`startAt` は
   * AudioContext の時間軸で未来を指す）だから。チャンクごとに `setTimeout` を張る形にすると、
   * バックグラウンドのタブでタイマーが間引かれる一方で音は実時間で鳴り終わり、滞留した
   * タイマーが後から発火して追従の状態が残る。rAF なら非表示中は止まり、戻ったときに
   * 一発で正しい位置へ収束する。
   */
  useEffect(() => {
    const session = speechSession
    if (!session || !isVisible || userScrollHold) {
      followActiveRef.current = false
      return
    }

    // **進み具合はセッション単位で持つ（effect のローカルにしない）。** この effect は
    // `isVisible` / `userScrollHold` / `bannerHeight` の変化でも作り直される。ローカルに
    // 置くと、読み上げの途中で手を触れたりバナーの高さが変わったりするたびに「一度出した箇所」の
    // 記憶が消え、消したはずの往復スクロールが戻ってくる。
    if (followProgressRef.current?.token !== session.token) {
      followProgressRef.current = {
        token: session.token,
        shownKeys: new Set<string>(),
        lastIndex: -1,
        targetScrollTop: null,
        resolvedAny: false,
        sawChunk: false,
      }
    }
    const progress = followProgressRef.current

    let raf = 0
    let refsPerChunk: SpeechRef[][] | null = null
    let mappedChunks: readonly string[] | null = null

    const rowFor = (ref: SpeechRef): HTMLElement | null => {
      for (const key of speechRowKeys(ref)) {
        const el = speechRowElsRef.current.get(key)
        if (el) return el
      }
      return null
    }

    // 差し替えで DOM から外れた要素は矩形が全 0 になる。そのまま使うと巨大なスクロールになる
    const rectsFor = (refs: readonly SpeechRef[], offset: number): FollowRect[] => {
      const rects: FollowRect[] = []
      for (const ref of refs) {
        const el = rowFor(ref)
        if (!el || !el.isConnected) continue
        const r = el.getBoundingClientRect()
        if (r.height <= 0) continue
        rects.push({ top: r.top - offset, bottom: r.bottom - offset })
      }
      return rects
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const container = containerRef.current
      if (!container || !session.chunks || session.schedule.length === 0) return

      // チャンクと参照の対応は 1 度だけ求める（チャンク列は読み上げの途中で変わらない）
      if (refsPerChunk === null || mappedChunks !== session.chunks) {
        mappedChunks = session.chunks
        refsPerChunk = mapChunksToRefs(session.segments, session.chunks)
      }

      const now = getSpeechClock()
      if (now === null) return
      // 鳴り始めた予約のうち最後のものが「いま読んでいるチャンク」。schedule は届いた順＝
      // startAt の昇順に積まれる
      let currentIndex = -1
      for (const entry of session.schedule) {
        if (entry.startAt > now) break
        currentIndex = entry.index
      }
      if (currentIndex < 0) return
      progress.sawChunk = true

      // 行き先に着いたら基準を現在位置へ戻す
      if (progress.targetScrollTop !== null
        && Math.abs(container.scrollTop - progress.targetScrollTop) < 2) {
        progress.targetScrollTop = null
      }
      if (currentIndex === progress.lastIndex) return
      progress.lastIndex = currentIndex

      const currentRefs = refsPerChunk[currentIndex] ?? []
      if (currentRefs.length === 0) return

      // **一度出した箇所は読み直されても追わない。** 発表・引き上げ・引き下げの読み上げは
      // 「区域を列挙 → 予想最大波高で同じ区域をもう一周」の形で、同じ区域を 1 回の読み上げで
      // 2 回読む（`tsunamiHeightSentence`）。2 周目に付き合うと、1 周目で見せた場所へ戻って
      // すぐ下がる往復になる（実測: 大津波警報テストで 1.5 秒のうちに 654→74→654）。
      // 1 周目で見せているので、追わなくても伝わっていないものは無い。
      const firstSeen = currentRefs.filter(ref => !progress.shownKeys.has(speechRowKeys(ref)[0]))
      for (const ref of currentRefs) progress.shownKeys.add(speechRowKeys(ref)[0])
      if (firstSeen.length === 0) return

      // これから読む箇所（この先のチャンクを読み上げ順に）
      const upcomingRefs: SpeechRef[] = []
      for (let i = currentIndex + 1; i < refsPerChunk.length; i++) {
        upcomingRefs.push(...refsPerChunk[i])
      }

      const containerRect = container.getBoundingClientRect()
      // 矩形は「行き先」から見た位置に直す。scrollTop が増えると要素は上へ動くので、
      // 進む量ぶん引く（コンテナ自身は動かないので視野はそのまま）。
      const base = progress.targetScrollTop ?? container.scrollTop
      const offset = base - container.scrollTop
      const currentRects = rectsFor(currentRefs, offset)
      // **行を引き当てられないうちは受け持ったことにしない。** 区域コードや観測点名が
      // 食い違って一度も引けない読み上げでも、無条件に印を立てると受信時スクロール
      // （変更区域へ寄せるフォールバック）まで道連れで止まり、画面が一切動かなくなる。
      if (currentRects.length === 0) return
      followActiveRef.current = true
      progress.resolvedAny = true

      const next = planFollowScroll({
        viewTop: containerRect.top + bannerHeight,
        viewBottom: containerRect.bottom,
        currentRects,
        upcomingRects: rectsFor(upcomingRefs, offset),
        currentScrollTop: base,
        maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
      })
      if (next === null) return

      progress.targetScrollTop = next
      container.scrollTo({ top: next, behavior: 'smooth' })
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      followActiveRef.current = false
    }
  }, [speechSession, isVisible, userScrollHold, bannerHeight])

  // 読み上げが終わったところで、追従が仕事をできたかを振り返る。
  //
  // 上の effect のクリーンアップではなく**セッションの終わり**で見るのは、あちらが
  // `isVisible` などの変化でも作り直されるため。作り直しのたびに評価すると、タブを離れた
  // だけで「引き当てられなかった」と言い出す。
  useEffect(() => {
    if (speechSession) return
    const last = followProgressRef.current
    followProgressRef.current = null
    // チャンクは鳴ったのに引き当てが 0 件だったときだけ残す。読み上げは出ているのに画面が
    // 動かない状態で、症状（動かない）からは追従の不具合と表示の不具合を区別できない。
    // 区域コード・観測点名の食い違い（`matchesArea` が想定している経路）を疑う手がかり。
    if (last?.sawChunk && !last.resolvedAny) {
      log.warn('[tsunami] 読み上げ追従: 対象の行を一度も引き当てられなかった')
    }
  }, [speechSession])

  // 変更区域が画面に収まるならまとめて見えるように、収まらなければ波高最大の区域が
  // ヘッダー直下に来るようにスクロールする
  useEffect(() => {
    if (!focusedDistrict) return
    const container = containerRef.current
    if (!container) return
    // 読み上げ追従が動いている間は見送る。**読み上げは数十秒続く**（区域が多い大津波警報で
    // 30 チャンク超）ため、その最中に届いた続報でここが動くと、いま読んでいる箇所から
    // 引き剥がしたうえで、次のチャンクで追従が引き戻す。声と画面が一致している側を優先する。
    if (followActiveRef.current) return
    // 対象区域が特定できない受信（区域のみの発表・実質変化なしの続報・解除）は一番上へ戻す
    if (focusedDistrict.districts.length === 0) {
      container.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const changedEls = Array.from(changedRowElsRef.current.values())
    if (changedEls.length === 0) return

    const containerRect = container.getBoundingClientRect()
    const viewTop = containerRect.top + bannerHeight
    const viewBottom = containerRect.bottom
    const availableHeight = viewBottom - viewTop

    const tops = changedEls.map(el => el.getBoundingClientRect().top)
    const bottoms = changedEls.map(el => el.getBoundingClientRect().bottom)
    const spanTop = Math.min(...tops)
    const spanBottom = Math.max(...bottoms)
    const spanHeight = spanBottom - spanTop

    let delta = 0
    if (spanHeight <= availableHeight) {
      if (spanTop < viewTop) delta = spanTop - viewTop
      else if (spanBottom > viewBottom) delta = spanBottom - viewBottom
    } else if (topRowElRef.current) {
      delta = topRowElRef.current.getBoundingClientRect().top - viewTop
    }

    if (Math.abs(delta) > 1) {
      container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' })
    }
  // focusedDistrict.ts を依存にすることで同一区域の再フォーカスも発火する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedDistrict?.ts, bannerHeight])

  if (active.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(20,83,45,0.5)', border: '2px solid #16a34a' }}>
          <span className="text-3xl">🌊</span>
        </div>
        <div className="text-center">
          <p className="text-green-400 font-bold">津波情報はありません</p>
          <p className="text-secondary text-sm mt-1">現在、津波警報・注意報は発表されていません。</p>
        </div>
      </div>
    )
  }

  const isCancelledDisplay = active.every(t => !!t.cancelledAt)
  const topGrade = getTopGrade(active)
  const topStyle = getGradeStyle(topGrade)
  const cancelInfo = CANCEL_REASON_LABEL[active[0]?.cancelReason ?? 'lifted']
  const latestTime = active[0]?.time
  const sourceEarthquake = active[0]?.sourceEarthquake

  // 津波の原因地震に対応する地震カードを eventId で照合する
  const tsunamiEventId = active[0]?.eventId
  const linkedQuake = (tsunamiEventId && earthquakes)
    ? earthquakes.find(q => q.eventId === tsunamiEventId && !q.cancelledAt)
    : undefined

  // h-full を持つ下記の要素自身がスクロール領域になるため、横スクロールの抑止は
  // App.tsx の TAB_SCROLLER_CLASS ではなくここで行う（祖先の指定は子に効かない）。
  return (
    <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden overscroll-x-none">
      {/* 発令中 / 解除バナー（sticky で常時表示）。対応する地震カードがある場合のみクリック可能。 */}
      <div ref={bannerRef} className="sticky top-0 z-10 px-3 pt-3">
        <div
          role={linkedQuake ? 'button' : undefined}
          tabIndex={linkedQuake ? 0 : undefined}
          onClick={linkedQuake ? () => onEarthquakeLink?.(quakeEventKey(linkedQuake)) : undefined}
          onKeyDown={linkedQuake ? (e) => { if (e.key === 'Enter' || e.key === ' ') onEarthquakeLink?.(quakeEventKey(linkedQuake)) } : undefined}
          className={`rounded-lg overflow-hidden${linkedQuake ? ' cursor-pointer hover:opacity-90 transition-opacity' : ''}`}
          style={{ background: isCancelledDisplay ? '#1a1a1a' : topStyle.headerBg, border: `2px solid ${isCancelledDisplay ? '#4b5563' : topStyle.cardBorder}` }}>
          <div className="px-3 py-2 roomy:px-4 roomy:py-3"
            style={{ background: isCancelledDisplay ? 'rgba(75,85,99,0.18)' : `${topStyle.cardBorder}18` }}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold" style={{ fontSize: '0.875rem', color: isCancelledDisplay ? '#9ca3af' : topStyle.headerColor }}>
                {isCancelledDisplay ? cancelInfo.title : `${GRADE_LABEL[topGrade]} 発令中`}
              </div>
              {latestTime && (
                <div className="text-right flex-shrink-0" style={{ fontSize: '0.6875rem', color: isCancelledDisplay ? '#6b7280' : topStyle.arrivalColor, opacity: 0.8 }}>
                  {formatDateTimeMin(latestTime)} 更新
                </div>
              )}
            </div>
            <div className="mt-1" style={{ fontSize: '0.6875rem', color: isCancelledDisplay ? '#6b7280' : topStyle.headerColor, opacity: 0.8 }}>
              {isCancelledDisplay ? cancelInfo.desc : topGrade === 'Forecast' ? '若干の海面変動があるかもしれません' : '海岸・河川から直ちに離れてください'}
            </div>
            {!isCancelledDisplay && sourceEarthquake && (
              <div className="mt-1.5 pt-1.5" style={{ fontSize: '0.6875rem', color: topStyle.arrivalColor, opacity: 0.9, borderTop: `1px solid ${topStyle.cardBorder}40` }}>
                震源: {sourceEarthquake.hypocenterName}
                {sourceEarthquake.magnitude !== undefined && `　M${sourceEarthquake.magnitude}`}
                {sourceEarthquake.originTime && `　${formatTime(sourceEarthquake.originTime).slice(0, 5)}発生`}
                {linkedQuake && <span style={{ marginLeft: '0.375rem', fontSize: '0.625rem', opacity: 0.7 }}>▶ 地震情報</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-2 flex flex-col gap-2 roomy:p-3 roomy:gap-3">
      {active.map(t => {
        const observations = t.observations ?? []
        const unmatched = observations.filter(o => !t.areas.some(a => matchesArea(o, a)))
        return (
          <div key={t.id} className="flex flex-col gap-3 relative">
            {t.cancelledAt && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg" style={{ minHeight: '5rem' }}>
                <span className="font-black text-white" style={{ fontSize: '2.5rem', lineHeight: 1.1 }}>{cancelInfo.badge}</span>
                <span className="text-sm font-bold text-white/90 mt-1">{cancelInfo.desc}</span>
              </div>
            )}
            {GRADE_ORDER.map(grade => (
              <TsunamiGradeCard
                key={grade}
                grade={grade}
                areas={t.areas.filter(a => a.grade === grade)}
                observations={observations}
                onObservationClick={onObservationClick}
                focusedDistrict={focusedDistrict}
                registerRow={registerRow}
                registerSpeechRow={registerSpeechRow}
                obsUpdateStatus={obsUpdateStatus}
              />
            ))}
            {unmatched.length > 0 && (
              <div className="bg-card rounded-lg overflow-hidden"
                style={{ border: '2px solid #1d4ed8', boxShadow: '0 0 0 1px rgba(29,78,216,0.25)' }}>
                <div className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
                  style={{ backgroundColor: '#0c1a3a', color: '#93c5fd', borderBottom: '1px solid #1d4ed8' }}>
                  沖合観測
                </div>
                {unmatched.map((obs, i) => (
                  <TsunamiObservationRow key={i} obs={obs} onObservationClick={onObservationClick} />
                ))}
              </div>
            )}
            {t.warningComment && !t.cancelledAt && (
              <div className="bg-card rounded-lg overflow-hidden" style={{ border: '1px solid #374151' }}>
                <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: '1.7', whiteSpace: 'pre-line', padding: '0.75rem 1rem' }}>
                  {t.warningComment}
                </div>
              </div>
            )}
          </div>
        )
      })}
      </div>
    </div>
  )
})
