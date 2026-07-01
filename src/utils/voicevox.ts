import { getAudioContext } from './alertSound'

export type VoicevoxStyle = { name: string; id: number }
export type VoicevoxSpeaker = { name: string; speaker_uuid: string; styles: VoicevoxStyle[] }

// 再生中のソース一覧（パイプライン再生中は複数になる）
let activeSources: AudioBufferSourceNode[] = []
// 現在のセッション ID。新しい読み上げが来たら古いパイプラインを打ち切るために使う
let currentSessionId = 0

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
  console.debug(`[VoiceVox] 読み上げ: ${text}`)

  // 既存の再生を全て停止
  for (const src of activeSources) {
    try { src.stop() } catch { /* already stopped */ }
  }
  activeSources = []

  // セッション ID を更新して古いパイプラインを無効化
  const sessionId = ++currentSessionId

  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') await ctx.resume()

  const gainNode = ctx.createGain()
  gainNode.gain.value = Math.min(1, Math.max(0, volume))
  gainNode.connect(ctx.destination)

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
