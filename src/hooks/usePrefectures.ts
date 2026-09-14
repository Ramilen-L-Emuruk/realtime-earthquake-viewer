import { useEffect, useState } from 'react'
import { getPrefecturesCache, loadPrefectures, type Prefectures } from '../utils/prefectures'

/**
 * 都道府県の境界データ。読み込みが済むまでと取得失敗時は null。
 *
 * **地図と同じデータを読む**（`BaseMapGL` が陸地塗りと県境に使っている）。`loadPrefectures` は
 * 一度取れば以後キャッシュを返すので、ここから呼んでも通信は増えない。
 *
 * **失敗をここでは記録しない。** 同じ取得の失敗は地図側が拾って画面へ出す（「データの一部を
 * 取得できませんでした」）ので、ここでも出すと原因 1 つに対してログが 2 本並ぶだけになる。
 * 県の境界を引けない間は、それを使う操作（県の行から地図へ寄せる）が押せないだけで済む。
 *
 * **一度失敗すると、そのカードでは回復しない。** 区域側（`useSubRegions`）と違って
 * `prefectures.ts` は成功を知らせる購読の口を持たず、他の呼び出し元（`BaseMapGL`・`LabelsGL`・
 * `QuakeIntensitySurfaceGL`）もマウント時に一度取りに行くだけで再試行しない。復帰するのは
 * **新しい地震カードがマウントされて初回の取得を試みたとき**だけで、地震が起きない間は回復の
 * 契機が無い。陸地塗り・県境・県名ラベルも同じ制約を元から抱えている（直すなら
 * `subregions.ts` の `onSubRegionsLoaded` に相当する購読の口を県側にも置くことになる）。
 */
export function usePrefectures(): Prefectures | null {
  const cache = getPrefecturesCache()
  const [, setLoadedTick] = useState(0)

  useEffect(() => {
    if (cache) return
    let active = true
    loadPrefectures()
      .then(() => { if (active) setLoadedTick((t) => t + 1) })
      // 失敗は上記のとおり地図側が記録する。ここで握るのは「この画面では諦める」という判断。
      .catch(() => {})
    return () => { active = false }
  }, [cache])

  return cache
}
