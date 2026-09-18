// 辞書の読みへ助詞を連結しても、アクセント句の数とモーラ列が変わらないことを実データで確かめる。
//
//   npm run verify-particle-phrases
//   npm run verify-particle-phrases -- --engine http://192.168.1.10:50021 --speaker 6
//
// 【なぜ要るか】辞書キーの直後の助詞は、読み仮名へ文字列として足してから 1 つのアクセント句へ
// 入れる（→ `docs/spec/audio-tts-spec.md` §3「助詞は辞書の読みへ取り込む」）。この足し戻しが
// **句の数を変えない**ことが、繋ぎ目の間を置く位置（`punctAt` の添字）の前提になっている。
// 句が増えれば添字が 1 つずれ、**間が別の切れ目へ移った読み上げが黙って出荷される**。
//
// 【いつ回すか】辞書を作り直したとき（`npm run build-station-readings` /
// `build-epicenter-accents` / 手書き辞書の編集）と、助詞を足したとき。
//
// 【CI では回せない】判定に音声合成エンジンが要るため。ユニットテストが固めているのは
// 「連結した形で取得しているか」「間をどこへ置くか」という実装の筋道で、**実データの読みが
// この前提を満たすか**はここでしか確かめられない。
//
// 【助詞の列挙は実装から取る】`TRAILING_PARTICLES` を import する。書き写すと、助詞を足した
// ときに検証だけが古い集合で通り続ける。
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRAILING_PARTICLES } from '../src/utils/ttsTrailingParticles'

const DEFAULT_ENGINE = 'http://localhost:50021'
const DEFAULT_SPEAKER = 6
const CONCURRENCY = 8

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data')

/** 突き合わせる辞書。3 つとも読み仮名を値に持つ（キーが衝突したら手書きが勝つ）。 */
const DICT_FILES = [
  'tts-phrase-break-dict',
  'tts-station-readings',
  'tts-epicenter-accents',
] as const

type Entry = { file: string; key: string; kana: string }
type Problem = { entry: Entry; particle: string; kind: string; detail: string }
type AccentPhrase = { moras: { text: string }[] }

function parseArgs(argv: string[]): { engine: string; speaker: number } {
  let engine = process.env.VOICEVOX_URL ?? DEFAULT_ENGINE
  let speaker = DEFAULT_SPEAKER
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--engine' && argv[i + 1]) { engine = argv[i + 1]; i += 1 }
    else if (argv[i] === '--speaker' && argv[i + 1]) { speaker = Number(argv[i + 1]); i += 1 }
  }
  if (!Number.isInteger(speaker) || speaker < 0) throw new Error(`--speaker が不正です: ${speaker}`)
  return { engine: engine.replace(/\/+$/, ''), speaker }
}

async function loadEntries(): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const file of DICT_FILES) {
    const raw = await readFile(join(DATA_DIR, `${file}.json`), 'utf8')
    const dict = JSON.parse(raw) as Record<string, unknown>
    for (const [key, value] of Object.entries(dict)) {
      // `_standalone` などの設定キーは辞書の項目ではない
      if (key.startsWith('_') || typeof value !== 'string') continue
      entries.push({ file, key, kana: value })
    }
  }
  return entries
}

/**
 * カナ表記をそのまま読ませてアクセント句を取る（`is_kana=true`）。
 *
 * **接続の失敗も戻り値で返す（投げない）。** 途中の一過性のネットワーク断で全体を落とすと、
 * **そこまでに見つけていた不一致がまとめて消え**、「見つからなかった」のか「見る前に落ちた」のかが
 * 区別できない結果だけが残る。
 */
async function accentPhrases(
  engine: string, speaker: number, kana: string,
): Promise<{ phrases?: AccentPhrase[]; error?: string }> {
  const url = `${engine}/accent_phrases?text=${encodeURIComponent(kana)}&speaker=${speaker}&is_kana=true`
  try {
    const res = await fetch(url, { method: 'POST' })
    if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 160)}` }
    return { phrases: await res.json() as AccentPhrase[] }
  } catch (err) {
    return { error: `接続できず: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 句ごとのモーラ列を `|` で繋いだ文字列（句の境目まで含めて突き合わせるため）。 */
const moraText = (phrases: AccentPhrase[]) =>
  phrases.map(p => p.moras.map(m => m.text).join('')).join('|')

export async function main(): Promise<void> {
  const { engine, speaker } = parseArgs(process.argv.slice(2))
  const entries = await loadEntries()
  if (entries.length === 0) throw new Error('辞書の項目を 1 つも読めませんでした')
  if (TRAILING_PARTICLES.length === 0) throw new Error('助詞の列挙が空です')

  const total = entries.length * TRAILING_PARTICLES.length
  console.log(`エンジン ${engine} / 話者 ${speaker}`)
  console.log(`助詞: ${TRAILING_PARTICLES.map(([s, k]) => `${s}=${k}`).join(' / ')}`)
  console.log(`対象 ${entries.length} 項目 × ${TRAILING_PARTICLES.length} 助詞 = ${total} 件`)

  const problems: Problem[] = []
  let done = 0
  let next = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < entries.length) {
      const entry = entries[next]
      next += 1
      const base = await accentPhrases(engine, speaker, entry.kana)
      if (!base.phrases) {
        // 助詞なしで取れない読みは、この検証の対象外（辞書自体の不備）。区別できる形で挙げる
        problems.push({ entry, particle: '(なし)', kind: 'base-error', detail: base.error ?? '' })
        continue
      }
      for (const [surface, kana] of TRAILING_PARTICLES) {
        const got = await accentPhrases(engine, speaker, entry.kana + kana)
        if (!got.phrases) {
          problems.push({ entry, particle: surface, kind: 'error', detail: got.error ?? '' })
          continue
        }
        if (got.phrases.length !== base.phrases.length) {
          problems.push({
            entry, particle: surface, kind: 'phrase-count',
            detail: `${base.phrases.length} 句 -> ${got.phrases.length} 句`,
          })
          continue
        }
        const expected = moraText(base.phrases) + kana
        const actual = moraText(got.phrases)
        if (actual !== expected) {
          problems.push({ entry, particle: surface, kind: 'mora-mismatch', detail: `${expected} != ${actual}` })
        }
      }
      done += 1
      if (done % 500 === 0) console.log(`  ${done}/${entries.length}`)
    }
  }))

  if (problems.length === 0) {
    console.log(`問題なし（${total} 件）`)
    return
  }
  const byKind = new Map<string, number>()
  for (const p of problems) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1)
  console.error(`問題 ${problems.length} 件: ${[...byKind].map(([k, n]) => `${k} ${n}`).join(' / ')}`)
  for (const p of problems.slice(0, 40)) {
    console.error(`  [${p.kind}] ${p.entry.file} ${p.entry.key}+${p.particle}  ${p.entry.kana}  ${p.detail}`)
  }
  if (problems.length > 40) console.error(`  ...ほか ${problems.length - 40} 件`)
  throw new Error('助詞を連結すると読みが変わる項目があります（上記）')
}

/**
 * **直接実行されたときだけ走らせる。** このファイルは今のところ他から import されていないが、
 * 定数を 1 つ読むための import で音声合成エンジンへ繋ぎに行く形を作らないため、
 * `scripts/` 配下の生成スクリプトと同じ門を置く（理由は `scripts/scriptEntrypoints.test.ts`）。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
