/**
 * テストボタン用の地震情報データ（`src/data/*-quake.json`）を、
 * **実電文をパーサーへ通して**作り直す。長周期の `build-test-lpgm.ts` と同じ考え方。
 *
 * ## なぜ実電文から作るのか
 *
 * テストボタンは実機で挙動を確かめられる唯一の入口で、**そこに無い形は一度も画面に出ない**
 * （CLAUDE.md「テストボタンは実機確認の唯一の入口」）。
 *
 * 手で組み立てた版は**観測点が市町村に紐付いていなかった**。実電文は観測点を市町村の下に
 * 置くので（`Pref/Area/City/IntensityStation`）、カードの 4 段表示では市町村の下に観測点が
 * 入る。紐付けの無いデータでは市町村と観測点が同じ段に並び、**実機で 4 段目を確かめられない**。
 *
 * ## 使い方
 *
 * ```
 * npm run build-test-quake                   # 地震テスト（能登半島地震の本震）
 * npm run build-test-quake-unreceived        # 未入電テスト（日向灘 2022-01-22）
 * npm run build-test-quake-max-unreceived    # 最大震度が「以上」になるテスト（石川県西方沖 2024-11-26）
 * ```
 *
 * **要 DMDATA.JP API キー**（リポジトリ直下の `.env.local` の `DMDATA_API_KEY`。
 * ワークツリーへは引き継がれないのでコピーすること）。
 *
 * 同じ `EventID` の電文が複数あるときは**観測点がいちばん多いもの**を採る —— 続報で
 * 観測点が積み上がるため、確定報がもっとも厚い。
 *
 * ## 引数
 *
 * | 引数 | 意味 |
 * |---|---|
 * | `--event=<EventID>` | 電文の `EventID`（14 桁）。既定は能登半島地震の本震 |
 * | `--out=<パス>` | 書き込み先。リポジトリ直下からの相対パスで、**`src/data` 直下に限る** |
 * | `--require-city-unreceived` | 市町村の未入電（`City/Condition`）を持つ電文であることを要求する |
 * | `--require-max-scale-unreceived` | 電文全体の最大震度と同じ階級に未入電の観測点があることを要求する |
 *
 * **データごとの引数は `package.json` の script に焼く。** 手で打つ形にしておくと、
 * `--require-city-unreceived` のような検査の指定を落としたまま実行できてしまい、
 * 上流の電文が差し替わって未入電が消えたときに 0 件のデータが黙って書き出される。
 *
 * ## 取得は共通の口を通す
 *
 * アーカイブの一覧・本体の取得は `telegram-audit/archive-cache.mjs` に集約してある。
 * **素の `fetch` を書き足さないこと** —— 控えもレート制御も 429 のバックオフも通らず、
 * 同じ日を何度でも取り直す形になる（→ `docs/spec/data-sources-spec.md` §2
 * 「リクエスト数を抑える」）。控えは分類・日・アーカイブ id で引くので、
 * **監査スクリプトが既に取った日はここでもリクエストを出さない**（逆も同じ）。
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
// 最大震度が「以上」になるかの判定は**実装と同じ述語を通す**。ここで数え方を書き写すと、
// 本体の判定を変えたときに検査だけ古い条件のまま通り続ける。
import { isMaxScaleUnreceived } from '../src/utils/quakePoints'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 既定の出力先。**ラベルにも使う**ので定数にしてある（下記の呼び出し）。 */
const DEFAULT_OUT = 'src/data/noto-honshin-2024-quake.json'

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/**
 * `--out` の値を解決する。**書き込み先は `src/data` の直下に限る。**
 *
 * 打ち間違い（`../` を含む値・別の場所の絶対パス）でリポジトリの他の場所を上書きしないための
 * 歯止め。生成物の置き場所はここ 1 つしかないので、外を許す理由が無い。
 */
function resolveOut(value: string): string {
  const dataDir = path.join(ROOT, 'src/data')
  const out = path.resolve(ROOT, value)
  if (path.dirname(out) !== dataDir) {
    throw new Error(`--out は src/data 直下を指してください（渡された値: ${value}）`)
  }
  return out
}

async function build() {
  const eventId = arg('event', '20240101161010')
  const out = resolveOut(arg('out', DEFAULT_OUT))
  const requireCityUnreceived = flag('require-city-unreceived')
  const requireMaxScaleUnreceived = flag('require-max-scale-unreceived')
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

  // **その日のアーカイブだけを落とす。** 件数を先に出しておくのは、下の「見つかりません」で
  // **「読んだが無い」と「そもそも読んでいない」を区別する**ため。前者は `--event` の指定違い、
  // 後者は日付・分類の指定違い（または保持期間外）で、直す場所が別になる。
  const matched = items.filter(it => dayOf(it).startsWith(day))

  const found: { name: string; xml: string; stations: number }[] = []
  for (const it of matched) {
    const tar = await loadArchiveTar({ classification: EARTHQUAKE_CLASSIFICATION, item: it, auth })
    for (const { name, body } of tarEntries(tar)) {
      if (!/^VXSE53_.*\.xml$/i.test(name)) continue
      const xml = body.toString('utf8')
      if ((xml.match(/<EventID>([^<]*)<\/EventID>/) ?? [])[1] !== eventId) continue
      found.push({ name, xml, stations: (xml.match(/<IntensityStation>/g) ?? []).length })
    }
  }
  if (!found.length) {
    throw new Error(
      `${day} の ${eventId} に対する VXSE53 が見つかりません`
      + `（一覧 ${items.length} 件・うち ${day} のアーカイブ ${matched.length} 件を読みました）`,
    )
  }
  found.sort((a, b) => b.stations - a.stations)
  const picked = found[0]

  // パーサーは `DOMParser` を使うため、Node からは jsdom を通して読み込む。
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM()
  ;(globalThis as unknown as { DOMParser: typeof dom.window.DOMParser }).DOMParser = dom.window.DOMParser
  const { parseEarthquakeFromXml } = await import('../src/services/dmdataParser')

  const parsed = parseEarthquakeFromXml('VXSE53', picked.xml)
  if (!parsed) throw new Error(`${picked.name} をパーサーが受け付けませんでした`)
  // **報ごとに変わるものはテスト側で作るので落とす。** 識別子・発表時刻・発表元のほかに、
  // 電文を数える鍵（`telegramKey`）と電文が名乗った報番号（`reportSerial`）も入る。
  //
  // **パーサーへ報ごとに変わる項目を足したら、ここへも足すこと。** 落とし忘れると収録した
  // 電文の値が焼き付き、テストが作る発表時刻と食い違う（`telegramKey` は 2026-09-14 に
  // パーサーへ入ったが、ここが取り残されていた）。**型検査では捕まらない** ——
  // 読む側が `as unknown as` でキャストするため、混ざっても何も言われない。
  // `src/utils/testData.test.ts` が生成物のキーを見て落とす。
  const {
    kind: _kind, id: _id, eventId: _eventId, time: _time, issue: _issue,
    telegramKey: _telegramKey, reportSerial: _reportSerial,
    ...rest
  } = parsed

  // **市町村に紐付いた観測点があることを確かめる。** ここが 0 件だと、このスクリプトを
  // 作った目的（実機で 4 段目を確かめる）を果たせない。黙って出すと気づけない。
  const withCity = (rest.points ?? []).filter(p => !p.isArea && p.city).length
  if (withCity === 0) throw new Error(`${picked.name}: 市町村に紐付いた観測点が 1 件もありません`)

  // 市町村の未入電は 2 通りに分かれる（→ quake-spec.md §5「市町村の震度」）。
  // `hasUnreceived` は「震度を観測できたうえで配下に未入電がある」、`unreceived` は
  // 「市町村の値そのものが未入電」。実機で確かめたいのは両方なので別々に数える。
  const cityHasUnreceived = (rest.cities ?? []).filter(c => c.hasUnreceived).length
  const cityUnreceived = (rest.cities ?? []).filter(c => c.unreceived).length
  if (requireCityUnreceived && cityHasUnreceived + cityUnreceived === 0) {
    throw new Error(`${picked.name}: 市町村の未入電（City/Condition）が 1 件もありません`)
  }

  // 電文全体の最大震度に「以上」が付くか（→ quake-spec.md §4「震度5弱以上未入電」）。
  // **観測できた最大が5弱の地震でしか起きない** —— 未入電の観測点は下限の 45（5弱）へ
  // 寄せてあるので、最大震度が 45 のときだけ階級が一致する。
  const maxScale = rest.earthquake?.maxScale
  const maxScaleUnreceived = maxScale === undefined
    ? false
    : isMaxScaleUnreceived(maxScale, rest.points ?? [])
  if (requireMaxScaleUnreceived && !maxScaleUnreceived) {
    throw new Error(
      `${picked.name}: 最大震度（${maxScale}）と同じ階級の未入電の観測点がありません`
      + '（この電文では最大震度に「以上」が付きません）',
    )
  }

  fs.writeFileSync(out, JSON.stringify(rest), 'utf8')
  console.log(
    `${picked.name} から作りました: 点 ${rest.points?.length ?? 0}`
    + `（うち市町村に紐付いた観測点 ${withCity}・未入電の観測点 ${(rest.points ?? []).filter(p => p.unreceived).length}）`
    + `・市町村 ${rest.cities?.length ?? 0}`
    + `（未入電あり ${cityHasUnreceived}・値そのものが未入電 ${cityUnreceived}）`
    + `・最大震度 ${maxScale}${maxScaleUnreceived ? '（「以上」が付く）' : ''}`
    + ` → ${path.relative(ROOT, out)}`,
  )
}

// **ラベルに出力先のファイル名を入れる。** この script は引数違いで 2 つのデータを作るので
// （`build-test-quake` と `build-test-quake-unreceived`）、固定にすると取得の実測値の
// ログからどちらを実行した結果か分からない。
const label = `アーカイブ（地震情報のテストデータ: ${path.basename(arg('out', DEFAULT_OUT))}）`

runArchiveScript(label, build)
  .catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
