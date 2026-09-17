// 発表頻度の低い種別と、条件付きの要素を持つ報を**名指しで**集める。
//
// `fetch-samples.mjs` は対象の全種別が上限に達した時点で走査を打ち切るため、**頻度の低い
// 種別は集まらないまま終わる**。実際、既定の集め方では次の 3 つが欠けていた。
//
//   - IXAC41（推計震度分布図）… **二進電文で拡張子が `.bin`**。`.xml` しか採らない
//     `fetch-samples.mjs` では 1 通も入らない
//   - VXSE60（地震回数に関する情報）… 2024-01-01〜2026-09-06 の全アーカイブを走査しても 0 件。
//     **配信実績が無い**（→ docs/spec/data-sources-spec.md §2）。突き合わせには気象庁公式の
//     サンプル電文を使う
//   - 条件付きの要素を持つ VXSE45（緊急地震速報）… 既定で集まる 8 通は**全部 最大予測震度 3 以下**で、
//     区域も固定付加文も長周期の予測も 1 つも入っていなかった。「実電文に無い」のか
//     「標本に無いだけ」なのかを分けられない
//
//   TELEGRAM_AUDIT_DIR=<作業ディレクトリ> node scripts/telegram-audit/fetch-rare-samples.mjs <対象>
//
// 対象は `eew` / `ixac41` / `type:VXSE60` のいずれか（既定は `eew`）。
import fs from 'node:fs'
import path from 'node:path'
import { CACHE } from './coverage-core.mjs'
import { apiAuthHeader, listArchive, loadArchiveTar, tarEntries, reportArchiveCacheStats } from './archive-cache.mjs'
import { markResult, reportIncompleteness, writeArtifact } from '../lib/incompleteness.mjs'
import { rareSampleCollectionMarkPath, clearCollectionMark } from './collection-mark.mjs'

fs.mkdirSync(CACHE, { recursive: true })

// **対象は走査の前に決める。** 札は対象ごとに分かれるので、消すときにも要る
// （対象で分けないと、取りこぼした収集の直後に別の対象を成功させただけで印が消える）。
// 対象名の検証もここで済ませる —— 走査を終えてから弾いても、その時間が無駄になる。
const target = process.argv[2] || 'eew'
if (target !== 'eew' && target !== 'ixac41' && !target.startsWith('type:')) {
  throw new Error(`対象は eew / ixac41 / type:<種別,...> のいずれか（渡された値: ${target}）`)
}
const markPath = rareSampleCollectionMarkPath(CACHE, target)
// **走査を始める前に古い札を消す。** 途中で落ちたら札が無い＝「不明」へ倒す
clearCollectionMark(markPath)

// 取得・控え・レート制御は `archive-cache.mjs` に集約してある。**素の `fetch` を書き足さないこと**
// —— この 3 つの集め方はどれも期間を区切って何度も走査するので、控えが無いと同じ日を繰り返し取る。
const auth = apiAuthHeader()

/** 条件付きの要素を持つ緊急地震速報を、欲しい形ごとに上限を決めて集める */
async function fetchBigEew() {
  // **同じ事象からは 1 通だけ**（続報で埋まると多様性が落ちる）
  const want = {
    areas: { max: 6, test: x => /<Pref>/.test(x), seen: new Set(), n: 0 },
    warning: { max: 6, test: x => /<WarningComment/.test(x), seen: new Set(), n: 0 },
    lgint: { max: 6, test: x => /forecastMaxLgInt|<LgInt>|MaxLgInt/.test(x), seen: new Set(), n: 0 },
  }
  const cls = 'eew.forecast'
  // 一覧が取れなければ**集めた数（この時点では 0）を返して終わる**。例外を素通しにすると
  // 末尾の `reportArchiveCacheStats()` まで飛ばされ、失敗の記録ごと消える。
  let items
  try {
    items = await listArchive({ classification: cls, from: '2025-01-01', to: '2026-09-06', auth })
  } catch (e) {
    console.error(`${cls}: ${e?.message ?? e}`)
    return Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.n]))
  }
  console.error(`${cls}: ${items.length} 日分`)
  for (const it of items) {
    let tar
    try { tar = await loadArchiveTar({ classification: cls, item: it, auth }) }
    catch { continue }
    for (const { name: n, body: b } of tarEntries(tar)) {
      if (!/^VXSE45_.*\.xml$/i.test(n)) continue
      const xml = b.toString('utf8')
      const ev = (xml.match(/<EventID>([^<]*)<\/EventID>/) || [])[1] ?? n
      let keep = false
      for (const w of Object.values(want)) {
        if (w.n >= w.max || w.seen.has(ev) || !w.test(xml)) continue
        w.seen.add(ev); w.n++; keep = true
      }
      // 接頭辞で「名指しで足した分」と分かるようにする（種別の判定は接頭辞を外してから行う）
      if (keep) fs.writeFileSync(path.join(CACHE, 'big-' + n), b)
    }
    if (Object.values(want).every(w => w.n >= w.max)) break
  }
  return Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.n]))
}

/** 推計震度分布図（二進・分割配信）。**同じ発表時刻の断片はすべて**保存する */
async function fetchIxac41(wantEvents = 8) {
  // 震度5弱以上の地震があった期間を先に見る（この電文はそのときにしか出ない）
  const ranges = [
    ['2024-01-01', '2024-02-29'], ['2024-08-01', '2024-09-30'], ['2026-07-01', '2026-09-06'],
    ['2025-01-01', '2025-12-31'], ['2024-03-01', '2024-07-31'], ['2026-01-01', '2026-06-30'],
  ]
  let events = 0
  for (const [from, to] of ranges) {
    // 一覧が取れなかったレンジは飛ばして次へ（全体を止めない。失敗は控えの統計に残る）
    let items
    try {
      items = await listArchive({ classification: 'telegram.earthquake', from, to, auth })
    } catch (e) {
      console.error(`${from}~${to}: ${e?.message ?? e}`)
      continue
    }
    console.error(`${from}~${to}: ${items.length} 日分`)
    for (const it of items) {
      let tar
      try { tar = await loadArchiveTar({ classification: 'telegram.earthquake', item: it, auth }) }
      catch { continue }
      const byTime = new Map()
      for (const { name: n, body: b } of tarEntries(tar)) {
        const m = /^IXAC41_RJTD_(RR[A-X]_)?(\d{17})_/.exec(n)
        if (!m || !n.endsWith('.bin')) continue
        const t = m[2].slice(0, 12)
        if (!byTime.has(t)) byTime.set(t, [])
        byTime.get(t).push({ n, b })
      }
      if (byTime.size === 0) continue
      // 1 日から採るのは 1 事象だけ（同じ地震の続報で埋めない）。断片がいちばん多い報を採る
      const [t, parts] = [...byTime].sort((a, b) => b[1].length - a[1].length)[0]
      for (const { n, b } of parts) fs.writeFileSync(path.join(CACHE, n), b)
      events++
      console.error(`  + ${it.date} ${t}（${parts.length} 断片）`)
      if (events >= wantEvents) return { events }
    }
  }
  return { events }
}

/** 種別を名指しで集める（`fetch-samples.mjs` の打ち切りに巻き込まれる稀な種別向け） */
async function fetchByType(types, perType = 8) {
  const want = new Set(types)
  const ranges = [
    ['2025-06-15', '2025-08-15'], ['2024-01-01', '2024-02-29'], ['2024-08-01', '2024-09-30'],
    ['2025-01-01', '2025-06-14'], ['2025-08-16', '2026-09-06'], ['2024-03-01', '2024-07-31'],
    ['2024-10-01', '2024-12-31'],
  ]
  const counts = new Map(); const seen = new Map()
  for (const [from, to] of ranges) {
    // 一覧が取れなかったレンジは飛ばして次へ（全体を止めない。失敗は控えの統計に残る）
    let items
    try {
      items = await listArchive({ classification: 'telegram.earthquake', from, to, auth })
    } catch (e) {
      console.error(`${from}~${to}: ${e?.message ?? e}`)
      continue
    }
    console.error(`${from}~${to}: ${items.length} 日分`)
    for (const it of items) {
      let tar
      try { tar = await loadArchiveTar({ classification: 'telegram.earthquake', item: it, auth }) }
      catch { continue }
      for (const { name: n, body: b } of tarEntries(tar)) {
        if (!/\.xml$/i.test(n)) continue
        const type = n.split('_')[0]
        if (!want.has(type) || (counts.get(type) ?? 0) >= perType) continue
        const xml = b.toString('utf8')
        const ev = (xml.match(/<EventID>([^<]*)<\/EventID>/) || [])[1] ?? n
        if (!seen.has(type)) seen.set(type, new Set())
        if (seen.get(type).has(ev)) continue
        seen.get(type).add(ev)
        fs.writeFileSync(path.join(CACHE, n), b)
        counts.set(type, (counts.get(type) ?? 0) + 1)
        console.error(`  + ${n}`)
      }
      if ([...want].every(t => (counts.get(t) ?? 0) >= perType)) {
        return Object.fromEntries([...counts].sort())
      }
    }
  }
  // **0 件で終わったことも返す。** 「集まらなかった」を黙って落とすと、
  // 突き合わせ側が「見ていない」を「無い」と取り違える
  return Object.fromEntries([...want].map(t => [t, counts.get(t) ?? 0]))
}

let result
if (target === 'eew') result = await fetchBigEew()
else if (target === 'ixac41') result = await fetchIxac41(Number(process.argv[3]) || 8)
else result = await fetchByType(target.slice(5).split(','), Number(process.argv[3]) || 8)

// **札を必ず置く**（理由は `collection-mark.mjs` の冒頭）。この収集も `telegram-cache/` へ
// ファイルを足すので、取りこぼしを下流へ渡す手段は札しかない。
writeArtifact(markPath, { collectedAt: Date.now(), target, collected: result })

// **不完全なら結果そのものへ印を付ける。** この出力は「条件付きの要素を持つ電文は実配信に無い」
// という主張の根拠になるので、走査できなかった範囲があることが JSON からも読めないといけない。
console.log(JSON.stringify(markResult(result), null, 1))
reportArchiveCacheStats('アーカイブ（稀な種別の収集）')
// 取りこぼしがあれば exit code も立てる（終了コードしか見ない経路で気づけるように）
if (reportIncompleteness('稀な種別の収集') > 0) process.exitCode = 1
