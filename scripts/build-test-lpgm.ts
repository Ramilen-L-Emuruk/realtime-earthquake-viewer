/**
 * テストボタン用の長周期地震動データ（`src/data/noto-honshin-2024-lpgm.json`）を、
 * **実電文をパーサーへ通して**作り直す。
 *
 * ## なぜスクリプトとして残すのか
 *
 * テストボタンは実機で挙動を確かめられる唯一の入口で、**そこに無い形は一度も画面に出ない**
 * （CLAUDE.md「テストボタンは実機確認の唯一の入口」）。手で組み立てると、電文から読む項目を
 * 足すたびにテストデータだけ古い形のまま残る。
 *
 * 生成物は `as unknown as` で型を付け直して使うため、**型が変わってもコンパイルは通る**。
 * 手順が残っていないと「実電文から作った」という前提が作った瞬間だけ真になり、
 * あとから確かめる手段が無くなる。
 *
 * ## 使い方
 *
 * ```
 * npm run build-test-lpgm -- --event=20240101161010
 * ```
 *
 * **要 DMDATA.JP API キー**（リポジトリ直下の `.env.local` の `DMDATA_API_KEY`。
 * ワークツリーへは引き継がれないのでコピーすること）。`--event` は電文の `EventID`
 * （14 桁）。既定は能登半島地震の本震。
 *
 * 取得先は DMDATA アーカイブで、`--date`（既定は `EventID` の先頭 8 桁から組む）の
 * `telegram.earthquake` から VXSE62 を探す。同じ `EventID` の電文が複数あるときは
 * **最大階級がいちばん大きいもの**を採る（続報で階級が確定するため）。
 *
 * ## 取得は共通の口を通す
 *
 * アーカイブの一覧・本体の取得は `telegram-audit/archive-cache.mjs` に集約してある。
 * **素の `fetch` を書き足さないこと** —— 控えもレート制御も 429 のバックオフも通らず、
 * 同じ日を何度でも取り直す形になる（→ `docs/spec/data-sources-spec.md` §2
 * 「リクエスト数を抑える」）。控えは分類・日・アーカイブ id で引くので、
 * **`build-test-quake` が同じ日を取っていればここではリクエストを出さない**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apiAuthHeader,
  dayOf,
  EARTHQUAKE_CLASSIFICATION,
  listArchive,
  loadArchiveTar,
  runArchiveScript,
  tarEntries,
} from './telegram-audit/archive-cache.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src/data/noto-honshin-2024-lpgm.json')

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

async function build() {
  const eventId = arg('event', '20240101161010')
  const day = arg('date', `${eventId.slice(0, 4)}-${eventId.slice(4, 6)}-${eventId.slice(6, 8)}`)
  const auth = apiAuthHeader()

  // **両端は広めに取る。** ちょうどの日付だけを指定するとその日が返らないことがある。
  const from = new Date(`${day}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1)
  const to = new Date(`${day}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 1)
  const items = await listArchive({
    classification: EARTHQUAKE_CLASSIFICATION,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    auth,
  })

  // 件数を先に出しておくのは、下の「見つかりません」で**「読んだが無い」と「そもそも
  // 読んでいない」を区別する**ため（理由は `build-test-quake.ts` の同じ箇所）。
  const matched = items.filter(it => dayOf(it).startsWith(day))

  const found: { name: string; xml: string; maxClass: number }[] = []
  for (const it of matched) {
    const tar = await loadArchiveTar({ classification: EARTHQUAKE_CLASSIFICATION, item: it, auth })
    for (const { name, body } of tarEntries(tar)) {
      if (!/^VXSE62_.*\.xml$/i.test(name)) continue
      const xml = body.toString('utf8')
      if ((xml.match(/<EventID>([^<]*)<\/EventID>/) ?? [])[1] !== eventId) continue
      found.push({ name, xml, maxClass: parseInt((xml.match(/<MaxLgInt>(\d+)<\/MaxLgInt>/) ?? [])[1] ?? '0', 10) })
    }
  }
  if (!found.length) {
    throw new Error(
      `${day} の ${eventId} に対する VXSE62 が見つかりません`
      + `（一覧 ${items.length} 件・うち ${day} のアーカイブ ${matched.length} 件を読みました）`,
    )
  }
  found.sort((a, b) => b.maxClass - a.maxClass)
  const picked = found[0]

  // パーサーは `DOMParser` を使うため、Node からは jsdom を通して読み込む。
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM()
  ;(globalThis as unknown as { DOMParser: typeof dom.window.DOMParser }).DOMParser = dom.window.DOMParser
  const { parseLpgmFromXml } = await import('../src/services/dmdataParser')

  const parsed = parseLpgmFromXml(picked.xml)
  if (!parsed) throw new Error(`${picked.name} をパーサーが受け付けませんでした`)
  // 報ごとに変わるもの（識別子・発表時刻・取消の別）はテスト側で作るので落とす
  const { id: _id, eventId: _eventId, time: _time, cancelled: _cancelled, ...rest } = parsed
  fs.writeFileSync(OUT, JSON.stringify(rest), 'utf8')
  console.log(
    `${picked.name} から作りました: 観測点 ${rest.points?.length ?? 0}・区域 ${rest.regions?.length ?? 0}`
    + `・都道府県 ${rest.prefs?.length ?? 0}・最大階級 ${rest.maxClass}`,
  )
}

runArchiveScript('アーカイブ（長周期地震動のテストデータ）', build)
  .catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
