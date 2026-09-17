// P2PQuake の実データを集める（公開 API・**認証不要**）。standard 版が実際に受け取る形の標本。
//
// テストデータの突き合わせ（`testdata-shapes.mjs`）が「standard 版で作れる項目」の実測に使う。
// **実測だけでは足りない** —— 552（津波）は直近 600 件に 1 件も無いことがある。突き合わせ側は
// `p2pquake.ts` のリテラルのキーで補うが、その理由はここが 0 件を返しうるからで、
// **0 件だったことも記録に残す**（「見ていない」と「無い」を分けるため）。
//
//   TELEGRAM_AUDIT_DIR=<作業ディレクトリ> node scripts/telegram-audit/fetch-p2p-history.mjs
//
// ## 配信元への負荷を抑える仕掛け
//
// **P2PQuake はこのリポジトリで唯一レート上限が明記されている配信元**（`/history` が 60req/分・
// IP ごと。→ `docs/spec/data-sources-spec.md` §3）。それなのに以前のこの script は控えも間隔も
// 固定の上限も持たず、既定の 18 件で収まっていたのは `PER_CODE` の既定値が小さかっただけだった
// （`P2P_LIMIT` で無制限に増やせ、控えが無いので再実行のたび全件を取り直していた）。
//
// **DMDATA アーカイブの控え（`archive-cache.mjs`）とは前提が違う。** あちらは「1 日分を締めた
// あとに生成される不変のファイル」なので一度取れば永久に使えるが、`/history` は最新から `offset`
// で遡る**可変**の一覧で、時間が経てば同じ `offset` が別の内容を返す。そのため控えは
// **期限付き**にしてある（アプリ側のヒートマップが `localStorage` へ 6 時間持つのと同じ思想）。
// 標本の用途（テストデータとの形の突き合わせ）には数時間前のものでも足りる。
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from './coverage-core.mjs'
import { REPO } from '../lib/repo-root.mjs'
import { gate } from '../lib/rateGate.mjs'
import { noteIncomplete, markResult, reportIncompleteness, writeArtifact } from '../lib/incompleteness.mjs'

// 551=地震情報 / 552=津波予報 / 556=緊急地震速報（警報）
const CODES = [551, 552, 556]

/**
 * 1 種別あたりに遡る件数の上限（＝ページ 20 枚ぶん）。`archive-cache.mjs` の `LIST_MAX_PAGES`
 * と同じ値で、1 ページ 100 件なので 2000 件。標本としてこれ以上要る用途は無い。
 */
const MAX_PER_CODE = 2000
/** ページを辿る上限。`PER_CODE` の検証と二重の歯止めにする（どちらか片方が緩んでも止まる）。 */
const MAX_PAGES = 20
/**
 * 取得の間隔。`/history` の 60req/分（＝1 秒 1 件）に対して余裕を取る。
 *
 * **ぴったり 1 秒にしないこと** —— 同じ IP からアプリ本体・実機の検証用ブラウザも同じ
 * エンドポイントを叩くので、この script だけで上限を使い切ると他が弾かれる。
 */
const MIN_INTERVAL_MS = 1_200
/** 控えの有効期間。過ぎたら取り直す（上のコメントのとおり `/history` は可変の一覧）。 */
const CACHE_TTL_MS = Number(process.env.P2P_CACHE_TTL_MS) || 6 * 60 * 60 * 1000
/** 控えの置き場所。`.claude/*` は `.gitignore` 済み（`dmdata-archive-cache` と同じ扱い）。 */
const CACHE_DIR = process.env.P2P_HISTORY_CACHE || path.join(REPO, '.claude', 'p2p-history-cache')

/**
 * `P2P_LIMIT` を読む。**範囲外は投げる** —— 下流へ流すと配信元へ余計なリクエストが出る
 * （CLAUDE.md「範囲外の指定は入口で弾く」）。
 *
 * **呼び出しは `MAX_PER_CODE` の定義より後に置くこと。** `const` は巻き上げられても TDZ で
 * 参照できないため、前に置くと上限値を直書きする羽目になり二重管理になる。
 */
function readPerCode() {
  const raw = process.env.P2P_LIMIT
  if (raw === undefined || raw === '') return 600
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`P2P_LIMIT は正の整数で指定してください（受け取った値: ${JSON.stringify(raw)}）`)
  }
  if (n > MAX_PER_CODE) {
    throw new Error(`P2P_LIMIT の上限は ${MAX_PER_CODE} です（受け取った値: ${n}）。これ以上の標本が要る用途は想定していません`)
  }
  return n
}

/** 1 種別あたりに遡る件数。**固定の上限を超える指定は受け付けない**（環境変数だけを歯止めにしない）。 */
const PER_CODE = readPerCode()

const stats = { cacheHits: 0, downloads: 0, failures: [] }

function cachePathFor(code) {
  return path.join(CACHE_DIR, `${code}.json`)
}

/** 控えから読む。期限切れ・壊れている・`P2P_REFRESH` 指定のときは `null`。 */
function readCache(code) {
  if (process.env.P2P_REFRESH) return null
  const p = cachePathFor(code)
  if (!fs.existsSync(p)) return null
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!Array.isArray(j?.items) || typeof j.fetchedAt !== 'number') return null
    if (Date.now() - j.fetchedAt > CACHE_TTL_MS) return null
    return j.items
  } catch (e) {
    // 読めない控えは残しても読めないので捨てて取り直す。**黙って消さない**
    console.error(`  控えが読めないため取り直します（${path.basename(p)}）: ${e.message ?? e}`)
    try { fs.rmSync(p) } catch { /* 消せなくても取得は続ける */ }
    return null
  }
}

/**
 * 控えへ書く。一時ファイルへ出してから `rename`（中断で半端なファイルを残さない）。
 *
 * **書けなくても取得は成功として扱う。** 包まないと、ディスク容量・権限といった
 * **取得とは無関係な理由**で、すでに取れているデータを丸ごと捨てて「取得に失敗」と
 * 記録することになる（呼び出し側が `fetchCode` と同じ `try` に入れているため）。
 * `lib/stationSource.mjs` の `writeRevisionCache` と同じ方針。
 */
function writeCache(code, items) {
  // **`tmp` は try の外で決める** —— 中で宣言すると catch から見えず、`rename` だけ失敗した
  // ときに一時ファイルを片付けられない（次回は別の pid を使うので上書きもされず溜まる）
  const p = cachePathFor(code)
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), items }))
    fs.renameSync(tmp, p)
  } catch (e) {
    // **黙って流さない**（次回また取ることになるので、その理由が見えるようにする）
    console.error(`  控えへ書けませんでした（次回また取得します・code=${code}）: ${e.message ?? e}`)
    try { fs.rmSync(tmp) } catch { /* 消せなくても害は無い（.gitignore 済みの小さな JSON） */ }
  }
}

/** 1 種別ぶんを取る。**失敗はここで数える**（呼び出し側の `break` に任せると記録が残らない）。 */
async function fetchCode(code) {
  const items = []
  let page = 0
  for (let offset = 0; offset < PER_CODE; offset += 100, page++) {
    if (page >= MAX_PAGES) {
      // **黙って切らない。** 打ち切った範囲は「見ていない」ので、0 件を「無い」と読まれないよう投げる
      throw new Error(`ページ上限（${MAX_PAGES}）に達した。offset の進み方が想定と違う疑いがある`)
    }
    await gate('p2p-history', MIN_INTERVAL_MS)
    const u = `https://api.p2pquake.net/v2/history?codes=${code}&limit=100&offset=${offset}`
    const r = await fetch(u)
    if (!r.ok) throw new Error(`HTTP ${r.status}（offset=${offset}）`)
    const j = await r.json()
    if (!Array.isArray(j) || j.length === 0) break
    items.push(...j)
    stats.downloads++
    if (j.length < 100) break
  }
  return items
}

const all = {}
for (const code of CODES) {
  const cached = readCache(code)
  if (cached) {
    all[code] = cached
    stats.cacheHits++
    console.error(`code=${code}: ${cached.length} 件（控えから）`)
    continue
  }
  try {
    const items = await fetchCode(code)
    writeCache(code, items)
    all[code] = items
    console.error(`code=${code}: ${items.length} 件`)
  } catch (e) {
    // **1 種別の失敗で他を止めない。** ただし取りこぼしたことは必ず残す
    // （内訳は `meta.failures`・下流へ運ぶ印は共有の台帳。片方だけに書かない）
    stats.failures.push({ code, error: String(e?.message ?? e) })
    noteIncomplete('P2PQuake の履歴', `code=${code}: ${e?.message ?? e}`)
    all[code] = []
    console.error(`code=${code}: 取得に失敗 —— ${e?.message ?? e}`)
  }
}

/**
 * **永続化するファイルへ印を載せる。** 下流（`testdata-shapes.mjs`）は `p2p-history.json` を
 * 直接読んで件数を数えるので、標準出力にだけ印を出すと**消費経路では印が消える**。
 *
 * 載せ方は `writeArtifact` に任せる —— 台帳に積んだ分が `_incomplete` として自動で入り、
 * 下流が `readArtifact` で読めばそのまま引き継がれる。**`codes` の外へ出る**ので、
 * 種別と並べて文字列が混ざる事故（`Object.entries(codes)` が文字数を件数として数える）も起きない。
 * `meta.failures` は内訳として別に残す（どの種別が落ちたかを構造のまま見たいとき用）。
 */
writeArtifact(path.join(WORK, 'p2p-history.json'), {
  codes: all,
  meta: { fetchedAt: Date.now(), failures: stats.failures },
}, { space: 0 })

console.error(
  `P2PQuake 履歴: 控えから ${stats.cacheHits} 種別 / 取得 ${stats.downloads} ページ`
  + `（間隔 ${MIN_INTERVAL_MS}ms・控えの有効期間 ${Math.round(CACHE_TTL_MS / 3600_000)} 時間）`
)
console.error(`  控えの場所: ${CACHE_DIR}`)

// 標準出力にも同じ印を載せる（標準エラーだけに出すと、この出力を保存・受け渡しする運用で
// 失敗が見えない）。**永続化するファイル側にも入れてある**のが本体で、こちらは人が読む用。
const counts = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.length]))
console.log(JSON.stringify(markResult(counts), null, 1))
if (reportIncompleteness('P2PQuake の履歴') > 0) process.exitCode = 1
