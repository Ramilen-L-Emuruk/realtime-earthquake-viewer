import { getAudioContext } from './alertSound'

export type VoicevoxStyle = { name: string; id: number }
export type VoicevoxSpeaker = { name: string; speaker_uuid: string; styles: VoicevoxStyle[] }

let currentSource: AudioBufferSourceNode | null = null

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
 * テキストを VOICEVOX で合成して再生する。
 * 再生中の音声があれば割り込み停止して新しいものを再生する。
 * VOICEVOX 未起動・ネットワーク失敗時は無音で終了する（例外スローなし）。
 */
export async function speakWithVoicevox(
  baseUrl: string,
  text: string,
  speakerId: number,
  volume: number,
): Promise<void> {
  try {
    if (currentSource) {
      try { currentSource.stop() } catch { /* already stopped */ }
      currentSource = null
    }

    const queryRes = await fetch(
      `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: 'POST' },
    )
    if (!queryRes.ok) return

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
    if (!synthRes.ok) return

    const wav = await synthRes.arrayBuffer()

    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') await ctx.resume()

    const audioBuffer = await ctx.decodeAudioData(wav)
    const gainNode = ctx.createGain()
    gainNode.gain.value = Math.min(1, Math.max(0, volume))
    gainNode.connect(ctx.destination)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(gainNode)
    source.onended = () => {
      if (currentSource === source) currentSource = null
    }
    currentSource = source
    source.start()
  } catch {
    // VOICEVOX 未起動・その他エラーはすべて無視
  }
}
