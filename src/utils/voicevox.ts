import { getAudioContext, getMasterInput } from './alertSound'
import { findPhraseBreakMatch, getTtsPhraseBreakDictCache, isPlaceNameKey, loadTtsPhraseBreakDict } from './ttsPhraseBreakDict'
import { log, createLogThrottle } from './logger'

export type VoicevoxStyle = { name: string; id: number }
export type VoicevoxSpeaker = { name: string; speaker_uuid: string; styles: VoicevoxStyle[] }

// VOICEVOX の AccentPhrase（構造の詳細には立ち入らず、そのまま受け渡すだけなので unknown 値の記録として扱う）
type AccentPhrase = Record<string, unknown>

// 再生中のソース一覧（パイプライン再生中は複数になる）
let activeSources: AudioBufferSourceNode[] = []
// 現在のセッション ID。新しい読み上げが来たら古いパイプラインを打ち切るために使う
let currentSessionId = 0
// 現在のセッションで進行中の fetch を一括中断するための AbortController（AUD-4）。
// sessionId のインクリメントだけでは in-flight の /audio_query・/synthesis リクエストは
// 完走してしまい、VOICEVOX 側の直列処理を占有して新規発話が待たされる。新セッション開始時に
// abort() することで旧セッションのリクエストを即座に打ち切る。
let currentAbortController: AbortController | null = null

// 1 チャンクも合成できなかったときの警告の間引き。VOICEVOX が落ちていると読み上げのたびに
// 起こるため、素通しにするとログが埋まって他の異常が見えなくなる。
const warnNoAudio = createLogThrottle(30000)

// チャンク末尾の間を付けられなかったときの記録の間引き。応答形式が変わっていれば読み上げの
// たびに全チャンクで起こるため、素通しにするとログが埋まる。
const warnNoChunkBreak = createLogThrottle(30000)

// 句区切り辞書エントリの accent_phrases 取得結果キャッシュ（"speakerId:キー" -> AccentPhrase[]）。
// 同じ地名・同じ話者の組み合わせで毎回 /accent_phrases を叩き直さないようにする。
const phraseBreakCache = new Map<string, AccentPhrase[]>()

/**
 * アクセント句の後ろに置く無音（`pause_mora`）を作る。
 * 長さは合成時に `speedScale` で割られるため、**実際に聞こえる秒数は値 ÷ 1.2**（→ 話速の節）。
 */
function pauseMora(vowelLength: number): AccentPhrase {
  return {
    text: '、',
    consonant: null,
    consonant_length: null,
    vowel: 'pau',
    vowel_length: vowelLength,
    pitch: 0,
  }
}

// 辞書該当「地名」の直後に挿入する短いポーズ。
// 抑揚の不連続そのものは {@link refineProsody} が引き直して解消するが、地名の切れ目には短い間があった方が
// 「区切って言い直した」ように聞こえて自然なため残している。
// 「深発地震」「遠地地震」等の一般用語（isPlaceNameKey が false を返すもの）は文中に自然に溶け込む語なので対象外。
const DICT_TRAILING_PAUSE = pauseMora(0.12)

/**
 * チャンク末尾の句読点に与える無音。
 *
 * {@link splitIntoChunks} は句読点の**後ろ**で割るため、句読点は必ずチャンクの末尾に来る。
 * この位置の句読点に `/audio_query` は `pause_mora` を付けない（後ろに何も続かないため。
 * 実測: 話者 0・2・3 のいずれでも最後のアクセント句は `null`。読点だけの `"、"` は
 * `accent_phrases` が空配列で返る）。そしてチャンクは隙間なく詰めて鳴らすので
 * （{@link speakWithVoicevox} の `scheduleAt += buffer.duration`）、補わないと句読点が音にならない。
 *
 * 値はチャンク境界に元からある無音（`prePhonemeLength` + `postPhonemeLength` = 0.1 + 0.1）を
 * 差し引いて、文中の読点と同じ間になるよう決めた。実測（speedScale 1.2 適用後）:
 * 境界の既存無音 0.18 秒／文中の読点 0.27 秒／差 0.09 秒 → speedScale を掛け戻した 0.107 を 0.11 に丸めた。
 * {@link DICT_TRAILING_PAUSE} と近い値になるのは偶然で、あちらは「無音の全量」、こちらは
 * 「既にある無音への足し分」を表す別の量。
 *
 * 句点と読点で値を変えていないのは、VOICEVOX 自身が文中でどちらにもほぼ同じ長さを与えるため
 * （実測: 読点 0.30〜0.38・句点 0.32）。
 */
const CHUNK_BREAK_PAUSE = pauseMora(0.11)

/**
 * フレーズ配列の最後の要素に指定の無音を付与したコピーを返す（キャッシュされた元配列は変更しない）。
 * 既に `pause_mora` が入っていても置き換える（足さない）。辞書地名がチャンク末尾に来た場合に
 * 辞書側の間と句読点の間が二重にならないようにするため。
 */
function withTrailingPause(phrases: AccentPhrase[], pause: AccentPhrase): AccentPhrase[] {
  if (phrases.length === 0) return phrases
  const last = { ...phrases[phrases.length - 1], pause_mora: pause }
  return [...phrases.slice(0, -1), last]
}

/**
 * 結合した accent_phrases の音素長と音高を、繋ぎ目を含めた文脈で再推定する（POST /mora_data）。
 *
 * {@link buildAccentPhrases} は辞書キーの前後を「独立した 1 文」として /audio_query にかけるため、
 * 前半の末尾が文末と解釈され、母音が伸びたうえ音高も下がりきってしまう。「震度5弱を」＋
 * 「宮崎県北部平野部」のように助詞で切れる場合、その助詞が間延びして聞こえたり、言い切ってから
 * 地名を言い直したように聞こえるのはこれが原因。結合後にこのエンドポイントへ通すと、
 * 全体の文脈で長さと音高が引き直され、通しで合成した場合とほぼ同じ値になる。
 *
 * 実測（四国めたん・ツンツン。「震度5弱を宮崎県北部平野部…」の「を」の母音長と音高）:
 * 単独取得 0.164 秒 / 212 Hz、通し取得 0.099 秒 / 271 Hz、このエンドポイントを通すと
 * 0.099 秒 / 267 Hz。通し取得にほぼ一致する。
 *
 * 音高はアクセント句の `accent`（アクセント核の位置）から引き直されるため、辞書がカナ表記で
 * 指定した読みとアクセント核は保たれる。失敗時は null を返し、呼び出し側は再推定前の
 * accent_phrases をそのまま使う（繋ぎ目が不自然なままになるだけで読み上げ自体は成立する）。
 */
async function refineProsody(
  baseUrl: string,
  phrases: AccentPhrase[],
  speakerId: number,
  signal?: AbortSignal,
): Promise<AccentPhrase[] | null> {
  if (phrases.length === 0) return phrases
  try {
    const res = await fetch(
      `${apiBase(baseUrl)}/mora_data?speaker=${speakerId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(phrases),
        signal,
      },
    )
    if (!res.ok) {
      log.debug('[VoiceVox] mora_data が非 200 応答（繋ぎ目の補正なしで続行）', res.status)
      return null
    }
    const refined = await res.json() as AccentPhrase[]
    // 句数が変わるはずはないが、変わっていれば pause_mora の対応が取れないため捨てる
    if (refined.length !== phrases.length) {
      log.debug('[VoiceVox] mora_data の句数が不一致（繋ぎ目の補正なしで続行）', {
        expected: phrases.length, actual: refined.length,
      })
      return null
    }
    // pause_mora は辞書由来・読点由来を問わずまとめて元の値へ戻す。再推定に任せると
    // DICT_TRAILING_PAUSE の短い間（0.12 秒）が読点相当まで伸ばされ、意図した長さでなくなる
    // （実測: 辞書語が文中なら 0.349 秒、チャンク末尾なら 0.968 秒）。
    return refined.map((ap, i) => ({ ...ap, pause_mora: phrases[i].pause_mora }))
  } catch (err) {
    // abort は割り込みの正常系。後続の /synthesis も同じ signal で中断されてチャンクごと
    // 破棄されるため、再推定前のものに戻して進んでも影響はなく、記録もしない。
    // それ以外（接続断・エンドポイント不在・応答形式の異常）は残す。ここが黙って失敗すると
    // 補正前と同じ「助詞が間延びして繋ぎ目が途切れた読み上げ」に戻るだけなので、記録が無いと
    // 「直っていない」という報告から原因を切り分けられない。
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      log.debug('[VoiceVox] mora_data の再推定に失敗（繋ぎ目の補正なしで続行）', err)
    }
    return null
  }
}

/**
 * 末尾のスラッシュを落とした基準 URL を返す。
 *
 * 入力欄には `http://localhost:50021/` のように末尾スラッシュ付きの値が入りうる
 * （ブラウザのアドレス欄からの貼り付けで普通に起こる）。そのまま連結すると
 * `http://localhost:50021//version` の二重スラッシュになり、VOICEVOX は 404 を返す。URL としては
 * 正しいので {@link isValidVoicevoxUrl} は通り、接続状態だけが「起動していません」に
 * なって**起動しているのに繋がらない**という誤診になる。連結する側で吸収する。
 */
function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * 接続確認に使える形の URL かを判定する。
 *
 * 見るのは「HTTP で叩ける URL として成立しているか」だけ。解析できることと、スキームが
 * http/https であること。ホスト名の中身には踏み込まない（LAN のホスト名・IPv4・IPv6 の
 * いずれも来る）。**ホスト名の有無を別途見る必要はない。** http/https は URL 標準の
 * 特殊スキームで、ホストを伴わない `http://` は解析の時点で例外になる。
 * スキームを書き忘れた `192.168.0.64:50021` も同様（数字はスキームの先頭に置けない）。
 *
 * **入力途中の値をここで弾き切ることは期待できない。** `http://1` も `http://192.`
 * も URL としては正常に解析でき（後者は末尾の空ラベルが落ちて `0.0.0.192` になる）、
 * ブラウザは実際に接続を試みる。入力途中のリクエストを止めるのは呼び出し側の
 * デバウンスの役目。ここが担うのは、スキームの書き忘れのような直らない誤りを
 * 「起動していません」と誤診しないこと。
 *
 * @param baseUrl 設定タブに入力された値
 * @returns http/https の URL として解析できるなら true
 */
export function isValidVoicevoxUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    // URL として解析できない（スキームが無い・ホストが無い・空欄 等）。
    return false
  }
}

/** VOICEVOX が起動中かどうかを確認する（2秒タイムアウト）。 */
export async function checkVoicevoxAvailable(baseUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(`${apiBase(baseUrl)}/version`, { signal: ctrl.signal })
    clearTimeout(tid)
    return res.ok
  } catch {
    return false
  }
}

/** 利用可能な話者一覧を取得する。失敗時は空配列を返す。 */
export async function fetchVoicevoxSpeakers(baseUrl: string): Promise<VoicevoxSpeaker[]> {
  try {
    const res = await fetch(`${apiBase(baseUrl)}/speakers`)
    if (!res.ok) return []
    return res.json() as Promise<VoicevoxSpeaker[]>
  } catch {
    return []
  }
}

// チャンクの区切りに使う句読点。**分割位置の判定（{@link splitIntoChunks}）と、チャンク末尾に
// 間を持たせる判定（{@link CHUNK_BREAK_PAUSE}）で同じ集合を使うこと。** 片方だけ増やすと、
// 増やした文字で割れたのに間が入らないチャンクができる。
const CHUNK_BREAK_PUNCTUATION = '。、！？'
const CHUNK_SPLIT_RE = new RegExp(`(?<=[${CHUNK_BREAK_PUNCTUATION}])`)
const CHUNK_TAIL_RE = new RegExp(`[${CHUNK_BREAK_PUNCTUATION}]$`)

/**
 * テキストを句読点で分割してチャンクのリストを返す。
 * 短すぎるチャンクは次と結合して自然さを保つ。
 *
 * export しているのはテストのため。読み上げの偽物を作る側が同じ分割を手書きすると、
 * ここの条件を変えたときにテストだけが古い境界を前提に通り続ける。
 */
export function splitIntoChunks(text: string): string[] {
  // 句点・読点・感嘆符・疑問符の後ろで分割
  const raw = text.split(CHUNK_SPLIT_RE)
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
  signal?: AbortSignal,
): Promise<AccentPhrase[] | null> {
  const res = await fetch(
    `${apiBase(baseUrl)}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
    { method: 'POST', signal },
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
  signal?: AbortSignal,
): Promise<AccentPhrase[] | null> {
  const cacheKey = `${speakerId}:${key}`
  const cached = phraseBreakCache.get(cacheKey)
  if (cached) return cached

  const res = await fetch(
    `${apiBase(baseUrl)}/accent_phrases?text=${encodeURIComponent(kanaReading)}&speaker=${speakerId}&is_kana=true`,
    { method: 'POST', signal },
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
 * 該当語の直後には短いポーズ（DICT_TRAILING_PAUSE）を挟み、区切りとして自然に聞こえるようにする。
 * **この関数が返す時点では、繋ぎ目の音素長と音高はまだ独立取得のまま**（前半の末尾が文末扱いで
 * 伸び、音高も下がりきっている）。呼び出し側が {@link refineProsody} で引き直すこと。
 * 失敗時は null。
 */
async function buildAccentPhrases(
  baseUrl: string,
  text: string,
  speakerId: number,
  phraseBreakDict: Record<string, string>,
  signal?: AbortSignal,
): Promise<AccentPhrase[] | null> {
  if (text === '') return []

  const match = findPhraseBreakMatch(text, phraseBreakDict)
  if (!match) return fetchAccentPhrasesForText(baseUrl, text, speakerId, signal)

  const pre = text.slice(0, match.index)
  const post = text.slice(match.index + match.key.length)

  const [prePhrases, matchedPhrasesRaw, postPhrases] = await Promise.all([
    buildAccentPhrases(baseUrl, pre, speakerId, phraseBreakDict, signal),
    fetchAccentPhrasesForKey(baseUrl, match.key, phraseBreakDict[match.key], speakerId, signal),
    buildAccentPhrases(baseUrl, post, speakerId, phraseBreakDict, signal),
  ])
  if (!prePhrases || !matchedPhrasesRaw || !postPhrases) return null

  const matchedPhrases = isPlaceNameKey(match.key)
    ? withTrailingPause(matchedPhrasesRaw, DICT_TRAILING_PAUSE)
    : matchedPhrasesRaw

  return [...prePhrases, ...matchedPhrases, ...postPhrases]
}

/**
 * 1チャンクを audio_query → synthesis して AudioBuffer を返す。失敗時は null。
 *
 * @param hasNextChunk 後続のチャンクがあるか。真のとき、末尾の句読点に間を持たせる
 *   （{@link CHUNK_BREAK_PAUSE}）。**最後のチャンクには渡さないこと。** 読み終わりに無音が伸び、
 *   再生完了を待っている次の読み上げがその分遅れる。
 */
async function synthesizeChunk(
  baseUrl: string,
  chunk: string,
  speakerId: number,
  ctx: AudioContext,
  signal?: AbortSignal,
  hasNextChunk = false,
): Promise<AudioBuffer | null> {
  try {
    const queryRes = await fetch(
      `${apiBase(baseUrl)}/audio_query?text=${encodeURIComponent(chunk)}&speaker=${speakerId}`,
      { method: 'POST', signal },
    )
    if (!queryRes.ok) return null

    const query = await queryRes.json() as Record<string, unknown>

    // 句区切り辞書にマッチする地名を含む場合は、accent_phrases を句区切り指定通りに組み直す
    const phraseBreakDict = getTtsPhraseBreakDictCache()
    if (phraseBreakDict && findPhraseBreakMatch(chunk, phraseBreakDict)) {
      const phrases = await buildAccentPhrases(baseUrl, chunk, speakerId, phraseBreakDict, signal)
      // 結合したままだと繋ぎ目の直前（多くは助詞）が文末扱いになるため、長さと音高を引き直す。
      // signal は下の /synthesis と必ず共有すること。共有していれば、割り込みで中断された場合に
      // 補正前の accent_phrases がそのまま合成まで進むことがない（refineProsody の catch 参照）。
      if (phrases) query.accent_phrases = await refineProsody(baseUrl, phrases, speakerId, signal) ?? phrases
    }

    // チャンク末尾の句読点は /audio_query では音にならないため、ここで間を持たせる（理由は
    // CHUNK_BREAK_PAUSE）。**辞書の組み直しと引き直しの後に置くこと。** refineProsody は
    // pause_mora を引き直し前の値へ戻すので、先に付けても消えはしないが、辞書地名が末尾に
    // 来たときにどちらの間が残るかが読み取りづらくなる。
    if (hasNextChunk && CHUNK_TAIL_RE.test(chunk)) {
      const phrases = query.accent_phrases
      if (Array.isArray(phrases)) {
        query.accent_phrases = withTrailingPause(phrases as AccentPhrase[], CHUNK_BREAK_PAUSE)
      } else {
        // 応答形式が想定と違う。**音は鳴るので気づけない**が、句読点の間が入らないまま合成が
        // 続き、地名を読点で並べても一続きに聞こえる状態（この処理を入れた理由そのもの）へ
        // 静かに戻る。全チャンク失敗の警告（warnNoAudio）にも引っかからないため、ここで残す。
        warnNoChunkBreak(() => log.debug(
          '[VoiceVox] accent_phrases が配列でないため句読点の間を付けられない', { chunk },
        ))
      }
    }

    query.speedScale = 1.2

    const synthRes = await fetch(
      `${apiBase(baseUrl)}/synthesis?speaker=${speakerId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        signal,
      },
    )
    if (!synthRes.ok) return null

    const wav = await synthRes.arrayBuffer()
    return await ctx.decodeAudioData(wav)
  } catch {
    // abort による例外もここに落ちる。null で返して呼び出し元に「合成失敗」として扱わせる。
    return null
  }
}

/** 先に合成しておいた読み上げの持ち手（{@link prewarmVoicevox} が返す）。 */
export type PrewarmedSpeech = {
  /** 合成したテキスト。取り違え防止に、再生時に照合する */
  readonly text: string
  /** 最初のチャンクの音声（合成できなければ null） */
  readonly first: Promise<AudioBuffer | null>
  /** 合成を打ち切る（使わないと決まったとき） */
  readonly abort: () => void
}

// 進行中の先行合成。新しい読み上げが始まるとき、使われないものを打ち切るために持つ。
const activePrewarms = new Set<PrewarmedSpeech>()

/**
 * 最初のチャンクだけを先に合成しておく（**再生はしない**）。
 *
 * 通知音と声が重ならないよう電文ごとに間を置いているので（`TTS_DELAY_MS`。0.5〜4.2 秒）、
 * その間に合成を済ませておけば、間が明けた瞬間に鳴らせる。合成は LAN 越しの VOICEVOX で
 * 150〜350ms かかり、そのぶん「音が鳴り終わってから声が出るまで」の空白になっていた。
 *
 * **セッションには関与しない。** 進行中の再生を止めず、`currentSessionId` も動かさない
 * （動かすと、間を置いている最中に前の読み上げが切れてしまう）。実際に鳴らすときは、
 * 結果を {@link speakWithVoicevox} に渡すこと。渡さなければ捨てられる。
 *
 * @returns AudioContext が未確立（ユーザー操作前）なら null。その場合は先行合成なしで進む
 */
export function prewarmVoicevox(baseUrl: string, text: string, speakerId: number): PrewarmedSpeech | null {
  const ctx = getAudioContext()
  if (!ctx) return null
  const chunks = splitIntoChunks(text)
  if (chunks.length === 0) return null

  const ctrl = new AbortController()
  const first = (async () => {
    // 辞書は句区切りにしか使わないので、取れなくても合成は続ける（本再生と同じ扱い）
    await loadTtsPhraseBreakDict().catch(() => { /* 区切りなしで合成する */ })
    return synthesizeChunk(baseUrl, chunks[0], speakerId, ctx, ctrl.signal, chunks.length > 1)
  })()
  const entry: PrewarmedSpeech = {
    text,
    first,
    abort: () => { try { ctrl.abort() } catch { /* 二重 abort は無視 */ } },
  }
  activePrewarms.add(entry)
  // 完了・失敗どちらでも登録を外す（打ち切り対象の集合に死んだ持ち手を残さない）
  void first.catch(() => null).finally(() => activePrewarms.delete(entry))
  log.debug(`[VoiceVox] 先行合成: ${chunks[0]}`)
  return entry
}

// ─── 切り出し語の作り置き ────────────────────────────────────────

/**
 * 作り置きの 1 件。
 *
 * **`buffer` は「もう手元にあるか」だけを表し、待ち合わせには使わない。** 合成中は null の
 * ままで、その間に読み上げが来たら普通に合成する（下記「待たない」を参照）。
 *
 * 保持するのは `AudioBuffer`。`getAudioContext()` は 1 つの AudioContext を使い回すので、
 * 一度デコードしたものを何度でも別の `AudioBufferSourceNode` に繋げる（AudioBuffer は不変）。
 */
type FixedPhrase = {
  /** 合成済みの音声。まだなら null */
  buffer: AudioBuffer | null
  /** 進行中の合成を打ち切る（作り直すとき・接続先が変わったとき） */
  abort: () => void
}

/** 合成済みの切り出し語。キーは句そのもの。 */
const fixedPhrases = new Map<string, FixedPhrase>()

/**
 * 作り置きの合成を諦めるまでの時間。
 *
 * **VOICEVOX への合成要求にはタイムアウトが無く、応答が返らないまま止まることがある**
 * （LAN 越しの機器がスリープに入る・経路が黙って捨てる等）。他の経路はいずれも中断手段を
 * 持っている——先行合成は次の読み上げの冒頭で `abort()` され、通常のチャンクは
 * `currentAbortController` で打ち切られる。作り置きだけが中断されないまま残ると、
 * 使われないリクエストが VOICEVOX の直列処理を占有し続ける。
 *
 * 合成の実測は 238〜697ms。作り置きは急ぐものではないので、正常な遅延を切らない幅を取る。
 */
const FIXED_PHRASE_SYNTH_TIMEOUT_MS = 10000

// 作り置きの合成が失敗したときの記録の間引き。VOICEVOX 未起動・話者 ID 誤りなどでは
// 設定を触るたびに全件失敗しうるため、素通しにするとログが埋まる。
const warnFixedPhraseFailed = createLogThrottle(30000)

/** 作り置きが通用する合成条件（接続先と話者）。変わったら作り直す。 */
let fixedPhraseScope = ''

/** 作り置きの対象として登録された句。手元に無かったときに埋め直す判断へ使う。 */
let fixedPhraseTargets: readonly string[] = []

// 接続先と話者の組。境界が曖昧にならないよう JSON にする
// （素朴な文字列連結だと、URL の末尾と話者 ID の切れ目が読み取れない組み合わせが作れる）。
const phraseScopeOf = (baseUrl: string, speakerId: number) => JSON.stringify([baseUrl, speakerId])

/**
 * 内容に依存しない切り出し語をあらかじめ合成しておく（**再生はしない**）。
 *
 * {@link prewarmVoicevox} と目的は同じだが、当てにするものが違う。あちらは「通知音との間を
 * 合成に充てる」ので**間がある経路にしか使えない**。緊急地震速報は間を置かずに読み始めるため
 * その手が使えず、合成の往復がそのまま声の出遅れになっていた（実測 238〜697ms）。
 * 切り出し語は震源名にも予想震度にも依存しない数通りの固定句なので、先に作っておける。
 *
 * **セッションには関与しない。** 進行中の再生を止めず、`currentSessionId` も動かさない。
 *
 * @param phrases 作り置きする句。`splitIntoChunks` が単独のチャンクとして切り出せる形
 *   （句読点で終わり、5 文字以上）でなければ照合されない
 */
export function warmFixedPhrases(baseUrl: string, speakerId: number, phrases: readonly string[]): void {
  const scope = phraseScopeOf(baseUrl, speakerId)
  if (scope !== fixedPhraseScope) {
    // 接続先か話者が変わった。前の声のまま鳴らさないよう捨て、進行中の合成も打ち切る
    // （放っておくと、もう使わない声の合成が VOICEVOX を占有して次の読み上げを待たせる）。
    for (const entry of fixedPhrases.values()) entry.abort()
    fixedPhrases.clear()
    fixedPhraseScope = scope
  }
  fixedPhraseTargets = phrases

  const ctx = getAudioContext()
  if (!ctx) {
    // 実質 window の無い環境でしか起きない。黙って戻ると「作り置きが一度も効かない」
    // 原因が追えなくなるので、他の早期 return と同じく記録は残す。
    log.debug('[VoiceVox] 切り出し語の作り置きをスキップ (AudioContext なし)')
    return
  }

  const pending = phrases.filter(p => !fixedPhrases.has(p))
  if (pending.length === 0) return

  // 先に全件を登録してから合成する。登録しておけば、この後の呼び出しが同じ句を二重に投げない。
  const queued = pending.map(phrase => {
    const ctrl = new AbortController()
    const entry: FixedPhrase = {
      buffer: null,
      abort: () => { try { ctrl.abort() } catch { /* 二重 abort は無視 */ } },
    }
    fixedPhrases.set(phrase, entry)
    return { phrase, entry, ctrl }
  })

  /** 1 件を合成して作り置きへ収める。 */
  const synthesizeOne = async ({ phrase, entry, ctrl }: typeof queued[number]) => {
    // 順番待ちの間に捨てられた・張り替えられたなら、もう要らない
    if (fixedPhrases.get(phrase) !== entry) return
    // タイムアウトは順番が回ってきてから張る（待ち時間を持ち時間に数えない）
    const timer = setTimeout(() => ctrl.abort(), FIXED_PHRASE_SYNTH_TIMEOUT_MS)
    try {
      // hasNextChunk は必ず true。作り置きの対象（`EEW_LEAD_PHRASES`）はすべて読点で終わる
      // 読み上げ文の 1 チャンク目で、後ろに震源名が続く。既定の false で焼くと、**作り置きが
      // 当たったときだけ末尾の間が消える**（合成し直した経路は `chunks.length > 1` を渡すため)。
      // どちらの経路が先にキャッシュを埋めたかで間が変わる、非決定的な不揃いになる。
      const buf = await synthesizeChunk(baseUrl, phrase, speakerId, ctx, ctrl.signal, true)
      // 張り替えられていたら触らない（新しい方を消してしまわないため）
      if (fixedPhrases.get(phrase) !== entry) return
      if (buf) { entry.buffer = buf; return }
      // 失敗は覚えない。VOICEVOX を後から起動することがあるため、作り直す余地を残す。
      fixedPhrases.delete(phrase)
      // 記録しないと「作り置きが一度も効いていない」ことに誰も気づけない。読み上げ本体と違い、
      // 失敗しても無音にはならず**ただ遅いだけ**なので、症状から原因へ辿る手がかりがここしかない。
      warnFixedPhraseFailed(() => log.warn(
        '[VoiceVox] 切り出し語の作り置きに失敗（緊急地震速報の読み上げが合成の往復ぶん遅れる）',
        { baseUrl, speakerId },
      ))
    } finally {
      clearTimeout(timer)
    }
  }

  // **1 件ずつ順に投げる。** VOICEVOX は合成を直列に捌くため、まとめて投げると起動直後の
  // 数百 ms を占有する。ちょうどその窓に緊急地震速報が届くと、切り出し語は作り置き（または
  // フォールバック）で鳴らせても、続く 2 チャンク目（震源名）の合成が後ろに並んで遅れる。
  // 逐次なら占有はその 1 件ぶんに収まり、間に本物の読み上げが割り込める。
  void (async () => { for (const item of queued) await synthesizeOne(item) })()

  log.debug(`[VoiceVox] 切り出し語の作り置き: ${pending.join(' / ')}`)
}

/**
 * 作り置きから引く。**待たない。**
 *
 * まだ合成できていなければ null を返し、呼び出し側は普通に合成する。ここで合成中のものを
 * 待つ設計にすると、応答が返らない要求を掴んだときに**その句を使う読み上げが軒並み無音になる**
 * （外側の待ち合わせが上限で諦めるため、記録も残らずに消える）。作り置きは「間に合っていれば
 * 速い」ための仕掛けであって、間に合っていないなら待つ理由がない。
 */
function takeFixedPhrase(baseUrl: string, speakerId: number, chunk: string): AudioBuffer | null {
  if (phraseScopeOf(baseUrl, speakerId) !== fixedPhraseScope) return null
  return fixedPhrases.get(chunk)?.buffer ?? null
}

/**
 * 作り置きの対象なのに手元に無かった句を、いま合成したもので埋める。
 * 起動時の作り置きが失敗していても（VOICEVOX が後から起動した場合など）次回から効く。
 */
function rememberFixedPhrase(baseUrl: string, speakerId: number, chunk: string, buffer: AudioBuffer): void {
  if (phraseScopeOf(baseUrl, speakerId) !== fixedPhraseScope) return
  if (!fixedPhraseTargets.includes(chunk)) return
  const existing = fixedPhrases.get(chunk)
  if (existing?.buffer) return
  // 合成中のものがあっても、同じ音をいま作れたのだから待つ必要はない。**打ち切って置き換える。**
  // ここで「登録済みなら何もしない」にすると、応答の返らない合成が居座っている間は
  // 二度と埋まらず、作り置きが永久に効かなくなる。
  existing?.abort()
  fixedPhrases.set(chunk, { buffer, abort: () => { /* 合成済み。打ち切るものがない */ } })
}

/** テスト用に作り置きを捨てる（本番経路では呼ばない）。 */
export function __resetFixedPhrasesForTest(): void {
  for (const entry of fixedPhrases.values()) entry.abort()
  fixedPhrases.clear()
  fixedPhraseScope = ''
  fixedPhraseTargets = []
}

/**
 * 発話を鳴らす直前に呼ばれる妥当性の判定。`false` を返すと、そのチャンク以降を鳴らさない。
 *
 * **文面を作った時刻と、音が出る時刻はずれる。** 合成（VOICEVOX への往復）を待つ間にも、
 * 鳴らしている間にも新しい電文は届く。緊急地震速報の予想震度のように数秒で書き換わる値は、
 * 1 回の発話が終わる前に古くなりうるため、鳴らす側で見直せるようにしている。
 *
 * 呼ばれるのは**チャンクごと**（句読点区切り。`splitIntoChunks`）で、鳴っている途中の
 * チャンクは打ち切らない。語の途中で切ると聞き取りを壊すため。
 */
export type ShouldStillPlay = () => boolean

/**
 * チャンクの再生を予約したときの通知。画面を読み上げに追従させる側が受け取る。
 *
 * **渡されるのは「予約」であって「鳴り始め」ではない。** `startAt` は AudioContext の
 * 時間軸（{@link getSpeechClock} と同じ基準）での再生開始時刻で、2 番目以降のチャンクでは
 * 未来を指す。受け取る側は `startAt` と現在時刻を突き合わせて「いま鳴っているチャンク」を決める。
 *
 * **ここでチャンクごとに `setTimeout` を張る形にはしていない。** バックグラウンドのタブでは
 * タイマーが 1 秒以上に間引かれる一方で**音は実時間で鳴り続けて正常に終わる**ため、滞留した
 * タイマーが読み上げの終了後に発火して追従の状態が残る。`ctx.suspend()`（システムスリープ）
 * では逆方向にずれる。時刻の解決は受け取る側に委ね、こちらは予約を報告するだけにする。
 *
 * `index` は `chunks` の添字。**連番になるとは限らない**（合成に失敗したチャンクは
 * 鳴らさずに飛ばすため、その分が欠ける）。
 */
export type ChunkScheduledListener = (index: number, startAt: number, chunks: readonly string[]) => void

/**
 * 読み上げの再生時刻（AudioContext の時間軸）。
 * {@link ChunkScheduledListener} の `startAt` と同じ基準で比較できる。
 * 音声がまだ使えない（ユーザー操作前）ときは null。
 */
export function getSpeechClock(): number | null {
  return getAudioContext()?.currentTime ?? null
}

// 予約したチャンクが鳴り始める何秒前に {@link ShouldStillPlay} を見直すか。
// チャンクは切れ目を作らないよう前のチャンクの終わりに合わせて**先に**予約するため、
// 予約した時点だけで判定すると 1 チャンク分（実測 1 秒強）先の未来を判定してしまう。
const PRE_START_CHECK_LEAD_SEC = 0.05

/**
 * テキストを VOICEVOX で合成して再生する（パイプライン方式）。
 * テキストを句読点で分割し、最初のチャンクが合成できた時点で再生を開始する。
 * 再生中の音声があれば割り込み停止して新しいものを再生する。
 * VOICEVOX 未起動・ネットワーク失敗時は無音で終了する（例外スローなし）。
 *
 * @param shouldStillPlay 各チャンクを鳴らす直前に呼ぶ妥当性の判定（省略時は常に鳴らす）
 */
export async function speakWithVoicevox(
  baseUrl: string,
  text: string,
  speakerId: number,
  volume: number,
  shouldStillPlay?: ShouldStillPlay,
  /**
   * {@link prewarmVoicevox} で先に合成しておいた音声。最初のチャンクをこれで置き換えて、
   * 合成待ちの分だけ声を早める。テキストが違う・合成に失敗していた場合はここで作り直す。
   *
   * EEW の読み上げでは使わない（間を置かずに読み始めるため、先に合成しておく余地がない）。
   */
  prewarmed?: PrewarmedSpeech | null,
  /**
   * チャンクの再生を予約したときに呼ぶ（{@link ChunkScheduledListener}）。
   * 画面を読み上げに追従させる側がこれを受け取る。
   */
  onChunkScheduled?: ChunkScheduledListener,
): Promise<void> {
  const startedAt = performance.now()
  log.debug(`[VoiceVox] 読み上げ: ${text}`, { speakerId, volume, prewarmed: !!prewarmed })

  // 既存の再生を全て停止
  for (const src of activeSources) {
    try { src.stop() } catch { /* already stopped */ }
  }
  activeSources = []

  // 使われない先行合成を打ち切る。放っておくと VOICEVOX 側の直列処理を占有して、これから
  // 読む方が待たされる（旧セッションの fetch を abort するのと同じ理由。AUD-4）。
  //
  // **自分が使うものは先に対象から外すこと。** 外さないと、地震情報と長周期のように電文が
  // ほぼ同時に届いたとき、**後から始まった読み上げが、先に始まった側がこれから使う先行合成を
  // 打ち切る**。消された側は作り直すので無音にはならないが、間に合わせるために先に合成した
  // 意味が失われ、待ち時間は先行合成が無かった頃より長くなる。
  if (prewarmed) activePrewarms.delete(prewarmed)
  for (const p of activePrewarms) p.abort()

  // 旧セッションの in-flight fetch を打ち切る（AUD-4）。abort() は同期完了なので
  // ここから先の await は新しいコントローラーの signal を使う。
  if (currentAbortController) {
    try { currentAbortController.abort() } catch { /* 二重 abort は無視 */ }
  }
  currentAbortController = new AbortController()
  const signal = currentAbortController.signal

  // セッション ID を更新して古いパイプラインを無効化
  const sessionId = ++currentSessionId

  // 辞書が未ロードならここで待つ（キャッシュ済みなら即時解決）。取得できなくても句区切りが
  // 効かないだけで読み上げは続行する（synthesizeChunk はキャッシュを都度参照し、未取得なら
  // 句区切り処理を飛ばす）。ここで長く待つと緊急地震速報の読み上げがそのまま遅れるため、
  // 辞書側は共通値より短いタイムアウトを使う（ttsPhraseBreakDict.ts）。
  // 失敗は読み上げのたびに繰り返されうるのでログは debug に留める。
  //
  // 待つのはセッションを確立した後にすること。先に待つと、辞書が未取得の間に重なった複数の
  // 読み上げが同じ取得完了を待ち合わせ、解決後に後着が先着のセッションを追い越して先着が
  // 1 音も鳴らずに消える。ここで待てば、待機中に来た読み上げが即座に旧セッションを無効化できる。
  await loadTtsPhraseBreakDict().catch((err) => {
    log.debug('[VoiceVox] 句区切り辞書の取得に失敗（区切りなしで読み上げ）', err)
  })
  if (currentSessionId !== sessionId) return  // 辞書待ちの間に割り込まれた

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

  // 次チャンクを先行合成するためのキュー。
  // 最初のチャンクは、間を置いている最中に合成しておいたものがあればそれを使う
  // （`prewarmVoicevox`）。打ち切られていた・失敗していた場合はここで作り直す。
  let nextBufferPromise: Promise<AudioBuffer | null> = (async () => {
    if (prewarmed && prewarmed.text === text) {
      const buffered = await prewarmed.first
      if (buffered) return buffered
      log.debug('[VoiceVox] 先行合成が使えなかったため作り直す')
    }
    // 切り出し語（緊急地震速報の第 1 フェーズ）は起動時に作り置きしてある。
    // 当たれば合成の往復を丸ごと省けるので、間を置かない経路でも待たずに鳴らせる。
    // 間に合っていなければ待たずに普通の合成へ落ちる（`takeFixedPhrase` の注記を参照）。
    const fixed = takeFixedPhrase(baseUrl, speakerId, chunks[0])
    if (fixed) return fixed

    // hasNextChunk は先行合成（prewarmVoicevox）・作り置き（warmFixedPhrases）と必ず同じ判定に
    // すること。食い違うと、合成済みのものを使えたときと作り直したときで末尾の間が変わる。
    const built = await synthesizeChunk(baseUrl, chunks[0], speakerId, ctx, signal, chunks.length > 1)
    // 作り置きの更新に失敗しても読み上げ自体は成立させる（この関数は例外を投げない約束）
    if (built) {
      try {
        rememberFixedPhrase(baseUrl, speakerId, chunks[0], built)
      } catch (err) {
        log.debug('[VoiceVox] 作り置きの更新に失敗（読み上げは続行）', err)
      }
    }
    return built
  })()

  // 次のチャンクを再生開始する予定時刻（AudioContext の時間軸）
  let scheduleAt = -1

  // 全チャンクの再生完了を待つための Promise（呼び出し元が await できる）
  let completionResolve!: () => void
  const completionPromise = new Promise<void>(r => { completionResolve = r })

  // 予約したチャンクと、その開始時刻（AudioContext の時間軸）。`dropped` は鳴らすのを
  // 取り下げた印、`ended` は再生が終わった印。完了を待つ対象を選ぶためにも使う。
  const scheduled: { source: AudioBufferSourceNode; startAt: number; dropped: boolean; ended: boolean }[] = []
  // 妥当性を失ったと判断したか。以降は合成も予約もしない
  let abandoned = false

  /**
   * 妥当性の判定を呼ぶ。**判定自体が失敗したときは鳴らす側に倒す。**
   * 黙る判断を例外に委ねると、緊急地震速報が無音のまま消える方に転ぶため。
   */
  const stillPlayable = (): boolean => {
    if (!shouldStillPlay) return true
    try {
      return shouldStillPlay()
    } catch (err) {
      log.warn('[VoiceVox] 発話直前の判定に失敗したため、そのまま読み上げる', err)
      return true
    }
  }

  /**
   * 完了（呼び出し元が待っている Promise）を、**最後まで鳴るチャンクの終わり**に合わせる。
   *
   * 取り下げのたびに呼び直すこと。合成は再生より速く終わることが多く、ループは実際の再生を
   * 追い越して全チャンクを予約し終える。そのため予約し終えた時点の「最後のチャンク」を
   * 掴んだままにすると、取り下げでそれを落としたときに完了が**鳴っている途中のチャンクより
   * 早く**訪れ、次の発話が割り込んで末尾を削ってしまう。
   *
   * 呼び直しの結果、同じチャンクにリスナーが二重に付くことはある（取り下げが起きた直後に
   * ループ側からも呼ばれる経路）。`completionResolve` は 2 回目以降が無効なので害はない。
   */
  const resolveWhenLastPlayingEnds = () => {
    const playing = scheduled.filter(s => !s.dropped)
    if (playing.length === 0) { completionResolve(); return }
    const last = playing[playing.length - 1]
    // **もう鳴り終わっているチャンクに 'ended' を張っても二度と発火しない。**
    // 先行合成が前のチャンクの残り時間より長くかかると、取り下げの判断はその「鳴り終わった
    // あと」に届く。ここを見落とすと完了が来ず、次の発話が上限（8 秒）まで足止めされる。
    if (last.ended) { completionResolve(); return }
    // **取り下げられたチャンクの 'ended' では完了させない。** リスナーは外せる形で持っていない
    // ため、付け替えても古いリスナーは残る。`stop()` は 'ended' を即座に発火させるので、
    // 残ったリスナーをそのまま通すと、まだ鳴っているチャンクより早く完了してしまう
    // （早まったぶん、次の発話の冒頭の一括 stop() が鳴っている末尾を削る）。
    last.source.addEventListener('ended', () => { if (!last.dropped) completionResolve() })
  }

  /**
   * まだ鳴り始めていない予約を落とし、以降の合成も止める。
   * **鳴っている途中のチャンクは最後まで鳴らす**（語の途中で切ると聞き取りを壊すため）。
   */
  const abandonRemaining = (reason: string) => {
    abandoned = true
    log.debug(`[VoiceVox] 以降のチャンクを取り下げた（${reason}）: ${text}`)
    for (const s of scheduled) {
      if (s.startAt <= ctx.currentTime) continue  // 鳴り始めている分はそのまま
      s.dropped = true
      try { s.source.stop() } catch { /* already stopped */ }
    }
    // 進行中の合成も打ち切る（**自分のセッションのものだけ**。新しい発話のものは触らない）
    if (currentSessionId === sessionId && currentAbortController) {
      try { currentAbortController.abort() } catch { /* 二重 abort は無視 */ }
    }
    // 完了の待ち先を鳴り続けるチャンクへ付け替える（落としたチャンクを待つと早すぎる）
    resolveWhenLastPlayingEnds()
  }

  for (let i = 0; i < chunks.length; i++) {
    if (currentSessionId !== sessionId) { completionResolve(); return }  // 割り込みされた

    const buffer = await nextBufferPromise
    if (currentSessionId !== sessionId) { completionResolve(); return }  // await 中に割り込み
    if (abandoned) break  // 鳴り始めの直前の判定で取り下げられた

    // 次チャンクの合成を先行開始（現在のチャンクの再生と並行）
    if (i + 1 < chunks.length) {
      nextBufferPromise = synthesizeChunk(baseUrl, chunks[i + 1], speakerId, ctx, signal, i + 2 < chunks.length)
    }

    if (!buffer) continue  // 合成失敗したチャンクはスキップ

    // 合成を待つ間に古くなっていたら、このチャンクは予約しない
    if (!stillPlayable()) { abandonRemaining('合成を待つ間に情報が新しくなった'); break }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gainNode)
    activeSources.push(source)

    if (scheduleAt < 0) {
      // 最初のチャンク: 即時再生
      scheduleAt = ctx.currentTime
      // 声が出るまでの実測。**先行合成（`prewarmVoicevox`）が効いているかの確認に使う。**
      // 効いていれば 1 桁 ms、効いていなければ合成の分（LAN 越しで 150〜350ms）が乗る。
      log.debug(`[VoiceVox] 最初の音まで ${Math.round(performance.now() - startedAt)}ms`)
    }
    // scheduleAt が過去になっている場合（合成が再生より遅れた）は現時刻にフォールバック
    if (scheduleAt < ctx.currentTime) scheduleAt = ctx.currentTime

    const startAt = scheduleAt
    const entry = { source, startAt, dropped: false, ended: false }
    scheduled.push(entry)
    source.onended = () => {
      entry.ended = true
      activeSources = activeSources.filter(s => s !== source)
    }
    source.start(startAt)
    // **追従の通知で読み上げを壊さない。** この関数は例外を投げない契約（VOICEVOX 未起動・
    // 通信失敗でも無音で正常終了する）で、ここから throw が抜けるとループが中断し、以降の
    // チャンクは合成も予約もされない ―― 画面が動かないどころか、警報の本文が途中で切れる。
    // 判定の失敗を「鳴らす側」に倒す `stillPlayable` と同じ方針で、記録だけ残して続行する。
    try {
      onChunkScheduled?.(i, startAt, chunks)
    } catch (err) {
      log.warn('[VoiceVox] 予約の通知に失敗（読み上げは続行）', err)
    }
    scheduleAt += buffer.duration

    // 鳴り始めが先なら、その直前にもう一度確かめる（予約時点の判定では 1 チャンク分先の
    // 未来を判定してしまう）。stop() は開始時刻より前に呼べば 1 音も鳴らさずに落ちる。
    if (shouldStillPlay) {
      const waitMs = (startAt - PRE_START_CHECK_LEAD_SEC - ctx.currentTime) * 1000
      if (waitMs > 0) {
        setTimeout(() => {
          if (currentSessionId !== sessionId || abandoned || entry.dropped) return
          if (stillPlayable()) return
          abandonRemaining('鳴り始める直前に情報が新しくなった')
        }, waitMs)
      }
    }
  }

  // 最後まで鳴るチャンクの再生終了で resolve（合成失敗等でソースが0個なら即時 resolve）
  const anyPlaying = scheduled.some(s => !s.dropped)
  if (anyPlaying) {
    resolveWhenLastPlayingEnds()
  } else if (abandoned) {
    // 1 音も鳴らさずに取り下げた（多くは合成を待つ間に情報が新しくなった場合）。異常ではないので
    // 無音の警告は出さないが、**部分的に鳴った取り下げとは水準を分ける**。判定側の不具合で
    // 本来鳴らすべきものまで落としていると、この経路だけが繰り返し起こるため。
    log.info(`[VoiceVox] 1 音も鳴らさずに取り下げた: ${text}`)
    completionResolve()
  } else {
    // 1 チャンクも鳴らせなかった。この関数は例外を投げない設計なので、記録しないと
    // 呼び出し側からは「読み上げが正常に完了した」と区別できず、**無音だったことが
    // どこにも残らない**（VOICEVOX 未起動・ネットワーク断・話者 ID 不正などで起こる）。
    // 同じ失敗が読み上げのたびに繰り返されうるため間引く。
    warnNoAudio(() => log.warn(
      `[VoiceVox] 音声を 1 つも合成できなかったため無音で終了した（chunks=${chunks.length}）`,
      { baseUrl, speakerId },
    ))
    completionResolve()
  }
  await completionPromise
}
