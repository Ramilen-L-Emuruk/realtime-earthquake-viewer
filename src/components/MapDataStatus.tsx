import { useEffect, useState, useSyncExternalStore } from 'react'
import { subscribeDataLoadStatus, getDataLoadStatus } from '../utils/fetchJson'

/**
 * 「取得中」を出すまでの猶予（ミリ秒）。
 * 生成データは通常 1 秒以内に揃うため、すぐ出すと起動のたびに一瞬だけ現れてちらつく。
 * 遅いときだけ知らせる。
 */
const SHOW_PENDING_AFTER_MS = 3000

/**
 * 生成データ（境界・観測点座標など）の取得状況を地図に重ねて知らせる。
 *
 * 取得できなかったデータがあると地図から県境や震度が欠けるが、それだけでは
 * 「まだ来ていない」のか「来ない」のかが利用者に分からない。`console` には
 * 従来どおり詳細を出しているので、ここでは件数だけを伝える。
 * 正常時（取得中が短く、失敗も無い）は何も描かない。
 *
 * 対象は地図の見た目に関わるデータだけ（読み上げ辞書・実地震テストシナリオは
 * `trackStatus: false` で除外している。fetchJson.ts 参照）。失敗があるときは
 * 取得中より優先して失敗を出す（両方は出さない）。
 */
export function MapDataStatus() {
  const status = useSyncExternalStore(subscribeDataLoadStatus, getDataLoadStatus, getDataLoadStatus)
  const [pendingVisible, setPendingVisible] = useState(false)
  const hasPending = status.pending > 0

  useEffect(() => {
    if (!hasPending) {
      setPendingVisible(false)
      return
    }
    // 依存を件数ではなく boolean にする。件数にすると 1 本取れ終わるたびに
    // effect が張り直されて猶予が延び、いつまでも表示されない。
    const timer = window.setTimeout(() => setPendingVisible(true), SHOW_PENDING_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [hasPending])

  const failed = status.failed > 0
  if (!failed && !pendingVisible) return null

  return (
    <div
      className={`bg-black/80 rounded text-xs px-2 py-0.5 roomy:text-lg roomy:px-2.5 roomy:py-1 ${
        failed ? 'text-amber-300' : 'text-white/70'
      }`}
    >
      {failed ? (
        <>
          <div>データの一部を取得できませんでした（{status.failed} 件）</div>
          {/* 自動での取り直しは行わないため、利用者が打てる手を書き添える。
              要求元が 1 箇所しかないローダ（津波海岸線・活断層・プレート境界・津波観測点）は、
              その 1 回が失敗すると再読み込みまで復帰しない。 */}
          <div className="opacity-80">再読み込みで取得し直します</div>
        </>
      ) : (
        'データを取得中…'
      )}
    </div>
  )
}
