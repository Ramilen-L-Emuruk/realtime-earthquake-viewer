import { useMemo } from 'react'
import type { JMAQuake } from '../../types/earthquake'
import {
  formatQuakeTime,
  formatDepth,
  formatMagnitude,
  formatDomesticTsunami,
  formatIssueType,
  formatCorrectType,
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

  const prefGroups = useMemo(() => {
    if (!isSelected || !quake.points.length) return []
    const map = new Map<string, number>()
    for (const p of quake.points) {
      const cur = map.get(p.pref) ?? -1
      if (p.scale > cur) map.set(p.pref, p.scale)
    }
    return Array.from(map.entries())
      .map(([pref, scale]) => ({ pref, scale }))
      .filter(({ scale }) => scale >= 0)
      .sort((a, b) => b.scale - a.scale)
  }, [isSelected, quake.points])

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
      {isSelected ? (
        /* 選択時：縦型詳細レイアウト */
        <div className="flex flex-col gap-2">
          {/* 最大震度バッジ（横幅いっぱい） */}
          <div
            className="w-full rounded-lg py-3 px-4 flex items-center justify-center gap-6"
            style={{
              backgroundColor: getIntensityBgColor(maxScale),
              border: `2px solid ${getIntensityColor(maxScale)}`,
            }}
          >
            <span className="text-sm font-medium" style={{ color: getIntensityColor(maxScale) }}>
              最大震度
            </span>
            <span className="text-5xl font-black" style={{ color: getIntensityColor(maxScale) }}>
              {maxScale === -1 ? '?' : getIntensityLabel(maxScale)}
            </span>
          </div>

          {/* 日時 + 発表種別 + 最新バッジ + 訂正情報 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base text-secondary">{formatQuakeTime(earthquake.time)}</span>
            <span className="text-xs bg-panel px-1.5 py-0.5 rounded text-secondary flex-shrink-0">
              {formatIssueType(issue.type)}
            </span>
            {isLatest && (
              <span className="text-xs bg-blue-900 text-blue-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                最新
              </span>
            )}
            {issue.correct !== 'None' && (
              <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                {formatCorrectType(issue.correct)}
              </span>
            )}
          </div>

          {/* 地域名 */}
          <div className="text-2xl font-bold text-white leading-tight">
            {hasLocation ? hypocenter.name : '震源調査中'}
          </div>

          {/* マグニチュード・深さ（右揃えインジケーター付き） */}
          {hasLocation && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-base text-secondary">マグニチュード</span>
                <div className="flex items-center gap-2">
                  <span className="text-xl font-bold text-white">{hypocenter.magnitude.toFixed(1)}</span>
                  <span
                    className="inline-block w-2 h-5 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: getMagnitudeColor(hypocenter.magnitude) }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-base text-secondary">深さ</span>
                <div className="flex items-center gap-2">
                  <span className="text-xl font-bold text-white">{formatDepth(hypocenter.depth)}</span>
                  <span
                    className="inline-block w-2 h-5 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: getDepthColor(hypocenter.depth) }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* 国内津波情報（横幅いっぱいバナー） */}
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

          {/* 国外津波情報（空でない場合のみ） */}
          {earthquake.foreignTsunami && earthquake.foreignTsunami !== 'Unknown' && (
            <div className="text-sm text-secondary">国外: {earthquake.foreignTsunami}</div>
          )}

          {/* 震源の緯度・経度 */}
          {hasLocation && (
            <div className="text-sm text-secondary">
              北緯 {hypocenter.latitude.toFixed(1)}° 東経 {hypocenter.longitude.toFixed(1)}°
            </div>
          )}

          {/* 都道府県別震度（震度の高い順） */}
          {prefGroups.length > 0 && (
            <div className="flex flex-col gap-0.5 pt-1 border-t border-blue-500/30">
              {prefGroups.map(({ pref, scale }) => (
                <div key={pref} className="flex items-center gap-2 text-base">
                  <span
                    className="font-bold w-12 text-right flex-shrink-0"
                    style={{ color: getIntensityColor(scale) }}
                  >
                    震度{getIntensityLabel(scale)}
                  </span>
                  <span className="text-white">{pref}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* 非選択時：コンパクト横並びレイアウト */
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
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-white font-bold text-lg leading-tight truncate">
                {hasLocation ? hypocenter.name : '震源調査中'}
              </span>
              {isLatest && (
                <span className="text-xs bg-blue-900 text-blue-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                  最新
                </span>
              )}
            </div>

            {/* 日時 + 発表種別 */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-base text-secondary">{formatQuakeTime(earthquake.time)}</span>
              <span className="text-xs bg-panel px-1.5 py-0.5 rounded text-secondary flex-shrink-0">
                {formatIssueType(issue.type)}
              </span>
              {issue.correct !== 'None' && (
                <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                  {formatCorrectType(issue.correct)}
                </span>
              )}
            </div>

            {/* 深さ・マグニチュード・津波情報 */}
            <div className="flex items-center gap-2 text-base flex-wrap">
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
      )}
    </button>
  )
}
