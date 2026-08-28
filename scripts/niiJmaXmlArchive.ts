// 国立情報学研究所（NII）CPS-IIPプロジェクトが公開する「気象庁防災情報XMLデータベース」
// （https://agora.ex.nii.ac.jp/cps/weather/report/）から、実際に配信された気象庁防災情報
// XML電文を取得する。2012年12月以降の電文を保持しており、気象庁防災情報XMLフォーマット
// 自体の運用開始（2011年5月12日）より後に発生した災害であれば、本物の電文をそのまま
// 再利用できる（DMDATA.JPのアーカイブは2020年4月以降のみのため、それより前の期間を
// 補う情報源として使う）。
//
// 出典・ライセンス: 気象庁防災情報XMLデータベース（国立情報学研究所 CPS-IIP, Asanobu KITAMOTO）。
// 「気象庁防災情報XMLに関連し、かつ他サービスとのマッシュアップとなっていない部分」は
// CC BY 4.0（https://creativecommons.org/licenses/by/4.0/legalcode.ja）。
//
// 個別電文のIDはページごとに形式が違う（一覧ページはUUID、種別検索ページは
// "eventId_serial_headType_officeCode"）。どちらの形式でも report_xml.pl?id=<id> で
// 生XMLを取得できる。
const NII_BASE = 'https://agora.ex.nii.ac.jp'

export interface NiiTelegramListItem {
  id: string
  time: string
  /** 日本語の情報名称（例: "震度速報"）。report_day.pl の headtitle 表示をそのまま使う。 */
  typeLabel: string
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

/** 1日ぶんの電文一覧を取得する（date は "YYYYMMDD"）。天気・警報等も含む全種別。 */
export async function fetchDayListing(date: string): Promise<NiiTelegramListItem[]> {
  const html = await fetchText(`${NII_BASE}/cgi-bin/cps/report_day.pl?date=${date}`)
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
  const html = await fetchText(`${NII_BASE}/cgi-bin/cps/report_xml.pl?id=${id}`)
  const m = html.match(/<pre>([\s\S]*?)<\/pre>/)
  if (!m) throw new Error(`report_xml.pl の応答に<pre>ブロックが見つかりません（id=${id}）`)
  return unescapeHtmlEntities(m[1])
}
