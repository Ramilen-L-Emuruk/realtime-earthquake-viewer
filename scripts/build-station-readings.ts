// 観測点名の読み上げ用辞書の生成。
//
// 気象庁が公開しているふりがなから、**音声合成エンジンが誤読する点だけ**を集めてカナの辞書にする。
// 誤読すると別の場所を伝えることになる（`札幌北区太平` →「オオヒラ」、`千歳市北栄` →「キタサカエ」、
// `宮城沖５０ｋｍＢ` →「ゴジュウ クムビイ」）。
//
//   npm run build-station-readings
//   npm run build-station-readings -- --engine http://192.168.1.10:50021 --speaker 3
//
// 【列挙元は 2 つ】声になる観測点名は 2 系統ある。どちらも同じ手順（読み上げ文の形で読ませ、
// ふりがなと食い違うものを収録する）に掛けるが、**ふりがなの形が違う**ので正解の作り方が分かれる。
//
//   | 列挙元 | 声になる場面 | ふりがな |
//   |---|---|---|
//   | 震度観測点（4372 点） | 「5弱以上・未入電」の地点名 | 純粋なかな |
//   | 潮位観測点（609 点） | 津波の観測情報の観測点名 | 沖合だけ距離・単位・英字が生のまま |
//
// 【エンジンが要る】「どれを誤読するか」は実際に読ませないと判らない。**全点を収録すれば
// エンジン不要で決定的に作れるが、正しく読めている点までカナ経由になり、そこでアクセントと
// 句切れが崩れる**（カナは核の位置を持たないため）。誤読する点だけに絞るほうが音が保たれる。
// 判定の結果は出力に焼き込まれるので、**他の環境で作り直す必要はない**。
//
// 【全点を収録しない理由はもう 1 つある】読み上げ辞書は「誤読するものだけ収録」が既存の方針
// （docs/spec/audio-tts-spec.md §3）。エンジンが正しく読める語を辞書へ入れると、エンジン側の
// 改善が届かなくなる。
//
// 出力: public/data/tts-station-readings.json
//   { "札幌北区太平": "サッポロキタクタイヘイ'", "宮城沖５０ｋｍＢ": "ミヤギ'オキ/ゴジュッキロメ'エトル/ビ'イ" }
//
// データ出典:
//   - 震度観測点一覧表（iku55 氏が JSON 化したものを利用）
//     https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1
//   - 気象庁 防災情報XML 個別コード表（PointTsunami）
//     https://xml.kishou.go.jp/tec_material.html

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasUnreadableFurigana, normalizeReading, stripReadingTail, toKanaEntry } from './stationReading'
import { classifyTsunamiStation, offshoreExpectedReading, splitDistance } from './tsunamiStationReading'
import type { TsunamiStationShape } from './tsunamiStationReading'
import { findWorkbookInZip } from './lib/xlsx.mjs'

/**
 * 震度観測点一覧の取得元。**`build-station-coords.mjs` と同じ URL を指す。**
 * 座標側は素の node で動かす規定（`node scripts/build-station-coords.mjs`）のため、
 * このスクリプト（tsx 実行）から定数を共有できない。食い違いは
 * `scripts/stationReadings.test.ts` が両ファイルを読んで検査する。
 */
export const SOURCE_URL =
  'https://gist.githubusercontent.com/iku55/79005d1896631ad6117bbe327b8162c1/raw/6458684e522767a9ffc42f9bba9d6b2b06253f44/stations.json'

/**
 * 潮位観測点の取得元（気象庁 技術資料ページ）。**`build-tsunami-obs-coords.mjs` と同じ URL を指す。**
 * 個別コード表の zip は URL に更新日が入る（`jmaxml_20260826_Code.zip`）ため、ここから解決する。
 * 座標側が素の node で動く規定なのは震度観測点と同じで、一致は `stationReadings.test.ts` が検査する。
 */
export const JMA_TEC_MATERIAL = 'https://xml.kishou.go.jp/tec_material.html'

/** 個別コード表の中で PointTsunami（潮位観測点）が載るシート。 */
const POINT_TSUNAMI_SHEET = '35'

const DEFAULT_ENGINE = 'http://localhost:50021'
/** 読み（モーラ列）は話者に依らないが、問い合わせに話者の指定が要るので既定を置く。 */
const DEFAULT_SPEAKER = 3
/** エンジンへの同時接続数。増やしても頭打ちで、エンジン側のワーカー数を超えると詰まる。 */
const CONCURRENCY = 8

/**
 * 上流の件数として受け入れる幅。2026-09 時点で震度観測点 4372 点・潮位観測点 609 点
 * （どちらも名前で数えた値。潮位観測点はコード表の行が 611 あり、うち 2 件が内容部と
 * ヘッダ部で同名）。
 * この幅を外れたらスキーマか URL が変わったと見て止める（黙って少ない辞書を作らない）。
 */
const EXPECTED_COUNT_RANGE = { min: 3000, max: 6000 } as const
const EXPECTED_TIDAL_COUNT_RANGE = { min: 450, max: 900 } as const

/**
 * 誤読として収録する割合の上限。これを超えたら判定か正規化が壊れたと見て止める。
 *
 * **上限が要るのは「誤読 0 件」だけが異常ではないから。** 正規化の条件が反転すれば全点が誤読と
 * 判定されうるが、その形は生成物を後から検査するテスト（`scripts/stationReadings.test.ts`）で
 * しか捕まらず、生成コマンドは正常終了してしまう。
 */
const MAX_MISREAD_RATIO = 0.9

/** 読み上げ文が観測点名の後ろに置く形と、その形で末尾に乗る助詞の読み。 */
type SpeechContext = { readonly suffix: string; readonly tail: string }

/**
 * 震度観測点名を読ませる形。**判定はこの形で行い、名前を単体で読ませない。**
 *
 * 誤読は後ろに続く文字で反転する（`docs/spec/audio-tts-spec.md` §3「何を収録するか」）。
 * 未入電の文（`ttsText.ts` の `unreceivedRegionSegments`）は名前を読点で繋ぎ、最後の名前にだけ
 * 「では、」が付く。`tail` はその形で読ませたときにモーラ列の末尾へ乗る助詞の読み。
 */
const STATION_SPEECH_CONTEXTS: readonly SpeechContext[] = [
  { suffix: '、', tail: '' },
  { suffix: 'では、', tail: 'デワ' },
]

/**
 * 潮位観測点名を読ませる形。津波の観測情報の文（`ttsText.ts` の `observationDetailSegments` と
 * それを使う各節）が観測点名の後ろに置くのは、読点か「で〜」の 2 系統。
 *
 * **「で」だけを付けた形では足りない。** エンジンの解析は文全体を見るため、`宮城沖５０ｋｍＢで、`
 * は正しく読めるのに `宮城沖５０ｋｍＢで0.2メートル、` で崩れる（実測）。だから述語まで含めた
 * 実運用の形をそのまま使う。波高の値（0.2）は代表値で、誤読は名前の直後の解析で起きるため
 * どの値でも同じように出る。
 *
 * 「最大波高は観測中です」「微弱です」の類は「で到達を確認しました。」に続く別の文なので、
 * 名前の直後の形としてはここに挙げた 3 通りで尽きている。
 */
const TIDAL_SPEECH_CONTEXTS: readonly SpeechContext[] = [
  { suffix: '、', tail: '' },
  { suffix: 'で到達を確認しました。', tail: 'デトオタツオカクニンシマシタ' },
  { suffix: 'で0.2メートルを観測しました。', tail: 'デレエテンニメエトルオカンソクシマシタ' },
]

/**
 * 上流のスキーマが変わっていないことを確かめる照合。**エンジンには依存させない** ——
 * 誤読するかどうかはエンジンの版で変わるが、気象庁のふりがなは変わらない。
 */
const FURIGANA_FIXTURES: readonly (readonly [string, string])[] = [
  ['石狩市花川', 'いしかりしはなかわ'],
  ['札幌北区太平', 'さっぽろきたくたいへい'],
  ['千歳市北栄', 'ちとせしほくえい'],
  ['神戸灘区八幡町', 'こうべなだくやはたちょう'],
  // 長音を含む点。半角ハイフンで書かれた点（`山鹿市老人福祉センター`）と併せて、
  // 長音の扱いを通る経路をここで固定する。
  ['小諸市文化センター', 'こもろしぶんかせんたー'],
  ['山鹿市老人福祉センター', 'やまがしろうじんふくしせんた-'],
]

/** 潮位観測点側の同じ照合。沿岸・沖合・ヘッダ部の簡略名の 3 つの形をそれぞれ通す。 */
const TIDAL_FURIGANA_FIXTURES: readonly (readonly [string, string])[] = [
  ['浜中町霧多布港', 'はまなかちょうきりたっぷこう'],
  ['竜飛', 'たっぴ'],
  ['宮城沖５０ｋｍＢ', 'みやぎおき５０ｋｍＢ'],
  ['釧路沖１００ｋｍＡ', 'くしろおき１００ｋｍＡ'],
  // ヘッダ部でのみ使う簡略名（識別英字が付かない）。
  ['宮城沖５０ｋｍ', 'みやぎおき５０ｋｍ'],
]

/**
 * 距離部分の読みの照合。**気象庁はここにふりがなを与えていない**ので、
 * 「その部分だけを単独で読ませた読み」を正解として使う（→ {@link offshoreExpectedReading}）。
 * 正解そのものをエンジンから採るため、**この照合がその正解の唯一の裏取り**になる。
 *
 * **数字と識別英字のすべての値を覆うこと。** 一部だけを固定すると、エンジンの版が変わって
 * 覆っていない桁の読み（百の位の連濁など）だけが崩れたときに気づけない ——
 * `entryOf` の再検証は同じ正解と比べるので、**正解ごと崩れれば一致してしまう**（自己参照）。
 * 覆えているかは {@link fetchDistanceReadings} が機械的に確かめ、漏れがあれば生成を止める。
 *
 * 値は日本語として当然の読み。崩れたら正解として使えなくなったということなので生成を止める。
 */
const DISTANCE_READING_FIXTURES: readonly (readonly [string, string])[] = [
  // 十の位（識別英字はＡで代表する）
  ['３０ｋｍＡ', 'さんじゅっキロメートルエー'],
  ['４０ｋｍＡ', 'よんじゅっキロメートルエー'],
  ['５０ｋｍＡ', 'ごじゅっキロメートルエー'],
  ['６０ｋｍＡ', 'ろくじゅっキロメートルエー'],
  ['７０ｋｍＡ', 'ななじゅっキロメートルエー'],
  ['８０ｋｍＡ', 'はちじゅっキロメートルエー'],
  ['９０ｋｍＡ', 'きゅうじゅっキロメートルエー'],
  // 百の位（`１００` は「ひゃっ」・`２００` は「にひゃっ」・`３１０` は「さんびゃく」と連濁する）
  ['１００ｋｍＡ', 'ひゃっキロメートルエー'],
  ['１１０ｋｍＡ', 'ひゃくじゅっキロメートルエー'],
  ['１２０ｋｍＡ', 'ひゃくにじゅっキロメートルエー'],
  ['１３０ｋｍＡ', 'ひゃくさんじゅっキロメートルエー'],
  ['１４０ｋｍＡ', 'ひゃくよんじゅっキロメートルエー'],
  ['１５０ｋｍＡ', 'ひゃくごじゅっキロメートルエー'],
  ['１６０ｋｍＡ', 'ひゃくろくじゅっキロメートルエー'],
  ['１７０ｋｍＡ', 'ひゃくななじゅっキロメートルエー'],
  ['１８０ｋｍＡ', 'ひゃくはちじゅっキロメートルエー'],
  ['１９０ｋｍＡ', 'ひゃくきゅうじゅっキロメートルエー'],
  ['２００ｋｍＡ', 'にひゃっキロメートルエー'],
  ['２２０ｋｍＡ', 'にひゃくにじゅっキロメートルエー'],
  ['２３０ｋｍＡ', 'にひゃくさんじゅっキロメートルエー'],
  ['２４０ｋｍＡ', 'にひゃくよんじゅっキロメートルエー'],
  ['２５０ｋｍＡ', 'にひゃくごじゅっキロメートルエー'],
  ['２６０ｋｍＡ', 'にひゃくろくじゅっキロメートルエー'],
  ['３１０ｋｍＡ', 'さんびゃくじゅっキロメートルエー'],
  // 識別英字（Ａは上で覆っている）
  ['５０ｋｍＢ', 'ごじゅっキロメートルビー'],
  ['５０ｋｍＣ', 'ごじゅっキロメートルシー'],
  ['５０ｋｍＤ', 'ごじゅっキロメートルディー'],
  ['５０ｋｍＥ', 'ごじゅっキロメートルイー'],
  ['５０ｋｍＦ', 'ごじゅっキロメートルエフ'],
  ['４０ｋｍＧ', 'よんじゅっキロメートルジー'],
  // 識別英字が付かない形（ヘッダ部でのみ使う簡略名と、内容部の 2 点）
  ['５０ｋｍ', 'ごじゅっキロメートル'],
]

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'tts-station-readings.json')

type Station = {
  name?: string
  furigana?: string
  pref?: { name?: string }
}

/**
 * 照合の対象。列挙元が違っても、この形へ揃えてから同じ手順（読ませる → 期待と比べる →
 * 誤読なら値を作る）に掛ける。
 */
type Target = {
  /** 列挙元の名前。記録に出して、どちらの経路で拾った点かが判るようにする。 */
  readonly source: string
  readonly name: string
  /** 気象庁のふりがな。記録と検査に使う（沖合は距離部分がカナ化されていない）。 */
  readonly furigana: string
  /** 期待する読み（{@link normalizeReading} 済み）。 */
  readonly expected: string
  readonly contexts: readonly SpeechContext[]
  /** 誤読だったときに辞書へ入れる値を作る。**誤読した点だけで呼ぶ。** */
  readonly entryOf: () => Promise<string>
}

function parseArgs(argv: readonly string[]): { engine: string; speaker: number } {
  let engine = DEFAULT_ENGINE
  let speaker = DEFAULT_SPEAKER
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=')
    const value = inline ?? argv[i + 1]
    if (flag === '--engine') { if (!inline) i += 1; engine = value ?? engine }
    else if (flag === '--speaker') { if (!inline) i += 1; speaker = Number(value) }
  }
  if (!Number.isInteger(speaker) || speaker < 0) throw new Error(`--speaker が不正です: ${speaker}`)
  return { engine: engine.replace(/\/+$/, ''), speaker }
}

/** エンジンにテキストを読ませ、モーラ列を連結して返す。 */
async function readingOf(engine: string, speaker: number, text: string, isKana = false): Promise<string> {
  const url = `${engine}/accent_phrases?text=${encodeURIComponent(text)}`
    + `&speaker=${speaker}&is_kana=${isKana}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`エンジンが非 200 応答（${res.status}）: ${text}${isKana ? '（カナ指定）' : ''}`)
  }
  const phrases = await res.json() as { moras: { text: string }[] }[]
  return phrases.map(p => p.moras.map(m => m.text).join('')).join('')
}

/**
 * エンジンにテキストを読ませ、AquesTalk 風カナ表記（アクセント核・句区切り付き）を返す。
 *
 * **沖合の観測点名はふりがなから読みを組めない**ので、「正しく読める形で読ませた結果」を
 * そのまま辞書の値にする。`/audio_query` はこの記法を `kana` フィールドで返すため、
 * アクセント核の位置と句の割り方まで含めてエンジン自身の判断を写し取れる
 * （ふりがなから組む {@link toKanaEntry} は核の位置を決められず、末尾へ置くしかない）。
 *
 * 読ませるときに付けた文末の句読点は落とす。読みを持たないうえ、辞書の値としては句読点を
 * 含まない形に揃えたい（`stationReadings.test.ts` が値の形を検査する）。
 *
 * **落とすのは末尾だけ。** 内側に句読点が残る形（エンジンが名前の途中に間を置いた）は、
 * 落とすと間の長さが失われ、句区切り（`/`・間なし）と区別が付かなくなる。現状そうなる
 * 観測点名は無いので、起きたら止めて中身を確かめる。
 */
async function kanaOf(engine: string, speaker: number, text: string): Promise<string> {
  const url = `${engine}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) throw new Error(`エンジンが非 200 応答（${res.status}）: ${text}（カナ表記の取得）`)
  const query = await res.json() as { kana?: unknown }
  if (typeof query.kana !== 'string' || query.kana === '') {
    throw new Error(`エンジンの応答に kana が入っていません: ${text}`)
  }
  const kana = query.kana.replace(/[、。]+$/, '')
  if (/[、。]/.test(kana)) {
    throw new Error(
      `「${text}」のカナ表記に内側の句読点が含まれています（${query.kana}）。`
      + 'エンジンが名前の途中に間を置いたので、辞書の値としてどう扱うかを決める必要があります。',
    )
  }
  return kana
}

/**
 * 各観測点名を読み上げ文と同じ形で読ませ、誤読していればその文脈と読みを返す（していなければ null）。
 * 助詞ぶんを差し引けなかったときは投げる（判定できないまま通さない。→ {@link stripReadingTail}）。
 */
async function findMisreading(
  engine: string,
  speaker: number,
  target: Target,
): Promise<{ context: string; reading: string } | null> {
  for (const { suffix, tail } of target.contexts) {
    const context = `${target.name}${suffix}`
    const full = await readingOf(engine, speaker, context)
    const reading = stripReadingTail(full, tail)
    if (reading == null) {
      throw new Error(
        `「${context}」の読み「${full}」から助詞ぶん（${tail}）を差し引けませんでした。`
        + '読み上げ文の形と SPEECH_CONTEXTS の tail が合っているか確かめてください。',
      )
    }
    if (reading !== target.expected) return { context, reading }
  }
  return null
}

/**
 * `items` を CONCURRENCY 本で流す。1 本が投げたら `main()` は打ち切られる（判定できないまま
 * 出力しない）が、**すでに走っている他のワーカーは止まらない**（中断信号は送っていない）。
 */
async function runPooled<T>(items: readonly T[], worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await worker(items[index], index)
    }
  }))
}

/** 既知の点のふりがなを照合する。入れ替わった取得元から黙って辞書を作らないため。 */
function checkFurigana(
  label: string,
  furiganaOf: ReadonlyMap<string, string>,
  fixtures: readonly (readonly [string, string])[],
): void {
  for (const [name, expected] of fixtures) {
    const actual = furiganaOf.get(name)
    if (actual !== expected) {
      throw new Error(
        `${label}の既知の点の照合に失敗しました。${name} のふりがなが「${actual ?? '（無し）'}」で、`
        + `期待する「${expected}」と違います。取得元が入れ替わっていないか確かめてください。`,
      )
    }
  }
}

/** 震度観測点のふりがな表を取る。 */
async function fetchSeismicFurigana(): Promise<Map<string, string>> {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const stations = await res.json() as Station[]
  if (!Array.isArray(stations)) throw new Error('取得したデータが配列ではありません')
  if (stations.length < EXPECTED_COUNT_RANGE.min || stations.length > EXPECTED_COUNT_RANGE.max) {
    throw new Error(
      `震度観測点の件数が想定の幅（${EXPECTED_COUNT_RANGE.min}〜${EXPECTED_COUNT_RANGE.max}）を`
      + `外れています: ${stations.length} 件。取得元か形式が変わっていないか確かめてください。`,
    )
  }
  console.log(`Loaded ${stations.length} seismic stations`)

  const furiganaOf = new Map<string, string>()
  const unreadable: string[] = []
  for (const s of stations) {
    if (!s.name) continue
    const furigana = s.furigana ?? ''
    if (hasUnreadableFurigana(furigana)) { unreadable.push(`${s.name}（${furigana || '空'}）`); continue }
    // 観測点名は全点で一意（同名は存在しない）。都道府県を鍵に含めないのは、読み上げ文に県名が
    // 付かない形で観測点名が現れるため（DMDATA は点の `pref` が常に空）。
    furiganaOf.set(s.name, furigana)
  }
  if (unreadable.length > 0) {
    throw new Error(
      `ふりがなとして読めない震度観測点が ${unreadable.length} 件あります: `
      + `${unreadable.slice(0, 5).join(' / ')}。取得元の形式を確かめてください。`,
    )
  }
  checkFurigana('震度観測点', furiganaOf, FURIGANA_FIXTURES)
  return furiganaOf
}

/**
 * 潮位観測点のふりがな表を取る（気象庁 個別コード表 PointTsunami）。
 *
 * **ヘッダ部でのみ使う簡略名も含める。** 津波観測情報の読み上げは電文の見出し文を読む
 * （`ttsText.ts` の `tsunamiObservationToSegments` が `headline` を通す）ため、簡略名も声になる。
 * 座標が要らない `build-tsunami-obs-coords.mjs` 側はここで簡略名を落としており、そこと範囲が
 * 違うのは意図したもの。
 */
async function fetchTidalFurigana(): Promise<Map<string, string>> {
  console.log(`Fetching ${JMA_TEC_MATERIAL} ...`)
  const indexRes = await fetch(JMA_TEC_MATERIAL)
  if (!indexRes.ok) throw new Error(`気象庁 技術資料ページの取得に失敗: ${indexRes.status}`)
  const index = await indexRes.text()
  const file = /href="(jmaxml_\d+_Code\.zip)"/i.exec(index)?.[1]
  if (!file) throw new Error('気象庁 技術資料ページに個別コード表（jmaxml_*_Code.zip）へのリンクがありません')
  const zipUrl = new URL(file, JMA_TEC_MATERIAL).href
  console.log(`Fetching ${zipUrl} ...`)
  const zipRes = await fetch(zipUrl)
  if (!zipRes.ok) throw new Error(`気象庁 個別コード表の取得に失敗: ${zipRes.status}`)
  const zip = new Uint8Array(await zipRes.arrayBuffer())

  const book = findWorkbookInZip(zip, (sheets) =>
    String(sheets.get(POINT_TSUNAMI_SHEET)?.[0]?.[0] ?? '').includes('PointTsunami'))
  const rows = book?.get(POINT_TSUNAMI_SHEET)
  if (!rows) {
    throw new Error(
      `個別コード表に PointTsunami のシート（地震火山関連コード表のシート ${POINT_TSUNAMI_SHEET}）が`
      + 'ありません。コード表の構成が変わっていないか確かめてください。',
    )
  }

  // PointTsunami: [Code, Name, ふりがな, 簡略名Code, 簡略名Name, 備考]。先頭 3 行は見出し。
  const furiganaOf = new Map<string, string>()
  const conflicts: string[] = []
  for (const row of rows.slice(3)) {
    const [code, name, kana] = row
    if (typeof code !== 'number' || typeof name !== 'string' || !name) continue
    const furigana = typeof kana === 'string' ? kana : ''
    const known = furiganaOf.get(name)
    // 同じ名前が別のふりがなで 2 度現れたら、どちらが正しいか決められない。
    if (known !== undefined && known !== furigana) conflicts.push(`${name}（${known} / ${furigana}）`)
    furiganaOf.set(name, furigana)
  }
  if (conflicts.length > 0) {
    throw new Error(
      `潮位観測点に、同じ名前で違うふりがなを持つ行が ${conflicts.length} 件あります: `
      + `${conflicts.slice(0, 5).join(' / ')}。コード表の形式を確かめてください。`,
    )
  }
  if (furiganaOf.size < EXPECTED_TIDAL_COUNT_RANGE.min || furiganaOf.size > EXPECTED_TIDAL_COUNT_RANGE.max) {
    throw new Error(
      `潮位観測点の件数が想定の幅（${EXPECTED_TIDAL_COUNT_RANGE.min}〜${EXPECTED_TIDAL_COUNT_RANGE.max}）を`
      + `外れています: ${furiganaOf.size} 件。コード表の形式が変わっていないか確かめてください。`,
    )
  }
  console.log(`Loaded ${furiganaOf.size} tidal stations`)
  checkFurigana('潮位観測点', furiganaOf, TIDAL_FURIGANA_FIXTURES)
  return furiganaOf
}

/**
 * 距離部分（`５０ｋｍＢ`）の読みをエンジンから引く。
 *
 * 単独で読ませた形を正解として使うので、**既知の値との照合をここで通す**
 * （→ {@link DISTANCE_READING_FIXTURES}）。読ませるときに読点を付けるのは、名前の照合と
 * 同じ条件に揃えるため。
 */
async function fetchDistanceReadings(
  engine: string,
  speaker: number,
  distances: readonly string[],
): Promise<Map<string, string>> {
  // 固定した正解が、実在する数字と識別英字をすべて覆っているかを先に確かめる。
  // **覆えていない値があると、そこだけ崩れたときに気づけない** —— `entryOf` の再検証は同じ
  // 正解と比べるので、正解ごと崩れれば一致してしまう。
  //
  // **見ているのは成分（数字・識別英字）で、組み合わせではない。** `３１０ｋｍＢ` が新設されても
  // 数字 `３１０` と識別英字 `Ｂ` は既に覆われているので通る。連結部分にだけ固有の異常が出る形は
  // この検査では捕まえられない。取りこぼすのは**退行に気づく網**だけで、辞書の値は毎回エンジンへ
  // 問い合わせた結果を使うので誤った値が生成されるわけではない。
  const coveredNumbers = new Set<string>()
  const coveredLetters = new Set<string>()
  for (const [distance] of DISTANCE_READING_FIXTURES) {
    const parts = splitDistance(distance)
    if (!parts) {
      throw new Error(`DISTANCE_READING_FIXTURES の「${distance}」が距離部分の形をしていません。`)
    }
    coveredNumbers.add(parts.number)
    coveredLetters.add(parts.letter)
  }
  const missingNumbers = new Set<string>()
  const missingLetters = new Set<string>()
  for (const distance of distances) {
    const parts = splitDistance(distance)
    if (!parts) throw new Error(`距離部分「${distance}」の形が想定と違います。`)
    if (!coveredNumbers.has(parts.number)) missingNumbers.add(parts.number)
    if (!coveredLetters.has(parts.letter)) missingLetters.add(parts.letter)
  }
  if (missingNumbers.size > 0 || missingLetters.size > 0) {
    const parts = [
      missingNumbers.size > 0 ? `数字 ${[...missingNumbers].join('・')}` : '',
      missingLetters.size > 0 ? `識別英字 ${[...missingLetters].map(l => l || '（なし）').join('・')}` : '',
    ].filter(Boolean).join(' / ')
    throw new Error(
      `DISTANCE_READING_FIXTURES が覆えていない距離の値があります（${parts}）。`
      + '観測点が新設されて新しい距離が現れたときは、読みを確かめてから固定値へ足してください。',
    )
  }

  const readings = new Map<string, string>()
  await runPooled(distances, async (distance) => {
    readings.set(distance, await readingOf(engine, speaker, `${distance}、`))
  })
  for (const [distance, expected] of DISTANCE_READING_FIXTURES) {
    const actual = readings.get(distance)
    if (actual === undefined) {
      throw new Error(
        `距離部分の照合に使う「${distance}」が上流の観測点名に現れませんでした。`
        + 'DISTANCE_READING_FIXTURES が実データと合っているか確かめてください。',
      )
    }
    if (normalizeReading(actual) !== normalizeReading(expected)) {
      throw new Error(
        `距離部分「${distance}」の読みが「${actual}」で、期待する「${expected}」と違います。`
        + 'エンジンがこの部分を正しく読めなくなったため、沖合の観測点名の正解を作れません。',
      )
    }
  }
  console.log(`Resolved ${readings.size} distance readings`)
  return readings
}

/** 潮位観測点を {@link Target} へ揃える。 */
async function buildTidalTargets(
  engine: string,
  speaker: number,
  furiganaOf: ReadonlyMap<string, string>,
): Promise<Target[]> {
  // 読み解けなかった点は下で全部投げるので、ここには残る 2 つの形だけを入れる。
  const shapes = new Map<string, Exclude<TsunamiStationShape, { kind: 'unreadable' }>>()
  const unreadable: string[] = []
  for (const [name, furigana] of furiganaOf) {
    const shape = classifyTsunamiStation(name, furigana)
    if (shape.kind === 'unreadable') { unreadable.push(`${name}: ${shape.reason}`); continue }
    shapes.set(name, shape)
  }
  if (unreadable.length > 0) {
    throw new Error(
      `ふりがなを読み解けない潮位観測点が ${unreadable.length} 件あります:\n`
      + unreadable.slice(0, 10).map(s => `  ${s}`).join('\n')
      + '\nコード表の書き方が変わっていないか確かめてください。',
    )
  }

  const distances = [...new Set(
    [...shapes.values()].flatMap(s => s.kind === 'offshore' ? [s.distance] : []),
  )]
  const distanceReadings = await fetchDistanceReadings(engine, speaker, distances)

  const targets: Target[] = []
  for (const [name, shape] of shapes) {
    const furigana = furiganaOf.get(name) as string
    if (shape.kind === 'coastal') {
      targets.push({
        source: '潮位観測点',
        name,
        furigana,
        expected: normalizeReading(furigana),
        contexts: TIDAL_SPEECH_CONTEXTS,
        entryOf: async () => toKanaEntry(furigana),
      })
      continue
    }
    const distanceReading = distanceReadings.get(shape.distance) as string
    const expected = offshoreExpectedReading(shape.placeFurigana, distanceReading)
    targets.push({
      source: '潮位観測点',
      name,
      furigana,
      expected,
      contexts: TIDAL_SPEECH_CONTEXTS,
      // 沖合の名前はふりがなから読みを組めないので、**正しく読める形での読みをそのまま写す**。
      // 写す前にその形が本当に正しいことを確かめる —— ここが崩れているものを採ると、
      // 誤読をそのまま辞書へ焼き込むことになる。
      entryOf: async () => {
        const context = `${name}、`
        const reading = stripReadingTail(await readingOf(engine, speaker, context), '')
        if (reading !== expected) {
          throw new Error(
            `「${context}」の読み「${reading}」が期待する「${expected}」と違うため、`
            + `${name} の辞書の値をエンジンの読みから作れません。`
            + '読点で終わる形でも誤読するようになったので、正解の作り方を見直してください。',
          )
        }
        return await kanaOf(engine, speaker, context)
      },
    })
  }
  return targets
}

async function main(): Promise<void> {
  const { engine, speaker } = parseArgs(process.argv.slice(2))

  // エンジンの疎通を先に確かめる。全点の取得を終えてから落ちるのは待ち時間の無駄。
  let version: string
  try {
    const res = await fetch(`${engine}/version`)
    if (!res.ok) throw new Error(`非 200 応答（${res.status}）`)
    version = String(await res.json())
  } catch (err) {
    throw new Error(
      `音声合成エンジンへ繋がりません（${engine}）。VOICEVOX を起動してから実行してください。`
      + `別のホストなら --engine で指定します。理由: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  console.log(`Engine ${engine} (VOICEVOX ${version}), speaker ${speaker}`)

  const seismicFurigana = await fetchSeismicFurigana()
  const tidalFurigana = await fetchTidalFurigana()

  const seismicTargets: Target[] = [...seismicFurigana].map(([name, furigana]) => ({
    source: '震度観測点',
    name,
    furigana,
    expected: normalizeReading(furigana),
    contexts: STATION_SPEECH_CONTEXTS,
    entryOf: async () => toKanaEntry(furigana),
  }))
  const tidalTargets = await buildTidalTargets(engine, speaker, tidalFurigana)

  // 同じ名前が両方の列挙元にあるときは 1 つへまとめる。**辞書のキーは 1 つしか持てない**ので、
  // 2 つのまま流すと辞書の値が並行処理の完了順で決まり、実行のたびに変わりうる
  // （2026-09 時点では `いわき市小名浜`・`日南市油津` の 2 件。どちらもふりがなが一致するため
  // 値は同じになるが、それは偶然で、機構としては非決定的だった）。
  //
  // **判定の文脈は両方を合わせる。** どちらの読み上げ文で崩れても収録したい。
  const targets: Target[] = []
  const indexByName = new Map<string, number>()
  const shared: string[] = []
  for (const target of [...seismicTargets, ...tidalTargets]) {
    const at = indexByName.get(target.name)
    if (at === undefined) {
      indexByName.set(target.name, targets.length)
      targets.push(target)
      continue
    }
    const existing = targets[at]
    // 期待する読みが食い違えば、どちらを採るかは機械的に決められない。
    if (existing.expected !== target.expected) {
      throw new Error(
        `同じ名前「${target.name}」に列挙元ごとに違う読みが期待されています。`
        + `${existing.source}: ${existing.furigana} → ${existing.expected} / `
        + `${target.source}: ${target.furigana} → ${target.expected}。`
        + 'どちらを採るかを決める必要があるため、辞書は書きません。',
      )
    }
    const contexts = [...existing.contexts]
    for (const context of target.contexts) {
      if (!contexts.some(c => c.suffix === context.suffix)) contexts.push(context)
    }
    targets[at] = { ...existing, source: `${existing.source}・${target.source}`, contexts }
    shared.push(target.name)
  }
  if (shared.length > 0) {
    console.log(`両方の列挙元にある名前: ${shared.length} 件（${shared.join('・')}。読みは一致）`)
  }
  console.log(`照合する観測点: ${targets.length} 点`)

  const misread = new Map<string, string>()
  const misreadTargets: Target[] = []
  let done = 0
  await runPooled(targets, async (target) => {
    const found = await findMisreading(engine, speaker, target)
    if (found) misreadTargets.push(target)
    done += 1
    if (done % 500 === 0) console.log(`  ${done}/${targets.length} 点を照合`)
  })
  if (misreadTargets.length === 0) {
    throw new Error(
      '誤読が 1 件も見つかりませんでした。判定か正規化が壊れている可能性が高いので、'
      + '空の辞書は書きません。',
    )
  }
  if (misreadTargets.length > targets.length * MAX_MISREAD_RATIO) {
    throw new Error(
      `誤読と判定した点が多すぎます（${misreadTargets.length} / ${targets.length} 点）。`
      + '判定か正規化が壊れている可能性が高いので、辞書は書きません。',
    )
  }

  // 誤読した点だけ、辞書へ入れる値を作る。
  await runPooled(misreadTargets, async (target) => {
    misread.set(target.name, await target.entryOf())
  })

  // 作った値をエンジンへ戻し、狙った読みになるかを確かめる。カナ表記には使えない文字があり
  // （AquesTalk 風カナが受け付けるモーラは限られる）、通らないものを混ぜると読み上げのその
  // 箇所だけが黙って辞書なしへ落ちる。
  const roundTripFailed: string[] = []
  await runPooled(misreadTargets, async (target) => {
    const kana = misread.get(target.name) as string
    try {
      const back = await readingOf(engine, speaker, kana, true)
      if (normalizeReading(back) !== target.expected) {
        roundTripFailed.push(`${target.name} → ${kana} → ${back}（期待 ${target.expected}）`)
      }
    } catch (err) {
      roundTripFailed.push(`${target.name} → ${kana}（${err instanceof Error ? err.message : String(err)}）`)
    }
  })
  if (roundTripFailed.length > 0) {
    throw new Error(
      `作った読みをエンジンへ戻したとき、${roundTripFailed.length} 件が期待する読みと一致しません:\n`
      + roundTripFailed.slice(0, 10).map(s => `  ${s}`).join('\n')
      + '\nカナ表記の作り方（scripts/stationReading.ts の toKanaEntry）を見直してください。',
    )
  }

  // 上流の並び順を保つ（震度観測点 → 潮位観測点）。station-coords.json・コード表と同じ並びに
  // なり、突き合わせるときに追いやすい。
  const output: Record<string, string> = {
    _comment: '観測点名の読み。気象庁のふりがなから、音声合成エンジンが誤読する点だけを収録。'
      + '対象は震度観測点（「5弱以上・未入電」の地点名）と潮位観測点（津波の観測情報）。'
      + 'キーは観測点名、値は AquesTalk 風カナ（\' はアクセント核、/ は句区切り）。'
      + '生成: npm run build-station-readings',
  }
  for (const target of targets) {
    const kana = misread.get(target.name)
    if (kana) output[target.name] = kana
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`)
  const bySource = new Map<string, number>()
  for (const target of misreadTargets) bySource.set(target.source, (bySource.get(target.source) ?? 0) + 1)
  const breakdown = [...bySource].map(([source, count]) => `${source} ${count}`).join(' / ')
  const rate = (misreadTargets.length / targets.length * 100).toFixed(1)
  console.log(`Wrote ${OUT_FILE} (収録 ${misreadTargets.length} / 全 ${targets.length} 点・${rate}%・${breakdown})`)
}

/**
 * **直接実行されたときだけ走らせる。**
 *
 * `scripts/stationReadings.test.ts` が `SOURCE_URL` を読むために import しており、
 * 読み込みだけで `main()` が動くと `npm test` が音声合成エンジンへ繋ぎに行く。
 * 理由と落ち方の詳細は `build-epicenter-accents.ts` の同じ門にある
 * —— **生成スクリプトをテストから import するなら必ずこの形にすること。**
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
