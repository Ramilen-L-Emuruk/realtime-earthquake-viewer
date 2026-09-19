// 読み上げに出る名前のアクセント核を、エンジンとは別の出典（UniDic）と突き合わせる監査。
//
//   npm run audit-accent-unidic
//   npm run audit-accent-unidic -- --upstream                 震央地名・震度観測点の上流も含める
//   npm run audit-accent-unidic -- --upstream --bare-check   エンジンの辞書に無い語を洗い出す
//   npm run audit-accent-unidic -- --engine http://192.168.1.10:50021 --speaker 6
//
// 【なぜ要るか】VOICEVOX（OpenJTalk）が置く核は、語が内蔵辞書にあればその値、無ければ構成要素
// からの推定になる。**推定が外れた語は読みも句数も正しい**ので、誤読の突き合わせにも句割りの
// 判定にも掛からない（→ `docs/spec/audio-tts-spec.md` §3「エンジンが置く核が外れているとき」）。
//
// 【出典】UniDic（国立国語研究所）現代書き言葉フルパッケージの `lex_3_1.csv`。33 列のうち
// 28 列目がアクセント型（`aType`。0 が平板、揺れがある語は `,` 区切りの複数値）。**zip 全体は
// 1.75GB あるが、この 1 ファイルは圧縮 25MB** なので、zip 末尾の目録（Central Directory）を
// HTTP Range で読んで該当エントリだけを抜き、`.claude/unidic-cache/` に残す。
//
// 【比べられる範囲】**名前まるごとが 1 語として UniDic に載っているものだけ。** アクセント句
// ごとに比べる形は採らない —— 複合語のアクセントは構成要素の単語アクセントとは別物で、当てると
// 偽陽性だらけになる（2026-09-19 の実測で 2273 句中 948 句が「食い違い」に化けた）。
//
// 【--bare-check】名前を読点なしで読ませ、読点ありと読みが変わるものを出す。**変われば 1 語と
// してエンジンの辞書に無い**（`甲信` → `キノエ｜シン` と漢字を 1 字ずつ読む）＝核が推定値。
// 辞書に値がある語は素の読みを使わないので対象外。エンジンへの問い合わせが倍になるため既定では回さない。
// **観測点名まで見たいなら `--upstream` と併用すること** —— 観測点の生の一覧はそちらでしか集めない
// （`tts-station-readings.json` 由来のものは値を持つので、この検査の対象から外れる）。
//
// 【いつ回すか】辞書を作り直したとき・観測点や区域が増えたとき。
//
// 【食い違いが出ても exit 0】正解を決めるのは耳で、これは候補を出すところまで。取得そのものに
// 失敗したときだけ exit 1（列位置は既知の語で検算する）。
import { mkdirSync, existsSync, readFileSync, writeFileSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { inflateRawSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EEW_WARNING_REGION_ORDER } from '../src/utils/eewWarningRegions'
import { toKana, splitIntoMoras } from './stationReading'
import { SOURCE_URL as EPICENTER_SOURCE_URL } from './build-epicenter-accents'
import { splitEpicenterDetailed } from './epicenterAccent'
import { buildCityIndex, splitStationName } from './stationPhrase'
import { fetchCodeTableBook, readCityFurigana } from './build-station-readings'
import { fetchListedStations } from './lib/stationSource.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(scriptDir, '..')
const CACHE_DIR = resolve(ROOT, '.claude/unidic-cache')

/** 現代書き言葉 UniDic のフルパッケージ。**版を上げたら aType の列位置を確かめ直すこと。** */
const UNIDIC_ZIP_URL = 'https://clrd.ninjal.ac.jp/unidic_archive/cwj/3.1.0/unidic-cwj-3.1.0-full.zip'
const LEX_ENTRY_SUFFIX = 'lex_3_1.csv'
/** `lex_3_1.csv` の列。**位置は既知の語で確かめてから使う**（下の検算）。 */
const COL = { surface: 0, pos1: 4, pos2: 5, pos3: 6, pron: 13, aType: 28 } as const
/** 列位置の検算に使う語と期待値。合わなければ版か列構成が変わったとみて止める。 */
const COLUMN_FIXTURE = { surface: '北海道', pron: 'ホッカイドー', aType: '3' } as const

type Phrase = { moras: string; accent: number; n: number }
type Target = { name: string; kinds: string[]; dictValue?: string }
type UnidicWord = { surface: string; pos: string; pron: string; aType: string }

// ---------------------------------------------------------------- UniDic の取得

async function range(url: string, from: number, to: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } })
  if (res.status !== 206) throw new Error(`Range 取得に失敗しました（${res.status}）: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** zip 末尾の目録を読み、目的のエントリだけを Range で取って展開する。 */
async function fetchLexCsv(): Promise<string> {
  const cached = resolve(CACHE_DIR, LEX_ENTRY_SUFFIX)
  if (existsSync(cached)) return cached

  const head = await fetch(UNIDIC_ZIP_URL, { method: 'HEAD' })
  if (!head.ok) throw new Error(`UniDic の取得に失敗しました（${head.status}）`)
  const size = Number(head.headers.get('content-length'))
  if (!Number.isFinite(size) || size <= 0) throw new Error('UniDic の大きさを取得できませんでした')

  const tail = await range(UNIDIC_ZIP_URL, size - Math.min(65557, size), size - 1)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip の目録（EOCD）が見つかりませんでした')
  const cdOff = tail.readUInt32LE(eocd + 16)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cd = await range(UNIDIC_ZIP_URL, cdOff, cdOff + cdSize - 1)

  let p = 0
  let hit: { comp: number; lho: number; method: number } | null = null
  while (p < cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const cmtLen = cd.readUInt16LE(p + 32)
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (name.endsWith(LEX_ENTRY_SUFFIX)) {
      hit = { comp: cd.readUInt32LE(p + 20), lho: cd.readUInt32LE(p + 42), method: cd.readUInt16LE(p + 10) }
    }
    p += 46 + nameLen + extraLen + cmtLen
  }
  if (!hit) throw new Error(`zip の中に ${LEX_ENTRY_SUFFIX} がありません（UniDic の構成が変わった可能性）`)

  const lh = await range(UNIDIC_ZIP_URL, hit.lho, hit.lho + 29)
  const dataAt = hit.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  const comp = await range(UNIDIC_ZIP_URL, dataAt, dataAt + hit.comp - 1)
  const raw = hit.method === 8 ? inflateRawSync(comp, { maxOutputLength: 1 << 30 }) : comp
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cached, raw)
  console.log(`  語彙表を取得しました（圧縮 ${(hit.comp / 1e6).toFixed(1)}MB → ${(raw.length / 1e6).toFixed(0)}MB）`)
  return cached
}

/** 引用符付きの CSV を 1 行ぶん分解する（`aType` は揺れがあると `"3,0"` のように囲まれる）。 */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c !== '"') cur += c
      else if (line[i + 1] === '"') { cur += '"'; i++ }
      else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

/** 表層形が `surfaces` にある行だけを拾う。233MB を 1 回だけ流す。 */
async function loadUnidic(path: string, surfaces: ReadonlySet<string>): Promise<Map<string, UnidicWord[]>> {
  const out = new Map<string, UnidicWord[]>()
  let fixtureSeen = false
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    const head = line.slice(0, line.indexOf(','))
    if (!surfaces.has(head) && head !== COLUMN_FIXTURE.surface) continue
    const f = parseCsvLine(line)
    if (f.length <= COL.aType || f[COL.surface] !== head) continue
    const word: UnidicWord = {
      surface: f[COL.surface],
      pos: `${f[COL.pos1]}/${f[COL.pos2]}/${f[COL.pos3]}`,
      pron: f[COL.pron],
      aType: f[COL.aType],
    }
    if (word.surface === COLUMN_FIXTURE.surface && word.pron === COLUMN_FIXTURE.pron) {
      if (word.aType !== COLUMN_FIXTURE.aType) {
        throw new Error(
          `列位置の検算に失敗しました（${COLUMN_FIXTURE.surface} の aType が "${word.aType}"、`
          + `期待は "${COLUMN_FIXTURE.aType}"）。UniDic の版か列構成が変わっています`,
        )
      }
      fixtureSeen = true
    }
    if (!surfaces.has(head)) continue
    const list = out.get(head)
    if (list) list.push(word)
    else out.set(head, [word])
  }
  if (!fixtureSeen) throw new Error(`列位置の検算に使う語（${COLUMN_FIXTURE.surface}）が語彙表にありません`)
  return out
}

// ---------------------------------------------------------------- 対象語

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as T
}

/** 個別コード表の中で詳細震央地名（AreaEpicenterDetail）が載るシート。 */
const EPICENTER_DETAIL_SHEET = '43'

/** 上流が変わったことに気づくための下限（2026-09-20 時点で 757 件）。 */
const MIN_DETAILED_EPICENTERS = 600

/**
 * 個別コード表のブックは 1.6MB ある。`--upstream`（詳細震央地名）と `--components`（市町村の
 * ふりがな）の両方が要るので、1 回だけ取って使い回す。
 */
let codeTableBook: Promise<ReadonlyMap<string, unknown[][]>> | null = null
const codeTable = (): Promise<ReadonlyMap<string, unknown[][]>> => (codeTableBook ??= fetchCodeTableBook())

/**
 * 詳細震央地名を読む（気象庁 個別コード表 AreaEpicenterDetail）。
 *
 * **ふりがなを持たない列構成**（Code・Name の 2 列）なので名前だけを返す —— 読みはエンジンへ
 * 訊く。遠地地震の震央はここから声になり、**読みは 2026-08-22 の棚卸しで目で通したが核は
 * 見ていない**（→ `docs/spec/audio-tts-spec.md` §3「エンジンが置く核が外れているとき」）。
 */
function readDetailedEpicenters(book: ReadonlyMap<string, unknown[][]>): string[] {
  const rows = book.get(EPICENTER_DETAIL_SHEET)
  if (!rows) {
    throw new Error(
      `個別コード表に AreaEpicenterDetail のシート（${EPICENTER_DETAIL_SHEET}）がありません。`
      + 'コード表の構成が変わっていないか確かめてください。',
    )
  }
  // 先頭 3 行は見出し（コード表の題・種別・列名）。
  const names = rows.slice(3)
    .map((row) => row[1])
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  if (names.length < MIN_DETAILED_EPICENTERS) {
    throw new Error(
      `詳細震央地名が ${names.length} 件しか読めませんでした（${MIN_DETAILED_EPICENTERS} 件以上を想定）。`,
    )
  }
  return names
}

async function collectTargets(withUpstream: boolean, withComponents: boolean): Promise<Target[]> {
  const found = new Map<string, Target>()
  const put = (name: string, kind: string, dictValue?: string) => {
    if (!name) return
    const cur = found.get(name) ?? { name, kinds: [] as string[], dictValue }
    if (!cur.kinds.includes(kind)) cur.kinds.push(kind)
    if (dictValue && !cur.dictValue) cur.dictValue = dictValue
    found.set(name, cur)
  }

  const phraseBreak = readJson<Record<string, string | string[]>>('public/data/tts-phrase-break-dict.json')
  const terms = new Set((phraseBreak._terms as string[] | undefined) ?? [])
  for (const [key, value] of Object.entries(phraseBreak)) {
    if (key.startsWith('_') || typeof value !== 'string') continue
    put(key, terms.has(key) ? '一般用語' : '手書き辞書', value)
  }
  for (const [key, value] of Object.entries(readJson<Record<string, string>>('public/data/tts-station-readings.json'))) {
    if (!key.startsWith('_') && typeof value === 'string') put(key, '観測点(辞書)', value)
  }
  for (const [key, value] of Object.entries(readJson<Record<string, string>>('public/data/tts-epicenter-accents.json'))) {
    if (!key.startsWith('_') && typeof value === 'string') put(key, '震央地名(辞書)', value)
  }
  for (const area of readJson<{ name: string }[]>('public/data/subregions.json')) put(area.name, '区域')
  for (const key of Object.keys(readJson<Record<string, unknown>>('public/data/tsunami-zones.json'))) put(key, '津波予報区')
  for (const key of Object.keys(readJson<Record<string, unknown>>('public/data/prefectures.json'))) put(key, '都道府県')
  for (const region of EEW_WARNING_REGION_ORDER) put(region, 'EEW地方')

  if (withUpstream || withComponents) {
    const res = await fetch(EPICENTER_SOURCE_URL)
    if (!res.ok) throw new Error(`震央地名の取得に失敗しました（${res.status}）`)
    const geo = await res.json() as { features: { properties: Record<string, string> }[] }
    const stations = await fetchListedStations() as { name?: string; furigana?: string }[]
    if (withUpstream) {
      for (const feature of geo.features) put(feature.properties.name, '震央地名')
      for (const station of stations) put(station.name as string, '観測点')
      for (const name of readDetailedEpicenters(await codeTable())) {
        put(name, '詳細震央地名')
        // **読点で割った部分も入れる。** 読み上げはそこでチャンクを割るので（`splitIntoChunks`）、
        // 「米国、アラスカ州中央部」は 2 つの単位として別々に合成される。まるごとでは
        // 単語辞書に載らないが、`米国` のような部分なら載る。
        if (name.includes('、')) for (const part of name.split('、')) put(part, '詳細震央地名(読点で分割)')
      }
    }
    if (withComponents) await putComponents(put, geo.features, stations)
  }
  return [...found.values()]
}

/**
 * 名前を割った**構成要素**を対象へ加える。
 *
 * **いま末尾核で鳴っている語は、ここでしか裏が取れない。** 震央地名の前部・後部要素も、
 * 観測点名の前半（市町村名）も、エンジンへ訊いて 1 句にまとまらなかった・誤読したものは
 * 末尾核で近似してある（`build-epicenter-accents.ts` の `measureAccent`／
 * `build-station-readings.ts` の `fetchCityAccents`）。**名前まるごとは複合語なので UniDic に
 * 載らないが、構成要素は単語として載ることがある。**
 *
 * 割り方は生成側と同じものを通す（`splitEpicenterDetailed` / `splitStationName`）——
 * 別の割り方で集めると、実際に鳴っている句とは違うものを検べることになる。
 */
async function putComponents(
  put: (name: string, kind: string) => void,
  features: readonly { properties: Record<string, string> }[],
  stations: readonly { name?: string; furigana?: string }[],
): Promise<void> {
  for (const feature of features) {
    const name = feature.properties?.name
    const kana = feature.properties?.name_kana
    if (!name || !kana) continue
    const outcome = splitEpicenterDetailed(name, kana)
    if (!('split' in outcome)) continue
    put(outcome.split.head, '震央地名(前部)')
    put(outcome.split.tail, '震央地名(後部)')
  }
  const cities = buildCityIndex(readCityFurigana(await codeTable()))
  for (const station of stations) {
    if (!station.name || !station.furigana) continue
    const outcome = splitStationName(station.name, station.furigana, cities)
    if (outcome.kind !== 'split') continue
    put(outcome.split.city, '観測点(市町村)')
  }
}

// ---------------------------------------------------------------- いまの核

/** AquesTalk 風カナ表記（`/` 句区切り・`'` 核）を句の並びへ。 */
export function parseAquesTalk(value: string): Phrase[] {
  return value.split('/').map((segment) => {
    const at = segment.indexOf("'")
    const kana = segment.replace(/'/g, '')
    return {
      moras: kana,
      accent: at < 0 ? 0 : splitIntoMoras(segment.slice(0, at)).length,
      n: splitIntoMoras(kana).length,
    }
  })
}

async function accentPhrasesOf(engine: string, speaker: number, text: string): Promise<Phrase[]> {
  const url = `${engine}/accent_phrases?text=${encodeURIComponent(text)}&speaker=${speaker}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) throw new Error(`エンジンが ${res.status} を返しました（${text}）`)
  const phrases = await res.json() as { accent: number; moras: { text: string }[] }[]
  return phrases.map((p) => ({ moras: p.moras.map((m) => m.text).join(''), accent: p.accent, n: p.moras.length }))
}

/**
 * 読点を付けて読ませる。**付けないと未知語が 1 字ずつに割れて核を測れない**
 * （`甲信` は単体だと `キノエ｜シン`）。読み上げ文も名前の後ろに必ず読点か助詞を置く。
 */
const withComma = (engine: string, speaker: number, name: string) =>
  accentPhrasesOf(engine, speaker, `${name}、`)

// ---------------------------------------------------------------- 突き合わせ

/**
 * `名前、` の形では**平板と尾高を区別できない**（後続が無いので accent = モーラ数 で返る）。
 * そのため 0 とモーラ数は同値として扱う。区別したければ助詞を続けた形で読ませること。
 */
function accentMatches(aType: number, accent: number, moras: number): boolean {
  if (aType === accent) return true
  const flatLike = (v: number) => v === 0 || v === moras
  return flatLike(aType) && flatLike(accent)
}

function accentTypesOf(word: UnidicWord): number[] {
  return word.aType.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number)
}

type Finding = { target: Target; phrase: Phrase; types: number[]; pos: string[] }

/** エンジンが 1 語として読めず、いま末尾核へ倒れている語。UniDic に核がある分だけ拾う。 */
type FallbackCandidate = { target: Target; moras: string; types: number[]; pos: string[] }

/**
 * 1 句に収まらなかった語を、UniDic に載っていれば候補として控える。
 *
 * **読みの照合は句を連結して行う。** 割れているのはエンジンが語の切れ目を見つけられなかった
 * だけで、読み自体は同じもの。連結しないと同じ表記の別語を弾けない。
 */
function collectFallbackCandidate(
  target: Target,
  phrases: readonly Phrase[],
  words: readonly UnidicWord[],
  out: FallbackCandidate[],
): void {
  const moras = phrases.map((p) => p.moras).join('')
  const sameReading = words.filter((w) => toKana(w.pron) === toKana(moras))
  if (!sameReading.length) return
  const places = sameReading.filter((w) => w.pos.includes('地名'))
  const use = places.length ? places : sameReading
  const types = [...new Set(use.flatMap(accentTypesOf))]
  if (!types.length) return
  out.push({ target, moras, types, pos: [...new Set(use.map((w) => w.pos))] })
}

/** 読点なしで読みが変わる語＝エンジンの辞書に 1 語として無い語を列挙する。 */
async function reportBareCheck(engine: string, speaker: number, targets: readonly Target[]): Promise<void> {
  // 辞書に値がある語は素の読みを使わないので対象外
  const bare = targets.filter((t) => !t.dictValue)
  console.log(`\n=== 単体読みの検査（辞書に値が無い ${bare.length} 語）===`)
  const changed: { name: string; kinds: string[]; withComma: string; bare: string }[] = []
  for (const target of bare) {
    const a = await withComma(engine, speaker, target.name)
    const b = await accentPhrasesOf(engine, speaker, target.name)
    const sig = (ps: Phrase[]) => ps.map((p) => `${p.moras}(${p.accent})`).join('|')
    if (a.map((p) => p.moras).join('') !== b.map((p) => p.moras).join('')) {
      changed.push({ name: target.name, kinds: target.kinds, withComma: sig(a), bare: sig(b) })
    }
  }
  if (!changed.length) {
    console.log('  読点の有無で読みが変わる語はありません（どれも 1 語として辞書にある）。')
    return
  }
  console.log(`  ${changed.length} 語で読みが変わりました（1 語として辞書に無く、核は推定値）:`)
  for (const c of changed) {
    console.log(`    ${c.name}  [${c.kinds.join(',')}]`)
    console.log(`        読点あり ${c.withComma}`)
    console.log(`        単体     ${c.bare}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const argOf = (name: string, fallback: string) => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback
  }
  const engine = argOf('--engine', 'http://localhost:50021').replace(/\/+$/, '')
  const speaker = Number(argOf('--speaker', '6'))
  const withUpstream = args.includes('--upstream')
  const bareCheck = args.includes('--bare-check')
  const withComponents = args.includes('--components')

  console.log('対象語を集めています…')
  const targets = await collectTargets(withUpstream, withComponents)
  const byKind: Record<string, number> = {}
  for (const target of targets) for (const kind of target.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1
  console.log(`  ${targets.length} 語`, byKind)

  console.log('UniDic の語彙表を読んでいます…')
  const unidic = await loadUnidic(await fetchLexCsv(), new Set(targets.map((t) => t.name)))
  console.log(`  1 語として載っていたのは ${unidic.size} 語`)
  if (unidic.size === 0) {
    throw new Error('UniDic から 1 語も引けませんでした（対象語か語彙表の取得が壊れています）')
  }

  // 比べられるのは「名前まるごとが UniDic にある」ものだけなので、エンジンへ訊くのもその分でよい
  const findings: Finding[] = []
  const fallbackCandidates: FallbackCandidate[] = []
  let single = 0
  let readingMismatch = 0
  let noType = 0
  for (const target of targets) {
    const words = unidic.get(target.name)
    if (!words) continue
    const phrases = target.dictValue
      ? parseAquesTalk(target.dictValue)
      : await withComma(engine, speaker, target.name)
    if (phrases.length !== 1) {
      // **エンジンが 1 語として読めなかった語。** 生成側もここで実測を諦めて末尾核へ倒している
      // （`build-epicenter-accents.ts` の `measureAccent` / `build-station-readings.ts` の
      // `fetchCityAccents` は、どちらも 1 句に収まらなければ採らない）。**UniDic に載っているなら
      // そちらから核を採れる** —— 黙って飛ばすと、末尾核のまま直せる語があることに気づけない。
      // 辞書に値がある語は意図して句へ割ったものなので、この枠では見ない
      if (!target.dictValue) collectFallbackCandidate(target, phrases, words, fallbackCandidates)
      continue
    }
    single++
    const phrase = phrases[0]
    const pron = toKana(phrase.moras)
    const sameReading = words.filter((w) => toKana(w.pron) === pron)
    if (!sameReading.length) { readingMismatch++; continue }
    // 同じ表記で品詞が分かれる語（人名と地名）は地名を優先する
    const places = sameReading.filter((w) => w.pos.includes('地名'))
    const use = places.length ? places : sameReading
    const types = [...new Set(use.flatMap(accentTypesOf))]
    if (!types.length) { noType++; continue }
    if (!types.some((v) => accentMatches(v, phrase.accent, phrase.n))) {
      findings.push({ target, phrase, types, pos: [...new Set(use.map((w) => w.pos))] })
    }
  }

  console.log(`\n1 句で読まれる語 ${single} 件のうち、読みも一致して比べられたのは ${single - readingMismatch - noType} 件`)
  if (readingMismatch) console.log(`  ${readingMismatch} 件は UniDic 側が同じ表記の別語で、読みが合わない`)
  if (noType) console.log(`  ${noType} 件はアクセント型を持たない`)

  // **0 件でも出す。**「見つからなかった」と「見ていない」を読み手が区別できるように
  if (!fallbackCandidates.length) {
    console.log()
    console.log('エンジンが 1 語として読めない語のうち、UniDic に核があるものはありません。')
  } else {
    console.log()
    console.log(
      `=== エンジンが 1 語として読めず、UniDic に核がある ${fallbackCandidates.length} 件 ===`,
    )
    console.log('  いまは末尾核へ倒れている。UniDic の値を当てれば直せる見込みがある。')
    for (const c of fallbackCandidates) {
      console.log(`  ${c.target.name}  [${c.target.kinds.join(',')}]`)
      console.log(`      読み     ${c.moras}`)
      console.log(`      UniDic   aType=${c.types.join(',')}  ${c.pos.join(' ')}`)
    }
  }

  if (!findings.length) {
    console.log('\n食い違いはありません。')
  } else {
    console.log(`\n=== 食い違い ${findings.length} 件 ===`)
    for (const f of findings) {
      const source = f.target.dictValue ? `辞書 ${f.target.dictValue}` : 'エンジン'
      console.log(`  ${f.target.name}  [${f.target.kinds.join(',')}]`)
      console.log(`      いま     ${f.phrase.moras} 核${f.phrase.accent}/${f.phrase.n}（${source}）`)
      console.log(`      UniDic   aType=${f.types.join(',')}  ${f.pos.join(' ')}`)
    }
    console.log('\n**正解を決めるのは耳。** 候補を実運用の経路で音にして聞き比べてから辞書へ入れること')
    console.log('（→ docs/spec/audio-tts-spec.md §3「エンジンが置く核が外れているとき」）。')
  }

  if (bareCheck) await reportBareCheck(engine, speaker, targets)
}

// 直接実行のときだけ走らせる。import だけで監査が走ると、エンジンが無い環境ではテストごと落ちる
// （理由は build-epicenter-accents.ts の同じ門のコメントに詳しい）。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
