// standard 版（P2PQuake）のリプレイ用データ取得。
//
// DMDSS 版（dmdataReplay.ts）と同じ ReplayFetchResult を返すため、useReplayController からは
// 取得元の違いを意識せずに使える。取得元としての違いは 3 点:
//
// 1. 単位が日次アーカイブ（tar.gz）ではなく日付指定の REST クエリ。`/jma/quake`・`/jma/tsunami`
//    の since_date・until_date は yyyyMMdd 単位で時刻まで絞れないため、日ごとに取ってから
//    再生窓で絞る
// 2. EEW を流さない。P2PQuake には EEW（code 556）を過去日付で引く口が無い（`/jma` 配下に
//    無く、`/history` は日付指定できず 1 週間以上前を辿れない）。standard 版のリプレイ中の
//    EEW は、従来どおり強震モニタの hypoInfo 検出（useKyoshinRealtime）が担う
// 3. レート制限（`/jma` は 10 リクエスト/分・IP 毎）がある。同じ日を何度も引かないよう日単位で
//    キャッシュする。再生窓が 1 時間ずつ先へ延びても、日をまたぐまでは通信が発生しない
//
// 日付の境界はローカル時刻で判定する。P2PQuake は日本のサービスで、電文の time も JST 表記の
// ローカル時刻として解釈している（p2pquake.ts の readTime 参照）ため、アプリ全体の前提に揃える。

import type { ReplayEntry, ReplayFetchResult, QuakeHistoryResult } from '../types/replay'
import type { RawP2PEvent } from './p2pquake'
import type { JMAQuake } from '../types/earthquake'
import { convertEvent, fetchJmaArchiveRaw } from './p2pquake'
import { sameQuakeEntry } from '../utils/quakeMerge'
import { getAreaPrefIndexCache } from '../utils/stationCoords'
import { log } from '../utils/logger'
import { createSkipCounter, UNKNOWN_SKIP_DAY } from '../utils/telegramLoss'

/** 1 ページの取得件数（API 側の上限）。 */
const PAGE_SIZE = 100

/** 履歴復元で 1 回に引く電文数（API 側の上限と同じ）。 */
const HISTORY_PAGE_SIZE = 100

/**
 * 1 日あたりのページ取得上限。超えたら例外にして再生を始めない。
 *
 * 黙って打ち切ると「その時間帯は静かだった」のか「取りこぼした」のかを見分けられなくなる。
 * 欠けたまま再生するより止める方を選ぶ。電文が特に多い 2024-01-01（能登半島地震）でも
 * 地震情報は 130 件だったので、500 件はその 3 倍以上の余裕がある。
 */
const MAX_PAGES_PER_DAY = 5

/**
 * 1 回の取得で触れてよい日数の上限。
 *
 * 呼び出し側の窓は「本編 1 時間」「初期状態 24 時間」なので、日をまたいでも 2 日に収まる。
 * それを超える要求は範囲指定の誤りとみなし、レート制限を焼き切る前に止める。
 */
const MAX_DAYS_PER_FETCH = 3

interface DayResult {
  entries: ReplayEntry[]
  /** 内部型へ変換できず捨てた電文の数。 */
  skippedByDay: ReadonlyMap<string, number>
}

// 日付（yyyyMMdd）→ その日ぶんの全電文。
const dayCache = new Map<string, Promise<DayResult>>()
/**
 * 当日ぶんの控えを捨てるまでの時間。
 *
 * **過去の日は不変なので控えを永続させてよいが、当日は違う。** その日の電文はこれからも増える
 * ので、最初の取得結果を持ち続けると**後から届いた電文が二度と見えない**（再生もされない）。
 *
 * レート制限（`/jma` は 10 リクエスト/分）があるので毎回取り直すことはできない。1 分は
 * 「1 日ぶんを 2 資源ぶん引く」（2 リクエスト）が上限に収まる間隔で、再生の粒度（窓 1 時間）
 * から見ても十分細かい。
 */
const TODAY_CACHE_TTL_MS = 60_000

/** その日の控えを作った時刻（当日ぶんの寿命の判定にだけ使う）。 */
const dayCachedAt = new Map<string, number>()

/**
 * 日 → その日についてこれまでに報告した取りこぼしの件数。
 *
 * **日を鍵にしても要る。** 合流する側（`addTelegramLoss`）は**別々の取得を集める前提で足す**
 * ので、同じ日を 2 度返すと 2 倍に数えられる。同じ日を読み直しただけなら新しい破損ではない。
 *
 * **「報告済みの日」の集合ではなく件数で持つ。** 当日ぶんは控えが古びると取り直すので、
 * 後から届いた電文が壊れていれば件数が増える —— 集合だと増えた分を報告できず、
 * 「その日はもう見た」として黙る。差分（増えた分）だけを報告すれば、読み直しでは 0 件、
 * 増えたときはその増分だけが出る。
 *
 * 一度これを撤去して「鍵があるから不要」としたが、そのときは合流が上書きだった。**合流の
 * 規則を変えるときは、ここも併せて見ること。**
 */
const reportedSkipCounts = new Map<string, number>()

export function clearP2PReplayCache(): void {
  dayCache.clear()
  dayCachedAt.clear()
  reportedSkipCounts.clear()
}

export async function fetchP2PReplayEvents(fromTime: Date, toTime: Date): Promise<ReplayFetchResult> {
  const days = enumerateDays(fromTime, toTime)
  // 日は直列に読む。本編と初期状態は同時に走るため、ここまで並列にすると 1 回の再生開始で
  // 十数本のリクエストが同時に飛び、レート制限（10 リクエスト/分）に触れやすくなる。
  // 日数は多くて 2〜3、しかも 2 回目以降はキャッシュから返るので、直列でも待ちはほぼ増えない。
  const results: DayResult[] = []
  for (const day of days) results.push(await loadDay(day))

  const from = fromTime.getTime()
  const to = toTime.getTime()
  const entries = results
    .flatMap(r => r.entries)
    .filter(e => {
      const t = e.replayTime.getTime()
      return t >= from && t < to
    })
    .sort((a, b) => a.replayTime.getTime() - b.replayTime.getTime())

  // **同じ日を二度数えない**（本編と初期状態は同じ日を読む）。合流する側は別々の取得を集める
  // 前提で足すので、キャッシュから返しただけの日を報告すると 2 倍に数えられる。
  // **当日ぶんは寿命が切れると取り直すので、そのとき `loadDay` がこの台帳からも外す**
  // （後から届いた電文の破損を数えられるようにするため）。
  //
  // 数える対象は「その日ぶんの取得で読めなかった電文」であり、再生窓の内側に限らない。
  // 読めなかった電文は時刻も読めないことが多く、窓の内外を判定できないため。結果として
  // 窓の外の破損まで数えることがあるが、少なく見せるより多く申告する側に倒している。
  const skippedByDay = new Map<string, number>()
  for (const r of results) {
    for (const [day, n] of r.skippedByDay) {
      const reported = reportedSkipCounts.get(day) ?? 0
      if (n <= reported) continue
      skippedByDay.set(day, (skippedByDay.get(day) ?? 0) + (n - reported))
      reportedSkipCounts.set(day, n)
    }
  }

  return { entries, skippedByDay, failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0 }
}

/** from〜to がまたぐ日（ローカル日付）を yyyyMMdd で列挙する。to は含まない。 */
function enumerateDays(fromTime: Date, toTime: Date): string[] {
  const days: string[] = []
  const cursor = startOfDay(fromTime)
  // to はキュー投入の上限（`< to`）なので、ちょうど 00:00 のときにその日を取りに行かない
  // よう 1ms 手前で丸める。取っても捨てるだけだが、無駄な 1 日ぶんの通信になる。
  const last = startOfDay(new Date(toTime.getTime() - 1))
  while (cursor.getTime() <= last.getTime()) {
    if (days.length >= MAX_DAYS_PER_FETCH) {
      throw new Error(`リプレイの取得範囲が広すぎます（${MAX_DAYS_PER_FETCH} 日以内）`)
    }
    days.push(toDateParam(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function toDateParam(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function loadDay(dateParam: string): Promise<DayResult> {
  const cached = dayCache.get(dateParam)
  // **当日ぶんだけ寿命で捨てる。** 判定は「いま」の日付で行う —— 再生時刻ではない。
  // 控えが古びるかどうかは配信元にこれから電文が増えるかで決まり、それは実時間の話。
  const isToday = dateParam === toDateParam(new Date())
  const staleToday = isToday && (Date.now() - (dayCachedAt.get(dateParam) ?? 0)) > TODAY_CACHE_TTL_MS
  if (cached && !staleToday) return cached
  const promise = fetchDay(dateParam)
  dayCache.set(dateParam, promise)
  dayCachedAt.set(dateParam, Date.now())
  // 失敗した Promise を残すと、以後そのセッション中は同じ日が常にキャッシュ済みの失敗を返し、
  // ネットワークが復旧しても再取得されない（dmdataReplay の downloadArchive と同じ理由）。
  // この catch はキャッシュ掃除専用で、エラー自体は返した promise 経由で呼び出し元へ伝わる。
  //
  // 消す前に自分自身かどうかを確かめる。停止して別の日で再開すると、古い取得が後から失敗して
  // 戻ってくることがあり、日付だけで消すと新しいセッションの正常なキャッシュを巻き添えにする。
  promise.catch(() => {
    if (dayCache.get(dateParam) === promise) dayCache.delete(dateParam)
  })
  return promise
}

async function fetchDay(dateParam: string): Promise<DayResult> {
  const [quake, tsunami] = await Promise.all([
    fetchAllPages('quake', dateParam),
    fetchAllPages('tsunami', dateParam),
  ])
  // **同じ日の 2 資源なので足す**（別々の電文を数えているので重複しない）。
  const skippedByDay = new Map<string, number>()
  const total = (quake.skippedByDay.get(dateParam) ?? 0) + (tsunami.skippedByDay.get(dateParam) ?? 0)
  if (total > 0) skippedByDay.set(dateParam, total)
  return { entries: [...quake.entries, ...tsunami.entries], skippedByDay }
}

/**
 * 1 日ぶんを古い順に全ページ取得する。
 *
 * ページは直列に辿る。offset ページングは前ページの結果を見てから次を判断する必要があり、
 * 並列にしても総リクエスト数は減らないため（むしろ空ページを余計に叩く）。
 */
async function fetchAllPages(resource: 'quake' | 'tsunami', dateParam: string): Promise<DayResult> {
  const entries: ReplayEntry[] = []
  // **この関数は 1 日ぶんを担当する**（`dateParam`）ので、取りこぼしはすべてその日に付く。
  const skipCounter = createSkipCounter()
  for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
    const raws = await fetchJmaArchiveRaw(resource, {
      sinceDate: dateParam,
      untilDate: dateParam,
      order: 1,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    for (const raw of raws) {
      // 種別そのものが読めない電文は「正常なフィルタ」ではなく破損。無言で捨てると検知できない。
      if (typeof raw?.code !== 'number') {
        log.warn(`[replay] code を読めない電文をスキップ date=${dateParam} resource=${resource}`)
        skipCounter.add(dateParam)
        continue
      }
      // 再生対象外の種別は取りこぼしではない（`/jma` 配下に EEW は無いため通常は 0 件だが、
      // 応答に想定外の種別が混ざったときに正常なフィルタを損失として数えないようにする）。
      if (!isReplayableCode(raw.code)) continue
      const entry = toEntry(raw)
      if (entry) entries.push(entry)
      else skipCounter.add(dateParam)
    }
    if (raws.length < PAGE_SIZE) return { entries, skippedByDay: skipCounter.toMap() }
  }
  throw new Error(
    `${dateParam} の電文が多すぎて全件を取得できません（${resource} が ${MAX_PAGES_PER_DAY * PAGE_SIZE} 件超）`,
  )
}

/** この経路で再生する電文か（551 地震情報・552 津波予報）。 */
function isReplayableCode(code: unknown): boolean {
  return code === 551 || code === 552
}

function toEntry(raw: RawP2PEvent): ReplayEntry | null {
  const event = convertEvent(raw)
  // convertEvent は壊れた電文で null を返す。種別は isReplayableCode で先に絞ってあるが、
  // 型を確定させるためここでも確認する。
  if (!event || (event.kind !== 'quake' && event.kind !== 'tsunami')) return null
  const replayTime = new Date(event.time)
  // 読めない時刻はイベントキューも捨てるが（`EventQueue` の `push`）、あちらは呼び出し規約の
  // 違反として `error` に残る。**再生元の電文が壊れているのは取りこぼしとして数えたい事実**なので、
  // ここで弾いて `warn` に留める。
  if (!Number.isFinite(replayTime.getTime())) {
    log.warn(`[replay] 時刻を読めない電文をスキップ id=${event.id} time=${event.time}`)
    return null
  }
  return { payload: { kind: 'event', event }, replayTime }
}

/**
 * 指定時刻より前に発表された地震電文を集める（地震カードの履歴復元用）。
 *
 * 再生窓の取得（`fetchP2PReplayEvents`）と違い、こちらは**件数基準**で引く。ライブ接続時の
 * 履歴取得と同じ厚みのカード一覧を作るのが目的で、日単位で遡ると静かな日ほど一覧が痩せる。
 *
 * `until_date` は日単位なので、指定時刻と同じ日の「まだ発表されていない」電文が必ず混ざる。
 * これは呼び出し側ではなくここで落とす（時刻の判定を 1 箇所に閉じる）。
 *
 * 1 リクエストで済ませているのはレート制限（`/jma` は 10 リクエスト/分・IP 毎）のため。
 * 実測では 100 電文で 6 日ぶん前後を遡れる。
 *
 * 集めた電文は目標のイベント数で打ち切る。API のページングは電文単位なので、そのまま渡すと
 * 地震の多い期間ほど一覧が厚くなり、同じ設定でもバリアントで枚数が食い違う（実測では
 * standard 版だけ 84 枚、DMDSS 版は 50 枚台）。同一イベントの判定にはカードの統合と同じ
 * `sameQuakeEntry` を使う（別の物差しで数えると、統合後の枚数と合わない）。
 */
export async function fetchP2PQuakeHistory(before: Date, targetEvents: number): Promise<QuakeHistoryResult> {
  const raws = await fetchJmaArchiveRaw('quake', {
    untilDate: toDateParam(before),
    order: -1,
    limit: HISTORY_PAGE_SIZE,
  })

  // 打ち切りの前に、読める電文だけを集めて発表時刻の新しい順に整える。
  // `order: -1` を渡しているので応答は既に新しい順のはずだが、**どこで切るかを外部 API の
  // 並び順に委ねない**（並びが崩れると、古い地震で目標に達して新しい地震を落としうる）。
  const candidates: { event: JMAQuake; time: number }[] = []
  // **日ごとに数える**（理由は `utils/telegramLoss.ts` の `skippedByDay`）。この経路は
  // `offset` で遡るので日で区切られておらず、鍵には「その電文が属する日」を使う。
  const skipCounter = createSkipCounter()
  const dayOf = (raw: RawP2PEvent | undefined): string => {
    const ms = Date.parse(typeof raw?.time === 'string' ? raw.time : '')
    return Number.isFinite(ms) ? toDateParam(new Date(ms)) : UNKNOWN_SKIP_DAY
  }
  for (const raw of raws) {
    // 種別そのものが読めない電文は「正常なフィルタ」ではなく破損（fetchAllPages と同じ扱い）。
    if (typeof raw?.code !== 'number') {
      log.warn(`[replay] 履歴用電文の code を読めずスキップ until=${toDateParam(before)}`)
      skipCounter.add(dayOf(raw))
      continue
    }
    // `/jma/quake` は地震情報しか返さないが、想定外の種別が混ざったときに
    // 正常なフィルタを損失として数えないようにする。
    if (raw.code !== 551) continue
    const event = convertEvent(raw)
    if (!event || event.kind !== 'quake') {
      skipCounter.add(dayOf(raw))
      continue
    }
    const time = new Date(event.time).getTime()
    if (!Number.isFinite(time)) {
      log.warn(`[replay] 履歴用電文の時刻を読めずスキップ id=${event.id} time=${event.time}`)
      skipCounter.add(dayOf(raw))
      continue
    }
    if (time > before.getTime()) continue
    candidates.push({ event, time })
  }
  candidates.sort((a, b) => b.time - a.time)

  const quakes: JMAQuake[] = []
  // 目標の数え方に使う「イベントの代表電文」。新しい順に見るので、同じ地震の前の報は
  // 代表より後に現れる。既知と判定された電文は目標に達した後でも採る（切ると、一覧の
  // 最も古いカードだけが震度速報のまま残るなど、途中で切れた形になる）。
  const seenEvents: JMAQuake[] = []
  for (const { event } of candidates) {
    if (!seenEvents.some(e => sameQuakeEntry(e, event, getAreaPrefIndexCache()))) {
      if (seenEvents.length >= targetEvents) break
      seenEvents.push(event)
    }
    quakes.push(event)
  }

  // P2PQuake は帯（地震回数・お知らせ・南海トラフ解説情報）も長周期も配信しないので常に空。
  // 津波もここでは返さない（standard 版の津波は初期状態の担当で、遡り幅も目的が違う）。
  //
  // **カーソルは持たない**（`oldestLoadedDay`）。standard 版の「もっと見る」は日ではなく
  // `offset` で遡るので、日付で続きを指す必要がない（→ `useEarthquakes` の P2PQuake 側）。
  return {
    quakes, tsunamis: [], extras: [], skippedByDay: skipCounter.toMap(),
    failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0, hasMore: false,
    oldestLoadedDay: null,
  }
}
