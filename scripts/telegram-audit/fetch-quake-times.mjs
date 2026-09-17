// 電文が持つ 2 つの地震の時刻（`OriginTime` = 発生時刻 / `ArrivalTime` = 発現時刻）を、
// アーカイブ全期間から抜き出して JSONL へ残す。集計は `compare-quake-times.mjs`。
//
// **抽出と集計を分けてある。** 集計の切り口を変えるたびに数十分の走査をやり直さないため。
// **電文そのものは保存しない**（配信元の利用規約。→ docs/spec/telegram-coverage-audit.md §2）。
//
// 読み方は `src/services/dmdataParser.ts` に揃える。
//   - 地震情報: `xmlQ(earthquakeEl, 'ArrivalTime')` = Earthquake の**子孫**から最初の 1 つ
//   - 津波    : `xmlChild(eqEl, 'ArrivalTime')`    = Earthquake の**直下**の子
// 両方を数えて残すので、この差が実電文で効くかどうかも集計側で確かめられる。
//
// 使い方:
//   TELEGRAM_AUDIT_DIR=<作業ディレクトリ> node scripts/telegram-audit/fetch-quake-times.mjs
//   （範囲を絞るなら FROM=2024-01-01 TO=2024-12-31、分類を変えるなら CLASSIFICATIONS=eew.forecast）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { REPO, WORK } from './coverage-core.mjs'
import { apiAuthHeader, listArchive, loadArchiveTar, tarEntries, reportArchiveCacheStats } from './archive-cache.mjs'
import { writeArtifact, reportIncompleteness, checkpoint } from '../lib/incompleteness.mjs'

const require = createRequire(path.join(REPO, 'package.json'))
const { JSDOM } = require('jsdom')
const domParser = new (new JSDOM().window.DOMParser)()

const OUT_DIR = path.join(WORK, process.env.OUT_DIR || 'quake-times')
fs.mkdirSync(OUT_DIR, { recursive: true })

// 取得・控え・レート制御は `archive-cache.mjs` に集約してある。**素の `fetch` を書き足さないこと**
// —— 同じ日を何度も取り直す形に戻り、配信元の制限（アーカイブ本体は 50req/5min）を超える。
const auth = apiAuthHeader()

const textOf = (el) => el?.textContent?.trim() ?? ''
// 子孫から localName 一致をすべて（`dmdataParser.ts` の `xmlAll` と同じ走査）
function descAll(parent, localName) {
  const els = parent.getElementsByTagName('*')
  const r = []
  for (let i = 0; i < els.length; i++) if (els[i].localName === localName) r.push(els[i])
  return r
}
// 直下の子だけ（同 `xmlChild` と同じ走査の全件版）
function childAll(parent, localName) {
  const r = []
  const c = parent.children
  for (let i = 0; i < c.length; i++) if (c[i].localName === localName) r.push(c[i])
  return r
}

// **全文を DOMParser へ渡す。ブロックだけを切り出してパースしない** —— `Earthquake` の中には
// `jmx_eb:` 接頭辞付きの要素があり、その宣言はルート要素にあるため、切り出した断片は
// 「未宣言の接頭辞」でパースに失敗する。失敗を「要素が無い」として書き出すと区別が付かない。
function extractOne(fileName, xml) {
  const rec = {
    file: fileName,
    type: fileName.split('_')[0],
    eventId: (xml.match(/<EventID>([^<]*)<\/EventID>/) || [])[1] ?? '',
    serial: (xml.match(/<Serial>([^<]*)<\/Serial>/) || [])[1] ?? '',
    infoType: (xml.match(/<InfoType>([^<]*)<\/InfoType>/) || [])[1] ?? '',
    status: (xml.match(/<Status>([^<]*)<\/Status>/) || [])[1] ?? '',
    reportDateTime: (xml.match(/<ReportDateTime>([^<]*)<\/ReportDateTime>/) || [])[1] ?? '',
    eqs: [],
  }
  const doc = domParser.parseFromString(xml, 'application/xml')
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length > 0) {
    rec.parseFail = true
    return rec
  }
  // **電文が名乗る情報名は `Head` 直下の `Title`。** 最初に現れる `<Title>` は
  // `Control/Title`（種別の固定名）で、遠地地震（`Head/Title` =「遠地地震に関する情報」）を
  // 判別できない。実装の `readInfoName` と同じく Head 直下に限る。
  const headEl = descAll(doc, 'Head')[0] ?? null
  rec.controlTitle = textOf(descAll(descAll(doc, 'Control')[0] ?? doc, 'Title')[0] ?? null)
  rec.title = headEl ? textOf(childAll(headEl, 'Title')[0] ?? null) : ''
  // 気象庁が利用者向けの文へどちらの時刻を書くかを確かめるため、見出し文と本文も残す。
  const headlineEl = headEl ? childAll(headEl, 'Headline')[0] : null
  rec.headline = headlineEl ? textOf(childAll(headlineEl, 'Text')[0] ?? null) : ''
  const bodyEl = descAll(doc, 'Body')[0] ?? null
  rec.bodyText = bodyEl ? textOf(childAll(bodyEl, 'Text')[0] ?? null) : ''
  // 電文全体の総数。`Earthquake` の外にある `ArrivalTime`（津波の区域の第 1 波到達時刻など）を
  // 混ぜていないことの検算に使う。
  rec.docArrival = descAll(doc, 'ArrivalTime').length
  rec.docOrigin = descAll(doc, 'OriginTime').length
  for (const eq of descAll(doc, 'Earthquake')) {
    const hypoArea = descAll(eq, 'Area')[0] ?? null
    const magEl = descAll(eq, 'Magnitude')[0] ?? null
    rec.eqs.push({
      originChild: childAll(eq, 'OriginTime').map(textOf),
      arrivalChild: childAll(eq, 'ArrivalTime').map(textOf),
      originDesc: descAll(eq, 'OriginTime').map(textOf),
      arrivalDesc: descAll(eq, 'ArrivalTime').map(textOf),
      hypo: hypoArea ? textOf(descAll(hypoArea, 'Name')[0] ?? null) : '',
      // **`type` 属性も残す。** VXSE61（震源要素更新）は `Coordinate` を 2 つ持ち、
      // 実装（`readHypocenterCoord`）は `type` に「度分」を含むほうを採る。もう一方は
      // 津波情報等で使うための丸め値で、深さまでずれる（全期間で 2 つ持つ電文は 86 通・
      // うち 78 通で深さが違い、深さの階級が変わるのは 4 件）。
      // 属性を落とすと、集計側が丸め値を掴んでいても気づけない。
      coordinate: hypoArea
        ? descAll(hypoArea, 'Coordinate').map(el => ({ text: textOf(el), type: el.getAttribute('type') ?? '' }))
        : [],
      magnitude: magEl ? textOf(magEl) : '',
    })
  }
  return rec
}

const CLASSIFICATIONS = (process.env.CLASSIFICATIONS || 'telegram.earthquake').split(',')
const FROM = process.env.FROM || '2020-01-01'
const TO = process.env.TO || new Date(Date.now() + 86400_000).toISOString().slice(0, 10)
const CONCURRENCY = Number(process.env.CONCURRENCY) || 8

for (const cls of CLASSIFICATIONS) {
  // **この分類の走査だけを印の対象にする。** 台帳はプロセス全体で 1 本なので、区切らないと
  // 別の分類の取りこぼしがこの分類の `meta.json` へ載る。下流（`compare-quake-times.mjs`）は
  // 分類ごとに別々に読むので、**完璧に走査できた分類のレポートに「信用するな」と出てしまう**。
  const cp = checkpoint()
  const base = cls.replace(/\./g, '-')
  const outPath = path.join(OUT_DIR, `${base}.jsonl`)
  const metaPath = path.join(OUT_DIR, `${base}.meta.json`)
  // 一覧が取れなかった分類は飛ばして次へ（全体を止めない。失敗は控えの統計に残る）
  let items
  try {
    items = await listArchive({ classification: cls, from: FROM, to: TO, auth })
  } catch (e) {
    console.error(`${cls}: ${e?.message ?? e}`)
    continue
  }
  console.error(`${cls}: ${items.length} 日分 (${FROM}~${TO})`)
  const out = fs.createWriteStream(outPath)
  const meta = { classification: cls, from: FROM, to: TO, days: items.length, dayList: [], failedDays: [], xmlTotal: 0 }

  let done = 0
  const queue = [...items]
  async function worker() {
    for (;;) {
      const it = queue.shift()
      if (!it) return
      const day = String(it.datetime ?? it.date ?? '?')
      let tar = null
      // 一時的な失敗の待ち直しは `archive-cache.mjs` が持つ（レート制限の 429 を含む）。
      // **それでも駄目なら記録する** ——「見ていない」を「無い」に潰さないため。
      try {
        tar = await loadArchiveTar({ classification: cls, item: it, auth })
      } catch (e) {
        meta.failedDays.push({ day, error: String(e?.message ?? e) })
        console.error(`  取得失敗 ${day}: ${e?.message ?? e}`)
        continue
      }
      const lines = []
      let xmlCount = 0
      for (const { name: n, body: b } of tarEntries(tar)) {
        if (!/\.xml$/i.test(n)) continue
        xmlCount++
        try {
          lines.push(JSON.stringify({ day, ...extractOne(n, b.toString('utf8')) }))
        } catch (e) {
          lines.push(JSON.stringify({ day, file: n, extractError: String(e.message ?? e) }))
        }
      }
      meta.xmlTotal += xmlCount
      meta.dayList.push({ day, xml: xmlCount })
      if (lines.length) out.write(lines.join('\n') + '\n')
      done++
      if (done % 100 === 0) console.error(`  ${done}/${items.length} 日 (XML ${meta.xmlTotal} 通)`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await new Promise(res => out.end(res))
  meta.dayList.sort((a, b) => a.day.localeCompare(b.day))
  // **その分類が終わった時点で書く。** 後ろへ寄せると、後続の分類でプロセスが落ちたときに
  // **完走した分類の `.jsonl` に対応する `meta.json` が 1 つも書かれない**（抽出のやり直しになる）。
  writeArtifact(metaPath, meta, { since: cp })
  console.error(`${cls}: XML ${meta.xmlTotal} 通 / 取得失敗 ${meta.failedDays.length} 日 → ${outPath}`)
}

// 何件を控えで済ませたかを残す。2 回目以降の走査がリクエストを出していないことの確認にもなる。
reportArchiveCacheStats('アーカイブ（地震の時刻の抽出）')

// **走査できなかった範囲があれば exit code を立てる。** 印は `meta.json` に載るので下流
// （`compare-quake-times.mjs`）は読めるが、終了コードしか見ない経路（CI・シェルの `&&`）
// にも伝える。この走査の結果は「その期間に該当の電文は無い」という主張の根拠になる。
if (reportIncompleteness('地震の時刻の抽出') > 0) process.exitCode = 1
