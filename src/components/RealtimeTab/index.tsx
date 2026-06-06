// リアルタイムタブの右パネル。地図エリアは JapanMap が強震モニタ（観測点）と
// 予報円を描画し、ここでは EEW 情報カード・説明・震度スケール凡例・注記を表示する。
import type { EEWAlert } from '../../types/earthquake'
import type { KyoshinDetection } from '../../hooks/useKyoshinDetection'
import { formatDateTime } from '../../utils/formatters'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
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
  eew: EEWAlert | null
  kyoshinDetection: KyoshinDetection
}

function EEWCard({ eew }: { eew: EEWAlert }) {
  const isWarning = eew.severity === 'Warning'
  const maxScale = eewMaxScale(eew)
  const areas = eewAreas(eew)
  const serial = eewSerial(eew)
  const { hypocenter } = eew.earthquake

  return (
    <div
      className={`rounded-lg p-3 border ${
        isWarning ? 'bg-red-900/40 border-red-600' : 'bg-orange-900/40 border-orange-600'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-secondary">緊急地震速報</span>
        <span className={`text-sm font-black ${isWarning ? 'text-red-300' : 'text-orange-300'}`}>
          {isWarning ? '警報' : '予報'}
        </span>
        {serial != null && <span className="text-xs text-secondary">#{serial}</span>}
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-white font-bold text-base">{hypocenter.name}</span>
        <span className="text-white text-sm">M{hypocenter.magnitude.toFixed(1)}</span>
        {maxScale > 0 && (
          <span className="text-white text-sm font-bold">最大震度{getIntensityLabel(maxScale)}予想</span>
        )}
      </div>
      <div className="text-xs text-secondary mt-1">
        深さ {hypocenter.depth}km / {formatDateTime(eew.earthquake.originTime)}
      </div>
      {areas.length > 0 && (
        <div className="text-xs text-secondary mt-1 leading-relaxed">
          対象: {areas.slice(0, 6).map(a => a.pref).join(' / ')}
          {areas.length > 6 && ' ...'}
        </div>
      )}
    </div>
  )
}

// 震度ラベルの降順（表示ソート用）
const LABEL_ORDER = ['7', '6強', '6弱', '5強', '5弱', '4', '3', '2', '1']

function KyoshinDetectionCard({ detection }: { detection: KyoshinDetection }) {
  if (!detection.detected || detection.points.length === 0) return null

  const maxLabel = kyoshinIndexToLabel(detection.maxIndex)
  if (!maxLabel) return null
  const maxColor = kyoshinIntensityColor(detection.maxIndex) ?? '#9ca3af'

  // 検知点を震度ラベルごとに集計
  const counts = new Map<string, { color: string; count: number }>()
  for (const p of detection.points) {
    const label = kyoshinIndexToLabel(p.index)
    if (!label) continue
    if (!counts.has(label)) counts.set(label, { color: kyoshinIntensityColor(p.index) ?? '#9ca3af', count: 0 })
    counts.get(label)!.count++
  }
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
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <span className="text-white text-sm">推定最大震度</span>
        <span className="font-black text-xl" style={{ color: maxColor }}>{maxLabel}</span>
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

export function RealtimeTab({ eew, kyoshinDetection }: Props) {
  return (
    <div className="p-3 space-y-3">
      {eew && <EEWCard eew={eew} />}
      <KyoshinDetectionCard detection={kyoshinDetection} />

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
  )
}
