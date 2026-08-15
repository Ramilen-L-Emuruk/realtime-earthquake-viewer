// 実地震テスト用シナリオのキャプチャCLI。
// DMDATA archiveから実際の電文を取得し、パース済みの内部型(AppEvent等)としてJSON化する
// （生電文は保存しない。standard版・DMDSS版どちらでも同じJSONで再生できるようにするため）。
//
// 使い方:
//   npm run capture-scenario -- --from=2024-01-01T07:09:00Z --to=2024-01-01T07:30:00Z \
//     --id=2024-noto --label="2024年能登半島地震" --description="M7.6 最大震度7 大津波警報" --category=eew-special
//
// APIキーの置き場所・渡し方・優先順位は docs/spec/settings-pwa-spec.md §6 を参照。
import { JSDOM } from 'jsdom'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fetchDmdataReplayEvents } from '../src/services/dmdataReplay'
import type { TestScenarioFile, TestScenarioMeta, TestScenarioEntry } from '../src/types/testScenario'

// APIキーをリポジトリ直下の .env.local から読む（雛形は .env.example）。
// 実行ディレクトリに依存しないよう、スクリプト位置からリポジトリ直下を解決する。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
if (typeof process.loadEnvFile !== 'function') {
  // 古いNodeでは `process.loadEnvFile is not a function` という原因の分かりにくい
  // TypeErrorになるため、必要バージョンを名指しして止める。
  console.error('Node.js 20.12 以上が必要です（.env.local の読み込みに process.loadEnvFile を使用）')
  process.exit(1)
}
try {
  process.loadEnvFile(join(repoRoot, '.env.local'))
} catch (err) {
  // 未配置は正常系（実行時の環境変数・--api-key で渡す経路を残すため）。
  // それ以外（ディレクトリだった・権限が無い等）は握り潰さず、内部スタックの代わりに
  // 何が起きたかを一行で示す。
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error(`.env.local を読み込めませんでした: ${(err as Error).message}`)
    process.exit(1)
  }
}

// dmdataParser.ts の南海トラフ・後発地震(VYSE50/51/60)XMLパースが `new DOMParser()` を
// ブラウザグローバルとして参照するため、Node.js環境ではjsdomで代替する。
const { window } = new JSDOM('')
globalThis.DOMParser = window.DOMParser as unknown as typeof DOMParser

const SCENARIO_CATEGORIES = ['eew-special', 'eew-warning', 'eew-forecast', 'quake', 'tsunami', 'lpgm', 'foreign'] as const

interface CliArgs {
  apiKey: string
  from: Date
  to: Date
  id: string
  label: string
  description: string
  category: TestScenarioMeta['category']
}

// BOM付きで保存された .env.local は変数名の先頭にBOMが混ざり、別名の変数として読まれるため
// キーが未設定に見える。BOMはエディタで不可視で原因に辿り着けないため、ここで判定して明示する。
// PowerShellのリダイレクト・Out-Fileが付けうるUTF-16(FF FE / FE FF)も対象にする。
function hasByteOrderMark(path: string): boolean {
  let head: Buffer
  try {
    head = readFileSync(path).subarray(0, 3)
  } catch {
    // 未配置・読み取り不可はBOM以前の問題。呼び出し側が別のエラーを既に出しているため、
    // ここでは「BOMではない」に丸めて追加のヒントを出さない。
    return false
  }
  return (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)
    || (head[0] === 0xff && head[1] === 0xfe)
    || (head[0] === 0xfe && head[1] === 0xff)
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      'api-key': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      id: { type: 'string' },
      label: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
    },
  })

  const apiKey = values['api-key'] ?? process.env.DMDATA_API_KEY
  if (!apiKey) {
    console.error('APIキーが必要です（.env.local の DMDATA_API_KEY / 環境変数 / --api-key のいずれか。雛形は .env.example）')
    if (hasByteOrderMark(join(repoRoot, '.env.local'))) {
      console.error('  → .env.local がBOM付きで保存されています。BOMなしUTF-8で保存し直してください')
    }
    process.exit(1)
  }
  const requiredKeys = ['from', 'to', 'id', 'label', 'description'] as const
  for (const key of requiredKeys) {
    if (!values[key]) {
      console.error(`--${key} は必須です`)
      process.exit(1)
    }
  }
  const category = values.category ?? 'quake'
  if (!(SCENARIO_CATEGORIES as readonly string[]).includes(category)) {
    console.error(`--category は次のいずれかである必要があります: ${SCENARIO_CATEGORIES.join(', ')}`)
    process.exit(1)
  }

  return {
    apiKey,
    from: new Date(values.from as string),
    to: new Date(values.to as string),
    id: values.id as string,
    label: values.label as string,
    description: values.description as string,
    category: category as TestScenarioMeta['category'],
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs()

  console.log(`DMDATA archiveから ${args.from.toISOString()} 〜 ${args.to.toISOString()} を取得中...`)
  const { entries, skipped, failedArchiveUrls } = await fetchDmdataReplayEvents(args.apiKey, args.from, args.to)
  // 収録したシナリオが「実際より静かな」ものになっていないか判断できるよう、
  // 取りこぼしがあれば件数を出す（詳細は取得時の警告ログを参照）。
  // 0 件で終了する場合こそこの情報が要る（本当に静かだったのか、取りこぼして
  // 0 件になったのかを区別できない）ため、件数チェックより前に出す。
  if (skipped > 0 || failedArchiveUrls.length > 0) {
    console.warn(`警告: ${skipped}件の電文・${failedArchiveUrls.length}件のアーカイブを取り込めませんでした`)
  }
  if (entries.length === 0) {
    console.error('指定範囲に電文が見つかりませんでした')
    process.exit(1)
  }
  console.log(`${entries.length}件の電文を取得しました`)

  const baseTime = entries[0].replayTime
  const scenarioEntries: TestScenarioEntry[] = entries.map(e => ({
    offsetMs: e.replayTime.getTime() - baseTime.getTime(),
    payload: e.payload,
    silent: e.silent,
  }))

  const meta: TestScenarioMeta = {
    id: args.id,
    label: args.label,
    description: args.description,
    category: args.category,
    durationMs: scenarioEntries.at(-1)!.offsetMs,
  }
  const scenario: TestScenarioFile = {
    ...meta,
    baseTime: baseTime.toISOString(),
    entries: scenarioEntries,
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'test-scenarios')
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, `${scenario.id}.json`), JSON.stringify(scenario, null, 2))

  const indexPath = join(outDir, 'index.json')
  let index: TestScenarioMeta[] = []
  try {
    index = JSON.parse(await readFile(indexPath, 'utf-8')) as TestScenarioMeta[]
  } catch {
    // 初回作成（index.jsonがまだ無い）
  }
  index = [...index.filter(m => m.id !== meta.id), meta]
  await writeFile(indexPath, JSON.stringify(index, null, 2))

  console.log(`書き出し完了: ${scenario.id}.json (${scenarioEntries.length}件, 再生時間 ${(scenario.durationMs / 1000).toFixed(0)}秒)`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
