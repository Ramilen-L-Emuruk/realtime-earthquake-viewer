import { log } from './logger'

/**
 * 合成済みチャンクの控え。
 *
 * **同じ文字列は何度でも同じ音になる。** 読み上げ文には繰り返し現れるチャンクが多い ——
 * 気象庁が書いた固定付加文（津波の避難行動・長周期地震動階級の目安表）は地震が変われば
 * また読むし、「この地震による津波の心配はありません。」のような定型句は毎回同じ。
 * 控えが無かった頃は、そのたびに `/audio_query` → （辞書の組み直しで `/accent_phrases` ×N
 * → `/mora_data`）→ `/synthesis` の往復と WAV の転送・デコードが丸ごと走っていた
 * （実測 229ms/チャンク・辞書に当たるチャンクはさらに増える）。
 *
 * **切り出し語の作り置き（`voicevox.ts` の `fixedPhrases`）とは別に持つ。** あちらは
 * 「対象が決まっていて起動時に能動的に焼く」もので、追い出されては困る —— 緊急地震速報は
 * 突然来るのに、こちらは録画中の投機で絶えず埋まる。統合すると**いちばん急ぐ音が、
 * 急がない投機に押し出される**。引く順番も作り置きが先（`voicevox.ts` の `nextBufferPromise`）。
 */

/**
 * 控えの上限（バイト数）。
 *
 * **件数とバイト数の両方で置く**（アーカイブ本体の控え `archiveBodyCache` と同じ流儀）。
 * チャンクの長さは 5 文字から 40 文字超まで開きがあり、件数だけで切ると短いチャンクばかりの
 * ときに上限が効かず、長いチャンクばかりのときに早く追い出される。
 *
 * **1 チャンクの実寸は AudioContext のサンプリングレートで決まる。** `decodeAudioData` は
 * コンテキストのレートへリサンプルするので、VOICEVOX が返す 24kHz ではなく 44.1〜48kHz の
 * float32 になる —— 2.8 秒のチャンクで約 538KB（48kHz）。この上限はおよそ 180 チャンク分。
 */
const MAX_BYTES = 96 * 1024 * 1024

/**
 * 控えの上限（件数）。
 *
 * バイト数の上限に先に当たるのが普通だが、短いチャンクばかりが延々と積まれる場合に
 * 走査と `Map` の肥大を抑える。
 */
const MAX_ENTRIES = 400

type Entry = {
  buffer: AudioBuffer
  bytes: number
  /** 最後に読まれた順番（{@link useSeq}）。追い出す相手を選ぶために持つ。 */
  usedAt: number
}

const entries = new Map<string, Entry>()
let totalBytes = 0

/**
 * 使用順の連番。
 *
 * **`Date.now()` を使わない。** 1 回の投機で数十件を続けて焼くと全件が同じミリ秒になり、
 * 読み直した印が効かなくなって**いま使ったものから追い出す**ことが起こる
 * （アーカイブ本体の控えが同じ理由で連番を使っている）。
 */
let useSeq = 0

// 統計。**効いているかは画面にも音にも出ない** —— 当たれば速いだけ、外れれば遅いだけで、
// どちらも「なんとなく」としか感じられない。投機（`speechPrefetch.ts`）が一度も当たって
// いなくても誰も気づけないので、読める形で持つ（`window.__speechCache()`）。
let hits = 0
let misses = 0
let evicted = 0

export type SpeechAudioCacheStats = {
  hits: number
  misses: number
  /** いま持っている件数。 */
  entries: number
  /** いま持っている合計バイト数。 */
  bytes: number
  /** 上限に当たって捨てた延べ件数。 */
  evicted: number
}

/**
 * 控えの鍵。
 *
 * **接続先と話者を含める。** 同じ文字列でも声が違えば別の音になる。境界が曖昧にならないよう
 * JSON にする（素朴な文字列連結だと、URL の末尾とチャンクの切れ目が読み取れない組み合わせを
 * 作れてしまう）。
 *
 * **末尾の間の有無（`hasNextChunk`）も含める。** 後続のチャンクがあるときだけ末尾の句読点に
 * 間を足すので（`voicevox.ts` の `CHUNK_BREAK_PAUSE`）、同じ文字列でも音の長さが違う。
 * 含め忘れると、**どちらが先に控えを埋めたかで末尾の間が変わる**非決定的な不揃いになる。
 */
export function speechChunkKey(
  baseUrl: string, speakerId: number, chunk: string, hasNextChunk: boolean,
): string {
  return JSON.stringify([baseUrl, speakerId, chunk, hasNextChunk])
}

/**
 * 控えに持っているかだけを見る。**統計は動かさない。**
 *
 * 投機（`speechPrefetch`）が「もう持っているものを並べない」ために使う。ここで
 * {@link takeCachedChunk} を呼ぶと**投機自身がヒット数を押し上げ**、「本番の読み上げが
 * 控えから出た回数」を読めなくなる —— 効いているかを測るための数字が、測る行為で濁る。
 */
export function hasCachedChunk(key: string): boolean {
  return entries.has(key)
}

/** 控えから引く。無ければ null。 */
export function takeCachedChunk(key: string): AudioBuffer | null {
  const entry = entries.get(key)
  if (!entry) { misses++; return null }
  entry.usedAt = ++useSeq
  hits++
  return entry.buffer
}

/**
 * 控えへ収める。既にあれば何もしない（同じ鍵なら同じ音なので、焼き直す理由がない）。
 *
 * **バッファの実寸を数えるのは収めるときだけ。** `AudioBuffer` は不変なので、後から
 * 大きさが変わることはない。
 */
export function putCachedChunk(key: string, buffer: AudioBuffer): void {
  if (entries.has(key)) return
  const bytes = bufferBytes(buffer)
  // 1 件で上限を超えるものは持たない（収めた直後に自分を追い出すことになる）
  if (bytes > MAX_BYTES) {
    log.debug('[VoiceVox] 控えに収めるには大きすぎるチャンク', { bytes })
    return
  }
  entries.set(key, { buffer, bytes, usedAt: ++useSeq })
  totalBytes += bytes
  evictIfNeeded()
}

/**
 * 全部捨てる。
 *
 * **いま呼んでいるのは、読み上げ辞書が入れ替わったときだけ**（`voicevox.ts` の
 * `invalidateCacheOnDictChange`）。
 *
 * **接続先・話者が変わったときは呼んでいない。** 鍵にその 2 つを含めてあるので、捨てなくても
 * 誤った声で鳴ることはなく、使われなくなった音は LRU が自然に追い出す。切り替えのたびに
 * 全部捨てると、**行き来したときに焼き直しが要る**ぶんかえって損をする（設定タブで話者を
 * 試す場面がまさにそれ）。作り置き（`fixedPhrases`）がスコープ変更で捨てているのは、
 * あちらが**進行中の合成を抱えている**ため —— もう使わない声の合成が VOICEVOX を占有する
 * のを止める必要がある。控えは焼き上がったものしか持たないので、その事情がない。
 */
export function clearSpeechAudioCache(): void {
  entries.clear()
  totalBytes = 0
}

/** 統計を読む。テストと `window.__speechCache()` から使う。 */
export function speechAudioCacheStats(): SpeechAudioCacheStats {
  return { hits, misses, entries: entries.size, bytes: totalBytes, evicted }
}

/**
 * 追加の統計を差し込む口（投機側が自分の数字を足すために使う）。
 *
 * **控えと投機は別のモジュールだが、読む側から見れば 1 つの仕掛け。** 「投機が何件焼いたか」と
 * 「そのうち何件が当たったか」を別々の窓口から読ませると、片方だけ見て判断することになる。
 */
let extraStats: (() => Record<string, unknown>) | null = null

/** 投機側の統計を登録する。渡した関数は `window.__speechCache()` の結果へ混ぜられる。 */
export function registerSpeechCacheExtraStats(fn: () => Record<string, unknown>): void {
  extraStats = fn
}

/**
 * `window.__speechCache()` を生やす。
 *
 * **控えも投機も、効いているかは画面にも音にも出ない。** 当たれば速い・外れれば遅いだけで、
 * 一度も当たっていなくても症状は「なんとなく遅い」にしかならない。読める形が無いと、
 * 仕掛けが丸ごと死んでいても誰も気づけない（`window.__cameraUpdateSkip` と同じ流儀）。
 */
export function installSpeechCacheProbe(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__speechCache = () => ({
    ...speechAudioCacheStats(),
    ...(extraStats?.() ?? {}),
  })
}

/** テスト用に統計ごと捨てる（本番経路では呼ばない）。 */
export function __resetSpeechAudioCacheForTest(): void {
  clearSpeechAudioCache()
  useSeq = 0
  hits = 0
  misses = 0
  evicted = 0
}

/**
 * `AudioBuffer` が占める実寸。
 *
 * チャンネルごとに `length` サンプルの `Float32Array` を持つので、4 バイト × 長さ × 本数。
 */
function bufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4
}

/** 上限を超えている間、いちばん古く使われたものから捨てる。 */
function evictIfNeeded(): void {
  while (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    let oldestKey: string | null = null
    let oldestUsedAt = Infinity
    for (const [key, entry] of entries) {
      if (entry.usedAt < oldestUsedAt) { oldestUsedAt = entry.usedAt; oldestKey = key }
    }
    // 起こらないはずだが、`Map` が空なら上限を超えようがない。無限ループにはしない。
    if (oldestKey === null) return
    const victim = entries.get(oldestKey)
    entries.delete(oldestKey)
    if (victim) totalBytes -= victim.bytes
    evicted++
  }
}
