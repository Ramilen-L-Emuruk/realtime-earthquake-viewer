import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAutoOpenWhileSpeaking } from '../../hooks/useAutoOpenWhileSpeaking'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation, TsunamiWarningComment } from '../../types/earthquake'
import { formatDateTimeMin, formatDepth, formatMagnitudeCondition, formatTimeMin, hasDepth } from '../../utils/formatters'
import { quakeEventKey } from '../../utils/quakeMerge'
import { groupAreasForCardDisplay, tsunamiAreaGradeChanges, TSUNAMI_GRADE_LIFTED, matchesArea, observationBadges, observationHeightText, observationArrivalFallbackText, observationMaxHeightTimeText, estimationBadges, estimationHeightText, forecastHeightImportantBadge, GRADES_IN_CARD_ORDER, TSUNAMI_GRADE_SHORT_LABEL, isTsunamiGradeRaised, sourceEarthquakeTime, tsunamiAreaKey, evacuationActionLine } from '../../utils/tsunami'
import { TSUNAMI_MISSING_COLOR as MISSING_COLOR } from '../../utils/tsunamiStyle'
import { mapChunksToRefs, planFollowScroll, type FollowRect, type SpeechFollowSession, type SpeechRef } from '../../utils/ttsFollow'
import { getSpeechClock } from '../../utils/voicevox'
import { INTERACTION_HOLD_SEC } from '../Map/gl/camera'
import { log } from '../../utils/logger'
import { useTsunamiObsCoords } from '../../hooks/useTsunamiObsCoords'
import { commentsOverlayMaxHeight, canShowCommentsOverlay } from './overlayHeight'
import { useTsunamiZones } from '../../hooks/useTsunamiZones'
import { ringsBoundsIndex, EMPTY_BOUNDS_INDEX } from '../../utils/subregions'
import type { LatLng } from '../../utils/stationCoords'

export interface FocusedDistrict {
  // 今回の受信で変更（新規/更新）があった区域すべて。寄せ先を決められない受信では空配列
  districts: { code?: string; name?: string }[]
  // その中で波高が最大の区域（画面に収まらない場合はこれを一番上に配置する）。districts が空のときは null
  top: { code?: string; name?: string } | null
  /**
   * `districts` が空のときに、カードの先頭へ戻すか。
   *
   * **「寄せ先が無い」と「先頭へ戻せ」は別の事実。** 空配列だけで両方を表していたころ、
   * 各地の満潮時刻・津波到達予想時刻に関する情報（観測点を載せず等級も変えない続報）が
   * 「変化なし」として先頭戻しに回り、**直前の報が寄せた位置を捨てていた**。沖合の観測情報も
   * 同じ穴に落ちる —— 新しい観測点はあるのに、沖合の観測点は津波予報区を持たないため
   * 寄せ先の一覧が空になる（実電文での実測は docs/spec/tsunami-spec.md §14 の 2026-09-11 の項）。
   *
   * 先頭へ戻してよいのは、カードの中身が入れ替わって前の位置に意味が無くなったときだけ
   * （解除・新規発報・等級の変わった報）。**既定値を置かない** ——
   * 受信の種類ごとに決める判断なので、足し忘れを型検査で捕まえる。
   *
   * **既定の状態への復帰（アイドル復帰など）はここを通らない。** あちらは受信ではなく
   * タブ切替なので、`autoShowTick`（`shouldResetTsunamiScroll` が判定する）が担う。
   * かつては復帰もここへ要求を出していたが、**タブが変わっていなくても戻す**形だったため、
   * 津波タブを見ている最中の復帰で読んでいた位置が捨てられていた。
   */
  resetToTop: boolean
  ts: number
}

interface Props {
  tsunamis: JMATsunami[]
  earthquakes?: JMAQuake[]
  onEarthquakeLink?: (quakeKey: string) => void
  onObservationClick?: (name: string) => void
  /** 区域名をクリックしたときに、その予報区の範囲へ地図を寄せる。 */
  onFocusMap?: (positions: LatLng[]) => void
  focusedDistrict?: FocusedDistrict | null
  obsUpdateStatus?: Map<string, 'new' | 'updated'>
  /**
   * 直近の受信で等級が動いた区域（`tsunamiAreaKey`）。この集合にある区域だけが
   * 「〇〇から切り替え」を出す。**区域が持つ `lastGrade` だけで出さないこと** ――
   * 気象庁の `LastKind` は変化した後の続報にも載り続けるため、何通も後まで
   * 「たった今切り替わった」ように見え続ける（→ docs/spec/tsunami-spec.md §10）。
   */
  areaGradeChangedKeys?: ReadonlySet<string>
  /** 進行中の読み上げ。渡されるとカードが読み上げに追従する（`null` なら追従しない） */
  speechSession?: SpeechFollowSession | null
  /**
   * 気象庁が書いた文（本文・付加文）をいま読み上げているか。真のあいだ、バナーの
   * 「気象庁が書いた文」を開く（→ docs/spec/audio-tts-spec.md §6）。
   */
  speakingTelegramText?: boolean
  /**
   * 津波タブが実際に見えているか。
   * タブは `invisible` で隠すだけなので、非表示でもスクロールは効いてしまう。
   */
  isVisible?: boolean
  /**
   * 読み上げが有効か。**有効なら受信時スクロールを行わず、読み上げ追従に任せる。**
   *
   * 受信時スクロールは電文が届いた瞬間に「変わった区域」へ寄せるが、読み上げが始まるのは
   * その 0.8〜2.8 秒後（通知音との間隔）。両方が働くと、先に区域へ寄ってから追従が等級カードの
   * 頭へ引き戻す、という逆向きの動きが見える。読み上げがあるなら声と画面を一致させる側に
   * 任せる（読み上げがある経路は順序の判断を読み上げ側に預ける、という既存の方針に揃える）。
   */
  speechFollowEnabled?: boolean
  /**
   * 津波タブを自動で見せた回数。**増えるたびにスクロールを先頭へ戻す。**
   *
   * 別のタブへ移ったあと続報やアイドル復帰で連れ戻されると、前に見ていた途中の位置が
   * 残ったまま表示される。自動で見せる以上は先頭（最も重い等級のカード）から見せる。
   * 手動で開いたときは増えないので、自分でスクロールした位置は保たれる。
   *
   * **これは最も弱い層。** 同じ受信で受信時スクロールや読み上げ追従が動くならそちらが
   * 上書きする（先頭へ戻すのは `useLayoutEffect`、他は `useEffect` と rAF なので必ず後）。
   */
  autoShowTick?: number
}

/**
 * 読み上げが有効なとき、受信時スクロールが追従を待つ時間。
 *
 * 声が出るまでには「通知音を鳴らし終える間隔」（`ttsDelayFor`。大津波警報は 2.27 秒）に
 * 読み上げの待ち行列と合成の時間が積み上がる。**実測では受信から 13 秒後**に最初の追従が
 * 動いた（大津波警報テスト）ので、それより余裕を持たせる。短すぎると、正常に読み上げられる
 * 場面でも受信時スクロールが先に動いて往復が見える ―― この機能で消したかったものそのもの。
 *
 * 長く取ることの代償は「読み上げが成立しなかったときに待たされる時間」だけ。塞いでしまう
 * （永久に待つ）のに比べれば軽い。
 */
const SPEECH_FOLLOW_GRACE_MS = 20000

/**
 * 追従用の行の登録キー。区域は code を優先し、無ければ名前で引く（`matchesArea` と同じ順序）。
 *
 * 津波カードの行を指さない参照（地震情報の `quakeRegion` / `quakeFact`）は空を返す。
 * ここへ来ることは無い（`hasFollowTarget` が地震情報の読み上げで追従を始めさせない）が、
 * 引き当てられない参照を無理に区域名として扱うと、名前が偶然一致した行を掴む。
 */
function speechRowKeys(ref: SpeechRef): string[] {
  if (ref.kind === 'grade') return [`grade:${ref.grade}`]
  if (ref.kind === 'station') return [`station:${ref.name}`]
  if (ref.kind !== 'area') return []
  return ref.code ? [`area:code:${ref.code}`, `area:name:${ref.name}`] : [`area:name:${ref.name}`]
}

type TsunamiGrade = TsunamiArea['grade']

interface GradeStyle {
  headerBg: string
  headerColor: string
  headerBorder: string
  cardBorder: string
  arrivalColor: string
  heightColor: string
}

function getGradeStyle(grade: TsunamiGrade): GradeStyle {
  switch (grade) {
    case 'MajorWarning':
      return { headerBg: '#2d0036', headerColor: '#e879f9', headerBorder: '#a855f7', cardBorder: '#a855f7', arrivalColor: '#a855f7', heightColor: '#e879f9' }
    case 'Warning':
      return { headerBg: '#450a0a', headerColor: '#fca5a5', headerBorder: '#ef4444', cardBorder: '#ef4444', arrivalColor: '#f87171', heightColor: '#fca5a5' }
    case 'Watch':
      return { headerBg: '#431407', headerColor: '#fdba74', headerBorder: '#f97316', cardBorder: '#f97316', arrivalColor: '#f97316', heightColor: '#fdba74' }
    case 'Forecast':
      return { headerBg: '#0c1a26', headerColor: '#67e8f9', headerBorder: '#0891b2', cardBorder: '#0891b2', arrivalColor: '#22d3ee', heightColor: '#67e8f9' }
    default:
      return { headerBg: '#1f2937', headerColor: '#9ca3af', headerBorder: '#4b5563', cardBorder: '#4b5563', arrivalColor: '#6b7280', heightColor: '#9ca3af' }
  }
}

const GRADE_LABEL: Record<TsunamiGrade, string> = {
  MajorWarning: '大津波警報',
  Warning:      '津波警報',
  Watch:        '津波注意報',
  Forecast:     '津波予報（若干の海面変動）',
  Unknown:      '不明',
}

// 等級カードを積む順は読み上げと共有する（`GRADES_IN_CARD_ORDER`）。ここに独自の配列を置くと、
// 読み上げの並びとカードの並びが片方だけ変わって追従スクロールが往復する。
const GRADE_ORDER = GRADES_IN_CARD_ORDER

// 解除表示（cancelledAt セット中）の見出し・説明文・オーバーレイ短文を cancelReason ごとに出し分ける。
// 気象庁の運用上、警報・注意報は「解除」、誤発表は「取消」、予報は解除電文を伴わず「有効期間終了」で
// 静かに消えるため、それぞれ表現が異なる（Issue #2）。
const CANCEL_REASON_LABEL: Record<NonNullable<JMATsunami['cancelReason']>, { title: string; desc: string; badge: string }> = {
  lifted:    { title: '津波情報 解除',       badge: '解除', desc: 'この津波情報は解除されました' },
  retracted: { title: '津波情報 取消',       badge: '取消', desc: 'この津波情報は誤って発表されたため取り消されました' },
  expired:   { title: '津波予報 有効期間終了', badge: '終了', desc: 'この津波予報は有効期間が終了しました' },
}

// FocusedDistrict の区域識別子（code/name）を発表区域に紐づける。照合ルールは matchesArea と同じ。
function districtMatchesArea(district: { code?: string; name?: string }, area: TsunamiArea): boolean {
  if (district.code && area.code) return district.code === area.code
  return !!district.name && district.name === area.name
}

function TsunamiHeightHeader({ label, style }: { label: string; style: GradeStyle }) {
  return (
    <div className="px-3 py-1 font-black leading-none text-[1.125rem] roomy:px-4 roomy:text-[1.375rem]"
      style={{ color: style.heightColor, backgroundColor: `${style.cardBorder}14`, borderBottom: `1px solid ${style.cardBorder}33` }}>
      {label}
    </div>
  )
}

/**
 * 津波の原因地震を 1 行で出す。
 *
 * **1 件目と 2 件目以降で同じものを通すこと。** 電文は原因地震を複数持ちうる（短い間に起きた
 * 地震がまとめて 1 通で発表される）ので、別々に書くと項目を足したとき片方に漏れる。
 */
function SourceEarthquakeLine({ eq, prefix, link }: {
  eq: NonNullable<JMATsunami['sourceEarthquakes']>[number]
  prefix: string
  link: React.ReactNode
}) {
  const quakeTime = sourceEarthquakeTime(eq)
  // 日時として読めなければ句ごと落とす（→ `formatters.ts` の `readDateTime`）。震源名・規模・
  // 深さが並ぶ行の付随情報なので、「発生」だけが残るより出さないほうがよい。
  const quakeHm = quakeTime ? formatTimeMin(quakeTime) : null
  return (
    <div>
      {prefix}{eq.hypocenterName}
      {/* 規模が数値で無いときは気象庁が添えた説明を出す（「Ｍ８を超える巨大地震」）。
          ここを空にすると、最大級の地震ほど震源名だけの薄い表示になる。 */}
      {eq.magnitude !== undefined
        ? `　M${eq.magnitude}`
        : eq.magnitudeCondition && `　${formatMagnitudeCondition(eq.magnitudeCondition)}`}
      {/* 深さ。**遠地地震による津波では、震源の深さがこの電文にしか無い**（対応する地震情報が
          発表されないことがある）。`0` は「ごく浅い」という有効値なので `hasDepth` で弾く。
          **値によらず「深さ」を前置する** —— 地震カード・地図・共有カードもそう出しており、
          ここだけ省くとアプリの中で表記が割れる。 */}
      {eq.depth !== undefined && hasDepth(eq.depth) && `　深さ ${formatDepth(eq.depth)}`}
      {/* 地震の時刻は `sourceEarthquakeTime` を通す（**発現時刻を先に採る**）。発生時刻を出すと、
          同じ地震が地震カードと津波カードで 1 分違って見える。理由と実電文で測った数字は
          `docs/spec/tsunami-spec.md` §4 が正。 */}
      {quakeHm && `　${quakeHm}発生`}
      {link}
      {/* 震央補助表現（「御前崎の北東40km付近」）と震源決定機関（「ＰＴＷＣ」等）。
          前者は震央地名より具体的に場所が分かり、後者は誰が決めた値かを示す。
          どちらも気象庁の語をそのまま出す。 */}
      {eq.nameFromMark && <div>{eq.nameFromMark}</div>}
      {/* この要素は**気象庁以外の機関が決めた震源を採用したときだけ**入る（Ⅱ.13 2-3-2）ので、
          機関名だけでは含意（気象庁の決定ではない）が伝わらない。ラベルに書く。 */}
      {eq.source && <div>震源決定: {eq.source}（気象庁以外）</div>}
    </div>
  )
}

/**
 * 区域の到達状況（`FirstHeight/Condition`）をバッジの文言へ写す。
 *
 * **3 つは意味が違う。** 「ただちに津波来襲と予測」はこれから来る予測、「津波到達中と推測」は
 * いま来ている推測、「第１波の到達を確認」は実際に到達した事実。**どれも同じ「到達中」と
 * 出していたため、これから来るのか既に来たのかが読み取れなかった。**
 *
 * 表に無い文言はバッジにしない（`arrivalText` として本文にそのまま出る）。気象庁が語を
 * 増やしたとき、知らない語を赤いバッジで強調してしまわないため。
 *
 * **3 値は気象庁の電文解説資料（地震火山関連）の事例と、実電文の両方で確かめてある。**
 * 「津波到達中と推測」「第１波の到達を確認」は令和6年能登半島地震の電文に実在した
 * （同じ欄には「第１波識別不能」「観測中」「微弱」も現れる。それらは観測状態として
 * `parseTsunamiObservationCondition` が拾う）。
 *
 * **全角・半角の「1」を両方引けるようにしておく**（解説資料の表記は全角）。同じ欄を読む
 * `FIRST_HEIGHT_CONDITIONS`（`tsunami.ts`）が既に両方を持っており、片方だけ想定しないと
 * 同じ電文の同じ欄で扱いが割れる。
 */
const ARRIVAL_CONDITION_BADGE: Record<string, string> = {
  'ただちに津波来襲と予測': 'まもなく到達',
  '津波到達中と推測': '到達中',
  '第１波の到達を確認': '第1波到達',
  '第1波の到達を確認': '第1波到達',
}

function TsunamiAreaRow({ area, observations, style, onObservationClick, canFocusObs, onAreaFocus, isChanged, isTop, registerRow, registerSpeechRow, obsUpdateStatus, areaGradeChangedKeys }: { area: TsunamiArea; observations: TsunamiObservation[]; style: GradeStyle; onObservationClick?: (name: string) => void; canFocusObs: (name: string) => boolean; onAreaFocus?: (name: string) => (() => void) | undefined; isChanged: boolean; isTop: boolean; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: Map<string, 'new' | 'updated'>; areaGradeChangedKeys?: ReadonlySet<string> }) {
  const areaFocus = onAreaFocus?.(area.name)
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    registerRow?.(area, isChanged, isTop, el)
    // 追従スクロールの引き当て用。focusedDistrict とは違い、変更の有無に関わらず全区域を登録する
    registerSpeechRow?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
  }, [registerRow, registerSpeechRow, area, isChanged, isTop])

  // バッジにする文言は本文から外す（同じことを 2 度書かない）。表に無い文言は本文へ残す。
  //
  // **バッジが出ない区域では本文へ戻す。** バッジは実測がある区域では出さない（下記）ため、
  // 無条件に本文から外すと**到達状況が画面のどこにも出ない**。
  const badgeSuppressed = observations.length > 0
  const arrivalBadgeLabel = !badgeSuppressed && area.firstHeight?.condition
    ? ARRIVAL_CONDITION_BADGE[area.firstHeight.condition]
    : undefined
  // 時刻が日時として読めないときは、時刻そのものが無い電文と同じ扱いにする（バッジか、
  // バッジが出ない区域では電文の到達状況の語へ戻す）。「到達予想 」とラベルだけ残すより、
  // 気象庁が書いた語のほうが利用者に届く。
  const areaArrivalHm = area.firstHeight?.arrivalTime ? formatTimeMin(area.firstHeight.arrivalTime) : null
  const arrivalText = areaArrivalHm
    ? `到達予想 ${areaArrivalHm}`
    : (arrivalBadgeLabel ? null : (area.firstHeight?.condition ?? null))

  // 直近の受信で等級が動いた区域に、その移り変わりを 1 行で示す。
  //
  // 条件は 2 つ。**直近の受信で動いた区域であること**（`areaGradeChangedKeys`。区域が持つ
  // `lastGrade` は変化後の続報にも残るため、これが無いと出続ける）と、**前回が「津波なし」
  // （`Unknown`）でないこと**（新規発表の報では全区域がそこから始まり、全部の行に付いて
  // 意味を持たなくなる）。`lastGrade` は DMDATA 経路のみが持つ（P2PQuake は配信しない）。
  const gradeChange = areaGradeChangedKeys?.has(tsunamiAreaKey(area))
    && area.lastGrade && area.lastGrade !== 'Unknown' && area.lastGrade !== area.grade
    ? {
      raised: isTsunamiGradeRaised(area.lastGrade, area.grade),
      label: TSUNAMI_GRADE_SHORT_LABEL[area.lastGrade],
    }
    : null

  const stations = area.stations ?? []
  // 実測値がある観測点名のセット（到達済み判定・到達中バッジ抑制に使用）
  const observedNames = new Set(observations.map(o => o.name))
  // 区域内に1件でも実測値があれば到達のバッジは不要（実測行で代替できる）。
  //
  // **`immediate` は文言が読めないときの補い。** P2PQuake も 3 値の文言をそのまま配信するが、
  // `firstHeight` を持たない古いデータでは真偽値しか残らない。**「ただちに津波来襲と予測」と
  // 1 対 1 ではなく**、実データでは「津波到達中と推測」の区域でも真になる（第１波の到達を
  // 確認では偽）ので、文言が読めるならそちらを優先する
  // （→ [`tsunami-spec.md`](../../../docs/spec/tsunami-spec.md) §9「区域の到達状況」）。
  const arrivalBadge = badgeSuppressed
    ? undefined
    : (arrivalBadgeLabel ?? (area.immediate ? ARRIVAL_CONDITION_BADGE['ただちに津波来襲と予測'] : undefined))

  return (
    <div ref={setRowRef} className="border-b border-white/5 last:border-0">
      <div className="flex items-center gap-2 px-3 py-2 roomy:gap-3 roomy:px-4 roomy:py-3">
        <div className="flex-1 min-w-0">
          {/* 区域名を押すとその予報区の海岸線が入る範囲へ地図が寄る。**押せるのは境界を引ける
              区域だけ**（観測点の行と同じ規律 → §9「観測点の行・区域名をクリックしたときの寄り先」）。
              行全体を押せるようにしないのは、この行が観測点の一覧を抱えているため。 */}
          <span
            className={`text-white font-semibold block text-[1.0625rem] roomy:text-[1.25rem]${areaFocus ? ' cursor-pointer hover:underline' : ''}`}
            style={{ lineHeight: '1.2' }}
            {...(areaFocus ? {
              role: 'button' as const,
              tabIndex: 0,
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); areaFocus() },
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); areaFocus() }
              },
            } : {})}
          >
            {area.name}
          </span>
          {arrivalText && (
            <span className="block mt-1" style={{ fontSize: '0.9375rem', color: style.arrivalColor }}>
              {arrivalText}
            </span>
          )}
          {gradeChange && (
            <span className="block mt-1" style={{ fontSize: '0.8125rem', color: gradeChange.raised ? '#f87171' : '#9ca3af' }}>
              {gradeChange.label}から{gradeChange.raised ? '引き上げ' : '切り替え'}
            </span>
          )}
          {/* 大津波警報の区域で、予想波高が初めて数値になった／上方修正された
              （電文の `MaxHeight/Condition` = 重要）。観測・推定の「重要」とは意味が違うので
              語を分けている（→ tsunami.ts の forecastHeightImportantBadge）。 */}
          {area.forecastHeightImportant && (
            <span className="block mt-1" style={{ fontSize: '0.8125rem', color: '#f87171' }}>
              {forecastHeightImportantBadge()}
            </span>
          )}
        </div>
        {arrivalBadge && (
          <span className="flex-shrink-0 text-xs font-bold px-2 py-1 rounded border"
            style={{ color: '#f87171', backgroundColor: 'rgba(239,68,68,0.15)', borderColor: '#ef4444' }}>
            {arrivalBadge}
          </span>
        )}
      </div>
      {/* 観測点ごとに実測・予測を統合して表示 */}
      {(observations.length > 0 || stations.length > 0) && (
        <div className="mx-4 mb-3 flex flex-col gap-1.5">
          {/* 実測値あり観測点 */}
          {observations.map((obs, i) => {
            const clickable = !!onObservationClick && canFocusObs(obs.name)
            const updateStatus = obsUpdateStatus?.get(obs.name)
            const borderLeftStyle = updateStatus === 'new'
              ? '3px solid #4ade80'
              : updateStatus === 'updated'
                ? '3px solid #fbbf24'
                : `1px solid ${style.cardBorder}38`
            const matched = stations.find(s => s.name === obs.name)
            // 実測の到達時刻が出せていない行に、予報側が持っている到達予想を添える。
            //
            // **欠測で絞らない。** 実配信でこの値が残るのは欠測の地点だけだが（到達そのものを
            // 観測できていないので、気象庁に予想を取り下げる理由が無い）、観測状態の名前で条件を
            // 書くと、別の状態で届いたときに黙って落とす。見たいのは「実測の到達時刻が出せて
            // いない」ことそのもの。
            //
            // **語は区域の行（`arrivalText`）と揃える。** 実測は「05:12 押し波」の形で出るため、
            // 語を冠さないと予報の値が観測できた時刻に見える。
            // **判定は整形の結果で行う。** 値があっても日時として読めなければ実測の到達時刻は
            // 出せないので、上の「実測の到達時刻が出せていない」に含まれる。
            const obsArrivalHm = obs.arrivalTime ? formatTimeMin(obs.arrivalTime) : null
            const forecastArrivalHm = !obsArrivalHm && matched?.arrivalTime
              ? formatTimeMin(matched.arrivalTime)
              : null
            const forecastArrivalText = forecastArrivalHm ? `到達予想 ${forecastArrivalHm}` : ''
            const matchedHighTideHm = matched?.highTideDateTime ? formatTimeMin(matched.highTideDateTime) : null
            // この欄は空になりうる要素が並ぶ。**区切りを前置きする書き方にしない** —— 先頭が
            // 空のとき字下げだけが残る（到達予想を足す前から、欠測の行の満潮時刻がそうなっていた）。
            const timeTexts = [
              obsArrivalHm
                ? `${obsArrivalHm}${obs.initial ? ` ${obs.initial}波` : ''}`
                : observationArrivalFallbackText(obs),
              // 第1波についての話が続くので、実測の到達時刻と同じ位置に置く。
              forecastArrivalText,
              // 最大波を観測した時刻。第1波の到達時刻と紛れないよう語を冠する
              // （決め方は `observationMaxHeightTimeText`）。
              observationMaxHeightTimeText(obs),
              // 同名 station があれば満潮時刻をここに表示
              matchedHighTideHm ? `満潮 ${matchedHighTideHm}` : '',
            ].filter(Boolean)
            return (
              <div
                key={i}
                /* 追従スクロールの引き当て用。読み上げが読むのは実測・到達確認の観測点だけなので、
                   下の「予測のみ」の行は登録しない（同名の行が 2 つあると引き当てが曖昧になる） */
                ref={el => registerSpeechRow?.([`station:${obs.name}`], el)}
                className={`px-3 py-2 rounded${clickable ? ' cursor-pointer hover:brightness-125 transition-[filter]' : ''}`}
                style={{ background: `${style.cardBorder}12`, border: `1px solid ${style.cardBorder}38`, borderLeft: borderLeftStyle }}
                onClick={clickable ? () => onObservationClick!(obs.name) : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onObservationClick!(obs.name) } : undefined}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold" style={{ fontSize: '0.8125rem', color: style.heightColor }}>{obs.name}</span>
                      {observationBadges(obs).map(label => (
                        <span
                          key={label}
                          className="text-xs font-bold px-1.5 py-0.5 rounded"
                          style={label === '欠測'
                            ? { background: `${MISSING_COLOR}26`, color: MISSING_COLOR }
                            : { background: `${style.cardBorder}30`, color: style.heightColor }}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                    {timeTexts.length > 0 && (
                      <div className="mt-1" style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
                        {timeTexts.join('　')}
                      </div>
                    )}
                  </div>
                  {obs.height ? (
                    <span className="font-bold flex-shrink-0" style={{ fontSize: '1.25rem', color: style.heightColor }}>{observationHeightText(obs)}</span>
                  ) : observationHeightText(obs) && (
                    <span className="flex-shrink-0" style={{ fontSize: '0.8125rem', color: '#9ca3af' }}>{observationHeightText(obs)}</span>
                  )}
                </div>
              </div>
            )
          })}
          {/* 実測値なし観測点（station のみ） */}
          {stations.filter(s => !observedNames.has(s.name)).map((st, i) => {
            // **語は実測の行・区域の行と揃える。** 同じ `TsunamiStation.arrivalTime` を、実測の
            // エントリが有るか無いかだけで「到達予想」「到達」と呼び分けると、上下に並んだとき
            // 片方が確定した事実に見える。バッジ（「予測」）があっても、時刻の語が違えば別の
            // 性質の値として読まれる。
            // 日時として読めない時刻はラベルごと落とす（「到達予想 」だけが残ると値があるように見える）。
            const stArrivalHm = st.arrivalTime ? formatTimeMin(st.arrivalTime) : null
            const stHighTideHm = st.highTideDateTime ? formatTimeMin(st.highTideDateTime) : null
            const timeTexts = [
              stArrivalHm ? `到達予想 ${stArrivalHm}` : '',
              stHighTideHm ? `満潮 ${stHighTideHm}` : '',
            ].filter(Boolean)
            return (
              <div key={i} className="px-3 py-2 rounded" style={{ border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.03)' }}>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-semibold" style={{ fontSize: '0.8125rem', color: '#d1d5db' }}>{st.name}</span>
                  <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)', color: '#9ca3af' }}>予測</span>
                </div>
                {timeTexts.length > 0 && (
                  <div className="mt-1" style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
                    {timeTexts.join('　')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TsunamiObservationRow({ obs, onObservationClick, canFocusObs, registerSpeechRow }: { obs: TsunamiObservation; onObservationClick?: (name: string) => void; canFocusObs: (name: string) => boolean; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void }) {
  const clickable = !!onObservationClick && canFocusObs(obs.name)
  // 日時として読めない到達時刻は、時刻が無い電文と同じ落とし先（下の fallback 群）へ回す。
  const arrivalHm = obs.arrivalTime ? formatTimeMin(obs.arrivalTime) : null
  return (
    <div
      /* 追従スクロールの引き当て用。この行は区域に紐づかない観測点（沖合）で、読み上げは
         区域の下の観測点と同じように読む。登録しないとその観測点を読んでいる間だけカードが
         動かず、引き当て失敗の診断も鳴る */
      ref={el => registerSpeechRow?.([`station:${obs.name}`], el)}
      className={`flex items-center gap-2 px-3 py-2 border-b border-white/5 last:border-0 roomy:gap-3 roomy:px-4 roomy:py-3${clickable ? ' cursor-pointer hover:brightness-125 transition-[filter]' : ''}`}
      onClick={clickable ? () => onObservationClick!(obs.name) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onObservationClick!(obs.name) } : undefined}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-white font-semibold text-[1rem] roomy:text-[1.125rem]">
            {obs.name}
          </span>
          {/* 区域に紐づく行と同じ語を出す（バッジの決め方は `observationBadges`）。ここへ出さないと、
              沖合の観測点だけ欠測が画面から落ちる */}
          {observationBadges(obs).filter(label => label !== '到達確認').map(label => (
            <span
              key={label}
              className="text-xs font-bold px-1.5 py-0.5 rounded"
              style={label === '欠測'
                ? { background: `${MISSING_COLOR}26`, color: MISSING_COLOR }
                : { background: 'rgba(255,255,255,0.08)', color: '#9ca3af' }}
            >
              {label}
            </span>
          ))}
        </div>
        {/* 最大波の観測時刻は**到達時刻の有無に関わらず出す**（第1波を識別できなくても
            最大波は観測できている電文がある）。区域に紐づく行と同じ述語を通す。 */}
        {arrivalHm ? (
          <span className="block mt-1 text-secondary" style={{ fontSize: '0.8125rem' }}>
            到達: {arrivalHm}{obs.initial ? `（${obs.initial}）` : ''}
            {observationMaxHeightTimeText(obs) && `　${observationMaxHeightTimeText(obs)}`}
            {/* 特殊観測機器（「ＧＮＳＳ波浪計」「水圧計」）。沖合の観測点だけが持つ。
                電文の語をそのまま出す —— 言い換えると、どちらの計器が測った値か分からなくなる。
                **括弧で括る** —— 「到達: 」のラベルは時刻にしか掛かっておらず、素で並べると
                地名や別の値と読める。 */}
            {obs.sensor && `　（${obs.sensor}）`}
          </span>
        ) : (observationArrivalFallbackText(obs) || observationMaxHeightTimeText(obs) || obs.sensor) && (
          <span className="block mt-1 text-secondary" style={{ fontSize: '0.8125rem' }}>
            {[observationArrivalFallbackText(obs), observationMaxHeightTimeText(obs)].filter(Boolean).join('　')}
            {obs.sensor && `${observationArrivalFallbackText(obs) || observationMaxHeightTimeText(obs) ? '　' : ''}（${obs.sensor}）`}
          </span>
        )}
      </div>
      {observationHeightText(obs) && (
        <span className="text-secondary flex-shrink-0" style={{ fontSize: '1rem' }}>
          {observationHeightText(obs)}
        </span>
      )}
    </div>
  )
}

function TsunamiGradeCard({ grade, areas, observations, onObservationClick, canFocusObs, onAreaFocus, focusedDistrict, registerRow, registerSpeechRow, registerSpeechAnchor, obsUpdateStatus, areaGradeChangedKeys }: { grade: TsunamiGrade; areas: TsunamiArea[]; observations: TsunamiObservation[]; onObservationClick?: (name: string) => void; canFocusObs: (name: string) => boolean; onAreaFocus?: (name: string) => (() => void) | undefined; focusedDistrict?: FocusedDistrict | null; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; registerSpeechAnchor?: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: Map<string, 'new' | 'updated'>; areaGradeChangedKeys?: ReadonlySet<string> }) {
  if (areas.length === 0) return null
  const style = getGradeStyle(grade)
  const groups = groupAreasForCardDisplay(areas, observations)
  return (
    /* 等級を告げたときの合わせ先は**カード全体**。帯だけを見ると、帯が視野の下端に映って
       いるだけで「収まっている」と判定して動かない ―― それでは等級を言った時点でカードの頭に
       来ない。全体を範囲にすれば視野に収まらない限り送られ、上端（＝帯）に揃う。 */
    <div ref={el => registerSpeechRow?.(speechRowKeys({ kind: 'grade', grade }), el)}
      className="bg-card rounded-lg overflow-hidden"
      style={{ border: `2px solid ${style.cardBorder}`, boxShadow: `0 0 0 1px ${style.cardBorder}40` }}>
      {/* 区域を読むときの合わせ先はこの帯（どの等級の話かが視野から消えないように） */}
      <div ref={el => {
        for (const area of areas) {
          registerSpeechAnchor?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
        }
      }}
        className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
        style={{ backgroundColor: style.headerBg, color: style.headerColor, borderBottom: `1px solid ${style.headerBorder}` }}>
        {GRADE_LABEL[grade]}
      </div>
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.heightLabel && <TsunamiHeightHeader label={group.heightLabel} style={style} />}
          {group.areas.map((area, i) => (
            <TsunamiAreaRow
              canFocusObs={canFocusObs}
              onAreaFocus={onAreaFocus}
              key={i}
              area={area}
              observations={observations.filter(o => matchesArea(o, area))}
              style={style}
              onObservationClick={onObservationClick}
              isChanged={focusedDistrict?.districts.some(d => districtMatchesArea(d, area)) ?? false}
              isTop={focusedDistrict?.top != null && districtMatchesArea(focusedDistrict.top, area)}
              registerRow={registerRow}
              registerSpeechRow={registerSpeechRow}
              obsUpdateStatus={obsUpdateStatus}
              areaGradeChangedKeys={areaGradeChangedKeys}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * この報で解除された区域を並べる枠。等級カードの後ろに置く。
 *
 * **等級カードを流用しないこと。** 解除された区域は電文が `Area` と `Category` しか持たず、
 * 波高・到達時刻・潮位観測点のいずれも無い。等級カードの行（`TsunamiAreaRow`）はそれらを
 * 描く前提で組んであるので、通しても空欄が並ぶだけになる。
 *
 * **前回の等級は無条件に出す。** 等級カードの「〇〇から切り替え」は直近の受信で動いた区域だけに
 * 付く（`areaGradeChangedKeys`。`lastGrade` が続報にも載り続けるため）が、こちらは枠そのものが
 * 「この報で解除された区域」を意味するので、印を絞る理由が無い。
 */
function TsunamiCancelledCard({ areas, focusedDistrict, registerRow, registerSpeechRow, registerSpeechAnchor }: { areas: TsunamiArea[]; focusedDistrict?: FocusedDistrict | null; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; registerSpeechAnchor?: (keys: string[], el: HTMLElement | null) => void }) {
  if (areas.length === 0) return null
  // 無彩色。解除は「もう出ていない」という報せなので、等級の色を借りない。
  const style = getGradeStyle('Unknown')
  // **カード自体は追従の引き当て先にしない。** 等級カードが `grade:` の鍵を持つのは、読み上げが
  // 「〇〇警報。」と等級を告げる箇所を指すため。解除の読み上げは区域名しか指さないので、
  // ここに鍵を置いても誰も引かない。
  return (
    <div className="bg-card rounded-lg overflow-hidden"
      style={{ border: `2px solid ${style.cardBorder}`, boxShadow: `0 0 0 1px ${style.cardBorder}40` }}>
      <div ref={el => {
        for (const area of areas) {
          registerSpeechAnchor?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
        }
      }}
        className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
        style={{ backgroundColor: style.headerBg, color: style.headerColor, borderBottom: `1px solid ${style.headerBorder}` }}>
        解除
      </div>
      {areas.map((area, i) => (
        <TsunamiCancelledRow
          key={i}
          area={area}
          style={style}
          isChanged={focusedDistrict?.districts.some(d => districtMatchesArea(d, area)) ?? false}
          isTop={focusedDistrict?.top != null && districtMatchesArea(focusedDistrict.top, area)}
          registerRow={registerRow}
          registerSpeechRow={registerSpeechRow}
        />
      ))}
    </div>
  )
}

/**
 * 解除カードの行。読み上げの追従と受信時スクロールの寄せ先になるため、等級カードの行と同じ
 * 2 つの登録（`registerRow` / `registerSpeechRow`）を通す。
 */
function TsunamiCancelledRow({ area, style, isChanged, isTop, registerRow, registerSpeechRow }: { area: TsunamiArea; style: GradeStyle; isChanged: boolean; isTop: boolean; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void }) {
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    registerRow?.(area, isChanged, isTop, el)
    registerSpeechRow?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
  }, [registerRow, registerSpeechRow, area, isChanged, isTop])
  return (
    <div ref={setRowRef} className="border-b border-white/5 last:border-0">
      <div className="flex items-center gap-2 px-3 py-2 roomy:gap-3 roomy:px-4 roomy:py-3">
        <div className="flex-1 min-w-0">
          <span className="text-white font-semibold block text-[1.0625rem] roomy:text-[1.25rem]" style={{ lineHeight: '1.2' }}>
            {area.name}
          </span>
          {/* 等級の呼び名は読み上げと共有する（`TSUNAMI_GRADE_SHORT_LABEL`）。
              `lastGrade` の有無は `describableCancelledAreas` が保証している。 */}
          {area.lastGrade && (
            <span className="block mt-1" style={{ fontSize: '0.8125rem', color: style.arrivalColor }}>
              {TSUNAMI_GRADE_SHORT_LABEL[area.lastGrade]}を解除
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function getTopGrade(tsunamis: JMATsunami[]): TsunamiGrade {
  for (const grade of GRADE_ORDER) {
    if (tsunamis.some(t => t.areas.some(a => a.grade === grade))) return grade
  }
  return 'Unknown'
}

// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
/**
 * 気象庁が書いた文の中身（行動指示の行をタップしたときに開く部分）。
 *
 * **小見出しは付けない。** 読めば何の話か分かる文ばかりで、名前を足すとかえって読む量が増える。
 * 区切り線だけで分ける。並びは電文の本文 → 固定付加文（主題順・`WARNING_COMMENT_ORDER`）→
 * 自由付加文。
 */
function TsunamiCommentBody({ bodyText, comments, freeText, borderColor, textColor }: { bodyText?: string; comments?: TsunamiWarningComment[]; freeText?: string; borderColor: string; textColor: string }) {
  const blocks: { key: string; text: string; pre: boolean }[] = [
    // 電文の本文。**バナーには出していない**ので、ここが唯一の出しどころ。
    ...(bodyText ? [{ key: '__body', text: bodyText, pre: true }] : []),
    ...(comments ?? []).map(c => ({ key: c.key, text: c.text, pre: false })),
    // 自由付加文。全角スペースで整形された表が入るため改行と空白をそのまま保つ。
    ...(freeText ? [{ key: '__free', text: freeText, pre: true }] : []),
  ]
  if (blocks.length === 0) return null
  return (
    <div>
      {/* 先頭だけ区切り線を出さない。**`first:` の指定では消せない** —— インラインの
          `borderTop` が常に勝つので、先頭かどうかをここで見て出し分ける。 */}
      {blocks.map((b, i) => (
        <div key={b.key}
          className={i === 0 ? '' : 'pt-2 mt-2'}
          style={i === 0 ? undefined : { borderTop: `1px solid ${borderColor}` }}>
          <div style={{ fontSize: '0.6875rem', color: textColor, opacity: 0.95, lineHeight: 1.6, whiteSpace: b.pre ? 'pre-wrap' : 'pre-line' }}>
            {b.text}
          </div>
        </div>
      ))}
    </div>
  )
}

export const TsunamiTab = memo(function TsunamiTab({ tsunamis, earthquakes, onEarthquakeLink, onObservationClick, onFocusMap, focusedDistrict, obsUpdateStatus, areaGradeChangedKeys, speechSession, speakingTelegramText, isVisible, speechFollowEnabled, autoShowTick }: Props) {
  // 行をクリックできるかは「地図がその観測点へ寄れるか」で決める。
  //
  // 座標表（`tsunami-obs-coords.json`）に無い観測点は地図に印が出ず、`FocusObsGL` も寄せ先を
  // 見つけられずに黙って何もしない。押せる見た目だけ与えると、利用者からは「押したのに動かない」
  // 理由が分からない。判定の材料は地図側（`useTsunamiLayerData`）が印を出すかどうかと同じ座標表。
  const obsCoords = useTsunamiObsCoords()
  const canFocusObs = useCallback((name: string) => !!obsCoords?.[name], [obsCoords])
  /**
   * 区域名から「その予報区へ寄せる」動作を作る。**押せるかどうかもこれで決まる**（境界を引けない
   * 区域は `undefined` が返り、押せる見た目にならない）。観測点の行と同じ規律。
   *
   * 寄り先は海岸線の**外接矩形の 2 点**（`fitToPositions` が矩形へ寄せるので全頂点は要らない）。
   * 索引は入力の参照をキーにキャッシュされるので、区域の行ごとに作り直されることはない。
   */
  const zones = useTsunamiZones()
  const zoneBounds = zones ? ringsBoundsIndex(zones, () => Object.entries(zones)) : EMPTY_BOUNDS_INDEX
  const onAreaFocus = useCallback((name: string) => {
    if (!onFocusMap) return undefined
    const bounds = zoneBounds.get(name)
    if (!bounds) return undefined
    const corners: LatLng[] = [[bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]]
    return () => onFocusMap(corners)
  }, [onFocusMap, zoneBounds])
  // cancelledAt がある = 10秒表示中なので active に含める
  const active = tsunamis.filter(t => !t.cancelled || t.cancelledAt)

  // バナーの本文と、そこから開く付加文。
  //
  // **フックは早期 return より前に置く。** 下の「津波情報はありません」で return しており、
  // 後ろに置くと津波が出た瞬間にフックの数が変わって React が描画ごと落とす（実際に踏んだ）。
  const isCancelledDisplay = active.every(t => !!t.cancelledAt)
  // 見るのは `active[0]` だけ。**状態は常に 0〜1 件スロット**で、同時発表は最新の 1 通で
  // 置き換わる（`useEarthquakes.ts` の TSU-3）。ここを配列で回しても 2 件目は来ない。
  const bannerBodyText = active[0]?.bodyText
  const bannerComments = active[0]?.warningComments
  const bannerFreeText = active[0]?.freeText
  // 行動指示の行に出す文。気象庁の避難行動の付加文が採れればそれを使う（→ `evacuationActionLine`）。
  const bannerActionLine = evacuationActionLine(bannerComments)
  // 開くものが 1 つも無ければ、その行はタップの入口にしない（押せる見た目だけ与えない）。
  // 取消し・解除の表示中も中身を出さないので、そこでも入口にしない。
  const hasCommentsToShow = (bannerComments?.length ?? 0) > 0 || !!bannerBodyText || !!bannerFreeText
  // 読み上げているあいだだけ開く（→ `useAutoOpenWhileSpeaking`）。**バナー 4 種と同じフックを使う。**
  // 自前で組んでいた頃は「手で開き直したら読み終わりで閉じない」という安全弁が抜けており、
  // 利用者が開いた面を読み終わりで閉じていた。
  const [commentsOpen, setCommentsOpen] = useAutoOpenWhileSpeaking(!!speakingTelegramText)
  // **開いたまま等級が動いたら閉じる。** 付加文の面は下の区域一覧を覆うので、開けっ放しだと
  // 発表・引き上げ・一部解除が届いても利用者の目に入らない。
  //
  // **ただし報ごとには閉じない。** 満潮時刻や観測の続報は数分おきに届き（2026-04-20 の実電文で
  // 41 通）、そのたびに閉じると読んでいる途中で毎回消える。鍵は津波の識別子と「区域ごとの等級」の
  // 組にして、等級が動いた報だけが閉じる契機になるようにする。
  //
  // `id` へ落ちるのは識別子を持たない電文のときだけ。その電文は続報として束ねられない
  // （`isTsunamiContinuation`）ので前報の中身も引き継がず、鍵が報ごとに変わっても
  // 「等級が動いたときだけ閉じる」との食い違いにはならない。
  const commentsKey = `${active[0]?.eventId ?? active[0]?.id ?? ''}|`
    + (active[0]?.areas ?? []).map(a => `${a.code ?? a.name}:${a.grade}`).join(',')
  // **前回値は state で持つ。ref をレンダー中に書き換えない。** React は描いた結果を捨てて
  // 描き直すことがあり、捨てられたレンダーでも ref の書き換えだけは残る。次のレンダーでは
  // 「鍵は変わっていない」と見えて閉じそこねる —— 実機で等級が動いても開いたままになった。
  // state なら捨てられたレンダーの更新も一緒に捨てられるので、この取りこぼしが起きない。
  const [prevCommentsKey, setPrevCommentsKey] = useState(commentsKey)
  // **閉じるのはエフェクトで行う。** 開閉の状態はフックが持ち、その setter は
  // 「手で操作した」という意味を持つ（読み上げの持ち物から外す）。レンダー中に呼ぶと、
  // React が捨てたレンダーでもフック内部の印だけが書き換わる。
  //
  // 1 描画ぶん閉じるのが遅れるが、**等級が動いた報で閉じる**という意図は保たれる。
  useEffect(() => {
    if (prevCommentsKey === commentsKey) return
    setPrevCommentsKey(commentsKey)
    // 読み上げ中でも閉じる（面は区域一覧を覆うので、発表・引き上げ・一部解除を隠さない）。
    // フックの setter を通すので、その読み上げのあいだは開き直さない。
    setCommentsOpen(false)
  }, [commentsKey, prevCommentsKey, setCommentsOpen])

  // sticky バナーの実高さを測り、自動スクロール先の scroll-margin-top に反映する
  // （バナーは発令中/解除・地震カードリンクの有無で行数が変わり高さが可変のため固定値では合わない）
  // 「津波情報なし」表示から実データ表示への切替でバナー要素自体が生成し直されるため、
  // useRef + 空配列 useEffect ではなく callback ref で mount のたびに監視し直す
  const bannerObserverRef = useRef<ResizeObserver | null>(null)
  const [bannerHeight, setBannerHeight] = useState(0)

  const bannerRef = useCallback((el: HTMLDivElement | null) => {
    bannerObserverRef.current?.disconnect()
    bannerObserverRef.current = null
    if (!el) return
    // contentRect は padding を含まない content-box。バナーには pt-3 の padding があるため
    // 実際の占有高さ（border-box）は getBoundingClientRect で測る
    const observer = new ResizeObserver(() => {
      setBannerHeight(el.getBoundingClientRect().height)
    })
    observer.observe(el)
    bannerObserverRef.current = observer
    // **初期値も同期で入れる**（パネル側と形を揃える）。監視のコールバックだけに任せると、
    // 「津波情報なし」から切り替わった直後の数フレームはバナーが 0 のままで、下の上限が
    // 実際より大きく出る。
    setBannerHeight(el.getBoundingClientRect().height)
  }, [])

  // 今回変更された区域の行DOM（area.code ?? area.name をキーに登録・登録解除される）
  const changedRowElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const topRowElRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // 重ねた付加文の高さの上限。**パネルの実寸から引く** —— 画面の高さ（`vh`）で切ると、
  // 上下分割でパネルが画面の一部しか占めていないときに下へはみ出す（実測値は
  // docs/spec/tsunami-spec.md §9）。バナーの下に置くので、残りがそのまま上限。
  //
  // **callback ref で測る。`useEffect` + `[]` では張り直されない。** 津波が無い間は下の
  // 「津波情報はありません」で早期 return しており、この要素自体が存在しない。効果は
  // 空振りして終わり、津波が届いても依存が変わらないので二度と走らない —— 結果、高さが 0 の
  // ままで上限が付かず、開いた付加文がパネルの外まで伸びる（実際にそうなった）。
  const [panelHeight, setPanelHeight] = useState(0)
  const panelObserverRef = useRef<ResizeObserver | null>(null)
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el
    panelObserverRef.current?.disconnect()
    panelObserverRef.current = null
    if (!el) return
    const observer = new ResizeObserver(() => setPanelHeight(el.clientHeight))
    observer.observe(el)
    panelObserverRef.current = observer
    setPanelHeight(el.clientHeight)
  }, [])
  // 面の高さの上限と、そもそも開かせてよいかの判断（→ `overlayHeight.ts`）。
  // **寸法の判断はコンポーネントの外に置く** —— ここに書くとテストで押さえられない。
  const commentsMaxHeight = commentsOverlayMaxHeight(panelHeight, bannerHeight)
  // **出す場所が無いときも入口にしない。** パネルを縮めるとバナーだけで埋まり、面は
  // 高さ 0 になる。開くと矢印が ▶→▼ に変わるだけで中身は 1 行も見えず、理由も出ない。
  const canOpenComments = hasCommentsToShow && !isCancelledDisplay && canShowCommentsOverlay(commentsMaxHeight)

  const registerRow = useCallback((area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => {
    const key = area.code ?? area.name ?? ''
    if (el && isChanged) changedRowElsRef.current.set(key, el)
    else changedRowElsRef.current.delete(key)
    if (isTop) topRowElRef.current = el
  }, [])

  // 読み上げ追従の引き当て表（キーの作り方は speechRowKeys）。区域は変更の有無に関わらず全件、
  // 観測点は実測・到達確認の行だけを持つ。
  const speechRowElsRef = useRef<Map<string, HTMLElement>>(new Map())
  const registerSpeechRow = useCallback((keys: string[], el: HTMLElement | null) => {
    for (const key of keys) {
      if (el) speechRowElsRef.current.set(key, el)
      else speechRowElsRef.current.delete(key)
    }
  }, [])

  // 区域キー → その区域が属する**等級カードの頭**（「大津波警報」の帯）。
  //
  // 区域を読んで動くときの行き先をここに揃える。区域行だけを基準にすると、その区域が
  // 画面の上端に来るように送られ、**どの等級の話をしているのかが視野から消える**。カードの頭を
  // 範囲に含めれば上端がそこになり、等級・波高見出し・区域が上から順に収まる。
  const speechAnchorElsRef = useRef<Map<string, HTMLElement>>(new Map())
  const registerSpeechAnchor = useCallback((keys: string[], el: HTMLElement | null) => {
    for (const key of keys) {
      if (el) speechAnchorElsRef.current.set(key, el)
      else speechAnchorElsRef.current.delete(key)
    }
  }, [])

  // 手で動かしたあとは追従を止める。地図の自動フィットと同じ考え方で、同じ保持時間を使う。
  //
  // 拾うのは `wheel` と `touchstart` の 2 つだけ。`scroll` は自分の `scrollTo` が撒くので
  // 使えない（自動と手動を区別する仕組みが別に必要になる）。`pointerdown` も採らない
  // ―― 観測点行のクリックは地図を寄せるための正当な操作で、それで追従が 30 秒止まるのは筋が
  // 違う（地図側のガードも「実際に視点が動いた」`zoomstart`/`dragstart` だけを見ていて
  // クリックは拾わない）。スクロールバーのドラッグとブラウザ内検索は取りこぼす。
  //
  // ref ではなく state で持つのは、保持が明けた瞬間に追従側の effect を起こし直すため
  // （CameraFollowsGL の useUserInteractionGuard と同じ理由）。
  const [userScrollHold, setUserScrollHold] = useState(false)
  // 先頭復帰（`autoShowTick`）からも読む。あちらは保持の明けで動き直してはいけないので
  // （明けた瞬間に画面が飛ぶ）、state を依存に取らず ref で今の値だけを見る。
  const userScrollHoldRef = useRef(false)
  userScrollHoldRef.current = userScrollHold
  const userHoldTimerRef = useRef<number | undefined>(undefined)
  const hasCards = active.length > 0
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onInteract = () => {
      setUserScrollHold(true)
      window.clearTimeout(userHoldTimerRef.current)
      userHoldTimerRef.current = window.setTimeout(() => setUserScrollHold(false), INTERACTION_HOLD_SEC * 1000)
    }
    container.addEventListener('wheel', onInteract, { passive: true })
    container.addEventListener('touchstart', onInteract, { passive: true })
    return () => {
      container.removeEventListener('wheel', onInteract)
      container.removeEventListener('touchstart', onInteract)
    }
  }, [hasCards])
  useEffect(() => () => window.clearTimeout(userHoldTimerRef.current), [])

  /**
   * 追従が最後に「読んでいる箇所を引き当てた」時刻（受信時スクロールが読む）。
   *
   * **真偽値ではなく時刻で持つ。** 真偽値だと読み上げが終わった時点で落ちるため、そのあと
   * 受信時スクロールの猶予が明けたときに「追従は働かなかった」と誤って判断し、読み終えた
   * カードを区域へ寄せ直してしまう。受信（`focusedDistrict.ts`）より後に追従が動いていれば
   * その受信は追従が受け持ったと見なせる。
   */
  const followHandledAtRef = useRef(0)

  // 追従の進み具合。**読み上げ 1 本（`token`）に紐づけて持つ。** 追従の effect は
  // `isVisible` などの変化でも作り直されるため、ここに置かないと途中で記憶が失われる。
  const followProgressRef = useRef<{
    token: number
    lastIndex: number
    /** smooth スクロールの行き先。着くまでは判定の基準をこちらにする */
    targetScrollTop: number | null
    /**
     * 区域・観測点の行を一度でも引き当てられたか（診断用）。
     * **等級は数えない。** 理由は下の `sawRowRef` を立てている箇所のコメント。
     */
    resolvedAny: boolean
    /** 区域・観測点を指すチャンクが一度でもあったか（診断用。無ければ引けなくて当然） */
    sawRowRef: boolean
  } | null>(null)

  /**
   * 読み上げに合わせてカードを送る。
   *
   * 現在位置の解決を rAF で回しているのは、voicevox が渡すのが「予約」（`startAt` は
   * AudioContext の時間軸で未来を指す）だから。チャンクごとに `setTimeout` を張る形にすると、
   * バックグラウンドのタブでタイマーが間引かれる一方で音は実時間で鳴り終わり、滞留した
   * タイマーが後から発火して追従の状態が残る。rAF なら非表示中は止まり、戻ったときに
   * 一発で正しい位置へ収束する。
   */
  useEffect(() => {
    const session = speechSession
    if (!session || !isVisible || userScrollHold) return

    // **進み具合はセッション単位で持つ（effect のローカルにしない）。** この effect は
    // `isVisible` / `userScrollHold` / `bannerHeight` の変化でも作り直される。ローカルに
    // 置くと、読み上げの途中で手を触れたりバナーの高さが変わったりするたびに「一度出した箇所」の
    // 記憶が消え、消したはずの往復スクロールが戻ってくる。
    if (followProgressRef.current?.token !== session.token) {
      followProgressRef.current = {
        token: session.token,
        lastIndex: -1,
        targetScrollTop: null,
        resolvedAny: false,
        sawRowRef: false,
      }
    }
    const progress = followProgressRef.current

    let raf = 0
    let refsPerChunk: SpeechRef[][] | null = null
    let mappedChunks: readonly string[] | null = null

    const lookup = (table: Map<string, HTMLElement>, ref: SpeechRef): HTMLElement | null => {
      for (const key of speechRowKeys(ref)) {
        const el = table.get(key)
        if (el) return el
      }
      return null
    }

    /**
     * 読んでいる箇所そのものが占める要素。
     * 等級はカードの頭、観測点は区域行の内側なので、いずれも 1 つで足りる。
     */
    const rowElementFor = (ref: SpeechRef): HTMLElement | null =>
      lookup(speechRowElsRef.current, ref)

    /**
     * 併せて視野に入れたい前置き。区域では**その等級カードの頭**。
     *
     * 区域行だけを上端に合わせると、どの等級の話をしているのかが視野から消える。ただし
     * これを「読んでいる箇所」に混ぜてはいけない。混ぜると送り先の上端が常にカードの頭に
     * なり、等級のところで一度寄せた後は区域行がどれだけ見切れていても動かなくなる
     * （`planFollowScroll` の JSDoc 参照）。前置きとして別に渡し、収まるときだけ含める。
     */
    const contextElementFor = (ref: SpeechRef): HTMLElement | null =>
      ref.kind === 'area' ? lookup(speechAnchorElsRef.current, ref) : null

    // 差し替えで DOM から外れた要素は矩形が全 0 になる。そのまま使うと巨大なスクロールになる
    const rectsFor = (
      refs: readonly SpeechRef[],
      offset: number,
      pick: (ref: SpeechRef) => HTMLElement | null,
    ): FollowRect[] => {
      const rects: FollowRect[] = []
      for (const ref of refs) {
        const el = pick(ref)
        if (!el || !el.isConnected) continue
        const r = el.getBoundingClientRect()
        if (r.height <= 0) continue
        rects.push({ top: r.top - offset, bottom: r.bottom - offset })
      }
      return rects
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const container = containerRef.current
      if (!container || !session.chunks || session.schedule.length === 0) return

      // チャンクと参照の対応は 1 度だけ求める（チャンク列は読み上げの途中で変わらない）
      if (refsPerChunk === null || mappedChunks !== session.chunks) {
        mappedChunks = session.chunks
        refsPerChunk = mapChunksToRefs(session.segments, session.chunks)
      }

      const now = getSpeechClock()
      if (now === null) return
      // 鳴り始めた予約のうち最後のものが「いま読んでいるチャンク」。schedule は届いた順＝
      // startAt の昇順に積まれる
      let currentIndex = -1
      for (const entry of session.schedule) {
        if (entry.startAt > now) break
        currentIndex = entry.index
      }
      if (currentIndex < 0) return

      // 行き先に着いたら基準を現在位置へ戻す
      if (progress.targetScrollTop !== null
        && Math.abs(container.scrollTop - progress.targetScrollTop) < 2) {
        progress.targetScrollTop = null
      }
      if (currentIndex === progress.lastIndex) return
      progress.lastIndex = currentIndex

      const currentRefs = refsPerChunk[currentIndex] ?? []
      if (currentRefs.length === 0) return

      // **同じ箇所を読み直す文は無い前提に立っている。** 読み上げは区域名を 1 回だけ出す
      // （区域と波高を 1 文で言い切る。→ `ttsText` の `areaHeightSentence`）。かつては
      // 「区域を列挙 → 予想最大波高でもう一周」の形で同じ区域を 2 回読んでいて、2 周目に
      // 付き合うと 1 周目で見せた場所へ戻ってすぐ下がる往復になったため、出した箇所を
      // 記録して追わない仕掛けを置いていた。文面を変えて重複が無くなったので外してある。
      // **読み上げ文を「同じ区域を 2 回読む」形に戻すなら、ここも戻すこと。**

      // これから読む箇所（この先のチャンクを読み上げ順に）
      const upcomingRefs: SpeechRef[] = []
      for (let i = currentIndex + 1; i < refsPerChunk.length; i++) {
        upcomingRefs.push(...refsPerChunk[i])
      }

      const containerRect = container.getBoundingClientRect()
      // 矩形は「行き先」から見た位置に直す。scrollTop が増えると要素は上へ動くので、
      // 進む量ぶん引く（コンテナ自身は動かないので視野はそのまま）。
      const base = progress.targetScrollTop ?? container.scrollTop
      const offset = base - container.scrollTop
      const currentRects = rectsFor(currentRefs, offset, rowElementFor)

      // 診断の集計。**等級（`grade`）は数えない。**
      //
      // 等級のカードは全等級ぶん常に登録されていて、電文の中身に依らず必ず引ける。読み上げ文は
      // 必ず等級の宣言から始まるので、これを成功に数えると `resolvedAny` が毎回 true になり、
      // 続く区域・観測点が 1 件も引けなくても下の警告が出なくなる。区域コードの食い違いを
      // 見つけるために置いた診断が、静かに死ぬ。前置き（カードの頭）を数えないのも同じ理由。
      if (currentRefs.some(r => r.kind !== 'grade')) {
        progress.sawRowRef = true
        if (currentRects.length > 0) progress.resolvedAny = true
      }

      // **行を引き当てられないうちは受け持ったことにしない。** 区域コードや観測点名が
      // 食い違って一度も引けない読み上げでも、無条件に印を立てると受信時スクロール
      // （変更区域へ寄せるフォールバック）まで道連れで止まり、画面が一切動かなくなる。
      if (currentRects.length === 0) return
      followHandledAtRef.current = Date.now()

      const next = planFollowScroll({
        viewTop: containerRect.top + bannerHeight,
        viewBottom: containerRect.bottom,
        currentRects,
        contextRects: rectsFor(currentRefs, offset, contextElementFor),
        upcomingRects: rectsFor(upcomingRefs, offset, rowElementFor),
        currentScrollTop: base,
        maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
      })
      if (next === null) return

      progress.targetScrollTop = next
      container.scrollTo({ top: next, behavior: 'smooth' })
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [speechSession, isVisible, userScrollHold, bannerHeight])

  // 読み上げが終わったところで、追従が仕事をできたかを振り返る。
  //
  // 上の effect のクリーンアップではなく**セッションの終わり**で見るのは、あちらが
  // `isVisible` などの変化でも作り直されるため。作り直しのたびに評価すると、タブを離れた
  // だけで「引き当てられなかった」と言い出す。
  useEffect(() => {
    if (speechSession) return
    const last = followProgressRef.current
    followProgressRef.current = null
    // **区域・観測点を読んだのに、その行を一度も引き当てられなかったときだけ残す。**
    //
    // 読み始めた直後にタブを離れると、追従の rAF が止まって以降のチャンクを見ないため、
    // 引き当ての失敗と区別できずに出ることがある（ログのノイズに留まる既知の限界）。
    // 読み上げは出ているのに画面が動かない状態で、症状（動かない）からは追従の不具合と表示の
    // 不具合を区別できない。区域コード・観測点名の食い違い（`matchesArea` が想定している経路）
    // を疑う手がかり。等級しか読まなかった読み上げでは引けなくて当然なので黙る。
    if (last?.sawRowRef && !last.resolvedAny) {
      log.warn('[tsunami] 読み上げ追従: 区域・観測点の行を一度も引き当てられなかった')
    }
  }, [speechSession])

  // 自動で見せられたときは先頭へ戻す（`autoShowTick` の JSDoc 参照）。
  //
  // **`useLayoutEffect` で行うのは順序のため。** 同じ受信で受信時スクロール（`useEffect`）や
  // 読み上げ追従（rAF）が動くなら、そちらに上書きさせたい。先頭へ戻すのは「他に行き先が
  // 決まらなかったとき」の既定でしかない。
  //
  // 一瞬で移す（`behavior: 'smooth'` にしない）。移動してきた直後で、まだ何も見せていない
  // 場所からの滑走を見せる意味が無いうえ、続く追従のスクロールと重なって二重に動く。
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    // 手で動かした直後は動かさない。他の 2 つの駆動（受信時スクロール・読み上げ追従）も
    // 同じ保持を尊重するので、ここだけ無条件に走ると「触った直後に飛ぶ」のが残る。
    //
    // **保持が明けたときに埋め合わせはしない**（既知の限界）。手でスクロール中に他タブへ移り、
    // 保持が明ける前に自動で連れ戻された場合は、前の位置のまま表示される。埋め合わせるには
    // 保持の明けを待って一度だけ実行する仕掛けが要るが、それは「何もしていないのに画面が飛ぶ」
    // という、この保持で防いでいるものを作り直すことになる。触った位置を残す方を採る。
    if (userScrollHoldRef.current) return
    container.scrollTop = 0
    // 追従が持っている「行き先」も捨てる。残すと、この先頭復帰を追従が知らないまま
    // 矩形を補正し、まだ動く前の位置を基準に判定してしまう。
    const progress = followProgressRef.current
    if (progress) progress.targetScrollTop = null
  }, [autoShowTick])

  // 変更区域が画面に収まるならまとめて見えるように、収まらなければ波高最大の区域が
  // ヘッダー直下に来るようにスクロールする（読み上げが無効な端末の唯一の自動スクロール）
  useEffect(() => {
    if (!focusedDistrict) return
    const container = containerRef.current
    if (!container) return

    const run = () => {
      // この受信より後に追従が動いていれば、その受信は追従が受け持ったと見なして見送る。
      // **読み上げは数十秒続く**ため、その最中にここが動くと、いま読んでいる箇所から引き剥がした
      // うえで次のチャンクで追従が引き戻す。
      if (followHandledAtRef.current >= focusedDistrict.ts) return
      // 寄せ先が無い受信。先頭へ戻すかどうかは要求側が決める（→ `FocusedDistrict.resetToTop`）。
      // **寄せ先が無いことを理由に動かさない** —— 満潮時刻の報や沖合の観測情報が、直前の報や
      // 読み上げが合わせた位置を捨てていた。
      if (focusedDistrict.districts.length === 0) {
        if (focusedDistrict.resetToTop) container.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      const changedEls = Array.from(changedRowElsRef.current.values())
      if (changedEls.length === 0) return

      const containerRect = container.getBoundingClientRect()
      const viewTop = containerRect.top + bannerHeight
      const viewBottom = containerRect.bottom
      const availableHeight = viewBottom - viewTop

      const tops = changedEls.map(el => el.getBoundingClientRect().top)
      const bottoms = changedEls.map(el => el.getBoundingClientRect().bottom)
      const spanTop = Math.min(...tops)
      const spanBottom = Math.max(...bottoms)
      const spanHeight = spanBottom - spanTop

      let delta = 0
      if (spanHeight <= availableHeight) {
        if (spanTop < viewTop) delta = spanTop - viewTop
        else if (spanBottom > viewBottom) delta = spanBottom - viewBottom
      } else if (topRowElRef.current) {
        delta = topRowElRef.current.getBoundingClientRect().top - viewTop
      }

      if (Math.abs(delta) > 1) {
        container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' })
      }
    }

    // **寄せる先がある受信だけ、追従が受け持つのを待つ。** 電文が届いた瞬間に変更区域へ寄せても、
    // 0.8〜2.8 秒後（通知音との間隔）に読み上げが始まって等級カードの頭へ引き戻すことになり、
    // 逆向きの動きが見える。声と画面を一致させる側に任せる。
    //
    // **寄せ先が無い受信（`districts` が空）は待たない。** 理由は先頭へ戻す側の 3 つで違う。
    //
    // - **解除**: 追従の対象になる読み上げを持たない（解除の読み上げは区域名を含まない
    //   ので参照が無い）。待たせても追従は永久に来ず、猶予のあいだ解除前の位置に留まるだけ。
    //   **解除で待たされるのが一番まずい。**
    // - **新規発報・等級の変わった報**: こちらは区域名を含む読み上げを持つので追従も来る。
    //   ただし等級が変わるのは最上位の区域群が入れ替わったときで、カードは重い等級を先頭へ
    //   積むため、**即時の先頭戻しと追従の着地点がほぼ一致する**（先に戻しても往復にならない）。
    //   この一致は「変化した区域が必ず先頭グループへ来る」ことに依っているので、並べ方を
    //   変えるときは待たせる側へ回すかを見直すこと。
    //
    // 戻さない側（`resetToTop` が false）は `run()` が何もしないので、待つかどうかで
    // 結果が変わらない。
    //
    // 待つ場合も**待ちっぱなしにはしない。** 「有効」は端末の設定値にすぎず、その電文で実際に
    // 読み上げが成立するかは別（VOICEVOX が未起動・到達不能でも `speakWithVoicevox` は無音の
    // まま正常終了する契約）。待って何も起きなければ、ここが唯一の自動スクロールになる。
    if (speechFollowEnabled && focusedDistrict.districts.length > 0) {
      const timer = window.setTimeout(run, SPEECH_FOLLOW_GRACE_MS)
      return () => window.clearTimeout(timer)
    }
    run()
  // focusedDistrict.ts を依存にすることで同一区域の再フォーカスも発火する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedDistrict?.ts, bannerHeight, speechFollowEnabled])

  if (active.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-4">
        <div className="text-center">
          <p className="text-green-400 font-bold">津波情報はありません</p>
          <p className="text-secondary text-sm mt-1">現在、津波警報・注意報は発表されていません。</p>
        </div>
      </div>
    )
  }

  const topGrade = getTopGrade(active)
  const topStyle = getGradeStyle(topGrade)
  const cancelInfo = CANCEL_REASON_LABEL[active[0]?.cancelReason ?? 'lifted']
  const latestTime = active[0]?.time
  // 観測状況を確定した時刻（`Head/TargetDateTime`）。**発表時刻と同じ分なら出さない** ——
  // 同じ数字が 2 つ並ぶだけで、「観測値は発表より前の時点のもの」という肝心の意味が薄れる。
  // 実電文では VTSE52 で 60〜360 秒・VTSE51 で 0〜120 秒さかのぼり、0 秒の報も普通にある。
  //
  // **発表時刻が日時として読めないときは、比べずに出す。** そのときは発表時刻の欄（下の
  // 「◯◯ 更新」）自体が出ないため、同じ数字が 2 つ並ぶ心配がない。
  const observationAsOfRaw = active[0]?.observationDateTime
  const observationAsOfHm = observationAsOfRaw ? formatTimeMin(observationAsOfRaw) : undefined
  const latestHm = latestTime ? formatTimeMin(latestTime) : undefined
  const observationAsOf = observationAsOfHm && observationAsOfHm !== latestHm ? observationAsOfHm : undefined
  const latestUpdatedText = latestTime ? formatDateTimeMin(latestTime) : null
  // 1 件目を主に扱い、残りは下に併記する（電文は複数の地震を持ちうる）。
  const sourceEarthquakes = active[0]?.sourceEarthquakes ?? []
  const sourceEarthquake = sourceEarthquakes[0]


  // 津波の原因地震に対応する地震カードを eventId で照合する
  const tsunamiEventId = active[0]?.eventId
  const linkedQuake = (tsunamiEventId && earthquakes)
    ? earthquakes.find(q => q.eventId === tsunamiEventId && !q.cancelledAt)
    : undefined

  // h-full を持つ下記の要素自身がスクロール領域になるため、横スクロールの抑止は
  // App.tsx の TAB_SCROLLER_CLASS ではなくここで行う（祖先の指定は子に効かない）。
  return (
    <div ref={setContainerRef} className="h-full overflow-y-auto overflow-x-hidden overscroll-x-none">
      {/* 発令中 / 解除バナー（sticky で常時表示）。対応する地震カードがある場合のみクリック可能。 */}
      <div ref={bannerRef} className="sticky top-0 z-10 px-3 pt-3 relative">
        <div
          role={linkedQuake ? 'button' : undefined}
          tabIndex={linkedQuake ? 0 : undefined}
          onClick={linkedQuake ? () => onEarthquakeLink?.(quakeEventKey(linkedQuake)) : undefined}
          onKeyDown={linkedQuake ? (e) => { if (e.key === 'Enter' || e.key === ' ') onEarthquakeLink?.(quakeEventKey(linkedQuake)) } : undefined}
          className={`rounded-lg overflow-hidden${linkedQuake ? ' cursor-pointer hover:opacity-90 transition-opacity' : ''}`}
          style={{ background: isCancelledDisplay ? '#1a1a1a' : topStyle.headerBg, border: `2px solid ${isCancelledDisplay ? '#4b5563' : topStyle.cardBorder}` }}>
          <div className="px-3 py-2 roomy:px-4 roomy:py-3"
            style={{ background: isCancelledDisplay ? 'rgba(75,85,99,0.18)' : `${topStyle.cardBorder}18` }}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold flex items-center gap-2" style={{ fontSize: '0.875rem', color: isCancelledDisplay ? '#9ca3af' : topStyle.headerColor }}>
                {isCancelledDisplay ? cancelInfo.title : `${GRADE_LABEL[topGrade]} 発令中`}
                {/* 電文が自分で名乗っている運用種別（`Control/Status`）。訓練・試験のときだけ出す。
                    印が無いと、訓練の大津波警報が本物と同じ顔で出る。 */}
                {active[0]?.operationStatus && (
                  <span
                    className="px-1.5 py-0.5 rounded flex-shrink-0"
                    style={{ fontSize: '0.6875rem', backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}
                  >
                    {active[0].operationStatus}報
                  </span>
                )}
              </div>
              {(latestUpdatedText || observationAsOf) && (
                <div className="text-right flex-shrink-0" style={{ fontSize: '0.6875rem', color: isCancelledDisplay ? '#6b7280' : topStyle.arrivalColor, opacity: 0.8 }}>
                  {/* 発表時刻が日時として読めなければこの行だけ落とす。観測時点の行は残す —— 2 つは
                      別の事実で、片方が読めないことをもう片方を隠す理由にしない。 */}
                  {latestUpdatedText && <div>{latestUpdatedText} 更新</div>}
                  {/* 観測状況を確定した時刻（電文の `Head/TargetDateTime`）。観測情報でのみ入り、
                      実電文では最大 6 分さかのぼる。**下の波高がいつ時点のものか**を示す。

                      **発表時刻と同じ分なら出さない。** 同じ数字が 2 つ並ぶだけで、
                      「観測値が発表より前の時点のもの」という肝心の意味が薄れる。 */}
                  {observationAsOf && (
                    <div style={{ opacity: 0.85 }}>観測 {observationAsOf} 時点</div>
                  )}
                </div>
              )}
            </div>
            {/* 行動指示の行。**気象庁の避難行動の付加文があればそれを出す**（無ければアプリの文）。
                ここはこれまでアプリが書いた文だけを出していたが、公式の文があるならそちらが正しい
                （→ CLAUDE.md「利用者へ出す語を気象庁の表現と揃える」）。採れる条件は
                `evacuationActionLine`。

                **この行が付加文への入口を兼ねる。** バナーは sticky なので、行を足すとその分だけ
                区域一覧の居場所が減る —— バナーは既にパネルの半分以上を使っている（実測値は
                docs/spec/tsunami-spec.md §9）。だから増やさず、既にある行に役目を持たせる。

                **操作要素が入れ子になる**（外側のバナーも地震カードへ移動できる）。支援技術には
                正しく伝わらないが、外へ出すと上の行数の問題に戻る。既知の限界として仕様書 §9 に
                記してある。地震カードの震度一覧も同じ制約を抱えている。 */}
            <div
              className={`mt-1 flex items-start gap-1.5${canOpenComments ? ' cursor-pointer' : ''}`}
              role={canOpenComments ? 'button' : undefined}
              tabIndex={canOpenComments ? 0 : undefined}
              aria-expanded={canOpenComments ? commentsOpen : undefined}
              // **バナー自身のクリック（地震カードへの移動）へ伝播させない。**
              onClick={canOpenComments ? e => { e.stopPropagation(); setCommentsOpen(!commentsOpen) } : undefined}
              onKeyDown={canOpenComments ? e => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault(); e.stopPropagation(); setCommentsOpen(!commentsOpen)
              } : undefined}
              style={{ fontSize: '0.6875rem', color: isCancelledDisplay ? '#6b7280' : topStyle.headerColor, opacity: 0.8 }}>
              <span className="flex-1">
                {isCancelledDisplay ? cancelInfo.desc
                  : bannerActionLine ?? (topGrade === 'Forecast' ? '若干の海面変動があるかもしれません' : '海岸・河川から直ちに離れてください')}
              </span>
              {canOpenComments && <span className="flex-shrink-0" style={{ fontSize: '0.625rem', opacity: 0.8 }}>{commentsOpen ? '▼' : '▶'}</span>}
            </div>
            {/* 電文が名乗る情報名（`Head/Title`）。**上の等級表示とは別物** —— あちらはアプリが
                区域の等級から組み立てた見出しで、こちらは気象庁がその報に付けた名前。
                同じ VTSE51 が「津波観測に関する情報」と「各地の満潮時刻・津波到達予想時刻に
                関する情報」を名乗り分けるので、**種別コードだけでは今どちらを見ているか分からない。**
                行動指示より下に、目立たせずに置く。 */}
            {active[0]?.infoName && (
              <div className="mt-0.5" style={{ fontSize: '0.625rem', color: isCancelledDisplay ? '#6b7280' : topStyle.headerColor, opacity: 0.6 }}>
                {active[0].infoName}
              </div>
            )}
            {/* 気象庁が書いた取消しの概要（電文の `Body/Text`）。アプリの定型文（上の `cancelInfo.desc`）
                とは別で、なぜ取り消したのかはここにしか無い。 */}
            {isCancelledDisplay && active[0]?.cancelText && (
              <div className="mt-1" style={{ fontSize: '0.6875rem', color: '#9ca3af', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                {active[0].cancelText}
              </div>
            )}
            {!isCancelledDisplay && sourceEarthquake && (
              <div className="mt-1.5 pt-1.5" style={{ fontSize: '0.6875rem', color: topStyle.arrivalColor, opacity: 0.9, borderTop: `1px solid ${topStyle.cardBorder}40` }}>
                {/* 短い間に複数の地震が起きると、1 つの津波情報にまとめて発表される。
                    2 件目以降を落とすと、どの地震による津波なのかが読み取れなくなる。
                    **1 件目と 2 件目以降で別々に書かない** —— 項目を足したとき片方に漏れる
                    （実際、震央補助表現と震源決定機関を 1 件目にだけ足して 2 件目で落としていた）。 */}
                {sourceEarthquakes.map((eq, i) => (
                  <SourceEarthquakeLine
                    key={i}
                    eq={eq}
                    prefix={i === 0 ? '震源: ' : ''}
                    link={i === 0 && linkedQuake
                      ? <span style={{ marginLeft: '0.375rem', fontSize: '0.625rem', opacity: 0.7 }}>▶ 地震情報</span>
                      : null}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        {/* 開いた付加文。**バナーの下へ重ねる（流し込まない）。**
            流し込むとバナーが伸びて、後ろの区域一覧が押し下がる —— 読むつもりで開いただけで
            見ていた場所が動いてしまう。重ねればバナーの高さは変わらず、後ろは動かない。
            パネルからはみ出さないよう高さに上限を置き、超えた分はこの中でスクロールさせる。 */}
        {/* 出す条件は入口と同じ述語にする。別々にすると、中身が空になったときに
            枠だけ残り、しかも入口が死んでいて閉じられない形ができる。 */}
        {commentsOpen && canOpenComments && (
          <div
            className="absolute left-3 right-3 z-20 rounded-b-lg overflow-y-auto overscroll-contain px-3 pb-3 pt-1.5 roomy:px-4"
            style={{
              top: '100%',
              marginTop: '-0.5rem',
              background: isCancelledDisplay ? '#1a1a1a' : topStyle.headerBg,
              border: `2px solid ${topStyle.cardBorder}`,
              borderTop: 'none',
              maxHeight: commentsMaxHeight,
              boxShadow: '0 8px 16px rgba(0,0,0,0.45)',
            }}>
            <TsunamiCommentBody
              bodyText={bannerBodyText}
              comments={bannerComments}
              freeText={bannerFreeText}
              borderColor={`${topStyle.cardBorder}40`}
              textColor={topStyle.headerColor}
            />
          </div>
        )}
      </div>

      <div className="p-2 flex flex-col gap-2 roomy:p-3 roomy:gap-3">
      {active.map(t => {
        const observations = t.observations ?? []
        const unmatched = observations.filter(o => !t.areas.some(a => matchesArea(o, a)))
        return (
          <div key={t.id} className="flex flex-col gap-3 relative">
            {t.cancelledAt && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg" style={{ minHeight: '5rem' }}>
                <span className="font-black text-white" style={{ fontSize: '2.5rem', lineHeight: 1.1 }}>{cancelInfo.badge}</span>
                <span className="text-sm font-bold text-white/90 mt-1">{cancelInfo.desc}</span>
              </div>
            )}
            {GRADE_ORDER.map(grade => (
              <TsunamiGradeCard
                canFocusObs={canFocusObs}
                onAreaFocus={onAreaFocus}
                key={grade}
                grade={grade}
                areas={t.areas.filter(a => a.grade === grade)}
                observations={observations}
                onObservationClick={onObservationClick}
                focusedDistrict={focusedDistrict}
                registerRow={registerRow}
                registerSpeechRow={registerSpeechRow}
                registerSpeechAnchor={registerSpeechAnchor}
                obsUpdateStatus={obsUpdateStatus}
                areaGradeChangedKeys={areaGradeChangedKeys}
              />
            ))}
            {/* この報で解除された区域。等級カードの後ろ＝いちばん軽い遷移先として置く
                （読み上げも引き下げの組の最後に読む）。

                **並びは読み上げが作る組をそのまま使う。** ここで `describableCancelledAreas` を
                独自に並べ替えると、**前回の等級が違う区域が同時に解除された報**で声と画面が
                食い違う —— 読み上げは `(遷移元, 遷移先)` の組ごとに分けて遷移元の重い順に読むが、
                こちらは全部を 1 つのリストとして扱うので電文順のまま残る。追従スクロールが
                解除カードの中を往復することになり、この機能が直そうとしたのと同じ症状になる。 */}
            <TsunamiCancelledCard
              areas={tsunamiAreaGradeChanges(t, observations)
                .filter(c => c.to === TSUNAMI_GRADE_LIFTED).flatMap(c => c.areas)}
              focusedDistrict={focusedDistrict}
              registerRow={registerRow}
              registerSpeechRow={registerSpeechRow}
              registerSpeechAnchor={registerSpeechAnchor}
            />
            {(unmatched.length > 0 || (t.estimations?.length ?? 0) > 0) && (
              <div className="bg-card rounded-lg overflow-hidden"
                style={{ border: '2px solid #1d4ed8', boxShadow: '0 0 0 1px rgba(29,78,216,0.25)' }}>
                {/* 実測が 1 件も無く推定だけが届く電文もあるので、見出しは中身に合わせる。 */}
                {unmatched.length > 0 && (
                  <div className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
                    style={{ backgroundColor: '#0c1a3a', color: '#93c5fd', borderBottom: '1px solid #1d4ed8' }}>
                    沖合観測
                  </div>
                )}
                {unmatched.map((obs, i) => (
                  <TsunamiObservationRow key={i} obs={obs} onObservationClick={onObservationClick} canFocusObs={canFocusObs} registerSpeechRow={registerSpeechRow} />
                ))}
                {/* 沖合の観測から導いた沿岸への推定。実測とは別のものなので実測の下に区切って
                    並べる。**推定したのは気象庁で、アプリ側の計算ではない**ことを見出しに書く。 */}
                {t.estimations && t.estimations.length > 0 && (
                  <>
                    <div className="w-full py-1 px-4 text-center"
                      style={{ backgroundColor: 'rgba(12,26,58,0.6)', color: '#93c5fd', fontSize: '0.6875rem', ...(unmatched.length > 0 && { borderTop: '1px solid #1d4ed8' }) }}>
                      沿岸への推定（気象庁発表）
                    </div>
                    {t.estimations.map((est, i) => (
                      <div key={i} className="px-4 py-1.5 border-b border-white/5 last:border-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 flex-wrap min-w-0">
                            <span className="text-white text-[0.9375rem] truncate">{est.name}</span>
                            {estimationBadges(est).map(label => (
                              <span key={label} className="text-xs font-bold px-1.5 py-0.5 rounded"
                                style={{ background: 'rgba(29,78,216,0.3)', color: '#93c5fd' }}>
                                {label}
                              </span>
                            ))}
                          </span>
                          <span className="flex-shrink-0 text-right" style={{ fontSize: '0.8125rem', color: '#93c5fd' }}>
                            {/* 数値が無ければ、無い理由（電文の「推定中」）を出す。 */}
                            {estimationHeightText(est) && <span className="font-bold">{estimationHeightText(est)}</span>}
                            {/* 日時として読めない時刻は句ごと落とす（「到達予想」だけが残ると、
                                いつ来るのかを述べているように見える）。到達についての説明は
                                すぐ下に別の行として出るので、情報が全部消えるわけではない。 */}
                            {(() => {
                              const hm = est.arrivalTime ? formatTimeMin(est.arrivalTime) : null
                              return hm ? <span className="ml-2">{hm}到達予想</span> : null
                            })()}
                          </span>
                        </div>
                        {/* 到達についての説明は時刻と併存する（電文解説資料 Ⅱ.13 1-2-2-2 の事例１）。
                            時刻があるときに隠すと、時刻を出せる沿岸ほど注意喚起が落ちる。 */}
                        {est.arrivalCondition && (
                          <div className="mt-0.5" style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>{est.arrivalCondition}</div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
      </div>
    </div>
  )
})
