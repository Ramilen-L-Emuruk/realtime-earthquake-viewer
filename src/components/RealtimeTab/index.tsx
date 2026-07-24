// リアルタイムタブの右パネル。地図エリアは JapanMap が強震モニタ（観測点）と
// 予報円を描画し、ここでは EEW 情報カード・強震モニタ検知(V2)カード・震度スケール凡例・注記を表示する。
import { useMemo } from 'react'
import type { EEWAlert } from '../../types/earthquake'
import type { DetectionEvent, Confidence } from '../../utils/kyoshinDetector'
import { MIN_DETECTION_INDEX, buildSiteIndex, resolveMembers, type DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { SiteCoords } from '../../services/kyoshin'
import type { SWaveArrival } from '../../hooks/useSWaveCountdown'
import { formatDateTime, formatTime } from '../../utils/formatters'
import { getIntensityColor, getIntensityLabel, getIntensityBgColor, getMagnitudeColor, getDepthColor } from '../../utils/intensity'
import { getLpgmClassLabel, getLpgmClassColor, getLpgmClassBgColor } from '../../utils/lpgm'
import { eewAreas, eewMaxScale, eewSerial } from '../../utils/eew'
import { kyoshinIndexToJma, kyoshinIndexToLabel, kyoshinIntensityColor, SHINDO0_COLOR } from '../../utils/kyoshinIntensity'

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
  kyoshinSites: SiteCoords
  kyoshinIndices: number[]
  swaveArrival: SWaveArrival | null
  /** V2 検知エンジンの検知イベント（音・自動タブ切替・自動フィット・カード表示を駆動）。 */
  kyoshinV2Detections: DetectionEvent[]
  activeLpgmEventId?: string | null
  onToggleLpgm?: (eventId: string) => void
  onDeactivateLpgm?: () => void
}

function EEWCard({ eew, activeLpgmEventId, onToggleLpgm, onDeactivateLpgm }: {
  eew: EEWAlert
  activeLpgmEventId?: string | null
  onToggleLpgm?: (eventId: string) => void
  onDeactivateLpgm?: () => void
}) {
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
      className="bg-card rounded-lg overflow-hidden relative"
      style={{
        border: `2px solid ${cardBorder}`,
        boxShadow: `0 0 0 1px ${cardBorder}40`,
      }}
      onClick={onDeactivateLpgm}
    >
      {eew.cancelledAt && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg">
          <span className="font-black text-white" style={{ fontSize: '48px', lineHeight: 1.1 }}>キャンセル</span>
          <span className="text-sm font-bold text-white/90 mt-1">この緊急地震速報は取り消されました</span>
        </div>
      )}
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
        {maxScale > 0 ? (
          <div
            className="w-full rounded-lg py-3 px-4 flex items-center justify-center gap-4"
            style={{
              backgroundColor: getIntensityBgColor(maxScale),
              border: `2px solid ${getIntensityColor(maxScale)}`,
            }}
          >
            <span className="text-sm font-medium" style={{ color: getIntensityColor(maxScale) }}>
              予想最大震度
            </span>
            <span className="font-black leading-none" style={{ fontSize: '72px', color: '#ffffff' }}>
              {getIntensityLabel(maxScale)}
            </span>
          </div>
        ) : (
          <div
            className="w-full rounded-lg py-3.5 px-4 flex flex-col items-center justify-center gap-1"
            style={{ backgroundColor: 'rgba(42,42,42,0.8)', border: '2px solid #4b5563' }}
          >
            {eew.earthquake.condition === '仮定震源要素' ? (
              <span className="text-xs font-medium" style={{ color: '#9ca3af' }}>単独点処理のため</span>
            ) : eew.earthquake.hypocenter.depth > 150 ? (
              <span className="text-xs font-medium" style={{ color: '#9ca3af' }}>深発地震のため</span>
            ) : null}
            <span className="text-xl font-extrabold" style={{ color: '#e5e7eb' }}>予想震度なし</span>
          </div>
        )}

        {/* 推定最大長周期地震動階級（クリックで地図表示トグル） */}
        {eew.forecastMaxLpgmClass != null && eew.forecastMaxLpgmClass >= 1 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleLpgm?.(eew.issue?.eventId ?? eew.id) }}
            className="w-full rounded-lg py-2 px-4 flex items-center justify-center gap-4 hover:opacity-80 transition-opacity"
            style={{
              backgroundColor: getLpgmClassBgColor(eew.forecastMaxLpgmClass),
              border: `2px solid ${getLpgmClassColor(eew.forecastMaxLpgmClass)}`,
              outline: activeLpgmEventId === (eew.issue?.eventId ?? eew.id)
                ? `2px solid ${getLpgmClassColor(eew.forecastMaxLpgmClass)}`
                : undefined,
              outlineOffset: '2px',
            }}
          >
            <span className="text-sm font-medium" style={{ color: getLpgmClassColor(eew.forecastMaxLpgmClass) }}>
              推定長周期地震動
            </span>
            <span className="text-2xl font-black" style={{ color: '#ffffff' }}>
              {getLpgmClassLabel(eew.forecastMaxLpgmClass)}
            </span>
          </button>
        )}

        {/* 発生時刻 */}
        <div className="text-secondary" style={{ fontSize: '18px' }}>
          {formatDateTime(eew.earthquake.originTime)}ごろ
        </div>

        {/* 震源名 */}
        <div className="font-bold text-white leading-tight" style={{ fontSize: '26px' }}>
          {hypocenter.name || '震源調査中'}
        </div>

        {/* マグニチュード・深さ（2カラムグリッド）：仮定震源要素（単独点処理）時は仮定値のため非表示 */}
        {hypocenter.name && eew.earthquake.condition !== '仮定震源要素' && (
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
const LABEL_ORDER = ['7', '6強', '6弱', '5強', '5弱', '4', '3', '2', '1', '0']

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

// 検知エンジンの確信度別スタイル。confirmed=赤・likely=橙・faint=淡青(震度0級・無音)・weak=灰。
const V2_TIER: Record<Confidence, { label: string; color: string; bg: string; border: string }> = {
  confirmed: { label: '検知', color: '#f87171', bg: '#450a0a', border: '#ef4444' },
  likely: { label: '可能性', color: '#fcd34d', bg: '#451a03', border: '#d97706' },
  faint: { label: '微弱', color: '#93c5fd', bg: 'rgba(30,41,59,0.55)', border: '#3b5b80' },
  weak: { label: '検出', color: '#9ca3af', bg: 'rgba(42,42,42,0.6)', border: '#4b5563' },
}

// 強震モニタ検知の集約カード。
// 近傍一致型の検知は震度5+ の大地震で有感域が複数の地域（連結成分）に分かれるため、コアは
// 複数の confirmed/likely イベントを同時に返す。これを「1 つの揺れ」として 1 枚に集約表示する
// （震源を推定しないため、揺れている地域数と全体の震度分布・推定最大震度を主情報とする）。
// 複数地域にまたがる場合は「広域」を示し、N 件の別地震のように見えるのを防ぐ。
function KyoshinDetectionSummary({ events, siteIndex }: { events: DetectionEvent[]; siteIndex: Map<string, DetectedPoint> }) {
  // 最上位ティア（confirmed > likely > faint）。faint のみ＝震度0級のコヒーレント揺れ（無音・控えめ表示）。
  const topTier: Confidence = events.some(e => e.confidence === 'confirmed')
    ? 'confirmed'
    : events.some(e => e.confidence === 'likely')
      ? 'likely'
      : 'faint'
  const tier = V2_TIER[topTier]
  const isFaint = topTier === 'faint'
  const heading = isFaint ? '微弱な揺れの兆候' : '強震モニタ検知'
  const regionCount = events.length
  const earliestMs = events.reduce((m, e) => Math.min(m, e.originTimeMs), Infinity)
  const time = new Date(earliestMs).toLocaleTimeString('ja-JP', { hour12: false })

  // 全イベントのメンバー観測点を和集合（重複除去）で集約し、震度分布・最大震度を集計する
  const memberKeys = [...new Set(events.flatMap(e => e.memberKeys))]
  const points = resolveMembers(memberKeys, siteIndex)
  const counts = new Map<string, { color: string; count: number }>()
  let maxIndex = 0
  let activeCount = 0
  for (const p of points) {
    if (p.index < MIN_DETECTION_INDEX) continue
    const label = kyoshinIndexToLabel(p.index)
    if (!label) continue
    if (!counts.has(label)) counts.set(label, { color: kyoshinIntensityColor(p.index) ?? '#9ca3af', count: 0 })
    counts.get(label)!.count++
    activeCount++
    if (p.index > maxIndex) maxIndex = p.index
  }
  const maxLabel = kyoshinIndexToLabel(maxIndex)
  const maxColor = kyoshinIntensityColor(maxIndex) ?? '#9ca3af'
  const groups = LABEL_ORDER.filter(l => counts.has(l)).map(l => ({ label: l, ...counts.get(l)! }))
  const maxCount = groups.reduce((m, g) => Math.max(m, g.count), 1)
  const totalActive = activeCount || events.reduce((s, e) => s + e.lastSize, 0)

  // カードの枠・背景は最大震度の気象庁配色に合わせる（地図マーカー・EEW カードと一貫）。
  // 確信度（検知/可能性/微弱）は枠色ではなく左上のチップで示す。
  // 震度1未満（faint＝震度0級で最大震度ラベルが無い）は震度色が定まらないため、確信度ティア色（淡青）へフォールバック。
  const maxJma = kyoshinIndexToJma(maxIndex)
  const hasIntensity = maxJma != null && maxJma.label !== '0'
  const frameBorder = hasIntensity ? getIntensityColor(maxJma.scale) : tier.border
  const frameBg = hasIntensity ? getIntensityBgColor(maxJma.scale) : tier.bg

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${frameBorder}`, backgroundColor: frameBg }}>
      {/* ヘッダー: 確信度チップ・広域バッジ・時刻。枠色は最大震度、チップ色は確信度で 2 軸を分離。 */}
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: `1px solid ${frameBorder}55` }}>
        <span className="text-xs font-bold px-1.5 py-0.5 rounded flex-shrink-0" style={{ backgroundColor: tier.border, color: '#fff' }}>
          {tier.label}
        </span>
        <span className="text-xs" style={{ color: tier.color }}>
          {regionCount >= 2 ? `${heading}（広域・${regionCount}地域）` : heading}
        </span>
        <span className="text-xs text-secondary ml-auto font-mono">{time}</span>
      </div>
      <div className="flex gap-3 p-3">
        {/* 推定最大震度 */}
        <div className="flex flex-col items-center justify-center flex-shrink-0" style={{ minWidth: '68px' }}>
          <span className="text-xs text-secondary">推定最大震度</span>
          <span className="font-black leading-none text-white" style={{ fontSize: '48px', textShadow: `0 0 12px ${maxColor}` }}>
            {maxLabel ?? '—'}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-w-0">
          {/* 震度分布（全メンバー観測点の集約） */}
          {groups.length > 0 && (
            <div className="flex flex-col gap-1">
              {groups.map(g => (
                <div key={g.label} className="flex items-center gap-2">
                  <span className="w-6 text-center text-xs font-bold rounded flex-shrink-0" style={{ backgroundColor: g.color, color: '#fff' }}>
                    {g.label}
                  </span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                    <div style={{ width: `${(g.count / maxCount) * 100}%`, height: '100%', background: g.color }} />
                  </div>
                  <span className="text-xs text-white w-8 text-right">{g.count}点</span>
                </div>
              ))}
            </div>
          )}
          <span className="text-xs text-secondary">
            {totalActive}観測点で反応{regionCount >= 2 ? ` ・ ${regionCount}地域` : ''} ・ 推定値
          </span>
        </div>
      </div>
    </div>
  )
}

export function RealtimeTab({ eews, kyoshinSites, kyoshinIndices, kyoshinV2Detections, swaveArrival, activeLpgmEventId, onToggleLpgm, onDeactivateLpgm }: Props) {
  // メンバー観測点キー → 現在の座標＋インデックスの索引（各カードの震度分布集計に使う）
  const siteIndex = useMemo(() => buildSiteIndex(kyoshinSites, kyoshinIndices), [kyoshinSites, kyoshinIndices])
  return (
    <div className="flex flex-col min-h-full p-3 gap-3">
      {/* データカード */}
      {[...eews]
        .sort((a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime))
        .map(eew => (
          <EEWCard
            key={eew.id}
            eew={eew}
            activeLpgmEventId={activeLpgmEventId}
            onToggleLpgm={onToggleLpgm}
            onDeactivateLpgm={onDeactivateLpgm}
          />
        ))
      }
      {swaveArrival !== null && <SWaveArrivalCard arrival={swaveArrival} />}

      {/* 強震モニタ検知: weak を除外した confirmed/likely を 1 つの揺れとして集約表示する。
          大地震では有感域が複数の地域（連結成分）に分かれてコアが複数イベントを返すため、
          N 件の別地震に見せず「広域・N地域」として 1 枚にまとめる。 */}
      {(() => {
        const events = [...kyoshinV2Detections].filter(d => d.confidence !== 'weak')
        if (events.length === 0) return null
        return (
          <div className="flex flex-col gap-2">
            <KyoshinDetectionSummary events={events} siteIndex={siteIndex} />
            <p className="text-xs text-secondary">※強震モニタによる推定値。気象庁発表とは異なる場合があります。</p>
          </div>
        )
      })()}

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
