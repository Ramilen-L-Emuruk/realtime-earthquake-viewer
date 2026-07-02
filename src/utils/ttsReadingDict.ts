const DATA_URL = `${import.meta.env.BASE_URL}data/tts-reading-dict.json`

let cache: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

/**
 * 地理的接尾語のペア（漢字 → ひらがな）。
 * 長い接尾語を先に並べることで「地方南部」が「地方」より先に試される。
 * ここに登録した接尾語は辞書ロード時に短縮形エントリとして自動展開される。
 */
const GEO_SUFFIXES: [string, string][] = [
  ['地方中東部', 'ちほうちゅうとうぶ'],
  ['地方南東部', 'ちほうなんとうぶ'],
  ['地方北東部', 'ちほうほくとうぶ'],
  ['地方南西部', 'ちほうなんせいぶ'],
  ['地方北西部', 'ちほうほくせいぶ'],
  ['地方南部',   'ちほうなんぶ'],
  ['地方北部',   'ちほうほくぶ'],
  ['地方東部',   'ちほうとうぶ'],
  ['地方西部',   'ちほうせいぶ'],
  ['地方中部',   'ちほうちゅうぶ'],
  ['地方',       'ちほう'],
  ['沖南部',     'おきなんぶ'],
  ['沖北部',     'おきほくぶ'],
  ['南東沖',     'なんとうおき'],
  ['北西沖',     'ほくせいおき'],
  ['南方沖',     'なんぽうおき'],
  ['東方沖',     'とうほうおき'],
  ['西方沖',     'せいほうおき'],
  ['近海',       'きんかい'],
  ['南部',       'なんぶ'],
  ['北部',       'ほくぶ'],
  ['東部',       'とうぶ'],
  ['西部',       'せいぶ'],
  ['中部',       'ちゅうぶ'],
  ['付近',       'ふきん'],
  ['沖',         'おき'],
]

/**
 * 辞書エントリから短縮形エントリを自動展開する。
 * キーが地理的接尾語で終わり、かつ読みが対応するひらがな接尾語で終わる場合に
 * 接尾語を除いた短縮形（漢字・読みとも）を生成して辞書に追加する。
 * 既に同キーが登録済みの場合はユーザー定義を優先してスキップする。
 */
function expandShortForms(dict: Record<string, string>): Record<string, string> {
  const expanded = { ...dict }
  for (const [key, reading] of Object.entries(dict)) {
    for (const [kanjiSuffix, kanaSuffix] of GEO_SUFFIXES) {
      if (key.endsWith(kanjiSuffix) && reading.endsWith(kanaSuffix)) {
        const shortKey = key.slice(0, -kanjiSuffix.length)
        const shortReading = reading.slice(0, -kanaSuffix.length)
        if (shortKey.length > 0 && !(shortKey in expanded)) {
          expanded[shortKey] = shortReading
        }
        break  // 最初にマッチした（最長の）接尾語のみ処理
      }
    }
  }
  return expanded
}

export function getTtsReadingDictCache(): Record<string, string> | null {
  return cache
}

/** 読み辞書を取得する。初回のみ fetch し、以降はキャッシュを返す。 */
export function loadTtsReadingDict(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`tts-reading-dict fetch failed: ${res.status}`)
        return res.json() as Promise<Record<string, string>>
      })
      .then((data) => {
        const { _comment: _, ...dict } = data as Record<string, string>
        cache = expandShortForms(dict)
        return cache
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}

/**
 * テキスト内の地名・用語を読み辞書に基づいてひらがなに変換する。
 * 辞書が未ロードの場合はそのまま返す（サイレント）。
 * 長いキーから優先的に置換することで部分一致の誤置換を防ぐ。
 */
export function applyTtsReadings(text: string): string {
  if (!cache) return text
  const entries = Object.entries(cache).sort((a, b) => b[0].length - a[0].length)
  let result = text
  for (const [kanji, reading] of entries) {
    result = result.split(kanji).join(`{${kanji}|${reading}}`)
  }
  return result
}
