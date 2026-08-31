import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import type { MapMode } from '../components/Map/mapTypes'
import { computeSingleEEWLevel, eewKindLabel, eewMaxScale, eewMaxScaleInfo } from './eew'
import { formatDateTime, formatDepth, formatMagnitude, formatTsunamiGrade, hasDepth, hasMagnitude } from './formatters'
import { getIntensityColor, getIntensityLabel, getIntensityLabelWithOrAbove, isValidIntensityScale } from './intensity'
import { ATTRIBUTION_SOURCES, attributionLine, EEW_NOTICE, type ShareCardHeader } from './shareCard'
import { tsunamiOverallGrade } from './tsunami'

// 共有カードの見出しと出典行を、いま地図が見せているものから組み立てる。
//
// 画面の状態に触れない純粋な関数として置いてある。撮影（captureMap.ts）と合成（shareCard.ts）は
// 地図とキャンバスに依存するが、「何を書くか」の判断はそのどちらにも依存しないため。

/** 見出しの各項目を並べるときの区切り。全角の空きで、読点より軽く見せる。 */
const SUBTITLE_SEPARATOR = '　'

export interface ShareCardContentInput {
  mode: MapMode
  quake: JMAQuake | null
  tsunamis: JMATsunami[]
  eews: EEWAlert[]
  /**
   * 地図に描いているか（設定の値をそのまま渡す）。
   * **描いているものだけを出典に挙げる**ため、表示の設定が出典の中身を決める。
   * **表示を切り替えられるレイヤーを足したら、ここへも足すこと。**
   */
  showBathymetry: boolean
  showActiveFaults: boolean
  showPlateBoundaries: boolean
}

export interface ShareCardContent {
  header: ShareCardHeader
  notices: string[]
  /** 共有先へ画像と一緒に渡す本文。 */
  shareText: string
  /** 保存名に使う語。日本語のファイル名を扱えない環境があるので ASCII に限る。 */
  filenameLabel: string
}

/**
 * 見出し・出典行を組み立てる。
 *
 * 注意文の要否は**モードで決めない**。緊急地震速報の予報円と震源は、地図のモードに関わらず
 * 描かれる（`JapanMapGL` の `PsWaveGL` / `EewEpicentersGL` はどのモードでも表示する）。
 * 「地震モードだから緊急地震速報は写らない」は成り立たないため、発報中かどうかで判断する。
 */
export function buildShareCardContent(
  {
    mode,
    quake,
    tsunamis,
    eews,
    showBathymetry,
    showActiveFaults,
    showPlateBoundaries,
  }: ShareCardContentInput,
  appUrl: string,
): ShareCardContent {
  const liveEews = eews.filter((e) => !e.cancelled && !e.expired)
  // **描いていないものを出典に挙げない**——読み手が画像の中に探しても見つからない。逆に
  // 描いているのに挙げないのは帰属表示の欠落になる。判定は表示の設定とモードの両方を見る。
  //
  // 気象庁のデータ（境界線・区域・電文）はどのモードでも必ず写るので条件を持たない。
  const derived: string[] = [ATTRIBUTION_SOURCES.jma]
  const asIs: string[] = []
  if (showBathymetry) asIs.push(ATTRIBUTION_SOURCES.bathymetry)
  // 活断層とプレート境界は地震／リアルタイム震度モードでのみ描かれる（`JapanMapGL` の
  // `showOverlayLines`）。設定が入りでも津波モードの画像には写らない。
  const showsOverlayLines = mode === 'quake' || mode === 'kyoshin'
  if (showsOverlayLines && showActiveFaults) derived.push(ATTRIBUTION_SOURCES.activeFaults)
  if (showsOverlayLines && showPlateBoundaries) derived.push(ATTRIBUTION_SOURCES.plateBoundaries)
  const notices = [attributionLine({ derived, asIs })]
  if (liveEews.length > 0) notices.unshift(EEW_NOTICE)

  const base =
    mode === 'tsunami' ? tsunamiContent(tsunamis) : mode === 'kyoshin' ? kyoshinContent(liveEews) : quakeContent(quake)
  return { ...base, notices, shareText: buildShareText(base.header, appUrl) }
}

/**
 * 共有先の本文を組み立てる。**材料は見出しと同じ**——画像と本文で違うことを述べないため。
 *
 * **注意文は入れない。** 緊急地震速報の注意文（EEW_NOTICE）は画像へ焼いてあり、本文と画像は
 * 共有シートで一緒に渡る。本文にも重ねると X の全角 140 字にほぼ届き、震源名が長ければ超える
 * ——利用者が削ることになり、削られた結果として注意文そのものが落ちうる。
 */
function buildShareText(header: ShareCardHeader, appUrl: string): string {
  const lines = [[header.title, header.subtitle].filter(Boolean).join(SUBTITLE_SEPARATOR)]
  if (header.meta) lines.push(header.meta)
  lines.push(appUrl)
  return lines.join('\n')
}

type ContentWithoutNotices = Omit<ShareCardContent, 'notices' | 'shareText'>

function quakeContent(quake: JMAQuake | null): ContentWithoutNotices {
  if (!quake) return { header: { title: '地震情報' }, filenameLabel: 'quake' }
  const { hypocenter, maxScale, time } = quake.earthquake
  // 震度を伝えない電文（震源情報など）は maxScale がセンチネル（-1）で届く。
  // 「最大震度 不明」と書くくらいなら見出しを種別名に落とす。
  const knownScale = isValidIntensityScale(maxScale) && maxScale >= 0
  // 規模・深さは不明のことがある。「不明」の語を並べても伝わらないので、項目ごと落とす。
  const parts = [hypocenter.name]
  if (hasMagnitude(hypocenter.magnitude)) parts.push(formatMagnitude(hypocenter.magnitude))
  if (hasDepth(hypocenter.depth)) parts.push(`深さ ${formatDepth(hypocenter.depth)}`)
  return {
    header: {
      title: knownScale ? `最大震度 ${getIntensityLabel(maxScale)}` : '地震情報',
      titleColor: knownScale ? getIntensityColor(maxScale) : undefined,
      subtitle: parts.join(SUBTITLE_SEPARATOR),
      meta: `${formatDateTime(time)} 発生`,
    },
    filenameLabel: 'quake',
  }
}

function tsunamiContent(tsunamis: JMATsunami[]): ContentWithoutNotices {
  const live = tsunamis.filter((t) => !t.cancelled)
  const grade = tsunamiOverallGrade(live)
  if (!grade) return { header: { title: '津波情報' }, filenameLabel: 'tsunami' }
  const { text, color } = formatTsunamiGrade(grade)
  const areaCount = new Set(live.flatMap((t) => t.areas.map((a) => a.name))).size
  const source = live.find((t) => t.sourceEarthquake)?.sourceEarthquake
  const parts: string[] = []
  if (source) {
    parts.push(source.magnitude != null ? `${source.hypocenterName}　M${source.magnitude.toFixed(1)}` : source.hypocenterName)
  }
  if (areaCount > 0) parts.push(`${areaCount} 区域`)
  const issued = live[0]?.issue.time ?? live[0]?.time
  return {
    header: {
      title: text,
      titleColor: color,
      subtitle: parts.join(SUBTITLE_SEPARATOR),
      meta: issued ? `${formatDateTime(issued)} 発表` : undefined,
    },
    filenameLabel: 'tsunami',
  }
}

function kyoshinContent(liveEews: EEWAlert[]): ContentWithoutNotices {
  const eew = pickMostSevereEew(liveEews)
  if (!eew) return { header: { title: 'リアルタイム震度' }, filenameLabel: 'realtime' }
  const info = eewMaxScaleInfo(eew)
  const knownScale = isValidIntensityScale(info.scale) && info.scale >= 0
  const { hypocenter } = eew.earthquake
  // **仮定震源要素（単独観測点処理・震源未確定）の報では規模を出さない。** 電文には数値が
  // 入っているが、それは地震学的に意味を持たない仮の値。画面では隠している（`RealtimeTab`）ので、
  // 画像にも焼かない——共有された画像は後から訂正できない。
  // **`condition` を参照する箇所は eew-spec.md §5 に列挙する決まり。足したらそちらも更新すること。**
  const assumedHypocenter = eew.earthquake.condition === '仮定震源要素'
  const parts = [hypocenter.name]
  if (!assumedHypocenter && hasMagnitude(hypocenter.magnitude)) parts.push(formatMagnitude(hypocenter.magnitude))
  if (knownScale) parts.push(`予想最大震度 ${getIntensityLabelWithOrAbove(info.scale, info.orAbove)}`)
  const serial = eew.issue?.serial
  return {
    header: {
      title: eewKindLabel(computeSingleEEWLevel(eew)),
      titleColor: knownScale ? getIntensityColor(info.scale) : undefined,
      subtitle: parts.join(SUBTITLE_SEPARATOR),
      meta: `${serial ? `第${serial}報　` : ''}${formatDateTime(eew.earthquake.originTime)} 発生`,
    },
    filenameLabel: 'eew',
  }
}

/**
 * 複数発報しているときに見出しへ載せる 1 件を選ぶ。
 *
 * **受け取った順で先頭を採らないこと。** 並びは発報を受けた順で深刻さとは無関係なので、
 * 連続する余震や離れた 2 地域でほぼ同時に起きた場合に、弱い方を見出しにしてしまう。
 * 区分（警報級か）を先に見て、同じなら予想最大震度で決める。
 */
function pickMostSevereEew(eews: EEWAlert[]): EEWAlert | null {
  let best: { eew: EEWAlert; level: number; scale: number } | null = null
  for (const eew of eews) {
    const level = computeSingleEEWLevel(eew)
    const scale = eewMaxScale(eew)
    if (!best || level > best.level || (level === best.level && scale > best.scale)) best = { eew, level, scale }
  }
  return best?.eew ?? null
}
