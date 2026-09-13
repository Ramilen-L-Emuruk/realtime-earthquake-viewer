// 国立情報学研究所（NII）CPS-IIPプロジェクトが公開する「気象庁防災情報XMLデータベース」
// （https://agora.ex.nii.ac.jp/cps/weather/report/）から、実際に配信された気象庁防災情報
// XML電文を取得する。2012年12月以降の電文を保持しており、気象庁防災情報XMLフォーマット
// 自体の運用開始（2011年5月12日）より後に発生した災害であれば、本物の電文をそのまま
// 再利用できる（DMDATA.JPのアーカイブは2020年11月18日以降のみのため、それより前の期間を
// 補う情報源として使う）。
//
// 出典・ライセンス: 気象庁防災情報XMLデータベース（国立情報学研究所 CPS-IIP, Asanobu KITAMOTO）。
// 「気象庁防災情報XMLに関連し、かつ他サービスとのマッシュアップとなっていない部分」は
// CC BY 4.0（https://creativecommons.org/licenses/by/4.0/legalcode.ja）。
//
// 個別電文のIDはページごとに形式が違う（一覧ページはUUID、種別検索ページは
// "eventId_serial_headType_officeCode"）。どちらの形式でも report_xml.pl?id=<id> で
// 生XMLを取得できる。
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NII_BASE = 'https://agora.ex.nii.ac.jp'

/**
 * 取得したページを残す場所。**一度取ったURLは二度取らない。**
 *
 * 1件の地震活動で数百通の電文を1通ずつ取るため（2016年熊本地震は653通）、途中で1回でも
 * 落ちると最初から取り直しになる。配信元は小規模な学術サーバーで、実測では1応答に60〜90秒
 * かかり502も断続的に返す。**取り直しの回数を減らすことが、こちら側の都合であると同時に
 * 相手への配慮でもある。**
 *
 * 過去の電文とその一覧は書き換わらないため、キャッシュは無期限でよい。
 */
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'nii-cache')

/** 1回の取得で何度まで試すか。指数バックオフと組で使う。 */
const FETCH_ATTEMPTS = 6

/** リトライの待ち時間の基準（ミリ秒）。n回目の失敗後に `BACKOFF_BASE_MS * 2^(n-1)` 待つ。 */
const BACKOFF_BASE_MS = 2000

/**
 * 名乗り。**ブラウザを騙らない。**
 *
 * 素の `fetch` はUser-Agentを送らず（Node.jsは既定で付けない）、配信元はそれを弾いている
 * ように見える瞬間があった。ただし同じ時間帯に接続タイムアウトも502も観測しているため、
 * User-Agentが原因だという確証は無い。**確証が無いからこそ、素性を名乗る側に倒す** ——
 * 相手が自動取得を識別できる形にしておく。
 */
const USER_AGENT = 'realtime-earthquake-viewer/archive-builder (+https://github.com/Ramilen-L-Emuruk/realtime-earthquake-viewer)'

export interface NiiTelegramListItem {
  id: string
  time: string
  /** 日本語の情報名称（例: "震度速報"）。report_day.pl の headtitle 表示をそのまま使う。 */
  typeLabel: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function fetchText(url: string, retries = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (attempt === retries) throw new Error(`取得失敗 ${url}: ${(err as Error).message}`, { cause: err })
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  throw new Error('unreachable')
}

/** キャッシュのファイル名。URLをそのまま使えないので、英数字以外を潰す。 */
function cacheFileName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.html`
}

/**
 * 残してあるページを読む。**保存したときと同じ目で検分する。**
 *
 * 数百通を数分かけて取るので、途中で中断されれば切り詰められた内容が残りうる。読むときにも
 * 見ておけば、壊れたものは「無かった」ことになって取り直しへ回る（手で消さなくても回復する）。
 */
async function readCache(key: string, canCache: (html: string) => boolean): Promise<string | null> {
  try {
    const text = await readFile(join(CACHE_DIR, cacheFileName(key)), 'utf-8')
    return canCache(text) ? text : null
  } catch (err) {
    // **まだ残していないだけ（`ENOENT`）は正常。それ以外は黙らない。**
    // 権限や I/O の異常で読めない状態が続くと、キャッシュが無いのと同じことになり、
    // 数百通を毎回取り直す —— この仕組みが減らそうとしている負荷が、誰にも気づかれずに戻る
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[nii-cache] 読めませんでした（${key}）: ${(err as Error).message}`)
    }
    return null
  }
}

/**
 * ページを残す。**一時ファイルへ書いてから置き換える。**
 *
 * 直接書くと、書いている途中で止まったときに切り詰められた内容がそのまま残る。
 *
 * **失敗しても投げない。** ディスクが一杯・書き込み権限が無いといったローカル起因の失敗は
 * 配信元とは無関係で、取得そのものは成功している。ここで投げると、既に取れている応答を捨てて
 * 低速な相手をもう一度叩くことになるうえ、原因が「配信元が不安定」に見えてしまう。
 */
async function saveCache(key: string, html: string): Promise<void> {
  const dest = join(CACHE_DIR, cacheFileName(key))
  const tmp = `${dest}.${process.pid}.tmp`
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(tmp, html, 'utf-8')
    await rename(tmp, dest)
  } catch (err) {
    // 書きかけを残さない（消せなくても構わない。ここで投げたら本末転倒）
    await unlink(tmp).catch(() => undefined)
    console.warn(`[nii-cache] 残せませんでした（${key}）: ${(err as Error).message}`)
  }
}

/**
 * 配信元からページを取り、**中身が期待の形をしているときだけキャッシュへ残す**。
 *
 * 検分せずに残すと、HTTP 200 で返ってきたエラーページを恒久的にキャッシュしてしまう。
 * そうなるとその電文は二度と取り直されず、**「その日は電文が無かった」「その電文は空だった」
 * という嘘が残り続ける**（「残す前に検分する」という考え方は `build-hypocenter-catalog.ts` の
 * `fetchDailyHtml` と同じ。ただし向こうは読み込み時の再検分と一時ファイル経由の置き換えを持たない）。
 *
 * **検分はキャッシュの可否だけに使い、リトライの判断には使わない。** HTTP 200 が返ってきた
 * 時点で取得そのものは成功していて、中身の形をどう扱うかは呼び出し側が既に決めている
 * （一覧は該当行が無ければ空配列、電文は `<pre>` が無ければ例外）。ここで例外にすると、
 * その判断を飛び越えて**呼び出し側が意図していた振る舞いまで止めてしまう**。
 * リトライするのは通信の失敗（502 等・ネットワークエラー）だけでよい。
 *
 * @param canCache 残してよい内容なら true。false でも値はそのまま返す（保存しないだけ）
 */
async function fetchNiiText(url: string, cacheKey: string, canCache: (html: string) => boolean): Promise<string> {
  const cached = await readCache(cacheKey, canCache)
  if (cached !== null) return cached

  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      // 保存は取得の成否と切り離す（`saveCache` は失敗しても投げない）
      if (canCache(html)) await saveCache(cacheKey, html)
      return html
    } catch (err) {
      lastError = err
      if (attempt < FETCH_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
    }
  }
  throw new Error(`取得失敗 ${url}: ${(lastError as Error)?.message ?? lastError}`, { cause: lastError })
}

/** 1日ぶんの電文一覧を取得する（date は "YYYYMMDD"）。天気・警報等も含む全種別。 */
export async function fetchDayListing(date: string): Promise<NiiTelegramListItem[]> {
  const html = await fetchNiiText(
    `${NII_BASE}/cgi-bin/cps/report_day.pl?date=${date}`,
    `day-${date}`,
    // 1件も載っていない応答は残さない。対象は天気・警報等も含む全種別なので、電文が1通も
    // 無い日は現実には無く、混雑時のエラーページである可能性が高い。**ただし例外にはしない** ——
    // 該当行が無いときに空配列を返すのは、この関数が元から持っている振る舞い
    (text) => /<a class="time" href="\/cgi-bin\/cps\/report_each\.pl\?id=/.test(text),
  )
  const items: NiiTelegramListItem[] = []
  // 1件ぶんは概ね次の形:
  // <a class="time" href="report_each.pl?id=<uuid>">YYYY-MM-DD HH:MM:SS+09</a><br>
  // <a class="nowrap" href="report_list.pl?type=...">種別名</a><br>...
  // <div class="headtitle">種別名（短縮）</div>
  const re = /<a class="time" href="\/cgi-bin\/cps\/report_each\.pl\?id=([^"]+)">([^<]+)<\/a><br><a class="nowrap" href="\/cgi-bin\/cps\/report_list\.pl\?type=[^"]+">([^<]+)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    items.push({ id: m[1], time: m[2], typeLabel: m[3] })
  }

  // 個々の "time" アンカーの出現数とマッチ件数を突き合わせる。ページの一部が想定外の
  // マークアップ（訂正・取消電文特有の追加要素等）を使っていると、そこだけ正規表現に
  // マッチせず無警告で items から抜け落ちる。件数が食い違えば黙って進めず例外にする。
  const rawTimeAnchorCount = (html.match(/<a class="time" href="\/cgi-bin\/cps\/report_each\.pl\?id=/g) ?? []).length
  if (rawTimeAnchorCount !== items.length) {
    throw new Error(
      `report_day.pl(date=${date}) の一部の行がパースできませんでした（time要素${rawTimeAnchorCount}件 / マッチ${items.length}件）`,
    )
  }

  return items
}

/** report_xml.pl の応答（HTMLに埋め込まれたエスケープ済みXML）から生XMLを取り出す。 */
function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export async function fetchRawXml(id: string): Promise<string> {
  const html = await fetchNiiText(
    `${NII_BASE}/cgi-bin/cps/report_xml.pl?id=${id}`,
    `xml-${id}`,
    // 電文の本体が入っていない応答を残さない。**`<pre>` があるだけでは足りない** ——
    // エラーページも整形済みテキストを `<pre>` で包みうる。気象庁防災情報XMLの根要素まで見る
    (text) => /<pre>[\s\S]*?&lt;Report[\s\S]*?<\/pre>/.test(text),
  )
  const m = html.match(/<pre>([\s\S]*?)<\/pre>/)
  if (!m) throw new Error(`report_xml.pl の応答に<pre>ブロックが見つかりません（id=${id}）`)
  return unescapeHtmlEntities(m[1])
}
