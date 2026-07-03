import { useEffect, useRef } from 'react'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import { formatDateTime, formatTime } from '../../utils/formatters'

export interface FocusedDistrict {
  code?: string
  name?: string
  ts: number
}

interface Props {
  tsunamis: JMATsunami[]
  earthquakes?: JMAQuake[]
  onEarthquakeLink?: (earthquakeTime: string) => void
  onObservationClick?: (name: string) => void
  focusedDistrict?: FocusedDistrict | null
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

// 観測情報が属する津波予報区（districtCode/districtName）を発表区域（area.code/area.name）に紐づける。
// code が双方にあれば code を優先。無ければ name で照合する。
function matchesArea(obs: TsunamiObservation, area: TsunamiArea): boolean {
  if (obs.districtCode && area.code) return obs.districtCode === area.code
  return !!obs.districtName && obs.districtName === area.name
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

function TsunamiHeightHeader({ label, style }: { label: string; style: GradeStyle }) {
  return (
    <div className="px-4 py-1 font-black leading-none"
      style={{ fontSize: '22px', color: style.heightColor, backgroundColor: `${style.cardBorder}14`, borderBottom: `1px solid ${style.cardBorder}33` }}>
      {label}
    </div>
  )
}

function TsunamiAreaRow({ area, observations, style, onObservationClick, focusedDistrict }: { area: TsunamiArea; observations: TsunamiObservation[]; style: GradeStyle; onObservationClick?: (name: string) => void; focusedDistrict?: FocusedDistrict | null }) {
  const rowRef = useRef<HTMLDivElement>(null)

  const isFocused = focusedDistrict != null && (
    (focusedDistrict.code && area.code) ? focusedDistrict.code === area.code : focusedDistrict.name === area.name
  )

  useEffect(() => {
    if (isFocused && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  // focusedDistrict.ts を依存にすることで同一 district の再フォーカスも発火する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedDistrict?.ts])

  const arrivalText = area.firstHeight?.arrivalTime
    ? `到達予想 ${formatTime(area.firstHeight.arrivalTime).slice(0, 5)}`
    : (area.firstHeight?.condition ?? null)

  const stations = area.stations ?? []
  // 実測値がある観測点名のセット（到達済み判定・到達中バッジ抑制に使用）
  const observedNames = new Set(observations.map(o => o.name))
  // 区域内に1件でも実測値があれば到達中バッジは不要（実測行で代替できる）
  const showImmediateBadge = area.immediate && observations.length === 0

  return (
    <div ref={rowRef} className="border-b border-white/5 last:border-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <span className="text-white font-semibold block" style={{ fontSize: '20px', lineHeight: '1.2' }}>
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
            return (
              <div
                key={i}
                className={`px-3 py-2 rounded${clickable ? ' cursor-pointer hover:brightness-125 transition-[filter]' : ''}`}
                style={{ background: `${style.cardBorder}12`, border: `1px solid ${style.cardBorder}38` }}
                onClick={clickable ? () => onObservationClick!(obs.name) : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onObservationClick!(obs.name) } : undefined}
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-semibold" style={{ fontSize: '13px', color: style.heightColor }}>{obs.name}</span>
                  <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: `${style.cardBorder}30`, color: style.heightColor }}>実測</span>
                  {obs.height && (
                    <span className="font-bold" style={{ fontSize: '15px', color: style.heightColor }}>{obs.height.description}</span>
                  )}
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
      className={`flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0${clickable ? ' cursor-pointer hover:brightness-125 transition-[filter]' : ''}`}
      onClick={clickable ? () => onObservationClick!(obs.name) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onObservationClick!(obs.name) } : undefined}
    >
      <div className="flex-1 min-w-0">
        <span className="text-white font-semibold block" style={{ fontSize: '18px' }}>
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

function TsunamiGradeCard({ grade, areas, observations, onObservationClick, focusedDistrict }: { grade: TsunamiGrade; areas: TsunamiArea[]; observations: TsunamiObservation[]; onObservationClick?: (name: string) => void; focusedDistrict?: FocusedDistrict | null }) {
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
              focusedDistrict={focusedDistrict}
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

export function TsunamiTab({ tsunamis, earthquakes, onEarthquakeLink, onObservationClick, focusedDistrict }: Props) {
  // cancelledAt がある = 10秒表示中なので active に含める
  const active = tsunamis.filter(t => !t.cancelled || t.cancelledAt)

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
  const latestTime = active[0]?.time
  const sourceEarthquake = active[0]?.sourceEarthquake

  // 津波の原因地震に対応する地震カードを eventId で照合する
  const tsunamiEventId = active[0]?.eventId
  const linkedQuake = (tsunamiEventId && earthquakes)
    ? earthquakes.find(q => q.eventId === tsunamiEventId && !q.cancelledAt)
    : undefined

  return (
    <div className="p-3 flex flex-col gap-3">
      {/* 発令中 / 解除バナー。対応する地震カードがある場合のみクリック可能。 */}
      <div
        role={linkedQuake ? 'button' : undefined}
        tabIndex={linkedQuake ? 0 : undefined}
        onClick={linkedQuake ? () => onEarthquakeLink?.(linkedQuake.earthquake.time) : undefined}
        onKeyDown={linkedQuake ? (e) => { if (e.key === 'Enter' || e.key === ' ') onEarthquakeLink?.(linkedQuake.earthquake.time) } : undefined}
        className={`rounded-lg overflow-hidden${linkedQuake ? ' cursor-pointer hover:opacity-90 transition-opacity' : ''}`}
        style={{ background: isCancelledDisplay ? '#1a1a1a' : topStyle.headerBg, border: `2px solid ${isCancelledDisplay ? '#4b5563' : topStyle.cardBorder}` }}>
        <div className="px-4 py-3"
          style={{ background: isCancelledDisplay ? 'rgba(75,85,99,0.18)' : `${topStyle.cardBorder}18` }}>
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold" style={{ fontSize: '14px', color: isCancelledDisplay ? '#9ca3af' : topStyle.headerColor }}>
              {isCancelledDisplay ? '津波情報 解除' : `${GRADE_LABEL[topGrade]} 発令中`}
            </div>
            {latestTime && (
              <div className="text-right flex-shrink-0" style={{ fontSize: '11px', color: isCancelledDisplay ? '#6b7280' : topStyle.arrivalColor, opacity: 0.8 }}>
                {formatDateTime(latestTime)}
              </div>
            )}
          </div>
          <div className="mt-1" style={{ fontSize: '11px', color: isCancelledDisplay ? '#6b7280' : topStyle.headerColor, opacity: 0.8 }}>
            {isCancelledDisplay ? 'この津波情報は解除されました' : topGrade === 'Forecast' ? '若干の海面変動があるかもしれません' : '海岸・河川から直ちに離れてください'}
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

      {active.map(t => {
        const observations = t.observations ?? []
        const unmatched = observations.filter(o => !t.areas.some(a => matchesArea(o, a)))
        return (
          <div key={t.id} className="flex flex-col gap-3 relative">
            {t.cancelledAt && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg" style={{ minHeight: '80px' }}>
                <span className="font-black text-white" style={{ fontSize: '40px', lineHeight: 1.1 }}>解除</span>
                <span className="text-sm font-bold text-white/90 mt-1">この津波情報は解除されました</span>
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
  )
}
