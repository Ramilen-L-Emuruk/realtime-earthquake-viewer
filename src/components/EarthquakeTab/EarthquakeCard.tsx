import { useMemo, useRef, useEffect } from 'react'
import type { JMAQuake, JMALpgm, IssueType } from '../../types/earthquake'
import { getLpgmClassLabel, getLpgmClassColor, getLpgmClassBgColor } from '../../utils/lpgm'
import {
  formatQuakeTime,
  formatDepth,
  formatMagnitude,
  formatDomesticTsunami,
  formatIssueType,
  formatCorrectType,
} from '../../utils/formatters'
import { getIntensityLabel, getIntensityColor, getIntensityBgColor, getDepthColor, getMagnitudeColor } from '../../utils/intensity'

/** issue.type に応じたバッジの Tailwind クラスを返す。 */
function issueTypeBadgeClass(type: IssueType): string {
  switch (type) {
    case 'ScalePrompt':
    case 'Destination':          return 'bg-amber-900 text-amber-300'
    case 'ScaleAndDestination':
    case 'DetailScale':
    case 'DestinationAmended':   return 'bg-blue-900/60 text-blue-300'
    case 'Foreign':              return 'bg-purple-900/60 text-purple-300'
    default:                     return 'bg-panel text-secondary'
  }
}

interface IssueTypeStyle {
  headerBg: string
  headerColor: string
  headerBorder: string
  cardBorder: string
  cardBg: string
}

function getIssueTypeStyle(type: IssueType): IssueTypeStyle {
  switch (type) {
    case 'ScalePrompt':
    case 'Destination':
      return { headerBg: '#451a03', headerColor: '#fbbf24', headerBorder: '#b45309', cardBorder: '#b45309', cardBg: '#1c1710' }
    case 'ScaleAndDestination':
    case 'DetailScale':
    case 'DestinationAmended':
      return { headerBg: '#0c2044', headerColor: '#93c5fd', headerBorder: '#1d4ed8', cardBorder: '#1d4ed8', cardBg: '#111827' }
    case 'Foreign':
      return { headerBg: '#2e1065', headerColor: '#d8b4fe', headerBorder: '#7e22ce', cardBorder: '#7e22ce', cardBg: '#1a1024' }
    default:
      return { headerBg: '#0c2044', headerColor: '#93c5fd', headerBorder: '#1d4ed8', cardBorder: '#1d4ed8', cardBg: '#111827' }
  }
}

interface Props {
  quake: JMAQuake
  isLatest?: boolean
  isSelected?: boolean
  onSelect?: () => void
  lpgm?: JMALpgm
  activeLpgmEventId?: string | null
  onToggleLpgm?: (eventId: string) => void
}

export function EarthquakeCard({ quake, isLatest, isSelected, onSelect, lpgm, activeLpgmEventId, onToggleLpgm }: Props) {
  const { earthquake, issue } = quake
  const { hypocenter, maxScale, domesticTsunami } = earthquake
  const tsunamiInfo = formatDomesticTsunami(domesticTsunami)
  const hasLocation = hypocenter.latitude > -200 && hypocenter.longitude > -200

  const cardRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (isSelected) {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const prefGroups = useMemo(() => {
    if (!isSelected || !quake.points.length) return []
    const map = new Map<string, number>()
    for (const p of quake.points) {
      if (!p.pref) continue  // pref 未設定（JSON の regions/stations）は都道府県表示に使わない
      const cur = map.get(p.pref) ?? -1
      if (p.scale > cur) map.set(p.pref, p.scale)
    }
    return Array.from(map.entries())
      .map(([pref, scale]) => ({ pref, scale }))
      .filter(({ scale }) => scale >= 0)
      .sort((a, b) => b.scale - a.scale)
  }, [isSelected, quake.points])

  if (isSelected) {
    const typeStyle = getIssueTypeStyle(issue.type)
    const magColor = getMagnitudeColor(hypocenter.magnitude)
    const depthColor = getDepthColor(hypocenter.depth)

    return (
      <button
        ref={cardRef}
        type="button"
        onClick={onSelect}
        aria-pressed={true}
        className="w-full text-left bg-card rounded-lg border transition-colors cursor-pointer overflow-hidden hover:opacity-90"
        style={{
          borderColor: typeStyle.cardBorder,
          boxShadow: `0 0 0 1px ${typeStyle.cardBorder}40`,
        }}
      >
        {/* 種別ヘッダー */}
        <div
          className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
          style={{
            backgroundColor: typeStyle.headerBg,
            color: typeStyle.headerColor,
            borderBottom: `1px solid ${typeStyle.headerBorder}`,
          }}
        >
          {formatIssueType(issue.type)}
        </div>

        <div className="flex flex-col gap-2 p-3">
          {/* 最大震度（横並び） */}
          <div
            className="w-full rounded-lg py-3 px-5 flex items-center justify-center gap-4"
            style={{
              backgroundColor: getIntensityBgColor(maxScale),
              border: `2px solid ${getIntensityColor(maxScale)}`,
            }}
          >
            <span className="text-base font-medium" style={{ color: getIntensityColor(maxScale) }}>
              最大震度
            </span>
            <span
              className="font-black leading-none"
              style={{ fontSize: '88px', color: '#ffffff' }}
            >
              {maxScale === -1 ? '?' : getIntensityLabel(maxScale)}
            </span>
          </div>

          {/* 長周期地震動観測情報（クリックで地図表示トグル） */}
          {lpgm && lpgm.maxClass >= 1 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleLpgm?.(lpgm.eventId) }}
              className="w-full rounded-lg py-2 px-4 flex items-center justify-center gap-4 hover:opacity-80 transition-opacity"
              style={{
                backgroundColor: getLpgmClassBgColor(lpgm.maxClass),
                border: `2px solid ${getLpgmClassColor(lpgm.maxClass)}`,
                outline: activeLpgmEventId === lpgm.eventId
                  ? `2px solid ${getLpgmClassColor(lpgm.maxClass)}`
                  : undefined,
                outlineOffset: '2px',
              }}
            >
              <span className="text-sm font-medium" style={{ color: getLpgmClassColor(lpgm.maxClass) }}>
                長周期地震動
              </span>
              <span className="text-2xl font-black" style={{ color: '#ffffff' }}>
                {getLpgmClassLabel(lpgm.maxClass)}
              </span>
            </button>
          )}

          {/* 日時 + 訂正情報 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-secondary" style={{ fontSize: '20px' }}>
              {formatQuakeTime(earthquake.time)}
            </span>
            {issue.correct !== 'None' && (
              <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                {formatCorrectType(issue.correct)}
              </span>
            )}
          </div>

          {/* 震源地 */}
          <div className="font-bold text-white leading-tight" style={{ fontSize: '30px' }}>
            {hasLocation ? hypocenter.name : '震源調査中'}
          </div>

          {/* マグニチュード・深さ（2カラムグリッド） */}
          {hasLocation && (
            <div className="grid grid-cols-2 gap-2">
              <div
                className="flex flex-col gap-1 rounded-lg p-2.5"
                style={{
                  backgroundColor: `${magColor}26`,
                  border: `2px solid ${magColor}`,
                }}
              >
                <span className="text-xs font-medium tracking-wide" style={{ color: magColor }}>
                  マグニチュード
                </span>
                <span className="font-black leading-none" style={{ fontSize: '28px', color: '#ffffff' }}>
                  {hypocenter.magnitude.toFixed(1)}
                </span>
              </div>
              <div
                className="flex flex-col gap-1 rounded-lg p-2.5"
                style={{
                  backgroundColor: `${depthColor}26`,
                  border: `2px solid ${depthColor}`,
                }}
              >
                <span className="text-xs font-medium tracking-wide" style={{ color: depthColor }}>
                  深さ
                </span>
                <span className="font-black leading-none" style={{ fontSize: '28px', color: '#ffffff' }}>
                  {formatDepth(hypocenter.depth)}
                </span>
              </div>
            </div>
          )}

          {/* 国内津波情報 */}
          <div
            className="w-full rounded-lg py-2 px-3 text-center font-bold text-base"
            style={{
              backgroundColor: `${tsunamiInfo.color}22`,
              border: `1px solid ${tsunamiInfo.color}`,
              color: tsunamiInfo.color,
            }}
          >
            {tsunamiInfo.text}
          </div>

          {/* 国外津波情報 */}
          {earthquake.foreignTsunami && earthquake.foreignTsunami !== 'Unknown' && earthquake.foreignTsunami !== 'None' && (
            <div className="text-sm text-secondary">国外: {earthquake.foreignTsunami}</div>
          )}

          {/* 震源の緯度・経度 */}
          {hasLocation && (
            <div className="text-sm text-secondary">
              北緯 {hypocenter.latitude.toFixed(1)}° 東経 {hypocenter.longitude.toFixed(1)}°
            </div>
          )}

          {/* 各地の震度 / 長周期地震動階級（LPGM トグルオン時は階級表示に切り替え） */}
          {(() => {
            const isLpgmActive = lpgm && activeLpgmEventId === lpgm.eventId
            const lpgmRegions = lpgm?.regions?.filter(r => r.maxLgInt >= 1)
              .slice()
              .sort((a, b) => b.maxLgInt - a.maxLgInt)

            if (isLpgmActive && lpgmRegions && lpgmRegions.length > 0) {
              return (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
                  {lpgmRegions.map(({ name, maxLgInt }, idx) => (
                    <div
                      key={name}
                      className="flex items-center justify-between px-2 py-1.5 rounded"
                      style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                    >
                      <span
                        className="font-bold flex-shrink-0 whitespace-nowrap"
                        style={{ fontSize: '18px', color: getLpgmClassColor(maxLgInt) }}
                      >
                        長周期 {getLpgmClassLabel(maxLgInt)}
                      </span>
                      <span className="text-white" style={{ fontSize: '18px' }}>{name}</span>
                    </div>
                  ))}
                </div>
              )
            }

            return prefGroups.length > 0 ? (
              <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
                {prefGroups.map(({ pref, scale }, idx) => (
                  <div
                    key={pref}
                    className="flex items-center justify-between px-2 py-1.5 rounded"
                    style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                  >
                    <span
                      className="font-bold flex-shrink-0 whitespace-nowrap"
                      style={{ fontSize: '18px', color: getIntensityColor(scale) }}
                    >
                      震度{getIntensityLabel(scale)}
                    </span>
                    <span className="text-white" style={{ fontSize: '18px' }}>{pref}</span>
                  </div>
                ))}
              </div>
            ) : null
          })()}
        </div>
      </button>
    )
  }

  /* 非選択時：コンパクト横並びレイアウト */
  const borderClass = isLatest ? 'border-blue-500/50' : 'border-border'

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onSelect}
      aria-pressed={false}
      className={`
        w-full text-left bg-card rounded-lg p-3 border transition-colors cursor-pointer
        hover:border-blue-400/60
        ${borderClass}
      `}
    >
      <div className="flex items-stretch gap-3">
        {/* 震度バッジ */}
        <div
          className="flex-shrink-0 w-20 rounded-lg flex flex-col items-center justify-center px-1"
          style={{
            backgroundColor: getIntensityBgColor(maxScale),
            border: `2px solid ${getIntensityColor(maxScale)}`,
          }}
        >
          <span className="text-xs font-medium" style={{ color: getIntensityColor(maxScale) }}>
            最大震度
          </span>
          <span
            className="text-4xl font-black leading-tight"
            style={{ color: getIntensityColor(maxScale) }}
          >
            {maxScale === -1 ? '?' : getIntensityLabel(maxScale)}
          </span>
        </div>

        {/* 地震詳細 */}
        <div className="flex-1 min-w-0">
          {/* 地域名 + 発表種別 */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-bold text-lg leading-tight flex-shrink-0">
              {hasLocation ? hypocenter.name : '震源調査中'}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded min-w-0 truncate ${issueTypeBadgeClass(issue.type)}`}>
              {formatIssueType(issue.type)}
            </span>
          </div>

          {/* 日時 */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-base text-secondary">{formatQuakeTime(earthquake.time)}</span>
            {issue.correct !== 'None' && (
              <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                {formatCorrectType(issue.correct)}
              </span>
            )}
          </div>

          {/* 深さ・マグニチュード */}
          <div className="flex items-center gap-2 text-base mb-1">
            {hasLocation && (
              <span className="flex items-center gap-1 text-secondary">
                <span>深さ</span>
                <span className="text-white font-medium">{formatDepth(hypocenter.depth)}</span>
                <span
                  className="inline-block w-1.5 h-3.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: getDepthColor(hypocenter.depth) }}
                />
                <span className="text-white font-medium">{formatMagnitude(hypocenter.magnitude)}</span>
                <span
                  className="inline-block w-1.5 h-3.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: getMagnitudeColor(hypocenter.magnitude) }}
                />
              </span>
            )}
          </div>

          {/* 津波情報（常に最終行） */}
          <div className="text-base font-medium" style={{ color: tsunamiInfo.color }}>
            {tsunamiInfo.text}
          </div>
        </div>
      </div>
    </button>
  )
}
