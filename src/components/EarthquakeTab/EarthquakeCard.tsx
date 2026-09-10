import { useMemo, useRef, useEffect, useState } from 'react'
import type { JMAQuake, JMALpgm, IssueType, EarthquakePoint, IntensityScale, JMAEstimatedIntensity } from '../../types/earthquake'
import { getLpgmClassLabel, getLpgmClassColor, getLpgmClassBgColor, lpgmCategoryNote } from '../../utils/lpgm'
import { estimatedIntensityFor, estimatedIntensityAvailability } from '../../utils/estimatedIntensity'
import {
  formatQuakeTime,
  formatDepth,
  formatDomesticTsunami,
  formatIssueType,
  formatCorrectType,
  hasHypocenterFacts,
  hasMagnitude,
  formatMagnitudeValue,
  formatMagnitudeWithCondition,
  formatCoordinate,
} from '../../utils/formatters'
import { getIntensityLabel, getIntensityLabelWithOrAbove, getIntensityColor, getIntensityBgColor, getDepthColor, getMagnitudeColor } from '../../utils/intensity'
import { hasKnownEpicenter } from '../../utils/geo'

import { buildAreaPrefIndex, buildPrefAreaNamesIndex, buildRegionOrderIndex, buildStationPrefIndex, lookupStationRegion, regionOrderRank, byValueDescThenRegion } from '../../utils/stationCoords'
import { isMaxScaleUnreceived, partitionUnreceivedPoints, unreceivedUnitLabel, buildIntensityRows, makeAreaPrefResolver } from '../../utils/quakePoints'
import { useStationCoords } from '../../hooks/useStationCoords'
import { NON_JMA_BADGE_LABEL, NON_JMA_BADGE_TITLE } from '../Map/gl/popupHtml'
import { mergeUnreceivedPointNames, type UnreceivedPointName } from './unreceivedPointNames'

/**
 * 震度一覧の 1 行。都道府県・一次細分区域・市町村・観測点の 4 段で共有する。
 *
 * **段ごとに書き分けない。** 未入電の語（「5弱以上」「未入電あり」）と震度の色は 4 段とも
 * 同じ規則で、書き分けると片方だけ直したときに静かにずれる。
 *
 * **震度の色（`getIntensityColor`）は値だけで決め、段では変えない。** 段の区別に使うのは
 * 字下げ・文字の大きさと、地名の文字色（県の行だけ白、下の 3 段はグレー）、それに震度側の
 * 太字（県の行だけ）。
 *
 * **カード自体が `<button>` なので、開閉は `<div role="button">` で作る**（HTML はボタンの
 * 入れ子を許さない。長周期のトグルと同じ作法）。開けない段には `role` も `tabIndex` も
 * 与えない —— 押せない行がタブ移動で止まると邪魔になる。
 */
function IntensityRow({ label, scale, unreceived, hasUnreceived, nonJma, depth, expandKey, expanded, onToggle }: {
  label: string
  scale: IntensityScale
  unreceived: boolean
  hasUnreceived?: boolean
  nonJma?: boolean
  /** 字下げの段（0＝都道府県）。 */
  depth: 0 | 1 | 2 | 3
  /** 開閉の鍵。`null` なら開けない行。 */
  expandKey: string | null
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
}) {
  const isOpen = expandKey != null && expanded.has(expandKey)
  // 字下げと文字の大きさで段を示す（地名の色・太さも下で段によって変える）。
  // **震度の色は値だけで決める** —— 段の区別に流用すると、色が二通りの意味を持つ。
  const pad = ['pl-2', 'pl-5', 'pl-8', 'pl-11'][depth]
  const size = depth === 0
    ? 'text-[0.9375rem] roomy:text-[1.125rem]'
    : depth === 1 ? 'text-[0.875rem] roomy:text-[1rem]' : 'text-[0.8125rem] roomy:text-[0.9375rem]'
  const interactive = expandKey != null
  return (
    <div
      {...(interactive ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-expanded': isOpen,
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); onToggle(expandKey) },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onToggle(expandKey) }
        },
      } : {})}
      className={`flex items-center justify-between ${pad} pr-2 py-0.5 ${depth === 0 ? 'roomy:py-1.5' : ''} ${size}${interactive ? ' cursor-pointer hover:bg-white/5' : ''}`}
    >
      <span
        className={`flex-shrink-0 whitespace-nowrap${depth === 0 ? ' font-bold' : ''}`}
        style={{ color: getIntensityColor(scale) }}
      >
        {/* 未入電は「5弱以上」。観測値と同じ顔で出すと、実際にはもっと強い可能性があることが
            伝わらない。EEW の「上限を定めない予想震度」と同じ語を同じヘルパーで付ける。 */}
        震度{getIntensityLabelWithOrAbove(scale, unreceived)}
      </span>
      <span style={{ color: depth === 0 ? '#ffffff' : '#d1d5db' }}>
        {label}
        {/* 気象庁以外が運用する観測点。名前から `＊` を外してある分をここで伝える。 */}
        {nonJma && (
          <span className="ml-1.5 text-[0.6875rem] roomy:text-[0.8125rem]" style={{ color: '#9ca3af' }} title={NON_JMA_BADGE_TITLE}>
            {NON_JMA_BADGE_LABEL}
          </span>
        )}
        {/* **「あり」を付けて範囲の話にする。** 未入電は地点単位の事実なので、「〇〇県 未入電」
            だと県が丸ごと未入電に読める。どの地点かは上のブロックが示す。語は気象庁のものを
            そのまま使い、読み上げとも揃える。 */}
        {hasUnreceived && (
          <span
            className="ml-1.5 text-[0.75rem] roomy:text-[0.875rem]"
            style={{ color: '#9ca3af' }}
            title="この範囲に、震度が届いていない観測点があります"
          >
            未入電あり
          </span>
        )}
        {interactive && (
          <span className="ml-1.5 text-[0.75rem] roomy:text-[0.875rem]" style={{ color: '#9ca3af' }}>
            {isOpen ? '▾' : '▸'}
          </span>
        )}
      </span>
    </div>
  )
}

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
  /** アプリが持っている最新の推計震度分布図。この地震のものかはここで引き当てる。 */
  estimatedIntensity?: JMAEstimatedIntensity | null
  /** この地震の震度分布モードを開いているか。 */
  distributionActive?: boolean
  onToggleDistribution?: () => void
}

export function EarthquakeCard({
  quake, isLatest, isSelected, onSelect, lpgm, activeLpgmEventId, onToggleLpgm,
  estimatedIntensity = null, distributionActive = false, onToggleDistribution,
}: Props) {
  const { earthquake, issue } = quake
  const { hypocenter, maxScale, domesticTsunami } = earthquake
  // 電文全体の最大震度が「5弱以上・未入電」だったとき、見出しにも「以上」を付ける。
  // 付けないと、実際にはもっと強い可能性があることが見出しから読み取れない。
  const maxScaleLabel = maxScale === -1 ? '?' : getIntensityLabelWithOrAbove(maxScale, isMaxScaleUnreceived(maxScale, quake.points))
  const tsunamiInfo = formatDomesticTsunami(domesticTsunami)
  const hasLocation = hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude)
  // 規模・深さは位置と別に判定する（→ `hasHypocenterFacts`）
  const hasFacts = hasHypocenterFacts(hypocenter)
  // 長周期の「観測情報の種類」から出す一文（値 2・4 のときだけ。→ `lpgmCategoryNote`）。
  // 条件と本文の両方で使うので一度だけ計算する。
  const categoryNote = lpgmCategoryNote(lpgm?.category)
  // 震度分布ボタン。**引き当てはここで行う** —— この電文は識別子を持たないので、
  // 発現時刻で突き合わせる（→ `estimatedIntensityFor`）。
  const matchedEstimated = estimatedIntensityFor(quake, estimatedIntensity)
  const distributionState = estimatedIntensityAvailability(quake, matchedEstimated)
  // **描けるものが何も無いならボタンを出さない。** 公式が無く、観測点も 1 つも無い電文
  //（震度速報など区域しか持たないもの）では、押しても空の画面になるだけ。
  const canDrawDistribution = !!matchedEstimated || quake.points.some(p => !p.isArea)

  const cardRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (isSelected) {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const stationData = useStationCoords()

  /**
   * 開いている段。**既定はどこも畳んである。**
   *
   * 電文は県・一次細分区域・市町村・観測点の 4 段を持つ（→ docs/spec/quake-spec.md §8
   * 「震度一覧は 4 段の入れ子」。観測点と市町村の紐付けは同 §5）。
   * 平らに並べると能登本震で県 45 行に対し区域 119 行・観測点 2829 行になり、カード 1 枚で
   * 画面が埋まる。見たいところだけ開く。
   *
   * **市町村の鍵は区域名と組にする** —— 同じ名前の市町村が別の区域にありうる。
   * 地震ごとに独立した状態（このコンポーネントが地震 1 件につき 1 つ作られる）。
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  /**
   * 未入電の点を切り分けた結果と、名前の解決に使う索引。**バッジとブロックで共有する。**
   * 別々に解決すると、片方だけが名前を引けたときに「印は出るのに地点が出ない」
   * （またはその逆）という自己矛盾が起きる。
   *
   * **区域は電文が言っているものを先に使う**（`EarthquakePoint.area`）。行の組み立て
   * （`buildIntensityRows`）と同じ優先順位にしておかないと、座標テーブルを引けない観測点で
   * **行には出るのに印だけ付かない**という食い違いになる。
   *
   * **それでも所属を引けない場合、印を付ける行が決まらない。** DMDATA は観測点を `pref: ''` で
   * 積むため、区域を持たない経路（P2PQuake）で座標テーブルが未読み込みのあいだ（起動直後の
   * 数百 ms）や、電文の観測点がテーブルに無い場合は県も区域も引けない。そのときは印が出ないが、
   * **ブロックには地点名が出る**ので情報自体は失われない（→ docs/spec/quake-spec.md §4）。
   */
  const unreceivedIndexes = useMemo(() => {
    const stationPrefIndex = stationData ? buildStationPrefIndex(stationData) : null
    const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
    // 区域 → 県は**行の組み立てと同じ引き方を共有する**（`makeAreaPrefResolver`）。手で
    // 優先順位を揃えると、片方だけ直したときに黙ってずれる（実際にそれで、行は出るのに
    // 印だけ付かない状態を作った）。
    const prefOfArea = makeAreaPrefResolver(quake.cities ?? [], name => areaPrefIndex?.get(name) ?? null)
    const prefOf = (p: EarthquakePoint): string =>
      p.pref || prefOfArea(p.addr) || stationPrefIndex?.get(p.addr)
      || (p.area ? prefOfArea(p.area) ?? '' : '') || ''
    const regionOfStation = (p: EarthquakePoint): string | null => {
      if (p.area) return p.area
      const pref = prefOf(p)
      return pref && stationData ? lookupStationRegion(stationData, pref, p.addr) : null
    }
    const { stations, areas } = partitionUnreceivedPoints(quake.points, p => [
      regionOfStation(p) ?? '',
      prefOf(p),
    ])
    return { stationPrefIndex, areaPrefIndex, prefOf, regionOfStation, stations, areas }
  }, [quake.points, quake.cities, stationData])

  const prefGroups = useMemo(() => {
    if (!isSelected || !quake.points.length) return []

    // 「未入電あり」の印は、**その範囲に未入電の地点が 1 つでもあるか**で出す。行の最大が
    // 未入電かどうかでは判定しない —— 区域・県の最大震度は配下の最大なので、1 点でも観測値が
    // 届けばそちらが勝つ。最大だけを見ると「最大は観測できたが別の地点は未入電」という
    // **最も起きやすい形**で印が消える（→ docs/spec/quake-spec.md §4）。
    // **ブロックと同じ切り分け結果から作る**（`unreceivedIndexes`）。別々に解決すると、
    // 片方だけが名前を引けたときに「印は出るのに地点が出ない」（またはその逆）になる。
    const { stationPrefIndex, prefOf, regionOfStation, stations: unreceivedStations, areas: unreceivedAreaPoints } = unreceivedIndexes
    const unreceivedPrefs = new Set<string>()
    const unreceivedAreas = new Set<string>()
    for (const p of [...unreceivedStations, ...unreceivedAreaPoints]) {
      const pref = prefOf(p)
      if (pref) unreceivedPrefs.add(pref)
      // 区域点はそのまま。都道府県ロールアップ点（addr === pref）は県として既に数えている。
      if (p.isArea) { if (!p.pref) unreceivedAreas.add(p.addr) }
      else {
        const region = regionOfStation(p)
        if (region) unreceivedAreas.add(region)
      }
    }

    // 組み立ては `buildIntensityRows` に置いてある（電文の点だけを扱う純関数として試せるように）。
    // ここでは座標テーブル由来の索引を渡すだけ。
    const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
    const order = stationData ? buildRegionOrderIndex(stationData) : null
    return buildIntensityRows(quake.points, quake.cities ?? [], {
      prefOfArea: name => areaPrefIndex?.get(name) ?? null,
      prefOfStation: name => stationPrefIndex?.get(name) ?? null,
      regionOfStation: (pref, addr) => (stationData ? lookupStationRegion(stationData, pref, addr) : null),
      unreceivedPrefs,
      unreceivedAreas,
      rank: name => regionOrderRank(name, order),
    })
  }, [isSelected, quake.points, quake.cities, stationData, unreceivedIndexes])

  /**
   * 「震度を入手していない地点」。**未入電は観測点 1 つ 1 つに付く事実**なので、地点名で見せる
   * （気象庁も市町村・地点名で発表する。→ docs/spec/quake-spec.md §4）。県や区域の行に印を
   * 付けるだけでは、地点 1 つの話が範囲全体の話に見えてしまう。
   *
   * 地点を持たない電文（震度速報は区域しか持たない）では区域名で出す。
   * 並びは読み上げと同じ気象庁の標準順 —— 電文が点を並べた順に画面を委ねない。
   */
  const unreceivedPoints = useMemo(() => {
    const empty = { names: [] as UnreceivedPointName[], unit: '地点' }
    if (!isSelected) return empty
    const { prefOf, regionOfStation, stations, areas } = unreceivedIndexes
    if (stations.length === 0 && areas.length === 0) return empty
    const order = stationData ? buildRegionOrderIndex(stationData) : null
    const rank = (p: EarthquakePoint): number => (p.isArea
      ? regionOrderRank(p.addr, order)
      : regionOrderRank(regionOfStation(p) ?? prefOf(p), order))
    const ordered = [...stations, ...areas]
      .map((p, i) => ({ p, i, r: rank(p) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map(({ p }) => p)
    return {
      names: mergeUnreceivedPointNames(ordered),
      unit: unreceivedUnitLabel(stations.length > 0, areas.length > 0),
    }
  }, [isSelected, stationData, unreceivedIndexes])

  // 長周期地震動の区域も、地震の震度と同じ考え方で県内全区域が同じ階級で揃っていれば
  // 「〇〇県」1件にまとめる（TTS の buildLpgmRegionText と同じ判定）。
  const lpgmGroups = useMemo(() => {
    const regions = lpgm?.regions?.filter(r => r.maxLgInt >= 1)
    if (!isSelected || !regions || regions.length === 0) return []

    const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
    const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null

    // 区域の最大震度。**階級と並べると「揺れは小さいのに高層階が大きく揺れた」形が出る**
    // ——長周期地震動でいちばん伝えたい差がこれ。県へまとめた行では最も大きいものを採る。
    const maxIntByName = new Map<string, IntensityScale>()
    const noPref: { name: string; maxLgInt: number }[] = []
    const byPref = new Map<string, Map<string, number>>()
    for (const r of regions) {
      // **電文が都道府県名を書いているならそれを使う。** 座標表からの逆引きは
      // 電文に無かった頃の代理で、表に無い区域では引けずにまとめが崩れる。
      const pref = r.pref || areaPrefIndex?.get(r.name)
      const noteMaxInt = (key: string) => {
        if (r.maxInt === undefined) return
        const cur = maxIntByName.get(key)
        if (cur === undefined || r.maxInt > cur) maxIntByName.set(key, r.maxInt)
      }
      noteMaxInt(r.name)
      if (!pref) { noPref.push({ name: r.name, maxLgInt: r.maxLgInt }); continue }
      noteMaxInt(pref)
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
    // 行の見出し（区域名または県名）に紐づく最大震度を添える。
    //
    // **県の行は電文が書いている値を優先する。** 区域から積み上げると、区域の震度を
    // 1 つでも読み落としたとき静かに低く出る（パーサー側が `prefs` を用意しているのは
    // そのため。→ `LpgmPref`）。電文に無い県だけ、区域からの積み上げへ落とす。
    const prefMaxIntByName = new Map((lpgm?.prefs ?? []).map(p => [p.name, p.maxInt]))
    const withMaxInt = result.map(g => ({
      ...g,
      maxInt: prefMaxIntByName.get(g.name) ?? maxIntByName.get(g.name),
    }))

    // 階級の降順。同じ階級どうしは震度側と同じく気象庁の標準順で並べる（理由は上記）。
    const order = stationData ? buildRegionOrderIndex(stationData) : null
    return withMaxInt.sort(byValueDescThenRegion(g => g.maxLgInt, g => g.name, order))
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
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg px-4">
            <span className="font-black text-white" style={{ fontSize: '3rem', lineHeight: 1.1 }}>キャンセル</span>
            <span className="text-sm font-bold text-white/90 mt-1">この地震情報は取り消されました</span>
            {/* 気象庁が書いた取消しの概要（電文の `Body/Text`）。アプリが組み立てた文言ではないので
                そのまま出す。オーバーレイは 10 秒で消えるが、理由を捨てる理由にはならない。 */}
            {quake.cancelText && (
              // カードは `overflow-hidden` で、オーバーレイは `absolute inset-0`。**本文が下地の
              // 高さを超えると下が切れる**（読み上げは長文を画面へ委ねる設計なので、そこで切れると
              // 理由がどこにも残らない）。この要素の中でスクロールできるようにしておく。
              <span
                className="mt-2 text-center text-white/80 overflow-y-auto"
                style={{ fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-line', maxHeight: '40%' }}
              >
                {quake.cancelText}
              </span>
            )}
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
          {/* 電文が自分で名乗っている運用種別（`Control/Status`）。訓練・試験のときだけ出す。
              **本物と見分けられるようにする** —— 検証用に受信した試験報もカードへ流している。 */}
          {quake.operationStatus && (
            <span className="ml-2 px-1.5 py-0.5 rounded" style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}>
              {quake.operationStatus}報
            </span>
          )}
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
              {maxScaleLabel}
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
          {/* 電文の「観測情報の種類」（`LgCategory`）が伝えているのは、階級を観測した地域の中に
              震度が小さい地域があるかどうか。**分類番号は出さず意味だけ書く**（→ `lpgmCategoryNote`）。 */}
          {lpgm && lpgm.maxClass >= 1 && categoryNote && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {categoryNote}
            </div>
          )}
          {/* 付加文。固定（`ForecastComment/Text`。この地震について気象庁が添える定型文で、
              実電文では緊急地震速報の発表の有無を伝えている）・その他の固定
              （`VarComment/Text`）・自由（`FreeFormComment`。階級ごとの揺れの言い換え）の 3 種。
              **自由付加文は改行と空白を保つ**（地震情報側と同じ扱い。全角スペースの表が入る）。 */}
          {lpgm && lpgm.maxClass >= 1 && lpgm.forecastText && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {lpgm.forecastText}
            </div>
          )}
          {lpgm && lpgm.maxClass >= 1 && lpgm.varCommentText && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {lpgm.varCommentText}
            </div>
          )}
          {lpgm && lpgm.maxClass >= 1 && lpgm.freeFormText && (
            <div
              className="text-secondary"
              style={{ fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
            >
              {lpgm.freeFormText}
            </div>
          )}
          {/* 気象庁の詳細ページ（`Comments/URI`）。**アプリが出せないもの（波形・スペクトル）の
              在りかを電文自身が示している**ので、そこへ行ける導線を残す。 */}
          {lpgm && lpgm.maxClass >= 1 && lpgm.uri && (
            <a
              href={lpgm.uri}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-blue-400 underline w-fit"
              style={{ fontSize: '0.75rem', lineHeight: 1.5 }}
            >
              気象庁の詳細ページ（波形・スペクトル）
            </a>
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
          {hasFacts && (
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
                {/* 規模不明（-1／NaN）を toFixed に通すと "-1.0"／"NaN" と表示される。深さ側の formatDepth と揃える。
                    数値が無くても気象庁が説明を添えていればそれを出す（「Ｍ８を超える巨大地震」を
                    「不明」で潰さない）。説明は数値より長いので、そのときだけ字を小さくする。 */}
                <span
                  className={`font-black leading-none ${hypocenter.magnitudeCondition && !hasMagnitude(hypocenter.magnitude) ? 'text-[0.9375rem] roomy:text-[1.125rem] leading-snug' : 'text-[1.375rem] roomy:text-[1.75rem]'}`}
                  style={{ color: '#ffffff' }}
                >
                  {formatMagnitudeValue(hypocenter.magnitude, hypocenter.magnitudeCondition)}
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

          {/* 固定付加文（その他）。長周期地震動の同じ枠と揃えて出す。 */}
          {quake.varCommentText && (
            <div className="w-full rounded-lg bg-panel px-3 py-2 text-xs leading-relaxed text-secondary whitespace-pre-wrap roomy:text-sm">
              {quake.varCommentText}
            </div>
          )}

          {/* 気象庁の自由付加文。津波区分の定型文（forecastText）と違い電文ごとに書き起こされ、
              続報での更新はここに現れる（観測された津波の高さ・潮位変化の有無・次報の予定時刻など）。
              全角スペースで整形された表が入るため `whitespace-pre-wrap` で改行と空白を保つ。
              コンパクト表示（一覧）には出さない。行数が電文次第で読めず、カードの高さが揃わなくなるため。 */}
          {quake.freeText && (
            <div className="w-full rounded-lg bg-panel px-3 py-2 text-xs leading-relaxed text-secondary whitespace-pre-wrap roomy:text-sm">
              {quake.freeText}
            </div>
          )}

          {/* 震源の緯度・経度 */}
          {hasLocation && (
            <div className="text-xs text-secondary roomy:text-sm">
              {formatCoordinate(hypocenter.latitude, hypocenter.longitude)}
            </div>
          )}

          {/* 震度分布（クリックで地図の表示モードをトグル）。カード自体が <button> のため
              入れ子を許さない（長周期のトグルと同じ作法）。
              **どちらの分布を見ているかをボタンに書く。** 気象庁の推計とアプリ自身の推定は
              見た目が似ているので、書かないと利用者が区別できない。 */}
          {canDrawDistribution && (
            <div
              role="button"
              tabIndex={0}
              aria-pressed={distributionActive}
              onClick={(e) => { e.stopPropagation(); onToggleDistribution?.() }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onToggleDistribution?.() } }}
              title={distributionState === 'official'
                ? '気象庁が地盤の揺れやすさまで考慮して推計した震度の分布'
                : '観測点の震度をこのアプリが補間した目安。気象庁の推計とは精度が違う'}
              className={`w-full rounded-lg py-1 px-3 flex items-center justify-between gap-2 border transition-colors cursor-pointer hover:opacity-80 roomy:py-2 roomy:px-4 ${
                distributionActive
                  ? 'bg-blue-900/40 border-blue-500 outline outline-2 outline-offset-2 outline-blue-500'
                  : 'bg-panel border-border'
              }`}
            >
              <span className="text-xs font-medium text-white roomy:text-sm">震度分布</span>
              {/* **「推計」と「推定」だけでは分かれない。** どちらも日常語ではほぼ同義で、
                  精度の差（気象庁は地盤の揺れやすさまで織り込む／こちらは観測点を補間しただけ）が
                  読み取れない。**片方に「簡易」を入れて、語の重さで差を付ける。** */}
              <span className={`text-xs roomy:text-sm ${distributionState === 'official' ? 'text-blue-300 font-bold' : 'text-secondary'}`}>
                {distributionState === 'official' ? '気象庁の推計' : 'このアプリの簡易推定'}
              </span>
            </div>
          )}
          {canDrawDistribution && distributionState === 'awaiting' && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {/* **「待っています」だけで終えない。** 気象庁は「強い揺れの拡がりが足りないときは
                  発表されないことがある」と断っている。言い切ると、来ないまま待たされた利用者が
                  アプリの不具合だと思う。 */}
              気象庁の推計を待っています（発表されないこともあります）
            </div>
          )}

          {/* 各地の震度 / 長周期地震動階級（LPGM トグルオン時は階級表示に切り替え） */}
          {(() => {
            const isLpgmActive = lpgm && activeLpgmEventId === lpgm.eventId

            if (isLpgmActive && lpgmGroups.length > 0) {
              return (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
                  {lpgmGroups.map(({ name, maxLgInt, maxInt }, idx) => (
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
                      <span className="flex items-baseline gap-2 min-w-0">
                        {/* **震度を並べる。** 階級だけだと「揺れは小さいのに高層階が
                            大きく揺れた」形が読み取れない —— 長周期地震動で最も伝えたい差 */}
                        {maxInt !== undefined && (
                          <span className="text-[0.8125rem] text-gray-400 whitespace-nowrap roomy:text-[0.9375rem]">
                            震度 {getIntensityLabel(maxInt)}
                          </span>
                        )}
                        <span className="text-white text-[0.9375rem] roomy:text-[1.125rem]">{name}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )
            }

            if (prefGroups.length === 0 && unreceivedPoints.names.length === 0) return null

            return (
              <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
                {/* **地点の話は地点として見せる。** 震度一覧の上に置くのは、最も強く揺れた
                    かもしれない場所が分からないことが、最大震度の次に重要だから。 */}
                {unreceivedPoints.names.length > 0 && (
                  <div
                    className="mb-1 px-2 py-1.5 rounded"
                    style={{ backgroundColor: 'rgba(156,163,175,0.12)', border: '1px solid rgba(156,163,175,0.35)' }}
                  >
                    {/* **単位は中身に合わせる。** 地点を持たない電文（震度速報は区域しか
                        持たない）では区域名が並ぶので、見出しが「地点」のままだと粒度を
                        誤解させる。読み上げの「ほかN地点／ほかN地域」と同じ判定で切り替える。 */}
                    <div className="text-[0.75rem] roomy:text-[0.875rem] font-bold" style={{ color: '#d1d5db' }}>
                      震度を入手していない{unreceivedPoints.unit}
                    </div>
                    {/* **推定したのは気象庁**であることを書く。このアプリは強震モニタ由来の
                        値にも「推定」を使っており（リアルタイムタブ）、主語が無いと
                        「アプリが推定した値」と取り違えられる。 */}
                    <div className="text-[0.6875rem] roomy:text-[0.8125rem] mb-1" style={{ color: '#9ca3af' }}>
                      気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.8125rem] roomy:text-[1rem] text-white">
                      {/* 気象庁以外が運用する観測点は、電文では名前の末尾に `＊` が付く。
                          アプリは印を名前から外して引き当てに使うため、地図の吹き出しと
                          同じバッジで伝える。 */}
                      {unreceivedPoints.names.map(({ name, nonJma }) => (
                        <span key={name} className="inline-flex items-center gap-1">
                          {name}
                          {nonJma && (
                            <span
                              className="rounded px-1 text-[0.625rem] font-semibold leading-4 whitespace-nowrap"
                              style={{ color: '#cbd5e1', border: '1px solid #475569' }}
                              title={NON_JMA_BADGE_TITLE}
                            >
                              {NON_JMA_BADGE_LABEL}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {prefGroups.map((prefRow, idx) => (
                  <div
                    key={prefRow.pref}
                    className="rounded"
                    style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                  >
                    <IntensityRow
                      label={prefRow.pref}
                      scale={prefRow.scale}
                      unreceived={prefRow.unreceived}
                      hasUnreceived={prefRow.hasUnreceived}
                      depth={0}
                      expandKey={prefRow.regions.length > 0 ? `pref:${prefRow.pref}` : null}
                      expanded={expanded}
                      onToggle={toggle}
                    />
                    {expanded.has(`pref:${prefRow.pref}`) && prefRow.regions.map(region => (
                      <div key={region.name}>
                        <IntensityRow
                          label={region.name}
                          scale={region.scale}
                          unreceived={region.unreceived}
                          hasUnreceived={region.hasUnreceived}
                          depth={1}
                          expandKey={region.cities.length > 0 || region.stations.length > 0 ? `area:${region.name}` : null}
                          expanded={expanded}
                          onToggle={toggle}
                        />
                        {expanded.has(`area:${region.name}`) && (
                          <>
                            {region.cities.map(city => (
                              <div key={city.name}>
                                <IntensityRow
                                  label={city.name}
                                  scale={city.scale}
                                  unreceived={city.unreceived}
                                  hasUnreceived={city.hasUnreceived}
                                  depth={2}
                                  expandKey={city.stations.length > 0 ? `city:${region.name}/${city.name}` : null}
                                  expanded={expanded}
                                  onToggle={toggle}
                                />
                                {expanded.has(`city:${region.name}/${city.name}`) && city.stations.map(st => (
                                  <IntensityRow
                                    key={st.name}
                                    label={st.name}
                                    scale={st.scale}
                                    unreceived={st.unreceived}
                                    nonJma={st.nonJma}
                                    depth={3}
                                    expandKey={null}
                                    expanded={expanded}
                                    onToggle={toggle}
                                  />
                                ))}
                              </div>
                            ))}
                            {/* 市町村に紐付かない観測点（P2PQuake 経路はすべてこちら）。
                                → `IntensityRegionRow.stations` */}
                            {region.stations.map(st => (
                              <IntensityRow
                                key={st.name}
                                label={st.name}
                                scale={st.scale}
                                unreceived={st.unreceived}
                                nonJma={st.nonJma}
                                depth={2}
                                expandKey={null}
                                expanded={expanded}
                                onToggle={toggle}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
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
            {maxScaleLabel}
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
            {quake.operationStatus && (
              <span className="text-xs px-1.5 py-0.5 rounded font-bold flex-shrink-0" style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}>
                {quake.operationStatus}報
              </span>
            )}
            {issue.correct !== 'なし' && (
              <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                {formatCorrectType(issue.correct)}
              </span>
            )}
          </div>

          {/* 深さ・マグニチュード */}
          <div className="flex items-center gap-2 text-base mb-1">
            {hasFacts && (
              <span className="flex items-center gap-1 text-secondary">
                <span>深さ</span>
                <span className="text-white font-medium">{formatDepth(hypocenter.depth)}</span>
                <span
                  className="inline-block w-1.5 h-3.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: getDepthColor(hypocenter.depth) }}
                />
                <span className="text-white font-medium">{formatMagnitudeWithCondition(hypocenter.magnitude, hypocenter.magnitudeCondition)}</span>
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
