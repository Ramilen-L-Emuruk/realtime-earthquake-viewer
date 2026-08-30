import { useSyncExternalStore } from 'react'
import { subscribeRenderHealth, getRenderHealth } from '../utils/renderHealth'

/**
 * 名前を並べるときに出す上限。超えたぶんは件数でまとめる。
 * 同時に壊れるのは 1〜2 件が普通で、全部並べると地図を覆う。
 */
const MAX_NAMES = 3

/**
 * 地図の描画物が描けているかを知らせる（`utils/renderHealth.ts`）。
 *
 * 取得の失敗を出す `MapDataStatus` と対になる。あちらは「データが来なかった」、
 * こちらは**「来たのに描けなかった」**。
 *
 * これが無いと、たとえば震源カタログは件数だけ正しく出したまま地図が空になり、
 * 利用者は絞り込みの結果と区別できない。正常時は何も描かない。
 */
export function MapRenderStatus() {
  const health = useSyncExternalStore(subscribeRenderHealth, getRenderHealth, getRenderHealth)
  if (health.broken.length === 0 && health.uninteractive.length === 0) return null

  return (
    <div className="bg-black/80 rounded text-xs px-2 py-0.5 roomy:text-lg roomy:px-2.5 roomy:py-1 text-amber-300">
      {health.broken.length > 0 && (
        <div>地図に描けていないものがあります（{nameList(health.broken)}）</div>
      )}
      {health.uninteractive.length > 0 && (
        <div>クリックしても内容を出せないものがあります（{nameList(health.uninteractive)}）</div>
      )}
      {/* **手掛かりは 2 つに共通なので 1 行にまとめる。** 片方にだけ添えると、もう片方は
          打つ手が無いように読める（実際にはどちらも同じ——一時的な不調なら作り直しで直り、
          恒久的なものならどちらも直らない）。
          再読み込みを挙げているのは、地図ごと作り直すとシェーダーも判定も新しく用意されるため。
          アプリが自分で作り直す機会（投影の切り替え）もあるが、利用者に案内できる操作ではない。 */}
      <div className="opacity-80">再読み込みで直ることがあります</div>
    </div>
  )
}

/** 名前を並べる。上限を超えたぶんは「ほか N 件」にまとめる。 */
function nameList(names: readonly string[]): string {
  if (names.length <= MAX_NAMES) return names.join('・')
  return `${names.slice(0, MAX_NAMES).join('・')} ほか ${names.length - MAX_NAMES} 件`
}
