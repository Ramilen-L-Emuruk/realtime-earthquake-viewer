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
 * 2 通の推計震度分布図が同じ地震のものか。**カードとの引き当てと同じ物差し**
 * （発現時刻が同じ分で、震源が {@link MATCH_MAX_KM} 以内）。
 *
 * 一覧（→ `EarthquakeState.estimatedIntensities`）を地震ごとに 1 通へ保つのに使う。
 * 物差しをカードの引き当てと揃えておかないと、カードからは 1 つの地震に見えるのに
 * 一覧には 2 通残る（どちらを出すかが到着順で決まる）、という食い違いが起きる。
 */
export function isSameEstimatedIntensityQuake(
  a: Pick<JMAEstimatedIntensity, 'arrivalTime' | 'hypocenter'>,
  b: Pick<JMAEstimatedIntensity, 'arrivalTime' | 'hypocenter'>,
): boolean {
  const ka = toMinuteKey(a.arrivalTime)
  const kb = toMinuteKey(b.arrivalTime)
  if (ka === null || kb === null || ka !== kb) return false
  if (!hasKnownEpicenter(a.hypocenter.lat, a.hypocenter.lon)) return true
  if (!hasKnownEpicenter(b.hypocenter.lat, b.hypocenter.lon)) return true
  return haversineKm(a.hypocenter.lat, a.hypocenter.lon, b.hypocenter.lat, b.hypocenter.lon) <= MATCH_MAX_KM
}

/**
 * 一覧の中から、その地震カードに対応する推計震度分布図を返す。**持っていなければ `null`。**
 *
 * アプリは分布を**地震ごとに 1 通**持つ（→ `EarthquakeState.estimatedIntensities`）。
 * 一覧は {@link upsertEstimatedIntensity} が地震ごとに 1 通へ保っているが、それが崩れて
 * 同じ地震のものが重なっていても**発表の新しい方**を返す（到着順で答えが変わらないように）。
 */
export function estimatedIntensityFor(
  quake: JMAQuake | null | undefined,
  list: readonly JMAEstimatedIntensity[],
): JMAEstimatedIntensity | null {
  if (!quake) return null
  let found: JMAEstimatedIntensity | null = null
  for (const ei of list) {
    if (!matchEstimatedIntensity(quake, ei)) continue
    if (found === null || ei.time > found.time) found = ei
  }
  return found
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

/** 比べるのに要る見分け（発現時刻・発表時刻・セル数）。 */
export interface ShownEstimatedIntensity {
  arrivalTime: string
  /** 発表時刻 */
  time: string
  count: number
}

/** {@link decideEstimatedIntensityUpdate} の答え。 */
export type EstimatedIntensityUpdate =
  /** 反映する（その地震の分布をまだ持っていない） */
  | { apply: true; reason: 'first' }
  /** 反映する（同じ地震の続報） */
  | { apply: true; reason: 'newer' }
  /** 反映しない（同じ地震の、発表が古い報。**記録に残すこと**） */
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
 * **見るのは「その地震の分布を前に伝えたか」だけ。** 反映の判定
 * （{@link decideEstimatedIntensityUpdate}）の理由では代われない —— あちらが見るのは
 * 「その地震の分布を**持っているか**」で、履歴（起動時・「もっと見る」・リプレイの補完）から
 * 黙って取り込んだ分布も持っている側に入る。聞いていない分布の続報を「更新されました」と
 * 読むと、聞き手は前の報を聞き逃したと思う。
 *
 * かつてアプリが最新の 1 通しか持たなかった頃は、反映の判定の理由で言い分けていて、地震が
 * 立て続けに起きると誤った。実電文（2024-01-01）は ①16:20 本震（発現 16:10）②16:23 余震
 * （発現 16:18）③16:26 本震の続報（発現 16:10）と届いており、③が「更新されました」と
 * 読まれなかった。
 *
 * **初めて見る地震なら初報側**。台帳に無い発現時刻は真を返す。
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
 * 届いた分布を、**同じ地震の 1 通**（持っていなければ `null`）と比べて反映するかを決める。
 *
 * **比べるのは同じ地震どうしだけ。** 地震ごとに持つので、別の地震の分布は置き換えずに足す
 * （→ {@link upsertEstimatedIntensity}）。到着順は発表順と一致しない（分割の結合が遅れる・
 * 当日経路とライブが前後する・履歴の補完が後から届く）ので、**同じ地震の古い報で退行させない**
 * ことだけを見る。
 */
export function decideEstimatedIntensityUpdate(
  sameQuake: ShownEstimatedIntensity | null,
  next: ShownEstimatedIntensity,
): EstimatedIntensityUpdate {
  if (!sameQuake) return { apply: true, reason: 'first' }
  if (sameQuake.time > next.time) return { apply: false, reason: 'stale' }
  // 内容が同じ重複配信。実電文で観測している（先頭断片の差が作成時刻の 1 バイトだけ）。
  if (sameQuake.time === next.time && sameQuake.count === next.count) return { apply: false, reason: 'duplicate' }
  return { apply: true, reason: 'newer' }
}

/**
 * 一覧へ分布を入れる。**地震ごとに 1 通**（その地震の最新）を保つ。
 *
 * - その地震の分布をまだ持っていなければ足す
 * - 同じ地震の新しい報なら、その 1 通だけを置き換える（他の地震の分布は触らない）
 * - 同じ地震の古い報・重複配信なら**同じ配列をそのまま返す**（参照が変わらないので再描画も起きない）
 *
 * **件数に上限は置かない**（2026-10-05 ユーザー承認）。発表は震度5弱以上の地震だけで
 * （実配信 13 か月で 28 通）、1 通はふつう数千セル・十数 KB。
 */
export function upsertEstimatedIntensity(
  list: readonly JMAEstimatedIntensity[],
  next: JMAEstimatedIntensity,
): { list: readonly JMAEstimatedIntensity[]; update: EstimatedIntensityUpdate } {
  const index = list.findIndex(e => isSameEstimatedIntensityQuake(e, next))
  const update = decideEstimatedIntensityUpdate(index >= 0 ? list[index] : null, next)
  if (!update.apply) return { list, update }
  if (index < 0) return { list: [...list, next], update }
  const replaced = list.slice()
  replaced[index] = next
  return { list: replaced, update }
}
