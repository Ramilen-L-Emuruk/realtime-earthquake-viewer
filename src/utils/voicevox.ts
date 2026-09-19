import { getAudioContext, getMasterInput, syncKeepAlive } from './alertSound'
import { findPhraseBreakMatch, getTtsPhraseBreakDictCache, isPlaceNameKey, loadTtsPhraseBreakDict } from './ttsPhraseBreakDict'
import { leadingParticle } from './ttsTrailingParticles'
import { getTtsStationReadingsCache, loadTtsStationReadings } from './ttsStationReadings'
import { getTtsEpicenterAccentsCache, loadTtsEpicenterAccents } from './ttsEpicenterAccents'
import { mergeSpeechDicts } from './ttsGeneratedDict'
import { speechChunkKey, takeCachedChunk, hasCachedChunk, putCachedChunk, clearSpeechAudioCache, registerSpeechCacheExtraStats } from './speechAudioCache'
import { log, createLogThrottle } from './logger'

/**
 * 設定の接続先を使って通信を始めるまでに、入力が落ち着くのを待つ時間。
 *
 * 入力欄は 1 文字ごとに設定を保存するため、生の値を effect の依存に渡すと打鍵のたびに通信が
 * 走る（実測: 「192」と打つ途中の「1」「19」「192」がそれぞれ IPv4 の `0.0.0.1` / `0.0.0.19` /
 * `0.0.0.192` として接続され、全部失敗した）。DMDATA の APIキー（`App.tsx` の
 * `API_KEY_DEBOUNCE_MS`）と同じ 800ms に揃えてある。
 *
 * **設定の変化で通信する側は全部これを通すこと。** 該当するのは接続確認・話者一覧（設定タブ）と
 * 切り出し語の作り置き（`warmFixedPhrases`）。試聴と実際の読み上げはユーザー操作・電文の受信の
 * 時点でしか通信しないので対象外。
 */
export const VOICEVOX_URL_DEBOUNCE_MS = 800

export type VoicevoxStyle = { name: string; id: number }
export type VoicevoxSpeaker = { name: string; speaker_uuid: string; styles: VoicevoxStyle[] }

// VOICEVOX の AccentPhrase（構造の詳細には立ち入らず、そのまま受け渡すだけなので unknown 値の記録として扱う）
type AccentPhrase = Record<string, unknown>

// 再生中のソース一覧（パイプライン再生中は複数になる）
let activeSources: AudioBufferSourceNode[] = []
// 最後に音源が空になった時刻（{@link isAudioPlaying} がチャンクの切れ目を跨ぐために使う）。
// 0 は「一度も鳴っていない」。
let lastAudioEndedAt = 0
// 現在のセッション ID。新しい読み上げが来たら古いパイプラインを打ち切るために使う
let currentSessionId = 0
// 現在のセッションで進行中の fetch を一括中断するための AbortController（AUD-4）。
// sessionId のインクリメントだけでは in-flight の /audio_query・/synthesis リクエストは
// 完走してしまい、VOICEVOX 側の直列処理を占有して新規発話が待たされる。新セッション開始時に
// abort() することで旧セッションのリクエストを即座に打ち切る。
let currentAbortController: AbortController | null = null

// 進行中の読み上げの本数（{@link isSpeaking}）。**数えるのは {@link speakWithVoicevox} の
// 呼び出しであって「いま音が鳴っているか」ではない。** 合成待ちやチャンクとチャンクの隙間で
// 偽へ落ちると、その一瞬を突いてアイドル復帰が画面を持っていく（→ `App.tsx` のアイドル復帰）。
// 割り込まれた側も正常終了で返るため（この関数は既存の再生を止めてから始める）、数は狂わない。
let speakingCount = 0
// **最後に読み上げが始まった**時刻（{@link SPEECH_STALE_MS} の起点）。
let speakingSince = 0
// 張り付きを記録したか。毎回出すと {@link isSpeaking} を呼ぶ周期でログが埋まる。
let speakingStaleWarned = false
// 最後に読み上げへ渡した文。張り付いたとき、何が詰まったのかを記録に残すために持つ。
let speakingLastText = ''
// 読み上げが 1 本も無くなったときに呼ぶ購読者（{@link onSpeechIdle}）。
const speechIdleListeners = new Set<() => void>()

/**
 * 読み上げが終わらなくなったと見なすまでの時間（{@link isSpeaking} の安全弁）。
 *
 * **数が減らないまま真を返し続けると、既定の状態へ二度と戻らなくなる。** しかも症状は
 * 「タブが戻らない」という形でしか出ず、例外もログも残らない。数える側（`speakWithVoicevox`
 * の `finally`）は取りこぼさない作りだが、それは**外部依存が個別に守っている契約の集まり**に
 * すぎない（辞書取得のタイムアウト・`AbortController`・`AudioContext` が止まらないこと）。
 * どれか 1 つが崩れたときに黙って壊れないよう、時間で足切りする。
 *
 * **測るのは「最後に読み上げが始まってからの経過」で、1 本の実時間ではない。** 読み上げは
 * 割り込み方式で、新しい呼び出しが古いものを止めてから始まる —— そのとき本数は 1 → 2 → 1 と
 * 動いて**一度も 0 を通らない**（止められた側が正常終了で返るのは次のマイクロタスク以降）。
 * 「1 本の実時間」で測ると、群発で同じ主題の続報が割り込み続ける間じゅう起点が最初の 1 件の
 * まま固定され、**実際には読み続けているのに 5 分で解けてしまう** —— いちばん解けてほしく
 * ない場面（大地震で読み上げが途切れない状況）で狙い撃ちになる。呼ばれるたびに引き直す。
 *
 * **値の根拠**: 正常な読み上げでいちばん長いのは各地の震度で、読み切りに 2 分近くかかる。
 * ここへ掛かるのは「最後に始まった 1 本がそれだけ続いている」場合なので、その 2 倍以上を
 * 取ってある。
 */
const SPEECH_STALE_MS = 5 * 60_000

// 1 チャンクも合成できなかったときの警告の間引き。VOICEVOX が落ちていると読み上げのたびに
// 起こるため、素通しにするとログが埋まって他の異常が見えなくなる。
const warnNoAudio = createLogThrottle(30000)

/**
 * 合成 1 チャンクを待つ上限。超えたらそのチャンクは合成失敗と同じ扱いにする。
 *
 * **VOICEVOX への合成要求そのものにはタイムアウトが無い**（接続は受け付けるのに応答を返さない
 * ——LAN 越しの機器がスリープに入る・経路が黙って捨てる、等。{@link FIXED_PHRASE_SYNTH_TIMEOUT_MS}
 * と同じ事情）。上限が無いと、この読み上げは完了も失敗もしないまま宙に浮き、**呼び出し側からは
 * 「鳴っている最中」と区別が付かない** —— 既読を進めるかどうかの判断がそこで狂う
 * （→ `SpeechOutcome`）。
 *
 * 上限は発話チェーンの待ち上限（`useLiveEventHandler` の `EEW_SPEECH_CHAIN_MAX_WAIT_MS` = 8 秒）
 * **より短く取ること**。長いと、チェーン側が先に見切りを付けてしまい「鳴っている最中」と
 * 誤認する余地が残る。作り置き（10 秒）より短いのは、あちらが急がない合成だから。
 *
 * 合成の実測は 238〜697ms。正常な遅延を切らない幅を取っている。
 */
export const CHUNK_SYNTH_TIMEOUT_MS = 5000

/**
 * 1 回の発話で**合成を待つ合計時間**の予算。
 *
 * **チャンクごとの上限（{@link CHUNK_SYNTH_TIMEOUT_MS}）だけでは足りない。** 合成待ちは直列に
 * 積み上がる（次のチャンクは前のチャンクの結果が出てから始める）ので、VOICEVOX が無応答なら
 * `チャンク数 × 5 秒` になる。2 チャンクあれば発話チェーンの待ち上限（8 秒）を越え、**チェーン側が
 * 先に見切って「鳴っている最中」と誤認する** —— 1 音も出ていないのに既読が進む。
 *
 * 予算はチェーン側の上限より短く取り、尽きたら以降のチャンクは待たない。
 * **鳴っている時間は数えない**（差し引くのは合成を待った分だけ）ので、正常な読み上げが
 * どれだけ長くても予算は減らない。
 *
 * **さらに、音が出ている間の合成待ちも数えない**（{@link isAudioPlaying}）。この予算が防ぎたい
 * 誤認は「1 音も出ていないのに鳴っている最中だと思われる」ことで、それはチェーン側
 * （`capSpeechWait`）が**同じ判定で**待ちを延ばすようになった時点で解消している。鳴り始めた
 * 後まで待ちを積むと、**合成が再生に追いつかないだけで以降のチャンクが丸ごと無音になる** ——
 * 録画中のように負荷で合成が遅れる場面では、1 チャンクあたり 200ms の遅れが 30 チャンク目で
 * 予算を使い切る（南海トラフ解説の本文は 65 チャンクある）。
 *
 * 音が {@link AUDIO_GAP_GRACE_MS} を超えて途切れたら消費を再開する。そこまで途切れているなら
 * チェーン側も打ち切る側へ倒れるので、宙吊りの保険は保たれる。
 */
export const SPEECH_SYNTH_BUDGET_MS = 6000

/**
 * 録画モードでの合成待ちの予算。
 *
 * **効くのは「音が途切れている間の待ち」の累計だけ**（鳴っている間は数えない。→
 * {@link SPEECH_SYNTH_BUDGET_MS}）。録画中は負荷で音が {@link AUDIO_GAP_GRACE_MS} を超えて
 * 途切れることがあり、そのたびに予算を削られると長い文の後半が落ちる。**録画は後で編集
 * するので、多少間が空いても最後まで読み切るほうが価値がある。**
 *
 * **この値が上限を決めるのは「音が途切れている間」だけ。** 鳴り続けている限り予算は減らない
 * ので、負荷で毎回ぎりぎり合成が成功し続ける劣化状態では、1 回の発話は
 * `CHUNK_SYNTH_TIMEOUT_MS × チャンク数`（南海トラフ解説の 65 チャンクなら理屈の上で 325 秒）
 * まで伸びうる。**それでよい** —— 音は出続けているので、聞き手には読み上げが続いている。
 * 最終的な歯止めは呼び出し側の `SPEECH_WAIT_HARD_CAP_MS`（`useLiveEventHandler`）が持つ。
 *
 * **それでも無制限にしないのは、1 音も鳴らないまま無応答になる場合のため。** そこでは
 * 予算がそのまま効き、この値で見切る。
 */
export const RECORDING_SYNTH_BUDGET_MS = 30_000

/** 録画モードか（合成待ちの予算を切り替える。{@link setSpeechSynthBudgetRelaxed}）。 */
let synthBudgetRelaxed = false

/**
 * 合成待ちの予算を録画向けに緩めるかどうかを切り替える。
 *
 * **引数で渡さないのはなぜか。** 読み上げを始める口は `speakWithVoicevox` ひとつだが、
 * 呼び出し元は 20 箇所を超える。1 つ足すたびに渡し忘れる余地ができ、忘れても
 * **症状は「録画中にたまに後半が落ちる」だけ**で型検査にも掛からない。
 */
export function setSpeechSynthBudgetRelaxed(relaxed: boolean): void {
  synthBudgetRelaxed = relaxed
}

// 合成が上限まで返らなかったときの警告の間引き。無応答は続けて起こるため、素通しにすると埋まる。
const warnSynthTimeout = createLogThrottle(30000)

// 合成そのものが失敗したときの警告の間引き（中断は別扱い。`synthesizeChunk` の catch）。
const warnSynthFailed = createLogThrottle(30000)

/**
 * 投機（`prefetchSpeechTexts`）由来の合成失敗の間引き。**本番と分ける。**
 *
 * 投機はリプレイ中 2 秒おきに何十件も投げる高頻度の呼び出し元で、{@link warnSynthFailed} を
 * 共有すると**投機の失敗が 30 秒の窓を使い切り、直後に起きた本物の読み上げの失敗が記録に
 * 出ない**（VOICEVOX 未起動でリプレイだけ先に始まった、など）。「読み上げが鳴らない」は
 * 実運用でいちばん知りたい異常なので、そこをノイズで潰さない。
 * 辞書の取得失敗を呼び出し元ごとに分けているのと同じ理由（{@link warnTextFragmentFailed}）。
 */
const warnPrefetchSynthFailed = createLogThrottle(30000)

/** 投機のループが例外で終わったときの間引き（合成の失敗とは別。実装の誤りを拾う枠）。 */
const warnPrefetchLoopFailed = createLogThrottle(30000)

// 合成待ちの予算を使い切ったときの警告の間引き。
const warnSynthBudgetOut = createLogThrottle(30000)

// チャンク末尾の間を付けられなかったときの記録の間引き。応答形式が変わっていれば読み上げの
// たびに全チャンクで起こるため、素通しにするとログが埋まる。
const warnNoChunkBreak = createLogThrottle(30000)

// 分割で落ちた句読点の間を mora_data が返さなかったときの記録の間引き。
// VOICEVOX 側の挙動が変われば読み上げのたびに起こるため間引く。
const warnNoEstimatedPause = createLogThrottle(30000)

// 句区切り辞書の組み直しに使う取得が失敗したときの記録の間引き。**辞書の読みだけでなく、
// 分割で落ちた句読点の補いもこの取得の上に乗っている**（失敗するとチャンク全体の
// /audio_query 結果へ落ちるので、間は残るが読みが崩れる）。記録が無いと切り分けられない。
//
// **断片の取得と辞書エントリの取得で分ける。** 間引きは呼び出し元を区別しないので、1 個を
// 共有すると VOICEVOX が不調で両方が同時に失敗したとき、**どちらが記録に出るかが偶然で決まる**
// —— 辞書エントリ側にしか無い助詞のカナが、いちばん切り分けたい場面で消える。
// `logger.ts` の createPerLabelLogGate が種類ごとにゲートを配るのと同じ理由。
const warnTextFragmentFailed = createLogThrottle(30000)
const warnDictEntryFailed = createLogThrottle(30000)

// 辞書の組み直しが例外で終わったときの記録の間引き。**取得の失敗（上）とは分ける。**
// あちらは非 200 応答という外の事情だが、こちらは組み直しそのものの実装の誤りで、
// 同じ記録に混ぜると「VOICEVOX が不調」と読み違える。
const warnDictRebuildFailed = createLogThrottle(30000)

// 句区切り辞書エントリの accent_phrases 取得結果キャッシュ
// （"speakerId:キー:助詞のカナ" -> AccentPhrase[]）。同じ地名・同じ話者・同じ助詞の組み合わせで
// 毎回 /accent_phrases を叩き直さないようにする。**助詞ごとに別エントリになる**（連結した形で
// 取得するため）ので、同じ地名でも最大「助詞なし＋助詞の数」通りが載る。
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
//
// **付属語を取り込めた切れ目には置かない**（`buildAccentPhrases` の `particle`）。間を置いていたのは
// 助詞が 1 モーラで独立したアクセント句になり、自ら核を持って浮くため。「区切って言い直した」ように
// 聞かせて隠していたにすぎず、読みを同じ句へ入れられるなら間そのものが要らない
// （→ `docs/spec/audio-tts-spec.md` §3「助詞は辞書の読みへ取り込む」）。
//
// 残るのは `leadingParticle` が助詞を切り出せなかった切れ目 —— 漢字・数字が直に続く形と、
// **列挙に無い助詞・助動詞が続く形**（`が` `と` `から` 等。読み上げ文の文型に無いので列挙していない）。
// 抑揚の不連続は {@link refineProsody} が引き直すが、句の切れ目であること自体は変わらないので短い間を挟む。
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
 * 辞書キーでの分割によって落ちた句読点の位置に置く「種」の無音。
 *
 * {@link buildAccentPhrases} は辞書キーの前後を別々に `/audio_query` にかけるため、**断片の端に
 * 来た句読点は音にならない**。チャンク末尾で起きるのと同じことが、チャンクの内側でも起きる。
 * 実測（話者 6）: `audio_query("山形県、")` の `pause_mora` は `null`、`audio_query("、")` は
 * `accent_phrases` が空配列。分割せず `audio_query("山形県、新潟県上中下越、")` なら 0.432 が付く。
 * つまり「山形県、新潟県上中下越」は**間ゼロで一続きに**聞こえていた。
 *
 * ここで種を置いておくと {@link refineProsody} が文脈から正しい長さへ引き直す（実測: 種を 0.01 に
 * しても 0.11 にしても、引き直し後は分割なしと同じ 0.432 になる）。**値そのものは通常使われない。**
 * 引き直しに失敗したときだけ残るので、文中の読点の実測幅（0.32〜0.54）の**短い側**から採った。
 * 中ほどを採らないのは、失敗した回だけ間が伸びて次のチャンクを待たせるより、やや短い方が害が
 * 小さいため。{@link CHUNK_BREAK_PAUSE} のように「既にある無音への足し分」ではなく、無音の全量を表す量。
 */
const SPLIT_PUNCT_PAUSE = pauseMora(0.35)

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
 *
 * @param keepEstimatedPauseAt 再推定された `pause_mora` を**採用する**句の位置。分割で落ちた
 *   句読点の位置（{@link SPLIT_PUNCT_PAUSE} を種として置いた場所）を渡す。ここだけは引き直された
 *   値こそが欲しい値で、種の値に戻してしまうと元の症状（間が入らない）に戻る。
 */
async function refineProsody(
  baseUrl: string,
  phrases: AccentPhrase[],
  speakerId: number,
  signal?: AbortSignal,
  keepEstimatedPauseAt?: ReadonlySet<number>,
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
    // pause_mora は原則まとめて元の値へ戻す。再推定に任せると DICT_TRAILING_PAUSE の短い間
    // （0.12 秒）が読点相当まで伸ばされ、意図した長さでなくなる（実測: 辞書語が文中なら
    // 0.349 秒、チャンク末尾なら 0.968 秒）。
    // 例外は `keepEstimatedPauseAt`（分割で落ちた句読点の位置）。そこは「文中の読点として
    // どれだけの間が要るか」を mora_data に決めてもらう場所なので、引き直した値を採る。
    const last = refined.length - 1
    return refined.map((ap, i) => {
      // **末尾では引き直し値を採らない。** チャンク末尾の間は CHUNK_BREAK_PAUSE の担当で、
      // ここで採ると 0.968 秒（実測）が乗り、最後のチャンクでは読み終わりがその分伸びて
      // 次の読み上げを待たせる。種を置いた位置が末尾に来るのは、後続の句が 1 つも返らなかった
      // 場合に限る（通常は起きないが、起きたときに黙って長い無音を作らせない）。
      if (!keepEstimatedPauseAt?.has(i) || i === last) {
        return { ...ap, pause_mora: phrases[i].pause_mora }
      }
      // 200 応答・句数一致でも `pause_mora` が落ちて返ることは原理的にありうる。そのまま採ると
      // **間が消えて元の症状（地名が一続きに聞こえる）へ静かに戻る**ので、種の値へ倒して記録する。
      if (ap.pause_mora == null) {
        warnNoEstimatedPause(() => log.debug(
          '[VoiceVox] mora_data が区切りの間を返さなかったため種の値を使う', { index: i },
        ))
        return { ...ap, pause_mora: phrases[i].pause_mora }
      }
      return ap
    })
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

// 辞書での分割によって音から落ちる「間の文字」。**句読点だけでは足りず、空白も含む。**
//
// VOICEVOX は後ろに何も続かない区切り文字に間を付けない。分割の切れ目へ来たものは句読点か
// 空白かによらず無音のまま消える（実測: 「…極めて大きな揺れ 波形、」を丸ごと読ませると
// 0.430 秒の間が入るが、辞書の「波形」で切り出すと 0 秒になる）。空白は電文の改行から来る
// （{@link normalizeTelegramTextForSpeech} が半角スペースへ直す）ので、気象庁が書いた文を
// 読むと必ずこの形が現れる。
//
// **チャンク分割の集合（{@link CHUNK_BREAK_PUNCTUATION}）とは分けること。** あちらは
// 「どこで割るか」と「チャンク末尾に間を足すか」の両方を決めており、空白を足すと割れない
// 位置に間だけが入る。
const SPLIT_GAP_TAIL_RE = new RegExp(`[${CHUNK_BREAK_PUNCTUATION}\\s]$`)
const SPLIT_GAP_HEAD_RUN_RE = new RegExp(`^[${CHUNK_BREAK_PUNCTUATION}\\s]+`)

/**
 * 断片の先頭の区切り文字が「内側」か（＝後ろにまだ読む文字が続くか）を返す。
 *
 * 区切り文字しか無い断片はチャンクの末尾を意味する。そこは {@link CHUNK_BREAK_PAUSE} の担当なので
 * {@link buildAccentPhrases} は種を置かない。置くと**最後のチャンクでだけ**引き直された長い無音
 * （実測 0.968 秒）が残り、読み終わりが伸びて次の読み上げがその分待たされる。
 */
function hasInnerLeadingGap(text: string): boolean {
  return SPLIT_GAP_HEAD_RUN_RE.test(text) && text.replace(SPLIT_GAP_HEAD_RUN_RE, '') !== ''
}

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
  if (!res.ok) {
    warnTextFragmentFailed(() => log.debug(
      '[VoiceVox] 句区切りの断片の取得が非 200 応答（辞書の組み直しを諦める）', { status: res.status, text },
    ))
    return null
  }
  const query = await res.json() as { accent_phrases: AccentPhrase[] }
  return query.accent_phrases
}

/**
 * 句区切り辞書エントリ（AquesTalk風カナ表記）を /accent_phrases(is_kana=true) にかけて
 * 句区切り・アクセント位置を指定通りに確定した accent_phrases を取得する。
 * 同じ話者・同じキーの結果はキャッシュして再利用する。失敗時は null。
 *
 * @param particleKana 辞書キーの直後に続く付属語の読み（無ければ空文字）。**辞書の値へ連結して
 *   1 つのカナ表記として渡す。** 記法上はただの文字列連結で、句を割る `/` を含めない限り
 *   アクセント句の数は変わらない（3 辞書の全 3032 エントリ × 全 7 助詞 ＝ 21224 件で実測。
 *   句数・モーラ列とも連結前と一致した）。**句が増えれば助詞が独立した句として浮き、この仕組みが
 *   直そうとした症状（1 モーラで自ら核を持つ句）がそのまま戻る**ので、助詞の読みを増やすときは
 *   `npm run verify-particle-phrases` で確かめること。キャッシュキーにも含める —— 同じキーでも
 *   助詞ごとに別の結果になる。
 */
async function fetchAccentPhrasesForKey(
  baseUrl: string,
  key: string,
  kanaReading: string,
  particleKana: string,
  speakerId: number,
  signal?: AbortSignal,
): Promise<AccentPhrase[] | null> {
  const cacheKey = `${speakerId}:${key}:${particleKana}`
  const cached = phraseBreakCache.get(cacheKey)
  if (cached) return cached

  const res = await fetch(
    `${apiBase(baseUrl)}/accent_phrases?text=${encodeURIComponent(kanaReading + particleKana)}&speaker=${speakerId}&is_kana=true`,
    { method: 'POST', signal },
  )
  if (!res.ok) {
    // **`particleKana` も残す。** 助詞を連結した形だけが拒否される場合と、辞書の読み単体でも
    // 起きていた失敗（サーバー不調・接続断）を、記録から切り分けられるようにするため。
    warnDictEntryFailed(() => log.debug(
      '[VoiceVox] 辞書エントリの取得が非 200 応答（辞書の組み直しを諦める）',
      { status: res.status, key, particleKana: particleKana || '(なし)' },
    ))
    return null
  }
  const phrases = await res.json() as AccentPhrase[]
  phraseBreakCache.set(cacheKey, phrases)
  return phrases
}

/**
 * テキストを accent_phrases の配列に変換する。句区切り辞書のキーを含む場合は、
 * その部分だけ /accent_phrases(is_kana=true) で処理し、前後の通常テキストと結合する
 * （キーを含まない後続部分にさらに別のキーが含まれる場合は再帰的に処理する）。
 * **該当語の直後に続く付属語（助詞）は、読みを辞書の値へ足して同じアクセント句に入れる**
 * （{@link leadingParticle}）。取り込めない切れ目にだけ短いポーズ（{@link DICT_TRAILING_PAUSE}）を挟む。
 * **この関数が返す時点では、繋ぎ目の音素長と音高はまだ独立取得のまま**（前半の末尾が文末扱いで
 * 伸び、音高も下がりきっている）。呼び出し側が {@link refineProsody} で引き直すこと。
 * 失敗時は null。
 *
 * **分割の切れ目に来た句読点は音にならない**（理由は {@link SPLIT_PUNCT_PAUSE}）。その位置には種の
 * 無音を置き、`punctAt` でどこに置いたかを返す。呼び出し側はそれを {@link refineProsody} の
 * `keepEstimatedPauseAt` へ渡すこと。渡さないと種の値がそのまま残り、間の長さが文脈に合わなくなる。
 *
 * **export しているのは、読み上げ文の抑揚を測る計測台（`ttsSentenceSweep.probe.test.ts`）が
 * 実運用と同じ組み立てを通すため。** 写し取って書き直すと、辞書の当たり方・助詞の取り込み・
 * 間の置き方のどれかがずれたときに**計測だけが古い組み立てで通り続ける**（そして食い違いは
 * 音を聞くまで出ない）。アプリ本体からの呼び出しは {@link synthesizeChunk} の 1 箇所だけ。
 */
export type BuiltPhrases = {
  phrases: AccentPhrase[]
  /** 分割で落ちた句読点を補った句の位置（`phrases` 内の添字）。 */
  punctAt: readonly number[]
}

export async function buildAccentPhrases(
  baseUrl: string,
  text: string,
  speakerId: number,
  phraseBreakDict: Record<string, string>,
  signal?: AbortSignal,
): Promise<BuiltPhrases | null> {
  if (text === '') return { phrases: [], punctAt: [] }

  const match = findPhraseBreakMatch(text, phraseBreakDict)
  if (!match) {
    const phrases = await fetchAccentPhrasesForText(baseUrl, text, speakerId, signal)
    return phrases ? { phrases, punctAt: [] } : null
  }

  const pre = text.slice(0, match.index)
  const afterKey = text.slice(match.index + match.key.length)

  // 辞書キーの直後に続く付属語は、辞書の読みへ取り込んで同じアクセント句に入れる
  // （→ ttsTrailingParticles の `leadingParticle`）。取り込めないものは従来どおりここで句を切る。
  //
  // **ただし辞書キーの一致を優先する。** 助詞と同じ字面で始まる辞書キーがあり（実データでは
  // `にかほ市金浦` の 1 件。先頭の `に` が助詞と同形）、そこで切ると残りは辞書に無い形になって
  // **その名前の読みが二度と当たらない** —— 誤読を直すために置いた辞書が、助詞 1 文字のために
  // 無効化される。記録も残らないので、聞くまで気づけない。
  // 直前の辞書キーとの間に区切り文字があればこの形にはならないが、**「読み上げ文には必ず読点が
  // 入る」ことに頼らない** —— 気象庁が書いた文（自由文）も同じ経路を通る。
  const particleRaw = leadingParticle(afterKey)
  const particle = particleRaw && findPhraseBreakMatch(afterKey, phraseBreakDict)?.index === 0
    ? null
    : particleRaw
  const post = particle ? afterKey.slice(particle.surface.length) : afterKey

  const [preBuilt, matchedPhrasesRaw, postBuilt] = await Promise.all([
    buildAccentPhrases(baseUrl, pre, speakerId, phraseBreakDict, signal),
    fetchAccentPhrasesForKey(
      baseUrl, match.key, phraseBreakDict[match.key], particle?.kana ?? '', speakerId, signal,
    ),
    buildAccentPhrases(baseUrl, post, speakerId, phraseBreakDict, signal),
  ])
  if (!preBuilt || !matchedPhrasesRaw || !postBuilt) return null

  // pre 側の位置もそのまま引き継ぐ。**`findPhraseBreakMatch` が最左一致を返すので pre は普通は
  // 辞書キーを含まないが、「含まない」と決めてはいけない。** 単独語キーは前後の文字で一致を弾く
  // 判定を持つため、切り出しでその文字が落ちると一致に転じる（→ ttsPhraseBreakDict の
  // `indexOfStandalone` の注記。あちらは直前の文字、ここでは直後の文字が落ちる形）。
  const punctAt = [...preBuilt.punctAt]

  // pre の末尾の区切り文字（句読点・空白）。辞書キーがこの直後に続くので、必ず「内側」。
  //
  // pre が区切り文字だけなら句が 0 個で掛ける先が無い。**それでもこの区切りは失われない。**
  // その状況は「親が post の先頭の区切り文字ごとこの再帰へ渡した」ときにだけ起こり、親は既に
  // 下の `postLeadsWithGap` で辞書キー側へ間を置いている。掛ける先が無いのは
  // **チャンクそのものが区切り文字で始まる**ときだけ。空白では起こらない（`splitIntoChunks` が
  // 各チャンクを `trim()` する）。句読点では、割る位置が句読点の後ろなので読み上げ文に句読点が
  // 連続している必要がある。テストデータと実シナリオの読み上げ文を機械的に走査した限り、
  // 連続句読点・句読点だけのチャンクはいずれも生じていない。
  let prePhrases = preBuilt.phrases
  if (SPLIT_GAP_TAIL_RE.test(pre) && prePhrases.length > 0) {
    prePhrases = withTrailingPause(prePhrases, SPLIT_PUNCT_PAUSE)
    punctAt.push(prePhrases.length - 1)
  }

  // post の先頭の区切り文字。落ちるのは post 側だが、間を掛けられるのは辞書キーの最後の句。
  // 区切り文字しか無い post（＝チャンク末尾）は CHUNK_BREAK_PAUSE の担当なので触らない。
  const postLeadsWithGap = hasInnerLeadingGap(post)
  const matchedPhrases = postLeadsWithGap
    ? withTrailingPause(matchedPhrasesRaw, SPLIT_PUNCT_PAUSE)
    // 付属語を取り込めたなら切れ目は句の内側へ移っているので、間を置かない（置くと取り込んだ意味が無い）
    : particle != null
      ? matchedPhrasesRaw
      // 一般用語（「深発地震」等）は文中に自然に溶け込む語なので、区切り文字が無ければ間を入れない
      : isPlaceNameKey(match.key)
        ? withTrailingPause(matchedPhrasesRaw, DICT_TRAILING_PAUSE)
        : matchedPhrasesRaw
  if (postLeadsWithGap) punctAt.push(prePhrases.length + matchedPhrases.length - 1)

  const offset = prePhrases.length + matchedPhrases.length
  for (const i of postBuilt.punctAt) punctAt.push(offset + i)

  return { phrases: [...prePhrases, ...matchedPhrases, ...postBuilt.phrases], punctAt }
}

/**
 * 読み上げに使う辞書の合成結果。両方のキャッシュの参照が変わるまで使い回す。
 * {@link findPhraseBreakMatch} は呼ばれるたびに全キーを走査し、しかもチャンクの断片ごとに
 * 再帰するので、毎回作り直すと 2600 キーぶんのオブジェクト生成が読み上げのたびに乗る。
 */
let mergedSpeechDict: {
  base: Record<string, string> | null
  stations: Record<string, string> | null
  epicenters: Record<string, string> | null
  merged: Record<string, string> | null
} = { base: null, stations: null, epicenters: null, merged: null }

/**
 * 句区切り辞書（手で書いたアクセント付き）と、震度観測点名の読み（気象庁のふりがなから生成）を
 * 合わせた辞書を返す。どちらも未取得なら null。合わせ方は {@link mergeSpeechDicts}。
 */
function speechDict(): Record<string, string> | null {
  const base = getTtsPhraseBreakDictCache()
  const stations = getTtsStationReadingsCache()
  const epicenters = getTtsEpicenterAccentsCache()
  if (mergedSpeechDict.base === base
    && mergedSpeechDict.stations === stations
    && mergedSpeechDict.epicenters === epicenters) {
    return mergedSpeechDict.merged
  }
  const merged = mergeSpeechDicts(base, stations, epicenters)
  mergedSpeechDict = { base, stations, epicenters, merged }
  return merged
}

/**
 * 読み上げに使う辞書を読み込む。**観測点の読みが取れなくても句区切りは効かせる**（逆も同じ）。
 *
 * @param onPhraseBreakError 句区切り辞書の取得に失敗したときの記録。呼び出し元ごとに
 *   ログの重みが違う（起動時の 1 回きりか、読み上げのたびに繰り返されうるか）ため外から渡す。
 */
async function loadSpeechDicts(onPhraseBreakError: (err: unknown) => void): Promise<void> {
  await Promise.all([
    loadTtsPhraseBreakDict().catch(onPhraseBreakError),
    loadTtsStationReadings().catch((err) => {
      log.debug('[VoiceVox] 観測点の読みの取得に失敗（観測点名の誤読が残る）', err)
    }),
    loadTtsEpicenterAccents().catch((err) => {
      log.debug('[VoiceVox] 震央地名の句割りの取得に失敗（長い震央地名の抑揚が崩れる）', err)
    }),
  ])
}

/**
 * 直前に控えの有効性を確かめたときの辞書の参照（{@link invalidateCacheOnDictChange}）。
 * `undefined` は「まだ一度も見ていない」。
 */
let cacheDictRef: Record<string, string> | null | undefined = undefined

/**
 * 辞書が入れ替わっていたら控えを捨てる。
 *
 * **辞書は後から届く。** `loadSpeechDicts` は取得に失敗しても合成を続ける設計なので、
 * 辞書が無い状態で焼いた音が控えに残り、あとから辞書が取れても**素の読みのまま鳴り続ける**
 * ことが起こる。読みが崩れていることは聞くまで分からず、画面にもログにも出ない。
 *
 * 効くのは起動直後だけだが、**1 回とは限らない。** 辞書は 3 つ（句区切り・観測点の読み・
 * 震央地名の句割り）あって個別に取得され、`speechDict()` はその組が変わるたびに新しい
 * オブジェクトを返す。揃う順によっては数回続けて発火する（そのぶん焼いた音は無駄になるが、
 * 誤読を残すよりよい）。読み込まれてしまえば以後は変わらない。
 *
 * **ここだけでは足りない。** この判定は「いま」の辞書しか見ないので、合成の往復の最中に
 * 入れ替わった場合は取りこぼす。書き込む側でも見比べること（`synthesizeChunk` の
 * `dictAtStart`）。
 */
function invalidateCacheOnDictChange(): void {
  const dict = speechDict()
  if (cacheDictRef === undefined) { cacheDictRef = dict; return }
  if (cacheDictRef === dict) return
  cacheDictRef = dict
  clearSpeechAudioCache()
  log.debug('[VoiceVox] 読み上げ辞書が入れ替わったため合成済みチャンクの控えを捨てた')
}

/**
 * 1 チャンクぶんの `/audio_query` を組み立てる（辞書の組み直し・繋ぎ目の引き直し・
 * チャンク末尾の間・話速まで）。**`/synthesis` へそのまま渡せる形**で返す。失敗時は null。
 *
 * **合成と分けてあるのは、読み上げ文の抑揚を測る計測台（`ttsSentenceSweep.probe.test.ts`）が
 * 本番と同じ音を作れるようにするため。** ここを写し取って書き直すと、話速・間・辞書の当たり方の
 * どれかがずれた音で判断することになる（一度それで、直そうとした症状そのものを聞き逃した）。
 * ブラウザの外では `AudioContext` を作れないので、切れ目は復号の手前に置いてある。
 *
 * @param hasNextChunk 後続のチャンクがあるか。真のとき、末尾の句読点に間を持たせる
 *   （{@link CHUNK_BREAK_PAUSE}）。**最後のチャンクには渡さないこと。** 読み終わりに無音が伸び、
 *   再生完了を待っている次の読み上げがその分遅れる。
 */
export async function buildChunkQuery(
  baseUrl: string,
  chunk: string,
  speakerId: number,
  signal?: AbortSignal,
  hasNextChunk = false,
  phraseBreakDict: Record<string, string> | null = speechDict(),
): Promise<Record<string, unknown> | null> {
  const built = await buildChunkQueryWithStatus(baseUrl, chunk, speakerId, signal, hasNextChunk, phraseBreakDict)
  return built?.query ?? null
}

/** 補正に失敗しても再生は続けるが、その音を控えに残して復旧後の再試行を妨げない。 */
async function buildChunkQueryWithStatus(
  baseUrl: string,
  chunk: string,
  speakerId: number,
  signal: AbortSignal | undefined,
  hasNextChunk: boolean,
  phraseBreakDict: Record<string, string> | null,
): Promise<{ query: Record<string, unknown>; cacheable: boolean } | null> {
  let cacheable = true
  const queryRes = await fetch(
    `${apiBase(baseUrl)}/audio_query?text=${encodeURIComponent(chunk)}&speaker=${speakerId}`,
    { method: 'POST', signal },
  )
  if (!queryRes.ok) return null

  const query = await queryRes.json() as Record<string, unknown>

  // 辞書にマッチする地名（区域名・観測点名）を含む場合は、accent_phrases を指定通りに組み直す
  if (phraseBreakDict && findPhraseBreakMatch(chunk, phraseBreakDict)) {
    // **組み直しの例外はここで受け止める。** 下の catch まで飛ばすと `return null` へ落ち、
    // **そのチャンクが無音のまま脱落する**（呼び出し側は `if (!buffer) continue`）。組み直しを
    // 諦めるだけなら素の `/audio_query` の結果で鳴るので、読みが崩れても声は続く。
    // 取得が非 200 だった場合（`buildAccentPhrases` が null を返す経路）は元からこの形。
    let built: BuiltPhrases | null = null
    try {
      built = await buildAccentPhrases(baseUrl, chunk, speakerId, phraseBreakDict, signal)
    } catch (err) {
      // 割り込みは正常系。**素の読みで合成を続けてはいけない**ので投げ直す（下の catch が拾う）。
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      // それ以外は組み直しの実装の誤り。**既定で残る側へ出す** —— 読みが崩れたことは
      // 聞くまで分からず、画面にも出ないため。すぐ下の refineProsody の失敗が debug 止まりなのは、
      // あちらが諦めても間は種の値で残る（縮退が軽い）から。こちらは辞書の読みそのものが効かない。
      warnDictRebuildFailed(() => log.warn(
        '[VoiceVox] 辞書の組み直しで例外（読みの補正を諦めて素のまま合成する）', { chunk, err },
      ))
    }
    // 結合したままだと繋ぎ目の直前（多くは助詞）が文末扱いになるため、長さと音高を引き直す。
    // 分割で落ちた句読点（`punctAt`）の間の長さも、ここで文脈から決めてもらう。
    // signal は下の /synthesis と必ず共有すること。共有していれば、割り込みで中断された場合に
    // 補正前の accent_phrases がそのまま合成まで進むことがない（refineProsody の catch 参照）。
    if (built) {
      const refined = await refineProsody(
        baseUrl, built.phrases, speakerId, signal, new Set(built.punctAt),
      )
      query.accent_phrases = refined ?? built.phrases
      if (!refined) cacheable = false
    } else {
      cacheable = false
    }
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
  return { query, cacheable }
}

/**
 * 1チャンクを audio_query → synthesis して AudioBuffer を返す。失敗時は null。
 *
 * **合成済みの控え（`speechAudioCache.ts`）はここで引く。** 合成を投げる経路は先行合成・
 * 作り置き・投機・本再生と 4 つあるが、いずれも最後はこの関数を通るので、ここ 1 箇所で全部に
 * 効く。呼び出し側それぞれに書くと、経路を足したときに 1 つだけ控えを通らない形ができる。
 *
 * @param hasNextChunk {@link buildChunkQuery} に同じ。
 */
async function synthesizeChunk(
  baseUrl: string,
  chunk: string,
  speakerId: number,
  ctx: AudioContext,
  signal?: AbortSignal,
  hasNextChunk = false,
  speculative = false,
): Promise<AudioBuffer | null> {
  const result = await synthesizeChunkWithStatus(baseUrl, chunk, speakerId, ctx, signal, hasNextChunk, speculative)
  return result?.buffer ?? null
}

/** 保存してよい音かを作り置きにも伝える。通常の再生は補正失敗時も音を使える。 */
async function synthesizeChunkWithStatus(
  baseUrl: string,
  chunk: string,
  speakerId: number,
  ctx: AudioContext,
  signal?: AbortSignal,
  hasNextChunk = false,
  /**
   * 投機（{@link prefetchSpeechTexts}）からの呼び出しか。**記録の間引きを分けるためだけに使う**
   * （理由は {@link warnPrefetchSynthFailed}）。合成の中身は変えない。
   */
  speculative = false,
): Promise<{ buffer: AudioBuffer; cacheable: boolean } | null> {
  invalidateCacheOnDictChange()
  // **鍵に `speedScale` は含めていない。** いまは下で 1.2 に固定しているため。設定で変えられる
  // ようにするなら、鍵にも足すこと —— さもないと速度を変えても古い音が鳴り続ける。
  const cacheKey = speechChunkKey(baseUrl, speakerId, chunk, hasNextChunk)
  const cached = takeCachedChunk(cacheKey)
  if (cached) return { buffer: cached, cacheable: true }
  /**
   * 合成を始めた時点の辞書。**読みの組み立てと、控えへ書いてよいかの判定の両方に使う。**
   *
   * **入口の `invalidateCacheOnDictChange()` だけでは足りない。** あちらは「いま辞書が
   * 入れ替わっていたら控えを捨てる」だけで、この関数は以降 `/audio_query` →
   * `/accent_phrases` → `/synthesis` と往復する。**その最中に別の発話が辞書を取り直すと、
   * 控えは捨てられた後にこちらが古い読みの音を書き込む**ことになる。辞書はその後安定するので
   * 二度と捨てられず、**そのチャンクだけセッション中ずっと誤読のまま固定される** ——
   * 無音にもならず例外も出ないので、聞くまで気づけない。
   *
   * 辞書の取得は失敗しても次の発話でやり直される設計（`loadTtsPhraseBreakDict`）なので、
   * 「未取得のまま合成が始まり、その最中に取得が成功する」並びは起動直後に現実に起こる。
   */
  const dictAtStart = speechDict()
  try {
    const built = await buildChunkQueryWithStatus(baseUrl, chunk, speakerId, signal, hasNextChunk, dictAtStart)
    if (!built) return null
    const { query, cacheable } = built

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
    const buffer = await ctx.decodeAudioData(wav)
    // **控えるのは合成しきったものだけ。** 失敗は覚えない（`fixedPhrases` と同じ理由 ——
    // VOICEVOX を後から起動することがあるので、作り直す余地を残す）。
    //
    // **待っている間に辞書が入れ替わっていたら書かない**（理由は `dictAtStart`）。この音は
    // 古い読みで作られているので、控えへ入れると誤読が固定される。鳴らすのはそのまま
    // 続ける —— 既に合成できているものを捨てて無音にするほうが害が大きい。
    if (cacheable && speechDict() === dictAtStart) {
      putCachedChunk(cacheKey, buffer)
    } else if (speechDict() !== dictAtStart) {
      log.debug('[VoiceVox] 合成中に辞書が入れ替わったため、この音は控えへ入れない', { chunk })
    }
    return { buffer, cacheable: cacheable && speechDict() === dictAtStart }
  } catch (err) {
    // abort による例外もここに落ちる。null で返して呼び出し元に「合成失敗」として扱わせる。
    //
    // **中断と通信障害は分けて残す。** どちらも同じ `null` になるので、記録しないと
    // 「新しい読み上げに切り替わった（正常）」と「VOICEVOX が応答しない（異常）」を
    // 後から切り分けられない。中断は日常的に起こるので `debug` に留める。
    if (err instanceof DOMException && err.name === 'AbortError') {
      log.debug('[VoiceVox] 合成を中断した（新しい読み上げへの切り替え・セッションの終了）')
    } else if (speculative) {
      warnPrefetchSynthFailed(() => log.warn('[VoiceVox] 投機の合成に失敗した', err))
    } else {
      warnSynthFailed(() => log.warn('[VoiceVox] 合成に失敗した', err))
    }
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
 * 通知音と声が重ならないよう音の種別ごとに間を置いているので（`ttsDelayFor`。0.5〜2.7 秒）、
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

  // **投機を止めてから始める**（→ {@link abortSpeechPrefetch}）。ここが呼ばれるのは通知音との
  // 間（0.5〜2.7 秒）で、そのとき直前の発話は終わっていることが多く `isSpeaking()` は偽 ——
  // つまり**投機は自制しない**。止めずに始めると、投機の要求が VOICEVOX の直列処理を占有した
  // まま先行合成が後ろに並び、「間が明けた瞬間に声を出す」という目的そのものが果たせない。
  // `speakOnce` の冒頭と同じ流儀。
  abortSpeechPrefetch()

  const ctrl = new AbortController()
  const first = (async () => {
    // 辞書は句区切りと読みにしか使わないので、取れなくても合成は続ける（本再生と同じ扱い）
    await loadSpeechDicts(() => { /* 区切りなしで合成する */ })
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
 * 合成を上限つきで待つ。超えたら `null`（合成失敗と同じ扱い）を返す。
 *
 * **ここで `abort()` してはいけない。** 合成に渡している `signal` は**その発話の全チャンクで
 * 共有**している（`speakOnce` が 1 回だけ `AbortController` を作る）。`AbortSignal` は一度
 * abort すると解除できないので、1 チャンクを見切るつもりで abort すると、**以降のチャンクは
 * 要求を送る前に即死する** —— 「このチャンクだけ諦める」が「残り全部を無音にする」に化ける。
 * 地方を列挙する読み上げなら、途中で 1 回詰まっただけで残りの警戒対象が丸ごと声にならない。
 *
 * **負けた側（合成）は止まらないが、放置してよい。** `Promise.race` は敗者をキャンセルしない
 * ので応答を待ち続けるリクエストが残るが、次の発話が始まるときに `speakOnce` の冒頭で
 * `currentAbortController.abort()` が片付ける。
 */
async function raceSynthTimeout(
  p: Promise<AudioBuffer | null>, waitMs: number,
  /**
   * この発話に適用された予算（記録の文面に出す）。
   *
   * **その発話の開始時に確定した値を渡すこと。** ここでモジュールの
   * {@link synthBudgetRelaxed} を読み直すと、長い発話の最中に録画モードを切り替えたとき
   * **実際に適用された値と記録が食い違う** —— この記録は「録画中に後半が無音になった」
   * 原因を追うための手掛かりなので、そこで嘘をつくと使えない。
   */
  budgetMs: number,
): Promise<AudioBuffer | null> {
  // 予算が尽きた。**既に終わっているものは拾う**（`p` を先に置く）が、待ちはしない。
  //
  // **黙って飛ばさない。** ここを通ったチャンクは合成失敗でもタイムアウトでもない経路で
  // 無音になるので、記録しないと「後半が読まれなかった」理由がどこにも残らない。
  if (waitMs <= 0) {
    warnSynthBudgetOut(() => log.warn(
      `[VoiceVox] この発話の合成待ちが予算（${budgetMs}ms）を使い切った（以降のチャンクは待たない）`,
    ))
    return Promise.race([p, Promise.resolve(null)])
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      warnSynthTimeout(() => log.warn(
        `[VoiceVox] 合成の応答が ${waitMs}ms 以内に返らなかった（このチャンクは諦める）`,
      ))
      resolve(null)
    }, waitMs)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

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
    // **辞書を待ってから焼く。** ここは起動直後に走るので、待たないと辞書のキャッシュが空のまま
    // 合成され、**辞書を当てていない音が作り置きに居座る**。作り置きは当たれば合成を丸ごと省く
    // ので、以後その句だけ辞書が効かない——しかも音は鳴るため、聞くまで気づけない。
    // 他の 2 経路（`prewarmVoicevox` / `speakOnce`）は既に待っている。
    // **待ちはタイムアウトの外に置く**（下の「持ち時間に数えない」と同じ理由）。
    await loadSpeechDicts(() => { /* 区切りなしで合成する */ })
    if (fixedPhrases.get(phrase) !== entry) return
    // タイムアウトは順番が回ってきてから張る（待ち時間を持ち時間に数えない）
    const timer = setTimeout(() => ctrl.abort(), FIXED_PHRASE_SYNTH_TIMEOUT_MS)
    try {
      // hasNextChunk は必ず true。作り置きの対象（`EEW_LEAD_PHRASES`）はすべて読点で終わる
      // 読み上げ文の 1 チャンク目で、後ろに震源名が続く。既定の false で焼くと、**作り置きが
      // 当たったときだけ末尾の間が消える**（合成し直した経路は `chunks.length > 1` を渡すため)。
      // どちらの経路が先にキャッシュを埋めたかで間が変わる、非決定的な不揃いになる。
      const result = await synthesizeChunkWithStatus(baseUrl, phrase, speakerId, ctx, ctrl.signal, true)
      // 張り替えられていたら触らない（新しい方を消してしまわないため）
      if (fixedPhrases.get(phrase) !== entry) return
      if (result?.cacheable) { entry.buffer = result.buffer; return }
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

// ─── 投機的な先行合成（リプレイ） ────────────────────────────────

/**
 * 投機で進行中の合成を打ち切る持ち手。**本番の読み上げが始まったら即座に止める。**
 *
 * VOICEVOX は合成を直列に捌くので、投機が走っている最中に本物が来ると 1 件ぶん待たされる。
 * 1 件ずつ順に投げる（下記）ことで待ちはその 1 件に収まるが、止められるものは止める。
 */
let prefetchAbort: AbortController | null = null

/** 投機のループが回っているか。二重に走らせない。 */
let prefetchRunning = false

/**
 * 投機の 1 件を諦めるまでの時間。
 *
 * **VOICEVOX への合成要求そのものにはタイムアウトが無い**（{@link CHUNK_SYNTH_TIMEOUT_MS} と
 * 同じ事情）。ここで上限を張らないと、無応答の 1 件で `await` が永久に解けず、
 * **{@link prefetchRunning} が真のまま固まって以後の投機が丸ごと死ぬ** —— しかも症状は
 * 「なんとなく速くならない」だけで、ログにも画面にも出ない。復帰するのは次の本物の読み上げが
 * {@link abortSpeechPrefetch} を呼んだときだけで、発話の少ない区間では長く死んだままになる。
 *
 * **値は作り置き（{@link FIXED_PHRASE_SYNTH_TIMEOUT_MS}）と同じだが、定数は分ける。** 急がない
 * 合成という性格は同じでも、片方を動かしたときにもう片方まで変える理由はない。
 */
export const PREFETCH_SYNTH_TIMEOUT_MS = 10000

/**
 * 続けてこの件数だけ焼けなかったら、そのバッチを諦める。
 *
 * **1 件ごとに持ち手を分けたことの裏返し。** 詰まった 1 件で残りを巻き込まないようにした結果、
 * VOICEVOX が落ちている場面では**全件が順に上限まで待つ**（`PREFETCH_SYNTH_TIMEOUT_MS` ×
 * チャンク数）。数十件並ぶバッチでは何分も投機が居座ることになる。
 *
 * 諦めても損はない —— 焼けなかったチャンクは控えに入らないので、次のティック（2 秒後）で
 * また積まれる。リプレイの取得が「1 件も無い範囲では打ち切る」のと同じ考え方
 * （`REPLAY_MAX_CONSECUTIVE_GIVEUPS`）。
 */
const PREFETCH_MAX_CONSECUTIVE_FAILURES = 2

// 投機の統計（`window.__speechCache()` から読む）。**焼いた件数だけでは足りない** ——
// 控えのヒット率と並べて初めて「投機が当たっているか」が読める。
let prefetchSynthesized = 0
let prefetchAborted = 0

registerSpeechCacheExtraStats(() => ({
  prefetchSynthesized,
  prefetchAborted,
  prefetchRunning,
}))

/**
 * これから読まれる見込みの文を、**再生せずに**先に合成して控えへ入れる。
 *
 * リプレイは窓ぶんの電文を先に持っているので、次に何が来るかが分かる（→ `speechPrefetch.ts`）。
 * その文を先に焼いておけば、実際に読む番が来たときには往復が丸ごと省ける。
 *
 * **本番を邪魔しないことが最優先。** 読み上げの最中は投げない・本番が始まったら打ち切る・
 * 1 件ずつ順に投げる（`warmFixedPhrases` と同じ流儀）。投機は「間に合っていれば速い」ための
 * 仕掛けであって、急ぐものではない。
 *
 * **セッションには関与しない。** 進行中の再生を止めず、`currentSessionId` も動かさない。
 *
 * @param texts 投機する読み上げ文。チャンクに割って、控えに無いものだけ焼く
 */
export function prefetchSpeechTexts(baseUrl: string, texts: readonly string[], speakerId: number): void {
  // 読み上げの最中は手を出さない。次の駆動で呼び直される（覗き直せば同じ文がまた並ぶ）。
  if (isSpeaking() || prefetchRunning) return
  const ctx = getAudioContext()
  if (!ctx) return

  // **控えに既にあるチャンクは並べない。** 同じチャンクが複数の文に現れることもあるので
  // 一意にもする。
  //
  // **見るのは `hasCachedChunk` で、`takeCachedChunk` ではない。** 後者はヒット数を数えるので、
  // ここで引くと**投機が自分の焼いたものを引き直した回数**が混ざり、`window.__speechCache()` の
  // ヒット数から「本番の読み上げが控えから出た回数」を読めなくなる（実測でそうなっていた ——
  // 28 件焼いたはずが手元に 18 件しか無く、差は投機自身のヒットだった）。
  const pending = new Map<string, { chunk: string; hasNext: boolean }>()
  for (const text of texts) {
    const chunks = splitIntoChunks(text)
    for (let i = 0; i < chunks.length; i++) {
      const hasNext = i + 1 < chunks.length
      const key = speechChunkKey(baseUrl, speakerId, chunks[i], hasNext)
      if (pending.has(key) || hasCachedChunk(key)) continue
      pending.set(key, { chunk: chunks[i], hasNext })
    }
  }
  if (pending.size === 0) return

  const ctrl = new AbortController()
  prefetchAbort = ctrl
  prefetchRunning = true
  void (async () => {
    try {
      // 辞書が無いまま焼くと、素の読みが控えへ入って**あとから辞書が取れても崩れたまま鳴る**
      // （`synthesizeChunk` が書き込み直前に見比べて弾くので誤読は固定されないが、
      // 投機ぶんが丸ごと無駄になる）。
      await loadSpeechDicts(() => { /* 取れなくても本再生と同じ扱いで進む */ })
      const items = [...pending.values()]
      /** 続けて焼けなかった件数（{@link PREFETCH_MAX_CONSECUTIVE_FAILURES}）。 */
      let consecutiveFailures = 0
      for (let i = 0; i < items.length; i++) {
        // **1 件ごとに見直す。** 読み上げが始まっていれば、そこで降りる。
        // **残り全部を諦めた件数として数える。** 1 件ずつしか数えないと、
        // 「焼けた数＋諦めた数」が試みた数と合わず、効きを読む数字として使えない。
        if (ctrl.signal.aborted || isSpeaking()) { prefetchAborted += items.length - i; return }
        const { chunk, hasNext } = items[i]
        /**
         * **この 1 件だけを打ち切るための持ち手。バッチ全体の `ctrl` とは分ける。**
         *
         * 上限（{@link PREFETCH_SYNTH_TIMEOUT_MS}）で `ctrl` を止めてしまうと、`AbortController`
         * は一度 abort すると戻せないので、**残りの未処理チャンクまで巻き添えで打ち切られる**。
         * 止めたいのは詰まった 1 件で、そのバッチ全部ではない（作り置き `warmFixedPhrases` も
         * 1 件ごとに持ち手を分けている）。
         *
         * バッチ全体の打ち切り（本番の読み上げが始まった・再生が切り替わった）は `ctrl` から
         * ここへ中継する。
         */
        const itemCtrl = new AbortController()
        const relayAbort = () => itemCtrl.abort()
        ctrl.signal.addEventListener('abort', relayAbort, { once: true })
        // 順番が回ってきてから張るのは作り置きと同じ（待ち時間を持ち時間に数えない）
        const timer = setTimeout(() => itemCtrl.abort(), PREFETCH_SYNTH_TIMEOUT_MS)
        try {
          const buf = await synthesizeChunk(baseUrl, chunk, speakerId, ctx, itemCtrl.signal, hasNext, true)
          if (buf) {
            prefetchSynthesized++
            consecutiveFailures = 0
          } else {
            // **焼けなかった分はここで数える**（上限で諦めた・合成が失敗した・打ち切られた）。
            // ループ先頭の判定は「次へ進む前」にしか効かないので、これが無いと合計が合わない。
            prefetchAborted++
            // **バッチ全体が打ち切られたのなら、それは「焼けなかった」ではない。** 本番の
            // 読み上げが始まった・再生が切り替わった、であって VOICEVOX の不調ではないので、
            // 下の「続けて焼けなかった」に数えると記録が原因を取り違えて語る。
            if (ctrl.signal.aborted) { prefetchAborted += items.length - i - 1; return }
            // 続けて焼けないならバッチごと降りる（理由は {@link PREFETCH_MAX_CONSECUTIVE_FAILURES}）
            if (++consecutiveFailures >= PREFETCH_MAX_CONSECUTIVE_FAILURES) {
              prefetchAborted += items.length - i - 1
              log.debug(`[VoiceVox] 投機を続けて ${consecutiveFailures} 件焼けなかったため、このバッチを降りる`)
              return
            }
          }
        } finally {
          clearTimeout(timer)
          ctrl.signal.removeEventListener('abort', relayAbort)
        }
      }
    } catch (err) {
      // **中断（正常系）と実装の誤りを分ける。** 一緒くたに debug へ落とすと、読み上げ文の
      // 組み立てに潜む不具合で投機が一度も動かなくなっても、本番では何も残らない
      // （`synthesizeChunk` の catch が同じ区別をしているのと揃える）。
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.debug('[VoiceVox] 投機の先行合成を中断した')
      } else {
        warnPrefetchLoopFailed(() => log.warn('[VoiceVox] 投機の先行合成が例外で終わった', err))
      }
    } finally {
      // **自分がまだ現役のときだけ降ろす。** 打ち切られた後は
      // {@link abortSpeechPrefetch} が同期で降ろし済みで、そこへ新しいバッチが始まっている
      // ことがある —— 条件を付けずに書くと、**走り出したばかりの次のバッチの旗を倒す**。
      if (prefetchAbort === ctrl) {
        prefetchRunning = false
        prefetchAbort = null
      }
    }
  })()
}

/**
 * 投機の合成を打ち切る。**本番の読み上げを始める直前に呼ぶ。**
 *
 * 打ち切っても、その 1 件の応答は返ってくるまで VOICEVOX を占有しうる（`AbortSignal` は
 * 送信済みの要求を取り消せるが、サーバー側の処理が止まる保証はない）。それでも呼ぶのは、
 * **残りのキューを止められる**のが大きいため —— 数十件が並んでいれば、そちらの影響が桁違い。
 */
export function abortSpeechPrefetch(): void {
  if (!prefetchAbort) return
  try { prefetchAbort.abort() } catch { /* 二重 abort は無視 */ }
  prefetchAbort = null
  // **旗はここで同期に降ろす。** ループの `finally` まで待つと、そこへ届くのは中断された
  // 要求の拒否がマイクロタスクとして処理された後 —— つまり**次の投機が「まだ走っている」と
  // 誤認されて黙って見送られる**。再生を切り替えた直後の 1 回目がまさにそれで、
  // いちばん効いてほしい区間の立ち上がりで 1 周期ぶん空振りする。
  // ループ側は「自分がまだ現役なら」を確かめてから降ろすので、二重には書かない。
  prefetchRunning = false
}

/**
 * テスト用に「最後に音が止んだ時刻」を捨てる（本番経路では呼ばない）。
 *
 * {@link isAudioPlaying} は音が途切れてから {@link AUDIO_GAP_GRACE_MS} のあいだ真を返す。
 * この値はモジュールに居座るので、**前のテストで鳴らした音の余韻が次のテストへ持ち越される** ——
 * 「1 音も鳴っていない」状況を作ったつもりが `isAudioPlaying()` が真を返し、合成待ちの予算が
 * 消費されないまま待ち続ける（→ {@link SPEECH_SYNTH_BUDGET_MS}）。
 */
export function __resetAudioPlaybackStateForTest(): void {
  lastAudioEndedAt = 0
}

/** テスト用に投機の状態を捨てる（本番経路では呼ばない）。 */
export function __resetSpeechPrefetchForTest(): void {
  abortSpeechPrefetch()
  prefetchRunning = false
  prefetchSynthesized = 0
  prefetchAborted = 0
}

/** テスト用に作り置きを捨てる（本番経路では呼ばない）。 */
export function __resetFixedPhrasesForTest(): void {
  for (const entry of fixedPhrases.values()) entry.abort()
  fixedPhrases.clear()
  fixedPhraseScope = ''
  fixedPhraseTargets = []
}

/**
 * テスト用に辞書エントリのキャッシュを捨てる（本番経路では呼ばない）。
 *
 * {@link phraseBreakCache} はモジュールに居座るため、同じファイル内の別のテストが**同じ辞書キーを
 * 別の句数で使うと、先に走ったテストの結果を掴む**。実行順に依存する不安定なテストになるので、
 * 代役の応答を差し替えるテストは毎回これで捨てること。
 */
export function __resetPhraseBreakCacheForTest(): void {
  phraseBreakCache.clear()
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

/** 音が途切れてから「まだ鳴っている」と見なす猶予（→ {@link isAudioPlaying}）。 */
const AUDIO_GAP_GRACE_MS = 1000

/**
 * いま**音が出ているか**（合成待ちは含まない）。
 *
 * 使うのは**鳴っている読み上げを切らないための待ち**（`useLiveEventHandler` の
 * `capSpeechWait`）。{@link isSpeaking} とは問いが違うので使い分けること ——
 * あちらは「読み上げの処理中か」で合成待ちも真になる。**待ちの判定にあちらを使うと、
 * 合成が無応答でハングしたときにこそ「鳴っている」と誤認して待ち続ける**（打ち切りの
 * 保険が要るのは、まさにその場面）。
 *
 * **チャンクの切れ目は跨ぐ。** 正常な読み上げは次のチャンクを先行合成して詰めて鳴らすので
 * 切れ目はほぼ無いが、合成が少し遅れると一瞬だけ音源が空になる。そこで偽へ落とすと、
 * 鳴っている読み上げを切らないという目的を取りこぼす。**逆に猶予を合成の上限
 * （{@link CHUNK_SYNTH_TIMEOUT_MS}）まで延ばさないのは、そこまで音が途切れているなら
 * 「詰まっている」と見て打ち切る側が正しいため。**
 */
export function isAudioPlaying(): boolean {
  if (activeSources.length > 0) return true
  // 一度も鳴っていなければ猶予も無い（`performance.now()` はページ読み込みからの経過なので、
  // 起動直後は差が小さく、初期値 0 のままだと真に見えてしまう）
  if (lastAudioEndedAt === 0) return false
  return performance.now() - lastAudioEndedAt <= AUDIO_GAP_GRACE_MS
}

/**
 * いま読み上げの最中か（合成待ち・チャンクの隙間も含む）。
 *
 * 使うのは**既定の状態へ戻す操作を見送る**側（`App.tsx` の `revertToDefaultTab` とアイドル
 * 復帰 —— 併せてアイドル復帰・EEW 全解除・揺れ検知終了・揺れの可能性の失効の 4 経路）。
 * 声が流れている間は「離席した」と見なさない
 * （→ docs/spec/audio-tts-spec.md §6「読み上げている間は既定の状態へ戻さない」）。**「音が鳴っているか」ではなく「読み上げの本数」で答える**理由は
 * `speakingCount` の注記。
 */
export function isSpeaking(): boolean {
  if (speakingCount <= 0) return false
  if (performance.now() - speakingSince <= SPEECH_STALE_MS) return true
  // **終わらなくなったら、読み上げ中の扱いを解ける。** ここへ来た時点で何かが壊れているが、
  // 真を返し続けると既定の状態へ戻る仕組みごと止まる（→ {@link SPEECH_STALE_MS}）。
  // **記録は 1 度だけ。** この関数はアイドル復帰の周期で呼ばれるので、毎回出すとログが埋まる。
  if (!speakingStaleWarned) {
    speakingStaleWarned = true
    // **何が詰まったのかを添える。** 発話の中身は既定で無効な詳細ログにしか出ないので、
    // これが無いと本番でこの警告を見ても、どの読み上げで起きたのか分からない。
    const head = speakingLastText.length > 30 ? `${speakingLastText.slice(0, 30)}…` : speakingLastText
    log.warn(`[VoiceVox] 読み上げが ${Math.round(SPEECH_STALE_MS / 1000)} 秒を超えても終わらないため、読み上げ中の扱いを解除しました（最後の発話: ${head}）`)
  }
  return false
}

/**
 * 読み上げが 1 本も無くなったときの通知を購読する。戻り値を呼ぶと解除する。
 *
 * **呼ぶのは「最後の 1 本が終わった瞬間」だけ。** 続けて別の読み上げが始まっている間は呼ばない
 * （鳴っている最中に計り直しても、そのぶん復帰が遅れるだけで意味が無い）。
 */
export function onSpeechIdle(listener: () => void): () => void {
  speechIdleListeners.add(listener)
  return () => { speechIdleListeners.delete(listener) }
}

/**
 * 読み上げが途切れたことを購読者へ伝える。
 *
 * **1 人の失敗で残りへ届かなくしない。** 届かなかった購読者は計り直しの契機を失い、症状は
 * 「タブが戻らない」という静かな形で出る。
 */
function notifySpeechIdle(): void {
  for (const listener of speechIdleListeners) {
    try {
      listener()
    } catch (err) {
      log.warn('[VoiceVox] 読み上げ終了の通知に失敗', err)
    }
  }
}

// 予約したチャンクが鳴り始める何秒前に {@link ShouldStillPlay} を見直すか。
// チャンクは切れ目を作らないよう前のチャンクの終わりに合わせて**先に**予約するため、
// 予約した時点だけで判定すると 1 チャンク分（実測 1 秒強）先の未来を判定してしまう。
const PRE_START_CHECK_LEAD_SEC = 0.05

/**
 * 鳴っている読み上げを止め、進行中の合成を打ち切る。**語の途中でも止まる。**
 *
 * {@link speakWithVoicevox} の冒頭が行う割り込みのうち、「止める」部分だけを次の発話を
 * 伴わずに実行する。使うのは予報から警報への言い直し（`useLiveEventHandler` の
 * `chainEEWSpeech`）で、狙いは**発話の順番を崩さずに待ちを短くすること**。
 *
 * 言い直しを「前の発話を待たずに投入する」形で実装すると、待ち行列に並んでいた別の EEW の
 * 予約が前の発話の完了で解放され、**始まったばかりの言い直しを後ろから消してしまう**
 * （止める行為そのものが解放のスイッチになる）。先に音だけ止めて自分は順番どおりに並べば、
 * 1 本のチェーンで直列化する前提を壊さずに済む。
 *
 * **これ自体は無音を作る。** 呼ぶ側は続けて読むものを用意しておくこと。止めてから次を読むまでの
 * 間に対象が取り消されて読むものが無くなることはあるが、そのときは誤報取消の読み上げが別途
 * 流れるため情報は欠けない。
 */
export function stopSpeech(): void {
  for (const src of activeSources) {
    try { src.stop() } catch { /* already stopped */ }
  }
  activeSources = []
  // **ここでも控える。** `onended` は `stop()` から非同期に発火するので、それだけに任せると
  // 止めた直後の一瞬だけ {@link isAudioPlaying} が「まだ鳴っている」と答える
  // （直前のチャンクの切れ目で起点が更新されていた場合）。
  lastAudioEndedAt = performance.now()
  if (currentAbortController) {
    try { currentAbortController.abort() } catch { /* 二重 abort は無視 */ }
  }
  // 進行中のパイプライン（合成 → 予約のループ）も降ろす。これが無いと、止めた後に残りの
  // チャンクが予約され直して鳴り続ける（ループは `currentSessionId` の一致で自分の世代を見る）。
  currentSessionId++
}

/**
 * 読み上げ 1 本の結末。
 *
 * **「終わったか」ではなく「鳴ったか」を返すために要る。** この関数は例外を投げない設計で、
 * VOICEVOX 未起動・ネットワーク断・話者 ID 不正のいずれでも正常終了する。呼び出し側が
 * 戻り値を見ないと「読み上げが完了した」と区別できず、**1 音も出ていないのに既読を進める**。
 */
export type SpeechOutcome = {
  /**
   * 1 チャンクでも実際に鳴ったか。
   *
   * 偽になるのは 2 通り —— 合成が 1 つも成功しなかった場合と、鳴り始める前にすべて
   * 取り下げた場合（`shouldStillPlay` が偽を返した）。**どちらも「声になっていない」**ので、
   * 既読を進める側から見れば同じ扱いでよい。
   */
  spoke: boolean
}

/**
 * テキストを VOICEVOX で合成して再生する（パイプライン方式）。
 * テキストを句読点で分割し、最初のチャンクが合成できた時点で再生を開始する。
 * 再生中の音声があれば割り込み停止して新しいものを再生する。
 * VOICEVOX 未起動・ネットワーク失敗時は無音で終了する（例外スローなし）。
 *
 * @param shouldStillPlay 各チャンクを鳴らす直前に呼ぶ妥当性の判定（省略時は常に鳴らす）
 */
export function speakWithVoicevox(...args: Parameters<typeof speakOnce>): Promise<SpeechOutcome> {
  // 読み上げの本数を数えるのはここ（{@link isSpeaking}）。**本体の中に置かない** —— 本体は
  // 途中で抜ける経路を複数持っていて、経路を足したときに減算を書き忘れると数が下がらず、
  // 既定の状態へ二度と戻らなくなる。包んでおけば書き忘れようがない。
  // **起点は呼ばれるたびに引き直す**（理由は {@link SPEECH_STALE_MS}）。読み上げが続いて
  // いる限り解けず、新しい読み上げが始まらないまま時間だけ過ぎたときに解ける。
  speakingSince = performance.now()
  speakingStaleWarned = false
  speakingLastText = args[1]
  speakingCount++
  return speakOnce(...args).finally(() => {
    speakingCount--
    if (speakingCount === 0) notifySpeechIdle()
  })
}

/** {@link speakWithVoicevox} の本体。読み上げの本数を数えるのは包む側の責務。 */
async function speakOnce(
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
): Promise<SpeechOutcome> {
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

  // 投機の合成も止める（→ {@link abortSpeechPrefetch}）。**先行合成より件数が多い**ので、
  // 止め忘れると数十件が VOICEVOX の直列処理に並んだまま、これから読む方が後ろで待つ。
  abortSpeechPrefetch()

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
  await loadSpeechDicts((err) => {
    log.debug('[VoiceVox] 句区切り辞書の取得に失敗（区切りなしで読み上げ）', err)
  })
  if (currentSessionId !== sessionId) return { spoke: false }  // 辞書待ちの間に割り込まれた

  const ctx = getAudioContext()
  if (!ctx) {
    log.debug('[VoiceVox] スキップ (AudioContext なし)')
    return { spoke: false }
  }
  if (ctx.state === 'suspended') await ctx.resume()
  // soundEnabled が無効でも voicevoxEnabled だけで読み上げは鳴る（AUD-7）。この経路が
  // alertSound 側の再生関数を一度も通らない端末があるため、ここでもキープアライブの
  // 生死を確かめる（詳細は syncKeepAlive() のコメント）
  syncKeepAlive()

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
    const built = await synthesizeChunkWithStatus(baseUrl, chunks[0], speakerId, ctx, signal, chunks.length > 1)
    // 作り置きの更新に失敗しても読み上げ自体は成立させる（この関数は例外を投げない約束）
    if (built?.cacheable) {
      try {
        rememberFixedPhrase(baseUrl, speakerId, chunks[0], built.buffer)
      } catch (err) {
        log.debug('[VoiceVox] 作り置きの更新に失敗（読み上げは続行）', err)
      }
    }
    return built?.buffer ?? null
  })()

  // 次のチャンクを再生開始する予定時刻（AudioContext の時間軸）
  let scheduleAt = -1

  // 全チャンクの再生完了を待つための Promise（呼び出し元が await できる）
  let completionResolve!: () => void
  const completionPromise = new Promise<void>(r => { completionResolve = r })

  // 予約したチャンクと、その開始時刻（AudioContext の時間軸）。`dropped` は鳴らすのを
  // 取り下げた印、`ended` は再生が終わった印。完了を待つ対象を選ぶためにも使う。
  const scheduled: { source: AudioBufferSourceNode; startAt: number; dropped: boolean; ended: boolean }[] = []

  /**
   * ここまでに 1 チャンクでも鳴ったか（{@link SpeechOutcome}）。**取り下げられていない予約が
   * 1 つでもあれば鳴った**と見なす —— 予約は再生の開始時刻付きで積まれ、落とすときは
   * `dropped` が立つため。
   */
  const outcome = (): SpeechOutcome => ({ spoke: scheduled.some(s => !s.dropped) })
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

  // この発話で合成を待てる残り（{@link SPEECH_SYNTH_BUDGET_MS}）。
  //
  // **起点は関数の開始（`startedAt`）で、合成ループの入口ではない。** 手前には辞書の取得待ち
  // （最大 5 秒）がある。そこを数えないと、辞書が遅い日に「予算 6 秒」のつもりで実際には
  // 11 秒待つことになり、**発話チェーン側の上限（8 秒）が先に尽きて「鳴っている最中」と
  // 誤認される** —— 1 音も出ていないのに既読が進む。
  const synthBudgetMs = synthBudgetRelaxed ? RECORDING_SYNTH_BUDGET_MS : SPEECH_SYNTH_BUDGET_MS
  let synthBudgetLeftMs = Math.max(0, synthBudgetMs - (performance.now() - startedAt))

  for (let i = 0; i < chunks.length; i++) {
    if (currentSessionId !== sessionId) { completionResolve(); return outcome() }  // 割り込みされた

    // **上限つきで待つ。** 1 チャンクの上限（{@link CHUNK_SYNTH_TIMEOUT_MS}）と、この発話で
    // 合成を待てる残りの予算（{@link SPEECH_SYNTH_BUDGET_MS}）の短い方。超えたら合成失敗と
    // 同じ扱いにして進む —— 待ち続けると、この読み上げが完了も失敗もしないまま宙に浮く。
    //
    // **ただし音が出ている間は予算を見ない。** 宙吊りの誤認はチェーン側（`capSpeechWait`）が
    // 同じ判定で待ちを延ばすことで防がれており、鳴っている最中の待ちまで予算に数えると
    // 「合成が再生に追いつかないだけ」で以降のチャンクが丸ごと無音になる（理由は
    // {@link SPEECH_SYNTH_BUDGET_MS}）。この判定を消すときは、あちらの注記も併せて見ること。
    //
    // **差し引くのは合成を待った分だけ。** 鳴っている時間は数えないので、正常な読み上げが
    // どれだけ長くても予算は減らない（先行合成は再生と並行して走り、待ちはほぼ 0 になる）。
    // 計るのは `performance.now()`（単調増加）。壁時計は NTP 補正・スリープ復帰で前後する。
    //
    // **待ちの前後の両方で見て、片方でも偽なら消費する。** 待っている最中に音が尽きた場合は
    // 「鳴っている間の待ち」とは言えないので、安全側（消費する）へ倒す。
    //
    // **「この発話が鳴ったか」まで見る。`isAudioPlaying()` だけでは足りない。** あちらは音が
    // 止んでから {@link AUDIO_GAP_GRACE_MS} のあいだ真を返し、しかも `lastAudioEndedAt` を
    // 更新するのは `onended`（非同期）—— **割り込みで止めた前の発話の `ended` が、この発話の
    // 最初の待ちの最中に発火する**。そのとき 1 音も鳴らしていないのに免除が働き、予算が
    // いちばん効くべき「最初の合成が返るか」の瞬間だけ素通りする。
    // 予約が 1 つでもあれば、この発話は鳴り始めている（`outcome()` と同じ述語）。
    const playingBeforeWait = scheduled.some(s => !s.dropped) && isAudioPlaying()
    const waitStartedAt = performance.now()
    const buffer = await raceSynthTimeout(
      nextBufferPromise,
      playingBeforeWait ? CHUNK_SYNTH_TIMEOUT_MS : Math.min(CHUNK_SYNTH_TIMEOUT_MS, synthBudgetLeftMs),
      synthBudgetMs,
    )
    if (!(playingBeforeWait && isAudioPlaying())) {
      synthBudgetLeftMs = Math.max(0, synthBudgetLeftMs - (performance.now() - waitStartedAt))
    }
    if (currentSessionId !== sessionId) { completionResolve(); return outcome() }  // await 中に割り込み
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
      // 空になった瞬間を控える（→ {@link isAudioPlaying} の猶予の起点）
      if (activeSources.length === 0) lastAudioEndedAt = performance.now()
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
  return outcome()
}

/**
 * 複数の文を**別々の読み上げとして順に鳴らす**。前の文が鳴り終わってから次を始める。
 *
 * **1 つの文字列へ繋げて {@link speakWithVoicevox} へ渡すのとは鳴り方が違う。** 繋げると文の
 * 境目がチャンクの途中になり、末尾の句読点に {@link CHUNK_BREAK_PAUSE} の間が入る。別々に
 * 渡せばそれぞれの末尾が「最後のチャンク」になり、間は入らない。
 *
 * **前の文が誰かに止められていたら、そこで降りる。** {@link speakWithVoicevox} は呼ばれる
 * たびに既存の再生を止め、止められた側は例外ではなく正常終了で返る。気づかずに次の文を
 * 鳴らすと、**今度はこちらが相手を止める**。相手は同じ列とは限らない —— 緊急地震速報の
 * 読み上げは {@link speakWithVoicevox} を直接呼ぶので（`useLiveEventHandler`）、警報の声を
 * この列の続きが上書きしうる。
 *
 * 見るのは**自分が始めた再生がまだ最新か**（`currentSessionId`）。「この関数の何回目の
 * 呼び出しか」で見ると、この関数を通らない読み上げに割り込まれても気づけない。
 *
 * **試聴の連打（同じ列どうしの止め合い）は単体テストで固定できていない。** 守る仕組みは
 * 同じだが、合成と再生を偽物に差し替えた `voicevox.test.ts` の環境では、判定を外しても
 * 止め合いが再現しない（止められた側が合成のループに留まって次の文へ進まない）。実機で
 * 確かめたときは、判定が無い版で試聴を 1 文目の後半で 2 度押すと**2 度目の「〇〇で地震。」が
 * `ERR_ABORTED` で消え**、代わりに 1 度目の続きが鳴った。判定を入れた版では 2 度目が最後まで
 * 鳴る。**連打まわりを触るときは実機で同じ確かめ方をすること。**
 */
export async function speakSequentially(
  baseUrl: string, texts: readonly string[], speakerId: number, volume: number,
): Promise<void> {
  for (const text of texts) {
    const playing = speakWithVoicevox(baseUrl, text, speakerId, volume)
    // セッションの採番は `speakWithVoicevox` の同期部分で済む。**await より前に読むこと。**
    const mine = currentSessionId
    await playing
    if (currentSessionId !== mine) return
  }
}
