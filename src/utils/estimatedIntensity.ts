// 推計震度分布図（IXAC41）を地震カードへ結び付ける規則と、画面へ出すときの語。
//
// **この電文は識別子を一切持たない。** BUFR の中身は凡例・震源要素・メッシュだけで、
// 気象庁が他の種別で配っている `EventID` に相当するものが無い。だから他の種別のように
// `eventId` で束ねられず、**地震発現時刻で突き合わせる**しかない。
import type {
  JMAQuake, JMAEstimatedIntensity, JMAEstimatedIntensityGrade, IntensityScale,
} from '../types/earthquake'
import { haversineKm, hasKnownEpicenter } from './geo'

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
 * 仕様 No.40102「最大震度５弱以上を観測する地震が発生した場合、地震発生から概ね 15 分後に
 * 配信します」。**「強い揺れの拡がりが足りないときは発表されないことがある」**とも書かれて
 * いるので、`awaiting` は「来るはず」ではなく「来る条件は満たしている」の意味。
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

/** 反映した（`apply: true`）ときの理由。反映しなかった理由（`stale` / `duplicate`）を含まない。 */
export type AppliedEstimatedIntensityReason = Extract<EstimatedIntensityUpdate, { apply: true }>['reason']

/**
 * その分布を「初めて受信した」ものとして読むか。読み上げの言い分けに使う。
 *
 * **更新扱いにするのは `newer`（同じ地震の続報）だけ。** `switched` は表示している分布が
 * 別の地震のものへ替わったので、聞き手にとっては初めて届いた分布にあたる —— そこで
 * 「更新されました」と言うと、直前まで読んでいた地震の分布が差し替わったように聞こえる。
 */
export function isNewEstimatedIntensity(reason: AppliedEstimatedIntensityReason): boolean {
  return reason !== 'newer'
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
