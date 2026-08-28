// ローカル限定生成の強震モニタ風リプレイデータ（scripts/capture-kyoshin-waveform.ts の出力）から
// フレームを供給する KyoshinSource。
//
// 出力ファイル（public/data/historical-archives-kyoshin/*.json）はNIED K-NET/KiK-netの再配布禁止
// 規約のためリポジトリに含めない（.gitignore対象）。したがって通常の配信環境では対象ファイルが
// 常に存在せず、この供給元は「何も供給しない」に静かに倒れる（従来どおり「リアルタイム震度」タブが
// 空のまま。regression ではない）。実行者本人がローカルで生成した場合にのみ実データを供給する。
//
// フレームは全件を一度に enqueue する。時刻ペースは呼び出し側の frame queue
// （useKyoshinRealtime の drainLatest(serverDate())）が担い、serverDate() はリプレイ中
// Date.now() + replayOffset を返す（clock.ts）ため、実際の地震発生当時のUTC時刻をそのまま
// frame.time に使えば、通常のリプレイ速度で自然に1件ずつ放出される
// （kyoshinSource.ts の「フレーム列が一度に手に入る供給元」という設計意図どおり）。

import type { SiteCoords } from './kyoshin'
import type { KyoshinSource } from './kyoshinSource'
import type { LocalKyoshinArchive } from '../types/localKyoshinArchive'
import { log } from '../utils/logger'

const fileUrl = (id: string): string => `${import.meta.env.BASE_URL}data/historical-archives-kyoshin/${id}.json`

/**
 * 取得結果。「未生成」（正常系・無警告）と「取得できたが壊れている／通信が失敗した」
 * （異常系・`setStalled(true)`で可視化する）を呼び出し側が区別できるようにする。
 */
type LoadResult =
  | { kind: 'found'; archive: LocalKyoshinArchive }
  /** 404、または開発サーバーのSPAフォールバック。通常の配信環境で常に起きる正常系。 */
  | { kind: 'not-generated' }
  /** ネットワーク層の失敗・5xx等・JSON解析失敗・構造不正。ファイルが存在するのに壊れている場合を含む。 */
  | { kind: 'failed'; retryable: boolean }

// id ごとにキャッシュ（同一アーカイブへの再生ジャンプで毎回 fetch し直さない）。
// 'not-generated'・'found'・retryable=false の'failed'（JSON解析失敗・構造不正。ファイルの
// 中身が変わらない限り再取得しても同じ結果になる）はキャッシュする。retryable=trueの'failed'
// （ネットワーク層の失敗・5xx等、一過性の可能性がある）はキャッシュしない
// （kyoshin.ts の fetchSiteList と同じ方針: 失敗したPromiseを残すと一時的な障害が
// セッション終了まで固定されてしまう）。
const cache = new Map<string, Promise<LoadResult>>()

/** テスト用。テスト間で確実に状態を切り離す。 */
export function clearLocalKyoshinArchiveCache(): void {
  cache.clear()
}

function isLocalKyoshinArchive(raw: unknown): raw is LocalKyoshinArchive {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return false
  if (!Array.isArray(r.sites) || !r.sites.every((s) => Array.isArray(s) && s.length === 2 && s.every((n) => typeof n === 'number'))) return false
  if (!Array.isArray(r.stationCodes) || r.stationCodes.length !== r.sites.length) return false
  if (!Array.isArray(r.frames) || r.frames.length === 0) return false
  return r.frames.every((f) => {
    if (typeof f !== 'object' || f === null) return false
    const frame = f as Record<string, unknown>
    return typeof frame.time === 'string'
      && Array.isArray(frame.indices)
      && frame.indices.length === (r.sites as unknown[]).length
      && frame.indices.every((n) => typeof n === 'number')
  })
}

function loadLocalKyoshinArchive(id: string): Promise<LoadResult> {
  const cached = cache.get(id)
  if (cached) return cached

  const promise = (async (): Promise<LoadResult> => {
    let res: Response
    try {
      res = await fetch(fileUrl(id))
    } catch (err) {
      // ネットワーク層の失敗（オフライン・一過性の接続断等）。再試行の余地があるためキャッシュしない。
      log.warn(`[kyoshinLocalArchive] ${id}.json の取得に失敗しました（ネットワーク層）`, err)
      return { kind: 'failed', retryable: true }
    }
    // 404 = 未生成。通常の配信環境で常に起きる正常系のため、ログを出さない。
    if (res.status === 404) return { kind: 'not-generated' }
    // 開発サーバー（vite）は静的ファイルが無いGETをSPAフォールバックでindex.html（200・text/html）を
    // 返す。本番の静的配信では同じ状況は404になるため、これも「未生成」と同じ静かな扱いにする
    // （実機確認で判明: この判定が無いと、他の3件のアーカイブを再生するたびに毎回
    // 「JSON解析に失敗しました」という誤った警告が出る）。
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return { kind: 'not-generated' }
    if (!res.ok) {
      // 404以外の失敗（5xx等）。未生成とは異なり本来なら取得できるはずのファイルが取れていない
      // ため、無警告で諦めず記録し、再試行の余地を残す。
      log.warn(`[kyoshinLocalArchive] ${id}.json の取得に失敗しました (status=${res.status})`)
      return { kind: 'failed', retryable: true }
    }
    let raw: unknown
    try {
      raw = await res.json()
    } catch (err) {
      log.warn(`[kyoshinLocalArchive] ${id}.json のJSON解析に失敗しました`, err)
      return { kind: 'failed', retryable: false }
    }
    if (!isLocalKyoshinArchive(raw)) {
      log.warn(`[kyoshinLocalArchive] ${id}.json の構造が不正です（capture-kyoshin-waveform.ts のバージョン不一致等）`)
      return { kind: 'failed', retryable: false }
    }
    return { kind: 'found', archive: raw }
  })()

  cache.set(id, promise)
  // retryable な失敗はキャッシュへ残さない。次回 start() されたときに取り直せるようにするため
  // （fetchSiteList と同じ「失敗したPromiseは残さない」方針。ここでは「一過性かどうか」で
  // さらに絞っている点が異なる）。
  promise.then((result) => {
    if (result.kind === 'failed' && result.retryable) cache.delete(id)
  })
  return promise
}

/**
 * ローカル限定の強震モニタ風リプレイデータを供給する KyoshinSource。
 * ファイルが存在しない場合（通常の配信環境では常にこちら）は何も enqueue しない。
 * ファイルが存在するのに壊れている・取得に失敗した場合は `setStalled(true)` で可視化する
 * （「地震活動が無い」のか「このソースが壊れている」のかを利用者が見分けられるようにするため）。
 */
export function createLocalKyoshinArchiveSource(archiveId: string): KyoshinSource {
  let active = false
  let sites: SiteCoords | null = null

  const source: KyoshinSource = {
    start(sink) {
      if (active) return
      active = true
      loadLocalKyoshinArchive(archiveId).then((result) => {
        if (!active) return
        if (result.kind === 'not-generated') return
        if (result.kind === 'failed') {
          sink.setStalled(true)
          return
        }
        sites = result.archive.sites
        sink.setStalled(false)
        for (const frame of result.archive.frames) {
          sink.enqueue({
            time: new Date(frame.time),
            dataTime: frame.time,
            sitesKey: archiveId,
            indices: frame.indices,
          })
        }
      }).catch((err) => {
        // loadLocalKyoshinArchive は内部で失敗を握り潰すため通常到達しないが、
        // 想定外の例外（enqueue 自体の例外等）はログに残す。
        log.error('[kyoshinLocalArchiveSource] ローカルアーカイブの反映中に例外', err)
      })
    },

    stop() {
      active = false
    },

    resolveSites(sitesKey) {
      if (sites === null || sitesKey !== archiveId) {
        return Promise.reject(new Error(`[kyoshinLocalArchiveSource] 観測点リストが未取得です (sitesKey=${sitesKey})`))
      }
      return Promise.resolve(sites)
    },
  }

  return source
}
