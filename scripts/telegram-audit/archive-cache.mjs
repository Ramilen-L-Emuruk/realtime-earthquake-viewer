// DMDATA アーカイブ（日ごとの `.tar.gz`）の取得と、**それを使うスクリプトの定型**を
// 1 箇所へ集約する。
//
// **取得だけのモジュールではない。** API キーの読み取り（`apiAuthHeader`）・取得の実測値の
// 報告（`reportArchiveCacheStats`）・実行の定型（`runArchiveScript`）も持つ。取得ロジック
// だけが欲しい利用者が現れたら、そのとき切り分けを考えること —— いま使っている 6 本
// （監査 3 本・テストデータの生成 3 本）はどれも報告まで必要とする。
//
// **同じ日を二度取らない。** アーカイブは 1 日分を締めたあとに生成される不変のファイルなので、
// 一度取ればローカルの控えで足りる。集約する前は 3 本のスクリプトがそれぞれ素の `fetch` で
// 取っていて、走査し直すたびに全日分を取り直していた（実測 2026-09-13: 2099 日分の走査を
// 1 時間半で 3 回 ＝ 約 6,300 リクエスト。配信元から利用量の指摘を受けた直接の原因）。
//
// **配信元の制限に合わせて待つ。** アーカイブ本体（`data.api.dmdata.jp/v1/archive/:id`）は
// 50req/5min ＝ 6 秒に 1 件で、利用規約も「定常的に 2req/s 以上のアクセスはお控えいただき」と
// 定めている（→ https://dmdata.jp/docs/reference/api/v2/ 「レートリミット」）。
//
// **待つのはネットワークへ出るときだけ。** 控えから読めた分はゲートを通さないので、2 回目以降の
// 走査は取得を待たずに全速で回る。初回だけ時間がかかる形にしてある。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
// **`coverage-core.mjs` から取らない。** あちらは import した時点で `TELEGRAM_AUDIT_DIR` を
// 要求して throw するため、このモジュール（根のパスしか要らない）まで環境変数に縛られ、
// レート制御を単体テストへ掛けられなくなる。
import { REPO } from '../lib/repo-root.mjs'
// レート制御は `scripts/lib/rateGate.mjs` に集約している。**DMDATA 専用ではない** ——
// `kind` で取得元を分ける汎用の門で、P2PQuake の履歴走査・観測点索引の走査も同じものを通す。
import { gate, resetRateGateForTest, sleep } from '../lib/rateGate.mjs'
// 不完全さの印も共有の仕組みへ寄せる。**ここで積んだ分は、下流が `readArtifact` で読んだ
// 時点で自動的に引き継がれる**（`scripts/lib/incompleteness.mjs`）。
import { noteIncomplete, reportIncompleteness, resetIncompletenessForTest } from '../lib/incompleteness.mjs'

/** 控えの置き場所。`.claude/*` は `.gitignore` 済み（`nii-cache` / `hypocenter-cache` と同じ扱い）。 */
export const ARCHIVE_CACHE_DIR = process.env.DMDATA_ARCHIVE_CACHE
  || path.join(REPO, '.claude', 'dmdata-archive-cache')

/**
 * 本体の取得間隔。`data.api.dmdata.jp/v1/archive/:id` の 50req/5min に合わせる。
 * **この値を下げないこと** —— 下げれば制限に触れ、触れなくても規約の「2req/s 以下」から外れる。
 */
const BODY_MIN_INTERVAL_MS = 6_000
/** 一覧（`api.dmdata.jp/v2/archive`）の取得間隔。ドメイン全体の 10 分 2000 リクエストに対して十分余裕がある。 */
const LIST_MIN_INTERVAL_MS = 500
/**
 * 一覧のページを辿る上限。**外すと 1 回の操作で数百リクエストが飛ぶ。**
 *
 * 実際に踏んだ（2026-09-15・アプリ側の同じ形のループ）。範囲外の日付を渡したところ、
 * 配信元は範囲指定を無視したかのように `nextToken` を返し続け、合計 399 リクエストを辿った。
 * 1 ページ 100 件 × 20 ページ ＝ 2000 件あれば、この script が渡す範囲には十分。
 */
const LIST_MAX_PAGES = 20
/** 429（レート制限）・409・5xx で待ち直す回数。超えたら呼び出し側へ投げて「見ていない」として扱わせる。 */
const MAX_RETRY = 5

const stats = { cacheHits: 0, downloads: 0, retryWaits: 0, bytesDownloaded: 0, failures: [] }

/**
 * 取得の実測値。走査のあとに出して、何件を控えで済ませたかを残す。
 *
 * **`failures` はここで数える。** 呼び出し側の `catch { continue }` に任せると、
 * 3 本のうち記録を持つのは 1 本だけになる（実際そうなっていた）。これらのスクリプトは
 * 「この種別は 0 件だった」という**網羅性の主張の根拠**を作るものなので、
 * 「見ていない」を「無い」に潰す穴は共有モジュール側で塞ぐ。
 */
export function archiveCacheStats() {
  return { ...stats, failures: [...stats.failures] }
}

/**
 * 取得できなかった範囲を 1 箇所で記録する。
 *
 * **内訳（`stats.failures`）と共有の台帳の両方へ入れる。** 前者はこのモジュールの実測値
 * （分類・日・理由を構造のまま持つ）で、後者は下流へ運ぶための印。2 箇所へ別々に書くと
 * 片方だけ足し忘れる形の穴が開くので、必ずこの関数を通す。
 */
function pushFailure(classification, day, error) {
  stats.failures.push({ classification, day, error })
  noteIncomplete('アーカイブの取得', `${classification} ${day}: ${error}`)
}

/**
 * テスト用。**モジュールに溜まる状態をまとめて空にする**（枠の予約と取得の実測値）。
 *
 * 2 つに分けないのは呼び忘れを防ぐため —— `failures` が残ったまま次のテストへ入ると、
 * 「失敗が無いときの振る舞い」を確かめるテストが**実行順によって落ちる**。
 */
export function resetArchiveCacheForTest() {
  resetRateGateForTest()
  resetIncompletenessForTest()
  stats.cacheHits = 0
  stats.downloads = 0
  stats.retryWaits = 0
  stats.bytesDownloaded = 0
  stats.failures.length = 0
}

/**
 * レート制御と 429 の待ち直しを載せた `fetch`。
 *
 * **`ok` でない応答をそのまま返す。** 404 などは呼び出し側の判断（その日は無い等）に委ねる。
 * ここで面倒を見るのは「待てば通る」種類（429 / 409 / 5xx）だけ。
 */
async function fetchWithRate(url, { auth, kind, minIntervalMs }) {
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    await gate(kind, minIntervalMs)
    let res
    try {
      res = await fetch(url, { headers: auth })
    } catch (e) {
      lastErr = e
      // 通信そのものの失敗。指数で待ち直す
      if (attempt < MAX_RETRY) await sleep(minIntervalMs * Math.pow(2, attempt - 1))
      continue
    }
    if (res.status !== 429 && res.status !== 409 && res.status < 500) return res
    lastErr = new Error(`HTTP ${res.status}`)
    stats.retryWaits++
    // 429 は「投げ過ぎた」の合図。**間隔を空けて待ち直す**（規約が指数バックオフを求めている）。
    // 5xx も同じ待ち方をするが、**原因は別**（配信元の障害）。数えるカウンタと文言を
    // 「レート制限」に寄せると、切り分ける人に誤った原因を疑わせる。
    const backoff = minIntervalMs * Math.pow(2, attempt)
    console.error(`  HTTP ${res.status}: ${Math.round(backoff / 1000)} 秒待って再試行します（${attempt}/${MAX_RETRY}）`)
    if (attempt < MAX_RETRY) await sleep(backoff)
  }
  throw lastErr ?? new Error('取得に失敗しました')
}

/**
 * 地震情報・津波・長周期地震動・推計震度分布図が入る分類。
 *
 * **呼び出し側で文字列を書かないこと。** 3 本の生成スクリプトが個別に同じ定数を持っていた。
 * 緊急地震速報は別（`eew.forecast` / `eew.warning`）で、そちらは対象が 2 つあるため
 * 定数にしていない —— 使う側がどちらを見るか選ぶ必要がある。
 */
export const EARTHQUAKE_CLASSIFICATION = 'telegram.earthquake'

/**
 * アーカイブの一覧を全ページ辿って返す。
 *
 * **分類ごとに分かれている。** 対象がどれに属するかを先に確かめること —— 2026-09-11 に
 * `telegram.earthquake` だけを見て「訓練の EEW は 1 通も無い」と誤った実績がある。
 * 地震情報と津波はどちらも `telegram.earthquake`、緊急地震速報は `eew.forecast` / `eew.warning`。
 */
export async function listArchive({ classification, from, to, auth }) {
  const out = []
  let token = null
  // **投げる前に記録する。** 呼び出し側はこの失敗を捕まえて次の分類・次のレンジへ進むので
  // （全体を止めると、それまでの集計も末尾の記録も出ない）、記録がここに無いと
  // 「その期間を走査できなかった」ことがどこにも残らない。
  try {
    let page = 0
    for (; page < LIST_MAX_PAGES; page++) {
      const u = new URL('https://api.dmdata.jp/v2/archive')
      u.searchParams.set('datetime', `${from}~${to}`)
      u.searchParams.set('classification', classification)
      u.searchParams.set('limit', '100')
      if (token) u.searchParams.set('cursorToken', token)
      const res = await fetchWithRate(u, { auth, kind: 'list', minIntervalMs: LIST_MIN_INTERVAL_MS })
      const j = await res.json()
      if (j.status !== 'ok') {
        throw new Error(`status=${j.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`)
      }
      out.push(...j.items)
      if (!j.nextToken) break
      token = j.nextToken
    }
    // **上限に達したら失敗として扱う。** 黙って切ると、走査できなかった期間が
    // 「アーカイブが無かった」に化けて集計へ混ざる（この script は網羅性を主張するために使う）。
    if (page >= LIST_MAX_PAGES) {
      throw new Error(`ページ上限（${LIST_MAX_PAGES}）に達した。範囲指定が効いていない疑いがある`)
    }
  } catch (e) {
    pushFailure(classification, `${from}~${to}（一覧）`, String(e?.message ?? e))
    // **分類・期間を文面へ含めない。** 呼び出し側が文脈を付けて出すので、含めると二重になる
    // （`eew.forecast: 一覧の取得に失敗: eew.forecast 2025-01-01~...` のように）。
    throw new Error(`一覧の取得に失敗（${from}~${to}）: ${e?.message ?? e}`)
  }
  return out
}

/**
 * 一覧のアイテムが指す日。控えの名前と失敗の記録で同じ値を使う。
 *
 * **`item.datetime ?? item.date` を呼び出し側で書き写さないこと。** 上流はどちらの名前でも
 * 返しうるので、片方だけを見る形にすると、名前が変わった日に「その日のアーカイブが無い」へ
 * 化ける。生成スクリプト 3 本（`build-test-quake` ほか）が `date` だけを見ていた。
 */
export function dayOf(item) {
  return String(item.datetime ?? item.date ?? 'unknown')
}

/** 控えのファイル名。**一覧が示す id を含める** ので、上流が作り直せば別のファイルになり自動で取り直す。 */
function cachePathFor(classification, item) {
  const day = dayOf(item)
  const id = String(item.id ?? item.url ?? '').split('/').pop() ?? ''
  const safeDay = day.replace(/[^0-9A-Za-z-]/g, '-')
  const safeId = id.replace(/[^0-9A-Za-z]/g, '').slice(0, 16)
  return path.join(ARCHIVE_CACHE_DIR, classification.replace(/\./g, '-'), `${safeDay}__${safeId}.tar.gz`)
}

/**
 * 1 日分のアーカイブを tar の中身（gzip を解いた Buffer）として返す。控えがあればそれを使う。
 *
 * **控えへ書く前に必ず解けることを確かめる。** 途中で切れた応答をそのまま置くと、以後
 * 何度走査しても同じ壊れたファイルを読み続ける（取り直す契機がどこにも無い）。
 * 書き込みは一時ファイルへ出してから `rename` する —— 走査中に中断されても、中途半端な
 * ファイルが控えとして残らない。
 */
export async function loadArchiveTar({ classification, item, auth }) {
  const cachePath = cachePathFor(classification, item)
  if (fs.existsSync(cachePath)) {
    try {
      const tar = zlib.gunzipSync(fs.readFileSync(cachePath))
      stats.cacheHits++
      return tar
    } catch (e) {
      // 解けない控えは残しても読めないので捨てて取り直す。**黙って消さない**
      console.error(`  控えが読めないため取り直します（${path.basename(cachePath)}）: ${e.message ?? e}`)
      try { fs.rmSync(cachePath) } catch { /* 消せなくても取得は続ける */ }
    }
  }

  // **失敗はここで数える。** 呼び出し側は `catch { continue }` で先へ進むものがあり、
  // そこへ任せると「取得できなかった日」がどこにも残らない（下の `reportArchiveCacheStats`
  // が必ず出す）。投げ直すのは、日ごとの記録を持つ呼び出し側（`fetch-quake-times.mjs` の
  // `meta.failedDays`）の扱いを変えないため。
  try {
    const res = await fetchWithRate(item.url, { auth, kind: 'body', minIntervalMs: BODY_MIN_INTERVAL_MS })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const gz = Buffer.from(await res.arrayBuffer())
    // 解けることを確かめてから控える（壊れたものを焼き付けない）
    const tar = zlib.gunzipSync(gz)
    stats.downloads++
    stats.bytesDownloaded += gz.length

    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    const tmp = `${cachePath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, gz)
    fs.renameSync(tmp, cachePath)
    return tar
  } catch (e) {
    pushFailure(classification, dayOf(item), String(e?.message ?? e))
    throw e
  }
}

/** tar の中身を順に返す（ファイル名と本体）。3 本のスクリプトで同じ実装を持たないため、ここに置く。 */
export function* tarEntries(buf) {
  let o = 0
  while (o + 512 <= buf.length) {
    const name = buf.slice(o, o + 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) { o += 512; continue }
    const size = parseInt(buf.slice(o + 124, o + 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    yield { name, body: buf.slice(o + 512, o + 512 + size) }
    o += 512 + Math.ceil(size / 512) * 512
  }
}

/** API キーを読む。**ワークツリーには `.env.local` が無い**ことがある（Git 管理外なので切っても付いてこない）。 */
export function apiAuthHeader() {
  const key = (() => {
    if (process.env.DMDATA_API_KEY) return process.env.DMDATA_API_KEY.trim()
    const envPath = path.join(REPO, '.env.local')
    if (fs.existsSync(envPath)) {
      const m = fs.readFileSync(envPath, 'utf8').match(/^DMDATA_API_KEY=(.+)$/m)
      if (m) return m[1].trim()
    }
    throw new Error(`DMDATA の API キーが見つかりません。DMDATA_API_KEY で渡すか ${path.join(REPO, '.env.local')} に置いてください`)
  })()
  return { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') }
}

/**
 * 走査の終わりに実測値を出す。「何件を控えで済ませたか」が分かると、次の走査の見積もりが立つ。
 *
 * **取得できなかった範囲はここでは出さない。** 印の報告は
 * `scripts/lib/incompleteness.mjs` の `reportIncompleteness` に集約してある ——
 * アーカイブ以外の取りこぼし（P2PQuake の履歴・上流から引き継いだ分）と同じ場所で
 * 数えないと、経路ごとに数え方が割れる。呼び出し側は 2 つを並べて呼ぶ。
 *
 * 数えるのは**範囲**で、日数ではない —— アーカイブ本体は 1 日 1 ファイルなので日と一致するが、
 * 一覧の失敗は `2026-01-01~2026-01-02（一覧）` のようにレンジ単位で 1 件になる。
 */
export function reportArchiveCacheStats(label = 'アーカイブ') {
  const s = archiveCacheStats()
  const mb = (s.bytesDownloaded / 1024 / 1024).toFixed(1)
  console.error(
    `${label}: 控えから ${s.cacheHits} 件 / 取得 ${s.downloads} 件（${mb} MB）`
    + (s.retryWaits > 0 ? ` / 待ち直し ${s.retryWaits} 回（レート制限・サーバーエラー）` : '')
  )
  console.error(`  控えの場所: ${ARCHIVE_CACHE_DIR}`)
}

/**
 * アーカイブを取るスクリプトの定型。**取得の実測値と取りこぼしの印を、成功・失敗のどちらでも出す。**
 *
 * **`finally` で出す理由は、失敗した回こそ見たい情報だから。** 何件を控えで済ませたか・
 * 429 で何回待ち直したかはここにしか出ない —— 本体の末尾で出す形にすると、途中で投げた回は
 * 1 件も出ないまま「エラー 1 行」で終わる。
 *
 * **2 つを並べて呼ぶ**のは、数える場所が別だから（取得の実測値はこのモジュール、
 * 取りこぼしの印は `lib/incompleteness.mjs`）。片方だけ呼ぶと「何件取ったか」か
 * 「何を見ていないか」のどちらかが消える。実際、テストデータの生成スクリプト 3 本が
 * 前者だけを呼んでいた。
 *
 * 印が残ったまま本体が完走した場合は終了コードを立てる。**いまは取得の失敗が必ず例外になるので
 * その経路は無いが、「失敗は必ず throw される」という前提に頼らない。**
 *
 * **監査スクリプト（`fetch-samples.mjs` ほか）はこれを通らない。** あちらはトップレベルで
 * 処理してから末尾で 2 つを並べて呼ぶ形で、包む本体を持たない。**寄せるなら向こうの構造ごと
 * 変える必要がある**ので、いまは同じ規約を別の形で満たしている状態。
 *
 * @param {string} label 報告の見出し。**同じスクリプトを引数違いで走らせる場合は変えること** ——
 *   固定にすると、ログからどちらを実行した結果か分からない
 * @param {() => Promise<void>} build 本体
 */
export async function runArchiveScript(label, build) {
  try {
    await build()
  } finally {
    reportArchiveCacheStats(label)
    if (reportIncompleteness(label) > 0) process.exitCode = 1
  }
}
