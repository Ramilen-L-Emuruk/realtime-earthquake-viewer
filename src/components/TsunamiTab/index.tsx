import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import { formatDateTimeMin, formatTime } from '../../utils/formatters'

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
  onEarthquakeLink?: (earthquakeTime: string) => void
  onObservationClick?: (name: string) => void
  focusedDistrict?: FocusedDistrict | null
  obsUpdateStatus?: Map<string, 'new' | 'updated'>
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

// 観測情報が属する津波予報区（districtCode/districtName）を発表区域（area.code/area.name）に紐づける。
// code が双方にあれば code を優先。無ければ name で照合する。
export function matchesArea(obs: TsunamiObservation, area: TsunamiArea): boolean {
  if (obs.districtCode && area.code) return obs.districtCode === area.code
  return !!obs.districtName && obs.districtName === area.name
}

// FocusedDistrict の区域識別子（code/name）を発表区域に紐づける。照合ルールは matchesArea と同じ。
function districtMatchesArea(district: { code?: string; name?: string }, area: TsunamiArea): boolean {
  if (district.code && area.code) return district.code === area.code
  return !!district.name && district.name === area.name
}

// 同一階級内で、予想波高（maxHeight.description）が連続して一致する区域を1グループにまとめる。
// 電文内の区域順序は維持し、離れた位置にある同じ波高の区域まではまとめない。
function groupAreasByHeight(areas: TsunamiArea[]): { heightLabel: string | null; areas: TsunamiArea[] }[] {
  const groups: { heightLabel: string | null; areas: TsunamiArea[] }[] = []
  for (const area of areas) {
    const label = area.maxHeight?.description || null
    const last = groups[groups.length - 1]
    if (label && last && last.heightLabel === label) {
      last.areas.push(area)
    } else {
      groups.push({ heightLabel: label, areas: [area] })
    }
  }
  return groups
}

// 区域に紐づく観測点のうち、実測値（height）が最も高いものを返す。
// value が同点の場合は over（「以上」）を優先する。実測値を持つ観測点が無ければ null。
function maxObservedHeight(area: TsunamiArea, observations: TsunamiObservation[]): { value: number; over: boolean } | null {
  let max: { value: number; over: boolean } | null = null
  for (const obs of observations) {
    if (!obs.height || !matchesArea(obs, area)) continue
    const candidate = { value: obs.height.value, over: !!obs.height.over }
    if (!max || candidate.value > max.value || (candidate.value === max.value && candidate.over && !max.over)) {
      max = candidate
    }
  }
  return max
}

// 波高グループ内で、観測データ（実測値）がある区域を上に、無い区域を下にまとめる。
// 観測データがある区域同士は実測波高（最大値・同点なら「以上」優先）の降順で並べ、
// 実測値未確定（到達時刻のみ等）の区域は観測データありの中で最下位に置く。
// いずれも同点の場合・観測データが無い区域同士は電文順（安定ソート）を維持する。
function sortAreasByObservation(areas: TsunamiArea[], observations: TsunamiObservation[]): TsunamiArea[] {
  const withObservation: TsunamiArea[] = []
  const withoutObservation: TsunamiArea[] = []
  for (const area of areas) {
    if (observations.some(o => matchesArea(o, area))) withObservation.push(area)
    else withoutObservation.push(area)
  }

  const sortedWithObservation = withObservation
    .map((area, index) => ({ area, index, height: maxObservedHeight(area, observations) }))
    .sort((a, b) => {
      if (a.height && b.height) {
        if (a.height.value !== b.height.value) return b.height.value - a.height.value
        if (a.height.over !== b.height.over) return a.height.over ? -1 : 1
        return a.index - b.index
      }
      if (a.height && !b.height) return -1
      if (!a.height && b.height) return 1
      return a.index - b.index
    })
    .map(({ area }) => area)

  return [...sortedWithObservation, ...withoutObservation]
}

// TsunamiGradeCard が実際に描画する区域の並び順（グループ化＋区域内ソート）を、
// カード外（読み上げ・自動スクロール判定など）からも再利用できるように公開する。
export function sortAreasForCardDisplay(areas: TsunamiArea[], observations: TsunamiObservation[]): TsunamiArea[] {
  return groupAreasByHeight(areas).flatMap(group => sortAreasByObservation(group.areas, observations))
}

function TsunamiHeightHeader({ label, style }: { label: string; style: GradeStyle }) {
  return (
    <div className="px-3 py-1 font-black leading-none text-[18px] roomy:px-4 roomy:text-[22px]"
      style={{ color: style.heightColor, backgroundColor: `${style.cardBorder}14`, borderBottom: `1px solid ${style.cardBorder}33` }}>
      {label}
    </div>
  )
}

function TsunamiAreaRow({ area, observations, style, onObservationClick, isChanged, isTop, registerRow, obsUpdateStatus }: { area: TsunamiArea; observations: TsunamiObservation[]; style: GradeStyle; onObservationClick?: (name: string) => void; isChanged: boolean; isTop: boolean; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; obsUpdateStatus?: Map<string, 'new' | 'updated'> }) {
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    registerRow?.(area, isChanged, isTop, el)
  }, [registerRow, area, isChanged, isTop])

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
          <span className="text-white font-semibold block text-[17px] roomy:text-[20px]" style={{ lineHeight: '1.2' }}>
            {area.name}
          </span>
          {arrivalText && (
            <span className="block mt-1" style={{ fontSize: '15px', color: style.arrivalColor }}>
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
                      <span className="font-semibold" style={{ fontSize: '13px', color: style.heightColor }}>{obs.name}</span>
                      <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: `${style.cardBorder}30`, color: style.heightColor }}>
                        {obs.height ? '実測' : '到達確認'}
                      </span>
                    </div>
                    <div className="mt-1" style={{ fontSize: '11px', color: '#9ca3af' }}>
                      {obs.arrivalTime && `${formatTime(obs.arrivalTime).slice(0, 5)}${obs.initial ? ` ${obs.initial}波` : ''}`}
                      {/* 同名 station があれば満潮時刻をここに表示 */}
                      {(() => {
                        const matched = stations.find(s => s.name === obs.name)
                        return matched?.highTideDateTime ? `　満潮 ${formatTime(matched.highTideDateTime).slice(0, 5)}` : null
                      })()}
                    </div>
                  </div>
                  {obs.height ? (
                    <span className="font-bold flex-shrink-0" style={{ fontSize: '20px', color: style.heightColor }}>{obs.height.description}</span>
                  ) : (
                    <span className="flex-shrink-0" style={{ fontSize: '13px', color: '#9ca3af' }}>観測中</span>
                  )}
                </div>
              </div>
            )
          })}
          {/* 実測値なし観測点（station のみ） */}
          {stations.filter(s => !observedNames.has(s.name)).map((st, i) => (
            <div key={i} className="px-3 py-2 rounded" style={{ border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.03)' }}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-semibold" style={{ fontSize: '13px', color: '#d1d5db' }}>{st.name}</span>
                <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)', color: '#9ca3af' }}>予測</span>
              </div>
              <div className="mt-1" style={{ fontSize: '11px', color: '#9ca3af' }}>
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
        <span className="text-white font-semibold block text-[16px] roomy:text-[18px]">
          {obs.name}
        </span>
        {obs.arrivalTime && (
          <span className="block mt-1 text-secondary" style={{ fontSize: '13px' }}>
            到達: {formatTime(obs.arrivalTime).slice(0, 5)}{obs.initial ? `（${obs.initial}）` : ''}
          </span>
        )}
      </div>
      {obs.height && (
        <span className="text-secondary flex-shrink-0" style={{ fontSize: '16px' }}>
          {obs.height.description}
        </span>
      )}
    </div>
  )
}

function TsunamiGradeCard({ grade, areas, observations, onObservationClick, focusedDistrict, registerRow, obsUpdateStatus }: { grade: TsunamiGrade; areas: TsunamiArea[]; observations: TsunamiObservation[]; onObservationClick?: (name: string) => void; focusedDistrict?: FocusedDistrict | null; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; obsUpdateStatus?: Map<string, 'new' | 'updated'> }) {
  if (areas.length === 0) return null
  const style = getGradeStyle(grade)
  const groups = groupAreasByHeight(areas).map(group => ({ ...group, areas: sortAreasByObservation(group.areas, observations) }))
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
export const TsunamiTab = memo(function TsunamiTab({ tsunamis, earthquakes, onEarthquakeLink, onObservationClick, focusedDistrict, obsUpdateStatus }: Props) {
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

  // 変更区域が画面に収まるならまとめて見えるように、収まらなければ波高最大の区域が
  // ヘッダー直下に来るようにスクロールする
  useEffect(() => {
    if (!focusedDistrict) return
    const container = containerRef.current
    if (!container) return
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
          onClick={linkedQuake ? () => onEarthquakeLink?.(linkedQuake.earthquake.time) : undefined}
          onKeyDown={linkedQuake ? (e) => { if (e.key === 'Enter' || e.key === ' ') onEarthquakeLink?.(linkedQuake.earthquake.time) } : undefined}
          className={`rounded-lg overflow-hidden${linkedQuake ? ' cursor-pointer hover:opacity-90 transition-opacity' : ''}`}
          style={{ background: isCancelledDisplay ? '#1a1a1a' : topStyle.headerBg, border: `2px solid ${isCancelledDisplay ? '#4b5563' : topStyle.cardBorder}` }}>
          <div className="px-3 py-2 roomy:px-4 roomy:py-3"
            style={{ background: isCancelledDisplay ? 'rgba(75,85,99,0.18)' : `${topStyle.cardBorder}18` }}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold" style={{ fontSize: '14px', color: isCancelledDisplay ? '#9ca3af' : topStyle.headerColor }}>
                {isCancelledDisplay ? cancelInfo.title : `${GRADE_LABEL[topGrade]} 発令中`}
              </div>
              {latestTime && (
                <div className="text-right flex-shrink-0" style={{ fontSize: '11px', color: isCancelledDisplay ? '#6b7280' : topStyle.arrivalColor, opacity: 0.8 }}>
                  {formatDateTimeMin(latestTime)} 更新
                </div>
              )}
            </div>
            <div className="mt-1" style={{ fontSize: '11px', color: isCancelledDisplay ? '#6b7280' : topStyle.headerColor, opacity: 0.8 }}>
              {isCancelledDisplay ? cancelInfo.desc : topGrade === 'Forecast' ? '若干の海面変動があるかもしれません' : '海岸・河川から直ちに離れてください'}
            </div>
            {!isCancelledDisplay && sourceEarthquake && (
              <div className="mt-1.5 pt-1.5" style={{ fontSize: '11px', color: topStyle.arrivalColor, opacity: 0.9, borderTop: `1px solid ${topStyle.cardBorder}40` }}>
                震源: {sourceEarthquake.hypocenterName}
                {sourceEarthquake.magnitude !== undefined && `　M${sourceEarthquake.magnitude}`}
                {sourceEarthquake.originTime && `　${formatTime(sourceEarthquake.originTime).slice(0, 5)}発生`}
                {linkedQuake && <span style={{ marginLeft: '6px', fontSize: '10px', opacity: 0.7 }}>▶ 地震情報</span>}
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
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg" style={{ minHeight: '80px' }}>
                <span className="font-black text-white" style={{ fontSize: '40px', lineHeight: 1.1 }}>{cancelInfo.badge}</span>
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
                <div className="text-secondary" style={{ fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-line', padding: '12px 16px' }}>
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
