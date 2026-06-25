// リアルタイムタブの右パネル。地図エリアは JapanMap が強震モニタ（観測点）と
// 予報円を描画し、ここでは EEW 情報カード・説明・震度スケール凡例・注記を表示する。
import type { EEWAlert } from '../../types/earthquake'
import type { KyoshinDetection } from '../../hooks/useKyoshinDetection'
import { MIN_DETECTION_INDEX } from '../../hooks/useKyoshinDetection'
import type { SiteCoords } from '../../services/kyoshin'
import type { SWaveArrival } from '../../hooks/useSWaveCountdown'
import { formatDateTime, formatTime } from '../../utils/formatters'
import { getIntensityColor, getIntensityLabel, getIntensityBgColor, getMagnitudeColor, getDepthColor } from '../../utils/intensity'
import { getLpgmClassLabel, getLpgmClassColor, getLpgmClassBgColor } from '../../utils/lpgm'
import { eewAreas, eewMaxScale, eewSerial } from '../../utils/eew'
import { kyoshinIndexToLabel, kyoshinIntensityColor, SHINDO0_COLOR } from '../../utils/kyoshinIntensity'

// 凡例は地図と同じ気象庁の震度配色（getIntensityColor）を使う。scale=0 は震度0（灰色）。
const SCALE_LEGEND: { label: string; scale: number }[] = [
  { label: '0', scale: 0 },
  { label: '1', scale: 10 },
  { label: '2', scale: 20 },
  { label: '3', scale: 30 },
  { label: '4', scale: 40 },
  { label: '5弱', scale: 45 },
  { label: '5強', scale: 50 },
  { label: '6弱', scale: 55 },
  { label: '6強', scale: 60 },
  { label: '7', scale: 70 },
]

interface Props {
  eews: EEWAlert[]
  kyoshinDetection: KyoshinDetection
  kyoshinSites: SiteCoords
  kyoshinIndices: number[]
  swaveArrival: SWaveArrival | null
}

function EEWCard({ eew }: { eew: EEWAlert }) {
  const maxScale = eewMaxScale(eew)
  const isWarning = eew.severity === 'Warning'
  const isSpecial = isWarning && maxScale >= 55
  const areas = eewAreas(eew)
  const serial = eewSerial(eew)
  const { hypocenter } = eew.earthquake
  const prefAreas = areas.filter(a => a.pref)

  const typeLabel = isSpecial ? '特別警報' : isWarning ? '警報' : '予報'
  const headerBg = isSpecial ? '#4c0519' : isWarning ? '#450a0a' : '#451a03'
  const headerColor = isSpecial ? '#fca5a5' : isWarning ? '#f87171' : '#fcd34d'
  const headerBorder = isSpecial ? '#dc2626' : isWarning ? '#ef4444' : '#d97706'
  const cardBorder = isSpecial ? '#fca5a5' : isWarning ? '#ef4444' : '#eab308'

  const magColor = getMagnitudeColor(hypocenter.magnitude)
  const depthColor = getDepthColor(hypocenter.depth)

  // 到達予想時刻が設定された地域を時刻順にソート
  const areasWithArrival = areas
    .filter(a => a.arrivalTime)
    .sort((a, b) => a.arrivalTime!.localeCompare(b.arrivalTime!))
    .slice(0, 6)

  return (
    <div
      className="bg-card rounded-lg overflow-hidden"
      style={{
        border: `2px solid ${cardBorder}`,
        boxShadow: `0 0 0 1px ${cardBorder}40`,
      }}
    >
      {/* 種別ヘッダー */}
      <div
        className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
        style={{
          backgroundColor: headerBg,
          color: headerColor,
          borderBottom: `1px solid ${headerBorder}`,
        }}
      >
        緊急地震速報（{typeLabel}）
        {serial != null && (
          <span className="ml-2 font-normal opacity-75">
            #{serial}{eew.isFinal ? ' 最終報' : ''}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2 p-3">
        {/* 最大震度バナー */}
        <div
          className="w-full rounded-lg py-3 px-4 flex items-center justify-center gap-4"
          style={{
            backgroundColor: maxScale > 0 ? getIntensityBgColor(maxScale) : 'rgba(42,42,42,0.8)',
            border: `2px solid ${maxScale > 0 ? getIntensityColor(maxScale) : '#4b5563'}`,
          }}
        >
          <span
            className="text-sm font-medium"
            style={{ color: maxScale > 0 ? getIntensityColor(maxScale) : '#9ca3af' }}
          >
            最大震度予想
          </span>
          <span
            className="font-black leading-none"
            style={{ fontSize: '72px', color: '#ffffff' }}
          >
            {maxScale > 0 ? getIntensityLabel(maxScale) : '?'}
          </span>
        </div>

        {/* 推定最大長周期地震動階級 */}
        {eew.forecastMaxLpgmClass != null && eew.forecastMaxLpgmClass >= 1 && (
          <div
            className="w-full rounded-lg py-2 px-4 flex items-center justify-center gap-4"
            style={{
              backgroundColor: getLpgmClassBgColor(eew.forecastMaxLpgmClass),
              border: `2px solid ${getLpgmClassColor(eew.forecastMaxLpgmClass)}`,
            }}
          >
            <span className="text-sm font-medium" style={{ color: getLpgmClassColor(eew.forecastMaxLpgmClass) }}>
              推定長周期地震動
            </span>
            <span className="text-2xl font-black" style={{ color: '#ffffff' }}>
              {getLpgmClassLabel(eew.forecastMaxLpgmClass)}
            </span>
          </div>
        )}

        {/* 発生時刻 */}
        <div className="text-secondary" style={{ fontSize: '18px' }}>
          {formatDateTime(eew.earthquake.originTime)}ごろ
        </div>

        {/* 震源名 */}
        <div className="font-bold text-white leading-tight" style={{ fontSize: '26px' }}>
          {hypocenter.name || '震源調査中'}
        </div>

        {/* マグニチュード・深さ（2カラムグリッド） */}
        {hypocenter.name && (
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
              <span className="font-black leading-none" style={{ fontSize: '24px', color: '#ffffff' }}>
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
              <span className="font-black leading-none" style={{ fontSize: '24px', color: '#ffffff' }}>
                {hypocenter.depth}km
              </span>
            </div>
          </div>
        )}

        {/* 対象地域（警報域と予報域を区別して表示） */}
        {prefAreas.length > 0 && (() => {
          const isWarning = (k: string) => k === '10' || k === '11' || k === '19'
          const warningPrefs = [...new Set(prefAreas.filter(a => isWarning(a.kindCode)).map(a => a.pref))]
          const forecastPrefs = [...new Set(prefAreas.filter(a => !isWarning(a.kindCode)).map(a => a.pref))]
          const hasKindCode = prefAreas.some(a => a.kindCode !== '')
          if (!hasKindCode) {
            return (
              <div className="text-xs text-secondary leading-relaxed">
                対象: {prefAreas.slice(0, 8).map(a => a.pref).join(' / ')}
                {prefAreas.length > 8 && ' ...'}
              </div>
            )
          }
          return (
            <div className="flex flex-col gap-0.5 text-xs">
              {warningPrefs.length > 0 && (
                <div className="flex items-start gap-1 flex-wrap">
                  <span className="text-red-300 font-bold flex-shrink-0">警報:</span>
                  <span className="text-secondary">{warningPrefs.slice(0, 6).join(' / ')}{warningPrefs.length > 6 && ' ...'}</span>
                </div>
              )}
              {forecastPrefs.length > 0 && (
                <div className="flex items-start gap-1 flex-wrap">
                  <span className="text-yellow-300 flex-shrink-0">予報:</span>
                  <span className="text-secondary">{forecastPrefs.slice(0, 6).join(' / ')}{forecastPrefs.length > 6 && ' ...'}</span>
                </div>
              )}
            </div>
          )
        })()}

        {/* 到達予想時刻 */}
        {areasWithArrival.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-secondary">到達予想時刻</span>
            {areasWithArrival.map((a, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-secondary truncate mr-2">{a.name}</span>
                <span className="text-white font-mono flex-shrink-0">
                  {formatTime(a.arrivalTime!).slice(0, 5)}
                </span>
              </div>
            ))}
            {areas.filter(a => a.arrivalTime).length > 6 && (
              <span className="text-xs text-secondary">他{areas.filter(a => a.arrivalTime).length - 6}地域</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 震度ラベルの降順（表示ソート用）
const LABEL_ORDER = ['7', '6強', '6弱', '5強', '5弱', '4', '3', '2', '1']

function KyoshinDetectionCard({
  detection,
  hasEEW,
  kyoshinSites,
  kyoshinIndices,
}: {
  detection: KyoshinDetection
  hasEEW: boolean
  kyoshinSites: SiteCoords
  kyoshinIndices: number[]
}) {
  const useAllPoints = hasEEW || detection.detected

  if (!useAllPoints) return null

  // EEW受信中または検知中は全観測点の現在インデックスで集計、それ以外は確定点のみ
  const counts = new Map<string, { color: string; count: number }>()
  let maxIndex = 0

  if (hasEEW || detection.detected) {
    for (let i = 0; i < kyoshinIndices.length; i++) {
      const idx = kyoshinIndices[i]
      if (idx < MIN_DETECTION_INDEX) continue
      const site = kyoshinSites[i]
      if (!site) continue
      const label = kyoshinIndexToLabel(idx)
      if (!label) continue
      if (!counts.has(label)) counts.set(label, { color: kyoshinIntensityColor(idx) ?? '#9ca3af', count: 0 })
      counts.get(label)!.count++
      if (idx > maxIndex) maxIndex = idx
    }
  }

  // 全点集計が空の場合は確定点にフォールバック
  if (counts.size === 0) {
    for (const p of detection.points) {
      const label = kyoshinIndexToLabel(p.index)
      if (!label) continue
      if (!counts.has(label)) counts.set(label, { color: kyoshinIntensityColor(p.index) ?? '#9ca3af', count: 0 })
      counts.get(label)!.count++
      if (p.index > maxIndex) maxIndex = p.index
    }
  }

  if (counts.size === 0) return null

  const maxLabel = kyoshinIndexToLabel(maxIndex)
  if (!maxLabel) return null
  const maxColor = kyoshinIntensityColor(maxIndex) ?? '#9ca3af'

  const groups = LABEL_ORDER.filter(l => counts.has(l)).map(l => ({ label: l, ...counts.get(l)! }))

  return (
    <div className="rounded-lg p-3 border border-border bg-card">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="inline-block w-2 h-2 rounded-full animate-pulse flex-shrink-0"
          style={{ backgroundColor: maxColor }}
        />
        <span className="text-xs text-secondary">揺れを検知中（強震モニタ）</span>
      </div>
      <div className="flex items-center gap-3 mb-2">
        <span className="text-xs text-secondary">推定最大震度</span>
        <span
          className="font-black text-5xl leading-none"
          style={{
            color: '#ffffff',
            textShadow: `0 0 12px ${maxColor}, 0 2px 4px rgba(0,0,0,0.8)`,
          }}
        >
          {maxLabel}
        </span>
      </div>
      <div className="space-y-1">
        {groups.map(g => (
          <div key={g.label} className="flex items-center gap-2">
            <span
              className="inline-block w-6 text-center text-xs font-bold rounded py-0.5 flex-shrink-0"
              style={{ backgroundColor: g.color, color: '#fff' }}
            >
              {g.label}
            </span>
            <span className="text-xs text-secondary">{g.count}点</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-secondary mt-2">※推定値。気象庁発表とは異なる場合があります</p>
    </div>
  )
}

function SWaveArrivalCard({ arrival }: { arrival: SWaveArrival }) {
  const borderColor = arrival.arrived ? '#ef4444' : '#f97316'
  return (
    <div className="bg-card rounded-lg p-3 border-2" style={{ borderColor }}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: borderColor }}
        />
        <span className="text-xs font-bold" style={{ color: borderColor }}>
          {arrival.arrived ? 'S波 到達済み' : 'S波 到達カウントダウン'}
        </span>
        <span className="text-xs text-secondary ml-auto">震源から {arrival.distanceKm.toFixed(0)} km</span>
      </div>
      {arrival.arrived ? (
        <p className="text-red-400 font-bold text-sm">ご自宅付近にS波が到達しています</p>
      ) : arrival.etaSec !== null ? (
        <div className="flex items-baseline gap-2">
          <span className="text-4xl font-black text-white">{arrival.etaSec}</span>
          <span className="text-sm text-secondary">秒後に到達予想</span>
        </div>
      ) : (
        <p className="text-sm text-secondary">到達時間を推定中…</p>
      )}
      <p className="text-xs text-secondary mt-1">※推定値。実際の到達時間は異なる場合があります</p>
    </div>
  )
}

export function RealtimeTab({ eews, kyoshinDetection, kyoshinSites, kyoshinIndices, swaveArrival }: Props) {
  return (
    <div className="flex flex-col min-h-full p-3 gap-3">
      {/* データカード */}
      {[...eews]
        .sort((a, b) => eewMaxScale(b) - eewMaxScale(a))
        .map(eew => <EEWCard key={eew.id} eew={eew} />)
      }
      {swaveArrival !== null && <SWaveArrivalCard arrival={swaveArrival} />}
      <KyoshinDetectionCard
        detection={kyoshinDetection}
        hasEEW={eews.length > 0}
        kyoshinSites={kyoshinSites}
        kyoshinIndices={kyoshinIndices}
      />

      {/* スペーサー：データが少ないときに情報セクションを下部へ押し出す */}
      <div className="flex-1" />

      {/* 情報セクション（説明・凡例・出典）*/}
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-white font-bold text-sm mb-1">リアルタイム震度モニタ</h2>
          <p className="text-secondary text-xs leading-relaxed">
            各観測点のリアルタイム震度を地図に表示します。1秒ごとに更新されます。
            緊急地震速報の発報時は予報円（青=P波 / 赤=S波）も表示します。
          </p>
        </div>

        {/* 震度スケール凡例 */}
        <div className="bg-card rounded-lg p-3 border border-border">
          <p className="text-white text-xs font-bold mb-2">震度スケール</p>
          <div className="flex gap-2 flex-wrap">
            {SCALE_LEGEND.map((item) => (
              <div key={item.label} className="flex items-center gap-1">
                <div
                  className="w-4 h-4 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: item.scale === 0 ? SHINDO0_COLOR : getIntensityColor(item.scale) }}
                />
                <span className="text-xs text-secondary">{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 注記 */}
        <div className="bg-card rounded-lg p-3 border border-border">
          <p className="text-secondary text-xs leading-relaxed">
            ※ データ出典: Yahoo!天気・災害 リアルタイム震度（防災科学技術研究所 強震モニタ）。
            表示される震度はリアルタイムの推定値であり、気象庁が発表する震度とは異なる場合があります。
          </p>
        </div>
      </div>
    </div>
  )
}
