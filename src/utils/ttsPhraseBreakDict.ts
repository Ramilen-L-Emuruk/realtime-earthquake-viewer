import { fetchJsonWithTimeout } from './fetchJson'
import { getTtsStationReadingsCache } from './ttsStationReadings'
import { getTtsEpicenterAccentsCache } from './ttsEpicenterAccents'

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
// _standalone に列挙されたキー（単独で現れたときだけ一致させるもの）の集合。{@link findPhraseBreakMatch} で使う。
let standaloneKeysCache: Set<string> = new Set()
let inflight: Promise<Record<string, string>> | null = null

/**
 * 単独語キーの前後で「地名が続いている」と見なす文字。漢字（`\p{Script=Han}`。拡張漢字も含む）と、
 * 地名中で漢字を繋ぐ「〆ヶヵ」。「々〇」は `\p{Script=Han}` に含まれるので足す必要がない。
 *
 * ひらがな・カタカナを含めないのは、読み上げ文では単独の予報区名にも助詞が直に付くため
 * （「佐渡に津波注意報」「佐渡で10センチ」）。これらを語の続きと見なすと肝心の場面で一致しなくなる。
 */
const WORD_CONTINUATION = /[\p{Script=Han}\u3006\u30F5\u30F6]/u

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
    inflight = fetchJsonWithTimeout<Record<string, string> & { _terms?: string[]; _standalone?: string[] }>(
      DATA_URL,
      'tts-phrase-break-dict',
      // 取れなくても読み上げの句区切りが効かないだけで地図は変わらないため、
      // 地図に重ねる取得状況表示には数えない。
      { timeoutMs: DICT_FETCH_TIMEOUT_MS, trackStatus: false },
    )
      .then((data) => {
        const { _comment: _, _terms, _standalone, ...dict } =
          data as Record<string, string> & { _terms?: string[]; _standalone?: string[] }
        termKeysCache = new Set(_terms ?? [])
        standaloneKeysCache = new Set(_standalone ?? [])
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
 * 辞書キーが「単独語キー」かどうかを返す。`_standalone` に列挙されたものと、
 * **震度観測点名の読み（生成辞書）のキー全部**が該当する。
 *
 * 短いキーはより長い地名の一部にもなる（「佐渡」は「佐渡市小木」「新潟県佐渡」にも含まれる）。
 * 長い側は VOICEVOX が正しく読めることも多く、素の部分一致で拾うと正しい読みを語中で切ってしまうため、
 * 単独で現れたときだけ一致させる。
 *
 * **生成辞書のキーを一律で単独語キーにするのは、長い側が辞書に無い組があるため。** 生成辞書は誤読する点だけを
 * 収録するので、`宮古島市下地`（誤読・収録）と `宮古島市下地島空港`（正しく読める・未収録）のような組が
 * できる。素の部分一致だと短い側が拾われ、**正しく読めていた観測点名が語中で切られる**（さらに
 * `DICT_TRAILING_PAUSE` まで挟まる）。読み上げ文では観測点名が必ず全部形で現れ、後ろに来るのは
 * 読点か「では」なので、境界判定を掛けても本来の一致は失わない
 * （→ `docs/spec/audio-tts-spec.md` §3「震度観測点名の読み」）。
 */
export function isStandaloneKey(key: string): boolean {
  if (standaloneKeysCache.has(key)) return true
  return has(getTtsStationReadingsCache(), key) || has(getTtsEpicenterAccentsCache(), key)
}

const has = (dict: Record<string, string> | null, key: string): boolean =>
  dict != null && Object.prototype.hasOwnProperty.call(dict, key)

/**
 * 単独語キーが「地名の一部でない位置」に現れる最初の位置を返す。無ければ -1。
 * 前後のどちらかが {@link WORD_CONTINUATION} なら、より長い地名の一部と見て次の出現を探す。
 *
 * 判定は渡された文字列の中だけで行う。`buildAccentPhrases`（voicevox.ts）は一致箇所でテキストを
 * 分割して再帰するため、**分割後の先頭では「直前の文字」が失われる**。これが問題になるのは
 * 「別の辞書キー＋区切り文字なしで単独語キー」という並びのときだけで、読み上げ文は地名を必ず
 * 読点で繋いでいる（ttsText.ts）ため現状は起きない。単独語キーを増やすときはここを見直すこと。
 *
 * **2026-09-10 に単独語キーの母数が 3 件から 2400 件超へ増えた**（観測点名を一律で扱うようにした
 * ため。→ {@link isStandaloneKey}）。上の根拠は「読み上げ文が地名を読点で繋ぐこと」なので母数が
 * 増えても変わらないが、地名を繋ぐ文の作り方を変えるときはここが効く範囲も併せて見ること。
 */
function indexOfStandalone(text: string, key: string): number {
  for (let from = 0; from <= text.length - key.length; ) {
    const index = text.indexOf(key, from)
    if (index < 0) return -1
    if (!WORD_CONTINUATION.test(charBefore(text, index))
      && !WORD_CONTINUATION.test(charAfter(text, index + key.length))) return index
    from = index + 1
  }
  return -1
}

/**
 * 数字で始まる鍵か（`0時`・`17日`・`27分頃`）。**前が数字なら一致させない**ために使う。
 *
 * 曖昧なもの（日付か期間かで読みが変わる「1日」）は辞書に置かず、生成側で読みを確定させる
 * （`ttsText` の `speakableDay`）。辞書は文字列しか見ないので、曖昧なものを入れると文脈を
 * 見誤り、境界の条件を足し続けることになる。残ったこれらの鍵に期間の用法は無い
 * （「0分程度」「0時間」とは言わない）ので、**見るのは前だけでよい**。
 *
 * 分は読み上げ文では「N分頃」、実電文の見出し文では「N分現在の、…」（津波観測情報）の形で出る。
 * 前者は連濁（`ゴロ`）が落ちないよう「頃」まで鍵に含めるが、後者まで鍵にすると助詞の「の」が
 * 独立したアクセント句になって浮く（実測）。そこで**数字の部分だけを鍵にし、後続で絞る**。
 */
const NUMERIC_KEY = /^[0-9]{1,2}(?:日|時|分|分頃|分ころ)$/

/**
 * 数字で始まる鍵が、前が数字でない位置に現れる最初の位置を返す。無ければ -1。
 *
 * **前が数字なら一致させない。** `0時` は `10時` `20時` の 2 文字目にも現れ、そのままだと
 * 「イチ／レイジ」と読まれる（実際に起きた）。`0分` も `10分`〜`50分` で同じ。
 *
 * **`17日` のような 2 桁の鍵にも同じガードを掛ける。** `117日` の 2 文字目に当たると
 * 「イチ｜ジュウシチニチ」と数値そのものを割って読む。いまは `normalizeDateTimeForSpeech`
 * が 3 桁以上の数字を半角化しないので届かないが、**別々の正規表現が暗黙に支え合う形**に
 * なるのを避ける。
 *
 * {@link indexOfStandalone} と同じく、**分割後の断片では「直前の文字」が失われる**。
 * いまの読み上げ文では数字の直前に必ず「日」「時」が挟まるので実害は無いが、
 * この判定を使う鍵を増やすときは見直すこと。
 */
function indexOfNumericKey(text: string, key: string): number {
  for (let from = 0; from <= text.length - key.length; ) {
    const index = text.indexOf(key, from)
    if (index < 0) return -1
    if (!/[0-9０-９]/.test(charBefore(text, index))) return index
    from = index + 1
  }
  return -1
}

/**
 * `index` の直前・直後の 1 文字を返す（範囲外なら空文字）。
 *
 * `text[i]` ではなくコードポイント単位で取るのは、拡張漢字（U+10000 以降）がサロゲートペアで
 * 表されるため。`text[i]` だとその片割れだけが返り、{@link WORD_CONTINUATION} の漢字判定が
 * 常に外れる（片割れは Han と判定されない）。
 */
function charBefore(text: string, index: number): string {
  if (index <= 0) return ''
  const prev = text.charCodeAt(index - 1)
  const isLowSurrogate = prev >= 0xDC00 && prev <= 0xDFFF
  return isLowSurrogate && index >= 2 ? text.slice(index - 2, index) : text[index - 1]
}

function charAfter(text: string, index: number): string {
  const code = text.codePointAt(index)
  return code == null ? '' : String.fromCodePoint(code)
}

/**
 * テキスト内に辞書のキーが含まれるか調べ、最初に出現する位置のものを返す。
 * 複数キーが同じ位置から始まる場合は長い方を優先する。見つからなければ null。
 * 単独語キー（{@link isStandaloneKey}）は地名の一部になっている出現を飛ばし、
 * 数字で始まる鍵（{@link NUMERIC_KEY}）は前が数字でない位置だけを拾う。
 */
export function findPhraseBreakMatch(
  text: string,
  dict: Record<string, string>,
): { key: string; index: number } | null {
  let best: { key: string; index: number } | null = null
  for (const key of Object.keys(dict)) {
    const index = NUMERIC_KEY.test(key)
      ? indexOfNumericKey(text, key)
      : isStandaloneKey(key) ? indexOfStandalone(text, key) : text.indexOf(key)
    if (index < 0) continue
    if (best == null || index < best.index || (index === best.index && key.length > best.key.length)) {
      best = { key, index }
    }
  }
  return best
}
