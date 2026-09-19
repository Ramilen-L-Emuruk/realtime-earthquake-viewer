// 読み（カタカナ）の長音を母音の重ねへ開く。中身は Python 側（`open_long_vowels.py`）。
//
// **なぜ Python なのか** —— 長音かどうかは語の切れ目で決まり（`ちょう`＝町 は長音、`のうら`＝ノ＋浦
// は長音でない）、判定に形態素解析が要る。Node 側に同等の解析器が無いため、`fugashi` ＋
// `unidic-lite` を持つ Python を子プロセスで呼ぶ。詳しい理由と方式は Python 側の冒頭にある。
//
// **要るのは生成するときだけ。** 開いた結果は生成物へ焼き込まれるので、アプリと CI には影響しない
// （`build-station-readings` が元から VOICEVOX を要求するのと同じ立て付け）。

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'open_long_vowels.py')

/**
 * 子プロセスの待ち上限。**無期限に待たせない** —— 全件を 1 回で渡す作りなので、形態素解析が
 * 詰まると生成スクリプトが理由も出さずに無反応になる。2026-09 の実測は 2669 件で数秒。
 */
const LONG_VOWEL_TIMEOUT_MS = 120_000

/** 開く対象。`name` は漢字表記（語の切れ目を出すのに要る）、`reading` はカタカナの読み。 */
export type LongVowelItem = {
  readonly name: string
  readonly reading: string
}

/**
 * 読みの長音をまとめて開く。**全件を 1 回の呼び出しで渡す**（起動のたびに辞書を読むため、
 * 1 件ずつ呼ぶと桁違いに遅い）。
 *
 * **開けなかったら止める。** 黙って素通しすると、長音でない音で鳴る辞書が「直したつもり」で
 * 書き出される。生成物を見ても気づけない（値としては正しい形をしている）。
 *
 * @param python 実行する Python。既定は `python`。
 * @returns `items` と同じ並びの、開いた読み。
 */
export function openLongVowels(
  items: readonly LongVowelItem[],
  python = process.env.PYTHON ?? 'python',
): string[] {
  if (items.length === 0) return []
  const res = spawnSync(python, [SCRIPT], {
    input: JSON.stringify(items),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: LONG_VOWEL_TIMEOUT_MS,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (res.signal === 'SIGTERM' && res.error == null) {
    throw new Error(
      `読みの長音を開く処理が ${LONG_VOWEL_TIMEOUT_MS / 1000} 秒で終わりませんでした`
      + `（${items.length} 件）。形態素解析が詰まっている可能性があります。`,
    )
  }
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message
      : ((res.stderr || '').trim() || '（詳細は出力されませんでした）')
    throw new Error(
      `読みの長音を開けませんでした（${python} ${SCRIPT}）。`
      + '形態素解析が要ります: pip install fugashi unidic-lite\n'
      + detail,
    )
  }
  let opened: unknown
  try {
    opened = JSON.parse(res.stdout)
  } catch {
    throw new Error(`長音を開く処理の出力を読めませんでした: ${res.stdout.slice(0, 200)}`)
  }
  if (!Array.isArray(opened) || opened.length !== items.length) {
    throw new Error(
      `長音を開く処理が ${items.length} 件に対して ${Array.isArray(opened) ? opened.length : '不明な形'} を返しました。`,
    )
  }
  // **変わってよいのは「長音の開き方」だけ。** 核の位置は読みの長さで数えているので長さが
  // 変われば辞書の値が黙って壊れるし、母音の開き以外の書き換えが混じれば別の音になる
  // （どちらも `/accent_phrases` は通ってしまうので、ここで止めないと声を聞くまで気づけない）。
  const broken = items
    .map((item, i) => ({ item, got: String(opened[i]), problem: openingProblem(item.reading, String(opened[i])) }))
    .filter(({ problem }) => problem !== null)
  if (broken.length > 0) {
    const sample = broken.slice(0, 3)
      .map(({ item, got, problem }) => `${item.name}（${item.reading} → ${got}: ${problem}）`)
    throw new Error(
      `長音の開き方が想定と違います（${broken.length} 件）: ${sample.join('・')}`,
    )
  }
  return items.map((_, i) => String(opened[i]))
}

/**
 * 開いた読みが「長音の開き方だけ」変わっているかを見る。問題があればその説明を返す。
 *
 * **許すのは `ウ` → `オ` と `イ` → `エ` だけ。** 長音を母音の重ねで書き直す変換なので、
 * それ以外の字が動いたら開く処理そのものがおかしい。
 *
 * **これで捕まえられないもの**: 語の切れ目を取り違えて開いた誤り（`ゴオノウラ` を
 * `ゴオノオラ` にしてしまう類）。変換の形としては正しいので、ここでは区別が付かない
 * —— 正しさを決めるのは語の知識で、それは形態素解析の側が受け持つ。
 */
export function openingProblem(before: string, after: string): string | null {
  const a = [...before]
  const b = [...after]
  if (a.length !== b.length) return `長さが ${a.length} から ${b.length} へ変わった`
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue
    if (a[i] === 'ウ' && b[i] === 'オ') continue
    if (a[i] === 'イ' && b[i] === 'エ') continue
    return `${i + 1} 文字目が ${a[i]} から ${b[i]} へ変わった`
  }
  return null
}

/** AquesTalk 風カナの値から、核（`'`）と句区切り（`/`）を除いた読みを取り出す。 */
export function readingOfEntry(value: string): string {
  return value.replace(/['/]/g, '')
}

/**
 * 開いた読みを値へ書き戻す。**核と句区切りの位置はそのまま**。
 *
 * 長音を開いてもモーラ数は変わらない（`ウ` → `オ` は 1 文字のまま）ので、カナだけを順に
 * 差し替えれば位置は保たれる。長さが変わる変換は {@link openLongVowels} が弾いている。
 */
export function applyOpenedReading(value: string, opened: string): string {
  const chars = [...value]
  const body = chars.filter((ch) => ch !== "'" && ch !== '/')
  // **足りなければ落とす。** 元の文字で埋めると、句区切りと核の位置だけが正しく見えて
  // 読みの一部が開かれないまま残る（生成物は形として成立するので、声を聞くまで気づけない）
  if (body.length !== [...opened].length) {
    throw new Error(`開いた読みの長さが合いません: ${value} ← ${opened}`)
  }
  const openedChars = [...opened]
  let i = 0
  let out = ''
  for (const ch of chars) {
    out += (ch === "'" || ch === '/') ? ch : openedChars[i++]
  }
  return out
}

/**
 * 句の出どころ。**漢字まで渡す** —— 揃えるときの鍵に使う（下の {@link openLongVowelsInEntries}）。
 */
export type PhraseOrigin = {
  /** 句の漢字表記（`当別町白樺` を市町村で割ったなら `当別町` と `白樺`）。 */
  readonly kanji: string
}

/**
 * 辞書（キー＝漢字表記・値＝AquesTalk 風カナ）の値をまとめて開く。
 *
 * **核と句区切りは保つ。** 開けなかった値はそのまま残る（{@link openLongVowels} が
 * 形態素ごとに安全側へ倒すため）。
 *
 * @param origins 値の句に対応する漢字。**渡した名前だけが「揃え」の対象になる**
 *   （→ {@link unifyOpenedPhrases}）。渡さなければ揃えない。
 */
export function openLongVowelsInEntries(
  entries: ReadonlyMap<string, string>,
  origins?: ReadonlyMap<string, readonly PhraseOrigin[]>,
  python?: string,
): Map<string, string> {
  const keys = [...entries.keys()]
  const items = keys.map((name) => ({ name, reading: readingOfEntry(entries.get(name) as string) }))
  const opened = openLongVowels(items, python)
  const out = new Map<string, string>()
  keys.forEach((name, i) => {
    out.set(name, applyOpenedReading(entries.get(name) as string, opened[i]))
  })
  return origins == null ? out : unifyOpenedPhrases(entries, out, origins)
}

/**
 * **同じ句は同じ開き方へ揃える。**
 *
 * 形態素解析は隣の語によって同じ漢字の読みを変える —— `浜中町湯沸` の「町」は `マチ`、
 * `浜中町茶内` では `チョウ` と推定される。読みがふりがなと一致した形態素だけを採る作りなので、
 * **同じ市町村名が一方のエントリでだけ開かれる**（手当てする前は 60 グループ）。そのままでは
 * 「同じ地名なのに、組み合わせる観測点によって発音が変わる」生成物になる。
 *
 * **鍵は「漢字と読みの組」。読みだけで揃えない。** 同じ読みで別の語を指す句が実データに 37 件ある
 * （`鷹栖町` と `高鷲町` はどちらも `タカスチョウ`）。読みだけを鍵にすると、ある語が「開かないのが
 * 正しい」と判定した句を、同音の別語が開いた結果で上書きしうる —— しかもその誤りは
 * {@link openingProblem}（字の動き方は正しい）でも {@link verifyOpenedEntries}（正規化すると
 * 一致する）でも捕まらない。
 *
 * **候補は全部集めてから決める。** 途中で「同数だから諦める」と印を付ける形だと、あとから
 * もっと開けた候補が来ても救えず、**辞書の並び順だけで結果が変わる**。最後に最多を採り、
 * 最多が複数あるときだけ諦めて名前を出す。
 */
export function unifyOpenedPhrases(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  origins: ReadonlyMap<string, readonly PhraseOrigin[]>,
): Map<string, string> {
  /** 「漢字＋開く前の読み」→ 開いた読みの候補。 */
  const candidates = new Map<string, Map<string, number>>()
  const keyOf = (kanji: string, reading: string) => `${kanji}\u0000${reading}`

  for (const [name, value] of after) {
    const origin = origins.get(name)
    if (origin == null) continue
    const from = (before.get(name) as string).split('/')
    const to = value.split('/')
    from.forEach((part, i) => {
      const kanji = origin[i]?.kanji
      if (kanji == null) return
      const raw = readingOfEntry(part)
      const got = readingOfEntry(to[i] ?? part)
      if (got === raw) return                       // この句は開かれていない
      const key = keyOf(kanji, raw)
      const seen = candidates.get(key) ?? new Map<string, number>()
      seen.set(got, (seen.get(got) ?? 0) + 1)
      candidates.set(key, seen)
    })
  }

  /** 元と違う文字がいくつあるか（＝どれだけ開けたか）。 */
  const openedCount = (raw: string, got: string) =>
    [...raw].reduce((n, ch, i) => n + (ch === got[i] ? 0 : 1), 0)

  const openedOf = new Map<string, string>()
  const unresolved: string[] = []
  for (const [key, seen] of candidates) {
    const raw = key.slice(key.indexOf('\u0000') + 1)
    let best: string | null = null
    let bestCount = -1
    let tied = false
    for (const got of seen.keys()) {
      const n = openedCount(raw, got)
      if (n > bestCount) { best = got; bestCount = n; tied = false }
      else if (n === bestCount) tied = true
    }
    if (best == null || tied) { unresolved.push(raw); continue }
    openedOf.set(key, best)
  }
  // **揃えられなかったものは黙らせない。** どちらが正しいか決める材料がここには無い
  if (unresolved.length > 0) {
    console.warn(
      `開き方を揃えられなかった句: ${unresolved.length} 件（そのままにします）`
      + `: ${unresolved.slice(0, 5).join('・')}`,
    )
  }

  const out = new Map<string, string>()
  for (const [name, value] of after) {
    const origin = origins.get(name)
    const from = (before.get(name) as string).split('/')
    const parts = value.split('/')
    const fixed = parts.map((part, i) => {
      const kanji = origin?.[i]?.kanji
      if (kanji == null) return part
      const source = from[i] ?? part
      const known = openedOf.get(keyOf(kanji, readingOfEntry(source)))
      return known == null ? part : applyOpenedReading(source, known)
    })
    out.set(name, fixed.join('/'))
  }
  return out
}

/**
 * 開いた値を**エンジンへ戻して確かめる**。
 *
 * **ここが無いと、開いた後の値は一度もエンジンを通らない。** 生成スクリプトのラウンドトリップ検証は
 * 開く前の値に掛かっており、開く処理はそのあとで走る。生成物は句数も核の位置も正しく見えるので、
 * 記法として壊れていても声を聞くまで気づけない。
 *
 * 見るのは 2 つ。**記法として通ること**（`is_kana=true` が受け付ける）と、**読みが開く前と
 * 同じものを指していること**（正規化して比べる）。
 *
 * **語の切れ目を取り違えて開いた誤りはここでは捕まえられない** —— `ゴオノウラ` を `ゴオノオラ` に
 * してしまう類は、正規化すると開く前と同じ形になるので一致してしまう。字の動き方そのものは
 * {@link openingProblem} が縛り、切れ目の正しさは形態素解析の側が受け持つ。
 *
 * @param pairs 開く前と後の値。変化しなかったものは渡さなくてよい。
 * @param readKana 値を `is_kana=true` で読ませて読み（カタカナ）を返す関数。
 * @param normalize 読みを突き合わせる前に通す正規化（`normalizeReading` を渡す）。
 * @returns 問題のあったものの説明。空なら全件が通った。
 */
export async function verifyOpenedEntries(
  pairs: readonly { readonly name: string; readonly before: string; readonly after: string }[],
  readKana: (entry: string) => Promise<string>,
  normalize: (reading: string) => string,
): Promise<string[]> {
  const problems: string[] = []
  for (const { name, before, after } of pairs) {
    let openedReading: string
    try {
      openedReading = await readKana(after)
    } catch (err) {
      problems.push(`${name} → ${after}: 読ませられない（${err instanceof Error ? err.message : err}）`)
      continue
    }
    const wanted = normalize(readingOfEntry(before))
    const got = normalize(openedReading)
    if (got !== wanted) problems.push(`${name} → ${after}: 読みが「${openedReading}」（開く前: ${readingOfEntry(before)}）`)
  }
  return problems
}
