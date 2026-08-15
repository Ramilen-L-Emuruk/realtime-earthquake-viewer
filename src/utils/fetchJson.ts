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
 * @param timeoutMs タイムアウト（既定は {@link DATA_FETCH_TIMEOUT_MS}）
 */
export async function fetchJsonWithTimeout<T>(
  url: string,
  label: string,
  timeoutMs: number = DATA_FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
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
  }
}
