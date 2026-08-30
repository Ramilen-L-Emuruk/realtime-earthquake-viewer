import { useCallback, useEffect, useState } from 'react'
import {
  loadHypocenterIndex,
  loadHypocenterYear,
  type HypocenterIndex,
  type HypocenterYear,
} from '../utils/hypocenterCatalog'
import { yearsInRange } from '../utils/hypocenterCatalogView'
import { log } from '../utils/logger'

// 長期震源カタログを、選んだ年の範囲ぶんだけ読む。
//
// **タブを開くまで何も取りに行かない。** 全期間で 108 ファイル・gzip 12.6MB あり、起動のたびに
// 取ると地震情報の表示までが遅くなる。読み込み自体は utils/hypocenterCatalog.ts が年ごとに
// キャッシュするので、一度見た年を選び直しても通信は起きない。

export interface HypocenterCatalogState {
  /** 索引。**年ファイルより先に必要**（どの年が存在するか・完全性の下限を持つ）。 */
  index: HypocenterIndex | null
  /**
   * 読めた年（昇順）。
   *
   * **必ず「いま選んでいる期間の一部」になる。** 取得に失敗しても前の期間のものを残さない。
   * 残すと、期間の表示・完全性の注意書きと地図の中身が食い違ったまま固定され、しかも
   * 読み込みが終わったように見えるため気づけない。
   */
  years: HypocenterYear[]
  /** 索引または年ファイルを取得中か。 */
  loading: boolean
  /** 索引を取得できなかった理由（利用者に見せる文言）。年ファイルの欠けは `missingYears`。 */
  error: string | null
  /** 取得できなかった年（昇順）。空なら欠けなし。**件数はこのぶん少なく出る。** */
  missingYears: number[]
  /**
   * 取りに行った年の数（索引に無い年は含まない）。
   *
   * **`missingYears` と突き合わせて「一部が欠けた」と「まるごと取れなかった」を言い分けるために要る。**
   * 件数が 0 のとき、絞り込みの結果なのか取得の失敗なのかは利用者から区別できない。
   */
  requestedYears: number
  /** もう一度取りに行く。期間を変えずに失敗から復帰する手段。 */
  retry: () => void
}

const EMPTY_YEARS: HypocenterYear[] = []
const EMPTY_MISSING: number[] = []

/**
 * 同じ年の並びか。**中身の比較ではなく参照の比較で足りる**——`loadHypocenterYear` は年ごとに
 * 同じオブジェクトを返すため、同じ年を読めば同じ参照になる。
 */
function sameYears(a: readonly HypocenterYear[], b: readonly HypocenterYear[]): boolean {
  return a.length === b.length && a.every((y, i) => y === b[i])
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

/**
 * @param fromYear 表示する期間の始まり（両端を含む）
 * @param toYear 表示する期間の終わり（両端を含む）
 * @param enabled 取りに行ってよいか。false の間は何もせず、前回の内容を保つ
 */
export function useHypocenterCatalog(
  fromYear: number,
  toYear: number,
  enabled: boolean,
): HypocenterCatalogState {
  const [index, setIndex] = useState<HypocenterIndex | null>(null)
  const [years, setYears] = useState<HypocenterYear[]>(EMPTY_YEARS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missingYears, setMissingYears] = useState<number[]>(EMPTY_MISSING)
  const [requestedYears, setRequestedYears] = useState(0)
  // 取り直しの合図。期間が変わらなくても効果を回し直すために連番で持つ。
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // 索引は 1 度だけ。年ファイルの取得はこれが揃ってからでないと、存在しない年を叩く。
  useEffect(() => {
    if (!enabled || index) return
    let cancelled = false
    setLoading(true)
    // **始める前に前回の失敗を消す。** 残すと、新しい取得の最中に古いエラーと
    // 「読み込み中」が同時に出る。
    setError(null)
    loadHypocenterIndex()
      .then((idx) => {
        if (cancelled) return
        setIndex(idx)
      })
      .catch((err: unknown) => {
        // **打ち切られていても記録は残す。** タブを離れた瞬間に失敗すると、ここで黙ると
        // 痕跡が一つも残らない。画面へ出すのは打ち切られていないときだけ。
        log.error('[useHypocenterCatalog] 索引を取得できませんでした', err)
        if (cancelled) return
        setError('震源カタログを取得できませんでした')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, index, attempt])

  useEffect(() => {
    if (!enabled || !index) return
    const wanted = yearsInRange(index, fromYear, toYear)
    setRequestedYears(wanted.length)
    if (wanted.length === 0) {
      setYears(EMPTY_YEARS)
      setMissingYears(EMPTY_MISSING)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    // **1 年でも失敗したら全部捨てる、にはしない。** `Promise.all` だと 1 本の不調で期間全体が
    // 消えるうえ、どこが欠けたかも判らない。取れた年で描き、欠けた年は名指しで伝える。
    void Promise.allSettled(wanted.map(loadHypocenterYear)).then((results) => {
      const loaded: HypocenterYear[] = []
      const missing: number[] = []
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          loaded.push(r.value)
          return
        }
        missing.push(wanted[i])
        log.error(`[useHypocenterCatalog] ${wanted[i]} 年を取得できませんでした`, r.reason)
      })
      // **範囲が変わっていたら捨てる。** 年を素早く動かすと古い応答が後から届き、
      // 選んでいない期間が描かれる（しかも次の操作まで直らない）。
      if (cancelled) return
      // **中身が同じなら前の配列をそのまま返す。** この効果は `enabled` を依存に持つので、
      // タブを離れて戻るだけで回り直す（通信は起きない。年ごとにキャッシュ済みのため）。
      // そこで新しい配列を作ると参照が変わり、下流の点群の組み立てと GPU への転送が
      // まるごと走り直す（全期間で 16ms ＋ 52ms）。**捨てていないのに詰め直すことになる。**
      setYears((prev) => (sameYears(prev, loaded) ? prev : loaded))
      setMissingYears((prev) => (sameNumbers(prev, missing) ? prev : missing.length > 0 ? missing : EMPTY_MISSING))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, index, fromYear, toYear, attempt])

  return { index, years, loading, error, missingYears, requestedYears, retry }
}
