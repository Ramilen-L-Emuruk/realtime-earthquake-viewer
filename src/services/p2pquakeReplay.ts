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

import type { ReplayEntry, ReplayFetchResult } from '../types/replay'
import type { RawP2PEvent } from './p2pquake'
import { convertEvent, fetchJmaArchiveRaw } from './p2pquake'
import { log } from '../utils/logger'

/** 1 ページの取得件数（API 側の上限）。 */
const PAGE_SIZE = 100

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
  skipped: number
}

// 日付（yyyyMMdd）→ その日ぶんの全電文。
const dayCache = new Map<string, Promise<DayResult>>()
// 取りこぼしを計上済みの日。本編と初期状態は同じ日を読むため、これが無いと二重に数える。
const countedSkipDays = new Set<string>()

export function clearP2PReplayCache(): void {
  dayCache.clear()
  countedSkipDays.clear()
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

  // 取りこぼしはその日を初めて読んだときだけ数える。日単位のキャッシュがあるため、
  // 同じ日を再び読んでも実際には取得していない（数えると実数より多く表示される）。
  //
  // 数える対象は「その日ぶんの取得で読めなかった電文」であり、再生窓の内側に限らない。
  // 読めなかった電文は時刻も読めないことが多く、窓の内外を判定できないため。結果として
  // 窓の外の破損まで数えることがあるが、少なく見せるより多く申告する側に倒している。
  let skipped = 0
  days.forEach((day, i) => {
    if (countedSkipDays.has(day)) return
    countedSkipDays.add(day)
    skipped += results[i].skipped
  })

  return { entries, skipped, failedArchiveUrls: [] }
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
  if (cached) return cached
  const promise = fetchDay(dateParam)
  dayCache.set(dateParam, promise)
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
  return {
    entries: [...quake.entries, ...tsunami.entries],
    skipped: quake.skipped + tsunami.skipped,
  }
}

/**
 * 1 日ぶんを古い順に全ページ取得する。
 *
 * ページは直列に辿る。offset ページングは前ページの結果を見てから次を判断する必要があり、
 * 並列にしても総リクエスト数は減らないため（むしろ空ページを余計に叩く）。
 */
async function fetchAllPages(resource: 'quake' | 'tsunami', dateParam: string): Promise<DayResult> {
  const entries: ReplayEntry[] = []
  let skipped = 0
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
        skipped++
        continue
      }
      // 再生対象外の種別は取りこぼしではない（`/jma` 配下に EEW は無いため通常は 0 件だが、
      // 応答に想定外の種別が混ざったときに正常なフィルタを損失として数えないようにする）。
      if (!isReplayableCode(raw.code)) continue
      const entry = toEntry(raw)
      if (entry) entries.push(entry)
      else skipped++
    }
    if (raws.length < PAGE_SIZE) return { entries, skipped }
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
  // Invalid Date を再生キューへ積むとディスパッチャが先頭で止まり、以後の電文が二度と
  // 発火しない（useEarthquakes の enqueueEvent の注記と同じ理由）。ここで弾いて数える。
  if (!Number.isFinite(replayTime.getTime())) {
    log.warn(`[replay] 時刻を読めない電文をスキップ id=${event.id} time=${event.time}`)
    return null
  }
  return { payload: { kind: 'event', event }, replayTime }
}
