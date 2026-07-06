const DATA_URL = `${import.meta.env.BASE_URL}data/tts-phrase-break-dict.json`

let cache: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

/** 句区切り辞書を取得する。初回のみ fetch し、以降はキャッシュを返す。 */
export function loadTtsPhraseBreakDict(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`tts-phrase-break-dict fetch failed: ${res.status}`)
        return res.json() as Promise<Record<string, string>>
      })
      .then((data) => {
        const { _comment: _, ...dict } = data as Record<string, string>
        cache = dict
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
 * 読み込み済みの句区切り辞書キャッシュを返す（未読み込みなら null）。
 * テキスト中にこの辞書のキーが含まれるかの判定に、fetch を待たず使う。
 */
export function getTtsPhraseBreakDictCache(): Record<string, string> | null {
  return cache
}

/**
 * テキスト内に辞書のキーが含まれるか調べ、最初に出現する位置のものを返す。
 * 複数キーが同じ位置から始まる場合は長い方を優先する。見つからなければ null。
 */
export function findPhraseBreakMatch(
  text: string,
  dict: Record<string, string>,
): { key: string; index: number } | null {
  let best: { key: string; index: number } | null = null
  for (const key of Object.keys(dict)) {
    const index = text.indexOf(key)
    if (index < 0) continue
    if (best == null || index < best.index || (index === best.index && key.length > best.key.length)) {
      best = { key, index }
    }
  }
  return best
}
