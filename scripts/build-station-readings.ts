// 震度観測点名の読み上げ用辞書の生成。
//
// 気象庁が公開している震度観測点のふりがなから、**音声合成エンジンが誤読する点だけ**を集めて
// カナの辞書にする。読み上げは「5弱以上・未入電」の地点名で観測点名を声にするため、誤読すると
// 別の場所を伝えることになる（`札幌北区太平` →「オオヒラ」、`千歳市北栄` →「キタサカエ」）。
//
//   npm run build-station-readings
//   npm run build-station-readings -- --engine http://192.168.1.10:50021 --speaker 3
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
//   { "札幌北区太平": "サッポロキタクタイヘイ'" }
//
// データ出典: 気象庁 震度観測点一覧表（iku55 氏が JSON 化したものを利用）
//   https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasUnreadableFurigana, isMisreading, stripReadingTail, toKanaEntry } from './stationReading'

/**
 * 震度観測点一覧の取得元。**`build-station-coords.mjs` と同じ URL を指す。**
 * 座標側は素の node で動かす規定（`node scripts/build-station-coords.mjs`）のため、
 * このスクリプト（tsx 実行）から定数を共有できない。食い違いは
 * `scripts/stationReadings.test.ts` が両ファイルを読んで検査する。
 */
export const SOURCE_URL =
  'https://gist.githubusercontent.com/iku55/79005d1896631ad6117bbe327b8162c1/raw/6458684e522767a9ffc42f9bba9d6b2b06253f44/stations.json'

const DEFAULT_ENGINE = 'http://localhost:50021'
/** 読み（モーラ列）は話者に依らないが、問い合わせに話者の指定が要るので既定を置く。 */
const DEFAULT_SPEAKER = 3
/** エンジンへの同時接続数。増やしても頭打ちで、エンジン側のワーカー数を超えると詰まる。 */
const CONCURRENCY = 8

/**
 * 上流の件数として受け入れる幅。2026-09 時点で 4372 点。
 * この幅を外れたらスキーマか URL が変わったと見て止める（黙って少ない辞書を作らない）。
 */
const EXPECTED_COUNT_RANGE = { min: 3000, max: 6000 } as const

/**
 * 誤読として収録する割合の上限。これを超えたら判定か正規化が壊れたと見て止める。
 *
 * **上限が要るのは「誤読 0 件」だけが異常ではないから。** 正規化の条件が反転すれば全点が誤読と
 * 判定されうるが、その形は生成物を後から検査するテスト（`scripts/stationReadings.test.ts`）で
 * しか捕まらず、生成コマンドは正常終了してしまう。
 */
const MAX_MISREAD_RATIO = 0.9

/**
 * 読み上げ文が観測点名の後ろに置く形。**判定はこの形で行い、名前を単体で読ませない。**
 *
 * 誤読は後ろに続く文字で反転する（`docs/spec/audio-tts-spec.md` §3「何を収録するか」）。
 * 未入電の文（`ttsText.ts` の `unreceivedRegionSegments`）は名前を読点で繋ぎ、最後の名前にだけ
 * 「では、」が付く。`tail` はその形で読ませたときにモーラ列の末尾へ乗る助詞の読み。
 */
const SPEECH_CONTEXTS: readonly { readonly suffix: string; readonly tail: string }[] = [
  { suffix: '、', tail: '' },
  { suffix: 'では、', tail: 'デワ' },
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

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'tts-station-readings.json')

type Station = {
  name?: string
  furigana?: string
  pref?: { name?: string }
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
 * 各観測点名を読み上げ文と同じ形で読ませ、誤読していればその文脈と読みを返す（していなければ null）。
 * 助詞ぶんを差し引けなかったときは投げる（判定できないまま通さない。→ {@link stripReadingTail}）。
 */
async function findMisreading(
  engine: string,
  speaker: number,
  name: string,
  furigana: string,
): Promise<{ context: string; reading: string } | null> {
  for (const { suffix, tail } of SPEECH_CONTEXTS) {
    const context = `${name}${suffix}`
    const full = await readingOf(engine, speaker, context)
    const reading = stripReadingTail(full, tail)
    if (reading == null) {
      throw new Error(
        `「${context}」の読み「${full}」から助詞ぶん（${tail}）を差し引けませんでした。`
        + 'SPEECH_CONTEXTS の tail が実際の読みと合っているか確かめてください。',
      )
    }
    if (isMisreading(reading, furigana)) return { context, reading }
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

  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const stations = await res.json() as Station[]
  if (!Array.isArray(stations)) throw new Error('取得したデータが配列ではありません')
  if (stations.length < EXPECTED_COUNT_RANGE.min || stations.length > EXPECTED_COUNT_RANGE.max) {
    throw new Error(
      `観測点の件数が想定の幅（${EXPECTED_COUNT_RANGE.min}〜${EXPECTED_COUNT_RANGE.max}）を外れています: `
      + `${stations.length} 件。取得元か形式が変わっていないか確かめてください。`,
    )
  }
  console.log(`Loaded ${stations.length} stations`)

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
      `ふりがなとして読めない点が ${unreadable.length} 件あります: ${unreadable.slice(0, 5).join(' / ')}`
      + '。取得元の形式を確かめてください。',
    )
  }

  for (const [name, expected] of FURIGANA_FIXTURES) {
    const actual = furiganaOf.get(name)
    if (actual !== expected) {
      throw new Error(
        `既知の観測点の照合に失敗しました。${name} のふりがなが「${actual ?? '（無し）'}」で、`
        + `期待する「${expected}」と違います。取得元が入れ替わっていないか確かめてください。`,
      )
    }
  }

  const names = [...furiganaOf.keys()]
  const misread = new Map<string, string>()
  let done = 0
  await runPooled(names, async (name) => {
    const furigana = furiganaOf.get(name) as string
    const found = await findMisreading(engine, speaker, name, furigana)
    if (found) misread.set(name, toKanaEntry(furigana))
    done += 1
    if (done % 500 === 0) console.log(`  ${done}/${names.length} 点を照合`)
  })
  if (misread.size === 0) {
    throw new Error(
      '誤読が 1 件も見つかりませんでした。判定か正規化が壊れている可能性が高いので、'
      + '空の辞書は書きません。',
    )
  }
  if (misread.size > names.length * MAX_MISREAD_RATIO) {
    throw new Error(
      `誤読と判定した点が多すぎます（${misread.size} / ${names.length} 点）。`
      + '判定か正規化が壊れている可能性が高いので、辞書は書きません。',
    )
  }

  // 作った値をエンジンへ戻し、狙った読みになるかを確かめる。カナ表記には使えない文字があり
  // （AquesTalk 風カナが受け付けるモーラは限られる）、通らないものを混ぜると読み上げのその
  // 箇所だけが黙って辞書なしへ落ちる。
  const roundTripFailed: string[] = []
  const entries = [...misread.entries()]
  await runPooled(entries, async ([name, kana]) => {
    const furigana = furiganaOf.get(name) as string
    try {
      const back = await readingOf(engine, speaker, kana, true)
      if (isMisreading(back, furigana)) roundTripFailed.push(`${name} → ${kana} → ${back}`)
    } catch (err) {
      roundTripFailed.push(`${name} → ${kana}（${err instanceof Error ? err.message : String(err)}）`)
    }
  })
  if (roundTripFailed.length > 0) {
    throw new Error(
      `作った読みをエンジンへ戻したとき、${roundTripFailed.length} 件が元のふりがなと一致しません:\n`
      + roundTripFailed.slice(0, 10).map(s => `  ${s}`).join('\n')
      + '\nカナ表記の作り方（scripts/stationReading.ts の toKanaEntry）を見直してください。',
    )
  }

  // 上流の並び順を保つ。station-coords.json と同じ並びになり、両方を見比べるときに追いやすい。
  const output: Record<string, string> = {
    _comment: '震度観測点名の読み。気象庁のふりがなから、音声合成エンジンが誤読する点だけを収録。'
      + 'キーは観測点名、値は AquesTalk 風カナ（末尾の \' はアクセント核）。'
      + '生成: npm run build-station-readings',
  }
  for (const name of names) {
    const kana = misread.get(name)
    if (kana) output[name] = kana
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`)
  const rate = (misread.size / names.length * 100).toFixed(1)
  console.log(`Wrote ${OUT_FILE} (収録 ${misread.size} / 全 ${names.length} 点・${rate}%)`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
