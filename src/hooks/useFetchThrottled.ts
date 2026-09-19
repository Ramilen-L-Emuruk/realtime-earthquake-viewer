/**
 * いま配信元の上限に達していて、取得が待たされているか。
 *
 * **画面に「取得制限中」を出すためだけのもの。** 待ちが発生していること自体はアプリの動作に
 * 影響しない（枠が空けばそのまま取りに行く）ので、判定に使わないこと。
 *
 * **ポーリングで読む。** 門（`utils/requestGate.ts`）は React の外にいて、購読の仕組みを
 * 持たせると門そのものが重くなる。見ているのは待ち行列の長さと時刻の比較だけなので、
 * 1 秒ごとに読んでも費用はない。**値が変わらなければ React は描き直さない。**
 */
import { useEffect, useState } from 'react'
import { dmdataThrottledUntil } from '../services/dmdataRequestGates'

/**
 * 様子を見る間隔。
 *
 * **1 秒より細かくしない。** 出したいのは「いま待たされている」という状態だけで、
 * 残り時間を秒単位で見せるわけではない。
 */
const POLL_MS = 1000

/**
 * @param enabled 見張るかどうか。**標準版（P2PQuake）では `false` を渡す** ——
 *   あちらは DMDATA を一切使わないので門は常に空で、周期処理だけが無駄に走る。
 */
export function useFetchThrottled(enabled: boolean): boolean {
  const [throttled, setThrottled] = useState(false)
  useEffect(() => {
    if (!enabled) {
      // 無効へ切り替わったら、出したままの告知を引っ込める
      setThrottled(false)
      return
    }
    // **最初の 1 回はすぐ見る。** 起動直後に上限へ達している状況（前のタブが枠を使い切った等）で、
    // 1 秒だけ告知が出ないのを避ける。
    setThrottled(dmdataThrottledUntil() !== null)
    const id = setInterval(() => {
      setThrottled(dmdataThrottledUntil() !== null)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [enabled])
  return throttled
}
