import { fetchJsonWithTimeout } from './fetchJson'

const DATA_URL = `${import.meta.env.BASE_URL}data/tts-phrase-break-dict.json`

/**
 * この辞書だけのタイムアウト（ミリ秒）。生成データ共通の `DATA_FETCH_TIMEOUT_MS`（60 秒）は使わない。
 *
 * 共通値は「初回に生成データ数 MB が並走する」前提の余裕を見た値だが、この辞書は数 KB と小さく、
 * かつ読み上げ本体（`speakWithVoicevox`）が取得を待つため、共通値だと緊急地震速報の読み上げが
 * その分そのまま遅れる。辞書が無くても句区切りが効かないだけで読み上げ自体は成立する
 * （`synthesizeChunk` はキャッシュを都度参照し、未取得なら句区切り処理を飛ばす）ので、短く見切る。
 */
export const DICT_FETCH_TIMEOUT_MS = 5_000

let cache: Record<string, string> | null = null
// _terms に列挙されたキー（地名ではなく一般用語）の集合。地名エントリとの読み上げ後ポーズの要否判定に使う。
let termKeysCache: Set<string> = new Set()
let inflight: Promise<Record<string, string>> | null = null

/**
 * 句区切り辞書を取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 *
 * この Promise は読み上げ本体（speakWithVoicevox）が await するため、解決しないまま止まると
 * 読み上げ全体が止まる。タイムアウトは必須で、値も短く抑える（{@link DICT_FETCH_TIMEOUT_MS}）。
 */
export function loadTtsPhraseBreakDict(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<Record<string, string> & { _terms?: string[] }>(
      DATA_URL,
      'tts-phrase-break-dict',
      DICT_FETCH_TIMEOUT_MS,
    )
      .then((data) => {
        const { _comment: _, _terms, ...dict } = data as Record<string, string> & { _terms?: string[] }
        termKeysCache = new Set(_terms ?? [])
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
 * 辞書キーが地名（区域名・港湾名等）かどうかを返す。
 * 「深発地震」「遠地地震」「大津波」等の一般用語（_terms に列挙）は false。
 * 地名の後だけ読み上げに短いポーズを挟みたい呼び出し側で使う。
 */
export function isPlaceNameKey(key: string): boolean {
  return !termKeysCache.has(key)
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
