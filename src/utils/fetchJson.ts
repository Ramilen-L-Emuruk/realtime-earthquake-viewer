// 生成データ（public/data/*.json）のローダが共通で使う JSON 取得ヘルパー。
//
// 素の fetch はタイムアウトを持たないため、接続だけ張れて応答が返らない回線では
// Promise が永久に pending になる。呼び出し側は .then も .catch も呼ばれないまま
// 「読み込み中」で固まり、取得失敗時のフォールバック（区域塗り → 観測点ドット等）も
// 失敗ログも発生しない。それを避けるため、生成データの取得は必ずここを通す。

/**
 * 生成データ取得のタイムアウト（ミリ秒）。
 *
 * 生成データは初回表示時にほぼ同時に要求されるため、1 本あたりではなく合計で見積もる。
 * gzip 後の合計は約 1.7MB（最大は `subregions.json` の約 680KB）で、低速 3G 相当
 * （実効 50KB/s ≒ 35 秒）でも取り切れる余裕を持たせた値。
 *
 * 値を詰めないこと。短くしても遅い回線の表示が早くなるわけではなく、正常な取得を
 * 打ち切った側の損失のほうが大きい。再取得の機会を持たないローダ（活断層・津波海岸線など）
 * では、一度切ってしまうとセッション終了までその表示が欠けたままになる。
 */
export const DATA_FETCH_TIMEOUT_MS = 60_000

/**
 * abort によって中断された例外か。
 * `DOMException` は `Error` を継承しないため instanceof ではなく name で判定する。
 */
function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

/** 生成データの取得状況。UI（MapDataStatus）が購読する。 */
export interface DataLoadStatus {
  /** 取得中のデータ数 */
  pending: number
  /** 取得に失敗し、まだ取り直せていないデータ数 */
  failed: number
}

// 取得状況は label 単位で持つ。全ローダがこのヘルパーを通るため、ここで数えれば
// 個々のフックに状態を持たせなくても「今いくつ取得中か・いくつ落ちたか」が分かる。
//
// 取得中は「あるか無いか」ではなく本数を数える。同じ label で複数の取得が同時に走ることが
// あり（実地震テストシナリオの連続再生など）、Set だと 1 本終わっただけで残りが in-flight でも
// 「取得中が無くなった」と見えてしまう。
const pendingCounts = new Map<string, number>()
const failedLabels = new Set<string>()

function addPending(label: string): void {
  pendingCounts.set(label, (pendingCounts.get(label) ?? 0) + 1)
}

function removePending(label: string): void {
  const rest = (pendingCounts.get(label) ?? 0) - 1
  if (rest > 0) pendingCounts.set(label, rest)
  else pendingCounts.delete(label)
}
const statusListeners = new Set<() => void>()
// useSyncExternalStore は getSnapshot が同じ状態に対して同じ参照を返すことを要求する
// （毎回新しいオブジェクトを作ると再レンダリングが止まらない）ため、変化時だけ作り直す。
let statusSnapshot: DataLoadStatus = { pending: 0, failed: 0 }

function publishStatus(): void {
  if (statusSnapshot.pending === pendingCounts.size && statusSnapshot.failed === failedLabels.size) return
  statusSnapshot = { pending: pendingCounts.size, failed: failedLabels.size }
  for (const fn of statusListeners) fn()
}

/** 取得状況の変化を購読する。戻り値は購読解除関数。 */
export function subscribeDataLoadStatus(fn: () => void): () => void {
  statusListeners.add(fn)
  return () => {
    statusListeners.delete(fn)
  }
}

/** 現在の取得状況を返す（同じ状態なら同じ参照を返す）。 */
export function getDataLoadStatus(): DataLoadStatus {
  return statusSnapshot
}

export interface FetchJsonOptions {
  /** タイムアウト（既定は {@link DATA_FETCH_TIMEOUT_MS}） */
  timeoutMs?: number
  /**
   * 取得状況（{@link getDataLoadStatus}）の集計対象にするか。既定は true。
   *
   * 集計結果は地図に重ねて表示するため、地図の見た目に関係しないデータは false にする。
   * 読み上げの句区切り辞書は音声にしか影響せず、実地震テストシナリオは設定タブ側に専用の
   * エラー表示がある。これらを数えると、地図が欠けていないのに「データを取得できませんでした」と
   * 地図上に出て利用者を誤解させる。
   */
  trackStatus?: boolean
}

/**
 * JSON を取得する。`timeoutMs` を過ぎても取り切れなければ中断して例外にする。
 *
 * タイムアウトは fetch 本体だけでなく `res.json()` による body 読み込みまでを含む
 * （ヘッダだけ返って body が流れてこない場合も同じ症状になるため）。
 * タイムアウトは通常の取得失敗と同じ経路（例外）に載せる。呼び出し側は成功／失敗の
 * 2 通りだけを扱えばよく、リトライは既存どおり「次に要求されたときに再取得する」で足りる。
 *
 * @param url 取得先
 * @param label 例外メッセージに載せるデータ名（例: `subregions`）
 * @param options タイムアウトと取得状況の集計可否（{@link FetchJsonOptions}）
 */
export async function fetchJsonWithTimeout<T>(
  url: string,
  label: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { timeoutMs = DATA_FETCH_TIMEOUT_MS, trackStatus = true } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (trackStatus) {
    addPending(label)
    publishStatus()
  }
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`)
    const data = (await res.json()) as T
    // 取り直しに成功したら失敗の記録を消す（フォールバックからの復帰を表示にも反映する）
    if (trackStatus) failedLabels.delete(label)
    return data
  } catch (err) {
    if (trackStatus) failedLabels.add(label)
    // abort 由来の例外（AbortError）は原因が読み取れないため、タイムアウトと分かる文言に置き換える。
    // signal はこの関数内でしか使わないので、aborted が立つのはタイムアウトのときだけ。
    // ただし aborted だけで判定すると、時間切れの直後に届いた別種の例外（配信データ破損による
    // SyntaxError 等）まで「timed out」に化けて本当の原因が消える。abort 由来かどうかまで見る。
    if (controller.signal.aborted && isAbortError(err)) {
      throw new Error(`${label} fetch timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (trackStatus) {
      removePending(label)
      publishStatus()
    }
  }
}
