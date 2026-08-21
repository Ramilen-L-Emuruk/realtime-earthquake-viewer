import { parseEEW, parseEarthquake, parseTsunami, parseLpgm, parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml } from './dmdataParser'
import { parseTar } from '../utils/tarParser'
import type { JMAQuake, EEWAlert, JMATsunami } from '../types/earthquake'
import { calcEEWCancelTime } from '../utils/eew'
import { gunzip } from '../utils/gzip'
import { log } from '../utils/logger'
import { authHeader } from '../utils/dmdataApiKey'
import { extractQuakeEventIdFromId } from '../utils/quakeMerge'
import type { ReplayEntry, ReplayPayload, ReplayFetchResult } from '../types/replay'

const QUAKE_TYPES = new Set(['VXSE51', 'VXSE52', 'VXSE53', 'VXSE61'])
const TSUNAMI_TYPES = new Set(['VTSE41', 'VTSE51', 'VTSE52'])
// DMD-8: VXSE43（EEW 警報）を追加。従来は archive リプレイ時に警報級 EEW が黙って
// 捨てられ、実地震シナリオ収録の警報経路が完全に欠落していた。
const EEW_TYPES = new Set(['VXSE43', 'VXSE45'])
const LPGM_TYPES = new Set(['VXSE62'])
// VYSE50=臨時情報（段階あり）、VYSE51/52=関連解説情報（段階なし）。別の型に読むため分ける。
const NANKAI_TYPES = new Set(['VYSE50'])
const COMMENTARY_TYPES = new Set(['VYSE51', 'VYSE52'])
const KOHATSU_TYPES = new Set(['VYSE60'])
// このモジュールが取り込む電文種別の全体。archive の classification には対象外の種別も
// 多数含まれるため、まずこれで絞ってから欠落を警告する（絞る前に警告すると、正常動作で
// ログが埋まって本当の異常が見えなくなる）。
const HANDLED_TYPES = new Set([
  ...QUAKE_TYPES, ...TSUNAMI_TYPES, ...EEW_TYPES, ...LPGM_TYPES,
  ...NANKAI_TYPES, ...COMMENTARY_TYPES, ...KOHATSU_TYPES,
])

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
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

  // archiveリストAPIは1回の応答で最大20件までしか返さないため、nextTokenが尽きるまで
  // cursorTokenで全ページを取得する（打ち切ると広い期間の指定で古い側のアーカイブが
  // 無言で欠落し、本震当日のデータごと消えるという事故につながる）。
  const items: ArchiveItem[] = []
  let cursorToken: string | undefined
  for (;;) {
    const params = new URLSearchParams({
      datetime: `${startDate}~${endDate}`,
      classification: 'telegram.earthquake,eew.forecast',
    })
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

          if (NANKAI_TYPES.has(headType) || COMMENTARY_TYPES.has(headType) || KOHATSU_TYPES.has(headType)) {
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

            let payload: ReplayPayload | null = null
            if (NANKAI_TYPES.has(headType)) {
              const nankai = parseNankaiFromXml(xmlText)
              if (nankai) payload = { kind: 'nankai', data: nankai }
            } else if (COMMENTARY_TYPES.has(headType)) {
              const commentary = parseNankaiCommentaryFromXml(xmlText)
              if (commentary) payload = { kind: 'nankaiCommentary', data: commentary }
            } else {
              const kohatsu = parseVyse60FromXml(xmlText)
              if (kohatsu) payload = { kind: 'kohatsu', data: kohatsu }
            }
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
          const jsonFileName = [...files.keys()].find(
            (n) => n.endsWith('.json') && n !== 'telegrams.json' && n.includes(idPrefix),
          )
          const bodyBytes = jsonFileName ? files.get(jsonFileName) : undefined
          if (!jsonFileName || !bodyBytes) {
            log.warn(`[replay] JSON 電文の本体が見つからずスキップ id=${entry.id} type=${headType}`)
            skippedCount++
            continue
          }
          const data = JSON.parse(dec.decode(bodyBytes)) as Record<string, unknown>

          let payload: ReplayPayload | null = null
          if (EEW_TYPES.has(headType)) {
            const event = parseEEW(headType, data)
            if (event) payload = { kind: 'event', event }
          } else if (QUAKE_TYPES.has(headType)) {
            const event = parseEarthquake(headType, data)
            if (event) payload = { kind: 'event', event }
          } else if (TSUNAMI_TYPES.has(headType)) {
            const event = parseTsunami(headType, data)
            if (event) payload = { kind: 'event', event }
          } else if (LPGM_TYPES.has(headType)) {
            const lpgm = parseLpgm(data)
            if (lpgm) payload = { kind: 'lpgm', data: lpgm }
          }

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
  if (items.length > 0 && failedArchiveUrls.length === items.length) {
    throw new Error(`Archive fetch failed: ${items.length} 件のアーカイブすべてを読み取れませんでした`)
  }
  if (failedArchiveUrls.length > 0) {
    log.warn(`[replay] ${items.length} 件中 ${failedArchiveUrls.length} 件のアーカイブをスキップした（残りから取り込みを継続）`)
  }
  if (skippedCount > 0) {
    log.warn(`[replay] ${skippedCount} 件の電文を取り込めなかった（範囲 ${fromTime.toISOString()}〜${toTime.toISOString()}）`)
  }
  if (items.length > 0 && entries.length === 0) {
    // アーカイブは取得できたのに 1 件も取り込めなかった状態。指定期間に本当に電文が
    // 無いだけのこともあるため例外にはしないが、UI 側は「成功」としか見えないので
    // 診断の手がかりを残す。
    log.warn(`[replay] アーカイブ ${items.length} 件を取得したが対象電文は 0 件（範囲 ${fromTime.toISOString()}〜${toTime.toISOString()}）`)
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
