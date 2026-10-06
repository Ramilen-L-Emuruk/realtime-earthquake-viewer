// 外部への取得に上限と打ち切りを持たせる共通の口。
//
// 素の fetch は時間の上限を持たない。接続だけ張れて応答が返らない回線では Promise が永久に
// pending になり、呼び出し側は .then も .catch も呼ばれないまま止まる —— 失敗として数えられず、
// 再試行も「更新停止」の表示も動かない（リプレイの開始なら「取得中」のまま、強震モニタなら
// 次の取得そのものが仕込まれない）。上限に当たった取得はここで例外にし、既存の失敗の経路へ乗せる。
//
// 生成データ（public/data/*.json）は取得状況の集計を持つ `fetchJsonWithTimeout` を使う。
// 外部の配信元（DMDATA・P2PQuake・強震モニタ・VOICEVOX・海底地形）はこちらを使う。

/**
 * DMDATA のアーカイブ本体（1 日ぶんの tar.gz）の上限。
 *
 * **重さで決める。** 応答待ちは実測で 0.5 秒だが（2026-10-06・7 本）、地震の多い日は重く、
 * 能登半島地震の日（2024-01-01）は 1.5 MB ある。生成データと同じ遅い回線（実効 50 KB/s）を
 * 仮定すると読み切るまでに 31 秒かかるので、その倍を取る。
 */
export const ARCHIVE_BODY_FETCH_TIMEOUT_MS = 60_000

/**
 * DMDATA の API（目録・一覧・電文本体・WebSocket のチケット）・P2PQuake・強震モニタの観測点一覧・
 * 海底地形のタイルの上限。
 *
 * 中身はどれも小さく、時間はほぼ応答待ち。実測の最長は WebSocket のチケット（`/v2/socket`）の
 * 2.7 秒で（2026-10-06）、その 10 倍を取る。
 */
export const API_FETCH_TIMEOUT_MS = 30_000

/**
 * 強震モニタの秒ファイル（1 秒ぶんの震度）の上限。**配信の局（west / east）1 つあたり**の値。
 *
 * 実測の最長は 0.25 秒（2026-10-06・175 本）。**長くしないこと** —— 1 秒ごとに取りに行くもので、
 * 上限に当たるまで次の取得は仕込まれない。長いほど止まったことに気づくのが遅れる。
 *
 * **1 フレームの取得は局を 2 つ順に試すので、両方とも黙ればこの 2 倍かかる。** その 2 倍を
 * 更新停止の判定（`STALLED_AFTER_MS`）と同じ長さにしてある —— 黙った回線でも 1 回の取得が判定の
 * 長さで終わり、判定はその取得を始めた時刻から測る（`createYahooPollingSource` の `failingSince`）
 * ので、失敗が分かった時点で通知が出る（2026-10-06 ユーザー承認）。
 */
export const KYOSHIN_FRAME_FETCH_TIMEOUT_MS = 2_500

/** 上限に当たって打ち切った取得。呼び出し元が止めた打ち切り（`AbortError`）とは別物。 */
export class FetchTimeoutError extends Error {
  readonly url: string
  readonly timeoutMs: number
  constructor(url: string, timeoutMs: number) {
    super(`取得が ${timeoutMs / 1000} 秒以内に終わりませんでした: ${url}`)
    this.name = 'FetchTimeoutError'
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

/**
 * 呼び出し元が止めたことによる打ち切りか（上限に当たったものは含まない）。
 *
 * **失敗として数えないために使う。** 止めた取得を失敗に数えると、再生を止めただけで
 * 「取得できなかった」と出る。`DOMException` は `Error` を継承しないので name で見る。
 */
export function isAbortedByCaller(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

export interface FetchWithTimeoutOptions {
  /** 上限（ミリ秒）。上の定数から選ぶ。 */
  timeoutMs: number
  /**
   * 呼び出し元が止めるための合図。止める手立てを持たない呼び出しは `null` を渡す
   * （**任意にしない** —— 渡し忘れても型が通ると、止めたつもりの取得が裏に残る）。
   */
  signal: AbortSignal | null
  /** fetch へそのまま渡す（`signal` は上書きする）。 */
  init?: RequestInit
}

/**
 * 取得して、中身を `read` で読み切るまでを 1 つの上限の中で行う。
 *
 * **上限は中身を読み終えるまで掛け続ける。** 見出しだけ返って中身が流れてこない回線でも
 * 同じ症状になるため、`fetch` が解決した時点で上限を外すと穴が残る。だから応答を呼び出し側へ
 * 返さず、読み方（`res.json()` など）を受け取る。
 *
 * **計時は呼んだ時点から。** レート制御の門で待つ時間は含めない —— 門を通ってから呼ぶこと。
 *
 * - 上限に当たったら {@link FetchTimeoutError} を投げる（失敗として扱ってよい）
 * - `signal` で止められたら `AbortError` を投げる（{@link isAbortedByCaller} で見分ける）
 * - それ以外の失敗（通信の失敗・`read` が投げたもの）はそのまま投げる
 */
export async function fetchWithTimeout<T>(
  url: string,
  options: FetchWithTimeoutOptions,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const { timeoutMs, signal, init } = options
  if (signal?.aborted) throw abortErrorOf(signal)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCallerAbort = () => controller.abort()
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return await read(res)
  } catch (err) {
    // 打ち切った理由で投げ分ける。fetch が投げる例外の形は実行環境で違う（理由を載せるもの・
    // 載せないもの）ので、例外の中身ではなく自分で立てた印を見る。
    if (timedOut) throw new FetchTimeoutError(url, timeoutMs)
    if (signal?.aborted) throw abortErrorOf(signal)
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}

/** {@link fetchJsonOutcome} の結果。中身は上限の中で読み終えている。 */
export interface JsonOutcome {
  ok: boolean
  status: number
  /** 応答の見出し（持たない応答では `null`）。 */
  headers: Headers | null
  /**
   * 読んだ JSON。読まないと決めた応答では `null`。**読もうとして壊れていたら `error`** ——
   * 通信の失敗（例外）と「届いたが JSON として読めない」を呼び出し側が分けて扱えるようにする。
   */
  body: { value: unknown } | { error: unknown } | null
}

/**
 * 取得して、`shouldRead` が真の応答だけ JSON を読む（上限は読み終えるまで掛かる）。
 *
 * **状態番号で分岐してから `res.json()` を読む既存の書き方のための口。** 応答を呼び出し側へ返して
 * から読ませると、そこで黙った取得に上限が届かない。読むかどうかの判定だけを受け取り、読むのは
 * ここで済ませる。
 */
export function fetchJsonOutcome(
  url: string,
  options: FetchWithTimeoutOptions,
  shouldRead: (res: Response) => boolean,
): Promise<JsonOutcome> {
  return fetchWithTimeout(url, options, async (res) => {
    const head = { ok: res.ok, status: res.status, headers: res.headers ?? null }
    if (!shouldRead(res)) return { ...head, body: null }
    try {
      return { ...head, body: { value: await res.json() as unknown } }
    } catch (error) {
      // 上限に当たった・止められたものは打ち切りとして投げる（「読めない JSON」に化けさせない）。
      // どちらも中身は同じ AbortError なので、ここでは分けない —— 時間切れかどうかは外側の
      // fetchWithTimeout が自分の印（timedOut）で見分けて FetchTimeoutError に替える。
      if (options.signal?.aborted || isAbortedByCaller(error)) throw error
      return { ...head, body: { error } }
    }
  })
}

/** {@link JsonOutcome} から読んだ値を取り出す。読めなかったときはその例外をそのまま投げる。 */
export function outcomeJson<T>(outcome: JsonOutcome): T {
  if (outcome.body === null) throw new Error(`本文を読んでいません（status=${outcome.status}）`)
  if ('error' in outcome.body) throw outcome.body.error
  return outcome.body.value as T
}

function abortErrorOf(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  if (isAbortedByCaller(reason)) return reason
  return new DOMException('取得を止めました', 'AbortError')
}
