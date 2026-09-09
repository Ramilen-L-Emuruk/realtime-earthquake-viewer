import { fetchJsonWithTimeout } from './fetchJson'
import { log } from './logger'

const DATA_URL = `${import.meta.env.BASE_URL}data/tts-station-readings.json`

/**
 * この辞書だけのタイムアウト（ミリ秒）。句区切り辞書（`DICT_FETCH_TIMEOUT_MS`）と同じ値にする。
 *
 * 読み上げ本体が両方の取得を待つため、片方だけ長くしても意味がない。取れなくても観測点名の
 * 誤読が残るだけで読み上げ自体は成立するので、短く見切る。
 */
export const STATION_READINGS_FETCH_TIMEOUT_MS = 5_000

let cache: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

/**
 * 震度観測点名の読み（AquesTalk 風カナ）を取得する。初回のみ fetch し、以降はキャッシュを返す。
 *
 * 収録されているのは**音声合成エンジンが誤読する観測点だけ**（生成は
 * `scripts/build-station-readings.ts`）。正しく読める点を入れないのは、カナ経由にすると
 * アクセントと句切れがエンジンの推定に委ねられ、かえって崩れるため。
 *
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 * この Promise を読み上げ本体が await するため、解決しないまま止まると読み上げ全体が止まる。
 * タイムアウトは必須（{@link STATION_READINGS_FETCH_TIMEOUT_MS}）。
 */
export function loadTtsStationReadings(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<Record<string, string>>(
      DATA_URL,
      'tts-station-readings',
      // 取れなくても観測点名の読みが効かないだけで地図は変わらないため、
      // 地図に重ねる取得状況表示には数えない（句区切り辞書と同じ扱い）。
      {
        timeoutMs: STATION_READINGS_FETCH_TIMEOUT_MS,
        trackStatus: false,
        // 200 でも中身が空・別物なら失敗として扱う。取得の中で検分しないと、
        // 「取れた」ことになってから気づく形になり、記録に残らない。
        validate: (data) => {
          if (data == null || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('観測点の読みが JSON オブジェクトではありません')
          }
          const entries = Object.entries(data as Record<string, unknown>)
            .filter(([key]) => !key.startsWith('_'))
          if (entries.length === 0) throw new Error('観測点の読みが 1 件も入っていません')
          const bad = entries.find(([, value]) => typeof value !== 'string' || value === '')
          if (bad) throw new Error(`観測点の読みの値が文字列ではありません: ${bad[0]}`)
          // 空のキーは弾く。`findPhraseBreakMatch` の `text.indexOf('')` は常に 0 を返すので、
          // 混ざるとどのチャンクにも先頭で一致し、読み上げの頭に無関係な読みが差し込まれる。
          if (entries.some(([key]) => key === '')) throw new Error('観測点の読みに空のキーがあります')
        },
      },
    )
      .then((data) => {
        // `_comment` のような注記のキーは辞書から外す（キーは観測点名だけ）。
        const dict: Record<string, string> = {}
        for (const [key, value] of Object.entries(data)) {
          if (!key.startsWith('_')) dict[key] = value
        }
        cache = dict
        log.debug(`[tts] 観測点の読みを ${Object.keys(dict).length} 件読み込んだ`)
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
 * 読み込み済みの観測点読みキャッシュを返す（未読み込みなら null）。
 * 句区切り辞書と合わせて読み上げへ渡す（→ {@link mergeSpeechDicts}）。
 */
export function getTtsStationReadingsCache(): Record<string, string> | null {
  return cache
}

/**
 * 句区切り辞書と観測点の読みを 1 つの辞書へ合わせる。どちらも無ければ null。
 *
 * **キーが衝突したら句区切り辞書（`base`）を優先する。** あちらは人がアクセント核と句区切りの
 * 位置まで指定したもので、観測点の読みは核の位置を持たない（気象庁のふりがなにアクセント情報が
 * 無いため、末尾へ置いて 1 アクセント句にまとめてある）。読みを聞いて直したくなったときは
 * 句区切り辞書へ足せばよい、という関係にするのがこの向きの意味。
 */
export function mergeSpeechDicts(
  base: Record<string, string> | null,
  stations: Record<string, string> | null,
): Record<string, string> | null {
  if (!base) return stations
  if (!stations) return base
  return { ...stations, ...base }
}
