// 突き合わせ用に実電文を種別ごとに集めてキャッシュする。
// 種別ごとに上限を決めて打ち切る（全部落とすと数百 MB になり、突き合わせには要らない）。
//
// **集めた電文はリポジトリへ入れられない**（配信元の利用規約）。置き場所と使い方は
// docs/spec/telegram-coverage-audit.md §2。
import fs from 'node:fs'
import path from 'node:path'
import { HANDLED } from './handled.mjs'
import { CACHE } from './coverage-core.mjs'
import { apiAuthHeader, listArchive, loadArchiveTar, tarEntries, reportArchiveCacheStats } from './archive-cache.mjs'
import { markResult, reportIncompleteness, writeArtifact } from '../lib/incompleteness.mjs'
import { sampleCollectionMarkPath, clearCollectionMark } from './collection-mark.mjs'

fs.mkdirSync(CACHE, { recursive: true })

// **走査を始める前に古い札を消す。** 途中で落ちたら札が無い＝「不明」へ倒す
// （残すと、前回成功したときの札が今回の成果物に対する「完了報告」として読まれる）。
clearCollectionMark(sampleCollectionMarkPath(CACHE))

// 取得・控え・レート制御は `archive-cache.mjs` に集約してある。**素の `fetch` を書き足さないこと**。
const auth = apiAuthHeader()

// 種別ごとに何通まで貯めるか。**増やすほど条件付きの要素に当たる見込みは上がる**が、
// 同じ事象の続報は下で弾いているので、独立した事象がその数だけ必要になる。
const PER_TYPE = Number(process.env.PER_TYPE) || 8

// **同じ事象の続報を数えない。** 「最初に出会った 8 通」だと、1 つの地震の連続報で埋まる
// （実際 EEW の 8 通は全部同じ地震のシーケンスだった）。区域構成・付加文・観測状態が似通うため、
// 独立した事象を 8 件集めた場合より多様性が著しく落ちる。EventID ごとに 1 通だけ採る。
const counts = new Map()
const seenEvents = new Map()   // 種別 -> Set<EventID>
for (const [cls, from, to] of [
  ['telegram.earthquake', '2024-01-01', '2026-09-06'],
  ['eew.forecast', '2026-06-01', '2026-09-06'],
]) {
  // 一覧が取れなかった分類は飛ばして次へ。**全体を止めない** —— 止めると、それまでに
  // 集めた分の集計も末尾の `reportArchiveCacheStats()` も出ないまま終わる。
  // 失敗そのものは `listArchive` が控えの統計へ記録しており、末尾で必ず出る。
  let items
  try {
    items = await listArchive({ classification: cls, from, to, auth })
  } catch (e) {
    console.error(`${cls}: ${e?.message ?? e}`)
    continue
  }
  console.error(`${cls}: ${items.length} 日分`)
  for (const it of items) {
    let tar
    try { tar = await loadArchiveTar({ classification: cls, item: it, auth }) }
    catch { continue }
    for (const { name: n, body: b } of tarEntries(tar)) {
      if (!/\.xml$/i.test(n)) continue
      const type = n.split('_')[0]
      const c = counts.get(type) ?? 0
      if (c >= PER_TYPE) continue
      const xml = b.toString('utf8')
      // **南海トラフの解説情報（VYSE51/52）は `EventID` が固定で `Serial` が号数**
      // （実電文で確認済み。docs/spec/data-sources-spec.md §2 の対応表）。
      // 事象で重複排除すると全部 1 つに畳まれるので、この 2 種別だけ号数まで鍵に含める。
      const evId = (xml.match(/<EventID>([^<]*)<\/EventID>/) || [])[1] ?? n
      const serial = (xml.match(/<Serial>([^<]*)<\/Serial>/) || [])[1] ?? ''
      const ev = /^VYSE5[12]$/.test(type) ? `${evId}|${serial}` : evId
      if (!seenEvents.has(type)) seenEvents.set(type, new Set())
      if (seenEvents.get(type).has(ev)) continue   // 同じ事象の続報は採らない
      seenEvents.get(type).add(ev)
      fs.writeFileSync(path.join(CACHE, n), b)
      counts.set(type, c + 1)
    }
    // 対象の全種別が上限に達したら打ち切る（種別は handled.mjs の 13 件）
    // 打ち切りは**対象の種別だけ**で数える。全種別で数えると、対象外の種別が先に埋まって
    // 対象の収集が終わる前に止まる（実際 VYSE60 が 7 通で止まっていた）。
    //
    // **ただしこの打ち切りは現状ほぼ成立しない。** `HANDLED` には、下の走査対象をいくら
    // 辿っても埋まらない種別が 2 つある ——
    //   - `VYSE60`（北海道・三陸沖後発地震注意情報）: 運用開始以降の実配信が無い
    //   - `VXSE45`（緊急地震速報（警報））: 分類 `eew.warning` にあり、走査対象
    //     （`telegram.earthquake` / `eew.forecast`）に入っていない
    // どちらも永久に `PER_TYPE` へ届かないため、**1 回の実行で毎回全期間を取り切る**
    // （約 1,080 日分）。控え（`archive-cache.mjs`）を通すようにしたので 2 回目以降の
    // リクエストは 0 になるが、初回の走査は全日分を通る。
    //
    // 直すなら「分類ごとに、そこで得られる種別だけを数える」形にする。ただしそれは
    // **収集の網羅性の定義を変える**ことになる（VYSE60 のサンプルを持たないと確定させる／
    // `eew.warning` を走査対象へ足す）ので、気づいた側で勝手に変えず設計として決めること。
    if (Object.keys(HANDLED).every(t => (counts.get(t) ?? 0) >= PER_TYPE)) break
  }
}
const collected = Object.fromEntries([...counts].sort())

// **札を必ず置く。** 集めた成果物は `telegram-cache/` に並ぶ XML そのもので、ファイルの山へは
// 印を載せられない。取りこぼしがあったかどうかは、この札でしか下流へ渡せない
// （成功しても書く理由は `collection-mark.mjs` の冒頭）。
writeArtifact(sampleCollectionMarkPath(CACHE), { collectedAt: Date.now(), perType: collected })

// **不完全なら結果そのものへ印を付ける。** 標準エラー（下の報告）を見ない運用でも、
// 「集めたが 0 件」と「集められなかった」を JSON 単体で区別できるようにする。
console.log(JSON.stringify(markResult(collected), null, 1))
reportArchiveCacheStats('アーカイブ（サンプル収集）')
// 取りこぼしがあれば exit code も立てる（終了コードしか見ない経路で気づけるように）
if (reportIncompleteness('サンプル収集') > 0) process.exitCode = 1
