// 実地震テスト用シナリオのキャプチャCLI。
// DMDATA archiveから実際の電文を取得し、パース済みの内部型(AppEvent等)としてJSON化する
// （生電文は保存しない。standard版・DMDSS版どちらでも同じJSONで再生できるようにするため）。
//
// 使い方（APIキーはシェル履歴に残らないよう環境変数 DMDATA_API_KEY で渡すことを推奨。
// --api-key 引数でも指定できるが、その場合コマンド履歴・プロセス一覧に残る点に注意）:
//   DMDATA_API_KEY=<KEY> npm run capture-scenario -- --from=2024-01-01T07:09:00Z --to=2024-01-01T07:30:00Z \
//     --id=2024-noto --label="2024年能登半島地震" --description="M7.6 最大震度7 大津波警報" --category=eew-special
import { JSDOM } from 'jsdom'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fetchDmdataReplayEvents } from '../src/services/dmdataReplay'
import type { TestScenarioFile, TestScenarioMeta, TestScenarioEntry } from '../src/types/testScenario'

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
    console.error('APIキーが必要です（--api-key または環境変数 DMDATA_API_KEY）')
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
  const entries = await fetchDmdataReplayEvents(args.apiKey, args.from, args.to)
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
