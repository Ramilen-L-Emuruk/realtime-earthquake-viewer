import { parseEarthquakeFromXml, parseTsunamiFromXml } from './dmdataParser'
import { parseTar } from '../utils/tarParser'
import type { JMAQuake, EEWAlert, JMATsunami } from '../types/earthquake'
import { selectActiveEews } from '../utils/eew'
import { gunzip } from '../utils/gzip'
import { createArchiveBodyCache } from '../utils/archiveBodyCache'
import { readArchiveBody, writeArchiveBody } from '../utils/archiveBodyDb'
import { log, createLogThrottle } from '../utils/logger'
import { authHeader } from '../utils/dmdataApiKey'
import { extractQuakeEventIdFromId, QUAKE_ISSUE_PRIORITY } from '../utils/quakeMerge'
import { latestValidDateTime } from '../utils/tsunami'
import type { ReplayEntry, ReplayPayload, ReplayFetchResult, QuakeHistoryResult } from '../types/replay'
import {
  HANDLED_TYPES, QUAKE_TYPES, TSUNAMI_TYPES, HISTORY_EXTRA_TYPES, historyExtraKey,
  buildXmlPayload, CLASSIFICATIONS, isBinaryTelegramType, buildBinaryPayload,
  isFilteredBinaryTelegram,
} from './dmdataTelegramPayload'
import { BufrFragmentStore, fragmentKey } from './bufrTelegramAssembly'
import {
  clearLiveReplayCache, fetchLiveQuakeTelegrams, fetchLiveReplayEntries, resolveLiveDates,
  archiveDaysForWindow, archiveListRange, toJstDateStr,
} from './dmdataReplayLive'
import {
  waitForDataApiSlot, waitForApiSlot, rateLimitedUntil, noteRateLimited, noteRateLimitCleared,
  RateLimitWindowError,
} from './dmdataRequestGates'
import { createSkipCounter, sumSkippedByDay, UNKNOWN_SKIP_DAY } from '../utils/telegramLoss'

/**
 * 履歴を 1 回で読む窓の幅（日）。起動時の初回ロードと「もっと見る」1 回ぶんで共通。
 *
 * **遡れる範囲の上限ではない。** 上端はカーソル（前回読んだ最古の日の手前）が決めるので、
 * 押し続ければ在庫の端（地震津波関連は 2020-11-18）まで届く。ここが決めているのは
 * 「1 回で読む幅」だけ。
 *
 * ## 件数ではなく日数で区切る理由
 *
 * **アーカイブは日単位でしか落とせない。** 打ち切りの判定も日の頭でしか置けない（日の途中で
 * 切ると同一地震の続報が分断され、震度速報だけのカードが残る）。つまり件数を目標にしても
 * 実際には日で丸められるので、**目標という形をとっているだけで区切りは日**だった。
 *
 * 日数で区切ると、落とした本体を全部使い切れる。件数目標だった頃は**窓の全日ぶんを落として
 * おきながら、目標に達した日から先は地震を取り込まなかった** —— 30 日窓の実測で 32 ファイルを
 * 落として地震に使ったのは 12 日ぶん。残りは帯と長周期のためだけに解析され、その長周期は
 * 紐づく地震カードが無いまま捨てられていた。
 *
 * ## 7 日にした根拠
 *
 * リクエスト数は窓の日数にそのまま比例するので、**どの窓でも「在庫の端まで遡るのにかかる
 * 合計時間」は変わらない**（配信元の窓ごとの上限が律速する）。変わるのは 1 回の重さだけ。
 *
 * | 窓 | 1 回のリクエスト | 1 回で増えるカード |
 * |---|---|---|
 * | **7 日** | **8 件**（目録 1 ＋ 本体 7） | **40〜50 件** |
 * | 14 日 | 15 件 | 80〜100 件 |
 * | 30 日 | 32 件 | 200 件前後 |
 *
 * 日常的には数回押すだけなので、1 回が軽いほうを採る。7 日ぶんの有感地震は実測で 44 件
 * （長期震源カタログの確定値 1997〜2023 年で 1 日平均 7.3 件）。
 */
export const HISTORY_WINDOW_DAYS = 7

/**
 * 1 回の取得で取り込む地震イベント数の**安全弁**。
 *
 * **目標ではない。** 通常は窓（`HISTORY_WINDOW_DAYS`）を丸ごと読み切るので、ここへ達しない。
 * 効くのは群発の最中だけ —— 能登半島地震の本震当日のように 1 日で数百件になると、日数だけで
 * 切った場合にカードが一度に千枚単位で増える。
 *
 * 達した日で地震の取り込みをやめ、カーソル（`oldestLoadedDay`）もそこで止まるので、続きは
 * 次に押したときに読める。
 */
export const HISTORY_EVENT_SAFETY_CAP = 500

/**
 * アーカイブの保存開始日（JST。地震津波関連の分類）。
 *
 * **これが遡りの本当の端。** 契約の保存期間として配信元が定めている値で、ここより古い日に
 * アーカイブが無いのは当たり前 —— 取りこぼしとして記録しないし、押せなくしてよい唯一の理由。
 *
 * **「目録が空だから端に来た」と読み替えないこと。** 一時的な障害や生成の遅れでも目録は空に
 * なる。区別せずに扱うと、**障害のときに黙ってボタンが死に、その窓の日がどの記録にも残らない**。
 *
 * 緊急地震速報（`eew.forecast` / `eew.warning`）は 2022-07-20 15:00 からで日が違うが、履歴の
 * 取得が引くのは `telegram.earthquake` だけなのでここでは扱わない
 * （→ `data-sources-spec.md` §2 の契約 B4）。
 */
const ARCHIVE_START_DAY = '2020-11-18'

/**
 * 当日経路が埋めてよい「直近」の日数。
 *
 * アーカイブは日次で生成されるので、目録に載っていない日は**当日ぶん**か、生成が遅れている
 * 直近だけ。それより古い日に目録が無ければ、それは在庫の端であって当日経路の出番ではない。
 *
 * **範囲全体を当日経路に任せないこと。** かつては窓の全日を `resolveLiveDates` へ渡していて、
 * 2 つのことが起きていた —— ①`enumerateJstDates` の暴走防止（`MAX_ENUMERATED_DAYS` ＝ 60 日）に
 * 触れるため、遡れる幅がその歯止めに縛られていた（歯止めは「呼び出し側の異常を検出する値」で
 * 遡り範囲の設計値ではない、とあちらのコメント自身が断っている）②在庫の端を越えた窓で、
 * アーカイブが無い日を全部「当日経路が埋める日」と見なして `/v2/telegram` を叩いていた。
 */
const LIVE_FALLBACK_DAYS = 2

const DAY_MS = 86_400_000

/**
 * 地震電文を「速報→詳細」の並びに揃える。
 *
 * `mergeQuakeHistory` は安定ソートで畳み込むため、**発表時刻が同値の電文どうしは入力配列の
 * 相対順序がそのまま結果に効く**（→ `utils/quakeMerge.ts` の `mergeQuakeHistory`）。
 *
 * **完全版と速報段階のあいだの逆転は、統合側が据え置くので起きない**（同ファイルの
 * `isSupersededByExistingCard`）。それでもここで揃えるのは、**同じ段階どうしの並びが
 * 依然として入力順に依存する**ため —— 同じ分に震度速報が複数あれば、後に置いた方が勝つ。
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

/**
 * gzip のアーカイブを展開して tar の中身にする。**通信は伴わない。**
 *
 * **2 か所から呼ぶので関数にしてある** —— 配信元から落としたときと、端末の控えから
 * 読み出したとき。片方だけ直すと、控えに当たった再生だけが別の中身で動く。
 *
 * **バイト数は展開後の tar の長さで返す。** `parseTar` が返すのは `subarray` の切り出しなので、
 * エントリの合計で数えると**使わなかった領域がまるごと数から漏れる**（1 エントリでも参照が
 * 残ればバッファ全体が残る）。
 */
async function expandArchive(gz: Uint8Array): Promise<{ files: Map<string, Uint8Array>; bytes: number }> {
  const tar = await gunzip(gz)
  const files = new Map<string, Uint8Array>()
  for (const entry of parseTar(tar)) {
    files.set(entry.name, entry.content)
  }
  return { files, bytes: tar.length }
}

/**
 * 日次アーカイブの控え（URL → 展開済みのファイル名マップ）。
 *
 * **二層ある。**
 *
 * | 層 | 中身 | 残る範囲 |
 * |---|---|---|
 * | メモリ | 展開後のファイル名マップ | そのタブが開いているあいだ |
 * | 端末（IndexedDB） | **gzip のまま**の原本 | タブを閉じても残る（→ `utils/archiveBodyDb.ts`） |
 *
 * **端末の層が効くのは「タブを開き直したとき」。** アプリの起動・リロード・録画で区間ごとに
 * 再生を開始し直す使い方では、メモリ層が空の状態から始まるので、そこが無いと毎回
 * 落とし直していた（起動時の履歴 7 本・リプレイの開始 16 本）。
 *
 * **配信元が名指しで求めているのはこの控え**（「同じ`id`に対して短期間にリクエストを
 * 繰り返さないように実装してください」）。取得の間隔を空けることはこの要請に何も寄与しない。
 *
 * 取得の失敗を控え続けないことと、同じ URL への同時要求を 1 本にまとめることは
 * `utils/archiveBodyCache.ts` が担っている。
 */
const archiveCache = createArchiveBodyCache({
  persist: {
    read: readArchiveBody,
    write: writeArchiveBody,
    expand: expandArchive,
  },
})

if (typeof window !== 'undefined') {
  // 控えが効いているかは画面に出ないので、検証で読めるようにしておく
  // （電文本体の `window.__telegramBodyStats()` と同じ趣旨）。
  ;(window as unknown as { __archiveCacheStats?: () => unknown }).__archiveCacheStats =
    () => archiveCache.stats()
}

/**
 * アーカイブ本体の URL から id を取り出す（`https://data.api.dmdata.jp/v1/archive/{id}` の末尾）。
 *
 * **429 の窓の鍵に使う。** 窓は id ごとに持つので（配信元は「同じ id への繰り返し」に 429 を
 * 返す）、URL をそのまま鍵にするとクエリや基底が変わるだけで別物として扱われる。
 *
 * **長さの下限は置かない。** 電文本体の側（`telegramIdFromUrl`）は 8 文字以上を要求しているが、
 * **アーカイブ id の長さは確かめていない**ので決め打たない。空でなければ鍵として使える
 * （短すぎる値を弾く理由が無く、弾くと窓が黙って効かなくなる）。
 */
function archiveIdFromUrl(url: string): string | null {
  try {
    const id = new URL(url).pathname.split('/').pop() ?? ''
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

/**
 * そのアーカイブ（`date` が覆う JST 日）を控えてよいか。**当日ぶんだけ控えない。**
 *
 * 目録に当日は現れず当日経路が受ける建て付けなので現状は起きないが、配信元が
 * 「育っている途中の部分アーカイブ」を出す設計へ変われば、控えた側は途中までの中身を
 * 返し続ける。**前提を実装で守り、崩れたら記録に残す**（控えの `uncacheable` が立つ）。
 *
 * **`nowMs` には壁時計（`Date.now()`）を渡すこと。`serverNow()` を渡してはいけない。**
 * あちらはリプレイ中に**再生対象のシミュレート時刻**を返すので、`date`（再生している日）と
 * 常に一致し、**再生中はこの述語がいつも偽になって控えが丸ごと効かなくなる**。
 * ここが訊いているのは「そのファイルが現実にまだ育っている最中か」であって、
 * 再生上の「いま」ではない。
 */
export function isArchiveCacheable(date: string, nowMs: number): boolean {
  return date !== toJstDateStr(new Date(nowMs))
}

// 当日ぶんが目録に現れた、という到達しないはずの報せ。**間引く** —— 本編の窓は同じ日を
// 繰り返し要求する構造なので、素の warn だと開始の回数だけ出て他の記録が埋もれる。
const warnSameDayArchive = createLogThrottle(60_000)

/**
 * アーカイブ本体を落とす（控えを通す）。`date` はそのアーカイブが覆う JST 日。
 */
function downloadArchive(url: string, apiKey: string, date: string): Promise<Map<string, Uint8Array>> {
  const cacheable = isArchiveCacheable(date, Date.now())
  if (!cacheable) {
    warnSameDayArchive(() => log.warn(
      `[replay] 当日ぶんのアーカイブが目録に現れた（控えずに毎回取る） date=${date}`,
    ))
  }
  return archiveCache.get(url, async () => {
    // **429 を受けたばかりの id は取りに行かない**（→ `services/dmdataRequestGates.ts`）。
    // **門の枠を使う前に見る** —— 取りに行かないものに 6 秒の枠を消費させない。
    // 専用の型で投げるのは、呼び出し側が通常の取得失敗と別の枠で数えるため
    // （→ `types/replay.ts` の `rateLimitedSources`）。
    const id = archiveIdFromUrl(url)
    const until = id ? rateLimitedUntil('archive', id) : null
    if (id && until !== null) throw new RateLimitWindowError(id, until)
    // **枠を待ってから投げる。** 呼び出し側は複数のアーカイブを並べてくるので、ここで
    // 直列化しないと配信元の上限をそのまま超える。**電文本体と枠を共有する** —— 同じ
    // 50req/5min の対象で、レート表の読み方が「3 行それぞれ」とも「3 行の合計」とも
    // 取れるため合算として扱う（→ `services/dmdataRequestGates.ts`）。
    // **控えから読めた分はここを通らない**（`archiveCache.get` が返す）。
    await waitForDataApiSlot()
    const res = await fetch(url, { headers: { Authorization: authHeader(apiKey) } })
    if (!res.ok) {
      // **429 だけは窓を置く**（他の失敗は次の操作で取り直してよい）
      if (id && res.status === 429) noteRateLimited('archive', id)
      throw new Error(`Archive fetch failed: ${res.status}`)
    }
    // **成功したら窓と回数を捨てる**
    if (id) noteRateLimitCleared('archive', id)
    const gz = new Uint8Array(await res.arrayBuffer())
    const { files, bytes } = await expandArchive(gz)
    // **`gz` も渡す。** 端末の控えは圧縮のまま置く（展開比は実測 ×11.5〜×18.1）。
    return { files, bytes, cacheable, gz }
  })
}

/**
 * 目録（`telegrams.json`）のパース結果。鍵はアーカイブの URL。
 *
 * **同じアーカイブの目録を何度も読み直すため。** かつて「もっと見る」が遡る日数を伸ばして
 * 取り直す形だった頃は、押すたびに既に読んだ日の目録も `JSON.parse` し直していた。
 * カーソル方式では窓が重ならないので、いま効くのは初回ロードとリプレイ開始時の復元が
 * 重なる場面と、`StrictMode` の二重実行だけ。リプレイの先読みも、1 日の中を
 * 窓ごとに前へ進むあいだ同じ日の目録を毎回読む。
 *
 * **返した配列は書き換えないこと。** 控えの実体をそのまま渡している。
 *
 * 捨てるのは `clearParseCachesForTest()` だけ（理由はそちら）。
 */
const manifestCache = new Map<string, ManifestEntry[]>()

/**
 * 電文 1 通のパース結果。鍵は目録のエントリ id。
 *
 * **鍵に採れる理由**: 電文の中身は不変で、パース結果は `head.type` と本体だけで決まる。
 * 目録の絞り込み（`includeTest`・窓・打ち切り）はパースに効かないので鍵へ含めなくてよい。
 *
 * **失敗は控えない。** 再パースさせて、警告と取りこぼしの数え方を控える前と変えないため
 * （実運用では 0 件なので、再パースの費用はかからない）。
 *
 * **控えるのは履歴の取得（`fetchDmdataQuakeHistory`）だけ。** リプレイ本編
 * （`fetchDmdataReplayEvents`）は窓を前へ進めながら読むので同じ電文を二度パースせず、
 * 控えても寿命の長い入れ物が増えるだけになる。
 *
 * **上限は置かない。** カーソル方式（`oldestLoadedDay`）では窓が重ならないので、「もっと見る」を
 * 押しても同じ電文を二度パースしない —— 控えが効くのは初回ロードとリプレイ開始時の復元が
 * 重なる場面と、`StrictMode` の二重実行だけ。増分は 1 回につき窓 7 日 × 1 日 8 通ほど
 * （→ `data-sources-spec.md` §2）で、在庫の端（2020-11-18）まで押し切っても約 17,000 件。
 *
 * **上限（LRU）を足すなら、`planNeedsBody` との噛み合わせを先に見ること。** あちらは
 * 「控えにあるか」で本体を落とすかを決め、本体を読む段で控えにも無ければ
 * `planMismatch`（実装の不具合）として数える。1 回の取得の途中で追い出しが起きると、
 * **正常な動作が実装の不具合として記録される。**
 *
 * **返したオブジェクトは書き換えないこと。** 控えの実体をそのまま渡している。書き換えは控える
 * 前から画面の状態を壊すが（同じ参照が state にも載る）、控えると次の取得の入力まで汚れる。
 */
type ParsedTelegram =
  | { kind: 'quake'; quake: JMAQuake }
  | { kind: 'tsunami'; tsunami: JMATsunami }
  | { kind: 'extra'; key: string; payload: ReplayPayload }

const parsedTelegramCache = new Map<string, ParsedTelegram>()

/**
 * 目録の発表時刻を**本体のファイル名から補ったとき**の結果。鍵は目録エントリの id。
 *
 * **補えたものだけを控える。** 目録の時刻が読める通常の経路は控えない（`new Date()` 1 回で済む）。
 *
 * **控える目的は、同じ電文について同じ警告を繰り返さないこと。** 「もっと見る」もリプレイの
 * 先読みも同じ日を何度も走査するので、控えないと押した回数だけ同じ行が並び、他の異常が埋もれる。
 * **黙らせるのではなく、二度目は「もう解けている」として警告の手前で返す** —— 補えなかった
 * ときは控えないので、そちらの記録と取りこぼしの数え方は変わらない。
 *
 * 捨てるのは `clearParseCachesForTest()` だけ（理由はそちら）。
 */
const manifestFallbackTimeCache = new Map<string, Date>()

/**
 * リプレイ本編（`fetchDmdataReplayEvents`）で、JST 日ごとにこれまで報告した取りこぼしの件数。
 *
 * **同じ日を何度も読むから要る。** 本編は初期状態（24 時間）・本編（1 時間）・毎時の先読みで
 * 同じ日を繰り返し走査する（アーカイブは控えから返るので通信は増えないが、**目録の走査は
 * 毎回走る**）。時刻が読めない電文は窓の絞り込みより前に数えるため、その日に留まっている
 * あいだ読むたびに加算され、**壊れた 1 通が 5 件にも 20 件にも見える**。
 *
 * 合流する側（`addTelegramLoss`）は別々の取得を集める前提で足すので、ここで止めるしかない。
 * P2PQuake 経路の `reportedSkipCounts` と同じ役目 —— **あちらにあってこちらに無かった。**
 *
 * **「報告済みの日」の集合ではなく件数で持つ。** 当日ぶんは控えないので走査のたびに取り直し、
 * 後から届いた電文が壊れていれば件数が増える —— 集合だと増えた分を報告できず、
 * 「その日はもう見た」として黙る。差分（増えた分）だけを報告すれば、読み直しでは 0 件、
 * 増えたときはその増分だけが出る。
 *
 * 時間軸が変わったら捨てる（`clearReplayCache`）。同じ日でも別の再生では数え直してよい。
 */
const reportedReplaySkipCounts = new Map<string, number>()

/**
 * 再生に使うセッション内の控えを捨てる。
 *
 * **アーカイブ本体の控えはここで捨てない。** 鍵（URL に入るアーカイブ id）は内容に対して
 * 不変なので捨てる正当性が無く、捨てると**開始のたびに同じファイルを落とし直す** ——
 * 区間ごとにリプレイを開始し直す使い方（録画の自動化）では実測 1,000〜3,800 リクエストに
 * なっていた。メモリは本数とバイト数の上限で抑え、期限も置いてある
 * （→ `utils/archiveBodyCache.ts`）。
 */
export function clearReplayCache(): void {
  clearLiveReplayCache()
  reportedReplaySkipCounts.clear()
}

/**
 * テスト用。目録・電文のパース結果の控えを空にする。
 *
 * **`clearReplayCache()` では捨てない。** 3 つの控えはどれも**内容に対して不変な鍵**
 * （アーカイブの URL・電文の id）で引くので、時間軸が変わっても中身は同じもの ——
 * 捨てる正当性が無い。捨てると、同じ日を何度も再生し直す使い方でそのたびに解析し直す
 * （アーカイブ本体の控え（`utils/archiveBodyCache.ts`）が「開始をまたいで残す」形である
 * のと同じ理由。→ `data-sources-spec.md` §2「アーカイブ本体の控え」）。
 *
 * **テストだけは捨てる必要がある。** テストの目録は `aaaaaaa1` のような作り物の id を
 * 使い回すので、残すと別のテストが仕込んだ中身を引く。
 */
export function clearParseCachesForTest(): void {
  manifestCache.clear()
  parsedTelegramCache.clear()
  manifestFallbackTimeCache.clear()
}

/**
 * アーカイブの中から、その目録エントリの本体ファイル名を探す。
 *
 * 目録の id は 8 桁目以降がアーカイブ内のファイル名と一致しないため、先頭 7 桁で引く。
 */
function findBodyFileName(
  entryId: unknown,
  files: Map<string, Uint8Array>,
  suffix: string,
): string | undefined {
  if (typeof entryId !== 'string') return undefined
  const idPrefix = entryId.slice(0, 7)
  return [...files.keys()].find((n) => n.endsWith(suffix) && n.includes(idPrefix))
}

/**
 * その電文の発表時刻のうち、**本体を落とさずに決まる分**だけを返す。
 *
 * 見るのは目録が名乗る値と、前に本体から補って控えた値（`manifestFallbackTimeCache`）の 2 つ。
 * **`null` は「読めなかった」ではなく「本体が要る」** —— 呼び出し側は本体を落としてから
 * `resolveManifestTime` へ渡す。
 *
 * 文字列であることを先に確かめるのは、`new Date(null)` が Invalid Date ではなく 1970-01-01 を
 * 返すため。数値チェックだけだと null がすり抜け、直後の窓の判定に「ただの古い電文」として
 * 無言で吸収されてしまう（undefined は Invalid Date になる）。
 */
function manifestTimeWithoutBody(entry: ManifestEntry): Date | null {
  const announced = new Date(typeof entry.head?.time === 'string' ? entry.head.time : NaN)
  if (!Number.isNaN(announced.getTime())) return announced
  // 2 度目以降は控えから返す（警告の手前で返るので同じ行が並ばない）
  const cached = typeof entry.id === 'string' ? manifestFallbackTimeCache.get(entry.id) : undefined
  return cached ?? null
}

/**
 * その電文が「いつのものか」。目録が名乗る発表時刻を使い、**読めなければ本体のファイル名に
 * 埋め込まれた受信時刻で補う。**
 *
 * 本体を見ない分は `manifestTimeWithoutBody` が持つ（目録の値と、前に補って控えた値）。
 * **本体が要るかどうかの判定はそちらを使う** —— この関数は本体を受け取ってから呼ぶ。
 *
 * **ファイル名で補うのは代理値ではない。** 窓が問うのは「その時刻に存在したか」で、電文は
 * 受信して初めて画面に出る。受信時刻は発表時刻以降なので、境界では採らない側（安全側）へ倒れる。
 * リプレイ本編は正常時もこの値を再生時刻に使っている（秒で切り捨てられた発表時刻より精度が高い）。
 *
 * **当日経路（`classifyTelegram`）には同じ補いを置けない。** あちらは本体を取る前に判定するので、
 * 補うにはリクエストが増える。**救える側だけ救う**（→ `data-sources-spec.md` §2）。
 *
 * @returns どちらも読めなければ null
 */
function resolveManifestTime(entry: ManifestEntry, files: Map<string, Uint8Array>): Date | null {
  const withoutBody = manifestTimeWithoutBody(entry)
  if (withoutBody) return withoutBody
  const bodyName = findBodyFileName(entry.id, files, '.xml')
    ?? findBodyFileName(entry.id, files, '.bin')
  const received = bodyName ? parseMsFromFileName(bodyName) : null
  if (received && !Number.isNaN(received.getTime())) {
    log.warn(
      '[replay] 目録の発表時刻が読めないため本体のファイル名から補った'
      + ` id=${String(entry.id)} time=${String(entry.head?.time)} → ${received.toISOString()}`,
    )
    if (typeof entry.id === 'string') manifestFallbackTimeCache.set(entry.id, received)
    return received
  }
  return null
}

/**
 * テスト用。アーカイブ本体の控えを空にする。
 *
 * **`clearReplayCache()` とは別の口にしてある。** あちらは本番の経路で、そこで
 * アーカイブの控えを残すことが今回の目的そのもの。テストは同じ URL に違う中身を載せて
 * 使い回すため、こちらで明示的に空にする（本番の値を緩める口ではない）。
 */
export function clearArchiveCacheForTest(): void {
  archiveCache.clear()
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
    // **枠を待ってから投げる。** ここは `api.dmdata.jp` なので本体の門（6 秒）ではなく
    // そちら側の門（500ms）を通る。**ページを辿るループの中なので、応答が速ければ
    // 待ちなしで連投される**（→ `services/dmdataRequestGates.ts`）。
    await waitForApiSlot()
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

/**
 * 目録 1 件について、**本体（`/v1/archive/:id`）を落とさずに決まること**だけをまとめたもの。
 *
 * ## なぜ先に決めるのか
 *
 * 目録（`manifestCache`）と電文のパース結果（`parsedTelegramCache`）は**上限も期限も持たない**のに、
 * 本体の控え（`utils/archiveBodyCache.ts`）は 96 本・128MB・12 時間で落ちる。**控えの寿命が
 * 揃っていない**ので、「解析結果は手元にあるのに本体だけ消えた」状態が普通に起きる —— そこで
 * 落とし直した本体は、下の 3 箇所のどれからも読まれずに捨てられる。効きと成立条件、実際に
 * 数えた値は [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2。
 *
 * ## 判定と消費で同じ述語を使うこと
 *
 * **「本体が要るか」を目録のループとは別に書き写してはいけない。** 絞り込みの連鎖（試験報・
 * 重複排除・種別・窓）は関数ごとに順序まで違うので、2 箇所に置けばいつか食い違う。食い違いの
 * 症状は「本体を落としていないのに本体を読もうとする」で、そのときは電文が黙って
 * 取りこぼしへ回る。
 *
 * そのため**この計画を 1 パスで組み、日ごとの判定（`planNeedsBody`）と消費のループの両方を
 * 同じ配列で回す**。計画に載っていないエントリは、本体を読むまでもなく捨てるものだけ。
 *
 * **配列を共有するだけでは足りない。** 「取り込む対象か」（窓・種別・打ち切り）は `include` に
 * 載せ、消費のループはその値を使う —— 同じ条件を再計算すると、境界（`<` と `<=` の別など）を
 * 片方だけ動かしたときに黙ってずれる。時刻を本体から補った場合だけ `include` が未定になるので、
 * そこは**計画が使ったのと同じ述語**（`isReplayTarget` / `isHistoryTarget`）で決め直す。
 *
 * ## ダウンロードの位置は動かさない
 *
 * 落とすのは**エントリのループへ入る前**のまま。ループの中へ遅延させると、失敗が「その日を
 * 途中まで読んだあと」に起きるため、`failedArchiveUrls` へ積むか否かが決まらなくなる
 * （全滅判定の分母 `judgedDays` に直接効く）。
 */
interface ManifestPlan {
  entry: ManifestEntry
  /** 本体を読まずに決まった発表時刻。`null` は「本体のファイル名から補うしかない」。 */
  time: Date | null
  /**
   * 取り込む対象か（窓・種別・打ち切り）。**`time` が `null` のときは未定**（`null`）——
   * 本体から時刻を補ってから、計画と同じ述語で決め直す。
   */
  include: boolean | null
  /** この 1 件を読み切るのに本体が要るか。 */
  needsBody: boolean
}

/**
 * 本編の再生（`fetchDmdataReplayEvents`）向けの計画。
 *
 * **履歴側と違い、窓に入るエントリは必ず本体が要る** —— 本編はパース結果を控えない
 * （窓を前へ進めるので同じ電文を二度読まない）。効くのは**窓に 1 件も入らない日**で、
 * 静かな 1 時間の窓では本体を読まずに済む。
 *
 * `head` を持たないエントリも（捨てずに）返す —— 消費側が記録して取りこぼしに数えるため。
 */
type ReplayPlan =
  | { kind: 'malformed'; entry: ManifestEntry | undefined; needsBody: false }
  | ({ kind: 'entry' } & ManifestPlan)

function planReplayEntries(
  manifest: ManifestEntry[],
  opts: { includeTest: boolean; fromTime: Date; toTime: Date },
): ReplayPlan[] {
  const plans: ReplayPlan[] = []
  for (const entry of manifest) {
    if (!entry?.head) {
      plans.push({ kind: 'malformed', entry, needsBody: false })
      continue
    }
    if (!opts.includeTest && entry.head.test) continue
    if (entry.originalId) continue
    const time = manifestTimeWithoutBody(entry)
    // 時刻が決まらないなら、補うために本体が要る（`resolveManifestTime`）。
    // **対象かどうかは時刻が決まるまで判らない**ので `include` は未定のまま。
    if (time === null) {
      plans.push({ kind: 'entry', entry, time: null, include: null, needsBody: true })
      continue
    }
    const include = isReplayTarget(entry, time, opts.fromTime, opts.toTime)
    plans.push({ kind: 'entry', entry, time, include, needsBody: include })
  }
  return plans
}

/**
 * 本編の再生で、その電文を取り込む対象か（窓の内側かつ扱う種別か）。
 *
 * **計画（`planReplayEntries`）と消費のループで同じ述語を使う。** 窓の境界（左は含む・右は
 * 含まない）と種別の集合を 2 箇所に書くと、片方だけ動かしたときに黙ってずれる。
 */
function isReplayTarget(entry: ManifestEntry, time: Date, fromTime: Date, toTime: Date): boolean {
  return time >= fromTime && time < toTime && HANDLED_TYPES.has(entry.head.type)
}

/** その日の計画に、本体を要するものが 1 件でもあるか。 */
function planNeedsBody(plans: ReadonlyArray<{ needsBody: boolean }>): boolean {
  return plans.some((p) => p.needsBody)
}

/**
 * 事前判定（`needsBody`）がずれていたときの記録。**到達しない。**
 *
 * **読めなかった取得元（`failedArchiveUrls`）には積まない。** 全滅判定はその件数と分母の
 * **等号**で見るので、電文ごとに積むと件数が分母を越えて等号が成立せず、**本当の全滅を
 * 捕まえられなくなる**。日ごとに 1 度だけ積む形にしても、控えから読めていた分を抱えた日を
 * 「読めなかった」と申告することになり、呼び出し側が結果ごと捨てる。
 *
 * 代わりに呼び出し側が件数を数え、**最後に必ず要約を出す** —— そうしないと、その日は
 * 「静かな日」と見分けが付かなくなる。
 */
function warnBodyNotDownloaded(entry: ManifestEntry, date: string, what: string): void {
  log.error(
    `[replay] 本体を落としていないのに${what}が要求された`
    + ` date=${date} id=${String(entry.id)} type=${String(entry.head?.type)}（事前判定のずれ）`,
  )
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

  // 取り込めなかった電文。1 通ごとの詳細は log.warn / log.error に出るが、「取りこぼしが
  // あったか」だけは最後にまとめて 1 行で分かるようにする。
  //
  // **日ごとに数え**（理由は `utils/telegramLoss.ts` の `skippedByDay`）、さらに
  // **窓を見る前に落ちた分と、窓の中で落ちた分を分ける。** リプレイは窓を進めながら何度も
  // この関数を呼ぶので、片方だけが二重に数えられる。
  //
  // - `scanSkips` ＝ **窓を見る前**（目録の構造異常・時刻が読めない）。その日を走査すれば
  //   毎回同じ顔ぶれが出るので、同じ日の 2 度目以降は報告しない（`reportedReplaySkipCounts`）
  // - `windowSkips` ＝ **窓の中**（本体が無い・パースできない・断片が揃わない）。窓は
  //   重ならないので 1 通はどれか 1 つの窓にしか入らず、足し合わせても重複しない
  //
  // **混ぜてはいけない。** リプレイの開始は本編（`[T, T+1h)`）と初期状態（`[T-24h, T)`）を
  // 並行に読み、どちらも `T` の日を含む。窓の中の破損は互いに素なのに、日ごとの件数ひとつで
  // 増分を取ると**後から報告した側が丸ごと消える** —— 取りこぼしを少なく見せる壊れ方で、
  // 画面には「静かな時間帯だった」としか出ない。
  const scanSkips = createSkipCounter()
  const windowSkips = createSkipCounter()
  /**
   * 事前判定がずれて本体を読めなかった電文の数（→ `warnBodyNotDownloaded`）。
   *
   * **取りこぼしにも数えたうえで、別に集計する。** 取りこぼしとしては事実（その電文は
   * 取り込めていない）だが、原因は実装の不具合なので、「壊れた電文」「揃わなかった断片」と
   * 同じ入れ物に埋もれさせない。
   */
  let planMismatchCount = 0
  // 読み取れなかったアーカイブの URL。取得・展開の失敗だけでなく、目録が無い・壊れている
  // ケースも含める。これらは「アーカイブは落ちてきたが中身を 1 通も読めない」状態であり、
  // 取得エラーと同じく丸ごと欠落する。数え漏らすと UI が無警告のまま「電文 0 件の成功」に化ける。
  const failedArchiveUrls: string[] = []
  /**
   * 429 の窓で見送った取得元。**上の枠と分ける**（→ `types/replay.ts` の
   * `rateLimitedSources`）。混ぜると「すべて読めなかった」の判定に入り、
   * 窓が広いあいだ取れていた分ごと捨てる。
   */
  const rateLimitedSources: string[] = []
  /**
   * 429 の窓で見送った**電文**の数。
   *
   * **取得元（`rateLimitedSources`）とは単位が違う**ので別に数える。表示側は
   * 「取得元N件」「電文N件」と単位を分けて出すため、混ぜると文面が嘘になる。
   */
  let rateLimitedTelegrams = 0

  await Promise.all(
    targets.map(async (item) => {
      // アーカイブ単位で隔離する。ここを Promise.all に素通しすると、1 つのアーカイブの
      // 破損（tar/gzip の異常・CDN の一時エラー）だけで、他のアーカイブから既に読み取れた
      // 電文まで巻き添えで捨てられる。日をまたぐ期間指定ほど被害が大きくなるため、
      // 「壊れたアーカイブだけ諦めて残りは活かす」を既定にする。
      /**
       * 本体を落とす。**失敗は会計へ積んで `null` を返す**（呼び出し側はその日を諦める）。
       *
       * 呼ぶのは 2 箇所（目録が控えに無いとき・計画が本体を要ると答えたとき）で、
       * **どちらもエントリのループへ入る前**。会計の位置を動かさないため（→ `ManifestPlan`）。
       */
      const loadBody = async (): Promise<Map<string, Uint8Array> | undefined> => {
        try {
          return await downloadArchive(item.url, apiKey, item.date)
        } catch (e) {
          if (e instanceof RateLimitWindowError) {
            // **正常な待ちなので `error` では記録しない。** 待てば取れる
            log.info(
              `[replay] アーカイブは 429 の窓が明けるまで取りに行きません date=${item.date}`
              + ` classification=${item.classification}`
              + `（あと ${Math.max(0, Math.round((e.until - Date.now()) / 1000))} 秒）`,
            )
            rateLimitedSources.push(item.url)
            return undefined
          }
          log.error(`[replay] アーカイブの取得・展開に失敗したためスキップ date=${item.date} classification=${item.classification}`, e)
          failedArchiveUrls.push(item.url)
          return undefined
        }
      }

      let files: Map<string, Uint8Array> | undefined
      // 目録は控えから読む（`manifestCache`）。先読みは 1 日の中を窓ごとに前へ進むため、
      // 同じ日のアーカイブを何度も開くことになる。
      // **控えに無いときだけ本体を落とす。**
      let manifest = manifestCache.get(item.url)
      if (!manifest) {
        files = await loadBody()
        if (!files) return
        const manifestBytes = files.get('telegrams.json')
        if (!manifestBytes) {
          // アーカイブは取得できたのに目録が無い＝そのアーカイブの中身を丸ごと読めない。
          // 例外にせず他のアーカイブの処理は続けるが、無言で捨てると「電文 0 件だが成功」に
          // 化けて原因が追えなくなるため、取得失敗と同じ扱いで数える。
          log.warn(`[replay] アーカイブに telegrams.json が無いためスキップ date=${item.date} classification=${item.classification}`)
          failedArchiveUrls.push(item.url)
          return
        }
        try {
          manifest = JSON.parse(dec.decode(manifestBytes)) as ManifestEntry[]
        } catch (e) {
          // 目録自体が壊れている場合も同様に、そのアーカイブのみ諦めて他は継続する。
          log.error(`[replay] telegrams.json の解析に失敗したためスキップ date=${item.date} classification=${item.classification}`, e)
          failedArchiveUrls.push(item.url)
          return
        }
        manifestCache.set(item.url, manifest)
      }

      // 絞り込み（試験報・重複排除・時刻・窓・種別）は計画へ集約してある。
      // **判定と消費で同じ配列を回すこと**が肝（→ `ManifestPlan`）。
      const plans = planReplayEntries(manifest, { includeTest, fromTime, toTime })
      // **窓に 1 件も入らない日は本体を落とさない。** 落としても中身を読まずに捨てるだけで、
      // 静かな 1 時間の窓では毎回それが起きる。
      if (files === undefined && planNeedsBody(plans)) {
        files = await loadBody()
        if (!files) return
      }

      for (const plan of plans) {
        // head を持たないエントリ（目録の構造異常）。素通しすると TypeError がアーカイブ単位の
        // 失敗に化ける。1 件のおかしな行で他の電文まで落とさないよう、計画の段で分けてある。
        if (plan.kind === 'malformed') {
          log.warn(`[replay] head を持たない目録エントリをスキップ id=${plan.entry?.id ?? '(不明)'}`)
          scanSkips.add(item.date)
          continue
        }
        const { entry } = plan

        // 時刻が読めない電文をそのまま通すと replayTime が Invalid Date になり、
        // 再生キューの並べ替え・発火判定が静かに破綻する。**目録の発表時刻が読めなくても
        // 本体のファイル名から補う**（`resolveManifestTime`）。どちらも読めなければ弾く。
        let entryTime = plan.time
        let include = plan.include
        if (entryTime === null) {
          if (files === undefined) {
            warnBodyNotDownloaded(entry, item.date, '発表時刻の補い')
            planMismatchCount++
            scanSkips.add(item.date)
            continue
          }
          entryTime = resolveManifestTime(entry, files)
          // 補えたので、**計画が使ったのと同じ述語**で対象かを決め直す
          if (entryTime !== null) include = isReplayTarget(entry, entryTime, fromTime, toTime)
        }
        if (entryTime === null) {
          log.warn(`[replay] 発表時刻も受信時刻も読めない電文をスキップ id=${entry.id} time=${String(entry.head.time)}`)
          scanSkips.add(item.date)
          continue
        }
        // 窓の外と、この実装が扱わない種別はここで落とす（どちらも通常運転で起きるので
        // 黙って捨てる。先に絞らないと、対象外の電文が大量に警告を出して本当の異常が埋もれる）。
        if (!include) continue

        const headType = entry.head.type
        // ここから先は本体が要る。計画が要ると答えた日は上で落としてある。
        if (files === undefined) {
          warnBodyNotDownloaded(entry, item.date, '電文の読み取り')
          planMismatchCount++
          windowSkips.add(item.date)
          continue
        }

        try {
          // 二進電文（IXAC41）は `.bin` で入り、512KiB を超えると複数エントリに分かれる。
          // **`dec.decode` を通してはいけない** —— 不正なバイトが U+FFFD へ潰れて戻せない。
          if (isBinaryTelegramType(headType)) {
            const binName = findBodyFileName(entry.id, files, '.bin')
            const binBytes = binName ? files.get(binName) : undefined
            if (!binBytes) {
              log.warn(`[replay] 二進電文の本体が見つからずスキップ id=${entry.id} type=${headType}`)
              // **電文ごとに 1 度だけ数える。** 分割は最大 24 断片あり、アーカイブの部分破損では
              // 複数が同時に欠ける。断片ごとに数えると 1 通の障害が断片の数だけ膨らむ。
              // 覚えておくのは、下の `pendingKeys` でもう一度数えないため。
              const key = fragmentKey(headType, 'RJTD', entry.head.time)
              if (!countedBinaryKeys.has(key)) {
                countedBinaryKeys.add(key)
                windowSkips.add(item.date)
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
            // **試験報は取りこぼしに数えない。** 正常な配信で、読めなかったわけではない
            // （非 XML 電文は `entry.head.test` で弾けないため本文で判定する
            // → `isFilteredBinaryTelegram`）。**捨てたことは記録する** —— 理由は
            // `dmdataReplayLive.ts` の同じ判定にある。
            if (binPayload && isFilteredBinaryTelegram(binPayload, includeTest)) {
              log.info(`[replay] 二進電文の試験報を流しません id=${entry.id} type=${headType}`)
              continue
            }
            if (binPayload) {
              const replayTime = (binName ? parseMsFromFileName(binName) : null) ?? entryTime
              entries.push({ payload: binPayload, replayTime })
            } else {
              log.warn(`[replay] 二進電文の読み取りに失敗しスキップ id=${entry.id} type=${headType}`)
              windowSkips.add(item.date)
            }
            continue
          }

          const xmlFileName = findBodyFileName(entry.id, files, '.xml')
          const bodyBytes = xmlFileName ? files.get(xmlFileName) : undefined
          if (!bodyBytes) {
            log.warn(`[replay] 電文の本体が見つからずスキップ id=${entry.id} type=${headType}`)
            windowSkips.add(item.date)
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
            windowSkips.add(item.date)
          }
        } catch (e) {
          // 1 通の想定外の例外で全体を落とさない（XML の破損はパーサが null を返すため
          // ここへは来ず、上の warn として記録される）。以前は個別の
          // try/catch が無く、壊れた電文が 1 通あるだけで Promise.all ごと reject し、
          // その日を含む期間の再生が丸ごと不可能になっていた。
          log.error(`[replay] 電文の取り込みに失敗しスキップ id=${entry.id} type=${headType}`, e)
          windowSkips.add(item.date)
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
    // **鍵からは日を復元できない**ので不明扱い（鍵は種別と発表時刻から作った文字列）。
    log.warn(`[replay] 二進電文の断片が揃いませんでした（分布は出ません）key=${key}`)
    windowSkips.add(UNKNOWN_SKIP_DAY)
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
      windowSkips.addAll(live.skippedByDay)
      scanSkips.addAll(live.scanSkippedByDay)
      rateLimitedTelegrams += live.rateLimitedTelegrams
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
  //
  // **429 の窓で見送った分は分母からも分子からも外す。** こちら側の意図的な待ちなので、
  // 混ぜると窓が広いあいだ「取得に失敗した」として例外へ倒れ、取れていた分ごと捨てる。
  // 全部が見送りだった場合は下の記録で手がかりを残す。
  const sourceDays = targets.length + liveDates.length - rateLimitedSources.length
  if (sourceDays > 0 && failedSourceDays === sourceDays) {
    throw new Error(`Archive fetch failed: 取得元${sourceDays}件すべてを読み取れませんでした`)
  }
  if (rateLimitedSources.length > 0) {
    log.info(
      `[replay] 取得元${rateLimitedSources.length}件は 429 の窓が明けるまで`
      + '取りに行きませんでした（待てば取れます）',
    )
  }

  if (failedArchiveUrls.length > 0) {
    log.warn(`[replay] 取得元 ${sourceDays} 日ぶんのうち ${failedArchiveUrls.length} 件を読めなかった（残りから取り込みを継続）: ${failedArchiveUrls.join(', ')}`)
  }
  // **事前判定のずれは必ず要約を出す。** 出さないと、その日は「静かな窓」と見分けが付かない
  // （読めなかった取得元には積まない。理由は `warnBodyNotDownloaded`）。
  if (planMismatchCount > 0) {
    log.error(
      `[replay] 本体の事前判定がずれた電文が ${planMismatchCount} 件ありました`
      + '（その分は取り込めていません。実装の不具合です）',
    )
  }
  // **窓を見る前に落ちた分だけ、前回からの増分にする**（→ `reportedReplaySkipCounts`）。
  // その日を走査すれば窓に関わらず毎回同じ顔ぶれが出るので、数え直すと壊れた 1 通が
  // 走査した回数だけ増える。当日ぶんは走査のたびに取り直すため件数が増えることがあり、
  // そのときは増えた分だけが出る。
  //
  // **窓の中で落ちた分（`windowSkips`）はそのまま足す。** 窓は重ならないので 1 通は
  // どれか 1 つの窓にしか入らず、増分にすると**並行して読んだ別の窓の分が丸ごと消える**
  // （理由は `scanSkips` の宣言）。
  //
  // **記録（`log.warn`）には報告前の値を使う。** 数えたこと自体は毎回の事実なので、
  // 「2 度目だから 0 件」と記録すると、その回に何が起きたか追えなくなる。
  const scanSkippedAll = scanSkips.toMap()
  const windowSkippedByDay = windowSkips.toMap()
  const replaySkippedTotal = [...scanSkippedAll.values(), ...windowSkippedByDay.values()]
    .reduce((a, b) => a + b, 0)
  const scanSkippedByDay = new Map<string, number>()
  for (const [day, n] of scanSkippedAll) {
    const reported = reportedReplaySkipCounts.get(day) ?? 0
    if (n <= reported) continue
    scanSkippedByDay.set(day, n - reported)
    reportedReplaySkipCounts.set(day, n)
  }
  const replaySkippedByDay = sumSkippedByDay(scanSkippedByDay, windowSkippedByDay)
  if (replaySkippedTotal > 0) {
    log.warn(`[replay] 電文${replaySkippedTotal}件を取り込めなかった（範囲 ${fromTime.toISOString()}〜${toTime.toISOString()}）`)
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

  return { entries, skippedByDay: replaySkippedByDay, failedArchiveUrls, rateLimitedSources, rateLimitedTelegrams }
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
 * 先行して投げた本体の取得の結果。
 *
 * **拒否のまま持たない。** 打ち切り（`shouldStop`）で残りの日を読まずに抜けると、
 * 誰も `await` しない Promise が残る —— そのまま拒否させると **unhandled rejection** になり、
 * 取得の失敗とは無関係な場所でエラーとして現れる。結果に畳んでおけば、読まれなければ
 * 黙って捨てられるだけで済む。
 */
type PrefetchedBody =
  | { files: Map<string, Uint8Array> }
  | { error: unknown }

/** 本体の取得を投げて、結果に畳む（失敗も値として持つ。理由は `PrefetchedBody`）。 */
function prefetchArchiveBody(item: ArchiveItem, apiKey: string): Promise<PrefetchedBody> {
  return downloadArchive(item.url, apiKey, item.date).then(
    files => ({ files }),
    (error: unknown) => ({ error }),
  )
}

/**
 * 履歴の取得（`fetchDmdataQuakeHistory`）向けの計画。**本体を落とさずに決まることだけ**を
 * 1 パスで求める（設計の意図は `ManifestPlan`）。
 *
 * 絞り込みは消費のループと同じ順序で当てる —— 種別 → 打ち切り（`takeQuakes`）→ 重複排除 →
 * 時刻。**パース結果が控えにある電文は本体を要らない**ので、その日の全件が控えに揃っていれば
 * ダウンロードごと省ける。
 *
 * **`head` を持たないエントリは取りこぼしとして数える**（本編の `planReplayEntries` と同じ）。
 * 黙って落とすと、目録が壊れている日ほど「静かな日」に見える。
 */
type HistoryPlan =
  | { kind: 'malformed'; entry: ManifestEntry | undefined; needsBody: false }
  | ({ kind: 'entry'; want: ParsedTelegram['kind'] } & ManifestPlan)

/**
 * 履歴の取得で、その電文を取り込む対象か。**再生開始時刻より後に発表された電文は、その時点で
 * まだ存在しない**（アーカイブは日単位なので、当日ぶんにはこれが必ず混ざる）。
 *
 * **計画（`planHistoryEntries`）と消費のループで同じ述語を使う** —— 境界（`before` ちょうどは
 * 採る）を 2 箇所に書くと、片方だけ動かしたときに黙ってずれる。
 */
function isHistoryTarget(time: Date, before: Date): boolean {
  return time <= before
}

function planHistoryEntries(
  manifest: ManifestEntry[],
  opts: { includeTest: boolean; takeQuakes: boolean; before: Date },
): HistoryPlan[] {
  const plans: HistoryPlan[] = []
  for (const entry of manifest) {
    if (!entry?.head) {
      plans.push({ kind: 'malformed', entry, needsBody: false })
      continue
    }
    if (!opts.includeTest && entry.head.test) continue
    const isQuake = QUAKE_TYPES.has(entry.head.type)
    const isExtra = HISTORY_EXTRA_TYPES.has(entry.head.type)
    const isTsunami = TSUNAMI_TYPES.has(entry.head.type)
    if (!isQuake && !isExtra && !isTsunami) continue
    if (isQuake && !opts.takeQuakes) continue
    // XML 版と JSON 版の 2 エントリで載るうち、XML 版（originalId 無し）だけを拾う
    if (entry.originalId) continue
    // **3 つのセットは互いに素**なので、種別からどの型として読むかが一意に決まる。
    const want: ParsedTelegram['kind'] = isExtra ? 'extra' : isTsunami ? 'tsunami' : 'quake'
    const time = manifestTimeWithoutBody(entry)
    // 時刻が決まらないなら、補うために本体が要る（`resolveManifestTime`）。
    // **対象かどうかは時刻が決まるまで判らない**ので `include` は未定のまま。
    if (time === null) {
      plans.push({ kind: 'entry', entry, want, time: null, include: null, needsBody: true })
      continue
    }
    const include = isHistoryTarget(time, opts.before)
    // **控えにある電文は本体を要らない。** 同じ日に控え済みと未控えが混じることは普通に起き、
    // そのときは 1 件でも要れば落とす（`planNeedsBody`）。
    plans.push({ kind: 'entry', entry, want, time, include, needsBody: include && !parsedTelegramCache.has(entry.id) })
  }
  return plans
}

/**
 * 履歴用に、目録のエントリ 1 件を本体からパースする。**成功したものだけを控える**
 * （`parsedTelegramCache`。控える理由と鍵の取り方はそちらの注記）。
 *
 * @param files 本体。**控えで読み切れる日は落としていない**ので `undefined` を取る
 *   （→ `ManifestPlan`）。控えに無いのに渡されなかったら事前判定のずれなので記録して諦める
 * @param want どの型として読むか。呼び出し側が種別から決める
 * @returns 本体が見つからない・パースできないときは null（警告はここで出す。取りこぼしの
 *   計上は呼び出し側）
 */
function parseHistoryTelegram(
  entry: ManifestEntry,
  files: Map<string, Uint8Array> | undefined,
  dec: TextDecoder,
  want: ParsedTelegram['kind'],
  date: string,
): ParsedTelegram | null {
  const cached = parsedTelegramCache.get(entry.id)
  if (cached) return cached
  if (!files) {
    warnBodyNotDownloaded(entry, date, '電文のパース')
    return null
  }

  const xmlFileName = findBodyFileName(entry.id, files, '.xml')
  const bodyBytes = xmlFileName ? files.get(xmlFileName) : undefined
  if (!bodyBytes) {
    log.warn(`[replay] 履歴用電文の本体が見つからずスキップ id=${entry.id} type=${entry.head.type}`)
    return null
  }
  const xml = dec.decode(bodyBytes)
  let parsed: ParsedTelegram | null = null
  if (want === 'extra') {
    const payload = buildXmlPayload(entry.head.type, xml)
    const key = payload ? historyExtraKey(payload) : null
    if (payload && key !== null) parsed = { kind: 'extra', key, payload }
  } else if (want === 'tsunami') {
    const tsunami = parseTsunamiFromXml(entry.head.type, xml)
    if (tsunami) parsed = { kind: 'tsunami', tsunami }
  } else {
    const quake = parseEarthquakeFromXml(entry.head.type, xml)
    if (quake) parsed = { kind: 'quake', quake }
  }
  if (!parsed) {
    log.warn(`[replay] 履歴用電文のパースに失敗しスキップ id=${entry.id} type=${entry.head.type}`)
    return null
  }
  parsedTelegramCache.set(entry.id, parsed)
  return parsed
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
 * **「もっと見る」はカーソルを進めて呼び直す形。** 呼び出し側は前回の `oldestLoadedDay` の
 * 手前を次の `before` にするので、**窓どうしは重ならない**（→ `useEarthquakes` の
 * `historyCursorRef`）。
 *
 * かつては遡る日数を伸ばして**毎回いちばん新しい日から読み直して**いた。通信はアーカイブの
 * 控え（`archiveCache`）で増えないが、目録と電文は押した回数だけ解析し直していた
 * （上限まで押すと日ごとの解析が累計 311 日ぶん＝実日数 59 日の約 5 倍）。目録
 * （`manifestCache`）と電文のパース結果（`parsedTelegramCache`）を控えているのはその名残で、
 * カーソル方式では初回ロードとリプレイ復元が重なる場面にしか効かない。
 *
 * @param before この時刻より後に発表された電文は採らない（＝窓の上端。カーソル）
 * @param targetEvents 取り込む地震イベント数の**上限**（続報は 1 件と数える）。
 *   **目標ではない** —— 通常は窓を丸ごと読み切るので達しない（→ `HISTORY_EVENT_SAFETY_CAP`）
 * @param maxDays この窓で読む日数（→ `HISTORY_WINDOW_DAYS`）。**遡れる範囲の上限ではない**
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
   * 立つのは接続 effect のクリーンアップ 1 箇所（`useEarthquakes`）で、実際の契機は
   * リプレイの開始・停止／API キーの変更／試験配信の切り替え／画面を離れること。
   *
   * **見る場所は 2 つ**＝本体を投げる前（`prefetchedBodies` の構築ループ）と、日ごとの解析の前。
   * 前者があるので、打ち切られた時点から先の日は**ネットワークへ出ない**。
   * 止められないのは「打ち切りが立つ前に投げた分」だけ。
   *
   * かつては「もう要らない取得が門の枠を予約し続ける」ことを防ぐ意味もあったが、
   * **門が上限まで待たせなくなったのでその理由は消えた**。残る意味は無駄なリクエストと
   * 解析を出さないこと。
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

  // アーカイブがまだ生成されていない日は当日経路で埋める（`fetchDmdataReplayEvents` と同じ理由）。
  // これが無いと、今日を指定した再生で「開始時刻より前の今日の地震」がカードに出ない。
  //
  // **列挙するのは窓の上端から `LIVE_FALLBACK_DAYS` ぶんだけ**（理由はその定数）。窓の全日を
  // 渡すと、在庫の端を越えた窓でアーカイブが無い日を全部「当日経路が埋める日」と見なして
  // `/v2/telegram` を叩き、そのぶん無駄なリクエストが出る。
  const liveFloorMs = before.getTime() - LIVE_FALLBACK_DAYS * DAY_MS
  const liveFrom = new Date(Math.max(startObj.getTime(), liveFloorMs))
  const liveDays = resolveLiveDates(liveFrom, new Date(before.getTime() + 1), items.map(i => i.date))

  // **どちらの担当にもならなかった日は記録する。**
  //
  // 窓の中で「アーカイブの目録に無い」かつ「当日経路の範囲より古い」日は、`sources` に
  // 一度も現れない —— ループを回らないので `usedDays` にも `failedArchiveUrls` にも
  // `skipped` にも載らず、**三層の記録のどれにも引っかからないまま消える**
  // （→ `data-sources-spec.md` §2「読めなかったものは記録する」）。
  //
  // 当日経路を直近へ絞った副作用で、配信元のアーカイブ生成が `LIVE_FALLBACK_DAYS` を超えて
  // 遅れると起きる。起きること自体は避けようがない（当日経路も過去日は返さない）ので、
  // **せめて黙って消えないようにする。**
  //
  // **鳴らさない条件は「在庫の端より古い日」だけ**（`ARCHIVE_START_DAY`）。保存開始より前に
  // アーカイブが無いのは当たり前で、遡り切るたびに警告が出ても困る。
  //
  // **「目録が空だから在庫の端」と決めつけないこと。** 一時的な障害や生成の遅れでも目録は
  // 空になる。そこで鳴らさない作りにしていたため、**この記録がいちばん要る場面でだけ黙る**
  // 状態だった（当日経路の日が残っていると `sources.length === 0` の警告にも掛からず、
  // 最大 `HISTORY_WINDOW_DAYS - LIVE_FALLBACK_DAYS` 日が三層のどこにも載らずに消える）。
  //
  // **`before` より後の日も数えない。** `archiveDaysForWindow` は配信の遅れを見込んで翌日まで
  // 列挙するが、`resolveLiveDates` は `before` までしか見ない。カーソルは「その日の直前」＝
  // 23:59:59.999 を指すので、この差だけで毎回 1 日が未担当に見えてしまう。
  const covered = new Set([...targets.map(t => t.date), ...liveDays])
  const lastDay = toJstDateStr(before)
  const uncovered = [...wantedDays]
    .filter(d => d <= lastDay && d >= ARCHIVE_START_DAY && !covered.has(d))
    .sort()
  if (uncovered.length > 0) {
    log.warn(
      `[replay] 履歴用に、アーカイブにも当日経路にも当たらない日が ${uncovered.length} 日ありました`
      + `（その日の電文は取り込めていません）: ${uncovered.join(', ')}`,
    )
  }

  // 新しい日から使う（カードは新しい順に並ぶため、打ち切りで欠けてよいのは古い側）。
  // アーカイブの日と当日経路の日は排他なので、日付だけで一本に並べられる。
  //
  // **本体の取得はループへ入る前にまとめて投げ、処理だけ日付順に行う**（→ `prefetchedBodies`）。
  // 取れた日から `onPartial` で流す点は変わらない —— 揃うまで待つ形にすると、
  // そのあいだカードが空のままになる。
  const sources: Array<{ date: string; item?: ArchiveItem }> = [
    ...targets.map(item => ({ date: item.date, item })),
    ...liveDays.map(date => ({ date })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  /**
   * ループへ入る前に投げておく本体の取得（アーカイブの URL → 結果）。
   *
   * **かつては 1 日ずつ順に落としていた。** 6 秒の固定間隔の門があったころは並列にしても
   * 門が直列化するので速くならず、むしろ「取れた日から順に流す」ほうが一方的に良かったため。
   * **門を窓ごとの上限へ変えて上限まで待たせなくなったので、その前提は崩れた** ——
   * 直列のままだと往復がそのまま積み上がる（実測: 7 本で 28.8 秒 ＝ 1 本あたり約 4 秒）。
   *
   * **先行させるのは「目録が控えに無い日」だけ。** 目録が控えにある日は、本体が要るかどうかを
   * 計画（`planNeedsBody`）が決める —— そこを飛ばして全件を落とすと、
   * **控えで読み切れる日の本体まで落とす**ことになり、落とした物が 1 バイトも読まれずに捨てられる。
   * 目録が控えに無い日は、目録そのものが本体の中にあるのでどのみち要る。
   *
   * **処理は日付順のまま**（下のループ）。受け取り順で処理すると `onPartial` が新しい日から
   * 順に流れなくなる（カードは新しい順に並ぶ）。
   *
   * **打ち切り（`shouldStop`）はこのループの各反復で見る。** 見ないと、既に要らないと
   * 決まった取得でも全日ぶんがネットワークへ出る —— **`StrictMode` の二重実行では
   * 1 回目が即座に打ち切られる**ので、dev では毎回それを踏む。
   * 止められないのは「打ち切りが立つ前に投げた分」だけで、そこは結果に畳んで捨てる
   * （→ `PrefetchedBody`）。
   */
  const prefetchedBodies = new Map<string, Promise<PrefetchedBody>>()
  for (const source of sources) {
    // **投げる前に打ち切りを見る。** ここを見ないと、既に要らないと決まった取得でも
    // 全日ぶんがネットワークへ出てしまう —— **`StrictMode` の二重実行では 1 回目の
    // 取得が即座に打ち切られる**ので、dev では毎回それが起きる。
    // 見ても止まらないのは「この反復より前に投げた分」だけになる。
    if (shouldStop?.()) break
    if (!source.item) continue
    if (manifestCache.has(source.item.url)) continue
    prefetchedBodies.set(source.item.url, prefetchArchiveBody(source.item, apiKey))
  }

  const dec = new TextDecoder()
  const quakes: JMAQuake[] = []
  /**
   * 同じアーカイブから拾う津波電文。
   *
   * **地震の件数で打ち切らない。** 発表中の津波は数日前に出たものが続いていることがあり、
   * 地震のカードが揃った日で切ると拾えなくなる（帯と長周期を打ち切らないのと同じ理由）。
   * 取得済みのアーカイブから拾うだけなので、増えるのは目録の走査と、その日を初めて読むときの
   * パースだけ（2 度目以降は `parsedTelegramCache` から返る）。
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
  /** 429 の窓で見送った取得元。**`failedArchiveUrls` とは別に数える**（理由は型の説明）。 */
  const rateLimitedSources: string[] = []
  /** 429 の窓で見送った**電文**の数（取得元とは単位が違う）。 */
  let rateLimitedTelegrams = 0
  /** 帯と長周期は種別ごとに最新 1 通だけ残す（鍵の作り方は `historyExtraKey`）。 */
  const extraLatest = new Map<string, { payload: ReplayPayload; timeMs: number }>()
  /** 取りこぼしは**日ごとに**数える（理由は `utils/telegramLoss.ts` の `skippedByDay`）。 */
  const skipCounter = createSkipCounter()
  /**
   * 事前判定がずれて本体を読めなかった電文の数（→ `warnBodyNotDownloaded`）。
   *
   * **`skipped` に混ぜたままにしない。** あちらは「壊れた電文」と同じ入れ物なので、
   * 実装の不具合がその中に埋もれる。
   */
  let planMismatch = 0
  let usedDays = 0
  /** 打ち切ったか。**まだ遡れるかの判定と混ぜない** —— 打ち切りは「もう要らない」、遡れるかは在庫の話。 */
  let stoppedEarly = false
  /**
   * 地震を最後まで読み切れた日（`sources` の日付そのもの）。
   *
   * **「読んだ日」ではなく「読み切った日」を集めること。** 件数の安全弁に達したあとの日も
   * 帯と長周期のために走査は続くので、`usedDays` で代用すると読んでいない日までカーソルが
   * 進み、その範囲の地震が二度と読まれない。
   *
   * **カーソルにするのは、ここから「新しい側から連続している範囲」だけ**（下の
   * `oldestLoadedDay` の組み立て）。1 日でも失敗を挟んだら、その手前で止める。
   */
  const loadedDays = new Set<string>()

  for (const source of sources) {
    // **地震は上限に達した日で打ち切る**（群発の最中だけ効く安全弁。通常は窓を丸ごと読み切る）。
    // 日の途中で切ると同一イベントの続報が分断され、震度速報だけのカードが残りうる。
    //
    // **帯と長周期は打ち切らない**（`HISTORY_EXTRA_TYPES`）。7 日ぶん画面に出続けるもの・
    // 地震ごとに紐づくもので、**地震活動が多い期間ほど早く打ち切られる**と、いちばん復元
    // したい状況（群発の最中）で復元できない。アーカイブは上で並列にダウンロードしてあるので、
    // 増えるのは目録の走査と、その日を初めて読むときの 1 日数通のパースだけ。
    if (shouldStop?.()) { stoppedEarly = true; break }
    const takeQuakes = eventIds.size < targetEvents
    usedDays++

    /**
     * その日を最後まで読み切ったことを記録する（＝カーソルをここまで進めてよい）。
     *
     * **呼ぶのは成功が確定した地点だけ。** ループの頭で済ませていた頃は、この後に続く
     * `continue`（本体の取得失敗・429・`telegrams.json` の欠落・目録の解析失敗・当日経路の
     * 例外）のどれを通ってもカーソルが進み、**窓が重ならない設計と噛み合って失敗した日が
     * 二度と要求されなくなっていた**。429 は「窓が明けるまで待てば取れる」ものなので、
     * とりわけ取り返しがつかない。
     *
     * 失敗した日で止めておけば、次に押したときその日から読み直せる。
     */
    const markDayLoaded = () => { if (takeQuakes) loadedDays.add(source.date) }

    if (!source.item) {
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
        skipCounter.addAll(live.skippedByDay)
        rateLimitedTelegrams += live.rateLimitedTelegrams
        // **429 で見送った電文があれば、その日は読み切っていない。**
        //
        // 当日経路は個々の電文が 429 を受けても例外を投げず `rateLimitedTelegrams` を数えて
        // 先へ進むので、ここは成功として返ってくる。そのまま読み切った扱いにするとカーソルが
        // 前進し、**待てば取れるはずの電文がその日ごと二度と要求されない**。
        // `rateLimitedTelegrams` はスカラーなので、次の窓の結果で表示まで消える。
        //
        // アーカイブ経路は 429 を `continue` で抜けるのでカーソルが止まる。**当日経路だけが
        // 非対称だった。**
        if (live.rateLimitedTelegrams === 0) markDayLoaded()
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

    const { item } = source
    /**
     * 本体を落とす。**失敗は会計へ積んで `null` を返す**（呼び出し側はその日を諦める）。
     *
     * 呼ぶのは 2 箇所（目録が控えに無いとき・計画が本体を要ると答えたとき）で、
     * **どちらもエントリのループへ入る前**。会計の位置を動かさないため（→ `ManifestPlan`）。
     */
    const loadBody = async (): Promise<Map<string, Uint8Array> | undefined> => {
      try {
        // **先に投げてあるならそれを使う**（→ `prefetchedBodies`）。投げていないのは
        // 目録が控えにあった日で、そのときだけここで落とす。
        const pre = prefetchedBodies.get(item.url)
        if (pre) {
          const got = await pre
          if ('error' in got) throw got.error
          return got.files
        }
        return await downloadArchive(item.url, apiKey, item.date)
      } catch (e) {
        if (e instanceof RateLimitWindowError) {
          // **取得の失敗と別の枠で数える。** 打てる手が違い（こちらは窓が明けるまで待つ）、
          // 全滅判定の分母にも混ぜない（→ `types/replay.ts` の `rateLimitedSources`）。
          log.info(
            `[replay] 履歴用アーカイブは 429 の窓が明けるまで取りに行きません date=${item.date}`
            + `（あと ${Math.max(0, Math.round((e.until - Date.now()) / 1000))} 秒）`,
          )
          rateLimitedSources.push(item.url)
        } else {
          log.error(`[replay] 履歴用アーカイブの取得・展開に失敗 date=${item.date}`, e)
          failedArchiveUrls.push(item.url)
        }
        return undefined
      }
    }

    let files: Map<string, Uint8Array> | undefined
    // 目録は控えから読む（`manifestCache`）。カーソル方式では「もっと見る」が同じ日を
    // 読み直さないので、当たるのは初回ロードとリプレイ開始時の復元が重なる場面だけ。
    // **控えに無いときだけ本体を落とす。**
    let manifest = manifestCache.get(item.url)
    if (!manifest) {
      files = await loadBody()
      if (!files) continue
      const manifestBytes = files.get('telegrams.json')
      if (!manifestBytes) {
        log.warn(`[replay] 履歴用アーカイブに telegrams.json が無いためスキップ date=${item.date}`)
        failedArchiveUrls.push(item.url)
        continue
      }
      try {
        manifest = JSON.parse(dec.decode(manifestBytes)) as ManifestEntry[]
      } catch (e) {
        log.error(`[replay] 履歴用アーカイブの telegrams.json 解析に失敗 date=${item.date}`, e)
        failedArchiveUrls.push(item.url)
        continue
      }
      manifestCache.set(item.url, manifest)
    }

    // 絞り込み（試験報・打ち切り・重複排除・時刻）は計画へ集約してある。
    // **判定と消費で同じ配列を回すこと**が肝（→ `ManifestPlan`）。
    const plans = planHistoryEntries(manifest, { includeTest, takeQuakes, before })
    // **控えで読み切れる日は本体を落とさない。** 目録もパース結果も上限と期限を持たないので、
    // 本体だけが先に落ちる組み合わせが普通に起きる（→ `ManifestPlan`）。
    if (files === undefined && planNeedsBody(plans)) {
      files = await loadBody()
      if (!files) continue
    }

    for (const plan of plans) {
      if (plan.kind === 'malformed') {
        log.warn(`[replay] 履歴用に head を持たない目録エントリをスキップ id=${plan.entry?.id ?? '(不明)'}`)
        skipCounter.add(item.date)
        continue
      }
      const { entry } = plan
      // 目録の発表時刻が読めなければ本体のファイル名から補う（`resolveManifestTime`）。
      let entryTime = plan.time
      let include = plan.include
      if (entryTime === null) {
        if (files === undefined) {
          warnBodyNotDownloaded(entry, item.date, '発表時刻の補い')
          planMismatch++
          skipCounter.add(item.date)
          continue
        }
        entryTime = resolveManifestTime(entry, files)
        // 補えたので、**計画が使ったのと同じ述語**で対象かを決め直す
        if (entryTime !== null) include = isHistoryTarget(entryTime, before)
      }
      if (entryTime === null) {
        log.warn(`[replay] 履歴用電文の発表時刻も受信時刻も読めないためスキップ id=${entry.id}`)
        skipCounter.add(item.date)
        continue
      }
      if (!include) continue

      try {
        // どの型として読むかは計画が種別から決めている（`planHistoryEntries`）。
        // **本体が無いのに要求された場合も `null`** が返る（`warnBodyNotDownloaded` が鳴る）。
        // その 1 件は事前判定のずれとして別に数える。
        if (files === undefined && !parsedTelegramCache.has(entry.id)) planMismatch++
        const parsed = parseHistoryTelegram(entry, files, dec, plan.want, item.date)
        if (!parsed) { skipCounter.add(item.date); continue }
        switch (parsed.kind) {
          case 'extra': {
            // 帯と長周期は「種別ごとに最新 1 通」だけを残す（画面に出るのは 1 つ・長周期は
            // 地震ごと）。古い報まで流すと、初期状態が入れた新しい値を上書きしうる。
            const prev = extraLatest.get(parsed.key)
            if (!prev || entryTime.getTime() > prev.timeMs) {
              extraLatest.set(parsed.key, { payload: parsed.payload, timeMs: entryTime.getTime() })
            }
            break
          }
          case 'tsunami':
            tsunamis.push(parsed.tsunami)
            break
          case 'quake':
            quakes.push(parsed.quake)
            eventIds.add(extractQuakeEventIdFromId(parsed.quake.id) ?? parsed.quake.id)
            break
        }
      } catch (e) {
        log.error(`[replay] 履歴用電文の取り込みに失敗しスキップ id=${entry.id} type=${entry.head.type}`, e)
        skipCounter.add(item.date)
      }
    }
    // ここまで来たらその日は読み切っている（本体も目録も取れ、全エントリを回し終えた）。
    // **個々の電文の解析失敗（`skipped`）は日の失敗にしない** —— 壊れた 1 通のために
    // その日ごと読み直しても、次も同じ 1 通で失敗する。
    markDayLoaded()
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

  // **カーソルは「新しい側から連続して読み切れた範囲」の最古まで。**
  //
  // `sources` は新しい日から並ぶので、頭から見て最初に読み切れていない日が現れたところで
  // 止める。**「読み切った日のうち最も古いもの」を採ってはいけない** —— 失敗した日を挟んで
  // さらに古い日が成功していると、その穴を跨いでカーソルが進み、窓が重ならない設計と
  // 噛み合って**失敗した日が二度と要求されなくなる**。
  //
  // 止まる理由は 4 つとも同じ扱いでよい（どれも「その日から先はまだ読んでいない」）。
  //   - その日の取得に失敗した（`markDayLoaded` を呼ばずに `continue` した）
  //   - 件数の安全弁に達して地震を取り込まなかった（`takeQuakes` が偽）
  //   - `shouldStop` で打ち切った（そもそもループに入っていない）
  //   - **どの担当にもならなかった**（`uncovered`。下記）
  //
  // **`sources` を辿るだけでは足りない。** どの担当にもならなかった日はこの配列に現れないので、
  // `break` の対象にすらならず素通りする —— そのまま進むと、窓が重ならない設計と噛み合って
  // **その日が二度と要求されない**。`log.warn` は残るが画面には何も出ないので静かに欠ける。
  // 最も新しい未担当日（`uncovered` は昇順）より古い日は、読めていても採らない。
  const newestUncovered = uncovered.length > 0 ? uncovered[uncovered.length - 1] : null
  let oldestLoadedDay: string | null = null
  for (const source of sources) {
    if (!loadedDays.has(source.date)) break
    if (newestUncovered !== null && source.date <= newestUncovered) break
    oldestLoadedDay = source.date
  }

  // 使おうとした日がすべて読めなかった場合だけ例外にする（認証エラー・全断などの共通原因が
  // ほとんどで、握り潰すと「履歴 0 件の成功」に化ける）。1 日でも読めていれば部分成功とする。
  //
  // **打ち切りを全滅と混ぜない。** 読んだ日がすべて失敗していても、途中で打ち切られたなら
  // それは「もう要らない」状態で、呼び出し側は結果ごと捨てる（`usedDays` は打ち切り判定の
  // **後**に増えるので、数日失敗してから打ち切られた形で両方が成立しうる）。例外にすると、
  // API キーの差し替えやリプレイの開始のたびに「取得に失敗した」という記録が残る。
  // **429 の窓で見送った日は分母からも外す。** この判定は認証切れ・全断のような共通原因を
  // 捕まえるためのもので、こちら側の意図的な見送りを混ぜると、窓が広いあいだ
  // **取れていた日のカードごと捨てる**（例外にすると呼び出し側は結果を使わない）。
  //
  // **分子だけ外しても足りない。** `usedDays` は見送った日も数えているので、分母をそのままに
  // すると「一部は本当に失敗し、残りは見送られた」＝**その回で 1 件も取れていない**状態で
  // 等号が成立せず、例外が飛ばない —— 握り潰して「履歴 0 件の成功」に化ける。
  // 兄弟関数（`fetchDmdataReplayEvents` の `sourceDays`）と同じ形に揃える。
  const judgedDays = usedDays - rateLimitedSources.length
  if (!stoppedEarly && judgedDays > 0 && failedArchiveUrls.length === judgedDays) {
    throw new Error(`Archive fetch failed: 取得元${judgedDays}件すべてを読み取れませんでした`)
  }
  // **見送りは例外にしない**（待てば取れる）。ただし全部が見送りだと画面は
  // 「静かな期間だった」と見えるので、手がかりを残す。
  if (rateLimitedSources.length > 0) {
    log.info(
      `[replay] 履歴用の取得元 ${usedDays} 日ぶんのうち ${rateLimitedSources.length} 件は`
      + '429 の窓が明けるまで取りに行きませんでした（待てば取れます）',
    )
  }
  const historySkippedByDay = skipCounter.toMap()
  const historySkippedTotal = [...historySkippedByDay.values()].reduce((a, b) => a + b, 0)
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
      + `（読めた地震電文=${quakes.length} 件・扱えなかった電文=${historySkippedTotal} 件）`,
    )
  }
  // **事前判定のずれは必ず要約を出す。** 出さないと、その日は「静かな日」と見分けが付かない
  // （読めなかった取得元には積まない。理由は `warnBodyNotDownloaded`）。
  if (planMismatch > 0) {
    log.error(
      `[replay] 履歴用に本体の事前判定がずれた電文が ${planMismatch} 件ありました`
      + '（その分は取り込めていません。実装の不具合です）',
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
  // **「さらに古い方に在庫がありそうか」。**
  //
  // 止めてよい理由は 2 つだけ ——「窓が保存開始（`ARCHIVE_START_DAY`）より古い」か「打ち切った」。
  //
  // **「目録が空だから在庫の端」で止めないこと。** 一時的な障害や生成の遅れでも目録は空に
  // なるので、そこで押せなくすると**障害のあいだ黙ってボタンが死ぬ**（しかもその窓の日は
  // どの記録にも残らない。上の `uncovered` と同じ思い込みだった）。押し直せば取り直せる形の
  // ほうが安全側 —— 在庫が本当に尽きていれば、窓が保存開始を越えた時点で止まる。
  //
  // **`sources` で数えないこと**（当日経路の日を含むので、在庫の端でも真を返し続ける）。
  //
  // **目標件数に達したかどうかは見ない。** 達していても在庫は残っているので、呼び出し側は
  // カーソル（`oldestLoadedDay`）を進めて次の窓を読める。かつては呼び出し側が遡り幅の上限に
  // 達したかどうかで判定していて、**件数で打ち切った回も上限に達したと見なして押せなく
  // なっていた**（読み残した日を抱えたままボタンが死ぬ）。
  //
  // 打ち切った場合は「もう要らない」ので真にしない（`stoppedEarly`）。
  const windowReachesInventory = [...wantedDays].some(d => d >= ARCHIVE_START_DAY)
  const hasMore = !stoppedEarly && windowReachesInventory
  return {
    quakes: orderedForMerge(quakes), tsunamis, extras, skippedByDay: historySkippedByDay,
    // **どの担当にもならなかった日も「読めなかった取得元」として画面へ出す。** カーソルは
    // その日で止まるので（上記）、出さないと**押しても何も増えないボタンが、理由の分からない
    // まま残る** —— 記録は `log.warn` にしかなく、利用者には「静かな期間だった」としか見えない。
    //
    // **積むのはここ（返す直前）で、`failedArchiveUrls` そのものへは入れない。** あちらは
    // 全滅判定（`failedArchiveUrls.length === judgedDays`）の分子なので、取りに行っていない日を
    // 混ぜると等号が成立して、読めていたカードごと例外で捨てることになる。
    //
    // 日を識別子にするのは当日経路の `live-telegram:<日>` と同じ形。呼び出し側は集合へ積むので
    // 同じ日を何度返しても 1 件のまま。
    failedArchiveUrls: [...failedArchiveUrls, ...uncovered.map(d => `uncovered:${d}`)],
    rateLimitedSources, rateLimitedTelegrams, hasMore, oldestLoadedDay,
  }
}
