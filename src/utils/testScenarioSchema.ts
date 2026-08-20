import type { TestScenarioFile, TestScenarioIndex, TestScenarioMeta, ScenarioCategory } from '../types/testScenario'

// 実地震シナリオファイル（`public/data/test-scenarios/`）の型検証ガード。
// スキーマ検証を怠ると壊れた JSON がそのまま instantiateScenario に渡り、
// 実行時例外を投げるか黙って壊れたエントリを再生してしまう。UI に「エラー」を出す代わりに
// バリデーション時に検出することで、シナリオ配信側の破損に対して防御的に振る舞う。

const CATEGORIES: ReadonlySet<ScenarioCategory> = new Set<ScenarioCategory>([
  'eew-special', 'eew-warning', 'eew-forecast',
  'quake', 'tsunami', 'lpgm', 'foreign',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isScenarioMeta(v: unknown): v is TestScenarioMeta {
  if (!isRecord(v)) return false
  if (typeof v.id !== 'string' || v.id.length === 0) return false
  if (typeof v.label !== 'string') return false
  if (typeof v.description !== 'string') return false
  if (typeof v.category !== 'string' || !CATEGORIES.has(v.category as ScenarioCategory)) return false
  if (typeof v.durationMs !== 'number' || !Number.isFinite(v.durationMs) || v.durationMs < 0) return false
  return true
}

/**
 * index.json の型検証。壊れた要素は落として通ったものだけ返す。
 *
 * malformed=true は「トップレベルが配列ですらない」深刻な破損を示す（HIGH #2 対策）。
 * これを skipped と別軸で扱うことで、呼び出し側は「正常な空リスト」と「配信破損」を
 * 区別してユーザーに通知できる（前者は「シナリオがありません」、後者は破損ログ）。
 */
export function validateScenarioIndex(v: unknown): { valid: TestScenarioIndex; skipped: number; malformed: boolean } {
  if (!Array.isArray(v)) return { valid: [], skipped: 0, malformed: true }
  const valid: TestScenarioMeta[] = []
  let skipped = 0
  for (const item of v) {
    if (isScenarioMeta(item)) valid.push(item)
    else skipped++
  }
  return { valid, skipped, malformed: false }
}

// ReplayPayload の判別子。testScenarioReplay.remapPayload の switch と一致させる
// （破損 payload が instantiateScenario で TypeError を投げる HIGH #1 対策）。
const PAYLOAD_KINDS = new Set(['event', 'lpgm', 'nankai', 'nankaiCommentary', 'kohatsu'])

/**
 * payload の kind と対応する必須サブフィールドを検証する。
 * - kind: 'event' → event が Record
 * - kind: 'lpgm' | 'nankai' | 'nankaiCommentary' | 'kohatsu' → data が Record
 * これを通さないと `remapPayload` 内で `switch (payload.kind)` の分岐に入った直後に
 * `payload.event.kind` や `payload.data.???` を読んで TypeError で map 全体が中断し、
 * そのシナリオの全エントリが再生キューに積まれなくなる（HIGH #1）。
 */
function isValidPayload(p: Record<string, unknown>): boolean {
  const kind = p.kind
  if (typeof kind !== 'string' || !PAYLOAD_KINDS.has(kind)) return false
  if (kind === 'event') return isRecord(p.event)
  return isRecord(p.data)
}

/**
 * シナリオファイル本体の型検証。entry 配列は payload の判別子（kind）と対応する
 * サブフィールドまで検証する（HIGH #1 対策）。壊れたエントリは落として通ったものだけ返す。
 */
export function validateScenarioFile(v: unknown): TestScenarioFile | null {
  if (!isRecord(v)) return null
  if (!isScenarioMeta(v)) return null
  if (typeof v.baseTime !== 'string' || v.baseTime.length === 0) return null
  if (!Array.isArray(v.entries)) return null
  const entries: TestScenarioFile['entries'] = []
  for (const e of v.entries) {
    if (!isRecord(e)) continue
    if (typeof e.offsetMs !== 'number' || !Number.isFinite(e.offsetMs)) continue
    if (!isRecord(e.payload)) continue
    if (!isValidPayload(e.payload)) continue
    entries.push({
      offsetMs: e.offsetMs,
      payload: e.payload as TestScenarioFile['entries'][number]['payload'],
      silent: typeof e.silent === 'boolean' ? e.silent : undefined,
    })
  }
  return {
    id: v.id,
    label: v.label,
    description: v.description,
    category: v.category as ScenarioCategory,
    durationMs: v.durationMs,
    baseTime: v.baseTime,
    entries,
  }
}
