import type { CorrectType, DomesticTsunami, Hypocenter, IssueType, TsunamiGrade } from '../types/earthquake'

export function formatDateTime(isoString: string): string {
  const date = new Date(isoString)
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}/${M}/${d} ${h}:${m}:${s}`
}

export function formatDateTimeMin(isoString: string): string {
  const date = new Date(isoString)
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${y}/${M}/${d} ${h}:${m}`
}

/**
 * 地震の発生時刻。元データに秒が含まれないため、秒を出さず「ごろ」を付ける。
 * 例: 6月6日 8:47ごろ
 */
export function formatQuakeTime(isoString: string): string {
  const date = new Date(isoString)
  const M = date.getMonth() + 1
  const d = date.getDate()
  const h = date.getHours()
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${M}月${d}日 ${h}:${m}ごろ`
}

export function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/** datetime-local input 用のローカル時刻文字列（YYYY-MM-DDTHH:mm）を返す。 */
export function formatDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 深さが判明しているか。パーサは深さ不明の電文（遠地地震で頻出）を -1 センチネルで渡すため、
 * 表示・読み上げはいずれもこの判定で「不明」を弾く。`0` は「ごく浅い」という有効値。
 */
export function hasDepth(depth: number): boolean {
  return Number.isFinite(depth) && depth >= 0
}

export function formatDepth(depth: number): string {
  if (!hasDepth(depth)) return '不明'
  if (depth === 0) return 'ごく浅い'
  return `${depth}km`
}

/**
 * 規模が有効値か。パーサは規模不明の電文を NaN（DMDATA 経路）または -1（P2PQuake 経路）で
 * 渡してくるため、表示・読み上げ・タイトルはいずれもこの判定で「不明」を弾く。
 */
export function hasMagnitude(magnitude: number): boolean {
  return Number.isFinite(magnitude) && magnitude >= 0
}

export function formatMagnitude(magnitude: number): string {
  if (!hasMagnitude(magnitude)) return '不明'
  return `M${magnitude.toFixed(1)}`
}

/**
 * 規模の説明（`Hypocenter.magnitudeCondition` ＝ `jmx_eb:Magnitude@description`）を表示用に直す。
 *
 * **「不明」で潰さない。** 電文は「Ｍ不明」と「Ｍ８を超える巨大地震」をどちらも数値なし・
 * `@condition="不明"` で送ってくるが、後者は M8 を超えて速報できないという別の事実で、
 * 最も伝えるべき場面に出る。
 *
 * 原文は全角なので、数字と記号だけ半角へ揃える（同じ欄に並ぶ数値表示が半角のため）。
 */
export function formatMagnitudeCondition(condition: string): string {
  return condition
    .replace(/^Ｍ/, 'M')
    .replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
}

/**
 * 「マグニチュード」の見出しを別に出している欄（地震カードの詳細表示）で、値として出す文字列。
 * 見出しと重ならないよう説明の先頭の「M」を落とす。説明が無ければ従来どおり「不明」。
 */
export function formatMagnitudeValue(magnitude: number, condition?: string): string {
  if (hasMagnitude(magnitude)) return magnitude.toFixed(1)
  if (!condition) return '不明'
  return formatMagnitudeCondition(condition).replace(/^M/, '')
}

/**
 * {@link formatMagnitude} の、説明を落とさない版。見出しに「M」を持たない欄で使う。
 *
 * **規模を出す箇所はすべてこれを通すこと。** 呼び出し側ごとに `hasMagnitude` の分岐を書くと、
 * 経路を 1 つ足すたびに漏れる —— 実際、説明を読むようにした最初の版では、地震カードの
 * 詳細表示・共有カード・ウィンドウタイトル・読み上げだけを直し、**一覧の行・ブラウザ通知・
 * 地図の震源ポップアップが「不明」のまま残った**（一覧の行は表示時間の大半を占める）。
 *
 * 説明を持たない経路（P2PQuake・EEW・長期震源カタログ）では従来どおり「不明」を返す。
 */
export function formatMagnitudeWithCondition(magnitude: number, condition?: string): string {
  if (hasMagnitude(magnitude)) return formatMagnitude(magnitude)
  return condition ? formatMagnitudeCondition(condition) : '不明'
}

/**
 * 震源の規模か深さのどちらかが判っているか。**位置とは別に判定する。**
 *
 * 「位置は判らないが規模は判っている」電文がある（震源要素不明。→ quake-spec.md §5）。
 * 位置と一緒くたに伏せると、震源を決められないほど異常な地震で最も重要な数値が画面から消える。
 * 共有カード・ブラウザ通知は元からそれぞれ独立に判定していて、カードだけが取り残されていた。
 *
 * 震源要素をまったく持たない電文（震度速報）では 3 つとも偽になり、欄ごと出ない。
 */
export function hasHypocenterFacts(hypocenter: Hypocenter): boolean {
  return hasMagnitude(hypocenter.magnitude)
    || !!hypocenter.magnitudeCondition
    || hasDepth(hypocenter.depth)
}

/**
 * 震源の緯度・経度を気象庁の表記で書く。
 *
 * **南半球・西半球を「北緯 -35.8°」と書かない。** 遠地地震は世界中で起きるため負の値が来る。
 * 気象庁の電文も向きを語で書く（電文解説資料の事例「南緯１７．２度　東経１７８．６度」）。
 *
 * @param digits 小数点以下の桁数。震源要素は 0.1 度刻み、長期震源カタログはより細かい
 */
export function formatCoordinate(latitude: number, longitude: number, digits = 1): string {
  // 深さ・規模と同じく、読めない値はこの関数の中で弾く。呼び出し側のガードだけに任せると、
  // ガードを持たない経路が足された日に「NaN°」が無警告で画面へ出る（`Infinity < 0` は偽なので
  // 向きの語まで誤る）。
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '不明'
  const ns = latitude < 0 ? '南緯' : '北緯'
  const ew = longitude < 0 ? '西経' : '東経'
  return `${ns} ${Math.abs(latitude).toFixed(digits)}° ${ew} ${Math.abs(longitude).toFixed(digits)}°`
}

/**
 * 「津波警報等」に添える説明。**気象庁自身が固定付加文の中で同じ補い方をしている**
 * （「津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中です。」）。
 *
 * 語だけでは何がどこまで含まれるのか分からないため、バッジの `title` として添える。
 */
export const TSUNAMI_WARNING_GROUP_TITLE = '大津波警報・津波警報あるいは津波注意報のいずれかが発表されています'

/**
 * 国内への津波の影響区分を、画面に出す語と色にする。
 *
 * **「警報等」を「津波警報」と書かないこと。** この区分は電文でも P2PQuake でも
 * **大津波警報・津波警報・津波注意報をひとまとめにした値**で（DMDATA は固定付加文 0211、
 * P2PQuake は `MajorWarning` と `Warning` の両方をここへ寄せる）、等級までは伝えていない。
 * 「津波警報」と書くと、**大津波警報の地震で事実より一段軽く見える**。
 * 気象庁の語（「津波警報等」）に合わせ、読み上げ（`domesticTsunamiText`）とも揃える。
 *
 * 等級そのものを知りたい場合は津波情報のカードを見ることになる。ここは地震カードなので、
 * その地震に津波の発表があるかどうかまでを伝える欄。
 */
export function formatDomesticTsunami(type: DomesticTsunami): { text: string; color: string } {
  const map: Record<DomesticTsunami, { text: string; color: string }> = {
    'なし': { text: '津波の心配なし', color: '#22c55e' },
    '不明': { text: '不明', color: '#94a3b8' },
    '調査中': { text: '調査中', color: '#94a3b8' },
    '海面変動の可能性': { text: '津波発生のおそれあり', color: '#f59e0b' },
    '若干の海面変動': { text: '若干の海面変動', color: '#f59e0b' },
    '注意報': { text: '津波注意報', color: '#f97316' },
    '警報等': { text: '津波警報等', color: '#ef4444' },
  }
  return map[type] ?? { text: '不明', color: '#94a3b8' }
}

export function formatIssueType(type: IssueType): string {
  const map: Record<IssueType, string> = {
    '震度速報': '震度速報',
    '震源情報': '震源情報',
    '震源・震度情報': '震源・震度情報',
    '各地の震度情報': '各地の震度情報',
    '顕著な地震の震源要素更新のお知らせ': '顕著な地震の震源要素更新のお知らせ',
    '遠地地震': '遠地地震',
    'その他': 'その他',
  }
  return map[type] ?? type
}

export function formatCorrectType(type: CorrectType): string {
  const map: Record<CorrectType, string> = {
    'なし': '',
    '訂正': '訂正（内容不明）',
    '震度のみ訂正': '震度を訂正',
    '震源を訂正': '震源を訂正',
    '震度・震源を訂正': '震度・震源を訂正',
  }
  return map[type] ?? ''
}

export function formatTsunamiGrade(grade: TsunamiGrade): { text: string; color: string; bg: string } {
  const map: Record<TsunamiGrade, { text: string; color: string; bg: string }> = {
    MajorWarning: { text: '大津波警報', color: '#ffffff', bg: '#9d0099' },
    Warning: { text: '津波警報', color: '#ffffff', bg: '#f00000' },
    Watch:    { text: '津波注意報',           color: '#000000', bg: '#ffa000' },
    Forecast: { text: '津波予報（若干の海面変動）', color: '#ffffff', bg: '#0891b2' },
    Unknown:  { text: '不明',                 color: '#ffffff', bg: '#666666' },
  }
  return map[grade] ?? { text: grade, color: '#ffffff', bg: '#666666' }
}

/**
 * 書き出すファイル名に使う時刻印（`YYYYMMDD_HHMMSS+HHMM`）。
 *
 * **端末のローカル時刻で作る。** `toISOString()` は UTC を返すため、JST の端末では 9 時間ずれた
 * 名前が並ぶ。書き出した記録を手元の観測（「この時刻に鳴った」というメモ）と突き合わせるのが
 * 用途なので、画面の他の時刻表示と同じ基準に揃える。
 *
 * 末尾に UTC からのオフセットを添えるのは、端末の時間帯が JST とは限らないため。名前だけで
 * どの時間帯の時刻か決まる。30 分・45 分刻みの時間帯があるので分も出す。
 */
export function formatFileStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(Math.floor(Math.abs(n))).padStart(w, '0')
  const date = `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  // getTimezoneOffset は「UTC - ローカル」の分を返すので、表記の符号は反転する（JST なら -540 → +0900）
  const off = -d.getTimezoneOffset()
  return `${date}_${time}${off < 0 ? '-' : '+'}${p(off / 60)}${p(Math.abs(off) % 60)}`
}
