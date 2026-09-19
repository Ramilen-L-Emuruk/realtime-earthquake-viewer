// 震央地名の句割り辞書の生成。
//
// 音声合成エンジンは長い震央地名を**ひと息の 1 アクセント句**にまとめ、核を後部要素の頭へ置く
// （`宮古島近海` → `ミヤコジマキ／ンカイ`）。読み自体は正しいが、切れ目が語の途中に来るため
// 地名として聞き取りづらい。そこで前部要素と後部要素の境界で句を割る指定を作る。
//
//   npm run build-epicenter-accents
//   npm run build-epicenter-accents -- --engine http://192.168.1.10:50021 --speaker 6
//
// 【誤読は扱わない】震央地名の誤読は既に手書きの句区切り辞書（tts-phrase-break-dict.json）が
// 全件手当てしてある（2026-09-10 に 332 件を突き合わせて確認）。ここで作るのは抑揚だけ。
//
// 【エンジンが要る】「どれが 1 句にまとまるか」は実際に読ませないと判らない。判定の結果は
// 出力へ焼き込まれるので、**他の環境で作り直す必要はない**。
//
// 出力: public/data/tts-epicenter-accents.json
//   { "宮古島近海": "ミヤコジマ'/キンカイ'" }
//
// データ出典: 気象庁「地震情報で用いる震央地名」「多言語辞書データ」ほか
//   Benidate 氏が GeoJSON 化したもの（CC0 1.0）を利用
//   https://github.com/0Quake/JMA_Region

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMisreading, stripReadingTail } from './stationReading'
import {
  endsWithChihou, MIN_TAIL_MORAS, splitEpicenterDetailed, toAccentEntry,
  type ComponentAccents, type EpicenterSplit, type UnsplitReason,
} from './epicenterAccent'

/**
 * 震央地名の一覧（名前＋ふりがな）の取得元。
 *
 * **気象庁の一次情報にはふりがなが揃っていない。** 多言語辞書データ（`jma_multilingual.xlsx`）は
 * セルのルビとして読みを持つが、ルビが付くのは漢字の一部だけで（`東北地方` は「とうほく」しか
 * 付かない）読みとして復元できない。こちらは同じ気象庁のデータから全件のふりがなを整えた
 * 二次データで、ライセンスは CC0。
 */
export const SOURCE_URL =
  'https://raw.githubusercontent.com/0Quake/JMA_Region/main/%E9%9C%87%E5%A4%AE%E5%9C%B0%E5%90%8D.geojson'

const DEFAULT_ENGINE = 'http://localhost:50021'
const DEFAULT_SPEAKER = 6
/**
 * 構成要素の核を実測できた割合の下限。**下回ったら辞書を書かない。**
 *
 * 実測が全滅しても末尾核へ倒れるだけなので、句数も読みも検証を通ってしまう（変わるのは核の位置
 * だけで、それを見る検査が他に無い）。`build-station-readings.ts` が句割りの割合に下限を置いて
 * いるのと同じ趣旨。2026-09-19 時点の実測は 9 割で、余裕を見て半分に置いた。
 */
const MIN_MEASURED_RATIO = 0.5

const CONCURRENCY = 8

/**
 * 句を割る対象にするモーラ数の下限。
 *
 * **これは耳で確かめた「破綻する境界」ではない。** 9 モーラの `宮古島近海` が不自然だという指摘を
 * 起点に、8 モーラ帯まで含める値として選んだもの。ここを通っても後部要素が短ければ
 * `MIN_TAIL_MORAS` で落ちる（`能登半島沖` がそれ）。
 *
 * 1 句にまとまる震央地名の分布は実測してある（2026-09 時点・全 331 件のうち 155 件が 1 句）。
 * 4 モーラ 9 件／5 モーラ 13 件／6 モーラ 18 件／**7 モーラ 28 件**／8 モーラ 13 件／9 モーラ 23 件／
 * 10 モーラ 14 件／11 モーラ 8 件／12 モーラ 14 件／13 モーラ 9 件／14 モーラ 6 件。
 * 7 モーラ帯は `網走地方`・`宗谷海峡`・`千島列島` のように前部要素が 3〜4 モーラで、1 句でも語の
 * 輪郭が保たれる（と判断した）が、聞き比べて決めたわけではない。**下げるならこの帯から。**
 *
 * なお手で書いた句区切り辞書には 7 モーラで 2 句に割った前例がある（`西表島`＝`イリオモテ'/ジマ'`）。
 * ただしあちらは「西表」の誤読（いりおもて）を直すためのもので、句割りは副産物。
 */
const MIN_MORAS_TO_SPLIT = 8

/** 上流の件数として受け入れる幅。2026-09 時点で 332 件。 */
const EXPECTED_COUNT_RANGE = { min: 250, max: 450 } as const

/** 句割りとして収録する割合の上限。超えたら判定が壊れたと見て止める。 */
const MAX_SPLIT_RATIO = 0.6

/**
 * 読み上げ文が震央地名の後ろに置く形。**判定はこの形で行う。**
 * `tail` はその形で読ませたときにモーラ列の末尾へ乗る後続の読み。
 * 文の組み立ては `src/utils/ttsText.ts`（EEW は `〇〇で地震。`、深さを言う電文は読点、
 * 深さ不明の電文は `〇〇を震源とする地震が発生しました。`）。
 */
const SPEECH_CONTEXTS: readonly { readonly suffix: string; readonly tail: string }[] = [
  { suffix: '、', tail: '' },
  { suffix: 'で地震。', tail: 'デジシン' },
  { suffix: 'を震源とする地震が発生しました。', tail: 'オシンゲントスルジシンガハッセイシマシタ' },
]

/** 上流のスキーマが変わっていないことを確かめる照合。**エンジンには依存させない**。 */
const FURIGANA_FIXTURES: readonly (readonly [string, string])[] = [
  ['宮古島近海', 'みやこじまきんかい'],
  ['能登半島沖', 'のとはんとうおき'],
  ['房総半島南方沖', 'ぼうそうはんとうなんぽうおき'],
  ['日向灘', 'ひゅうがなだ'],
]

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'tts-epicenter-accents.json')

type Feature = { properties?: { name?: string; name_kana?: string } }

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

type Phrase = { accent: number; moras: { text: string }[] }

async function accentPhrases(
  engine: string, speaker: number, text: string, isKana = false,
): Promise<Phrase[]> {
  const url = `${engine}/accent_phrases?text=${encodeURIComponent(text)}`
    + `&speaker=${speaker}&is_kana=${isKana}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`エンジンが非 200 応答（${res.status}）: ${text}${isKana ? '（カナ指定）' : ''}`)
  }
  return await res.json() as Phrase[]
}

const readingOf = (phrases: readonly Phrase[]): string =>
  phrases.map(p => p.moras.map(m => m.text).join('')).join('')

async function runPooled<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await worker(items[index])
    }
  }))
}

/**
 * この名前が「1 句にまとまって長い」かを返す。判定は読点の形で行う
 * （後続の助詞が別の句を作らないので、名前だけの句構成が見える）。
 */
async function isLongSinglePhrase(engine: string, speaker: number, name: string): Promise<boolean> {
  const phrases = await accentPhrases(engine, speaker, `${name}、`)
  if (phrases.length !== 1) return false
  return phrases[0].moras.length >= MIN_MORAS_TO_SPLIT
}

/**
 * 構成要素を単独で読ませ、**1 句にまとまって読みがふりがなと一致したときだけ**核を返す。
 * 採れなければ null（→ `epicenterAccent.ts` の `toAccentEntry` が代わりの位置を決める）。
 *
 * **単独で読ませるのは、そこで採れた核がその句の核になるから。** 句へ割っている以上、各句は
 * 単独語と同じアクセントを持つ。2 句に割れる語（`〜地方`）と誤読する語（`渡島` → トトオ）は
 * ここで弾かれ、呼び出し先の規則へ落ちる。
 *
 * **読点の前では平板と尾高を区別できない**（後続が無いので accent = モーラ数 で返る）。ただし
 * どちらでも組み立てる値は末尾核と同じ文字列になるので、出力に差は出ない。
 */
async function measureAccent(
  engine: string, speaker: number, part: string, partKana: string,
): Promise<number | null> {
  const phrases = await accentPhrases(engine, speaker, `${part}、`)
  if (phrases.length !== 1) return null
  if (isMisreading(readingOf(phrases), partKana)) return null
  return phrases[0].accent
}

/**
 * 作った句割りを各文脈で読ませ、**読みを壊していないこと**と**句が割れていること**を確かめる。
 * 問題があればその内容を返す（無ければ null）。
 */
async function verify(
  engine: string, speaker: number, name: string, kana: string, entry: string,
): Promise<string | null> {
  // カナ指定で読ませ、狙った読みとアクセント句の数になるか
  const kanaPhrases = await accentPhrases(engine, speaker, entry, true)
  if (kanaPhrases.length < 2) return `句が割れていない（${kanaPhrases.length} 句）`
  const back = readingOf(kanaPhrases)
  if (isMisreading(back, kana)) return `カナ指定で読ませると「${back}」（正: ${kana}）`
  // 読み上げ文の形でも、名前部分の読みが変わらないこと
  for (const { suffix, tail } of SPEECH_CONTEXTS) {
    const whole = readingOf(await accentPhrases(engine, speaker, `${name}${suffix}`))
    const stripped = stripReadingTail(whole, tail)
    if (stripped == null) return `「${name}${suffix}」の読み「${whole}」から後続を差し引けない`
  }
  return null
}

async function main(): Promise<void> {
  const { engine, speaker } = parseArgs(process.argv.slice(2))

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

  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const geo = await res.json() as { features?: Feature[] }
  const features = geo.features
  if (!Array.isArray(features)) throw new Error('取得したデータに features がありません')
  if (features.length < EXPECTED_COUNT_RANGE.min || features.length > EXPECTED_COUNT_RANGE.max) {
    throw new Error(
      `震央地名の件数が想定の幅（${EXPECTED_COUNT_RANGE.min}〜${EXPECTED_COUNT_RANGE.max}）を`
      + `外れています: ${features.length} 件。取得元か形式が変わっていないか確かめてください。`,
    )
  }

  const kanaOf = new Map<string, string>()
  const conflicting: string[] = []
  for (const f of features) {
    const name = f.properties?.name
    const kana = f.properties?.name_kana
    if (!name || !kana) continue
    // 上流には同名の feature が複数あることがある（`釧路地方北部` が 2 件。飛び地や分割された
    // ポリゴン）。**読みが同じなら黙って上書きしてよいが、食い違うなら知らせる** ——
    // どちらが採られたか判らないまま片方が失われるのを避ける。
    const known = kanaOf.get(name)
    if (known != null && known !== kana) conflicting.push(`${name}（${known} / ${kana}）`)
    kanaOf.set(name, kana)
  }
  if (conflicting.length > 0) {
    throw new Error(
      `同じ名前で読みが違う震央地名が ${conflicting.length} 件あります: ${conflicting.join(' / ')}`
      + '。どちらを採るべきか判断できないため止めます。',
    )
  }
  if (kanaOf.size < EXPECTED_COUNT_RANGE.min) {
    throw new Error(`ふりがなを持つ震央地名が ${kanaOf.size} 件しかありません`)
  }
  console.log(`Loaded ${kanaOf.size} epicenter names`)

  for (const [name, expected] of FURIGANA_FIXTURES) {
    const actual = kanaOf.get(name)
    if (actual !== expected) {
      throw new Error(
        `既知の震央地名の照合に失敗しました。${name} のふりがなが「${actual ?? '（無し）'}」で、`
        + `期待する「${expected}」と違います。取得元が入れ替わっていないか確かめてください。`,
      )
    }
  }

  // 1 句にまとまって長いものを拾う
  const names = [...kanaOf.keys()]
  const targets: string[] = []
  let checked = 0
  await runPooled(names, async (name) => {
    if (await isLongSinglePhrase(engine, speaker, name)) targets.push(name)
    checked += 1
    if (checked % 100 === 0) console.log(`  ${checked}/${names.length} 件を照合`)
  })
  if (targets.length === 0) {
    throw new Error(
      '1 句にまとまる震央地名が 1 件も見つかりませんでした。判定が壊れている可能性が高いので、'
      + '空の辞書は書きません。',
    )
  }
  if (targets.length > names.length * MAX_SPLIT_RATIO) {
    throw new Error(
      `句割りの対象が多すぎます（${targets.length} / ${names.length} 件）。`
      + '判定が壊れている可能性が高いので、辞書は書きません。',
    )
  }

  // 句へ割る。割れないものは理由別に記録して落とす
  const entries = new Map<string, string>()
  const unsplit = new Map<UnsplitReason, string[]>()
  const splits = new Map<string, EpicenterSplit>()
  for (const name of targets) {
    const kana = kanaOf.get(name) as string
    const outcome = splitEpicenterDetailed(name, kana)
    if ('split' in outcome) { splits.set(name, outcome.split); continue }
    const list = unsplit.get(outcome.reason) ?? []
    list.push(`${name}（${kana}）`)
    unsplit.set(outcome.reason, list)
  }
  // 1 件も割れなかったときは、後部要素の表（SUFFIXES）を疑う。
  // この先の実測割合の歯止め（MIN_MEASURED_RATIO）は 0 / 0 語でも発火するが、
  // 文面が「エンジンの応答が壊れている」と言うので原因を取り違える
  if (splits.size === 0) {
    throw new Error(
      `句へ割れた震央地名が 1 件もありません（対象 ${targets.length} 件）。`
      + '後部要素の表（SUFFIXES）を見直してください。辞書は書きません。',
    )
  }

  // 構成要素の核をエンジンへ訊く。同じ語は何度も出るので 1 度だけ測る。
  // **「〜地方」の前部要素は訊かない** —— 核は実測より優先して「チ」へ置くので、訊いても結果が
  // 使われず、実測できた割合の数字だけが狂う（→ epicenterAccent.ts の `phraseEntry`）。
  // **鍵は「表記と読み」の組** —— 同じ表記で読みが違う構成要素が来たとき、片方の核でもう片方を
  // 塗り潰さないため（実データでは 0 件だが、起きても読みは変わらないので検証を素通りする）。
  const accentOf = new Map<string, number | null>()
  const parts = new Map<string, { text: string; kana: string }>()
  const partKey = (text: string, kana: string) => JSON.stringify([text, kana])
  for (const split of splits.values()) {
    if (!endsWithChihou(split.headKana)) parts.set(partKey(split.head, split.headKana), { text: split.head, kana: split.headKana })
    parts.set(partKey(split.tail, split.tailKana), { text: split.tail, kana: split.tailKana })
  }
  await runPooled([...parts.entries()], async ([key, { text, kana }]) => {
    accentOf.set(key, await measureAccent(engine, speaker, text, kana))
  })
  const missed = [...parts.entries()].filter(([key]) => accentOf.get(key) == null).map(([, p]) => p.text)
  console.log(`  構成要素の核: ${parts.size - missed.length} / ${parts.size} 語で実測できました`
    + `（「〜地方」の前部要素は対象外。核は「チ」へ置きます）`)
  if (missed.length > 0) {
    // 採れない理由は「単独では 2 句に割れる」か「単独では誤読する」のどちらか。どちらも末尾核へ倒れる
    console.log(`  実測できなかった ${missed.length} 語（末尾核へ倒します）: ${missed.join('・')}`)
  }
  // **実測だけが黙って死にうる。** 採れなければ末尾核へ倒れるので、全滅しても辞書は書き出され、
  // 句数も読みも検証を通る —— 変わるのは核の位置だけで、それを見る検査はここにしか無い。
  // 割合で止める（件数で見ると上流の増減で意味が変わる）。実測は 2026-09-19 時点で 9 割。
  const measuredRatio = parts.size > 0 ? (parts.size - missed.length) / parts.size : 0
  if (measuredRatio < MIN_MEASURED_RATIO) {
    throw new Error(
      `構成要素の核をほとんど実測できていません（${parts.size - missed.length} / ${parts.size} 語 ＝ `
      + `${(measuredRatio * 100).toFixed(0)}%。下限 ${(MIN_MEASURED_RATIO * 100).toFixed(0)}%）。`
      + 'エンジンの応答か読みの突き合わせが壊れている可能性が高いので、辞書は書きません。',
    )
  }
  for (const [name, split] of splits) {
    const accents: ComponentAccents = {
      head: accentOf.get(partKey(split.head, split.headKana)) ?? null,
      tail: accentOf.get(partKey(split.tail, split.tailKana)) ?? null,
    }
    entries.set(name, toAccentEntry(split, accents))
  }
  const UNSPLIT_LABEL: Record<UnsplitReason, string> = {
    'no-suffix': '後部要素の表に無い構成',
    'empty-head': '後部要素だけの名前（前部要素が空）',
    'tail-too-short': `後部要素が ${MIN_TAIL_MORAS} モーラ未満（割らないと決めた形）`,
  }
  for (const [reason, names] of unsplit) {
    console.log(`  割れなかった ${names.length} 件（${UNSPLIT_LABEL[reason]}）:`)
    for (const u of names) console.log(`    ${u}`)
  }
  if (entries.size === 0) throw new Error('句へ割れた震央地名が 1 件もありません')

  // 作った値を検証する。1 件でも通らなければ止める（黙って辞書なしへ落ちるのを防ぐ）
  const failed: string[] = []
  await runPooled([...entries.entries()], async ([name, entry]) => {
    const problem = await verify(engine, speaker, name, kanaOf.get(name) as string, entry)
    if (problem) failed.push(`${name} → ${entry}: ${problem}`)
  })
  if (failed.length > 0) {
    throw new Error(
      `作った句割りの検証で ${failed.length} 件が通りませんでした:\n`
      + failed.slice(0, 10).map(s => `  ${s}`).join('\n')
      + '\n後部要素の表（scripts/epicenterAccent.ts の SUFFIXES）を見直してください。',
    )
  }

  // 上流の並び順を保つ（差分を追いやすくするため）
  const output: Record<string, string> = {
    _comment: '震央地名の句割り。音声合成エンジンが 1 アクセント句にまとめてしまう長い名前を、'
      + '前部要素と後部要素の境界で割る指定。キーは震央地名、値は AquesTalk 風カナ'
      + '（/ が句区切り、\' がアクセント核）。生成: npm run build-epicenter-accents',
  }
  for (const name of names) {
    const entry = entries.get(name)
    if (entry) output[name] = entry
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Wrote ${OUT_FILE} (収録 ${entries.size} / 全 ${names.length} 件)`)
  // 読みを作り直したら助詞の連結を確かめ直す（理由は `build-station-readings.ts` の同じ箇所）
  console.log('次は `npm run verify-particle-phrases` を回すこと（助詞を連結しても句が増えないかの確認）')
}

/**
 * **直接実行されたときだけ走らせる。**
 *
 * このファイルは `scripts/epicenterAccents.test.ts` が `SOURCE_URL` を読むために import して
 * おり、**読み込みだけで `main()` が動くと `npm test` が音声合成エンジンへ繋ぎに行く**。
 * エンジンがある環境（生成した本人の端末）では生成物を黙って書き換え、無い環境（CI）では
 * `process.exit(1)` まで届いて、**テストが全件通っていてもテスト実行そのものが失敗する**。
 *
 * **落ち方が一定しないので気づきにくい。** 拒否が実行の終わりに間に合うかどうかで、
 * `process.exit unexpectedly called with "1"` になったり、ワーカーのハング
 * （`Timeout terminating forks worker`）で済んで exit 0 になったりする。2026-09-11 に
 * 連続する 2 回の CI で両方を観測した（前者だけがデプロイを止めた）。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
