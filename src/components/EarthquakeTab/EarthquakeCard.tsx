import type { JMAQuake } from '../../types/earthquake'
import {
  formatQuakeTime,
  formatDepth,
  formatMagnitude,
  formatDomesticTsunami,
  formatIssueType,
} from '../../utils/formatters'
import { getIntensityLabel, getIntensityColor, getIntensityBgColor, getDepthColor, getMagnitudeColor } from '../../utils/intensity'

interface Props {
  quake: JMAQuake
  isLatest?: boolean
  isSelected?: boolean
  onSelect?: () => void
}

export function EarthquakeCard({ quake, isLatest, isSelected, onSelect }: Props) {
  const { earthquake, issue } = quake
  const { hypocenter, maxScale, domesticTsunami } = earthquake
  const tsunamiInfo = formatDomesticTsunami(domesticTsunami)
  const hasLocation = hypocenter.latitude > -200 && hypocenter.longitude > -200

  const borderClass = isSelected
    ? 'border-blue-500 ring-1 ring-blue-500/60'
    : isLatest
      ? 'border-blue-500/50'
      : 'border-border'

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className={`
        w-full text-left bg-card rounded-lg p-3 border transition-colors cursor-pointer
        hover:border-blue-400/60
        ${borderClass}
      `}
    >
      <div className="flex items-stretch gap-3">
        {/* Intensity badge */}
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

        {/* Earthquake details */}
        <div className="flex-1 min-w-0">
          {/* 地域名 + 最新バッジ */}
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="text-white font-bold text-base leading-tight truncate">
              {hasLocation ? hypocenter.name : '震源調査中'}
            </span>
            {isLatest && (
              <span className="text-xs bg-blue-900 text-blue-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                最新
              </span>
            )}
          </div>

          {/* 日時 + 発表種別 */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-secondary">
              {formatQuakeTime(earthquake.time)}
            </span>
            <span className="text-xs bg-panel px-1.5 py-0.5 rounded text-secondary flex-shrink-0">
              {formatIssueType(issue.type)}
            </span>
          </div>

          {/* 深さ・マグニチュード・津波情報 */}
          <div className="flex items-center gap-2 text-xs flex-wrap">
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
            {tsunamiInfo.text !== '津波の心配なし' && (
              <span className="font-medium" style={{ color: tsunamiInfo.color }}>
                {tsunamiInfo.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}
