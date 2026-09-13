import type { CorrectType, DomesticTsunami, Hypocenter, IssueType, TsunamiGrade } from '../types/earthquake'
import {
  createLogThrottle, createPerLabelLogGate, log,
  UNREADABLE_VALUE_LOG_KINDS, UNREADABLE_VALUE_LOG_INTERVAL_MS,
} from './logger'

const FORMAT_LOG_PREFIX = '[format]'

// 読めない値の記録は**値ごとに 1 回**出し、種類が溢れたら時間で間引く
// （理由は `createPerLabelLogGate`）。時刻の整形は再描画のたびに走るため、素朴に
// `log.warn` を置くと壊れた値 1 つでコンソールが埋まる。

/** 文字列の入力用。整形関数ごとに独立した枠を持つ。 */
const gateByLabel = createPerLabelLogGate(UNREADABLE_VALUE_LOG_KINDS, UNREADABLE_VALUE_LOG_INTERVAL_MS)
/** `Date`・数値の入力用（下記の理由で値では間引けない）。こちらも整形関数ごとに分ける。 */
const opaqueThrottles = new Map<string, (emit: () => void) => void>()

/**
 * 読めなかったことを記録する。**間引き方は入力の型で分ける。**
 *
 * - **文字列**は値ごとに 1 回。壊れた値がそのまま鍵になる
 * - **`Date` と数値**は時間で間引く。壊れていると `String()` は元の値によらず
 *   `"Invalid Date"` / `"NaN"` へ丸まり、**別々の壊れた値が 1 つの鍵に潰れる**。値で間引くと
 *   最初の 1 回だけ出て以後は永久に黙る —— `createFirstSeenLogGate` が「やってはいけない」と
 *   書いた状態そのもので、しかも痕跡が残らない
 *
 * **`Date`・数値では、記録に元の値が載らない**（上と同じ理由で復元できない）。原因を追うには
 * その `Date` を作った側を当たることになる。文字列で渡せる経路は文字列のまま渡すこと。
 */
function reportInvalidDateTime(label: string, raw: string, opaque: boolean): void {
  const emit = (overflowed: boolean): void => {
    const tail = overflowed
      ? `（読めない値が ${UNREADABLE_VALUE_LOG_KINDS} 種類を超えたため、以後は間引いて記録します）`
      : ''
    // **落とし先を文面で断定しない。** 呼び出し元によって違う（表示の整形は `null` を返して
    // 欄・句ごと落とすが、ファイル名の時刻印は現在時刻で作る）。共通の文面で「時刻を
    // 出しません」と書くと、書き出したファイル名には時刻が入っているのに記録だけが
    // 別のことを言う。
    log.warn(`${FORMAT_LOG_PREFIX} ${label}: 日時として読めません: "${raw}"${tail}`)
  }
  if (!opaque) {
    gateByLabel(label, raw, emit)
    return
  }
  let throttle = opaqueThrottles.get(label)
  if (!throttle) {
    throttle = createLogThrottle(UNREADABLE_VALUE_LOG_INTERVAL_MS)
    opaqueThrottles.set(label, throttle)
  }
  throttle(() => emit(false))
}

/**
 * 日時として読める値だけを `Date` にして返す。読めなければ記録を残して `null`。
 *
 * **日時を整形する関数はすべてここを通す。** `new Date('壊れた値')` は例外を投げず
 * `Invalid Date` になり、`getHours()` 以下がそろって `NaN` を返す。素通しにすると
 * `"NaN:NaN:NaN"` のような文字列が画面へ出るうえ、**例外も記録も残らない**ので
 * 起きたことにすら気づけない。
 *
 * **時間帯を明示していない値（`2026-01-01T12:00:00`）はここでは弾けない。** `Date` は
 * それを実行環境のローカル時刻として解釈し、有効な値を返す。端末ごとに違う時刻が出る別の
 * 穴で、手当ては電文を読む側（`dmdataParser.ts` の `readReportDateTime` ほか）。
 *
 * **この関数は外にも出している。** 読み上げ文（`ttsText.ts`）は表示とは別の語形で時刻を組む
 * ため独自の整形関数を持つが、`Invalid Date` の穴は同じで、しかもそちらは
 * 「ナンじナンぷん」と**音声に出る**。同じ検査を通すために共有する。
 *
 * @param label 記録に出す呼び出し元の名前。同じ名前の関数が別ファイルにあるときは
 *   `ttsText.formatTime` のように前置きを添える
 */
export function readDateTime(label: string, input: string | number | Date): Date | null {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) {
    // 文字列以外は「壊れた値の中身」を記録へ載せられない（`String()` が `"Invalid Date"` /
    // `"NaN"` へ丸める）。間引き方を変える理由は {@link reportInvalidDateTime}。
    const opaque = typeof input !== 'string'
    reportInvalidDateTime(label, opaque ? String(input) : input, opaque)
    return null
  }
  return date
}

export function formatDateTime(isoString: string): string | null {
  const date = readDateTime('formatDateTime', isoString)
  if (!date) return null
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}/${M}/${d} ${h}:${m}:${s}`
}

export function formatDateTimeMin(isoString: string): string | null {
  const date = readDateTime('formatDateTimeMin', isoString)
  if (!date) return null
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${y}/${M}/${d} ${h}:${m}`
}

/**
 * 地震の時刻（`earthquake.time`）。元データに秒が含まれないため、秒を出さず「ごろ」を付ける。
 * 例: 6月6日 8:47ごろ
 */
export function formatQuakeTime(isoString: string): string | null {
  const date = readDateTime('formatQuakeTime', isoString)
  if (!date) return null
  const M = date.getMonth() + 1
  const d = date.getDate()
  const h = date.getHours()
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${M}月${d}日 ${h}:${m}ごろ`
}

export function formatTime(isoString: string): string | null {
  const date = readDateTime('formatTime', isoString)
  if (!date) return null
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/**
 * 時刻を分まで（`HH:MM`）。津波の到達・満潮・最大波など、**秒を出す意味がない欄**はこちら。
 *
 * 呼び出し側が `formatTime(...).slice(0, 5)` と書くのをやめるために置いた。切り出す前は
 * 12 箇所で同じ `slice` が繰り返されており、読めない値のときに `null` を `slice` しようとして
 * 落ちる箇所と、文字列 `"NaN:N"` が出る箇所が混在していた。
 *
 * **秒まで出す欄はこちらを使わない**（緊急地震速報の到達予測時刻。区域ごとの差が数秒なので
 * 分に丸めると到達順が潰れる。→ `docs/spec/eew-spec.md` §4）。
 *
 * `formatTime` を呼んで切るのではなく独立させてあるのは、記録に出る名前を呼び出し元と
 * 一致させるため（`formatDateTime` と `formatDateTimeMin` の関係と同じ）。
 */
export function formatTimeMin(isoString: string): string | null {
  const date = readDateTime('formatTimeMin', isoString)
  if (!date) return null
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** datetime-local input 用のローカル時刻文字列（YYYY-MM-DDTHH:mm）を返す。 */
export function formatDateTimeLocal(date: Date): string | null {
  const d = readDateTime('formatDateTimeLocal', date)
  if (!d) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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
 *
 * **読めない値では現在時刻で作る。** `NaNNaNNaN_NaNNaNNaN+NaNNaN` という名前で書き出しても
 * 意味を成さないが、**ここだけは `null` を返さない** —— 画面の時刻表示と違って、名前が
 * 付かなければ書き出し自体が成り立たない。対象の時刻が判らないことと、利用者が求めた
 * 書き出しを止めることは別で、後者まで巻き込むのは過剰。読めなかった事実は記録に残る。
 */
export function formatFileStamp(ms: number): string {
  const d = readDateTime('formatFileStamp', ms) ?? new Date()
  const p = (n: number, w = 2): string => String(Math.floor(Math.abs(n))).padStart(w, '0')
  const date = `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  // getTimezoneOffset は「UTC - ローカル」の分を返すので、表記の符号は反転する（JST なら -540 → +0900）
  const off = -d.getTimezoneOffset()
  return `${date}_${time}${off < 0 ? '-' : '+'}${p(off / 60)}${p(Math.abs(off) % 60)}`
}

/**
 * 気象庁以外が運用する観測点に付く印（全角アスタリスク U+FF0A）。
 *
 * 電文は観測点名の末尾にこの印を付け、固定付加文で「＊印は気象庁以外の震度観測点に
 * ついての情報です。」と断る（コード `0262`。長周期地震動観測情報は `0263`）。
 */
export const NON_JMA_MARK = '＊'

/** 印に添える説明。**記号だけでは何と対比しているのか分からない。** */
export const NON_JMA_MARK_TITLE = '気象庁以外の機関が運用する観測点です'

/**
 * 観測点名へ「気象庁以外が運用する観測点」の印を付ける。
 *
 * **印は表示するときにだけ付ける。** 電文の読み取りでは印を外して持ち（→ `stripNonJmaMark`）、
 * 座標表をはじめ**印の無い名前を鍵にしている経路がいくつもある**。名前そのものへ戻すと
 * そのすべてに印を外す処理が要り、1 つ漏らすだけで地図から点が落ちたり読み上げが記号を
 * 読んだりする。**経路の一覧は単一情報源に置いてある**
 * （→ {@link import('../types/earthquake').EarthquakePoint.nonJma}）。
 *
 * **「自治体」と言い換えないこと** —— 気象庁以外には防災科研なども含まれる。
 */
export function withNonJmaMark(name: string, nonJma: boolean | undefined): string {
  return nonJma ? `${name}${NON_JMA_MARK}` : name
}
