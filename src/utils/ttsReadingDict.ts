const DATA_URL = `${import.meta.env.BASE_URL}data/tts-reading-dict.json`

let cache: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

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
        // "_comment" キーは除外する
        const { _comment: _, ...dict } = data as Record<string, string>
        cache = dict
        return dict
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
    result = result.split(kanji).join(reading)
  }
  return result
}
