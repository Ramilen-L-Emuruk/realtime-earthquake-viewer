import type { EEWAlert } from '../types/earthquake'
import { formatDateTime } from '../utils/formatters'
import { getIntensityLabel } from '../utils/intensity'
import { eewAreas, eewMaxScale } from '../utils/eew'

interface Props {
  eew: EEWAlert | null
}

export function EEWBanner({ eew }: Props) {
  if (!eew) return null

  const isWarning = eew.severity === 'Warning'
  const areas = eewAreas(eew)
  const maxScale = eewMaxScale(eew)

  return (
    <div
      className={`
        animate-slide-down flex-shrink-0
        ${isWarning
          ? 'bg-red-900 border-b-2 border-red-500'
          : 'bg-orange-900 border-b-2 border-orange-500'
        }
      `}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-shrink-0 text-center">
          <div className="text-xs font-bold text-white opacity-75">緊急地震速報</div>
          <div
            className={`text-2xl font-black ${isWarning ? 'text-red-300 animate-pulse' : 'text-orange-300'}`}
          >
            {isWarning ? '警報' : '予報'}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-white font-bold text-base truncate">
              {eew.earthquake.hypocenter.name}
            </span>
            <span className="text-white font-bold">
              M{eew.earthquake.hypocenter.magnitude.toFixed(1)}
            </span>
            {maxScale > 0 && (
              <span className="text-white font-bold">
                最大震度{getIntensityLabel(maxScale)}予想
              </span>
            )}
          </div>
          <div className="text-xs text-white opacity-75 mt-0.5">
            {formatDateTime(eew.earthquake.originTime)}
          </div>
          {areas.length > 0 && (
            <div className="text-xs text-white opacity-75 truncate mt-0.5">
              対象: {areas.slice(0, 4).map(r => r.pref).join(' / ')}
              {areas.length > 4 && ' ...'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
