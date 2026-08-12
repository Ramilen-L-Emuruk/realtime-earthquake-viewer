import { getAudioContext, getMasterInput } from './alertSound'
import { findPhraseBreakMatch, getTtsPhraseBreakDictCache, isPlaceNameKey, loadTtsPhraseBreakDict } from './ttsPhraseBreakDict'
import { log } from './logger'

export type VoicevoxStyle = { name: string; id: number }
export type VoicevoxSpeaker = { name: string; speaker_uuid: string; styles: VoicevoxStyle[] }

// VOICEVOX の AccentPhrase（構造の詳細には立ち入らず、そのまま受け渡すだけなので unknown 値の記録として扱う）
type AccentPhrase = Record<string, unknown>

// 再生中のソース一覧（パイプライン再生中は複数になる）
let activeSources: AudioBufferSourceNode[] = []
// 現在のセッション ID。新しい読み上げが来たら古いパイプラインを打ち切るために使う
let currentSessionId = 0

// 句区切り辞書エントリの accent_phrases 取得結果キャッシュ（"speakerId:キー" -> AccentPhrase[]）。
// 同じ地名・同じ話者の組み合わせで毎回 /accent_phrases を叩き直さないようにする。
const phraseBreakCache = new Map<string, AccentPhrase[]>()

// 辞書該当「地名」の直後に挿入する短いポーズ（VOICEVOX が読点「、」に対して付与する pause_mora を参考にした値）。
// 該当語は前後を独立に取得して結合するため continuation の抑揚が不連続になりがちだが、
// 直後にポーズを挟むことで「区切って言い直した」ような自然な間として聞こえ、不連続感を目立たなくする。
// 「深発地震」「遠地地震」等の一般用語（isPlaceNameKey が false を返すもの）は文中に自然に溶け込む語なので対象外。
const DICT_TRAILING_PAUSE = {
  text: '、',
  consonant: null,
  consonant_length: null,
  vowel: 'pau',
  vowel_length: 0.12,
  pitch: 0,
}

/** フレーズ配列の最後の要素に辞書語用の短いポーズを付与したコピーを返す（キャッシュされた元配列は変更しない）。 */
function withTrailingPause(phrases: AccentPhrase[]): AccentPhrase[] {
  if (phrases.length === 0) return phrases
  const last = { ...phrases[phrases.length - 1], pause_mora: DICT_TRAILING_PAUSE }
  return [...phrases.slice(0, -1), last]
}

/** VOICEVOX が起動中かどうかを確認する（2秒タイムアウト）。 */
export async function checkVoicevoxAvailable(baseUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(`${baseUrl}/version`, { signal: ctrl.signal })
    clearTimeout(tid)
    return res.ok
  } catch {
    return false
  }
}

/** 利用可能な話者一覧を取得する。失敗時は空配列を返す。 */
export async function fetchVoicevoxSpeakers(baseUrl: string): Promise<VoicevoxSpeaker[]> {
  try {
    const res = await fetch(`${baseUrl}/speakers`)
    if (!res.ok) return []
    return res.json() as Promise<VoicevoxSpeaker[]>
  } catch {
    return []
  }
}

/**
 * テキストを句読点で分割してチャンクのリストを返す。
 * 短すぎるチャンクは次と結合して自然さを保つ。
 */
function splitIntoChunks(text: string): string[] {
  // 句点・読点・感嘆符・疑問符の後ろで分割
  const raw = text.split(/(?<=[。、！？])/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  // 5文字未満のチャンクは次のチャンクと結合（単独合成するには短すぎる）
  const MIN_CHUNK = 5
  const merged: string[] = []
  for (const chunk of raw) {
    if (merged.length > 0 && merged[merged.length - 1].length < MIN_CHUNK) {
      merged[merged.length - 1] += chunk
    } else {
      merged.push(chunk)
    }
  }
  return merged.length > 0 ? merged : [text]
}

/** 通常テキストを /audio_query に渡し、accent_phrases 部分だけを取り出す。失敗時は null。 */
async function fetchAccentPhrasesForText(
  baseUrl: string,
  text: string,
  speakerId: number,
): Promise<AccentPhrase[] | null> {
  const res = await fetch(
    `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
    { method: 'POST' },
  )
  if (!res.ok) return null
  const query = await res.json() as { accent_phrases: AccentPhrase[] }
  return query.accent_phrases
}

/**
 * 句区切り辞書エントリ（AquesTalk風カナ表記）を /accent_phrases(is_kana=true) にかけて
 * 句区切り・アクセント位置を指定通りに確定した accent_phrases を取得する。
 * 同じ話者・同じキーの結果はキャッシュして再利用する。失敗時は null。
 */
async function fetchAccentPhrasesForKey(
  baseUrl: string,
  key: string,
  kanaReading: string,
  speakerId: number,
): Promise<AccentPhrase[] | null> {
  const cacheKey = `${speakerId}:${key}`
  const cached = phraseBreakCache.get(cacheKey)
  if (cached) return cached

  const res = await fetch(
    `${baseUrl}/accent_phrases?text=${encodeURIComponent(kanaReading)}&speaker=${speakerId}&is_kana=true`,
    { method: 'POST' },
  )
  if (!res.ok) return null
  const phrases = await res.json() as AccentPhrase[]
  phraseBreakCache.set(cacheKey, phrases)
  return phrases
}

/**
 * テキストを accent_phrases の配列に変換する。句区切り辞書のキーを含む場合は、
 * その部分だけ /accent_phrases(is_kana=true) で処理し、前後の通常テキストと結合する
 * （キーを含まない後続部分にさらに別のキーが含まれる場合は再帰的に処理する）。
 * 前後を独立に取得するため継ぎ目の抑揚は不連続になり得るが、該当語の直後に短いポーズ
 * （DICT_TRAILING_PAUSE）を挟むことで区切りとして自然に聞こえるようにしている。
 * 失敗時は null。
 */
async function buildAccentPhrases(
  baseUrl: string,
  text: string,
  speakerId: number,
  phraseBreakDict: Record<string, string>,
): Promise<AccentPhrase[] | null> {
  if (text === '') return []

  const match = findPhraseBreakMatch(text, phraseBreakDict)
  if (!match) return fetchAccentPhrasesForText(baseUrl, text, speakerId)

  const pre = text.slice(0, match.index)
  const post = text.slice(match.index + match.key.length)

  const [prePhrases, matchedPhrasesRaw, postPhrases] = await Promise.all([
    buildAccentPhrases(baseUrl, pre, speakerId, phraseBreakDict),
    fetchAccentPhrasesForKey(baseUrl, match.key, phraseBreakDict[match.key], speakerId),
    buildAccentPhrases(baseUrl, post, speakerId, phraseBreakDict),
  ])
  if (!prePhrases || !matchedPhrasesRaw || !postPhrases) return null

  const matchedPhrases = isPlaceNameKey(match.key) ? withTrailingPause(matchedPhrasesRaw) : matchedPhrasesRaw

  return [...prePhrases, ...matchedPhrases, ...postPhrases]
}

/** 1チャンクを audio_query → synthesis して AudioBuffer を返す。失敗時は null。 */
async function synthesizeChunk(
  baseUrl: string,
  chunk: string,
  speakerId: number,
  ctx: AudioContext,
): Promise<AudioBuffer | null> {
  try {
    const queryRes = await fetch(
      `${baseUrl}/audio_query?text=${encodeURIComponent(chunk)}&speaker=${speakerId}`,
      { method: 'POST' },
    )
    if (!queryRes.ok) return null

    const query = await queryRes.json() as Record<string, unknown>

    // 句区切り辞書にマッチする地名を含む場合は、accent_phrases を句区切り指定通りに組み直す
    const phraseBreakDict = getTtsPhraseBreakDictCache()
    if (phraseBreakDict && findPhraseBreakMatch(chunk, phraseBreakDict)) {
      const phrases = await buildAccentPhrases(baseUrl, chunk, speakerId, phraseBreakDict)
      if (phrases) query.accent_phrases = phrases
    }

    query.speedScale = 1.2

    const synthRes = await fetch(
      `${baseUrl}/synthesis?speaker=${speakerId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      },
    )
    if (!synthRes.ok) return null

    const wav = await synthRes.arrayBuffer()
    return await ctx.decodeAudioData(wav)
  } catch {
    return null
  }
}

/**
 * テキストを VOICEVOX で合成して再生する（パイプライン方式）。
 * テキストを句読点で分割し、最初のチャンクが合成できた時点で再生を開始する。
 * 再生中の音声があれば割り込み停止して新しいものを再生する。
 * VOICEVOX 未起動・ネットワーク失敗時は無音で終了する（例外スローなし）。
 */
export async function speakWithVoicevox(
  baseUrl: string,
  text: string,
  speakerId: number,
  volume: number,
): Promise<void> {
  // 辞書が未ロードなら待つ（キャッシュ済みなら即時解決）
  await loadTtsPhraseBreakDict().catch(() => {})
  log.debug(`[VoiceVox] 読み上げ: ${text}`, { speakerId, volume })

  // 既存の再生を全て停止
  for (const src of activeSources) {
    try { src.stop() } catch { /* already stopped */ }
  }
  activeSources = []

  // セッション ID を更新して古いパイプラインを無効化
  const sessionId = ++currentSessionId

  const ctx = getAudioContext()
  if (!ctx) {
    log.debug('[VoiceVox] スキップ (AudioContext なし)')
    return
  }
  if (ctx.state === 'suspended') await ctx.resume()

  const gainNode = ctx.createGain()
  gainNode.gain.value = Math.min(1, Math.max(0, volume))
  // TTS も alertSound と同じマスターチェーン（Gain → DynamicsCompressor → destination）を
  // 経由させる。TTS 継続中に次の警報音が加算されても合成音圧の暴走を compressor で抑える
  // （CRIT-3 対応の一部）。
  gainNode.connect(getMasterInput(ctx))

  const chunks = splitIntoChunks(text)

  // 次チャンクを先行合成するためのキュー
  let nextBufferPromise: Promise<AudioBuffer | null> = synthesizeChunk(baseUrl, chunks[0], speakerId, ctx)

  // 次のチャンクを再生開始する予定時刻（AudioContext の時間軸）
  let scheduleAt = -1

  // 全チャンクの再生完了を待つための Promise（呼び出し元が await できる）
  let completionResolve!: () => void
  const completionPromise = new Promise<void>(r => { completionResolve = r })
  let lastSource: AudioBufferSourceNode | null = null

  for (let i = 0; i < chunks.length; i++) {
    if (currentSessionId !== sessionId) { completionResolve(); return }  // 割り込みされた

    const buffer = await nextBufferPromise
    if (currentSessionId !== sessionId) { completionResolve(); return }  // await 中に割り込み

    // 次チャンクの合成を先行開始（現在のチャンクの再生と並行）
    if (i + 1 < chunks.length) {
      nextBufferPromise = synthesizeChunk(baseUrl, chunks[i + 1], speakerId, ctx)
    }

    if (!buffer) continue  // 合成失敗したチャンクはスキップ

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gainNode)
    source.onended = () => {
      activeSources = activeSources.filter(s => s !== source)
    }
    activeSources.push(source)
    lastSource = source

    if (scheduleAt < 0) {
      // 最初のチャンク: 即時再生
      scheduleAt = ctx.currentTime
    }
    // scheduleAt が過去になっている場合（合成が再生より遅れた）は現時刻にフォールバック
    if (scheduleAt < ctx.currentTime) scheduleAt = ctx.currentTime

    source.start(scheduleAt)
    scheduleAt += buffer.duration
  }

  // 最後のチャンクの再生終了で resolve（合成失敗等でソースが0個なら即時 resolve）
  if (lastSource) {
    lastSource.addEventListener('ended', () => completionResolve())
  } else {
    completionResolve()
  }
  await completionPromise
}
