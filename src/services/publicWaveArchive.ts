import { API_FETCH_TIMEOUT_MS, FetchTimeoutError, fetchWithTimeout, isAbortedByCaller } from '../utils/fetchWithTimeout'
import { createRateGate, type RateGate, type RateLimitWindow } from '../utils/requestGate'
import type { PublicWaveRange } from '../utils/publicQuakeRange'

/**
 * 公開観測点の保存庫（EarthScope の FDSN dataselect）から、地震カードに出す区間の波形を取る
 * （`docs/public-waveform-design.md` §2・§3.5・§6）。返すのは miniSEED の生バイト —— 端末に控えるのも生バイトで、
 * 読み解くのは使うとき（`utils/miniseed2Stream.ts`）。
 *
 * **素の `fetch` を足さない**（`docs/spec/data-sources-spec.md` §1）。上限は門を通った後から数える。
 */

export const PUBLIC_DATASELECT_URL = 'https://service.earthscope.org/fdsnws/dataselect/1/query'

/**
 * 保存庫への門。EarthScope の Web サービスの上限（どの組み合わせでも同時 5 接続・毎秒 10 接続。設計書 §2）の手前に置く。
 * **値は仮**（設計書 §12「問い合わせの並列の度合い」）—— §3.4 の測り方（1 秒おき・直列）と同じ量にしてある。
 */
const ARCHIVE_LIMITS: readonly RateLimitWindow[] = [
  { windowMs: 1_000, max: 1 },
  { windowMs: 60_000, max: 60 },
]
/** 同時に飛ばしてよい本数。仮の値（設計書 §12）。同時 5 本の上限が保存庫の HTTP にも掛かるかは確かめていない。 */
export const PUBLIC_ARCHIVE_MAX_IN_FLIGHT = 2

const archiveGate: RateGate = createRateGate(ARCHIVE_LIMITS)

/**
 * 同時の本数を抑える待ち行列（門は時間あたりの件数だけを守り、同時の本数は数えない）。
 * **急ぐ取得（開いたカード・再生中の下部の波形）は、急がない待ち手（先取り）より前へ入れる**（急ぐものどうしは来た順）。
 * 門だけで追い越させても、ここで先取りの後ろに並ぶと先取りが終わるまで待たされる。
 */
let inFlight = 0
const slotWaiters: { readonly wake: () => void; readonly urgent: boolean }[] = []
async function takeSlot(signal: AbortSignal | undefined, urgent: boolean): Promise<void> {
  while (inFlight >= PUBLIC_ARCHIVE_MAX_IN_FLIGHT) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = slotWaiters.indexOf(entry)
        if (i >= 0) slotWaiters.splice(i, 1)
        reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const entry = {
        wake: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        urgent,
      }
      if (urgent) {
        const firstCalm = slotWaiters.findIndex((w) => !w.urgent)
        slotWaiters.splice(firstCalm < 0 ? slotWaiters.length : firstCalm, 0, entry)
      } else {
        slotWaiters.push(entry)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  inFlight += 1
}
function releaseSlot(): void {
  inFlight -= 1
  slotWaiters.shift()?.wake()
}

/** 秒まで・末尾の Z を付けない UTC（保存庫が受ける形。`scripts/measure-public-waveform.ts` で通った形と同じ）。 */
function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)
}

/**
 * 問い合わせの URL。範囲は秒に丸める（始まりは切り下げ・終わりは切り上げ。範囲が少し広がるだけ）。
 * 成分は表が持つ広帯域の 3 つ（`BH?`）。場所コードは渡さない（JP 網の BH は場所コードが空）。
 */
export function buildDataselectUrl(params: { readonly stations: readonly string[]; readonly range: PublicWaveRange }): string {
  const { stations, range } = params
  const q = new URLSearchParams({
    net: 'JP',
    sta: stations.join(','),
    cha: 'BH?',
    starttime: isoSeconds(range.fromMs),
    endtime: isoSeconds(Math.ceil(range.toMs / 1000) * 1000),
    // 「データが無い」を 204 の空の応答ではなく 404 で受ける（成功と取り違えない）
    nodata: '404',
  })
  // URLSearchParams はカンマを %2C にするが、保存庫はどちらでも受ける。読みやすさのため戻す
  return `${PUBLIC_DATASELECT_URL}?${q.toString().replace(/%2C/g, ',')}`
}

export type PublicArchiveResult =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  /** 204・404。問い合わせ全体の不在応答であり、永続的な不在とは確定しない（呼び出し側で再試行）。 */
  | { readonly kind: 'no-data' }
  | { readonly kind: 'http-error'; readonly status: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** 呼び出し元が止めた。失敗に数えず、記録にも残さない。 */
  | { readonly kind: 'aborted' }

/** 1 回取る。門と同時の本数の両方を通ってから投げる。`urgent` は開いたカードの取得（先に取る分を追い越す）。 */
export async function fetchPublicWaveArchive(params: {
  readonly stations: readonly string[]
  readonly range: PublicWaveRange
  readonly signal?: AbortSignal
  readonly urgent?: boolean
}): Promise<PublicArchiveResult> {
  const { stations, range, signal, urgent } = params
  const url = buildDataselectUrl({ stations, range })
  try {
    await takeSlot(signal, urgent === true)
  } catch (e) {
    if (isAbortedByCaller(e)) return { kind: 'aborted' }
    throw e
  }
  try {
    await archiveGate.wait({ urgent: urgent === true })
    if (signal?.aborted) return { kind: 'aborted' }
    return await fetchWithTimeout(url, { timeoutMs: API_FETCH_TIMEOUT_MS, signal: signal ?? null }, async (res): Promise<PublicArchiveResult> => {
      if (res.status === 204 || res.status === 404) return { kind: 'no-data' }
      if (!res.ok) return { kind: 'http-error', status: res.status }
      return { kind: 'ok', bytes: new Uint8Array(await res.arrayBuffer()) }
    })
  } catch (e) {
    if (isAbortedByCaller(e)) return { kind: 'aborted' }
    if (e instanceof FetchTimeoutError) return { kind: 'timeout' }
    return { kind: 'unreachable', detail: e instanceof Error ? e.message : String(e) }
  } finally {
    releaseSlot()
  }
}
