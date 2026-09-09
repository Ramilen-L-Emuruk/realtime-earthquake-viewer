import { createGeneratedDictLoader } from './ttsGeneratedDict'

/**
 * 震度観測点名の読み。**音声合成エンジンが誤読する観測点だけ**を収録している
 * （生成は `scripts/build-station-readings.ts`）。
 *
 * 正しく読める点を入れないのは、カナ経由にするとアクセントと句切れがエンジンの推定に委ねられ、
 * かえって崩れるため。仕組みの全体は
 * [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「震度観測点名の読み」。
 */
const loader = createGeneratedDictLoader(
  'tts-station-readings.json',
  'tts-station-readings',
  '観測点の読み',
)

/**
 * 震度観測点名の読み（AquesTalk 風カナ）を取得する。初回のみ fetch し、以降はキャッシュを返す。
 *
 * この Promise を読み上げ本体が await するため、解決しないまま止まると読み上げ全体が止まる。
 * タイムアウトは必須（`GENERATED_DICT_FETCH_TIMEOUT_MS`）。
 */
export const loadTtsStationReadings = loader.load

/** 読み込み済みの観測点読みキャッシュを返す（未読み込みなら null）。 */
export const getTtsStationReadingsCache = loader.getCache
