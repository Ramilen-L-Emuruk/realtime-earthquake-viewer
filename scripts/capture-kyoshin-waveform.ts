// NIED K-NET/KiK-netの実波形から、ローカル限定の強震モニタ風リプレイデータを生成するCLI。
//
// 背景・設計方針は docs/spec/settings-pwa-spec.md §6の
// 「NIED K-NET/KiK-netの実波形由来のデータ（ローカル限定・リアルタイム震度）」を参照。
// 要点: K-NET/KiK-netのデータは再配布禁止のため、このスクリプトの出力
// （public/data/historical-archives-kyoshin/*.json）はリポジトリに含めない（.gitignore対象）。
// 実行者本人のNIED登録が必要で、生成したデータは実行者のローカル環境でのみ再生できる。
//
// 使い方（複数の--originを指定すると、本震＋余震のように離れた複数のK-NETイベントを
// 1つのアーカイブへ統合する。観測点はstationCode基準で名寄せし、時間軸は各イベントの
// 実際の記録範囲のみ（間の無関係な期間は含めない＝スパース）。詳細は下部main()参照）:
//   NIED_KNET_USER=xxx NIED_KNET_PASSWORD=yyy \
//     npx tsx scripts/capture-kyoshin-waveform.ts \
//     --origin=20180906030759 --origin=20180906061100 \
//     --id=2018-iburi --expected-max-intensity=6.5
//
//   --origin: 地震発生時刻(JST)をYYYYMMDDHHMMSS形式で指定する（気象庁発表の原時刻）。
//             複数回指定できる。K-NET自身のイベントディレクトリ名（トリガー検知時刻ベースで
//             数秒〜1分弱ずれる）とは完全には一致しないため、月別の一覧から最も近いものを
//             自動で探す（EVENT_MATCH_TOLERANCE_MS参照）
//   --id: 出力ファイル名（<id>.json）。対応する historical-archives/<id>.json と揃えると
//         リプレイ時に自動で読み込まれる
//   --window-sec / --step-sec: 計測震度のスライディングウィンドウ設定（既定20秒・1秒刻み）
//   --expected-max-intensity: 既知の最大震度（計測震度換算値、全イベント通して）との差が
//         1.0を超えたら警告を出す。算出パイプラインの単位取り違え等、明らかな誤りに
//         早期に気付くための任意の検算
//
// 認証情報の置き場所は .env.local（NIED_KNET_USER / NIED_KNET_PASSWORD）。
// NIEDの登録は https://hinetwww11.bosai.go.jp/nied/registration/ から行う（利用者本人の責任）。
import { writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { unzipSync } from 'fflate'
import { parseKnetAsciiFile, groupIntoStations, type KnetAsciiFile } from './knetAscii'
import { computeIntensityTimeSeries } from './seismicIntensity'
import { mergeEvents, type EventResult, type StationSeries } from './kyoshinEventMerge'
import type { LocalKyoshinArchive } from '../src/types/localKyoshinArchive'

const WINDOW_SEC_DEFAULT = 20
const STEP_SEC_DEFAULT = 1
/** 期待値との差がこれを超えたら警告する（計測震度のスケール）。 */
const SANITY_CHECK_TOLERANCE = 1.0
/** 3成分が揃わない観測点の割合がこれを超えたら失敗として止める。 */
const INCOMPLETE_STATION_RATIO_LIMIT = 0.5

// .env.local から認証情報を読む（capture-test-scenario.ts と同じ方式）。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
if (typeof process.loadEnvFile !== 'function') {
  console.error('Node.js 20.12 以上が必要です（.env.local の読み込みに process.loadEnvFile を使用）')
  process.exit(1)
}
try {
  process.loadEnvFile(join(repoRoot, '.env.local'))
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error(`.env.local を読み込めませんでした: ${(err as Error).message}`)
    process.exit(1)
  }
}

function hasByteOrderMark(path: string): boolean {
  let head: Buffer
  try {
    head = readFileSync(path).subarray(0, 3)
  } catch {
    return false
  }
  return (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)
    || (head[0] === 0xff && head[1] === 0xfe)
    || (head[0] === 0xfe && head[1] === 0xff)
}

interface CliArgs {
  originTimesJst: string[]
  id: string
  windowSec: number
  stepSec: number
  expectedMaxIntensity: number | null
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      origin: { type: 'string', multiple: true },
      id: { type: 'string' },
      'window-sec': { type: 'string' },
      'step-sec': { type: 'string' },
      'expected-max-intensity': { type: 'string' },
    },
  })

  const origins = values.origin ?? []
  if (origins.length === 0 || origins.some((o) => !/^\d{14}$/.test(o))) {
    console.error('--origin は地震発生時刻(JST)をYYYYMMDDHHMMSS形式で指定してください（例: --origin=20180906030759）。複数回指定可')
    process.exit(1)
  }
  const id = values.id
  // ファイル名にそのまま使うため、パス区切り等を含めない（意図しない書き込み先への逸脱を防ぐ）。
  if (!id || !/^[\w-]+$/.test(id)) {
    console.error('--id は必須です（英数字・ハイフン・アンダースコアのみ。出力ファイル名 public/data/historical-archives-kyoshin/<id>.json に使う）')
    process.exit(1)
  }

  const stepSec = values['step-sec'] ? Number(values['step-sec']) : STEP_SEC_DEFAULT
  if (!Number.isInteger(stepSec) || stepSec <= 0) {
    // buildStationSeries は epochSec を Math.round(tSec) で整数秒へ丸めるため、非整数の
    // step-sec を渡すと複数の tSec が同じ整数秒に丸められて衝突し、後着の値が先着を
    // 無警告で上書き・消失させる（実データが半分近く欠落した状態で「成功」してしまう）。
    console.error('--step-sec は正の整数（秒）で指定してください')
    process.exit(1)
  }

  return {
    originTimesJst: origins,
    id,
    windowSec: values['window-sec'] ? Number(values['window-sec']) : WINDOW_SEC_DEFAULT,
    stepSec,
    expectedMaxIntensity: values['expected-max-intensity'] ? Number(values['expected-max-intensity']) : null,
  }
}

/**
 * K-NETのイベントディレクトリ名（YYYYMMDDHHMMSS、JST）と--originの許容差（ms）。
 *
 * K-NETのディレクトリ名は気象庁が発表する地震の原時刻ではなく、K-NET自身のトリガー検知時刻
 * （実測で数秒程度のずれ）。60秒あれば十分にトリガー遅延を吸収できる一方、実データで確認した
 * 限り本震クラスの余震は分単位で間隔が空くため、隣の無関係なイベントを誤って拾う心配は無い。
 */
const EVENT_MATCH_TOLERANCE_MS = 60_000

/** "YYYYMMDDHHMMSS"（JST）をUTCのepoch msへ変換する。 */
function parseKnetTimestamp(ts: string): number {
  const y = Number(ts.slice(0, 4))
  const mo = Number(ts.slice(4, 6))
  const d = Number(ts.slice(6, 8))
  const h = Number(ts.slice(8, 10))
  const mi = Number(ts.slice(10, 12))
  const s = Number(ts.slice(12, 14))
  return Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3600_000
}

/** ディレクトリ一覧のHTML（Apacheの自動生成インデックス）から YYYYMMDDHHMMSS 形式のサブディレクトリ名を抽出する。 */
function parseEventDirectoryListing(html: string): string[] {
  return [...html.matchAll(/href="(\d{14})\/"/g)].map((m) => m[1])
}

/**
 * --originに最も近いK-NETのイベントディレクトリ名を、月別の一覧ページから見つける。
 *
 * K-NETのダウンロードURLはイベントごとに専用のサブディレクトリを持つが、そのディレクトリ名は
 * 気象庁が発表する地震の原時刻と完全には一致しない（K-NET自身のトリガー検知時刻のため、
 * 実データで確認した限り数秒程度ずれる）。ディレクトリ名を--originからの単純な文字列組み立てで
 * 決め打ちすると、正しい認証情報でも「そのファイルが無い」という理由で403/404になる
 * （実機確認で発覚。既知の地震で検証済み）。
 */
async function findNearestEventDirectory(originTimeJst: string, auth: string): Promise<string> {
  const year = originTimeJst.slice(0, 4)
  const month = originTimeJst.slice(4, 6)
  const listingUrl = `https://www.kyoshin.bosai.go.jp/kyoshin/download/all/zip/${year}/${month}/`
  const res = await fetch(listingUrl, { headers: { Authorization: auth } })
  if (!res.ok) {
    throw new Error(
      `K-NETのイベント一覧取得に失敗しました (status=${res.status})\nURL: ${listingUrl}\n`
      + 'NIED_KNET_USER / NIED_KNET_PASSWORD が正しいか確認してください',
    )
  }
  const candidates = parseEventDirectoryListing(await res.text())
  if (candidates.length === 0) throw new Error(`${listingUrl} にイベントディレクトリが1件も見つかりませんでした`)

  const targetMs = parseKnetTimestamp(originTimeJst)
  let best: { ts: string; diffMs: number } | null = null
  for (const ts of candidates) {
    const diffMs = Math.abs(parseKnetTimestamp(ts) - targetMs)
    if (best === null || diffMs < best.diffMs) best = { ts, diffMs }
  }
  if (best === null || best.diffMs > EVENT_MATCH_TOLERANCE_MS) {
    throw new Error(
      `--origin=${originTimeJst} に近いK-NETイベントディレクトリが見つかりませんでした`
      + `（最も近い候補: ${best?.ts ?? 'なし'}、差${best ? Math.round(best.diffMs / 1000) : '?'}秒。`
      + `許容誤差${EVENT_MATCH_TOLERANCE_MS / 1000}秒を超えています。--originの時刻を確認してください）`,
    )
  }
  console.log(`  K-NETイベントディレクトリ: ${best.ts}（--originとの差 ${Math.round(best.diffMs / 1000)}秒）`)
  return best.ts
}

/** K-NET/KiK-netのHTTPSダウンロード（Basic認証）。URLパターンは kyoshin.bosai.go.jp/ja/https_download/ 参照。 */
async function downloadKnetZip(originTimeJst: string, user: string, password: string): Promise<Uint8Array> {
  const year = originTimeJst.slice(0, 4)
  const month = originTimeJst.slice(4, 6)
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  const eventTs = await findNearestEventDirectory(originTimeJst, auth)
  const url = `https://www.kyoshin.bosai.go.jp/kyoshin/download/all/zip/${year}/${month}/${eventTs}/${eventTs}_ascii.zip`
  const res = await fetch(url, { headers: { Authorization: auth } })
  if (!res.ok) {
    throw new Error(
      `K-NET/KiK-net強震データのダウンロードに失敗しました (status=${res.status})\n`
      + `URL: ${url}\n`
      + 'NIED_KNET_USER / NIED_KNET_PASSWORD が正しいか確認してください',
    )
  }
  return new Uint8Array(await res.arrayBuffer())
}

/** ZIP内のNS/EW/UD波形ファイルをすべて解析する。それ以外のファイル（メタ情報等）は無視する。 */
function parseAllStationFiles(zip: Uint8Array): { files: KnetAsciiFile[]; failures: { fileName: string; message: string }[] } {
  const entries = unzipSync(zip)
  const files: KnetAsciiFile[] = []
  const failures: { fileName: string; message: string }[] = []
  const decoder = new TextDecoder('utf-8')
  for (const [path, data] of Object.entries(entries)) {
    const fileName = path.split('/').pop() ?? path
    if (!/\.(NS|EW|UD)[12]?$/i.test(fileName)) continue
    try {
      files.push(parseKnetAsciiFile(decoder.decode(data), fileName))
    } catch (err) {
      failures.push({ fileName, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { files, failures }
}

/** 1つのK-NETイベント（--origin 1件ぶん）をダウンロード・解析し、観測点ごとの震度時系列を算出する。 */
async function processEvent(
  originTimeJst: string,
  user: string,
  password: string,
  windowSec: number,
  stepSec: number,
): Promise<EventResult> {
  console.log(`\n=== イベント origin=${originTimeJst} ===`)
  console.log('K-NET/KiK-net強震データを取得中...')
  const zip = await downloadKnetZip(originTimeJst, user, password)
  console.log(`ダウンロード完了（${zip.byteLength}バイト）。解凍・パース中...`)

  const { files, failures } = parseAllStationFiles(zip)
  if (failures.length > 0) {
    console.error(`${failures.length}件のファイルでパースに失敗しました:`)
    for (const f of failures.slice(0, 20)) console.error(`  ${f.fileName}: ${f.message}`)
    throw new Error(
      `origin=${originTimeJst}: パースに失敗したファイルがあります（上記参照）。`
      + 'scripts/knetAscii.ts のヘッダー判定条件が実際のファイル形式と食い違っている可能性があります',
    )
  }
  if (files.length === 0) throw new Error(`origin=${originTimeJst}: ZIP内にNS/EW/UD波形ファイルが1件も見つかりませんでした`)

  const { stations, skippedIncomplete } = groupIntoStations(files)
  if (skippedIncomplete > 0) {
    console.warn(`3成分が揃わない観測点 ${skippedIncomplete} 件を除外しました`)
  }
  if (stations.length === 0) throw new Error(`origin=${originTimeJst}: 3成分が揃った観測点が0件です`)
  // 除外が大半を占める場合、component/depthKindの判定ロジック（resolveComponentFromFileName）に
  // 系統的な誤りがある可能性が高い。警告止まりだと、実質ほぼ空のデータが「成功」として
  // 書き出されるのに気付けない。
  const incompleteRatio = skippedIncomplete / (skippedIncomplete + stations.length)
  if (incompleteRatio > INCOMPLETE_STATION_RATIO_LIMIT) {
    throw new Error(
      `origin=${originTimeJst}: 3成分が揃わない観測点が${Math.round(incompleteRatio * 100)}%に達しました`
      + '（成分・深度の判定ロジックに誤りがある可能性があります）',
    )
  }
  console.log(`${stations.length}観測点を検出。震度時系列を算出中...`)

  const stationSeries: StationSeries[] = stations.map((station) => {
    const startEpochSec = Math.round(station.recordStartTime.getTime() / 1000)
    const points = computeIntensityTimeSeries(
      station.components.NS,
      station.components.EW,
      station.components.UD,
      station.samplingHz,
      { windowSec, stepSec },
    ).map((p) => ({
      epochSec: startEpochSec + Math.round(p.tSec),
      intensity: p.intensity,
    }))
    return { stationCode: station.stationCode, latitude: station.latitude, longitude: station.longitude, points }
  })

  let peakIntensity = -Infinity
  for (const s of stationSeries) {
    for (const p of s.points) {
      if (p.intensity !== null && p.intensity > peakIntensity) peakIntensity = p.intensity
    }
  }
  // 全ウィンドウがデータ不足でnullだった場合、-1（欠測）だけのフレームが無警告で書き出されて
  // しまうため、他のイベントを巻き込む前にここで止める。
  if (!Number.isFinite(peakIntensity)) {
    throw new Error(
      `origin=${originTimeJst}: 有効な計測震度を1件も算出できませんでした（全ウィンドウがデータ不足でnullでした）。`
      + 'サンプリング周波数・スケールファクタ等、算出パイプラインの誤りを疑ってください',
    )
  }
  console.log(`このイベントのピーク計測震度（近似値）: ${peakIntensity.toFixed(2)}`)

  return { originTimeJst, stationSeries, peakIntensity }
}

async function main(): Promise<void> {
  const { originTimesJst, id, windowSec, stepSec, expectedMaxIntensity } = parseCliArgs()
  const user = process.env.NIED_KNET_USER
  const password = process.env.NIED_KNET_PASSWORD
  if (!user || !password) {
    console.error('NIED_KNET_USER / NIED_KNET_PASSWORD が必要です（.env.local または環境変数）')
    if (hasByteOrderMark(join(repoRoot, '.env.local'))) {
      console.error('  → .env.local がBOM付きで保存されています。BOMなしUTF-8で保存し直してください')
    }
    process.exit(1)
  }

  // イベント単位でtry/catchする: 19件のような大きなバッチで1件（許容誤差を超えたイベント
  // 一致失敗・一時的な通信断等）が失敗しても、既に成功した残り全部を無駄にしない
  // （実機確認で判明: 17/19まで成功していたのに、18件目の失敗でmain()全体が例外を投げ、
  // 成功済みの17件分のダウンロード・FFT計算がすべて無駄になった）。
  const events: EventResult[] = []
  const eventFailures: { origin: string; message: string }[] = []
  for (const origin of originTimesJst) {
    try {
      events.push(await processEvent(origin, user, password, windowSec, stepSec))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`origin=${origin} をスキップします: ${message}`)
      eventFailures.push({ origin, message })
    }
  }
  if (events.length === 0) throw new Error('全イベントの取得・算出に失敗しました（上記参照）')
  if (eventFailures.length > 0) {
    console.warn(
      `\n${eventFailures.length}件のイベントをスキップしました: ${eventFailures.map((f) => f.origin).join(', ')}`,
    )
  }

  const { stationOrder, siteCoords, frames } = mergeEvents(events, stepSec)

  const overallPeak = Math.max(...events.map((e) => e.peakIntensity))
  console.log(`\n${events.length}イベント統合。全イベント通してのピーク計測震度（近似値）: ${overallPeak.toFixed(2)}`)
  if (expectedMaxIntensity !== null && Math.abs(overallPeak - expectedMaxIntensity) > SANITY_CHECK_TOLERANCE) {
    console.warn(
      `警告: 期待値(${expectedMaxIntensity})との差が${SANITY_CHECK_TOLERANCE}を超えています。`
      + 'スケールファクタの取り違え・単位ミス等、算出パイプラインの誤りを疑ってください',
    )
  }

  const archive: LocalKyoshinArchive = {
    id,
    sites: siteCoords,
    stationCodes: stationOrder,
    frames,
  }

  const outDir = join(repoRoot, 'public', 'data', 'historical-archives-kyoshin')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, `${id}.json`)
  await writeFile(outPath, JSON.stringify(archive))
  console.log(`書き出し完了: ${outPath}（${frames.length}フレーム、${stationOrder.length}観測点、${events.length}イベント統合）`)
  console.log('このファイルはリポジトリに含めない（.gitignore対象）。実行者本人の環境でのみ再生できる')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
