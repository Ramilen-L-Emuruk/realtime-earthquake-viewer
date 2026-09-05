// NIIアーカイブ（気象庁防災情報XMLデータベース）+ 気象庁発表状況ページ（pub_hist）から
// 特定の地震活動のローカル履歴アーカイブを組み立てる共通処理。
// 2016年熊本地震向けに書いた build-historical-archive-2016-kumamoto.ts のロジックのうち、
// 地震活動ごとに変わらない部分（NII時刻のパース・種別ラベルの解釈・取消電文の扱い・
// 集計の整合性チェック）を切り出したもの。地震活動ごとに変わる部分（EEW一覧・震央地名・
// 収録期間）は呼び出し側が渡す。
//
// dmdataParser.ts の parseEarthquakeFromXml/parseTsunamiFromXml はこのモジュールでは
// importしない。呼び出し側で jsdom の DOMParser ポリフィルを入れてから動的importした
// 関数を引数で渡すこと（このモジュールを静的importする時点でdmdataParser.tsが先に
// 読み込まれてしまうと、ポリフィル未設定のまま失敗する）。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fetchDayListing, fetchRawXml, fetchText } from './niiJmaXmlArchive'
import { buildEewEntries } from './historicalEewArchiveBuilder'
import { parseEewContentHtml } from './historicalEewParser'
import type { HistoricalArchiveEntry, HistoricalArchiveFile } from '../src/types/historicalArchive'
import type { AppEvent, JMAQuake, JMATsunami } from '../src/types/earthquake'

export interface EewEventSpec {
  /** entry.id / issue.eventId の元になる接頭辞（例: "2018osaka-mainshock"） */
  idPrefix: string
  /** pub_hist の発表状況ディレクトリ名（例: "20180618075838"） */
  dir: string
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

/** 気象庁発表状況ページ（pub_hist）から警報級EEWの全報を取得する。 */
export async function buildEewSection(eewBase: string, events: EewEventSpec[]): Promise<HistoricalArchiveEntry[]> {
  const all: HistoricalArchiveEntry[] = []
  for (const { idPrefix, dir } of events) {
    const url = `${eewBase}/${dir}/content/content_out.html`
    const html = await fetchText(url)
    if (!html || html.includes('404')) throw new Error(`${idPrefix}: EEWページを取得できません（${url}）`)
    const parsed = parseEewContentHtml(html)
    const entries = buildEewEntries(parsed, { idPrefix })
    if (entries.length === 0) throw new Error(`${idPrefix}: 報が1件も生成されませんでした（${url}）`)
    all.push(...entries)
    console.log(`  ${idPrefix}: ${entries.length}報 (${parsed.hypocenter.name} M${parsed.hypocenter.magnitude})`)
  }
  return all
}

// 地震情報・津波として取り込む対象の電文の見分け方。
//
// NIIサイトの表示ラベルは、完全一致で辞書引きするには信用できないことが分かっている
// （実際に2回踏んだ事故: 「震源・震度情報」だと思っていたら実際は「震源・震度に関する
// 情報」だった／津波系のラベルには末尾に説明のつかない"a"が付く）。そのため、まず
// 「地震・津波に関係しそうな候補」を広くキーワードで拾い、個別の種別判定は含有文字列で
// 行う。どれにも一致しない候補は黙って捨てず例外にする。
export const QUAKE_CANDIDATE_KEYWORDS = ['震度', '震源', '顕著な地震']
export const TSUNAMI_CANDIDATE_KEYWORD = '津波'

/**
 * 地震情報の種別ラベルから、より具体的なパターンを先に判定する（「震源・震度」は
 * 「震源」も含むため、判定順を間違えると全てVXSE52に丸め込まれる）。地震活動に依らず
 * NIIサイトの表示ラベル自体の解釈なので、地震ごとにカスタマイズする必要はない。
 */
export function resolveQuakeHeadType(typeLabel: string): string {
  if (typeLabel.includes('震度速報')) return 'VXSE51'
  if (typeLabel.includes('顕著な地震')) return 'VXSE61'
  if (typeLabel.includes('震源・震度')) return 'VXSE53'
  if (typeLabel.includes('震源')) return 'VXSE52'
  throw new Error(`地震情報の種別ラベルを解釈できません: "${typeLabel}"`)
}

/**
 * 震央地名（完全一致）または観測地域名（前方一致）でこの地震活動に関連するかを判定する。
 * 震度速報（VXSE51）は震源が未確定の段階で発表されるため震央地名を持たず
 * （parseEarthquakeFromXmlの仕様どおり、hypocenter.nameは常に空文字になる）、
 * 観測震度の対象地域名で代わりに判定する。地域名は前方一致で意図的に粗くしている
 * （一次細分区域名を返すため、県名・地方名レベルでしか震央と対応が取れない）。
 * この粒度の非対称は時刻ウィンドウとの併用で補う設計。
 */
export function isRelated(
  quake: { earthquake: { hypocenter: { name: string } }; points: { addr: string }[] },
  hypocenterNames: Set<string>,
  areaPrefixes: string[],
): boolean {
  if (quake.earthquake.hypocenter.name) return hypocenterNames.has(quake.earthquake.hypocenter.name)
  return quake.points.some((p) => areaPrefixes.some((prefix) => p.addr.startsWith(prefix)))
}

/**
 * 取消電文（InfoType==='取消'）は parseEarthquakeFromXml が points・hypocenter.name を
 * 両方とも空にして返す仕様のため、isRelated() のどちらの経路にも一致しない
 * （必ず false になる）。震央地名・観測地域名のどちらでも判定できない構造上の穴であり、
 * 誤って「無関係」に丸め込まず専用の判定・専用カウンタで扱う。
 */
export function isUnverifiableCancellation(quake: {
  cancelled?: boolean
  earthquake: { hypocenter: { name: string } }
  points: { addr: string }[]
}): boolean {
  return quake.cancelled === true && !quake.earthquake.hypocenter.name && quake.points.length === 0
}

/**
 * NIIサイトの一覧表示時刻（例: "2016-04-14 21:28:06+09"）はISO 8601ではない
 * （タイムゾーンオフセットが分無しの2桁）。`new Date()` にそのまま渡すと Invalid Date に
 * なり、Invalid Date 同士の比較は常に false を返すため、時刻ウィンドウによる絞り込みが
 * 無警告で機能しなくなる（実際に踏んだ事故）。分を補ってからパースし、それでも
 * Invalid Date ならログでは気づけないため例外にする。
 */
export function parseNiiTime(niiTime: string): Date {
  const m = niiTime.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\+(\d{2})$/)
  if (!m) throw new Error(`NII一覧の時刻表記を解釈できません: "${niiTime}"`)
  const parsed = new Date(`${m[1]}T${m[2]}+${m[3]}:00`)
  if (Number.isNaN(parsed.getTime())) throw new Error(`NII一覧の時刻をDateとして解釈できません: "${niiTime}"`)
  return parsed
}

export interface QuakeTsunamiOptions {
  /** 電文一覧を取得する日付（"YYYYMMDD"）の集合。連続した範囲でなくてもよい
   *  （散発的な余震が長期間に渡る地震活動では、実際にEEWが出た日の前後だけを
   *  指定すればよい。全期間を連続で舐めるとNIIサイトへの負荷・実行時間が過大になる）。 */
  dates: string[]
  windowStart: Date
  windowEnd: Date
  hypocenterNames: Set<string>
  areaPrefixes: string[]
  /** jsdomポリフィル設定後に動的importした dmdataParser.ts の関数をそのまま渡す。 */
  parseEarthquakeFromXml: (headType: string, xml: string) => JMAQuake | null
  parseTsunamiFromXml: (xml: string) => JMATsunami | null
}

export async function buildQuakeAndTsunamiSection(opts: QuakeTsunamiOptions): Promise<HistoricalArchiveEntry[]> {
  const { dates, windowStart, windowEnd, hypocenterNames, areaPrefixes, parseEarthquakeFromXml, parseTsunamiFromXml } = opts
  const entries: HistoricalArchiveEntry[] = []
  let totalCandidates = 0
  let fetched = 0
  let kept = 0
  let skippedOutOfWindow = 0
  let skippedUnrelated = 0
  let skippedParseFailed = 0
  let skippedCancelledUnverifiable = 0

  for (const date of dates) {
    console.log(`  ${date} の電文一覧を取得中...`)
    const listing = await fetchDayListing(date)
    // 全国対象の天気・警報等も含む一覧が1件も無い日は、対象日の指定ミスかサイト側の
    // 構造異常のいずれかであり、平常時でもまずあり得ない。黙って「候補0件」に進めず
    // 例外にする（候補0件そのもの＝フィルタ後の結果は正当にありうるので許容する）。
    if (listing.length === 0) throw new Error(`${date}: 電文一覧が0件でした（一覧ページの取得に問題がある可能性）`)

    const candidates = listing.filter(
      (it) => QUAKE_CANDIDATE_KEYWORDS.some((k) => it.typeLabel.includes(k)) || it.typeLabel.includes(TSUNAMI_CANDIDATE_KEYWORD),
    )
    console.log(`    候補 ${candidates.length}件`)
    totalCandidates += candidates.length

    for (const item of candidates) {
      const itemTime = parseNiiTime(item.time)
      if (itemTime < windowStart || itemTime > windowEnd) {
        skippedOutOfWindow++
        continue
      }

      const xml = await fetchRawXml(item.id)
      fetched++
      await sleep(120) // 小規模なアカデミックサーバーへの配慮

      if (item.typeLabel.includes(TSUNAMI_CANDIDATE_KEYWORD)) {
        const tsunami = parseTsunamiFromXml(xml)
        if (!tsunami) {
          skippedParseFailed++
          continue
        }
        // 津波電文には震源要素（sourceEarthquake）が無い場合がある（観測情報のみの続報等）。
        // 持っている場合だけ震央地名で関連性を確認する。持たない場合はキーワード＋時刻
        // ウィンドウのみが頼りになる（isRelated と非対称だが、津波電文の構造上これ以上の
        // 判定材料が無い）。
        // 原因地震が複数ある電文では、**1 つでも対象の震源に当たれば残す**。
        // 先頭だけを見ると、2 件目に対象が入っている電文を落とす。
        const sourceNames = tsunami.sourceEarthquakes?.map(eq => eq.hypocenterName).filter(Boolean) ?? []
        if (sourceNames.length > 0 && !sourceNames.some(n => hypocenterNames.has(n))) {
          skippedUnrelated++
          continue
        }
        // dmdataParser.ts の id 生成は eventId+serial を使うが、Serial が空の電文（震度速報等）
        // では固定値'1'に丸められるため、同じ地震の別種別の電文と衝突しうる。NIIの電文ID
        // （電文ごとに一意）を足して確実に一意にする。
        entries.push({ time: tsunami.time, payload: { kind: 'event', event: { ...tsunami, id: `${tsunami.id}-${item.id}` } as AppEvent } })
        kept++
        continue
      }

      const headType = resolveQuakeHeadType(item.typeLabel)
      const quake = parseEarthquakeFromXml(headType, xml)
      if (!quake) {
        skippedParseFailed++
        continue
      }
      if (isUnverifiableCancellation(quake)) {
        // 取消電文は震央地名・観測地域名のどちらも持たないため isRelated() で判定できない
        // （構造上の制約）。無関係と決めつけて捨てず、専用カウンタで可視化した上で見送る。
        skippedCancelledUnverifiable++
        continue
      }
      if (!isRelated(quake, hypocenterNames, areaPrefixes)) {
        skippedUnrelated++
        continue
      }
      entries.push({ time: quake.time, payload: { kind: 'event', event: { ...quake, id: `${quake.id}-${item.id}` } as AppEvent } })
      kept++
    }
  }

  console.log(
    `  地震情報・津波: 取得${fetched}件 → 採用${kept}件` +
      `（期間外${skippedOutOfWindow}件・無関係${skippedUnrelated}件・パース失敗${skippedParseFailed}件・` +
      `取消電文（判定不能）${skippedCancelledUnverifiable}件を除外）`,
  )
  if (kept === 0) throw new Error('地震情報・津波が1件も採用されませんでした')
  const accountedFor = kept + skippedOutOfWindow + skippedUnrelated + skippedParseFailed + skippedCancelledUnverifiable
  if (accountedFor !== totalCandidates) {
    throw new Error(`集計の不整合: 候補${totalCandidates}件に対し内訳の合計が${accountedFor}件です`)
  }
  return entries
}

interface IndexEntry {
  id: string
  label: string
  description: string
  from: string
  to: string
  firstEventTime: string
}

/**
 * 既存のindex.json一覧へ新規/更新エントリを追加し、収録範囲の開始時刻(from)順に並べ替える。
 * 単純追記だと実行順（開発時にどのアーカイブを先に作ったか）でしか並ばず、設定タブの一覧が
 * 地震の起きた順にならない（実際に発生していた不具合）。同じidが既にあれば置き換える。
 */
export function mergeIndexEntry(index: IndexEntry[], newEntry: IndexEntry): IndexEntry[] {
  return [...index.filter((e) => e.id !== newEntry.id), newEntry]
    .sort((a, b) => new Date(a.from).getTime() - new Date(b.from).getTime())
}

export interface FinalizeArchiveOptions {
  id: string
  label: string
  description: string
  windowStart: Date
  windowEnd: Date
  entries: HistoricalArchiveEntry[]
  outPath: string
  indexPath: string
  /** isRelated() が正しく機能していれば、採用済みentriesの震央地名はこの集合か空文字の
   *  どちらかのはず。それ以外が混入していたら isRelated() 側の不具合を疑う防御チェックに使う。 */
  hypocenterNames: Set<string>
}

/**
 * id重複チェック・震央地名の事後検証・ファイル書き出し・index.json更新をまとめて行う。
 * 4本のビルドスクリプト（熊本・鳥取・大阪・胆振東部）がこのブロックを個別にコピペして
 * いたことで、将来ここに検証を足したときに1本だけ直し忘れるリスクがあった
 * （レビューで指摘）。地震活動に依らない処理なのでここに集約する。
 */
export async function finalizeArchive(opts: FinalizeArchiveOptions): Promise<void> {
  const { id, label, description, windowStart, windowEnd, entries, outPath, indexPath, hypocenterNames } = opts

  if (entries.length === 0) throw new Error('entriesが1件もありません（firstEventTimeを決定できません）')

  const allEntries = [...entries].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())

  const idCounts = new Map<string, number>()
  for (const e of allEntries) {
    const eid = (e.payload as { event?: { id?: string } }).event?.id
    if (!eid) throw new Error(`idを持たないエントリがあります: ${JSON.stringify(e)}`)
    idCounts.set(eid, (idCounts.get(eid) ?? 0) + 1)
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1)
  if (duplicateIds.length > 0) {
    throw new Error(`id が重複しています: ${duplicateIds.map(([eid, count]) => `${eid}(${count}件)`).join(', ')}`)
  }

  // isRelated() を通過したはずのquakeエントリの震央地名が、渡されたhypocenterNames
  // （または震度速報の空文字）のどちらでもなければ、isRelated()自体の不具合か、
  // 呼び出し側が渡すhypocenterNamesの取り違えを疑う。
  const unexpectedHypocenters = new Set<string>()
  for (const e of allEntries) {
    const event = (e.payload as { event?: { kind?: string; earthquake?: { hypocenter?: { name?: string } } } }).event
    if (event?.kind !== 'quake') continue
    const name = event.earthquake?.hypocenter?.name ?? ''
    if (name && !hypocenterNames.has(name)) unexpectedHypocenters.add(name)
  }
  if (unexpectedHypocenters.size > 0) {
    throw new Error(`震央地名が想定外の地震情報が混入しています: ${[...unexpectedHypocenters].join(', ')}`)
  }

  const out: HistoricalArchiveFile = {
    id,
    label,
    description,
    from: windowStart.toISOString(),
    to: windowEnd.toISOString(),
    firstEventTime: allEntries[0].time,
    entries: allEntries,
  }

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8')
  console.log(`書き出し完了: ${outPath}（全${allEntries.length}件）`)

  const indexRaw = await readFile(indexPath, 'utf-8')
  const index = JSON.parse(indexRaw) as IndexEntry[]
  const newIndexEntry: IndexEntry = { id: out.id, label: out.label, description: out.description, from: out.from, to: out.to, firstEventTime: out.firstEventTime }
  const updatedIndex = mergeIndexEntry(index, newIndexEntry)
  await writeFile(indexPath, JSON.stringify(updatedIndex, null, 2) + '\n', 'utf-8')
  console.log('index.json を更新しました')
}
