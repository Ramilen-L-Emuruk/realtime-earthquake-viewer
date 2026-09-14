// 推計震度分布図（IXAC41）を地震カードへ結び付ける規則と、画面へ出すときの語。
//
// **この電文は識別子を一切持たない。** BUFR の中身は凡例・震源要素・メッシュだけで、
// 気象庁が他の種別で配っている `EventID` に相当するものが無い。だから他の種別のように
// `eventId` で束ねられず、**地震発現時刻で突き合わせる**しかない。
import type {
  JMAQuake, JMAEstimatedIntensity, JMAEstimatedIntensityGrade, IntensityScale,
} from '../types/earthquake'
import { haversineKm, hasKnownEpicenter } from './geo'
import { log } from './logger'

/**
 * 震源が離れすぎていたら別の地震とみなす距離。
 *
 * 時刻だけで裁くと、**同じ分に起きた別の地震**（本震の直後の余震など）の分布を取り違えうる。
 * とはいえ震源要素は続報で動く（VXSE61 が訂正する）ので、**きつくすると正しい組を落とす**。
 * 取り違えは「離れた地方どうし」でしか起きないため、地方をまたぐ程度に広く取る。
 */
const MATCH_MAX_KM = 300

/** ISO 文字列を分単位の通し番号にする。読めない値は null。 */
function toMinuteKey(iso: string): number | null {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.floor(t / 60000)
}

/**
 * 分布図の**本体を持たずに**突き合わせる。自動で分布モードを開くときが使う。
 *
 * {@link matchEstimatedIntensity} と判定は同じ。分けてあるのは、開く側へ本体を渡すと
 * 3MB を引数に載せることになるため —— 要るのは時刻と震源の 3 つの値だけ。
 */
export function matchEstimatedIntensityArrival(
  quake: JMAQuake, arrivalTime: string, lat?: number, lon?: number,
): boolean {
  const a = toMinuteKey(quake.earthquake.time)
  const b = toMinuteKey(arrivalTime)
  if (a === null || b === null || a !== b) return false
  // 震源も渡されたら距離でも裏を取る（{@link matchEstimatedIntensity} と同じ判定）。
  if (lat === undefined || lon === undefined) return true
  const { latitude, longitude } = quake.earthquake.hypocenter
  if (!hasKnownEpicenter(latitude, longitude)) return true
  return haversineKm(latitude, longitude, lat, lon) <= MATCH_MAX_KM
}

/**
 * その推計震度分布図が、その地震カードのものか。
 *
 * **突き合わせるのは地震発現時刻（分単位）。** 電文の値が発生時刻ではなく発現時刻であることは
 * 実電文で確かめてある（→ {@link JMAEstimatedIntensity.arrivalTime}）。地震カードが持つ
 * `earthquake.time` も同じ発現時刻なので、そのまま比べられる。
 *
 * 震源が両方読めているときだけ、距離でも裏を取る。**片方でも読めなければ時刻だけで判定する**
 * ——震度速報しか届いていない段階のカードは震源を持たない（位置不明のセンチネル）。
 */
export function matchEstimatedIntensity(quake: JMAQuake, ei: JMAEstimatedIntensity): boolean {
  return matchEstimatedIntensityArrival(quake, ei.arrivalTime, ei.hypocenter.lat, ei.hypocenter.lon)
}

/**
 * 一覧の中から、その地震カードに対応する推計震度分布図を返す。
 *
 * アプリが持つのは最新の 1 通だけ（→ `EarthquakeState.estimatedIntensity`）なので、
 * 引数も 1 通。**持っていない・別の地震のものなら `null`。**
 */
export function estimatedIntensityFor(
  quake: JMAQuake | null | undefined,
  ei: JMAEstimatedIntensity | null,
): JMAEstimatedIntensity | null {
  if (!quake || !ei) return null
  return matchEstimatedIntensity(quake, ei) ? ei : null
}

/**
 * 震度分布ボタンの状態。
 *
 * **3 つに分けているのは、電文の発表条件が 3 通りだから。** 推計震度分布図は最大震度5弱以上の
 * 地震にしか発表されないので、震度4以下の地震では「まだ届いていない」のではなく
 * **そもそも発表されない**。
 *
 * **画面が見分けているのは `official` かどうかだけ**で、`awaiting` と `notIssued` は同じ見た目に
 * なる。それでも 2 値へ畳まないのは、**この区別が画面の都合ではなく電文の側の事実**だから
 * （根拠は下の `ISSUE_MIN_SCALE`）。畳めばこの関数自体が「一致する電文を持っているか」と
 * 同義になり、発表条件を調べ直さないと元へ戻せない。
 */
export type EstimatedIntensityAvailability = 'official' | 'awaiting' | 'notIssued'

/**
 * 気象庁が推計震度分布図を発表する最大震度の下限（震度5弱＝階級値 45）。
 *
 * 「配信資料に関する仕様 No.40102『推計震度分布図』」が「最大震度５弱以上を観測する地震が
 * 発生した場合、地震発生から概ね 15 分後に配信します」と定めている（資料の発行日・改訂日は
 * `docs/spec/quake-spec.md` §8「この電文だけ二進（BUFR）で届く」）。
 *
 * **`awaiting` が言えるのは「発表される条件を満たしている」まで。** 資料は発表されない条件を
 * 書いていないが、配信まで概ね 15 分あり、**受信側からは「まだ発表されていない」と「配信が
 * 届かなかった」を区別できない**。そのため画面では `notIssued` と書き分けない
 * （→ `docs/spec/quake-spec.md` §9「震度分布モード」）。
 */
const ISSUE_MIN_SCALE = 45

export function estimatedIntensityAvailability(
  quake: JMAQuake,
  matched: JMAEstimatedIntensity | null,
): EstimatedIntensityAvailability {
  if (matched) return 'official'
  return quake.earthquake.maxScale >= ISSUE_MIN_SCALE ? 'awaiting' : 'notIssued'
}

/** 階級震度（整数部と弱・強）→ このアプリの階級値。 */
function gradeToScale(scale: number, modifier: 'none' | 'weak' | 'strong'): IntensityScale | null {
  if (scale === 4) return 40
  if (scale === 5) return modifier === 'strong' ? 50 : 45
  if (scale === 6) return modifier === 'strong' ? 60 : 55
  if (scale === 7) return 70
  return null
}

/** 計測震度（0.1 単位）の取りうる範囲。電文の幅が 7 ビットなので 0〜127。 */
const SI_RANGE = 128

/**
 * 計測震度（0.1 単位の整数）→ 階級値の索引を作る。
 *
 * **凡例は電文が持っているものを使う。** 自前の階級表を当てると、気象庁が境界を見直したときに
 * 画面だけが古い区切りで塗られる —— しかもセルの値は正しいので、ずれに気づく手掛かりが無い。
 *
 * 索引に無い計測震度（凡例のどの範囲にも入らない値）は `0` を置く。呼び出し側は 0 を
 * 「塗らない」として扱うこと（震度4未満はそもそも配信されないので、正常時は現れない）。
 */
export function buildSiToScale(grades: readonly JMAEstimatedIntensityGrade[]): Uint8Array {
  const table = new Uint8Array(SI_RANGE)
  for (const g of grades) {
    const scale = gradeToScale(g.scale, g.modifier)
    if (scale === null) continue
    const lo = Math.max(0, Math.min(SI_RANGE - 1, g.lower))
    const hi = Math.max(0, Math.min(SI_RANGE - 1, g.upper))
    for (let si = lo; si <= hi; si++) table[si] = scale
  }
  return table
}

/** いま画面に出している分布の見分け。**本体（3MB 規模）は持たない。** */
export interface ShownEstimatedIntensity {
  arrivalTime: string
  /** 発表時刻 */
  time: string
  count: number
}

/** {@link decideEstimatedIntensityUpdate} の答え。 */
export type EstimatedIntensityUpdate =
  /** 反映する（初めての分布） */
  | { apply: true; reason: 'first' }
  /** 反映する（同じ地震の続報） */
  | { apply: true; reason: 'newer' }
  /** 反映する（別の地震へ入れ替える。**記録に残すこと**） */
  | { apply: true; reason: 'switched' }
  /** 反映しない（発表が古い。**記録に残すこと**） */
  | { apply: false; reason: 'stale' }
  /** 反映しない（内容が同じ重複配信。正常なので記録しない） */
  | { apply: false; reason: 'duplicate' }

/**
 * 分布を伝えた地震（発現時刻）を覚えておく上限。
 *
 * 要るのは「同じ地震の続報が届くまでのあいだに、別の地震の分布が何通挟まりうるか」だけ。
 * 実電文（2024-01-01 の能登半島地震）では本震の初報 16:20 と続報 16:26 のあいだに挟まった
 * 別の地震の分布は 1 通で、当日 1 日を通しても発現時刻は 8 種類だった。余裕を見て倍にしてある
 * —— 覚えるのは時刻の文字列だけなので、増やしても費用はほぼ無い。
 *
 * **ライブ運用では台帳が空になる契機が無い**（空にするのはリプレイの開始・終了だけ）ので、
 * 数日つなぎ続ければ上限に届きうる。ただし追い出しが誤読につながるのは、**ある地震の初報から
 * その続報が届くまでのあいだに、別の地震の分布が上限ぶん挟まった**ときだけ。この電文は震度5弱
 * 以上でしか発表されず、続報も数分後に届く（実測 6 分）ので、届いても稀。**それでも
 * 追い出したことは記録に残す** —— 誤読が起きたときに、原因を追う手掛かりがどこにも無くなる。
 */
export const MAX_SHOWN_ESTIMATED_INTENSITY_ARRIVALS = 16

/**
 * その分布を「初めて受信した」ものとして読むか。読み上げの言い分けに使う。
 *
 * **見るのは「その地震の分布を前に伝えたか」だけ。** かつては
 * {@link decideEstimatedIntensityUpdate} の理由で決め、`switched`（別の地震の分布へ入れ替え）を
 * 初報側へ倒していた。だが理由が比べている相手は**いま出している 1 通**しかないので、地震が
 * 立て続けに起きて分布が交互に届くと、同じ地震の続報まで `switched` になる。実電文
 * （2024-01-01）は ①16:20 本震（発現 16:10）②16:23 余震（発現 16:18）③16:26 本震の続報
 * （発現 16:10）と届いており、③が「更新されました」と読まれなかった。
 *
 * **初めて見る地震なら初報側**という判断自体は変えていない。台帳に無い発現時刻は真を返す。
 */
export function isNewEstimatedIntensity(shownArrivals: readonly string[], arrivalTime: string): boolean {
  return !shownArrivals.includes(arrivalTime)
}

/**
 * 分布を伝えた地震（発現時刻）を台帳へ積む。古いものから落として上限に収める。
 *
 * **積むのは声にした分だけ。** 反映しなかった報（`stale` / `duplicate`）はもちろん、画面へ
 * 出しただけで音も声も伴わない注入（リプレイ開始時の初期状態）でも積まない —— 聞いていない
 * ものを「更新されました」と読むと、聞き手は前の報を聞き逃したと思う。逆向きの誤り（二度
 * 読んだように聞こえる）は事実として嘘になっていないぶん軽い。
 */
export function rememberShownEstimatedIntensity(shownArrivals: string[], arrivalTime: string): void {
  if (!shownArrivals.includes(arrivalTime)) shownArrivals.push(arrivalTime)
  if (shownArrivals.length > MAX_SHOWN_ESTIMATED_INTENSITY_ARRIVALS) {
    const dropped = shownArrivals.splice(0, shownArrivals.length - MAX_SHOWN_ESTIMATED_INTENSITY_ARRIVALS)
    // 追い出した地震の続報がこの後に届けば、初報として読まれる。**稀にしか起きないので
    // 通常運転のログは汚さない**（1 回の追加で溢れるのは高々 1 件）。
    log.info(`[ixac41] 台帳の上限を超えたので古い分を落とします dropped=${dropped.join(',')}`)
  }
}

/**
 * 届いた分布を反映するかどうか。**フックから切り出してある**（判定だけを固定したいため）。
 *
 * **発表時刻が古い報は、別の地震のものでも採らない。** アプリが持つのは最新の 1 通だけで、
 * 到着順は発表順と一致しない（分割の結合が遅れる・当日経路とライブが前後する）。比較を
 * 「同じ地震どうし」に限ると、**遅れて届いた古い地震の分布が、より新しい地震の分布を
 * 押しのける** —— 震度5弱以上が短時間に続く場面でだけ起きるので、いちばん起きてほしくない
 * ときに起きる。
 */
export function decideEstimatedIntensityUpdate(
  shown: ShownEstimatedIntensity | null,
  next: { arrivalTime: string; time: string; count: number },
): EstimatedIntensityUpdate {
  if (!shown) return { apply: true, reason: 'first' }
  if (shown.time > next.time) return { apply: false, reason: 'stale' }
  if (shown.arrivalTime === next.arrivalTime) {
    // 内容が同じ重複配信。実電文で観測している（先頭断片の差が作成時刻の 1 バイトだけ）。
    if (shown.time === next.time && shown.count === next.count) return { apply: false, reason: 'duplicate' }
    return { apply: true, reason: 'newer' }
  }
  return { apply: true, reason: 'switched' }
}
