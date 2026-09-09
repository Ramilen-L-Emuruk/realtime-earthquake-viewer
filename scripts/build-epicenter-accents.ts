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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMisreading, stripReadingTail } from './stationReading'
import { splitEpicenter, toAccentEntry } from './epicenterAccent'

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
const CONCURRENCY = 8

/**
 * 句を割る対象にするモーラ数の下限。
 *
 * **これは耳で確かめた「破綻する境界」ではない。** 9 モーラの `宮古島近海` が不自然だという指摘を
 * 起点に、同じ構成の `能登半島沖`（8 モーラ）まで含める値として選んだもの。
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

type Phrase = { moras: { text: string }[] }

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

  // 句へ割る。割れないものは記録して落とす（後部要素の表に無い構成）
  const entries = new Map<string, string>()
  const unsplit: string[] = []
  for (const name of targets) {
    const kana = kanaOf.get(name) as string
    const split = splitEpicenter(name, kana)
    if (!split) { unsplit.push(`${name}（${kana}）`); continue }
    entries.set(name, toAccentEntry(split))
  }
  if (unsplit.length > 0) {
    console.log(`  割れなかった ${unsplit.length} 件（後部要素の表に無い構成）:`)
    for (const u of unsplit) console.log(`    ${u}`)
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
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
