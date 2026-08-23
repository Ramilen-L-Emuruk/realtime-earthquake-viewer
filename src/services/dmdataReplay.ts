import { parseEarthquake } from './dmdataParser'
import { parseTar } from '../utils/tarParser'
import type { JMAQuake, EEWAlert, JMATsunami } from '../types/earthquake'
import { calcEEWCancelTime } from '../utils/eew'
import { gunzip } from '../utils/gzip'
import { log } from '../utils/logger'
import { authHeader } from '../utils/dmdataApiKey'
import { extractQuakeEventIdFromId } from '../utils/quakeMerge'
import type { ReplayEntry, ReplayFetchResult, QuakeHistoryResult } from '../types/replay'
import { HANDLED_TYPES, QUAKE_TYPES, XML_ONLY_TYPES, buildJsonPayload, buildXmlPayload } from './dmdataTelegramPayload'
import {
  clearLiveReplayCache, fetchLiveQuakeTelegrams, fetchLiveReplayEntries, resolveLiveDates,
} from './dmdataReplayLive'

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * 読めなかった当日経路の日を、アーカイブ URL と同じ枠で数えるための識別子。
 *
 * 「読めなかった取得元」を 1 本の集合で持つのは、**全滅判定**（共通原因の検出）を成立させるため。
 * 当日経路だけ別の枠に置くと、アーカイブが全滅していても当日経路のぶんだけ分母が増えて
 * 「一部は読めた」に化け、認証切れ・全断のときに例外が上がらなくなる。
 */
function liveSourceId(date: string): string {
  return `live:${date}`
}

// ファイル名に埋め込まれた17桁タイムスタンプ（YYYYMMDDHHMMSSmmm）を UTC の Date に変換する。
// pressDateTime は秒単位で切り捨てられているため、こちらがミリ秒精度の正確な受信時刻となる。
function parseMsFromFileName(fileName: string): Date | null {
  const m = fileName.match(/_(\d{17})_/)
  if (!m) return null
  const ts = m[1]
  return new Date(Date.UTC(
    +ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8),
    +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14), +ts.slice(14, 17),
  ))
}

interface ArchiveItem {
  classification: string
  date: string
  url: string
}

interface ManifestEntry {
  id: string
  originalId?: string
  classification: string
  head: { type: string; time: string; test: boolean }
}

// 日次アーカイブのキャッシュ（URL → ファイル名マップ）
const archiveCache = new Map<string, Promise<Map<string, Uint8Array>>>()

async function downloadArchive(url: string, apiKey: string): Promise<Map<string, Uint8Array>> {
  const cached = archiveCache.get(url)
  if (cached) return cached
  const promise = (async () => {
    const res = await fetch(url, { headers: { Authorization: authHeader(apiKey) } })
    if (!res.ok) throw new Error(`Archive fetch failed: ${res.status}`)
    const gz = new Uint8Array(await res.arrayBuffer())
    const tar = await gunzip(gz)
    const files = new Map<string, Uint8Array>()
    for (const entry of parseTar(tar)) {
      files.set(entry.name, entry.content)
    }
    return files
  })()
  archiveCache.set(url, promise)
  // 失敗した Promise を残すと、以後そのセッション中は同じ URL が常にキャッシュ済みの失敗を返し、
  // ネットワークが復旧しても再取得されない。先読み（App.tsx のプリフェッチ）は clearReplayCache() を
  // 呼ばないため、一過性の障害で再生が無言のまま止まったきりになる。reject 時はキャッシュから外す。
  // この catch はキャッシュ掃除専用で、エラー自体は返した promise 経由で呼び出し元へ伝わる。
  promise.catch(() => archiveCache.delete(url))
  return promise
}

export function clearReplayCache(): void {
  archiveCache.clear()
  clearLiveReplayCache()
}

/**
 * 指定期間・指定分類のアーカイブ目録を全ページ取得する。
 *
 * archive リスト API は 1 回の応答で最大 20 件までしか返さないため、nextToken が尽きるまで
 * cursorToken で辿る（打ち切ると広い期間の指定で古い側のアーカイブが無言で欠落し、
 * 本震当日のデータごと消えるという事故につながる）。
 */
async function listArchives(
  apiKey: string,
  startDate: string,
  endDate: string,
  classification: string,
): Promise<ArchiveItem[]> {
  const items: ArchiveItem[] = []
  let cursorToken: string | undefined
  for (;;) {
    const params = new URLSearchParams({ datetime: `${startDate}~${endDate}`, classification })
    if (cursorToken) params.set('cursorToken', cursorToken)
    const listRes = await fetch(
      `https://api.dmdata.jp/v2/archive?${params.toString()}`,
      { headers: { Authorization: authHeader(apiKey) } },
    )
    if (!listRes.ok) throw new Error(`Archive list failed: ${listRes.status}`)
    const listJson = (await listRes.json()) as { status: string; items: ArchiveItem[]; nextToken?: string }
    if (listJson.status !== 'ok') throw new Error('Archive list error')
    items.push(...listJson.items)
    if (!listJson.nextToken) break
    cursorToken = listJson.nextToken
  }
  return items
}

/**
 * 目録エントリの id 先頭 7 文字に対応する JSON 本体を探す。
 *
 * 目録（telegrams.json）自身も .json なので明示的に除く。
 */
function findJsonBody(
  files: Map<string, Uint8Array>,
  idPrefix: string,
): { name: string; bytes: Uint8Array } | null {
  const name = [...files.keys()].find(
    (n) => n.endsWith('.json') && n !== 'telegrams.json' && n.includes(idPrefix),
  )
  const bytes = name ? files.get(name) : undefined
  return name && bytes ? { name, bytes } : null
}

export async function fetchDmdataReplayEvents(
  apiKey: string,
  fromTime: Date,
  toTime: Date,
): Promise<ReplayFetchResult> {
  // アーカイブは JST 日付で索引されているため、UTC 日付との差を吸収するため
  // 開始日を -1 日、終了日を +1 日して確実に対象アーカイブを含める
  const startDateObj = new Date(fromTime)
  startDateObj.setDate(startDateObj.getDate() - 1)
  const startDate = toDateStr(startDateObj)
  const endDateObj = new Date(toTime)
  endDateObj.setDate(endDateObj.getDate() + 1)
  const endDate = toDateStr(endDateObj)

  const items = await listArchives(apiKey, startDate, endDate, 'telegram.earthquake,eew.forecast')

  const dec = new TextDecoder()
  const entries: ReplayEntry[] = []

  // 取り込めなかった電文の総数。1 通ごとの詳細は log.warn / log.error に出るが、
  // 「取りこぼしがあったか」だけは最後にまとめて 1 行で分かるようにする。
  let skippedCount = 0
  // 読み取れなかったアーカイブの URL。取得・展開の失敗だけでなく、目録が無い・壊れている
  // ケースも含める。これらは「アーカイブは落ちてきたが中身を 1 通も読めない」状態であり、
  // 取得エラーと同じく丸ごと欠落する。数え漏らすと UI が無警告のまま「電文 0 件の成功」に化ける。
  const failedArchiveUrls: string[] = []

  await Promise.all(
    items.map(async (item) => {
      // アーカイブ単位で隔離する。ここを Promise.all に素通しすると、1 つのアーカイブの
      // 破損（tar/gzip の異常・CDN の一時エラー）だけで、他のアーカイブから既に読み取れた
      // 電文まで巻き添えで捨てられる。日をまたぐ期間指定ほど被害が大きくなるため、
      // 「壊れたアーカイブだけ諦めて残りは活かす」を既定にする。
      let files: Map<string, Uint8Array>
      try {
        files = await downloadArchive(item.url, apiKey)
      } catch (e) {
        log.error(`[replay] アーカイブの取得・展開に失敗したためスキップ date=${item.date} classification=${item.classification}`, e)
        failedArchiveUrls.push(item.url)
        return
      }

      const manifestBytes = files.get('telegrams.json')
      if (!manifestBytes) {
        // アーカイブは取得できたのに目録が無い＝そのアーカイブの中身を丸ごと読めない。
        // 例外にせず他のアーカイブの処理は続けるが、無言で捨てると「電文 0 件だが成功」に
        // 化けて原因が追えなくなるため、取得失敗と同じ扱いで数える。
        log.warn(`[replay] アーカイブに telegrams.json が無いためスキップ date=${item.date} classification=${item.classification}`)
        failedArchiveUrls.push(item.url)
        return
      }

      let manifest: ManifestEntry[]
      try {
        manifest = JSON.parse(dec.decode(manifestBytes))
      } catch (e) {
        // 目録自体が壊れている場合も同様に、そのアーカイブのみ諦めて他は継続する。
        log.error(`[replay] telegrams.json の解析に失敗したためスキップ date=${item.date} classification=${item.classification}`, e)
        failedArchiveUrls.push(item.url)
        return
      }

      for (const entry of manifest) {
        // head を持たないエントリ（目録の構造異常）。この判定はループ内 try の外にあるため、
        // 素通しすると TypeError がアーカイブ単位の失敗に化ける。1 件のおかしな行で
        // 他の電文まで落とさないよう、ここで弾く。
        if (!entry?.head) {
          log.warn(`[replay] head を持たない目録エントリをスキップ id=${entry?.id ?? '(不明)'}`)
          skippedCount++
          continue
        }
        if (entry.head.test) continue

        // 時刻が読めない電文をそのまま通すと replayTime が Invalid Date になり、
        // 再生キューの並べ替え・発火判定が静かに破綻する。ここで弾く。
        //
        // 文字列であることを先に確かめるのは、new Date(null) が Invalid Date ではなく
        // 1970-01-01 を返すため。数値チェックだけだと null がすり抜け、直後の範囲外判定に
        // 「ただの古い電文」として無言で吸収されてしまう（undefined は Invalid Date になる）。
        const entryTime = new Date(typeof entry.head.time === 'string' ? entry.head.time : NaN)
        if (Number.isNaN(entryTime.getTime())) {
          log.warn(`[replay] head.time が不正な電文をスキップ id=${entry.id} time=${String(entry.head.time)}`)
          skippedCount++
          continue
        }
        if (entryTime < fromTime || entryTime >= toTime) continue

        const headType = entry.head.type
        // この実装が扱わない種別はここで落とす。以降のスキップはすべて
        // 「本来あるはずのものが見つからない」異常なので、警告付きで記録する。
        // （先に絞らないと、対象外の電文が通常運転で大量に警告を出し、
        //   本当の異常が埋もれてログが役に立たなくなる）
        if (!HANDLED_TYPES.has(headType)) continue

        try {
          const idPrefix = entry.id.slice(0, 7)

          if (XML_ONLY_TYPES.has(headType)) {
            // XML 形式電文（VYSE50/51/52/60）。これらは XML パーサ（parseNankaiFromXml /
            // parseNankaiCommentaryFromXml / parseVyse60FromXml）でしか読めないため、
            // XML 版エントリ（originalId 無し）だけを拾う。
            // 実アーカイブでは確認できた全種別が XML 版と JSON 版の 2 エントリで載っていたため、
            // VYSE 系にも JSON 版が現れうる。それをここで弾かないと、JSON 版の id で .xml を
            // 探して見つからず「本体が見つからず」警告を出し続けることになる。
            if (entry.originalId) continue
            const xmlFileName = [...files.keys()].find(
              (n) => n.endsWith('.xml') && n.includes(idPrefix),
            )
            const bodyBytes = xmlFileName ? files.get(xmlFileName) : undefined
            if (!bodyBytes) {
              log.warn(`[replay] XML 電文の本体が見つからずスキップ id=${entry.id} type=${headType}`)
              skippedCount++
              continue
            }
            const xmlText = dec.decode(bodyBytes)

            const payload = buildXmlPayload(headType, xmlText)
            if (payload) {
              entries.push({ payload, replayTime: entryTime })
            } else {
              log.warn(`[replay] XML 電文のパースに失敗しスキップ id=${entry.id} type=${headType}`)
              skippedCount++
            }
            continue
          }

          // JSON 形式電文（地震・津波・EEW・VXSE62）
          //
          // manifest には同じ電文が XML 版と JSON 版の 2 エントリで載る。originalId を持つ方が
          // JSON 版（XML から変換されたもの）で、その値は元の XML エントリの id を指す。
          // ここで originalId 無しを落とすのは元の XML 側を捨てて JSON 版だけを拾うためで、
          // 同一電文の二重取り込みを防ぐ正常な重複排除。実データでは manifest の約半数が
          // これに該当するため、警告は出さない（出すと正常運転でログが埋まる）。
          if (!entry.originalId) continue
          const body = findJsonBody(files, idPrefix)
          if (!body) {
            log.warn(`[replay] JSON 電文の本体が見つからずスキップ id=${entry.id} type=${headType}`)
            skippedCount++
            continue
          }
          const jsonFileName = body.name
          const data = JSON.parse(dec.decode(body.bytes)) as Record<string, unknown>

          const payload = buildJsonPayload(headType, data)
          if (payload) {
            // ファイル名の17桁タイムスタンプ（YYYYMMDDHHMMSSmmm）はミリ秒精度の実受信時刻。
            // pressDateTime は秒単位で切り捨てられているため、ファイル名から ms を優先的に取得する。
            const replayTime = parseMsFromFileName(jsonFileName) ?? new Date((data.pressDateTime as string | undefined) ?? entryTime.toISOString())
            entries.push({ payload, replayTime })
          } else {
            log.warn(`[replay] 電文のパースに失敗しスキップ id=${entry.id} type=${headType}`)
            skippedCount++
          }
        } catch (e) {
          // 1 通の破損（JSON 破損・パーサ内の例外）で全体を落とさない。以前は個別の
          // try/catch が無く、壊れた電文が 1 通あるだけで Promise.all ごと reject し、
          // その日を含む期間の再生が丸ごと不可能になっていた。
          log.error(`[replay] 電文の取り込みに失敗しスキップ id=${entry.id} type=${headType}`, e)
          skippedCount++
        }
      }
    }),
  )

  // 全アーカイブが読めなかった場合だけは例外にする。認証エラー・権限不足・ネットワーク全断など、
  // 個別の破損ではなく共通の原因であることがほとんどで、これを握り潰すと UI には
  // 「成功したが電文 0 件」としか見えない。1 件でも読めていれば部分的成功として扱う。
  // ここまでに積まれたのはアーカイブ 1 日ぶんの失敗だけ。全滅判定の分母に使うので、
  // 当日経路が識別子を足す前に数えておく。
  let failedSourceDays = failedArchiveUrls.length

  // アーカイブがまだ生成されていない日（当日、および前日ぶんの生成待ち）を別経路で埋める。
  // 日次アーカイブは JST 日単位で当日ぶんが作られないため、これが無いと今日を指定した
  // 再生が電文 0 件になり、前日をまたぐ指定では今日側だけが静まり返る。
  // 担当日はアーカイブ一覧が返した date と重ならないので、同じ電文を二重に取り込むことはない。
  const liveDates = resolveLiveDates(fromTime, toTime, items.map(i => i.date))
  if (liveDates.length > 0) {
    try {
      const live = await fetchLiveReplayEntries(apiKey, fromTime, toTime, liveDates)
      entries.push(...live.entries)
      skippedCount += live.skipped
      failedArchiveUrls.push(...live.failedSources)
    } catch (e) {
      // アーカイブ 1 日ぶんが読めなかったときと同じ扱いにする。ここで素通しすると、当日の
      // 一覧 API が一度こけただけで、既に読めているアーカイブ側の電文まで巻き添えで捨てられる
      // （この関数は本編と初期状態の 2 回、`Promise.all` で呼ばれるため再生自体が始まらなくなる）。
      log.error(`[replay] 当日経路の取得に失敗したためスキップ 日=${liveDates.join(',')}`, e)
      failedArchiveUrls.push(...liveDates.map(liveSourceId))
      failedSourceDays += liveDates.length
    }
  }

  // 取得元がすべて読めなかった場合だけ例外にする。認証エラー・権限不足・ネットワーク全断など、
  // 個別の破損ではなく共通の原因であることがほとんどで、これを握り潰すと UI には
  // 「成功したが電文 0 件」としか見えない。1 日ぶんでも読めていれば部分的成功として扱う。
  //
  // 分母を「アーカイブの本数」ではなく「取得元の日数」で取るのが要点。当日だけを指す窓
  //（本編の 1 時間）は取得元が当日経路 1 本しか無く、そこを部分成功に落とすと**電文 0 件のまま
  // 「再生中」**になってしまう。日数で数えれば、その場合はちゃんと例外になる。
  const sourceDays = items.length + liveDates.length
  if (sourceDays > 0 && failedSourceDays === sourceDays) {
    throw new Error(`Archive fetch failed: ${sourceDays} 件の取得元すべてを読み取れませんでした`)
  }

  if (failedArchiveUrls.length > 0) {
    log.warn(`[replay] 取得元 ${sourceDays} 日ぶんのうち ${failedArchiveUrls.length} 件を読めなかった（残りから取り込みを継続）: ${failedArchiveUrls.join(', ')}`)
  }
  if (skippedCount > 0) {
    log.warn(`[replay] ${skippedCount} 件の電文を取り込めなかった（範囲 ${fromTime.toISOString()}〜${toTime.toISOString()}）`)
  }
  if (items.length + liveDates.length > 0 && entries.length === 0) {
    // 取得元は引けたのに 1 件も取り込めなかった状態。指定期間に本当に電文が
    // 無いだけのこともあるため例外にはしないが、UI 側は「成功」としか見えないので
    // 診断の手がかりを残す。
    log.warn(`[replay] アーカイブ ${items.length} 件・当日経路 ${liveDates.length} 日を取得したが対象電文は 0 件（範囲 ${fromTime.toISOString()}〜${toTime.toISOString()}）`)
  }

  entries.sort((a, b) => a.replayTime.getTime() - b.replayTime.getTime())

  // 同一 replayTime のエントリを 1ms ずつずらして別ティックで発火させる。
  // ファイル名から ms を取得しているため衝突はほぼ起きないが、念のため保証する。
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].replayTime.getTime() <= entries[i - 1].replayTime.getTime()) {
      entries[i] = {
        ...entries[i],
        replayTime: new Date(entries[i - 1].replayTime.getTime() + 1),
      }
    }
  }

  return { entries, skipped: skippedCount, failedArchiveUrls }
}

// T 時点でまだ有効な電文のみを残すフィルタ（pre-window 初期状態用）
export function filterPreWindowEvents(
  entries: ReplayEntry[],
  targetTime: Date,
): ReplayEntry[] {
  // EEW は同一イベント ID の複数報をグルーピングして T 時点の有効性を判定する
  // 状態管理キーは issue.eventId（シリアル番号を含まない）に合わせる
  const eewByEventId = new Map<string, Array<{ entry: ReplayEntry; eew: EEWAlert }>>()
  const quakeByEventId = new Map<string, ReplayEntry>()
  const result: ReplayEntry[] = []

  for (const entry of entries) {
    if (entry.payload.kind !== 'event') { result.push(entry); continue }
    const ev = entry.payload.event

    if (ev.kind === 'quake') {
      const quake = ev as JMAQuake
      const eid = extractQuakeEventIdFromId(quake.id)
      if (!eid) { result.push(entry); continue }
      const existing = quakeByEventId.get(eid)
      if (!existing || entry.replayTime > existing.replayTime) {
        quakeByEventId.set(eid, entry)
      }
      continue
    }

    if (ev.kind === 'eew') {
      const eew = ev as EEWAlert
      const groupKey = eew.issue?.eventId ?? eew.id
      if (!eewByEventId.has(groupKey)) eewByEventId.set(groupKey, [])
      eewByEventId.get(groupKey)!.push({ entry, eew })
      continue
    }

    if (ev.kind === 'tsunami') {
      const tsunami = ev as JMATsunami
      if (tsunami.cancelled) continue
      if (tsunami.validDateTime && new Date(tsunami.validDateTime).getTime() <= targetTime.getTime()) continue
    }

    result.push(entry)
  }

  for (const entry of quakeByEventId.values()) result.push(entry)

  // EEW グループごとに T 時点の有効性を判定し、有効なら最新の1件だけ注入する
  for (const [, reports] of eewByEventId) {
    // キャンセル済み（解除電文あり）は全報スキップ
    if (reports.some(r => r.eew.cancelled)) continue

    // 最終報を後ろから探す
    let finalReport: { entry: ReplayEntry; eew: EEWAlert } | undefined
    for (let i = reports.length - 1; i >= 0; i--) {
      if (reports[i].eew.isFinal) { finalReport = reports[i]; break }
    }

    if (finalReport) {
      const expireAt = calcEEWCancelTime(finalReport.eew, new Date(finalReport.eew.time))
      if (expireAt.getTime() <= targetTime.getTime()) continue
      result.push(finalReport.entry)
    } else {
      // まだ最終報がない場合は最新の非最終報を1件だけ注入
      result.push(reports[reports.length - 1].entry)
    }
  }

  return result
}

/**
 * 指定時刻より前に発表された地震電文を、日次アーカイブを遡って集める（地震カードの履歴復元用）。
 *
 * 「初期状態」の取得（`fetchDmdataReplayEvents` の pre-window）と分けている理由:
 * あちらは指定時刻の時点で発表中だった津波・EEW を再現するための 24 時間で、目的も必要な
 * 遡り幅も違う。カードを厚くするために 24 時間を延ばすと、EEW アーカイブの解析まで
 * 巻き添えで増える。ここでは `telegram.earthquake` だけを読む。
 *
 * 打ち切りは**日単位**で行う。イベント数が目標に届いた時点で、それより古い日は解析しない。
 * 日の途中で切ると同一イベントの続報が分断され、震度速報だけのカードが残りうる。
 *
 * ダウンロード自体は `maxDays` ぶんを並列で走らせる。日次アーカイブは 1 日 10〜70KB と小さく、
 * 逐次に落として都度判定すると往復のぶんだけ再生開始が遅れるため（ライブの履歴取得が
 * 電文 1 通ずつ数百リクエストを投げているのに比べれば、余分な数ファイルは誤差）。
 *
 * @param before この時刻より後に発表された電文は採らない（＝再生開始時刻）
 * @param targetEvents 集めたい地震イベント数（続報は 1 件と数える）
 * @param maxDays 遡ってよい日数の上限
 */
export async function fetchDmdataQuakeHistory(
  apiKey: string,
  before: Date,
  targetEvents: number,
  maxDays: number,
): Promise<QuakeHistoryResult> {
  // アーカイブは JST 日付で索引されているため、UTC 日付との差を吸収するよう終端を +1 日する
  // （`fetchDmdataReplayEvents` と同じ理由）。
  const startObj = new Date(before)
  startObj.setDate(startObj.getDate() - maxDays)
  const endObj = new Date(before)
  endObj.setDate(endObj.getDate() + 1)
  const items = await listArchives(apiKey, toDateStr(startObj), toDateStr(endObj), 'telegram.earthquake')

  const downloaded = await Promise.all(items.map(async (item) => {
    try {
      return { date: item.date, item, files: await downloadArchive(item.url, apiKey) }
    } catch (e) {
      log.error(`[replay] 履歴用アーカイブの取得・展開に失敗 date=${item.date}`, e)
      return { date: item.date, item, files: null }
    }
  }))

  // アーカイブがまだ生成されていない日は当日経路で埋める（`fetchDmdataReplayEvents` と同じ理由）。
  // これが無いと、今日を指定した再生で「開始時刻より前の今日の地震」がカードに出ない。
  const liveDays = resolveLiveDates(startObj, new Date(before.getTime() + 1), items.map(i => i.date))

  // 新しい日から使う（カードは新しい順に並ぶため、打ち切りで欠けてよいのは古い側）。
  // アーカイブの日と当日経路の日は排他なので、日付だけで一本に並べられる。
  const sources: Array<{ date: string; archive?: typeof downloaded[number] }> = [
    ...downloaded.map(d => ({ date: d.date, archive: d })),
    ...liveDays.map(date => ({ date })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const dec = new TextDecoder()
  const quakes: JMAQuake[] = []
  const eventIds = new Set<string>()
  const failedArchiveUrls: string[] = []
  let skipped = 0
  let usedDays = 0

  for (const source of sources) {
    if (eventIds.size >= targetEvents) break
    usedDays++

    if (!source.archive) {
      // 当日経路。読めなくてもアーカイブ側の成果は活かす（アーカイブ 1 日ぶんが読めなかったときと
      // 同じ扱い）。ここで例外にすると、当日の一覧 API が一度こけただけで過去数日ぶんの
      // カードごと消える。
      try {
        const live = await fetchLiveQuakeTelegrams(apiKey, source.date, before)
        for (const quake of live.quakes) {
          quakes.push(quake)
          eventIds.add(extractQuakeEventIdFromId(quake.id) ?? quake.id)
        }
        skipped += live.skipped
      } catch (e) {
        log.error(`[replay] 履歴用の当日経路の取得に失敗 date=${source.date}`, e)
        failedArchiveUrls.push(liveSourceId(source.date))
      }
      continue
    }

    const { item, files } = source.archive
    if (!files) { failedArchiveUrls.push(item.url); continue }

    const manifestBytes = files.get('telegrams.json')
    if (!manifestBytes) {
      log.warn(`[replay] 履歴用アーカイブに telegrams.json が無いためスキップ date=${item.date}`)
      failedArchiveUrls.push(item.url)
      continue
    }
    let manifest: ManifestEntry[]
    try {
      manifest = JSON.parse(dec.decode(manifestBytes))
    } catch (e) {
      log.error(`[replay] 履歴用アーカイブの telegrams.json 解析に失敗 date=${item.date}`, e)
      failedArchiveUrls.push(item.url)
      continue
    }

    for (const entry of manifest) {
      if (!entry?.head || entry.head.test) continue
      if (!QUAKE_TYPES.has(entry.head.type)) continue
      // XML 版と JSON 版の 2 エントリで載るうち、JSON パーサで読める方だけを拾う
      // （`fetchDmdataReplayEvents` と同じ重複排除。正常動作なので警告は出さない）。
      if (!entry.originalId) continue

      const entryTime = new Date(typeof entry.head.time === 'string' ? entry.head.time : NaN)
      if (Number.isNaN(entryTime.getTime())) {
        log.warn(`[replay] 履歴用電文の head.time が不正なためスキップ id=${entry.id}`)
        skipped++
        continue
      }
      // 再生開始時刻より後に発表された電文は、その時点ではまだ存在しない。
      // アーカイブは日単位なので、当日ぶんにはこれが必ず混ざる。
      if (entryTime > before) continue

      try {
        const body = findJsonBody(files, entry.id.slice(0, 7))
        if (!body) {
          log.warn(`[replay] 履歴用電文の本体が見つからずスキップ id=${entry.id} type=${entry.head.type}`)
          skipped++
          continue
        }
        const data = JSON.parse(dec.decode(body.bytes)) as Record<string, unknown>
        const quake = parseEarthquake(entry.head.type, data)
        if (!quake) {
          log.warn(`[replay] 履歴用電文のパースに失敗しスキップ id=${entry.id} type=${entry.head.type}`)
          skipped++
          continue
        }
        quakes.push(quake)
        eventIds.add(extractQuakeEventIdFromId(quake.id) ?? quake.id)
      } catch (e) {
        log.error(`[replay] 履歴用電文の取り込みに失敗しスキップ id=${entry.id} type=${entry.head.type}`, e)
        skipped++
      }
    }
  }

  // 使おうとした日がすべて読めなかった場合だけ例外にする（認証エラー・全断などの共通原因が
  // ほとんどで、握り潰すと「履歴 0 件の成功」に化ける）。1 日でも読めていれば部分成功とする。
  if (usedDays > 0 && failedArchiveUrls.length === usedDays) {
    throw new Error(`Archive fetch failed: ${usedDays} 件の取得元すべてを読み取れませんでした`)
  }
  // 「取得元が 1 つも無い」は取得の失敗として現れないため、例外にも損失にもならない。
  // 黙って空を返すと「静かな期間だった」と区別が付かないので、手がかりだけは残す。
  if (sources.length === 0) {
    log.warn(`[replay] 履歴用の取得元が 1 件も見つからなかった（範囲 ${toDateStr(startObj)}〜${toDateStr(endObj)}）`)
  } else if (quakes.length === 0) {
    log.warn(`[replay] 履歴用に ${usedDays} 日ぶんを読んだが地震電文は 0 件（${before.toISOString()} 以前）`)
  }
  log.info(`[replay] 地震カードの履歴を復元 電文=${quakes.length} イベント=${eventIds.size} 参照日数=${usedDays}（うち当日経路=${liveDays.length}）`)
  return { quakes, skipped, failedArchiveUrls }
}
