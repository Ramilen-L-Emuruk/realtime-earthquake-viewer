import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import { formatDateTimeMin, formatTime } from '../../utils/formatters'
import { quakeEventKey } from '../../utils/quakeMerge'
import { groupAreasForCardDisplay, matchesArea, overSuffixedHeight } from '../../utils/tsunami'
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
  /**
   * 読み上げが有効か。**有効なら受信時スクロールを行わず、読み上げ追従に任せる。**
   *
   * 受信時スクロールは電文が届いた瞬間に「変わった区域」へ寄せるが、読み上げが始まるのは
   * その 0.8〜4.2 秒後（通知音との間隔）。両方が働くと、先に区域へ寄ってから追従が等級カードの
   * 頭へ引き戻す、という逆向きの動きが見える。読み上げがあるなら声と画面を一致させる側に
   * 任せる（読み上げがある経路は順序の判断を読み上げ側に預ける、という既存の方針に揃える）。
   */
  speechFollowEnabled?: boolean
  /**
   * 津波タブを自動で見せた回数。**増えるたびにスクロールを先頭へ戻す。**
   *
   * 別のタブへ移ったあと続報やアイドル復帰で連れ戻されると、前に見ていた途中の位置が
   * 残ったまま表示される。自動で見せる以上は先頭（最も重い等級のカード）から見せる。
   * 手動で開いたときは増えないので、自分でスクロールした位置は保たれる。
   *
   * **これは最も弱い層。** 同じ受信で受信時スクロールや読み上げ追従が動くならそちらが
   * 上書きする（先頭へ戻すのは `useLayoutEffect`、他は `useEffect` と rAF なので必ず後）。
   */
  autoShowTick?: number
}

/**
 * 読み上げが有効なとき、受信時スクロールが追従を待つ時間。
 *
 * 声が出るまでには「通知音を鳴らし終える間隔」（`TTS_DELAY_MS`。大津波警報は 4.2 秒）に
 * 読み上げの待ち行列と合成の時間が積み上がる。**実測では受信から 13 秒後**に最初の追従が
 * 動いた（大津波警報テスト）ので、それより余裕を持たせる。短すぎると、正常に読み上げられる
 * 場面でも受信時スクロールが先に動いて往復が見える ―― この機能で消したかったものそのもの。
 *
 * 長く取ることの代償は「読み上げが成立しなかったときに待たされる時間」だけ。塞いでしまう
 * （永久に待つ）のに比べれば軽い。
 */
const SPEECH_FOLLOW_GRACE_MS = 20000

/** 追従用の行の登録キー。区域は code を優先し、無ければ名前で引く（`matchesArea` と同じ順序）。 */
function speechRowKeys(ref: SpeechRef): string[] {
  if (ref.kind === 'grade') return [`grade:${ref.grade}`]
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
                    <span className="font-bold flex-shrink-0" style={{ fontSize: '1.25rem', color: style.heightColor }}>{overSuffixedHeight(obs.height)}</span>
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
          {overSuffixedHeight(obs.height)}
        </span>
      )}
    </div>
  )
}

function TsunamiGradeCard({ grade, areas, observations, onObservationClick, focusedDistrict, registerRow, registerSpeechRow, registerSpeechAnchor, obsUpdateStatus }: { grade: TsunamiGrade; areas: TsunamiArea[]; observations: TsunamiObservation[]; onObservationClick?: (name: string) => void; focusedDistrict?: FocusedDistrict | null; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; registerSpeechAnchor?: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: Map<string, 'new' | 'updated'> }) {
  if (areas.length === 0) return null
  const style = getGradeStyle(grade)
  const groups = groupAreasForCardDisplay(areas, observations)
  return (
    /* 等級を告げたときの合わせ先は**カード全体**。帯だけを見ると、帯が視野の下端に映って
       いるだけで「収まっている」と判定して動かない ―― それでは等級を言った時点でカードの頭に
       来ない。全体を範囲にすれば視野に収まらない限り送られ、上端（＝帯）に揃う。 */
    <div ref={el => registerSpeechRow?.(speechRowKeys({ kind: 'grade', grade }), el)}
      className="bg-card rounded-lg overflow-hidden"
      style={{ border: `2px solid ${style.cardBorder}`, boxShadow: `0 0 0 1px ${style.cardBorder}40` }}>
      {/* 区域を読むときの合わせ先はこの帯（どの等級の話かが視野から消えないように） */}
      <div ref={el => {
        for (const area of areas) {
          registerSpeechAnchor?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
        }
      }}
        className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
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
export const TsunamiTab = memo(function TsunamiTab({ tsunamis, earthquakes, onEarthquakeLink, onObservationClick, focusedDistrict, obsUpdateStatus, speechSession, isVisible, speechFollowEnabled, autoShowTick }: Props) {
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

  // 区域キー → その区域が属する**等級カードの頭**（「大津波警報」の帯）。
  //
  // 区域を読んで動くときの行き先をここに揃える。区域行だけを基準にすると、その区域が
  // 画面の上端に来るように送られ、**どの等級の話をしているのかが視野から消える**。カードの頭を
  // 範囲に含めれば上端がそこになり、等級・波高見出し・区域が上から順に収まる。
  const speechAnchorElsRef = useRef<Map<string, HTMLElement>>(new Map())
  const registerSpeechAnchor = useCallback((keys: string[], el: HTMLElement | null) => {
    for (const key of keys) {
      if (el) speechAnchorElsRef.current.set(key, el)
      else speechAnchorElsRef.current.delete(key)
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
  // 先頭復帰（`autoShowTick`）からも読む。あちらは保持の明けで動き直してはいけないので
  // （明けた瞬間に画面が飛ぶ）、state を依存に取らず ref で今の値だけを見る。
  const userScrollHoldRef = useRef(false)
  userScrollHoldRef.current = userScrollHold
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

  /**
   * 追従が最後に「読んでいる箇所を引き当てた」時刻（受信時スクロールが読む）。
   *
   * **真偽値ではなく時刻で持つ。** 真偽値だと読み上げが終わった時点で落ちるため、そのあと
   * 受信時スクロールの猶予が明けたときに「追従は働かなかった」と誤って判断し、読み終えた
   * カードを区域へ寄せ直してしまう。受信（`focusedDistrict.ts`）より後に追従が動いていれば
   * その受信は追従が受け持ったと見なせる。
   */
  const followHandledAtRef = useRef(0)

  // 追従の進み具合。**読み上げ 1 本（`token`）に紐づけて持つ。** 追従の effect は
  // `isVisible` などの変化でも作り直されるため、ここに置かないと途中で記憶が失われる。
  const followProgressRef = useRef<{
    token: number
    lastIndex: number
    /** smooth スクロールの行き先。着くまでは判定の基準をこちらにする */
    targetScrollTop: number | null
    /**
     * 区域・観測点の行を一度でも引き当てられたか（診断用）。
     * **等級は数えない。** 理由は下の `sawRowRef` を立てている箇所のコメント。
     */
    resolvedAny: boolean
    /** 区域・観測点を指すチャンクが一度でもあったか（診断用。無ければ引けなくて当然） */
    sawRowRef: boolean
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
    if (!session || !isVisible || userScrollHold) return

    // **進み具合はセッション単位で持つ（effect のローカルにしない）。** この effect は
    // `isVisible` / `userScrollHold` / `bannerHeight` の変化でも作り直される。ローカルに
    // 置くと、読み上げの途中で手を触れたりバナーの高さが変わったりするたびに「一度出した箇所」の
    // 記憶が消え、消したはずの往復スクロールが戻ってくる。
    if (followProgressRef.current?.token !== session.token) {
      followProgressRef.current = {
        token: session.token,
        lastIndex: -1,
        targetScrollTop: null,
        resolvedAny: false,
        sawRowRef: false,
      }
    }
    const progress = followProgressRef.current

    let raf = 0
    let refsPerChunk: SpeechRef[][] | null = null
    let mappedChunks: readonly string[] | null = null

    const lookup = (table: Map<string, HTMLElement>, ref: SpeechRef): HTMLElement | null => {
      for (const key of speechRowKeys(ref)) {
        const el = table.get(key)
        if (el) return el
      }
      return null
    }

    /**
     * 読んでいる箇所そのものが占める要素。
     * 等級はカードの頭、観測点は区域行の内側なので、いずれも 1 つで足りる。
     */
    const rowElementFor = (ref: SpeechRef): HTMLElement | null =>
      lookup(speechRowElsRef.current, ref)

    /**
     * 併せて視野に入れたい前置き。区域では**その等級カードの頭**。
     *
     * 区域行だけを上端に合わせると、どの等級の話をしているのかが視野から消える。ただし
     * これを「読んでいる箇所」に混ぜてはいけない。混ぜると送り先の上端が常にカードの頭に
     * なり、等級のところで一度寄せた後は区域行がどれだけ見切れていても動かなくなる
     * （`planFollowScroll` の JSDoc 参照）。前置きとして別に渡し、収まるときだけ含める。
     */
    const contextElementFor = (ref: SpeechRef): HTMLElement | null =>
      ref.kind === 'area' ? lookup(speechAnchorElsRef.current, ref) : null

    // 差し替えで DOM から外れた要素は矩形が全 0 になる。そのまま使うと巨大なスクロールになる
    const rectsFor = (
      refs: readonly SpeechRef[],
      offset: number,
      pick: (ref: SpeechRef) => HTMLElement | null,
    ): FollowRect[] => {
      const rects: FollowRect[] = []
      for (const ref of refs) {
        const el = pick(ref)
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

      // 行き先に着いたら基準を現在位置へ戻す
      if (progress.targetScrollTop !== null
        && Math.abs(container.scrollTop - progress.targetScrollTop) < 2) {
        progress.targetScrollTop = null
      }
      if (currentIndex === progress.lastIndex) return
      progress.lastIndex = currentIndex

      const currentRefs = refsPerChunk[currentIndex] ?? []
      if (currentRefs.length === 0) return

      // **同じ箇所を読み直す文は無い前提に立っている。** 読み上げは区域名を 1 回だけ出す
      // （区域と波高を 1 文で言い切る。→ `ttsText` の `areaHeightSentence`）。かつては
      // 「区域を列挙 → 予想最大波高でもう一周」の形で同じ区域を 2 回読んでいて、2 周目に
      // 付き合うと 1 周目で見せた場所へ戻ってすぐ下がる往復になったため、出した箇所を
      // 記録して追わない仕掛けを置いていた。文面を変えて重複が無くなったので外してある。
      // **読み上げ文を「同じ区域を 2 回読む」形に戻すなら、ここも戻すこと。**

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
      const currentRects = rectsFor(currentRefs, offset, rowElementFor)

      // 診断の集計。**等級（`grade`）は数えない。**
      //
      // 等級のカードは全等級ぶん常に登録されていて、電文の中身に依らず必ず引ける。読み上げ文は
      // 必ず等級の宣言から始まるので、これを成功に数えると `resolvedAny` が毎回 true になり、
      // 続く区域・観測点が 1 件も引けなくても下の警告が出なくなる。区域コードの食い違いを
      // 見つけるために置いた診断が、静かに死ぬ。前置き（カードの頭）を数えないのも同じ理由。
      if (currentRefs.some(r => r.kind !== 'grade')) {
        progress.sawRowRef = true
        if (currentRects.length > 0) progress.resolvedAny = true
      }

      // **行を引き当てられないうちは受け持ったことにしない。** 区域コードや観測点名が
      // 食い違って一度も引けない読み上げでも、無条件に印を立てると受信時スクロール
      // （変更区域へ寄せるフォールバック）まで道連れで止まり、画面が一切動かなくなる。
      if (currentRects.length === 0) return
      followHandledAtRef.current = Date.now()

      const next = planFollowScroll({
        viewTop: containerRect.top + bannerHeight,
        viewBottom: containerRect.bottom,
        currentRects,
        contextRects: rectsFor(currentRefs, offset, contextElementFor),
        upcomingRects: rectsFor(upcomingRefs, offset, rowElementFor),
        currentScrollTop: base,
        maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
      })
      if (next === null) return

      progress.targetScrollTop = next
      container.scrollTo({ top: next, behavior: 'smooth' })
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
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
    // **区域・観測点を読んだのに、その行を一度も引き当てられなかったときだけ残す。**
    //
    // 読み始めた直後にタブを離れると、追従の rAF が止まって以降のチャンクを見ないため、
    // 引き当ての失敗と区別できずに出ることがある（ログのノイズに留まる既知の限界）。
    // 読み上げは出ているのに画面が動かない状態で、症状（動かない）からは追従の不具合と表示の
    // 不具合を区別できない。区域コード・観測点名の食い違い（`matchesArea` が想定している経路）
    // を疑う手がかり。等級しか読まなかった読み上げでは引けなくて当然なので黙る。
    if (last?.sawRowRef && !last.resolvedAny) {
      log.warn('[tsunami] 読み上げ追従: 区域・観測点の行を一度も引き当てられなかった')
    }
  }, [speechSession])

  // 自動で見せられたときは先頭へ戻す（`autoShowTick` の JSDoc 参照）。
  //
  // **`useLayoutEffect` で行うのは順序のため。** 同じ受信で受信時スクロール（`useEffect`）や
  // 読み上げ追従（rAF）が動くなら、そちらに上書きさせたい。先頭へ戻すのは「他に行き先が
  // 決まらなかったとき」の既定でしかない。
  //
  // 一瞬で移す（`behavior: 'smooth'` にしない）。移動してきた直後で、まだ何も見せていない
  // 場所からの滑走を見せる意味が無いうえ、続く追従のスクロールと重なって二重に動く。
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    // 手で動かした直後は動かさない。他の 2 つの駆動（受信時スクロール・読み上げ追従）も
    // 同じ保持を尊重するので、ここだけ無条件に走ると「触った直後に飛ぶ」のが残る。
    //
    // **保持が明けたときに埋め合わせはしない**（既知の限界）。手でスクロール中に他タブへ移り、
    // 保持が明ける前に自動で連れ戻された場合は、前の位置のまま表示される。埋め合わせるには
    // 保持の明けを待って一度だけ実行する仕掛けが要るが、それは「何もしていないのに画面が飛ぶ」
    // という、この保持で防いでいるものを作り直すことになる。触った位置を残す方を採る。
    if (userScrollHoldRef.current) return
    container.scrollTop = 0
    // 追従が持っている「行き先」も捨てる。残すと、この先頭復帰を追従が知らないまま
    // 矩形を補正し、まだ動く前の位置を基準に判定してしまう。
    const progress = followProgressRef.current
    if (progress) progress.targetScrollTop = null
  }, [autoShowTick])

  // 変更区域が画面に収まるならまとめて見えるように、収まらなければ波高最大の区域が
  // ヘッダー直下に来るようにスクロールする（読み上げが無効な端末の唯一の自動スクロール）
  useEffect(() => {
    if (!focusedDistrict) return
    const container = containerRef.current
    if (!container) return

    const run = () => {
      // この受信より後に追従が動いていれば、その受信は追従が受け持ったと見なして見送る。
      // **読み上げは数十秒続く**ため、その最中にここが動くと、いま読んでいる箇所から引き剥がした
      // うえで次のチャンクで追従が引き戻す。
      if (followHandledAtRef.current >= focusedDistrict.ts) return
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
    }

    // **寄せる先がある受信だけ、追従が受け持つのを待つ。** 電文が届いた瞬間に変更区域へ寄せても、
    // 0.8〜4.2 秒後（通知音との間隔）に読み上げが始まって等級カードの頭へ引き戻すことになり、
    // 逆向きの動きが見える。声と画面を一致させる側に任せる。
    //
    // **区域が特定できない受信（`districts` が空）は待たない。** 解除・実質変化なしの続報・
    // 復帰による先頭戻しがここに来るが、いずれも追従の対象になる読み上げを持たない
    // （解除の読み上げは区域名を含まないので参照が無い）。待たせても追従は永久に来ず、
    // 猶予のあいだ解除前の位置に留まるだけ。**解除で待たされるのが一番まずい。**
    //
    // 待つ場合も**待ちっぱなしにはしない。** 「有効」は端末の設定値にすぎず、その電文で実際に
    // 読み上げが成立するかは別（VOICEVOX が未起動・到達不能でも `speakWithVoicevox` は無音の
    // まま正常終了する契約）。待って何も起きなければ、ここが唯一の自動スクロールになる。
    if (speechFollowEnabled && focusedDistrict.districts.length > 0) {
      const timer = window.setTimeout(run, SPEECH_FOLLOW_GRACE_MS)
      return () => window.clearTimeout(timer)
    }
    run()
  // focusedDistrict.ts を依存にすることで同一区域の再フォーカスも発火する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedDistrict?.ts, bannerHeight, speechFollowEnabled])

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
                registerSpeechAnchor={registerSpeechAnchor}
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
