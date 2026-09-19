import { Fragment, useMemo, useRef, useEffect, useState } from 'react'
import type { JMAQuake, JMALpgm, IssueType, EarthquakePoint, IntensityScale, JMAEstimatedIntensity, QuakeReportRecord, BorrowedFromTsunami } from '../../types/earthquake'
import { getLpgmClassLabel, getLpgmClassColor, getLpgmClassBgColor, lpgmCategoryNote, buildLpgmRows, canOpenLpgmNotes } from '../../utils/lpgm'
import { estimatedIntensityFor, estimatedIntensityAvailability } from '../../utils/estimatedIntensity'
import { telegramTextSubject } from '../../utils/ttsFollow'
import { useAutoOpenWhileSpeakingIn } from '../../hooks/useAutoOpenWhileSpeaking'
import { SerialBadge } from '../SerialBadge'
import {
  formatQuakeTime,
  formatDepth,
  formatDomesticTsunami,
  TSUNAMI_WARNING_GROUP_TITLE,
  quakeReportLabels,
  formatCorrectType,
  hasHypocenterFacts,
  hasMagnitude,
  formatMagnitudeValue,
  formatMagnitudeWithCondition,
  formatCoordinate,
  formatTimeMin,
  NON_JMA_MARK,
  NON_JMA_MARK_TITLE,
  withNonJmaMark,
} from '../../utils/formatters'
import { getIntensityLabel, getIntensityLabelWithOrAbove, getIntensityColor, getIntensityBgColor, getDepthColor, getMagnitudeColor } from '../../utils/intensity'
import { hasKnownEpicenter } from '../../utils/geo'

import { buildAreaPrefIndex, buildRegionOrderIndex, buildStationPrefIndex, lookupPointCoords, lookupStationRegion, regionOrderRank, type LatLng } from '../../utils/stationCoords'
import { isMaxScaleUnreceived, partitionUnreceivedPoints, unreceivedUnitLabel, buildIntensityRows, makeAreaPrefResolver, cityKey, type IntensityStationRow, type IntensityRegionRow } from '../../utils/quakePoints'
import { rowMarkKey, rowMarkOf, type QuakeCardMarks, type QuakeUpdateField } from '../../utils/quakeUpdateMark'
import { UPDATE_MARK_COLOR, UPDATE_MARK_TITLE, type UpdateStatus } from '../../utils/updateMark'

import { useStationCoords } from '../../hooks/useStationCoords'
import { useSubRegions } from '../../hooks/useSubRegions'
import { usePrefectures } from '../../hooks/usePrefectures'
import { ringsBoundsIndex, EMPTY_BOUNDS_INDEX, type RingsBounds } from '../../utils/subregions'
import { groupUnreceivedPointNames, type UnreceivedPointGroup } from './unreceivedPointNames'

/**
 * 区域の行より下にある行の鍵をすべて集める。**親の行へ印を上げるために要る**
 * （一覧は既定で畳んであるので、配下にだけ付けると開かないと気づけない）。
 */
function regionDescendantKeys(region: IntensityRegionRow): string[] {
  return [
    ...region.cities.flatMap(c => [rowMarkKey.city(region.name, c.name), ...c.stations.map(st => rowMarkKey.station(st.name))]),
    ...region.stations.map(st => rowMarkKey.station(st.name)),
  ]
}

/**
 * 長周期地震動に添える気象庁からの補足（付加文 3 種＋詳細ページ）の開閉キー。
 *
 * 震度一覧・長周期一覧の行と**同じ `expanded` を共有する**ので、鍵の名前空間を分けておく
 * （行の側は `pref:` / `area:` / `city:` / `lpgm:pref:` / `lpgm:area:` を使う）。
 */
const LPGM_NOTES_KEY = 'lpgm:notes'


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
function IntensityRow({ label, scale, unreceived, unreceivedIsOwn, hasUnreceived, nonJma, depth, expandKey, expanded, onToggle, onFocus, mark }: {
  label: string
  scale: IntensityScale
  /** その行の震度が未入電の値から来ている（ラベルへ「以上」を足す）。 */
  unreceived: boolean
  /**
   * 「未入電」の印を出すか。**`unreceived` とは分ける。**
   *
   * 県・区域の行の値は、電文が区域の `MaxInt` を持たないときに**配下から積み上げる**
   * （標準版は区域のロールアップ点を持たないので常にこの経路）。積み上げは震度の大小で
   * 決まるため、**観測できた震度3 と未入電（下限 45）が混在すると未入電が勝つ**。その行を
   * 「未入電」と断定すると、届いている観測値を無かったことにする。**電文が直にその行について
   * 言っている場合だけ**に出す —— 観測点の行と、値を持たない市町村。範囲の行は下の
   * `hasUnreceived` が「未入電あり」を担う。
   */
  unreceivedIsOwn?: boolean
  hasUnreceived?: boolean
  nonJma?: boolean
  /** 字下げの段（0＝都道府県）。 */
  depth: 0 | 1 | 2 | 3
  /** 開閉の鍵。`null` なら開けない行。 */
  expandKey: string | null
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  /**
   * その行が指す場所へ地図を寄せる。**置き場所は行が開閉を持つかで変わる。**
   *
   * - 開閉を持たない行（観測点）→ **行全体**が寄せになる
   * - 開閉を持つ行（県・区域・市町村）→ **地名の部分だけ**（行全体は開閉が取る）
   *
   * 1 回のクリックに 2 つの意味を持たせられないので当たり判定を分けている。どちらの段でも
   * 「地名を押せば寄る」は成り立つ（→ docs/spec/quake-spec.md §8）。
   */
  onFocus?: () => void
  /**
   * この報でこの行（または配下の行）が動いたか。行の左端の縦線で出す。
   *
   * **縦線は印が無くても幅を取る**（透明で置く）。付いたり消えたりで地名の位置がずれると、
   * 一覧を目で追っているときに行がまとめて動いて見える。
   */
  mark?: UpdateStatus
}) {
  const canExpand = expandKey != null
  const isOpen = canExpand && expanded.has(expandKey)
  // 字下げと文字の大きさで段を示す（地名の色・太さも下で段によって変える）。
  // **震度の色は値だけで決める** —— 段の区別に流用すると、色が二通りの意味を持つ。
  const pad = ['pl-2', 'pl-5', 'pl-8', 'pl-11'][depth]
  const size = depth === 0
    ? 'text-[0.9375rem] roomy:text-[1.125rem]'
    : depth === 1 ? 'text-[0.875rem] roomy:text-[1rem]' : 'text-[0.8125rem] roomy:text-[0.9375rem]'
  // 行の主アクション。**開閉があればそちらが取る**（`onFocus` の注記を参照）。
  // `stopPropagation` は、カード自体の `<button>`（選択のトグル）へ伝わらせないため。
  const activate = canExpand ? () => onToggle(expandKey) : onFocus
  // 開閉を持つ行では、寄せを地名の部分へ移す（行全体は開閉が取っているため）。
  const labelFocus = canExpand ? onFocus : undefined
  return (
    <div
      {...(activate ? {
        role: 'button' as const,
        tabIndex: 0,
        // 開けない行に `aria-expanded` を付けない —— 開閉できる行だと読み上げさせてしまう。
        ...(canExpand ? { 'aria-expanded': isOpen } : {}),
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); activate() },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); activate() }
        },
      } : {})}
      className={`flex items-center ${pad} pr-2 py-0.5 ${depth === 0 ? 'roomy:py-1.5' : ''} ${size}${activate ? ' cursor-pointer hover:bg-white/5' : ''}`}
      style={{ borderLeft: `3px solid ${mark ? UPDATE_MARK_COLOR[mark] : 'transparent'}` }}
    >
      {/* 震度と、その値についての印（未入電）を左に置く。**印を地名の側へ置かない** ——
          置くと右端を揃えるためにいちばん長い「未入電あり」ぶんの枠を全行で空けることになり、
          狭い画面では印を持たない行まで地名が折り返す（実測: 幅 320px で 47 行中 7 行）。
          震度の隣なら、なぜ「以上」なのかをその値の真横で言うことにもなる。 */}
      <span className={`flex items-center flex-shrink-0 gap-1.5 whitespace-nowrap${depth === 0 ? ' font-bold' : ''}`}>
        <span style={{ color: getIntensityColor(scale) }}>
          {/* 未入電は「5弱以上」。観測値と同じ顔で出すと、実際にはもっと強い可能性があることが
              伝わらない。EEW の「上限を定めない予想震度」と同じ語を同じヘルパーで付ける。 */}
          震度{getIntensityLabelWithOrAbove(scale, unreceived)}
        </span>
        {/* **その行自身が未入電か、配下にあるだけかを書き分ける。**
            - 「未入電」＝この行の震度そのものが届いていない（観測点の行と、値を持たない市町村）
            - 「未入電あり」＝この範囲に未入電の地点があるが、行の値は観測できている

            **「あり」の有無が意味を分ける。** 未入電は地点単位の事実なので、配下にあるだけの
            県へ「〇〇県 未入電」と書くと県が丸ごと未入電に読める。逆に、行自身が未入電なのに
            何も書かないと、**事実を持っている行が黙って、範囲の行だけが喋る**ことになる
            （「震度5弱以上」の語だけでは、なぜ「以上」なのかが読み取れない）。

            **両方は出さない。** 行自身が未入電なら、配下に未入電があることは言わずとも含む。
            語は気象庁のものをそのまま使い、読み上げとも揃える。 */}
        {(unreceivedIsOwn || hasUnreceived) && (
          <span
            className="text-[0.75rem] font-normal roomy:text-[0.875rem]"
            style={{ color: '#9ca3af' }}
            title={unreceivedIsOwn
              ? '気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）'
              : 'この範囲に、震度が届いていない地点があります'}
          >
            {unreceivedIsOwn ? '未入電' : '未入電あり'}
          </span>
        )}
      </span>
      {/* 地名は伸びる枠に入れて右端で揃え、`＊` と開閉の記号はそれぞれ固定幅の枠へ出す。
          同じ流れに並べると、付いている行だけ地名が左へ押されて右端が揃わない（実測で 69px）。
          **`＊` と地名のあいだは詰める** —— 電文が名前の末尾へ置く印なので、離すと別のものに
          見える。枠を分けているのは右端を揃えるためで、見た目は続いているのが正しい。

          **行の両端揃え（`justify-between`）は使わない。** この枠が `flex-1` で残り幅を
          占めるので空きが生まれず、効かないクラスが意図だけ残ることになる。右端へ寄せるのは
          この枠の中の `justify-end`。 */}
      <span className="flex items-center justify-end min-w-0 flex-1">
        {/* `text-right` は**折り返した 2 行目以降のため**。1 行に収まるあいだは上の
            `justify-end` が寄せるので効かないが、長い観測点名（実データで最長 12 文字）が
            折り返したとき、これが無いと 2 行目だけ左へ流れる。 */}
        {/* 印が付いた行は**地名を印の色にする**。段の色（県の行だけ白）より優先させる ——
            段は字下げと文字の大きさでも分かるが、動いたかどうかはここでしか分からない。
            行の左端の縦線と 2 段構えにしてあるのは、**畳んだ親の行のため** —— 親の地名を
            塗ると「その地名自身が動いた」に見えるので、配下が動いただけのときは縦線が担う。 */}
        <span className="min-w-0 text-right" style={{ color: depth === 0 ? '#ffffff' : '#d1d5db' }}>
          {/* 気象庁以外が運用する観測点には電文どおり `＊` を付ける。読み取りの側では
              引き当てのために外してあるので、戻すのは表示のここ。記号だけでは何と対比して
              いるのか分からないので説明を添える。**枠の幅は行の文字の大きさに連動させる**
              （`em`）—— 段ごとに文字が小さくなるため。 */}
          {/* 開閉を持つ行では、ここだけが寄せの当たり判定になる（`labelFocus`）。
              **行に要素を足さない**のが選んだ理由 —— 行には既に震度・未入電の印・地名・`＊`・
              開閉の記号が並んでおり、狭い画面では地名が折り返している。 */}
          <span
            title={nonJma ? NON_JMA_MARK_TITLE : undefined}
            {...(labelFocus ? {
              role: 'button' as const,
              tabIndex: 0,
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); labelFocus() },
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); labelFocus() }
              },
              className: 'cursor-pointer hover:underline',
            } : {})}
          >
            {label}
          </span>
        </span>
        <span
          className="flex-shrink-0 w-[1em] text-center"
          style={{ color: depth === 0 ? '#ffffff' : '#d1d5db' }}
          title={nonJma ? NON_JMA_MARK_TITLE : undefined}
        >
          {nonJma ? NON_JMA_MARK : ''}
        </span>
        <span
          className="ml-1.5 flex-shrink-0 w-[1em] text-center text-[0.75rem] roomy:text-[0.875rem]"
          style={{ color: '#9ca3af' }}
        >
          {canExpand ? (isOpen ? '▾' : '▸') : ''}
        </span>
      </span>
    </div>
  )
}

/**
 * 長周期地震動の 1 行。都道府県・一次細分区域・観測点の 3 段で共有する
 * （電文が持つ段数。震度一覧の 4 段から市町村を除いた形）。
 *
 * **見た目の規約は `IntensityRow` と揃える。** 段の区別に使うのは字下げ・文字の大きさと、
 * 地名の文字色（県の行だけ白、下の 2 段はグレー）、それに階級側の太字（県の行だけ）。
 * **階級の色（`getLpgmClassColor`）は値だけで決め、段では変えない** —— 段の区別に流用すると、
 * 色が二通りの意味を持つ。並べる震度も値によらずグレーで、こちらは階級の補足として置いている。
 */
function LpgmRow({ label, lgInt, int, nonJma, depth, expandKey, expanded, onToggle, onFocus, mark }: {
  label: string
  lgInt: number
  /** その範囲の最大震度。階級と並べると「揺れは小さいのに高層階が大きく揺れた」形が出る */
  int?: IntensityScale
  nonJma?: boolean
  /** 字下げの段（0＝都道府県）。 */
  depth: 0 | 1 | 2
  /** 開閉の鍵。`null` なら開けない行。 */
  expandKey: string | null
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  /**
   * 開閉を持たない行（＝観測点の行）を押したときの動作。地図をその地点へ寄せる。
   * 扱いは `IntensityRow` の同名 props と同じ（開閉があればそちらが取る）。
   */
  onFocus?: () => void
  /** この報でこの行（または配下）が動いたか（→ {@link IntensityRow} の同名プロップ）。 */
  mark?: UpdateStatus
}) {
  const canExpand = expandKey != null
  const isOpen = canExpand && expanded.has(expandKey)
  const pad = ['pl-2', 'pl-5', 'pl-8'][depth]
  const size = depth === 0
    ? 'text-[0.9375rem] roomy:text-[1.125rem]'
    : depth === 1 ? 'text-[0.875rem] roomy:text-[1rem]' : 'text-[0.8125rem] roomy:text-[0.9375rem]'
  // 行の主アクション。開閉があればそちらが取る（`IntensityRow` と同じ）。
  const activate = canExpand ? () => onToggle(expandKey) : onFocus
  // 開閉を持つ行（県・区域）では、寄せを地名の部分へ移す。
  const labelFocus = canExpand ? onFocus : undefined
  return (
    <div
      {...(activate ? {
        role: 'button' as const,
        tabIndex: 0,
        ...(canExpand ? { 'aria-expanded': isOpen } : {}),
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); activate() },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); activate() }
        },
      } : {})}
      className={`flex items-center ${pad} pr-2 py-0.5 ${depth === 0 ? 'roomy:py-1.5' : ''} ${size}${activate ? ' cursor-pointer hover:bg-white/5' : ''}`}
      style={{ borderLeft: `3px solid ${mark ? UPDATE_MARK_COLOR[mark] : 'transparent'}` }}
    >
      {/* 階級と、その範囲の最大震度を左に置く。**震度一覧と同じ並べ方**（値についての情報は
          左、地名は右で揃える）。地名の側へ置くと、付いている行だけ地名が左へ押される。 */}
      <span className={`flex items-baseline flex-shrink-0 gap-1.5 whitespace-nowrap${depth === 0 ? ' font-bold' : ''}`}>
        <span style={{ color: getLpgmClassColor(lgInt) }}>
          長周期 {getLpgmClassLabel(lgInt)}
        </span>
        {int !== undefined && (
          <span className="text-[0.8125rem] font-normal text-gray-400 roomy:text-[0.9375rem]">
            震度 {getIntensityLabel(int)}
          </span>
        )}
      </span>
      {/* 地名は伸びる枠に入れて右端で揃え、`＊` と開閉の記号は固定幅の枠へ出す
          （→ `IntensityRow`。`justify-between` を使わない理由と `text-right` の役目も
          そちらに書いてある）。 */}
      <span className="flex items-center justify-end min-w-0 flex-1">
        {/* 印が付いた行は**地名を印の色にする**。段の色（県の行だけ白）より優先させる ——
            段は字下げと文字の大きさでも分かるが、動いたかどうかはここでしか分からない。
            行の左端の縦線と 2 段構えにしてあるのは、**畳んだ親の行のため** —— 親の地名を
            塗ると「その地名自身が動いた」に見えるので、配下が動いただけのときは縦線が担う。 */}
        <span className="min-w-0 text-right" style={{ color: depth === 0 ? '#ffffff' : '#d1d5db' }}>
          {/* 気象庁以外が運用する観測点の印。震度一覧・地図の吹き出しと同じ扱い。 */}
          <span
            title={nonJma ? NON_JMA_MARK_TITLE : undefined}
            {...(labelFocus ? {
              role: 'button' as const,
              tabIndex: 0,
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); labelFocus() },
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); labelFocus() }
              },
              className: 'cursor-pointer hover:underline',
            } : {})}
          >
            {label}
          </span>
        </span>
        <span
          className="flex-shrink-0 w-[1em] text-center"
          style={{ color: depth === 0 ? '#ffffff' : '#d1d5db' }}
          title={nonJma ? NON_JMA_MARK_TITLE : undefined}
        >
          {nonJma ? NON_JMA_MARK : ''}
        </span>
        <span
          className="ml-1.5 flex-shrink-0 w-[1em] text-center text-[0.75rem] roomy:text-[0.875rem]"
          style={{ color: '#9ca3af' }}
        >
          {canExpand ? (isOpen ? '▾' : '▸') : ''}
        </span>
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
  /**
   * この報で動いた欄と行の印。**ライブで受けた続報にだけ付く**（→ `utils/quakeUpdateMark.ts`）。
   *
   * 履歴から組んだカードや、そのカードで最初に見た報には付かない。前report が無ければ
   * 全欄・全行が「初出」になり、印が画面を埋めるだけで何も指さないため。
   */
  /**
   * **任意にしない。** 渡し忘れても画面は正常に見え、印が出ないことに気づけない
   * （呼び出し元が増えたときに黙って抜ける）。印が無いときは空の印を渡す。
   */
  marks: QuakeCardMarks | undefined
  /**
   * 長周期地震動の一覧の印。**震度一覧とは別に受け取る。**
   *
   * 2 つの一覧はカードの中で切り替えて出るが、行の鍵（`area:` / `st:`）は同じ名前空間を
   * 使うので、1 つにまとめると同じ区域名の行どうしで印が混ざる。
   */
  lpgmMarks: QuakeCardMarks | undefined
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
  /** この地震の未入電の一覧を開いているか。 */
  unreceivedActive?: boolean
  onToggleUnreceived?: () => void
  /** 一覧の行をクリックしたときに、その場所へ地図を寄せる（1 点でも範囲でも）。 */
  onFocusMap?: (positions: LatLng[]) => void
  /**
   * いま気象庁が書いた文を読み上げている主題（読んでいなければ null）。
   * このカードの長周期の補足が対象なら、読み上げのあいだ開く（→ `useAutoOpenWhileSpeakingIn`）。
   *
   * **任意にしない**（理由は `EarthquakeTab` の同名 props）。
   */
  speakingTelegramTextSubject: string | null
}

/**
 * 種別ヘッダーに出す「受け取った電文種別」。→ `quakeReportLabels`
 *
 * **報番号の見た目は緊急地震速報と共有する**（→ `components/SerialBadge.tsx`）。同じ器に出す
 * もので、別々に書くと片方だけ変わる。
 *
 * **鍵には並び順も混ぜる。** 同じ種別が 2 件並ばないことは統合の側（`utils/quakeMerge.ts` の
 * `mergeQuakeReports` が種別ごとに 1 件へ畳む）が保証しているが、**そこが崩れたときの症状が
 * 「種別が 1 つ黙って消える」になる** —— React は鍵が重なった要素を畳むだけで例外を投げない。
 */
/** 津波電文から借りた値の欄に添える印。説明は {@link borrowedSourceNote} がカードへ 1 行出す。 */
const BORROWED_MARK = '※'

/**
 * 借りた値の欄へ添える印。
 *
 * **前に空白を置く。** 直前の文字（震央地名・「深さ」など）へ貼り付くと、名前の一部に見える。
 */
function BorrowedMark() {
  return <span className="ml-0.5 align-super text-[0.625rem] font-normal opacity-80">{BORROWED_MARK}</span>
}

/**
 * 借りた値の説明（→ `utils/borrowFromTsunami.ts`）。**常に 1 行**で、詳しい出どころは
 * ホバーの説明（`title`）へ回す。
 *
 * **「電文」「借りる」のような内部の言い回しを画面へ出さない。** 印が「どれが」を示すので、
 * 文は出どころを名指しするだけでよい。述語を足すと説明くさくなるうえ、開発側の語彙が混ざる。
 *
 * **震源と津波区分で行を分けない。** 借りる報は実際には別になりうる —— 震源は「震源を載せた
 * 最新の報」、区分は「等級を載せた最新の報」から採るため、能登の実電文では 16:22 と 16:12 に
 * 分かれる。だが読み手にとっては同じ津波の情報で、報の違いまで並べても判断は変わらない。
 *
 * **等級を名乗らない**（「津波警報より」と書くと大津波警報の地震で一段軽く見える。
 * → `docs/spec/quake-spec.md` §3）。正確な名乗りと発表時刻は `title` に持つ。
 */
function borrowedSourceNote(
  hypocenter: BorrowedFromTsunami | undefined,
  domesticTsunami: BorrowedFromTsunami | undefined,
): { text: string; title: string } | null {
  if (!hypocenter && !domesticTsunami) return null
  // **文として読めるように書く。** 「震源: 〜／津波区分: 〜」の列挙は開発者向けの体裁で、
  // ホバーを開いた利用者が読む文になっていない。
  const sentence = (src: BorrowedFromTsunami, what: string) => {
    const at = formatTimeMin(src.reportTime)
    // 時刻を読めない電文では時刻だけ落とす。文そのものは出す ——
    // どの情報が伝えたかは時刻が無くても伝わる。
    return at
      ? `${what}は${at}に発表された${src.infoName}で伝えられました。`
      : `${what}は${src.infoName}で伝えられました。`
  }
  const parts: string[] = []
  if (hypocenter) parts.push(sentence(hypocenter, '震源'))
  if (domesticTsunami) parts.push(sentence(domesticTsunami, '津波の有無'))
  return {
    text: `${BORROWED_MARK} 津波情報より`,
    title: parts.join(''),
  }
}

function QuakeReportHeading({ reports, fallback }: { reports?: QuakeReportRecord[]; fallback: IssueType }) {
  return (
    <>
      {quakeReportLabels(reports, fallback).map((label, index) => (
        <Fragment key={`${index}:${label.type}`}>
          {index > 0 && ' / '}
          {label.type}
          {label.count != null && <SerialBadge serial={label.count} />}
        </Fragment>
      ))}
    </>
  )
}

export function EarthquakeCard({
  quake, isLatest, isSelected, onSelect, lpgm, activeLpgmEventId, onToggleLpgm,
  estimatedIntensity = null, distributionActive = false, onToggleDistribution,
  unreceivedActive = false, onToggleUnreceived, onFocusMap, speakingTelegramTextSubject,
  marks, lpgmMarks,
}: Props) {
  /**
   * 印は**文字色**で出す。当てる先はその欄で「色に意味を持たない文字」。
   *
   * - 震央地名・座標 … 文字そのもの（白・灰）
   * - 最大震度・規模・深さ … **値の数字**（白）。隣のラベルと枠は階級・段階の色なので触らない
   * - 津波区分 … **文字が区分の色そのもの**なので塗り替えられない。ここだけ枠で囲む
   *
   * 色に意味がある文字を塗り替えると、別の値を指しているように見える（津波カードが波高を
   * 印の対象から外しているのと同じ理由。→ `utils/updateMark.ts`）。
   */
  const markText = (field: QuakeUpdateField): React.CSSProperties | undefined => {
    const status = marks?.facts.get(field)
    return status ? { color: UPDATE_MARK_COLOR[status] } : undefined
  }
  /** 印の意味を言葉でも添える（色を読み取れない利用者向け。→ `UPDATE_MARK_TITLE`）。 */
  const markTitle = (field: QuakeUpdateField) => {
    const status = marks?.facts.get(field)
    return status ? UPDATE_MARK_TITLE[status] : undefined
  }
  const markRing = (field: QuakeUpdateField) => {
    const status = marks?.facts.get(field)
    // 枠は文字色を触らないので、向きの無い変化でも白のまま出せる。
    return status ? { outline: `2px solid ${UPDATE_MARK_COLOR[status]}`, outlineOffset: '2px' } : undefined
  }
  /**
   * 行の印。**配下に動いた行があれば親にも出す** —— 一覧は既定でどの段も畳んであるので、
   * 配下にだけ付けると「開かないと気づけない印」になる（→ `rowMarkOf`）。
   */
  const rowMark = (key: string, descendants: readonly string[] = []) =>
    marks ? rowMarkOf(key, descendants, marks.rows) : undefined
  const lpgmRowMark = (key: string, descendants: readonly string[] = []) =>
    lpgmMarks ? rowMarkOf(key, descendants, lpgmMarks.rows) : undefined
  const { earthquake, issue } = quake
  const { hypocenter, maxScale, domesticTsunami } = earthquake
  // 電文全体の最大震度が「5弱以上・未入電」だったとき、見出しにも「以上」を付ける。
  // 付けないと、実際にはもっと強い可能性があることが見出しから読み取れない。
  //
  // **値と語を分けて持つ。** 最大震度は大きく出す欄なので、語を同じ大きさで並べると
  // 「5弱以上」で桁数が倍になり、器に収まらず折り返す（畳んだ表示は 7rem 角に固定、
  // 開いた表示も横並びのラベルと競る）。**語は本体より小さく添える** —— EEW の予想最大震度
  // バナーが「程度以上」で同じ形を採っている（`RealtimeTab/index.tsx`）。
  // **語は縮められない**（気象庁の表現をそのまま使う決まり）ので、大きさで受ける。
  const maxScaleLabel = maxScale === -1 ? '?' : getIntensityLabel(maxScale)
  const maxScaleOrAbove = maxScale !== -1 && isMaxScaleUnreceived(maxScale, quake.points)
  const tsunamiInfo = formatDomesticTsunami(domesticTsunami)
  const hasLocation = hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude)
  // 規模・深さは位置と別に判定する（→ `hasHypocenterFacts`）
  const hasFacts = hasHypocenterFacts(hypocenter)
  // 津波電文から借りた値の印と、その説明（→ `utils/borrowFromTsunami.ts`）。
  //
  // **借りた欄すべてに印を付け、説明はカードに 1 行だけ置く。** 欄ごとに「津波情報より」と
  // 書くと同じ語が並んで冗長になり、逆に 1 行へまとめるだけだと**どの欄に掛かるのかが消える**
  // （震源は名前・座標・規模・深さの 4 欄にまたがる）。印なら両方を満たせる —— `＊`（気象庁
  // 以外の観測点）と同じ流儀。
  //
  // **記号は `＊` と分ける。** あちらは観測点名の末尾に付き、こちらは震源と津波区分の欄に付く。
  // 出る場所も説明文も違うので混ざらないが、同じ記号にすると説明が 2 つ並んで読み手が迷う。
  const borrowedHypocenter = quake.hypocenterSource
  const borrowedDomesticTsunami = quake.domesticTsunamiSource
  // 説明は**常に 1 行**。詳しい出どころ（名乗り・発表時刻）はホバーの説明へ回す。
  const borrowedNote = borrowedSourceNote(borrowedHypocenter, borrowedDomesticTsunami)
  // 長周期の「観測情報の種類」から出す一文（値 2・4 のときだけ。→ `lpgmCategoryNote`）。
  // 条件と本文の両方で使うので一度だけ計算する。
  const categoryNote = lpgmCategoryNote(lpgm?.category)
  /** 補足の見出しを出すか（判定は読み上げ側の診断と共有する → `canOpenLpgmNotes`）。 */
  const hasLpgmNotes = canOpenLpgmNotes(lpgm)
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
  // 県・区域の行から地図へ寄せるための境界。**どちらも地図が既に読んでいるデータ**で、
  // ローダーがキャッシュを返すので通信は増えない（→ `usePrefectures`）。
  const prefectures = usePrefectures()
  const { data: subRegions } = useSubRegions()

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
  const lpgmNotesOpen = expanded.has(LPGM_NOTES_KEY)
  const setLpgmNotesOpen = (open: boolean) => setExpanded(prev => {
    const next = new Set(prev)
    if (open) next.add(LPGM_NOTES_KEY); else next.delete(LPGM_NOTES_KEY)
    return next
  })
  /**
   * **この地震の**長周期の補足をいま読み上げているか。
   *
   * 主題は電文の種別だけでなく地震の識別子まで含む（→ `telegramTextSubject`）。カードは
   * 複数並ぶので、種別だけで判定すると読んでいるのとは別の地震の補足まで開く。
   * **「いま選ばれているカード」で代用しない** —— 選択は受信した瞬間に動き、読み上げの
   * 順番とは独立している（未入電モードの自動開閉と同じ規約）。
   */
  const speakingLpgmNotes = !!lpgm
    && speakingTelegramTextSubject === telegramTextSubject('lpgm', lpgm.eventId)
  // 読み上げているあいだだけ開く（自分が開いた分だけ閉じる）。**状態は `expanded` が持つ**
  // ので、判定を書き写さず状態の持ち主を渡せる版を使う。
  const setLpgmNotesOpenByUser = useAutoOpenWhileSpeakingIn(
    speakingLpgmNotes, lpgmNotesOpen, setLpgmNotesOpen,
  )

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

  /**
   * 一覧の行を押したときに地図へ渡す寄り先。**押せるかどうかもこれで決める。**
   *
   * 判定と寄り先を別々に解決すると、片方だけ引けたときに「押せるのに動かない」（またはその逆）に
   * なる。津波の観測点の行が同じ規律で書かれている（→ docs/spec/tsunami-spec.md §9
   * 「観測点の行・区域名をクリックしたときの寄り先」）。
   *
   * **県名は行の親から採り、引けなければ名前から逆引きする。** 行の県は電文の `City` 由来の
   * ことがあり（`makeAreaPrefResolver`）、座標テーブルのキーと必ず揃うとは限らない。地図側
   * （`useQuakeLayerData` の `intensityMarkers`）は逆引きで引いているので、両方を試せば
   * 地図に点が立っている観測点は引ける。
   *
   * **観測点と区域は座標表の別の表に入っている**ので、どちらを引くかは呼び出し側が渡す
   * （`lookupPointCoords` の `isArea`）。震度一覧の行は観測点しか渡さないが、未入電の一覧には
   * 区域の行も並ぶ（→ `unreceivedPoints`）。
   *
   * **`＊`（気象庁以外が運用する観測点）は外さなくてよい。** 電文の読み取りで既に外れており
   * （`stripNonJmaMark`）、`EarthquakePoint.addr` は印の無い名前。戻しているのは表示のときだけ。
   */
  /**
   * 県・区域の外接矩形。**カードごとに作り直さない** —— 索引は入力の参照をキーにキャッシュされる
   * （`namedRingsBoundsIndex` / `subRegionBoundsIndex`）。境界は県 47 件・区域 192 件で
   * 合わせて 24 万点あり、カードの一覧は仮想化していないので、ここで走査すると**畳んだカードも
   * 含めて全枚数ぶん**繰り返すことになる。
   */
  const prefBounds = prefectures
    ? ringsBoundsIndex(prefectures, () => Object.entries(prefectures).map(([name, shape]) => [name, shape.rings] as const))
    : EMPTY_BOUNDS_INDEX
  const areaBounds = subRegions
    ? ringsBoundsIndex(subRegions, () => subRegions.map((r) => [r.name, r.rings] as const))
    : EMPTY_BOUNDS_INDEX

  const coordsOf = (pref: string, name: string, isArea = false): LatLng | null => {
    if (!stationData) return null
    const index = isArea ? unreceivedIndexes.areaPrefIndex : unreceivedIndexes.stationPrefIndex
    return lookupPointCoords(stationData, pref, name, isArea)
      ?? lookupPointCoords(stationData, index?.get(name) ?? '', name, isArea)
  }

  const focusHandlerFor = (pref: string, name: string, isArea = false): (() => void) | undefined => {
    if (!onFocusMap) return undefined
    const position = coordsOf(pref, name, isArea)
    return position ? () => onFocusMap([position]) : undefined
  }

  /**
   * 範囲の行（県・区域・市町村）の寄り先。
   *
   * **外接矩形の 2 点だけを渡す。** `fitToPositions` は受け取った点の外接矩形へ寄せるので、
   * 境界の全頂点を渡す必要が無い（区域 1 つで数百点になる）。
   */
  const focusBoundsHandler = (bounds: RingsBounds | null): (() => void) | undefined => {
    if (!onFocusMap || !bounds) return undefined
    const corners: LatLng[] = [[bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]]
    return () => onFocusMap(corners)
  }

  /**
   * 市町村の行の寄り先。**境界データが無いので配下の観測点の範囲で代用する。**
   *
   * 県・区域と違って市町村の境界は生成データに無く（`prefectures.json` / `subregions.json` の
   * どちらも持たない）、電文からも作れない。観測点を 1 つも引けない市町村は押せないままにする。
   */
  const focusCityHandler = (pref: string, stations: readonly IntensityStationRow[]): (() => void) | undefined => {
    if (!onFocusMap) return undefined
    const positions = stations
      .map((st) => coordsOf(pref, st.name))
      .filter((p): p is LatLng => p !== null)
    return positions.length > 0 ? () => onFocusMap(positions) : undefined
  }

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
    const unreceivedCities = new Set<string>()
    for (const p of [...unreceivedStations, ...unreceivedAreaPoints]) {
      const pref = prefOf(p)
      if (pref) unreceivedPrefs.add(pref)
      // 区域点はそのまま。都道府県ロールアップ点（addr === pref）は県として既に数えている。
      if (p.isArea) { if (!p.pref) unreceivedAreas.add(p.addr) }
      else {
        const region = regionOfStation(p)
        if (region) {
          unreceivedAreas.add(region)
          // **市町村にも同じ条件で印を付ける。** 電文の `City/Condition` は市町村の最大が
          // 震度4以下のときしか出ないので、それだけに頼ると**強く揺れた市町村ほど印が消える**
          // （能登本震では 1343 市町村すべてで `Condition` が付いていない）。鍵の作り方は
          // 行の組み立てと共有する（`cityKey`）。
          if (p.city) unreceivedCities.add(cityKey(region, p.city))
        }
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
      unreceivedCities,
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
    const empty = { groups: [] as UnreceivedPointGroup[], count: 0, unit: '地点' }
    // ボタンも一覧も展開表示（`isSelected`）の中にしか無い。畳んだカードで組んでも使い道が無く、
    // 一覧に並ぶカードの数だけ並べ替えが走る。
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
      .map(({ p }) => ({ addr: p.addr, nonJma: p.nonJma, isArea: p.isArea, pref: prefOf(p) }))
    const groups = groupUnreceivedPointNames(ordered)
    return {
      groups,
      count: groups.reduce((n, g) => n + g.names.length, 0),
      unit: unreceivedUnitLabel(stations.length > 0, areas.length > 0),
    }
  }, [isSelected, stationData, unreceivedIndexes])

  // 長周期地震動も震度一覧と同じく入れ子にする（電文が持つのは県 → 区域 → 観測点の 3 段で、
  // 市町村の段が無いぶん震度の 4 段より 1 つ浅い）。組み立ては `buildLpgmRows` に置いてあり、
  // ここでは座標表由来の索引を渡すだけ。
  const lpgmGroups = useMemo(() => {
    // **どのデータがあれば行が出るかは `buildLpgmRows` に決めさせる。** ここで「区域があるか」
    // 「観測点があるか」と条件を並べ直すと、向こうが受け皿を足したときに静かにずれる
    // （区域が全滅して県の値だけが残る電文が、ここで弾かれていた）。空なら空配列が返り、
    // 描画側の `lpgmGroups.length > 0` で落ちる。
    if (!isSelected || !lpgm) return []
    const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
    const order = stationData ? buildRegionOrderIndex(stationData) : null
    return buildLpgmRows(lpgm.regions ?? [], lpgm.points ?? [], lpgm.prefs ?? [], {
      prefOfArea: name => areaPrefIndex?.get(name) ?? null,
      rank: name => regionOrderRank(name, order),
    })
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
          {/* 受け取った電文種別を `/` でつないで出す（→ `QuakeReportHeading`）。気象庁は
              震度速報 → 震源情報 → 震度速報 … と前後して発表するため、最後に届いた 1 種別だけ
              だと「震源情報も受け取っている」ことが画面から消える。**色は代表種別のまま**。 */}
          <QuakeReportHeading reports={quake.reports} fallback={issue.type} />
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
              // 枠は震度階級の色なので触らない。印は下の白い数字の文字色で出す。
            }}
          >
            <span className="text-sm font-medium roomy:text-base" style={{ color: getIntensityColor(maxScale) }}>
              最大震度
            </span>
            <span
              className="font-black leading-none text-[3.25rem] roomy:text-[5.5rem]"
              style={{ color: '#ffffff', ...markText('maxScale') }}
            >
              {maxScaleLabel}
              {/* 「以上」は本体より小さく添える（→ `maxScaleOrAbove` の注記）。同じ大きさで
                  並べると横並びのラベルと競って折り返す。 */}
              {maxScaleOrAbove && (
                <span className="font-bold text-[1.25rem] roomy:text-[1.75rem]">以上</span>
              )}
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
              震度が小さい地域があるかどうか。**分類番号は出さず意味だけ書く**（→ `lpgmCategoryNote`）。
              **この一文だけは畳まない。** 1 行しかないうえ、その地震でしか言えない事実で、
              下の折りたたみに入れても縮む量はほとんど変わらない。 */}
          {lpgm && lpgm.maxClass >= 1 && categoryNote && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {categoryNote}
            </div>
          )}
          {/* 気象庁からの補足は畳んで置く。中身は付加文 3 種 —— 固定（`ForecastComment/Text`。
              この地震について気象庁が添える定型文で、実電文では緊急地震速報の発表の有無を
              伝えている）・その他の固定（`VarComment/Text`）・自由（`FreeFormComment`。階級ごとの
              揺れの言い換え）—— と、気象庁の詳細ページ（`Comments/URI`）への導線。

              **開いたままだと主要な情報が画面の外へ出る。** この位置は震央地名・規模より**上**で、
              上下分割では開いたままだとどちらも初期表示に入らない。**押し下げ量の実測値は
              docs/spec/quake-spec.md §8「気象庁からの補足は畳んで置く」が単一情報源**
              （同じ値を 2 箇所に書くとずれる。**実測値の置き場所の作法**が津波の付加文と同じで、
              畳むか重ねるかという見せ方のほうは別 —— 理由は同節）。

              **「解説」の語を使わない。** 南海トラフ地震関連解説情報のバナーと同じ画面に並ぶため、
              語幹が被ると別の情報だと読み取れない。

              開閉は `<div role="button">` で作る（カード自体が `<button>` なので入れ子にできない。
              震度一覧の行と同じ作法）。 */}
          {hasLpgmNotes && (
            <div
              role="button"
              tabIndex={0}
              aria-expanded={lpgmNotesOpen}
              onClick={(e) => { e.stopPropagation(); setLpgmNotesOpenByUser(!lpgmNotesOpen) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation(); e.preventDefault(); setLpgmNotesOpenByUser(!lpgmNotesOpen)
                }
              }}
              className="text-secondary w-fit cursor-pointer hover:text-white transition-colors"
              style={{ fontSize: '0.75rem', lineHeight: 1.5 }}
            >
              気象庁からの補足
              <span className="ml-1.5" style={{ color: '#9ca3af' }}>{lpgmNotesOpen ? '▾' : '▸'}</span>
            </div>
          )}
          {/* **自由付加文は改行と空白を保つ**（地震情報側と同じ扱い。全角スペースの表が入る）。 */}
          {lpgm && lpgm.maxClass >= 1 && lpgmNotesOpen && lpgm.forecastText && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {lpgm.forecastText}
            </div>
          )}
          {lpgm && lpgm.maxClass >= 1 && lpgmNotesOpen && lpgm.varCommentText && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {lpgm.varCommentText}
            </div>
          )}
          {lpgm && lpgm.maxClass >= 1 && lpgmNotesOpen && lpgm.freeFormText && (
            <div
              className="text-secondary"
              style={{ fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
            >
              {lpgm.freeFormText}
            </div>
          )}
          {/* **アプリが出せないもの（波形・スペクトル）の在りかを電文自身が示している**ので、
              そこへ行ける導線を残す。自由付加文も同じ URL を文中で案内しているため、
              畳む単位はこの 4 つで 1 つにまとめている。 */}
          {lpgm && lpgm.maxClass >= 1 && lpgmNotesOpen && lpgm.uri && (
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

          {/* 日時 + 訂正情報。**日時として読めないときは語を出す**（→ `formatters.ts` の
              `readDateTime`）。ここはカードの主題（いつ起きた地震か）で、空欄にすると
              隣の種別バッジだけが残り、時刻を読み落としたのか電文に無いのか分からない。 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-secondary text-base roomy:text-xl">
              {formatQuakeTime(earthquake.time) ?? '発生時刻不明'}
            </span>
            {issue.correct !== 'なし' && (
              <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                {formatCorrectType(issue.correct)}
              </span>
            )}
          </div>

          {/* 震源地。**緯度・経度はこの直下に置く** —— どちらも「どこで起きたか」を言う欄で、
              あいだに規模・津波・付加文を挟むと、震央地名を読んだあとに座標を探すことになる。 */}
          {/* **印は名前を出しているときだけ。** 座標を読めない報では名前の代わりに固定文言
              「震源調査中」が出るので、そこへ印を当てると**文言そのものが新しくなった**ように
              読める（借りた震源で名前はあるのに座標が無い形が実際に起こりうる）。 */}
          <div
            className="font-bold text-white leading-tight text-[1.375rem] roomy:text-[1.875rem] rounded"
            style={hasLocation ? markText('hypocenterName') : undefined}
            title={hasLocation ? markTitle('hypocenterName') : undefined}
          >
            {hasLocation ? hypocenter.name : '震源調査中'}
            {/* **「震源調査中」には印を付けない。** 借りた原因地震に震央地名はあるのに座標を
                読めなかった形（`readHypocenterAreaDetail` が座標を落とす経路）では、名前を出せず
                固定文言へ倒れる。そこへ印を足すと「震源調査中」という文言そのものが津波から
                来たように読め、しかも借りたはずなのに調査中という矛盾した見た目になる。
                **借りた名前が画面に出ないこと自体は別の穴**（この分岐が名前の表示を座標の有無で
                決めているため）で、今回の変更が作ったものではない。 */}
            {borrowedHypocenter && hasLocation && <BorrowedMark />}
          </div>
          {hasLocation && (
            <div className="text-xs text-secondary roomy:text-sm" style={markText('coordinate')} title={markTitle('coordinate')}>
              {formatCoordinate(hypocenter.latitude, hypocenter.longitude)}
              {borrowedHypocenter && <BorrowedMark />}
            </div>
          )}

          {/* マグニチュード・深さ（2カラムグリッド） */}
          {hasFacts && (
            <div className="grid grid-cols-2 gap-2">
              <div
                className="flex flex-col gap-0.5 rounded-lg p-2 roomy:gap-1 roomy:p-2.5"
                style={{
                  backgroundColor: `${magColor}26`,
                  border: `2px solid ${magColor}`,
                  // 枠は器の色（規模の段階）なので触らない。印は下の白い数字の文字色で出す。
                }}
              >
                <span className="text-xs font-medium tracking-wide" style={{ color: magColor }}>
                  マグニチュード
                  {borrowedHypocenter && <BorrowedMark />}
                </span>
                {/* 規模不明（-1／NaN）を toFixed に通すと "-1.0"／"NaN" と表示される。深さ側の formatDepth と揃える。
                    数値が無くても気象庁が説明を添えていればそれを出す（「Ｍ８を超える巨大地震」を
                    「不明」で潰さない）。説明は数値より長いので、そのときだけ字を小さくする。 */}
                <span
                  className={`font-black leading-none ${hypocenter.magnitudeCondition && !hasMagnitude(hypocenter.magnitude) ? 'text-[0.9375rem] roomy:text-[1.125rem] leading-snug' : 'text-[1.375rem] roomy:text-[1.75rem]'}`}
                  style={{ color: '#ffffff', ...markText('magnitude') }}
                >
                  {formatMagnitudeValue(hypocenter.magnitude, hypocenter.magnitudeCondition)}
                </span>
              </div>
              <div
                className="flex flex-col gap-0.5 rounded-lg p-2 roomy:gap-1 roomy:p-2.5"
                style={{
                  backgroundColor: `${depthColor}26`,
                  border: `2px solid ${depthColor}`,
                  // 同上（枠は深さの段階の色）。
                }}
              >
                <span className="text-xs font-medium tracking-wide" style={{ color: depthColor }}>
                  深さ
                  {borrowedHypocenter && <BorrowedMark />}
                </span>
                <span className="font-black leading-none text-[1.375rem] roomy:text-[1.75rem]" style={{ color: '#ffffff', ...markText('depth') }}>
                  {formatDepth(hypocenter.depth)}
                </span>
              </div>
            </div>
          )}

          {/* 国内津波情報。「津波警報等」だけは語に何が含まれるか説明を添える（→ `formatDomesticTsunami`）。 */}
          <div
            className="w-full rounded-lg py-1 px-3 text-center font-bold text-sm roomy:py-2 roomy:text-base"
            title={domesticTsunami === '警報等' ? TSUNAMI_WARNING_GROUP_TITLE : undefined}
            style={{
              backgroundColor: `${tsunamiInfo.color}22`,
              border: `1px solid ${tsunamiInfo.color}`,
              color: tsunamiInfo.color,
              ...markRing('domesticTsunami'),
            }}
          >
            {tsunamiInfo.text}
            {borrowedDomesticTsunami && <BorrowedMark />}
          </div>
          {/* 借りた値の説明。**印を付けた欄より後ろへ置く** —— 記号を見てから意味を探すので、
              説明が先にあると「何の話か」が分からないまま読むことになる。 */}
          {borrowedNote && (
            <div className="text-xs text-secondary roomy:text-sm" title={borrowedNote.title}>
              {borrowedNote.text}
            </div>
          )}

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

          {/* 震度を入手していない地点（クリックで一覧を差し替え、地図に印を出す）。
              **再掲だったブロックをこのボタンへ畳んである。** 未入電の観測点は震度一覧の入れ子の
              中にも入っており、県・区域の「未入電あり」バッジがそこへ辿る導線になっている。
              実測で 60 件のとき上下分割でパネル可視高の 142% を占めていたので、件数だけ常に見せて
              地点名は開いたときに出す。 */}
          {unreceivedPoints.count > 0 && (
            <div
              role="button"
              tabIndex={0}
              aria-pressed={unreceivedActive}
              onClick={(e) => { e.stopPropagation(); onToggleUnreceived?.() }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onToggleUnreceived?.() } }}
              title="気象庁が震度5弱以上と推定しているのに、震度が届いていない地点。押すと一覧と地図に出る"
              className={`w-full rounded-lg py-1 px-3 flex items-center justify-between gap-2 border transition-colors cursor-pointer hover:opacity-80 roomy:py-2 roomy:px-4 ${
                unreceivedActive
                  ? 'bg-gray-500/25 border-gray-400 outline outline-2 outline-offset-2 outline-gray-400'
                  : 'bg-panel border-border'
              }`}
            >
              <span className="text-xs font-medium text-white roomy:text-sm">
                震度を入手していない{unreceivedPoints.unit}
              </span>
              <span className="text-xs font-bold roomy:text-sm" style={{ color: '#d1d5db' }}>
                {unreceivedPoints.count}{unreceivedPoints.unit}
              </span>
            </div>
          )}

          {/* 各地の震度 / 長周期地震動階級（LPGM トグルオン時は階級表示に切り替え） */}
          {(() => {
            const isLpgmActive = lpgm && activeLpgmEventId === lpgm.eventId

            if (isLpgmActive && lpgmGroups.length > 0) {
              return (
                <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
                  {/* 最上段は都道府県か、都道府県を引けなかった区域（→ `LpgmPrefRow.kind`）。
                      **鍵に段の種別を入れる** —— 区域名と県名は一致しうる（実データの「奈良県」）。 */}
                  {lpgmGroups.map((prefRow, idx) => {
                    const topKey = `lpgm:${prefRow.kind}:${prefRow.name}`
                    return (
                    <div
                      key={topKey}
                      className="rounded"
                      style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                    >
                      <LpgmRow
                        label={prefRow.name}
                        lgInt={prefRow.maxLgInt}
                        int={prefRow.maxInt}
                        mark={lpgmRowMark(rowMarkKey.pref(prefRow.name), [
                          ...prefRow.areas.flatMap(a => [rowMarkKey.area(a.name), ...a.stations.map(st => rowMarkKey.station(st.name))]),
                          ...prefRow.stations.map(st => rowMarkKey.station(st.name)),
                        ])}
                        depth={0}
                        expandKey={prefRow.areas.length > 0 || prefRow.stations.length > 0 ? topKey : null}
                        expanded={expanded}
                        onToggle={toggle}
                        onFocus={focusBoundsHandler(prefBounds.get(prefRow.name) ?? null)}
                      />
                      {expanded.has(topKey) && (
                        <>
                          {prefRow.areas.map(area => (
                            <div key={area.name}>
                              <LpgmRow
                                label={area.name}
                                lgInt={area.maxLgInt}
                                int={area.maxInt}
                                mark={lpgmRowMark(rowMarkKey.area(area.name), area.stations.map(st => rowMarkKey.station(st.name)))}
                                depth={1}
                                expandKey={area.stations.length > 0 ? `lpgm:area:${area.name}` : null}
                                expanded={expanded}
                                onToggle={toggle}
                                onFocus={focusBoundsHandler(areaBounds.get(area.name) ?? null)}
                              />
                              {expanded.has(`lpgm:area:${area.name}`) && area.stations.map(st => (
                                <LpgmRow
                                  key={st.name}
                                  label={st.name}
                                  lgInt={st.lgInt}
                                  int={st.int}
                                  nonJma={st.nonJma}
                                  mark={lpgmRowMark(rowMarkKey.station(st.name))}
                                  depth={2}
                                  expandKey={null}
                                  expanded={expanded}
                                  onToggle={toggle}
                                  onFocus={focusHandlerFor(prefRow.name, st.name)}
                                />
                              ))}
                            </div>
                          ))}
                          {/* 区域が分からない観測点（→ `LpgmPrefRow.stations`）。 */}
                          {prefRow.stations.map(st => (
                            <LpgmRow
                              key={st.name}
                              label={st.name}
                              lgInt={st.lgInt}
                              int={st.int}
                              nonJma={st.nonJma}
                              mark={lpgmRowMark(rowMarkKey.station(st.name))}
                              depth={1}
                              expandKey={null}
                              expanded={expanded}
                              onToggle={toggle}
                              onFocus={focusHandlerFor(prefRow.name, st.name)}
                            />
                          ))}
                        </>
                      )}
                    </div>
                    )
                  })}
                </div>
              )
            }

            // 未入電の一覧（トグルオン時は震度一覧と差し替える）。
            //
            // **4 段の入れ子にしない。** 全部が同じ「5弱以上」なので段を作っても分かれる情報が
            // 無く、60 件のときに段を開いて回る手間だけが残る。平らに並べ、どこの話かは県の
            // 見出しが示す（→ `groupUnreceivedPointNames`）。
            if (unreceivedActive && unreceivedPoints.count > 0) {
              return (
                <div className="flex flex-col gap-1 pt-1 border-t border-white/10">
                  {/* **推定したのは気象庁**であることを書く。このアプリは強震モニタ由来の
                      値にも「推定」を使っており（リアルタイムタブ）、主語が無いと
                      「アプリが推定した値」と取り違えられる。 */}
                  <div className="text-[0.6875rem] roomy:text-[0.8125rem]" style={{ color: '#9ca3af' }}>
                    気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）
                  </div>
                  {unreceivedPoints.groups.map((group, idx) => (
                    <div
                      key={group.pref || `unknown-pref-${idx}`}
                      className="rounded px-2 py-1"
                      style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                    >
                      {/* 県を引けなかった点は見出しを出さずに並べる（名前は出す）。所属が
                          分からないことは、地点名を落とす理由にならない。 */}
                      {group.pref && (
                        <div className="text-[0.75rem] roomy:text-[0.875rem] font-bold text-white">
                          {group.pref}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.8125rem] roomy:text-[1rem] text-white">
                        {/* 気象庁以外が運用する観測点には電文どおり `＊` を付ける。震度一覧・
                            地図の吹き出しと同じ扱い（→ `withNonJmaMark`）。 */}
                        {/* 地名を押すと地図がその地点（区域なら代表点）へ寄る。震度一覧の
                            観測点の行と同じ引き当てで、寄り先を作れる名前だけが押せる
                            （→ `focusHandlerFor`・docs/spec/quake-spec.md §8）。
                            **`＊` まで含めて 1 つの当たり判定にする** —— 印は名前の一部で、
                            そこだけ押せないと境目が利用者に分からない。 */}
                        {group.names.map(({ name, nonJma, isArea }) => {
                          const focus = focusHandlerFor(group.pref, name, isArea)
                          return (
                            <span
                              key={name}
                              title={nonJma ? NON_JMA_MARK_TITLE : undefined}
                              {...(focus ? {
                                role: 'button' as const,
                                tabIndex: 0,
                                onClick: (e: React.MouseEvent) => { e.stopPropagation(); focus() },
                                onKeyDown: (e: React.KeyboardEvent) => {
                                  if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); focus() }
                                },
                                className: 'cursor-pointer hover:underline',
                              } : {})}
                            >
                              {withNonJmaMark(name, nonJma)}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )
            }

            if (prefGroups.length === 0) return null

            return (
              <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
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
                      mark={rowMark(rowMarkKey.pref(prefRow.pref), prefRow.regions.flatMap(r => [rowMarkKey.area(r.name), ...regionDescendantKeys(r)]))}
                      depth={0}
                      expandKey={prefRow.regions.length > 0 ? `pref:${prefRow.pref}` : null}
                      expanded={expanded}
                      onToggle={toggle}
                      onFocus={focusBoundsHandler(prefBounds.get(prefRow.pref) ?? null)}
                    />
                    {expanded.has(`pref:${prefRow.pref}`) && prefRow.regions.map(region => (
                      <div key={region.name}>
                        <IntensityRow
                          label={region.name}
                          scale={region.scale}
                          unreceived={region.unreceived}
                          hasUnreceived={region.hasUnreceived}
                          mark={rowMark(rowMarkKey.area(region.name), regionDescendantKeys(region))}
                          depth={1}
                          expandKey={region.cities.length > 0 || region.stations.length > 0 ? `area:${region.name}` : null}
                          expanded={expanded}
                          onToggle={toggle}
                          onFocus={focusBoundsHandler(areaBounds.get(region.name) ?? null)}
                        />
                        {expanded.has(`area:${region.name}`) && (
                          <>
                            {region.cities.map(city => (
                              <div key={city.name}>
                                <IntensityRow
                                  label={city.name}
                                  scale={city.scale}
                                  unreceived={city.unreceived}
                                  unreceivedIsOwn={city.unreceived}
                                  hasUnreceived={city.hasUnreceived}
                                  mark={rowMark(rowMarkKey.city(region.name, city.name), city.stations.map(st => rowMarkKey.station(st.name)))}
                                  depth={2}
                                  expandKey={city.stations.length > 0 ? `city:${region.name}/${city.name}` : null}
                                  expanded={expanded}
                                  onToggle={toggle}
                                  onFocus={focusCityHandler(prefRow.pref, city.stations)}
                                />
                                {expanded.has(`city:${region.name}/${city.name}`) && city.stations.map(st => (
                                  <IntensityRow
                                    key={st.name}
                                    label={st.name}
                                    scale={st.scale}
                                    unreceived={st.unreceived}
                                    unreceivedIsOwn={st.unreceived}
                                    nonJma={st.nonJma}
                                    mark={rowMark(rowMarkKey.station(st.name))}
                                    depth={3}
                                    expandKey={null}
                                    expanded={expanded}
                                    onToggle={toggle}
                                    onFocus={focusHandlerFor(prefRow.pref, st.name)}
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
                                unreceivedIsOwn={st.unreceived}
                                nonJma={st.nonJma}
                                mark={rowMark(rowMarkKey.station(st.name))}
                                depth={2}
                                expandKey={null}
                                expanded={expanded}
                                onToggle={toggle}
                                onFocus={focusHandlerFor(prefRow.pref, st.name)}
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
          {/* **ここだけ値の下へ置く。** バッジは 7rem 角に固定してあり、「5弱」で幅をほぼ
              使い切るため横には添えられない（→ `maxScaleOrAbove` の注記）。縦並びの器なので
              下へ置けば正方形は崩れない。 */}
          {maxScaleOrAbove && (
            <span
              className="text-sm font-bold leading-none"
              style={{ color: getIntensityColor(maxScale) }}
            >
              以上
            </span>
          )}
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
            {/* 畳んだ表示。開いた表示（上）と同じ語を出す。 */}
            <span className="text-base text-secondary flex-shrink-0">{formatQuakeTime(earthquake.time) ?? '発生時刻不明'}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded min-w-0 truncate ${issueTypeBadgeClass(issue.type)}`}>
              <QuakeReportHeading reports={quake.reports} fallback={issue.type} />
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

          {/* 津波情報（常に最終行）。説明は選択時のカードと同じものを付ける
              —— **一覧のほうが先に目に入る**ので、こちらだけ説明が無いと順序が逆になる。 */}
          <div
            className="text-base font-medium"
            title={domesticTsunami === '警報等' ? TSUNAMI_WARNING_GROUP_TITLE : undefined}
            style={{ color: tsunamiInfo.color }}
          >
            {tsunamiInfo.text}
          </div>
        </div>
      </div>
    </button>
  )
}
