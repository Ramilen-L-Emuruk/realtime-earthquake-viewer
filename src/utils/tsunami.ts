import type { JMATsunami, TsunamiArea, TsunamiEstimation, TsunamiEstimationCondition, TsunamiGrade, TsunamiObservation, TsunamiObservationCondition, TsunamiWarningComment } from '../types/earthquake'
import { formatTimeMin } from './formatters'
import { log } from './logger'

/**
 * 等級の重さ。値が大きいほど深刻。
 *
 * **等級の上下を比べるときは、必ずこの表を通すこと。** 同じ並びを呼び出し側で書き写すと、
 * `Record<TsunamiGrade, number>` の型検査が効かなくなり、等級を増やしたときのキーの
 * 取りこぼしが素通りする（`as const` で書き写した表を引くと `undefined` が返るが、
 * 数値との比較は例外を出さずに偽へ倒れるため、画面にも記録にも痕跡が残らない）。
 *
 * 引き上げの判定だけは `isTsunamiGradeRaised` に用意してある。
 */
export const GRADE_PRIORITY: Record<TsunamiGrade, number> = {
  MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0,
}

/**
 * カードが等級カードを積む順（重い等級が上）。
 *
 * カード・読み上げの双方がこの並びに従う。`GRADE_PRIORITY` の降順そのものなので、等級を
 * 増やしたときに片方だけ漏れることがない。
 *
 * **`'Unknown'` の扱いだけは両者で違う。** カードはそのまま使い、読み上げ（`ttsText` の
 * `GRADE_ORDER`）は取り除いてから使う —— 等級の呼び名が空文字なので、読むと主語を欠いた文になる
 * （理由は向こうのコメント）。並びそのものは共有したままなので、等級を増やしたときの漏れは起きない。
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
 * 引き継ぎを断ると、その基準を渡す先が「カードに無い観測点」で並べ替えた結果を使うことになる
 * （渡す先の一覧は `tsunamiCardOrderBasis` の宣言箇所。ここで数え上げないのは、経路が増えたときに
 * 取りこぼすため）。逆も同じで、片方だけ緩めれば黙って食い違う。
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
 * 履歴からの復元（初回ロード・リロード）で、同一イベントの過去報を取り込み直す。
 *
 * 復元は最新の 1 報だけを画面へ載せるため、その報が持たない値は画面から落ちる。ここでは
 * **ライブ受信が続報のたびに行っているのと同じことを、古い報から順にやり直す**
 * （{@link mergeTsunamiReports} を畳む）。
 *
 * **引き継ぐ項目の一覧はここに置かない。** 表を 2 箇所に持つと、片方だけに項目が足されて
 * 「ライブ受信では出るのにリロードすると消える」形の欠落が生まれる —— 実際、かつては両方が
 * 規則を各自で書いており、説明文で戒めるだけだったため、レビュー 3 巡で別々の項目が 3 回漏れた。
 * 何をどう引き継ぐかは {@link mergeTsunamiReports} を見ること。
 *
 * 同一イベントの判定は `eventId`、`eventId` を持たない経路（P2PQuake）では `id` の一致で行う。
 * 別の津波の値を引き継ぐと、発表中の津波を無関係な期限で消したり、別の津波の本文を出したりする。
 *
 * @param latest 画面へ載せる最新報
 * @param reports 同じ取得結果に含まれる報（`latest` を含んでよい）
 */
export function withInheritedTsunamiFacts(latest: JMATsunami, reports: JMATsunami[]): JMATsunami {
  const sameEvent = reports.filter(r => r !== latest
    && (latest.eventId ? r.eventId === latest.eventId : !r.eventId && r.id === latest.id))
  // **発表時刻を読めない報は候補から外す。** 並べ替えの比較が NaN になると順序が定まらず、
  // 「最も新しいもの」を選んだつもりで時刻の読めない報を掴む。期限の側（`latestValidDateTime`）が
  // 新旧を判定できない報を候補から外すのと同じ扱い。
  const older = sameEvent
    .filter(r => Number.isFinite(new Date(r.time).getTime()))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())

  // **ライブ受信が続報のたびに行っているのと同じことを、古い報から順にやり直す。**
  // 規則を書き写さずに `mergeTsunamiReports` を畳むので、引き継ぐ項目が増えても
  // ここを直す必要が無い。
  //
  // 取消・解除の報には継がない。値が空なのは**その報の内容**であって、運ばないからではない
  // （継ぐと解除されたはずの区域が復活する）。
  let merged = latest
  if (!latest.cancelled && older.length > 0) {
    let acc: JMATsunami | undefined
    for (const r of older) {
      if (r.cancelled) continue
      acc = acc ? mergeTsunamiReports(acc, r) : r
    }
    if (acc) merged = mergeTsunamiReports(acc, latest)
  }

  // **期限の引き継ぎ自体は畳み込みの中で済んでいる**（`mergeTsunamiReports` が
  // `latestValidDateTime([current, next])` を段ごとに計算する）。ここに残すのは最後の検分だけ。
  //
  // 読めない期限は落とす。残すと「期限を持つ津波」の顔をしたまま以後の比較がすべて偽へ倒れ、
  // 表示は続くのに失効の予約も積まれない。落とせば standard 版の 24 時間フェイルセーフが働く。
  if (latestValidDateTime([merged])) return merged
  return merged.validDateTime ? { ...merged, validDateTime: undefined } : merged
}

/**
 * 避難行動の文が前報のまま取り残される形を記録する。
 *
 * バナーの行動指示の行は固定付加文（VTSE41）の 1 行目を出す（→ `evacuationActionLine`）。
 * 固定付加文は主題の鍵ごとに上書きするので、**等級を動かす報がその付加文を持たないと、
 * 前の等級に向けた避難の呼びかけが画面のいちばん目立つ位置に残り続ける。**
 *
 * アーカイブにある VTSE41 全 91 通（2024-01-01 以降）では 1 通も無かった形。**走査したのは
 * VTSE41 型の電文だけ**なので、他の種別が等級を動かす経路はこの数え上げに含まれていない
 * （判定自体は種別を問わないので、そちらで起きても記録は出る）。画面には何の痕跡も
 * 出ないため、記録だけは残す。
 */
function warnIfActionLineGoesStale(current: JMATsunami, next: JMATsunami): void {
  const ACTION_LINE_KEY = 'VTSE41'
  if (next.areas.length === 0) return
  if (next.warningComments?.some(c => c.key === ACTION_LINE_KEY)) return
  if (!current.warningComments?.some(c => c.key === ACTION_LINE_KEY)) return
  // 区域の鍵は `mergeTsunamiAreas` と同じ取り方にする（別々に決めると照合が静かにずれる）。
  const before = new Map(current.areas.map(a => [a.code || a.name, a.grade]))
  const moved = next.areas.some(a => {
    const was = before.get(a.code || a.name)
    return was !== undefined && was !== a.grade
  })
  if (!moved) return
  log.warn(`[tsunami] 等級が動いた報に避難行動の付加文がありません（前報の文がバナーに残ります）: id=${next.id}`)
}

/**
 * 続報 1 通を取り込む。**引き継ぎの規則はここが唯一の置き場所**で、ライブ受信
 * （`useEarthquakes` の tsunami ケース）も履歴からの復元（{@link withInheritedTsunamiFacts}）も
 * この関数を通る。
 *
 * **規則を 2 箇所に書いてはいけない。** かつては両方が同じ引き継ぎを各自で書いており、
 * 説明文で「同じものをここでも引き継ぐこと」と戒めるだけだった。結果、項目を足すたびに
 * 片方へ入れ忘れ、**ライブ受信では出るのにリロードすると消える**という形の欠落が
 * 繰り返し見つかった（2026-09-11 のレビューで 3 巡にわたり別々の項目が漏れていた）。
 *
 * | 項目 | 引き継ぎ方 |
 * |---|---|
 * | 区域（`areas`）と区域の潮位観測点 | 顔ぶれと等級は新報が正。観測点だけ種別に応じて継ぐ（{@link mergeTsunamiAreas}）。区域を伝えていない報では前報の区域をそのまま残す |
 * | 観測点（`observations`） | 観測点ごとに upsert（{@link mergeTsunamiObservations}）。沿岸と沖合は別の集合なので、片方だけの報で上書きしない |
 * | 固定付加文（`warningComments`） | 主題ごとに束ねる（{@link mergeTsunamiWarningComments}） |
 * | 有効期限（`validDateTime`） | 発表時刻が新しく、日時として読めるもの（{@link latestValidDateTime}） |
 * | 本文・観測時点・自由付加文・沿岸への推定 | 新報が持たなければ前報 |
 * | それ以外 | 新報の値（名乗り `infoName` もここ。その報が何を出しているかの表示なので引き継がない） |
 *
 * **新しく引き継ぐ項目を足すときは、この表とここだけを直す。** リプレイの初期状態
 * （`dmdataReplay.ts`）は最新 1 報へ畳まず全報を順に流す作りなので、触らなくてよい。
 *
 * @param current いま表示している津波（＝これまでの報を取り込んだ結果）
 * @param next 新しく届いた報
 */
export function mergeTsunamiReports(current: JMATsunami, next: JMATsunami): JMATsunami {
  warnIfActionLineGoesStale(current, next)
  return {
    ...next,
    // 区域が空の報（観測のみの続報）は等級を伝えていないので、前報の区域をそのまま残す。
    areas: next.areas.length > 0
      ? mergeTsunamiAreas(current.areas, next.areas, next.carriesForecastStations)
      : current.areas,
    observations: mergeTsunamiObservations(current.observations, next.observations),
    warningComments: mergeTsunamiWarningComments(current.warningComments, next.warningComments),
    validDateTime: latestValidDateTime([current, next]),
    bodyText: next.bodyText ?? current.bodyText,
    observationDateTime: next.observationDateTime ?? current.observationDateTime,
    freeText: next.freeText ?? current.freeText,
    estimations: next.estimations ?? current.estimations,
  }
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
 *   - `eventId` が両者で欠落する場合は原因地震（`sourceEarthquakes[0]`）の `originTime` で代替判定
 *     （DMDATA XML の Earthquake 要素経由でのみ機能する。P2PQuake API v2 の
 *     生 552 電文には `earthquake` 相当のフィールドが無く `sourceEarthquakes` は
 *     常に undefined になるため、標準版ではこのフォールバックは実質発火しない）
 *     **比べるのは 1 件目だけ** —— 電文は原因地震を複数持ちうるが、2 件目以降は続報で
 *     増減するので同一性の鍵にならない
 *   - 上記いずれの識別子も取れない場合は false（保守的に続報扱い）。
 *     標準版はこの経路がデフォルトで、別地震の新規津波でもタブが奪われない
 *     （grade 格上げか手動タブ切替に依存する）
 */
export function isTsunamiNewFire(next: JMATsunami, current: JMATsunami | undefined): boolean {
  if (!current) return true
  if (current.cancelled || current.cancelledAt) return true
  if (current.eventId && next.eventId) return current.eventId !== next.eventId
  // 識別子を持たない経路（P2PQuake）のフォールバック。**比べるのは 1 件目だけ。**
  // 複数の地震が原因のとき、2 件目以降は続報で増減しうるので同一性の鍵にならない。
  const currentOrigin = current.sourceEarthquakes?.[0]?.originTime
  const nextOrigin = next.sourceEarthquakes?.[0]?.originTime
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
 * **引き上げの判定はこの関数に閉じる。** 読み上げの動詞（「引き上げられました」/
 * 「切り替えられました」）・組の並び順・カードの表示がいずれもこの向きで決まるので、
 * 呼び出し側でそれぞれ比べ直すと、等級を増やしたときに片方だけ漏れる。
 *
 * 引き下げ・据え置きの判定はこの関数では表せないため `GRADE_PRIORITY` を直に引く
 * （表そのものが単一情報源で、書き写さない限り漏れは生じない）。
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

// ============================================================
// 観測状態（電文の Condition）
// ============================================================

/** `FirstHeight/Condition` に現れる語と、写す先のフラグ。 */
const FIRST_HEIGHT_CONDITIONS: Record<string, keyof TsunamiObservationCondition> = {
  // 全角・半角の「1」が混在しうるため両方を引けるようにしておく（電文解説資料の表記は全角）。
  '第１波識別不能': 'firstWaveUnidentifiable',
  '第1波識別不能': 'firstWaveUnidentifiable',
  '欠測': 'firstHeightMissing',
}

/** `MaxHeight/Condition` に現れる語と、写す先のフラグ。 */
const MAX_HEIGHT_CONDITIONS: Record<string, keyof TsunamiObservationCondition> = {
  '欠測': 'maxHeightMissing',
  '微弱': 'weak',
  '観測中': 'observing',
  '重要': 'important',
}

/** `jmx_eb:TsunamiHeight@condition` に現れる語と、写す先のフラグ。 */
const HEIGHT_CONDITIONS: Record<string, keyof TsunamiObservationCondition> = {
  '上昇中': 'rising',
}

/**
 * 沿岸への推定（`Estimation/Item/MaxHeight/Condition`）に現れる語と、写す先のフラグ。
 *
 * **観測点の表を流用しないこと。** 推定値なので語は「観測中」ではなく「推定中」で、
 * 混ぜると電文に無い語を引き当てるうえ、未知語の記録も効かなくなる。
 */
const ESTIMATION_MAX_HEIGHT_CONDITIONS: Record<string, keyof TsunamiEstimationCondition> = {
  '推定中': 'estimating',
  '重要': 'important',
}

/** 区域の予想波高（`Forecast/Item/MaxHeight/Condition`）に現れる語と、写す先のフラグ。 */
const FORECAST_MAX_HEIGHT_CONDITIONS: Record<string, 'forecastHeightImportant'> = {
  '重要': 'forecastHeightImportant',
}

/**
 * 知らない語を記録した組（`欄名:語`）。観測情報は数分おきに再送され同じ語が何度も来るので、
 * 1 度だけ出す。地図に出せない観測点名の記録（`useTsunamiLayerData`）と同じ間引き方。
 */
const reportedUnknownConditions = new Set<string>()

function collectConditionFlags<K extends string>(
  raw: string | undefined,
  table: Record<string, K>,
  field: string,
  into: Partial<Record<K, boolean>>,
): void {
  if (!raw) return
  // 併記の区切りは全角スペース（電文解説資料 Ⅱ.12）。半角・改行が混ざっても読めるよう広く割る。
  for (const token of raw.split(/[\s　]+/)) {
    if (!token) continue
    const flag = table[token]
    if (flag) {
      into[flag] = true
      continue
    }
    // **黙って捨てない。** 気象庁が語を増やしたとき、表示も読み上げも何も言わないまま
    // その状態を無視することになる（2025-07-24 に「欠測」が増えたときが実際にそれだった）。
    const key = `${field}:${token}`
    if (reportedUnknownConditions.has(key)) continue
    reportedUnknownConditions.add(key)
    log.warn(`[tsunami] ${field} に未知の語があります（無視します）: ${token}`)
  }
}

/**
 * 気象庁電文の `Condition` を観測状態（{@link TsunamiObservationCondition}）へ写す。
 *
 * **併記を前提に分割して照合する。** `MaxHeight/Condition` は複数の内容を全角スペースで
 * 並べる（電文解説資料 Ⅱ.12 の事例に「重要 欠測」「微弱 欠測」「観測中 欠測」がある）ため、
 * 文字列の完全一致では読み取れない。
 *
 * **入力は 3 つに分かれる**（下の引数）。どこに現れた状態かで意味が違うため、まとめずに渡す。
 *
 * 何も立たなければ `undefined` を返す（大多数の観測点は状態を持たない）。
 */
export function parseTsunamiObservationCondition(input: {
  /** `FirstHeight/Condition`。 */
  firstHeight?: string
  /** `MaxHeight/Condition`。 */
  maxHeight?: string
  /** `jmx_eb:TsunamiHeight@condition`。 */
  heightCondition?: string
}): TsunamiObservationCondition | undefined {
  const condition: TsunamiObservationCondition = {}
  collectConditionFlags(input.firstHeight, FIRST_HEIGHT_CONDITIONS, 'Observation/FirstHeight/Condition', condition)
  collectConditionFlags(input.maxHeight, MAX_HEIGHT_CONDITIONS, 'Observation/MaxHeight/Condition', condition)
  collectConditionFlags(input.heightCondition, HEIGHT_CONDITIONS, 'Observation/TsunamiHeight@condition', condition)
  return Object.keys(condition).length > 0 ? condition : undefined
}

/**
 * 沿岸への推定の `MaxHeight/Condition` を {@link TsunamiEstimationCondition} へ写す。
 *
 * 観測点側と分けているのは語彙が違うため（「観測中」ではなく「推定中」）。併記の割り方と
 * 未知語の記録は共通の {@link collectConditionFlags} が受け持つ。
 */
export function parseTsunamiEstimationCondition(maxHeight: string | undefined): TsunamiEstimationCondition | undefined {
  const condition: TsunamiEstimationCondition = {}
  collectConditionFlags(maxHeight, ESTIMATION_MAX_HEIGHT_CONDITIONS, 'Estimation/MaxHeight/Condition', condition)
  return Object.keys(condition).length > 0 ? condition : undefined
}

/**
 * 区域の予想波高の `MaxHeight/Condition` から「重要」を読む。
 *
 * 立つ語は「重要」1 つだけだが、未知語を記録する仕組みを観測・推定と揃えたいので
 * 同じ経路を通す（電文が語を増やしたときに黙って捨てないため）。
 */
export function parseTsunamiForecastHeightImportant(maxHeight: string | undefined): boolean | undefined {
  const flags: Partial<Record<'forecastHeightImportant', boolean>> = {}
  collectConditionFlags(maxHeight, FORECAST_MAX_HEIGHT_CONDITIONS, 'Forecast/MaxHeight/Condition', flags)
  return flags.forecastHeightImportant || undefined
}

/**
 * その観測点が欠測かどうか。
 *
 * **「まだ観測できていない（観測中）」と「もう観測できない（欠測）」を見分ける唯一の述語。**
 * カード・地図・読み上げはすべてこれを通すこと ―― `height` の有無で振り分けると、欠測の
 * 観測点が「到達確認・波高は観測中」として扱われる（気象庁が 2025-07-24 に欠測の発表を
 * 始めたのは、まさにその取り違えを防ぐため）。
 *
 * 第1波と最大波のどちらが欠測でも真。**どちらが欠測かで扱いを変えたい場合は
 * `condition` を直接見る**（到達時刻だけ判っていて波高が落ちた状態と、到達自体が判らない
 * 状態は別物）。
 */
export function isObservationMissing(obs: TsunamiObservation): boolean {
  return !!(obs.condition?.maxHeightMissing || obs.condition?.firstHeightMissing)
}

/**
 * 観測点の行に出すバッジの語（左から順に並べる）。
 *
 * **観測の性質を述べる場所**で、波高そのものは {@link observationHeightText} が受け持つ。
 * 分けているのは、欠測が数値と同時に来る（電文解説資料 Ⅱ.12 事例 6）ため——1 つの欄に
 * 押し込むとどちらかが消える。
 *
 * 「到達確認」を欠測の観測点に付けないこと。第1波が欠測なら到達したかどうかも判っていない。
 */
export function observationBadges(obs: TsunamiObservation): string[] {
  const missing = isObservationMissing(obs)
  const badges: string[] = []
  if (obs.height) badges.push('実測')
  else if (obs.arrivalTime) badges.push('到達確認')
  else if (missing) return ['欠測']
  else badges.push('到達確認')
  if (missing) badges.push('欠測')
  // 水位が上昇中なら、いま見えている波高が最大とは限らないことを伝える。
  if (obs.condition?.rising) badges.push('上昇中')
  // 「重要」は基準を超えた値に気象庁が付ける印。語をそのまま出しても何が重要なのか
  // 伝わらないので、意味の側を書く。**基準は沿岸と沖合で違う**（→ importantBadgeText）。
  if (obs.condition?.important) badges.push(importantBadgeText(!!obs.offshore))
  // 数値が出ていなくても、電文が「津波警報に相当する津波を観測している」と言っている場合がある。
  //
  // **「〜の基準超」と同じ形にしない。** 上の 2 つは実測値が基準を超えた事実だが、こちらは
  // 数値が出ていないまま気象庁が置いた信号で、意味の階層が違う。同じ行に並ぶので、形を揃えると
  // 「弱いほうの基準だけ超えた」と読める。読み上げ（「津波警報に相当する津波を観測しています」）と
  // 語を揃え、隣の波高欄の「観測中」と合わせて「相当する津波を観測中・数値は未確定」と読ませる。
  if (isWarningLevelWhileObserving(obs)) badges.push('津波警報相当を観測')
  return badges
}

/**
 * 「観測中」のまま、津波警報に相当する津波を観測しているか。
 *
 * **値の変化では捉えられない信号。** 気象庁は大津波警報の津波予報区に対応する沖合の観測点で、
 * 沿岸で推定される高さが大津波警報の基準（3m 超）に届かないとき `Condition` を「観測中」に
 * したまま数値を出さない。そのとき **`Revise` に「更新」と書くことで、津波警報に相当する
 * 津波（1m 超）を観測していることを示す**（電文解説資料 Ⅱ.13 1-1-2-2-2。資料自身が
 * 「注意する必要がある」と名指ししている）。
 *
 * 「観測中」の中身は変わりようがない（`DateTime` も高さも出ない）ので、この組み合わせは
 * 気象庁が意図して置いたときにしか現れない。**アプリが値の変化から導くことは原理的にできない。**
 *
 * **沿岸の観測点（VTSE51）には当てない。** 同じ「観測中」でも、資料が注意を書いているのは
 * 沖合の側だけ。仕組みとしては沿岸でも成り立ちそうに見えるが、電文が定めていないことを
 * 先回りして読むと、気象庁が言っていない警告をアプリが作ることになる。
 */
export function isWarningLevelWhileObserving(obs: TsunamiObservation): boolean {
  return !!obs.offshore && !!obs.condition?.observing && obs.maxHeightRevise === '更新'
}

/**
 * 「重要」（`MaxHeight/Condition`）を利用者向けに言い換えた語。
 *
 * **基準が電文で違う。** 語をそのまま「重要」と出しても何が重要なのか伝わらないので意味を
 * 書くが、そのとき電文ごとの基準を混ぜると、実際より軽い／重い印象を与える。
 *
 * | 出所 | 電文解説資料 | 基準 |
 * |---|---|---|
 * | 沿岸の潮位観測点（VTSE51） | Ⅱ.12 1-2-2-2 | 大津波警報のみ |
 * | 沖合の潮位観測点（VTSE52） | Ⅱ.13 1-1-2-2-2 | 大津波警報・津波警報 |
 * | 沿岸への推定（VTSE52） | Ⅱ.13 1-2-2-3 | 大津波警報・津波警報 |
 *
 * 区域の予想波高（`Forecast`）の「重要」は**意味そのものが違う**ため、ここではなく
 * {@link forecastHeightImportantBadge} が受け持つ。
 */
export function importantBadgeText(offshore: boolean): string {
  return offshore ? '大津波警報・津波警報の基準超' : '大津波警報の基準超'
}

/**
 * 区域の予想波高に付く「重要」の語。
 *
 * 観測・推定の「重要」（実際に高い津波を観測・推定した）とは違い、**予想の書き換え**を指す
 * —— 大津波警報の区域で予想波高が初めて数値になった、または上方修正された
 * （電文解説資料 Ⅱ.11 1-1-2-4）。同じ語で出すと取り違えるので分けている。
 */
export function forecastHeightImportantBadge(): string {
  // 「更新」では方向が伝わらない（この印は引き下げでは付かない）。かといって「引き上げ」だけでは、
  // 「巨大」から「10m超」へ数値になっただけの報まで「高さが上がった」と言うことになる。
  // 電文の定義（初めて数値で発表／上方修正）をそのまま書く。
  return '予想の高さを数値で発表・引き上げ'
}

/**
 * 沿岸への推定の行に出すバッジ（左から順に）。
 *
 * 観測点の {@link observationBadges} と分けているのは、推定には「欠測」「上昇中」が無く、
 * 代わりに数値を出せない理由が「推定中」である点が違うため。
 */
export function estimationBadges(est: TsunamiEstimation): string[] {
  const badges: string[] = []
  if (est.condition?.important) badges.push(importantBadgeText(true))
  return badges
}

/**
 * 沿岸への推定の行の右端に出す波高。数値が無いときは、無い理由（電文の語）を出す。
 *
 * 「推定中」は**数値を出せるほど大きくない**ことを気象庁が明示した状態で、`DateTime` と
 * `jmx_eb:TsunamiHeight` の代わりに現れる（電文解説資料 Ⅱ.13 1-2-2-3）。空欄にすると、
 * 値が無いのが電文の判断なのか読み落としなのか画面から分からない。
 */
export function estimationHeightText(est: TsunamiEstimation): string {
  if (est.maxHeight?.description) return est.maxHeight.description
  return est.condition?.estimating ? '推定中' : ''
}

/**
 * 到達時刻の代わりに出す語。時刻が入っていれば空を返す（呼び出し側が時刻を出す）。
 *
 * 気象庁は「津波は観測したが第1波の到達時刻が不明瞭で観測できなかった」場合に
 * `FirstHeight/Condition` へ「第１波識別不能」と載せる（電文解説資料 Ⅱ.12）。**到達そのものは
 * 確定している**ので到達確認の扱いは変えず、時刻の欄にだけ理由を出す。空欄にすると、時刻を
 * 出せない理由が電文にあることが画面から読めない。
 */
export function observationArrivalFallbackText(obs: TsunamiObservation): string {
  if (obs.arrivalTime) return ''
  return obs.condition?.firstWaveUnidentifiable ? '到達時刻不明' : ''
}

/**
 * 最大波を観測した時刻（`MaxHeight/DateTime`）を、行の時刻欄に添える語。
 *
 * **波高の数値だけでは、それがいつの観測値かが分からない。** 続報で値が変わらないとき、
 * 観測し直して同じだったのか前の値が据え置かれているのかは、この時刻でしか読み取れない。
 *
 * **第1波の到達時刻と紛れないよう「最大波」と冠する。** 同じ行に 2 つの時刻が並ぶため、
 * 裸の時刻を足すとどちらがどちらか分からなくなる。
 *
 * 波高を出していない行では返さない —— 時刻だけが残ると、値の無い観測点に何かを観測した
 * ように見える。**日時として読めない時刻も同じく返さない**（「最大波 」とラベルだけが残る）。
 */
export function observationMaxHeightTimeText(obs: TsunamiObservation): string {
  if (!obs.maxHeightDateTime || !obs.height) return ''
  const hm = formatTimeMin(obs.maxHeightDateTime)
  return hm ? `最大波 ${hm}` : ''
}

/**
 * 観測点の行の右端に出す文字列。数値が無いときは、無い理由（電文の語）を出す。
 *
 * **欠測のときは空を返す。** バッジ（{@link observationBadges}）が既に「欠測」を言っているため、
 * 重ねると同じ語が 1 行に 2 回出る。
 *
 * 「観測中」を欠測の観測点へ出さないこと——「これから値が出る」と読めてしまう。
 */
export function observationHeightText(obs: TsunamiObservation): string {
  if (obs.height) return overSuffixedHeight(obs.height)
  // 「微弱」は欠測と併記されうる（同 事例 7）。そのときも気象庁が波高について述べた語はこちら。
  if (obs.condition?.weak) return '微弱'
  if (isObservationMissing(obs)) return ''
  // `condition.observing`（電文が「観測中」と明示した場合）に専用の分岐は要らない。
  // 数値も微弱も欠測も無い状態は、電文が「観測中」と書いた場合と、`MaxHeight` 要素そのものが
  // 無い場合（これまでの最大波を観測していない）の 2 通りだが、**利用者にとっては同じ**
  // ――どちらもこれから値が出る。フラグは電文を読み違えていないかを確かめる側（テスト）で使う。
  return '観測中'
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

/**
 * 続報の区域一覧をマージする。**区域の顔ぶれと等級は新報が正**で、前報から継ぐのは
 * 区域ごとの潮位観測点（`stations` ＝満潮時刻・津波到達予想時刻）だけ。
 *
 * **区域そのものをキー単位で upsert してはいけない。** 実電文では津波警報等（VTSE41）も
 * 津波情報（VTSE51）も区域一覧を毎回全量で載せており、一部解除は「区域が電文から消える」形で
 * 届く。upsert すると、その消えた区域が前報から復活して解除済みの等級を出し続ける。
 *
 * 一方 `stations` を運ぶのは VTSE51 だけで、VTSE41 は区域一覧だけを持って観測点を載せない。
 * 新報の区域をそのまま採ると、警報が届いた瞬間に満潮時刻が画面から消える（24 秒後の次の
 * 満潮情報まで欠ける）。そこで区域コード・区域名で前報を引き当てて継ぐ。
 *
 * **継ぐかどうかは電文種別で決める。中身では決められない。** 「新報の区域に観測点が無い」には
 * 「運ばない種別だから無い」（VTSE41 → 継ぐ）と「運ぶ種別なのに気象庁が出さなくなった」
 * （VTSE51 → 継がない）の 2 通りがあり、区域や観測点を見ても区別できない。後者は等級が
 * 津波予報まで下がったときに実際に起きる（実電文で確認）ので、一律に継ぐと解除間際の画面に
 * 古い到達予想時刻が残る。判定材料は `JMATsunami.carriesForecastStations`。
 *
 * @param nextCarriesStations 新報が観測点を運ぶ種別か（`JMATsunami.carriesForecastStations`）。
 *   種別を判定できない経路（P2PQuake）は undefined で、安全側＝継ぐ。
 */
export function mergeTsunamiAreas(
  prev: TsunamiArea[] | undefined,
  next: TsunamiArea[],
  nextCarriesStations: boolean | undefined,
): TsunamiArea[] {
  if (nextCarriesStations) return next
  if (!prev || prev.length === 0) return next

  // `??` ではなく `||` にするのは、空文字のコードで別の区域どうしが同じ鍵へ落ちるのを避けるため。
  const key = (a: TsunamiArea) => a.code || a.name
  const prevByKey = new Map<string, TsunamiArea>()
  for (const a of prev) prevByKey.set(key(a), a)

  return next.map(area => {
    if (area.stations && area.stations.length > 0) return area
    const carried = prevByKey.get(key(area))?.stations
    return carried && carried.length > 0 ? { ...area, stations: carried } : area
  })
}

/**
 * 固定付加文を主題ごとに束ねる。同じ鍵が来たら置き換え、別の鍵なら足す
 * （`mergeTsunamiObservations` と同じ作り）。
 *
 * **1 つの枠を報どうしで奪い合わせてはいけない。** 電文種別ごとに別の話をしているので、
 * 上書きすると最後に届いた報の注記しか残らない —— 実電文では津波警報の避難呼びかけが
 * 1 分後の満潮時刻の報で消えていた。鍵の作り方は {@link TsunamiWarningComment.key}。
 *
 * 並びは {@link WARNING_COMMENT_ORDER} の主題順。表に無い鍵は末尾へ、初めて現れた順で並ぶ
 * （気象庁が情報名を増やしても落ちない）。
 */
export function mergeTsunamiWarningComments(
  prev: TsunamiWarningComment[] | undefined,
  next: TsunamiWarningComment[] | undefined,
): TsunamiWarningComment[] | undefined {
  if (!next || next.length === 0) return prev
  if (!prev || prev.length === 0) return sortWarningComments(next)

  const merged = new Map<string, TsunamiWarningComment>()
  for (const c of prev) merged.set(c.key, c)
  for (const c of next) merged.set(c.key, c)
  return sortWarningComments(Array.from(merged.values()))
}

/**
 * 固定付加文の表示順。**鍵そのものは電文から導く**ので、この表に無い鍵が来ても落ちない
 * （末尾に、初めて現れた順で並ぶ）。
 *
 * 等級に対する行動の呼びかけを先頭に置くのは、いちばん重い内容だから。途中から受信を始めた
 * ときでも（アーカイブ再生・アプリの起動が遅れた場合）順序が変わらないよう、到着順ではなく
 * この表で決める。
 */
export const WARNING_COMMENT_ORDER: readonly string[] = [
  'VTSE41',
  'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報',
  'VTSE51|津波観測に関する情報',
  'VTSE52',
]

/**
 * 避難行動の付加文（津波警報等が運ぶ定型文）から、行動指示の 1 行を採る。
 *
 * バナーはこれまでアプリが書いた短い文（「海岸・河川から直ちに離れてください」）を出していた。
 * **気象庁の文があるならそちらを出す**（→ CLAUDE.md「利用者へ出す語を気象庁の表現と揃える」）。
 *
 * **採るのは 1 行目が文として完結しているときだけ。** 実電文では報によって 1 行目の形が違い、
 * 「ただちに避難してください。」で始まる報と、「＜津波警報＞」のような小見出しで始まる報がある。
 * 小見出しをそのまま行動指示の位置に出すと、何をすべきか伝わらない。採れないときは呼び出し側が
 * アプリの文へ戻す。
 *
 * **どちらの形になるかを等級から当てにいかないこと。** 2024-01-01 能登半島地震では、最高等級が
 * 同じ津波警報の報でも 16:12 は「ただちに避難してください。」・20:30 は「＜津波警報＞」で始まった。
 * 2026-04-20 三陸沖（最高等級は津波警報）も前者の形。**等級と形は対応していない**ので、
 * 行そのものを見る。
 */
export function evacuationActionLine(comments?: TsunamiWarningComment[]): string | undefined {
  const text = comments?.find(c => c.key === 'VTSE41')?.text
  const first = text?.split('\n')[0]?.trim()
  return first && first.endsWith('。') ? first : undefined
}

function sortWarningComments(comments: TsunamiWarningComment[]): TsunamiWarningComment[] {
  const rank = (c: TsunamiWarningComment) => {
    const i = WARNING_COMMENT_ORDER.indexOf(c.key)
    return i < 0 ? WARNING_COMMENT_ORDER.length : i
  }
  // 安定ソートなので、表に無い鍵どうしは元の並び（＝初めて現れた順）を保つ。
  return [...comments].sort((a, b) => rank(a) - rank(b))
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
 * 記号や語を重ねると「>8.5m以上」のような二重表記になる。含まないときだけ補う。
 *
 * **数字を含まない `description` には足さない。** 機械的に繋ぐと「巨大以上」のような読めない語に
 * なる。数値化されない語（「巨大」「高い」）が入るのは区域の予想波高だが、そちらは `over` を
 * 持たないため現状ここへは来ない ―― 経路が増えたときの歯止めとして残してある。
 * その場合は語自体が確定していないことを伝えているため、`over` の印を落としてでも
 * 文字列を壊さない方を採る。
 *
 * 数字の判定は**全角も数える**。いまこの関数に届く `description` は両経路とも半角
 * （実電文の `TsunamiHeight` は `description="０．５ｍ"` と全角だが、`dmdataParser` の
 * `toHalfWidthHeightDesc` が半角へ直す）。それでも全角を残しているのは防御で、
 * ASCII だけを見る形にすると「８．５ｍ」のような表記が入った瞬間に「以上」が黙って落ちる。
 * なお `ttsText.ts` の `tsunamiHeightToSpeech` が全角を扱うのは別の理由——あちらは
 * `headline`（電文の文章。全角のまま）にも通すため。
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
