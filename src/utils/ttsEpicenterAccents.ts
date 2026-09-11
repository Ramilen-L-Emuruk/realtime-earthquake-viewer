import { createGeneratedDictLoader } from './ttsGeneratedDict'

/**
 * 震央地名の句割り。**音声合成エンジンが 1 アクセント句にまとめてしまう長い名前だけ**を収録して
 * いる（生成は `scripts/build-epicenter-accents.ts`）。
 *
 * エンジンは `宮古島近海` を 1 句にまとめ、核を後部要素の頭へ置く（`ミヤコジマキ／ンカイ`）。
 * 読みは正しいが切れ目が語の途中に来るため、前部要素と後部要素の境界で割る指定を持つ。
 * 誤読はこの辞書の担当ではない（手で書いた句区切り辞書が全件手当てしてある）。
 * 仕組みの全体は [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「震央地名の句割り」。
 */
const loader = createGeneratedDictLoader(
  'tts-epicenter-accents.json',
  'tts-epicenter-accents',
  '震央地名の句割り',
)

/**
 * 震央地名の句割り（AquesTalk 風カナ）を取得する。初回のみ fetch し、以降はキャッシュを返す。
 *
 * この Promise を読み上げ本体が await するため、解決しないまま止まると読み上げ全体が止まる。
 * タイムアウトは必須（`GENERATED_DICT_FETCH_TIMEOUT_MS`）。
 */
export const loadTtsEpicenterAccents = loader.load

/** 読み込み済みの震央地名の句割りキャッシュを返す（未読み込みなら null）。 */
export const getTtsEpicenterAccentsCache = loader.getCache
