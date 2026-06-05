import type { JMAQuake } from '../../types/earthquake'
import {
  formatDateTime,
  formatDepth,
  formatMagnitude,
  formatDomesticTsunami,
  formatIssueType,
} from '../../utils/formatters'
import { getIntensityLabel, getIntensityColor, getIntensityBgColor } from '../../utils/intensity'

interface Props {
  quake: JMAQuake
  isLatest?: boolean
}

export function EarthquakeCard({ quake, isLatest }: Props) {
  const { earthquake, issue } = quake
  const { hypocenter, maxScale, domesticTsunami } = earthquake
  const tsunamiInfo = formatDomesticTsunami(domesticTsunami)
  const hasLocation = hypocenter.latitude > -200 && hypocenter.longitude > -200

  return (
    <div
      className={`
        bg-card rounded-lg p-3 border transition-colors
        ${isLatest ? 'border-blue-500/50' : 'border-border'}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Intensity badge */}
        <div
          className="flex-shrink-0 w-14 h-14 rounded-lg flex flex-col items-center justify-center"
          style={{
            backgroundColor: getIntensityBgColor(maxScale),
            border: `2px solid ${getIntensityColor(maxScale)}`,
          }}
        >
          <span className="text-xs font-medium" style={{ color: getIntensityColor(maxScale) }}>
            最大
          </span>
          <span
            className="text-xl font-black leading-tight"
            style={{ color: getIntensityColor(maxScale) }}
          >
            {maxScale === -1 ? '?' : getIntensityLabel(maxScale)}
          </span>
          <span className="text-xs" style={{ color: getIntensityColor(maxScale) }}>
            震度
          </span>
        </div>

        {/* Earthquake details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-white font-bold text-sm truncate">
              {hasLocation ? hypocenter.name : '震源調査中'}
            </span>
            {isLatest && (
              <span className="text-xs bg-blue-900 text-blue-300 px-1.5 py-0.5 rounded font-medium">
                最新
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-secondary flex-wrap">
            {hasLocation && (
              <>
                <span className="font-medium text-white">
                  {formatMagnitude(hypocenter.magnitude)}
                </span>
                <span>{formatDepth(hypocenter.depth)}</span>
              </>
            )}
            <span className="bg-panel px-1.5 py-0.5 rounded text-secondary">
              {formatIssueType(issue.type)}
            </span>
          </div>

          <div className="mt-1.5 space-y-0.5">
            <div className="text-xs text-secondary">
              {formatDateTime(earthquake.time)}
            </div>
            <div
              className="text-xs font-medium"
              style={{ color: tsunamiInfo.color }}
            >
              {tsunamiInfo.text}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
