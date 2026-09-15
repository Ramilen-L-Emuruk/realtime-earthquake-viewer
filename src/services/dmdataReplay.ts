import { parseEarthquakeFromXml, parseTsunamiFromXml } from './dmdataParser'
import { parseTar } from '../utils/tarParser'
import type { JMAQuake, EEWAlert, JMATsunami } from '../types/earthquake'
import { selectActiveEews } from '../utils/eew'
import { gunzip } from '../utils/gzip'
import { log } from '../utils/logger'
import { authHeader } from '../utils/dmdataApiKey'
import { extractQuakeEventIdFromId, QUAKE_ISSUE_PRIORITY } from '../utils/quakeMerge'
import { latestValidDateTime } from '../utils/tsunami'
import type { ReplayEntry, ReplayPayload, ReplayFetchResult, QuakeHistoryResult } from '../types/replay'
import {
  HANDLED_TYPES, QUAKE_TYPES, TSUNAMI_TYPES, HISTORY_EXTRA_TYPES, historyExtraKey,
  buildXmlPayload, CLASSIFICATIONS, isBinaryTelegramType, buildBinaryPayload,
} from './dmdataTelegramPayload'
import { BufrFragmentStore, fragmentKey } from './bufrTelegramAssembly'
import {
  clearLiveReplayCache, fetchLiveQuakeTelegrams, fetchLiveReplayEntries, resolveLiveDates,
  MAX_ENUMERATED_DAYS, archiveDaysForWindow, archiveListRange,
} from './dmdataReplayLive'

/**
 * `fetchDmdataQuakeHistory` の `maxDays` に渡してよい上限。
 *
 * この関数が当日経路へ列挙させる範囲は `[before - maxDays, before]` ＝ **maxDays + 1 日**で、
 * `MAX_ENUMERATED_DAYS` を超えると `enumerateJstDates` が投げる。1 日ぶんを差し引いた値が、
 * 例外にならずに渡せる最大。
 *
 * **「もっと見る」で日数を伸ばす側がこの値で止まること。** 止めないと、上限を越えた時点から
 * 押すたびに同じ例外を投げるだけのボタンが残る（画面には「増えなかった」としか出ない）。
 */
export const MAX_HISTORY_DAYS = MAX_ENUMERATED_DAYS - 1

/**
 * 地震電文を「速報→詳細」の並びに揃える。
 *
 * `mergeQuakeHistory` は安定ソートで畳み込むため、**発表時刻が同値の電文どうしは入力配列の
 * 相対順序がそのまま結果に効く** —— 詳しい電文（各地の震度情報）が先・粗い電文（震度速報）が
 * 後に並ぶと、粗い方が詳しい方を上書きする（→ `utils/quakeMerge.ts` の `mergeQuakeHistory`）。
 *
 * **アーカイブ経路も当日経路も、この並びを自分では保証しない。** 前者は目録の並びと日の処理順
 * （新しい日から）に、後者は同時実行の完了順に従うだけ。旧実装は種別ごとに取って
 * VXSE51→52→53→61 の順に連結していたが、1 本へ寄せた今は**ここで明示的に揃える**。
 * 症状は「同じ分に 2 種類の電文が届いた地震のカードだけ震度が粗いまま」で、例外もログも出ない。
 */
function timeKey(q: JMAQuake): number {
  const ms = Date.parse(q.time)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

function orderedForMerge(quakes: JMAQuake[]): JMAQuake[] {
  return [...quakes].sort((a, b) => {
    // **日時として読めない時刻は末尾へ寄せる。** 捨てないのは、同一性の判定に使う時刻を
    // 落とさない方針のため（→ `data-sources-spec.md` §2「日時は 2 つの層で確かめる」）。
    //
    // **「読めないものは据え置いて種別だけで比べる」と書いてはいけない。** それでは
    // 比較関数が全順序にならず（読めない a と読める b・c について a=b・a=c なのに b<c が
    // 成り立ちうる）、`Array.prototype.sort` の結果が実装依存になる。**症状は「同じ入力なのに
    // 並びが違う」で、例外もログも出ない。**
    const at = timeKey(a)
    const bt = timeKey(b)
    if (at !== bt) return at - bt
    return (QUAKE_ISSUE_PRIORITY[a.issue.type] ?? 0) - (QUAKE_ISSUE_PRIORITY[b.issue.type] ?? 0)
  })
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
  /**
   * `designation` は分割配信された二進電文の 2 報目以降にだけ入る（`RRA`〜`RRX`）。
   * 実アーカイブで確認済み（2026-07-28 の IXAC41 が 1 報目 null・2 報目 "RRA"）。
   */
  head: { type: string; time: string; test: boolean; designation?: string | null }
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

/** 目録のページを辿る上限。理由は `dmdataReplayLive.ts` の `LIST_MAX_PAGES` と同じ。 */
const ARCHIVE_LIST_MAX_PAGES = 20

/**
 * 1 ページで要求する目録の件数。配信元が許す最大値（リファレンス「デフォルト: 20 … 最大は100」）。
 *
 * **渡さないと既定の 20 件しか返らない。** かつて「この API は 1 回に 20 件しか返さない」と
 * 誤解して省いており、同じ範囲を読むのに 5 倍のページを辿っていた。
 */
const ARCHIVE_LIST_LIMIT = 100

/**
 * 指定期間・指定分類のアーカイブ目録を全ページ取得する。
 *
 * 1 ページで収まらない範囲では、nextToken が尽きるまで cursorToken で辿る（打ち切ると広い期間の
 * 指定で古い側のアーカイブが無言で欠落し、本震当日のデータごと消えるという事故につながる）。
 * **2 ページ目以降も `limit` を渡し続けること** —— 配信元は cursorToken を使うとき「以前と同じ
 * 検索クエリパラメータを指定する」ことを求めており、落とすと既定の 20 件へ戻る。
 * `URLSearchParams` をページごとに作り直しているので、初期化に入れておけば自動で付く。
 *
 * **ただしページ数には上限を置く。** 1 ページ 100 件 × 20 ページ ＝ 2000 件。目録の 1 件は
 * 「1 日 × 1 分類」なので、このアプリが渡す範囲（最大でも `MAX_ENUMERATED_DAYS` ＝ 60 日 ×
 * 2 分類）には十分。上限が無いと、範囲指定が効かない呼び出し 1 回で数百リクエストが飛ぶ
 * （`LIST_MAX_PAGES` の由来を参照）。
 */
async function listArchives(
  apiKey: string,
  startDate: string,
  endDate: string,
  classification: string,
): Promise<ArchiveItem[]> {
  const items: ArchiveItem[] = []
  let cursorToken: string | undefined
  let page = 0
  for (; page < ARCHIVE_LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      datetime: `${startDate}~${endDate}`,
      classification,
      limit: String(ARCHIVE_LIST_LIMIT),
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
  // **打ち切りは失敗として扱う**（理由は `dmdataReplayLive.ts` の `listTelegrams` と同じ）。
  // ログだけにすると、打ち切られた不完全な目録が正常な戻り値として流れ、`failedArchiveUrls`
  // にも計上されないまま「部分成功」に見える。
  if (page >= ARCHIVE_LIST_MAX_PAGES) {
    throw new Error(
      `Archive list truncated: ページ上限（${ARCHIVE_LIST_MAX_PAGES}）に達した`
      + ` 範囲=${startDate}~${endDate} 件数=${items.length}`,
    )
  }
  return items
}

export async function fetchDmdataReplayEvents(
  apiKey: string,
  fromTime: Date,
  toTime: Date,
  includeTest: boolean,
): Promise<ReplayFetchResult> {
  // **落とす日を JST で決めて、目録もその範囲だけ引く。**
  //
  // 本体（`/v1/archive/:id`）は 1 日分の電文がまとめて入っていて重く、落とせば gunzip と
  // tar 展開も走る。かつては窓の **UTC 日付**に両端 ±1 日を足して目録を引き、返ってきた分を
  // 全件落としていた。1 日に収まる窓でも 3 日 × 分類数のファイルを取り、窓の外の電文は
  // 時刻で捨てていた（分類 2 つで 6 ファイル）。
  //
  // **その ±1 日は、両側とも狙いどおりに効いていなかった。**
  //   - 開始側の −1 日: 目録の `datetime` は**左端が排他**なので打ち消されていた（実測）
  //   - 終了側の +1 日: **UTC 日で数えていた**ため、00:00〜09:00 JST の窓では翌日の
  //     アーカイブが目録に現れなかった —— **日をまたいで配信された電文を拾う経路が
  //     塞がっていた**
  //
  // 日の決め方と境界の実測は `archiveDaysForWindow` / `archiveListRange`（→ そちら）。
  const wantedDays = archiveDaysForWindow(fromTime, toTime)
  const listRange = archiveListRange(wantedDays)
  if (listRange === null) {
    // **「窓が不正で目録を引いていない」と「引いたが 0 件だった」を混ぜない。**
    // 現状は `fromTime < toTime` なら起きないが、混ぜると「見ていない」が
    // 「見つからなかった」に化ける（→ CLAUDE.md「調査レビュー」）。
    log.warn(`[replay] 窓から対象の JST 日を決められなかったため目録を引かなかった（${fromTime.toISOString()}〜${toTime.toISOString()}）`)
  }
  const items = listRange === null
    ? []
    : await listArchives(apiKey, listRange.from, listRange.to, CLASSIFICATIONS.join(','))
  // **絞るのはダウンロードだけ。`resolveLiveDates` には絞る前の `items` を渡す**（下の
  // `liveDates`）—— 絞った後を渡すと、窓の外の日を「アーカイブが無い」と誤認して
  // 当日経路が余計に走る。目録の範囲は `wantedDays` を覆うだけなので通常は差が出ないが、
  // 左端が排他であることに頼らずここでも絞る（配信元の境界の扱いが変わっても安全側）。
  const targets = items.filter(i => wantedDays.has(i.date))
  if (targets.length < items.length) {
    log.debug(`[replay] アーカイブ本体は ${targets.length}/${items.length} 件だけ落とす（窓の JST 日: ${[...wantedDays].join(', ')}）`)
  }

  const dec = new TextDecoder()
  const entries: ReplayEntry[] = []
  // 分割された二進電文の結合待ち。**アーカイブをまたいで共有する** —— 断片は同じ日の同じ
  // アーカイブに入るのが普通だが、日付の境目で分かれても拾えるようにしておく。
  // この取得 1 回きりの入れ物なので、ライブの断片とは混ざらない。
  const bufrFragments = new BufrFragmentStore()
  /** 本体が見つからず、既に取りこぼしとして数えた二進電文の識別名。 */
  const countedBinaryKeys = new Set<string>()

  // 取り込めなかった電文の総数。1 通ごとの詳細は log.warn / log.error に出るが、
  // 「取りこぼしがあったか」だけは最後にまとめて 1 行で分かるようにする。
  let skippedCount = 0
  // 読み取れなかったアーカイブの URL。取得・展開の失敗だけでなく、目録が無い・壊れている
  // ケースも含める。これらは「アーカイブは落ちてきたが中身を 1 通も読めない」状態であり、
  // 取得エラーと同じく丸ごと欠落する。数え漏らすと UI が無警告のまま「電文 0 件の成功」に化ける。
  const failedArchiveUrls: string[] = []

  await Promise.all(
    targets.map(async (item) => {
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
        // 試験・訓練報は既定で捨てる（理由は dmdataReplayLive.ts の classifyTelegram に同じ）。
        // **アーカイブの索引は訓練報に test=true を立てる。** 電文の中身の運用種別
        // （`Control/Status`）とは別の印で、こちらを見ないと訓練報だけが静かに落ちる。
        if (!includeTest && entry.head.test) continue

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

          // manifest には同じ電文が XML 版と JSON 版の 2 エントリで載る。originalId を持つ方が
          // JSON 版（XML から変換されたもの）で、その値は元の XML エントリの id を指す。
          // **採るのは XML 版**（originalId 無し）。JSON 版を落とすのは同一電文の二重取り込みを
          // 防ぐ正常な重複排除で、実データでは manifest の約半数がこれに該当するため警告は出さない。
          if (entry.originalId) continue

          // 二進電文（IXAC41）は `.bin` で入り、512KiB を超えると複数エントリに分かれる。
          // **`dec.decode` を通してはいけない** —— 不正なバイトが U+FFFD へ潰れて戻せない。
          if (isBinaryTelegramType(headType)) {
            const binName = [...files.keys()].find((n) => n.endsWith('.bin') && n.includes(idPrefix))
            const binBytes = binName ? files.get(binName) : undefined
            if (!binBytes) {
              log.warn(`[replay] 二進電文の本体が見つからずスキップ id=${entry.id} type=${headType}`)
              // **電文ごとに 1 度だけ数える。** 分割は最大 24 断片あり、アーカイブの部分破損では
              // 複数が同時に欠ける。断片ごとに数えると 1 通の障害が断片の数だけ膨らむ。
              // 覚えておくのは、下の `pendingKeys` でもう一度数えないため。
              const key = fragmentKey(headType, 'RJTD', entry.head.time)
              if (!countedBinaryKeys.has(key)) {
                countedBinaryKeys.add(key)
                skippedCount++
              }
              continue
            }
            const joined = bufrFragments.add(
              fragmentKey(headType, 'RJTD', entry.head.time), entry.head.designation, binBytes, Date.now(),
            )
            // まだ揃っていない断片。**取りこぼしには数えない** —— 残りの断片は同じ
            // アーカイブの後続エントリに入っており、揃った時点で 1 通として積まれる。
            if (!joined) continue
            const binPayload = buildBinaryPayload(headType, joined, entry.id, entry.head.time)
            if (binPayload) {
              const replayTime = (binName ? parseMsFromFileName(binName) : null) ?? entryTime
              entries.push({ payload: binPayload, replayTime })
            } else {
              log.warn(`[replay] 二進電文の読み取りに失敗しスキップ id=${entry.id} type=${headType}`)
              skippedCount++
            }
            continue
          }

          const xmlFileName = [...files.keys()].find(
            (n) => n.endsWith('.xml') && n.includes(idPrefix),
          )
          const bodyBytes = xmlFileName ? files.get(xmlFileName) : undefined
          if (!bodyBytes) {
            log.warn(`[replay] 電文の本体が見つからずスキップ id=${entry.id} type=${headType}`)
            skippedCount++
            continue
          }

          const payload = buildXmlPayload(headType, dec.decode(bodyBytes))
          if (payload) {
            // ファイル名の 17 桁タイムスタンプ（YYYYMMDDHHMMSSmmm）はミリ秒精度の実受信時刻。
            // 発表時刻は秒単位で切り捨てられているため、ファイル名から ms を優先的に取得する
            // （報が連続する EEW で順序と間隔を保つのに要る）。
            const replayTime = (xmlFileName ? parseMsFromFileName(xmlFileName) : null) ?? entryTime
            entries.push({ payload, replayTime })
          } else {
            log.warn(`[replay] 電文のパースに失敗しスキップ id=${entry.id} type=${headType}`)
            skippedCount++
          }
        } catch (e) {
          // 1 通の想定外の例外で全体を落とさない（XML の破損はパーサが null を返すため
          // ここへは来ず、上の warn として記録される）。以前は個別の
          // try/catch が無く、壊れた電文が 1 通あるだけで Promise.all ごと reject し、
          // その日を含む期間の再生が丸ごと不可能になっていた。
          log.error(`[replay] 電文の取り込みに失敗しスキップ id=${entry.id} type=${headType}`, e)
          skippedCount++
        }
      }
    }),
  )

  // **揃わなかった二進電文の断片を取りこぼしとして数える。** ここで見ないと誰も見ない ——
  // この入れ物は取得 1 回きりで使い捨てるので、残った断片は黙って消える。
  // 症状は「他の電文は全部読めているのに、その地震だけ分布が出ない」で、手掛かりが何も残らない。
  for (const key of bufrFragments.pendingKeys) {
    // 本体が見つからず既に数えた電文は、ここでは数えない（上の注記）。
    if (countedBinaryKeys.has(key)) continue
    log.warn(`[replay] 二進電文の断片が揃いませんでした（分布は出ません）key=${key}`)
    skippedCount++
  }

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
      const live = await fetchLiveReplayEntries(apiKey, fromTime, toTime, liveDates, includeTest)
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
  //
  // **数えるのは `targets`（実際に落とした分）で、`items`（目録の全件）ではない。**
  // 目録は窓より広く引いているので、`items` を分母にすると落としてもいない日で分母が膨らみ、
  // **全滅が「一部は読めた」に化ける**（認証切れ・全断のときに例外が上がらなくなる）。
  const sourceDays = targets.length + liveDates.length
  if (sourceDays > 0 && failedSourceDays === sourceDays) {
    throw new Error(`Archive fetch failed: ${sourceDays} 件の取得元すべてを読み取れませんでした`)
  }

  if (failedArchiveUrls.length > 0) {
    log.warn(`[replay] 取得元 ${sourceDays} 日ぶんのうち ${failedArchiveUrls.length} 件を読めなかった（残りから取り込みを継続）: ${failedArchiveUrls.join(', ')}`)
  }
  if (skippedCount > 0) {
    log.warn(`[replay] ${skippedCount} 件の電文を取り込めなかった（範囲 ${fromTime.toISOString()}〜${toTime.toISOString()}）`)
  }
  if (sourceDays > 0 && entries.length === 0) {
    // 取得元は引けたのに 1 件も取り込めなかった状態。指定期間に本当に電文が
    // 無いだけのこともあるため例外にはしないが、UI 側は「成功」としか見えないので
    // 診断の手がかりを残す。
    log.warn(`[replay] アーカイブ ${targets.length} 件・当日経路 ${liveDates.length} 日を取得したが対象電文は 0 件（範囲 ${fromTime.toISOString()}〜${toTime.toISOString()}）`)
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

/** 初期状態に載せるかどうかを、津波イベント単位で決めた結果。 */
interface TsunamiPreWindowState {
  /** T 時点でこの津波が続いているか（false ならその津波の報は 1 通も載せない）。 */
  alive: boolean
  /** 報を跨いで最後に伝えられた有効期限。 */
  validDateTime?: string
}

/**
 * 同一の津波イベントに属する報をまとめるキー。
 *
 * `eventId` を持たない電文（P2PQuake の 552。この関数は DMDATA アーカイブだけでなく全バリアントの
 * 初期状態で使われる——呼び出しは `useReplayController` に 1 箇所だけある）は `id` が報ごとに変わる
 * ため、報 1 通ずつが別のグループになる。その経路の扱いは下の `resolveTsunamiPreWindowStates` に書く。
 *
 * 空文字を弾くのは、キーの導出と「識別子を持つか」の判定を同じ述語に揃えるため（`??` だと空文字が
 * 有効な識別子として通り、識別子の無い電文どうしが 1 つの津波として束ねられる）。
 */
function tsunamiGroupKey(tsunami: JMATsunami): string {
  return tsunami.eventId || tsunami.id
}

/**
 * 初期状態の再現に載せる津波を、報ではなくイベント単位で決める。
 *
 * 報 1 通だけで判定できない事実が 2 つある。
 *
 * ひとつは**有効期限**。気象庁は期限が決まった報で一度だけ ValidDateTime を載せ、以後の続報には
 * 載せない（詳細と実データは `utils/tsunami` の `latestValidDateTime`）。報ごとに見ると、期限を
 * 伝えた報だけが「期限切れ」で捨てられ、期限を持たない最後の報が生き残る。予報のみの津波に解除
 * 電文は出ないため、そうなると失効の予約も積まれず永久に画面へ残る。
 *
 * もうひとつは**解除**。解除報を捨てるだけでは、それより前の発表報が残って解除済みの津波が復活する。
 *
 * **解除による足切りは `eventId` を持つ電文にしか適用しない。** 識別子が無ければ「どの津波の解除か」
 * を決められず、時刻の前後だけで落とすと、同じ 24 時間に無関係な津波が 2 つあったときに、解除された
 * 側の時刻で、まだ発表中の側まで消える。識別子の無い経路では**解除報も含めて全報をそのまま流し**、
 * 照合は `isCancelForCurrentTsunami`（発表時刻の前後で足切りする既存の述語。カードの状態更新と
 * 読み上げの記憶で共有している）へ委ねる。初期状態でも解除は届くので津波は画面から消える
 * （解除の表示が 10 秒挟まる点だけが「載せない」場合との違い）。
 *
 * 有効期限のほうは識別子の有無で分けない。識別子が無ければ 1 グループ 1 報になり、その報自身の
 * 期限で判定することになる（報単位で見ていた従来と同じ）。
 */
function resolveTsunamiPreWindowStates(
  entries: ReplayEntry[],
  targetTime: Date,
): Map<string, TsunamiPreWindowState> {
  const groups = new Map<string, JMATsunami[]>()
  for (const entry of entries) {
    if (entry.payload.kind !== 'event') continue
    const ev = entry.payload.event
    if (ev.kind !== 'tsunami') continue
    const tsunami = ev as JMATsunami
    const key = tsunamiGroupKey(tsunami)
    const group = groups.get(key)
    if (group) group.push(tsunami)
    else groups.set(key, [tsunami])
  }

  const states = new Map<string, TsunamiPreWindowState>()
  for (const [key, reports] of groups) {
    const identified = !!reports[0].eventId
    if (identified && reports.some(r => r.cancelled)) {
      states.set(key, { alive: false })
      continue
    }
    const validDateTime = latestValidDateTime(reports)
    const expired = !!validDateTime && new Date(validDateTime).getTime() <= targetTime.getTime()
    states.set(key, { alive: !expired, validDateTime })
  }
  return states
}

// T 時点でまだ有効な電文のみを残すフィルタ（pre-window 初期状態用）
export function filterPreWindowEvents(
  entries: ReplayEntry[],
  targetTime: Date,
): ReplayEntry[] {
  // EEW は T 時点で有効なものだけを 1 地震につき 1 件へ畳む。グルーピングと失効の判定は
  // ライブ起動時の復元と共有する（`selectActiveEews`）——どちらも「その時刻の画面を作り直す」
  // という同じ目的なので、二重に持つと片方だけ直したときに再生と実機で挙動が食い違う。
  const eewReports: Array<{ eew: EEWAlert; value: ReplayEntry }> = []
  const quakeByEventId = new Map<string, ReplayEntry>()
  // 津波は報を跨いで状態が積み上がる（観測のみの続報が前報の区域を引き継ぐ）ため、EEW のように
  // 最新 1 報へ畳まずに全報を順に流す。一方で「T 時点でその津波が終わっているか」は報 1 通では
  // 判定できないので、先にイベント単位で決めてからループへ入る。
  const tsunamiStates = resolveTsunamiPreWindowStates(entries, targetTime)
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
      eewReports.push({ eew: ev as EEWAlert, value: entry })
      continue
    }

    if (ev.kind === 'tsunami') {
      const tsunami = ev as JMATsunami
      const state = tsunamiStates.get(tsunamiGroupKey(tsunami))
      if (!state) {
        // 状態は同じ `entries` から作るので、ここへ来るのは作る側と読む側の入力が食い違ったとき
        // だけ。津波が 1 件も出ない結果は画面上「静かな時間だった」と見分けが付かないので、
        // 落とす前に記録を残す。
        log.warn(`[replay] 津波の有効性を解決できなかったため初期状態に載せません: id=${tsunami.id}`)
        continue
      }
      if (!state.alive) continue
      // その津波に対して最後に伝えられた期限を、期限を持たない報にも持たせる。補わないと
      // 最後の報で失効の予約が積まれず、期限を過ぎても画面から消えなくなる。
      if (state.validDateTime && !tsunami.validDateTime) {
        result.push({
          ...entry,
          payload: { kind: 'event', event: { ...tsunami, validDateTime: state.validDateTime } },
        })
        continue
      }
    }

    result.push(entry)
  }

  for (const entry of quakeByEventId.values()) result.push(entry)

  result.push(...selectActiveEews(eewReports, targetTime, 'replay'))

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
  includeTest: boolean,
  /**
   * 1 日ぶんを読み終えるたびに、そこまでの地震を流す先。
   *
   * **当日ぶんは 1 件ずつ取るので門で直列化される**（→ `services/telegramBody.ts`）。
   * 揃うまで待つと、そのあいだ画面に何も出ない。渡さなければ従来どおり全件揃ってから返す。
   */
  onPartial?: (quakes: JMAQuake[]) => void,
  /**
   * 途中で打ち切ってよいかを訊く。**日ごとに、読み始める前に見る。**
   *
   * 取得のあいだにリプレイが始まる・API キーが変わる・画面を離れることがある。
   * 放っておくと、もう要らない取得が当日経路の門の枠を予約し続ける。
   */
  shouldStop?: () => boolean,
): Promise<QuakeHistoryResult> {
  // 落とす日と目録の範囲は、どちらも JST 日から導く（`fetchDmdataReplayEvents` と同じ理由。
  // 根拠と境界の実測は `archiveDaysForWindow` / `archiveListRange`）。
  //
  // `before` ちょうどの電文は残す側（`entryTime > before` で捨てる）なので、終端を含まない
  // `archiveDaysForWindow` へは 1ms 足して渡す。
  const startObj = new Date(before)
  startObj.setDate(startObj.getDate() - maxDays)
  const wantedDays = archiveDaysForWindow(startObj, new Date(before.getTime() + 1))
  const listRange = archiveListRange(wantedDays)
  const items = listRange === null
    ? []
    : await listArchives(apiKey, listRange.from, listRange.to, 'telegram.earthquake')
  // **絞るのはダウンロードだけ。`resolveLiveDates` には絞る前の `items` を渡す**（下の
  // `liveDays`）—— 絞った後を渡すと、窓の外の日を「アーカイブが無い」と誤認して
  // 当日経路が余計に走る。
  const targets = items.filter(i => wantedDays.has(i.date))
  if (targets.length < items.length) {
    log.debug(`[replay] 履歴用アーカイブ本体は ${targets.length}/${items.length} 件だけ落とす`)
  }

  const downloaded = await Promise.all(targets.map(async (item) => {
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
  /**
   * 同じアーカイブから拾う津波電文。
   *
   * **地震の件数で打ち切らない。** 発表中の津波は数日前に出たものが続いていることがあり、
   * 地震のカードが揃った日で切ると拾えなくなる（帯と長周期を打ち切らないのと同じ理由）。
   * 取得済みのアーカイブから拾うだけなので、増えるのは目録の走査とパースだけ。
   *
   * **「いま発表中か」の判定はここでしない。** 期限の引き継ぎ・解除の照合は呼び出し側が持つ
   * （→ `tsunami-spec.md` §3「有効期限は報ではなく津波に付く」）。ここは電文を集めるだけ。
   *
   * **遡る範囲は `maxDays`（起動時は 7 日）。** 以前は「津波電文の最新 10 通」を期間を問わずに
   * 引いていたが、日数で切っても取り逃がしは増えない —— 気象庁の津波警報等はいずれも数日で
   * 解除され（東北地方太平洋沖地震でも約 2 日）、発表中の津波が 7 日より古い報しか持たない形は
   * 起きない。むしろ件数で引く形は、津波が発表中のあいだ 10 通が同じ日で埋まって前日以前へ
   * 届かなくなる。
   */
  const tsunamis: JMATsunami[] = []
  const eventIds = new Set<string>()
  const failedArchiveUrls: string[] = []
  /** 帯と長周期は種別ごとに最新 1 通だけ残す（鍵の作り方は `historyExtraKey`）。 */
  const extraLatest = new Map<string, { payload: ReplayPayload; timeMs: number }>()
  let skipped = 0
  let usedDays = 0
  /** 打ち切ったか。**まだ遡れるかの判定と混ぜない** —— 打ち切りは「もう要らない」、遡れるかは在庫の話。 */
  let stoppedEarly = false

  for (const source of sources) {
    // **地震は目標件数に達した日で打ち切る。** 日の途中で切ると同一イベントの続報が分断され、
    // 震度速報だけのカードが残りうる。
    //
    // **帯と長周期は打ち切らない**（`HISTORY_EXTRA_TYPES`）。7 日ぶん画面に出続けるもの・
    // 地震ごとに紐づくもので、**地震活動が多い期間ほど早く打ち切られる**と、いちばん復元
    // したい状況（群発の最中）で復元できない。アーカイブは上で並列にダウンロードしてあるので、
    // 増えるのは目録の走査と 1 日数通のパースだけ。
    if (shouldStop?.()) { stoppedEarly = true; break }
    const takeQuakes = eventIds.size < targetEvents
    usedDays++

    if (!source.archive) {
      // 当日経路。読めなくてもアーカイブ側の成果は活かす（アーカイブ 1 日ぶんが読めなかったときと
      // 同じ扱い）。ここで例外にすると、当日の一覧 API が一度こけただけで過去数日ぶんの
      // カードごと消える。
      try {
        const live = await fetchLiveQuakeTelegrams(apiKey, source.date, before, includeTest)
        for (const quake of live.quakes) {
          quakes.push(quake)
          eventIds.add(extractQuakeEventIdFromId(quake.id) ?? quake.id)
        }
        // 当日ぶんの津波も拾う（アーカイブ側と揃える）
        for (const tsunami of live.tsunamis) tsunamis.push(tsunami)
        for (const e of live.extras) {
          const key = historyExtraKey(e.payload)
          if (key === null) continue
          const timeMs = e.replayTime.getTime()
          const prev = extraLatest.get(key)
          if (!prev || timeMs > prev.timeMs) extraLatest.set(key, { payload: e.payload, timeMs })
        }
        skipped += live.skipped
      } catch (e) {
        log.error(`[replay] 履歴用の当日経路の取得に失敗 date=${source.date}`, e)
        failedArchiveUrls.push(liveSourceId(source.date))
      }
      // 当日経路はアーカイブの走査（下の for）を通らないので、ここでも流す
      if (onPartial) {
        try {
          onPartial(orderedForMerge(quakes))
        } catch (e) {
          log.warn('[replay] 履歴の途中経過を反映できませんでした（取得は続けます）', e)
        }
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
      if (!entry?.head || (!includeTest && entry.head.test)) continue
      const isQuake = QUAKE_TYPES.has(entry.head.type)
      const isExtra = HISTORY_EXTRA_TYPES.has(entry.head.type)
      const isTsunami = TSUNAMI_TYPES.has(entry.head.type)
      if (!isQuake && !isExtra && !isTsunami) continue
      if (isQuake && !takeQuakes) continue
      // XML 版と JSON 版の 2 エントリで載るうち、XML 版（originalId 無し）だけを拾う
      // （`fetchDmdataReplayEvents` と同じ重複排除。正常動作なので警告は出さない）。
      if (entry.originalId) continue

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
        const idPrefix = entry.id.slice(0, 7)
        const xmlFileName = [...files.keys()].find((n) => n.endsWith('.xml') && n.includes(idPrefix))
        const bodyBytes = xmlFileName ? files.get(xmlFileName) : undefined
        if (!bodyBytes) {
          log.warn(`[replay] 履歴用電文の本体が見つからずスキップ id=${entry.id} type=${entry.head.type}`)
          skipped++
          continue
        }
        if (isExtra) {
          // 帯と長周期は「種別ごとに最新 1 通」だけを残す（画面に出るのは 1 つ・長周期は
          // 地震ごと）。古い報まで流すと、初期状態が入れた新しい値を上書きしうる。
          const payload = buildXmlPayload(entry.head.type, dec.decode(bodyBytes))
          const key = payload ? historyExtraKey(payload) : null
          if (!payload || key === null) {
            log.warn(`[replay] 履歴用電文のパースに失敗しスキップ id=${entry.id} type=${entry.head.type}`)
            skipped++
            continue
          }
          const prev = extraLatest.get(key)
          if (!prev || entryTime.getTime() > prev.timeMs) {
            extraLatest.set(key, { payload, timeMs: entryTime.getTime() })
          }
          continue
        }
        if (isTsunami) {
          const tsunami = parseTsunamiFromXml(entry.head.type, dec.decode(bodyBytes))
          if (!tsunami) {
            log.warn(`[replay] 履歴用電文のパースに失敗しスキップ id=${entry.id} type=${entry.head.type}`)
            skipped++
            continue
          }
          tsunamis.push(tsunami)
          continue
        }
        const quake = parseEarthquakeFromXml(entry.head.type, dec.decode(bodyBytes))
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
    // **1 日ぶん読み終えたところで流す。** 流し先の例外で取得を止めない —— 投げると
    // 残りの日を見捨てたうえで呼び出し側が「全滅」として受け取る。
    if (onPartial) {
      try {
        onPartial(orderedForMerge(quakes))
      } catch (e) {
        log.warn('[replay] 履歴の途中経過を反映できませんでした（取得は続けます）', e)
      }
    }
  }

  // 使おうとした日がすべて読めなかった場合だけ例外にする（認証エラー・全断などの共通原因が
  // ほとんどで、握り潰すと「履歴 0 件の成功」に化ける）。1 日でも読めていれば部分成功とする。
  //
  // **打ち切りを全滅と混ぜない。** 読んだ日がすべて失敗していても、途中で打ち切られたなら
  // それは「もう要らない」状態で、呼び出し側は結果ごと捨てる（`usedDays` は打ち切り判定の
  // **後**に増えるので、数日失敗してから打ち切られた形で両方が成立しうる）。例外にすると、
  // API キーの差し替えやリプレイの開始のたびに「取得に失敗した」という記録が残る。
  if (!stoppedEarly && usedDays > 0 && failedArchiveUrls.length === usedDays) {
    throw new Error(`Archive fetch failed: ${usedDays} 件の取得元すべてを読み取れませんでした`)
  }
  // 「取得元が 1 つも無い」は取得の失敗として現れないため、例外にも損失にもならない。
  // 黙って空を返すと「静かな期間だった」と区別が付かないので、手がかりだけは残す。
  //
  // **「大半が落ちて数件だけ残る」形はここでしか見えない。** 全滅は上で例外になり、
  // 個別の失敗はその場で 1 行ずつ出るが、**分母との対比が無いと「7 日中 6 日が落ちた」と
  // 「静かな期間だった」が区別できない**。呼び出し側（`useEarthquakes`）は画面へ出す手段を
  // まだ持たないので、いまは記録だけが頼り。
  // リプレイ側の兄弟関数（`fetchDmdataReplayEvents`）は同じ要約を出しており、片方だけ
  // 抜けている状態だった。
  if (failedArchiveUrls.length > 0) {
    log.warn(
      `[replay] 履歴用の取得元 ${usedDays} 日ぶんのうち ${failedArchiveUrls.length} 件を読めなかった`
      + `（読めた地震電文=${quakes.length} 件・扱えなかった電文=${skipped} 件）`,
    )
  }
  if (sources.length === 0) {
    log.warn(`[replay] 履歴用の取得元が 1 件も見つからなかった（対象の JST 日: ${[...wantedDays].sort().join(', ') || 'なし'}）`)
  } else if (stoppedEarly) {
    // **打ち切りは「読んだが 0 件」とは別の状態。** 混ぜると、時間軸の切り替えや画面を離れた
    // だけの正常な打ち切りが「静かな期間だった」と読める記録になる（`shouldStop` が初回から
    // 真を返す形は `StrictMode` の二重実行で普通に起きるので、実際に毎回それが出ていた）。
    // 警告にしないのも同じ理由で、正常系で鳴らすと他の記録が埋もれる。
    log.info(`[replay] 履歴の取得を打ち切った（取得元 ${sources.length} 日のうち ${usedDays} 日を読んだ時点）`)
  } else if (quakes.length === 0) {
    log.warn(`[replay] 履歴用に ${usedDays} 日ぶんを読んだが地震電文は 0 件（${before.toISOString()} 以前）`)
  }
  // 帯と長周期は古い順に流す（`useReplayController` が初期状態の後に注入する）。
  const extras: ReplayEntry[] = [...extraLatest.values()]
    .sort((a, b) => a.timeMs - b.timeMs)
    .map((x) => ({ payload: x.payload, replayTime: new Date(x.timeMs), silent: true }))
  // 走査日数は**常に取得元の全日数**（＝`sources.length`。帯と長周期のために打ち切らない）。
  // 地震が何日で目標に達したかとは別の数字なので、混ぜて読まないこと。
  //
  // **打ち切ったときは出さない。** 上で打ち切りを記録済みで、こちらは「復元した」と名乗るため
  // 0 件の行が並ぶと復元できなかったのか静かだったのか読めない。
  if (!stoppedEarly) {
    log.info(
      `[replay] 地震カードの履歴を復元 電文=${quakes.length} イベント=${eventIds.size}`
      + ` 走査日数=${usedDays}（うち当日経路=${liveDays.length}）帯と長周期=${extras.length}`,
    )
  }
  // **「まだ試す余地があるか」。** 「もう無い」とは言い切らない。
  //
  // 件数で判定していた頃（目標に達して、かつ読んでいない日が残っている）は、
  // **在庫が目標に届かないと永久に偽**になった —— 7 日分で 43 件しか無ければ目標 50 件には
  // 届かず、範囲を広げる機会が来ない。範囲の外に在庫があるかはここでは分からないので、
  // **取得元が 1 つでもあれば真**にして、呼び出し側が「押しても増えなかった」で打ち切る。
  //
  // 打ち切った場合は「もう要らない」ので真にしない（`stoppedEarly`）。
  const hasMore = !stoppedEarly && sources.length > 0
  return { quakes: orderedForMerge(quakes), tsunamis, extras, skipped, failedArchiveUrls, hasMore }
}
