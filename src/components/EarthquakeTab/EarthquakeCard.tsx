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
  hasMagnitude,
} from '../../utils/formatters'
import { getIntensityLabel, getIntensityColor, getIntensityBgColor, getDepthColor, getMagnitudeColor } from '../../utils/intensity'
import { buildAreaPrefIndex, buildPrefAreaNamesIndex } from '../../utils/stationCoords'
import { useStationCoords } from '../../hooks/useStationCoords'

/** issue.type に応じたバッジの Tailwind クラスを返す。 */
function issueTypeBadgeClass(type: IssueType): string {
  switch (type) {
    case '震度速報':
    case '震源情報':                         return 'bg-amber-900 text-amber-300'
    case '震源・震度情報':
    case '各地の震度情報':
    case '顕著な地震の震源要素更新のお知らせ': return 'bg-blue-900/60 text-blue-300'
    case '遠地地震':                          return 'bg-purple-900/60 text-purple-300'
    default:                                  return 'bg-panel text-secondary'
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
    case '震度速報':
    case '震源情報':
      return { headerBg: '#451a03', headerColor: '#fbbf24', headerBorder: '#b45309', cardBorder: '#b45309', cardBg: '#1c1710' }
    case '震源・震度情報':
    case '各地の震度情報':
    case '顕著な地震の震源要素更新のお知らせ':
      return { headerBg: '#0c2044', headerColor: '#93c5fd', headerBorder: '#1d4ed8', cardBorder: '#1d4ed8', cardBg: '#111827' }
    case '遠地地震':
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

  const stationData = useStationCoords()

  const prefGroups = useMemo(() => {
    if (!isSelected || !quake.points.length) return []

    // pref 設定済みの点（JSON prefectures[] 由来）→ 都道府県別の最大震度とする
    const prefMax = new Map<string, number>()
    for (const p of quake.points) {
      if (!p.pref) continue
      const cur = prefMax.get(p.pref) ?? -1
      if (p.scale > cur) prefMax.set(p.pref, p.scale)
    }

    // pref 未設定の一次細分区域点（JSON regions[] 由来）を実際の都道府県ごとにグルーピングし、
    // 県内全区域が同じ震度で揃っていれば「〇〇県」1件にまとめる（TTS 読み上げと同じ判定）。
    // 既に prefectures[] 側にデータがある都道府県は、行の重複を避けるため区域側を無視する。
    const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
    const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null
    const areaByPref = new Map<string, Map<string, number>>()
    for (const p of quake.points) {
      if (p.pref || !p.isArea) continue
      const pref = areaPrefIndex?.get(p.addr)
      if (!pref || prefMax.has(pref)) continue
      const set = areaByPref.get(pref) ?? new Map<string, number>()
      const cur = set.get(p.addr)
      if (cur == null || p.scale > cur) set.set(p.addr, p.scale)
      areaByPref.set(pref, set)
    }

    const result = new Map<string, number>(prefMax)
    for (const [pref, addrScales] of areaByPref) {
      const fullSet = prefAreaNames?.get(pref)
      const scales = new Set(addrScales.values())
      const isWholePref = fullSet != null && fullSet.size > 0
        && addrScales.size === fullSet.size
        && [...addrScales.keys()].every(n => fullSet.has(n))
        && scales.size === 1
      if (isWholePref) result.set(pref, [...scales][0])
      else for (const [name, scale] of addrScales) result.set(name, scale)
    }

    return Array.from(result.entries())
      .map(([pref, scale]) => ({ pref, scale }))
      .filter(({ scale }) => scale >= 0)
      .sort((a, b) => b.scale - a.scale)
  }, [isSelected, quake.points, stationData])

  // 長周期地震動の区域も、地震の震度と同じ考え方で県内全区域が同じ階級で揃っていれば
  // 「〇〇県」1件にまとめる（TTS の buildLpgmRegionText と同じ判定）。
  const lpgmGroups = useMemo(() => {
    const regions = lpgm?.regions?.filter(r => r.maxLgInt >= 1)
    if (!isSelected || !regions || regions.length === 0) return []

    const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
    const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null

    const noPref: { name: string; maxLgInt: number }[] = []
    const byPref = new Map<string, Map<string, number>>()
    for (const r of regions) {
      const pref = areaPrefIndex?.get(r.name)
      if (!pref) { noPref.push({ name: r.name, maxLgInt: r.maxLgInt }); continue }
      const set = byPref.get(pref) ?? new Map<string, number>()
      const cur = set.get(r.name)
      if (cur == null || r.maxLgInt > cur) set.set(r.name, r.maxLgInt)
      byPref.set(pref, set)
    }

    const result: { name: string; maxLgInt: number }[] = [...noPref]
    for (const [pref, nameClasses] of byPref) {
      const fullSet = prefAreaNames?.get(pref)
      const classes = new Set(nameClasses.values())
      const isWholePref = fullSet != null && fullSet.size > 0
        && nameClasses.size === fullSet.size
        && [...nameClasses.keys()].every(n => fullSet.has(n))
        && classes.size === 1
      if (isWholePref) result.push({ name: pref, maxLgInt: [...classes][0] })
      else for (const [name, maxLgInt] of nameClasses) result.push({ name, maxLgInt })
    }

    return result.sort((a, b) => b.maxLgInt - a.maxLgInt)
  }, [isSelected, lpgm, stationData])

  if (isSelected) {
    const typeStyle = getIssueTypeStyle(issue.type)
    const magColor = getMagnitudeColor(hypocenter.magnitude)
    const depthColor = getDepthColor(hypocenter.depth)

    return (
      <button
        ref={cardRef}
        type="button"
        onClick={quake.cancelledAt ? undefined : onSelect}
        aria-pressed={true}
        className={`w-full text-left bg-card rounded-lg border transition-colors overflow-hidden relative ${quake.cancelledAt ? 'cursor-default' : 'cursor-pointer hover:opacity-90'}`}
        style={{
          borderColor: typeStyle.cardBorder,
          boxShadow: `0 0 0 1px ${typeStyle.cardBorder}40`,
        }}
      >
        {quake.cancelledAt && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg">
            <span className="font-black text-white" style={{ fontSize: '3rem', lineHeight: 1.1 }}>キャンセル</span>
            <span className="text-sm font-bold text-white/90 mt-1">この地震情報は取り消されました</span>
          </div>
        )}
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

        {/* 画面が狭い・低い環境（roomy 未満＝スマホ縦/横）では余白と文字を詰め、
            各地の震度がスクロールせずに見えるようにする。roomy 以上は従来の寸法。 */}
        <div className="flex flex-col gap-1.5 p-2 roomy:gap-2 roomy:p-3">
          {/* 最大震度（横並び） */}
          <div
            className="w-full rounded-lg py-1.5 px-3 flex items-center justify-center gap-2 roomy:py-3 roomy:px-5 roomy:gap-4"
            style={{
              backgroundColor: getIntensityBgColor(maxScale),
              border: `2px solid ${getIntensityColor(maxScale)}`,
            }}
          >
            <span className="text-sm font-medium roomy:text-base" style={{ color: getIntensityColor(maxScale) }}>
              最大震度
            </span>
            <span
              className="font-black leading-none text-[3.25rem] roomy:text-[5.5rem]"
              style={{ color: '#ffffff' }}
            >
              {maxScale === -1 ? '?' : getIntensityLabel(maxScale)}
            </span>
          </div>

          {/* 長周期地震動観測情報（クリックで地図表示トグル）。
              カード自体が<button>のため、ネスト禁止のHTML仕様に合わせ<div role="button">にする。 */}
          {lpgm && lpgm.maxClass >= 1 && (
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onToggleLpgm?.(lpgm.eventId) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onToggleLpgm?.(lpgm.eventId) } }}
              className="w-full rounded-lg py-1 px-3 flex items-center justify-center gap-2 hover:opacity-80 transition-opacity cursor-pointer roomy:py-2 roomy:px-4 roomy:gap-4"
              style={{
                backgroundColor: getLpgmClassBgColor(lpgm.maxClass),
                // 枠線・アウトラインは装飾のヘアラインのため px 据え置き（UI 倍率に連動させない）。
                // 文字・余白側は rem で書いてあり倍率に追従する。
                border: `2px solid ${getLpgmClassColor(lpgm.maxClass)}`,
                outline: activeLpgmEventId === lpgm.eventId
                  ? `2px solid ${getLpgmClassColor(lpgm.maxClass)}`
                  : undefined,
                outlineOffset: '2px',
              }}
            >
              <span className="text-xs font-medium roomy:text-sm" style={{ color: getLpgmClassColor(lpgm.maxClass) }}>
                長周期地震動
              </span>
              <span className="text-xl font-black roomy:text-2xl" style={{ color: '#ffffff' }}>
                {getLpgmClassLabel(lpgm.maxClass)}
              </span>
            </div>
          )}

          {/* 日時 + 訂正情報 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-secondary text-base roomy:text-xl">
              {formatQuakeTime(earthquake.time)}
            </span>
            {issue.correct !== 'なし' && (
              <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                {formatCorrectType(issue.correct)}
              </span>
            )}
          </div>

          {/* 震源地 */}
          <div className="font-bold text-white leading-tight text-[1.375rem] roomy:text-[1.875rem]">
            {hasLocation ? hypocenter.name : '震源調査中'}
          </div>

          {/* マグニチュード・深さ（2カラムグリッド） */}
          {hasLocation && (
            <div className="grid grid-cols-2 gap-2">
              <div
                className="flex flex-col gap-0.5 rounded-lg p-2 roomy:gap-1 roomy:p-2.5"
                style={{
                  backgroundColor: `${magColor}26`,
                  border: `2px solid ${magColor}`,
                }}
              >
                <span className="text-xs font-medium tracking-wide" style={{ color: magColor }}>
                  マグニチュード
                </span>
                <span className="font-black leading-none text-[1.375rem] roomy:text-[1.75rem]" style={{ color: '#ffffff' }}>
                  {/* 規模不明（-1／NaN）を toFixed に通すと "-1.0"／"NaN" と表示される。深さ側の formatDepth と揃える */}
                  {hasMagnitude(hypocenter.magnitude) ? hypocenter.magnitude.toFixed(1) : '不明'}
                </span>
              </div>
              <div
                className="flex flex-col gap-0.5 rounded-lg p-2 roomy:gap-1 roomy:p-2.5"
                style={{
                  backgroundColor: `${depthColor}26`,
                  border: `2px solid ${depthColor}`,
                }}
              >
                <span className="text-xs font-medium tracking-wide" style={{ color: depthColor }}>
                  深さ
                </span>
                <span className="font-black leading-none text-[1.375rem] roomy:text-[1.75rem]" style={{ color: '#ffffff' }}>
                  {formatDepth(hypocenter.depth)}
                </span>
              </div>
            </div>
          )}

          {/* 国内津波情報 */}
          <div
            className="w-full rounded-lg py-1 px-3 text-center font-bold text-sm roomy:py-2 roomy:text-base"
            style={{
              backgroundColor: `${tsunamiInfo.color}22`,
              border: `1px solid ${tsunamiInfo.color}`,
              color: tsunamiInfo.color,
            }}
          >
            {tsunamiInfo.text}
          </div>

          {/* 震源の緯度・経度 */}
          {hasLocation && (
            <div className="text-xs text-secondary roomy:text-sm">
              北緯 {hypocenter.latitude.toFixed(1)}° 東経 {hypocenter.longitude.toFixed(1)}°
            </div>
          )}

          {/* 各地の震度 / 長周期地震動階級（LPGM トグルオン時は階級表示に切り替え） */}
          {(() => {
            const isLpgmActive = lpgm && activeLpgmEventId === lpgm.eventId

            if (isLpgmActive && lpgmGroups.length > 0) {
              return (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
                  {lpgmGroups.map(({ name, maxLgInt }, idx) => (
                    <div
                      key={name}
                      className="flex items-center justify-between px-2 py-1 rounded roomy:py-1.5"
                      style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                    >
                      <span
                        className="font-bold flex-shrink-0 whitespace-nowrap text-[0.9375rem] roomy:text-[1.125rem]"
                        style={{ color: getLpgmClassColor(maxLgInt) }}
                      >
                        長周期 {getLpgmClassLabel(maxLgInt)}
                      </span>
                      <span className="text-white text-[0.9375rem] roomy:text-[1.125rem]">{name}</span>
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
                    className="flex items-center justify-between px-2 py-1 rounded roomy:py-1.5"
                    style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                  >
                    <span
                      className="font-bold flex-shrink-0 whitespace-nowrap text-[0.9375rem] roomy:text-[1.125rem]"
                      style={{ color: getIntensityColor(scale) }}
                    >
                      震度{getIntensityLabel(scale)}
                    </span>
                    <span className="text-white text-[0.9375rem] roomy:text-[1.125rem]">{pref}</span>
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
      onClick={quake.cancelledAt ? undefined : onSelect}
      aria-pressed={false}
      className={`
        w-full text-left bg-card rounded-lg p-3 border transition-colors relative
        ${quake.cancelledAt ? 'cursor-default' : 'cursor-pointer hover:border-blue-400/60'}
        ${borderClass}
      `}
    >
      {quake.cancelledAt && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg">
          <span className="font-black text-white" style={{ fontSize: '1.75rem', lineHeight: 1.1 }}>キャンセル</span>
          <span className="text-xs font-bold text-white/90 mt-1">この地震情報は取り消されました</span>
        </div>
      )}
      <div className="flex items-stretch gap-3">
        {/* 震度バッジ。7rem 角の正方形に固定する。右カラム（通常は 4 行）の高さとほぼ同じ寸法で、
            カードの高さいっぱいに見える。
            高さを右カラムに追従させる（`aspect-square` + stretch）方式は採らない。この行は高さが
            兄弟の内容次第で決まるため、幅を確定する時点では高さが未定で、aspect-ratio が幅を
            導けずコンテンツ幅（実測 60px）に潰れる。高さを固定した親の中でなら成立する手だが、
            ここでは使えない。
            寸法を固定した結果、右カラムが何行になってもバッジは正方形のまま保たれる。 */}
        <div
          className="flex-shrink-0 self-center w-28 h-28 rounded-lg flex flex-col items-center justify-center px-1"
          style={{
            backgroundColor: getIntensityBgColor(maxScale),
            border: `2px solid ${getIntensityColor(maxScale)}`,
          }}
        >
          <span className="text-xs font-medium" style={{ color: getIntensityColor(maxScale) }}>
            最大震度
          </span>
          <span
            className="text-5xl font-black leading-tight"
            style={{ color: getIntensityColor(maxScale) }}
          >
            {maxScale === -1 ? '?' : getIntensityLabel(maxScale)}
          </span>
        </div>

        {/* 地震詳細 */}
        <div className="flex-1 min-w-0">
          {/* 震源地名。1 行に固定し、収まらない分は末尾を省略する。
              「熊本県天草・芦北地方」級の名前が折り返すとカードだけが縦に伸びて一覧の行が
              揃わなくなるため、ここは伸ばさない。発表種別は日時の行へ逃がし、地名に幅を明け渡している。 */}
          <div className="text-white font-bold text-lg leading-tight truncate mb-1">
            {hasLocation ? hypocenter.name : '震源調査中'}
          </div>

          {/* 日時 + 発表種別 + 訂正情報。
              発表種別だけは末尾を省略して詰められるが、日時と訂正情報は縮まない。収まらない
              ときは折り返して 2 行にする。訂正報（`issue.correct !== 'なし'`）で 3 つ並ぶ場合の
              ほか、パネルが狭いときや種別名が長いとき（「顕著な地震の震源要素更新のお知らせ」）は
              2 つでも折り返す。詰め切って情報を欠けさせるより、カードが 1 行分高くなる方を
              選んでいる（震度バッジは寸法固定なので正方形は崩れない）。 */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-base text-secondary flex-shrink-0">{formatQuakeTime(earthquake.time)}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded min-w-0 truncate ${issueTypeBadgeClass(issue.type)}`}>
              {formatIssueType(issue.type)}
            </span>
            {issue.correct !== 'なし' && (
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
