import type { JMATsunami, TsunamiArea, TsunamiGrade, TsunamiObservation } from '../types/earthquake'
import { log } from './logger'

const GRADE_PRIORITY: Record<TsunamiGrade, number> = {
  MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0,
}

/**
 * カードが等級カードを積む順（重い等級が上）。
 *
 * カード・読み上げの双方がこの並びに従う。`GRADE_PRIORITY` の降順そのものなので、等級を
 * 増やしたときに片方だけ漏れることがない。
 */
export const GRADES_IN_CARD_ORDER: TsunamiGrade[] =
  (Object.keys(GRADE_PRIORITY) as TsunamiGrade[]).sort((a, b) => GRADE_PRIORITY[b] - GRADE_PRIORITY[a])

/** 発表中エリアの最高グレードを返す。エリアが無ければ 'Unknown'。 */
export function tsunamiMaxGrade(tsunami: JMATsunami): TsunamiGrade {
  let max: TsunamiGrade = 'Unknown'
  for (const area of tsunami.areas) {
    if (GRADE_PRIORITY[area.grade] > GRADE_PRIORITY[max]) max = area.grade
  }
  return max
}

/**
 * 等級を伝えていない電文か（区域が空 = 観測情報のみの続報。DMDATA の VTSE51②・VTSE52）。
 *
 * **この形の電文を等級の比較に混ぜないこと。** 区域が無いので `tsunamiMaxGrade` は
 * `Unknown`（最下位）を返し、発表中の警報と比べると必ず「降格」と判定される。降格の
 * 読み上げ（`tsunamiDowngradeToText`）は区域が空だと全解除の文言へフォールバックするため、
 * 警報の発表中に「津波警報等は全て解除されました」と読み上げる事故になる。
 *
 * 等級を伝えていないだけで、観測値は載っている。**観測点更新として扱うのが正しい。**
 */
export function isTsunamiObservationOnly(tsunami: JMATsunami): boolean {
  return tsunami.areas.length === 0
}

/** 複数の津波イベントを横断して最大グレードを返す。解除済み（10秒表示中のcancelledAtも含む）・Unknown は除外。なければ null。 */
export function tsunamiOverallGrade(tsunamis: JMATsunami[]): 'MajorWarning' | 'Warning' | 'Watch' | null {
  let max: TsunamiGrade | null = null
  for (const t of tsunamis) {
    if (t.cancelled || t.cancelledAt) continue
    const g = tsunamiMaxGrade(t)
    if (g !== 'Unknown' && g !== 'Forecast' && (max === null || GRADE_PRIORITY[g] > GRADE_PRIORITY[max])) max = g
  }
  return max as 'MajorWarning' | 'Warning' | 'Watch' | null
}

/**
 * 解除電文が「いま表示している津波」に向けたものかを判定する。
 *
 * 津波は 1 件スロットで持つため、**別イベントの遅延到達した解除で進行中の津波を消してはいけない**。
 * 判定は 2 段。
 *
 * 1. 双方が `eventId` を持つなら一致で見る（`serial` が違っても同一イベントを解除できるよう、
 *    `id` 全体ではなく `eventId` で照合する）
 * 2. どちらかが欠けていれば同一イベントかは判定できないので、発表時刻の前後だけを見る。
 *    表示中より古い解除は別イベントの遅延到達とみなす（これが無いと A の遅い解除で B が消える）
 *
 * **時刻も読めないときは受け入れる**（`true`）。かつて `id` の完全一致を求めていた頃は、
 * P2PQuake（standard 版）の 552 が `eventId` を持たず `id` は電文ごとの文書 ID なので、発表と
 * 解除で必ず異なり standard 版の解除が常に捨てられていた（音と読み上げだけが「解除」と伝え、
 * カードは 24 時間のフェイルセーフまで残る）。解除を落とす方が害が大きい。
 *
 * **カードの状態更新（`useEarthquakes`）と、読み上げ・画面の記憶を落とす判断
 * （`useLiveEventHandler`）の両方でこの関数を使うこと。** 片方だけが照合すると、カードは
 * 残っているのに観測点の既読だけが消える（進行中の観測点が「新規」として読み直される）。
 */
export function isCancelForCurrentTsunami(cancel: JMATsunami, current: JMATsunami | undefined): boolean {
  if (!current) return true
  const cancelEventId = cancel.eventId
  const currentEventId = current.eventId
  if (cancelEventId && currentEventId) return cancelEventId === currentEventId
  const cancelAt = new Date(cancel.time).getTime()
  const currentAt = new Date(current.time).getTime()
  if (Number.isFinite(cancelAt) && Number.isFinite(currentAt) && cancelAt < currentAt) return false
  return true
}

/**
 * 新報を「表示中の津波の続報」として扱い、前報の区域・観測点を引き継いでよいかを判定する。
 *
 * **カードの状態更新（`useEarthquakes`）と、カードの並びを引く基準の組み立て
 * （`useLiveEventHandler` の `tsunamiCardOrderBasis`）で同じ述語を使うこと。** 前者だけが
 * 引き継ぎを断ると、読み上げ・通知・スクロールの送り先が「カードに無い観測点」で並べ替えた
 * 結果になる。逆も同じで、片方だけ緩めれば黙って食い違う。
 *
 * 引き継ぐのは**双方が同じ `eventId` を持ち、表示中が解除表示に入っていない**ときだけ。
 *
 * - `eventId` を持たない経路（P2PQuake の 552）は同一性を判定できないので引き継がない。
 *   standard 版で観測点が蓄積されないのはこのため（カードもそう振る舞う）
 * - 解除表示中（`cancelledAt`）のカードは 10 秒で消える。その値を新しい津波へ持ち込まない
 */
export function isTsunamiContinuation(current: JMATsunami | undefined, next: JMATsunami): boolean {
  return !!current && !!current.eventId && !!next.eventId
    && current.eventId === next.eventId && !current.cancelledAt
}

/**
 * 同一の津波イベントに属する報から、最後に伝えられた有効期限（`validDateTime`）を選ぶ。
 *
 * **有効期限は報ではなく津波そのものに付く事実として扱うこと。** 気象庁は期限が決まった報で
 * 一度だけ ValidDateTime を載せ、以後の続報には載せない。2024 年能登半島地震の実電文では
 * 01/02 10:00 の VTSE41 が「01/02 17:00 まで」を伝え、その 3 分後に届いた最後の報（VTSE51）は
 * 期限を持たない。2024 年日向灘地震も同じ形で、津波予報が最後に残るケースの標準的な運用。
 * 報 1 通だけを見て期限の有無を判定すると、そういう津波は「失効しない津波」として扱われ、
 * 期限を過ぎても画面に残り続ける（予報のみに解除電文は出ないため、消す手段が他に無い）。
 *
 * 期限を持つ報が複数あれば発表時刻が最も新しいものを採る（気象庁が期限を延ばした・縮めた場合に
 * 従うため）。発表時刻が読めない報は新旧を判定できないので候補から外す。
 *
 * **期限そのものが日時として読めない値は採らない。** 読めない値を採ると、その津波が「期限を持つ」
 * 顔をしたまま、以後の比較（`new Date(壊れた値) <= now` 等）がすべて偽に倒れる。表示を続ける側にも、
 * 失効の予約を積まない側にも同時に倒れるため、消す手段が無い津波が黙って出来上がる。捨てるときは
 * 記録を残す（画面には何の痕跡も残らないため）。
 *
 * @param reports 同一イベントの報。順序は問わない
 * @returns 最後に伝えられた期限。1 通も期限を持たなければ undefined
 */
export function latestValidDateTime(reports: JMATsunami[]): string | undefined {
  let latestAt = -Infinity
  let latest: string | undefined
  for (const report of reports) {
    if (!report.validDateTime) continue
    if (!Number.isFinite(new Date(report.validDateTime).getTime())) {
      log.warn(`[tsunami] 有効期限を日時として読めないため採用しません: id=${report.id} validDateTime=${report.validDateTime}`)
      continue
    }
    const at = new Date(report.time).getTime()
    if (!Number.isFinite(at)) {
      // 発表時刻が読めないと新旧を判定できない。期限が読めない場合と同じく記録を残す
      // （片方だけ無言で落とすと、期限が消えた原因を追う手がかりが残らない）。
      log.warn(`[tsunami] 発表時刻を日時として読めないため有効期限の候補から外します: id=${report.id} time=${report.time}`)
      continue
    }
    if (at < latestAt) continue
    latestAt = at
    latest = report.validDateTime
  }
  return latest
}

/**
 * 最新報に有効期限が無ければ、同一イベントの過去報から引き継いだものを返す。
 *
 * 履歴からの復元（初回ロード・リロード）は最新の 1 報だけを画面へ載せるため、その報が期限を
 * 持たないと失効の予約が積まれず、期限切れの津波が消えないまま残る。引き継ぐ理由は
 * `latestValidDateTime` に同じ。
 *
 * 同一イベントの判定は `eventId`、`eventId` を持たない経路（P2PQuake）では `id` の一致で行う。
 * 別の津波の期限を引き継ぐと、発表中の津波を無関係な期限で消しうる。
 *
 * @param latest 画面へ載せる最新報
 * @param reports 同じ取得結果に含まれる報（`latest` を含んでよい）
 */
export function withInheritedValidDateTime(latest: JMATsunami, reports: JMATsunami[]): JMATsunami {
  // 自分の期限が日時として読めるならそれを使う（判定は `latestValidDateTime` と同じ 1 箇所に置く）。
  if (latestValidDateTime([latest])) return latest
  const sameEvent = reports.filter(r => r !== latest
    && (latest.eventId ? r.eventId === latest.eventId : !r.eventId && r.id === latest.id))
  const inherited = latestValidDateTime(sameEvent)
  if (inherited) return { ...latest, validDateTime: inherited }
  // 読めない期限は落とす。残すと「期限を持つ津波」の顔をしたまま以後の比較がすべて偽へ倒れ、
  // 表示は続くのに失効の予約も積まれない。落とせば standard 版の 24 時間フェイルセーフが働く。
  return latest.validDateTime ? { ...latest, validDateTime: undefined } : latest
}

/**
 * 新報がタブ強制切替を発火すべき「新規発報」に当たるかを判定する。
 * `current` は現在アクティブな津波（`tsunamis[0]`、無ければ undefined）。
 * 続報（同一 eventId の観測点更新等）でタブが毎回奪われるのを防ぐため、
 * useLiveEventHandler がタブ切替判定に使う。
 *
 * true になるのは以下のいずれか:
 *   - `current` 無し
 *   - `current` が取消済み（`cancelled` or 10秒表示中の `cancelledAt`）
 *   - `current.eventId` と `next.eventId` が異なる（別地震の津波）
 *   - `eventId` が両者で欠落する場合は `sourceEarthquake.originTime` で代替判定
 *     （DMDATA XML の Earthquake 要素経由でのみ機能する。P2PQuake API v2 の
 *     生 552 電文には `earthquake` 相当のフィールドが無く `sourceEarthquake` は
 *     常に undefined になるため、標準版ではこのフォールバックは実質発火しない）
 *   - 上記いずれの識別子も取れない場合は false（保守的に続報扱い）。
 *     標準版はこの経路がデフォルトで、別地震の新規津波でもタブが奪われない
 *     （grade 格上げか手動タブ切替に依存する）
 */
export function isTsunamiNewFire(next: JMATsunami, current: JMATsunami | undefined): boolean {
  if (!current) return true
  if (current.cancelled || current.cancelledAt) return true
  if (current.eventId && next.eventId) return current.eventId !== next.eventId
  const currentOrigin = current.sourceEarthquake?.originTime
  const nextOrigin = next.sourceEarthquake?.originTime
  if (currentOrigin && nextOrigin) return currentOrigin !== nextOrigin
  return false
}

/**
 * 新報が `current` から grade 格上げに当たるかを判定する。
 * `MajorWarning > Warning > Watch > Forecast > Unknown` の順で比較。
 * `current` 無し／取消済みの場合は false（新規発報として扱うので isTsunamiNewFire 側で拾う）。
 */
export function isTsunamiGradeUpgrade(next: JMATsunami, current: JMATsunami | undefined): boolean {
  if (!current) return false
  if (current.cancelled || current.cancelledAt) return false
  const nextGrade = tsunamiMaxGrade(next)
  const currentGrade = tsunamiMaxGrade(current)
  return GRADE_PRIORITY[nextGrade] > GRADE_PRIORITY[currentGrade]
}

/** 1 つの報の中で、区域の等級が「どこから、どこへ」動いたかの組。 */
export interface TsunamiAreaGradeChange {
  /** 前回この区域に発表されていた等級（`TsunamiArea.lastGrade`） */
  from: TsunamiGrade
  /** 今回この区域に発表されている等級 */
  to: TsunamiGrade
  /** この遷移をした区域。カードの表示順に並ぶ */
  areas: TsunamiArea[]
  /**
   * 等級が上がったか（引き上げ）。`false` なら下がった（切替・解除）。
   *
   * 読み上げの動詞（「引き上げられました」/「切り替えられました」）と並び順の両方がこれで
   * 決まる。判定は `isTsunamiGradeRaised` に閉じている。
   */
  raised: boolean
}

/**
 * 区域単位で等級が動いた組を、読み上げ・表示に使う順で返す。
 *
 * **全体の最上位等級が変わらない報でも、区域ごとには等級が動いている。** 気象庁は一部解除でも
 * 区域を電文から消さず「津波注意報 → 津波予報」の降格として載せるため、他の区域に注意報が
 * 残っていると `tsunamiMaxGrade` は同じ値を返し続ける。2024 年能登半島地震の 01/02 02:30 の報
 * （福岡県日本海沿岸・佐賀県北部の 2 区域だけが解除）がこの形で、音以外は何も起きなかった。
 *
 * 並びは**引き上げの組を先、引き下げの組を後**に置き、それぞれの中は遷移先の等級が重い順。
 * 聞き手が取るべき行動が重くなる側を先に伝えるため。
 *
 * `lastGrade` を持たない区域（P2PQuake 経路・`LastKind` の無い電文）は判定できないので数えない。
 * 遷移先が `Unknown` の組も返さない（等級の名前が付かず、文にも表示にもできない）。
 *
 * @param tsunami 判定する報
 * @param observations 区域の並べ替えに使う観測情報。既定はこの報が持つもの
 */
export function tsunamiAreaGradeChanges(
  tsunami: JMATsunami,
  observations: readonly TsunamiObservation[] = tsunami.observations ?? [],
): TsunamiAreaGradeChange[] {
  const byTransition = new Map<string, TsunamiAreaGradeChange>()
  for (const area of tsunami.areas) {
    const from = area.lastGrade
    if (from === undefined || from === area.grade) continue
    if (area.grade === 'Unknown') continue
    const key = `${from}>${area.grade}`
    const found = byTransition.get(key)
    if (found) found.areas.push(area)
    else byTransition.set(key, {
      from,
      to: area.grade,
      areas: [area],
      raised: isTsunamiGradeRaised(from, area.grade),
    })
  }
  const changes = [...byTransition.values()]
  for (const change of changes) {
    change.areas = sortAreasForCardDisplay(change.areas, [...observations])
  }
  return changes.sort((a, b) => {
    if (a.raised !== b.raised) return a.raised ? -1 : 1
    if (GRADE_PRIORITY[a.to] !== GRADE_PRIORITY[b.to]) return GRADE_PRIORITY[b.to] - GRADE_PRIORITY[a.to]
    return GRADE_PRIORITY[b.from] - GRADE_PRIORITY[a.from]
  })
}

/**
 * 等級の短い呼び名。読み上げの文と、カードで等級の移り変わりを示す行が共有する。
 *
 * カードの等級カードが掲げる見出し（`TsunamiTab` の `GRADE_LABEL`）は「津波予報（若干の
 * 海面変動）」のように正式名を出すが、文の中へ差し込むには長い。**両方を別々に持たないこと**
 * ―― 読み上げと表示で等級の呼び名が食い違う。
 */
export const TSUNAMI_GRADE_SHORT_LABEL: Record<TsunamiGrade, string> = {
  MajorWarning: '大津波警報',
  Warning: '津波警報',
  Watch: '津波注意報',
  Forecast: '津波予報',
  Unknown: '',
}

/**
 * 等級が `from` から `to` へ上がったか（引き上げ）。下がった場合と、動いていない場合は false。
 *
 * **等級の重さの比較はこの関数に閉じる。** 読み上げの動詞（「引き上げられました」/
 * 「切り替えられました」）・組の並び順・カードの表示がいずれもこの向きで決まるので、
 * 呼び出し側でそれぞれ比べ直すと、等級を増やしたときに片方だけ漏れる。
 */
export function isTsunamiGradeRaised(from: TsunamiGrade, to: TsunamiGrade): boolean {
  return GRADE_PRIORITY[to] > GRADE_PRIORITY[from]
}

/** 区域を既読の記録で引くときのキー。`matchesArea` と同じく区域コードを優先する。 */
export function tsunamiAreaKey(area: TsunamiArea): string {
  return area.code ?? area.name
}

/**
 * まだ声にしていない等級変化だけを残す。
 *
 * **`LastKind` は変化した瞬間だけでなく、その後の続報にも載り続ける。** 2024 年能登半島地震の
 * 01/02 02:30 で解除された福岡県日本海沿岸・佐賀県北部は、02:31・02:33 の続報でも
 * 「津波予報／前回は津波注意報」のまま届いた。電文の事実だけで読み上げると同じ文を 3 回読む。
 *
 * 記録は「その区域について最後に声にした等級」。今回の等級と一致していれば読み終えている。
 * 等級がさらに動けば（予報 → 注意報へ引き上げ等）値が変わるので、もう一度読む。
 *
 * @param changes `tsunamiAreaGradeChanges` の結果
 * @param spoken 声にした等級の記録（区域キー → 等級）
 */
export function selectUnspokenAreaGradeChanges(
  changes: readonly TsunamiAreaGradeChange[],
  spoken: ReadonlyMap<string, TsunamiGrade>,
): TsunamiAreaGradeChange[] {
  const result: TsunamiAreaGradeChange[] = []
  for (const change of changes) {
    const areas = change.areas.filter(area => spoken.get(tsunamiAreaKey(area)) !== area.grade)
    if (areas.length > 0) result.push({ ...change, areas })
  }
  return result
}

/**
 * 声にした等級変化を既読へ移す。
 *
 * **呼ぶのは発話を始める瞬間だけ。** 受信時や読み上げ文を組んだ時点で進めると、上位の読み上げに
 * 割り込まれて鳴らなかった変化が既読になり、二度と伝わらない（観測点の記憶と同じ規約。理由は
 * `useLiveEventHandler` の `spokenObsHeightRef` の宣言箇所）。
 */
export function rememberAreaGrades(
  changes: readonly TsunamiAreaGradeChange[],
  spoken: Map<string, TsunamiGrade>,
): void {
  for (const change of changes) {
    for (const area of change.areas) spoken.set(tsunamiAreaKey(area), area.grade)
  }
}

/**
 * 前回・今回の観測情報をマージする。VTSE51②/VTSE52（観測のみ電文）が届くたびに
 * 全観測点が再送されるとは限らないため、区域コード+観測点名をキーに upsert し、
 * 今回の電文に含まれない観測点は前回の値を保持する。
 */
export function mergeTsunamiObservations(
  prev: TsunamiObservation[] | undefined,
  next: TsunamiObservation[] | undefined,
): TsunamiObservation[] | undefined {
  if (!next || next.length === 0) return prev
  if (!prev || prev.length === 0) return next

  const key = (o: TsunamiObservation) => `${o.districtCode ?? o.districtName ?? ''}|${o.name}`
  const merged = new Map<string, TsunamiObservation>()
  for (const o of prev) merged.set(key(o), o)
  for (const o of next) merged.set(key(o), o)
  return Array.from(merged.values())
}

// ============================================================
// カード表示順（区域の並べ替え）
//
// 読み上げ（`ttsText.ts`）とカード（`TsunamiTab`）は**同じ並び順を使う**。
// 食い違うと、読み上げに合わせたカードの追従スクロールが上下交互に往復する
// （詳細は docs/spec/audio-tts-spec.md §4）。そのためカード専用ではなく
// ここに置き、双方から参照する。
// ============================================================

/**
 * 観測情報が属する津波予報区（districtCode/districtName）を発表区域（area.code/area.name）に紐づける。
 * code が双方にあれば code を優先。無ければ name で照合する。
 */
export function matchesArea(obs: TsunamiObservation, area: TsunamiArea): boolean {
  if (obs.districtCode && area.code) return obs.districtCode === area.code
  return !!obs.districtName && obs.districtName === area.name
}

/** 予想波高ごとの区域グループ（カードの波高見出しの単位）。 */
export interface TsunamiHeightGroup {
  heightLabel: string | null
  areas: TsunamiArea[]
}

/**
 * 読み上げ・表示に使える予想波高を持つか。
 *
 * **`maxHeight` の有無では判定しない。** 電文の解析（`dmdataParser`）は数値が取れれば
 * `maxHeight` を作るが、値が 0 で条件（「巨大」等）も無いときは `description` が空文字になる。
 * オブジェクトの有無で見ると、カードは波高なしとして扱うのに読み上げは波高ありとして扱い、
 * **その区域がどちらの文にも現れない**（黙って落ちる）。判定はここに一本化する。
 */
export function hasForecastHeight(area: TsunamiArea): boolean {
  return !!area.maxHeight?.description
}

/**
 * 同一階級内で、予想波高（maxHeight.description）が連続して一致する区域を1グループにまとめる。
 * 電文内の区域順序は維持し、離れた位置にある同じ波高の区域まではまとめない。
 */
function groupAreasByHeight(areas: TsunamiArea[]): TsunamiHeightGroup[] {
  const groups: { heightLabel: string | null; areas: TsunamiArea[] }[] = []
  for (const area of areas) {
    const label = hasForecastHeight(area) ? area.maxHeight!.description : null
    const last = groups[groups.length - 1]
    if (label && last && last.heightLabel === label) {
      last.areas.push(area)
    } else {
      groups.push({ heightLabel: label, areas: [area] })
    }
  }
  return groups
}

/** 観測波高の深刻さを比べるのに必要な部分だけを抜いた形。 */
export interface ObservedHeightRank {
  value: number
  /** 気象庁が「○m以上」と発表した観測値（観測施設の観測可能範囲の超過・機器の被災）。 */
  over?: boolean
}

/**
 * 観測波高を「深刻な順」に比べる。降順ソートの比較関数として使う（負なら a が先）。
 *
 * **`over`（「○m以上」）は値の大小より先に見る。** 「○m以上」が示すのは真の波高の
 * *下限* だけで、上限は無い。確定値と大小で並べると 8.5m以上 が 9.0m の下に来るが、
 * 真値は 8.5m以上 の方が高いことも十分あり（2011年の潮位計はこの形で飽和・被災した）、
 * 防災情報の並びとしては過小評価の側に倒れる。上限が無いものを上に置く。
 *
 * この規則は、値が小さい `over` を確定値の大きな観測より上に置く（0.2m以上 が 5.0m より
 * 上に来る）。観測可能範囲が 0.2m の潮位計は実在しないため実用上は起きないが、
 * 上流データが想定外の形で来たときはこの並びになる。
 *
 * 同じ区分・同値なら 0 を返す（呼び出し側の安定ソートで元の順序＝電文順を保つ）。
 */
export function compareObservedHeightDesc(a: ObservedHeightRank, b: ObservedHeightRank): number {
  if (!!a.over !== !!b.over) return a.over ? -1 : 1
  return b.value - a.value
}

/**
 * 観測波高の表示文字列に「以上」（観測可能範囲の超過）を必要なだけ補う。
 *
 * `description` は over のとき既に「以上」を含む（`dmdataParser` が `${value}m以上` を組む）ため、
 * 記号や語を重ねると「>8.5m以上」のような二重表記になる。一方で電文が `height.condition` を
 * 持つ経路では `description` がその文字列に置き換わって「以上」が落ちうるので、含まないときだけ補う。
 *
 * **数字を含まない `description` には足さない。** `condition` には「巨大」のような数値化されない語が
 * 入りうる（`dmdataParser.test.ts` の実電文相当フィクスチャにある形）ので、機械的に繋ぐと
 * 「巨大以上」という読めない語になる。その場合は語自体が確定していないことを伝えているため、
 * `over` の印を落としてでも文字列を壊さない方を採る。
 *
 * 数字の判定は**全角も数える**。`over` が立つのは JSON 経路だけで、そこが自前で組む表記
 * （`${value}m以上`）は半角だが、`condition` は電文由来の文字列がそのまま入るため全角が来うる
 * （`ttsText.ts` の `tsunamiHeightToSpeech` が同じ理由で両方を扱う）。ASCII だけを見ると
 * 「８．５ｍ」のような表記で「以上」が黙って落ちる。
 *
 * **観測波高を人に見せる・読み上げる経路はすべてこれを通すこと。** 片方だけ通すと、地図には
 * 「以上」が出てカードと読み上げには出ない、という食い違いになる。
 */
export function overSuffixedHeight(height: { description: string; over?: boolean }): string {
  if (!height.over) return height.description
  if (height.description.includes('以上')) return height.description
  if (!/[\d０-９]/.test(height.description)) return height.description
  return `${height.description}以上`
}

// 区域に紐づく観測点のうち、最も深刻な実測値（height）を返す。実測値を持つ観測点が無ければ null。
// 深刻さの規則は compareObservedHeightDesc に集約する（並び順と代表値の選び方を食い違わせない）。
function maxObservedHeight(area: TsunamiArea, observations: TsunamiObservation[]): ObservedHeightRank | null {
  let max: ObservedHeightRank | null = null
  for (const obs of observations) {
    if (!obs.height || !matchesArea(obs, area)) continue
    const candidate: ObservedHeightRank = { value: obs.height.value, over: obs.height.over }
    if (!max || compareObservedHeightDesc(candidate, max) < 0) max = candidate
  }
  return max
}

// 波高グループ内で、観測データ（実測値）がある区域を上に、無い区域を下にまとめる。
// 観測データがある区域同士は実測波高の深刻な順（compareObservedHeightDesc）に並べ、
// 実測値未確定（到達時刻のみ等）の区域は観測データありの中で最下位に置く。
// いずれも同点の場合・観測データが無い区域同士は電文順（安定ソート）を維持する。
function sortAreasByObservation(areas: TsunamiArea[], observations: TsunamiObservation[]): TsunamiArea[] {
  const withObservation: TsunamiArea[] = []
  const withoutObservation: TsunamiArea[] = []
  for (const area of areas) {
    if (observations.some(o => matchesArea(o, area))) withObservation.push(area)
    else withoutObservation.push(area)
  }

  const sortedWithObservation = withObservation
    .map((area, index) => ({ area, index, height: maxObservedHeight(area, observations) }))
    .sort((a, b) => {
      if (a.height && b.height) {
        const byHeight = compareObservedHeightDesc(a.height, b.height)
        if (byHeight !== 0) return byHeight
        return a.index - b.index
      }
      if (a.height && !b.height) return -1
      if (!a.height && b.height) return 1
      return a.index - b.index
    })
    .map(({ area }) => area)

  return [...sortedWithObservation, ...withoutObservation]
}

/**
 * カードが描画する区域の並び順を、波高グループの構造を保ったまま返す。
 * カードは波高ごとに見出しを挟むため、平坦化していない形が必要。
 */
export function groupAreasForCardDisplay(
  areas: TsunamiArea[],
  observations: TsunamiObservation[],
): TsunamiHeightGroup[] {
  return groupAreasByHeight(areas).map(group => ({
    ...group,
    areas: sortAreasByObservation(group.areas, observations),
  }))
}

/**
 * カードが実際に描画する区域の並び順（波高グループ化＋グループ内の観測順）を平坦に返す。
 *
 * **読み上げの区域列挙もこの順に揃える**（`ttsText.ts`）。観測が入り始めた続報では
 * 電文順（気象庁の地理順）とこの順が乖離するため、読み上げが電文順のままだと
 * 追従スクロールが 1 チャンクごとに上下へ往復する。
 */
export function sortAreasForCardDisplay(areas: TsunamiArea[], observations: TsunamiObservation[]): TsunamiArea[] {
  return groupAreasForCardDisplay(areas, observations).flatMap(group => group.areas)
}

/**
 * 等級カードをまたいだ、カードが描く区域の通し順を返す。
 *
 * `sortAreasForCardDisplay` は**1 つの等級の中**の並びしか決めない（カードが等級ごとに分かれて
 * いるため）。等級が混ざった区域の一覧を「カードで上から見える順」に並べたいときはこちらを使う。
 * 等級混じりのまま `sortAreasForCardDisplay` へ渡すと、波高の見出しで等級をまたいで束ねてしまい、
 * 注意報の区域が警報の区域より上に来ることがある。
 *
 * 上位から何件かだけを採る用途（通知の本文・スクロールの送り先）では、この違いがそのまま
 * 「カードの先頭に無い区域を代表として挙げる」形で現れる。
 *
 * `GRADES_IN_CARD_ORDER` に無い等級の区域は落ちる。カード（`TsunamiTab`）も等級ごとに
 * 絞り込んで描くので**カードと同じ振る舞い**だが、電文の解析（`dmdataParser` / `p2pquake`）が
 * 既知の 5 値へ正規化することに依存している。正規化を緩めるなら両方を併せて見直すこと。
 */
export function sortAreasAcrossGradesForCardDisplay(
  areas: readonly TsunamiArea[],
  observations: readonly TsunamiObservation[],
): TsunamiArea[] {
  const all = [...observations]
  const ordered: TsunamiArea[] = []
  for (const grade of GRADES_IN_CARD_ORDER) {
    const inGrade = areas.filter(a => a.grade === grade)
    if (inGrade.length === 0) continue
    ordered.push(...sortAreasForCardDisplay(inGrade, all))
  }
  return ordered
}

/**
 * 観測点をカードが描画する順に並べる。
 *
 * カードの入れ子をそのまま辿る ―― 等級カード → 予想波高の見出し → 区域
 * （`sortAreasAcrossGradesForCardDisplay`）→ 区域内は電文の並び → 区域に紐づかない観測点
 * （「沖合観測」のカード）を最後に置く。
 *
 * **読み上げの観測点列挙もこの順に揃える**（→ [`ttsText.ts`] の
 * `tsunamiObservationUpdateToSegments`）。区域の並びで既に踏んでいるのと同じ罠で、読み上げが
 * 波高の深刻な順に読むとカード上を上下に往復する。**どの観測点を読むかは深刻な順で選び、
 * どの順で読むかはこの関数で決める** ―― 選抜と並び順は別物として分ける。
 *
 * **渡すのはカードが持っている観測点の全体**（`mergeTsunamiObservations` 済みのもの）。
 * 今回の電文が運んできた分だけを渡してはいけない ―― 区域の並びは「その区域の最大波高」で決まる
 * ため（`sortAreasForCardDisplay`）、部分再送の電文（既報の観測点を載せない続報）だけで並べると
 * 観測を持たない区域として後ろへ回り、カードの並びと逆転する。読み上げたい部分集合は、返って
 * きた並びから呼び出し側が絞り込む。
 *
 * 同じ観測点が複数の区域に一致しうる経路ではカードが行を 2 つ描くが、並び順としては最初に
 * 現れた位置を採る（読み上げは 1 回しか読まないため）。
 *
 * 置いたかどうかはオブジェクトの同一性で見るので、**入力に同じ参照が 2 回入っていない前提**。
 * `mergeTsunamiObservations` は区域と観測点名でキー化するため現状は満たしている。
 */
export function sortObservationsForCardDisplay(
  observations: readonly TsunamiObservation[],
  areas: readonly TsunamiArea[],
): TsunamiObservation[] {
  const placed = new Set<TsunamiObservation>()
  const ordered: TsunamiObservation[] = []
  for (const area of sortAreasAcrossGradesForCardDisplay(areas, observations)) {
    for (const obs of observations) {
      if (placed.has(obs) || !matchesArea(obs, area)) continue
      placed.add(obs)
      ordered.push(obs)
    }
  }
  // どの区域にも紐づかない観測点（沖合の観測点）はカードでも最後に来る。
  for (const obs of observations) if (!placed.has(obs)) ordered.push(obs)
  return ordered
}
