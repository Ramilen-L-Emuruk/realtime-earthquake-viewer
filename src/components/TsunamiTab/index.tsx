import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import { formatDateTime, formatTime } from '../../utils/formatters'

interface Props {
  tsunamis: JMATsunami[]
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
    default:
      return { headerBg: '#1f2937', headerColor: '#9ca3af', headerBorder: '#4b5563', cardBorder: '#4b5563', arrivalColor: '#6b7280', heightColor: '#9ca3af' }
  }
}

const GRADE_LABEL: Record<TsunamiGrade, string> = {
  MajorWarning: '大津波警報',
  Warning: '津波警報',
  Watch: '津波注意報',
  Unknown: '不明',
}

const GRADE_ORDER: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch', 'Unknown']

function TsunamiAreaRow({ area, style }: { area: TsunamiArea; style: GradeStyle }) {
  const arrivalText = area.firstHeight?.arrivalTime
    ? `到達予想 ${area.firstHeight.arrivalTime}`
    : (area.firstHeight?.condition ?? null)
  const heightText = area.maxHeight?.description ?? null
  const isLongHeight = !!heightText && heightText.length > 3

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0">
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
      {heightText && (
        <span className="font-black flex-shrink-0 leading-none"
          style={{ fontSize: isLongHeight ? '22px' : '36px', color: style.heightColor }}>
          {heightText}
        </span>
      )}
      {area.immediate && (
        <span className="flex-shrink-0 text-xs font-bold px-2 py-1 rounded border"
          style={{ color: '#f87171', backgroundColor: 'rgba(239,68,68,0.15)', borderColor: '#ef4444' }}>
          到達中
        </span>
      )}
    </div>
  )
}

function TsunamiObservationRow({ obs }: { obs: TsunamiObservation }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0">
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

function TsunamiGradeCard({ grade, areas }: { grade: TsunamiGrade; areas: TsunamiArea[] }) {
  if (areas.length === 0) return null
  const style = getGradeStyle(grade)
  return (
    <div className="bg-card rounded-lg overflow-hidden"
      style={{ border: `2px solid ${style.cardBorder}`, boxShadow: `0 0 0 1px ${style.cardBorder}40` }}>
      <div className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
        style={{ backgroundColor: style.headerBg, color: style.headerColor, borderBottom: `1px solid ${style.headerBorder}` }}>
        {GRADE_LABEL[grade]}
      </div>
      {areas.map((area, i) => (
        <TsunamiAreaRow key={i} area={area} style={style} />
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

export function TsunamiTab({ tsunamis }: Props) {
  const active = tsunamis.filter(t => !t.cancelled)

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

  const topGrade = getTopGrade(active)
  const topStyle = getGradeStyle(topGrade)
  const latestTime = active[0]?.time

  return (
    <div className="p-3 flex flex-col gap-3">
      {/* 発令中バナー */}
      <div className="rounded-lg overflow-hidden"
        style={{ background: topStyle.headerBg, border: `2px solid ${topStyle.cardBorder}` }}>
        <div className="px-4 py-3 flex items-center gap-3"
          style={{ background: `${topStyle.cardBorder}18` }}>
          <div className="flex-1">
            <div className="font-bold" style={{ fontSize: '14px', color: topStyle.headerColor }}>
              {GRADE_LABEL[topGrade]} 発令中
            </div>
            <div className="mt-1" style={{ fontSize: '11px', color: topStyle.headerColor, opacity: 0.8 }}>
              海岸・河川から直ちに離れてください
            </div>
          </div>
          {latestTime && (
            <div className="text-right flex-shrink-0" style={{ fontSize: '11px', color: topStyle.arrivalColor, opacity: 0.8 }}>
              {formatDateTime(latestTime)}
            </div>
          )}
        </div>
      </div>

      {active.map(t => (
        <div key={t.id} className="flex flex-col gap-3">
          {GRADE_ORDER.map(grade => (
            <TsunamiGradeCard
              key={grade}
              grade={grade}
              areas={t.areas.filter(a => a.grade === grade)}
            />
          ))}
          {t.observations && t.observations.length > 0 && (
            <div className="bg-card rounded-lg overflow-hidden"
              style={{ border: '2px solid #1d4ed8', boxShadow: '0 0 0 1px rgba(29,78,216,0.25)' }}>
              <div className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
                style={{ backgroundColor: '#0c1a3a', color: '#93c5fd', borderBottom: '1px solid #1d4ed8' }}>
                沖合観測
              </div>
              {t.observations.map((obs, i) => (
                <TsunamiObservationRow key={i} obs={obs} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
